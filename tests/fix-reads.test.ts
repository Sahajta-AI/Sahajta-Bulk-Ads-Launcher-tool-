import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { sha256 } from "@/lib/crypto";
import { MetaClient } from "@/lib/meta/client";
import { FakeClock, MockMeta } from "@/lib/meta/mock";
import { MetaError, RateLimitedError } from "@/lib/meta/errors";
import { NOT_FOUND, deliveryStatus, planDeliveryTargets } from "@/lib/manage/delivery";
import { accountHealth, pixelCheck } from "@/lib/manage/checks";
import { checkBreakdowns, dateRange, metricProblem, readInsights, type CustomMetric } from "@/lib/manage/insights";
import { alertMime, clearAlerts, recentAlerts, sendAlert } from "@/lib/alerts";
import { upsertAccount } from "@/lib/setup";
import { zoneNote } from "@/app/results/shared";
import { freshDb } from "./helpers";

// Group READS fixes (R1–R13 without R4/R7): reading and reporting. Fake Meta only.

vi.mock("@/auth", () => ({ auth: async () => null }));

process.env.ALLOWED_EMAILS = "reads@example.com";
const KEY = "sal_fix_reads_key";
const g = globalThis as unknown as { __mockMeta?: MockMeta };

function mockClient(opts: Partial<ConstructorParameters<typeof MockMeta>[0]> = {}) {
  const clock = new FakeClock();
  const mock = new MockMeta({ clock, capPoints: 9000, richAccount: true, ...opts });
  const client = new MetaClient({ token: "t", accountId: mock.accountId, version: "v26.0", fetch: mock.fetch, clock });
  return { mock, client };
}

/** Practice mode with a connected account and a Claude key, for calling routes. */
function practice() {
  process.env.META_MOCK = "1";
  freshDb();
  const mock = new MockMeta({ clock: new FakeClock(), capPoints: 9000, richAccount: true });
  g.__mockMeta = mock;
  const accountId = upsertAccount({ metaAccountId: "act_1001", name: "Practice", token: "mock-token" });
  db().prepare("INSERT INTO api_keys (user_email, label, key_hash, key_hint) VALUES (?, 'test', ?, 'test')").run("reads@example.com", sha256(KEY));
  return { mock, accountId };
}

const req = (url: string, init: RequestInit = {}) => new Request(`http://app${url}`, { ...init, headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", ...(init.headers ?? {}) } });
const ctx = { params: Promise.resolve({}) };

function addAds(mock: MockMeta, n: number, adset = "as1", prefix = "9") {
  const ids = Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(3, "0")}`);
  for (const id of ids) mock.objects.set(id, { id, name: `Ad ${id}`, adset_id: adset, status: "PAUSED", effective_status: "PENDING_REVIEW", _type: "ad" } as never);
  return ids;
}

const reads = (mock: MockMeta) => mock.calls.filter((c) => c.method === "GET");

// ---------------------------------------------------------------------------------------------

describe("R1 delivery: one paged list read instead of one read per object", () => {
  it("a 20-ad batch costs 2 reads; each ad set is followed by its ads", async () => {
    const { mock, client } = mockClient();
    const ids = addAds(mock, 20);
    const before = mock.calls.length;
    const rows = await deliveryStatus(client, { adsets: ["as1"], ads: ids });
    expect(mock.calls.length - before).toBe(2);
    expect(rows[0]).toMatchObject({ kind: "adset", id: "as1" });
    expect(rows.slice(1).map((r) => r.id)).toEqual(ids);
    expect(rows.slice(1).every((r) => r.plain === "in Meta review")).toBe(true);
  });

  it("an ad Meta no longer has stays as a row, not left out", async () => {
    const { mock, client } = mockClient();
    const ids = addAds(mock, 2);
    const rows = await deliveryStatus(client, { ads: [...ids, "777"] });
    expect(rows.map((r) => r.id)).toEqual([...ids, "777"]);
    expect(rows[2]).toMatchObject({ kind: "ad", status: NOT_FOUND });
    expect(rows[2].plain).toMatch(/not found in Meta/);
  });

  it("everything in a campaign: its ad sets and their ads, 2 reads", async () => {
    const { mock, client } = mockClient();
    addAds(mock, 3, "as2");
    const before = mock.calls.length;
    const rows = await deliveryStatus(client, { campaigns: ["c1"] });
    expect(mock.calls.length - before).toBe(2);
    const sets = rows.filter((r) => r.kind === "adset").map((r) => r.id);
    expect(sets).toEqual(expect.arrayContaining(["as1", "as2"]));
    const i = rows.findIndex((r) => r.id === "as2");
    expect(rows.slice(i + 1, i + 4).every((r) => r.kind === "ad")).toBe(true);
  });

  it("a lost Meta login (code 190) is thrown, never an empty table", async () => {
    const { mock, client } = mockClient();
    const ids = addAds(mock, 2);
    mock.inject({ match: (m, p) => m === "GET" && p.endsWith("/ads"), kind: "error", error: { message: "Error validating access token", code: 190 } });
    const err = await deliveryStatus(client, { ads: ids }).catch((e) => e);
    expect(err).toBeInstanceOf(MetaError);
    expect((err as MetaError).code).toBe(190);
  });

  it("when Meta refuses the filter, it reads one by one (and a missing ID is still a row)", async () => {
    const { mock, client } = mockClient();
    const ids = addAds(mock, 2);
    mock.inject({ match: (m, p) => m === "GET" && p === `${mock.accountId}/ads`, kind: "error", error: { message: "Invalid filtering field", code: 100 } });
    const rows = await deliveryStatus(client, { ads: [...ids, "777"] });
    expect(rows.map((r) => [r.id, r.status])).toEqual([[ids[0], "PENDING_REVIEW"], [ids[1], "PENDING_REVIEW"], ["777", NOT_FOUND]]);
  });

  it("a rate-limited page is thrown as Meta is limiting calls", async () => {
    const client = { accountId: "act_1", async getAll() { throw new RateLimitedError(Date.now() + 60_000); }, async get() { return {}; } } as unknown as MetaClient;
    await expect(deliveryStatus(client, { campaigns: ["c1"] })).rejects.toBeInstanceOf(RateLimitedError);
  });
});

describe("R2 delivery of a plan: kinds from the plan itself, the plan's own ad account", () => {
  it("reads kinds from step types, copy sub-keys and set_status's saved kinds", () => {
    const ops = [
      { type: "duplicate_campaign" },
      { type: "duplicate_adset" },
      { type: "set_status", campaigns: ["c9"] },
      { type: "ads_from_post" },
      { type: "create_custom_audience" },
      { type: "edit_adset" },
    ];
    const progress: Parameters<typeof planDeliveryTargets>[1] = [
      { ids: ["c2"], sub: { "1/as1": "as10", "1/as1/901": "910" } },
      { ids: ["as20"], sub: { "1/902": "920" } },
      { ids: ["c9", "as30", "930"], before: { as30: { kind: "adset" }, "930": { kind: "ad" } } },
      { ids: ["940"], sub: { creative: "cr1" } },
      { ids: ["aud1"] },
      { ids: [] },
    ];
    expect(planDeliveryTargets(ops, progress)).toEqual({ campaigns: ["c2", "c9"], adsets: ["as10", "as20", "as30"], ads: ["910", "920", "930", "940"] });
  });

  it("the route makes no 'what is this ID' reads and uses the plan's ad account", async () => {
    process.env.META_MOCK = "1";
    freshDb();
    const mock = new MockMeta({ clock: new FakeClock(), capPoints: 9000, richAccount: true });
    g.__mockMeta = mock;
    upsertAccount({ metaAccountId: "act_5005", name: "Default, not connected" }); // the default account
    const planAccount = upsertAccount({ metaAccountId: "act_1001", name: "Practice", token: "mock-token" });
    db().prepare("INSERT INTO api_keys (user_email, label, key_hash, key_hint) VALUES (?, 'test', ?, 'test')").run("reads@example.com", sha256(KEY));
    db()
      .prepare("INSERT INTO plans (key, ad_account_id, title, ops, summary, can_spend, progress, created_by, source, status) VALUES ('pread', ?, 't', ?, NULL, 0, ?, 'reads@example.com', 'app', 'done')")
      .run(planAccount, JSON.stringify({ ops: [{ type: "edit_adset", adset: "as1", name: "x" }] }), JSON.stringify([{ status: "done", ids: ["as1"], message: "" }]));
    const { GET } = await import("@/app/api/manage/delivery/route");
    const before = mock.calls.length;
    const res = await GET(req("/api/manage/delivery?plan=pread"), ctx);
    const body = (await res.json()) as { rows: { id: string }[]; error?: string };
    expect(body.error).toBeUndefined();
    expect(body.rows[0].id).toBe("as1");
    const paths = mock.calls.slice(before).map((c) => c.path);
    expect(paths.every((p) => p === "act_1001/adsets" || p === "act_1001/ads")).toBe(true);
  });

  it("a campaign name instead of an ID is refused in words, not 'Object … does not exist'", async () => {
    practice();
    const { GET } = await import("@/app/api/manage/delivery/route");
    const res = await GET(req("/api/manage/delivery?campaign=November%20tests"), ctx);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/"November tests" is not a campaign ID/);
  });
});

describe("R3 list of ads: one paged read with the creatives, not one read per ad", () => {
  it("30 ads cost 2 reads (pages of 25); more than 100 says the list was cut", async () => {
    const { mock } = practice();
    addAds(mock, 30);
    const { GET } = await import("@/app/api/manage/ads/route");
    let before = reads(mock).length;
    let body = (await (await GET(req("/api/manage/ads?adset=as1"), ctx)).json()) as { ads: unknown[]; truncated: boolean };
    expect(body.ads.length).toBe(30);
    expect(body.truncated).toBe(false);
    expect(reads(mock).length - before).toBe(2);
    addAds(mock, 90, "as1", "8");
    before = reads(mock).length;
    body = (await (await GET(req("/api/manage/ads?adset=as1"), ctx)).json()) as { ads: unknown[]; truncated: boolean; note?: string };
    expect(body.ads.length).toBe(100);
    expect(body.truncated).toBe(true);
    expect(reads(mock).length - before).toBe(5);
  });
});

// ---------------------------------------------------------------------------------------------

describe("R5 pixel check: 'not in the ad account' only when Meta says so", () => {
  const throwing = (e: unknown) => ({ accountId: "act_1", async get() { throw e; } }) as unknown as MetaClient;
  const fine = { accountId: "act_1", async get() { return { id: "px1", name: "Site pixel", last_fired_time: new Date().toISOString() }; } } as unknown as MetaClient;

  it("code 100 → pixel_missing (error); no permission → plain warning; no answer → warning", async () => {
    expect((await pixelCheck(throwing(new MetaError("Unsupported get request", { status: 400, body: { code: 100 } })), "px1")).map((c) => [c.code, c.level])).toEqual([["pixel_missing", "error"]]);
    expect((await pixelCheck(throwing(new MetaError("Permissions error", { status: 400, body: { code: 200 } })), "px1")).map((c) => [c.code, c.level])).toEqual([["pixel_no_access", "warning"]]);
    const down = await pixelCheck(throwing(new MetaError("Network error", { status: 0, noAnswer: true })), "px1");
    expect(down.map((c) => [c.code, c.level])).toEqual([["pixel_unknown", "warning"]]);
    expect(down[0].message).toMatch(/no answer from Meta/);
  });

  it("a rate limit or an expired login is thrown", async () => {
    await expect(pixelCheck(throwing(new RateLimitedError(Date.now() + 60_000)), "px1")).rejects.toBeInstanceOf(RateLimitedError);
    await expect(pixelCheck(throwing(new MetaError("Error validating access token", { status: 400, body: { code: 190 } })), "px1")).rejects.toBeInstanceOf(MetaError);
  });

  it("a page that answers 403 says it couldn't be read, not 'pixel not found'", async () => {
    const blocked = (async () => new Response("denied", { status: 403 })) as unknown as typeof fetch;
    const checks = await pixelCheck(fine, "px1", ["https://example.com/lp"], blocked);
    expect(checks.map((c) => c.code)).toEqual(["pixel_page_unread"]);
    expect(checks[0].message).toMatch(/Couldn't read https:\/\/example\.com\/lp \(HTTP 403; the site may block automated checks\)/);
  });

  it("every landing page is read, at most 5 at a time", async () => {
    let open = 0;
    let most = 0;
    const read: string[] = [];
    const slow = (async (url: string) => {
      read.push(url);
      open++;
      most = Math.max(most, open);
      await new Promise((r) => setTimeout(r, 20));
      open--;
      return new Response(url.endsWith("/p6") ? "<html>no tag</html>" : "<script>fbq('init','px1')</script>", { status: 200 });
    }) as unknown as typeof fetch;
    const pages = Array.from({ length: 7 }, (_, i) => `https://example.com/p${i}`);
    const checks = await pixelCheck(fine, "px1", pages, slow);
    expect(read.sort()).toEqual([...pages].sort());
    expect(most).toBe(5);
    expect(checks.map((c) => [c.code, c.message.includes("/p6")])).toEqual([["pixel_not_on_page", true]]);
  });

  it("more than 20 landing pages: the first 20 are read and a note says the rest weren't", async () => {
    const read: string[] = [];
    const ok = (async (url: string) => {
      read.push(url);
      return new Response("<script>fbq('init','px1')</script>", { status: 200 });
    }) as unknown as typeof fetch;
    const pages = Array.from({ length: 23 }, (_, i) => `https://example.com/p${i}`);
    const checks = await pixelCheck(fine, "px1", pages, ok);
    expect(read).toHaveLength(20);
    expect(checks.map((c) => c.code)).toEqual(["pixel_pages_unchecked"]);
    expect(checks[0].message).toMatch(/23 different landing pages; pixel px1 was looked for on the first 20 only\. Check the other 3/);
  });
});

describe("R6 account health", () => {
  beforeEach(() => {
    freshDb();
  });

  it("a failed read is not cached; a good read is", async () => {
    let n = 0;
    const client = {
      accountId: "act_7",
      async get() {
        n++;
        if (n === 1) throw new MetaError("Network error", { status: 0, noAnswer: true });
        return { name: "Main", account_status: 1, currency: "INR", funding_source_details: { display_string: "Visa" } };
      },
    } as unknown as MetaClient;
    expect((await accountHealth(client)).map((c) => c.code)).toEqual(["account_unknown"]);
    expect(await accountHealth(client)).toEqual([]);
    expect(await accountHealth(client)).toEqual([]);
    expect(n).toBe(2);
  });

  it("Meta limiting calls is thrown, not cached as 'couldn't ask Meta'", async () => {
    const client = { accountId: "act_6", async get() { throw new RateLimitedError(Date.now() + 60_000); } } as unknown as MetaClient;
    await expect(accountHealth(client)).rejects.toBeInstanceOf(RateLimitedError);
  });

  it("a disabled account says Meta's reason in plain words", async () => {
    const client = { accountId: "act_5", async get() { return { name: "Main", account_status: 2, disable_reason: 15, currency: "INR", funding_source_details: { display_string: "Visa" } }; } } as unknown as MetaClient;
    expect((await accountHealth(client))[0].message).toMatch(/disabled \(Meta's reason: Meta thinks someone else got into the account/);
  });
});

// ---------------------------------------------------------------------------------------------

type Row = Record<string, unknown>;
function insightsClient(rows: Row[]) {
  const calls: Record<string, unknown>[] = [];
  const client = {
    accountId: "act_1",
    async getAll(_p: string, params: Record<string, unknown>, max: number) {
      calls.push(params);
      const fields = String(params.fields).split(",");
      return rows.slice(0, max).map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => fields.includes(k))));
    },
  } as unknown as MetaClient;
  return { client, calls };
}

const TWO: Row[] = [
  { campaign_id: "c1", campaign_name: "A", spend: "1000", impressions: "50000", clicks: "500", reach: "30000", frequency: "1.6", actions: [{ action_type: "lead", value: "20" }], cost_per_action_type: [{ action_type: "lead", value: "50" }], video_thruplay_watched_actions: [{ action_type: "video_view", value: "300" }] },
  { campaign_id: "c2", campaign_name: "B", spend: "500", impressions: "20000", clicks: "100", reach: "15000", frequency: "1.3", actions: [{ action_type: "lead", value: "5" }], cost_per_action_type: [{ action_type: "lead", value: "100" }], video_thruplay_watched_actions: [{ action_type: "video_view", value: "200" }] },
];
// The rows' cost per lead differ (₹50 and ₹100): the total is ₹1,500 ÷ 25 leads = ₹60, not their average (₹75).

describe("R8 totals", () => {
  it("counts add up, rates are worked out from the totals, reach and frequency stay empty", async () => {
    const { client, calls } = insightsClient(TWO);
    const r = await readInsights(client, { level: "campaign", metrics: ["spend", "ctr", "cost:lead", "video_thruplay_watched_actions", "reach", "frequency"] }, []);
    expect(String(calls[0].fields).split(",")).toEqual(expect.arrayContaining(["actions", "clicks", "impressions"]));
    expect(r.totals).toEqual({ spend: 1500, ctr: (600 / 70000) * 100, "cost:lead": 60, video_thruplay_watched_actions: 500, reach: null, frequency: null });
  });

  it("one row without breakdowns is the total itself (Meta's reach)", async () => {
    const { client } = insightsClient([TWO[0]]);
    const r = await readInsights(client, { level: "campaign", metrics: ["spend", "reach"] }, []);
    expect(r.totals).toEqual({ spend: 1000, reach: 30000 });
  });

  it("nested custom metrics total with total rates; a loop is refused", async () => {
    const custom: CustomMetric[] = [
      { name: "CPL", formula: "spend / actions:lead", format: "money" },
      { name: "CPL GST", formula: "CPL * 1.18", format: "money" },
      { name: "Per person", formula: "spend / reach", format: "money" },
    ];
    const { client } = insightsClient(TWO);
    const r = await readInsights(client, { level: "campaign", metrics: ["CPL GST", "Per person"] }, custom);
    expect(r.rows.map((x) => x.values["CPL GST"])).toEqual([59, 118]);
    expect(r.totals["CPL GST"]).toBeCloseTo(70.8); // ₹60 × 1.18, not the rows' average (₹88.50)
    expect(r.totals["Per person"]).toBeNull();
    const loop: CustomMetric[] = [{ name: "A", formula: "B * 2", format: "number" }, { name: "B", formula: "A + 1", format: "number" }];
    await expect(readInsights(client, { level: "campaign", metrics: ["A"] }, loop)).rejects.toThrow(/uses itself/);
  });
});

describe("R9 big reports say when rows were cut", () => {
  it("Meta has more rows than asked for → truncated, with a note", async () => {
    const { client } = mockClient({ defaultPageSize: 2 });
    const r = await readInsights(client, { level: "adset", metrics: ["spend"], limit: 2 }, []);
    expect(r.rows.length).toBe(2);
    expect(r.truncated).toBe(true);
    expect(r.notes.join(" ")).toMatch(/Only the first 2 rows are shown/);
    const all = await readInsights(client, { level: "adset", metrics: ["spend"] }, []);
    expect(all.truncated).toBe(false);
    expect(all.notes).toEqual([]);
  });
});

describe("R10 metric names", () => {
  it("names are standard keys, actions:/cost: names or custom metrics", () => {
    expect(metricProblem("spend", [])).toBeNull();
    expect(metricProblem("actions:offsite_conversion.fb_pixel_purchase", [])).toBeNull();
    expect(metricProblem("action:lead", [])).toMatch(/Unknown metric "action:lead"/);
    expect(metricProblem("X", [{ name: "x", formula: "spnd / 2", format: "number" }])).toMatch(/"x" uses "spnd"/);
  });

  it("a saved column set with a removed metric is shown without it, with a note", async () => {
    const { client } = insightsClient(TWO);
    const r = await readInsights(client, { level: "campaign", metrics: ["spend", "Gone"] }, [], { dropUnknown: true });
    expect(r.columns.map((c) => c.key)).toEqual(["spend"]);
    expect(r.notes[0]).toMatch(/"Gone" was left out/);
  });
});

describe("R11 dates", () => {
  const now = Date.parse("2026-11-18T20:00:00Z"); // 19 Nov 01:30 in India, 18 Nov in California
  it("a start date alone runs to today in the ad account's time zone", () => {
    expect(dateRange({ since: "2026-11-01" }, "Asia/Kolkata", now).params).toEqual({ time_range: { since: "2026-11-01", until: "2026-11-19" } });
    expect(dateRange({ since: "2026-11-01" }, "America/Los_Angeles", now).params).toEqual({ time_range: { since: "2026-11-01", until: "2026-11-18" } });
  });
  it("unknown ranges and bad dates are refused in words", () => {
    expect(() => dateRange({ date_preset: "this_week_mon_today" })).toThrow(/Unknown date range "this_week_mon_today". Use one of today, yesterday/);
    expect(() => dateRange({ until: "2026-11-10" })).toThrow(/start date/);
    expect(() => dateRange({ since: "1 Nov" })).toThrow(/YYYY-MM-DD/);
    expect(() => dateRange({ since: "2026-11-10", until: "2026-11-01" })).toThrow(/after the end date/);
  });
  it("the results route runs a start date alone to today, says so, and returns the ad account's time zone", async () => {
    practice();
    const { POST } = await import("@/app/api/results/route");
    const res = await POST(req("/api/results", { method: "POST", body: JSON.stringify({ action: "query", level: "campaign", since: "2026-11-01", metrics: ["spend"] }) }), ctx);
    const body = (await res.json()) as { range: string; timezone: string; error?: string };
    expect(body.error).toBeUndefined();
    expect(body.range).toMatch(/^2026-11-01 to \d{4}-\d\d-\d\d \(today\)$/);
    expect(body.timezone).toBe("Asia/Kolkata");
  });

  it("a date that doesn't exist (30 February) is refused before any Meta call", async () => {
    const { mock } = practice();
    const { POST } = await import("@/app/api/results/route");
    const before = mock.calls.length;
    const res = await POST(req("/api/results", { method: "POST", body: JSON.stringify({ action: "query", level: "campaign", since: "2026-02-01", until: "2026-02-30", metrics: ["spend"] }) }), ctx);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/The end date "2026-02-30" isn't a date/);
    expect(mock.calls.length).toBe(before);
    expect(() => dateRange({ since: "2026-13-01" })).toThrow(/isn't a date/);
    expect(dateRange({ since: "2028-02-29", until: "2028-02-29" }).label).toBe("2028-02-29 to 2028-02-29");
  });
});

describe("R12 breakdown pairs", () => {
  it("allows pairs Meta accepts and refuses the rest in words", () => {
    expect(checkBreakdowns(["age", "gender", "day"])).toEqual(["age", "gender"]);
    expect(checkBreakdowns(["platform_position", "publisher_platform"])).toEqual(["platform_position", "publisher_platform"]);
    expect(checkBreakdowns(["country", "day"])).toEqual(["country"]);
    expect(() => checkBreakdowns(["age", "country"])).toThrow(/can't break results down by age and country together/);
    expect(() => checkBreakdowns(["platform_position"])).toThrow(/placement only together with platform/);
    expect(() => checkBreakdowns(["city"])).toThrow(/Unknown breakdown: city/);
  });
});

describe("R13 time zone note on Results", () => {
  it("only when the ad account isn't on India time", () => {
    expect(zoneNote("Asia/Kolkata")).toBeNull();
    expect(zoneNote(null)).toBeNull();
    expect(zoneNote("America/New_York")).toMatch(/America\/New York/);
  });
});

describe("Alerts", () => {
  beforeEach(() => {
    freshDb();
  });

  it("the same alert again replaces the earlier one on the home page (counted), and can be cleared", async () => {
    const a = { to: "marketer@example.com", subject: "Launch ab12c stopped", lines: ["x"], link: "https://app/batches/ab12c" };
    await sendAlert(a);
    await sendAlert({ ...a, lines: ["y"] });
    await sendAlert({ ...a, subject: "Plan p1 stopped", link: "https://app/plans/p1" });
    const list = recentAlerts(10);
    expect(list.map((x) => [x.subject, x.count])).toEqual([["Plan p1 stopped", 1], ["Launch ab12c stopped", 2]]);
    expect(list[1].lines).toEqual(["y"]);
    expect(clearAlerts("/batches/ab12c")).toBe(1);
    expect(recentAlerts(10).map((x) => x.subject)).toEqual(["Plan p1 stopped"]);
  });

  it("never throws, even with a line break in the address", async () => {
    const r = await sendAlert({ to: "marketer@example.com\r\nBcc: x@evil.test", subject: "s\r\nBcc: y", lines: [], link: "" });
    expect(r.emailed).toBe(false);
  });

  it("a line break in the subject, the address or a line can't add a header to the email (no hidden Bcc)", () => {
    const raw = alertMime({ to: "marketer@example.com\r\nBcc: x@evil.test", subject: "Launch ab12c: 3 ads not created\r\nBcc: y@evil.test", lines: ["Ad 1 (hook\r\nBcc: z@evil.test): failed"], link: "https://app/batches/ab12c" });
    const [head, ...rest] = raw.split("\r\n\r\n");
    const headers = head.split("\r\n");
    expect(headers.map((h) => h.split(":")[0])).toEqual(["To", "From", "Subject", "MIME-Version", "Content-Type", "Content-Transfer-Encoding"]);
    expect(headers[0]).toBe("To: marketer@example.com Bcc: x@evil.test");
    const subject = /^Subject: =\?UTF-8\?B\?(.+)\?=$/.exec(headers[2])![1];
    expect(Buffer.from(subject, "base64").toString("utf8")).toBe("Launch ab12c: 3 ads not created Bcc: y@evil.test");
    // A line break in a line stays in the body (after the blank line), where it is only text.
    expect(rest.join("\r\n\r\n")).toContain("Ad 1 (hook\r\nBcc: z@evil.test): failed");
  });
});
