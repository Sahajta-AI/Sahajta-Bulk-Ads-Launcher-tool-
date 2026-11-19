import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { resetFailed, runBatch, type LaunchDeps } from "@/lib/engine/launcher";
import { estimateWork, timeLeft, type LaunchWork } from "@/lib/engine/estimate";
import { buildPreview, launchTimeLeft, launchWork } from "@/lib/engine/preview";
import { DEFAULT_UTM } from "@/lib/engine/naming";
import { siblings } from "@/lib/manage/golive";
import { MetaClient } from "@/lib/meta/client";
import { FakeClock, MockMeta } from "@/lib/meta/mock";
import { Pacer } from "@/lib/meta/pacer";
import { localFiles } from "@/lib/sources/local";
import { batchView, launchBatch, retryFailed, updateAdOverride, updateSettings } from "@/lib/service";
import { getAds, getBatch, updateAd, updateBatch } from "@/lib/store";
import { registerTools, type LauncherApi } from "@/mcp/tools";
import type { BatchRow } from "@/lib/types";
import { LEAD_COPY, fifteenFileFolder, freshDb, setupBatch } from "./helpers";

// Round 4 (the marketer's 19 Nov retest): the same ads into several ad sets upload each file once, make each
// creative once (one post per ad, shared by every ad set) and the time estimate covers the whole launch.
// Practice Meta only (MockMeta).

process.env.META_MOCK = "1";
const g = globalThis as unknown as { __mockMeta?: MockMeta };
const STARTER = { capPoints: 60, tier: "development_access" };
const FULL = { capPoints: 9000, tier: "standard_access" };

let images: string;
let fifteen: string;
let mock: MockMeta;
let clock: FakeClock;

beforeAll(async () => {
  images = path.join(os.tmpdir(), "r4-three-images");
  fs.mkdirSync(images, { recursive: true });
  for (const [i, c] of ["#c33", "#3c3", "#33c"].entries()) {
    const f = path.join(images, `img-${i + 1}_1x1.jpg`);
    if (!fs.existsSync(f)) await sharp({ create: { width: 1080, height: 1080, channels: 3, background: c } }).jpeg().toFile(f);
  }
  fifteen = await fifteenFileFolder();
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", (url: string | URL | Request, init?: RequestInit) => (String(url).startsWith("https://example.com") ? Promise.resolve(new Response("ok")) : real(url, init)));
}, 120_000);

beforeEach(() => {
  freshDb();
  clock = new FakeClock();
  mock = new MockMeta({ clock, capPoints: 9000, richAccount: true, allowActive: true, videoProcessingMs: 60_000 });
  g.__mockMeta = mock;
});

/** `total` ad sets in campaign c1: the practice account's as1 and as4, then copies of as4. */
function adsets(total: number): string[] {
  const ids = ["as1", "as4"];
  for (let i = 5; ids.length < total; i++) {
    mock.objects.set(`as${i}`, { ...mock.objects.get("as4")!, id: `as${i}`, name: `Ad set ${i}` });
    ids.push(`as${i}`);
  }
  return ids.slice(0, total);
}

/** A draft into `total` ad sets (the main one and the extra ones), with the batch copy given. */
async function draft(folder: string, total: number, copy: Record<string, unknown> = LEAD_COPY) {
  const ids = adsets(total);
  const { accountId, batchId } = await setupBatch(folder);
  db().prepare("UPDATE ad_accounts SET is_default = 1 WHERE id = ?").run(accountId);
  updateBatch(batchId, { copy: JSON.stringify(copy) });
  const key = getBatch(batchId)!.key;
  await updateSettings(key, { extraAdsetIds: ids.slice(1) });
  return { accountId, batchId, key };
}

/** Launch as the page does: the extra ad sets become batches of their own, queued one after another. */
async function launch(key: string): Promise<BatchRow[]> {
  await launchBatch(key, { confirm: true, acceptWarnings: true });
  const id = db().prepare("SELECT id FROM batches WHERE key = ?").pluck().get(key) as number;
  return siblings(getBatch(id)!);
}

/** The worker's launch lane on the starter tier (45 of 60 points per 5 minutes), on simulated time. */
function starterDeps(accountDbId: number, fetchImpl: typeof fetch = mock.fetch): LaunchDeps {
  const pacer = new Pacer(clock, undefined, undefined, 60);
  const client = new MetaClient({ token: "mock-token", accountId: mock.accountId, version: "v26.0", fetch: fetchImpl, pacer, clock });
  return { client, files: localFiles, clock, accountDbId, tmpDir: fs.mkdtempSync(path.join(os.tmpdir(), "r4-share-")) };
}

/** Run the launch's batches in order, as the launch lane does. */
async function runAll(group: BatchRow[], deps: LaunchDeps) {
  const out = [];
  for (const b of group) out.push(await runBatch(b.id, deps));
  return out;
}

const callsSince = (n: number) => {
  const calls = mock.calls.slice(n).filter((c) => !c.path.startsWith("rupload/"));
  return { writes: calls.filter((c) => c.method !== "GET").length, reads: calls.filter((c) => c.method === "GET").length, calls };
};
const posts = (path: string, from = 0) => mock.calls.slice(from).filter((c) => c.method === "POST" && c.path.endsWith(path)).length;
const allAds = (group: BatchRow[]) => group.flatMap((b) => getAds(b.id));
const body = (creativeId: string) => mock.objects.get(creativeId)!.body as Record<string, unknown>;

describe("one creative per distinct creative in a launch: 3 images into 4 ad sets", () => {
  it("3 uploads, 3 creatives, 12 paused ads, one shared post per image; the estimate is the whole launch and is right", async () => {
    const { accountId, batchId, key } = await draft(images, 4);
    // The page's estimate before launch, on the starter tier: the whole launch (4 ad sets), as the launcher does it.
    const est = buildPreview(batchId, {}, STARTER).estimate;
    expect(est.text).toMatch(/^about \d+ minutes for 12 ads in 4 ad sets \(Meta's limit on this ad account sets the pace: about \d+ new ads? a minute\)$/);
    // The ads a minute agrees with the time: 12 ads over the minutes said.
    expect(Number(/pace: about (\d+)/.exec(est.text)![1])).toBe(Math.round(12 / Number(/^about (\d+) minutes/.exec(est.text)![1])));
    const group = await launch(key);
    expect(group).toHaveLength(4);

    const from = mock.calls.length;
    const start = clock.now();
    expect(await runAll(group, starterDeps(accountId))).toEqual(Array(4).fill({ done: 3, failed: 0 }));
    const minutes = (clock.now() - start) / 60_000;

    expect(posts("adimages", from)).toBe(3);
    expect(posts("adcreatives", from)).toBe(3);
    expect(posts("/ads", from)).toBe(12);
    expect(mock.of("creative")).toHaveLength(3);
    expect(mock.of("ad")).toHaveLength(12);
    expect(mock.of("ad").every((a) => a.status === "PAUSED")).toBe(true);
    for (const c of mock.of("creative")) expect(JSON.stringify(c.body)).not.toContain("standard_enhancements");

    // Each image: the 4 ad sets' ads use one creative, so one post (likes and comments stay together).
    const ads = allAds(group);
    for (const pos of [1, 2, 3]) {
      const same = ads.filter((a) => a.position === pos);
      expect(same).toHaveLength(4);
      expect(new Set(same.map((a) => a.meta_creative_id)).size).toBe(1);
      expect(new Set(same.map((a) => a.meta_post_id)).size).toBe(1);
      expect(same[0].meta_post_id).toBeTruthy();
      expect(new Set(same.map((a) => a.meta_adset_id)).size).toBe(4);
    }
    expect(new Set(ads.map((a) => a.meta_post_id)).size).toBe(3);

    // Meta calls of the launch: 3 uploads + 3 creatives + 12 ads; 2 reads per ad set (earlier work) + 2 per creative.
    const { writes, reads } = callsSince(from);
    expect({ writes, reads }).toEqual({ writes: 18, reads: 14 });
    console.log(`3 ads × 4 ad sets: ${writes + reads} Meta calls (${writes} writes, ${reads} reads, ${writes * 3 + reads} points), ${minutes.toFixed(1)} simulated minutes; estimate said "${est.text}"`);
    expect(minutes).toBeLessThan((est.seconds / 60) * 1.6);
    expect(minutes).toBeGreaterThan((est.seconds / 60) * 0.5);
  }, 120_000);

  it("3 images into 15 ad sets: still 3 uploads and 3 creatives, 45 ads", async () => {
    const { accountId, batchId, key } = await draft(images, 15);
    const est = buildPreview(batchId, {}, STARTER).estimate;
    expect(est.text).toMatch(/ for 45 ads in 15 ad sets \(/);
    const group = await launch(key);
    const from = mock.calls.length;
    const start = clock.now();
    await runAll(group, starterDeps(accountId));
    const minutes = (clock.now() - start) / 60_000;
    expect(posts("adimages", from)).toBe(3);
    expect(mock.of("creative")).toHaveLength(3);
    expect(mock.of("ad")).toHaveLength(45);
    const { writes, reads } = callsSince(from);
    expect({ writes, reads }).toEqual({ writes: 51, reads: 36 });
    console.log(`3 ads × 15 ad sets: ${writes + reads} Meta calls (${writes} writes, ${reads} reads, ${writes * 3 + reads} points), ${minutes.toFixed(1)} simulated minutes; estimate said "${est.text}"`);
    expect(minutes).toBeLessThan((est.seconds / 60) * 1.6);
    expect(minutes).toBeGreaterThan((est.seconds / 60) * 0.5);
  }, 120_000);
});

describe("anything different makes its own creative", () => {
  it("an ad set with another lead form, and one ad with its own text, each get their own creative", async () => {
    const { accountId, key } = await draft(images, 4);
    const group = await launch(key);
    // As if the extra ad sets had been set up differently: ad set 2 uses another lead form, ad 1 of ad set 3 its own text.
    updateBatch(group[1].id, { copy: JSON.stringify({ ...LEAD_COPY, leadFormId: "555000222" }) });
    const own = getAds(group[2].id).find((a) => a.position === 1)!;
    updateAd(own.id, { copy_override: JSON.stringify({ primaryTexts: ["Only in ad set 3."] }) });
    await runAll(group, starterDeps(accountId));

    expect(mock.of("creative")).toHaveLength(3 + 3 + 1);
    const ads = allAds(group);
    const ofSet = (i: number) => getAds(group[i].id);
    // Ad sets 1 and 4 share all three; ad set 2 has its own three (with its own form); ad set 3 shares two.
    expect(ofSet(0).map((a) => a.meta_creative_id)).toEqual(ofSet(3).map((a) => a.meta_creative_id));
    for (const a of ofSet(1)) {
      expect(ofSet(0).map((x) => x.meta_creative_id)).not.toContain(a.meta_creative_id);
      expect(JSON.stringify(body(a.meta_creative_id!))).toContain('"lead_gen_form_id":"555000222"');
    }
    const set3 = ofSet(2);
    expect(set3.filter((a) => ofSet(0).some((x) => x.meta_creative_id === a.meta_creative_id)).map((a) => a.position)).toEqual([2, 3]);
    const ownCreative = set3.find((a) => a.position === 1)!.meta_creative_id!;
    expect(JSON.stringify(body(ownCreative))).toContain("Only in ad set 3.");
    expect(new Set(ads.map((a) => a.meta_creative_id)).size).toBe(7);
  }, 120_000);

  it("Instant form ad sets (Meta's lead form rule on): the shared creatives carry the form; an ad set with another form gets its own", async () => {
    mock = new MockMeta({ clock, capPoints: 9000, richAccount: true, allowActive: true, leadFormRule: true });
    g.__mockMeta = mock;
    // Every ad set is an Instant form ad set: an ad whose creative has no lead form is refused.
    mock.objects.get("as4")!.destination_type = "ON_AD";
    const { accountId, key } = await draft(images, 3);
    const group = await launch(key);
    updateBatch(group[2].id, { copy: JSON.stringify({ ...LEAD_COPY, leadFormId: "555000333" }) });
    expect(await runAll(group, starterDeps(accountId))).toEqual(Array(3).fill({ done: 3, failed: 0 }));
    expect(mock.of("creative")).toHaveLength(6);
    const [one, two, three] = group.map((b) => getAds(b.id));
    expect(two.map((a) => a.meta_creative_id)).toEqual(one.map((a) => a.meta_creative_id));
    for (const a of one) expect(JSON.stringify(body(a.meta_creative_id!))).toContain('"lead_gen_form_id":"555000111"');
    for (const a of three) {
      expect(one.map((x) => x.meta_creative_id)).not.toContain(a.meta_creative_id);
      expect(JSON.stringify(body(a.meta_creative_id!))).toContain('"lead_gen_form_id":"555000333"');
    }
    expect(mock.of("ad").every((a) => a.status === "PAUSED")).toBe(true);
  }, 120_000);

  it("link tags: the launcher's own {adset} makes one creative per ad set; Meta's {{adset.name}} is shared", async () => {
    const own = await draft(images, 3, { ...LEAD_COPY, utmTemplate: "utm_source=meta&utm_term={adset}" });
    expect(launchWork(getBatch(own.batchId)!)).toMatchObject({ ads: 9, creatives: 9, uploads: [{}, {}, {}] });
    await runAll(await launch(own.key), starterDeps(own.accountId));
    expect(mock.of("creative")).toHaveLength(9);
    expect(new Set(mock.of("creative").map((c) => c.url_tags)).size).toBe(3);

    freshDb();
    mock = new MockMeta({ clock, capPoints: 9000, richAccount: true, allowActive: true });
    g.__mockMeta = mock;
    const meta = await draft(images, 3, { ...LEAD_COPY, utmTemplate: DEFAULT_UTM });
    expect(launchWork(getBatch(meta.batchId)!)).toMatchObject({ ads: 9, creatives: 3 });
    await runAll(await launch(meta.key), starterDeps(meta.accountId));
    expect(mock.of("creative")).toHaveLength(3);
    expect(mock.of("creative").every((c) => String(c.url_tags).includes("{{adset.name}}"))).toBe(true);
  }, 120_000);

  it("an ad's own copy set before launch goes to every ad set, in one shared creative", async () => {
    const { accountId, batchId, key } = await draft(images, 3);
    const ad2 = getAds(batchId).find((a) => a.position === 2)!;
    updateAdOverride(key, ad2.id, { copy: { primaryTexts: ["Ad two's own words."], headlines: ["Own headline"] } });
    const group = await launch(key);
    await runAll(group, starterDeps(accountId));
    expect(mock.of("creative")).toHaveLength(3);
    const twos = allAds(group).filter((a) => a.position === 2);
    expect(new Set(twos.map((a) => a.meta_creative_id)).size).toBe(1);
    expect(JSON.stringify(body(twos[0].meta_creative_id!))).toContain("Ad two's own words.");
  }, 120_000);
});

describe("no second creative, ever", () => {
  it("a creative whose answer was lost is found and used by the next ad set, never made twice; Retry then uses it", async () => {
    const { accountId, key } = await draft(images, 4);
    const group = await launch(key);
    // Ad set 1, ad 1: Meta makes the creative but the answer is lost, and the look-ups after it fail too,
    // so the ad fails. The next ad sets must find that creative, not make another one.
    let armed = false;
    let fired = false;
    mock.inject({ match: (m, p) => !fired && m === "POST" && p.endsWith("/adcreatives") && (fired = armed = true), kind: "timeout_after_create" });
    for (let i = 0; i < 50; i++) mock.inject({ match: (m, p) => armed && m === "GET" && p.endsWith("/adcreatives"), kind: "network" });
    const deps = starterDeps(accountId);
    const results = [await runBatch(group[0].id, deps)];
    armed = false; // Meta answers again
    results.push(...(await runAll(group.slice(1), deps)));
    expect(results[0]).toEqual({ done: 2, failed: 1 });
    expect(results.slice(1)).toEqual(Array(3).fill({ done: 3, failed: 0 }));
    expect(mock.of("creative")).toHaveLength(3);
    const first = getAds(group[0].id).find((a) => a.position === 1)!;
    const lost = mock.of("creative").find((c) => c.name?.includes(`[L:${first.key}]`))!;
    expect(lost).toBeTruthy();
    expect(allAds(group).filter((a) => a.position === 1 && a.status === "done").every((a) => a.meta_creative_id === lost.id)).toBe(true);
    // The failed ad got it too: its Retry makes no creative.
    expect(getAds(group[0].id).find((a) => a.position === 1)!.meta_creative_id).toBe(lost.id);
    expect(resetFailed(group[0].id)).toBe(1);
    const before = posts("adcreatives");
    expect(await runBatch(group[0].id, deps)).toEqual({ done: 3, failed: 0 });
    expect(posts("adcreatives")).toBe(before);
    expect(mock.of("creative")).toHaveLength(3);
    expect(mock.of("ad")).toHaveLength(12);
  }, 120_000);

  it("an ad set that runs first and fails does not stop the others: Meta refused, so no look-up, the next one makes it", async () => {
    const { accountId, key } = await draft(images, 4);
    const group = await launch(key);
    mock.inject({ match: (m, p) => m === "POST" && p.endsWith("/adcreatives"), kind: "error", error: { message: "Invalid parameter", code: 100, error_user_msg: "Something in this creative is not allowed." } });
    const deps = starterDeps(accountId);
    const results = await runAll(group, deps);
    expect(results[0]).toEqual({ done: 2, failed: 1 });
    expect(results.slice(1)).toEqual(Array(3).fill({ done: 3, failed: 0 }));
    expect(mock.of("creative")).toHaveLength(3);
    // Only the 4 runs' own checks read the creatives: nobody looked up the refused try.
    expect(mock.calls.filter((c) => c.method === "GET" && c.path.endsWith("/adcreatives")).length).toBe(4);
    resetFailed(group[0].id);
    expect(await runBatch(group[0].id, deps)).toEqual({ done: 3, failed: 0 });
    expect(mock.of("creative")).toHaveLength(3);
    const ones = allAds(group).filter((a) => a.position === 1);
    expect(new Set(ones.map((a) => a.meta_creative_id)).size).toBe(1);
  }, 120_000);

  it("Retry after the copy of a failed ad changed makes a new creative (v2); the other ad sets keep theirs", async () => {
    const { accountId, key } = await draft(images, 3);
    const group = await launch(key);
    const deps = starterDeps(accountId);
    // Ad set 2's ad 1 fails when its ad is made, after it took the shared creative.
    expect(await runBatch(group[0].id, deps)).toEqual({ done: 3, failed: 0 });
    mock.inject({ match: (m, p) => m === "POST" && p.endsWith("/ads"), kind: "error", error: { message: "Invalid parameter", code: 100, error_user_msg: "Text not allowed." } });
    expect(await runBatch(group[1].id, deps)).toEqual({ done: 2, failed: 1 });
    expect(await runBatch(group[2].id, deps)).toEqual({ done: 3, failed: 0 });
    const failed = getAds(group[1].id).find((a) => a.status === "failed")!;
    const old = getAds(group[0].id).find((a) => a.position === failed.position)!.meta_creative_id!;
    // Meta refused it with the shared creative: the Retry makes it its own.
    expect(failed.meta_creative_id).toBeNull();
    expect(mock.of("creative")).toHaveLength(3);

    updateAdOverride(group[1].key, failed.id, { copy: { primaryTexts: ["Fixed words."] } });
    retryFailed(group[1].key);
    expect(await runBatch(group[1].id, deps)).toEqual({ done: 3, failed: 0 });
    expect(mock.of("creative")).toHaveLength(4);
    const after = getAds(group[1].id).find((a) => a.id === failed.id)!;
    expect(after.meta_creative_id).not.toBe(old);
    expect(mock.objects.get(after.meta_creative_id!)!.name).toContain(`[L:${after.key}]`);
    expect(JSON.stringify(body(after.meta_creative_id!))).toContain("Fixed words.");
    // The other ad sets' ads still use the first creative.
    expect(getAds(group[0].id).find((a) => a.position === failed.position)!.meta_creative_id).toBe(old);
    expect(getAds(group[2].id).find((a) => a.position === failed.position)!.meta_creative_id).toBe(old);
  }, 120_000);
});

describe("videos and carousels", () => {
  it("15 files (videos, images, a carousel) into 2 ad sets: each file uploaded once, each creative made once", async () => {
    const { accountId, batchId, key } = await draft(fifteen, 2);
    const testimonial = getAds(batchId).find((a) => a.creative_name === "testimonial")!;
    updateAdOverride(key, testimonial.id, { copy: { format: "carousel" } as never });
    const group = await launch(key);
    const from = mock.calls.length;
    expect(await runAll(group, starterDeps(accountId))).toEqual([{ done: 9, failed: 0 }, { done: 9, failed: 0 }]);
    expect(posts("video_ads", from)).toBe(10 * 2); // 10 videos: start + finish, once each
    expect(mock.calls.slice(from).filter((c) => c.path.startsWith("rupload/")).length).toBe(10);
    expect(posts("adimages", from)).toBe(5);
    expect(mock.of("creative")).toHaveLength(9);
    expect(mock.of("ad")).toHaveLength(18);
    const [one, two] = group.map((b) => getAds(b.id));
    expect(one.map((a) => a.meta_creative_id)).toEqual(two.map((a) => a.meta_creative_id));
    expect(one.map((a) => a.meta_post_id)).toEqual(two.map((a) => a.meta_post_id));
    const carousel = one.find((a) => a.creative_name === "testimonial")!;
    expect(JSON.stringify(body(carousel.meta_creative_id!))).toContain("child_attachments");
    expect(mock.of("creative").filter((c) => JSON.stringify(c.body).includes("child_attachments"))).toHaveLength(1);
  }, 240_000);
});

describe("time estimate of the whole launch", () => {
  const work = (ads: number, adsets: number, creatives: number): LaunchWork => ({
    ads,
    adsets,
    creatives,
    uploads: Array.from({ length: creatives }, () => ({ kind: "image" as const, sizeBytes: 300_000 })),
    newAdsets: 0,
    runReads: adsets * 2,
  });

  it("counts what the launcher does: each file once, each creative once, an ad per ad set", async () => {
    const { batchId } = await draft(images, 4);
    expect(launchWork(getBatch(batchId)!)).toMatchObject({ ads: 12, adsets: 4, creatives: 3, newAdsets: 0, runReads: 8 });
    expect(launchWork(getBatch(batchId)!).uploads).toHaveLength(3);
  });

  it("starter tier and full access, in plain words", () => {
    const s4 = estimateWork(work(12, 4, 3), STARTER);
    // 18 writes + 14 reads = 68 points: 45 go out at once, the other 23 once those leave the 5 minutes.
    expect(s4.points).toBe(68);
    expect(s4.calls).toBe(32);
    expect(s4.text).toBe("about 5 minutes for 12 ads in 4 ad sets (Meta's limit on this ad account sets the pace: about 2 new ads a minute)");
    // 51 writes + 36 reads = 189 points: 45 now, then 45 every 5 minutes.
    const s15 = estimateWork(work(45, 15, 3), STARTER);
    expect(s15.points).toBe(189);
    expect(s15.text).toBe("about 20 minutes for 45 ads in 15 ad sets (Meta's limit on this ad account sets the pace: about 2 new ads a minute)");
    // The same launch before creatives were shared: 93 writes + 120 reads = 399 points, about 40 minutes.
    const before = estimateWork({ ...work(45, 15, 45), uploads: work(45, 15, 3).uploads }, STARTER);
    expect([before.points, before.calls]).toEqual([399, 213]);
    expect(before.text).toMatch(/^about 40 minutes/);
    // Points already spent in the last 5 minutes leave less room at the start.
    expect(estimateWork(work(12, 4, 3), { ...STARTER, usedPoints: 45 }).seconds).toBe(s4.seconds + 300);
    // Full access: Meta's limit is not what slows it.
    const f15 = estimateWork(work(45, 15, 3), FULL);
    expect(f15.rateLimited).toBe(false);
    expect(f15.text).toBe("about 1 minute for 45 ads in 15 ad sets");
    // Turning the ads on when all are in: 12 ads + 4 ad sets + 1 campaign = 17 more writes, said apart.
    const on = estimateWork({ ...work(12, 4, 3), turnOn: 17 }, STARTER);
    expect(on.seconds).toBeGreaterThan(s4.seconds);
    expect(on.turnOnSeconds).toBe(on.seconds - s4.seconds);
    expect(on.text).toBe("about 10 minutes for 12 ads in 4 ad sets: about 5 minutes to create them, then about 5 minutes to turn them on (Meta's limit on this ad account sets the pace: about 2 new ads a minute)");
  });

  it("the starter tier's hourly allowance, on the practice Meta: an account that used most of its hour already", async () => {
    mock = new MockMeta({ clock, capPoints: 60, hourlyCalls: 300, richAccount: true, allowActive: true });
    g.__mockMeta = mock;
    const { accountId, batchId, key } = await draft(images, 4);
    // Pages and Claude made 230 calls 50 minutes ago (of the 300 Meta allows an hour).
    for (let i = 0; i < 230; i++) mock.calls.push({ method: "GET", path: `${mock.accountId}/insights`, cost: 1, t: clock.now() - 50 * 60_000 });
    const deps = starterDeps(accountId);
    // A page read gives the hour's use, as the batch page has it (the pacer's saved numbers).
    await deps.client.get(mock.accountId, { fields: "name" });
    const hourPct = deps.client.pacer.state.lastBuc!.pct;
    expect(hourPct).toBeGreaterThanOrEqual(75);
    const limits = { ...STARTER, hourPct, usedPoints: 1 };
    const est = buildPreview(batchId, {}, limits).estimate;
    const plain = buildPreview(batchId, {}, STARTER).estimate;
    expect(est.seconds).toBeGreaterThan(plain.seconds); // the hour's use makes it longer
    const group = await launch(key);
    const start = clock.now();
    expect(await runAll(group, deps)).toEqual(Array(4).fill({ done: 3, failed: 0 }));
    const real = (clock.now() - start) / 1000;
    console.log(`hour 77% used: estimate "${est.text}" (without it: "${plain.label}"); the launch took ${(real / 60).toFixed(1)} simulated minutes, ${mock.throttled} refused`);
    expect(est.seconds).toBeGreaterThan(real * 0.5);
    expect(est.seconds).toBeLessThan(real * 1.6);
  }, 120_000);

  it("the time left during a launch uses how fast the ads are really going in (Meta slower than its limits), for every ad set", async () => {
    const { accountId, key } = await draft(images, 15);
    const group = await launch(key);
    const main = getBatch(group[0].id)!;
    // Before anything is in: the account's limits.
    const first = launchTimeLeft(main, STARTER, clock.now())!;
    expect(first.observed).toBeFalsy();
    expect(first.text).toMatch(/^about \d+ minutes left for 45 ads in 15 ad sets \(Meta's limit on this ad account sets the pace: /);
    // The service gives the same sentence on the batch page and to Claude.
    expect((await batchView(key)).timeLeft).toMatch(/ left for 45 ads in 15 ad sets/);

    // Meta answers slowly today (20 s a call): slower than its limits alone would make the launch.
    const slow: typeof fetch = async (input, init) => {
      await clock.sleep(20_000);
      return mock.fetch(input, init);
    };
    const deps = starterDeps(accountId, slow);
    await runAll(group.slice(0, 5), deps);
    // The pacer's own numbers, as accountLimits reads them from the saved rate state.
    const used = deps.client.pacer.state.log.filter(([t]) => t > clock.now() - 300_000).reduce((s, [, p]) => s + p, 0);
    const left = launchTimeLeft(main, { ...STARTER, usedPoints: used }, clock.now())!;
    expect(left.text).toMatch(/^about \d+ minutes left for 30 ads in 10 ad sets \(at the pace Meta allows right now, about \d new ads? a minute\)$/);
    expect(left.observed).toBe(true);
    const start = clock.now();
    await runAll(group.slice(5), deps);
    const real = (clock.now() - start) / 1000;
    console.log(`time left after 5 of 15 ad sets: "${left.text}"; it took ${(real / 60).toFixed(1)} simulated minutes`);
    expect(left.seconds).toBeLessThan(real * 1.6);
    expect(left.seconds).toBeGreaterThan(real * 0.5);
    // Everything in: nothing is running, so no time left.
    expect(launchTimeLeft(getBatch(main.id)!, STARTER, clock.now())).toBeNull();
  }, 120_000);

  it("too little seen yet, or a pause: the time left says so honestly", () => {
    const w = work(9, 3, 0);
    expect(timeLeft(w, STARTER, [{ doneAt: 0, points: 11 }, { doneAt: 1000, points: 3 }], 2000).observed).toBeFalsy();
    // 3 ads a minute seen: 9 ads left (27 points + 6 reads) take about 3 minutes.
    const seen = [0, 20_000, 40_000, 60_000].map((t) => ({ doneAt: t, points: 3 }));
    const r = timeLeft(w, STARTER, seen, 60_000);
    expect(r.observed).toBe(true);
    expect(r.text).toBe("about 4 minutes left for 9 ads in 3 ad sets (at the pace Meta allows right now, about 2 new ads a minute)");
    // The same ads, but nothing new for 5 more minutes: slower now.
    expect(timeLeft(w, STARTER, seen, 360_000).seconds).toBeGreaterThan(r.seconds * 4);
    // A pace that looks faster than the limits allow (right after a burst): the limits win.
    const fast = [0, 1000, 2000, 61_000].map((t) => ({ doneAt: t, points: 30 }));
    const capped = timeLeft(work(30, 10, 0), { ...STARTER, usedPoints: 45 }, fast, 61_000);
    expect(capped.observed).toBe(false);
    expect(capped.seconds).toBe(estimateWork(work(30, 10, 0), { ...STARTER, usedPoints: 45 }).seconds);
  });
});

describe("Claude's batch_status", () => {
  async function status(view: Record<string, unknown>) {
    const api: LauncherApi = { call: async <T,>() => view as T };
    const server = new McpServer({ name: "r4", version: "0" });
    registerTools(server, api);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: "r4", version: "0" });
    await client.connect(b);
    const r = (await client.callTool({ name: "batch_status", arguments: { batch_id: "abcde" } })) as { content: { text: string }[] };
    return r.content.map((c) => c.text).join("\n");
  }
  const base = {
    key: "abcde", statusLabel: "Launching", source: { kind: "upload", label: "" },
    settings: { campaignName: "C", adsetMode: "existing", adsetName: "A", copyTemplateId: null, preset: null, goLive: "now", goLiveAt: null, extraAdsets: [] },
    preview: { batchChecks: [], errors: 0, warnings: 0, estimate: { label: "about 3 minutes", rateLimited: true, text: "about 3 minutes for 9 ads in 3 ad sets" } },
    launchEstimate: "about 6 minutes", links: { app: "https://launcher.test/batches/abcde", campaign: null }, ads: [], together: [{ key: "fghij", adsetName: "B", status: "queued" }],
  };

  it("shows the time left of the whole launch while it runs", async () => {
    const t = await status({ ...base, status: "running", progress: { total: 3, done: 1, failed: 0, working: 1 }, timeLeft: "about 4 minutes left for 8 ads in 3 ad sets (at the pace Meta allows right now, about 2 new ads a minute)" });
    expect(t).toContain("Estimate at launch (every ad set): about 6 minutes. About 4 minutes left for 8 ads in 3 ad sets (at the pace Meta allows right now, about 2 new ads a minute).");
  });

  it("says next to the Retry advice when a Retry now would not turn the ads on by itself", async () => {
    const hold = "more than an hour passed between the end of the launch (19 Nov, 2:00 pm IST) and the Retry";
    const t = await status({ ...base, status: "partial", statusLabel: "Some ads failed", progress: { total: 3, done: 2, failed: 1, working: 0 }, timeLeft: null, retryHold: hold, goLiveHold: null, goLivePlan: null, together: [] });
    const lines = t.split("\n");
    const advice = lines.findIndex((l) => l.startsWith("Next: fix the cause"));
    expect(advice).toBeGreaterThan(-1);
    expect(lines[advice + 1]).toBe(`If retry_failed is used now, the ads are NOT turned on by themselves: ${hold}, so the budget confirmation given at launch is not used. Once every ad is in, the plan that turns them on is saved as a draft for the person to check and confirm.`);
    expect(lines.filter((l) => l.startsWith("If retry_failed is used now"))).toHaveLength(1);
  });
});
