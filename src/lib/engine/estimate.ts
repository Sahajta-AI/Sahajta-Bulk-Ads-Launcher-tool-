import { READ_COST, TARGET, WINDOW_MS, WRITE_COST } from "../meta/pacer";

// Honest time estimate. Counts the Meta calls each ad needs (skipping files already
// uploaded), turns points into time at the account's current cap, and adds upload time.

export interface PlanAsset {
  kind: "image" | "video";
  sizeBytes: number;
  alreadyUploaded: boolean;
}

export interface PlanAd {
  assets: PlanAsset[];
  newAdset: boolean;
  done?: boolean;
}

/** Upload speed from the server to Meta. Conservative for an Oracle free machine. */
const UPLOAD_BYTES_PER_SEC = 8 * 1024 * 1024;
/** Typical wait for Meta to process a video; overlaps with other ads' work. */
const VIDEO_PROCESSING_SEC = 120;

export function pointsForAd(ad: PlanAd): number {
  if (ad.done) return 0;
  let points = 0;
  for (const a of ad.assets) {
    if (a.alreadyUploaded) continue;
    if (a.kind === "image") points += WRITE_COST;
    // Resumable upload: start + finish (the bytes go to rupload.facebook.com), ~3 status checks, 1 thumbnail read.
    // The older chunked upload, used only if Meta refuses that, adds one write per ~50 MB.
    else points += WRITE_COST * 2 + READ_COST * 4;
  }
  if (ad.newAdset) points += WRITE_COST * 2; // copy + rename
  points += WRITE_COST + READ_COST; // creative + read-back
  points += WRITE_COST; // ad
  return points;
}

export interface Estimate {
  seconds: number;
  points: number;
  label: string;
  rateLimited: boolean;
}

export function estimate(ads: PlanAd[], capPoints: number): Estimate {
  const points = ads.reduce((s, a) => s + pointsForAd(a), 0) + READ_COST * 3; // + reconcile lookups
  const budget = capPoints * TARGET;
  const perSec = budget / (WINDOW_MS / 1000);
  // The first `budget` points go out at once; the rest at the steady rate.
  const pacingSec = Math.max(0, points - budget) / perSec;
  const bytes = ads.flatMap((a) => (a.done ? [] : a.assets)).filter((a) => !a.alreadyUploaded).reduce((s, a) => s + a.sizeBytes, 0);
  const uploadSec = bytes / UPLOAD_BYTES_PER_SEC;
  const hasVideo = ads.some((a) => !a.done && a.assets.some((x) => x.kind === "video" && !x.alreadyUploaded));
  const callSec = ads.length * 3; // round-trip time for a handful of calls per ad
  const seconds = Math.round(Math.max(pacingSec, uploadSec + callSec) + (hasVideo ? VIDEO_PROCESSING_SEC : 0));
  return { seconds, points, label: humanDuration(seconds), rateLimited: pacingSec > uploadSec + callSec };
}

export function humanDuration(seconds: number): string {
  if (seconds < 90) return "about 1 minute";
  const min = Math.round(seconds / 60);
  if (min < 60) return `about ${min} minutes`;
  const h = Math.floor(min / 60);
  const m = Math.round((min % 60) / 5) * 5;
  return `about ${h} hour${h > 1 ? "s" : ""}${m ? ` ${m} minutes` : ""}`;
}
