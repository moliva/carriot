export type State =
  | "working"
  | "needs_approval"
  | "question"
  | "plan_review"
  | "pr_review"
  | "waiting"
  | "ended";

export const BLOCKED: readonly State[] = ["needs_approval", "question", "plan_review", "pr_review"];

export type ArtifactKind = "plan" | "pr";

export interface Artifact {
  kind: ArtifactKind;
  title?: string;
  body: string;
  diff?: string;
  meta?: Record<string, unknown>;
}

/** Agent-agnostic event. Every adapter (claude, pi, ...) normalizes into this shape. */
export interface AgentEvent {
  agent: string;
  sessionId: string;
  cwd?: string;
  pane?: string;
  state?: State;
  /** Only apply `state` when the session is currently in a blocked state (e.g. a tool finished after approval). */
  onlyIfBlocked?: boolean;
  mode?: string;
  /** Agent-provided session title, used when the tmux window has no meaningful name. */
  title?: string;
  detail?: string;
  prompt?: string;
  lastMessage?: string;
  artifact?: Artifact;
  /** Attach to the most recent artifact of this kind instead of creating a new one. */
  artifactUpdate?: { kind: ArtifactKind; meta: Record<string, unknown> };
  /** Refresh tmux naming info (window renames happen mid-turn). */
  refreshTmux?: boolean;
  /** Runs detached from any terminal (e.g. `claude --bg`); reconnect by attaching. */
  background?: boolean;
}

export interface AdapterResult {
  event?: AgentEvent;
  /** JSON written to stdout for the agent harness (e.g. a permission decision). */
  response?: unknown;
}

export interface SessionRow {
  id: string;
  agent: string;
  name: string | null;
  title: string | null;
  cwd: string | null;
  pane: string | null;
  window_id: string | null;
  tmux_target: string | null;
  state: State;
  mode: string | null;
  detail: string | null;
  last_prompt: string | null;
  last_message: string | null;
  started_at: number;
  updated_at: number;
  state_since: number;
  ended_at: number | null;
  bg: number;
}

export interface ArtifactRow {
  id: number;
  session_id: string;
  kind: ArtifactKind;
  title: string | null;
  body: string;
  diff: string | null;
  meta: string | null;
  created_at: number;
}

const RANK: Record<State, number> = {
  needs_approval: 0,
  question: 0,
  plan_review: 0,
  pr_review: 0,
  waiting: 1,
  working: 2,
  ended: 3,
};

export const urgency = (s: State) => RANK[s];

export function label(row: Pick<SessionRow, "state" | "mode">): string {
  switch (row.state) {
    case "needs_approval":
      return "needs approval";
    case "question":
      return "question";
    case "plan_review":
      return "plan review";
    case "pr_review":
      return "PR review";
    case "waiting":
      return "your turn";
    case "working":
      return row.mode === "plan" ? "planning" : "working";
    case "ended":
      return "ended";
  }
}
