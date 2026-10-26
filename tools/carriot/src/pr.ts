import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { Artifact } from "./types";

const MAX_DIFF = 2_000_000;

export const isPrCreate = (cmd: string) => /(^|[\s;&|(])gh\s+pr\s+create\b/.test(cmd);

/** Value of a flag, accepting "…", '…', $'…', a heredoc substitution, or a bare word. */
export function flag(cmd: string, names: string[]): string | undefined {
  for (const name of names) {
    const at = cmd.search(new RegExp(`(^|\\s)${name.replace(/-/g, "\\-")}(=|\\s+)`));
    if (at < 0) continue;
    const rest = cmd.slice(at).replace(new RegExp(`^\\s*${name.replace(/-/g, "\\-")}(=|\\s+)`), "");
    const heredoc = rest.match(/^"?\$\(\s*cat\s+<<-?\s*['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\s*\1\s*\n?\s*\)"?/);
    if (heredoc) return heredoc[2];
    if (rest.startsWith('"')) return unquoteDouble(rest);
    if (rest.startsWith("$'")) return rest.slice(2, rest.indexOf("'", 2));
    if (rest.startsWith("'")) return rest.slice(1, rest.indexOf("'", 1));
    return rest.match(/^\S+/)?.[0];
  }
}

function unquoteDouble(s: string): string {
  let out = "";
  for (let i = 1; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && i + 1 < s.length) {
      out += s[++i];
      continue;
    }
    if (c === '"') break;
    out += c;
  }
  return out;
}

function git(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "ignore" });
  return p.exitCode === 0 ? p.stdout.toString() : "";
}

/** Builds a PR preview artifact from a `gh pr create …` command about to run in `cwd`. */
export function prArtifact(cmd: string, hookCwd: string): Artifact {
  const cd = cmd.match(/^\s*cd\s+("[^"]+"|'[^']+'|\S+)\s*&&/);
  const cwd = cd ? resolve(hookCwd, cd[1].replace(/^["']|["']$/g, "")) : hookCwd;

  const title = flag(cmd, ["--title", "-t"]);
  let body = flag(cmd, ["--body", "-b"]) ?? "";
  const bodyFile = flag(cmd, ["--body-file", "-F"]);
  if (!body && bodyFile && bodyFile !== "-") {
    const p = isAbsolute(bodyFile) ? bodyFile : resolve(cwd, bodyFile);
    if (existsSync(p)) body = readFileSync(p, "utf8");
  }

  const remoteHead = git(cwd, "rev-parse", "--abbrev-ref", "origin/HEAD").trim();
  const base = flag(cmd, ["--base", "-B"]) ?? (remoteHead ? remoteHead.replace(/^origin\//, "") : "main");
  const head = flag(cmd, ["--head", "-H"]) ?? git(cwd, "rev-parse", "--abbrev-ref", "HEAD").trim();
  const mergeBase = git(cwd, "merge-base", `origin/${base}`, "HEAD").trim();
  const range = mergeBase ? `${mergeBase}..HEAD` : "HEAD~1..HEAD";

  let diff = git(cwd, "diff", "--no-color", "--no-ext-diff", "-M", range);
  if (diff.length > MAX_DIFF) diff = `${diff.slice(0, MAX_DIFF)}\n… diff truncated …\n`;

  return {
    kind: "pr",
    title: title ?? git(cwd, "log", "-1", "--format=%s").trim(),
    body,
    diff,
    meta: {
      cwd,
      base,
      head,
      repo: flag(cmd, ["--repo", "-R"]),
      draft: /\s--draft\b/.test(cmd),
      commits: git(cwd, "log", "--format=%h %s", range).trim().split("\n").filter(Boolean),
      stat: git(cwd, "diff", "--shortstat", range).trim(),
      command: cmd,
    },
  };
}
