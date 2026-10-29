import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import * as core from "./core";
import * as db from "./db";
import * as tmux from "./tmux";
import { label, type SessionRow } from "./types";
import { prLine, type PrStatus } from "./work";

/**
 * The scout: a cheap model that reads the other sessions for you. It runs outside the hub so the hub's CLAUDE.md, the
 * carriot hooks (project settings) and MCP servers never load: it is not tracked as a session, and it can only read.
 * Reins uses it in one-off runs (needs-you lines, briefings, answers, write-ups) and as an interactive pane.
 */

const PROMPT = join(import.meta.dir, "../scout/PROMPT.md");
const HUB = process.env.CARRIOT_NEW_CWD ?? join(import.meta.dir, "../../..");
const TRANSCRIPTS = join(homedir(), ".claude/projects");
const DIR = join(dirname(db.DB_PATH), "scout");
const MODEL = process.env.CARRIOT_SCOUT_MODEL ?? "deepseek/deepseek-v4.1-flash";
const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/** Read-only allowlist; carriot by absolute path, since the agent's shell rebuilds PATH from the user's profile. */
function settings(bin: string) {
  const read = ["ls", "screen", "plan", "pr"].map((c) => `Bash(${bin} ${c}:*)`);
  const git = ["log", "diff", "status", "show"].map((c) => `Bash(git ${c}:*)`);
  const text = ["ls", "tail", "jq", "grep", "wc", "echo"].map((c) => `Bash(${c}:*)`);
  return {
    effortLevel: "low",
    permissions: {
      allow: ["Read", ...read, "Bash(sqlite3 -readonly:*)", ...git, ...text],
      deny: ["Edit", "Write", "NotebookEdit"],
    },
  };
}

/** Writes the prompt and settings next to the database and returns the arguments every scout run shares. */
function base(): string[] {
  mkdirSync(DIR, { recursive: true });
  const bin = process.env.CARRIOT_BIN ?? join(HUB, "bin/carriot");
  const prompt = join(DIR, "prompt.md");
  const where = `\nRun carriot as \`${bin}\` (it is not on PATH).\nCarriot database: ${db.DB_PATH}\nHub: ${HUB} (worktrees under ${join(HUB, "sessions")})\nTranscripts: ${TRANSCRIPTS}\n`;
  writeFileSync(prompt, readFileSync(PROMPT, "utf8") + where);
  writeFileSync(join(DIR, "settings.json"), JSON.stringify(settings(bin), null, 2));
  return [
    "claude",
    "--model", MODEL,
    "--setting-sources", "user",
    "--settings", join(DIR, "settings.json"),
    "--permission-mode", "dontAsk",
    "--append-system-prompt-file", prompt,
    "--add-dir", join(HUB, "sessions"), TRANSCRIPTS,
    // Your MCP servers (from the user config) would only slow a cheap model down; it answers from carriot's data.
    "--strict-mcp-config",
  ];
}

/**
 * One headless scout run; resolves to its answer, or null when it failed or timed out. With `tools: false` the model
 * only sees the prompt (and a short system prompt), which is faster and cheaper for summaries of data we hand it.
 */
export async function run(prompt: string, opts: { tools: boolean; system?: string; timeoutMs?: number }): Promise<string | null> {
  const args = opts.tools
    ? [...base(), "-p", "--no-session-persistence"]
    : [
        "claude", "--model", MODEL, "--setting-sources", "user", "--strict-mcp-config", "--tools", "",
        "--system-prompt", opts.system ?? "You summarize the state of coding agent sessions for their user. Be brief and concrete.",
        "-p", "--no-session-persistence",
      ];
  mkdirSync(DIR, { recursive: true });
  try {
    const p = Bun.spawn(args, { cwd: DIR, stdin: new TextEncoder().encode(prompt), stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => p.kill(), opts.timeoutMs ?? (opts.tools ? 180_000 : 60_000));
    const [text, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
    clearTimeout(timer);
    return code === 0 && text.trim() ? text.trim() : null;
  } catch {
    return null;
  }
}

const clip = (text: string | null | undefined, max: number) =>
  !text ? "" : text.length > max ? `${text.slice(0, max)}…` : text;

function prOf(s: SessionRow): PrStatus | null {
  const w = db.getWork(s.id);
  return w?.pr ? JSON.parse(w.pr) : null;
}

/** What we know about a session, as plain text for a prompt. */
function facts(s: SessionRow, detail: number): string {
  const w = db.getWork(s.id);
  const ticket = w?.ticket ? db.getTicket(w.ticket) : null;
  const pr = prOf(s);
  return [
    `## ${core.displayName(s)} (${s.id})`,
    `state: ${s.state === "ended" ? `ended (${s.end_reason ?? "?"})` : label(s)} for ${core.ago(s.state === "ended" ? (s.ended_at ?? s.updated_at) : s.state_since)}`,
    w?.repo || w?.branch ? `repo: ${w?.repo ?? "?"} · branch ${w?.branch ?? "?"}` : null,
    ticket ? `ticket: ${ticket.id}${ticket.title ? ` ${ticket.title}` : ""}${ticket.status ? ` (${ticket.status})` : ""}` : null,
    pr ? `PR: ${prLine(pr)} · ${pr.title} · ${pr.url}` : null,
    s.attention ? `attention: ${s.attention}` : null,
    s.last_prompt ? `last prompt from the user: ${clip(s.last_prompt, detail / 2)}` : null,
    s.last_message ? `last message from the agent: ${clip(s.last_message, detail)}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Key a needs-you line is made for: it is stale once the session moves to another state. */
export const needKey = (s: SessionRow) => `${s.state}:${s.state_since}`;

/** One line on what a waiting or blocked session wants from you; saved as its "need" note. */
export async function need(s: SessionRow): Promise<string | null> {
  const screen = s.state === "needs_approval" || s.state === "question" ? (core.screen(s, 40) ?? "") : "";
  const prompt = `${facts(s, 3000)}${screen ? `\n\nIts terminal right now:\n${clip(screen, 3000)}` : ""}

In one line of at most 12 words, say what this session needs from its user right now (a decision, an approval, a review, a reply, or nothing: just done). Start with a verb, no preamble, no quotes.`;
  const line = (await run(prompt, { tools: false }))?.split("\n")[0]?.trim();
  if (!line) return null;
  db.putNote(s.id, "need", needKey(s), line);
  return line;
}

/** Sessions touched since `since`, live and ended. */
function touched(since: number): SessionRow[] {
  const live = core.sorted().filter((s) => s.updated_at >= since || s.state_since >= since);
  const gone = db.endedSessions(Date.now() - since);
  return [...live, ...gone];
}

/** Report notes ("*" kind "report") hold `{ title, text }`; reins shows the latest in its report panel. */
export interface Report {
  title: string;
  text: string;
  /** Sessions the report points to, for reins to select. */
  ids?: string[];
}

function saveReport(r: Report) {
  db.putNote("*", "report", r.title, JSON.stringify(r));
  return r;
}

export function lastReport(): (Report & { at: number }) | null {
  const n = db.getNote("*", "report");
  if (!n) return null;
  try {
    return { ...(JSON.parse(n.body) as Report), at: n.created_at };
  } catch {
    return null;
  }
}

const hhmm = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** What changed while you were away from reins. */
export async function brief(since: number): Promise<Report | null> {
  const list = touched(since);
  const title = `While you were away · since ${hhmm(since)}`;
  if (!list.length) return saveReport({ title, text: "Nothing changed." });
  const prompt = `These agent sessions changed since ${new Date(since).toISOString()}:

${list.map((s) => facts(s, 600)).join("\n\n")}

Brief the user in at most 5 short bullets, most urgent first: what finished, what waits on them and why, and PR changes (CI, reviews, merges). Name sessions as they are named above. Markdown, no preamble.`;
  const text = await run(prompt, { tools: false });
  return text ? saveReport({ title, text }) : null;
}

/** Standup-style write-up of the last `hours` of work, in the user's project update style. */
export async function writeup(hours = 24): Promise<Report | null> {
  const list = touched(Date.now() - hours * 3600_000);
  const title = `Write-up · last ${hours}h`;
  if (!list.length) return saveReport({ title, text: "No session activity in that window." });
  const prompt = `These agent sessions were active in the last ${hours} hours:

${list.map((s) => facts(s, 800)).join("\n\n")}

Write a status update of this work for the user's team and managers:
- Start with a one-line **TL;DR**.
- Then group bullets under **Done**, **In progress** and **Blocked / waiting** (skip empty groups).
- One line per item, about the outcome and its impact, not the mechanics. Merge items that are the same piece of work.
- No ticket IDs and no session names. Link PRs as markdown links when there is one.
- Leave out sessions that only reviewed or chatted with nothing to show.
Markdown only, no preamble.`;
  const text = await run(prompt, { tools: false, timeoutMs: 120_000 });
  return text ? saveReport({ title, text }) : null;
}

/** Answer notes hold `{ q, a }`. */
export function lastAnswer(sessionId: string): { q: string; a: string; at: number } | null {
  const n = db.getNote(sessionId, "answer");
  if (!n) return null;
  try {
    return { ...(JSON.parse(n.body) as { q: string; a: string }), at: n.created_at };
  } catch {
    return null;
  }
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/**
 * Answers a question with the scout's read-only tools: about one session (saved as its "answer" note), or, with
 * `s` null, across every session (saved as a report, with the sessions it names).
 */
export async function answer(question: string, s: SessionRow | null): Promise<string | null> {
  const prompt = s ? `About ${core.displayName(s)} (${s.id}): ${question}` : `About all sessions: ${question}`;
  const a = await run(prompt, { tools: true });
  if (!a) return null;
  if (s) db.putNote(s.id, "answer", null, JSON.stringify({ q: question, a }));
  else {
    const ids = [...new Set(a.match(UUID) ?? [])].filter((id) => db.getSession(id));
    saveReport({ title: `Scout · ${question}`, text: a, ids });
  }
  return a;
}

// --- the interactive pane ------------------------------------------------------------------------------------------

/**
 * Focuses the scout pane beside `pane` (reins), starting it the first time. Once it runs, the question is pre-filled
 * with the selected session; a fresh scout is still starting up and would drop the keys.
 */
export function openPane(pane: string, s: SessionRow | null): string {
  const existing = tmux.scoutPane(pane);
  if (existing) {
    tmux.focusPane(existing, s ? `About ${core.displayName(s)} (${s.id}): ` : undefined);
    return "";
  }
  const command = base().map(quote).join(" ");
  const started = tmux.splitScout(pane, { cwd: DIR, command, size: process.env.CARRIOT_SCOUT_WIDTH ?? "40%" });
  return started
    ? "Scout starting (first time: accept the folder trust prompt); S again pre-fills the selected session."
    : "Could not start the scout.";
}

/** Closes the scout pane beside `pane` (reins); the conversation is not kept. */
export function closePane(pane: string): string {
  const existing = tmux.scoutPane(pane);
  if (!existing) return "The scout pane is not open.";
  return tmux.killPane(existing) ? "Scout pane closed." : "Could not close the scout pane.";
}
