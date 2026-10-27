import { copyFileSync, existsSync, readFileSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { DB_PATH } from "./db";
import * as tmux from "./tmux";
import { BLOCKED, type SessionRow, type State } from "./types";
import { prRef, type PrStatus } from "./work";

/** `all`: needs you and your turn; `blocked`: only states that stop the agent; `off`: nothing. */
export type NotifyMode = "all" | "blocked" | "off";

const MODE = (process.env.CARRIOT_NOTIFY ?? "all") as NotifyMode;
const TERMINAL_APP = process.env.CARRIOT_TERMINAL_APP ?? "WezTerm";
const ICNS = `${import.meta.dir}/../assets/icon.icns`;
const APP = join(dirname(DB_PATH), "carriot.app");
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

/** The terminal-notifier.app behind a `terminal-notifier` on PATH: the binary itself, or the one Homebrew's wrapper execs. */
function sourceApp(tn: string): string | null {
  const real = realpathSync(tn);
  const inApp = real.match(/^(.+\.app)\/Contents\/MacOS\//);
  if (inApp) return inApp[1];
  if (statSync(real).size > 4096) return null;
  return readFileSync(real, "utf8").match(/"([^"]+\.app)\/Contents\/MacOS\//)?.[1] ?? null;
}

const mtime = (p: string) => (existsSync(p) ? statSync(p).mtimeMs : 0);
const run = (...cmd: string[]) => Bun.spawnSync(cmd, { stdout: "ignore", stderr: "ignore" }).exitCode === 0;

/**
 * macOS shows the sending app's icon and ignores terminal-notifier's -appIcon, so notifications go through a copy of
 * terminal-notifier.app with carriot's icon and bundle id. Built next to the database on first use and rebuilt when
 * the icon or terminal-notifier changes; null if that fails.
 */
function carriotApp(tn: string): string | null {
  const bin = join(APP, "Contents/MacOS/terminal-notifier");
  const src = sourceApp(tn);
  if (!src || !existsSync(ICNS)) return null;
  const built = mtime(join(APP, "Contents/Info.plist"));
  if (built && built >= mtime(ICNS) && built >= mtime(join(src, "Contents/Info.plist"))) return bin;
  const tmp = `${APP}.${process.pid}`;
  const plist = join(tmp, "Contents/Info.plist");
  rmSync(tmp, { recursive: true, force: true });
  const ok = run("ditto", src, tmp)
    && (copyFileSync(ICNS, join(tmp, "Contents/Resources/carriot.icns")), true)
    && run("plutil", "-replace", "CFBundleIdentifier", "-string", "dev.carriot.notifier", plist)
    && run("plutil", "-replace", "CFBundleName", "-string", "carriot", plist)
    && run("plutil", "-replace", "CFBundleIconFile", "-string", "carriot", plist)
    && run("codesign", "--force", "--deep", "--sign", "-", tmp);
  if (!ok) {
    rmSync(tmp, { recursive: true, force: true });
    return existsSync(bin) ? bin : null;
  }
  rmSync(APP, { recursive: true, force: true });
  try {
    renameSync(tmp, APP);
  } catch {
    rmSync(tmp, { recursive: true, force: true }); // another hook built it at the same moment
  }
  run("/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister", "-f", APP);
  return existsSync(bin) ? bin : null;
}

/** The notifier to run, and whether it is carriot's own app (which carries the icon) or plain terminal-notifier. */
function notifier(): { bin: string; own: boolean } | null {
  const tn = Bun.which("terminal-notifier");
  if (!tn) return null;
  try {
    const own = carriotApp(tn);
    if (own) return { bin: own, own: true };
  } catch {}
  return { bin: tn, own: false };
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
  const args = [tn.bin, "-title", name, "-subtitle", subtitle, "-message", body, "-group", group(s), "-execute", execute];
  if (urgent) args.push("-sound", "Glass");
  if (!tn.own) args.push("-sender", "com.github.wez.wezterm");
  Bun.spawn(args, { stdio: ["ignore", "ignore", "ignore"] }).unref();
}

function clear(s: SessionRow) {
  const tn = notifier();
  if (tn) Bun.spawn([tn.bin, "-remove", group(s)], { stdio: ["ignore", "ignore", "ignore"] }).unref();
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
  send(s, name, { subtitle: change.subtitle, body: `${prRef(pr)} ${pr.title}`, urgent: change.urgent });
}
