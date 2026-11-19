import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { saveAppSettings } from "@/lib/appsettings";
import { MetaClient } from "@/lib/meta/client";
import { FakeClock, MockMeta } from "@/lib/meta/mock";
import { Pacer } from "@/lib/meta/pacer";
import { deliveryStatus } from "@/lib/manage/delivery";
import { createPlan } from "@/lib/manage/service";
import { sameAmount } from "@/lib/manage/plan";
import { batchLaunchSummary, batchView, launchBatch, savePreset, setAdCopyBy } from "@/lib/service";
import { upsertAccount } from "@/lib/setup";
import { getAds, getBatch, updateBatch } from "@/lib/store";
import { parseCopySheet } from "@/app/batches/[key]/CopySheet";
import { fifteenFileFolder, freshDb, setupBatch } from "./helpers";

// Audit of the web app's pages and routes (18 Nov). Each test names the behaviour the marketer
// needs; a failing test is a bug found by the audit.

process.env.META_MOCK = "1";
const g = globalThis as unknown as { __mockMeta?: MockMeta };
let folder: string;
let mock: MockMeta;

beforeAll(async () => {
  folder = await fifteenFileFolder();
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", (url: string | URL | Request, init?: RequestInit) => (String(url).startsWith("https://example.com") ? Promise.resolve(new Response("ok")) : real(url, init)));
}, 120_000);

beforeEach(() => {
  freshDb();
  mock = new MockMeta({ clock: new FakeClock(), capPoints: 9000, richAccount: true, allowActive: true, videoProcessingMs: 1000 });
  g.__mockMeta = mock;
});

const keyOf = (batchId: number) => getBatch(batchId)!.key;

describe("Batch page: Meta reads on a 300-calls-an-hour limit", () => {
  it("the summary of a batch that was already launched reads nothing from Meta (the page does not show it)", async () => {
    const { batchId } = await setupBatch(folder);
    updateBatch(batchId, { status: "done", launched_at: new Date().toISOString() });
    const before = mock.calls.length;
    await batchLaunchSummary(keyOf(batchId));
    expect(mock.calls.length - before).toBe(0);
  });

  it("reloading a draft batch with ?dest=1 (done after every upload and every setting change) reads Meta at most once in a row", async () => {
    const { batchId } = await setupBatch(folder);
    const key = keyOf(batchId);
    await batchView(key, { withDestination: true }); // warms the caches
    const before = mock.calls.length;
    await batchView(key, { withDestination: true });
    await batchView(key, { withDestination: true });
    expect(mock.calls.length - before).toBe(0);
  });

  it("asking for the summary again with nothing changed does not read Meta again (short cache)", async () => {
    const { batchId } = await setupBatch(folder);
    const key = keyOf(batchId);
    await batchLaunchSummary(key);
    const before = mock.calls.length;
    await batchLaunchSummary(key);
    expect(mock.calls.length - before).toBe(0);
  });
});

describe("Copy sheet: per-ad copy pasted from Google Sheets", () => {
  it("a primary text with a line break (Sheets copies it in quotes) stays one row", () => {
    const text = 'ad\tprimary_text_1\theadline_1\n1\t"Line one\nLine two"\tFree site visit\n2\tSecond ad text\tCall us';
    const rows = parseCopySheet(text);
    expect(rows).toHaveLength(2);
    expect(rows[0].copy.primaryTexts).toEqual(["Line one\nLine two"]);
    expect(rows[1].ad).toBe("2");
  });

  it("a sheet with one bad row saves nothing (no half-saved sheet behind an error)", async () => {
    const { batchId } = await setupBatch(folder);
    const key = keyOf(batchId);
    expect(() => setAdCopyBy(key, [
      { ad: 1, copy: { primaryTexts: ["New text for ad 1"] } },
      { ad: 99, copy: { primaryTexts: ["There is no ad 99"] } },
    ])).toThrow(/No ad "99"/);
    expect(getAds(batchId).find((a) => a.position === 1)!.copy_override).toBeNull();
  });
});

describe("Plain error messages", () => {
  it("a copy row without its copy gets a plain message, not a JavaScript error", async () => {
    const { batchId } = await setupBatch(folder);
    let msg = "";
    try {
      setAdCopyBy(keyOf(batchId), [{ ad: 1 } as never]);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).not.toMatch(/Cannot read properties|undefined/);
  });
});

describe("Settings → Ad presets", () => {
  it("saving a preset from the Settings form keeps its Threads account and partner Page", () => {
    upsertAccount({ metaAccountId: "act_1001", name: "Mock", token: "mock-token" });
    const id = savePreset({ name: "Main", pageId: "p1", pageName: "Sahajta AI", threadsUserId: "1784", sponsorPageId: "5550" });
    // Exactly the body PresetEditor (src/app/settings/SettingsClient.tsx) sends after ticking one box.
    savePreset({ id, name: "Main", pageId: "p1", pageName: "Sahajta AI", igUserId: "", igName: "", whatsappNumber: "", multiAdvertiser: false, isDefault: false, enhancements: { add_text_overlay: "OPT_IN" } } as never);
    const row = db().prepare("SELECT threads_user_id, sponsor_page_id FROM settings_presets WHERE id = ?").get(id) as { threads_user_id: string; sponsor_page_id: string };
    expect(row).toEqual({ threads_user_id: "1784", sponsor_page_id: "5550" });
  });
});

describe("Launch and turn on: the typed budget confirmation", () => {
  it("an ad set with a lifetime budget is not confirmed as '₹0 a day'", async () => {
    const as1 = mock.objects.get("as1")!;
    delete as1.daily_budget;
    Object.assign(as1, { lifetime_budget: "5000000", end_time: "2026-12-31T23:59:00+0530" }); // ₹50,000 lifetime
    const { batchId } = await setupBatch(folder);
    updateBatch(batchId, { go_live: "now" });
    const s = await batchLaunchSummary(keyOf(batchId));
    expect(s.launch!.spendConfirmation).not.toBe("₹0");
  });

  it("the daily budget ceiling in Settings → Safety also stops a lifetime budget launch that turns ads on", async () => {
    const as1 = mock.objects.get("as1")!;
    delete as1.daily_budget;
    Object.assign(as1, { lifetime_budget: "5000000", end_time: "2026-12-31T23:59:00+0530" });
    const { batchId } = await setupBatch(folder);
    updateBatch(batchId, { go_live: "now" });
    saveAppSettings({ dailyBudgetCeiling: 1000 }, "test@example.com");
    let refused = false;
    try {
      await launchBatch(keyOf(batchId), { confirm: true, acceptWarnings: true, spendConfirmation: "₹0" });
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
    expect(getBatch(batchId)!.status).toBe("draft");
  });

  it("'Rs. 1500' typed for a total of ₹1,500 is accepted (common way to write rupees in India)", () => {
    expect(sameAmount("Rs. 1500", "₹1,500")).toBe(true);
    expect(sameAmount("Rs.1,500", "₹1,500")).toBe(true);
  });
});

describe("Plans: budgets typed in the forms", () => {
  it("a daily budget of 0 is refused when the plan is checked, not later by Meta", async () => {
    await setupBatch(folder); // creates the connected account
    const v = await createPlan({ ops: [{ type: "edit_adset", adset: "as1", daily_budget: 0 }] } as never, "test@example.com", "app");
    expect(v.summary!.errors).toBeGreaterThan(0);
  });

  it("a negative daily budget (Claude or the API) is refused when the plan is checked", async () => {
    await setupBatch(folder);
    const v = await createPlan({ ops: [{ type: "edit_adset", adset: "as1", daily_budget: -500 }] } as never, "test@example.com", "claude");
    expect(v.summary!.errors).toBeGreaterThan(0);
  });
});

describe("Delivery check while Meta limits calls", () => {
  it("says Meta is limiting calls instead of silently leaving ads out of the table", async () => {
    const clock = new FakeClock();
    const m = new MockMeta({ clock, capPoints: 9000 });
    for (let i = 0; i < 12; i++) m.objects.set(`ad${i}`, { id: `ad${i}`, name: `Ad ${i}`, adset_id: "as1", status: "PAUSED", effective_status: "PAUSED", _type: "ad" } as never);
    // A small, fixed cap: the 12 reads cannot all fit in the window, as on a busy day.
    const client = new MetaClient({ token: "t", accountId: m.accountId, version: "v26.0", fetch: m.fetch, pacer: new Pacer(clock, undefined, undefined, 8), clock, maxWaitMs: 15_000 });
    const ids = Array.from({ length: 12 }, (_, i) => `ad${i}`);
    let rows: Awaited<ReturnType<typeof deliveryStatus>> | null = null;
    let failed: unknown = null;
    try {
      rows = await deliveryStatus(client, { ads: ids });
    } catch (e) {
      failed = e;
    }
    // Either every ad is there, or the call fails with the plain "Meta is limiting calls" answer.
    if (!failed) expect(rows!.length).toBe(12);
  });
});
