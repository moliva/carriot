import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import * as core from "./core";
import * as db from "./db";
import { fuzzyScore } from "./fuzzy";
import * as tmux from "./tmux";
import { isStale, label, needsYou, type SessionRow } from "./types";
import { linearLinks, prBadge, prRef, repoName, type PrStatus } from "./work";

/** One row of an Alfred script filter (https://www.alfredapp.com/help/workflows/inputs/script-filter/json/). */
export interface AlfredItem {
  title: string;
  subtitle?: string;
  /** What the workflow's action receives: `session:<id>`, `reins:`, `new:<TICKET>`, `review:<PR>` or `open:<url>`. */
  arg?: string;
  valid?: boolean;
  mods?: Record<string, { arg?: string; subtitle?: string; valid?: boolean }>;
}

/** A session with what carriot knows it is working on. */
export interface Entry {
  s: SessionRow;
  ticket: string | null;
  ticketTitle: string | null;
  ticketStatus: string | null;
  ticketUrl: string | null;
  branch: string | null;
  repo: string | null;
  pr: PrStatus | null;
  /** PR links in the session's latest messages: not tracked, but searchable. */
  mentioned: string[];
}

/** A Linear ticket from a link (anywhere in the text) or from text that is just an id like ABC-123. */
export function parseTicket(text: string): { id: string; url: string | null } | null {
  const link = linearLinks([text])[0];
  if (link) return { id: link.id, url: link.url };
  const bare = text.trim().match(/^([A-Za-z][A-Za-z0-9]*-\d+)$/);
  return bare ? { id: bare[1].toUpperCase(), url: null } : null;
}

export interface PrRef {
  owner: string | null;
  repo: string;
  number: number;
  /** What goes after /review-pr: the link as pasted (canonical), or the short reference as typed. */
  ref: string;
}

/** A GitHub PR from a pull request link (anywhere in the text) or from text that is just `repo#123` or `owner/repo#123`. */
export function parsePr(text: string): PrRef | null {
  const link = text.match(/https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/);
  if (link) return { owner: link[1], repo: link[2], number: Number(link[3]), ref: link[0] };
  const short = text.trim().match(/^(?:([\w.-]+)\/)?([\w.-]+)#(\d+)$/);
  return short ? { owner: short[1] ?? null, repo: short[2], number: Number(short[3]), ref: text.trim() } : null;
}

/** `repo#123` for each GitHub pull request link in the text. */
export function prMentions(...texts: (string | null | undefined)[]): string[] {
  const refs = new Set<string>();
  for (const text of texts)
    for (const m of (text ?? "").matchAll(/github\.com\/[\w.-]+\/([\w.-]+)\/pull\/(\d+)/g)) refs.add(`${m[1]}#${m[2]}`);
  return [...refs];
}

function entryOf(s: SessionRow): Entry {
  const w = db.getWork(s.id);
  const pr: PrStatus | null = w?.pr ? JSON.parse(w.pr) : null;
  if (pr && !pr.repo) pr.repo = w?.repo ?? null;
  const t = w?.ticket ? db.getTicket(w.ticket) : null;
  return {
    s,
    ticket: w?.ticket ?? null,
    ticketTitle: t?.title ?? null,
    ticketStatus: t?.status ?? null,
    ticketUrl: w?.ticket ? core.ticketLink(w.ticket) : null,
    branch: w?.branch ?? null,
    repo: repoName(w?.repo ?? null),
    pr,
    mentioned: prMentions(s.last_message, s.last_prompt, s.detail),
  };
}

/** Running sessions in reins order, then the ones that ended in the last week (enter resumes those). */
export function loadEntries(): Entry[] {
  return [...core.sorted(), ...db.endedSessions(7 * 24 * 3600_000)].map(entryOf);
}

/** Match score for a query: identifiers fuzzy, free text (titles, prompts) only as substrings; null when it misses. */
export function score(e: Entry, query: string): number | null {
  const folder = e.s.cwd?.match(/\/sessions\/(.+)$/)?.[1];
  const names = [
    core.displayName(e.s),
    e.s.title,
    e.ticket,
    e.pr ? `${prRef(e.pr)} #${e.pr.number}` : null,
    ...e.mentioned,
    e.repo,
    e.branch,
    folder,
    core.location(e.s),
  ]
    .filter(Boolean)
    .join(" ");
  const text = [e.ticketTitle, e.ticketStatus, e.pr?.title, label(e.s), e.s.detail, e.s.last_prompt].filter(Boolean).join(" ");
  const a = fuzzyScore(query, names);
  const b = fuzzyScore(query, `${names} ${text}`, { substringOnly: true });
  return a === null ? b : b === null ? a : Math.max(a, b);
}

/** Entries matching the query, best first; with no query, the order they came in. */
export function search(entries: Entry[], query: string): Entry[] {
  if (!query.trim()) return entries;
  return entries
    .map((e, i) => ({ e, i, sc: score(e, query) }))
    .filter((x): x is { e: Entry; i: number; sc: number } => x.sc !== null)
    .sort((x, y) => y.sc - x.sc || x.i - y.i)
    .map((x) => x.e);
}

const dot = (s: SessionRow) =>
  s.state === "ended" ? "⚫️" : isStale(s) ? "⚪️" : needsYou(s) ? "🔴" : s.state === "waiting" ? "🟡" : s.mode === "plan" ? "🔵" : "🟢";

export function toItem(e: Entry): AlfredItem {
  const { s, pr } = e;
  const ended = s.state === "ended";
  const status = ended
    ? `${s.end_reason === "lost" ? "lost" : "ended"} ${core.ago(s.ended_at ?? s.updated_at)} ago · enter resumes`
    : [label(s), core.ago(isStale(s) ? s.updated_at : s.state_since), core.location(s)].filter(Boolean).join(" ");
  const ticket = e.ticket ? `${e.ticket}${e.ticketTitle ? ` ${e.ticketTitle}` : ""}` : null;
  const subtitle = [status, ticket, pr ? prBadge(pr).text : null, ticket || pr ? null : (s.detail ?? "").replace(/\s+/g, " ").slice(0, 80)]
    .filter(Boolean)
    .join(" · ");
  return {
    title: `${dot(s)} ${core.displayName(s)}`,
    subtitle,
    arg: `session:${s.id}`,
    mods: {
      cmd: pr ? { arg: `open:${pr.url}`, subtitle: `Open ${prRef(pr)} on GitHub` } : { valid: false, subtitle: "No PR yet" },
      alt: e.ticketUrl
        ? { arg: `open:${e.ticketUrl}`, subtitle: `Open ${e.ticket} in Linear` }
        : { valid: false, subtitle: e.ticket ? `No Linear link known for ${e.ticket}` : "No ticket" },
      ctrl: { arg: `open:carriot://focus/${s.id}`, subtitle: "Open in the Carriot dashboard" },
    },
  };
}

function newItem(ticket: string, title: string | null, note: string): AlfredItem {
  return {
    title: `Start a session for ${ticket}`,
    subtitle: [title, note].filter(Boolean).join(" · "),
    arg: `new:${ticket}`,
  };
}

function reviewItem(p: PrRef): AlfredItem {
  return {
    title: `Review ${p.repo}#${p.number}`,
    subtitle: "opens a new agent running /review-pr",
    arg: `review:${p.ref}`,
  };
}

/** The pinned row that opens reins; it stays out of the way once you search for something else. */
function reinsItem(entries: Entry[]): AlfredItem {
  const waiting = entries.filter((e) => e.s.state !== "ended" && needsYou(e.s)).length;
  return {
    title: "🏇 Reins",
    subtitle: waiting ? `${waiting} session${waiting === 1 ? "" : "s"} waiting on you · overview of every session` : "Overview of every session",
    arg: "reins:",
  };
}

/**
 * The list: reins first (when the query is empty or looks for it), then the sessions matching the query. A typed
 * ticket id or Linear link also offers a new session after the matches, and a PR reference or link offers a review
 * session; a session already running for that ticket or PR comes first, so enter goes back to it.
 */
export function sessionItems(entries: Entry[], query: string): AlfredItem[] {
  const t = parseTicket(query);
  const p = t ? null : parsePr(query);
  // A pasted link says what to look for; searching for the whole URL would find nothing.
  const looking = t ? t.id : p ? `${p.repo}#${p.number}` : query;
  const items = search(entries, looking).map(toItem);
  if (!query.trim() || fuzzyScore(query, "reins overview dashboard") !== null) items.unshift(reinsItem(entries));
  if (t) items.push(newItem(t.id, db.getTicket(t.id)?.title ?? null, "opens a new agent running /carriot:new"));
  if (p) items.push(reviewItem(p));
  return items.length ? items : [{ title: "No session matches", subtitle: "Search by name, ticket, PR number, repo or branch", valid: false }];
}

/** Brings a session to the front: a running one is reconnected (unparked or attached), an ended one is resumed. */
function openSession(id: string): string {
  core.reconcile();
  const live = core.resolve(id);
  if (live) {
    const r = core.reconnect(live);
    if (r.error || !r.pane) return r.error ?? "could not reach that session";
    tmux.jump(r.pane, true);
    return "";
  }
  const ended = core.resolve(id, { ended: true });
  if (!ended) return "that session is gone";
  const r = core.resume(ended);
  if (r.pane) tmux.jump(r.pane, true);
  return r.message;
}

/** Starts an agent in the hub with `prompt`, in a window next to your other sessions, and brings it to the front. */
function startSession(prompt: string, name: string, hub: string): string {
  const r = core.newAgent({ prompt, cwd: hub, name, skipPermissions: true });
  if (!r.ok) return r.message;
  if (r.pane) tmux.jump(r.pane, true);
  return `started ${name}`;
}

/** Switches to the reins session (starting it when needed) and brings the terminal forward. */
function openReins(bin: string): string {
  db.putSetting("reins_entered", String(Date.now()));
  tmux.toggleReins(`${bin} reins`);
  tmux.activateTerminal();
  return "";
}

/** The workflow's action: runs what a list item's `arg` says and returns a line for the notification (empty for none). */
export function go(arg: string, hub: string, bin = "carriot"): string {
  const at = arg.indexOf(":");
  const kind = at < 0 ? arg : arg.slice(0, at);
  const value = at < 0 ? "" : arg.slice(at + 1);
  switch (kind) {
    case "reins":
      return openReins(bin);
    case "session":
      return openSession(value);
    case "new": {
      const t = parseTicket(value);
      return t ? startSession(`/carriot:new ${t.id}`, t.id.toLowerCase(), hub) : `not a ticket: ${value}`;
    }
    case "review": {
      const p = parsePr(value);
      return p ? startSession(`/review-pr ${p.ref}`, `review-${p.repo}-${p.number}`.toLowerCase(), hub) : `not a PR: ${value}`;
    }
    case "open":
      if (!/^(https:\/\/|carriot:\/\/)/.test(value)) return "";
      Bun.spawnSync(["open", value]);
      return "";
    default:
      return "";
  }
}

/** Zips the workflow into the state directory (next to the database); opening it makes Alfred offer to import it. */
export function buildWorkflow(): string {
  const out = join(dirname(db.DB_PATH), "Carriot.alfredworkflow");
  rmSync(out, { force: true });
  const files = [join(import.meta.dir, "../alfred/info.plist"), join(import.meta.dir, "../assets/icon.png")];
  const p = Bun.spawnSync(["zip", "-j", "-q", out, ...files], { stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`zip failed: ${p.stderr.toString().trim()}`);
  return out;
}
