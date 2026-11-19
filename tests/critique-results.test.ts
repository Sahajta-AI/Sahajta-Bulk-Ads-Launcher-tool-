import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { MetaClient } from "@/lib/meta/client";
import { FakeClock, MockMeta } from "@/lib/meta/mock";
import { MetaError, plainError } from "@/lib/meta/errors";
import { readInsights, type CustomMetric } from "@/lib/manage/insights";
import { pixelCheck } from "@/lib/manage/checks";
import { queueGoLive } from "@/lib/manage/golive";
import { accountInfo } from "@/lib/manage/objects";
import { checkReview } from "@/lib/engine/launcher";
import { clientFor } from "@/lib/meta/factory";
import { retryFailed } from "@/lib/service";
import { newBatch, upsertAccount } from "@/lib/setup";
import { cacheDelete, getAds, getBatch, updateBatch } from "@/lib/store";
import { freshDb } from "./helpers";

// Second look at tests/audit-results.test.ts. Names:
//   FACT: documents what the code does today (passes).
//   BUG:  asserts the behaviour the marketer should get (fails today).
// Fake clients only: no real Meta, Google or web calls.

type Row = Record<string, unknown>;

function insightsClient(rows: Row[]) {
  const client = {
    accountId: "act_1",
    async getAll(_p: string, params: Record<string, unknown>) {
      const fields = String(params.fields).split(",");
      return rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => fields.includes(k))));
    },
  } as unknown as MetaClient;
  return client;
}

const g = globalThis as unknown as { __mockMeta?: MockMeta };

/** A launched "go live now" batch with every ad created, on practice mode's fake Meta. */
function launchedBatch() {
  process.env.META_MOCK = "1";
  freshDb();
  const mock = new MockMeta({ clock: new FakeClock(), capPoints: 9000, richAccount: true, allowActive: true });
  g.__mockMeta = mock;
  const accountId = upsertAccount({ metaAccountId: "act_1001", name: "Practice", token: "mock-token" });
  const batchId = newBatch(accountId, "marketer@example.com");
  updateBatch(batchId, { campaign_id: "c1", adset_id: "as1", go_live: "now", go_live_total: "₹500", status: "done" } as never);
  const key = getBatch(batchId)!.key;
  for (const n of [1, 2]) {
    db().prepare("INSERT INTO ads (batch_id, position, key, creative_name, status, meta_adset_id, meta_ad_id) VALUES (?, ?, ?, ?, 'done', 'as1', ?)").run(batchId, n, `${key}-0${n}`, `ad${n}`, `90${n}`);
  }
  return { mock, accountId, batchId, key };
}

describe("Finding 1: go-live after the launch", () => {
  // Updated in round 2 (BATCH): the turn-on plan's own check runs before it is queued, and Retry
  // recovers a go-live that failed. The old FACTs described the old queueGoLive.
  it("FACT (fixed): a turn-on plan whose check finds an error (here: ad IDs Meta doesn't have) is saved as a draft, not queued", async () => {
    const { mock, accountId, batchId, key } = launchedBatch();
    await accountInfo(clientFor(accountId)); // cached for 24 h, as launchSummary does at confirm time
    mock.inject({ match: (m, p) => m === "GET" && p === "as1", kind: "error", error: { message: "Simulated", code: 2 } });
    const msg = await queueGoLive(batchId);
    expect(msg).toMatch(/^Ads created but NOT turned on: .*are not (an )?ads in this ad account/);
    expect(msg).toMatch(/saved as a draft/);
    expect(db().prepare("SELECT status FROM plans WHERE title LIKE ?").pluck().get(`Turn on batch ${key} (%`)).toBe("draft");
    expect(getBatch(batchId)!.go_live_done).toBe(1);
  });

  it("FACT (fixed): with a cold account cache and an expired login, queueGoLive fails without making a plan, and Retry turns the ads on again", async () => {
    const { mock, batchId, key } = launchedBatch();
    cacheDelete("acctinfo:");
    mock.inject({ match: (m, p) => m === "GET" && p === "act_1001", kind: "error", error: { message: "Error validating access token", code: 190 } });
    await expect(queueGoLive(batchId)).rejects.toThrow(); // the worker tries again and tells the person
    expect(getBatch(batchId)!.go_live_done).toBe(0);
    // The worker's catch then leaves the batch partial (0 failed ads). Retry no longer refuses with "No failed ads":
    updateBatch(batchId, { status: "partial" } as never);
    expect(retryFailed(key)).toMatchObject({ retried: 0, goLive: true });
    // Only the turn-on step runs again (a "golive" job); the batch, with every ad in, is done.
    expect(getBatch(batchId)!.status).toBe("done");
    expect(db().prepare("SELECT COUNT(*) FROM jobs WHERE kind = 'golive' AND batch_id = ? AND status = 'queued'").pluck().get(batchId)).toBe(1);
    expect(getAds(batchId).every((a) => a.status === "done")).toBe(true);
  });
});

describe("Missed: the worker's review check has the same [object Object] bug, and saves it", () => {
  it("BUG: placement-specific review feedback is stored in words on the ad (batch page, emails)", async () => {
    const { batchId, key } = launchedBatch();
    const client = {
      accountId: "act_1001",
      async getAll() {
        return [{ id: "901", name: `Ad 1 [L:${key}-01]`, effective_status: "DISAPPROVED", ad_review_feedback: { global: { "Personal attributes": "Ads must not imply personal traits." }, placement_specific: { instagram: { "Personal attributes": "Not allowed on Instagram." } } } }];
      },
    } as unknown as MetaClient;
    await checkReview(client, batchId);
    const stored = String(getAds(batchId).find((a) => a.meta_ad_id === "901")!.review_issues);
    expect(stored).not.toContain("[object Object]");
  });
});

describe("Missed: reads that time out", () => {
  // Updated after the fixes (META M4/M5): a read that gets no answer is never told "nothing is created
  // twice" (that sentence is for writes). The old FACT asserted the old wording.
  it("FACT (fixed): an interactive read that times out is told 'try again', not 'nothing is created twice'", async () => {
    let calls = 0;
    const fake = (async () => {
      calls++;
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }) as unknown as typeof fetch;
    const client = new MetaClient({ token: "t", accountId: "act_1", version: "v26.0", fetch: fake, clock: new FakeClock(), maxWaitMs: 15_000 });
    const err = await readInsights(client, { level: "ad" }, []).catch((e) => e);
    expect(err).toBeInstanceOf(MetaError);
    expect(calls).toBeLessThanOrEqual(3);
    expect(plainError(err, "Reading results")).not.toMatch(/created twice/);
    expect(plainError(err, "Reading results")).toMatch(/Try again/);
  });
});

describe("Missed: the fake Meta can't check a 'read in pages' fix", () => {
  // Updated after META M8: the fake Meta now honours IN, so "read in pages" fixes can be tested.
  it("FACT (fixed): MockMeta honours filtering operator IN, so id IN [no-such-id] returns nothing", async () => {
    const mock = new MockMeta({ clock: new FakeClock(), capPoints: 9000, richAccount: true });
    const client = new MetaClient({ token: "t", accountId: mock.accountId, version: "v26.0", fetch: mock.fetch, clock: new FakeClock() });
    const rows = await client.getAll<{ id: string }>(`${mock.accountId}/adsets`, { fields: "id", filtering: [{ field: "id", operator: "IN", value: ["no-such-id"] }] });
    expect(rows.length).toBe(0);
  });
});

describe("Finding 4: more totals", () => {
  const ROWS: Row[] = [
    { campaign_id: "c1", campaign_name: "A", spend: "1000", reach: "30000", impressions: "50000" },
    { campaign_id: "c2", campaign_name: "B", spend: "500", reach: "30000", impressions: "50000" },
  ];
  it("BUG: a custom metric using reach does not total with reach added across rows (people are counted twice)", async () => {
    const custom: CustomMetric[] = [{ name: "Cost per 1000 reached", formula: "spend / reach * 1000", format: "money" }];
    const r = await readInsights(insightsClient(ROWS), { level: "campaign", metrics: ["spend", "Cost per 1000 reached"] }, custom);
    // Today: 1500 / 60000 * 1000 = 25, but the two campaigns may reach the same people.
    expect(r.totals["Cost per 1000 reached"]).toBeNull();
  });
});

describe("Findings 7 and 8: names in formulas", () => {
  // Updated after READS R10: the name is checked. Asked for directly, the column is refused naming
  // the missing metric; from a saved column set (dropUnknown), it is left out with a note.
  it("FACT (fixed): a formula naming a custom metric that was renamed or deleted is refused by name, or left out with a note", async () => {
    const custom: CustomMetric[] = [{ name: "CPL with GST", formula: "CPL * 1.18", format: "money" }];
    const client = insightsClient([{ campaign_id: "c1", campaign_name: "A", spend: "100" }]);
    await expect(readInsights(client, { level: "campaign", metrics: ["CPL with GST"] }, custom)).rejects.toThrow(/"CPL"/);
    const r = await readInsights(client, { level: "campaign", metrics: ["spend", "CPL with GST"] }, custom, { dropUnknown: true });
    expect(r.columns.map((c) => c.key)).toEqual(["spend"]);
    expect(r.notes.join(" ")).toMatch(/CPL with GST.*left out/);
  });
});

describe("Finding 3: pixel check", () => {
  it("FACT: a pixel Meta says does not exist (code 100) is still an error (keep this)", async () => {
    const missing = { accountId: "act_1", async get() { throw new MetaError("Unsupported get request", { status: 400, body: { code: 100, error_subcode: 33 } }); } } as unknown as MetaClient;
    expect((await pixelCheck(missing, "px9")).map((c) => c.code)).toEqual(["pixel_missing"]);
  });
  it("BUG: a connection problem does not say the pixel isn't in the ad account", async () => {
    const down = { accountId: "act_1", async get() { throw new MetaError("Network error: fetch failed", { status: 0, unknownOutcome: true }); } } as unknown as MetaClient;
    const codes = await pixelCheck(down, "px1").then((c) => c.map((x) => x.code)).catch(() => []);
    expect(codes).not.toContain("pixel_missing");
  });
});

describe("Finding 12: start date only", () => {
  // Updated after READS R11: a start date alone now runs to today (the ad account's time zone).
  it("FACT (fixed): a start date alone runs to today, not the last 7 days", async () => {
    const r = await readInsights(insightsClient([]), { level: "campaign", since: "2026-11-01", metrics: ["spend"] }, [], { timezone: "Asia/Kolkata", now: Date.parse("2026-11-18T20:00:00Z") });
    expect(r.range).toBe("2026-11-01 to 2026-11-19 (today)");
  });
});
