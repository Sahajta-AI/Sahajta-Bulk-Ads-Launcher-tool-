import { DEV_CAP, isDevTier, READ_COST, TARGET, WINDOW_MS, WRITE_COST } from "../meta/pacer";

// Honest time estimate for a whole launch (every ad set it puts the ads into). Counts the Meta calls
// the launcher will make (each file uploaded once, each distinct creative made once, one ad per ad set,
// and the reads it does), turns them into time with the ad account's real limits, and adds upload time.
// During a launch, the time left uses how fast the ads are really going in.

export interface PlanAsset {
  kind: "image" | "video";
  sizeBytes: number;
  alreadyUploaded: boolean;
}

/** One ad of one batch, with its own creative (the older, one-batch estimate). */
export interface PlanAd {
  assets: PlanAsset[];
  newAdset: boolean;
  done?: boolean;
}

/** The Meta work a launch still needs, in every ad set, each shared thing counted once. */
export interface LaunchWork {
  /** Ads still to create, in every ad set. */
  ads: number;
  /** Ad sets these ads go into. */
  adsets: number;
  /** Creatives still to make: one per distinct creative of the launch. */
  creatives: number;
  /** Files not in Meta yet, once each. */
  uploads: { kind: "image" | "video"; sizeBytes: number }[];
  /** New ad sets to copy from the template (copy + rename). */
  newAdsets: number;
  /** Reads at the start of the runs still to start (each checks Meta for earlier work first). */
  runReads: number;
  /**
   * Ads, ad sets and campaigns turned on once every ad is in (go-live "now" or "at a time"): one write
   * each, plus the turn-on plan's few reads. 0 or missing: the ads stay paused.
   */
  turnOn?: number;
}

/** What Meta lets this ad account do (the pacer's numbers). */
export interface RateLimits {
  /** Points per 5 minutes (60 on the starter tier, 9,000 on full access). */
  capPoints: number;
  /** Meta's access tier, e.g. "development_access" (the starter tier). */
  tier?: string;
  /** Points already spent in the last 5 minutes (they leave less room at the start). */
  usedPoints?: number;
  /** Meta's hourly use for this ad account (percent), when read in the last hour. */
  hourPct?: number;
}

export interface Estimate {
  seconds: number;
  points: number;
  /** Meta calls left (writes + reads). */
  calls: number;
  /** "about 6 minutes" */
  label: string;
  /** "about 6 minutes for 12 ads in 4 ad sets (…)" */
  text: string;
  /** Meta's limit sets the pace (not the uploads or the calls' own time). */
  rateLimited: boolean;
  /** New ads a minute this estimate works out to (ads ÷ the minutes to create them). */
  adsPerMinute: number;
  /** The same in words: "about 2 new ads a minute". */
  pace: string;
  /** Of `seconds`: the time to turn the ads on at the end (0 when they stay paused). */
  turnOnSeconds: number;
  /** True when the time comes from how fast the ads are really going in (during a launch). */
  observed?: boolean;
}

/** Upload speed from the server to Meta. Conservative for an Oracle free machine. */
const UPLOAD_BYTES_PER_SEC = 8 * 1024 * 1024;
/** Typical wait for Meta to process a video; overlaps with other ads' work. */
const VIDEO_PROCESSING_SEC = 120;
/** Time of one Meta call itself (sent, answered), when the limit is not what slows it. */
const CALL_SEC = 0.75;
/** Meta's starter tier: about 300 calls an hour per ad account; the launcher keeps a quarter for pages and Claude. */
export const STARTER_HOURLY_CALLS = 300;
/** "Recent" for the speed during a launch. */
const RECENT_MS = 10 * 60_000;

const VIDEO_WRITES = 2; // resumable upload: start + finish (the bytes go to rupload.facebook.com)
const VIDEO_READS = 4; // ~3 status checks + 1 thumbnail read
/** The turn-on plan's reads: its check of the ad sets and campaigns, the budget check, and its run's reads. */
export const TURN_ON_READS = 4;

/** Meta calls and points of some work. Upload calls are kept apart: upload time is counted by bytes. */
export function workCalls(w: LaunchWork): { writes: number; reads: number; points: number; calls: number; tripCalls: number } {
  let writes = 0;
  let reads = 0;
  let uploadCalls = 0;
  for (const u of w.uploads) {
    if (u.kind === "image") {
      writes += 1;
      uploadCalls += 1;
    } else {
      writes += VIDEO_WRITES;
      reads += VIDEO_READS;
      uploadCalls += VIDEO_WRITES + VIDEO_READS;
    }
  }
  writes += w.newAdsets * 2; // copy + rename
  writes += w.creatives; // the creative
  reads += w.creatives * 2; // its enhancements read back + the post behind it
  writes += w.ads; // the ad
  reads += w.runReads;
  if (w.turnOn) {
    writes += w.turnOn; // each ad, ad set and campaign turned on
    reads += TURN_ON_READS;
  }
  const calls = writes + reads;
  return { writes, reads, points: writes * WRITE_COST + reads * READ_COST, calls, tripCalls: calls - uploadCalls };
}

const isStarter = (l: RateLimits) => isDevTier(l.tier) || l.capPoints <= DEV_CAP;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function whatWords(w: LaunchWork): string {
  return `${plural(w.ads, "ad")}${w.adsets > 1 ? ` in ${w.adsets} ad sets` : ""}`;
}

function speedWords(adsPerMin: number): string {
  if (adsPerMin >= 1.5) return `about ${Math.round(adsPerMin)} new ads a minute`;
  if (adsPerMin >= 0.75) return "about 1 new ad a minute";
  return `about 1 new ad every ${Math.max(2, Math.round(1 / Math.max(adsPerMin, 0.01)))} minutes`;
}

/** Ads a minute over the time it takes to create them (at least half a minute, so a fast launch isn't "48 a minute"). */
const paceOf = (ads: number, createSec: number) => ads / Math.max(createSec / 60, 0.5);

const partWords = (sec: number) => (sec < 60 ? "under a minute" : humanDuration(sec));

/**
 * The sentence: "about 9 minutes for 12 ads in 4 ad sets: about 5 minutes to create them, then about 4
 * minutes to turn them on (Meta's limit on this ad account sets the pace: about 2 new ads a minute)".
 * The pace is the ads over the minutes to create them, so it always agrees with the time.
 */
function sentence(w: LaunchWork, seconds: number, turnSec: number, why: string | null, left = false): string {
  const parts = w.turnOn ? `: ${partWords(seconds - turnSec)} to create them, then ${partWords(turnSec)} to turn them on` : "";
  return `${humanDuration(seconds)}${left ? " left" : ""} for ${whatWords(w)}${parts}${why ? ` (${why})` : ""}`;
}

/** Seconds the limits allow for some work (see estimateWork). */
function limitSeconds(w: LaunchWork, limits: RateLimits): { seconds: number; rateLimited: boolean; points: number; calls: number } {
  const { points, calls, tripCalls } = workCalls(w);
  const budget = limits.capPoints * TARGET;
  // The pacer keeps the calls of the last 5 minutes under the budget: what the last 5 minutes left free
  // goes out at once, then the next calls wait until the first ones leave the 5 minutes, and so on
  // (on the starter tier: 45 points, then a wait to the next 5 minutes).
  const room = Math.max(0, budget - (limits.usedPoints ?? 0));
  const pacingSec = points > room ? Math.ceil((points - room) / budget) * (WINDOW_MS / 1000) : 0;
  // The starter tier's hourly allowance (Meta counts every call, reads too).
  let hourlySec = 0;
  if (isStarter(limits)) {
    const allowed = STARTER_HOURLY_CALLS * TARGET;
    const left = Math.max(0, allowed - ((limits.hourPct ?? 0) / 100) * STARTER_HOURLY_CALLS);
    hourlySec = Math.max(0, calls - left) / (allowed / 3600);
  }
  const bytes = w.uploads.reduce((s, u) => s + u.sizeBytes, 0);
  const workSec = bytes / UPLOAD_BYTES_PER_SEC + tripCalls * CALL_SEC;
  const limitSec = Math.max(pacingSec, hourlySec);
  const hasVideo = w.uploads.some((u) => u.kind === "video");
  const seconds = w.ads ? Math.round(Math.max(limitSec, workSec) + (hasVideo ? VIDEO_PROCESSING_SEC : 0)) : 0;
  return { seconds, rateLimited: limitSec > workSec, points, calls };
}

/** The whole launch, before it starts (or what is left of it, at the limits only). */
export function estimateWork(w: LaunchWork, limits: RateLimits): Estimate {
  const all = limitSeconds(w, limits);
  // Turning the ads on comes after every ad is in, on the same limit: the time it adds.
  const create = w.turnOn ? limitSeconds({ ...w, turnOn: 0 }, limits) : all;
  const turnOnSeconds = w.ads ? Math.max(0, all.seconds - create.seconds) : 0;
  const perMin = paceOf(w.ads, create.seconds);
  const pace = speedWords(perMin);
  const label = humanDuration(all.seconds);
  const why = all.rateLimited ? `Meta's limit on this ad account sets the pace: ${pace}` : null;
  const text = w.ads ? sentence(w, all.seconds, turnOnSeconds, why) : "nothing left to create";
  return { seconds: all.seconds, points: all.points, calls: all.calls, label, text, rateLimited: all.rateLimited, adsPerMinute: perMin, pace, turnOnSeconds };
}

/** One batch, each ad with its own creative (kept for callers that count ads one by one). */
export function estimate(ads: PlanAd[], capPoints: number | RateLimits): Estimate {
  const limits = typeof capPoints === "number" ? { capPoints } : capPoints;
  const left = ads.filter((a) => !a.done);
  const w: LaunchWork = {
    ads: left.length,
    adsets: 1,
    creatives: left.length,
    uploads: left.flatMap((a) => a.assets.filter((x) => !x.alreadyUploaded).map((x) => ({ kind: x.kind, sizeBytes: x.sizeBytes }))),
    newAdsets: left.filter((a) => a.newAdset).length,
    runReads: left.length ? 2 : 0,
  };
  return estimateWork(w, limits);
}

/** An ad already created in this launch: when, and the Meta points its own steps used. */
export interface DoneAd {
  doneAt: number;
  points: number | null;
}

/**
 * Time left of a running launch. The pace seen over the last 10 minutes (the Meta work the ads needed, so
 * an ad that also uploaded its file and made its creative counts for more than an ad that reused them),
 * applied to the work left; never less than the account's limits allow (the pacer sends in bursts, so a
 * pace measured right after a burst looks faster than it is). Too little seen yet: the limits only.
 */
export function timeLeft(w: LaunchWork, limits: RateLimits, done: DoneAd[], now: number): Estimate {
  const atLimits = estimateWork(w, limits);
  if (!w.ads) return { ...atLimits, text: "nothing left to create" };
  const limitsText = { ...atLimits, observed: false, text: sentence(w, atLimits.seconds, atLimits.turnOnSeconds, atLimits.rateLimited ? `Meta's limit on this ad account sets the pace: ${atLimits.pace}` : null, true) };
  const recent = done.filter((d) => d.doneAt >= now - RECENT_MS && d.doneAt <= now).sort((a, b) => a.doneAt - b.doneAt);
  const span = recent.length ? now - recent[0].doneAt : 0;
  // The work done after the first of them, over the time since it (a pause since the last one counts too).
  const pts = recent.slice(1).reduce((s, d) => s + (d.points ?? 0), 0);
  if (recent.length < 3 || span < 60_000 || pts <= 0 || recent.slice(1).some((d) => d.points === null)) return limitsText;
  const perSec = pts / (span / 1000);
  const hasVideo = w.uploads.some((u) => u.kind === "video");
  const seconds = Math.round(atLimits.points / perSec + (hasVideo ? VIDEO_PROCESSING_SEC : 0));
  if (seconds <= atLimits.seconds) return limitsText;
  const label = humanDuration(seconds);
  // The turn-on writes at the same pace; the ads a minute is over the time to create them.
  const turnOnSeconds = w.turnOn ? Math.round((atLimits.points - workCalls({ ...w, turnOn: 0 }).points) / perSec) : 0;
  const perMin = paceOf(w.ads, seconds - turnOnSeconds);
  const pace = speedWords(perMin);
  return { ...atLimits, seconds, label, observed: true, adsPerMinute: perMin, pace, turnOnSeconds, text: sentence(w, seconds, turnOnSeconds, `at the pace Meta allows right now, ${pace}`, true) };
}

export function humanDuration(seconds: number): string {
  if (seconds < 90) return "about 1 minute";
  const min = Math.round(seconds / 60);
  if (min < 60) return `about ${min} minutes`;
  const h = Math.floor(min / 60);
  const m = Math.round((min % 60) / 5) * 5;
  return `about ${h} hour${h > 1 ? "s" : ""}${m ? ` ${m} minutes` : ""}`;
}
