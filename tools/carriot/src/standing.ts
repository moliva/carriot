import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseCategory, type Category } from "./category";
import * as core from "./core";
import * as db from "./db";
import * as tmux from "./tmux";

/**
 * A standing session: work you keep open all the time, such as a review queue or a monitor overview. One command
 * opens it, or focuses it when it is already running, in a tmux session of its own.
 */
export interface Standing {
  name: string;
  /** First message of the session; it is also where it is told to recheck now and then. */
  prompt: string;
  category?: Category;
  /** Folder to start in; the carriot root (so the hooks apply) when left out. */
  cwd?: string;
}

/**
 * Local, untracked file (the prompts hold search links and team names, which stay out of the repo):
 * `{ "<name>": { "prompt": "...", "category": "review", "cwd": "..." } }`.
 */
export const CONFIG_PATH = process.env.CARRIOT_STANDING_CONFIG ?? join(homedir(), ".config/carriot/standing.json");

/** The standing sessions a config file defines; throws a readable error when the file is not what it should be. */
export function parseConfig(text: string): Standing[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("not valid JSON");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("expected an object keyed by session name");
  return Object.entries(raw).map(([name, value]) => {
    const v = (value ?? {}) as Record<string, unknown>;
    if (!/^[\w.-]+$/.test(name)) throw new Error(`'${name}' is not a usable name (letters, digits, - _ .)`);
    if (typeof v.prompt !== "string" || !v.prompt.trim()) throw new Error(`'${name}' needs a prompt`);
    const category = v.category === undefined ? undefined : parseCategory(String(v.category));
    if (category === null) throw new Error(`'${name}' has a category that is not dev, review, alert or misc`);
    if (v.cwd !== undefined && typeof v.cwd !== "string") throw new Error(`'${name}' has a cwd that is not text`);
    return { name, prompt: v.prompt.trim(), category, cwd: v.cwd };
  });
}

export function loadConfig(path = CONFIG_PATH): Standing[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(`no standing sessions defined: create ${path} (see the carriot README)`);
  }
  try {
    return parseConfig(text);
  } catch (err) {
    throw new Error(`${path}: ${(err as Error).message}`);
  }
}

export type Found = { kind: "live" | "dead"; pane: string } | { kind: "none" };

/**
 * Where standing session `name` is. A window belongs to it by its mark, or by its name when a tmux restore dropped the
 * marks. It is live when carriot tracks an agent in the pane or something other than a shell runs there; a window left
 * at a shell prompt (the agent exited) is dead.
 */
export function find(name: string, panes: tmux.StandingPane[], tracked: Set<string>): Found {
  const mine = panes.filter((p) => (p.mark ? p.mark === name : p.window === name));
  const live = mine.find((p) => tracked.has(p.pane)) ?? mine.find((p) => !tmux.SHELLS.has(p.command));
  if (live) return { kind: "live", pane: live.pane };
  return mine[0] ? { kind: "dead", pane: mine[0].pane } : { kind: "none" };
}

const trackedPanes = () => new Set(db.liveSessions().map((s) => s.pane).filter((p): p is string => !!p));

export function status(name: string): Found {
  core.reconcile();
  return find(name, tmux.standingPanes(), trackedPanes());
}

/**
 * Brings standing session `name` to the front, starting it first when it is not running. From its own window the same
 * call goes back to the session you came from, like reins. Returns an error message, or "" on success.
 */
export function open(s: Standing, hub: string): string {
  const found = status(s.name);
  const here = process.env.TMUX_PANE;
  if (found.kind === "live") {
    if (here === found.pane) tmux.switchBack();
    else tmux.jump(found.pane, !process.env.TMUX);
    return "";
  }
  // The agent ended and left a shell behind: clear it away so the new window takes its place.
  if (found.kind === "dead") tmux.killPane(found.pane);
  const r = core.newAgent({
    prompt: s.prompt,
    cwd: s.cwd ?? hub,
    name: s.name,
    skipPermissions: true,
    pin: tmux.STANDING,
    category: s.category,
    anonymous: true,
  });
  if (!r.ok || !r.pane) return r.message;
  tmux.markStanding(r.pane, s.name);
  tmux.jump(r.pane, !process.env.TMUX);
  return "";
}
