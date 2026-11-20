import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { runBatch } from "@/lib/engine/launcher";
import { buildPreview } from "@/lib/engine/preview";
import { extraAdsets, siblings } from "@/lib/manage/golive";
import { istTime } from "@/lib/manage/objects";
import { clientFor } from "@/lib/meta/factory";
import { FakeClock, MockMeta } from "@/lib/meta/mock";
import { localFiles } from "@/lib/sources/local";
import { batchView, cancelBatch, launchBatch, retryFailed, runPreview, savePreset, setAdCopyBy, updateAdOverride, updateSettings } from "@/lib/service";
import { getAds, getBatch, updateBatch } from "@/lib/store";
import { COPY, fifteenFileFolder, freshDb, setupBatch } from "./helpers";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Audit of the batch launch flow (18 Nov 2026). Every test here states the behaviour the marketer
// needs. A test that fails today proves a bug; its name says what is expected.

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

function fakeMeta(extra: Partial<ConstructorParameters<typeof MockMeta>[0]> = {}) {
  mock = new MockMeta({ clock, capPoints: 9000, richAccount: true, allowActive: true, videoProcessingMs: 1000, ...extra });
  g.__mockMeta = mock;
}

beforeEach(() => {
  freshDb();
  clock = new FakeClock();
  fakeMeta();
});

async function batch() {
  const { accountId, batchId } = await setupBatch(folder);
  db().prepare("UPDATE ad_accounts SET is_default = 1 WHERE id = ?").run(accountId);
  const deps = { client: clientFor(accountId), files: localFiles, clock, accountDbId: accountId, tmpDir: fs.mkdtempSync(path.join(os.tmpdir(), "audit-batches-")) };
  return { accountId, batchId, key: getBatch(batchId)!.key, deps };
}

describe("Destination checks reach the launch (runPreview throws its own result away)", () => {
  it("launching into a Dynamic creative ad set is refused at launch", async () => {
    const { batchId, key } = await batch();
    updateBatch(batchId, { adset_id: "as2", adset_name: "Dynamic creative ad set" });
    // The check itself works (page load with ?dest=1 shows it)...
    expect((await batchView(key, { withDestination: true })).preview.batchChecks.map((c) => c.code)).toContain("dynamic_creative");
    // ...but launchBatch reads the view runPreview returns, which is rebuilt without the destination.
    await expect(launchBatch(key, { confirm: true, acceptWarnings: true })).rejects.toThrow(/Dynamic creative/);
  }, 60_000);

  it("the view returned by the Check button (POST /preview, Claude's preview_batch) still shows the Dynamic creative error", async () => {
    const { batchId, key } = await batch();
    updateBatch(batchId, { adset_id: "as2", adset_name: "Dynamic creative ad set" });
    const v = await runPreview(key);
    expect(v.preview.batchChecks.map((c) => c.code)).toContain("dynamic_creative");
  }, 60_000);

  it("an Instagram account the ad account may not use (200/1815199) blocks the launch before anything is made", async () => {
    fakeMeta({ igNotAllowed: true });
    const { key } = await batch();
    expect((await batchView(key, { withDestination: true })).preview.batchChecks.map((c) => c.code)).toContain("ig_not_allowed");
    await expect(launchBatch(key, { confirm: true, acceptWarnings: true })).rejects.toThrow(/not allowed to use Instagram/);
  }, 60_000);

  it("an ad set that already holds 45 ads refuses a 9-ad batch at launch (Meta's 50-ad limit)", async () => {
    const { key } = await batch();
    for (let i = 0; i < 45; i++) mock.objects.set(`old${i}`, { _type: "ad", id: `old${i}`, name: `Old ad ${i}`, adset_id: "as1", status: "PAUSED", effective_status: "PAUSED" });
    expect((await batchView(key, { withDestination: true })).preview.batchChecks.map((c) => c.code)).toContain("adset_full");
    await expect(launchBatch(key, { confirm: true, acceptWarnings: true })).rejects.toThrow(/already has 45/);
  }, 60_000);

  it("a landing page that answers 404 shows as a warning after the full check", async () => {
    const { batchId, key } = await batch();
    updateBatch(batchId, { copy: JSON.stringify({ ...COPY, linkUrl: "https://example.com/dead" }) });
    const v = await runPreview(key);
    expect(v.ads[0].checks.map((c) => c.code)).toContain("link_down");
  }, 60_000);
});

describe("Same ads into several ad sets", () => {
  it("changing the main ad set to one already ticked as an extra does not put every ad twice into that ad set", async () => {
    const { batchId, key, deps } = await batch();
    // as1 and as4 collect leads with an Instant form: since 19 Nov a launch there needs a lead form (B13).
    updateBatch(batchId, { copy: JSON.stringify({ ...COPY, leadFormId: "555000111" }) });
    await updateSettings(key, { extraAdsetIds: ["as4"] });
    await updateSettings(key, { adsetId: "as4" }); // the UI's ad set dropdown sends only adsetId
    const v = await launchBatch(key, { confirm: true, acceptWarnings: true });
    expect(v.status).toBe("queued");
    const group = siblings(getBatch(batchId)!);
    for (const b of group) await runBatch(b.id, deps);
    const inAs4 = mock.of("ad").filter((a) => a.adset_id === "as4");
    expect(group.map((b) => b.adset_id)).toEqual(["as4"]);
    expect(inAs4).toHaveLength(9);
  }, 120_000);

  it("the settings never list the main ad set as an extra ad set", async () => {
    const { batchId, key } = await batch();
    await updateSettings(key, { extraAdsetIds: ["as4"] });
    await updateSettings(key, { adsetId: "as4" });
    const b = getBatch(batchId)!;
    expect(extraAdsets(b).map((x) => x.id)).not.toContain(b.adset_id);
  }, 60_000);

  it("'Stop the launch' on a batch launched into several ad sets also stops the batches launched with it", async () => {
    const { batchId, key } = await batch();
    updateBatch(batchId, { copy: JSON.stringify({ ...COPY, leadFormId: "555000111" }) }); // Instant form ad sets (B13)
    await updateSettings(key, { extraAdsetIds: ["as4"] });
    await launchBatch(key, { confirm: true, acceptWarnings: true });
    cancelBatch(key);
    const sib = siblings(getBatch(batchId)!).find((b) => b.id !== batchId)!;
    expect(getBatch(sib.id)!.status).not.toBe("queued");
    expect(db().prepare("SELECT COUNT(*) FROM jobs WHERE kind = 'launch' AND batch_id = ? AND status = 'queued'").pluck().get(sib.id)).toBe(0);
  }, 60_000);
});

describe("The fixes named in error messages work", () => {
  // Corrected after the critique (finding 4): the audit expected an edit of the preset in Settings to
  // reach a launched batch. A batch keeps its own copy of the preset (the batch page relies on it), so
  // the fix is to retry the batch with a preset without Instagram, and the message now says exactly that.
  it("Instagram not allowed: retrying with a settings preset without Instagram (fix 2 in the message) creates the ads", async () => {
    fakeMeta({ igNotAllowed: true });
    const { batchId, key, deps } = await batch();
    expect((await runBatch(batchId, deps)).done).toBe(0);
    expect(getAds(batchId)[0].error).toMatch(/retry this batch with a settings preset set to "No Instagram account/);
    expect(getAds(batchId)[0].error).toMatch(/Editing the preset in Settings alone does not change a batch/);
    savePreset({ name: "No Instagram", pageId: "p1", pageName: "Sahajta AI", igUserId: "", igName: "", enhancements: {}, multiAdvertiser: false });
    expect(retryFailed(key, { presetId: "No Instagram" }).retried).toBe(9);
    expect(JSON.parse(getBatch(batchId)!.preset!).igUserId).toBe("");
    expect(await runBatch(batchId, deps)).toEqual({ done: 9, failed: 0 });
  }, 120_000);

  it("a Meta login that expired before the launch starts gives the plain 'Reconnect Meta' message, not Meta's raw words", async () => {
    const { batchId, deps } = await batch();
    const expired = { message: "Error validating access token: Session has expired on Tuesday, 17-Nov-26.", type: "OAuthException", code: 190, error_subcode: 463 };
    // An expired login fails every call (the run's first call, whichever it is).
    for (let i = 0; i < 50; i++) mock.inject({ match: () => true, kind: "error", error: expired });
    const thrown = await runBatch(batchId, deps).then(() => null, (e: Error) => e.message);
    const shown = thrown ?? getAds(batchId)[0].error ?? "";
    expect(shown).toMatch(/Reconnect Meta/);
  }, 60_000);
});

describe("Per-ad copy is kept", () => {
  it("setting only the angle of an ad (Claude's set_ad_copy) keeps the ad's own texts", async () => {
    const { batchId, key } = await batch();
    const ad = getAds(batchId)[0];
    setAdCopyBy(key, [{ ad: ad.position, copy: { primaryTexts: ["Own text"], displayLink: "sahajta.com" } }]);
    setAdCopyBy(key, [{ ad: ad.position, copy: {}, angle: "price" }]);
    const after = getAds(batchId).find((a) => a.id === ad.id)!;
    expect(after.angle).toBe("price");
    expect(JSON.parse(after.copy_override ?? "{}").primaryTexts).toEqual(["Own text"]);
  });

  it("pasting a copy sheet with only text columns keeps an ad's carousel format and lead form", async () => {
    const { batchId, key } = await batch();
    const two = getAds(batchId).find((a) => db().prepare("SELECT COUNT(*) FROM assets WHERE ad_id = ?").pluck().get(a.id) === 2)!;
    updateAdOverride(key, two.id, { copy: { format: "carousel", leadFormId: "123456" } });
    setAdCopyBy(key, [{ ad: two.position, copy: { primaryTexts: ["Sheet text"] } }]);
    const o = JSON.parse(getAds(batchId).find((a) => a.id === two.id)!.copy_override ?? "{}");
    expect(o.format).toBe("carousel");
    expect(o.leadFormId).toBe("123456");
  });

  it("a carousel with 5 primary texts warns that only the first text is used", async () => {
    const { batchId, key } = await batch();
    const two = getAds(batchId).find((a) => db().prepare("SELECT COUNT(*) FROM assets WHERE ad_id = ?").pluck().get(a.id) === 2)!;
    updateAdOverride(key, two.id, { copy: { format: "carousel" } });
    const ad = buildPreview(batchId, {}, 9000).ads.find((a) => a.id === two.id)!;
    expect(ad.copy.primaryTexts).toHaveLength(5);
    expect(ad.checks.map((c) => c.message).join(" ")).toMatch(/primary text/i);
  });
});

describe("Leftovers and names", () => {
  it("one new ad set for the batch: when every ad failed, the empty paused ad set left in Meta is reported", async () => {
    const { batchId, key, deps } = await batch();
    await updateSettings(key, { adsetMode: "new_shared" });
    for (let i = 0; i < 9; i++) mock.inject({ match: (m, p) => m === "POST" && p.endsWith("/adcreatives"), kind: "error", error: { message: "Invalid parameter", code: 100, error_user_msg: "Text not allowed." } });
    expect(await runBatch(batchId, deps)).toEqual({ done: 0, failed: 9 });
    expect(getBatch(batchId)!.shared_adset_id).toBeTruthy();
    expect(buildPreview(batchId, {}, 9000).ads.some((a) => a.leftover)).toBe(true);
  }, 120_000);

  it("an empty ad naming pattern is refused or falls back to the creative name (never an ad called only '[L:key]')", async () => {
    const { batchId, key } = await batch();
    await updateSettings(key, { adNameTemplate: "" });
    const p = buildPreview(batchId, {}, 9000);
    const blocked = p.batchChecks.some((c) => c.level === "error");
    expect(blocked || p.ads[0].metaName.replace(/\s*\[L:[^\]]+\]$/, "").trim().length > 0).toBe(true);
  });
});

describe("Schedule time zone (server runs in UTC)", () => {
  it("a go-live time without an offset is taken as India time or refused, not read as UTC", async () => {
    const { batchId, key } = await batch();
    const old = process.env.TZ;
    process.env.TZ = "UTC";
    try {
      const r = await updateSettings(key, { goLive: "at", goLiveAt: "2026-11-20T09:00" }).then(() => "saved", (e: Error) => e.message);
      if (r === "saved") expect(istTime(getBatch(batchId)!.go_live_at!)).toMatch(/09:00 am IST/i);
      else expect(r).toMatch(/India|\+05:30|offset/i);
    } finally {
      if (old === undefined) delete process.env.TZ;
      else process.env.TZ = old;
    }
  });
});

describe("Lead form ad sets (suspected: Meta refuses a lead ad without a form)", () => {
  it("launching into an Instant form ad set (destination ON_AD) without a lead form is flagged before launch", async () => {
    const { key } = await batch(); // as1 in the practice account: destination ON_AD, goal LEAD_GENERATION
    const v = await batchView(key, { withDestination: true });
    const all = [...v.preview.batchChecks, ...v.ads.flatMap((a) => a.checks)].map((c) => c.message).join(" ");
    expect(all).toMatch(/lead form|instant form/i);
  }, 60_000);
});
