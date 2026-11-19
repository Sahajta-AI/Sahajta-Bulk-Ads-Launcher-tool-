import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { clientFor } from "@/lib/meta/factory";
import { FakeClock, MockMeta } from "@/lib/meta/mock";
import { recentAlerts } from "@/lib/alerts";
import { cancelPlan, confirmPlan, createPlan, undoPlan, updatePlan } from "@/lib/manage/service";
import { getPlan, runPlan, summarise, type Op } from "@/lib/manage/plan";
import { upsertAccount } from "@/lib/setup";
import { freshDb } from "./helpers";

// Review 3 of the plan engine (independent probes). A FAILING test here is a real bug the review found;
// a passing one is a case that was checked and is fine. Practice Meta only, never the real API.

vi.mock("@/auth", () => ({ auth: async () => null }));
process.env.META_MOCK = "1";
const WHO = "review3plans@example.com";
process.env.ALLOWED_EMAILS = WHO;
const g = globalThis as unknown as { __mockMeta?: MockMeta };
let clock: FakeClock;
let mock: MockMeta;

beforeEach(() => {
  freshDb();
  clock = new FakeClock();
  mock = new MockMeta({ clock, capPoints: 90000, richAccount: true, allowActive: true, videoProcessingMs: 1000, budgetSchedules: true });
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
type Prog = { status: string; ids: string[]; message: string; orphans?: { id: string }[]; unused?: { id: string; kind: string }[] };
const progress = (key: string) => JSON.parse(getPlan(key).progress) as Prog[];
type Sum = { spendConfirmation: string | null; canSpend: boolean; checks: { level: string; code: string; message: string }[] };
const summaryOf = (key: string) => JSON.parse(getPlan(key).summary!) as Sum;
const errorsOf = (s: { checks: { level: string; message: string }[] }) => s.checks.filter((c) => c.level === "error").map((c) => c.message).join("\n");
const notesOf = (s: { checks: { code: string; message: string }[] }) => s.checks.filter((c) => c.code === "plan_note").map((c) => c.message).join("\n");
const status = (id: string) => mock.objects.get(id)?.status;
const fail = { message: "Invalid parameter", code: 100, error_user_msg: "Refused (test)." };
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const sec = (ms: number) => Math.floor(ms / 1000);
const ceiling = (v: number) => db().prepare("INSERT INTO app_settings (key, value) VALUES ('daily_budget_ceiling', ?)").run(String(v));
/** Daily budgets (₹) of every ad set of a campaign that is ON in the practice Meta now. */
const onDaily = (campaign: string) => mock.of("adset").filter((a) => a.campaign_id === campaign && a.status === "ACTIVE").reduce((s, a) => s + Number(a.daily_budget ?? 0) / 100, 0);

// ---------------------------------------------------------------------------------------------------
// FINDINGS (these fail today)
// ---------------------------------------------------------------------------------------------------

describe("R3-review · 3-minute rule: another plan ran between the check and the run", () => {
  it("FINDING 1: a turn-on plan confirmed a moment ago, run right after a budget plan, turns on at the new budget with no new typed total and above the ceiling", async () => {
    const t0 = Date.parse("2026-11-19T10:00:00Z");
    vi.useFakeTimers({ toFake: ["Date"], now: t0 });
    ceiling(10_000);
    // Plan A raises a PAUSED ad set's budget: nothing can spend, so no typed total.
    const a = await createPlan({ ops: [{ type: "edit_adset", adset: "as1", daily_budget: 50_000 }] }, WHO, "claude");
    expect(a.summary!.canSpend).toBe(false);
    // Plan B turns that ad set and its campaign on: checked at ₹500 a day.
    const b = await createPlan({ ops: [{ type: "set_status", status: "ACTIVE", adsets: ["as1"], campaigns: ["c1"] }] }, WHO, "claude");
    expect(b.summary!.spendConfirmation).toBe("₹500");
    await confirm(a.key);
    await confirm(b.key, "₹500");
    // The worker runs them in order, both within 3 minutes of their confirmation.
    vi.setSystemTime(t0 + 30_000);
    expect(await run(a.key)).toEqual({ done: 1, failed: 0 });
    vi.setSystemTime(t0 + 40_000);
    const r = await run(b.key);
    // What should happen: B is checked again (Meta changed since its check) and goes back for a new yes.
    expect(onDaily("c1")).toBeLessThanOrEqual(10_000); // today: ₹50,000 a day ON, typed ₹500, ceiling ₹10,000
    expect(r.reopened).toBeTruthy();
  });
});

describe("R3-review · whole campaigns turned on at run time", () => {
  it("FINDING 2: a copy dropped by a retry (kept paused, left out of the count) is turned ON by a later whole-campaign step", async () => {
    const op = (copies: number): Op[] => [{ type: "duplicate_adset", ref: "cp", adset: "as1", copies }, { type: "set_status", status: "ACTIVE", whole_campaigns: ["c1"] }];
    const v = await createPlan({ ops: op(3) }, WHO, "claude");
    await confirm(v.key, v.summary!.spendConfirmation);
    let posts = 0;
    mock.inject({ match: (m, p) => m === "POST" && /^\d+$/.test(p) && ++posts === 3, kind: "error", error: fail });
    await run(v.key);
    const third = progress(v.key)[0].ids[2];
    expect(third).toBeTruthy();
    const u = await updatePlan(v.key, { ops: op(2) });
    expect(notesOf(u.summary!)).toMatch(/The last one is not used and stays paused/);
    const typed = u.summary!.spendConfirmation!;
    expect(await confirmAndRun(v.key, typed)).toEqual({ done: 2, failed: 0 });
    // The summary promised the dropped copy stays paused, and did not count it.
    expect(status(third)).toBe("PAUSED"); // today: ACTIVE
    expect(onDaily("c1")).toBeLessThanOrEqual(Number(typed.replace(/[^\d.]/g, "")));
  });

  it("FINDING 2b: an ad set added to the campaign after the check (e.g. by a batch launch while an earlier step runs) is turned ON and not counted", async () => {
    mock.objects.get("c1")!.status = "PAUSED";
    const v = await createPlan({ ops: [{ type: "edit_adset", adset: "as2", name: "Renamed" }, { type: "set_status", status: "ACTIVE", whole_campaigns: ["c1"] }] }, WHO, "claude");
    const typed = v.summary!.spendConfirmation!;
    await confirm(v.key, typed);
    // While step 1 runs, a launch adds a paused ad set with its own budget to c1.
    mock.inject({ match: (m, p) => { if (m === "POST" && p === "as2") mock.objects.set("as9", { _type: "adset", id: "as9", name: "Launched set", campaign_id: "c1", status: "PAUSED", daily_budget: "900000", effective_status: "PAUSED" }); return false; }, kind: "error" });
    expect(await run(v.key)).toEqual({ done: 2, failed: 0 });
    expect(status("as9")).toBe("PAUSED"); // today: ACTIVE, ₹9,000 a day not in the typed total
  });
});

describe("R3-review · budget periods and the run time", () => {
  it("FINDING 3: a plan set to run at 9:00 that adds a budget period starting at 9:00 is always sent back at run time", async () => {
    const t0 = Date.parse("2026-11-19T10:00:00Z");
    vi.useFakeTimers({ toFake: ["Date"], now: t0 });
    const runAt = t0 + DAY;
    // Fixed as the finding asked: the check wants the period to start at least 10 minutes after the run
    // time (a period at the run time itself is refused there, in plain words), and the run-time check
    // doesn't send back a period that met that rule. (Probe changed: it expected 9:00 to pass the check.)
    const at9 = await createPlan({
      run_at: iso(runAt),
      ops: [{ type: "edit_campaign", campaign: "c2", status: "ACTIVE", budget_schedules: [{ start: iso(runAt), end: iso(runAt + 12 * 3_600_000), increase_amount: 500 }] }],
    }, WHO, "claude");
    expect(errorsOf(at9.summary!)).toMatch(/budget period 1 starts at .*less than 10 minutes after the plan runs/);
    const v = await createPlan({
      run_at: iso(runAt),
      ops: [{ type: "edit_campaign", campaign: "c2", status: "ACTIVE", budget_schedules: [{ start: iso(runAt + 10 * 60_000), end: iso(runAt + 12 * 3_600_000), increase_amount: 500 }] }],
    }, WHO, "claude");
    expect(errorsOf(v.summary!)).toBe("");
    await confirm(v.key, v.summary!.spendConfirmation);
    vi.setSystemTime(runAt + 5_000); // the worker starts it a few seconds after 9:00
    const r = await run(v.key);
    expect(r.reopened ?? "").not.toMatch(/starts in the past/); // today: reopened, "budget period 1 starts in the past"
  });
});

describe("R3-review · retried plan: a later step names what the stopped step made", () => {
  it("FINDING 4: a step that names the stopped step's campaign by its name is refused as '2 campaigns are called …'", async () => {
    const now = Date.now();
    const ops: Op[] = [
      { type: "create_campaign", name: "Diwali Sale", objective: "OUTCOME_LEADS", daily_budget: 1000, budget_schedules: [{ start: iso(now + 2 * DAY), end: iso(now + 2.5 * DAY), increase_amount: 300 }] },
      { type: "create_adset", campaign: "Diwali Sale", name: "Diwali set", goal: "LEAD_GENERATION", countries: ["IN"] },
    ];
    const v = await createPlan({ ops }, WHO, "claude");
    expect(errorsOf(v.summary!)).toBe("");
    await confirm(v.key);
    // Meta makes the campaign, then refuses the budget period: step 1 stops with the campaign made.
    mock.inject({ match: (m, p) => m === "POST" && /^\d+\/budget_schedules$/.test(p), kind: "error", error: fail });
    await run(v.key);
    expect(progress(v.key)[0].status).toBe("failed");
    expect(progress(v.key)[0].ids[0]).toBeTruthy();
    const u = await updatePlan(v.key);
    expect(errorsOf(u.summary!)).not.toMatch(/2 campaigns are called "Diwali Sale"/); // today: false error, plan can't be confirmed
  });
});

describe("R3-review · something deleted in Ads Manager", () => {
  it("FINDING 5: Undo can't be confirmed when one item the plan made was deleted in Ads Manager", async () => {
    const v = await createPlan({ ops: [{ type: "duplicate_adset", adset: "as1", copies: 2 }] }, WHO, "claude");
    expect(await confirmAndRun(v.key)).toEqual({ done: 1, failed: 0 });
    const [first] = progress(v.key)[0].ids;
    mock.objects.delete(first); // deleted in Ads Manager: it can't spend
    const undo = await undoPlan(v.key, WHO, "claude");
    expect(errorsOf(undo.summary!)).toBe(""); // today: "… is not an ad set in this ad account …"
  });

  it("FINDING 5b: a turn-off step fails (every retry) when one item was deleted after the plan was confirmed", async () => {
    Object.assign(mock.objects.get("as1")!, { status: "ACTIVE" });
    Object.assign(mock.objects.get("as4")!, { status: "ACTIVE" });
    const v = await createPlan({ ops: [{ type: "set_status", status: "PAUSED", adsets: ["as1", "as4"] }] }, WHO, "claude");
    await confirm(v.key);
    mock.objects.delete("as4");
    expect(await run(v.key)).toEqual({ done: 1, failed: 0 }); // today: failed; a retry is then refused at the check
    expect(status("as1")).toBe("PAUSED");
  });
});

describe("R3-review · reads that fail must not hide spend", () => {
  it("FINDING 6: an ON ad set's budget raised 10× needs no typed total when its campaign can't be read", async () => {
    Object.assign(mock.objects.get("c1")!, { status: "ACTIVE" });
    Object.assign(mock.objects.get("as1")!, { status: "ACTIVE" });
    for (let i = 0; i < 4; i++) mock.inject({ match: (m, p) => m === "GET" && (p === "c1" || p === "act_1001/campaigns"), kind: "error", status: 500, error: { message: "Service temporarily unavailable", code: 2, is_transient: true } });
    const s = await summarise(clientFor(), { ops: [{ type: "edit_adset", adset: "as1", daily_budget: 5000 }] });
    expect(s.canSpend || s.errors > 0).toBe(true); // today: canSpend false, no error: runs with no typed total and no ceiling check
  });

  it("FINDING 7: budget periods past Meta's first 200 rows are not read (counted as none)", async () => {
    const now = Date.now();
    const rows = Array.from({ length: 250 }, (_, k) => ({ id: `old${k}`, budget_value: "10000", budget_value_type: "ABSOLUTE", time_start: sec(now - (300 - k) * DAY), time_end: sec(now - (300 - k) * DAY + 6 * 3_600_000), status: "COMPLETED" }));
    rows.push({ id: "next", budget_value: "50000", budget_value_type: "ABSOLUTE", time_start: sec(now + 2 * DAY), time_end: sec(now + 3 * DAY), status: "ACTIVE" });
    mock.objects.get("c2")!.budget_schedules = rows;
    const s = await summarise(clientFor(), { ops: [{ type: "set_status", status: "ACTIVE", campaigns: ["c2"] }] });
    expect(s.spendConfirmation === "₹1,500" || s.errors > 0).toBe(true); // today: ₹1,000 (the +₹500 period is missed)
  });

  it("FINDING 7b: a budget period whose start Meta sends in a form the launcher can't read is left out (not refused)", async () => {
    const now = Date.now();
    mock.objects.get("c2")!.budget_schedules = [{ id: "bs1", budget_value: "50000", budget_value_type: "ABSOLUTE", time_end: sec(now + 3 * DAY), status: "ACTIVE" }];
    const s = await summarise(clientFor(), { ops: [{ type: "set_status", status: "ACTIVE", campaigns: ["c2"] }] });
    expect(s.spendConfirmation === "₹1,500" || s.errors > 0).toBe(true); // today: ₹1,000
  });
});

describe("R3-review · messages after the run-time check", () => {
  it("FINDING 8: a plan sent back at run time loses its notes (what a retry keeps, what stays in Meta)", async () => {
    const t0 = Date.parse("2026-11-19T10:00:00Z");
    vi.useFakeTimers({ toFake: ["Date"], now: t0 });
    mock.objects.get("c1")!.status = "ACTIVE";
    const ops = (copies: number): Op[] => [{ type: "duplicate_adset", ref: "cp", adset: "as1", copies }, { type: "set_status", status: "ACTIVE", adsets: ["$cp"] }];
    const v = await createPlan({ ops: ops(3) }, WHO, "claude");
    await confirm(v.key, v.summary!.spendConfirmation);
    let posts = 0;
    mock.inject({ match: (m, p) => m === "POST" && /^\d+$/.test(p) && ++posts === 3, kind: "error", error: fail });
    await run(v.key);
    const u = await updatePlan(v.key, { ops: ops(2) });
    expect(notesOf(u.summary!)).toMatch(/not used and stays paused/);
    await confirm(v.key, u.summary!.spendConfirmation);
    mock.objects.get("as1")!.daily_budget = "70000"; // changed in Ads Manager while the plan waited
    vi.setSystemTime(t0 + 10 * 60_000);
    expect((await run(v.key)).reopened).toBeTruthy();
    expect(notesOf(summaryOf(v.key))).toMatch(/not used and stays paused/); // today: the note is gone
  });

  it("FINDING 9: a plan cancelled while its run-time check reads Meta gets a 'not run … confirm it to run it' email", async () => {
    const t0 = Date.parse("2026-11-19T10:00:00Z");
    vi.useFakeTimers({ toFake: ["Date"], now: t0 });
    const v = await createPlan({ ops: [{ type: "set_status", status: "ACTIVE", adsets: ["as1"], campaigns: ["c1"] }] }, WHO, "claude");
    await confirm(v.key, "₹500");
    mock.objects.get("as1")!.daily_budget = "90000";
    vi.setSystemTime(t0 + 10 * 60_000);
    let once = true;
    mock.inject({ match: (m) => { if (once && m === "GET") { once = false; cancelPlan(v.key); } return false; }, kind: "error" });
    await run(v.key);
    expect(getPlan(v.key).status).toBe("cancelled");
    expect(recentAlerts().some((a) => a.subject.includes(`Plan ${v.key} was not run`))).toBe(false); // today: sent
  });
});

describe("R3-review · a budget period Meta took, on a campaign the plan copies", () => {
  it("FINDING 10: on retry, the second copy counts the period twice (shared raise absorbed by the first copy only)", async () => {
    const now = Date.now();
    const p1 = { start: iso(now + 2 * DAY), end: iso(now + 2.5 * DAY), increase_amount: 500 };
    const ops: Op[] = [
      { type: "edit_campaign", campaign: "c2", budget_schedules: [p1] },
      { type: "duplicate_campaign", ref: "cp", campaign: "c2", with_contents: true, copies: 2 },
      { type: "set_status", status: "ACTIVE", whole_campaigns: ["$cp"] },
    ];
    const v = await createPlan({ ops }, WHO, "claude");
    const first = v.summary!.spendConfirmation;
    await confirm(v.key, first);
    mock.inject({ match: (m, p) => m === "POST" && p === "c2/copies", kind: "error", error: fail });
    await run(v.key);
    expect(progress(v.key).map((p) => p.status)).toEqual(["done", "failed", "skipped"]);
    const u = await updatePlan(v.key);
    expect(u.summary!.spendConfirmation).toBe(first); // today: ₹500 more (the second copy counts the period twice)
  });
});

// ---------------------------------------------------------------------------------------------------
// CHECKED AND FINE (these pass)
// ---------------------------------------------------------------------------------------------------

describe("R3-review · checked and fine", () => {
  it("a plan confirmed again by retry (no ops) runs without a second full check when the worker starts it at once", async () => {
    const v = await createPlan({ ops: [{ type: "edit_adset", adset: "as2", name: "X" }, { type: "set_status", status: "ACTIVE", adsets: ["as1"], campaigns: ["c1"] }] }, WHO, "claude");
    await confirm(v.key, v.summary!.spendConfirmation);
    mock.inject({ match: (m, p) => m === "POST" && p === "as1", kind: "error", error: fail });
    await run(v.key);
    const u = await updatePlan(v.key);
    await confirm(v.key, u.summary!.spendConfirmation);
    const before = mock.calls.length;
    expect(await run(v.key)).toEqual({ done: 2, failed: 0 });
    expect(mock.calls.slice(before).filter((c) => c.method === "GET" && /^act_1001\/(campaigns|adsets)$/.test(c.path)).length).toBeLessThanOrEqual(2);
  });

  it("an ON extra copy dropped by a retry is turned off when the plan runs, and Undo lists it", async () => {
    mock.objects.get("c1")!.status = "ACTIVE";
    const op = (n: number): Op => ({ type: "duplicate_adset", adset: "as1", changes: Array.from({ length: n }, () => ({ status: "ACTIVE" as const })) });
    const v = await createPlan({ ops: [op(3)] }, WHO, "claude");
    await confirm(v.key, v.summary!.spendConfirmation);
    let posts = 0;
    mock.inject({ match: (m, p) => m === "POST" && /^\d+$/.test(p) && ++posts === 3, kind: "error", error: fail });
    await run(v.key);
    const third = progress(v.key)[0].ids[2];
    // The third copy's settings post failed: Meta still has it paused (copies are made paused).
    const u = await updatePlan(v.key, { ops: [op(2)] });
    expect(u.summary!.spendConfirmation).toBe("₹1,000");
    expect(await confirmAndRun(v.key, "₹1,000")).toEqual({ done: 1, failed: 0 });
    expect(status(third)).toBe("PAUSED");
    const undo = await undoPlan(v.key, WHO, "claude");
    const off = undo.input.ops.find((o) => o.type === "set_status" && o.status === "PAUSED") as { adsets?: string[] };
    expect(off.adsets).toEqual(expect.arrayContaining([third]));
  });

  it("a percent budget period Meta took is counted at the amount it took after the daily budget changes on retry", async () => {
    mock.objects.get("c2")!.status = "ACTIVE";
    const p1 = { start: iso(Date.now() + 2 * DAY), end: iso(Date.now() + 2.5 * DAY), increase_percent: 50 };
    const v = await createPlan({ ops: [{ type: "edit_campaign", campaign: "c2", budget_schedules: [p1] }, { type: "edit_adset", adset: "as2", name: "Y" }] }, WHO, "claude");
    expect(v.summary!.spendConfirmation).toBe("₹1,500");
    await confirm(v.key, "₹1,500");
    mock.inject({ match: (m, p) => m === "POST" && p === "as2", kind: "error", error: fail });
    await run(v.key);
    expect(progress(v.key).map((p) => p.status)).toEqual(["done", "failed"]);
    const u = await updatePlan(v.key, { ops: [{ type: "edit_campaign", campaign: "c2", budget_schedules: [p1] }, { type: "edit_campaign", campaign: "c2", daily_budget: 2000 }] });
    // ₹2,000 a day, plus the ₹500 Meta already added (50% of the ₹1,000 it had then), once.
    expect(u.summary!.spendConfirmation).toBe("₹2,500");
  });

  it("a period in Meta with a status the launcher doesn't know is counted (fails safe)", async () => {
    const now = Date.now();
    mock.objects.get("c2")!.budget_schedules = [{ id: "bs1", budget_value: "50000", budget_value_type: "ABSOLUTE", time_start: sec(now + DAY), time_end: sec(now + 2 * DAY), status: "SOMETHING_NEW" }];
    const s = await summarise(clientFor(), { ops: [{ type: "set_status", status: "ACTIVE", campaigns: ["c2"] }] });
    expect(s.spendConfirmation).toBe("₹1,500");
  });

  it("a period in Meta as text times (+0000) and text amounts is read", async () => {
    const now = Date.now();
    const t = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "+0000");
    mock.objects.get("c2")!.budget_schedules = [{ id: "bs1", budget_value: "50000", budget_value_type: "absolute", time_start: t(now + DAY), time_end: t(now + 2 * DAY), status: "ACTIVE" }];
    const s = await summarise(clientFor(), { ops: [{ type: "set_status", status: "ACTIVE", campaigns: ["c2"] }] });
    expect(s.spendConfirmation).toBe("₹1,500");
  });

  it("ads from a post moved to a done step's ad set by ref: the kept ad is reused, the other is turned off", async () => {
    mock.objects.get("c1")!.status = "ACTIVE";
    const step1: Op = { type: "duplicate_adset", ref: "cp", adset: "as1", copies: 1 };
    const post = (sets: string[]): Op => ({ type: "ads_from_post", post_id: "p1_9", adsets: sets, name: "Post ad", status: "ACTIVE" });
    const v = await createPlan({ ops: [step1, post(["as1", "as4"])] }, WHO, "claude");
    await confirm(v.key, v.summary!.spendConfirmation);
    let ads = 0;
    mock.inject({ match: (m, p) => m === "POST" && p === "act_1001/ads" && ++ads === 2, kind: "error", error: fail });
    await run(v.key);
    const inAs1 = progress(v.key)[1].ids[0];
    const u = await updatePlan(v.key, { ops: [step1, post(["as1", "$cp"])] });
    expect(notesOf(u.summary!)).toMatch(/keeps the ad it already made/);
    expect(await confirmAndRun(v.key, u.summary!.spendConfirmation)).toEqual({ done: 2, failed: 0 });
    expect(progress(v.key)[1].ids[0]).toBe(inAs1);
    expect(mock.of("ad").filter((a) => a.adset_id === "as1")).toHaveLength(1);
  });

  it("Meta calls: the budget periods of each campaign budget are read once per check (create, confirm)", async () => {
    for (let k = 0; k < 5; k++) {
      mock.objects.set(`cc${k}`, { _type: "campaign", id: `cc${k}`, name: `CBO ${k}`, status: "PAUSED", objective: "OUTCOME_LEADS", daily_budget: "10000", special_ad_categories: [] });
      mock.objects.set(`ccs${k}`, { _type: "adset", id: `ccs${k}`, name: `CBO set ${k}`, campaign_id: `cc${k}`, status: "ACTIVE", effective_status: "CAMPAIGN_PAUSED", optimization_goal: "LEAD_GENERATION", billing_event: "IMPRESSIONS" });
    }
    const before = mock.calls.length;
    const v = await createPlan({ ops: [{ type: "set_status", status: "ACTIVE", campaigns: ["cc0", "cc1", "cc2", "cc3", "cc4"] }] }, WHO, "claude");
    await confirm(v.key, v.summary!.spendConfirmation);
    const reads = mock.calls.slice(before).filter((c) => c.method === "GET" && /\/budget_schedules$/.test(c.path)).length;
    expect(reads).toBe(10); // 5 campaigns × 2 checks (each is also counted when the run starts more than 3 minutes later)
  });
});
