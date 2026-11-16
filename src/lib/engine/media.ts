import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";

const run = promisify(execFile);

export type Kind = "image" | "video" | "unsupported";
export type Ratio = "9x16" | "4x5" | "1x1" | "16x9" | "other";

export const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png"]);
export const VIDEO_EXT = new Set([".mp4", ".mov", ".m4v"]);

export function kindFromName(filename: string, mime = ""): Kind {
  const ext = path.extname(filename).toLowerCase();
  if (IMAGE_EXT.has(ext) || mime === "image/jpeg" || mime === "image/png") return "image";
  if (VIDEO_EXT.has(ext) || mime === "video/mp4" || mime === "video/quicktime") return "video";
  return "unsupported";
}

const RATIOS: [Ratio, number][] = [
  ["9x16", 9 / 16],
  ["4x5", 4 / 5],
  ["1x1", 1],
  ["16x9", 16 / 9],
];

/** Classify by real pixel dimensions. 3% tolerance covers 1080x1920 vs 1080x1919 and similar exports. */
export function ratioOf(width?: number | null, height?: number | null): Ratio | null {
  if (!width || !height) return null;
  const r = width / height;
  for (const [label, target] of RATIOS) {
    if (Math.abs(r - target) / target <= 0.03) return label;
  }
  return "other";
}

export function ratioText(width?: number | null, height?: number | null): string {
  if (!width || !height) return "unknown size";
  return `${width}×${height}`;
}

export interface Probe {
  kind: Kind;
  width?: number;
  height?: number;
  durationSec?: number;
  sizeBytes: number;
  codec?: string;
}

export async function probeFile(file: string, filename = path.basename(file)): Promise<Probe> {
  const sizeBytes = fs.statSync(file).size;
  const kind = kindFromName(filename);
  if (kind === "image") {
    const meta = await sharp(file).metadata();
    let { width, height } = meta;
    // EXIF orientations 5-8 mean the picture is shown rotated by 90 degrees.
    if (meta.orientation && meta.orientation >= 5) [width, height] = [height, width];
    return { kind, width, height, sizeBytes };
  }
  if (kind === "video") {
    const { stdout } = await run("ffprobe", [
      "-v", "error", "-print_format", "json", "-show_streams", "-show_format", file,
    ]);
    const info = JSON.parse(stdout) as {
      streams: { codec_type: string; codec_name?: string; width?: number; height?: number; tags?: Record<string, string>; side_data_list?: { rotation?: number }[] }[];
      format: { duration?: string };
    };
    const v = info.streams.find((s) => s.codec_type === "video");
    let width = v?.width;
    let height = v?.height;
    const rotation = Number(v?.side_data_list?.find((s) => s.rotation !== undefined)?.rotation ?? v?.tags?.rotate ?? 0);
    if (Math.abs(rotation) % 180 === 90) [width, height] = [height, width];
    return { kind, width, height, durationSec: info.format.duration ? Number(info.format.duration) : undefined, sizeBytes, codec: v?.codec_name };
  }
  return { kind, sizeBytes };
}

export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    fs.createReadStream(file)
      .on("data", (c) => h.update(c))
      .on("end", () => resolve(h.digest("hex")))
      .on("error", reject);
  });
}

/** Grab one frame (at 1 second, or the first frame for very short clips) as a JPEG thumbnail. */
export async function extractFrame(video: string, out: string, atSec = 1): Promise<string> {
  await run("ffmpeg", ["-y", "-v", "error", "-ss", String(atSec), "-i", video, "-frames:v", "1", "-q:v", "2", out]).catch(() =>
    run("ffmpeg", ["-y", "-v", "error", "-i", video, "-frames:v", "1", "-q:v", "2", out]),
  );
  return out;
}

export function humanSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
