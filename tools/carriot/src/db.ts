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
  bg INTEGER NOT NULL DEFAULT 0
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
  if (!cols.has("bg")) db.exec("ALTER TABLE sessions ADD COLUMN bg INTEGER NOT NULL DEFAULT 0");
  return db;
}

export function getSession(id: string): SessionRow | null {
  return open().query<SessionRow, [string]>("SELECT * FROM sessions WHERE id = ?").get(id);
}

export interface TmuxInfo {
  name?: string;
  windowId?: string;
  target?: string;
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
      `INSERT INTO sessions (id, agent, name, title, cwd, pane, window_id, tmux_target, state, mode, detail, last_prompt, last_message, started_at, updated_at, state_since, ended_at, bg)
       VALUES ($id, $agent, $name, $title, $cwd, $pane, $window_id, $tmux_target, $state, $mode, $detail, $last_prompt, $last_message, $now, $now, $now, $ended_at, $bg)
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
         bg = max(bg, $bg)`,
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
  })();
}

/** Overwrites tmux placement (pane may move between windows and sessions, or detach entirely). */
export function setTmux(id: string, pane: string | null, info: TmuxInfo) {
  open()
    .query("UPDATE sessions SET pane = ?, window_id = ?, tmux_target = ?, name = coalesce(?, name) WHERE id = ?")
    .run(pane, info.windowId ?? null, info.target ?? null, info.name ?? null, id);
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

export function markEnded(ids: string[]) {
  if (!ids.length) return;
  const q = open().query("UPDATE sessions SET state = 'ended', ended_at = ?, state_since = ? WHERE id = ?");
  const now = Date.now();
  for (const id of ids) q.run(now, now, id);
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
