import { existsSync } from "node:fs";
import { dirname } from "node:path";
import * as tmux from "./tmux";
import { BLOCKED, type SessionRow, type State } from "./types";
import type { PrStatus } from "./work";

/** `all`: needs you and your turn; `blocked`: only states that stop the agent; `off`: nothing. */
export type NotifyMode = "all" | "blocked" | "off";

const MODE = (process.env.CARRIOT_NOTIFY ?? "all") as NotifyMode;
const TERMINAL_APP = process.env.CARRIOT_TERMINAL_APP ?? "WezTerm";
const ICON = `${process.env.HOME}/.local/share/claude/icon.png`;
const NEEDS_YOU: readonly State[] = [...BLOCKED, "waiting"];

const group = (s: SessionRow) => `carriot-${s.id}`;

/**
 * Only a move into a state that needs you notifies. A brand-new or resumed session (no previous row, or one coming
 * back from ended) stays quiet, so a reboot resume does not fire one notification per agent.
 */
export function shouldNotify(prev: SessionRow | null, next: SessionRow | null, mode: NotifyMode = MODE): boolean {
  if (mode === "off" || !prev || !next || prev.state === "ended" || prev.state === next.state) return false;
  if (BLOCKED.includes(next.state)) return true;
  return mode === "all" && next.state === "waiting";
}

export function message(s: SessionRow): { subtitle: string; body: string; urgent: boolean } {
  const detail = s.detail?.replace(/\s+/g, " ").trim();
  switch (s.state) {
    case "needs_approval":
      return { subtitle: "Needs approval", body: detail || "A tool is waiting for permission", urgent: true };
    case "question":
      return { subtitle: "Has a question", body: detail || "Waiting for your answer", urgent: true };
    case "plan_review":
      return { subtitle: "Plan ready for review", body: detail || "Open it to read the plan", urgent: true };
    case "pr_review":
      return { subtitle: "PR ready for review", body: detail?.replace(/^PR:\s*/, "") || "Open it to preview the PR", urgent: true };
    default:
      return { subtitle: "Your turn", body: detail || "Finished its turn", urgent: false };
  }
}

function frontApp(): string | null {
  try {
    const front = Bun.spawnSync(["lsappinfo", "front"], { stdout: "pipe", stderr: "ignore" }).stdout.toString().trim();
    const info = Bun.spawnSync(["lsappinfo", "info", "-only", "name", front], { stdout: "pipe", stderr: "ignore" });
    return info.stdout.toString().match(/"LSDisplayName"="([^"]*)"/)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** You are looking at it: its pane is on screen in tmux and the terminal app is in front. */
export function isWatched(s: SessionRow): boolean {
  return !!s.pane && tmux.paneOnScreen(s.pane) && frontApp() === TERMINAL_APP;
}

const shellQuote = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;

function notifier(): string | null {
  return Bun.which("terminal-notifier");
}

function send(s: SessionRow, name: string, msg = message(s)) {
  const { subtitle, body, urgent } = msg;
  const tn = notifier();
  if (!tn) {
    Bun.spawn(["osascript", "-e", `display notification ${JSON.stringify(body)} with title ${JSON.stringify(name)} subtitle ${JSON.stringify(subtitle)}`], {
      stdio: ["ignore", "ignore", "ignore"],
    }).unref();
    return;
  }
  // Notification clicks run with a bare PATH, so carry tmux's and bun's directories along.
  const path = [Bun.which("tmux"), Bun.which("bun")].filter(Boolean).map((p) => dirname(p!));
  const bin = process.env.CARRIOT_BIN ?? "carriot";
  const execute = `PATH=${shellQuote([...new Set(path)].join(":"))}:$PATH ${shellQuote(bin)} jump ${s.id}`;
  const args = [tn, "-title", name, "-subtitle", subtitle, "-message", body, "-group", group(s), "-execute", execute];
  if (urgent) args.push("-sound", "Glass");
  if (existsSync(ICON)) args.push("-appIcon", ICON);
  else args.push("-sender", "com.github.wez.wezterm");
  Bun.spawn(args, { stdio: ["ignore", "ignore", "ignore"] }).unref();
}

function clear(s: SessionRow) {
  const tn = notifier();
  if (tn) Bun.spawn([tn, "-remove", group(s)], { stdio: ["ignore", "ignore", "ignore"] }).unref();
}

/**
 * Reacts to a hook-driven state change: notifies when a session starts needing you and you are not watching it, and
 * withdraws its notification once it no longer needs you.
 */
export function onChange(prev: SessionRow | null, next: SessionRow | null, name: string) {
  if (!next) return;
  if (shouldNotify(prev, next)) {
    if (!isWatched(next)) send(next, name);
  } else if (prev && NEEDS_YOU.includes(prev.state) && !NEEDS_YOU.includes(next.state)) clear(next);
}

/**
 * PR activity on a session's branch (CI failing, review comments, approval, merge). Sent even while you watch the
 * session's pane, since the agent's screen does not show what happens on GitHub.
 */
export function prChange(s: SessionRow, name: string, change: { subtitle: string; urgent: boolean }, pr: PrStatus) {
  if (MODE === "off" || (MODE === "blocked" && !change.urgent)) return;
  send(s, name, { subtitle: change.subtitle, body: `#${pr.number} ${pr.title}`, urgent: change.urgent });
}
