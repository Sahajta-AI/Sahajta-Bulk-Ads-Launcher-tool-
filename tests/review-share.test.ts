import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import sharp from "sharp";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, migrate, setDb } from "@/lib/db";
import { migrations } from "@/lib/db/schema";
import { resetFailed, runBatch, type LaunchDeps } from "@/lib/engine/launcher";
import { estimateWork, timeLeft, workCalls, type LaunchWork } from "@/lib/engine/estimate";
import { accountLimits, buildPreview, launchTimeLeft, launchWork } from "@/lib/engine/preview";
import { DEFAULT_UTM } from "@/lib/engine/naming";
import { siblings } from "@/lib/manage/golive";
import { MetaClient } from "@/lib/meta/client";
import { FakeClock, MockMeta } from "@/lib/meta/mock";
import { Pacer } from "@/lib/meta/pacer";
import { localFiles } from "@/lib/sources/local";
import { batchView, launchBatch, updateAdOverride, updateSettings } from "@/lib/service";
import { getAds, getBatch, updateAd, updateBatch } from "@/lib/store";
import type { BatchRow } from "@/lib/types";
import { LEAD_COPY, fifteenFileFolder, freshDb, setupBatch } from "./helpers";

// Independent review probes of round 4 (one creative per launch, shared by the ad sets; time estimate of the
// whole launch). Practice Meta only (MockMeta). A failing test here is a bug found; a passing one is a case
// checked and found fine (or behaviour recorded).

process.env.META_MOCK = "1";
const g = globalThis as unknown as { __mockMeta?: MockMeta };
const STARTER = { capPoints: 60, tier: "development_access" };
const BASE_PRESET = { name: "All off", pageId: "p1", pageName: "Sahajta AI", igUserId: "ig1", igName: "sahajta.ai", enhancements: {}, multiAdvertiser: false };

let three: string;
let one: string;
let twins: string;
let oneVideo: string;
let mock: MockMeta;
let clock: FakeClock;

async function jpg(file: string, c: string) {
  if (!fs.existsSync(file)) await sharp({ create: { width: 1080, height: 1080, channels: 3, background: c } }).jpeg().toFile(file);
}

beforeAll(async () => {
  const root = path.join(os.tmpdir(), "review-share-fixtures");
  three = path.join(root, "three");
  one = path.join(root, "one");
  twins = path.join(root, "twins");
  oneVideo = path.join(root, "one-video");
  for (const d of [three, one, twins, oneVideo]) fs.mkdirSync(d, { recursive: true });
  for (const [i, c] of ["#c33", "#3c3", "#33c"].entries()) await jpg(path.join(three, `img-${i + 1}_1x1.jpg`), c);
  await jpg(path.join(one, "solo_1x1.jpg"), "#a5a");
  // Two files with the very same bytes, under two names (a copy of a file left in the folder).
  await jpg(path.join(twins, "offer-a_1x1.jpg"), "#5aa");
  if (!fs.existsSync(path.join(twins, "offer-b_1x1.jpg"))) fs.copyFileSync(path.join(twins, "offer-a_1x1.jpg"), path.join(twins, "offer-b_1x1.jpg"));
  const fifteen = await fifteenFileFolder();
  if (!fs.existsSync(path.join(oneVideo, "hook-01_9x16.mp4"))) fs.copyFileSync(path.join(fifteen, "hook-01_9x16.mp4"), path.join(oneVideo, "hook-01_9x16.mp4"));
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", (url: string | URL | Request, init?: RequestInit) => (String(url).startsWith("https://example.com") ? Promise.resolve(new Response("ok")) : real(url, init)));
}, 120_000);

beforeEach(() => {
  freshDb();
  clock = new FakeClock();
  mock = new MockMeta({ clock, capPoints: 9000, richAccount: true, allowActive: true, videoProcessingMs: 60_000 });
  g.__mockMeta = mock;
});

function adsets(total: number): string[] {
  const ids = ["as1", "as4"];
  for (let i = 5; ids.length < total; i++) {
    mock.objects.set(`as${i}`, { ...mock.objects.get("as4")!, id: `as${i}`, name: `Ad set ${i}` });
    ids.push(`as${i}`);
  }
  return ids.slice(0, total);
}

async function draft(folder: string, total: number, copy: Record<string, unknown> = LEAD_COPY, opts: { mode?: "existing" | "new_per_ad"; adsetId?: string } = {}) {
  const ids = opts.adsetId ? [opts.adsetId, ...adsets(total).filter((x) => x !== opts.adsetId)].slice(0, total) : adsets(total);
  const { accountId, batchId } = await setupBatch(folder, { mode: opts.mode, adsetId: ids[0] });
  db().prepare("UPDATE ad_accounts SET is_default = 1 WHERE id = ?").run(accountId);
  updateBatch(batchId, { copy: JSON.stringify(copy) });
  const key = getBatch(batchId)!.key;
  if (total > 1) await updateSettings(key, { extraAdsetIds: ids.slice(1) });
  return { accountId, batchId, key };
}

async function launch(key: string): Promise<BatchRow[]> {
  await launchBatch(key, { confirm: true, acceptWarnings: true });
  const id = db().prepare("SELECT id FROM batches WHERE key = ?").pluck().get(key) as number;
  return siblings(getBatch(id)!);
}

function deps(accountDbId: number, fetchImpl: typeof fetch = mock.fetch, extra: Partial<LaunchDeps> = {}): LaunchDeps {
  const pacer = new Pacer(clock, undefined, undefined, 60);
  const client = new MetaClient({ token: "mock-token", accountId: mock.accountId, version: "v26.0", fetch: fetchImpl, pacer, clock });
  return { client, files: localFiles, clock, accountDbId, tmpDir: fs.mkdtempSync(path.join(os.tmpdir(), "review-share-")), ...extra };
}

async function runAll(group: BatchRow[], d: LaunchDeps) {
  const out = [];
  for (const b of group) out.push(await runBatch(b.id, d));
  return out;
}

const allAds = (group: BatchRow[]) => group.flatMap((b) => getAds(b.id));
const body = (creativeId: string) => JSON.stringify(mock.objects.get(creativeId)!.body);
const urlOf = (input: string | URL | Request) => new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);

/** Meta's thumbnail links are signed CDN links: each read gives another one (oh=/oe= change). */
function signedThumbnails(base: typeof fetch): typeof fetch {
  let n = 0;
  return async (input, init) => {
    const res = await base(input, init);
    if (!urlOf(input as string).pathname.endsWith("/thumbnails")) return res;
    const data = (await res.json()) as { data: { uri: string }[] };
    n++;
    for (const d of data.data) d.uri = `${d.uri}?oh=sig${n}&oe=${1_800_000_000 + n}`;
    return new Response(JSON.stringify(data), { status: res.status, headers: res.headers });
  };
}

// ---------------------------------------------------------------------------------------------------------
describe("BUGS: duplicate or split creatives", () => {
  it("after a database restore, the other ad sets make a second creative for every ad (the posts split)", async () => {
    const { accountId, key } = await draft(three, 2);
    let group = await launch(key);
    const backup = db().serialize(); // the nightly backup, taken after the launch was queued
    const d = deps(accountId);
    expect(await runBatch(group[0].id, d)).toEqual({ done: 3, failed: 0 });
    expect(mock.of("creative")).toHaveLength(3);
    // The server is restored from the backup: Meta keeps ad set 1's creatives and ads, the database forgets them.
    setDb(new Database(backup));
    group = group.map((b) => getBatch(b.id)!);
    expect(await runBatch(group[0].id, d)).toEqual({ done: 3, failed: 0 }); // found in Meta by key: nothing made again
    expect(mock.of("creative")).toHaveLength(3);
    // Found by key, and its hash worked out from the saved files, so the other ad sets can find it.
    expect(getAds(group[0].id).every((a) => a.meta_creative_id && (a as { creative_hash?: string }).creative_hash)).toBe(true);
    expect(await runBatch(group[1].id, d)).toEqual({ done: 3, failed: 0 });
    // Expected: ad set 2 uses the same 3 creatives (one post per ad). Found: 3 more creatives, so 2 posts per ad.
    expect(mock.of("creative")).toHaveLength(3);
  }, 60_000);

  it("a video ad retried more than 6 hours later gets its own creative: the thumbnail link changed, so the hash did", async () => {
    const { accountId, key } = await draft(oneVideo, 2);
    const group = await launch(key);
    const d = deps(accountId, signedThumbnails(mock.fetch));
    expect(await runBatch(group[0].id, d)).toEqual({ done: 1, failed: 0 });
    // Ad set 2 is retried the next morning (or a big launch runs past 6 hours): the saved thumbnail link is old.
    db().prepare("UPDATE meta_media SET updated_at = datetime('now', '-7 hours')").run();
    expect(await runBatch(group[1].id, d)).toEqual({ done: 1, failed: 0 });
    const [a, b] = allAds(group);
    const strip = (id: string) => body(id).replace(/\?oh=sig\d+&oe=\d+/g, "").replace(/"name":"[^"]*"/, "");
    if (b.meta_creative_id !== a.meta_creative_id) expect(strip(b.meta_creative_id!)).toBe(strip(a.meta_creative_id!)); // they differ only in the thumbnail link
    // Expected: same video, same copy, same Page: one creative, one post. Found: two creatives that differ only in the thumbnail link.
    expect(b.meta_creative_id).toBe(a.meta_creative_id);
    expect(mock.of("creative")).toHaveLength(1);
  }, 60_000);

  it("a copy change on the failed ad that made a creative loses that creative for the other ad sets: an identical one is made again", async () => {
    const { accountId, key } = await draft(three, 2);
    const group = await launch(key);
    const d = deps(accountId);
    // Ad set 1, ad 1: its creative C is made, then Meta refuses the ad. Ad set 2 is stopped before it starts.
    mock.inject({ match: (m, p) => m === "POST" && p.endsWith("/ads"), kind: "error", error: { message: "Invalid parameter", code: 100, error_user_msg: "Text not allowed." } });
    expect(await runBatch(group[0].id, d)).toEqual({ done: 2, failed: 1 });
    const x = getAds(group[0].id).find((a) => a.status === "failed")!;
    const c = x.meta_creative_id!;
    updateBatch(group[1].id, { cancel_requested: 1 });
    expect(await runBatch(group[1].id, d)).toEqual({ done: 0, failed: 3 });
    // The person fixes only ad set 1's ad (ad set 2 keeps the batch copy), then retries ad set 2.
    updateAdOverride(group[0].key, x.id, { copy: { primaryTexts: ["Fixed words."] } });
    updateBatch(group[1].id, { cancel_requested: 0 });
    resetFailed(group[1].id);
    expect(await runBatch(group[1].id, d)).toEqual({ done: 3, failed: 0 });
    const twin = getAds(group[1].id).find((a) => a.position === x.position)!;
    // C has exactly ad set 2's body (old copy) and no ad. Expected: reused. Found: a 4th, identical creative; C is left unused.
    expect(twin.meta_creative_id).toBe(c);
    expect(mock.of("creative")).toHaveLength(3);
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------------------
describe("BUGS: the time estimate", () => {
  it("a launch that turns the ads on shows the same time as a paused one: the turn-on calls are not counted", async () => {
    const { batchId } = await draft(three, 4);
    const paused = buildPreview(batchId, {}, STARTER).estimate;
    updateBatch(batchId, { go_live: "now" });
    const now = buildPreview(batchId, {}, STARTER).estimate;
    // Turning on 12 ads, 4 ad sets and 1 campaign is 17 more writes (51 points) on a 45-point-per-5-minutes lane.
    console.log(`paused: "${paused.text}"; turned on when all are in: "${now.text}"`);
    expect(now.seconds).toBeGreaterThan(paused.seconds);
  });

  it("the sentence contradicts itself: 'about 10 minutes for 12 ads (… about 3 new ads a minute …)'", () => {
    // One ad set, 12 images: each ad needs its upload, its creative (and 2 reads) and the ad.
    const w: LaunchWork = { ads: 12, adsets: 1, creatives: 12, uploads: Array.from({ length: 12 }, () => ({ kind: "image" as const, sizeBytes: 300_000 })), newAdsets: 0, runReads: 2 };
    const e = estimateWork(w, STARTER);
    console.log(`estimate: "${e.text}"`);
    const minutes = Number(/about (\d+) minutes/.exec(e.text)![1]);
    const rate = Number(/about (\d+) new ads? a minute/.exec(e.text)![1]);
    // At the rate the sentence gives, 12 ads take 4 minutes; the same sentence says 10.
    expect(rate * minutes).toBeLessThanOrEqual(w.ads * 2);
  });
});

// ---------------------------------------------------------------------------------------------------------
describe("BUG (not caused by sharing, same code): an angle-only change keeps the old link tags", () => {
  it("link tags with {angle}: after the angle of a failed ad is changed, Retry still uses the creative with the old angle", async () => {
    const { accountId, key } = await draft(three, 1, { ...LEAD_COPY, utmTemplate: "utm_source=meta&utm_content={angle}" });
    const group = await launch(key);
    mock.inject({ match: (m, p) => m === "POST" && p.endsWith("/ads"), kind: "error", error: { message: "Invalid parameter", code: 100, error_user_msg: "Try again." } });
    const d = deps(accountId);
    expect(await runBatch(group[0].id, d)).toEqual({ done: 2, failed: 1 });
    const x = getAds(group[0].id).find((a) => a.status === "failed")!;
    updateAdOverride(key, x.id, { angle: "price-drop" });
    resetFailed(group[0].id);
    expect(await runBatch(group[0].id, d)).toEqual({ done: 3, failed: 0 });
    const after = getAds(group[0].id).find((a) => a.id === x.id)!;
    // Expected: utm_content=price-drop. Found: the creative made before the change (utm_content=site-visit).
    expect(String(mock.objects.get(after.meta_creative_id!)!.url_tags)).toContain("price-drop");
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------------------
describe("checked and fine: anything different makes its own creative", () => {
  it("identity, WhatsApp, partner, enhancements, display link, multi-advertiser and button each split; the same body shares", async () => {
    const { accountId, key } = await draft(one, 9);
    const group = await launch(key);
    const set = (i: number, patch: Record<string, unknown>) => updateBatch(group[i].id, patch as Record<string, string>);
    const adOf = (i: number) => getAds(group[i].id)[0];
    set(1, { preset: JSON.stringify({ ...BASE_PRESET, igUserId: "", igName: "" }) });
    set(2, { preset: JSON.stringify({ ...BASE_PRESET, whatsappNumber: "+919800000000" }), copy: JSON.stringify({ ...LEAD_COPY, cta: "WHATSAPP_MESSAGE" }) });
    set(3, { preset: JSON.stringify({ ...BASE_PRESET, sponsorPageId: "p9" }) });
    updateAd(adOf(4).id, { copy_override: JSON.stringify({ enhancements: { image_animation: "OPT_IN" } }) });
    set(5, { copy: JSON.stringify({ ...LEAD_COPY, displayLink: "sahajta.com/visit" }) });
    updateAd(adOf(6).id, { copy_override: JSON.stringify({ multiAdvertiser: true }) });
    // 7: unchanged (shares with 0)
    set(8, { copy: JSON.stringify({ ...LEAD_COPY, cta: "SIGN_UP" }) });
    expect(await runAll(group, deps(accountId))).toEqual(Array(9).fill({ done: 1, failed: 0 }));
    const ids = group.map((_, i) => adOf(i).meta_creative_id!);
    expect(ids[7]).toBe(ids[0]);
    expect(new Set(ids).size).toBe(8);
    expect(mock.of("creative")).toHaveLength(8);
    expect(body(ids[0])).toContain('"instagram_user_id":"ig1"');
    expect(body(ids[1])).not.toContain("instagram_user_id");
    expect(body(ids[2])).toContain('"whatsapp_number":"+919800000000"');
    expect(body(ids[3])).toContain('"branded_content_sponsor_page_id":"p9"');
    expect(body(ids[4])).toMatch(/"image_animation":\{"enroll_status":"OPT_IN"\}/);
    expect(body(ids[5])).toContain('"caption":"sahajta.com/visit"');
    expect(body(ids[6])).toMatch(/"contextual_multi_ads":\{"enroll_status":"OPT_IN"\}/);
    expect(body(ids[8])).toContain('"type":"SIGN_UP"');
  }, 60_000);

  it("the launcher's own {batch} placeholder in the link tags never shares across ad sets; {n} (same ad number) does", async () => {
    const own = await draft(three, 2, { ...LEAD_COPY, utmTemplate: "utm_source=meta&utm_campaign={batch}" });
    expect(launchWork(getBatch(own.batchId)!)).toMatchObject({ ads: 6, creatives: 6 });
    await runAll(await launch(own.key), deps(own.accountId));
    expect(mock.of("creative")).toHaveLength(6);

    freshDb();
    mock = new MockMeta({ clock, capPoints: 9000, richAccount: true, allowActive: true });
    g.__mockMeta = mock;
    const n = await draft(three, 2, { ...LEAD_COPY, utmTemplate: "utm_source=meta&utm_content={n}" });
    expect(launchWork(getBatch(n.batchId)!)).toMatchObject({ ads: 6, creatives: 3 });
    await runAll(await launch(n.key), deps(n.accountId));
    expect(mock.of("creative")).toHaveLength(3);
  }, 60_000);

  it("records: two ads with the same bytes under two names, in ONE ad set, now share one creative and one post", async () => {
    const { accountId, batchId, key } = await draft(twins, 1, { ...LEAD_COPY, utmTemplate: DEFAULT_UTM });
    expect(getAds(batchId)).toHaveLength(2);
    await runAll(await launch(key), deps(accountId));
    const [a, b] = getAds(batchId);
    expect(a.meta_ad_id).not.toBe(b.meta_ad_id);
    expect(a.meta_creative_id).toBe(b.meta_creative_id); // was two creatives (two posts) before round 4
    expect(mock.of("creative")).toHaveLength(1);
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------------------
describe("checked and fine: lost answers, crashes, refusals", () => {
  it("a crash right after Meta made the creative, then the next ad set runs before the first one resumes: no second creative", async () => {
    const { accountId, key } = await draft(three, 3);
    const group = await launch(key);
    const first = getAds(group[0].id)[0];
    let crashed = false;
    const d = deps(accountId, mock.fetch, {
      afterCreate: (kind, adKey) => {
        if (kind === "creative" && adKey === first.key && !crashed) {
          crashed = true;
          throw Object.assign(new Error("worker killed"), { fatal: true });
        }
      },
    });
    await expect(runBatch(group[0].id, d)).rejects.toThrow("worker killed");
    // The other ad sets run first (queue order after a restart), then ad set 1 resumes.
    expect(await runAll(group.slice(1), d)).toEqual([{ done: 3, failed: 0 }, { done: 3, failed: 0 }]);
    expect(await runBatch(group[0].id, d)).toEqual({ done: 3, failed: 0 });
    expect(mock.of("creative")).toHaveLength(3);
    const ones = allAds(group).filter((a) => a.position === 1);
    expect(new Set(ones.map((a) => a.meta_creative_id)).size).toBe(1);
    expect(new Set(ones.map((a) => a.meta_post_id)).size).toBe(1);
  }, 60_000);

  it("when Meta refuses the ad that uses a shared creative, Retry makes that ad its own creative, and says so", async () => {
    const { accountId, key } = await draft(three, 2);
    const group = await launch(key);
    const d = deps(accountId);
    expect(await runBatch(group[0].id, d)).toEqual({ done: 3, failed: 0 });
    const shared = getAds(group[0].id).map((a) => a.meta_creative_id);
    const refuse = { message: "Invalid parameter", code: 100, error_subcode: 1487390, error_user_msg: "This creative can't be used with this ad set." };
    for (let i = 0; i < 3; i++) mock.inject({ match: (m, p) => m === "POST" && p.endsWith("/ads"), kind: "error", error: refuse });
    expect(await runBatch(group[1].id, d)).toEqual({ done: 0, failed: 3 });
    const failed = getAds(group[1].id);
    expect(failed.every((a) => a.error?.includes("Retry makes this ad its own creative"))).toBe(true);
    console.log(`error shown on the ad: "${failed[0].error}"`);
    resetFailed(group[1].id);
    updateBatch(group[1].id, { status: "queued" });
    expect(launchWork(getBatch(group[1].id)!)).toMatchObject({ ads: 3, creatives: 3, uploads: [] });
    expect(await runBatch(group[1].id, d)).toEqual({ done: 3, failed: 0 });
    expect(mock.of("creative")).toHaveLength(6);
    const own = getAds(group[1].id);
    for (const [i, a] of own.entries()) {
      expect(a.meta_creative_id).not.toBe(shared[i]);
      expect(mock.objects.get(a.meta_creative_id!)!.name).toContain(`[L:${a.key}]`);
    }
    // Ad set 1 keeps the first ones; a third ad set still shares them.
    expect(getAds(group[0].id).map((a) => a.meta_creative_id)).toEqual(shared);
  }, 60_000);

  it("the feature warnings Meta gave the creative are shown on every ad that uses it", async () => {
    const { accountId, key } = await draft(three, 2);
    const group = await launch(key);
    // Meta's read-back of the creative switches on a feature nobody asked for.
    const withFeature: typeof fetch = async (input, init) => {
      const res = await mock.fetch(input, init);
      const u = urlOf(input as string);
      if ((init?.method ?? "GET") !== "GET" || u.searchParams.get("fields") !== "degrees_of_freedom_spec") return res;
      const data = (await res.json()) as { degrees_of_freedom_spec?: { creative_features_spec: Record<string, unknown> } };
      data.degrees_of_freedom_spec!.creative_features_spec.surprise_ai_feature = { enroll_status: "OPT_IN" };
      return new Response(JSON.stringify(data), { status: res.status, headers: res.headers });
    };
    await runAll(group, deps(accountId, withFeature));
    const [a, b] = group.map((x) => getAds(x.id)[0]);
    expect(a.meta_creative_id).toBe(b.meta_creative_id);
    expect(JSON.parse(a.feature_warnings)).toHaveLength(1);
    expect(b.feature_warnings).toBe(a.feature_warnings);
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------------------
describe("checked and fine: estimate and time left", () => {
  it("the estimate, the time left and the batch page ask Meta nothing", async () => {
    const { accountId, key } = await draft(three, 3);
    const group = await launch(key);
    const before = mock.calls.length;
    const limits = accountLimits(accountId);
    buildPreview(group[0].id, {}, limits);
    launchWork(getBatch(group[0].id)!);
    expect(launchTimeLeft(getBatch(group[0].id)!, limits)).not.toBeNull();
    await batchView(key);
    await batchView(group[2].key);
    expect(mock.calls.length).toBe(before);
  }, 60_000);

  it("time left is never negative and never shorter than the account's limits allow", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
    for (let i = 0; i < 2000; i++) {
      const w: LaunchWork = { ads: Math.floor(rnd() * 60), adsets: 1 + Math.floor(rnd() * 15), creatives: Math.floor(rnd() * 20), uploads: rnd() < 0.3 ? [{ kind: "video", sizeBytes: 5e7 }] : [], newAdsets: Math.floor(rnd() * 3), runReads: Math.floor(rnd() * 30) };
      const limits = rnd() < 0.5 ? { ...STARTER, usedPoints: Math.floor(rnd() * 60), hourPct: Math.floor(rnd() * 110) } : { capPoints: 9000, tier: "standard_access" };
      const now = 10_000_000;
      const done = Array.from({ length: Math.floor(rnd() * 8) }, () => ({ doneAt: now - Math.floor(rnd() * 900_000), points: rnd() < 0.1 ? null : Math.floor(rnd() * 20) }));
      const t = timeLeft(w, limits, done, now);
      expect(t.seconds).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(t.seconds)).toBe(true);
      expect(t.seconds).toBeGreaterThanOrEqual(estimateWork(w, limits).seconds);
    }
  });

  it("time left after the video ad set: compared with the real time of the ad sets still to run", async () => {
    const fifteen = await fifteenFileFolder();
    const { accountId, key } = await draft(fifteen, 3);
    const group = await launch(key);
    const d = deps(accountId);
    const main = getBatch(group[0].id)!;
    expect(await runBatch(group[0].id, d)).toEqual({ done: 9, failed: 0 });
    const used = d.client.pacer.state.log.filter(([t]) => t > clock.now() - 300_000).reduce((s, [, p]) => s + p, 0);
    const left = launchTimeLeft(getBatch(main.id)!, { ...STARTER, usedPoints: used }, clock.now())!;
    const start = clock.now();
    await runAll(group.slice(1), d);
    const real = (clock.now() - start) / 1000;
    console.log(`video launch, after ad set 1 of 3: "${left.text}"; the other 2 ad sets took ${(real / 60).toFixed(1)} simulated minutes`);
    expect(left.seconds).toBeLessThan(Math.max(real * 3, 180));
  }, 120_000);

  it("a Retry of an ad that already has its shared creative counts one ad and no creative", async () => {
    const { accountId, key } = await draft(three, 2);
    const group = await launch(key);
    const d = deps(accountId);
    expect(await runBatch(group[0].id, d)).toEqual({ done: 3, failed: 0 });
    // Meta is busy for ad set 2's first ad every time (a refusal would make the Retry give it its own creative).
    const busyKey = getAds(group[1].id)[0].key;
    const busy: typeof fetch = async (input, init) => {
      const u = urlOf(input as string);
      if ((init?.method ?? "GET") === "POST" && u.pathname.endsWith("/ads") && String(init?.body ?? "").includes(busyKey)) {
        return new Response(JSON.stringify({ error: { message: "Service temporarily unavailable", code: 2, is_transient: true } }), { status: 503, headers: { "content-type": "application/json" } });
      }
      return mock.fetch(input, init);
    };
    expect(await runBatch(group[1].id, deps(accountId, busy))).toEqual({ done: 2, failed: 1 });
    expect(getAds(group[1].id)[0].meta_creative_id).toBe(getAds(group[0].id)[0].meta_creative_id);
    expect(launchWork(getBatch(group[1].id)!)).toMatchObject({ ads: 0 }); // nothing queued
    resetFailed(group[1].id);
    updateBatch(group[1].id, { status: "queued" });
    expect(launchWork(getBatch(group[1].id)!)).toMatchObject({ ads: 1, adsets: 1, creatives: 0, uploads: [] });
  }, 60_000);

  it("Meta calls counted by the estimate match the launch: new ad set per ad, and one new ad set per batch", async () => {
    const rows: string[] = [];
    for (const mode of ["new_per_ad", "new_shared"] as const) {
      freshDb();
      mock = new MockMeta({ clock, capPoints: 9000, richAccount: true, allowActive: true });
      g.__mockMeta = mock;
      const { accountId, batchId, key } = await draft(three, 2, LEAD_COPY, { mode: "new_per_ad", adsetId: "as1" });
      updateBatch(batchId, { adset_mode: mode });
      const est = workCalls(launchWork(getBatch(batchId)!));
      const group = await launch(key); // the launch's own checks read Meta; the estimate is about the runs
      const from = mock.calls.length;
      expect(await runAll(group, deps(accountId))).toEqual([{ done: 3, failed: 0 }, { done: 3, failed: 0 }]);
      const calls = mock.calls.slice(from).filter((c) => !c.path.startsWith("rupload/"));
      const real = { writes: calls.filter((c) => c.method !== "GET").length, reads: calls.filter((c) => c.method === "GET").length };
      rows.push(`${mode}: estimate ${est.writes} writes + ${est.reads} reads, launch ${real.writes} writes + ${real.reads} reads`);
      expect(est.writes).toBe(real.writes);
      // new_shared: the look-up of the batch's new ad set by its key (1 read per batch) is counted too.
      expect(real.reads).toBe(est.reads);
    }
    console.log(rows.join("\n"));
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------------------
describe("checked and fine: migration 7 on an existing database", () => {
  it("adds the three columns and the index to a database at version 6, keeping its rows", async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "review-mig-")), "launcher.db");
    const old = new Database(file);
    for (let v = 0; v < 6; v++) old.exec(migrations[v]);
    old.pragma("user_version = 6");
    setDb(old);
    const { batchId } = await setupBatch(three);
    const before = getAds(batchId).map((a) => [a.id, a.key]);
    expect(before).toHaveLength(3);
    migrate(old);
    expect(old.pragma("user_version", { simple: true })).toBe(migrations.length);
    const cols = (old.prepare("PRAGMA table_info(ads)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["creative_hash", "done_at", "work_points"]));
    expect(old.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'ads_creative_hash'").get()).toBeTruthy();
    expect(getAds(batchId).map((a) => [a.id, a.key])).toEqual(before);
    expect(getAds(batchId).every((a) => (a as { creative_hash?: string | null }).creative_hash === null)).toBe(true);
    migrate(old); // a second process starting at the same time: nothing to do
    expect(old.pragma("user_version", { simple: true })).toBe(migrations.length);
    old.close();
  });
});
