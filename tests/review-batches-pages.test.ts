import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { db } from "@/lib/db";
import { runBatch } from "@/lib/engine/launcher";
import { buildPreview } from "@/lib/engine/preview";
import { launchSummary, queueGoLive, siblings } from "@/lib/manage/golive";
import { clientFor } from "@/lib/meta/factory";
import { FakeClock, MockMeta } from "@/lib/meta/mock";
import { localFiles } from "@/lib/sources/local";
import {
  batchLaunchSummary,
  batchView,
  cancelBatch,
  launchBatch,
  retryFailed,
  runPreview,
  saveCopyTemplate,
  savePreset,
  setAdCopyBy,
  updateAdOverride,
  updateSettings,
} from "@/lib/service";
import { getAds, getBatch, updateBatch } from "@/lib/store";
import { summaryKey } from "@/app/batches/[key]/batch-logic";
import { copyBody } from "@/app/settings/settings-logic";
import { COPY, fifteenFileFolder, freshDb, setupBatch } from "./helpers";

// Review probes (19 Nov 2026), batch launches and the pages. A failing test is a bug; each test is
// named after the behaviour the marketer should get.

process.env.META_MOCK = "1";
const g = globalThis as unknown as { __mockMeta?: MockMeta };
let folder: string;
let clock: FakeClock;
let mock: MockMeta;
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

beforeEach(() => {
  freshDb();
  clock = new FakeClock();
  mock = new MockMeta({ clock, capPoints: 9000, richAccount: true, allowActive: true, videoProcessingMs: 1000 });
  g.__mockMeta = mock;
});

async function batch(copy: object = LEAD) {
  const { accountId, batchId } = await setupBatch(folder);
  db().prepare("UPDATE ad_accounts SET is_default = 1 WHERE id = ?").run(accountId);
  updateBatch(batchId, { copy: JSON.stringify(copy) });
  const deps = { client: clientFor(accountId), files: localFiles, clock, accountDbId: accountId, tmpDir: fs.mkdtempSync(path.join(os.tmpdir(), "review-batches-")) };
  return { accountId, batchId, key: getBatch(batchId)!.key, deps };
}

const turnOnPlan = (key: string) => db().prepare("SELECT key, status, run_at FROM plans WHERE title LIKE ? ORDER BY id DESC LIMIT 1").get(`Turn on batch ${key} (%`) as { key: string; status: string; run_at: string | null } | undefined;

async function launchTurningOn(key: string) {
  const spend = (await batchLaunchSummary(key)).launch!.spendConfirmation!;
  return launchBatch(key, { confirm: true, acceptWarnings: true, spendConfirmation: spend });
}

describe("money: the go-live after Stop and Retry", () => {
  it("after Stop, 'Retry failed' creates the ads but does not turn them on without a fresh confirmation", async () => {
    const { batchId, key, deps } = await batch();
    await updateSettings(key, { goLive: "now" });
    expect((await launchTurningOn(key)).status).toBe("queued");
    cancelBatch(key); // "Ads already created stay paused; nothing is deleted or turned on."
    expect(getBatch(batchId)!.cancel_requested).toBe(1);
    retryFailed(key); // the page's "Retry the 9 failed ads only" (no confirm dialog)
    expect(await runBatch(batchId, deps)).toEqual({ done: 9, failed: 0 });
    await queueGoLive(batchId); // what the worker does next
    expect(turnOnPlan(key)?.status).toBe("draft");
  }, 120_000);

  it("a Retry days after a 'launch now' asks for a fresh confirmation before turning the ads on", async () => {
    const { batchId, key, deps } = await batch();
    updateBatch(batchId, { go_live: "now" });
    expect(await runBatch(batchId, deps)).toEqual({ done: 9, failed: 0 });
    const ad = getAds(batchId)[8];
    db().prepare("UPDATE ads SET status = 'failed', error = 'x' WHERE id = ?").run(ad.id);
    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000).toISOString();
    updateBatch(batchId, { status: "partial", launched_at: threeDaysAgo, finished_at: threeDaysAgo });
    expect(retryFailed(key).retried).toBe(1);
    expect(await runBatch(batchId, deps)).toEqual({ done: 9, failed: 0 });
    await queueGoLive(batchId);
    expect(turnOnPlan(key)?.status).toBe("draft");
  }, 120_000);

  it("Stop on a launch into several ad sets also stops the turn-on plan of a batch of the group that already finished", async () => {
    const { batchId, key, deps } = await batch();
    const at = new Date(Date.now() + 2 * 86_400_000).toISOString();
    await updateSettings(key, { extraAdsetIds: ["as4"], goLive: "at", goLiveAt: at });
    expect((await launchTurningOn(key)).status).toBe("queued");
    const sib = siblings(getBatch(batchId)!).find((b) => b.id !== batchId)!;
    // The launch lane runs the main batch first; it finishes and waits for the second ad set (round 3:
    // one turn-on plan for the whole launch, made once every ad of both is in).
    expect(await runBatch(batchId, deps)).toEqual({ done: 9, failed: 0 });
    expect(await queueGoLive(batchId)).toMatch(/waits for the other ad sets of this launch/);
    // The person presses "Stop the launch" while the second ad set is still waiting.
    const r = cancelBatch(key);
    // Probe fixed (round 2): `cancelled` now also lists the turn-on plans Stop cancelled, so only the launches are compared here.
    expect(r.cancelled.filter((c) => c.result === "cancelled" || c.result === "stopping").map((c) => c.key)).toEqual([sib.key]);
    // The finished batch is named too, and nothing will turn it on.
    expect(r.cancelled.find((c) => c.key === key)?.result).toBe("turn_on_cancelled");
    expect(await queueGoLive(batchId)).toMatch(/skipped: the launch was stopped/);
    expect(turnOnPlan(key)).toBeUndefined();
  }, 120_000);

  it("stopping a 'turn the ads on again' retry leaves a batch whose ads are all created as done, not 'Some ads failed'", async () => {
    const { batchId, key, deps } = await batch();
    updateBatch(batchId, { go_live: "now" });
    expect(await runBatch(batchId, deps)).toEqual({ done: 9, failed: 0 });
    expect(retryFailed(key)).toMatchObject({ retried: 0, goLive: true });
    cancelBatch(key);
    expect(getBatch(batchId)!.status).toBe("done");
  }, 120_000);
});

describe("the launch summary on the page", () => {
  it("summaryKey changes when ads are added in 'a new ad set per ad' mode (the total is per ad)", async () => {
    const { batchId, key } = await batch();
    await updateSettings(key, { adsetMode: "new_per_ad", goLive: "now" });
    const v = await batchView(key);
    // The server's total grows with the number of ads in this mode…
    const all = await launchSummary(getBatch(batchId)!, { mode: "now" });
    const ads = getAds(batchId);
    db().prepare("DELETE FROM assets WHERE ad_id = ?").run(ads[ads.length - 1].id);
    db().prepare("DELETE FROM ads WHERE id = ?").run(ads[ads.length - 1].id);
    const fewer = await launchSummary(getBatch(batchId)!, { mode: "now" });
    expect(all.totalDailyBudget).toBeGreaterThan(fewer.totalDailyBudget);
    // …so the page must ask for the summary again when the number of ads changes.
    const before = summaryKey({ ...v, ads: v.ads.slice(0, -1) } as typeof v);
    const after = summaryKey(v);
    expect(after).not.toBe(before);
  }, 120_000);
});

describe("the launch decision", () => {
  it("acceptWarnings as a number refuses a landing page that first fails at launch, even when another warning went away", async () => {
    const { batchId, key } = await batch();
    await updateSettings(key, { adNameTemplate: "{creative} {nosuchword}" });
    const seen = (await runPreview(key)).preview.warnings; // includes the naming-template warning
    await updateSettings(key, { adNameTemplate: "{creative}" }); // that warning goes away
    updateAdOverride(key, getAds(batchId)[0].id, { copy: { linkUrl: "https://example.com/dead" } }); // a new one comes at launch
    expect((await runPreview(key, { remember: false })).preview.warnings).toBe(seen); // same count, other warnings
    await expect(launchBatch(key, { confirm: true, acceptWarnings: seen })).rejects.toThrow(/new warning/);
  }, 120_000);
});

describe("the Instagram check at launch", () => {
  it("a failed re-read of the Instagram list keeps the known 'not allowed' error (the launch is refused for it)", async () => {
    mock = new MockMeta({ clock, capPoints: 9000, richAccount: true, allowActive: true, videoProcessingMs: 1000, igNotAllowed: true });
    g.__mockMeta = mock;
    const { key } = await batch();
    const v = await batchView(key, { withDestination: true });
    expect(v.preview.batchChecks.map((c) => c.code)).toContain("ig_not_allowed");
    // Meta has a hiccup (not a rate limit) on the Instagram list during both launch attempts.
    const perm = { message: "(#10) Application does not have permission for this action", code: 10, type: "OAuthException" };
    for (let i = 0; i < 6; i++) mock.inject({ match: (m, p) => m === "GET" && p === "act_1001/instagram_accounts", kind: "error", error: perm });
    await expect(launchBatch(key, { confirm: true, acceptWarnings: true })).rejects.toThrow(); // "1 new warning: Couldn't check…"
    await expect(launchBatch(key, { confirm: true, acceptWarnings: true })).rejects.toThrow(/not allowed to use Instagram/);
  }, 120_000);
});

describe("per-ad copy after a failed launch", () => {
  it("a row from Claude that only sets the angle keeps the ad's creative (no 'copy changed', no second creative)", async () => {
    const { batchId, key } = await batch();
    updateBatch(batchId, { status: "failed" });
    const ad = getAds(batchId)[0];
    db().prepare("UPDATE ads SET status = 'failed', meta_creative_id = 'cr9', attempts = '{\"creative\":1}' WHERE id = ?").run(ad.id);
    // set_ad_copy with only `angle`: the tool always sends a copy object (its undefined fields vanish in JSON).
    setAdCopyBy(key, [{ ad: 1, angle: "price", copy: {} }]);
    expect(getAds(batchId)[0].angle).toBe("price");
    expect(getAds(batchId)[0].meta_creative_id).toBe("cr9");
  });

  it("a Retry refused with 'No failed ads' does not change the batch's settings preset", async () => {
    const { batchId, key } = await batch();
    db().prepare("UPDATE ads SET status = 'done', meta_ad_id = '9' || id WHERE batch_id = ?").run(batchId);
    updateBatch(batchId, { status: "done" });
    savePreset({ name: "No Instagram", pageId: "p1", pageName: "Sahajta AI", igUserId: "", igName: "" });
    expect(() => retryFailed(key, { presetId: "No Instagram" })).toThrow(/No failed ads/);
    expect(JSON.parse(getBatch(batchId)!.preset!).name).toBe("All off");
  });
});

describe("Settings: 'Add a copy template' / 'Add a preset'", () => {
  it("adding a new one under a name already in use does not silently overwrite the saved one", async () => {
    await batch();
    const id = saveCopyTemplate({ name: "Site Visit", primaryTexts: ["Book a visit"], headlines: ["Visit"], linkUrl: "https://example.com/visit", leadFormId: "555" });
    // Exactly what Settings → "Add a copy template" posts (no id, every field of the empty form).
    // Probe fixed (round 2): built by the page's own helper, so it is what the "Add" form posts now
    // (create: true for a new one); Claude keeps saving by name.
    const body = copyBody({ id: undefined, name: "site visit", texts: ["New text", "", "", "", ""], heads: ["", "", "", "", ""], desc: "", cta: "LEARN_MORE", link: "https://example.com/other", utm: "", displayLink: "", leadFormId: "" });
    expect(() => saveCopyTemplate(body)).toThrow(/already called/);
    const row = db().prepare("SELECT link_url, lead_form_id FROM copy_templates WHERE id = ?").get(id) as { link_url: string; lead_form_id: string };
    expect(row).toEqual({ link_url: "https://example.com/visit", lead_form_id: "555" });
  });
});

describe("looked at and fine: lead-form and WhatsApp fit checks", () => {
  const fit = (batchId: number, a: Record<string, unknown>) =>
    buildPreview(batchId, { adset: { id: "x", name: "X", ...a } }, 9000).batchChecks.filter((c) => ["lead_form_needed", "lead_form_unused", "whatsapp_button"].includes(c.code));

  it("website conversions (OFFSITE_CONVERSIONS, destination UNDEFINED) and traffic (LINK_CLICKS, WEBSITE) are not flagged", async () => {
    const { batchId } = await batch(COPY);
    expect(fit(batchId, { optimization_goal: "OFFSITE_CONVERSIONS", destination_type: "UNDEFINED" })).toEqual([]);
    expect(fit(batchId, { optimization_goal: "LINK_CLICKS", destination_type: "WEBSITE" })).toEqual([]);
    expect(fit(batchId, { optimization_goal: "LEAD_GENERATION", destination_type: "MESSENGER" })).toEqual([]);
  });

  it("an Instant form ad set without a lead form, and a WhatsApp ad set with a web button, are errors", async () => {
    const { batchId } = await batch(COPY);
    expect(fit(batchId, { optimization_goal: "LEAD_GENERATION", destination_type: "ON_AD" }).map((c) => c.code)).toEqual(["lead_form_needed"]);
    expect(fit(batchId, { optimization_goal: "CONVERSATIONS", destination_type: "WHATSAPP" }).map((c) => c.code)).toEqual(["whatsapp_button"]);
  });
});
