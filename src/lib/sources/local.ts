import fs from "node:fs";
import path from "node:path";
import { db } from "../db";
import type { FileSource } from "../engine/launcher";
import { kindFromName, probeFile, ratioOf, sha256File } from "../engine/media";
import { updateAsset } from "../store";
import type { AssetRow } from "../types";

// Files already on this machine: tus uploads from the browser, and folders given to the CLI.

export function walk(dir: string, base = dir): { abs: string; rel: string }[] {
  const out: { abs: string; rel: string }[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(abs, base));
    else if (e.isFile()) out.push({ abs, rel: path.relative(base, abs) });
  }
  return out;
}

/** Register one local file in a batch: read its real size, ratio and checksum. */
export async function addLocalFile(batchId: number, abs: string, rel: string, sourceKind: "local" | "upload" = "local", sourceRef = abs): Promise<number> {
  const filename = path.basename(rel);
  const kind = kindFromName(filename);
  let probe: Awaited<ReturnType<typeof probeFile>> = { kind, sizeBytes: fs.statSync(abs).size };
  if (kind !== "unsupported") {
    try {
      probe = await probeFile(abs, filename);
    } catch {
      /* unreadable file: keep kind, no size; preview will warn */
    }
  }
  const sha = kind === "unsupported" ? null : await sha256File(abs);
  const res = db()
    .prepare(
      `INSERT INTO assets (batch_id, source_kind, source_ref, rel_path, filename, kind, size_bytes, width, height, duration_sec, ratio, local_path, sha256)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(batchId, sourceKind, sourceRef, rel, filename, kind, probe.sizeBytes, probe.width ?? null, probe.height ?? null, probe.durationSec ?? null, ratioOf(probe.width, probe.height), abs, sha);
  return Number(res.lastInsertRowid);
}

export async function addLocalFolder(batchId: number, dir: string) {
  for (const f of walk(dir)) await addLocalFile(batchId, f.abs, f.rel);
}

/** Local and uploaded files are already on disk with a checksum. */
export const localFiles: FileSource = {
  async ensureLocal(asset: AssetRow) {
    if (!asset.local_path || !fs.existsSync(asset.local_path)) {
      throw new Error(`The file ${asset.filename} is no longer on the server. Add it to a new batch again.`);
    }
    let sha = asset.sha256;
    if (!sha) {
      sha = await sha256File(asset.local_path);
      updateAsset(asset.id, { sha256: sha });
    }
    return { ...asset, local_path: asset.local_path, sha256: sha };
  },
};
