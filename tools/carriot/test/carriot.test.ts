import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "carriot-test-"));
process.env.CARRIOT_DB = join(dir, "carriot.db");

const { adapt } = await import("../src/adapters/claude");
const { fileDiff, flag, isPrCreate, prArtifact } = await import("../src/pr");
const db = await import("../src/db");
const core = await import("../src/core");
const { fuzzyScore } = await import("../src/fuzzy");
const { isStale, STALE_AFTER_MS } = await import("../src/types");

const env = { TMUX_PANE: undefined };
const ev = (h: Record<string, unknown>) => adapt({ session_id: "s1", cwd: dir, permission_mode: "default", ...h }, env);

describe("claude adapter", () => {
  test("prompt submit means working, plan mode is kept for display", () => {
    const { event } = ev({ hook_event_name: "UserPromptSubmit", prompt: "fix the bug\nplease", permission_mode: "plan" });
    expect(event).toMatchObject({ state: "working", mode: "plan", detail: "fix the bug" });
  });

  test("ExitPlanMode captures the plan for review", () => {
    const { event } = ev({ hook_event_name: "PreToolUse", tool_name: "ExitPlanMode", tool_input: { plan: "# Plan\n1. do it" } });
    expect(event?.state).toBe("plan_review");
    expect(event?.artifact).toMatchObject({ kind: "plan", title: "Plan", body: "# Plan\n1. do it" });
  });

  test("ExitPlanMode falls back to planFilePath", () => {
    const p = join(dir, "plan.md");
    writeFileSync(p, "## From file");
    const { event } = ev({ hook_event_name: "PreToolUse", tool_name: "ExitPlanMode", tool_input: { planFilePath: p } });
    expect(event?.artifact?.body).toBe("## From file");
  });

  test("AskUserQuestion is a question", () => {
    const { event } = ev({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_input: { questions: [{ question: "Which?" }] } });
    expect(event).toMatchObject({ state: "question", detail: "Which?" });
  });

  test("ordinary Bash calls are ignored", () => {
    expect(ev({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } })).toEqual({});
  });

  test("gh pr create captures a preview and asks for approval", () => {
    const cmd = `gh pr create --assignee @me --title "feat: thing" --body "$(cat <<'EOF'\n## Summary\n- did it\nEOF\n)"`;
    const r = ev({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: cmd } });
    expect(r.event?.state).toBe("pr_review");
    expect(r.event?.artifact).toMatchObject({ kind: "pr", title: "feat: thing", body: "## Summary\n- did it" });
    expect((r.response as any).hookSpecificOutput.permissionDecision).toBe("ask");
  });

  test("PR gate can be disabled", () => {
    const r = adapt(
      { session_id: "s1", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "gh pr create -t x -b y" }, cwd: dir },
      { CARRIOT_PR_GATE: "0" },
    );
    expect(r.response).toBeUndefined();
    expect(r.event?.state).toBe("working");
  });

  test("background sessions ignore any inherited tmux pane", () => {
    const { event } = adapt(
      { session_id: "bg1", hook_event_name: "UserPromptSubmit", prompt: "x" },
      { CLAUDE_CODE_SESSION_KIND: "bg", TMUX_PANE: "%9" },
    );
    expect(event).toMatchObject({ background: true, pane: undefined });
  });

  test("notifications map by type", () => {
    expect(ev({ hook_event_name: "Notification", notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" }).event?.state).toBe("needs_approval");
    expect(ev({ hook_event_name: "Notification", notification_type: "idle_prompt", message: "Claude is waiting for your input" }).event?.state).toBe("waiting");
    expect(ev({ hook_event_name: "Notification", notification_type: "auth_success", message: "ok" })).toEqual({});
  });

  test("Stop uses the last line of the final reply", () => {
    const { event } = ev({ hook_event_name: "Stop", last_assistant_message: "Done.\n\nShall I commit?" });
    expect(event).toMatchObject({ state: "waiting", detail: "Shall I commit?", lastMessage: "Done.\n\nShall I commit?" });
  });

  test("Stop falls back to the transcript tail", () => {
    const p = join(dir, "t.jsonl");
    writeFileSync(
      p,
      [
        JSON.stringify({ type: "user", message: { content: "hi" } }),
        JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Ready to open the PR?" }] } }),
        JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "x" }] } }),
      ].join("\n"),
    );
    expect(ev({ hook_event_name: "Stop", transcript_path: p }).event?.detail).toBe("Ready to open the PR?");
  });

  test("PostToolUse only unblocks, and records the created PR url", () => {
    const { event } = ev({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "gh pr create -t x" },
      tool_response: { stdout: "https://github.com/acme/app/pull/42\n" },
    });
    expect(event).toMatchObject({ state: "working", onlyIfBlocked: true, artifactUpdate: { kind: "pr", meta: { url: "https://github.com/acme/app/pull/42" } } });
  });
});

describe("pr flag parsing", () => {
  test("detects gh pr create after cd", () => {
    expect(isPrCreate("cd /x && gh pr create -t a")).toBe(true);
    expect(isPrCreate("gh pr view 3")).toBe(false);
    expect(isPrCreate("echo 'use gh-pr-create'")).toBe(false);
  });
  test("quoted, escaped, single-quoted and bare values", () => {
    expect(flag(`gh pr create --title "a \\"b\\" c"`, ["--title"])).toBe('a "b" c');
    expect(flag(`gh pr create --title 'it is'`, ["--title"])).toBe("it is");
    expect(flag(`gh pr create --base develop --title x`, ["--base"])).toBe("develop");
    expect(flag(`gh pr create --base=develop`, ["--base"])).toBe("develop");
    expect(flag(`gh pr create -t short`, ["--title", "-t"])).toBe("short");
  });
});

describe("pr context expansion", () => {
  const repo = join(dir, "repo");
  const git = (...args: string[]) => Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
  let preview: ReturnType<typeof prArtifact>;

  beforeAll(() => {
    mkdirSync(repo);
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    git("config", "commit.gpgsign", "false");
    writeFileSync(join(repo, "a.txt"), lines.join("\n") + "\n");
    git("add", ".");
    git("commit", "-qm", "base");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    git("switch", "-qc", "feat");
    lines[19] = "changed";
    writeFileSync(join(repo, "a.txt"), lines.join("\n") + "\n");
    git("commit", "-qam", "change");
    preview = prArtifact("gh pr create -t x -b y --base main", repo);
  });

  test("the preview pins the commits it was taken from", () => {
    expect(preview.meta?.baseSha).toBe(git("rev-parse", "main").stdout.toString().trim());
    expect(preview.meta?.headSha).toBe(git("rev-parse", "feat").stdout.toString().trim());
  });

  test("re-diffs a previewed file with more context", () => {
    expect(preview.diff).not.toContain("line 10\n");
    const wider = fileDiff(preview.diff!, preview.meta!, "a.txt", "a.txt", 15);
    expect(wider).toContain(" line 10\n");
    expect(wider).toContain("+changed");
  });

  test("ignores later commits on the branch", () => {
    writeFileSync(join(repo, "a.txt"), "rewritten\n");
    git("commit", "-qam", "later");
    expect(fileDiff(preview.diff!, preview.meta!, "a.txt", "a.txt", 3)).toContain("+changed");
  });

  test("refuses files outside the preview", () => {
    expect(fileDiff(preview.diff!, preview.meta!, "../../etc/passwd", "../../etc/passwd", 3)).toBeNull();
    expect(fileDiff(preview.diff!, { ...preview.meta, headSha: undefined }, "a.txt", "a.txt", 3)).toBeNull();
  });
});

describe("state store", () => {
  beforeAll(() => db.open());

  test("onlyIfBlocked leaves non-blocked sessions alone", () => {
    db.apply({ agent: "claude", sessionId: "a", state: "waiting" });
    db.apply({ agent: "claude", sessionId: "a", state: "working", onlyIfBlocked: true });
    expect(db.getSession("a")?.state).toBe("waiting");
    db.apply({ agent: "claude", sessionId: "a", state: "needs_approval", detail: "Bash: rm" });
    db.apply({ agent: "claude", sessionId: "a", state: "working", onlyIfBlocked: true });
    expect(db.getSession("a")).toMatchObject({ state: "working", detail: null });
  });

  test("a session first seen mid-turn starts as working", () => {
    db.apply({ agent: "claude", sessionId: "new", state: "working", onlyIfBlocked: true });
    expect(db.getSession("new")?.state).toBe("working");
  });

  test("state_since only moves on transitions", async () => {
    db.apply({ agent: "claude", sessionId: "b", state: "working" });
    const t0 = db.getSession("b")!.state_since;
    await Bun.sleep(5);
    db.apply({ agent: "claude", sessionId: "b", state: "working", mode: "plan" });
    expect(db.getSession("b")!.state_since).toBe(t0);
    expect(db.getSession("b")!.mode).toBe("plan");
  });

  test("artifact updates merge into the latest artifact", () => {
    db.apply({ agent: "claude", sessionId: "c", state: "pr_review", artifact: { kind: "pr", title: "t", body: "b", meta: { base: "main" } } });
    db.apply({ agent: "claude", sessionId: "c", artifactUpdate: { kind: "pr", meta: { url: "u" } } });
    expect(JSON.parse(db.latestArtifact("c", "pr")!.meta!)).toEqual({ base: "main", url: "u" });
  });

  test("ended sessions drop out of the live list and revive on new activity", () => {
    db.apply({ agent: "claude", sessionId: "d", state: "ended" });
    expect(db.liveSessions().some((s) => s.id === "d")).toBe(false);
    db.apply({ agent: "claude", sessionId: "d", state: "working" });
    expect(db.getSession("d")).toMatchObject({ state: "working", ended_at: null });
  });
});

describe("background sessions", () => {
  test("unseen background sessions are added, vanished ones end", () => {
    core.syncBackground([{ sessionId: "bg-a", name: "Fix CI", status: "busy", cwd: "/x" }]);
    expect(db.getSession("bg-a")).toMatchObject({ bg: 1, state: "working", title: "Fix CI", pane: null });
    expect(core.location(db.getSession("bg-a")!)).toBe("background");
    core.syncBackground([]);
    expect(db.getSession("bg-a")?.state).toBe("ended");
  });

  test("a known session keeps its hook-reported state when synced", () => {
    db.apply({ agent: "claude", sessionId: "bg-b", state: "plan_review", background: true });
    core.syncBackground([{ sessionId: "bg-b", status: "idle" }]);
    expect(db.getSession("bg-b")?.state).toBe("plan_review");
  });

  test("the background flag sticks once set", () => {
    db.apply({ agent: "claude", sessionId: "bg-c", state: "working", background: true });
    db.apply({ agent: "claude", sessionId: "bg-c", state: "waiting" });
    expect(db.getSession("bg-c")?.bg).toBe(1);
  });

  test("raw terminal logs reduce to the text of the last redraw", () => {
    const raw = "old frame\x1b[2J\x1b[H\x1b[38;2;215;119;87m Claude\x1b[39m\x1b[1Bready\x1b]0;title\x07\r\n\x1b[12G> OK";
    expect(core.plainLog(raw)).toBe("Claude\nready\n> OK");
  });

  test("unavailable CLI leaves rows untouched", () => {
    db.apply({ agent: "claude", sessionId: "bg-d", state: "working", background: true });
    core.syncBackground(null);
    expect(db.getSession("bg-d")?.state).toBe("working");
  });
});

describe("fuzzy find", () => {
  test("letters must appear in order", () => {
    expect(fuzzyScore("hlm", "helm-rightsize your turn")).not.toBeNull();
    expect(fuzzyScore("mlh", "helm-rightsize")).toBeNull();
  });

  test("every space-separated term must match", () => {
    expect(fuzzyScore("helm turn", "helm-rightsize your turn")).not.toBeNull();
    expect(fuzzyScore("helm plan", "helm-rightsize your turn")).toBeNull();
  });

  test("substrings and word starts outrank scattered letters", () => {
    const exact = fuzzyScore("auth", "auth-refactor plan review")!;
    const scattered = fuzzyScore("auth", "a urgent task here")!;
    expect(exact).toBeGreaterThan(scattered);
    expect(fuzzyScore("ref", "auth-refactor")!).toBeGreaterThan(fuzzyScore("ref", "carefully")!);
  });

  test("letters spread across a sentence do not match", () => {
    expect(fuzzyScore("trad", "the last activity here was a month ago")).toBeNull();
    expect(fuzzyScore("trad", "trading")).not.toBeNull();
    expect(fuzzyScore("trdg", "the trading desk")).not.toBeNull();
  });

  test("substring-only mode needs the term as typed", () => {
    expect(fuzzyScore("commit", "shall I commit?", { substringOnly: true })).not.toBeNull();
    expect(fuzzyScore("cmt", "shall I commit?", { substringOnly: true })).toBeNull();
  });

  test("matching ignores case", () => {
    expect(fuzzyScore("PR", "pr review · feat: thing")).not.toBeNull();
  });
});

describe("aging", () => {
  const day = STALE_AFTER_MS;

  const put = (id: string, state: "waiting" | "needs_approval" | "working", ageMs: number, sinceMs = ageMs) => {
    db.apply({ agent: "claude", sessionId: id, state });
    db.open()
      .query("UPDATE sessions SET updated_at = ?, state_since = ? WHERE id = ?")
      .run(Date.now() - ageMs, Date.now() - sinceMs, id);
  };

  test("no activity past the threshold makes a session idle", () => {
    expect(isStale({ updated_at: Date.now() - day - 1000 })).toBe(true);
    expect(isStale({ updated_at: Date.now() - 3600_000 })).toBe(false);
  });

  test("idle sessions sort after active ones, even when they need you", () => {
    put("age-old-blocked", "needs_approval", 3 * day);
    put("age-fresh-wait", "waiting", 3600_000);
    const ids = core.sorted().map((s) => s.id).filter((id) => id.startsWith("age-"));
    expect(ids).toEqual(["age-fresh-wait", "age-old-blocked"]);
  });

  test("sort order flips within a group", () => {
    put("age-wait-2h", "waiting", 2 * 3600_000);
    put("age-wait-5h", "waiting", 5 * 3600_000);
    const pick = (order: "oldest" | "newest") =>
      core.sorted(order).map((s) => s.id).filter((id) => id === "age-wait-2h" || id === "age-wait-5h");
    expect(pick("oldest")).toEqual(["age-wait-5h", "age-wait-2h"]);
    expect(pick("newest")).toEqual(["age-wait-2h", "age-wait-5h"]);
  });
});

describe("resume", () => {
  test("SessionEnd records why the session ended, and the launch directory sticks", () => {
    const end = adapt({ session_id: "r-1", hook_event_name: "SessionEnd", reason: "prompt_input_exit" }, { CLAUDE_PROJECT_DIR: "/proj" });
    expect(end.event).toMatchObject({ state: "ended", endReason: "exited", projectDir: "/proj" });
    expect(adapt({ session_id: "r-1", hook_event_name: "SessionEnd", reason: "clear" }, {}).event?.endReason).toBe("clear");
    expect(adapt({ session_id: "r-1", hook_event_name: "SessionEnd", reason: "other" }, {}).event?.endReason).toBe("lost");
    expect(adapt({ session_id: "r-1", hook_event_name: "SessionEnd" }, {}).event?.endReason).toBe("lost");
  });

  test("ended rows keep their reason until revived; /clear ones are not offered", () => {
    db.apply({ agent: "claude", sessionId: "r-exit", state: "ended", endReason: "exited", projectDir: "/p" });
    db.apply({ agent: "claude", sessionId: "r-clear", state: "ended", endReason: "clear" });
    db.apply({ agent: "claude", sessionId: "r-lost", state: "working" });
    db.markEnded(["r-lost"], "lost");
    const ids = db.endedSessions(3600_000).map((s) => s.id);
    expect(ids).toContain("r-exit");
    expect(ids).toContain("r-lost");
    expect(ids).not.toContain("r-clear");
    expect(db.getSession("r-exit")).toMatchObject({ end_reason: "exited", project_dir: "/p" });
    db.apply({ agent: "claude", sessionId: "r-exit", state: "waiting" });
    expect(db.getSession("r-exit")).toMatchObject({ state: "waiting", end_reason: null, project_dir: "/p" });
  });

  test("a late exit hook does not overwrite a recorded close", () => {
    db.apply({ agent: "claude", sessionId: "r-closing", state: "working" });
    db.markEnded(["r-closing"], "closed");
    db.apply({ agent: "claude", sessionId: "r-closing", state: "ended", endReason: "lost" });
    expect(db.getSession("r-closing")?.end_reason).toBe("closed");
  });

  test("markEnded never overwrites how an already-ended session ended", () => {
    db.apply({ agent: "claude", sessionId: "r-closed", state: "working" });
    db.markEnded(["r-closed"], "closed");
    db.markEnded(["r-closed"], "lost");
    expect(db.getSession("r-closed")?.end_reason).toBe("closed");
  });

  test("only lost sessions are resumed in bulk, oldest first", () => {
    const lost = core.lostSessions().map((s) => s.id);
    expect(lost).toContain("r-lost");
    expect(lost).not.toContain("r-closed");
    expect(lost).not.toContain("r-exit");
  });

  test("launch directory falls back to the conversation file", () => {
    const home = mkdtempSync(join(tmpdir(), "carriot-home-"));
    const projects = join(home, ".claude/projects/-work");
    mkdirSync(projects, { recursive: true });
    writeFileSync(join(projects, "r-file.jsonl"), `${JSON.stringify({ type: "user", cwd: "/work/root" })}\n`);
    db.apply({ agent: "claude", sessionId: "r-file", state: "working", cwd: "/work/root/sessions/X/repo" });
    const prev = process.env.HOME;
    process.env.HOME = home;
    try {
      expect(core.launchDir(db.getSession("r-file")!)).toBe("/work/root");
    } finally {
      process.env.HOME = prev;
    }
  });
});

describe("hook entry", () => {
  test("empty stdin is ignored", () => {
    expect(core.handle("claude", "", (p) => adapt(p, env))).toBeUndefined();
    expect(core.handle("claude", " \n", (p) => adapt(p, env))).toBeUndefined();
  });

  test("the PR gate still asks when the store write fails", () => {
    const broken = { agent: null, sessionId: "gate-broken", state: "pr_review" } as any;
    const ask = { hookSpecificOutput: { permissionDecision: "ask" } };
    expect(core.handle("claude", "{}", () => ({ event: broken, response: ask }))).toBe(ask);
    expect(db.getSession("gate-broken")).toBeNull();
  });

  test("store failures without a response still surface", () => {
    const broken = { agent: null, sessionId: "plain-broken", state: "working" } as any;
    expect(() => core.handle("claude", "{}", () => ({ event: broken }))).toThrow();
  });
});
