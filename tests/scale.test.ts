import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildPreview } from "@/lib/engine/preview";
import { resetFailed, runBatch } from "@/lib/engine/launcher";
import { MetaClient } from "@/lib/meta/client";
import { Pacer } from "@/lib/meta/pacer";
import { getAds, getBatch, updateBatch } from "@/lib/store";
import { freshDb, mockDeps, setupBatch } from "./helpers";

// A real-size batch: 95 ads from 150 files, on Meta's slowest tier (60 points),
// with a crash in the middle and random network trouble. This is the shape of
// a marketer's first real launch.

const DIR = path.join(os.tmpdir(), "sahajta-launcher-fixtures-v2", "ninety-five");

async function img(file: string, w: number, h: number, seed: number) {
  if (fs.existsSync(file)) return;
  const c = `#${((seed * 2654435761) >>> 8).toString(16).padStart(6, "0").slice(0, 6)}`;
  await sharp({ create: { width: w, height: h, channels: 3, background: c } }).jpeg({ quality: 60 }).toFile(file);
}
function vid(file: string, w: number, h: number, hue: number) {
  if (fs.existsSync(file)) return;
  execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", `testsrc=size=${w}x${h}:rate=12,hue=h=${hue}`, "-t", "1", "-pix_fmt", "yuv420p", file]);
}

/** 30 video pairs + 20 image pairs + 25 single images + 20 single videos = 95 ads, 145 files.
 *  Names mix spaces, capitals, Hindi, sub-folders and a duplicate base name in two folders. */
async function ninetyFive(): Promise<string> {
  fs.mkdirSync(path.join(DIR, "reels"), { recursive: true });
  fs.mkdirSync(path.join(DIR, "statics", "week 2"), { recursive: true });
  for (let i = 1; i <= 30; i++) {
    const n = String(i).padStart(2, "0");
    vid(path.join(DIR, "reels", `Hook ${n}_9x16.mp4`), 180, 320, i * 11);
    vid(path.join(DIR, "reels", `Hook ${n}_4x5.mp4`), 200, 250, i * 11 + 5);
  }
  for (let i = 1; i <= 20; i++) {
    await img(path.join(DIR, "statics", `offer-${i}_story.jpg`), 1080, 1920, i);
    await img(path.join(DIR, "statics", `offer-${i}_feed.jpg`), 1080, 1350, i + 100);
  }
  for (let i = 1; i <= 24; i++) await img(path.join(DIR, "statics", "week 2", `प्लॉट ${i}.jpg`), 1080, 1350, i + 200);
  await img(path.join(DIR, "statics", "week 2", "offer-1_story.jpg"), 1080, 1080, 999); // same base name as a pair in another folder
  for (let i = 1; i <= 20; i++) vid(path.join(DIR, "reels", `testimonial-${i}.mp4`), 216, 384, i * 13 + 3);
  fs.writeFileSync(path.join(DIR, ".DS_Store"), "junk");
  fs.writeFileSync(path.join(DIR, "notes.txt"), "not a creative");
  return DIR;
}

let folder: string;
beforeAll(async () => {
  folder = await ninetyFive();
}, 240_000);
beforeEach(() => {
  freshDb();
});

const keyOf = (n?: string) => /\[L:([^\]]+)\]/.exec(n ?? "")?.[1];

describe("95-ad batch on the slowest Meta tier", () => {
  it("groups into 95 ads, blocks 95 in one ad set, launches them all paused, once each, never refused by Meta", async () => {
    const { accountId, batchId } = await setupBatch(folder);
    const { mock, deps, clock, pacer } = mockDeps(accountId, { capPoints: 60 });
    // 95 ads can't go into one existing ad set (Meta's limit is 50): the preview must say so.
    const intoOne = buildPreview(batchId, { adset: { id: "as1", name: "November test ad set", is_dynamic_creative: false, ad_count: 0 } }, pacer.capPoints);
    expect(intoOne.batchChecks.filter((c) => c.level === "error").map((c) => c.code)).toEqual(["adset_full"]);
    updateBatch(batchId, { adset_mode: "new_per_ad" });
    const preview = buildPreview(batchId, { adset: { id: "as1", name: "November test ad set", is_dynamic_creative: false } }, pacer.capPoints, { persist: true });
    expect(preview.errors).toBe(0);
    expect(preview.ads).toHaveLength(95);
    const names = preview.ads.map((a) => a.name);
    expect(new Set(names).size).toBe(95); // every ad has its own name, even the duplicate base name
    expect(names.every((n) => n.length < 250)).toBe(true);

    const start = clock.now();
    const result = await runBatch(batchId, deps);
    expect(result).toEqual({ done: 95, failed: 0 });
    const ads = mock.of("ad");
    expect(ads).toHaveLength(95);
    expect(ads.every((a) => a.status === "PAUSED")).toBe(true);
    expect(new Set(ads.map((a) => keyOf(a.name))).size).toBe(95);
    expect(mock.of("creative")).toHaveLength(95);
    expect(mock.calls.filter((c) => c.path.startsWith("rupload/")).length).toBe(80); // 60 + 20 videos, each once
    expect(mock.calls.filter((c) => c.path.endsWith("adimages")).length).toBe(65); // 40 + 25 images, each once
    expect(mock.throttled).toBe(0);
    expect(getBatch(batchId)!.status).toBe("done");
    const hours = (clock.now() - start) / 3_600_000;
    console.log(`95 ads: ${mock.calls.length} calls, ${hours.toFixed(2)} simulated hours; estimate said "${preview.estimate.label}"`);
    expect(hours * 3600).toBeLessThan(preview.estimate.seconds * 1.6);
    // Tmp files from downloads are cleaned up as the batch goes.
    expect(fs.readdirSync(deps.tmpDir).length).toBe(0);
  }, 240_000);

  it("survives a crash at ad 40 and flaky network: resume ends with exactly 95 ads", async () => {
    const { accountId, batchId } = await setupBatch(folder);
    const { mock, deps, clock } = mockDeps(accountId, { capPoints: 60 });
    // Random network drops and Meta 500s throughout.
    let n = 0;
    for (let i = 0; i < 25; i++) mock.inject({ match: (m) => m === "POST" && ++n % 17 === 0, kind: "network" });
    mock.inject({ match: (m, p) => m === "POST" && p.endsWith("/ads"), kind: "timeout_after_create" });
    let created = 0;
    const killing = { ...deps, afterCreate: (kind: string) => {
      if (kind === "ad" && ++created === 40) throw Object.assign(new Error("server restarted"), { fatal: true });
    } };
    await expect(runBatch(batchId, killing)).rejects.toThrow("server restarted");

    const pacer2 = new Pacer(clock);
    const client2 = new MetaClient({ token: "t", accountId: mock.accountId, version: "v26.0", fetch: mock.fetch, pacer: pacer2, clock });
    let result = await runBatch(batchId, { ...deps, client: client2 });
    if (result.failed) {
      // Anything that ran out of retries goes again with "Retry the failed ads only".
      resetFailed(batchId);
      result = await runBatch(batchId, { ...deps, client: client2 });
    }
    expect(result).toEqual({ done: 95, failed: 0 });
    expect(mock.of("ad")).toHaveLength(95);
    expect(new Set(mock.of("ad").map((a) => keyOf(a.name))).size).toBe(95);
    expect(mock.of("creative")).toHaveLength(95);
    expect(getAds(batchId).every((a) => a.status === "done" && a.meta_ad_id)).toBe(true);
  }, 240_000);

  it("one new ad set per ad: 95 paused copies, each named once", async () => {
    const { accountId, batchId } = await setupBatch(folder, { mode: "new_per_ad" });
    const { mock, deps } = mockDeps(accountId, { capPoints: 60 });
    const result = await runBatch(batchId, deps);
    expect(result).toEqual({ done: 95, failed: 0 });
    const sets = mock.of("adset").filter((s) => s.id !== "as1" && s.id !== "as2");
    expect(sets).toHaveLength(95);
    expect(sets.every((s) => s.status === "PAUSED")).toBe(true);
    expect(new Set(sets.map((s) => keyOf(s.name))).size).toBe(95);
  }, 240_000);
});
