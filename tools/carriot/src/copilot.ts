import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as core from "./core";
import { DB_PATH } from "./db";
import * as tmux from "./tmux";
import type { SessionRow } from "./types";

/**
 * A cheap Claude beside reins for quick questions about the other sessions. It starts outside the hub so the hub's
 * CLAUDE.md and the carriot hooks (project settings) never load: it is not tracked as a session, and it can only read.
 */

const PROMPT = join(import.meta.dir, "../copilot/PROMPT.md");
const HUB = process.env.CARRIOT_NEW_CWD ?? join(import.meta.dir, "../../..");
const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/** Read-only allowlist; carriot by absolute path, since the agent's shell rebuilds PATH from the user's profile. */
function settings(bin: string) {
  const read = ["ls", "screen", "plan", "pr"].map((c) => `Bash(${bin} ${c}:*)`);
  const git = ["log", "diff", "status", "show"].map((c) => `Bash(git ${c}:*)`);
  return {
    effortLevel: "low",
    permissions: { allow: ["Read", "Grep", "Glob", ...read, "Bash(sqlite3 -readonly:*)", ...git], deny: ["Edit", "Write", "NotebookEdit"] },
  };
}

function command(): { cwd: string; command: string } {
  const cwd = join(dirname(DB_PATH), "copilot");
  mkdirSync(cwd, { recursive: true });
  const bin = process.env.CARRIOT_BIN ?? join(HUB, "bin/carriot");
  const prompt = join(cwd, "prompt.md");
  const where = `\nRun carriot as \`${bin}\` (it is not on PATH).\nCarriot database: ${DB_PATH}\nHub: ${HUB} (worktrees under ${join(HUB, "sessions")})\n`;
  writeFileSync(prompt, readFileSync(PROMPT, "utf8") + where);
  writeFileSync(join(cwd, "settings.json"), JSON.stringify(settings(bin), null, 2));
  const args = [
    "claude",
    "--model", process.env.CARRIOT_COPILOT_MODEL ?? "haiku",
    "--setting-sources", "user",
    "--settings", join(cwd, "settings.json"),
    "--permission-mode", "dontAsk",
    "--append-system-prompt-file", prompt,
    "--add-dir", join(HUB, "sessions"),
  ];
  return { cwd, command: args.map(quote).join(" ") };
}

/**
 * Focuses the copilot beside `pane` (reins), starting it the first time. Once it runs, the question is pre-filled
 * with the selected session; a fresh copilot is still starting up and would drop the keys.
 */
export function ask(pane: string, s: SessionRow | null): string {
  const existing = tmux.copilotPane(pane);
  if (existing) {
    tmux.focusPane(existing, s ? `About ${core.displayName(s)} (${s.id}): ` : undefined);
    return "";
  }
  const started = tmux.splitCopilot(pane, { ...command(), size: process.env.CARRIOT_COPILOT_WIDTH ?? "40%" });
  return started
    ? "Copilot starting (first time: accept the folder trust prompt); ? again pre-fills the selected session."
    : "Could not start the copilot.";
}
