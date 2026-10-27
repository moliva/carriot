import type { TmuxInfo } from "./db";
import { COLOUR } from "./palette";
import { isStale, needsYou, type SessionRow } from "./types";

/**
 * Without a UTF-8 locale (processes WezTerm or macOS start, such as the dashboard or a notification click) tmux
 * prints tabs and non-ASCII as "_", which garbles every tab-separated listing. Force one when none is set.
 */
const TMUX_ENV = /utf-?8/i.test(process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG || "")
  ? process.env
  : { ...process.env, LC_CTYPE: "en_US.UTF-8" };

function tmux(...args: string[]): string | null {
  try {
    const p = Bun.spawnSync(["tmux", ...args], { stdout: "pipe", stderr: "ignore", env: TMUX_ENV });
    return p.exitCode === 0 ? p.stdout.toString().trimEnd() : null;
  } catch {
    return null;
  }
}

export function paneInfo(pane: string): TmuxInfo {
  const out = tmux("display-message", "-p", "-t", pane, "#{window_id}\t#{session_name}:#{window_index}\t#{window_name}\t#{pid}");
  if (!out) return {};
  const [windowId, target, name, server] = out.split("\t");
  // tmux answers with empty fields rather than an error for a pane that no longer exists.
  return windowId ? { windowId, target, name, server } : {};
}

export interface PaneInfo extends TmuxInfo {
  session: string;
  attach?: string;
  /** Only pane in its window. */
  alone?: boolean;
  command?: string;
}

/** Every pane on the server with its current placement; null when tmux is unreachable. */
export function panes(): Map<string, PaneInfo> | null {
  const out = tmux(
    "list-panes",
    "-a",
    "-F",
    "#{pane_id}\t#{window_id}\t#{session_name}\t#{session_name}:#{window_index}\t#{window_name}\t#{@carriot_attach}\t#{pid}\t#{window_panes}\t#{pane_current_command}",
  );
  if (out === null) return null;
  const map = new Map<string, PaneInfo>();
  for (const line of out.split("\n").filter(Boolean)) {
    const [pane, windowId, session, target, name, attach, server, windowPanes, command] = line.split("\t");
    map.set(pane, {
      windowId,
      session,
      target,
      name,
      attach: attach || undefined,
      server,
      alone: windowPanes === "1",
      command,
    });
  }
  return map;
}

/** PID of the running tmux server, or null when tmux is not reachable. */
export function serverPid(): string | null {
  return tmux("display-message", "-p", "#{pid}") || null;
}

const SHELLS = new Set(["zsh", "bash", "fish", "sh", "-zsh", "-bash"]);

/**
 * A window tmux-resurrect brought back after a restart: same name, a single pane sitting at a shell, not used by
 * any live session. Resuming into it avoids a duplicate window next to the empty restored one.
 */
export function restoredShell(name: string, taken: Set<string>, session?: string): string | null {
  const candidates = [...(panes() ?? [])].filter(
    ([pane, info]) => info.name === name && info.alone && SHELLS.has(info.command ?? "") && !taken.has(pane),
  );
  // Prefer the tmux session it lived in (the park session included), then any other one.
  return (candidates.find(([, info]) => info.session === session) ?? candidates.find(([, info]) => info.session !== PARK))?.[0] ?? null;
}

/** Replaces whatever runs in a pane with `command`, keeping the window where it is. */
export function respawn(pane: string, cwd: string, command: string): boolean {
  return tmux("respawn-pane", "-k", "-t", pane, "-c", cwd, command) !== null;
}

/** Hidden tmux session that holds parked agents; it disappears on its own when its last window leaves. */
export const PARK = process.env.CARRIOT_PARK_SESSION ?? "carriot-parked";

export const isParked = (target: string | null | undefined) => !!target && target.startsWith(`${PARK}:`);

/** Session of the client running this process (the pane carriot was started from), if any. */
function currentSession(): string | null {
  const pane = process.env.TMUX_PANE;
  if (!pane) return null;
  const s = tmux("display-message", "-p", "-t", pane, "#{session_name}");
  return s && s !== PARK ? s : null;
}

function fallbackSession(): string | null {
  const all = tmux("list-sessions", "-F", "#{session_name}");
  return all?.split("\n").find((x) => x && x !== PARK) ?? null;
}

/** Moves a pane out of sight into the park session. A pane that shares its window leaves alone. */
export function park(pane: string): boolean {
  const out = tmux("display-message", "-p", "-t", pane, "#{session_name}\t#{window_id}\t#{window_panes}");
  if (!out) return false;
  const [session, windowId, count] = out.split("\t");
  if (session === PARK) return true;
  let placeholder: string | null = null;
  if (tmux("has-session", "-t", `=${PARK}`) === null)
    placeholder = tmux("new-session", "-d", "-s", PARK, "-n", PARK, "-P", "-F", "#{window_id}");
  const moved =
    Number(count) > 1
      ? tmux("break-pane", "-d", "-s", pane, "-t", `=${PARK}:`)
      : tmux("move-window", "-d", "-s", windowId, "-t", `=${PARK}:`);
  if (placeholder) tmux("kill-window", "-t", placeholder);
  if (moved === null) return false;
  tmux("set-option", "-w", "-t", pane, "@carriot_origin", session);
  return true;
}

/** Brings a parked pane's window back into the current tmux session (or where it came from). */
export function unpark(pane: string): boolean {
  const windowId = tmux("display-message", "-p", "-t", pane, "#{window_id}");
  if (!windowId) return false;
  const origin = tmux("show-options", "-wqv", "-t", pane, "@carriot_origin");
  const dest = currentSession() ?? (origin && tmux("has-session", "-t", `=${origin}`) !== null ? origin : null) ?? fallbackSession();
  if (!dest) return false;
  if (tmux("move-window", "-s", windowId, "-t", `=${dest}:`) === null) return false;
  tmux("set-option", "-w", "-u", "-t", pane, "@carriot_origin");
  return true;
}

/** Window running `claude attach` for a background session: reuses an open one, else creates it. Returns its pane. */
export function openAttach(sessionId: string, name: string, cwd: string | null): string | null {
  for (const [pane, info] of panes() ?? []) if (info.attach === sessionId) return pane;
  const dest = currentSession() ?? fallbackSession();
  const claude = Bun.which("claude") ?? "claude";
  if (!dest) return null;
  const out = tmux(
    "new-window",
    "-d",
    "-P",
    "-F",
    "#{pane_id}\t#{window_id}",
    "-t",
    `=${dest}:`,
    "-n",
    name.slice(0, 30),
    ...(cwd ? ["-c", cwd] : []),
    `${claude} attach ${sessionId.slice(0, 8)}`,
  );
  if (!out) return null;
  const [pane, windowId] = out.split("\t");
  tmux("set-option", "-w", "-t", windowId, "@carriot_attach", sessionId);
  return pane;
}

/** Kills a pane (closing its window when it was the last one). For an attach window the background session keeps running. */
export function detach(pane: string): boolean {
  return tmux("kill-pane", "-t", pane) !== null;
}

const BADGE: Record<string, string> = {
  blocked: `#[fg=colour${COLOUR.blocked},bold]●`,
  waiting: `#[fg=colour${COLOUR.waiting}]●`,
  planning: `#[fg=colour${COLOUR.planning}]●`,
  working: `#[fg=colour${COLOUR.working}]●`,
  idle: `#[fg=colour${COLOUR.idle}]○`,
};

/** Worst state across the window's active agents (grey when all are idle), as a pre-rendered badge in the @carriot_badge window option. */
export function paintWindow(windowId: string, all: SessionRow[]) {
  // Idle sessions only count when the window has nothing active.
  const sessions = all.filter((s) => !isStale(s));
  let kind = all.length && !sessions.length ? "idle" : "";
  if (sessions.some(needsYou)) kind = "blocked";
  else if (sessions.some((s) => s.state === "waiting")) kind = "waiting";
  else if (sessions.some((s) => s.state === "working" && s.mode === "plan")) kind = "planning";
  else if (sessions.some((s) => s.state === "working")) kind = "working";
  if (kind) tmux("set-option", "-w", "-t", windowId, "@carriot_badge", BADGE[kind]);
  else tmux("set-option", "-w", "-u", "-t", windowId, "@carriot_badge");
}

/** The pane is what someone sees: active pane of the active window of a session with a client attached. */
export function paneOnScreen(pane: string): boolean {
  return tmux("display-message", "-p", "-t", pane, "#{session_attached} #{window_active} #{pane_active}")?.match(/^([1-9]\d*) 1 1$/) != null;
}

export function jump(pane: string, focusTerminal: boolean) {
  tmux("switch-client", "-t", pane);
  tmux("select-window", "-t", pane);
  tmux("select-pane", "-t", pane);
  if (focusTerminal) {
    const app = process.env.CARRIOT_TERMINAL_APP ?? "WezTerm";
    Bun.spawnSync(["osascript", "-e", `tell application "${app}" to activate`], { stdout: "ignore", stderr: "ignore" });
  }
}

/** Recent pane text; `escapes` keeps the SGR colour/attribute sequences tmux otherwise strips. */
export function capture(pane: string, lines = 80, escapes = false): string | null {
  return tmux("capture-pane", "-p", "-J", ...(escapes ? ["-e"] : []), "-t", pane, "-S", `-${lines}`);
}

export function sendText(pane: string, text: string, opts: { escapeFirst?: boolean } = {}): boolean {
  if (opts.escapeFirst) {
    if (tmux("send-keys", "-t", pane, "Escape") === null) return false;
    Bun.sleepSync(400);
  }
  if (text.includes("\n")) {
    // Bracketed paste keeps a multi-line message in one prompt instead of submitting it line by line.
    const buffer = `carriot-${process.pid}`;
    const load = Bun.spawnSync(["tmux", "load-buffer", "-b", buffer, "-"], {
      stdin: new TextEncoder().encode(text),
      stderr: "ignore",
      env: TMUX_ENV,
    });
    if (load.exitCode !== 0 || tmux("paste-buffer", "-p", "-d", "-b", buffer, "-t", pane) === null) return false;
    Bun.sleepSync(150);
  } else if (tmux("send-keys", "-t", pane, "-l", text) === null) return false;
  return tmux("send-keys", "-t", pane, "Enter") !== null;
}

/** Opens a window right after the current one (or in the first session outside tmux) and selects it. */
export function newWindow(opts: { cwd?: string; name: string; command?: string; session?: string }): string | null {
  const pane = process.env.TMUX_PANE;
  const window = pane ? tmux("display-message", "-p", "-t", pane, "#{window_id}") : null;
  // Without a pane to sit next to (a tmux hook), go back to the session it came from.
  const home = opts.session && tmux("has-session", "-t", `=${opts.session}`) !== null ? opts.session : null;
  const placement = home && !window ? ["-d", "-t", `=${home}:`] : window ? ["-a", "-t", window] : ["-t", `=${fallbackSession() ?? ""}:`];
  const cwd = opts.cwd ?? (pane ? tmux("display-message", "-p", "-t", pane, "#{pane_current_path}") : null);
  return tmux("new-window", "-P", "-F", "#{pane_id}", ...placement, "-n", opts.name, ...(cwd ? ["-c", cwd] : []), ...(opts.command ? [opts.command] : []));
}

/** Brief status-line message on the attached client (no output view to dismiss). */
export function flash(message: string, ms: number): boolean {
  const pane = process.env.TMUX_PANE;
  return tmux("display-message", "-d", String(ms), ...(pane ? ["-t", pane] : []), message) !== null;
}
