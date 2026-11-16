import fs from "node:fs";
import path from "node:path";
import { backupNow } from "@/lib/backup";
import { removeBatchFiles, sweepFiles } from "@/lib/cleanup";
import { config } from "@/lib/config";
import { db } from "@/lib/db";
import { checkReview, runBatch } from "@/lib/engine/launcher";
import { LANES, claimNext, enqueue, finishJob, requeueStale, workerHeartbeat, type Job } from "@/lib/jobs";
import { clientFor } from "@/lib/meta/factory";
import { realClock } from "@/lib/meta/pacer";
import { anyFiles } from "@/lib/sources/drive";
import { getBatch, logEvent, updateBatch } from "@/lib/store";

// The worker: takes jobs from the jobs table in two lanes, each one job at a time.
//   launch lane: launch -> run a batch to the end (paced, resumable)
//   other lane:  review -> read Meta's review status for a batch's ads, again later while any are pending
//                backup -> copy the database to Object Storage
// Both lanes call Meta through the same pacer per ad account, so together they stay under the limit.

const REVIEW_SCHEDULE_MIN = [2, 10, 30, 60, 180, 360, 720, 1440];

function log(msg: string) {
  console.log(`${new Date().toISOString()} ${msg}`);
}

async function runJob(job: Job) {
  if (job.kind === "launch") {
    const batch = getBatch(job.batch_id!)!;
    const client = clientFor(batch.ad_account_id, (ms, reason) => {
      // Short pauses happen on almost every call on Meta's slow tier: only log the long ones.
      if (ms >= 60_000) logEvent(batch.id, null, "info", `${reason}: waiting ${Math.ceil(ms / 1000)} seconds.`);
    });
    const tmpDir = path.join(config.dataDir, "tmp");
    fs.mkdirSync(tmpDir, { recursive: true });
    const res = await runBatch(batch.id, { client, files: anyFiles, clock: realClock, accountDbId: batch.ad_account_id, tmpDir, namePrefix: config.namePrefix });
    log(`batch ${batch.key}: ${res.done} done, ${res.failed} failed`);
    // Meta has every file now: free the server's disk. Kept while some ads still need a retry.
    if (res.failed === 0) {
      const freed = removeBatchFiles(batch.id);
      if (freed) log(`batch ${batch.key}: removed ${Math.round(freed / 1024 ** 2)} MB of creatives from the server`);
    }
    enqueue("review", batch.id, Date.now() + REVIEW_SCHEDULE_MIN[0] * 60_000);
    enqueue("backup", null);
    return;
  }
  if (job.kind === "review") {
    const batch = getBatch(job.batch_id!)!;
    const { pending } = await checkReview(clientFor(batch.ad_account_id), batch.id);
    // Earlier review checks for this batch, plus this one.
    const n = (db().prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'review' AND batch_id = ? AND status = 'done'").get(batch.id) as { n: number }).n + 1;
    if (pending > 0 && n < REVIEW_SCHEDULE_MIN.length) enqueue("review", batch.id, Date.now() + REVIEW_SCHEDULE_MIN[n] * 60_000);
    return;
  }
  if (job.kind === "backup") {
    const r = await backupNow("after a batch");
    log(r.message);
  }
}

let stopping = false;

async function lane(kinds: readonly Job["kind"][], everyLoop?: () => void) {
  while (!stopping) {
    everyLoop?.();
    const job = claimNext(kinds);
    if (!job) {
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    try {
      await runJob(job);
      finishJob(job.id, "done");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`job ${job.id} (${job.kind}) failed: ${msg}`);
      finishJob(job.id, "failed", msg);
      if (job.kind === "launch" && job.batch_id) {
        // Ads not created yet are marked failed with the reason, so "Retry" can pick them up.
        const plain = `The launch stopped before this ad was created: ${msg}. Press "Retry" to continue; ads already created are not made again.`;
        db().prepare("UPDATE ads SET status = 'failed', error = ?, wait_until = NULL WHERE batch_id = ? AND status != 'done'").run(plain, job.batch_id);
        const done = (db().prepare("SELECT COUNT(*) AS n FROM ads WHERE batch_id = ? AND status = 'done'").get(job.batch_id) as { n: number }).n;
        updateBatch(job.batch_id, { status: done ? "partial" : "failed", finished_at: new Date().toISOString() });
        logEvent(job.batch_id, null, "error", `The launch stopped: ${msg}`);
      }
    }
  }
}

async function main() {
  const stale = requeueStale();
  if (stale) log(`Resuming ${stale} job(s) that were running when the worker stopped.`);
  log("Worker started.");
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => {
      log(`${sig}: stopping after the current step. Unfinished batches resume on the next start.`);
      stopping = true;
      setTimeout(() => process.exit(0), 2000);
    });
  }
  workerHeartbeat();
  setInterval(workerHeartbeat, 15_000);
  // Nightly backup at about 02:00 IST.
  let lastNightly = "";
  const nightly = () => {
    const ist = new Date(Date.now() + 330 * 60_000);
    const day = ist.toISOString().slice(0, 10);
    if (ist.getUTCHours() === 2 && lastNightly !== day) {
      lastNightly = day;
      enqueue("backup", null);
      const swept = sweepFiles();
      if (swept.freedGb) log(`nightly cleanup: ${swept.freedGb} GB freed`);
    }
  };
  await Promise.all([lane(LANES.launch), lane(LANES.other, nightly)]);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
