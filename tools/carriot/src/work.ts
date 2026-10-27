import { readFileSync } from "node:fs";
import { basename } from "node:path";

/** What a session is working on: its ticket, branch and pull request. */
export interface Work {
  repo: string | null;
  branch: string | null;
  ticket: string | null;
  pr: PrStatus | null;
}

export interface PrStatus {
  number: number;
  url: string;
  title: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  draft: boolean;
  checks: { failed: number; pending: number; passed: number; total: number };
  /** APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED or null. */
  review: string | null;
  /** Comments and reviews from other people (not you, not noisy automation). */
  activity: number;
}

export interface Ticket {
  id: string;
  title: string | null;
  status: string | null;
  url: string | null;
}

const DEFAULT_BRANCHES = new Set(["main", "master", "develop", "HEAD"]);

/** Automation whose comments are noise, not review; your own comments never count either. */
const IGNORED_AUTHORS = new Set(
  (process.env.CARRIOT_PR_IGNORE_AUTHORS ?? "github-actions,linear-code,linear,vercel,codecov,dependabot,renovate")
    .split(",")
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean),
);

/** Ticket id from a carriot session folder (sessions/BEPLAT-123/...) or a Linear-style branch (me/beplat-123-...). */
export function ticketFrom(cwd: string | null, branch: string | null): string | null {
  const dir = cwd?.match(/\/sessions\/([A-Za-z][A-Za-z0-9]*-\d+)(?:\/|$)/)?.[1];
  if (dir) return dir.toUpperCase();
  const fromBranch = branch?.match(/(?:^|\/)([A-Za-z][A-Za-z0-9]*-\d+)(?:-|$)/)?.[1];
  return fromBranch ? fromBranch.toUpperCase() : null;
}

/** Review sessions (sessions/review-<repo>#<number>/...) name the PR under review. */
export function reviewedPr(cwd: string | null): number | null {
  const n = cwd?.match(/\/sessions\/review-[^/#]+#(\d+)(?:\/|$)/)?.[1];
  return n ? Number(n) : null;
}

/** owner/name from a GitHub remote URL (ssh or https). */
export function repoFromRemote(url: string): string | null {
  return url.trim().match(/github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?$/)?.[1] ?? null;
}

/** Gate checks that report mergeability rather than CI results; they fail until the PR may merge, so they are skipped. */
const IGNORED_CHECKS = (process.env.CARRIOT_PR_IGNORE_CHECKS ?? "mergeable")
  .split(",")
  .map((c) => c.trim().toLowerCase())
  .filter(Boolean);

const FAILED = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"]);

/** Counts a statusCheckRollup: check runs report status + conclusion, commit statuses report a single state. */
export function summarizeChecks(rollup: any[] | null | undefined): PrStatus["checks"] {
  const checks = { failed: 0, pending: 0, passed: 0, total: 0 };
  for (const c of rollup ?? []) {
    const name = String(c.name ?? c.context ?? "").toLowerCase();
    if (IGNORED_CHECKS.some((ignored) => name.includes(ignored))) continue;
    checks.total++;
    const outcome = c.__typename === "StatusContext" ? c.state : c.status === "COMPLETED" ? c.conclusion : "PENDING";
    if (FAILED.has(outcome)) checks.failed++;
    else if (outcome === "PENDING" || outcome === "EXPECTED" || outcome === "QUEUED" || outcome === "IN_PROGRESS") checks.pending++;
    else checks.passed++;
  }
  return checks;
}

export function summarizePr(json: any, me: string | null): PrStatus {
  const counts = (author: any) => {
    const login = String(author?.login ?? "").toLowerCase();
    return login && login !== me?.toLowerCase() && !IGNORED_AUTHORS.has(login) && !login.endsWith("[bot]");
  };
  return {
    number: json.number,
    url: json.url,
    title: json.title,
    state: json.state,
    draft: !!json.isDraft,
    checks: summarizeChecks(json.statusCheckRollup),
    review: json.reviewDecision || null,
    activity: (json.comments ?? []).filter((c: any) => counts(c.author)).length + (json.reviews ?? []).filter((r: any) => counts(r.author)).length,
  };
}

export interface Change {
  /** Reason the session needs you (turns it red and notifies); null when only worth a quiet notification. */
  attention: string | null;
  notify: { subtitle: string; urgent: boolean } | null;
}

/**
 * What changed between two looks at a PR. The first look (no previous) only records a baseline, so starting carriot
 * does not raise every PR at once.
 */
export function diffPr(prev: PrStatus | null, next: PrStatus | null): Change {
  const none: Change = { attention: null, notify: null };
  if (!prev || !next || prev.number !== next.number) return none;
  if (prev.state === "OPEN" && next.state === "MERGED") return { attention: null, notify: { subtitle: "PR merged", urgent: false } };
  if (next.state !== "OPEN") return none;
  if (next.checks.failed > 0 && prev.checks.failed === 0) return { attention: "CI failing", notify: { subtitle: "CI failing", urgent: true } };
  if (next.review === "CHANGES_REQUESTED" && prev.review !== "CHANGES_REQUESTED")
    return { attention: "changes requested", notify: { subtitle: "Changes requested", urgent: true } };
  if (next.activity > prev.activity) {
    const n = next.activity - prev.activity;
    const what = `${n} new comment${n === 1 ? "" : "s"}`;
    return { attention: what, notify: { subtitle: what.replace(/^./, (c) => c.toUpperCase()), urgent: true } };
  }
  if (next.review === "APPROVED" && prev.review !== "APPROVED") return { attention: null, notify: { subtitle: "PR approved", urgent: false } };
  return none;
}

/** Short PR badge for list rows, e.g. "#9936 ✓ changes". */
export function prBadge(pr: PrStatus): { text: string; tone: "bad" | "pending" | "good" | "neutral" } {
  if (pr.state === "MERGED") return { text: `#${pr.number} merged`, tone: "neutral" };
  if (pr.state === "CLOSED") return { text: `#${pr.number} closed`, tone: "neutral" };
  const ci = pr.checks.failed ? "✗" : pr.checks.pending ? "…" : pr.checks.total ? "✓" : "";
  const review = pr.review === "CHANGES_REQUESTED" ? " changes" : pr.review === "APPROVED" ? " approved" : "";
  const tone = pr.checks.failed || pr.review === "CHANGES_REQUESTED" ? "bad" : pr.checks.pending ? "pending" : pr.review === "APPROVED" ? "good" : "neutral";
  return { text: `#${pr.number}${pr.draft ? " draft" : ""}${ci ? ` ${ci}` : ""}${review}`, tone };
}

/** One line for the detail pane, e.g. "PR #9936 · open · CI 14/14 passed · changes requested · 3 comments". */
export function prLine(pr: PrStatus): string {
  const c = pr.checks;
  const ci = !c.total ? "no checks" : c.failed ? `CI ${c.failed} failing` : c.pending ? `CI ${c.pending} running` : `CI ${c.passed}/${c.total} passed`;
  const review = pr.review ? pr.review.toLowerCase().replace(/_/g, " ") : null;
  return [`PR #${pr.number}`, pr.draft ? "draft" : pr.state.toLowerCase(), pr.state === "OPEN" ? ci : null, review, pr.activity ? `${pr.activity} comments` : null]
    .filter(Boolean)
    .join(" · ");
}

// --- fetching -----------------------------------------------------------------------------------------------------

function run(cmd: string[], cwd?: string): string | null {
  try {
    const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "ignore" });
    return p.exitCode === 0 ? p.stdout.toString().trim() : null;
  } catch {
    return null;
  }
}

let login: string | null | undefined;
function me(): string | null {
  if (login === undefined) login = run(["gh", "api", "user", "--jq", ".login"]);
  return login;
}

const PR_FIELDS = "number,url,title,state,isDraft,reviewDecision,statusCheckRollup,comments,reviews";

/**
 * Where a session does its work: its current directory when that is inside a carriot session folder, else the last
 * such directory its conversation recorded (agents often wander back to the hub root after setting up a worktree).
 */
export function workDir(cwd: string | null, transcript: string | null): string | null {
  if (!cwd || cwd.includes("/sessions/") || !transcript) return cwd;
  try {
    const text = readFileSync(transcript, "utf8");
    const tail = text.slice(-4 * 1024 * 1024);
    const dirs = [...tail.matchAll(/"cwd":"([^"]*\/sessions\/[^"]+)"/g)];
    return dirs.length ? dirs[dirs.length - 1][1] : cwd;
  } catch {
    return cwd;
  }
}

/** Looks up what a session's directory is working on. Network: one `gh pr view` when there is a branch or review PR. */
export function inspect(cwd: string | null): Work {
  const work: Work = { repo: null, branch: null, ticket: null, pr: null };
  if (!cwd) return work;
  const remote = run(["git", "-C", cwd, "remote", "get-url", "origin"]);
  work.repo = remote ? repoFromRemote(remote) : null;
  work.branch = run(["git", "-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"]);
  work.ticket = ticketFrom(cwd, work.branch);
  const reviewing = reviewedPr(cwd);
  const ref = reviewing ? String(reviewing) : work.branch && !DEFAULT_BRANCHES.has(work.branch) ? work.branch : null;
  if (!ref || !work.repo) return work;
  const json = run(["gh", "pr", "view", ref, "--repo", work.repo, "--json", PR_FIELDS]);
  if (json) {
    try {
      work.pr = summarizePr(JSON.parse(json), me());
    } catch {}
  }
  return work;
}

/** Linear API key from CARRIOT_LINEAR_API_KEY / LINEAR_API_KEY, or the keychain item "carriot-linear". */
function linearKey(): string | null {
  return process.env.CARRIOT_LINEAR_API_KEY || process.env.LINEAR_API_KEY || run(["security", "find-generic-password", "-s", "carriot-linear", "-w"]);
}

/** Title and status from Linear when a key is configured; otherwise just the id. */
export async function fetchTicket(id: string): Promise<Ticket> {
  const ticket: Ticket = { id, title: null, status: null, url: null };
  const key = linearKey();
  if (!key) return ticket;
  try {
    const res = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: key },
      body: JSON.stringify({ query: "query($id: String!) { issue(id: $id) { title url state { name } } }", variables: { id } }),
      signal: AbortSignal.timeout(5000),
    });
    const issue = (await res.json())?.data?.issue;
    if (issue) Object.assign(ticket, { title: issue.title ?? null, status: issue.state?.name ?? null, url: issue.url ?? null });
  } catch {}
  return ticket;
}

export const repoName = (repo: string | null) => (repo ? basename(repo) : null);
