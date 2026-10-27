import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as core from "./core";
import * as db from "./db";
import * as notify from "./notify";
import { diffPr, fetchTicket, inspect, workDir, type PrStatus } from "./work";

const POLL_MS = Number(process.env.CARRIOT_PR_POLL_SECONDS ?? 120) * 1000;
const TICKET_TTL_MS = 30 * 60_000;

export interface Refreshed {
  checked: number;
  flagged: { name: string; reason: string }[];
}

/** One pass over live sessions: record each one's ticket, branch and PR, and flag and notify on PR changes. */
export async function refreshAll(): Promise<Refreshed> {
  core.reconcile();
  const out: Refreshed = { checked: 0, flagged: [] };
  for (const s of db.liveSessions()) {
    out.checked++;
    const work = inspect(workDir(s.cwd, core.transcriptPath(s)));
    const before = db.getWork(s.id);
    const prev: PrStatus | null = before?.pr ? JSON.parse(before.pr) : null;
    db.putWork({ session_id: s.id, repo: work.repo, branch: work.branch, ticket: work.ticket, pr: work.pr ? JSON.stringify(work.pr) : null });

    // PR text links Linear issues; keep their URLs and learn the workspace so other tickets can link too.
    for (const l of work.links) {
      db.setTicketUrl(l.id, l.url);
      if (db.getSetting("linear_workspace") !== l.workspace) db.putSetting("linear_workspace", l.workspace);
    }
    if (work.ticket) {
      const cached = db.getTicket(work.ticket);
      if (!cached || Date.now() - cached.fetched_at > TICKET_TTL_MS) db.putTicket(await fetchTicket(work.ticket));
    }

    const change = diffPr(prev, work.pr);
    if (change.attention) {
      db.setAttention(s.id, change.attention);
      out.flagged.push({ name: core.displayName(s), reason: change.attention });
    } else if (s.attention === "CI failing" && work.pr && work.pr.checks.failed === 0) db.setAttention(s.id, null);
    if (change.attention || s.attention) core.repaint(s.window_id);
    if (change.notify && work.pr) {
      try {
        notify.prChange(db.getSession(s.id) ?? s, core.displayName(s), change.notify, work.pr);
      } catch (err) {
        core.logError(err);
      }
    }
  }
  return out;
}

const pidFile = () => join(dirname(db.DB_PATH), "watch.pid");

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Long-running PR watcher, started by carriot.tmux with every tmux config load; a second copy sees the first one's
 * pid file and exits, so reloads never stack watchers.
 */
export async function watch() {
  const file = pidFile();
  if (existsSync(file) && alive(Number(readFileSync(file, "utf8")))) return;
  writeFileSync(file, String(process.pid));
  const stop = () => {
    try {
      if (readFileSync(file, "utf8") === String(process.pid)) rmSync(file);
    } catch {}
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  process.on("SIGHUP", stop);
  for (;;) {
    try {
      await refreshAll();
    } catch (err) {
      core.logError(err);
    }
    await Bun.sleep(POLL_MS);
  }
}
