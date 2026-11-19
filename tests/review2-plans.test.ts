import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { clientFor } from "@/lib/meta/factory";
import { FakeClock, MockMeta } from "@/lib/meta/mock";
import { cancelPlan, confirmPlan, createPlan, undoPlan, updatePlan } from "@/lib/manage/service";
import { getPlan, runPlan, summarise, type Op } from "@/lib/manage/plan";
import { upsertAccount } from "@/lib/setup";
import { freshDb } from "./helpers";

// Second review of the plan engine (after the PLANS fix group). Every test runs the real plan code
// against the practice Meta. A failing test is a bug found in this review; a passing one is a case
// that was checked and found right.

vi.mock("@/auth", () => ({ auth: async () => null }));
process.env.META_MOCK = "1";
const WHO = "review2@example.com";
process.env.ALLOWED_EMAILS = WHO;
const g = globalThis as unknown as { __mockMeta?: MockMeta };
let clock: FakeClock;
let mock: MockMeta;

beforeEach(() => {
  freshDb();
  clock = new FakeClock();
  mock = new MockMeta({ clock, capPoints: 90000, richAccount: true, allowActive: true, videoProcessingMs: 1000 });
  g.__mockMeta = mock;
  upsertAccount({ metaAccountId: "act_1001", name: "Sahajta (mock)", token: "mock-token" });
});
afterEach(() => {
  vi.useRealTimers();
});

const run = (key: string) => runPlan(getPlan(key).id, { client: clientFor(), clock });
const confirm = (key: string, spend?: string | null) => confirmPlan(key, { confirm: true, acceptWarnings: true, spendConfirmation: spend ?? undefined }, WHO);
async function confirmAndRun(key: string, spend?: string | null) {
  await confirm(key, spend);
  return run(key);
}
type Prog = { status: string; ids: string[]; message: string; before?: Record<string, Record<string, unknown>>; orphans?: { id: string }[] };
const progress = (key: string) => JSON.parse(getPlan(key).progress) as Prog[];
const errorsOf = (s: { checks: { level: string; message: string }[] }) => s.checks.filter((c) => c.level === "error").map((c) => c.message).join("\n");
const amount = (s: string | null | undefined) => Number(/\d[\d,]*(?:\.\d+)?/.exec(s ?? "")?.[0]?.replace(/,/g, "") ?? NaN);
const HOUR = 3_600_000;
const DAY = 86_400_000;
const at = (base: number, d: number) => new Date(base + d * DAY).toISOString();
const failWith = { message: "Invalid parameter", code: 100, error_user_msg: "Refused (test)." };

/** The practice Meta has no budget period route: this adds one. `refuse(n)` says which sends (1, 2, …) Meta refuses. */
function budgetPeriods(refuse: (n: number) => boolean = () => false, lose: (n: number) => boolean = () => false) {
  const sent: Record<string, string>[] = [];
  // What Meta took, by campaign: read back by GET {campaign}/budget_schedules (round 3: the launcher reads
  // a campaign's periods, so this fake route keeps what it took, as real Meta does).
  const taken = new Map<string, Record<string, string>[]>();
  const orig = mock.fetch;
  mock.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const campaign = /\/([^/?]+)\/budget_schedules/.exec(url)?.[1] ?? "";
    if (url.includes("/budget_schedules") && (init?.method ?? "GET").toUpperCase() === "POST") {
      const body = Object.fromEntries(new URLSearchParams(String(init?.body ?? "")));
      sent.push(body);
      if (refuse(sent.length)) return Response.json({ error: failWith }, { status: 400 });
      taken.set(campaign, [...(taken.get(campaign) ?? []), { id: `bs${sent.length}`, status: "ACTIVE", ...body }]);
      // Meta took the period, but the answer never arrived.
      if (lose(sent.length)) throw new TypeError("network timeout after create (simulated)");
      return Response.json({ id: `bs${sent.length}` });
    }
    if (url.includes("/budget_schedules")) return Response.json({ data: taken.get(campaign) ?? [], paging: { cursors: {} } });
    return orig(input, init);
  }) as typeof fetch;
  return sent;
}

describe("Review 2 · a stopped copy step retried with fewer copies", () => {
  it("a later step that uses all the copies ($ref) does not turn on the copy the retry dropped", async () => {
    mock.objects.get("c1")!.status = "ACTIVE";
    const step2: Op = { type: "set_status", status: "ACTIVE", adsets: ["$cp"] };
    const v = await createPlan({ ops: [{ type: "duplicate_adset", ref: "cp", adset: "as1", copies: 3 }, step2] }, WHO, "claude");
    await confirm(v.key, v.summary!.spendConfirmation);
    // All 3 copies are made; Meta refuses the rename of the third one, so the step stops.
    let posts = 0;
    mock.inject({ match: (m, p) => m === "POST" && /^\d+$/.test(p) && ++posts === 3, kind: "error", error: failWith });
    await run(v.key);
    expect(progress(v.key)[0].status).toBe("failed");
    const third = progress(v.key)[0].ids[2];
    expect(third).toBeTruthy();
    // Fixed: two copies are enough. The summary says step 2 turns on 2 ad sets.
    const u = await updatePlan(v.key, { ops: [{ type: "duplicate_adset", ref: "cp", adset: "as1", copies: 2 }, step2] });
    expect(u.summary!.steps.find((s) => s.n === 2)!.title).toMatch(/Turn ON: ad set .*, ad set /);
    expect(await confirmAndRun(v.key, u.summary!.spendConfirmation)).toEqual({ done: 2, failed: 0 });
    // The dropped copy stays paused: it is not in the typed total.
    expect(mock.objects.get(third)!.status).toBe("PAUSED");
    expect(progress(v.key)[1].ids).not.toContain(third);
  });
});

describe("Review 2 · budget periods", () => {
  it("a percent period Meta already took is counted at the amount Meta took when the daily budget is lowered on retry", async () => {
    mock.objects.get("c2")!.status = "ACTIVE"; // as3 is on
    const p1 = { start: at(Date.now(), 2), end: at(Date.now(), 2.5), increase_percent: 100 };
    const p2 = { start: at(Date.now(), 4), end: at(Date.now(), 4.5), increase_percent: 50 };
    const sent = budgetPeriods((n) => n === 2);
    const v = await createPlan({ ops: [{ type: "edit_campaign", campaign: "c2", daily_budget: 5000, budget_schedules: [p1, p2] }] }, WHO, "claude");
    expect(v.summary!.spendConfirmation).toBe("₹10,000");
    await confirmAndRun(v.key, v.summary!.spendConfirmation);
    expect(progress(v.key)[0].status).toBe("failed");
    expect(sent[0].budget_value).toBe("500000"); // Meta took +₹5,000 for period 1
    // Retry with a lower daily budget, the periods kept as they are (the launcher can't remove one).
    const u = await updatePlan(v.key, { ops: [{ type: "edit_campaign", campaign: "c2", daily_budget: 1000, budget_schedules: [p1, p2] }] });
    // During period 1 Meta spends ₹1,000 + ₹5,000 a day: the total to type must say at least that.
    expect(amount(u.summary!.spendConfirmation)).toBeGreaterThanOrEqual(6000);
  });

  it("a raise added by a finished step counts when the retried plan turns that campaign on", async () => {
    budgetPeriods();
    const p1 = { start: at(Date.now(), 2), end: at(Date.now(), 2.5), increase_percent: 50 };
    const v = await createPlan({ ops: [{ type: "edit_campaign", campaign: "c2", budget_schedules: [p1] }, { type: "set_status", status: "ACTIVE", campaigns: ["c2"] }] }, WHO, "claude");
    expect(v.summary!.spendConfirmation).toBe("₹1,500");
    await confirm(v.key, v.summary!.spendConfirmation);
    mock.inject({ match: (m, p) => m === "POST" && p === "c2", kind: "error", error: failWith });
    await run(v.key);
    expect(progress(v.key).map((p) => p.status)).toEqual(["done", "failed"]);
    const u = await updatePlan(v.key);
    // The +₹500 period is on the campaign in Meta (step 1 added it): turning it on can spend ₹1,500 a day.
    expect(u.summary!.spendConfirmation).toBe("₹1,500");
  });

  it("a stopped step whose first period has already started can still be retried", async () => {
    const t0 = Date.parse("2026-11-19T10:00:00Z");
    vi.useFakeTimers({ toFake: ["Date"], now: t0 });
    budgetPeriods((n) => n === 2);
    const p1 = { start: new Date(t0 + 2 * HOUR).toISOString(), end: new Date(t0 + 6 * HOUR).toISOString(), increase_percent: 20 };
    const p2 = { start: at(t0, 2), end: at(t0, 2.5), increase_percent: 20 };
    const v = await createPlan({ ops: [{ type: "edit_campaign", campaign: "c2", budget_schedules: [p1, p2] }] }, WHO, "claude");
    await confirmAndRun(v.key, v.summary!.spendConfirmation);
    expect(progress(v.key)[0].status).toBe("failed");
    vi.setSystemTime(t0 + 3 * HOUR); // period 1 (already in Meta) has started
    const u = await updatePlan(v.key);
    expect(errorsOf(u.summary!)).toBe("");
  });
});

describe("Review 2 · things that make an ON object spend again", () => {
  it("moving the end of an ON ad set that has ended to next week needs the typed total", async () => {
    mock.objects.get("c1")!.status = "ACTIVE";
    Object.assign(mock.objects.get("as1")!, { status: "ACTIVE", end_time: at(Date.now(), -1) }); // ₹500 a day, ended yesterday
    const s = await summarise(clientFor(), { ops: [{ type: "edit_adset", adset: "as1", end_time: at(Date.now(), 7) }] });
    expect(s.canSpend).toBe(true);
    expect(s.spendConfirmation).toBe("₹500");
  });

  it("starting an ON campaign-budget campaign a month earlier needs the typed total", async () => {
    Object.assign(mock.objects.get("c2")!, { status: "ACTIVE", start_time: at(Date.now(), 30) }); // as3 is on
    const s = await summarise(clientFor(), { ops: [{ type: "edit_campaign", campaign: "c2", start_time: at(Date.now(), 0.1) }] });
    expect(s.canSpend).toBe(true);
  });
});

describe("Review 2 · lifetime budgets as a daily amount", () => {
  it("a ₹10,000 lifetime budget ending in 25 hours is counted near ₹10,000 a day, not ₹5,000", async () => {
    mock.objects.get("c1")!.status = "ACTIVE";
    mock.objects.set("as5", { _type: "adset", id: "as5", name: "Short sale", campaign_id: "c1", status: "PAUSED", lifetime_budget: "1000000", end_time: new Date(Date.now() + 25 * HOUR).toISOString(), optimization_goal: "LEAD_GENERATION", billing_event: "IMPRESSIONS" });
    const s = await summarise(clientFor(), { ops: [{ type: "set_status", status: "ACTIVE", adsets: ["as5"] }] });
    // Meta spreads ₹10,000 over the 25 hours left: about ₹9,600 in the first day.
    expect(amount(s.spendConfirmation)).toBeGreaterThanOrEqual(9000);
  });

  it("the daily ceiling stops that plan (₹6,000 ceiling, ₹9,600 can spend in the first day)", async () => {
    db().prepare("INSERT INTO app_settings (key, value) VALUES ('daily_budget_ceiling', '6000')").run();
    mock.objects.get("c1")!.status = "ACTIVE";
    mock.objects.set("as5", { _type: "adset", id: "as5", name: "Short sale", campaign_id: "c1", status: "PAUSED", lifetime_budget: "1000000", end_time: new Date(Date.now() + 25 * HOUR).toISOString(), optimization_goal: "LEAD_GENERATION", billing_event: "IMPRESSIONS" });
    const s = await summarise(clientFor(), { ops: [{ type: "set_status", status: "ACTIVE", adsets: ["as5"] }] });
    expect(s.checks.some((c) => c.code === "budget_ceiling")).toBe(true);
  });
});

describe("Review 2 · the typed total on a retried create step", () => {
  it("an ad set the stopped step already made is counted once, at the budget it will have", async () => {
    mock.objects.get("c1")!.status = "ACTIVE";
    const op = (daily: number): Op => ({ type: "create_adset", campaign: "c1", name: "Reused set", daily_budget: daily, goal: "LEAD_GENERATION", status: "ACTIVE" });
    const v = await createPlan({ ops: [op(5000)] }, WHO, "claude");
    expect(v.summary!.spendConfirmation).toBe("₹5,000");
    await confirm(v.key, v.summary!.spendConfirmation);
    mock.inject({ match: (m, p) => m === "POST" && p === "act_1001/adsets", kind: "timeout_after_create" });
    await run(v.key);
    expect(progress(v.key)[0].status).toBe("failed");
    const u = await updatePlan(v.key, { ops: [op(1000)] });
    // After the run Meta has one ad set at ₹1,000 (the one already made, changed): not ₹6,000.
    expect(u.summary!.spendConfirmation).toBe("₹1,000");
    expect(await confirmAndRun(v.key, u.summary!.spendConfirmation)).toEqual({ done: 1, failed: 0 });
    expect(mock.of("adset").filter((a) => a.name === "Reused set").map((a) => Number(a.daily_budget))).toEqual([100000]);
  });
});

describe("Review 2 · what a stopped step made", () => {
  it("removing the stopped step does not lose what it turned on (Undo still turns it off)", async () => {
    const v = await createPlan({ ops: [{ type: "edit_adset", adset: "as2", name: "Renamed" }, { type: "set_status", status: "ACTIVE", adsets: ["as1", "as4"], campaigns: ["c1"] }] }, WHO, "claude");
    await confirm(v.key, v.summary!.spendConfirmation);
    mock.inject({ match: (m, p) => m === "POST" && p === "c1", kind: "error", error: failWith });
    await run(v.key);
    expect(mock.objects.get("as1")!.status).toBe("ACTIVE");
    let refused = false;
    try {
      await updatePlan(v.key, { ops: [{ type: "edit_adset", adset: "as2", name: "Renamed" }] });
    } catch {
      refused = true;
    }
    if (refused) return; // refusing the removal is also right
    expect(await confirmAndRun(v.key)).toEqual({ done: 1, failed: 0 });
    const undo = await undoPlan(v.key, WHO, "claude");
    const off = undo.input.ops.find((o) => o.type === "set_status" && o.status === "PAUSED") as { adsets?: string[] } | undefined;
    expect(off?.adsets ?? []).toEqual(expect.arrayContaining(["as1", "as4"]));
  });

  it("an unused item that was deleted in Ads Manager doesn't stop the retried step for ever", async () => {
    const op = (objective: string, periods: boolean): Op => ({ type: "create_campaign", name: "Orphan", objective, budget_level: "campaign", daily_budget: 1000, status: "ACTIVE", ...(periods ? { budget_schedules: [{ start: at(Date.now(), 2), end: at(Date.now(), 3), increase_percent: 20 }] } : {}) });
    const v = await createPlan({ ops: [op("OUTCOME_LEADS", true)] }, WHO, "claude");
    await confirmAndRun(v.key, v.summary!.spendConfirmation); // no budget period route: made ON, then the step fails
    const old = progress(v.key)[0].ids[0];
    expect(mock.objects.get(old)!.status).toBe("ACTIVE");
    await updatePlan(v.key, { ops: [op("OUTCOME_TRAFFIC", false)] });
    mock.objects.delete(old); // the person deleted the stray campaign in Ads Manager
    expect(await confirmAndRun(v.key, getPlan(v.key).can_spend ? JSON.parse(getPlan(v.key).summary!).spendConfirmation : undefined)).toEqual({ done: 1, failed: 0 });
  });

  it("a copy step stopped by Cancel says its copies are on when they were turned on", async () => {
    mock.objects.get("c1")!.status = "ACTIVE";
    const v = await createPlan({ ops: [{ type: "duplicate_adset", adset: "as1", changes: [{ status: "ACTIVE" }, { status: "ACTIVE" }, { status: "ACTIVE" }] }] }, WHO, "claude");
    await confirm(v.key, v.summary!.spendConfirmation);
    // Cancel arrives while the first copy is turned on.
    mock.inject({ match: (m, p) => { if (m === "POST" && /^\d+$/.test(p)) cancelPlan(v.key); return false; }, kind: "error" });
    await run(v.key);
    const p = progress(v.key)[0];
    expect(mock.objects.get(p.ids[0])!.status).toBe("ACTIVE");
    expect(p.message).not.toMatch(/paused/);
  });
});

describe("Review 2 · messages", () => {
  it("the refusal of a wrong typed amount doesn't call it the total daily budget when they differ", async () => {
    mock.objects.get("c1")!.status = "ACTIVE";
    const v = await createPlan({ ops: [{ type: "set_status", status: "ACTIVE", adsets: ["as1"] }, { type: "edit_adset", adset: "as4", daily_budget: 900 }] }, WHO, "claude");
    expect(v.summary!.totals.spendNowDaily).not.toBe(v.summary!.totals.dailyBudget);
    await expect(confirmPlan(v.key, { confirm: true, acceptWarnings: true, spendConfirmation: "1" }, WHO)).rejects.toThrow(/./);
    const msg = await confirmPlan(v.key, { confirm: true, acceptWarnings: true, spendConfirmation: "1" }, WHO).catch((e: Error) => e.message);
    expect(msg).not.toMatch(/total daily budget/);
  });
});

describe("Review 2 · run-time check of a scheduled plan (cases found right)", () => {
  it("an ON campaign with a budget period added is not sent back to draft at run time when nothing changed", async () => {
    const t0 = Date.parse("2026-11-19T10:00:00Z");
    vi.useFakeTimers({ toFake: ["Date"], now: t0 });
    budgetPeriods();
    mock.objects.get("c2")!.status = "ACTIVE";
    const v = await createPlan({ run_at: at(t0, 1), ops: [{ type: "edit_campaign", campaign: "c2", budget_schedules: [{ start: at(t0, 2), end: at(t0, 2.5), increase_percent: 50 }] }] }, WHO, "claude");
    expect(v.summary!.spendConfirmation).toBe("₹1,500");
    await confirm(v.key, v.summary!.spendConfirmation);
    vi.setSystemTime(t0 + DAY + 30_000);
    const r = await run(v.key);
    expect(r.reopened).toBeUndefined();
    expect(r).toMatchObject({ done: 1, failed: 0 });
  });

  it("a lifetime campaign budget turned on at a set time is not sent back to draft when nothing changed", async () => {
    const t0 = Date.parse("2026-11-19T10:00:00Z");
    vi.useFakeTimers({ toFake: ["Date"], now: t0 });
    Object.assign(mock.objects.get("c2")!, { daily_budget: undefined, lifetime_budget: "3000000", stop_time: at(t0, 6.3) });
    const v = await createPlan({ run_at: at(t0, 2), ops: [{ type: "set_status", status: "ACTIVE", campaigns: ["c2"] }] }, WHO, "claude");
    await confirm(v.key, v.summary!.spendConfirmation);
    vi.setSystemTime(t0 + 2 * DAY);
    const r = await run(v.key);
    expect(r.reopened).toBeUndefined();
    expect(mock.objects.get("c2")!.status).toBe("ACTIVE");
  });

  it("a budget raised in Ads Manager after confirming sends a scheduled turn-on back to draft", async () => {
    const t0 = Date.parse("2026-11-19T10:00:00Z");
    vi.useFakeTimers({ toFake: ["Date"], now: t0 });
    const v = await createPlan({ run_at: at(t0, 1), ops: [{ type: "set_status", status: "ACTIVE", campaigns: ["c2"] }] }, WHO, "claude");
    await confirm(v.key, v.summary!.spendConfirmation);
    mock.objects.get("c2")!.daily_budget = "900000";
    vi.setSystemTime(t0 + DAY);
    const r = await run(v.key);
    expect(r.reopened).toMatch(/₹9,000/);
    expect(mock.objects.get("c2")!.status).toBe("PAUSED");
    expect(getPlan(v.key).status).toBe("draft");
  });

  it("a scheduled plan cut off mid-step by a restart continues without a second check (no reopen half way)", async () => {
    const t0 = Date.parse("2026-11-19T10:00:00Z");
    vi.useFakeTimers({ toFake: ["Date"], now: t0 });
    mock.objects.get("c1")!.status = "ACTIVE";
    const v = await createPlan({ run_at: at(t0, 1), ops: [{ type: "create_adset", campaign: "c1", name: "Cut off", daily_budget: 300, goal: "LEAD_GENERATION" }, { type: "set_status", status: "ACTIVE", adsets: ["as1"] }] }, WHO, "claude");
    await confirm(v.key, v.summary!.spendConfirmation);
    vi.setSystemTime(t0 + DAY);
    const crash = Object.assign(new Error("worker killed (test)"), { fatal: true });
    await expect(runPlan(getPlan(v.key).id, { client: clientFor(), clock, afterCreate: () => { throw crash; } })).rejects.toThrow(/killed/);
    expect(progress(v.key)[0].status).toBe("running");
    mock.objects.get("as4")!.status = "ACTIVE"; // something changed in Meta while the worker was down
    const r = await run(v.key);
    expect(r.reopened).toBeUndefined();
    expect(r).toMatchObject({ done: 2, failed: 0 });
    expect(mock.of("adset").filter((a) => a.name === "Cut off")).toHaveLength(1);
  });
});

describe("Review 2 · Meta calls on the 300-an-hour tier", () => {
  it("checking a plan that only makes a campaign reads no campaigns, ad sets or ads", async () => {
    const before = mock.calls.length;
    await summarise(clientFor(), { ops: [{ type: "create_campaign", name: "Plain", objective: "OUTCOME_LEADS", budget_level: "adset" }] }, { validate: false });
    const reads = mock.calls.slice(before).filter((c) => c.method === "GET" && /act_1001\/(campaigns|adsets|ads)$/.test(c.path));
    expect(reads).toHaveLength(0);
  });

  it("checking paused ads from a post in one ad set (named by ID) doesn't read the campaign", async () => {
    mock.objects.set("2001", { _type: "adset", id: "2001", name: "Numbered set", campaign_id: "c1", status: "PAUSED", daily_budget: "50000", optimization_goal: "LEAD_GENERATION", billing_event: "IMPRESSIONS" });
    const before = mock.calls.length;
    await summarise(clientFor(), { ops: [{ type: "ads_from_post", post_id: "p1_123", adsets: ["2001"] }] }, { validate: false });
    const campaignReads = mock.calls.slice(before).filter((c) => c.method === "GET" && (c.path === "act_1001/campaigns" || c.path === "c1"));
    expect(campaignReads).toHaveLength(0);
  });

  it("turning on 150 ads in one ad set at run time reads their statuses in 2 calls, not 150", async () => {
    mock.objects.get("c1")!.status = "ACTIVE";
    const ads: string[] = [];
    for (let i = 0; i < 150; i++) {
      mock.objects.set(`cr${i}`, { _type: "creative", id: `cr${i}`, name: `cr${i}`, object_story_id: "p1_1" });
      mock.objects.set(`ad${i}`, { _type: "ad", id: `ad${i}`, name: `Ad ${i}`, adset_id: "as1", status: "PAUSED", effective_status: "PAUSED", creative_id: `cr${i}` });
      ads.push(`ad${i}`);
    }
    const v = await createPlan({ ops: [{ type: "set_status", status: "ACTIVE", ads }] }, WHO, "claude");
    await confirm(v.key, v.summary!.spendConfirmation);
    const before = mock.calls.length;
    await run(v.key);
    const reads = mock.calls.slice(before).filter((c) => c.method === "GET" && c.path !== "act_1001");
    expect(reads.length).toBeLessThanOrEqual(2);
  });
});

describe("Review 2 · lost answers, name lookups and retry notes", () => {
  it("a budget period whose answer was lost is not sent to Meta a second time on retry", async () => {
    mock.objects.get("c2")!.status = "ACTIVE";
    const sent = budgetPeriods(() => false, (n) => n === 1);
    const p1 = { start: at(Date.now(), 2), end: at(Date.now(), 2.5), increase_amount: 500 };
    const v = await createPlan({ ops: [{ type: "edit_campaign", campaign: "c2", budget_schedules: [p1] }] }, WHO, "claude");
    await confirmAndRun(v.key, v.summary!.spendConfirmation);
    expect(progress(v.key)[0].status).toBe("failed");
    await updatePlan(v.key);
    await confirmAndRun(v.key, JSON.parse(getPlan(v.key).summary!).spendConfirmation);
    // Meta has the +₹500 period once (or the step says it can't tell), never +₹1,000.
    expect(sent).toHaveLength(1);
  });

  it("running 5 steps that name ad sets by name in an account with 300 ad sets doesn't read the whole list for every step", async () => {
    for (let i = 0; i < 300; i++) mock.objects.set(`asn${i}`, { _type: "adset", id: `asn${i}`, name: `Set ${i}`, campaign_id: "c1", status: "PAUSED", daily_budget: "10000", optimization_goal: "LEAD_GENERATION", billing_event: "IMPRESSIONS" });
    const ops: Op[] = [0, 1, 2, 3, 4].map((i) => ({ type: "edit_adset", adset: `Set ${i}`, daily_budget: 200 + i }));
    const v = await createPlan({ ops }, WHO, "claude");
    await confirm(v.key, v.summary!.spendConfirmation);
    const before = mock.calls.length;
    expect(await run(v.key)).toEqual({ done: 5, failed: 0 });
    const listReads = mock.calls.slice(before).filter((c) => c.method === "GET" && c.path === "act_1001/adsets");
    expect(listReads.length).toBeLessThanOrEqual(5);
  });

  it("after an edit step is changed to work on another ad set, the note doesn't say the ad sets it already raised are paused", async () => {
    mock.objects.get("c1")!.status = "ACTIVE";
    const v = await createPlan({ ops: [{ type: "duplicate_adset", ref: "cp", adset: "as1", changes: [{ status: "ACTIVE" }, { status: "ACTIVE" }] }, { type: "edit_adset", adset: "$cp", daily_budget: 900 }] }, WHO, "claude");
    await confirm(v.key, v.summary!.spendConfirmation);
    let posts = 0;
    mock.inject({ match: (m, p) => m === "POST" && /^\d+$/.test(p) && ++posts === 4, kind: "error", error: failWith });
    await run(v.key);
    expect(progress(v.key).map((p) => p.status)).toEqual(["done", "failed"]);
    const raised = progress(v.key)[0].ids[0];
    expect(mock.objects.get(raised)).toMatchObject({ status: "ACTIVE", daily_budget: "90000" });
    const u = await updatePlan(v.key, { ops: [{ type: "duplicate_adset", ref: "cp", adset: "as1", changes: [{ status: "ACTIVE" }, { status: "ACTIVE" }] }, { type: "edit_adset", adset: "$cp.2", daily_budget: 900 }] });
    const note = u.summary!.checks.find((c) => c.code === "plan_note" && /Step 2/.test(c.message))!.message;
    expect(note).not.toMatch(/paused/);
  });
});

describe("Review 2 · Undo and duplicates after a changed step", () => {
  it("Undo of a plan cancelled after a step was changed still turns off the campaign the first version made ON", async () => {
    const op = (objective: string, periods: boolean): Op => ({ type: "create_campaign", name: "Undo me", objective, budget_level: "campaign", daily_budget: 1000, status: "ACTIVE", ...(periods ? { budget_schedules: [{ start: at(Date.now(), 2), end: at(Date.now(), 3), increase_percent: 20 }] } : {}) });
    const v = await createPlan({ ops: [op("OUTCOME_LEADS", true)] }, WHO, "claude");
    await confirmAndRun(v.key, v.summary!.spendConfirmation); // made ON, then the budget period fails
    const made = progress(v.key)[0].ids[0];
    expect(mock.objects.get(made)!.status).toBe("ACTIVE");
    await updatePlan(v.key, { ops: [op("OUTCOME_TRAFFIC", false)] }); // works on something else now
    cancelPlan(v.key); // the person gives up on the plan
    const undo = await undoPlan(v.key, WHO, "claude");
    const off = undo.input.ops.find((o) => o.type === "set_status" && o.status === "PAUSED") as { campaigns?: string[] } | undefined;
    expect(off?.campaigns ?? []).toContain(made);
  });

  it("fixing one wrong ad set in an 'ads from a post' step doesn't make a second ad in the ad set that already has one", async () => {
    // The second ad set is the wrong one: Meta refuses the ad there, after the ad in as1 is made.
    mock.objects.set("as9", { _type: "adset", id: "as9", name: "Wrong set", campaign_id: "c1", status: "PAUSED" });
    const v = await createPlan({ ops: [{ type: "ads_from_post", post_id: "p1_123", adsets: ["as1", "as9"], name: "Post ad" }] }, WHO, "claude");
    await confirm(v.key);
    mock.inject({ match: (m, p) => m === "POST" && p === "act_1001/ads" && mock.of("ad").length > 0, kind: "error", error: failWith });
    await run(v.key);
    expect(progress(v.key)[0].status).toBe("failed");
    expect(mock.of("ad").filter((a) => a.adset_id === "as1")).toHaveLength(1);
    // Fixed: the second ad set is as2. The ad already in as1 is the same ad the step makes there.
    await updatePlan(v.key, { ops: [{ type: "ads_from_post", post_id: "p1_123", adsets: ["as1", "as2"], name: "Post ad" }] });
    expect(await confirmAndRun(v.key)).toEqual({ done: 1, failed: 0 });
    expect(mock.of("ad").filter((a) => a.adset_id === "as1")).toHaveLength(1);
  });
});

describe("Review 2 · retries, generations and Undo (cases found right)", () => {
  it("a step changed to another objective makes one new campaign, turns the old ON one off, and a plain retry after that makes no third", async () => {
    const op = (objective: string): Op => ({ type: "create_campaign", name: "Gen test", objective, budget_level: "campaign", daily_budget: 1000, status: "ACTIVE", budget_schedules: [{ start: at(Date.now(), 2), end: at(Date.now(), 3), increase_percent: 20 }] });
    const v = await createPlan({ ops: [op("OUTCOME_LEADS")] }, WHO, "claude");
    await confirmAndRun(v.key, v.summary!.spendConfirmation); // no period route: made ON, then fails
    const first = progress(v.key)[0].ids[0];
    const u = await updatePlan(v.key, { ops: [op("OUTCOME_TRAFFIC")] });
    await confirmAndRun(v.key, u.summary!.spendConfirmation); // makes the second, turns the first off, fails on the period again
    const second = progress(v.key)[0].ids[0];
    expect(second).not.toBe(first);
    expect(mock.objects.get(first)!.status).toBe("PAUSED");
    await updatePlan(v.key);
    await confirmAndRun(v.key, JSON.parse(getPlan(v.key).summary!).spendConfirmation);
    expect(progress(v.key)[0].ids[0]).toBe(second);
    expect(mock.of("campaign").filter((c) => c.name === "Gen test")).toHaveLength(2);
    expect(mock.objects.get(second)!.status).toBe("ACTIVE");
  });

  it("a stopped copy step retried with fewer copies turns off only the extra copy, not the ones it keeps", async () => {
    mock.objects.get("c1")!.status = "ACTIVE";
    const changes = (n: number) => Array.from({ length: n }, () => ({ status: "ACTIVE" as const }));
    const v = await createPlan({ ops: [{ type: "duplicate_adset", adset: "as1", changes: changes(3) }] }, WHO, "claude");
    await confirm(v.key, v.summary!.spendConfirmation);
    let posts = 0;
    mock.inject({ match: (m, p) => m === "POST" && /^\d+$/.test(p) && ++posts === 3, kind: "error", error: failWith });
    await run(v.key);
    const ids = progress(v.key)[0].ids;
    const u = await updatePlan(v.key, { ops: [{ type: "duplicate_adset", adset: "as1", changes: changes(2) }] });
    expect(await confirmAndRun(v.key, u.summary!.spendConfirmation)).toEqual({ done: 1, failed: 0 });
    expect(ids.map((id) => mock.objects.get(id)!.status)).toEqual(["ACTIVE", "ACTIVE", "PAUSED"]);
  });

  it("Undo after a create step was changed and retried turns off the ad set it reused", async () => {
    mock.objects.get("c1")!.status = "ACTIVE";
    const op = (daily: number): Op => ({ type: "create_adset", campaign: "c1", name: "Undo set", daily_budget: daily, goal: "LEAD_GENERATION", status: "ACTIVE" });
    const v = await createPlan({ ops: [op(500)] }, WHO, "claude");
    await confirm(v.key, v.summary!.spendConfirmation);
    mock.inject({ match: (m, p) => m === "POST" && p === "act_1001/adsets", kind: "timeout_after_create" });
    await run(v.key);
    const u = await updatePlan(v.key, { ops: [op(400)] });
    await confirmAndRun(v.key, u.summary!.spendConfirmation);
    const made = progress(v.key)[0].ids[0];
    expect(Number(mock.objects.get(made)!.daily_budget)).toBe(40000);
    const undo = await undoPlan(v.key, WHO, "claude");
    const off = undo.input.ops.find((o) => o.type === "set_status" && o.status === "PAUSED") as { adsets?: string[] } | undefined;
    expect(off?.adsets).toContain(made);
  });

  it("copies changed from ON to paused on retry are paused in Meta (copy_ad)", async () => {
    mock.objects.set("cr_x", { _type: "creative", id: "cr_x", name: "cr", object_story_id: "p1_9" });
    mock.objects.set("adx", { _type: "ad", id: "adx", name: "Source ad", adset_id: "as1", status: "PAUSED", effective_status: "PAUSED", creative_id: "cr_x" });
    const op = (status: "ACTIVE" | "PAUSED"): Op => ({ type: "copy_ad", ad: "adx", adsets: ["as2", "as4"], status });
    const v = await createPlan({ ops: [op("ACTIVE")] }, WHO, "claude");
    await confirm(v.key, v.summary!.spendConfirmation);
    let posts = 0;
    // The second new ad (on the same creative, C1) is refused with an error that stops the step.
    mock.inject({ match: (m, p) => m === "POST" && p === "act_1001/ads" && ++posts === 2, kind: "error", error: { message: "Permissions error", code: 200 } });
    await run(v.key);
    const first = progress(v.key)[0].ids[0];
    expect(mock.objects.get(first)!.status).toBe("ACTIVE");
    await updatePlan(v.key, { ops: [op("PAUSED")] });
    expect(await confirmAndRun(v.key)).toEqual({ done: 1, failed: 0 });
    expect(progress(v.key)[0].ids.map((id) => mock.objects.get(id)!.status)).toEqual(["PAUSED", "PAUSED"]);
  });
});
