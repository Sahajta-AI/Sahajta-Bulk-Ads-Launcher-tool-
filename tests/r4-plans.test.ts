import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { clientFor } from "@/lib/meta/factory";
import { FakeClock, MockMeta } from "@/lib/meta/mock";
import { confirmPlan, createPlan } from "@/lib/manage/service";
import { getPlan, runPlan, summarise, type Op } from "@/lib/manage/plan";
import { upsertAccount } from "@/lib/setup";
import { freshDb } from "./helpers";

// Round 4 of the plan engine: the GOLIVE review items on the plan side and the marketer's 19 Nov rows
// (audiences, minimum spends in a campaign-budget campaign, copied ads on the same post).
// Practice Meta only, never the real API.

vi.mock("@/auth", () => ({ auth: async () => null }));
process.env.META_MOCK = "1";
const WHO = "r4plans@example.com";
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
type Prog = { status: string; ids: string[]; message: string };
const progress = (key: string) => JSON.parse(getPlan(key).progress) as Prog[];
const errorsOf = (s: { checks: { level: string; message: string }[] }) => s.checks.filter((c) => c.level === "error").map((c) => c.message).join("\n");
const warningsOf = (s: { checks: { level: string; message: string }[] }) => s.checks.filter((c) => c.level === "warning").map((c) => c.message).join("\n");
const status = (id: string) => mock.objects.get(id)?.status;
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

describe("GOLIVE 4 · the run-start check counts only the spend this plan starts or raises", () => {
  /** c1 on, with "November test ad set" (as1, ₹500) already spending; the plan turns on as4 (₹800). */
  async function planAt() {
    Object.assign(mock.objects.get("c1")!, { status: "ACTIVE" });
    Object.assign(mock.objects.get("as1")!, { status: "ACTIVE", effective_status: "ACTIVE" });
    const t0 = Date.parse("2026-11-19T10:00:00Z");
    vi.useFakeTimers({ toFake: ["Date"], now: t0 });
    const v = await createPlan({ run_at: iso(t0 + DAY), ops: [{ type: "set_status", status: "ACTIVE", adsets: ["as4"] }] }, WHO, "claude");
    expect(v.summary!.spendConfirmation).toBe("₹1,300");
    const basis = v.summary!.spendBasis!;
    expect(basis.find((x) => x.id === "as1")?.mine).toBe(false);
    expect(basis.find((x) => x.id === "as4")?.mine).toBe(true);
    await confirm(v.key, "₹1,300");
    vi.setSystemTime(t0 + DAY + 5_000);
    return v.key;
  }

  it("a budget already spending that the plan doesn't touch, raised meanwhile, doesn't send it back", async () => {
    const key = await planAt();
    mock.objects.get("as1")!.daily_budget = "500000"; // someone raised it in Ads Manager
    const r = await run(key);
    expect(r.reopened).toBeUndefined();
    expect(r).toEqual({ done: 1, failed: 0 });
    expect(status("as4")).toBe("ACTIVE");
  });

  it("the budget of what the plan turns on, raised meanwhile, sends it back (nothing turned on)", async () => {
    const key = await planAt();
    mock.objects.get("as4")!.daily_budget = "900000";
    const r = await run(key);
    expect(r.reopened).toMatch(/what can spend changed since it was confirmed/);
    expect(status("as4")).toBe("PAUSED");
  });
});

describe("GOLIVE 6 · confirming saves 'queued' and its job together", () => {
  it("a database error while saving the job leaves the plan a draft (not queued with nothing to run it)", async () => {
    const v = await createPlan({ ops: [{ type: "edit_adset", adset: "as2", name: "Renamed" }] }, WHO, "claude");
    db().exec("CREATE TRIGGER busy_once BEFORE INSERT ON jobs WHEN NEW.kind = 'plan' BEGIN SELECT RAISE(ABORT, 'database is locked'); END");
    await expect(confirm(v.key)).rejects.toThrow(/database is locked/);
    db().exec("DROP TRIGGER busy_once");
    expect(getPlan(v.key).status).toBe("draft");
    await confirm(v.key);
    expect(getPlan(v.key).status).toBe("queued");
    expect(db().prepare("SELECT COUNT(*) FROM jobs WHERE kind = 'plan' AND batch_id = ? AND status = 'queued'").pluck().get(getPlan(v.key).id)).toBe(1);
  });
});

describe("the marketer A2 · audience steps never print 'undefined'; each problem names its field", () => {
  it("a website audience with retention_days instead of days", async () => {
    const v = await createPlan({ ops: [{ type: "create_custom_audience", name: "Visitors", source: { kind: "website", pixel_id: "px1", retention_days: 30 } } as unknown as Op] }, WHO, "claude");
    const e = errorsOf(v.summary!);
    expect(e).toMatch(/Step 1: unknown field "retention_days" in source; did you mean days\?/);
    expect(e).toMatch(/Step 1: source\.days is missing: how many days back to look, from 1 to 180 for a website audience\./);
    expect(JSON.stringify(v.summary)).not.toMatch(/undefined/);
  });

  it("days out of range names source.days and the limit for that kind", async () => {
    const v = await createPlan({ ops: [{ type: "create_custom_audience", name: "Leads", source: { kind: "lead_form", page_id: "p1", days: 120 } }] }, WHO, "claude");
    expect(errorsOf(v.summary!)).toMatch(/source\.days must be a whole number of days from 1 to 90 for a lead form audience \(got 120\)/);
  });

  it("a lookalike with misnamed and missing fields", async () => {
    const v = await createPlan({ ops: [{ type: "create_lookalike", name: "LAL", source_audience: "999", countries: ["IN"], ratio: 1 } as unknown as Op] }, WHO, "claude");
    const e = errorsOf(v.summary!);
    expect(e).toMatch(/unknown field "countries"; did you mean country/);
    expect(e).toMatch(/unknown field "ratio"; did you mean size_percent/);
    expect(e).toMatch(/country is missing: the 2-letter code/);
    expect(e).toMatch(/size_percent is missing: how much of the country's people, from 1 to 10/);
    expect(JSON.stringify(v.summary)).not.toMatch(/undefined/);
  });

  it("a correct audience is still described as before", async () => {
    const v = await createPlan({ ops: [{ type: "create_custom_audience", name: "Visitors", source: { kind: "website", pixel_id: "px1", days: 30 } }] }, WHO, "claude");
    expect(errorsOf(v.summary!)).toBe("");
    expect(v.summary!.steps[0].lines.join(" ")).toMatch(/pixel px1 in the last 30 days/);
  });
});

describe("the marketer B1/B4 · a minimum spend that doesn't fit a campaign budget", () => {
  /** Plan pt64e: "R2 CBO" (₹300 a day) with "R2 CBO AS1" (minimum ₹100); a copy asked with ₹250. */
  function account() {
    mock.objects.set("cR", { _type: "campaign", id: "cR", name: "R2 CBO", status: "PAUSED", objective: "OUTCOME_LEADS", daily_budget: "30000", bid_strategy: "LOWEST_COST_WITHOUT_CAP", special_ad_categories: [] });
    mock.objects.set("asR", { _type: "adset", id: "asR", name: "R2 CBO AS1", campaign_id: "cR", status: "PAUSED", effective_status: "PAUSED", daily_min_spend_target: "10000", optimization_goal: "LEAD_GENERATION", billing_event: "IMPRESSIONS", targeting: { geo_locations: { countries: ["IN"] } } });
  }
  const step: Op = { type: "duplicate_adset", adset: "asR", changes: [{ min_daily_spend: 250 }] };

  it("the check names the numbers; the run builds the copy in the same run and says exactly what it has", async () => {
    account();
    const v = await createPlan({ ops: [step] }, WHO, "claude");
    expect(errorsOf(v.summary!)).toBe("");
    expect(warningsOf(v.summary!)).toMatch(/Step 1: the ad sets in campaign "R2 CBO" would have minimum daily spends adding up to ₹350 \("R2 CBO AS1" ₹100, "R2 CBO AS1 - copy 1" ₹250\), more than its ₹300 daily budget/);
    await confirm(v.key);
    expect(await run(v.key)).toEqual({ done: 1, failed: 0 });
    const copy = mock.objects.get(progress(v.key)[0].ids[0])!;
    expect(copy.name).toBe("R2 CBO AS1 - copy 1");
    expect(Number(copy.daily_min_spend_target)).toBe(10000); // the original's ₹100, not the refused ₹250
    expect(progress(v.key)[0].message).toMatch(/Copy 1: Meta refused the minimum daily spend of ₹250 asked for it \(the minimum daily spends of the ad sets in "R2 CBO" would add up to more than its ₹300 a day\), so that minimum was left out; it has a minimum daily spend of ₹100\./);
  });

  it("a copy left half made says so; Retry finishes it and the message matches what Meta has", async () => {
    account();
    const v = await createPlan({ ops: [step] }, WHO, "claude");
    await confirm(v.key);
    // The copy is made, then Meta refuses its settings for another reason: the step stops there.
    mock.inject({ match: (m, p) => m === "POST" && /^\d+$/.test(p), kind: "error", error: { message: "Invalid parameter", code: 100, error_user_msg: "Refused (test)." } });
    await run(v.key);
    const p0 = progress(v.key)[0];
    expect(p0.status).toBe("failed");
    expect(p0.message).toMatch(/Copy 1 is made but not finished: its settings were not sent yet, so it is paused and still named "… \[P:/);
    const { updatePlan } = await import("@/lib/manage/service");
    await updatePlan(v.key);
    await confirm(v.key);
    expect(await run(v.key)).toEqual({ done: 1, failed: 0 });
    const copy = mock.objects.get(progress(v.key)[0].ids[0])!;
    expect(mock.of("adset").filter((a) => a.campaign_id === "cR")).toHaveLength(2); // no second copy
    expect(copy.name).toBe("R2 CBO AS1 - copy 1");
    expect(Number(copy.daily_min_spend_target)).toBe(10000);
    expect(progress(v.key)[0].message).toMatch(/so that minimum was left out; it has a minimum daily spend of ₹100\./);
  });

  it("an ad set step (not a copy) whose minimum doesn't fit stops with a plain message", async () => {
    account();
    const v = await createPlan({ ops: [{ type: "edit_adset", adset: "asR", min_daily_spend: 400 }] }, WHO, "claude");
    expect(warningsOf(v.summary!)).toMatch(/adding up to ₹400 .*stops its step: lower min_daily_spend or raise the campaign budget/);
    await confirm(v.key);
    await run(v.key);
    expect(progress(v.key)[0].message).toMatch(/minimum daily spends of the ad sets in the campaign would add up to more than the campaign budget \(code 100\/1885648\)\. Lower min_daily_spend/);
  });
});

describe("the marketer C1 · copy_ad keeps the original's creative (the same post)", () => {
  function sourceAd() {
    mock.objects.set("cr9", { _type: "creative", id: "cr9", name: "Creative [L:t-01]", object_story_spec: { page_id: "p1", link_data: { link: "https://example.com", message: "Hi", name: "Head", image_hash: "h1" } }, effective_object_story_id: "p1_777" });
    mock.objects.set("ad9", { _type: "ad", id: "ad9", name: "Price ad [L:t-01]", adset_id: "as1", status: "PAUSED", effective_status: "PAUSED", creative_id: "cr9" });
  }

  it("the new ads use creative cr9; no new creative is made", async () => {
    sourceAd();
    const creatives = mock.of("creative").length;
    const v = await createPlan({ ops: [{ type: "copy_ad", ad: "ad9", adsets: ["as2", "as4"], name: "Price ad copy" }] }, WHO, "claude");
    expect(v.summary!.steps[0].lines.join(" ")).toMatch(/Same creative, so the same post/);
    await confirm(v.key);
    expect(await run(v.key)).toEqual({ done: 1, failed: 0 });
    const made = progress(v.key)[0].ids.map((id) => mock.objects.get(id)!);
    expect(made.map((a) => [a.adset_id, a.creative_id, a.name, a.status])).toEqual([["as2", "cr9", "Price ad copy", "PAUSED"], ["as4", "cr9", "Price ad copy", "PAUSED"]]);
    expect(mock.of("creative")).toHaveLength(creatives);
    expect(mock.calls.some((c) => c.path === "ad9/copies")).toBe(false);
    expect(progress(v.key)[0].message).toMatch(/on the same creative: the same post/);
  });

  it("when Meta refuses the creative in one ad set, that copy gets a new post and the message says why", async () => {
    sourceAd();
    const v = await createPlan({ ops: [{ type: "copy_ad", ad: "ad9", adsets: ["as2", "as4"] }] }, WHO, "claude");
    await confirm(v.key);
    let ads = 0;
    mock.inject({ match: (m, p) => m === "POST" && p === "act_1001/ads" && ++ads === 2, kind: "error", error: { message: "Invalid parameter", code: 100, error_user_msg: "This creative can't be used in this ad set." } });
    expect(await run(v.key)).toEqual({ done: 1, failed: 0 });
    const [a, b] = progress(v.key)[0].ids.map((id) => mock.objects.get(id)!);
    expect(a.creative_id).toBe("cr9");
    expect(b.creative_id).toBe("cr9"); // the practice Meta's own copy keeps it; real Meta makes a new one
    expect(b.name).toBe("Price ad [L:t-01]");
    expect(progress(v.key)[0].message).toMatch(/1 on the same creative \(the same post\)\. 1 copy got a NEW creative, so a new post .*: ad set as4 \(.*This creative can't be used in this ad set/);
  });
});

describe("Claude-tools items · lists and spend limit words", () => {
  it("one ad set given as text is one ad set, not letters", async () => {
    const v = await createPlan({ ops: [{ type: "set_status", status: "PAUSED", adsets: "as4" as unknown as string[] }] }, WHO, "claude");
    expect(errorsOf(v.summary!)).toBe("");
    expect(v.summary!.steps[0].title).toBe('Turn off: ad set "Min-spend template"');
    const s = await summarise(clientFor(), { ops: [{ type: "set_status", status: "PAUSED", adsets: "as4" as unknown as string[] }] });
    expect(errorsOf(s)).toMatch(/Step 1: adsets must be a list, e.g. \["as1"\] \(got "as4"\)\./);
    expect(errorsOf(s)).not.toMatch(/are not ad sets/);
  });

  it("an edit that gives only a minimum names only the minimum", async () => {
    const v = await createPlan({ ops: [{ type: "edit_adset", adset: "as3", min_daily_spend: 100 }] }, WHO, "claude");
    expect(v.summary!.steps[0].lines[0]).toBe("spend limits → minimum ₹100 a day");
  });
});
