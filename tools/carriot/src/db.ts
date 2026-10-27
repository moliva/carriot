import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { BLOCKED, type ArtifactRow, type AgentEvent, type SessionRow, type State } from "./types";

export const DB_PATH = process.env.CARRIOT_DB ?? join(homedir(), ".local/state/carriot/carriot.db");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  name TEXT,
  title TEXT,
  cwd TEXT,
  pane TEXT,
  window_id TEXT,
  tmux_target TEXT,
  state TEXT NOT NULL,
  mode TEXT,
  detail TEXT,
  last_prompt TEXT,
  last_message TEXT,
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  state_since INTEGER NOT NULL,
  ended_at INTEGER,
  bg INTEGER NOT NULL DEFAULT 0,
  end_reason TEXT,
  project_dir TEXT,
  tmux_server TEXT,
  attention TEXT,
  attention_since INTEGER
);
CREATE TABLE IF NOT EXISTS artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT,
  body TEXT NOT NULL,
  diff TEXT,
  meta TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS artifacts_session ON artifacts(session_id, kind, id);
CREATE TABLE IF NOT EXISTS work (
  session_id TEXT PRIMARY KEY,
  repo TEXT,
  branch TEXT,
  ticket TEXT,
  pr TEXT,
  fetched_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,
  title TEXT,
  status TEXT,
  url TEXT,
  fetched_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT,
  session_id TEXT,
  type TEXT,
  payload TEXT,
  ts INTEGER NOT NULL
);
`;

let db: Database | undefined;

export function open(): Database {
  if (db) return db;
  mkdirSync(dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH, { create: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000; PRAGMA synchronous = NORMAL;");
  db.exec(SCHEMA);
  const cols = new Set(db.query<{ name: string }, []>("PRAGMA table_info(sessions)").all().map((c) => c.name));
  const add: Record<string, string> = {
    bg: "INTEGER NOT NULL DEFAULT 0",
    end_reason: "TEXT",
    project_dir: "TEXT",
    tmux_server: "TEXT",
    attention: "TEXT",
    attention_since: "INTEGER",
  };
  for (const [col, type] of Object.entries(add)) if (!cols.has(col)) db.exec(`ALTER TABLE sessions ADD COLUMN ${col} ${type}`);
  return db;
}

export function getSession(id: string): SessionRow | null {
  return open().query<SessionRow, [string]>("SELECT * FROM sessions WHERE id = ?").get(id);
}

export interface TmuxInfo {
  name?: string;
  windowId?: string;
  target?: string;
  /** PID of the tmux server; pane ids restart with a new server, so a pane only means anything under the same one. */
  server?: string;
}

/** Applies an event; returns previous and next rows so callers can react to transitions. */
export function apply(ev: AgentEvent, tmux: TmuxInfo = {}): { prev: SessionRow | null; next: SessionRow | null } {
  const d = open();
  const now = Date.now();
  return d.transaction(() => {
    const prev = getSession(ev.sessionId);
    let state: State = prev?.state ?? ev.state ?? "waiting";
    if (ev.state && (!ev.onlyIfBlocked || (prev && BLOCKED.includes(prev.state)))) state = ev.state;
    if (prev?.state === "ended" && !ev.state) state = "waiting";

    const stateChanged = !prev || prev.state !== state;
    d.query(
      `INSERT INTO sessions (id, agent, name, title, cwd, pane, window_id, tmux_target, state, mode, detail, last_prompt, last_message, started_at, updated_at, state_since, ended_at, bg, end_reason, project_dir, tmux_server)
       VALUES ($id, $agent, $name, $title, $cwd, $pane, $window_id, $tmux_target, $state, $mode, $detail, $last_prompt, $last_message, $now, $now, $now, $ended_at, $bg, $end_reason, $project_dir, $tmux_server)
       ON CONFLICT(id) DO UPDATE SET
         name = coalesce($name, name),
         title = coalesce($title, title),
         cwd = coalesce($cwd, cwd),
         pane = coalesce($pane, pane),
         window_id = coalesce($window_id, window_id),
         tmux_target = coalesce($tmux_target, tmux_target),
         state = $state,
         mode = coalesce($mode, mode),
         detail = CASE WHEN $state_changed THEN $detail ELSE coalesce($detail, detail) END,
         last_prompt = coalesce($last_prompt, last_prompt),
         last_message = coalesce($last_message, last_message),
         updated_at = $now,
         state_since = CASE WHEN $state_changed THEN $now ELSE state_since END,
         ended_at = $ended_at,
         bg = max(bg, $bg),
         end_reason = CASE WHEN state = 'ended' AND $state = 'ended' THEN coalesce(end_reason, $end_reason) ELSE $end_reason END,
         project_dir = coalesce($project_dir, project_dir),
         tmux_server = coalesce($tmux_server, tmux_server),
         attention = CASE WHEN $engaged THEN NULL ELSE attention END,
         attention_since = CASE WHEN $engaged THEN NULL ELSE attention_since END`,
    ).run({
      $id: ev.sessionId,
      $agent: ev.agent,
      $name: tmux.name ?? null,
      $title: ev.title ?? null,
      $cwd: ev.cwd ?? null,
      $pane: ev.pane ?? null,
      $window_id: tmux.windowId ?? null,
      $tmux_target: tmux.target ?? null,
      $state: state,
      $mode: ev.mode ?? null,
      $detail: ev.detail ?? null,
      $last_prompt: ev.prompt ?? null,
      $last_message: ev.lastMessage ?? null,
      $now: now,
      $state_changed: stateChanged ? 1 : 0,
      $ended_at: state === "ended" ? now : null,
      $bg: ev.background ? 1 : 0,
      $end_reason: state === "ended" ? (ev.endReason ?? "exited") : null,
      $project_dir: ev.projectDir ?? null,
      $tmux_server: tmux.server ?? null,
      // A prompt means you are back on it, which settles whatever PR activity flagged it.
      $engaged: ev.prompt !== undefined ? 1 : 0,
    });

    if (ev.artifact) {
      const a = ev.artifact;
      d.query(
        "INSERT INTO artifacts (session_id, kind, title, body, diff, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(ev.sessionId, a.kind, a.title ?? null, a.body, a.diff ?? null, a.meta ? JSON.stringify(a.meta) : null, now);
    }
    if (ev.artifactUpdate) {
      const last = latestArtifact(ev.sessionId, ev.artifactUpdate.kind);
      if (last) {
        const meta = { ...(last.meta ? JSON.parse(last.meta) : {}), ...ev.artifactUpdate.meta };
        d.query("UPDATE artifacts SET meta = ? WHERE id = ?").run(JSON.stringify(meta), last.id);
      }
    }
    return { prev, next: getSession(ev.sessionId) };
  }).immediate();
}

/** Overwrites tmux placement (pane may move between windows and sessions, or detach entirely). */
export function setTmux(id: string, pane: string | null, info: TmuxInfo) {
  open()
    .query(
      "UPDATE sessions SET pane = ?, window_id = ?, tmux_target = ?, name = coalesce(?, name), tmux_server = coalesce(?, tmux_server) WHERE id = ?",
    )
    .run(pane, info.windowId ?? null, info.target ?? null, info.name ?? null, info.server ?? null, id);
}

export function logRaw(agent: string, sessionId: string | undefined, type: string | undefined, payload: string) {
  const d = open();
  d.query("INSERT INTO events (agent, session_id, type, payload, ts) VALUES (?, ?, ?, ?, ?)").run(
    agent,
    sessionId ?? null,
    type ?? null,
    payload,
    Date.now(),
  );
  d.exec("DELETE FROM events WHERE id <= (SELECT max(id) - 1000 FROM events)");
}

export function liveSessions(): SessionRow[] {
  return open().query<SessionRow, []>("SELECT * FROM sessions WHERE state != 'ended'").all();
}

export function sessionsInWindow(windowId: string): SessionRow[] {
  return open()
    .query<SessionRow, [string]>("SELECT * FROM sessions WHERE window_id = ? AND state != 'ended'")
    .all(windowId);
}

/**
 * Why a session ended: `lost` (its pane or tmux server vanished without the agent exiting: crash, reboot, killed
 * window), `closed` (carriot close), `exited` (the agent quit on purpose), `clear` (replaced by /clear or /resume).
 */
export type EndReason = "lost" | "closed" | "exited" | "clear";

export function markEnded(ids: string[], reason: EndReason = "lost") {
  if (!ids.length) return;
  const q = open().query(
    "UPDATE sessions SET state = 'ended', ended_at = ?, state_since = ?, end_reason = ? WHERE id = ? AND state != 'ended'",
  );
  const now = Date.now();
  for (const id of ids) q.run(now, now, reason, id);
}

/** Ended sessions worth resuming (not ones replaced by /clear), most recently ended first. */
export function endedSessions(sinceMs: number): SessionRow[] {
  return open()
    .query<SessionRow, [number]>(
      "SELECT * FROM sessions WHERE state = 'ended' AND ended_at >= ? AND coalesce(end_reason, '') != 'clear' ORDER BY ended_at DESC",
    )
    .all(Date.now() - sinceMs);
}

export function purgeEnded(olderThanMs: number) {
  const cutoff = Date.now() - olderThanMs;
  const d = open();
  d.query("DELETE FROM artifacts WHERE session_id IN (SELECT id FROM sessions WHERE state = 'ended' AND ended_at < ?)").run(cutoff);
  d.query("DELETE FROM sessions WHERE state = 'ended' AND ended_at < ?").run(cutoff);
}

export function latestArtifact(sessionId: string, kind: string): ArtifactRow | null {
  return open()
    .query<ArtifactRow, [string, string]>(
      "SELECT * FROM artifacts WHERE session_id = ? AND kind = ? ORDER BY id DESC LIMIT 1",
    )
    .get(sessionId, kind);
}

export function artifactSummaries(): { session_id: string; kind: string; id: number }[] {
  return open()
    .query<{ session_id: string; kind: string; id: number }, []>(
      "SELECT session_id, kind, max(id) AS id FROM artifacts GROUP BY session_id, kind",
    )
    .all();
}

export function getArtifact(id: number): ArtifactRow | null {
  return open().query<ArtifactRow, [number]>("SELECT * FROM artifacts WHERE id = ?").get(id);
}

export interface WorkRow {
  session_id: string;
  repo: string | null;
  branch: string | null;
  ticket: string | null;
  pr: string | null;
  fetched_at: number;
}

export function getWork(sessionId: string): WorkRow | null {
  return open().query<WorkRow, [string]>("SELECT * FROM work WHERE session_id = ?").get(sessionId);
}

export function putWork(w: Omit<WorkRow, "fetched_at">) {
  open()
    .query(
      `INSERT INTO work (session_id, repo, branch, ticket, pr, fetched_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET repo = excluded.repo, branch = excluded.branch, ticket = excluded.ticket,
         pr = excluded.pr, fetched_at = excluded.fetched_at`,
    )
    .run(w.session_id, w.repo, w.branch, w.ticket, w.pr, Date.now());
}

export interface TicketRow {
  id: string;
  title: string | null;
  status: string | null;
  url: string | null;
  fetched_at: number;
}

export function getTicket(id: string): TicketRow | null {
  return open().query<TicketRow, [string]>("SELECT * FROM tickets WHERE id = ?").get(id);
}

export function putTicket(t: Omit<TicketRow, "fetched_at">) {
  open()
    .query(
      `INSERT INTO tickets (id, title, status, url, fetched_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title = coalesce(excluded.title, title), status = coalesce(excluded.status, status),
         url = coalesce(excluded.url, url), fetched_at = excluded.fetched_at`,
    )
    .run(t.id, t.title, t.status, t.url, Date.now());
}

/** Flags (or clears, with null) a reason the session needs you that no hook reported, e.g. CI failing on its PR. */
export function setAttention(id: string, reason: string | null) {
  const now = Date.now();
  open()
    .query(
      // Raising it also counts as activity, so a long-idle session comes back out of the idle group.
      "UPDATE sessions SET attention = ?, attention_since = ?, updated_at = CASE WHEN ? IS NULL THEN updated_at ELSE ? END WHERE id = ?",
    )
    .run(reason, reason ? now : null, reason, now, id);
}

/** Records a ticket's URL learned elsewhere (a PR link) without touching its title or status. */
export function setTicketUrl(id: string, url: string) {
  open()
    .query("INSERT INTO tickets (id, url, fetched_at) VALUES (?, ?, 0) ON CONFLICT(id) DO UPDATE SET url = excluded.url")
    .run(id, url);
}

export function getSetting(key: string): string | null {
  return open().query<{ value: string | null }, [string]>("SELECT value FROM settings WHERE key = ?").get(key)?.value ?? null;
}

export function putSetting(key: string, value: string) {
  open().query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}
