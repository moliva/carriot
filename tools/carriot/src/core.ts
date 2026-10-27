import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as db from "./db";
import * as notify from "./notify";
import { ticketUrl } from "./work";
import * as tmux from "./tmux";
import { isStale, needsYou, urgency, type AdapterResult, type AgentEvent, type SessionRow } from "./types";

const STALE_UNTRACKED_MS = 12 * 3600_000;
const PURGE_ENDED_MS = 7 * 24 * 3600_000;

export function ingest(ev: AgentEvent): { prev: SessionRow | null; next: SessionRow | null } {
  const needsTmux = ev.pane && (ev.refreshTmux || !db.getSession(ev.sessionId)?.window_id);
  const info = needsTmux ? tmux.paneInfo(ev.pane!) : {};
  const { prev, next } = db.apply(ev, info);
  if (!next?.window_id) return { prev, next };
  if (prev?.state !== next.state || prev?.mode !== next.mode || prev?.window_id !== next.window_id || (prev && isStale(prev))) {
    tmux.paintWindow(next.window_id, db.sessionsInWindow(next.window_id));
    if (prev?.window_id && prev.window_id !== next.window_id)
      tmux.paintWindow(prev.window_id, db.sessionsInWindow(prev.window_id));
  }
  return { prev, next };
}

/** Hook-driven changes only: resumes and background syncs go through ingest directly and never notify. */
function ingestAndNotify(ev: AgentEvent) {
  const { prev, next } = ingest(ev);
  try {
    notify.onChange(prev, next, next ? displayName(next) : ev.sessionId);
  } catch (err) {
    logError(err);
  }
}

export function logError(err: unknown) {
  try {
    appendFileSync(join(dirname(db.DB_PATH), "errors.log"), `${new Date().toISOString()} ${(err as Error)?.stack ?? err}\n`);
  } catch {}
}

export function handle(agent: string, raw: string, adapt: (payload: any) => AdapterResult): unknown {
  if (!raw.trim()) return;
  const payload = JSON.parse(raw);
  if (process.env.CARRIOT_DEBUG) db.logRaw(agent, payload.session_id, payload.hook_event_name, raw);
  const { event, response } = adapt(payload);
  if (!event) return response;
  if (!response) {
    ingestAndNotify(event);
    return;
  }
  // A failed write must not swallow the response: the PR gate's "ask" has to reach the agent.
  try {
    ingestAndNotify(event);
  } catch (err) {
    logError(err);
  }
  return response;
}

function paint(...windowIds: (string | null | undefined)[]) {
  for (const w of new Set(windowIds)) if (w) tmux.paintWindow(w, db.sessionsInWindow(w));
}

export const repaint = (windowId: string | null | undefined) => paint(windowId);

/** Records where a pane lives now and repaints the windows it left and joined. */
function place(id: string, pane: string | null, info: tmux.PaneInfo | db.TmuxInfo = {}) {
  const before = db.getSession(id)?.window_id;
  db.setTmux(id, pane, info);
  paint(before, info.windowId);
}

export interface BackgroundAgent {
  sessionId: string;
  name?: string;
  status?: string;
  cwd?: string;
}

function parseAgents(json: string): BackgroundAgent[] | null {
  try {
    return (JSON.parse(json) as any[]).filter((a) => a.kind === "background" && a.sessionId);
  } catch {
    return null;
  }
}

/** Claude Code's own background sessions (`claude --bg`); null when the CLI is unavailable. */
export function listBackground(): BackgroundAgent[] | null {
  const claude = Bun.which("claude");
  if (!claude) return null;
  const p = Bun.spawnSync([claude, "agents", "--json"], { stdout: "pipe", stderr: "ignore" });
  return p.exitCode === 0 ? parseAgents(p.stdout.toString()) : null;
}

export async function listBackgroundAsync(): Promise<BackgroundAgent[] | null> {
  const claude = Bun.which("claude");
  if (!claude) return null;
  const p = Bun.spawn([claude, "agents", "--json"], { stdout: "pipe", stderr: "ignore" });
  const text = await new Response(p.stdout).text();
  return (await p.exited) === 0 ? parseAgents(text) : null;
}

/** Adds background sessions carriot has not seen yet and ends the ones Claude Code no longer runs. */
export function syncBackground(agents: BackgroundAgent[] | null) {
  if (!agents) return;
  const ids = new Set(agents.map((a) => a.sessionId));
  for (const a of agents) {
    const row = db.getSession(a.sessionId);
    if (row && row.state !== "ended" && row.bg) continue;
    const fresh = !row || row.state === "ended";
    db.apply({
      agent: "claude",
      sessionId: a.sessionId,
      cwd: a.cwd,
      title: a.name,
      background: true,
      state: fresh ? (a.status === "busy" ? "working" : "waiting") : undefined,
    });
  }
  db.markEnded(db.liveSessions().filter((s) => s.bg && !ids.has(s.id)).map((s) => s.id), "lost");
}

/**
 * Keeps rows in line with tmux: follows panes that moved (parked, renamed, re-split), ends sessions whose
 * pane is gone, and detaches background sessions whose attach window was closed.
 */
export function reconcile(opts: { background?: boolean } = {}) {
  if (opts.background) syncBackground(listBackground());
  const panes = tmux.panes();
  const server = panes ? tmux.serverPid() : null;
  const now = Date.now();
  const dead: string[] = [];
  const missingIds = new Set<string>();
  const gone = new Map<string, boolean>();
  for (const s of db.liveSessions()) {
    // Pane ids restart with a new tmux server (reboot, kill-server), so an old id may now name an unrelated pane.
    if (s.pane && server && s.tmux_server && s.tmux_server !== server) {
      // Only when that server is really gone; if it still runs, this process is just talking to another tmux
      // server (a second one, or a test one) and must leave the session alone.
      if (!gone.has(s.tmux_server)) gone.set(s.tmux_server, tmux.serverGone(s.tmux_server));
      if (!gone.get(s.tmux_server)) continue;
      if (s.bg) place(s.id, null);
      else dead.push(s.id);
      continue;
    }
    if (!s.pane) {
      if (!s.bg && now - s.updated_at > STALE_UNTRACKED_MS) dead.push(s.id);
      continue;
    }
    if (!panes) continue;
    const p = panes.get(s.pane);
    if (!p) {
      if (s.bg) place(s.id, null);
      else {
        dead.push(s.id);
        missingIds.add(s.id);
      }
    } else if (p.windowId !== s.window_id || p.target !== s.tmux_target || p.name !== s.name || !s.tmux_server)
      place(s.id, s.pane, p);
  }
  // Every tracked pane vanishing at once under the same server is far likelier a misread tmux listing than a mass
  // exit (a restarted server is caught above), so keep the sessions and leave a trace instead.
  const tracked = db.liveSessions().filter((s) => s.pane && !s.bg).length;
  if (panes && tracked >= 3 && missingIds.size === tracked) {
    logError(new Error(`reconcile: all ${tracked} tracked panes missing from ${panes.size} listed; keeping them`));
    dead.splice(0, dead.length, ...dead.filter((id) => !missingIds.has(id)));
  }
  db.markEnded(dead, "lost");
  db.purgeEnded(PURGE_ENDED_MS);
  // Idleness is time-based (no hook marks it), so windows are repainted here.
  if (panes) paint(...db.liveSessions().map((s) => s.window_id));
}

export type Location = "parked" | "background" | "attached" | null;

export function location(s: SessionRow): Location {
  if (s.bg) return s.pane ? "attached" : "background";
  return tmux.isParked(s.tmux_target) ? "parked" : null;
}

/** Makes a session reachable in tmux (unparks it, or attaches to a background session) and returns its pane. */
export function reconnect(s: SessionRow): { pane?: string; error?: string } {
  const panes = tmux.panes();
  let pane = s.pane && panes?.has(s.pane) ? s.pane : null;
  if (!pane && s.bg) {
    pane = tmux.openAttach(s.id, displayName(s), s.cwd);
    if (!pane) return { error: "Could not open a window to attach to it." };
  } else if (!pane) return { error: "That session is not in tmux." };
  else if (panes?.get(pane)?.session === tmux.PARK && !tmux.unpark(pane)) return { error: "Could not unpark it." };
  place(s.id, pane, tmux.panes()?.get(pane) ?? {});
  return { pane };
}

/** Takes a session out of your tmux sessions without stopping it: parks a pane, or detaches from a background session. */
export function sendAway(s: SessionRow): { ok: boolean; message: string } {
  if (!s.pane) return s.bg ? { ok: true, message: "Already running in the background." } : { ok: false, message: "That session is not in tmux." };
  if (s.bg) {
    tmux.detach(s.pane);
    place(s.id, null);
    return { ok: true, message: "Detached. It keeps running in the background." };
  }
  if (!tmux.park(s.pane)) return { ok: false, message: "Could not park it." };
  place(s.id, s.pane, tmux.panes()?.get(s.pane) ?? {});
  return { ok: true, message: "Parked. It keeps running out of sight." };
}

/**
 * Ends a session and removes its pane in one step: kills the pane (and the window if it was alone), or stops a
 * background session with `claude stop` and closes its attach window. Conversations stay resumable.
 */
export function close(s: SessionRow): { ok: boolean; message: string } {
  if (!s.bg && !s.pane) return { ok: false, message: "That session is not in tmux." };
  // Record the intent first: killing the pane makes the agent's exit hook report a hangup, which reads as lost.
  db.markEnded([s.id], "closed");
  if (s.bg) {
    const claude = Bun.which("claude");
    const p = claude ? Bun.spawnSync([claude, "stop", s.id.slice(0, 8)], { stdout: "ignore", stderr: "ignore" }) : null;
    if (s.pane) tmux.detach(s.pane);
    if (p?.exitCode !== 0) return { ok: false, message: "Could not stop the background session." };
  } else if (!tmux.detach(s.pane!)) return { ok: false, message: "Could not close its pane." };
  paint(s.window_id);
  return { ok: true, message: `closed ${displayName(s)}` };
}

/** Recent terminal output: the live pane (with SGR escapes if `ansi`), or `claude logs` for a detached background session. */
export function screen(s: SessionRow, lines = 200, ansi = false): string | null {
  if (s.pane) return tmux.capture(s.pane, lines, ansi);
  if (!s.bg) return null;
  const claude = Bun.which("claude");
  if (!claude) return null;
  const p = Bun.spawnSync([claude, "logs", s.id.slice(0, 8)], { stdout: "pipe", stderr: "ignore" });
  return p.exitCode === 0 ? plainLog(p.stdout.toString()) : null;
}

/** `claude logs` is a raw terminal recording; keep the text of the last full redraw. */
export function plainLog(raw: string): string {
  const frames = raw.split(/\x1b\[[23]J/);
  return frames[frames.length - 1]
    .replace(/\x1b\[\d*(?:;\d*)?[HfB]/g, "\n")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?<>=]*[ -\/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "")
    .replace(/\r/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export type SortOrder = "oldest" | "newest";

/**
 * Active sessions first, idle ones (no activity for a day) last; then by urgency; then by how long each has been
 * in its state: longest waiting first by default, or most recent first.
 */
export function sorted(order: SortOrder = "oldest"): SessionRow[] {
  const now = Date.now();
  return db
    .liveSessions()
    .sort(
      (a, b) =>
        Number(isStale(a, now)) - Number(isStale(b, now)) ||
        (needsYou(a) ? 0 : urgency(a.state)) - (needsYou(b) ? 0 : urgency(b.state)) ||
        (order === "oldest" ? a.state_since - b.state_since : b.state_since - a.state_since),
    );
}

export function resolve(ref: string, opts: { ended?: boolean } = {}): SessionRow | null {
  const all = [...db.liveSessions(), ...(opts.ended ? db.endedSessions(PURGE_ENDED_MS) : [])];
  return (
    all.find((s) => s.id === ref) ??
    all.find((s) => s.id.startsWith(ref)) ??
    all.find((s) => s.name === ref || s.tmux_target === ref) ??
    null
  );
}

export function displayName(s: SessionRow): string {
  if (s.name && !["zsh", "bash", "claude", "node", "main", "master"].includes(s.name)) return s.name;
  if (s.title) return s.title;
  const cwd = s.cwd ?? "";
  const m = cwd.match(/sessions\/([^/]+)(?:\/([^/]+))?/);
  return m ? [m[1], m[2]].filter(Boolean).join("/") : cwd.split("/").pop() || s.id.slice(0, 8);
}

export function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Window command: runs claude through an interactive shell (so PATH and rc files apply), then leaves that shell. */
function windowCommand(args: string[]): string {
  const shell = process.env.SHELL || "/bin/zsh";
  const cmd = ["claude", ...args].join(" ");
  return `${shell} -ic ${shellQuote(`${cmd}; exec ${shell} -l`)}`;
}

/**
 * Starts a new Claude session: a tmux window next to the current one that drops into a shell when Claude exits,
 * or a `claude --bg` background session.
 */
export function newAgent(opts: {
  prompt?: string;
  background?: boolean;
  cwd?: string;
  name?: string;
  skipPermissions?: boolean;
}): { ok: boolean; message: string; pane?: string } {
  const claude = Bun.which("claude") ?? "claude";
  const flags = opts.skipPermissions === false ? [] : ["--dangerously-skip-permissions"];
  const prompt = opts.prompt?.trim();
  if (opts.background) {
    if (!prompt) return { ok: false, message: "A background session needs a first prompt." };
    const p = Bun.spawnSync([claude, "--bg", ...flags, prompt], { cwd: opts.cwd, stdout: "pipe", stderr: "pipe" });
    const out = `${p.stdout}${p.stderr}`.trim();
    return { ok: p.exitCode === 0, message: out || "Started in the background." };
  }
  const pane = tmux.newWindow({
    cwd: opts.cwd,
    name: opts.name ?? "claude",
    command: windowCommand([...flags, ...(prompt ? [shellQuote(prompt)] : [])]),
  });
  if (!pane) return { ok: false, message: "Could not open a tmux window (is tmux running?)." };
  return { ok: true, message: prompt ? `new agent: ${prompt.slice(0, 50)}` : "new agent started", pane };
}

/** Lost sessions from the last day are what "resume everything" brings back after a crash or reboot. */
export const RESUME_LOST_WINDOW_MS = 24 * 3600_000;

/** The session's conversation file under ~/.claude/projects, if Claude Code wrote one. */
export function transcriptPath(s: SessionRow): string | null {
  for (const path of new Bun.Glob(`*/${s.id}.jsonl`).scanSync({ cwd: `${process.env.HOME}/.claude/projects`, absolute: true })) return path;
  return null;
}

/** Directory a session was started from: recorded by the hooks, else read from its conversation file. */
export function launchDir(s: SessionRow): string | null {
  if (s.project_dir) return s.project_dir;
  for (const path of new Bun.Glob(`*/${s.id}.jsonl`).scanSync({ cwd: `${process.env.HOME}/.claude/projects`, absolute: true })) {
    try {
      const head = readFileSync(path, "utf8").slice(0, 256 * 1024);
      for (const line of head.split("\n")) {
        if (!line.includes('"cwd"')) continue;
        const cwd = JSON.parse(line).cwd;
        if (typeof cwd === "string") return cwd;
      }
    } catch {}
  }
  return s.cwd;
}

/**
 * Brings an ended session back with `claude --resume`, in the directory it started from and with the same
 * permission mode. Reuses a window tmux-resurrect restored under the same name, else opens a new one. Background
 * sessions resume in the background.
 */
export function resume(s: SessionRow): { ok: boolean; message: string; pane?: string } {
  if (s.state !== "ended") return { ok: true, message: `${displayName(s)} is already running`, pane: s.pane ?? undefined };
  const cwd = launchDir(s);
  if (!cwd) return { ok: false, message: "Could not find where that session was started." };
  const flags = s.mode === "bypassPermissions" ? ["--dangerously-skip-permissions"] : [];
  const name = displayName(s);
  if (s.bg) {
    const claude = Bun.which("claude") ?? "claude";
    const p = Bun.spawnSync([claude, "--bg", ...flags, "--resume", s.id], { cwd, stdout: "pipe", stderr: "pipe" });
    if (p.exitCode !== 0) return { ok: false, message: `${p.stderr}`.trim() || "claude --bg --resume failed." };
    db.apply({ agent: s.agent, sessionId: s.id, state: "waiting", background: true });
    return { ok: true, message: `resumed ${name} in the background` };
  }
  const command = windowCommand([...flags, "--resume", s.id]);
  const taken = new Set(db.liveSessions().map((x) => x.pane).filter((p): p is string => !!p));
  const session = s.tmux_target?.split(":")[0] || undefined;
  const restored = tmux.restoredShell(name, taken, session);
  const pane = restored && tmux.respawn(restored, cwd, command) ? restored : tmux.newWindow({ cwd, name, command, session });
  if (!pane) return { ok: false, message: "Could not open a tmux window (is tmux running?)." };
  // Revive the row now; the resumed session's own hooks keep it current from here.
  ingest({ agent: s.agent, sessionId: s.id, state: "waiting", pane, refreshTmux: true });
  return { ok: true, message: `resumed ${name}`, pane };
}

/** Every session lost (not closed or exited) in the last day, oldest first so windows come back in order. */
export function lostSessions(): SessionRow[] {
  return db
    .endedSessions(RESUME_LOST_WINDOW_MS)
    .filter((s) => s.end_reason === "lost")
    .reverse();
}

export function resumeLost(): { ok: boolean; message: string } {
  const lost = lostSessions();
  if (!lost.length) return { ok: true, message: "nothing lost to resume" };
  const failed = lost.map(resume).filter((r) => !r.ok);
  return failed.length
    ? { ok: false, message: `resumed ${lost.length - failed.length} of ${lost.length}; ${failed[0].message}` }
    : { ok: true, message: `resumed ${lost.length} session${lost.length === 1 ? "" : "s"}` };
}

/** Linear URL for a ticket: recorded from a PR or Linear, else built from the learned (or configured) workspace. */
export function ticketLink(id: string): string | null {
  return ticketUrl(id, db.getTicket(id)?.url ?? null, process.env.CARRIOT_LINEAR_WORKSPACE || db.getSetting("linear_workspace"));
}

/**
 * The session has a PR preview whose PR does not exist yet: the agent is about to open it, or is waiting for you to say
 * so. Views open such sessions on the PR preview, whatever the agent state.
 */
export function prPending(s: SessionRow): boolean {
  const a = db.latestArtifact(s.id, "pr");
  if (!a) return false;
  try {
    return !JSON.parse(a.meta ?? "{}").url;
  } catch {
    return true;
  }
}
