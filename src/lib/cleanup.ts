import fs from "node:fs";
import path from "node:path";
import { config } from "./config";
import { db } from "./db";
import { getBatch, logEvent } from "./store";
import { timeMs } from "./time";

// Creatives are copied to the server (Drive downloads, browser uploads) and are only needed
// until Meta has them. A 95-ad batch of video pairs can be tens of GB, so remove them once
// a batch has gone through, and clear abandoned drafts. The database keeps every record.
//
// Safe rules (18 Nov review):
//  R1  done batches: their files go (removeBatchFiles), unless another batch still needs a file.
//  R2  uploads/ files no asset row points to (by tus id or path), when the file and its .json are both
//      more than 48 hours old (a tus upload in progress has no row yet).
//  R2b deleting a draft or one of its files removes the uploaded file at once, after the database
//      delete, and only when no row points to it any more.
//  R3  files/<key>/ of a batch that no longer exists; Drive downloads of a failed or partly done
//      batch 7 days after it finished (a Retry downloads them again).
//  R4  uploads of a failed or partly done batch 30 days after it finished, when every batch using
//      the file is done or also finished 30+ days ago (an event says so).
//  R5  tmp/ files more than 48 hours old.
//  R6  drafts nobody touched for 14 days (newest of: created, checked, last file added).
// A file any draft, queued or running batch points to is never deleted.

const GB = 1024 ** 3;
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const LIVE = ["draft", "queued", "running"];

/** Free bytes on the disk that holds the data folder (null if the system can't tell). */
export function freeBytes(): number | null {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    const s = fs.statfsSync(config.dataDir);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

const inside = (p: string, dir: string) => path.resolve(p).startsWith(path.resolve(dir) + path.sep);

/** Delete a stored file and the tus/download side files next to it. Returns bytes freed. */
function rmFile(f: string): number {
  let freed = 0;
  for (const x of [f, `${f}.json`, `${f}.part`]) {
    try {
      freed += fs.statSync(x).size;
      fs.rmSync(x, { force: true });
    } catch {
      /* already gone */
    }
  }
  // Every row that pointed to it now knows the file is gone (the preview says so).
  db().prepare("UPDATE assets SET local_path = NULL WHERE local_path = ?").run(f);
  return freed;
}

/** True when a draft, queued or running batch (other than `except`) points to the file. */
function liveUser(f: string, except?: number): boolean {
  return !!db()
    .prepare(`SELECT 1 FROM assets a JOIN batches b ON b.id = a.batch_id WHERE a.local_path = ? AND a.batch_id IS NOT ? AND b.status IN (${LIVE.map(() => "?").join(",")}) LIMIT 1`)
    .get(f, except ?? null, ...LIVE);
}

/** Delete one batch's files from the server. Safe to call more than once. Returns bytes freed. */
export function removeBatchFiles(batchId: number): number {
  const batch = getBatch(batchId);
  if (!batch) return 0;
  let freed = 0;
  const rows = db().prepare("SELECT id, source_kind, source_ref, local_path FROM assets WHERE batch_id = ? AND local_path IS NOT NULL").all(batchId) as { id: number; source_kind: string; source_ref: string; local_path: string }[];
  for (const r of rows) {
    // Only files the launcher itself stored: never a folder someone pointed the CLI at.
    if (![config.filesDir, config.uploadsDir].some((d) => inside(r.local_path, d))) continue;
    // Batches launched together into several ad sets share uploaded files: keep a file while another needs it.
    const shared = db().prepare("SELECT 1 FROM assets a JOIN batches b ON b.id = a.batch_id WHERE a.local_path = ? AND a.batch_id != ? AND b.status NOT IN ('done')").get(r.local_path, batchId);
    if (shared) continue;
    freed += rmFile(r.local_path);
  }
  freed += removeDriveFolder(batch.key, batchId);
  return freed;
}

/** files/<key>/: Drive downloads of one batch (never shared with another batch). */
function removeDriveFolder(key: string, batchId?: number): number {
  const dir = path.join(config.filesDir, key);
  let freed = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const f of walkFiles(dir)) {
    try {
      freed += fs.statSync(f).size;
    } catch {
      /* gone */
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
  if (batchId) db().prepare("UPDATE assets SET local_path = NULL WHERE batch_id = ? AND source_kind = 'drive'").run(batchId);
  return freed;
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkFiles(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

/**
 * R2b: after a draft (or a file of a draft) was deleted from the database, remove its uploaded files
 * that no batch points to any more, and the draft's Drive downloads. Returns bytes freed.
 */
export function removeUnusedUploads(paths: (string | null)[], deletedBatchKey?: string): number {
  let freed = 0;
  for (const f of new Set(paths.filter((p): p is string => !!p))) {
    if (!inside(f, config.uploadsDir)) continue;
    if (db().prepare("SELECT 1 FROM assets WHERE local_path = ? LIMIT 1").get(f)) continue;
    freed += rmFile(f);
  }
  if (deletedBatchKey && !db().prepare("SELECT 1 FROM batches WHERE key = ?").get(deletedBatchKey)) freed += removeDriveFolder(deletedBatchKey);
  return freed;
}

const mtimeMs = (f: string) => {
  try {
    return fs.statSync(f).mtimeMs;
  } catch {
    return NaN;
  }
};

/** Nightly: the rules at the top of this file. */
export function sweepFiles(): { batches: number; freedGb: number; orphans: number; tmp: number } {
  const now = Date.now();
  let freed = 0;
  // R1 + R6: done batches, and drafts with no activity for 14 days.
  const ids = db()
    .prepare(
      `SELECT id FROM batches b WHERE status = 'done'
         OR (status = 'draft' AND MAX(
               julianday(b.created_at),
               COALESCE(julianday(b.previewed_at), julianday(b.created_at)),
               COALESCE((SELECT MAX(julianday(a.created_at)) FROM assets a WHERE a.batch_id = b.id), julianday(b.created_at))
             ) < julianday('now', '-14 days'))`,
    )
    .all() as { id: number }[];
  for (const { id } of ids) freed += removeBatchFiles(id);

  // R3: Drive download folders of batches that no longer exist; Drive files of failed / partly done
  // batches 7 days after they finished.
  try {
    for (const e of fs.readdirSync(config.filesDir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      if (!db().prepare("SELECT 1 FROM batches WHERE key = ?").get(e.name)) freed += removeDriveFolder(e.name);
    }
  } catch {
    /* no files folder yet */
  }
  const ended = db().prepare("SELECT id, key, finished_at FROM batches WHERE status IN ('partial', 'failed') AND finished_at IS NOT NULL").all() as { id: number; key: string; finished_at: string }[];
  for (const b of ended) {
    const age = now - timeMs(b.finished_at);
    if (age >= 7 * DAY) freed += removeDriveFolder(b.key, b.id);
  }

  // R4: uploads of failed / partly done batches that nobody retried for 30 days.
  const expired = (id: number) => {
    const r = db().prepare("SELECT status, finished_at FROM batches WHERE id = ?").get(id) as { status: string; finished_at: string | null } | undefined;
    if (!r) return true;
    if (r.status === "done") return true;
    return (r.status === "partial" || r.status === "failed") && now - timeMs(r.finished_at) >= 30 * DAY;
  };
  for (const b of ended.filter((x) => expired(x.id))) {
    const files = db().prepare("SELECT DISTINCT local_path FROM assets WHERE batch_id = ? AND local_path IS NOT NULL").pluck().all(b.id) as string[];
    let n = 0;
    for (const f of files) {
      if (!inside(f, config.uploadsDir) || liveUser(f)) continue;
      const users = db().prepare("SELECT DISTINCT batch_id FROM assets WHERE local_path = ?").pluck().all(f) as number[];
      if (!users.every(expired)) continue;
      freed += rmFile(f);
      n++;
    }
    if (n) logEvent(b.id, null, "info", `Removed ${n} uploaded file${n === 1 ? "" : "s"} from the server: this launch ended 30+ days ago without a retry. To create the failed ads, add the files to a new batch.`);
  }

  // R2: uploads no asset row points to, both files older than 48 hours.
  let orphans = 0;
  try {
    for (const name of fs.readdirSync(config.uploadsDir)) {
      if (name.endsWith(".json") || name.endsWith(".part") || name.startsWith(".")) continue;
      const f = path.join(config.uploadsDir, name);
      if (!fs.statSync(f).isFile()) continue;
      if (db().prepare("SELECT 1 FROM assets WHERE local_path = ? OR (source_kind = 'upload' AND source_ref = ?) LIMIT 1").get(f, name)) continue;
      const times = [mtimeMs(f), fs.existsSync(`${f}.json`) ? mtimeMs(`${f}.json`) : mtimeMs(f)];
      if (times.some((t) => Number.isNaN(t) || now - t < 48 * HOUR)) continue;
      freed += rmFile(f);
      orphans++;
    }
  } catch {
    /* no uploads folder yet */
  }

  // R5: tmp/ (frames, files swapped into ads by plans) older than 48 hours.
  let tmp = 0;
  for (const f of walkFiles(path.join(config.dataDir, "tmp"))) {
    const t = mtimeMs(f);
    if (Number.isNaN(t) || now - t < 48 * HOUR) continue;
    try {
      freed += fs.statSync(f).size;
      fs.rmSync(f, { force: true });
      tmp++;
    } catch {
      /* gone */
    }
  }
  return { batches: ids.length, freedGb: Math.round((freed / GB) * 10) / 10, orphans, tmp };
}

export { GB };
