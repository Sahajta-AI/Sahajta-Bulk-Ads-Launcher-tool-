import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { saveAppSettings } from "@/lib/appsettings";
import { FakeClock, MockMeta } from "@/lib/meta/mock";
import { queueGoLive } from "@/lib/manage/golive";
import { createPlan } from "@/lib/manage/service";
import { sameAmount } from "@/lib/manage/plan";
import { batchLaunchSummary } from "@/lib/service";
import { getAds, getBatch, updateBatch } from "@/lib/store";
import { fifteenFileFolder, freshDb, setupBatch } from "./helpers";

// Critique of tests/audit-web.test.ts (18 Nov): extra checks for findings the audit only suspected
// or missed. Each test names the behaviour the marketer needs; a failing test confirms a bug.

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

const lifetimeAdset = () => {
  const as1 = mock.objects.get("as1")!;
  delete as1.daily_budget;
  Object.assign(as1, { lifetime_budget: "5000000", end_time: "2026-12-31T23:59:00+0530" }); // ₹50,000 lifetime
};

describe("Finding 1, plans: turning on a lifetime-budget ad set", () => {
  it("the plan's typed total is not ₹0", async () => {
    lifetimeAdset();
    await setupBatch(folder);
    const v = await createPlan({ ops: [{ type: "set_status", status: "ACTIVE", campaigns: ["c1"], adsets: ["as1"] }] } as never, "test@example.com", "app");
    expect(v.summary!.spendConfirmation).not.toBe("₹0");
  });

  it("the Safety ceiling applies to it", async () => {
    lifetimeAdset();
    await setupBatch(folder);
    saveAppSettings({ dailyBudgetCeiling: 1000 }, "test@example.com");
    const v = await createPlan({ ops: [{ type: "set_status", status: "ACTIVE", campaigns: ["c1"], adsets: ["as1"] }] } as never, "test@example.com", "app");
    expect(v.summary!.checks.some((c) => c.code === "budget_ceiling")).toBe(true);
  });

  it("the plan does not say 'nothing will spend yet'", async () => {
    lifetimeAdset();
    await setupBatch(folder);
    const v = await createPlan({ ops: [{ type: "set_status", status: "ACTIVE", campaigns: ["c1"], adsets: ["as1"] }] } as never, "test@example.com", "app");
    expect(v.summary!.checks.some((c) => c.code === "nothing_delivers")).toBe(false);
  });
});

describe("Finding 1, batches: a campaign budget (CBO) that is a lifetime budget", () => {
  it("is not confirmed as ₹0", async () => {
    const c2 = mock.objects.get("c2")!;
    delete c2.daily_budget;
    Object.assign(c2, { lifetime_budget: "5000000", stop_time: "2026-12-31T23:59:00+0530" });
    const { batchId } = await setupBatch(folder);
    updateBatch(batchId, { campaign_id: "c2", adset_id: "as3", go_live: "now" });
    const s = await batchLaunchSummary(getBatch(batchId)!.key);
    expect(s.launch!.spendConfirmation).not.toBe("₹0");
  });
});

describe("Missed: turning the ads on after a launch skips the plan's own checks", () => {
  it("a go-live plan whose check finds an error (ceiling now exceeded) is not queued", async () => {
    const { batchId } = await setupBatch(folder);
    updateBatch(batchId, { go_live: "now", status: "done" });
    for (const [i, a] of getAds(batchId).entries()) {
      db().prepare("UPDATE ads SET status = 'done', meta_ad_id = ?, meta_adset_id = 'as1' WHERE id = ?").run(`9${i}`, a.id);
      mock.objects.set(`9${i}`, { id: `9${i}`, name: `Ad ${i}`, adset_id: "as1", status: "PAUSED", effective_status: "PAUSED", _type: "ad" } as never);
    }
    // The launch was confirmed at ₹500 a day; while the ads were being created (an hour on the
    // starter tier), the ceiling was lowered below the ad set's budget.
    saveAppSettings({ dailyBudgetCeiling: 100 }, "test@example.com");
    await queueGoLive(batchId);
    const plan = db().prepare("SELECT status, summary FROM plans ORDER BY id DESC LIMIT 1").get() as { status: string; summary: string };
    const errors = (JSON.parse(plan.summary) as { errors: number }).errors;
    expect(errors).toBeGreaterThan(0); // the plan's own check sees the problem...
    expect(plan.status).not.toBe("queued"); // ...but it is queued anyway
  });
});

describe("Finding 7: Meta's own check runs once per kind of step", () => {
  it("a second ad set edit with a budget of 0 is never sent to Meta's validate_only", async () => {
    await setupBatch(folder);
    const before = mock.calls.length;
    await createPlan({ ops: [{ type: "edit_adset", adset: "as1", daily_budget: 600 }, { type: "edit_adset", adset: "as4", daily_budget: 0 }] } as never, "test@example.com", "app");
    const posts = mock.calls.slice(before).filter((c) => c.method === "POST");
    // One validate_only POST for two edit_adset steps: step 2 (budget 0) is checked by nobody.
    expect(posts.length).toBe(1);
  });
});

describe("Finding 12: sameAmount", () => {
  it("does not accept a different amount (safe direction stays safe)", () => {
    expect(sameAmount("₹15,000", "₹1,500")).toBe(false);
    expect(sameAmount("1.500", "₹1,500")).toBe(false);
    expect(sameAmount("₹0", "₹0")).toBe(true);
  });
});
