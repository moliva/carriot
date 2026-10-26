import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { isPrCreate, prArtifact } from "../pr";
import type { AdapterResult, AgentEvent } from "../types";

/** Claude Code hook stdin payload (fields vary by event; everything optional by design). */
export interface ClaudeHook {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  transcript_path?: string;
  permission_mode?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: Record<string, any>;
  tool_response?: unknown;
  message?: string;
  notification_type?: string;
  last_assistant_message?: string;
  source?: string;
  session_title?: string;
  reason?: string;
}

const clip = (line: string, n: number) => (line.length > n ? `${line.slice(0, n - 1)}…` : line);
const firstLine = (s: string | undefined, n = 160) => clip((s ?? "").trim().split("\n").find((l) => l.trim()) ?? "", n);
const lastLine = (s: string | undefined, n = 160) => clip((s ?? "").trim().split("\n").findLast((l) => l.trim()) ?? "", n);

/** Last assistant text in a transcript JSONL, reading only the file tail. */
export function lastAssistantText(path: string | undefined): string | undefined {
  if (!path || !existsSync(path)) return;
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(size, 512 * 1024);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"assistant"')) continue;
      try {
        const rec = JSON.parse(lines[i]);
        if (rec.type !== "assistant") continue;
        const content = rec.message?.content;
        const text = Array.isArray(content)
          ? content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n")
          : typeof content === "string"
            ? content
            : "";
        if (text.trim()) return text.trim();
      } catch {}
    }
  } finally {
    closeSync(fd);
  }
}

function toolSummary(name: string | undefined, input: Record<string, any> | undefined): string {
  if (!name) return "permission requested";
  const arg = input?.command ?? input?.file_path ?? input?.url ?? input?.pattern ?? input?.description;
  return arg ? `${name}: ${firstLine(String(arg), 120)}` : name;
}

function planFrom(input: Record<string, any> | undefined): string | undefined {
  if (typeof input?.plan === "string" && input.plan.trim()) return input.plan;
  const path = input?.planFilePath ?? input?.plan_file_path;
  if (typeof path === "string" && existsSync(path)) return readFileSync(path, "utf8");
}

export function adapt(h: ClaudeHook, env: Record<string, string | undefined> = process.env): AdapterResult {
  if (!h.session_id || !h.hook_event_name) return {};
  const base: AgentEvent = {
    agent: "claude",
    sessionId: h.session_id,
    cwd: h.cwd,
    pane: env.CLAUDE_CODE_SESSION_KIND === "bg" ? undefined : env.TMUX_PANE || undefined,
    background: env.CLAUDE_CODE_SESSION_KIND === "bg" || undefined,
    mode: h.permission_mode,
    title: h.session_title || undefined,
  };

  switch (h.hook_event_name) {
    case "SessionStart":
      return { event: { ...base, state: "waiting", detail: `session ${h.source ?? "started"}`, refreshTmux: true } };

    case "UserPromptSubmit":
      return {
        event: { ...base, state: "working", prompt: firstLine(h.prompt, 300), detail: firstLine(h.prompt), refreshTmux: true },
      };

    case "PreToolUse": {
      if (h.tool_name === "ExitPlanMode") {
        const plan = planFrom(h.tool_input);
        return {
          event: {
            ...base,
            state: "plan_review",
            detail: plan ? firstLine(plan.replace(/^#+\s*/gm, "")) : "plan ready",
            artifact: plan ? { kind: "plan", title: firstLine(plan.replace(/^#+\s*/gm, ""), 120), body: plan } : undefined,
          },
        };
      }
      if (h.tool_name === "AskUserQuestion") {
        const q = h.tool_input?.questions?.[0]?.question;
        return { event: { ...base, state: "question", detail: firstLine(q) || "question" } };
      }
      if (h.tool_name === "Bash" && typeof h.tool_input?.command === "string" && isPrCreate(h.tool_input.command)) {
        const artifact = prArtifact(h.tool_input.command, h.cwd ?? process.cwd());
        const gate = env.CARRIOT_PR_GATE !== "0";
        return {
          event: { ...base, state: gate ? "pr_review" : "working", detail: `PR: ${artifact.title ?? ""}`, artifact },
          response: gate
            ? {
                hookSpecificOutput: {
                  hookEventName: "PreToolUse",
                  permissionDecision: "ask",
                  permissionDecisionReason: `PR preview ready — review it in carriot (web UI or 'carriot pr ${h.session_id.slice(0, 8)}') before approving.`,
                },
              }
            : undefined,
        };
      }
      return {};
    }

    case "PermissionRequest":
      return { event: { ...base, state: "needs_approval", detail: toolSummary(h.tool_name, h.tool_input) } };

    case "PostToolUse": {
      const ev: AgentEvent = { ...base, state: "working", onlyIfBlocked: true };
      if (h.tool_name === "Bash" && isPrCreate(String(h.tool_input?.command ?? ""))) {
        const url = JSON.stringify(h.tool_response ?? "").match(/https:\/\/github\.com\/[^\s"\\]+\/pull\/\d+/)?.[0];
        if (url) ev.artifactUpdate = { kind: "pr", meta: { url } };
      }
      return { event: ev };
    }

    case "Notification": {
      const msg = h.message ?? "";
      if (h.notification_type === "permission_prompt" || /permission/i.test(msg))
        return { event: { ...base, state: "needs_approval", detail: firstLine(msg) } };
      if (h.notification_type === "elicitation_dialog" || h.notification_type === "elicitation_url_dialog")
        return { event: { ...base, state: "question", detail: firstLine(msg) || "input requested" } };
      if (h.notification_type === "agent_needs_input")
        return { event: { ...base, state: "question", detail: firstLine(msg) || "agent needs input" } };
      if (h.notification_type === "idle_prompt" || /waiting for your input/i.test(msg))
        return { event: { ...base, state: "waiting" } };
      return {};
    }

    case "Stop": {
      const text = h.last_assistant_message ?? lastAssistantText(h.transcript_path);
      return {
        event: {
          ...base,
          state: "waiting",
          detail: lastLine(text) || "finished",
          lastMessage: text?.slice(-4000),
          refreshTmux: true,
        },
      };
    }

    case "SessionEnd":
      return { event: { ...base, state: "ended" } };
  }
  return {};
}
