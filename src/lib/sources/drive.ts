import { drive as driveApi, type drive_v3 } from "@googleapis/drive";
import { OAuth2Client } from "google-auth-library";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { config } from "../config";
import { decrypt } from "../crypto";
import { db } from "../db";
import type { FileSource } from "../engine/launcher";
import { kindFromName, probeFile, ratioOf, sha256File } from "../engine/media";
import { getBatch, updateAsset } from "../store";
import type { AssetRow } from "../types";

// Google Drive: read-only. Files are downloaded to the server's disk, then uploaded to Meta.
// Nothing in Drive is ever shared or made public.

export class DriveAccessError extends Error {}

/** Google's errors in plain words. Network trouble and Google outages are rethrown as they are, so they count as "try again". */
export function plainDriveError(e: unknown, what: string): unknown {
  if (e instanceof DriveAccessError) return e;
  const err = e as { code?: number | string; status?: number; response?: { status?: number; data?: { error?: string } }; message?: string };
  const status = Number(err.response?.status ?? (typeof err.code === "number" ? err.code : 0) ?? err.status ?? 0);
  const msg = `${err.message ?? ""} ${err.response?.data?.error ?? ""}`;
  if (/invalid_grant|invalid_token|Token has been expired or revoked/i.test(msg) || status === 401) {
    return new DriveAccessError("Your Google sign-in has expired. Sign out of the launcher (top right), sign in again with Google, then try again.");
  }
  if (status === 403) return new DriveAccessError(`Your Google account isn't allowed to open ${what}. Ask the owner to share it with you, then try again.`);
  if (status === 404) return new DriveAccessError(`Couldn't find ${what} in Google Drive. Check the link, and that your Google account can see it.`);
  return e;
}

export function authFor(email: string): OAuth2Client {
  const row = db().prepare("SELECT google_refresh_enc FROM users WHERE email = ?").get(email.toLowerCase()) as { google_refresh_enc: string | null } | undefined;
  if (!row?.google_refresh_enc) {
    throw new DriveAccessError(`${email} hasn't connected Google Drive yet. Sign in to the app once with Google, then try again.`);
  }
  const client = new OAuth2Client(config.googleClientId, config.googleClientSecret);
  client.setCredentials({ refresh_token: decrypt(row.google_refresh_enc) });
  return client;
}

/** Accepts a folder link, a "open?id=" link, or a bare ID. */
export function parseFolderId(input: string): string | null {
  const s = input.trim();
  const m = /\/folders\/([A-Za-z0-9_-]{10,})/.exec(s) ?? /[?&]id=([A-Za-z0-9_-]{10,})/.exec(s);
  if (m) return m[1];
  if (/^[A-Za-z0-9_-]{10,}$/.test(s)) return s;
  return null;
}

type DriveFile = drive_v3.Schema$File;

const FIELDS = "id, name, mimeType, size, md5Checksum, imageMediaMetadata(width, height, rotation), videoMediaMetadata(width, height, durationMillis), shortcutDetails(targetId, targetMimeType)";
const FILE_FIELDS = FIELDS.replace(", shortcutDetails(targetId, targetMimeType)", "");

async function listRecursive(d: drive_v3.Drive, folderId: string, prefix = "", depth = 0): Promise<{ file: DriveFile; rel: string }[]> {
  const out: { file: DriveFile; rel: string }[] = [];
  let pageToken: string | undefined;
  do {
    const res = await d.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: `nextPageToken, files(${FIELDS})`,
      pageSize: 200,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    for (const f of res.data.files ?? []) {
      // A Drive shortcut: follow it to the real file or folder.
      if (f.mimeType === "application/vnd.google-apps.shortcut" && f.shortcutDetails?.targetId) {
        if (f.shortcutDetails.targetMimeType === "application/vnd.google-apps.folder") {
          if (depth < 5) out.push(...(await listRecursive(d, f.shortcutDetails.targetId, `${prefix}${f.name}/`, depth + 1)));
        } else {
          try {
            const t = await d.files.get({ fileId: f.shortcutDetails.targetId, fields: FILE_FIELDS, supportsAllDrives: true });
            out.push({ file: { ...t.data, name: f.name ?? t.data.name }, rel: `${prefix}${f.name}` });
          } catch {
            out.push({ file: { ...f, mimeType: "application/vnd.google-apps.shortcut" }, rel: `${prefix}${f.name}` }); // shown as skipped
          }
        }
        continue;
      }
      if (f.mimeType === "application/vnd.google-apps.folder") {
        if (depth < 5) out.push(...(await listRecursive(d, f.id!, `${prefix}${f.name}/`, depth + 1)));
      } else {
        out.push({ file: f, rel: `${prefix}${f.name}` });
      }
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return out;
}

export async function folderName(email: string, folderId: string): Promise<string> {
  const d = driveApi({ version: "v3", auth: authFor(email) });
  const res = await d.files.get({ fileId: folderId, fields: "name, mimeType", supportsAllDrives: true }).catch((e) => {
    throw plainDriveError(e, "that Drive folder");
  });
  if (res.data.mimeType !== "application/vnd.google-apps.folder") throw new DriveAccessError("That link is a file, not a folder. Paste the link of the folder.");
  return res.data.name ?? folderId;
}

/** List a Drive folder into a batch. Sizes and ratios come from Drive's own metadata where it has them. */
export async function importDriveFolder(batchId: number, email: string, folderId: string): Promise<number> {
  const d = driveApi({ version: "v3", auth: authFor(email) });
  let files: { file: DriveFile; rel: string }[];
  try {
    files = await listRecursive(d, folderId);
  } catch (e) {
    throw plainDriveError(e, "that Drive folder");
  }
  const insert = db().prepare(
    `INSERT INTO assets (batch_id, source_kind, source_ref, rel_path, filename, kind, mime, size_bytes, width, height, duration_sec, ratio)
     VALUES (?, 'drive', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const missing: number[] = [];
  for (const { file: f, rel } of files) {
    // Google Docs, Sheets and shortcuts we couldn't follow can't be uploaded, whatever their name says.
    const kind = f.mimeType?.startsWith("application/vnd.google-apps.") ? "unsupported" : kindFromName(f.name ?? "", f.mimeType ?? "");
    let width = f.imageMediaMetadata?.width ?? f.videoMediaMetadata?.width ?? null;
    let height = f.imageMediaMetadata?.height ?? f.videoMediaMetadata?.height ?? null;
    // Drive reports image rotation in quarter turns.
    if (f.imageMediaMetadata?.rotation && f.imageMediaMetadata.rotation % 2 === 1) [width, height] = [height, width];
    const duration = f.videoMediaMetadata?.durationMillis ? Number(f.videoMediaMetadata.durationMillis) / 1000 : null;
    const id = Number(
      insert.run(batchId, f.id, rel, f.name, kind, f.mimeType ?? "", Number(f.size ?? 0), width, height, duration, ratioOf(width, height)).lastInsertRowid,
    );
    if (kind !== "unsupported" && (!width || !height)) missing.push(id);
  }
  // Drive has no size for some files (videos still processing in Drive): download and measure those now.
  for (const id of missing) {
    const asset = db().prepare("SELECT * FROM assets WHERE id = ?").get(id) as AssetRow;
    await driveFiles.ensureLocal(asset).catch(() => undefined);
  }
  return files.length;
}

async function download(email: string, fileId: string, dest: string) {
  const d = driveApi({ version: "v3", auth: authFor(email) });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  try {
    const res = await d.files.get({ fileId, alt: "media", supportsAllDrives: true }, { responseType: "stream" });
    await pipeline(res.data as NodeJS.ReadableStream, fs.createWriteStream(tmp));
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw plainDriveError(e, `the file ${path.basename(dest).replace(/^[^_]+_/, "")}`);
  }
  fs.renameSync(tmp, dest);
}

/** Downloads Drive files on first use (with the batch creator's Google access), then measures them. */
export const driveFiles: FileSource = {
  async ensureLocal(asset: AssetRow) {
    if (asset.local_path && asset.sha256 && fs.existsSync(asset.local_path)) return { ...asset, local_path: asset.local_path, sha256: asset.sha256 };
    const batch = getBatch(asset.batch_id)!;
    if (!batch.created_by) throw new DriveAccessError("This batch has no owner, so its Drive files can't be downloaded.");
    const dest = path.join(config.filesDir, batch.key, `${asset.source_ref}_${asset.filename.replace(/[^\w.\- ]/g, "_")}`);
    if (!fs.existsSync(dest)) await download(batch.created_by, asset.source_ref, dest);
    const probe = await probeFile(dest, asset.filename);
    const sha = await sha256File(dest);
    const patch = { local_path: dest, sha256: sha, width: probe.width ?? null, height: probe.height ?? null, duration_sec: probe.durationSec ?? null, ratio: ratioOf(probe.width, probe.height), size_bytes: probe.sizeBytes };
    updateAsset(asset.id, patch);
    return { ...asset, ...patch, local_path: dest, sha256: sha };
  },
};

/** One FileSource for any asset: Drive files are fetched, local and uploaded files are used as they are. */
export const anyFiles: FileSource = {
  async ensureLocal(asset) {
    if (asset.source_kind === "drive") return driveFiles.ensureLocal(asset);
    const { localFiles } = await import("./local");
    return localFiles.ensureLocal(asset);
  },
};
