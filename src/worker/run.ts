import fs from "node:fs";
import path from "node:path";
import { appLink, clearAlerts, sendAlert } from "@/lib/alerts";
import { NIGHTLY_DAY_KEY, getSetting, putSetting } from "@/lib/appsettings";
import { backupAlertDue, backupNow, markBackupAlerted } from "@/lib/backup";
import { removeBatchFiles, sweepFiles } from "@/lib/cleanup";
import { config } from "@/lib/config";
import { db } from "@/lib/db";
import { checkReview, runBatch } from "@/lib/engine/launcher";
import { GO_LIVE_MAX_TRIES, GO_LIVE_NOTE_MS, GO_LIVE_RETRY_MS, enqueue, finishJob, goLiveRetryKey, goLiveStopped, markReviewChecked, markStopped, workerHeartbeat, type GoLiveRetryInfo, type Job, type Stopped } from "@/lib/jobs";
import { queueGoLive } from "@/lib/manage/golive";
import { runPlan, setPlanWait } from "@/lib/manage/plan";
import { clientFor } from "@/lib/meta/factory";
import { realClock } from "@/lib/meta/pacer";
import { anyFiles, downloadDriveFile } from "@/lib/sources/drive";
import { cacheDelete, cacheGet, cacheSet, getBatch, logEvent } from "@/lib/store";

// What the worker does with each job (src/worker/index.ts runs the lanes and the timers).
//   launch: run a batch to the end (paced, resumable), then the follow-up steps
//   golive: only turn a finished launch's ads on, again (after that step failed)
//   plan:   run a confirmed plan
//   review: read Meta's review status for a batch's ads, again later while any are pending
//   backup: copy the database to Object Storage
// Rule: once a launch or plan has run, nothing after it (emails, file removal, go-live, scheduling)
// can change its result or stop the worker.

export const REVIEW_SCHEDULE_MIN = [2, 10, 30, 60, 180, 360, 720, 1440];
export { GO_LIVE_MAX_TRIES, GO_LIVE_RETRY_MS } from "@/lib/jobs";

export function log(msg: string) {
  console.log(`${new Date().toISOString()} ${msg}`);
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** One follow-up step: a failure is logged (and shown on the batch), never thrown. */
async function safely(what: string, batchId: number | null, fn: () => unknown): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (e) {
    log(`${what} failed: ${errText(e)}`);
    try {
      if (batchId) logEvent(batchId, null, "warn", `${what} didn't work: ${errText(e)}`);
    } catch {
      /* logged above */
    }
    return false;
  }
}

/** A launch or plan changed campaigns and ad sets: the pages' 2-minute lists must be read from Meta again. */
export function clearMetaLists() {
  try {
    cacheDelete("tree:");
    cacheDelete("dest:");
  } catch (e) {
    log(`couldn't clear the campaign lists: ${errText(e)}`);
  }
}

const goLiveKey = goLiveRetryKey;

/** One go-live at a time per batch (a retry and a launch's own go-live may meet in two lanes). */
const goLiveBusy = new Map<number, Promise<void>>();

/**
 * "Launch now" / "at a time": queue the plan that turns the new ads on. A failure is tried again
 * on its own (a "golive" job): never the whole launch, so no new run, no review check moved, no backup.
 */
export async function goLive(batchId: number): Promise<void> {
  const before = goLiveBusy.get(batchId);
  const mine = (async () => {
    await before?.catch(() => undefined);
    await goLiveOnce(batchId);
  })();
  goLiveBusy.set(batchId, mine);
  try {
    await mine;
  } finally {
    if (goLiveBusy.get(batchId) === mine) goLiveBusy.delete(batchId);
  }
}

async function goLiveOnce(batchId: number) {
  const b = getBatch(batchId);
  if (!b) return;
  let reason: string;
  try {
    const msg = await queueGoLive(batchId);
    if (msg) log(`batch ${b.key}: ${msg}`);
    reason = "";
  } catch (e) {
    reason = errText(e) || "unknown error";
  }
  if (!reason) {
    try {
      cacheDelete(goLiveKey(batchId));
      // The turn-on step went through (a plan is queued, or saved as a draft with its own alert).
      if (getBatch(batchId)?.go_live_done) clearAlerts(`/batches/${b.key}`, ["golive"]);
    } catch (e) {
      log(`batch ${b.key}: couldn't tidy up after the go-live: ${errText(e)}`);
    }
    return;
  }
  const tries = (cacheGet<number>(goLiveKey(batchId)) ?? 0) + 1;
  cacheSet(goLiveKey(batchId), tries, GO_LIVE_NOTE_MS);
  const again = tries < GO_LIVE_MAX_TRIES;
  const nextAt = again ? Date.now() + GO_LIVE_RETRY_MS : null;
  // For the batch page and Claude (goLiveNote): why it failed and when it is tried again. Kept 14 days,
  // so "NOT turned on" doesn't vanish a day after the worker gave up (a Retry or a success removes it).
  cacheSet(`${goLiveKey(batchId)}info`, { reason, nextAt } satisfies GoLiveRetryInfo, GO_LIVE_NOTE_MS);
  if (nextAt) enqueue("golive", batchId, nextAt);
  log(`batch ${b.key}: go-live failed (${tries}/${GO_LIVE_MAX_TRIES}): ${reason}`);
  logEvent(batchId, null, "warn", again
    ? `All ads are created, but turning them on didn't work yet: ${reason}. Trying again in 5 minutes (try ${tries} of ${GO_LIVE_MAX_TRIES}). The ads stay paused until then.`
    : `All ads are created, but turning them on didn't work after ${tries} tries: ${reason}. The ads stay paused. Press "Retry" on the batch to try again.`);
  if (b.created_by && (tries === 1 || !again)) {
    const sent = await sendAlert({
      to: b.created_by,
      kind: "golive",
      subject: `Launch ${b.key}: ads created but not turned on yet`,
      lines: [
        `Ads created but not turned on yet: ${reason}`,
        again ? "The launcher tries again every 5 minutes for about an hour. The ads stay paused until then." : `It tried ${tries} times. The ads stay paused. Open the batch and press Retry to try again.`,
      ],
      link: appLink(`/batches/${b.key}`),
    });
    log(`batch ${b.key}: alert ${sent.emailed ? "emailed" : `not emailed (${sent.why})`}`);
  }
}

/** After runBatch: each step on its own. None of them changes the batch status runBatch set. */
export async function afterLaunch(batchId: number, res: { done: number; failed: number }) {
  const batch = getBatch(batchId);
  if (!batch) return;
  if (res.failed && batch.created_by) {
    await safely("The failure email", batch.id, async () => {
      const failedAds = db().prepare("SELECT position, creative_name, error FROM ads WHERE batch_id = ? AND status = 'failed' LIMIT 5").all(batch.id) as { position: number; creative_name: string; error: string }[];
      const sent = await sendAlert({
        to: batch.created_by!,
        kind: "create_failed",
        subject: `Launch ${batch.key}: ${res.failed} ad${res.failed === 1 ? "" : "s"} not created`,
        lines: [`${res.done} ad${res.done === 1 ? "" : "s"} created, ${res.failed} not created.`, ...failedAds.map((a) => `Ad ${a.position} (${a.creative_name}): ${a.error}`), "", "Fix the cause, then press Retry failed (ads already created are never made twice)."],
        link: appLink(`/batches/${batch.key}`),
      });
      log(`batch ${batch.key}: alert ${sent.emailed ? "emailed" : `not emailed (${sent.why})`}`);
    });
  }
  // Meta has every file now: free the server's disk. Kept while some ads still need a retry.
  if (res.failed === 0) {
    await safely("Removing the batch's files from the server", batch.id, () => {
      const freed = removeBatchFiles(batch.id);
      if (freed) log(`batch ${batch.key}: removed ${Math.round(freed / 1024 ** 2)} MB of creatives from the server`);
    });
  }
  await safely("Turning the ads on", batch.id, () => goLive(batch.id));
  await safely("Scheduling the review check", batch.id, () => enqueue("review", batch.id, Date.now() + REVIEW_SCHEDULE_MIN[0] * 60_000));
  await safely("Scheduling a backup", batch.id, () => enqueue("backup", null));
}

export async function runJob(job: Job) {
  if (job.kind === "launch") {
    const batch = getBatch(job.batch_id!);
    if (!batch) {
      log(`launch job ${job.id}: batch ${job.batch_id} no longer exists`);
      return;
    }
    const client = clientFor(batch.ad_account_id, (ms, reason) => {
      // Short pauses happen on almost every call on Meta's slow tier: only log the long ones.
      if (ms >= 60_000) logEvent(batch.id, null, "info", `${reason}: waiting ${Math.ceil(ms / 1000)} seconds.`);
    });
    const tmpDir = path.join(config.dataDir, "tmp");
    fs.mkdirSync(tmpDir, { recursive: true });
    let res: { done: number; failed: number };
    try {
      res = await runBatch(batch.id, { client, files: anyFiles, clock: realClock, accountDbId: batch.ad_account_id, tmpDir, namePrefix: config.namePrefix });
    } finally {
      clearMetaLists();
    }
    log(`batch ${batch.key}: ${res.done} done, ${res.failed} failed`);
    await afterLaunch(batch.id, res);
    return;
  }
  if (job.kind === "golive") {
    // Only the turn-on step of a finished launch: no new run, no events about one, no review check
    // moved earlier, no backup. A launch that was queued again (Retry) turns the ads on at its own end.
    const batch = getBatch(job.batch_id!);
    if (!batch) return;
    if (batch.status === "queued" || batch.status === "running") {
      log(`go-live job ${job.id}: batch ${batch.key} is launching again; its launch turns the ads on at the end`);
      return;
    }
    // Stop was pressed while this try waited: it is dropped (the job ends as done), nothing is tried
    // again until a Retry, and the "tries again every 5 minutes" alert leaves the home page.
    if (goLiveStopped(batch)) {
      log(`go-live job ${job.id}: batch ${batch.key} was stopped; its ads stay paused`);
      await safely("Removing the go-live alert", batch.id, () => clearAlerts(`/batches/${batch.key}`, ["golive"]));
      return;
    }
    await goLive(batch.id);
    return;
  }
  if (job.kind === "plan") {
    const plan = db().prepare("SELECT id, key, ad_account_id, status, created_by FROM plans WHERE id = ?").get(job.batch_id) as { id: number; key: string; ad_account_id: number; status: string; created_by: string | null } | undefined;
    // Only a plan still waiting to run (or cut off while running) runs: never a draft someone is
    // editing, a plan that ended, or a cancelled one (runPlan checks this again atomically).
    if (!plan || (plan.status !== "queued" && plan.status !== "running")) {
      log(`plan job ${job.id}: plan ${plan?.key ?? job.batch_id} is ${plan?.status ?? "gone"}, nothing to run`);
      return;
    }
    const who = plan.created_by;
    // Long waits for Meta are shown on the plan (page and plan_status), so nobody thinks it hangs.
    const onWait = (ms: number, reason: string) => {
      if (ms < 20_000) return;
      setPlanWait(plan.id, Date.now() + ms, reason);
      log(`plan ${plan.key}: waiting ${Math.ceil(ms / 1000)} s for Meta (${reason})`);
    };
    let res: { done: number; failed: number };
    try {
      res = await runPlan(plan.id, { client: clientFor(plan.ad_account_id, onWait), clock: realClock, driveFile: who ? (link) => downloadDriveFile(who, link) : undefined });
    } finally {
      try {
        setPlanWait(plan.id, null);
      } catch {
        /* the wait notice expires by itself */
      }
      clearMetaLists();
    }
    log(`plan ${plan.key}: ${res.done} step(s) done, ${res.failed} failed`);
    const ended = db().prepare("SELECT status FROM plans WHERE id = ?").pluck().get(plan.id) as string | undefined;
    // Done, or cancelled while it ran: its "not turned on" and "stopped" alerts leave the home page.
    // (A plan cancelled before it ran is tidied where it is cancelled.)
    if (ended === "done" || ended === "cancelled") {
      await safely(`Plan ${plan.key}: removing its alerts`, null, () => clearAlerts(`/plans/${plan.key}`, ["golive", "stopped"]));
    }
    // A cancel is the person's own choice: no "stopped" email for it.
    if (res.failed && who && ended !== "cancelled") {
      await safely(`Plan ${plan.key}: the failure email`, null, async () => {
        const row = db().prepare("SELECT title, progress FROM plans WHERE id = ?").get(plan.id) as { title: string; progress: string };
        const steps = (JSON.parse(row.progress) as { status: string; message: string }[]).map((p, i) => ({ ...p, n: i + 1 })).filter((p) => p.status !== "done");
        const sent = await sendAlert({
          to: who,
          kind: "stopped",
          subject: `Plan ${plan.key} stopped: ${res.failed} step${res.failed === 1 ? "" : "s"} not done`,
          lines: [`"${row.title}": ${res.done} step${res.done === 1 ? "" : "s"} done, ${res.failed} not done.`, ...steps.slice(0, 5).map((p) => `Step ${p.n}: ${p.message || p.status}`), "", "Open the plan to fix the step and press Retry, or Undo to put things back."],
          link: appLink(`/plans/${plan.key}`),
        });
        log(`plan ${plan.key}: alert ${sent.emailed ? "emailed" : `not emailed (${sent.why})`}`);
      });
    }
    if (res.done || res.failed) await safely(`Plan ${plan.key}: scheduling a backup`, null, () => enqueue("backup", null));
    return;
  }
  if (job.kind === "review") {
    const batch = getBatch(job.batch_id!);
    if (!batch) return;
    // Earlier review checks for this batch (failed ones too, so the schedule always ends), plus this one.
    const n = (db().prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'review' AND batch_id = ? AND status IN ('done', 'failed')").get(batch.id) as { n: number }).n + 1;
    const next = () => {
      if (n < REVIEW_SCHEDULE_MIN.length) enqueue("review", batch.id, Date.now() + REVIEW_SCHEDULE_MIN[n] * 60_000);
    };
    let pending: number;
    try {
      ({ pending } = await checkReview(clientFor(batch.ad_account_id), batch.id));
    } catch (e) {
      // Meta busy, a network drop, an expired connection: keep the schedule, try at the next time.
      next();
      throw e;
    }
    markReviewChecked(batch.id);
    if (pending > 0) next();
    return;
  }
  if (job.kind === "backup") {
    const r = await backupNow("after a launch or plan, or nightly");
    log(r.message);
    await checkBackupAge();
  }
}

/** Tell the person who started a launch or plan that it stopped (nobody may be watching). */
export async function alertStopped(s: Stopped, msg: string) {
  if (!s.who) return;
  const sent = await sendAlert({
    to: s.who,
    kind: "stopped",
    subject: `${s.kind === "launch" ? "Launch" : "Plan"} ${s.key} stopped`,
    lines: [`It stopped with: ${msg}`, "Nothing already made was removed. Open it to see what was made and press Retry."],
    link: appLink(s.kind === "launch" ? `/batches/${s.key}` : `/plans/${s.key}`),
  });
  log(`${s.key}: alert ${sent.emailed ? "emailed" : `not emailed (${sent.why})`}`);
}

/** A job threw: record it on the job and on its batch or plan, and tell the person. Never throws. */
export async function onJobFailed(job: Job, e: unknown) {
  const msg = errText(e);
  log(`job ${job.id} (${job.kind}) failed: ${msg}`);
  await safely(`Job ${job.id}: saving the failure`, null, () => finishJob(job.id, "failed", msg));
  let stopped: Stopped | null = null;
  try {
    stopped = markStopped(job, msg);
  } catch (e2) {
    log(`Job ${job.id}: marking its ${job.kind} failed: ${errText(e2)}`);
  }
  if (job.kind === "launch" || job.kind === "plan") clearMetaLists();
  const s = stopped;
  if (s) await safely(`Job ${job.id}: the failure email`, null, () => alertStopped(s, msg));
}

/** Run one claimed job to the end and record the result. Never throws (the lane must keep going). */
export async function runClaimed(job: Job) {
  try {
    await runJob(job);
    finishJob(job.id, "done");
  } catch (e) {
    await onJobFailed(job, e);
  }
}

/** Email the admin when no backup reached Object Storage for 48 hours (at most once a day). */
export async function checkBackupAge(now = Date.now()) {
  await safely("The backup check", null, async () => {
    const due = backupAlertDue(now);
    if (!due) return;
    markBackupAlerted(now);
    const sent = await sendAlert({ ...due, link: appLink("/settings") });
    log(`backup alert ${sent.emailed ? "emailed" : `not emailed (${sent.why})`}`);
  });
}

/** India time (the server runs in UTC). */
const istDay = (now: number) => new Date(now + 330 * 60_000).toISOString().slice(0, 10);
const istHour = (now: number) => new Date(now + 330 * 60_000).getUTCHours();

/**
 * Nightly cleanup and backup at about 02:00 IST. Called every minute; runs once per India-time day,
 * on the first call after 02:00 (so a busy worker or a restart at 02:00 doesn't skip the day).
 * Returns true when it ran. Never throws.
 */
export async function nightly(now = Date.now()): Promise<boolean> {
  try {
    if (istHour(now) < 2) return false;
    const day = istDay(now);
    if (getSetting(NIGHTLY_DAY_KEY) === day) return false;
    putSetting(NIGHTLY_DAY_KEY, day);
  } catch (e) {
    log(`nightly: couldn't read or save the last run day: ${errText(e)}`);
    return false;
  }
  await safely("Nightly backup", null, () => enqueue("backup", null));
  await safely("Nightly cleanup", null, () => {
    log(`nightly cleanup: ${JSON.stringify(sweepFiles())}`);
  });
  await checkBackupAge(now);
  return true;
}

/** The heartbeat the health check reads. A busy database must not stop the worker. */
export function safeHeartbeat() {
  try {
    workerHeartbeat();
  } catch (e) {
    log(`heartbeat not saved: ${errText(e)}`);
  }
}
