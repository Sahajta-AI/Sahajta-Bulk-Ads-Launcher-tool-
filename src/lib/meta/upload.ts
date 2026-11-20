import fs from "node:fs";
import { Readable } from "node:stream";
import { db } from "../db";
import type { MetaClient } from "./client";
import { MetaError } from "./errors";

// Media uploads. Every upload is keyed by the file's SHA-256, per ad account,
// so the same file is never uploaded twice (meta_media table).

export interface MediaRow {
  ad_account_id: number;
  sha256: string;
  kind: "image" | "video";
  image_hash: string | null;
  video_id: string | null;
  status: "uploading" | "uploaded" | "ready" | "error";
  upload_state: string | null;
  thumbnail_url: string | null;
  thumbnail_hash: string | null;
}

export function getMedia(accountId: number, sha: string): MediaRow | undefined {
  return db().prepare("SELECT * FROM meta_media WHERE ad_account_id = ? AND sha256 = ?").get(accountId, sha) as MediaRow | undefined;
}

export function saveMedia(row: Partial<MediaRow> & { ad_account_id: number; sha256: string; kind: "image" | "video"; status: MediaRow["status"] }) {
  const cur = getMedia(row.ad_account_id, row.sha256);
  const merged = { image_hash: null, video_id: null, upload_state: null, thumbnail_url: null, thumbnail_hash: null, ...cur, ...row };
  db().prepare(
    `INSERT INTO meta_media (ad_account_id, sha256, kind, image_hash, video_id, status, upload_state, thumbnail_url, thumbnail_hash, updated_at)
     VALUES (@ad_account_id, @sha256, @kind, @image_hash, @video_id, @status, @upload_state, @thumbnail_url, @thumbnail_hash, datetime('now'))
     ON CONFLICT(ad_account_id, sha256) DO UPDATE SET image_hash = excluded.image_hash, video_id = excluded.video_id, status = excluded.status,
       upload_state = excluded.upload_state, thumbnail_url = excluded.thumbnail_url, thumbnail_hash = excluded.thumbnail_hash, updated_at = excluded.updated_at`,
  ).run(merged);
}

/** POST /act_x/adimages (multipart). Returns the image hash. Meta also dedupes identical bytes. */
export async function uploadImage(client: MetaClient, file: string, filename: string): Promise<string> {
  const form = new FormData();
  form.set("filename", new Blob([fs.readFileSync(file)]), filename);
  const res = await client.post<{ images: Record<string, { hash: string }> }>(`${client.accountId}/adimages`, form);
  const first = Object.values(res.images ?? {})[0];
  if (!first?.hash) throw new MetaError("Meta did not return an image hash", { status: 200 });
  return first.hash;
}

/**
 * Video upload. Default: Meta's resumable ad-video flow, 3 calls whatever the size
 * (start on /act_x/video_ads -> bytes to rupload.facebook.com -> finish).
 * If Meta refuses that flow (its docs say system users may not be supported yet), we fall
 * back to the older chunked /advideos upload for the rest of this client's life (one batch run).
 * META_VIDEO_UPLOAD=chunked forces the old method.
 */
const chunkedClients = new WeakSet<MetaClient>();

export async function uploadVideo(
  client: MetaClient,
  opts: { accountDbId: number; sha: string; file: string; title: string; onProgress?: (pct: number) => void },
): Promise<string> {
  const row = getMedia(opts.accountDbId, opts.sha);
  const state = row?.upload_state ? (JSON.parse(row.upload_state) as { method?: string }) : null;
  const preferred = process.env.META_VIDEO_UPLOAD === "chunked" || chunkedClients.has(client) ? "chunked" : "resumable";
  const method = process.env.META_VIDEO_UPLOAD === "chunked" ? "chunked" : state?.method === "resumable" || state?.method === "chunked" ? state.method : preferred;
  if (method === "chunked") return uploadVideoChunked(client, opts);
  try {
    return await uploadVideoResumable(client, opts);
  } catch (e) {
    // Meta refused the 3-call flow (at start, during the bytes, or at finish; its docs say system
    // users may not be supported). Forget that attempt and use the older chunked upload instead.
    // Not for an expired or invalid login (190, 102): every call fails then, and the launch stops at once.
    if (e instanceof MetaError && !e.isTransient && e.code !== 190 && e.code !== 102) {
      chunkedClients.add(client);
      saveMedia({ ad_account_id: opts.accountDbId, sha256: opts.sha, kind: "video", status: "uploading", video_id: null, upload_state: null });
      return uploadVideoChunked(client, opts);
    }
    throw e;
  }
}

interface ResumableState {
  method: "resumable";
  uploadUrl: string;
  fileSize: number;
}

async function uploadVideoResumable(
  client: MetaClient,
  opts: { accountDbId: number; sha: string; file: string; title: string; onProgress?: (pct: number) => void },
): Promise<string> {
  const fileSize = fs.statSync(opts.file).size;
  const row = getMedia(opts.accountDbId, opts.sha);
  let state = row?.upload_state ? (JSON.parse(row.upload_state) as ResumableState) : null;
  let videoId = row?.video_id ?? null;
  let offset = 0;

  if (videoId && state?.method === "resumable" && state.fileSize === fileSize) {
    // Resume: ask Meta how many bytes it already has.
    const st = await client.get<{ status?: { uploading_phase?: { bytes_transferred?: number } } }>(videoId, { fields: "status" });
    offset = Number(st.status?.uploading_phase?.bytes_transferred ?? 0);
  } else {
    const start = await client.post<{ video_id: string; upload_url?: string }>(`${client.accountId}/video_ads`, { upload_phase: "start" });
    videoId = start.video_id;
    state = { method: "resumable", uploadUrl: start.upload_url ?? `https://rupload.facebook.com/video-ads-upload/${client.version}/${videoId}`, fileSize };
    saveMedia({ ad_account_id: opts.accountDbId, sha256: opts.sha, kind: "video", video_id: videoId, status: "uploading", upload_state: JSON.stringify(state) });
  }

  if (offset < fileSize) {
    opts.onProgress?.(Math.round((offset / fileSize) * 100));
    const body = Readable.toWeb(fs.createReadStream(opts.file, { start: offset })) as unknown as BodyInit;
    await client.uploadBytes(state!.uploadUrl, { offset: String(offset), file_size: String(fileSize) }, body);
  }
  opts.onProgress?.(100);
  await client.post(`${client.accountId}/video_ads`, { upload_phase: "finish", video_id: videoId, title: opts.title });
  saveMedia({ ad_account_id: opts.accountDbId, sha256: opts.sha, kind: "video", video_id: videoId, status: "uploaded", upload_state: null });
  return videoId!;
}

interface ChunkState {
  sessionId: string;
  startOffset: number;
  endOffset: number;
  fileSize: number;
}

/**
 * Chunked video upload (older method): start -> transfer (Meta picks the chunk ranges) -> finish.
 * The video ID is saved right after "start", and progress after every chunk,
 * so a crash resumes the same upload instead of starting a new video.
 */
async function uploadVideoChunked(
  client: MetaClient,
  opts: { accountDbId: number; sha: string; file: string; title: string; onProgress?: (pct: number) => void },
): Promise<string> {
  const fileSize = fs.statSync(opts.file).size;
  let row = getMedia(opts.accountDbId, opts.sha);
  let state: ChunkState | null = row?.upload_state ? (JSON.parse(row.upload_state) as ChunkState) : null;
  let videoId = row?.video_id ?? null;

  if (!videoId || !state || state.fileSize !== fileSize) {
    const start = await client.post<{ video_id: string; upload_session_id: string; start_offset: string; end_offset: string }>(
      `${client.accountId}/advideos`,
      { upload_phase: "start", file_size: fileSize },
    );
    videoId = start.video_id;
    state = { sessionId: start.upload_session_id, startOffset: Number(start.start_offset), endOffset: Number(start.end_offset), fileSize };
    saveMedia({ ad_account_id: opts.accountDbId, sha256: opts.sha, kind: "video", video_id: videoId, status: "uploading", upload_state: JSON.stringify({ ...state, method: "chunked" }) });
  }

  const fd = fs.openSync(opts.file, "r");
  try {
    while (state.startOffset < state.endOffset) {
      const len = state.endOffset - state.startOffset;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, state.startOffset);
      const form = new FormData();
      form.set("upload_phase", "transfer");
      form.set("upload_session_id", state.sessionId);
      form.set("start_offset", String(state.startOffset));
      form.set("video_file_chunk", new Blob([buf]), "chunk");
      let next: { start_offset: string; end_offset: string };
      try {
        next = await client.post(`${client.accountId}/advideos`, form);
      } catch (e) {
        // An expired upload session cannot be resumed: start over with a new video.
        if (e instanceof MetaError && !e.isTransient) {
          saveMedia({ ad_account_id: opts.accountDbId, sha256: opts.sha, kind: "video", status: "error", upload_state: null, video_id: null });
        }
        throw e;
      }
      state = { ...state, startOffset: Number(next.start_offset), endOffset: Number(next.end_offset) };
      saveMedia({ ad_account_id: opts.accountDbId, sha256: opts.sha, kind: "video", video_id: videoId, status: "uploading", upload_state: JSON.stringify({ ...state, method: "chunked" }) });
      opts.onProgress?.(Math.round((state.startOffset / fileSize) * 100));
    }
  } finally {
    fs.closeSync(fd);
  }

  await client.post(`${client.accountId}/advideos`, { upload_phase: "finish", upload_session_id: state.sessionId, title: opts.title });
  saveMedia({ ad_account_id: opts.accountDbId, sha256: opts.sha, kind: "video", video_id: videoId, status: "uploaded", upload_state: null });
  return videoId;
}

export type VideoStatus = "ready" | "processing" | "error";

export async function videoStatus(client: MetaClient, videoId: string): Promise<{ status: VideoStatus; progress?: number }> {
  const v = await client.get<{ status?: { video_status?: string; processing_progress?: number } }>(videoId, { fields: "status" });
  const s = v.status?.video_status;
  if (s === "ready") return { status: "ready" };
  if (s === "error" || s === "expired") return { status: "error" };
  return { status: "processing", progress: v.status?.processing_progress };
}

/** Meta's preferred auto-generated thumbnail, if there is one. */
export async function videoThumbnail(client: MetaClient, videoId: string): Promise<string | null> {
  const res = await client.get<{ data: { uri: string; is_preferred?: boolean }[] }>(`${videoId}/thumbnails`);
  const list = res.data ?? [];
  return (list.find((t) => t.is_preferred) ?? list[0])?.uri ?? null;
}
