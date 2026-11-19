import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { BACKUP_STATUS_KEY, getSetting, putSetting } from "./appsettings";
import { config } from "./config";
import { db } from "./db";
import { istLabel } from "./time";

// Database backup to Oracle Object Storage through a pre-authenticated request (PAR) URL.
// A PAR is a write-only link to one bucket: no keys, no SDK, one HTTP PUT.
// The result of every backup is saved (app_settings "backup_status") and shown in /api/health
// and Settings → Safety; after 48 hours without a copy outside the server the admin gets an alert.

/** The last backup, as saved in app_settings under BACKUP_STATUS_KEY. Never contains the PAR link. */
export interface BackupStatus {
  /** Time of the last backup try (ISO). */
  at: string;
  /** A compressed copy was saved on the server. */
  saved: boolean;
  /** ...and copied to Object Storage. */
  uploaded: boolean;
  message: string;
  /** Last time a copy reached Object Storage (ISO), or null if never. */
  lastUploadedAt: string | null;
  /** First backup try ever recorded (ISO): the start of "no off-site copy" when none was ever uploaded. */
  firstAt: string;
  /** When the admin was last alerted about missing off-site copies (ISO), or null. */
  alertedAt: string | null;
}

export const OFFSITE_ALERT_HOURS = 48;

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The PAR link is a secret (anyone with it can write to the bucket): never put it in a message. */
function hidePar(s: string, par: string): string {
  let out = par ? s.split(par).join("[backup link]") : s;
  out = out.replace(/\/p\/[^/\s]+/g, "/p/[hidden]");
  return out;
}

export function backupStatus(): BackupStatus | null {
  try {
    const v = getSetting(BACKUP_STATUS_KEY);
    return v ? (JSON.parse(v) as BackupStatus) : null;
  } catch {
    return null;
  }
}

function record(r: { saved: boolean; uploaded: boolean; message: string }, now = new Date()) {
  const prev = backupStatus();
  const at = now.toISOString();
  const next: BackupStatus = {
    at,
    saved: r.saved,
    uploaded: r.uploaded,
    message: r.message,
    lastUploadedAt: r.uploaded ? at : (prev?.lastUploadedAt ?? null),
    firstAt: prev?.firstAt ?? at,
    alertedAt: r.uploaded ? null : (prev?.alertedAt ?? null),
  };
  try {
    putSetting(BACKUP_STATUS_KEY, JSON.stringify(next));
  } catch {
    /* the backup itself still happened; the status shows the older result */
  }
}

/** PUT a file without reading it into memory. Resolves with the HTTP status. */
function putFile(url: string, file: string, timeoutMs = 15 * 60_000): Promise<number> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const size = fs.statSync(file).size;
    const req = (u.protocol === "http:" ? http : https).request(
      u,
      { method: "PUT", headers: { "Content-Type": "application/gzip", "Content-Length": size }, timeout: timeoutMs },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error(`no answer after ${Math.round(timeoutMs / 60_000)} minutes`)));
    req.on("error", reject);
    const src = fs.createReadStream(file);
    src.on("error", (e) => req.destroy(e));
    src.pipe(req);
  });
}

export async function backupNow(reason: string): Promise<{ file: string; uploaded: boolean; message: string }> {
  const dir = path.join(config.dataDir, "backups");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const name = `launcher-${stamp}.db.gz`;
  const raw = path.join(dir, `launcher-${stamp}.db`);
  const gz = path.join(dir, name);
  try {
    fs.mkdirSync(dir, { recursive: true });
    await db().backup(raw);
    // Streamed: neither the database nor the compressed copy is held in memory as a whole.
    await pipeline(fs.createReadStream(raw), createGzip(), fs.createWriteStream(gz));
  } catch (e) {
    fs.rmSync(gz, { force: true });
    const message = `Backup failed on the server: ${errText(e)}`;
    record({ saved: false, uploaded: false, message });
    throw new Error(message);
  } finally {
    fs.rmSync(raw, { force: true });
  }

  // Keep the last 20 local copies.
  try {
    const local = fs.readdirSync(dir).filter((f) => f.endsWith(".db.gz")).sort();
    for (const old of local.slice(0, Math.max(0, local.length - 20))) fs.rmSync(path.join(dir, old), { force: true });
  } catch {
    /* an old copy left behind is harmless */
  }

  const par = config.backupParUrl;
  if (!par) {
    const message = `Saved on the server only (${reason}). BACKUP_PAR_URL is not set, so there is no copy outside the server.`;
    record({ saved: true, uploaded: false, message });
    return { file: gz, uploaded: false, message };
  }
  let uploaded = false;
  let message: string;
  try {
    const status = await putFile(`${par.replace(/\/?$/, "/")}${name}`, gz);
    uploaded = status >= 200 && status < 300;
    message = uploaded
      ? `Backed up (${reason}).`
      : `Saved on the server, but the upload to Object Storage failed with HTTP ${status}${[401, 403, 404].includes(status) ? " (the BACKUP_PAR_URL link may have expired: make a new one, docs/SETUP.md step O6)" : ""}.`;
  } catch (e) {
    message = `Saved on the server, but the upload to Object Storage failed: ${hidePar(errText(e), par)}.`;
  }
  record({ saved: true, uploaded, message });
  return { file: gz, uploaded, message };
}

/** Backup state for /api/health and Settings → Safety (no secrets). */
export interface BackupHealth {
  lastBackupAt: string | null;
  offsite: boolean;
  lastOffsiteAt: string | null;
  message: string;
  /** Set when no copy reached Object Storage for OFFSITE_ALERT_HOURS. */
  warning: string | null;
}

export function backupHealth(now = Date.now()): BackupHealth {
  const s = backupStatus();
  if (!s) return { lastBackupAt: null, offsite: false, lastOffsiteAt: null, message: "No backup has run yet (the worker backs up after each launch or plan and every night).", warning: null };
  const since = Date.parse(s.lastUploadedAt ?? s.firstAt);
  const hours = Math.floor((now - since) / 3600_000);
  const warning = hours >= OFFSITE_ALERT_HOURS
    ? s.lastUploadedAt
      ? `No backup copy outside the server for ${hours} hours (last one ${istLabel(s.lastUploadedAt)}). Last try: ${s.message}`
      : `No backup has reached Object Storage yet (${hours} hours since the first backup). Last try: ${s.message}`
    : null;
  return { lastBackupAt: s.at, offsite: s.uploaded, lastOffsiteAt: s.lastUploadedAt, message: s.message, warning };
}

/** Who hears about missing backups: ADMIN_EMAIL, or else the first address in ALLOWED_EMAILS. */
export function backupAdmin(): string {
  return (process.env.ADMIN_EMAIL ?? "").trim().toLowerCase() || config.allowedEmails[0] || "";
}

/**
 * The alert to send when no copy reached Object Storage for 48 hours (at most once a day), or null.
 * On a laptop (not production, no BACKUP_PAR_URL) there is nothing to alert about.
 */
export function backupAlertDue(now = Date.now()): { to: string; subject: string; lines: string[] } | null {
  if (!config.backupParUrl && process.env.NODE_ENV !== "production") return null;
  const s = backupStatus();
  const h = backupHealth(now);
  if (!s || !h.warning) return null;
  if (s.alertedAt && now - Date.parse(s.alertedAt) < 24 * 3600_000) return null;
  return {
    to: backupAdmin(),
    subject: "Launcher backups: no copy outside the server for 2 days",
    lines: [
      h.warning,
      "",
      config.backupParUrl
        ? "Check the BACKUP_PAR_URL link (it may have expired) and the bucket, then run: sudo docker compose exec worker npx tsx scripts/backup.ts"
        : "Set BACKUP_PAR_URL in .env (docs/SETUP.md step O6), then restart: sudo docker compose up -d",
    ],
  };
}

export function markBackupAlerted(now = Date.now()) {
  const s = backupStatus();
  if (!s) return;
  putSetting(BACKUP_STATUS_KEY, JSON.stringify({ ...s, alertedAt: new Date(now).toISOString() }));
}
