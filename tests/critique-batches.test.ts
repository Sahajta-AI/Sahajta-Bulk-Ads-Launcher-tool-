import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { runBatch } from "@/lib/engine/launcher";
import { launchSummary, queueGoLive } from "@/lib/manage/golive";
import { saveAppSettings } from "@/lib/appsettings";
import { clientFor } from "@/lib/meta/factory";
import { FakeClock, MockMeta } from "@/lib/meta/mock";
import { localFiles } from "@/lib/sources/local";
import { batchLaunchSummary, batchView, launchBatch, runPreview, updateAdOverride, updateSettings } from "@/lib/service";
import { getAds, getBatch, updateBatch } from "@/lib/store";
import type { CopyOverride } from "@/lib/types";
import { fifteenFileFolder, freshDb, setupBatch } from "./helpers";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Second opinion on tests/audit-batches.test.ts (18 Nov 2026). These tests CONFIRMED the behaviour of
// 18 Nov. After the fixes of 19 Nov (Group BATCH) the tests marked FIXED check the corrected behaviour
// instead; the name says what changed.

process.env.META_MOCK = "1";
const g = globalThis as unknown as { __mockMeta?: MockMeta };
let folder: string;
let clock: FakeClock;
let mock: MockMeta;

beforeAll(async () => {
  folder = await fifteenFileFolder();
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith("https://example.com/dead")) return Promise.resolve(new Response("gone", { status: 404 }));
    return u.startsWith("https://example.com") ? Promise.resolve(new Response("ok")) : real(url, init);
  });
}, 120_000);

beforeEach(() => {
  freshDb();
  clock = new FakeClock();
  mock = new MockMeta({ clock, capPoints: 9000, richAccount: true, allowActive: true, videoProcessingMs: 1000 });
  g.__mockMeta = mock;
});

async function batch() {
  const { accountId, batchId } = await setupBatch(folder);
  db().prepare("UPDATE ad_accounts SET is_default = 1 WHERE id = ?").run(accountId);
  const deps = { client: clientFor(accountId), files: localFiles, clock, accountDbId: accountId, tmpDir: fs.mkdtempSync(path.join(os.tmpdir(), "critique-batches-")) };
  return { accountId, batchId, key: getBatch(batchId)!.key, deps };
}

describe("Finding 1: what each path shows", () => {
  it("FIXED (B1): a per-ad copy edit on the page (PATCH items → batchView without dest) keeps the Dynamic creative error, without asking Meta", async () => {
    const { batchId, key } = await batch();
    updateBatch(batchId, { adset_id: "as2", adset_name: "Dynamic creative ad set" });
    expect((await batchView(key, { withDestination: true })).preview.errors).toBeGreaterThan(0);
    const ad = getAds(batchId)[0];
    updateAdOverride(key, ad.id, { copy: { headlines: ["New"] } });
    const before = mock.calls.length;
    const shown = await batchView(key); // what the items route returns and the page sets
    expect(mock.calls.length).toBe(before);
    expect(shown.destChecked).toBe(true);
    expect(shown.preview.batchChecks.map((c) => c.code)).toContain("dynamic_creative");
  }, 60_000);

  it("FIXED (B1): Claude's preview_batch (POST /preview) shows the Instagram error, and the summary names it too", async () => {
    g.__mockMeta = mock = new MockMeta({ clock, capPoints: 9000, richAccount: true, allowActive: true, videoProcessingMs: 1000, igNotAllowed: true });
    const { key } = await batch();
    const v = await runPreview(key);
    expect(v.preview.batchChecks.map((c) => c.code)).toContain("ig_not_allowed");
    const sum = await batchLaunchSummary(key);
    expect(sum.connection.problems.join(" ")).toMatch(/not allowed to use Instagram/);
  }, 60_000);

  it("FIXED (B1): when Meta refuses the ad-count read (e.g. rate limit), the view says the 50-ad check couldn't run (a warning, not a silent pass)", async () => {
    const { key } = await batch();
    for (let i = 0; i < 45; i++) mock.objects.set(`old${i}`, { _type: "ad", id: `old${i}`, name: `Old ad ${i}`, adset_id: "as1", status: "PAUSED", effective_status: "PAUSED" });
    mock.inject({ match: (m, p) => m === "GET" && p === "as1/ads", kind: "error", error: { message: "User request limit reached", code: 17, error_subcode: 2446079 } });
    const v = await batchView(key, { withDestination: true });
    const codes = [...v.preview.batchChecks, ...v.ads.flatMap((a) => a.checks)].map((c) => c.code);
    expect(codes).not.toContain("adset_full");
    const unchecked = v.preview.batchChecks.filter((c) => c.code === "dest_unchecked");
    expect(unchecked.map((c) => c.level)).toEqual(["warning"]);
    expect(unchecked[0].message).toMatch(/Couldn't check how many ads .* already holds/);
  }, 60_000);
});

describe("Finding 2: main ad set also in the extras", () => {
  it("FIXED (B2): the pre-launch summary counts that ad set's budget once (₹800)", async () => {
    const { batchId, key } = await batch();
    await updateSettings(key, { extraAdsetIds: ["as4"] });
    await updateSettings(key, { adsetId: "as4" });
    const s = await launchSummary(getBatch(batchId)!, { mode: "now" });
    expect(s.totalDailyBudget).toBe(800);
    expect(s.adCount).toBe(9);
  }, 60_000);
});

describe("Suspected: lifetime budgets", () => {
  it("FIXED (B8): a ₹30,000 lifetime budget ad set counts as lifetime ÷ days left, is shown on its own, and a ₹400 daily ceiling stops it", async () => {
    const { key } = await batch();
    const end = new Date(Date.now() + 5 * 86_400_000 + 3_600_000).toISOString(); // 5 whole days left (days round down)
    Object.assign(mock.objects.get("as1")!, { daily_budget: "0", lifetime_budget: "3000000", end_time: end });
    saveAppSettings({ dailyBudgetCeiling: 400 }, "critique@example.com");
    await updateSettings(key, { goLive: "now" });
    const sum = await batchLaunchSummary(key);
    expect(sum.launch!.totalDailyBudget).toBe(6000);
    expect(sum.launch!.spendConfirmation).toBe("₹6,000");
    expect(sum.launch!.lifetimeBudgets.join(" ")).toMatch(/₹30,000 lifetime, ends .* \(counted as ₹6,000 a day\)/);
    await expect(launchBatch(key, { confirm: true, acceptWarnings: true, spendConfirmation: "₹0" })).rejects.toThrow(/ceiling of ₹400/);
  }, 60_000);
});

describe("Suspected: go-live after the scheduled time passed", () => {
  it("FIXED (B9): once every ad is in more than an hour after the set time, the turn-on plan is a draft that needs a new confirmation", async () => {
    const { batchId, key, deps } = await batch();
    await updateSettings(key, { goLive: "at", goLiveAt: new Date(Date.now() + 3600_000).toISOString() });
    updateBatch(batchId, { status: "queued", go_live_total: "₹500" } as never);
    await runBatch(batchId, deps);
    const setTime = new Date(Date.now() - 3 * 86_400_000).toISOString(); // a Retry three days after the set time
    updateBatch(batchId, { go_live_at: setTime, late_retry_from: setTime, retried_at: new Date().toISOString() } as never);
    const msg = await queueGoLive(batchId);
    expect(msg).toMatch(/Ads created but NOT turned on: more than an hour passed between the time set to turn them on .* and the Retry/);
    expect(db().prepare("SELECT status FROM plans ORDER BY id DESC LIMIT 1").pluck().get()).toBe("draft");
    expect(db().prepare("SELECT COUNT(*) FROM jobs WHERE kind = 'plan'").pluck().get()).toBe(0);
  }, 120_000);
});

describe("Missed: the web 'Change copy for this ad' editor", () => {
  it("CONFIRMS: saving the editor (PreviewTable body) drops a carousel format that Claude set", async () => {
    const { batchId, key } = await batch();
    const two = getAds(batchId).find((a) => db().prepare("SELECT COUNT(*) FROM assets WHERE ad_id = ?").pluck().get(a.id) === 2)!;
    updateAdOverride(key, two.id, { copy: { format: "carousel" } });
    const o = (await batchView(key)).ads.find((a) => a.id === two.id)!.override as CopyOverride;
    // The body PreviewTable.tsx:37-41 builds from the ad's override (no `format` field):
    const copy: CopyOverride = { primaryTexts: ["Edited"], headlines: o.headlines ?? [], descriptions: o.descriptions ?? [], linkUrl: o.linkUrl ?? "", displayLink: o.displayLink ?? "", leadFormId: o.leadFormId ?? "", cta: o.cta ?? "" };
    updateAdOverride(key, two.id, { copy, angle: "" });
    expect(JSON.parse(getAds(batchId).find((a) => a.id === two.id)!.copy_override ?? "{}").format).toBeUndefined();
  }, 60_000);
});

describe("Suspected: expired login before a paused launch", () => {
  it("FIXED (B12): launchBatch (paused) refuses with 'Reconnect Meta' when the stored login has expired", async () => {
    const { accountId, batchId, key } = await batch();
    db().prepare("UPDATE ad_accounts SET token_expires_at = ? WHERE id = ?").run(Date.now() - 60_000, accountId);
    await expect(launchBatch(key, { confirm: true, acceptWarnings: true })).rejects.toThrow(/Reconnect Meta/);
    expect(getBatch(batchId)!.status).toBe("draft");
  }, 60_000);
});
