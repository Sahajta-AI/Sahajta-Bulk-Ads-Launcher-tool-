import { describe, expect, it } from "vitest";
import { MetaClient } from "@/lib/meta/client";
import { FakeClock, MockMeta } from "@/lib/meta/mock";
import { MetaError, RateLimitedError, plainError } from "@/lib/meta/errors";
import { readInsights, type CustomMetric } from "@/lib/manage/insights";
import { NOT_FOUND, deliveryStatus } from "@/lib/manage/delivery";
import { accountHealth, pixelCheck } from "@/lib/manage/checks";
import { checkLinks } from "@/lib/engine/preview";
import { recentAlerts, sendAlert } from "@/lib/alerts";
import { deleteResultsItem, results, saveColumnSet, saveCustomMetric } from "@/lib/manage/service";
import { upsertAccount } from "@/lib/setup";
import { freshDb } from "./helpers";

// Audit of reading and reporting (Results, delivery, checks, alerts). Each failing test names the
// behaviour the marketer should get. Fake clients only: no real Meta, Google or web calls.

type Row = Record<string, unknown>;

/** A fake Meta that only returns the fields the launcher asked for, like the real one. */
function insightsClient(rows: Row[]) {
  const calls: Record<string, unknown>[] = [];
  const client = {
    accountId: "act_1",
    async getAll(_path: string, params: Record<string, unknown>) {
      calls.push(params);
      const fields = String(params.fields).split(",");
      return rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => fields.includes(k))));
    },
  } as unknown as MetaClient;
  return { client, calls };
}

const TWO_CAMPAIGNS: Row[] = [
  {
    campaign_id: "c1", campaign_name: "A", spend: "1000", impressions: "50000",
    actions: [{ action_type: "lead", value: "20" }],
    cost_per_action_type: [{ action_type: "lead", value: "50" }],
    video_thruplay_watched_actions: [{ action_type: "video_view", value: "300" }],
  },
  {
    campaign_id: "c2", campaign_name: "B", spend: "500", impressions: "20000",
    actions: [{ action_type: "lead", value: "5" }],
    cost_per_action_type: [{ action_type: "lead", value: "100" }],
    video_thruplay_watched_actions: [{ action_type: "video_view", value: "200" }],
  },
];
// The two rows' cost per lead differ (₹50 and ₹100): a total that averaged the rows (₹75) would be wrong.

describe("Results: totals and custom metrics", () => {
  it("the ThruPlays total adds up the rows (not 0)", async () => {
    const { client } = insightsClient(TWO_CAMPAIGNS);
    const r = await readInsights(client, { level: "campaign", metrics: ["spend", "video_thruplay_watched_actions"] }, []);
    expect(r.rows[0].values.video_thruplay_watched_actions).toBe(300);
    expect(r.totals.video_thruplay_watched_actions).toBe(500);
  });

  it("the cost per lead total works when the Leads column is not in the column set", async () => {
    const { client } = insightsClient(TWO_CAMPAIGNS);
    const r = await readInsights(client, { level: "campaign", metrics: ["spend", "cost:lead"] }, []);
    expect(r.rows.map((x) => x.values["cost:lead"])).toEqual([50, 100]);
    expect(r.totals["cost:lead"]).toBe(60); // ₹1,500 / 25 leads
  });

  it("a custom metric built on another custom metric asks Meta for the fields it needs", async () => {
    const { client } = insightsClient(TWO_CAMPAIGNS);
    const custom: CustomMetric[] = [
      { name: "CPL", formula: "spend / actions:lead", format: "money" },
      { name: "CPL with GST", formula: "CPL * 1.18", format: "money" },
    ];
    const r = await readInsights(client, { level: "campaign", metrics: ["spend", "CPL with GST"] }, custom);
    expect(r.rows[0].values["CPL with GST"]).toBeCloseTo(59);
  });

  it("the total of a custom metric that uses cost:lead is worked out, not –", async () => {
    const { client } = insightsClient(TWO_CAMPAIGNS);
    const custom: CustomMetric[] = [{ name: "CPL incl GST", formula: "cost:lead * 1.18", format: "money" }];
    const r = await readInsights(client, { level: "campaign", metrics: ["spend", "actions:lead", "CPL incl GST"] }, custom);
    expect(r.rows[0].values["CPL incl GST"]).toBeCloseTo(59);
    expect(r.totals["CPL incl GST"]).toBeCloseTo(70.8); // ₹60 × 1.18
  });

  it("a typo in a formula is refused with a plain message, not shown as – in every row", async () => {
    const { client } = insightsClient(TWO_CAMPAIGNS);
    const custom: CustomMetric[] = [{ name: "Bad CPL", formula: "spnd / actions:lead", format: "money" }];
    await expect(readInsights(client, { level: "campaign", metrics: ["Bad CPL"] }, custom)).rejects.toThrow(/spnd/);
  });

  it("a misspelt action metric (action:lead) is refused, not shown as – in every row", async () => {
    const { client } = insightsClient(TWO_CAMPAIGNS);
    await expect(readInsights(client, { level: "campaign", metrics: ["action:lead"] }, [])).rejects.toThrow();
  });

  it("a start date without an end date is refused, not silently replaced by the last 7 days", async () => {
    const { client, calls } = insightsClient(TWO_CAMPAIGNS);
    let refused = false;
    try {
      await readInsights(client, { level: "campaign", since: "2026-11-01", metrics: ["spend"] }, []);
    } catch {
      refused = true;
    }
    expect(refused || calls[0]?.time_range !== undefined).toBe(true);
  });
});

/** A real MetaClient over a fake fetch, so paging, retries and error words are the real ones. */
function realClient(fetchImpl: typeof fetch) {
  return new MetaClient({ token: "t", accountId: "act_1", version: "v26.0", fetch: fetchImpl, clock: new FakeClock() });
}

describe("Results: big reports", () => {
  it("with more rows than the launcher reads, the result says so (totals are not from part of the data)", async () => {
    const total = 2500;
    let served = 0;
    const fake = (async () => {
      const page = Array.from({ length: Math.min(500, total - served) }, (_, i) => ({ ad_id: String(served + i), ad_name: `Ad ${served + i}`, spend: "10" }));
      served += page.length;
      const more = served < total;
      return new Response(JSON.stringify({ data: page, paging: more ? { cursors: { after: `p${served}` }, next: "https://graph.facebook.com/next" } : { cursors: {} } }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await readInsights(realClient(fake), { level: "ad", metrics: ["spend"] }, []);
    const complete = r.rows.length === total && r.totals.spend === total * 10;
    const flagged = (r as unknown as { truncated?: boolean }).truncated === true;
    expect(complete || flagged).toBe(true);
  });

  const tooBig = () =>
    new Response(JSON.stringify({ error: { message: "Please reduce the amount of data you're asking for, then retry your request", type: "OAuthException", code: 1, error_subcode: 99 } }), { status: 500 });

  it("Meta's 'reduce the amount of data' answer tells the marketer to pick fewer days or rows, not 'connection problem'", async () => {
    const err = await readInsights(realClient((async () => tooBig()) as unknown as typeof fetch), { level: "ad", date_preset: "maximum", breakdowns: ["day"] }, []).catch((e) => e);
    expect(err).toBeInstanceOf(MetaError);
    expect(plainError(err, "Reading results")).toMatch(/fewer|shorter|smaller|less|reduce/i);
  });

  it("a report Meta says is too big is asked once, not three times (each try costs starter-tier calls)", async () => {
    let calls = 0;
    const fake = (async () => { calls++; return tooBig(); }) as unknown as typeof fetch;
    await readInsights(realClient(fake), { level: "ad", date_preset: "maximum" }, []).catch(() => null);
    expect(calls).toBe(1);
  });
});

describe("Delivery status", () => {
  it("a rate-limit refusal is reported, not turned into an empty table", async () => {
    // Corrected after the fix (R1): delivery now reads the ad account's lists in pages (getAll), so the
    // fake refuses there too. With getAll answering [] the ads are simply not in Meta (shown as such).
    const client = {
      accountId: "act_1",
      async get() { throw new RateLimitedError(Date.now() + 10 * 60_000, "development_access"); },
      async getAll() { throw new RateLimitedError(Date.now() + 10 * 60_000, "development_access"); },
    } as unknown as MetaClient;
    await expect(deliveryStatus(client, { ads: ["11", "12"] })).rejects.toThrow();
  });

  it("placement-specific review feedback is shown in words, not [object Object]", async () => {
    // Corrected after the fix (R1): the ad now comes from the paged list read (getAll), not a read per ad.
    const ad = {
      id: "11", name: "Ad 1", adset_id: "9", effective_status: "DISAPPROVED",
      ad_review_feedback: { global: { "Personal attributes": "Ads must not imply personal traits." }, placement_specific: { instagram: { "Personal attributes": "Not allowed on Instagram." } } },
    };
    const client = {
      accountId: "act_1",
      async get() { return ad; },
      async getAll() { return [ad]; },
    } as unknown as MetaClient;
    const rows = await deliveryStatus(client, { ads: ["11"] });
    expect(rows[0].issues.join(" | ")).not.toContain("[object Object]");
    expect(rows[0].issues.join(" | ")).toContain("Instagram – Personal attributes: Not allowed on Instagram.");
  });

  it("delivery of a 20-ad batch (one ad set per ad) costs 2 Meta reads, not one per ad set and one per ad, and finds every one", async () => {
    const clock = new FakeClock();
    const mock = new MockMeta({ clock, capPoints: 9000, richAccount: true });
    const client = new MetaClient({ token: "t", accountId: mock.accountId, version: "v26.0", fetch: mock.fetch, clock });
    const sets = Array.from({ length: 20 }, (_, i) => `55${String(i).padStart(3, "0")}`);
    const ads = sets.map((s) => `${s}9`);
    sets.forEach((s, i) => {
      mock.objects.set(s, { id: s, name: `Ad set ${i + 1}`, campaign_id: "c1", status: "PAUSED", effective_status: "PAUSED", _type: "adset" } as never);
      mock.objects.set(ads[i], { id: ads[i], name: `Ad ${i + 1}`, adset_id: s, status: "PAUSED", effective_status: "PENDING_REVIEW", _type: "ad" } as never);
    });
    const before = mock.calls.length;
    const rows = await deliveryStatus(client, { adsets: sets, ads });
    expect(mock.calls.length - before).toBe(2);
    // Each ad set, then its ad; none "not found".
    expect(rows.map((r) => r.id)).toEqual(sets.flatMap((s, i) => [s, ads[i]]));
    expect(rows.filter((r) => r.status === NOT_FOUND)).toEqual([]);
  });
});

describe("Pixel and landing page checks", () => {
  const pixelClient = {
    accountId: "act_1",
    async get() { return { id: "px1", name: "Site pixel", last_fired_time: new Date().toISOString() }; },
  } as unknown as MetaClient;

  it("a page that blocks the checker (403) does not claim the pixel is missing", async () => {
    const blocked = (async () => new Response("<html><body>Access denied</body></html>", { status: 403 })) as unknown as typeof fetch;
    const checks = await pixelCheck(pixelClient, "px1", ["https://example.com/lp"], blocked);
    expect(checks.map((c) => c.code)).not.toContain("pixel_not_on_page");
  });

  it("being rate-limited does not say the pixel isn't in the ad account (that error blocks the launch)", async () => {
    const limited = { accountId: "act_1", async get() { throw new RateLimitedError(Date.now() + 10 * 60_000, "development_access"); } } as unknown as MetaClient;
    const checks = await pixelCheck(limited, "px1").catch(() => []);
    expect(checks.map((c) => c.code)).not.toContain("pixel_missing");
  });

  it("a landing page whose domain has no DNS record gets a clear message (warmchain.sahajta.com)", async () => {
    const nxdomain = (async () => {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND warmchain.sahajta.com"), { code: "ENOTFOUND", hostname: "warmchain.sahajta.com" }) });
    }) as unknown as typeof fetch;
    const started = Date.now();
    const res = await checkLinks(["https://warmchain.sahajta.com/apply"], nxdomain);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(res.get("https://warmchain.sahajta.com/apply")).toMatch(/does not exist|doesn't exist|no DNS|not registered|domain/i);
  });
});

describe("Account health", () => {
  it("a failed read is not remembered for 10 minutes: the next check asks Meta again", async () => {
    freshDb();
    let n = 0;
    const client = {
      accountId: "act_9",
      async get() {
        if (n++ === 0) throw new MetaError("Network error", { status: 0, unknownOutcome: true });
        return { name: "Main", account_status: 3, currency: "INR", funding_source_details: { display_string: "Visa" } };
      },
    } as unknown as MetaClient;
    await accountHealth(client);
    const second = await accountHealth(client);
    expect(second.map((c) => c.code)).toContain("account_status");
  });

  it("a disabled ad account says why (Meta's disable_reason)", async () => {
    freshDb();
    const client = {
      accountId: "act_8",
      async get() { return { name: "Main", account_status: 2, disable_reason: 3, currency: "INR", funding_source_details: { display_string: "Visa" } }; },
    } as unknown as MetaClient;
    const checks = await accountHealth(client);
    expect(checks.find((c) => c.code === "account_status")?.message).toMatch(/payment/i);
  });
});

describe("Column sets and custom metrics", () => {
  it("removing a custom metric that a column set uses does not break the Results page", async () => {
    process.env.META_MOCK = "1";
    freshDb();
    (globalThis as unknown as { __mockMeta?: MockMeta }).__mockMeta = new MockMeta({ clock: new FakeClock(), capPoints: 9000, richAccount: true });
    upsertAccount({ metaAccountId: "act_1001", name: "Practice", token: "mock-token" });
    const id = saveCustomMetric({ name: "CPL with GST", formula: "spend / actions:lead * 1.18", format: "money" });
    saveColumnSet({ name: "Mine", metrics: ["spend", "actions:lead", "CPL with GST"], isDefault: true });
    deleteResultsItem("custom_metric", id);
    await expect(results({ level: "campaign" })).resolves.toBeTruthy();
  });
});

describe("Alerts (should pass: never break the worker)", () => {
  it("an alert for someone without the Gmail permission is kept on the home page and does not throw", async () => {
    freshDb();
    const r = await sendAlert({ to: "marketer@example.com", subject: "Launch ab12c: 3 ads not created\r\nBcc: x@evil.test", lines: ["Ad 1 (hook\r\nBcc: y): failed"], link: "https://app/batches/ab12c" });
    expect(r.emailed).toBe(false);
    expect(recentAlerts(5)[0].subject).toContain("Launch ab12c");
  });
});
