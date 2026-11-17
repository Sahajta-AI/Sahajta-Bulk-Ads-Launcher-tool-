import fs from "node:fs";
import path from "node:path";
import { config } from "./config";
import { db } from "./db";
import { getBatch } from "./store";

// Creatives are copied to the server (Drive downloads, browser uploads) and are only needed
// until Meta has them. A 95-ad batch of video pairs can be tens of GB, so remove them once
// a batch has gone through, and clear abandoned drafts. The database keeps every record.

const GB = 1024 ** 3;

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

/** Delete one batch's files from the server. Safe to call more than once. Returns bytes freed. */
export function removeBatchFiles(batchId: number): number {
  const batch = getBatch(batchId);
  if (!batch) return 0;
  let freed = 0;
  const rows = db().prepare("SELECT id, source_kind, source_ref, local_path FROM assets WHERE batch_id = ? AND local_path IS NOT NULL").all(batchId) as { id: number; source_kind: string; source_ref: string; local_path: string }[];
  for (const r of rows) {
    // Only files the launcher itself stored: never a folder someone pointed the CLI at.
    const inside = [config.filesDir, config.uploadsDir].some((d) => path.resolve(r.local_path).startsWith(path.resolve(d) + path.sep));
    if (!inside) continue;
    // Batches launched together into several ad sets share uploaded files: keep a file while another needs it.
    const shared = db().prepare("SELECT 1 FROM assets a JOIN batches b ON b.id = a.batch_id WHERE a.local_path = ? AND a.batch_id != ? AND b.status NOT IN ('done')").get(r.local_path, batchId);
    if (shared) continue;
    for (const f of [r.local_path, `${r.local_path}.json`, `${r.local_path}.part`]) {
      try {
        freed += fs.statSync(f).size;
        fs.rmSync(f, { force: true });
      } catch {
        /* already gone */
      }
    }
  }
  fs.rmSync(path.join(config.filesDir, batch.key), { recursive: true, force: true });
  return freed;
}

/** Nightly: files of finished batches, and of drafts nobody touched for 14 days. */
export function sweepFiles(): { batches: number; freedGb: number } {
  const ids = db()
    .prepare(
      `SELECT id FROM batches WHERE status = 'done'
         OR (status = 'draft' AND COALESCE(previewed_at, created_at) < datetime('now', '-14 days'))`,
    )
    .all() as { id: number }[];
  let freed = 0;
  for (const { id } of ids) freed += removeBatchFiles(id);
  return { batches: ids.length, freedGb: Math.round((freed / GB) * 10) / 10 };
}

export { GB };
