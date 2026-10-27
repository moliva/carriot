import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { adapt as claude } from "./adapters/claude";
import * as core from "./core";
import * as db from "./db";
import { ansiFg, COLOUR, DELTA_THEME, GLOW_STYLE } from "./palette";
import * as tmux from "./tmux";
import { BLOCKED, isStale, label, type SessionRow, type State } from "./types";

const ADAPTERS: Record<string, (payload: any) => ReturnType<typeof claude>> = { claude };

const C = {
  red: ansiFg(COLOUR.blocked),
  yellow: ansiFg(COLOUR.waiting),
  green: ansiFg(COLOUR.working),
  blue: ansiFg(COLOUR.planning),
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  reset: "\x1b[0m",
};
const color = (s: SessionRow) =>
  isStale(s) ? C.dim : BLOCKED.includes(s.state) ? C.red : s.state === "waiting" ? C.yellow : s.mode === "plan" ? C.blue : C.green;

const self = () => `${process.env.CARRIOT_BIN ?? "carriot"}`;

const CHEATSHEET = (c: typeof C) => `${c.bold}CARRIOT CHEATSHEET${c.reset}  ${c.dim}one chariot, many horses: see who is pulling and who is waiting on you${c.reset}

${c.bold}AFTER A REBOOT${c.reset}  sessions come back on their own once tmux restores its windows. If any are missing:
  prefix R (or R in reins) reopens everything lost in the last day; older ones: reins, e, then enter on each

${c.red}●${c.reset} needs you   ${c.yellow}●${c.reset} your turn   ${c.blue}●${c.reset} planning   ${c.green}●${c.reset} working
idle: no activity for a day (CARRIOT_STALE_AFTER_HOURS); grouped last, grey ○ in tmux; prefix b reaches them only when nothing active waits
⏸ parked (hidden tmux session)   ◌ bg (claude --bg, detached)   ◉ bg (attached in a window)
enter / jump reconnects anything: parked sessions come back, background ones open a \`claude attach\` window

${c.bold}TMUX${c.reset}  ${c.dim}(prefix = C-a)${c.reset}
  prefix A          new agent window (claude --dangerously-skip-permissions)
  prefix T          reins: every session, full screen (stays open in a "reins" window)
  prefix F          picker popup
  prefix b          jump to the session that has waited on you the longest
  prefix P          park the current agent (it keeps running out of sight)
  prefix X          close the current agent and its pane (asks first)
  prefix R          resume every session lost in the last day (asks first)
  prefix G          this cheatsheet

${c.bold}WEZTERM${c.reset}  ${c.dim}(no prefix needed)${c.reset}
  cmd+shift+t       new agent window          cmd+b         next waiting
  cmd+shift+a       reins (all sessions)      cmd+g         picker popup
  cmd+shift+p       park the current agent    cmd+shift+o   web dashboard
  cmd+shift+w       close the current agent   cmd+/         this cheatsheet

${c.bold}REINS${c.reset}  ${c.dim}carriot reins${c.reset}
  j k  ↑ ↓  ^n ^p   move between sessions        g G   first / last
  /                 fuzzy find (type to narrow, enter jumps, esc clears)
  s                 sort: longest waiting first / most recent first
  enter             jump to the session's pane   n     jump to next waiting
  1 2 3 4  tab      overview / plan / PR preview / terminal
  J K  ^d ^u  space scroll the right-hand pane
  enter on ended    resume it (claude --resume in a new window, same directory and mode)
  R                 resume every session lost in the last day
  e                 show every session ended in the last week (default: only lost ones)
  r                 reply (type, enter sends, esc cancels)
  p                 park / unpark; detach from a background session
  a                 new agent window (type an optional first prompt, enter starts it)
  x                 close the selected session and its pane (y to confirm)
  o                 open in the web dashboard    q     quit

${c.bold}PICKER POPUP${c.reset}  ${c.dim}carriot pick${c.reset}
  type to filter    enter jump    ctrl-p plan    ctrl-r PR preview
  ctrl-s terminal   ctrl-o web    ctrl-x park       ctrl-l reload

${c.bold}WEB DASHBOARD${c.reset}
  carriot open        open it in an app window (starts the server in the background if needed)
  carriot serve       run the server in the foreground instead
  carriot stop        stop the background server
  j k move · o open in terminal · reply box at the bottom · enable notifications in the sidebar

${c.bold}COMMANDS${c.reset}
  carriot new [prompt]          new tmux window running claude --dangerously-skip-permissions
            [--bg]            start it as a background session instead (needs a prompt)
            [--here|--cwd D]  start in this pane's directory / D (default: carriot root)
            [--safe]          keep normal permission prompts
  carriot ls [--json]           list live sessions, most urgent first
  carriot next                  jump to the session that has waited the longest
  carriot jump <name|id>        switch tmux to a session (unparks or attaches first)
  carriot park [name|id]        move a session out of sight; it keeps running
                              (no argument: the current pane; background sessions detach)
  carriot unpark <name|id>      bring a parked session back without switching to it
  carriot close [name|id]       end a session and close its pane (no argument: the current pane);
                              background sessions are stopped. Bring it back with carriot resume
  carriot resume <name|id>      reopen an ended session (claude --resume, same directory and mode)
  carriot resume --lost         reopen everything lost in the last day (crash, reboot, killed window)
  carriot ls --ended            list ended sessions from the last week
  carriot plan <name|id>        show the latest plan
  carriot pr <name|id>          show the latest PR preview
  carriot screen <name|id>      print the session's terminal
  carriot prune                 forget sessions whose pane is gone
  carriot emit --agent A --session S --state STATE [--detail D]
                              report state from agents without a hook adapter
  carriot hook <agent>          hook entry point (agents: ${Object.keys(ADAPTERS).join(", ")})

${c.bold}ENVIRONMENT${c.reset}
  CARRIOT_PR_GATE=0   record PR previews without asking for confirmation
  CARRIOT_PORT        dashboard port (7777)      CARRIOT_DEBUG=1   log raw hook payloads
  CARRIOT_DB          database path (~/.local/state/carriot/carriot.db)
`;

function usage(): never {
  console.log(CHEATSHEET(C));
  process.exit(1);
}

function need(ref: string | undefined): SessionRow {
  core.reconcile();
  const s = ref ? core.resolve(ref) : null;
  if (!s) {
    console.error(`no live session matching '${ref ?? ""}'`);
    process.exit(1);
  }
  return s;
}

function which(bin: string): boolean {
  return Bun.which(bin) !== null;
}

async function pipeTo(cmd: string[], input: string) {
  const p = Bun.spawn(cmd, { stdin: "pipe", stdout: "inherit", stderr: "inherit" });
  p.stdin.write(input);
  p.stdin.end();
  await p.exited;
}

async function markdown(text: string) {
  const width = Number(process.env.FZF_PREVIEW_COLUMNS) || process.stdout.columns || 100;
  if (which("glow")) return pipeTo(["glow", "-s", GLOW_STYLE, "-w", String(Math.min(width, 120)), "-"], text);
  if (which("bat")) return pipeTo(["bat", "-l", "md", "--style=plain", "--color=always", "--paging=never"], text);
  process.stdout.write(`${text}\n`);
}

async function diff(text: string) {
  if (which("delta")) return pipeTo(["delta", "--paging=never", ...DELTA_THEME], text);
  const out = text
    .split("\n")
    .map((l) =>
      l.startsWith("diff --git") ? `\n${C.bold}${l}${C.reset}`
      : l.startsWith("+++") || l.startsWith("---") ? `${C.bold}${l}${C.reset}`
      : l.startsWith("@@") ? `${C.blue}${l}${C.reset}`
      : l.startsWith("+") ? `${C.green}${l}${C.reset}`
      : l.startsWith("-") ? `${C.red}${l}${C.reset}`
      : l,
    )
    .join("\n");
  process.stdout.write(`${out}\n`);
}

const WHERE: Record<string, string> = { parked: "⏸ parked", background: "◌ bg", attached: "◉ bg" };

/**
 * Feedback for commands bound to tmux keys: printed output there opens a view you must dismiss,
 * so inside tmux it becomes a short status-line message instead.
 */
function notify(message: string, error = false) {
  // TMUX alone (no pane) is a tmux hook such as tmux-resurrect's post-restore one.
  if ((process.env.TMUX_PANE || process.env.TMUX) && tmux.flash(`carriot: ${message}`, error ? 4000 : 3000)) return;
  if (error) {
    console.error(message);
    process.exit(1);
  }
  console.log(message);
}

function reconnectAndJump(s: SessionRow) {
  const r = core.reconnect(s);
  if (r.error || !r.pane) return notify(r.error ?? "could not reach that session", true);
  tmux.jump(r.pane, !process.env.TMUX);
}

function row(s: SessionRow, width = 40): string {
  const where = core.location(s);
  const name = `${core.displayName(s).slice(0, where ? 19 : 28)}${where ? ` ${C.dim}${WHERE[where]}${C.reset}${C.bold}` : ""}`;
  const pad = 28 - Bun.stringWidth(name.replace(/\x1b\[[0-9;]*m/g, ""));
  const padded = `${name}${" ".repeat(Math.max(0, pad))}`;
  const st = label(s).padEnd(14);
  const age = core.ago(isStale(s) ? s.updated_at : s.state_since).padStart(4);
  const detail = (s.detail ?? "").replace(/\s+/g, " ").slice(0, width);
  return `${color(s)}●${C.reset} ${C.bold}${padded}${C.reset} ${color(s)}${st}${C.reset} ${C.dim}${age}${C.reset}  ${detail}`;
}

async function preview(s: SessionRow) {
  console.log(`${C.bold}${core.displayName(s)}${C.reset}  ${color(s)}${label(s)}${C.reset} for ${core.ago(s.state_since)}`);
  console.log(`${C.dim}${s.agent} · ${s.cwd ?? "?"} · ${s.tmux_target ?? s.pane ?? "no tmux"} · ${s.id.slice(0, 8)}${C.reset}`);
  const plan = db.latestArtifact(s.id, "plan");
  const pr = db.latestArtifact(s.id, "pr");
  if (plan || pr)
    console.log(`${C.dim}${[plan && "ctrl-p: plan", pr && "ctrl-r: PR preview"].filter(Boolean).join(" · ")}${C.reset}`);
  if (s.last_prompt) console.log(`\n${C.bold}› ${s.last_prompt}${C.reset}`);
  if (s.state === "pr_review" && pr) {
    const meta = JSON.parse(pr.meta ?? "{}");
    console.log(`\n${C.bold}PR: ${pr.title}${C.reset}  ${C.dim}${meta.head} → ${meta.base} · ${meta.stat ?? ""}${C.reset}`);
  } else if (s.state === "plan_review" && plan) {
    console.log("");
    await markdown(plan.body.split("\n").slice(0, 60).join("\n"));
    return;
  }
  const body = s.state === "waiting" && s.last_message ? s.last_message : s.detail;
  if (body) {
    console.log("");
    await markdown(body.split("\n").slice(-40).join("\n"));
  }
}

async function pick() {
  if (!which("fzf")) {
    console.error("fzf not found");
    process.exit(1);
  }
  const bin = self();
  const p = Bun.spawn(
    [
      "fzf",
      "--ansi",
      "--no-sort",
      "--layout=reverse",
      "--delimiter=\t",
      "--with-nth=2",
      "--prompt=agents › ",
      "--header=enter jump · ctrl-p plan · ctrl-r PR · ctrl-s screen · ctrl-o web · ctrl-x park · ctrl-l reload",
      `--preview=${bin} preview {1}`,
      "--preview-window=down,60%,wrap",
      `--bind=enter:become(${bin} jump {1})`,
      `--bind=ctrl-p:execute(${bin} plan {1} | less -R)`,
      `--bind=ctrl-r:execute(${bin} pr {1} | less -R)`,
      `--bind=ctrl-s:execute(${bin} screen {1} | less -R +G)`,
      `--bind=ctrl-o:execute-silent(${bin} open {1})`,
      `--bind=ctrl-x:execute-silent(${bin} park {1})+reload(${bin} ls --fzf)`,
      `--bind=ctrl-l:reload(${bin} ls --fzf)`,
      `--bind=start:reload(${bin} ls --fzf)`,
    ],
    { stdin: "pipe", stdout: "inherit", stderr: "inherit" },
  );
  p.stdin.end();
  process.exit(await p.exited);
}

const stateDir = () => dirname(db.DB_PATH);
// Sessions start from the carriot root so its project settings (and the carriot hooks) apply.
const CARRIOT_ROOT = process.env.CARRIOT_NEW_CWD ?? join(import.meta.dir, "../../..");
const pidFile = () => join(stateDir(), "serve.pid");

async function serverUp(port: string): Promise<boolean> {
  try {
    return (await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) })).ok;
  } catch {
    return false;
  }
}

/** Starts `carriot serve` detached (it outlives the caller) unless something already answers on the port. */
async function ensureServer(port: string): Promise<boolean> {
  if (await serverUp(port)) return true;
  mkdirSync(stateDir(), { recursive: true });
  const log = openSync(join(stateDir(), "serve.log"), "a");
  const child = spawn(process.execPath, [join(import.meta.dir, "cli.ts"), "serve", "--port", port], {
    detached: true,
    stdio: ["ignore", log, log],
    env: process.env,
  });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await Bun.sleep(100);
    if (await serverUp(port)) return true;
  }
  return false;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "hook": {
      const agent = rest[0] ?? "claude";
      const adapter = ADAPTERS[agent];
      if (!adapter) return;
      const response = core.handle(agent, await Bun.stdin.text(), adapter);
      if (response) process.stdout.write(JSON.stringify(response));
      return;
    }
    case "emit": {
      const { values: v } = parseArgs({
        args: rest,
        options: {
          agent: { type: "string" },
          session: { type: "string" },
          state: { type: "string" },
          detail: { type: "string" },
          cwd: { type: "string" },
          mode: { type: "string" },
          title: { type: "string" },
        },
      });
      if (!v.agent || !v.session) usage();
      core.ingest({
        agent: v.agent,
        sessionId: v.session,
        state: v.state as State | undefined,
        detail: v.detail,
        cwd: v.cwd ?? process.cwd(),
        mode: v.mode,
        title: v.title,
        pane: process.env.TMUX_PANE,
        refreshTmux: true,
      });
      return;
    }
    case "ls": {
      core.reconcile({ background: true });
      const list = rest.includes("--ended") ? db.endedSessions(7 * 24 * 3600_000) : core.sorted();
      if (rest.includes("--json")) return console.log(JSON.stringify(list, null, 2));
      const width = Math.max(20, (process.stdout.columns ?? 120) - 55);
      if (rest.includes("--fzf")) return console.log(list.map((s) => `${s.id}\t${row(s, width)}`).join("\n"));
      if (!list.length) return console.log(`${C.dim}no live sessions${C.reset}`);
      return console.log(list.map((s) => row(s, width)).join("\n"));
    }
    case "preview":
      return preview(need(rest[0]));
    case "next": {
      core.reconcile({ background: true });
      const s = core.sorted().find((x) => x.state !== "working" && x.pane !== process.env.TMUX_PANE);
      if (!s) return notify("nobody is waiting on you");
      return reconnectAndJump(s);
    }
    case "jump":
      return reconnectAndJump(need(rest[0]));
    case "park": {
      core.reconcile();
      const pane = process.env.TMUX_PANE;
      const s = rest[0] ? need(rest[0]) : core.sorted().find((x) => x.pane === pane);
      if (!s) {
        if (pane && tmux.park(pane)) return notify("parked this pane");
        return notify("no session to park", true);
      }
      const r = core.sendAway(s);
      return notify(r.message, !r.ok);
    }
    case "close": {
      core.reconcile();
      const pane = process.env.TMUX_PANE;
      const s = rest[0] ? need(rest[0]) : core.sorted().find((x) => x.pane === pane);
      if (!s) return notify("no agent session in this pane", true);
      const r = core.close(s);
      return notify(r.message, !r.ok);
    }
    case "resume": {
      core.reconcile();
      if (rest.includes("--lost")) {
        const r = core.resumeLost();
        return notify(r.message, !r.ok);
      }
      const s = rest[0] ? core.resolve(rest[0], { ended: true }) : null;
      if (!s) return notify(rest[0] ? `no session matching '${rest[0]}'` : "usage: carriot resume <name|id> | --lost", true);
      const r = core.resume(s);
      if (!r.ok) return notify(r.message, true);
      if (r.pane) tmux.jump(r.pane, !process.env.TMUX);
      return notify(r.message);
    }
    case "unpark": {
      const s = need(rest[0]);
      const r = core.reconnect(s);
      return r.error ? console.error(r.error) : console.log(`${core.displayName(s)} is back`);
    }
    case "plan": {
      const s = need(rest[0]);
      const a = db.latestArtifact(s.id, "plan");
      if (!a) return console.log("no plan captured for this session");
      return markdown(a.body);
    }
    case "pr": {
      const s = need(rest[0]);
      const a = db.latestArtifact(s.id, "pr");
      if (!a) return console.log("no PR preview captured for this session");
      const m = JSON.parse(a.meta ?? "{}");
      console.log(`${C.bold}${a.title}${C.reset}${m.draft ? `  ${C.dim}[draft]${C.reset}` : ""}`);
      console.log(`${C.dim}${m.head} → ${m.base}${m.repo ? ` · ${m.repo}` : ""} · ${m.stat ?? ""}${m.url ? ` · ${m.url}` : ""}${C.reset}\n`);
      if (m.commits?.length) console.log(`${m.commits.map((c: string) => `  ${C.yellow}${c.slice(0, 7)}${C.reset}${c.slice(7)}`).join("\n")}\n`);
      await markdown(a.body || "_no description_");
      return diff(a.diff ?? "");
    }
    case "screen": {
      const s = need(rest[0]);
      return console.log(core.screen(s) ?? "no terminal output available");
    }
    case "pick":
      return pick();
    case "reins": {
      const { reins } = await import("./reins");
      return reins();
    }
    case "help":
    case "--help":
    case "-h":
      return console.log(CHEATSHEET(C));
    case "serve": {
      const { values: v } = parseArgs({ args: rest, options: { port: { type: "string" } } });
      const { serve } = await import("./server");
      serve(Number(v.port ?? process.env.CARRIOT_PORT ?? 7777));
      mkdirSync(stateDir(), { recursive: true });
      await Bun.write(pidFile(), String(process.pid));
      const cleanup = () => {
        try {
          if (readFileSync(pidFile(), "utf8") === String(process.pid)) rmSync(pidFile());
        } catch {}
        process.exit(0);
      };
      process.on("SIGTERM", cleanup);
      process.on("SIGINT", cleanup);
      return;
    }
    case "stop": {
      if (!existsSync(pidFile())) return console.log("dashboard is not running");
      const pid = Number(readFileSync(pidFile(), "utf8"));
      try {
        process.kill(pid, "SIGTERM");
        console.log(`stopped dashboard (pid ${pid})`);
      } catch {
        console.log("dashboard was not running");
      }
      rmSync(pidFile(), { force: true });
      return;
    }
    case "open": {
      const port = process.env.CARRIOT_PORT ?? "7777";
      if (!(await ensureServer(port))) {
        console.error(`carriot: dashboard did not start; see ${join(stateDir(), "serve.log")}`);
        process.exit(1);
      }
      const url = `http://127.0.0.1:${port}/${rest[0] ? `#${rest[0]}` : ""}`;
      const chrome = "/Applications/Google Chrome.app";
      const args = (await Bun.file(`${chrome}/Contents/Info.plist`).exists())
        ? ["open", "-na", "Google Chrome", "--args", `--app=${url}`]
        : ["open", url];
      Bun.spawnSync(args);
      return;
    }
    case "new": {
      const { values: v, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          bg: { type: "boolean" },
          here: { type: "boolean" },
          safe: { type: "boolean" },
          cwd: { type: "string" },
          name: { type: "string" },
        },
      });
      const r = core.newAgent({
        prompt: positionals.join(" "),
        background: v.bg,
        cwd: v.cwd ?? (v.here ? undefined : CARRIOT_ROOT),
        name: v.name,
        skipPermissions: !v.safe,
      });
      return notify(r.message, !r.ok);
    }
    case "prune":
      return core.reconcile();
    default:
      usage();
  }
}

try {
  await main();
} catch (err) {
  // A hook must never break the agent it observes.
  if (process.argv[2] === "hook") {
    core.logError(err);
    process.exit(0);
  }
  throw err;
}
