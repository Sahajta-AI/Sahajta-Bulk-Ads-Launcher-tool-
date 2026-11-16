import path from "node:path";
import type { Kind, Ratio } from "./media";

// Auto-grouping: files that are versions of the same creative become one ad.
// hook-01_9x16.mp4 + hook-01_4x5.mp4 -> one ad "hook-01".

export interface GroupInput {
  id: number;
  filename: string;
  relPath: string; // path inside the picked folder, e.g. "reels/hook-01_9x16.mp4"
  kind: Kind;
  ratio: Ratio | null;
}

export interface Group {
  name: string;
  assetIds: number[];
}

// Ratio and placement words people put in file names. Bare numbers like "45" or "11"
// are left alone on purpose: they are too often part of the creative's own name.
const RATIO_TOKEN =
  /(^|[\s._-])(9x16|9_16|9:16|9by16|4x5|4_5|4:5|4by5|1x1|1_1|1:1|1by1|16x9|16_9|16:9|16by9|vertical|vert|story|stories|reel|reels|feed|square|portrait|landscape|horizontal)(?=$|[\s._-])/gi;

export function baseName(filename: string): string {
  const stem = path.basename(filename, path.extname(filename));
  return stem
    .replace(RATIO_TOKEN, "$1")
    .replace(/[\s._-]{2,}/g, (m) => m[0])
    .replace(/^[\s._-]+|[\s._-]+$/g, "");
}

function naturalCompare(a: string, b: string) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

export function groupFiles(files: GroupInput[]): Group[] {
  const groups = new Map<string, { name: string; ids: number[]; sortKey: string; kind: Kind }>();
  for (const f of files) {
    if (f.kind === "unsupported") continue;
    const dir = path.dirname(f.relPath || f.filename);
    let name = baseName(f.filename);
    if (!name) name = dir && dir !== "." ? path.basename(dir) : path.basename(f.filename, path.extname(f.filename));
    // Images and videos never share an ad, even with the same base name.
    const key = `${dir}\u0000${name.toLowerCase()}\u0000${f.kind}`;
    const g = groups.get(key) ?? { name, ids: [], sortKey: `${dir}/${name}`, kind: f.kind };
    g.ids.push(f.id);
    groups.set(key, g);
  }

  // If an image and a video share a base name, tell them apart in the ad name.
  const count = new Map<string, number>();
  for (const g of groups.values()) count.set(g.sortKey.toLowerCase(), (count.get(g.sortKey.toLowerCase()) ?? 0) + 1);

  return [...groups.values()]
    .sort((a, b) => naturalCompare(a.sortKey, b.sortKey))
    .map((g) => ({
      name: (count.get(g.sortKey.toLowerCase()) ?? 0) > 1 ? `${g.name}-${g.kind}` : g.name,
      assetIds: g.ids,
    }));
}

/** Which placement slot each ratio fills: 9:16 serves Stories and Reels, everything else serves Feed. */
export type Slot = "vertical" | "feed";

export function slotOf(ratio: Ratio | null): Slot | null {
  if (ratio === "9x16") return "vertical";
  if (ratio === "4x5" || ratio === "1x1" || ratio === "16x9") return "feed";
  return null;
}

/** Short label for the {format} naming token, e.g. "VID-9x16+4x5". */
export function formatLabel(assets: { kind: Kind; ratio: Ratio | null }[]): string {
  if (assets.length === 0) return "";
  const prefix = assets[0].kind === "video" ? "VID" : "IMG";
  const order: (Ratio | null)[] = ["9x16", "4x5", "1x1", "16x9", "other", null];
  const ratios = [...new Set(assets.map((a) => a.ratio))].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return `${prefix}-${ratios.map((r) => r ?? "unknown").join("+")}`;
}
