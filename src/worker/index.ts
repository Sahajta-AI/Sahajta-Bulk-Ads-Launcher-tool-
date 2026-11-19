import { LANES, claimNext, releaseJobs, requeueStale, type Job } from "@/lib/jobs";
import { useBackgroundClients } from "@/lib/meta/factory";
import { alertStopped, log, nightly, runClaimed, safeHeartbeat } from "./run";

// The worker: takes jobs from the jobs table in three lanes, each one job at a time.
//   launch lane: launch -> run a batch to the end (paced, resumable)
//   plan lane:   plan -> run a confirmed plan
//   other lane:  review -> read Meta's review status for a batch's ads, again later while any are pending
//                backup -> copy the database to Object Storage
// All lanes call Meta through the same pacer per ad account, so together they stay under the limit.
// What each job does is in ./run.ts.

// Nobody waits on a page here: launches and plans wait as long as Meta's rate limits ask.
useBackgroundClients();

/** On SIGTERM (deploy, restart) the running job gets this long to finish its current Meta call. */
const STOP_AFTER_MS = 8_000;

let stopping = false;
/** Jobs running now, per lane: put back in the queue on a graceful stop. */
const running = new Set<number>();

async function lane(kinds: readonly Job["kind"][]) {
  while (!stopping) {
    let job: Job | undefined;
    try {
      job = claimNext(kinds);
    } catch (e) {
      log(`couldn't read the job queue: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!job) {
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    running.add(job.id);
    try {
      await runClaimed(job);
    } finally {
      running.delete(job.id);
    }
  }
}

function stop(sig: string) {
  if (stopping) return;
  stopping = true;
  log(`${sig}: no new jobs. The running job gets ${STOP_AFTER_MS / 1000} seconds, then goes back in the queue and continues on the next start.`);
  setTimeout(() => {
    try {
      // Not counted as an attempt: a deploy in the middle of a long launch is normal.
      const n = releaseJobs([...running]);
      if (n) log(`Put ${n} running job(s) back in the queue.`);
    } catch (e) {
      log(`couldn't put the running jobs back (they resume on the next start anyway): ${e instanceof Error ? e.message : String(e)}`);
    }
    process.exit(0);
  }, STOP_AFTER_MS);
}

async function main() {
  // First of all: a stop (deploy, restart) that comes while the worker is starting is handled too.
  // The signal reaches this process through `npx tsx` (npm and tsx both pass SIGTERM and SIGINT on).
  for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => stop(sig));
  const { requeued, stopped } = requeueStale();
  if (requeued) log(`Resuming ${requeued} job(s) that were running when the worker stopped.`);
  for (const s of stopped) {
    log(`job ${s.job.id} (${s.job.kind}) stopped: ${s.message}`);
    if (s.stopped) await alertStopped(s.stopped, s.message).catch(() => undefined);
  }
  log("Worker started.");

  safeHeartbeat();
  setInterval(safeHeartbeat, 15_000);

  // Nightly cleanup and backup: once per India-time day, on the first check after 02:00 IST.
  let nightlyBusy = false;
  const tick = async () => {
    if (nightlyBusy || stopping) return;
    nightlyBusy = true;
    try {
      if (await nightly()) log("Nightly cleanup and backup started.");
    } finally {
      nightlyBusy = false;
    }
  };
  void tick();
  setInterval(() => void tick(), 60_000);

  await Promise.all([lane(LANES.launch), lane(LANES.other), lane(LANES.plan)]);
  log("Worker stopped.");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
