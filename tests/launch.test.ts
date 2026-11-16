import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildPreview } from "@/lib/engine/preview";
import { checkReview, resetFailed, runBatch } from "@/lib/engine/launcher";
import { LANES, claimNext, enqueue, finishJob } from "@/lib/jobs";
import { getAdAssets, getAds, getBatch, updateBatch } from "@/lib/store";
import { MetaClient } from "@/lib/meta/client";
import { Pacer } from "@/lib/meta/pacer";
import { fifteenFileFolder, freshDb, mockDeps, setupBatch } from "./helpers";

let folder: string;
beforeAll(async () => {
  folder = await fifteenFileFolder();
});
beforeEach(() => {
  freshDb();
});

function keysOf(names: (string | undefined)[]) {
  return names.map((n) => /\[L:([^\]]+)\]/.exec(n ?? "")?.[1]);
}

describe("15-file Drive-style folder, existing ad set", () => {
  it("groups, names, and launches every ad paused with all enhancements off", async () => {
    const { accountId, batchId } = await setupBatch(folder);
    const { mock, deps, clock, pacer } = mockDeps(accountId);

    const preview = buildPreview(batchId, { adset: { id: "as1", name: "November test ad set", is_dynamic_creative: false } }, pacer.capPoints, { persist: true });
    expect(preview.errors).toBe(0);
    // 5 video pairs + 3 single images + 1 image pair = 9 ads from 15 files.
    expect(preview.ads).toHaveLength(9);
    const byName = new Map(preview.ads.map((a) => [a.creativeName, a]));
    expect(byName.get("hook-01")!.files.map((f) => f.ratio).sort()).toEqual(["4x5", "9x16"]);
    expect(byName.get("testimonial")!.files.map((f) => f.placement).sort()).toEqual(["Feed and everything else", "Stories and Reels"]);
    expect(byName.get("hook-01")!.name).toMatch(/^2026-\d\d-\d\d_hook-01_site-visit_VID-9x16\+4x5$/);
    expect(preview.estimate.label).toMatch(/minutes/);

    const start = clock.now();
    const result = await runBatch(batchId, deps);
    expect(result).toEqual({ done: 9, failed: 0 });

    const ads = mock.of("ad");
    expect(ads).toHaveLength(9);
    expect(ads.every((a) => a.status === "PAUSED")).toBe(true);
    expect(new Set(keysOf(ads.map((a) => a.name))).size).toBe(9);

    for (const c of mock.of("creative")) {
      const body = c.body as Record<string, unknown> & { degrees_of_freedom_spec: { creative_features_spec: Record<string, { enroll_status: string }> }; contextual_multi_ads: { enroll_status: string } };
      expect(Object.values(body.degrees_of_freedom_spec.creative_features_spec).every((f) => f.enroll_status === "OPT_OUT")).toBe(true);
      expect(body.contextual_multi_ads.enroll_status).toBe("OPT_OUT");
      expect(JSON.stringify(body)).not.toContain("standard_enhancements");
    }

    // Each distinct file uploaded once: 10 videos (start, bytes, finish) + 5 images.
    expect(mock.calls.filter((c) => c.path.endsWith("video_ads")).length).toBe(10 * 2);
    expect(mock.calls.filter((c) => c.path.startsWith("rupload/")).length).toBe(10);
    expect(mock.calls.filter((c) => c.path.endsWith("adimages")).length).toBe(5);

    // Paced, never refused: the Limited tier's cap was never hit.
    expect(mock.throttled).toBe(0);
    const minutes = (clock.now() - start) / 60000;
    console.log(`15 files -> 9 ads, ${mock.calls.length} calls, ${minutes.toFixed(1)} simulated minutes; estimate said "${preview.estimate.label}"`);
    expect(minutes).toBeLessThan((preview.estimate.seconds / 60) * 1.6);
    expect(minutes).toBeGreaterThan((preview.estimate.seconds / 60) * 0.5);

    const review = await checkReview(deps.client, batchId);
    expect(review.pending).toBe(9);
    expect(getBatch(batchId)!.status).toBe("done");
  });
});

describe("no duplicates", () => {
  it("a batch killed halfway, then resumed, ends with zero duplicates", async () => {
    const { accountId, batchId } = await setupBatch(folder);
    const { mock, deps, clock } = mockDeps(accountId);

    // Kill the "process" right after Meta creates the 5th ad, before we save its ID.
    let created = 0;
    const killing = { ...deps, afterCreate: (kind: string) => {
      if (kind === "ad" && ++created === 5) throw Object.assign(new Error("worker killed"), { fatal: true });
    } };
    await expect(runBatch(batchId, killing)).rejects.toThrow("worker killed");
    expect(mock.of("ad")).toHaveLength(5);
    expect(getAds(batchId).filter((a) => a.meta_ad_id).length).toBe(4); // the 5th ID was lost

    // Restart: a new worker (fresh pacer) picks the batch up again.
    const pacer2 = new Pacer(clock);
    const client2 = new MetaClient({ token: "t", accountId: mock.accountId, version: "v26.0", fetch: mock.fetch, pacer: pacer2, clock });
    const result = await runBatch(batchId, { ...deps, client: client2 });
    expect(result).toEqual({ done: 9, failed: 0 });
    const keys = keysOf(mock.of("ad").map((a) => a.name));
    expect(mock.of("ad")).toHaveLength(9);
    expect(new Set(keys).size).toBe(9);
    expect(mock.of("creative")).toHaveLength(9);
  });

  it("a create that times out after Meta saved it is adopted, not repeated", async () => {
    const { accountId, batchId } = await setupBatch(folder);
    const { mock, deps } = mockDeps(accountId);
    let n = 0;
    mock.inject({ match: (m, p) => m === "POST" && p.endsWith("/adcreatives") && ++n === 3, kind: "timeout_after_create" });
    mock.inject({ match: (m, p) => m === "POST" && p.endsWith("/ads"), kind: "timeout_after_create" });
    const result = await runBatch(batchId, deps);
    expect(result).toEqual({ done: 9, failed: 0 });
    expect(mock.of("creative")).toHaveLength(9);
    expect(mock.of("ad")).toHaveLength(9);
  });

  it("retry failed only: failed ads are redone, done ads are left alone", async () => {
    const { accountId, batchId } = await setupBatch(folder);
    const { mock, deps } = mockDeps(accountId);
    mock.inject({
      match: (m, p) => m === "POST" && p.endsWith("/ads"),
      kind: "error",
      error: { message: "Invalid parameter", code: 100, error_user_title: "Link not allowed", error_user_msg: "The landing page breaks Meta's policy." },
    });
    const first = await runBatch(batchId, deps);
    expect(first).toEqual({ done: 8, failed: 1 });
    expect(getBatch(batchId)!.status).toBe("partial");
    const failed = getAds(batchId).find((a) => a.status === "failed")!;
    expect(failed.error).toBe("Creating the ad (paused) failed: Link not allowed. The landing page breaks Meta's policy.");

    expect(resetFailed(batchId)).toBe(1);
    const second = await runBatch(batchId, deps);
    expect(second).toEqual({ done: 9, failed: 0 });
    expect(mock.of("ad")).toHaveLength(9);
    expect(mock.of("creative")).toHaveLength(9); // the failed ad's creative was reused
    expect(getBatch(batchId)!.status).toBe("done");
  });
});

describe("new ad set per ad", () => {
  it("refuses a template ad set with dynamic creative", async () => {
    const { batchId } = await setupBatch(folder, { mode: "new_per_ad", adsetId: "as2" });
    const p = buildPreview(batchId, { adset: { id: "as2", name: "Dynamic creative ad set", is_dynamic_creative: true } }, 60);
    expect(p.batchChecks.find((c) => c.code === "dynamic_creative")?.message).toContain("Dynamic creative switched on");
  });

  it("copies the template once per ad, paused, named with the key", async () => {
    const { accountId, batchId } = await setupBatch(folder, { mode: "new_per_ad" });
    const { mock, deps } = mockDeps(accountId);
    buildPreview(batchId, { adset: { id: "as1", name: "t", is_dynamic_creative: false } }, 60, { persist: true });
    // Crash right after the 2nd copy: the copy already carries the key in its name.
    let copies = 0;
    await expect(
      runBatch(batchId, { ...deps, afterCreate: (k) => { if (k === "adset" && ++copies === 2) throw Object.assign(new Error("killed"), { fatal: true }); } }),
    ).rejects.toThrow("killed");
    await runBatch(batchId, deps);
    const sets = mock.of("adset").filter((s) => s.id !== "as1" && s.id !== "as2");
    expect(sets).toHaveLength(9);
    expect(sets.every((s) => s.status === "PAUSED" && /^2026-\d\d-\d\d_.+ \[L:[a-z0-9]+-\d\d\]$/.test(String(s.name)))).toBe(true);
    const ads = getAds(batchId);
    expect(new Set(ads.map((a) => a.meta_adset_id)).size).toBe(9);
  });
});

describe("rate limits", () => {
  it("only make a batch slower, never fail it, even after a surprise block", async () => {
    const { accountId, batchId } = await setupBatch(folder);
    const { mock, deps } = mockDeps(accountId, { capPoints: 30 }); // a cap lower than we assume
    const result = await runBatch(batchId, deps);
    expect(result.failed).toBe(0);
    expect(mock.of("ad")).toHaveLength(9);
    expect(mock.throttled).toBeLessThan(5);
  });

  it("speeds up by itself on the 9,000-point tier", async () => {
    const { accountId, batchId } = await setupBatch(folder);
    const { deps, clock, pacer } = mockDeps(accountId, { capPoints: 9000 });
    const start = clock.now();
    await runBatch(batchId, deps);
    expect(pacer.capPoints).toBeGreaterThan(1000);
    expect((clock.now() - start) / 60000).toBeLessThan(10);
  });
});

describe("Meta features that may not be on for our app", () => {
  it("falls back to the chunked video upload when the 3-call flow is refused", async () => {
    const { accountId, batchId } = await setupBatch(folder);
    const { mock, deps } = mockDeps(accountId, { noResumableVideo: true });
    const r = await runBatch(batchId, deps);
    expect(r.failed).toBe(0);
    expect(mock.calls.filter((c) => c.path.endsWith("advideos")).length).toBe(10 * 3);
  });
  it("finds creatives without Meta's name filter, and Meta's idempotency key catches repeats", async () => {
    const { accountId, batchId } = await setupBatch(folder);
    const { mock, deps } = mockDeps(accountId, { noCreativeFilter: true });
    mock.inject({ match: (m, p) => m === "POST" && p.endsWith("/adcreatives"), kind: "timeout_after_create" });
    const r = await runBatch(batchId, deps);
    expect(r.failed).toBe(0);
    expect(mock.of("creative")).toHaveLength(9);
  });
  it("resumes a video upload from the byte Meta already has", async () => {
    const { accountId, batchId } = await setupBatch(folder);
    const { mock, deps } = mockDeps(accountId);
    let n = 0;
    mock.inject({ match: (m, p) => m === "POST" && p.endsWith("/video_ads") && ++n === 2, kind: "network" });
    const r = await runBatch(batchId, deps);
    expect(r.failed).toBe(0);
    // The interrupted video was not started twice.
    expect(mock.calls.filter((c) => c.path.endsWith("video_ads")).length).toBe(10 * 2 + 1);
    expect(mock.of("video")).toHaveLength(10);
  });
});

describe("video thumbnails", () => {
  it("falls back to an ffmpeg frame when Meta has no thumbnail", async () => {
    const { accountId, batchId } = await setupBatch(folder);
    const { mock, deps } = mockDeps(accountId, { noThumbnails: true });
    await runBatch(batchId, deps);
    // 5 images + 10 video frames.
    expect(mock.calls.filter((c) => c.path.endsWith("adimages")).length).toBe(15);
    const ad = getAds(batchId)[0];
    expect(getAdAssets(ad.id).length).toBeGreaterThan(0);
    updateBatch(batchId, {});
  });
});

describe("worker lanes", () => {
  it("review checks and backups are taken while a launch is running", () => {
    const first = enqueue("launch", 1, 0);
    enqueue("launch", 2, 0);
    enqueue("review", 3, 0);
    enqueue("backup", null, 0);
    expect(claimNext(LANES.launch)?.id).toBe(first);
    // Launch 1 is still running: the other lane does not wait for it.
    expect(claimNext(LANES.other)?.kind).toBe("review");
    expect(claimNext(LANES.other)?.kind).toBe("backup");
    expect(claimNext(LANES.other)).toBeUndefined();
    finishJob(first, "done");
    expect(claimNext(LANES.launch)?.batch_id).toBe(2);
  });

  it("a review check finishes during a slow launch, and the shared pacer is never refused", async () => {
    const done = await setupBatch(folder);
    const { mock, deps } = mockDeps(done.accountId);
    await runBatch(done.batchId, deps);
    const next = await setupBatch(folder);
    // Same ad account, so the same client and pacer, as in the worker's two lanes.
    let launchFinished = false;
    const launch = runBatch(next.batchId, deps).then((r) => {
      launchFinished = true;
      return r;
    });
    await checkReview(deps.client, done.batchId);
    expect(launchFinished).toBe(false);
    expect(getAds(done.batchId).map((a) => a.effective_status)).toEqual(Array(9).fill("PENDING_REVIEW"));
    const result = await launch;
    expect(result.failed).toBe(0);
    expect(mock.of("ad")).toHaveLength(18);
    expect(mock.throttled).toBe(0);
  });
});
