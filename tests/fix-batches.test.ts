import { beforeAll, beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { db } from "@/lib/db";
import { config } from "@/lib/config";
import { saveAppSettings } from "@/lib/appsettings";
import { removeBatchFiles, sweepFiles } from "@/lib/cleanup";
import { runBatch } from "@/lib/engine/launcher";
import { buildPreview, checkLinks, removeAsset } from "@/lib/engine/preview";
import { dailyEquivalent, launchSummary, queueGoLive, siblings } from "@/lib/manage/golive";
import { istTime } from "@/lib/manage/objects";
import { clientFor } from "@/lib/meta/factory";
import { FakeClock, MockMeta } from "@/lib/meta/mock";
import { driveFiles } from "@/lib/sources/drive";
import { localFiles } from "@/lib/sources/local";
import {
  batchLaunchSummary,
  batchView,
  cancelBatch,
  connectionSummary,
  createBatch,
  CTA_TYPES,
  deleteDraft,
  launchBatch,
  listIdentities,
  retryFailed,
  runPreview,
  saveCopyTemplate,
  savePreset,
  setAdCopyBy,
  updateAdOverride,
  updateSettings,
} from "@/lib/service";
import { newBatch } from "@/lib/setup";
import { getAds, getBatch, updateBatch } from "@/lib/store";
import { COPY, fifteenFileFolder, freshDb, setupBatch } from "./helpers";

// Group BATCH fixes (19 Nov 2026): one test per fix of the batch launch flow (B1–B16, R7).

process.env.META_MOCK = "1";
const g = globalThis as unknown as { __mockMeta?: MockMeta };
let folder: string;
let clock: FakeClock;
let mock: MockMeta;
const THROTTLE = { message: "User request limit reached", code: 17, error_subcode: 2446079, is_transient: true };
const LEAD = { ...COPY, leadFormId: "555000111" };

beforeAll(async () => {
  folder = await fifteenFileFolder();
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith("https://example.com/dead")) return Promise.resolve(new Response("gone", { status: 404 }));
    return u.startsWith("https://example.com") ? Promise.resolve(new Response("ok")) : real(url, init);
  });
}, 120_000);

function fakeMeta(extra: Partial<ConstructorParameters<typeof MockMeta>[0]> = {}) {
  mock = new MockMeta({ clock, capPoints: 9000, richAccount: true, allowActive: true, videoProcessingMs: 1000, ...extra });
  g.__mockMeta = mock;
}

beforeEach(() => {
  freshDb();
  clock = new FakeClock();
  fakeMeta();
});

async function batch(copy: object = LEAD) {
  const { accountId, batchId } = await setupBatch(folder);
  db().prepare("UPDATE ad_accounts SET is_default = 1 WHERE id = ?").run(accountId);
  updateBatch(batchId, { copy: JSON.stringify(copy) });
  const deps = { client: clientFor(accountId), files: localFiles, clock, accountDbId: accountId, tmpDir: fs.mkdtempSync(path.join(os.tmpdir(), "fix-batches-")) };
  return { accountId, batchId, key: getBatch(batchId)!.key, deps };
}
const codes = (v: { preview: { batchChecks: { code: string }[]; ads: { checks: { code: string }[] }[] } }) => [...v.preview.batchChecks, ...v.preview.ads.flatMap((a) => a.checks)].map((c) => c.code);

describe("B1 destination checks reach the view and the launch", () => {
  it("runPreview's view carries the destination checks and launchBatch refuses on them", async () => {
    const { batchId, key } = await batch();
    updateBatch(batchId, { adset_id: "as2", adset_name: "Dynamic creative ad set" });
    const v = await runPreview(key);
    expect(v.destChecked).toBe(true);
    expect(codes(v)).toContain("dynamic_creative");
    await expect(launchBatch(key, { confirm: true, acceptWarnings: true })).rejects.toThrow(/Dynamic creative/);
  }, 60_000);

  it("a view without options (polls, copy/move/items, PATCH) reuses the checks of the last 2 minutes and asks Meta nothing", async () => {
    const { batchId, key } = await batch();
    updateBatch(batchId, { adset_id: "as2", adset_name: "Dynamic creative ad set" });
    await batchView(key, { withDestination: true });
    const before = mock.calls.length;
    const v = await batchView(key);
    expect(mock.calls.length).toBe(before);
    expect(v.destChecked).toBe(true);
    expect(codes(v)).toContain("dynamic_creative");
    // Another ad set: the old checks don't fit, so they are not shown as if checked.
    await updateSettings(key, { adsetId: "as1" });
    expect((await batchView(key)).destChecked).toBe(false);
  }, 60_000);

  it("a rate-limited ad-set read is a warning 'Couldn't check …', never a silent pass", async () => {
    const { key } = await batch();
    mock.inject({ match: (m, p) => m === "GET" && p === "as1/ads", kind: "error", error: THROTTLE });
    const v = await batchView(key, { withDestination: true });
    const w = v.preview.batchChecks.find((c) => c.code === "dest_unchecked");
    expect(w?.level).toBe("warning");
    expect(w?.message).toMatch(/Couldn't check how many ads "November test ad set" already holds/);
  }, 60_000);

  it("the Instagram list is read again before blocking (the person may just have fixed it)", async () => {
    fakeMeta({ igNotAllowed: true });
    const { key } = await batch();
    expect(codes(await batchView(key, { withDestination: true }))).toContain("ig_not_allowed");
    // Fixed in Business settings: the next launch reads the list again and is not blocked by the 30-minute cache.
    (mock as unknown as { o: { igNotAllowed: boolean } }).o.igNotAllowed = false;
    const v = await launchBatch(key, { confirm: true, acceptWarnings: true });
    expect(v.status).toBe("queued");
  }, 60_000);

  it("acceptWarnings as a number: a launch that finds more warnings than were seen is refused, naming the new one", async () => {
    const { batchId, key } = await batch();
    const seen = (await runPreview(key)).preview.warnings;
    updateBatch(batchId, { copy: JSON.stringify({ ...LEAD, linkUrl: "https://example.com/dead" }) });
    await expect(launchBatch(key, { confirm: true, acceptWarnings: seen })).rejects.toThrow(/new warning.*since you checked[\s\S]*answered with error 404/);
    expect(getBatch(batchId)!.status).toBe("draft");
  }, 60_000);

  it("acceptWarnings: true still refuses a landing page that first fails at launch; after it was shown, the launch goes", async () => {
    const { batchId, key } = await batch();
    await batchView(key, { withDestination: true });
    updateBatch(batchId, { copy: JSON.stringify({ ...LEAD, linkUrl: "https://example.com/dead" }) });
    await expect(launchBatch(key, { confirm: true, acceptWarnings: true })).rejects.toThrow(/since you checked/);
    expect((await launchBatch(key, { confirm: true, acceptWarnings: true })).status).toBe("queued");
  }, 60_000);

  it("an extra ad set with Dynamic creative is an error in the main batch's own view", async () => {
    const { key } = await batch();
    await updateSettings(key, { extraAdsetIds: ["as2"] });
    const v = await batchView(key, { withDestination: true });
    expect(v.preview.batchChecks.find((c) => c.code === "dynamic_creative")?.message).toMatch(/Extra ad set "Dynamic creative ad set"/);
  }, 60_000);
});

describe("B2 the main ad set is never also an extra", () => {
  it("changing only the main ad set drops it from the extras; the summary counts each ad set once", async () => {
    const { batchId, key } = await batch();
    await updateSettings(key, { extraAdsetIds: ["as4", "as1"] });
    expect(JSON.parse(getBatch(batchId)!.extra_adsets).map((x: { id: string }) => x.id)).toEqual(["as4"]);
    await updateSettings(key, { adsetId: "as4" });
    expect(JSON.parse(getBatch(batchId)!.extra_adsets)).toEqual([]);
    // Old rows may still hold the main one: the summary and the launch skip it.
    updateBatch(batchId, { extra_adsets: JSON.stringify([{ id: "as4", name: "x", campaignId: "c1", campaignName: "c" }]) });
    const s = await launchSummary(getBatch(batchId)!, { mode: "now" });
    expect(s.adsets).toHaveLength(1);
    expect(s.totalDailyBudget).toBe(800);
  }, 60_000);
});

describe("B3 stopping a launch into several ad sets", () => {
  it("cancelBatch stops every queued batch of the group and names them; the go-live is skipped", async () => {
    const { batchId, key } = await batch();
    await updateSettings(key, { extraAdsetIds: ["as4"] });
    await launchBatch(key, { confirm: true, acceptWarnings: true });
    const sib = siblings(getBatch(batchId)!).find((b) => b.id !== batchId)!;
    const r = cancelBatch(key);
    expect(r.cancelled.map((c) => c.key).sort()).toEqual([key, sib.key].sort());
    expect(r.cancelled.find((c) => c.key === sib.key)!.adsetName).toBe(sib.adset_name);
    expect(getBatch(sib.id)!.status).toBe("failed");
    expect(db().prepare("SELECT COUNT(*) FROM jobs WHERE status = 'queued'").pluck().get()).toBe(0);
    updateBatch(batchId, { go_live: "now" });
    db().prepare("UPDATE ads SET status = 'done' WHERE batch_id = ?").run(batchId);
    expect(await queueGoLive(batchId)).toMatch(/stopped/);
    expect(db().prepare("SELECT COUNT(*) FROM plans").pluck().get()).toBe(0);
  }, 60_000);
});

describe("B4 / 1815199: retry with another settings preset", () => {
  it("the preset of a failed batch can change; a creative made with the old one is made again ('v2')", async () => {
    const { batchId, key } = await batch();
    updateBatch(batchId, { status: "failed" });
    const ad = getAds(batchId)[0];
    db().prepare("UPDATE ads SET status = 'failed', meta_creative_id = 'cr9', attempts = '{\"creative\":1}' WHERE id = ?").run(ad.id);
    savePreset({ name: "No Instagram", pageId: "p1", pageName: "Sahajta AI", igUserId: "", igName: "" });
    await updateSettings(key, { presetId: "No Instagram" });
    const after = getAds(batchId)[0];
    expect(JSON.parse(getBatch(batchId)!.preset!).name).toBe("No Instagram");
    expect(after.meta_creative_id).toBeNull();
    expect(JSON.parse(after.attempts).copy_gen).toBe(1);
    await expect(updateSettings(key, { adsetId: "as4" })).rejects.toThrow(/can't change/);
  });
});

describe("B5 the start-of-run check", () => {
  it("an expired login at the start marks the ads failed with 'Reconnect Meta' instead of throwing Meta's words", async () => {
    const { batchId, deps } = await batch();
    const expired = { message: "Error validating access token: Session has expired.", type: "OAuthException", code: 190, error_subcode: 463 };
    for (let i = 0; i < 6; i++) mock.inject({ match: (m, p) => m === "GET" && /^act_1001\/(ads|adsets|adcreatives)$/.test(p), kind: "error", error: expired });
    expect(await runBatch(batchId, deps)).toEqual({ done: 0, failed: 9 });
    expect(getAds(batchId)[0].error).toMatch(/Reconnect Meta/);
    expect(getBatch(batchId)!.status).toBe("failed");
  }, 60_000);
});

describe("B6 per-ad copy from Claude and the sheet", () => {
  it("merges: fields left out keep the ad's values, '' clears, format and lead form stay", async () => {
    const { batchId, key } = await batch();
    const ad = getAds(batchId)[0];
    updateAdOverride(key, ad.id, { copy: { format: "carousel", leadFormId: "42", primaryTexts: ["Own"], headlines: ["Own head"] } });
    setAdCopyBy(key, [{ ad: ad.position, copy: { headlines: ["New head"] } }, { ad: ad.position, angle: "price" }]);
    let o = JSON.parse(getAds(batchId)[0].copy_override!);
    expect(o).toMatchObject({ format: "carousel", leadFormId: "42", primaryTexts: ["Own"], headlines: ["New head"] });
    expect(getAds(batchId)[0].angle).toBe("price");
    setAdCopyBy(key, [{ ad: ad.position, copy: { primaryTexts: [] } }]);
    o = JSON.parse(getAds(batchId)[0].copy_override!);
    expect(o.primaryTexts).toBeUndefined();
  });

  it("one bad row saves nothing and the error names the row; a row with neither copy nor angle gets a plain message", async () => {
    const { batchId, key } = await batch();
    expect(() => setAdCopyBy(key, [{ ad: 1, copy: { primaryTexts: ["x"] } }, { ad: 2, copy: { cta: "CALL_NOW" } }])).toThrow(/Row 2 \(ad 2\).*unknown call-to-action/);
    expect(getAds(batchId).find((a) => a.position === 1)!.copy_override).toBeNull();
    expect(() => setAdCopyBy(key, [{ ad: 1 } as never])).toThrow(/Row 1 \(ad 1\): has no copy or angle/);
  });

  it("the items route (updateAdOverride) still replaces: 'Use the batch copy again' sends copy: {}", async () => {
    const { batchId, key } = await batch();
    const ad = getAds(batchId)[0];
    updateAdOverride(key, ad.id, { copy: { primaryTexts: ["Own"] } });
    updateAdOverride(key, ad.id, { copy: {} });
    expect(getAds(batchId)[0].copy_override).toBeNull();
  });
});

describe("B7 go-live time without a zone", () => {
  it("is India time and is stored with its zone", async () => {
    const { batchId, key } = await batch();
    await updateSettings(key, { goLive: "at", goLiveAt: "2026-12-20T09:00" });
    expect(getBatch(batchId)!.go_live_at).toBe("2026-12-20T09:00:00+05:30");
    expect(istTime(getBatch(batchId)!.go_live_at!)).toMatch(/09:00 am IST/i);
    await expect(updateSettings(key, { goLiveAt: "next tuesday" })).rejects.toThrow(/not a date and time/);
  });
});

describe("B8 lifetime budgets", () => {
  it("dailyEquivalent = daily + lifetime ÷ whole days left (a part day dropped, at least 1)", () => {
    const now = Date.parse("2026-11-19T00:00:00Z");
    expect(dailyEquivalent(500, null, null, null, now)).toBe(500);
    expect(dailyEquivalent(null, 30000, "2026-11-24T00:00:00Z", null, now)).toBe(6000);
    expect(dailyEquivalent(null, 30000, "2026-11-19T05:00:00Z", null, now)).toBe(30000);
    expect(dailyEquivalent(null, 30000, "2026-11-29T00:00:00Z", "2026-11-24T00:00:00Z", now)).toBe(6000);
    // A part day above one: Meta can spend most of a ₹10,000 lifetime budget ending in 25 hours in the
    // first day, so it counts in full; 49 hours counts as 2 days.
    expect(dailyEquivalent(null, 10000, "2026-11-20T01:00:00Z", null, now)).toBe(10000);
    expect(dailyEquivalent(null, 10000, "2026-11-21T01:00:00Z", null, now)).toBe(5000);
    expect(dailyEquivalent(null, 10000, "2026-11-23T23:00:00Z", null, now)).toBe(2500); // 4 days 23 hours: 4 days
    // The same within a day: 4 hours later it is still 4 whole days.
    expect(dailyEquivalent(null, 30000, "2026-11-24T00:00:00Z", null, now + 4 * 3600_000)).toBe(7500);
    expect(dailyEquivalent(null, 30000, "2026-11-24T00:00:00Z", null, now + 23 * 3600_000)).toBe(7500);
  });

  it("a lifetime ad set and a lifetime campaign budget are counted, shown on their own, and checked against the ceiling", async () => {
    const { key } = await batch();
    const end = new Date(Date.now() + 10 * 86_400_000 + 3600_000).toISOString(); // 10 whole days (and an hour) left
    Object.assign(mock.objects.get("as1")!, { daily_budget: "0", lifetime_budget: "5000000", end_time: end }); // ₹50,000 over 10 days
    await updateSettings(key, { goLive: "now" });
    const s = (await batchLaunchSummary(key)).launch!;
    expect(s.spendConfirmation).toBe("₹5,000");
    expect(s.lifetimeBudgets[0]).toMatch(/"November test ad set": ₹50,000 lifetime, ends .*counted as ₹5,000 a day/);
    saveAppSettings({ dailyBudgetCeiling: 1000 }, "t@example.com");
    await expect(launchBatch(key, { confirm: true, acceptWarnings: true, spendConfirmation: "₹5,000" })).rejects.toThrow(/ceiling of ₹1,000/);

    const c2 = mock.objects.get("c2")!;
    delete c2.daily_budget;
    Object.assign(c2, { lifetime_budget: "2000000", stop_time: end }); // ₹20,000 over 10 days
    const b2 = getBatch(getBatch(db().prepare("SELECT id FROM batches WHERE key = ?").pluck().get(key) as number)!.id)!;
    const s2 = await launchSummary({ ...b2, campaign_id: "c2", adset_id: "as3" }, { mode: "now" });
    expect(s2.spendConfirmation).toBe("₹2,000");
  }, 60_000);
});

describe("B9 the go-live after a Retry", () => {
  function allIn(batchId: number) {
    for (const [i, a] of getAds(batchId).entries()) {
      db().prepare("UPDATE ads SET status = 'done', meta_ad_id = ?, meta_adset_id = 'as1' WHERE id = ?").run(`9${i}`, a.id);
      mock.objects.set(`9${i}`, { id: `9${i}`, name: `Ad ${i}`, adset_id: "as1", status: "PAUSED", effective_status: "PAUSED", _type: "ad" } as never);
    }
  }

  // Updated in round 2: only the turn-on step runs again (a "golive" job), not the whole launch.
  it("Retry with no failed ad but a pending go-live queues the turn-on step (golive job) and resets the worker's tries", async () => {
    const { batchId, key } = await batch();
    allIn(batchId);
    updateBatch(batchId, { go_live: "now", status: "partial" });
    db().prepare("INSERT INTO cache (key, value, expires_at) VALUES (?, '12', ?)").run(`golive_retry:${batchId}:`, Date.now() + 3600_000);
    const r = retryFailed(key);
    expect(r).toMatchObject({ retried: 0, goLive: true });
    expect(db().prepare("SELECT COUNT(*) FROM jobs WHERE kind = 'golive' AND batch_id = ? AND status = 'queued'").pluck().get(batchId)).toBe(1);
    expect(db().prepare("SELECT COUNT(*) FROM jobs WHERE kind = 'launch' AND batch_id = ?").pluck().get(batchId)).toBe(0);
    expect(getBatch(batchId)!.status).toBe("done");
    expect(db().prepare("SELECT COUNT(*) FROM cache WHERE key LIKE 'golive_retry:%'").pluck().get()).toBe(0);
  });

  it("a go-live plan whose own check finds an error stays a draft, with an event and an alert", async () => {
    const { batchId } = await batch();
    allIn(batchId);
    updateBatch(batchId, { go_live: "now", status: "done" });
    saveAppSettings({ dailyBudgetCeiling: 100 }, "t@example.com");
    const msg = await queueGoLive(batchId);
    expect(msg).toMatch(/Ads created but NOT turned on/);
    expect(db().prepare("SELECT status FROM plans").pluck().get()).toBe("draft");
    expect(getBatch(batchId)!.go_live_done).toBe(1);
    expect(db().prepare("SELECT COUNT(*) FROM cache WHERE key LIKE 'alert:%' AND value LIKE '%NOT turned on%'").pluck().get()).toBe(1);
  });
});

describe("B10 presets and templates", () => {
  it("savePreset: a field left out keeps its value, '' clears it; saving with an existing exact name edits that preset", async () => {
    await batch();
    const id = savePreset({ name: "Main", pageId: "p1", pageName: "Page", igUserId: "ig1", igName: "ig", whatsappNumber: "+919812345678", threadsUserId: "1784", sponsorPageId: "5550" });
    savePreset({ id, name: "Main", enhancements: { add_text_overlay: "OPT_IN" } });
    savePreset({ name: "main", threadsUserId: "" });
    const rows = db().prepare("SELECT * FROM settings_presets WHERE lower(name) = 'main'").all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ig_user_id: "ig1", whatsapp_number: "+919812345678", threads_user_id: "", sponsor_page_id: "5550" });
  });

  it("names: exact first; several partial matches are refused with the list (ad sets with their campaign)", async () => {
    const { batchId, key } = await batch();
    savePreset({ name: "Sahajta + IG reels", pageId: "p1" });
    savePreset({ name: "Sahajta", pageId: "p1" });
    await updateSettings(key, { presetId: "sahajta" });
    expect(JSON.parse(getBatch(batchId)!.preset!).name).toBe("Sahajta");
    savePreset({ name: "Sahajta Two", pageId: "p1" });
    await expect(updateSettings(key, { presetId: "Sahaj" })).rejects.toThrow(/fits several settings presets/);
    await expect(updateSettings(key, { adsetId: "ad set" })).rejects.toThrow(/"November test ad set" in campaign "November tests"/);
  }, 60_000);

  it("a copy template saved again under its exact name is edited (one template), and left-out fields are kept", async () => {
    await batch();
    saveCopyTemplate({ name: "Site Visit", primaryTexts: ["old"], headlines: ["old"], linkUrl: "https://example.com", cta: "LEARN_MORE", leadFormId: "77" });
    saveCopyTemplate({ name: "site visit", headlines: ["new"] });
    const rows = db().prepare("SELECT * FROM copy_templates WHERE lower(name) = 'site visit'").all() as { headlines: string; primary_texts: string; lead_form_id: string }[];
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].headlines)).toEqual(["new"]);
    expect(JSON.parse(rows[0].primary_texts)).toEqual(["old"]);
    expect(rows[0].lead_form_id).toBe("77");
  });
});

describe("B11 identities and the connection status pass rate limits on", () => {
  it("a rate-limited Instagram read throws and is not cached; connectionSummary says Meta is limiting", async () => {
    await batch();
    mock.inject({ match: (m, p) => m === "GET" && p.endsWith("/instagram_accounts"), kind: "error", error: THROTTLE });
    await expect(listIdentities(true)).rejects.toThrow(/Meta is limiting/);
    expect(db().prepare("SELECT COUNT(*) FROM cache WHERE key LIKE 'ident:%'").pluck().get()).toBe(0);
    await expect(connectionSummary()).rejects.toThrow(/Meta is limiting/);
  });

  it("an Instagram list Meta refuses for another reason is not cached as 'none allowed'", async () => {
    await batch();
    mock.inject({ match: (m, p) => m === "GET" && p.endsWith("/instagram_accounts"), kind: "error", error: { message: "Unsupported get request", code: 100 } });
    mock.inject({ match: (m, p) => m === "GET" && p.endsWith("/instagram_accounts"), kind: "error", error: { message: "Unsupported get request", code: 100 } });
    const ids = await listIdentities(true);
    expect(ids.instagramKnown).toBe(false);
    expect(db().prepare("SELECT COUNT(*) FROM cache WHERE key LIKE 'ident:%'").pluck().get()).toBe(0);
  });
});

describe("B12 smaller fixes", () => {
  it("a carousel with several primary texts warns that only the first is used", async () => {
    const { batchId, key } = await batch();
    const two = getAds(batchId).find((a) => db().prepare("SELECT COUNT(*) FROM assets WHERE ad_id = ?").pluck().get(a.id) === 2)!;
    updateAdOverride(key, two.id, { copy: { format: "carousel" } });
    const ad = buildPreview(batchId, {}, 9000).ads.find((a) => a.id === two.id)!;
    expect(ad.checks.find((c) => c.code === "carousel_texts")?.message).toMatch(/only the first primary text/);
  });

  it("an empty naming pattern names the ad after its creative", async () => {
    const { batchId, key } = await batch();
    await updateSettings(key, { adNameTemplate: "" });
    const ad = buildPreview(batchId, {}, 9000).ads[0];
    expect(ad.name).toBe(ad.creativeName);
  });

  it("one new ad set for the batch: an empty one left by a failed launch is reported", async () => {
    const { batchId } = await batch();
    updateBatch(batchId, { adset_mode: "new_shared", shared_adset_id: "999", status: "failed" });
    db().prepare("UPDATE ads SET status = 'failed' WHERE batch_id = ?").run(batchId);
    const left = buildPreview(batchId, {}, 9000).ads.filter((a) => a.leftover);
    expect(left).toHaveLength(1);
    expect(left[0].leftover).toMatch(/ID 999/);
  });

  it("launching with an expired Meta login is refused with 'Reconnect Meta'", async () => {
    const { accountId, key } = await batch();
    db().prepare("UPDATE ad_accounts SET token_expires_at = ? WHERE id = ?").run(Date.now() - 1000, accountId);
    await expect(launchBatch(key, { confirm: true, acceptWarnings: true })).rejects.toThrow(/Reconnect Meta/);
  });

  it("the ad count is kept 2 minutes for the view, read again at launch; the summary reads each ad set once", async () => {
    const { batchId, key } = await batch();
    await batchView(key, { withDestination: true });
    const n = () => mock.calls.filter((c) => c.path === "as1/ads").length;
    const before = n();
    await batchView(key, { withDestination: true });
    expect(n()).toBe(before);
    const reads = mock.calls.length;
    await launchSummary(getBatch(batchId)!, { mode: "paused" });
    expect(mock.calls.slice(reads).filter((c) => c.method === "GET" && c.path === "as1").length).toBe(1);
  }, 60_000);

  it("an extra ad set's batch reuses the main batch's Drive file when Meta already has it (no second download)", () => {
    const acc = Number(db().prepare("INSERT INTO ad_accounts (meta_account_id, name, is_default, token_enc) VALUES ('act_1001', 'x', 1, 'x')").run().lastInsertRowid);
    const main = newBatch(acc, null, { kind: "drive", ref: "folder1" });
    const sib = newBatch(acc, null, { kind: "drive", ref: "folder1" });
    for (const id of [main, sib]) updateBatch(id, { group_key: "grp1" });
    db().prepare("INSERT INTO assets (batch_id, source_kind, source_ref, filename, kind, size_bytes, sha256) VALUES (?, 'drive', 'FILE1', 'a.jpg', 'image', 10, 'sha-a')").run(main);
    const id = Number(db().prepare("INSERT INTO assets (batch_id, source_kind, source_ref, filename, kind, size_bytes) VALUES (?, 'drive', 'FILE1', 'a.jpg', 'image', 10)").run(sib).lastInsertRowid);
    db().prepare("INSERT INTO meta_media (ad_account_id, sha256, kind, image_hash, status) VALUES (?, 'sha-a', 'image', 'h1', 'ready')").run(acc);
    const asset = db().prepare("SELECT * FROM assets WHERE id = ?").get(id) as Parameters<typeof driveFiles.ensureLocal>[0];
    // No owner: a download would throw. The main batch's upload is reused instead.
    return expect(driveFiles.ensureLocal(asset)).resolves.toMatchObject({ sha256: "sha-a" });
  });
});

describe("B13 the copy fits the ad set", () => {
  it("an Instant form ad set without a lead form is an error (Meta refuses the ads)", async () => {
    fakeMeta({ leadFormRule: true });
    const { batchId, key } = await batch(COPY);
    const v = await batchView(key, { withDestination: true });
    expect(v.preview.batchChecks.find((c) => c.code === "lead_form_needed")?.message).toMatch(/collects leads with an Instant form.*the copy has none/);
    await expect(launchBatch(key, { confirm: true, acceptWarnings: true })).rejects.toThrow(/lead form/);
    // With the lead form, the launch goes and Meta (lead form rule on) takes the ads.
    updateBatch(batchId, { copy: JSON.stringify(LEAD) });
    expect((await launchBatch(key, { confirm: true, acceptWarnings: true })).status).toBe("queued");
  }, 60_000);

  it("a WhatsApp ad set needs the WhatsApp button; a lead form going into a non-lead extra ad set is an error", async () => {
    Object.assign(mock.objects.get("as4")!, { destination_type: "WHATSAPP", optimization_goal: "CONVERSATIONS" });
    const { batchId, key } = await batch();
    updateBatch(batchId, { adset_id: "as4", adset_name: "Min-spend template" });
    expect(codes(await batchView(key, { withDestination: true }))).toContain("whatsapp_button");
    updateBatch(batchId, { adset_id: "as1", adset_name: "November test ad set" });
    await updateSettings(key, { extraAdsetIds: ["as4"] });
    const c = (await batchView(key, { withDestination: true })).preview.batchChecks.find((x) => x.code === "lead_form_unused");
    expect(c?.level).toBe("error");
  }, 60_000);

  it("CALL_NOW, GET_DIRECTIONS and MESSAGE_PAGE are not offered until the launcher sends what they need", () => {
    for (const t of ["CALL_NOW", "GET_DIRECTIONS", "MESSAGE_PAGE"]) expect(CTA_TYPES).not.toContain(t);
  });
});

describe("B14 creating a batch", () => {
  it("an unknown ad set makes no batch", async () => {
    await batch();
    const n = db().prepare("SELECT COUNT(*) FROM batches").pluck().get();
    await expect(createBatch("test@example.com", { adsetId: "no such ad set" })).rejects.toThrow(/Couldn't find an ad set/);
    expect(db().prepare("SELECT COUNT(*) FROM batches").pluck().get()).toBe(n);
  });
});

describe("B15 cleanup (safe rules)", () => {
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "fix-batches-data-"));
  const saved = process.env.DATA_DIR;
  beforeEach(() => {
    process.env.DATA_DIR = DATA;
  });
  afterEach(() => {
    process.env.DATA_DIR = saved;
  });
  const ACC = () => Number(db().prepare("INSERT INTO ad_accounts (meta_account_id, name, is_default, token_enc) VALUES ('act_1001', 'x', 1, 'x')").run().lastInsertRowid);
  function upload(batchId: number | null, name: string, ageHours = 0): string {
    fs.mkdirSync(config.uploadsDir, { recursive: true });
    const f = path.join(config.uploadsDir, `${name}-${Math.random().toString(36).slice(2)}`);
    fs.writeFileSync(f, Buffer.alloc(1024));
    fs.writeFileSync(`${f}.json`, "{}");
    const t = new Date(Date.now() - ageHours * 3600_000);
    fs.utimesSync(f, t, t);
    fs.utimesSync(`${f}.json`, t, t);
    if (batchId) db().prepare("INSERT INTO assets (batch_id, source_kind, source_ref, filename, kind, size_bytes, local_path) VALUES (?, 'upload', ?, ?, 'image', 1024, ?)").run(batchId, path.basename(f), `${name}.jpg`, f);
    return f;
  }

  it("orphan uploads go after 48 hours (a tus upload in progress is kept); tmp/ files after 48 hours", () => {
    ACC();
    const old = upload(null, "orphan-old", 50);
    const young = upload(null, "orphan-young", 2);
    const tmp = path.join(config.dataDir, "tmp", "frame.jpg");
    fs.mkdirSync(path.dirname(tmp), { recursive: true });
    fs.writeFileSync(tmp, "x");
    const t = new Date(Date.now() - 50 * 3600_000);
    fs.utimesSync(tmp, t, t);
    sweepFiles();
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(`${old}.json`)).toBe(false);
    expect(fs.existsSync(young)).toBe(true);
    expect(fs.existsSync(tmp)).toBe(false);
  });

  it("deleting a draft or removing a file deletes the upload, unless another batch still points to it", () => {
    const acc = ACC();
    const a = newBatch(acc, "t@example.com");
    const b = newBatch(acc, "t@example.com");
    const shared = upload(a, "shared");
    db().prepare("INSERT INTO assets (batch_id, source_kind, source_ref, filename, kind, size_bytes, local_path) VALUES (?, 'upload', ?, 'shared.jpg', 'image', 1024, ?)").run(b, path.basename(shared), shared);
    const own = upload(a, "own");
    const ownId = db().prepare("SELECT id FROM assets WHERE local_path = ?").pluck().get(own) as number;
    removeAsset(a, ownId);
    expect(fs.existsSync(own)).toBe(false);
    deleteDraft(getBatch(a)!.key);
    expect(fs.existsSync(shared)).toBe(true);
    deleteDraft(getBatch(b)!.key);
    expect(fs.existsSync(shared)).toBe(false);
  });

  it("partly done launches: Drive downloads go after 7 days, uploads after 30 days when no batch needs them; a draft with a new file is kept", () => {
    const acc = ACC();
    const p = newBatch(acc, "t@example.com");
    const key = getBatch(p)!.key;
    const drive = path.join(config.filesDir, key, "F1_a.jpg");
    fs.mkdirSync(path.dirname(drive), { recursive: true });
    fs.writeFileSync(drive, "x");
    db().prepare("INSERT INTO assets (batch_id, source_kind, source_ref, filename, kind, size_bytes, local_path) VALUES (?, 'drive', 'F1', 'a.jpg', 'image', 1, ?)").run(p, drive);
    const up = upload(p, "partial-up");
    updateBatch(p, { status: "partial", finished_at: new Date(Date.now() - 8 * 86_400_000).toISOString() });
    sweepFiles();
    expect(fs.existsSync(drive)).toBe(false);
    expect(fs.existsSync(up)).toBe(true); // 8 days: the upload stays for a Retry
    updateBatch(p, { finished_at: new Date(Date.now() - 31 * 86_400_000).toISOString() });
    sweepFiles();
    expect(fs.existsSync(up)).toBe(false);
    expect(db().prepare("SELECT local_path FROM assets WHERE batch_id = ? AND source_kind = 'upload'").pluck().get(p)).toBeNull();
    // An old draft that just got a new file is not swept.
    const d = newBatch(acc, "t@example.com");
    db().prepare("UPDATE batches SET created_at = datetime('now', '-20 days') WHERE id = ?").run(d);
    const fresh = upload(d, "fresh");
    sweepFiles();
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it("a launched batch's removed files are marked gone (local_path cleared)", () => {
    const acc = ACC();
    const b = newBatch(acc, "t@example.com");
    const f = upload(b, "done-file");
    updateBatch(b, { status: "done" });
    removeBatchFiles(b);
    expect(fs.existsSync(f)).toBe(false);
    expect(db().prepare("SELECT local_path FROM assets WHERE batch_id = ?").pluck().get(b)).toBeNull();
  });
});

describe("B15 preview of a file no longer on the server", () => {
  it("is an error that says so", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fix-missing-"));
    fs.copyFileSync(path.join(folder, "static-price_1x1.jpg"), path.join(dir, "price_1x1.jpg"));
    const { batchId } = await setupBatch(dir);
    db().prepare("UPDATE assets SET source_kind = 'upload' WHERE batch_id = ?").run(batchId);
    fs.rmSync(path.join(dir, "price_1x1.jpg"));
    const ad = buildPreview(batchId, {}, 9000).ads[0];
    expect(ad.checks.find((c) => c.code === "file_missing")?.message).toMatch(/no longer on the server/);
  });
});

describe("B16 home alerts", () => {
  it("a Retry that creates every ad clears the batch's alerts", async () => {
    const { batchId, key, deps } = await batch();
    // Alerts now have a kind (READS round 2): a launch that ends with every ad in removes "ads not created" ones.
    db().prepare("INSERT INTO cache (key, value, expires_at) VALUES ('alert:1:x', ?, ?)").run(JSON.stringify({ to: "t", subject: "s", lines: [], link: `${config.appUrl}/batches/${key}`, kind: "create_failed" }), Date.now() + 86_400_000);
    db().prepare("INSERT INTO cache (key, value, expires_at) VALUES ('alert:2:y', ?, ?)").run(JSON.stringify({ to: "t", subject: "s", lines: [], link: `${config.appUrl}/batches/other`, kind: "create_failed" }), Date.now() + 86_400_000);
    expect(await runBatch(batchId, deps)).toEqual({ done: 9, failed: 0 });
    expect(db().prepare("SELECT key FROM cache WHERE key LIKE 'alert:%'").pluck().all()).toEqual(["alert:2:y"]);
  }, 120_000);
});

describe("R7 landing page wording", () => {
  it("no DNS record, a refused check and an error page each get their own words", async () => {
    const nx = (async () => {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND warm.example.org"), { code: "ENOTFOUND" }) });
    }) as unknown as typeof fetch;
    expect((await checkLinks(["https://warm.example.org/a"], nx)).get("https://warm.example.org/a")).toBe("The address warm.example.org does not exist (no DNS record). People clicking the ad would see an error page.");
    const status = (n: number) => (async () => new Response("x", { status: n })) as unknown as typeof fetch;
    expect((await checkLinks(["https://site.example.org/"], status(403))).get("https://site.example.org/")).toMatch(/refused the launcher's check.*open it in a browser/);
    expect((await checkLinks(["https://site.example.org/"], status(404))).get("https://site.example.org/")).toMatch(/answered with error 404/);
  });

  it("a landing page that doesn't load is a warning after the full check", async () => {
    const { batchId, key } = await batch();
    updateBatch(batchId, { copy: JSON.stringify({ ...LEAD, linkUrl: "https://example.com/dead" }) });
    const c = (await runPreview(key)).ads[0].checks.find((x) => x.code === "link_down");
    expect(c?.level).toBe("warning");
  }, 60_000);
});

describe("summary of a launched batch, and the short cache", () => {
  it("a launched batch's summary reads nothing from Meta; a draft's summary is kept a minute while nothing changes", async () => {
    const { batchId, key } = await batch();
    await batchLaunchSummary(key);
    const before = mock.calls.length;
    await batchLaunchSummary(key);
    expect(mock.calls.length).toBe(before);
    updateBatch(batchId, { status: "done" });
    const s = await batchLaunchSummary(key);
    expect(mock.calls.length).toBe(before);
    expect(s.launch).toBeNull();
  }, 60_000);
});
