import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { config } from "./config";
import { db } from "./db";

// Database backup to Oracle Object Storage through a pre-authenticated request (PAR) URL.
// A PAR is a write-only link to one bucket: no keys, no SDK, one HTTP PUT.

export async function backupNow(reason: string): Promise<{ file: string; uploaded: boolean; message: string }> {
  const dir = path.join(config.dataDir, "backups");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `launcher-${stamp}.db`);
  await db().backup(file);
  const gz = gzipSync(fs.readFileSync(file));
  fs.writeFileSync(`${file}.gz`, gz);
  fs.rmSync(file);

  // Keep the last 20 local copies.
  const local = fs.readdirSync(dir).filter((f) => f.endsWith(".db.gz")).sort();
  for (const old of local.slice(0, Math.max(0, local.length - 20))) fs.rmSync(path.join(dir, old));

  const par = config.backupParUrl;
  if (!par) return { file: `${file}.gz`, uploaded: false, message: `Saved locally only (${reason}); BACKUP_PAR_URL is not set.` };
  const url = `${par.replace(/\/?$/, "/")}launcher-${stamp}.db.gz`;
  const res = await fetch(url, { method: "PUT", body: gz, headers: { "Content-Type": "application/gzip" } });
  if (!res.ok) return { file: `${file}.gz`, uploaded: false, message: `Upload to Object Storage failed with HTTP ${res.status}.` };
  return { file: `${file}.gz`, uploaded: true, message: `Backed up (${reason}).` };
}
