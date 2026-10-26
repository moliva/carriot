import * as core from "./core";
import * as db from "./db";
import { fuzzyScore } from "./fuzzy";
import * as tmux from "./tmux";
import { BLOCKED, isStale, label, STALE_AFTER_MS, type SessionRow } from "./types";

const ESC = "\x1b[";
const A = {
  reset: `${ESC}0m`,
  bold: `${ESC}1m`,
  dim: `${ESC}2m`,
  inverse: `${ESC}7m`,
  red: `${ESC}38;5;203m`,
  amber: `${ESC}38;5;214m`,
  green: `${ESC}38;5;78m`,
  blue: `${ESC}38;5;75m`,
  grey: `${ESC}38;5;244m`,
  selBg: `${ESC}48;5;236m`,
};

type Tab = "overview" | "plan" | "pr" | "screen";
const WHERE: Record<string, string> = { parked: "⏸ parked", background: "◌ bg", attached: "◉ bg" };
const TABS: Tab[] = ["overview", "plan", "pr", "screen"];
const TAB_NAME: Record<Tab, string> = { overview: "overview", plan: "plan", pr: "PR preview", screen: "terminal" };

const kind = (s: SessionRow) =>
  BLOCKED.includes(s.state) ? "blocked" : s.state === "waiting" ? "waiting" : s.mode === "plan" ? "planning" : "working";
const tint = (s: SessionRow) =>
  s.state === "ended" ? A.grey : { blocked: A.red, waiting: A.amber, planning: A.blue, working: A.green }[kind(s)];
const ended = (s: SessionRow) => s.state === "ended";
const DAY = 24 * 3600_000;

/** Idle sessions show when they were last active; active ones how long they have been in their state. */
const ageOf = (s: SessionRow) => (isStale(s) ? s.updated_at : s.state_since);

/** Brighter means fresher: under 2h bright, under a day normal, older dim. */
function ageTint(ts: number): string {
  const ms = Date.now() - ts;
  return ms < 2 * 3600_000 ? `${A.bold}` : ms < 24 * 3600_000 ? "" : `${A.grey}${A.dim}`;
}

/** "lost" sessions vanished without exiting (crash, reboot, killed window); the others ended on purpose. */
const endedLabel = (s: SessionRow) =>
  ({ lost: "lost", closed: "closed", exited: "exited" })[s.end_reason as "lost" | "closed" | "exited"] ?? "ended";

const idleLabel = () => {
  const h = Math.round(STALE_AFTER_MS / 3600_000);
  return h % 24 === 0 ? `${h / 24}d` : `${h}h`;
};

// --- ANSI-aware text helpers -------------------------------------------------

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;
const visible = (s: string) => Bun.stringWidth(s.replace(ANSI, ""));

/** Truncates to `width` visible columns (keeping escape codes) and pads with spaces. */
function fit(line: string, width: number, bg = ""): string {
  if (width <= 0) return "";
  let out = "";
  let w = 0;
  let i = 0;
  while (i < line.length) {
    ANSI.lastIndex = i;
    const m = ANSI.exec(line);
    if (m && m.index === i) {
      out += m[0];
      i += m[0].length;
      continue;
    }
    const ch = String.fromCodePoint(line.codePointAt(i)!);
    const cw = Bun.stringWidth(ch);
    if (w + cw > width) break;
    out += ch;
    w += cw;
    i += ch.length;
  }
  return `${out}${A.reset}${bg}${" ".repeat(Math.max(0, width - w))}`;
}

function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const para of text.split("\n")) {
    let cur = "";
    for (const word of para.split(/(\s+)/)) {
      if (visible(cur + word) > width && cur.trim()) {
        lines.push(cur.trimEnd());
        cur = word.trimStart();
      } else cur += word;
    }
    lines.push(cur.trimEnd());
  }
  return lines;
}

// --- rendering through glow / delta, cached per input and width -----------

const cache = new Map<string, string[]>();
function external(key: string, cmd: string[], input: string, fallback: () => string[]): string[] {
  const hit = cache.get(key);
  if (hit) return hit;
  let lines: string[];
  if (Bun.which(cmd[0])) {
    const p = Bun.spawnSync(cmd, { stdin: new TextEncoder().encode(input), stdout: "pipe", stderr: "ignore" });
    lines = p.exitCode === 0 ? p.stdout.toString().replace(/\s+$/, "").split("\n").map((l) => l.replace(/ +(\x1b\[[0-9;]*m)*$/, "")) : fallback();
  } else lines = fallback();
  if (cache.size > 200) cache.clear();
  cache.set(key, lines);
  return lines;
}

const markdown = (key: string, text: string, width: number) =>
  external(`md:${key}:${width}`, ["glow", "-s", "dark", "-w", String(width), "-"], text, () => wrap(text, width));

const diff = (key: string, text: string, width: number) =>
  external(`diff:${key}:${width}`, ["delta", "--paging=never", `--width=${width}`], text, () =>
    text.split("\n").map((l) =>
      l.startsWith("+") ? `${A.green}${l}` : l.startsWith("-") ? `${A.red}${l}` : l.startsWith("@@") ? `${A.blue}${l}` : l,
    ),
  );

// --- state -------------------------------------------------------------------

let sessions: SessionRow[] = [];
let selectedId: string | null = null;
let tab: Tab = "overview";
let tabPinned = false;
let scroll = 0;
let follow = true;
let replying: string | null = null;
let composing: string | null = null;
let confirmClose: string | null = null;
let confirmResumeLost = false;
/** Resumable ended sessions: by default only ones lost in the last day; `e` shows everything ended in the last week. */
let endedRows: SessionRow[] = [];
let showWeekOfEnded = false;
/** Active `/` filter query; null when not filtering. */
let filter: string | null = null;
let order: core.SortOrder = "oldest";
let flash: { text: string; until: number } | null = null;
let lastVersion = -1;
let lastReconcile = 0;
let contentHeight = 10;
const logCache = new Map<string, { at: number; text: string | null }>();

const out = process.stdout;
const cols = () => out.columns ?? 120;
const rows = () => out.rows ?? 40;
/** Live sessions in display order, then ended ones (most recently ended first). */
const allRows = () => [...sessions, ...endedRows];
const selected = () => allRows().find((s) => s.id === selectedId) ?? null;

/** Short identifying fields match fuzzily; status and reply text only match the words as typed. */
function matchScore(s: SessionRow, query: string): number | null {
  const names = [core.displayName(s), s.title, core.location(s), s.agent, s.tmux_target, s.cwd?.replace(/^\/Users\/[^/]+/, "~")]
    .filter(Boolean)
    .join(" ");
  const text = [label(s), s.detail, s.last_prompt].filter(Boolean).join(" ");
  const a = fuzzyScore(query, names);
  const b = fuzzyScore(query, `${names} ${text}`, { substringOnly: true });
  return a === null ? b : b === null ? a : Math.max(a, b);
}

/** Sessions the list shows: all of them, or the ones matching the `/` filter. */
function visibleSessions(): SessionRow[] {
  if (!filter?.trim()) return allRows();
  return allRows().filter((s) => matchScore(s, filter!) !== null);
}

/** Moves the selection to the best match whenever the query changes or the selection drops out of the results. */
function selectBestMatch() {
  if (!filter?.trim()) return;
  let best: SessionRow | null = null;
  let bestScore = -Infinity;
  for (const s of allRows()) {
    const score = matchScore(s, filter);
    if (score !== null && score > bestScore) {
      best = s;
      bestScore = score;
    }
  }
  if (best) select(best.id);
}

function defaultTab(s: SessionRow): Tab {
  if (s.state === "plan_review" && db.latestArtifact(s.id, "plan")) return "plan";
  if (s.state === "pr_review" && db.latestArtifact(s.id, "pr")) return "pr";
  if (s.state === "needs_approval" || s.state === "question") return "screen";
  return "overview";
}

function available(s: SessionRow, t: Tab): boolean {
  if (t === "plan") return !!db.latestArtifact(s.id, "plan");
  if (t === "pr") return !!db.latestArtifact(s.id, "pr");
  if (t === "screen") return !ended(s) && (!!s.pane || !!s.bg);
  return true;
}

function refresh(force = false) {
  const now = Date.now();
  if (now - lastReconcile > 10_000) {
    lastReconcile = now;
    core.reconcile();
    force = true;
  }
  const v = db.open().query<{ data_version: number }, []>("PRAGMA data_version").get()?.data_version ?? 0;
  if (!force && v === lastVersion) return false;
  lastVersion = v;
  const before = selected();
  sessions = core.sorted(order).filter((s) => s.pane !== process.env.TMUX_PANE);
  endedRows = showWeekOfEnded ? db.endedSessions(7 * DAY) : core.lostSessions().reverse();
  if (!selected()) selectedId = sessions[0]?.id ?? null;
  if (filter?.trim() && !visibleSessions().some((x) => x.id === selectedId)) selectBestMatch();
  const s = selected();
  if (s && !tabPinned && (s.id !== before?.id || s.state !== before?.state)) {
    tab = defaultTab(s);
    scroll = 0;
    follow = true;
  }
  return true;
}

function select(id: string | null) {
  if (!id || id === selectedId) return;
  selectedId = id;
  tabPinned = false;
  const s = selected();
  if (s) tab = defaultTab(s);
  scroll = 0;
  follow = true;
}

// --- drawing -----------------------------------------------------------------

function listLines(width: number, height: number): string[] {
  const lines: string[] = [];
  let selLine = 0;
  const groups: [string, (s: SessionRow) => boolean][] = [
    ["NEEDS YOU", (s) => !ended(s) && !isStale(s) && kind(s) === "blocked"],
    ["YOUR TURN", (s) => !ended(s) && !isStale(s) && kind(s) === "waiting"],
    ["WORKING", (s) => !ended(s) && !isStale(s) && (kind(s) === "working" || kind(s) === "planning")],
    [`IDLE · no activity for ${idleLabel()}+`, (s) => !ended(s) && isStale(s)],
    [
      showWeekOfEnded
        ? "ENDED · last week · enter resumes · e shows only lost"
        : "LOST · last day · enter resumes one, R all · e shows everything ended",
      ended,
    ],
  ];
  for (const [title, match] of groups) {
    const items = visibleSessions().filter(match);
    if (!items.length) continue;
    if (lines.length) lines.push("");
    const [head, ...rest] = title.split(" · ");
    lines.push(` ${A.grey}${head} · ${items.length}${rest.length ? ` · ${rest.join(" · ")}` : ""}${A.reset}`);
    for (const s of items) {
      const sel = s.id === selectedId;
      if (sel) selLine = lines.length;
      const bg = sel ? A.selBg : "";
      const gone = ended(s);
      const idle = gone || isStale(s);
      const dot = idle ? `${A.dim}${tint(s)}` : tint(s);
      const marker = sel ? `${gone ? A.amber : tint(s)}▌` : " ";
      const ts = gone ? (s.ended_at ?? s.updated_at) : ageOf(s);
      const age = core.ago(ts);
      const nameMax = Math.max(4, width - age.length - 5);
      const where = core.location(s);
      const tag = where ? ` ${WHERE[where]}` : "";
      const name = fit(core.displayName(s), Math.max(4, nameMax - Bun.stringWidth(tag)), bg).trimEnd();
      lines.push(
        `${bg}${marker}${A.reset}${bg}${dot}${gone ? "✕" : "●"}${A.reset}${bg} ${idle ? A.grey : A.bold}${fit(`${name}${A.reset}${bg}${A.grey}${tag}`, nameMax, bg)}${A.reset}${bg} ${ageTint(ts)}${age}${A.reset}${bg} ${A.reset}`,
      );
      const detail = s.detail ? ` · ${s.detail.replace(/\s+/g, " ")}` : "";
      const status = gone ? endedLabel(s) : label(s);
      lines.push(fit(`${bg}${marker}${A.reset}${bg}   ${gone && s.end_reason === "lost" ? A.amber : idle ? A.grey : tint(s)}${status}${A.reset}${bg}${A.grey}${detail}`, width, bg));
    }
  }
  if (sessions.length && !visibleSessions().length) lines.push("", ` ${A.grey}No sessions match /${filter}${A.reset}`, ` ${A.grey}esc clears the filter${A.reset}`);
  if (!sessions.length) lines.push("", ` ${A.grey}No live sessions.${A.reset}`, ` ${A.grey}Agents with carriot hooks show up here.${A.reset}`);
  const start = Math.max(0, Math.min(selLine - Math.floor(height / 2), lines.length - height));
  return lines.slice(start, start + height);
}

function content(s: SessionRow, width: number): string[] {
  if (tab === "overview") {
    const lines: string[] = [];
    if (s.last_prompt) lines.push(`${A.grey}LAST PROMPT${A.reset}`, ...wrap(`› ${s.last_prompt}`, width).map((l) => `${A.bold}${l}${A.reset}`), "");
    if (s.state !== "waiting" && s.detail) lines.push(`${A.grey}NOW${A.reset}`, ...wrap(s.detail, width), "");
    if (s.last_message) lines.push(`${A.grey}LAST REPLY${A.reset}`, ...markdown(`msg:${s.id}:${s.updated_at}`, s.last_message, width));
    return lines.length ? lines : [`${A.grey}Nothing captured yet.${A.reset}`];
  }
  if (tab === "plan") {
    const a = db.latestArtifact(s.id, "plan");
    return a ? markdown(`plan:${a.id}`, a.body, width) : [`${A.grey}No plan captured.${A.reset}`];
  }
  if (tab === "pr") {
    const a = db.latestArtifact(s.id, "pr");
    if (!a) return [`${A.grey}No PR preview captured.${A.reset}`];
    const m = JSON.parse(a.meta ?? "{}");
    return [
      ...wrap(a.title ?? "(untitled)", width).map((l) => `${A.bold}${l}${A.reset}`),
      `${A.grey}${m.url ? `opened ${m.url}` : m.draft ? "draft · not created yet" : "not created yet"} · ${A.blue}${m.head ?? "?"}${A.grey} → ${A.blue}${m.base ?? "?"}${A.grey}${m.stat ? ` · ${m.stat}` : ""}${A.reset}`,
      "",
      ...(m.commits ?? []).map((c: string) => `  ${A.amber}${c.slice(0, 7)}${A.reset}${c.slice(7)}`),
      "",
      `${A.grey}DESCRIPTION${A.reset}`,
      ...markdown(`prbody:${a.id}`, a.body || "_No description._", width),
      "",
      `${A.grey}FILES CHANGED${A.reset}`,
      ...(a.diff ? diff(`prdiff:${a.id}`, a.diff, width) : [`${A.grey}No diff captured.${A.reset}`]),
    ];
  }
  // `claude logs` costs a process spawn, so a detached background session's output refreshes every few seconds.
  let text: string | null;
  if (s.pane) text = tmux.capture(s.pane, 300);
  else {
    const hit = logCache.get(s.id);
    if (hit && Date.now() - hit.at < 3000) text = hit.text;
    else {
      text = core.screen(s, 300);
      logCache.set(s.id, { at: Date.now(), text });
    }
  }
  return (text ?? "no terminal output available").replace(/\n+$/, "").split("\n");
}

function detailLines(width: number, height: number): string[] {
  const s = selected();
  if (!s) return [];
  const head = [
    ended(s)
      ? `${A.bold}${core.displayName(s)}${A.reset}  ${s.end_reason === "lost" ? A.amber : A.grey}${A.bold}${endedLabel(s)}${A.reset} ${A.grey}${core.ago(s.ended_at ?? s.updated_at)} ago · enter resumes${A.reset}`
      : `${A.bold}${core.displayName(s)}${A.reset}  ${tint(s)}${A.bold}${label(s)}${A.reset} ${A.grey}for ${core.ago(s.state_since)}${A.reset}`,
    `${A.grey}${[s.agent, (s.cwd ?? "").replace(/^\/Users\/[^/]+/, "~"), s.tmux_target, s.mode && s.mode !== "default" ? `mode ${s.mode}` : null, s.id.slice(0, 8)].filter(Boolean).join(" · ")}${A.reset}`,
    TABS.map((t, i) => {
      const on = available(s, t);
      const txt = ` ${i + 1} ${TAB_NAME[t]} `;
      return t === tab ? `${A.inverse}${txt}${A.reset}` : on ? txt : `${A.grey}${A.dim}${txt}${A.reset}`;
    }).join(" "),
    `${A.grey}${"─".repeat(width)}${A.reset}`,
  ];
  const body = content(s, width);
  contentHeight = Math.max(1, height - head.length);
  const maxScroll = Math.max(0, body.length - contentHeight);
  if (tab === "screen" && follow) scroll = maxScroll;
  scroll = Math.max(0, Math.min(scroll, maxScroll));
  const shown = body.slice(scroll, scroll + contentHeight);
  if (maxScroll > 0) {
    const pct = Math.round((scroll / maxScroll) * 100);
    head[3] = `${A.grey}${"─".repeat(Math.max(0, width - 8))} ${String(pct).padStart(3)}% ─${A.reset}`;
  }
  return [...head, ...shown];
}

function header(width: number): string {
  const count = { blocked: 0, waiting: 0, working: 0, idle: 0 };
  for (const s of sessions) count[isStale(s) ? "idle" : kind(s) === "planning" ? "working" : (kind(s) as keyof typeof count)]++;
  const lost = core.lostSessions().length;
  const left = ` ${A.bold}CARRIOT REINS${A.reset}   ${A.red}● ${count.blocked} need you${A.reset}   ${A.amber}● ${count.waiting} your turn${A.reset}   ${A.green}● ${count.working} working${A.reset}   ${A.grey}○ ${count.idle} idle${A.reset}${lost ? `   ${A.amber}${A.bold}↻ ${lost} lost · R resumes all${A.reset}` : ""}`;
  const clock = `${A.grey}${order === "oldest" ? "longest waiting first" : "most recent first"} · ${A.reset}${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  return fit(`${left}${" ".repeat(Math.max(1, width - visible(left) - visible(clock) - 1))}${A.grey}${clock}${A.reset}`, width);
}

function footer(width: number): string {
  if (filter !== null) {
    const n = visibleSessions().length;
    return fit(
      `${A.inverse} / ${A.reset} ${A.bold}${filter}${A.reset}${A.inverse} ${A.reset}  ${A.grey}${n} match${n === 1 ? "" : "es"} · enter jump · ↑↓ ^n/^p move · ^u clear · esc done${A.reset}`,
      width,
    );
  }
  if (confirmResumeLost) {
    const n = core.lostSessions().length;
    return fit(`${A.inverse}${A.amber} resume ${A.reset} ${A.bold}${n} lost session${n === 1 ? "" : "s"}${A.reset} ${A.grey}from the last day in new windows?${A.reset}  ${A.bold}y${A.reset} ${A.grey}resume · any other key cancels${A.reset}`, width);
  }
  const closing = confirmClose ? sessions.find((x) => x.id === confirmClose) : null;
  if (closing)
    return fit(`${A.inverse}${A.red} close ${A.reset} ${A.bold}${core.displayName(closing)}${A.reset} ${A.grey}and its pane? the conversation stays resumable${A.reset}  ${A.bold}y${A.reset} ${A.grey}close · any other key cancels${A.reset}`, width);
  if (composing !== null)
    return fit(`${A.inverse} new agent ${A.reset} ${A.grey}first prompt (optional):${A.reset} ${composing}${A.inverse} ${A.reset}  ${A.grey}enter start · esc cancel${A.reset}`, width);
  if (replying !== null) {
    const s = selected();
    return fit(`${A.inverse} reply ${A.reset} ${A.grey}to ${s ? core.displayName(s) : "?"}:${A.reset} ${replying}${A.inverse} ${A.reset}  ${A.grey}enter send · esc cancel${A.reset}`, width);
  }
  if (flash && flash.until > Date.now()) return fit(` ${A.bold}${flash.text}${A.reset}`, width);
  const keys = [
    ["j/k ^n/^p", "move"], ["/", "find"], ["s", "sort"], ["enter", "open"], ["n", "next waiting"], ["1-4", "tabs"], ["J/K ^d/^u", "scroll"],
    ["r", "reply"], ["p", "park"], ["a", "new"], ["x", "close"], ["R", "resume lost"], ["o", "web"], ["q", "quit"],
  ];
  return fit(` ${keys.map(([k, v]) => `${A.bold}${k}${A.reset} ${A.grey}${v}${A.reset}`).join("  ")}`, width);
}

function draw() {
  const W = cols();
  const H = rows();
  const bodyH = H - 3;
  const lines: string[] = [header(W), `${A.grey}${"─".repeat(W)}${A.reset}`];
  if (W >= 110) {
    const listW = Math.min(52, Math.max(36, Math.floor(W * 0.34)));
    const detailW = W - listW - 3;
    const left = listLines(listW, bodyH);
    const right = detailLines(detailW, bodyH);
    for (let i = 0; i < bodyH; i++) lines.push(`${fit(left[i] ?? "", listW)} ${A.grey}│${A.reset} ${fit(right[i] ?? "", detailW)}`);
  } else {
    const listH = Math.max(6, Math.min(Math.floor(bodyH * 0.4), visibleSessions().length * 2 + 4));
    const left = listLines(W, listH);
    const right = detailLines(W - 2, bodyH - listH - 1);
    for (let i = 0; i < listH; i++) lines.push(fit(left[i] ?? "", W));
    lines.push(`${A.grey}${"─".repeat(W)}${A.reset}`);
    for (let i = 0; i < bodyH - listH - 1; i++) lines.push(` ${fit(right[i] ?? "", W - 1)}`);
  }
  lines.push(footer(W));
  out.write(`${ESC}?25l${ESC}H${lines.map((l) => `${l}${ESC}K`).join("\r\n")}`);
}

// --- input -------------------------------------------------------------------

function say(text: string) {
  flash = { text, until: Date.now() + 2000 };
}

function move(delta: number) {
  const list = visibleSessions();
  const i = list.findIndex((s) => s.id === selectedId);
  select(list[Math.max(0, Math.min(list.length - 1, i + delta))]?.id ?? null);
}

function jump(s: SessionRow | null) {
  if (!s) return;
  if (ended(s)) {
    const r = core.resume(s);
    if (!r.ok) return say(r.message);
    if (r.pane) tmux.jump(r.pane, false);
    else say(r.message);
    refresh(true);
    return;
  }
  const r = core.reconnect(s);
  if (r.error || !r.pane) return say(r.error ?? "Could not reach that session.");
  tmux.jump(r.pane, false);
}

function toggleAway(s: SessionRow | null) {
  if (!s) return;
  if (core.location(s) === "parked") {
    const r = core.reconnect(s);
    say(r.error ?? `${core.displayName(s)} is back in this tmux session.`);
  } else say(core.sendAway(s).message);
  refresh(true);
}

function onKey(key: string) {
  if (filter !== null) {
    if (key === "\x1b") filter = null;
    else if (key === "\r") {
      filter = null;
      jump(selected());
    } else if (key === "\x1b[A" || key === "\x10") move(-1);
    else if (key === "\x1b[B" || key === "\x0e") move(1);
    else if (key === "\x15") filter = "";
    else if (key === "\x7f") {
      filter = filter.slice(0, -1);
      selectBestMatch();
    } else if (key >= " " && !key.startsWith("\x1b")) {
      filter += key;
      selectBestMatch();
    }
    return;
  }
  if (confirmResumeLost) {
    confirmResumeLost = false;
    if (key === "y") {
      say(core.resumeLost().message);
      refresh(true);
    }
    return;
  }
  if (confirmClose !== null) {
    const s = sessions.find((x) => x.id === confirmClose);
    confirmClose = null;
    if (key === "y" && s) {
      say(core.close(s).message);
      refresh(true);
    }
    return;
  }
  if (composing !== null) {
    if (key === "\x1b") composing = null;
    else if (key === "\r") {
      const r = core.newAgent({ prompt: composing, cwd: process.env.CARRIOT_NEW_CWD ?? `${import.meta.dir}/../../..` });
      composing = null;
      say(r.message);
    } else if (key === "\x7f") composing = composing.slice(0, -1);
    else if (key >= " " && !key.startsWith("\x1b")) composing += key;
    return;
  }
  if (replying !== null) {
    if (key === "\x1b") replying = null;
    else if (key === "\r") {
      const s = selected();
      if (s?.pane && replying.trim()) say(tmux.sendText(s.pane, replying) ? `Sent to ${core.displayName(s)}` : "Could not send");
      replying = null;
    } else if (key === "\x7f") replying = replying.slice(0, -1);
    else if (key >= " " && !key.startsWith("\x1b")) replying += key;
    return;
  }
  const page = Math.max(1, Math.floor(contentHeight / 2));
  const scrollBy = (n: number) => {
    scroll = Math.max(0, scroll + n);
    follow = false;
  };
  switch (key) {
    case "q":
    case "\x03":
      return quit();
    case "j":
    case "\x1b[B":
    case "\x0e": // ctrl-n
      return move(1);
    case "k":
    case "\x1b[A":
    case "\x10": // ctrl-p
      return move(-1);
    case "g":
      return select(visibleSessions()[0]?.id ?? null);
    case "G":
      return select(visibleSessions().at(-1)?.id ?? null);
    case "/":
      filter = "";
      return;
    case "s":
      order = order === "oldest" ? "newest" : "oldest";
      refresh(true);
      return say(order === "oldest" ? "Sorted by longest waiting first" : "Sorted by most recent first");
    case "\r":
      return jump(selected());
    case "n": {
      const s = sessions.find((x) => x.state !== "working");
      return s ? jump(s) : say("Nobody is waiting on you.");
    }
    case "J":
      return scrollBy(1);
    case "K":
      return scrollBy(-1);
    case "\x04":
    case "\x1b[6~":
    case " ":
      return scrollBy(page);
    case "\x15":
    case "\x1b[5~":
      return scrollBy(-page);
    case "\t":
    case "\x1b[Z": {
      const s = selected();
      if (!s) return;
      const dir = key === "\t" ? 1 : -1;
      let i = TABS.indexOf(tab);
      for (let n = 0; n < TABS.length; n++) {
        i = (i + dir + TABS.length) % TABS.length;
        if (available(s, TABS[i])) break;
      }
      tab = TABS[i];
      tabPinned = true;
      scroll = 0;
      follow = true;
      return;
    }
    case "r": {
      const s = selected();
      if (s?.pane) replying = "";
      else say(s?.bg ? "Press enter to attach first, then reply." : "That session is not in tmux.");
      return;
    }
    case "p":
      if (selected() && ended(selected()!)) return say("That session has ended; enter resumes it.");
      return toggleAway(selected());
    case "a":
      composing = "";
      return;
    case "R":
      if (core.lostSessions().length) confirmResumeLost = true;
      else say("Nothing lost in the last day.");
      return;
    case "e":
      showWeekOfEnded = !showWeekOfEnded;
      refresh(true);
      return say(showWeekOfEnded ? "Showing every session ended in the last week" : "Showing only sessions lost in the last day");
    case "x":
      if (selected() && ended(selected()!)) return say("That session has already ended.");
      confirmClose = selected()?.id ?? null;
      return;
    case "o": {
      const s = selected();
      Bun.spawn([process.env.CARRIOT_BIN ?? "carriot", "open", ...(s ? [s.id] : [])], { stdout: "ignore", stderr: "ignore" });
      return say("Opening the web dashboard…");
    }
  }
  if (/^[1-4]$/.test(key)) {
    const s = selected();
    const t = TABS[Number(key) - 1];
    if (s && available(s, t)) {
      tab = t;
      tabPinned = true;
      scroll = 0;
      follow = true;
    } else say(`No ${TAB_NAME[t]} for this session.`);
  }
}

/** Splits a raw stdin chunk into individual keys (escape sequences stay whole). */
function keys(chunk: string): string[] {
  const res: string[] = [];
  for (let i = 0; i < chunk.length; ) {
    if (chunk[i] === "\x1b" && chunk[i + 1] === "[") {
      const m = chunk.slice(i).match(/^\x1b\[[0-9;]*[A-Za-z~]/);
      if (m) {
        res.push(m[0]);
        i += m[0].length;
        continue;
      }
    }
    const ch = String.fromCodePoint(chunk.codePointAt(i)!);
    res.push(ch);
    i += ch.length;
  }
  return res;
}

let timers: ReturnType<typeof setInterval>[] = [];

function quit() {
  for (const t of timers) clearInterval(t);
  out.write(`${ESC}?25h${ESC}?1049l`);
  process.stdin.setRawMode?.(false);
  process.exit(0);
}

export function reins() {
  if (!process.stdin.isTTY) {
    console.error("carriot reins needs a terminal");
    process.exit(1);
  }
  out.write(`${ESC}?1049h${ESC}?25l${ESC}2J`);
  process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    for (const k of keys(chunk)) onKey(k);
    draw();
  });
  out.on("resize", () => {
    out.write(`${ESC}2J`);
    draw();
  });
  process.on("SIGTERM", quit);
  process.on("SIGHUP", quit);
  process.on("uncaughtException", (err) => {
    out.write(`${ESC}?25h${ESC}?1049l`);
    console.error(err);
    process.exit(1);
  });
  refresh(true);
  draw();
  let polling = false;
  const pollBackground = async () => {
    if (polling) return;
    polling = true;
    try {
      core.syncBackground(await core.listBackgroundAsync());
      refresh(true);
      draw();
    } finally {
      polling = false;
    }
  };
  pollBackground();
  timers = [
    setInterval(() => {
      if (refresh()) draw();
    }, 400),
    setInterval(pollBackground, 10_000),
    // Ages, the clock, and the live terminal tab tick even when nothing was written.
    setInterval(() => draw(), 1000),
  ];
}
