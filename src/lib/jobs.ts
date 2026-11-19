import { db } from "./db";
import { logEvent, updateBatch } from "./store";

// The queue is a table. The worker runs three lanes, each one job at a time:
// launches in one, plans in one, review checks, go-live retries and backups in the other, so a
// review check never waits for a 20-minute launch. All lanes share one pacer per ad account.

export interface Job {
  id: number;
  /** "golive": only the step that turns a finished launch's ads on, tried again after it failed. For "plan", batch_id holds the plan's id. */
  kind: "launch" | "review" | "backup" | "plan" | "golive";
  batch_id: number | null;
  status: "queued" | "running" | "done" | "failed";
  run_after: number;
  attempts: number;
  locked_at: number | null;
  last_error: string | null;
}

/** A job that was started this many times without finishing (the worker died each time) is stopped. */
export const MAX_ATTEMPTS = 5;

/** When turning a launch's ads on fails, only that step (a "golive" job) is tried again this much later... */
export const GO_LIVE_RETRY_MS = 5 * 60_000;
/** ...at most this many times (about an hour); after that the person presses Retry. */
export const GO_LIVE_MAX_TRIES = 12;
/** The go-live tries of a batch: `<prefix>` holds the count, `<prefix>info` the last reason and the next try. Deleting the prefix resets both. */
export const goLiveRetryKey = (batchId: number) => `golive_retry:${batchId}:`;
export interface GoLiveRetryInfo {
  reason: string;
  /** When the next try is due (ms), or null when the worker gave up. */
  nextAt: number | null;
}
/** The go-live count and reason are kept this long, so "NOT turned on" stays on the batch (as long as alerts stay). */
export const GO_LIVE_NOTE_MS = 14 * 86_400_000;

/**
 * "Stop the launch" is in force for this batch: pressed, and no Retry since. Then nothing turns its
 * ads on by itself: the worker drops a go-live try that was waiting, and no note says one is coming.
 */
export function goLiveStopped(b: { cancel_requested?: number | null; stopped_at?: string | null; retried_at?: string | null }): boolean {
  if (b.cancel_requested) return true;
  if (!b.stopped_at) return false;
  const retried = b.retried_at ? Date.parse(b.retried_at) : NaN;
  return Number.isNaN(retried) || retried < Date.parse(b.stopped_at);
}

export function enqueue(kind: Job["kind"], batchId: number | null, runAfter = Date.now()): number {
  // At most one waiting job per batch and kind. (A running job may schedule its own follow-up.)
  const open = db().prepare("SELECT id FROM jobs WHERE kind = ? AND batch_id IS ? AND status = 'queued'").get(kind, batchId) as { id: number } | undefined;
  if (open) {
    db().prepare("UPDATE jobs SET run_after = MIN(run_after, ?) WHERE id = ?").run(runAfter, open.id);
    return open.id;
  }
  return Number(db().prepare("INSERT INTO jobs (kind, batch_id, run_after) VALUES (?, ?, ?)").run(kind, batchId, runAfter).lastInsertRowid);
}

export const LANES: Record<"launch" | "other" | "plan", readonly Job["kind"][]> = {
  launch: ["launch"],
  other: ["review", "golive", "backup"],
  // Plans get their own lane, so a plan scheduled for 9:00 doesn't wait behind a 4-hour launch.
  plan: ["plan"],
};

export function claimNext(kinds: readonly Job["kind"][], now = Date.now()): Job | undefined {
  const marks = kinds.map(() => "?").join(", ");
  return db()
    .prepare(
      `UPDATE jobs SET status = 'running', locked_at = ?, attempts = attempts + 1
       WHERE id = (SELECT id FROM jobs WHERE status = 'queued' AND run_after <= ? AND kind IN (${marks}) ORDER BY run_after, id LIMIT 1)
       RETURNING *`,
    )
    .get(now, now, ...kinds) as Job | undefined;
}

export function finishJob(id: number, status: "done" | "failed", error?: string) {
  db().prepare("UPDATE jobs SET status = ?, last_error = ?, locked_at = NULL WHERE id = ?").run(status, error ?? null, id);
}

/**
 * A running job whose follow-up of the same kind is already queued for the same batch (a go-live try
 * that failed and queued the next one, then was stopped while emailing) is done: its follow-up runs.
 * Putting it back too would leave two waiting jobs for one batch (the try would run twice).
 */
const RETIRE_IF_FOLLOWED = `UPDATE jobs SET status = 'done', locked_at = NULL WHERE id = ? AND status = 'running'
  AND EXISTS (SELECT 1 FROM jobs q WHERE q.kind = jobs.kind AND q.batch_id IS jobs.batch_id AND q.status = 'queued' AND q.id != jobs.id)`;

/**
 * Graceful stop (deploy, restart): running jobs go back in the queue and this run is not counted
 * as an attempt, so a few deploys in a row never stop a long launch. A job whose follow-up is
 * already queued is marked done instead (never two waiting jobs of one kind for one batch).
 */
export function releaseJobs(ids: number[]): number {
  const retire = db().prepare(RETIRE_IF_FOLLOWED);
  const put = db().prepare("UPDATE jobs SET status = 'queued', locked_at = NULL, attempts = MAX(attempts - 1, 0) WHERE id = ? AND status = 'running'");
  let n = 0;
  for (const id of ids) n += db().transaction(() => retire.run(id).changes || put.run(id).changes)();
  return n;
}

/** What a stopped launch or plan is, so the worker can tell the person who started it. */
export interface Stopped {
  kind: "launch" | "plan";
  key: string;
  who: string | null;
}

/**
 * A launch or plan job ended with an error (or was given up): record it on the batch or plan.
 * Ads not created yet are marked failed with the reason, so "Retry" picks them up; ads that already
 * failed keep their own reason. A batch whose every ad is in is done (not "partly done").
 * Only a batch or plan that is still queued or running is changed (never a finished one).
 */
export function markStopped(job: Pick<Job, "kind" | "batch_id">, msg: string): Stopped | null {
  if (!job.batch_id) return null;
  if (job.kind === "launch") {
    const b = db().prepare("SELECT id, key, status, created_by FROM batches WHERE id = ?").get(job.batch_id) as { id: number; key: string; status: string; created_by: string | null } | undefined;
    if (!b) return null;
    if (b.status === "queued" || b.status === "running") {
      const plain = `The launch stopped before this ad was created: ${msg}. Press "Retry" to continue; ads already created are not made again.`;
      db().transaction(() => {
        db().prepare("UPDATE ads SET status = 'failed', error = ?, wait_until = NULL WHERE batch_id = ? AND status NOT IN ('done', 'failed')").run(plain, b.id);
        const c = db().prepare("SELECT COUNT(*) AS total, COALESCE(SUM(status = 'done'), 0) AS done FROM ads WHERE batch_id = ?").get(b.id) as { total: number; done: number };
        const status = c.total > 0 && c.done === c.total ? "done" : c.done > 0 ? "partial" : "failed";
        updateBatch(b.id, { status, finished_at: new Date().toISOString() });
        logEvent(b.id, null, "error", status === "done" ? `Every ad was created, then the launch stopped: ${msg}` : `The launch stopped: ${msg}`);
      })();
    }
    return { kind: "launch", key: b.key, who: b.created_by };
  }
  if (job.kind === "plan") {
    const p = db().prepare("SELECT id, key, created_by FROM plans WHERE id = ?").get(job.batch_id) as { id: number; key: string; created_by: string | null } | undefined;
    if (!p) return null;
    db().prepare("UPDATE plans SET status = 'failed', finished_at = datetime('now') WHERE id = ? AND status IN ('queued', 'running')").run(p.id);
    return { kind: "plan", key: p.key, who: p.created_by };
  }
  return null;
}

/**
 * After a crash or restart: anything left "running" goes back in the queue. A job that was started
 * MAX_ATTEMPTS times and never finished (it kills the worker each time, e.g. out of memory) is
 * stopped instead, and its batch or plan is marked like any failed run.
 */
export function requeueStale(): { requeued: number; stopped: { job: Job; message: string; stopped: Stopped | null }[] } {
  const stuck = db().prepare("SELECT * FROM jobs WHERE status = 'running' AND attempts >= ?").all(MAX_ATTEMPTS) as Job[];
  const stopped: { job: Job; message: string; stopped: Stopped | null }[] = [];
  for (const job of stuck) {
    const what = job.kind === "launch" ? "launch" : job.kind === "plan" ? "plan" : `${job.kind} job`;
    const message = `the worker restarted ${job.attempts} times while running this ${what} (the server may be short of memory), so it was stopped instead of trying again`;
    finishJob(job.id, "failed", message);
    stopped.push({ job, message, stopped: markStopped(job, message) });
  }
  const left = db().prepare("SELECT id FROM jobs WHERE status = 'running'").pluck().all() as number[];
  const retire = db().prepare(RETIRE_IF_FOLLOWED);
  const put = db().prepare("UPDATE jobs SET status = 'queued', locked_at = NULL WHERE id = ? AND status = 'running'");
  let requeued = 0;
  for (const id of left) requeued += db().transaction(() => retire.run(id).changes || put.run(id).changes)();
  return { requeued, stopped };
}

export function workerHeartbeat() {
  db().prepare("INSERT INTO cache (key, value, expires_at) VALUES ('worker:heartbeat', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at")
    .run(JSON.stringify(Date.now()), Date.now() + 3600_000);
}

export function lastHeartbeat(): number | null {
  const r = db().prepare("SELECT value FROM cache WHERE key = 'worker:heartbeat'").get() as { value: string } | undefined;
  return r ? Number(JSON.parse(r.value)) : null;
}

/** The worker notes when it last read Meta's review status for a batch (shown on the batch page). */
export function markReviewChecked(batchId: number, at = new Date()) {
  db().prepare("INSERT INTO cache (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at")
    .run(`review_checked:${batchId}`, JSON.stringify(at.toISOString()), at.getTime() + 60 * 86_400_000);
}

/** When the worker last read Meta's review status for this batch (ISO time), or null. */
export function reviewCheckedAt(batchId: number): string | null {
  const r = db().prepare("SELECT value FROM cache WHERE key = ?").get(`review_checked:${batchId}`) as { value: string } | undefined;
  return r ? (JSON.parse(r.value) as string) : null;
}
