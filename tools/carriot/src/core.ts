import * as db from "./db";
import * as tmux from "./tmux";
import { isStale, urgency, type AdapterResult, type AgentEvent, type SessionRow } from "./types";

const STALE_UNTRACKED_MS = 12 * 3600_000;
const PURGE_ENDED_MS = 7 * 24 * 3600_000;

export function ingest(ev: AgentEvent) {
  const needsTmux = ev.pane && (ev.refreshTmux || !db.getSession(ev.sessionId)?.window_id);
  const info = needsTmux ? tmux.paneInfo(ev.pane!) : {};
  const { prev, next } = db.apply(ev, info);
  if (!next?.window_id) return;
  if (prev?.state !== next.state || prev?.mode !== next.mode || prev?.window_id !== next.window_id || (prev && isStale(prev))) {
    tmux.paintWindow(next.window_id, db.sessionsInWindow(next.window_id));
    if (prev?.window_id && prev.window_id !== next.window_id)
      tmux.paintWindow(prev.window_id, db.sessionsInWindow(prev.window_id));
  }
}

export function handle(agent: string, raw: string, adapt: (payload: any) => AdapterResult): unknown {
  const payload = JSON.parse(raw);
  if (process.env.CARRIOT_DEBUG) db.logRaw(agent, payload.session_id, payload.hook_event_name, raw);
  const { event, response } = adapt(payload);
  if (event) ingest(event);
  return response;
}

function paint(...windowIds: (string | null | undefined)[]) {
  for (const w of new Set(windowIds)) if (w) tmux.paintWindow(w, db.sessionsInWindow(w));
}

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
  db.markEnded(db.liveSessions().filter((s) => s.bg && !ids.has(s.id)).map((s) => s.id));
}

/**
 * Keeps rows in line with tmux: follows panes that moved (parked, renamed, re-split), ends sessions whose
 * pane is gone, and detaches background sessions whose attach window was closed.
 */
export function reconcile(opts: { background?: boolean } = {}) {
  if (opts.background) syncBackground(listBackground());
  const panes = tmux.panes();
  const now = Date.now();
  const dead: string[] = [];
  for (const s of db.liveSessions()) {
    if (!s.pane) {
      if (!s.bg && now - s.updated_at > STALE_UNTRACKED_MS) dead.push(s.id);
      continue;
    }
    if (!panes) continue;
    const p = panes.get(s.pane);
    if (!p) {
      if (s.bg) place(s.id, null);
      else dead.push(s.id);
    } else if (p.windowId !== s.window_id || p.target !== s.tmux_target || p.name !== s.name) place(s.id, s.pane, p);
  }
  db.markEnded(dead);
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
  if (s.bg) {
    const claude = Bun.which("claude");
    const p = claude ? Bun.spawnSync([claude, "stop", s.id.slice(0, 8)], { stdout: "ignore", stderr: "ignore" }) : null;
    if (s.pane) tmux.detach(s.pane);
    if (p?.exitCode !== 0) return { ok: false, message: "Could not stop the background session." };
  } else if (!s.pane) return { ok: false, message: "That session is not in tmux." };
  else if (!tmux.detach(s.pane)) return { ok: false, message: "Could not close its pane." };
  db.markEnded([s.id]);
  paint(s.window_id);
  return { ok: true, message: `closed ${displayName(s)}` };
}

/** Recent terminal output: the live pane, or `claude logs` for a detached background session. */
export function screen(s: SessionRow, lines = 200): string | null {
  if (s.pane) return tmux.capture(s.pane, lines);
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
        urgency(a.state) - urgency(b.state) ||
        (order === "oldest" ? a.state_since - b.state_since : b.state_since - a.state_since),
    );
}

export function resolve(ref: string): SessionRow | null {
  const all = db.liveSessions();
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
}): { ok: boolean; message: string } {
  const claude = Bun.which("claude") ?? "claude";
  const flags = opts.skipPermissions === false ? [] : ["--dangerously-skip-permissions"];
  const prompt = opts.prompt?.trim();
  if (opts.background) {
    if (!prompt) return { ok: false, message: "A background session needs a first prompt." };
    const p = Bun.spawnSync([claude, "--bg", ...flags, prompt], { cwd: opts.cwd, stdout: "pipe", stderr: "pipe" });
    const out = `${p.stdout}${p.stderr}`.trim();
    return { ok: p.exitCode === 0, message: out || "Started in the background." };
  }
  // Run through an interactive login shell so PATH and rc files apply, then leave that shell behind.
  const shell = process.env.SHELL || "/bin/zsh";
  const cmd = ["claude", ...flags, ...(prompt ? [shellQuote(prompt)] : [])].join(" ");
  const pane = tmux.newWindow({ cwd: opts.cwd, name: opts.name ?? "claude", command: `${shell} -ic ${shellQuote(`${cmd}; exec ${shell} -l`)}` });
  if (!pane) return { ok: false, message: "Could not open a tmux window (is tmux running?)." };
  return { ok: true, message: prompt ? `new agent: ${prompt.slice(0, 50)}` : "new agent started" };
}
