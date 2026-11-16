import { db } from "./db";

// The queue is a table. The worker runs two lanes, each one job at a time:
// launches in one, review checks and backups in the other, so a review check
// never waits for a 20-minute launch. Both lanes share one pacer per ad account.

export interface Job {
  id: number;
  kind: "launch" | "review" | "backup";
  batch_id: number | null;
  status: "queued" | "running" | "done" | "failed";
  run_after: number;
  attempts: number;
  locked_at: number | null;
  last_error: string | null;
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

export const LANES: Record<"launch" | "other", readonly Job["kind"][]> = {
  launch: ["launch"],
  other: ["review", "backup"],
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

/** After a crash or restart: anything left "running" goes back in the queue. */
export function requeueStale(): number {
  return db().prepare("UPDATE jobs SET status = 'queued', locked_at = NULL WHERE status = 'running'").run().changes;
}

export function workerHeartbeat() {
  db().prepare("INSERT INTO cache (key, value, expires_at) VALUES ('worker:heartbeat', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at")
    .run(JSON.stringify(Date.now()), Date.now() + 3600_000);
}

export function lastHeartbeat(): number | null {
  const r = db().prepare("SELECT value FROM cache WHERE key = 'worker:heartbeat'").get() as { value: string } | undefined;
  return r ? Number(JSON.parse(r.value)) : null;
}
