import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { sha256 } from "@/lib/crypto";
import { MetaClient } from "@/lib/meta/client";
import { FakeClock, MockMeta } from "@/lib/meta/mock";
import { NOT_FOUND, deliveryStatus, planDeliveryTargets } from "@/lib/manage/delivery";
import { pixelCheck } from "@/lib/manage/checks";
import { readInsights, type CustomMetric } from "@/lib/manage/insights";
import { recentAlerts, sendAlert, appLink } from "@/lib/alerts";
import { clearBatchAlerts } from "@/lib/engine/launcher";
import { newBatch, upsertAccount } from "@/lib/setup";
import { getBatch, updateBatch } from "@/lib/store";
import { freshDb } from "./helpers";

// Independent review probes for the READS fixes. A failing test here is a bug; the name says
// what the marketer should get. Fake Meta, fake Gmail, fake web pages only.

vi.mock("@/auth", () => ({ auth: async () => null }));
vi.mock("@/lib/sources/drive", async (orig) => ({
  ...(await orig<typeof import("@/lib/sources/drive")>()),
  authFor: () => ({ getAccessToken: async () => ({ token: "fake-gmail-token" }) }),
}));

process.env.ALLOWED_EMAILS = "review@example.com";
const KEY = "sal_review_reads_key";
const g = globalThis as unknown as { __mockMeta?: MockMeta };

function mockClient() {
  const clock = new FakeClock();
  const mock = new MockMeta({ clock, capPoints: 9000, richAccount: true });
  const client = new MetaClient({ token: "t", accountId: mock.accountId, version: "v26.0", fetch: mock.fetch, clock });
  return { mock, client };
}

function addAds(mock: MockMeta, n: number, adset = "as1", prefix = "9") {
  const ids = Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(4, "0")}`);
  for (const id of ids) mock.objects.set(id, { id, name: `Ad ${id}`, adset_id: adset, status: "PAUSED", effective_status: "PENDING_REVIEW", _type: "ad" } as never);
  return ids;
}

// ---------------------------------------------------------------------------------------------

describe("Delivery", () => {
  it("120 ads by ID: read in chunks of 50, every ad found, none marked not found", async () => {
    const { mock, client } = mockClient();
    const ids = addAds(mock, 120);
    const before = mock.calls.length;
    const rows = await deliveryStatus(client, { ads: ids });
    expect(rows.filter((r) => r.status === NOT_FOUND)).toEqual([]);
    expect(rows.map((r) => r.id)).toEqual(ids);
    expect(mock.calls.length - before).toBe(3);
  });

  it("a Meta error that is not 'does not exist' (code 100, bad field) is shown as an error, not as every ad 'not found in Meta'", async () => {
    const { mock, client } = mockClient();
    const ids = addAds(mock, 2);
    const bad = { message: "(#100) Tried accessing nonexisting field (ad_review_feedback) on node type (Adgroup)", code: 100 };
    // The list read and each one-by-one read get the same answer (the field is the problem, not the IDs).
    for (let i = 0; i < 3; i++) mock.inject({ match: (m) => m === "GET", kind: "error", error: bad });
    const out = await deliveryStatus(client, { ads: ids }).then(
      (rows) => rows,
      (e) => e as Error,
    );
    expect(out).toBeInstanceOf(Error);
  });

  it("a go-live plan (set_status with saved kinds) gives the campaign, ad sets and ads", () => {
    const t = planDeliveryTargets(
      [{ type: "set_status", campaigns: ["c1"], adsets: ["as1"], ads: ["901", "902"] }],
      [{ ids: ["901", "902", "as1", "c1"], before: { "901": { kind: "ad" }, "902": { kind: "ad" }, as1: { kind: "adset" }, c1: { kind: "campaign" } } }],
    );
    expect(t).toEqual({ campaigns: ["c1"], adsets: ["as1"], ads: ["901", "902"] });
  });
});

// ---------------------------------------------------------------------------------------------

describe("Ads list", () => {
  it("a carousel ad shows its card headlines (the launcher's carousels put them on the cards)", async () => {
    process.env.META_MOCK = "1";
    freshDb();
    const mock = new MockMeta({ clock: new FakeClock(), capPoints: 9000, richAccount: true });
    g.__mockMeta = mock;
    upsertAccount({ metaAccountId: "act_1001", name: "Practice", token: "mock-token" });
    db().prepare("INSERT INTO api_keys (user_email, label, key_hash, key_hint) VALUES (?, 'test', ?, 'test')").run("review@example.com", sha256(KEY));
    const spec = { page_id: "p1", link_data: { link: "https://example.com/visit", message: "Book a visit", child_attachments: [{ link: "https://example.com/visit", name: "Free site visit" }, { link: "https://example.com/visit", name: "Plots from 20L" }] } };
    mock.objects.set("cr77", { id: "cr77", name: "carousel", body: { object_story_spec: spec }, object_story_spec: spec, _type: "creative" } as never);
    mock.objects.set("9777", { id: "9777", name: "Carousel ad", adset_id: "as1", creative_id: "cr77", status: "PAUSED", effective_status: "PAUSED", _type: "ad" } as never);
    const { GET } = await import("@/app/api/manage/ads/route");
    const res = await GET(new Request("http://app/api/manage/ads?adset=as1", { headers: { Authorization: `Bearer ${KEY}` } }), { params: Promise.resolve({}) });
    const body = (await res.json()) as { ads: { id: string; primaryTexts: string[]; headlines: string[]; link: string | null }[] };
    const ad = body.ads.find((a) => a.id === "9777")!;
    expect(ad.primaryTexts).toEqual(["Book a visit"]);
    expect(ad.link).toBe("https://example.com/visit");
    expect(ad.headlines).toEqual(["Free site visit", "Plots from 20L"]);
  });
});

// ---------------------------------------------------------------------------------------------

describe("Pixel check", () => {
  const fine = { accountId: "act_1", async get() { return { id: "px1", name: "Site pixel", last_fired_time: new Date().toISOString() }; } } as unknown as MetaClient;

  it("every landing page is checked, not only the first 5 (page 7 without the pixel gets a warning)", async () => {
    const pages = Array.from({ length: 7 }, (_, i) => `https://example.com/p${i}`);
    const fetchImpl = (async (url: string) => new Response(url.endsWith("/p6") ? "<html>no tag</html>" : "<script>fbq('init','px1')</script>", { status: 200 })) as unknown as typeof fetch;
    const checks = await pixelCheck(fine, "px1", pages, fetchImpl);
    expect(checks.map((c) => c.code)).toEqual(["pixel_not_on_page"]);
  });
});

// ---------------------------------------------------------------------------------------------

describe("Results totals (rows with different costs)", () => {
  type Row = Record<string, unknown>;
  const ROWS: Row[] = [
    { campaign_id: "c1", campaign_name: "A", spend: "1000", impressions: "40000", clicks: "400", actions: [{ action_type: "offsite_conversion.fb_pixel_purchase", value: "40" }], cost_per_action_type: [{ action_type: "offsite_conversion.fb_pixel_purchase", value: "25" }] },
    { campaign_id: "c2", campaign_name: "B", spend: "3000", impressions: "10000", clicks: "100", actions: [{ action_type: "offsite_conversion.fb_pixel_purchase", value: "10" }], cost_per_action_type: [{ action_type: "offsite_conversion.fb_pixel_purchase", value: "300" }] },
  ];
  const client = {
    accountId: "act_1",
    async getAll(_p: string, params: Record<string, unknown>, max: number) {
      const fields = String(params.fields).split(",");
      return ROWS.slice(0, max).map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => fields.includes(k))));
    },
  } as unknown as MetaClient;

  it("cost per purchase and a custom metric on it total as total spend ÷ total purchases (80), not the average of rows (162.5)", async () => {
    const custom: CustomMetric[] = [{ name: "CPP GST", formula: "cost:offsite_conversion.fb_pixel_purchase * 1.18", format: "money" }];
    const r = await readInsights(client, { level: "campaign", metrics: ["cost:offsite_conversion.fb_pixel_purchase", "CPP GST", "cpm"] }, custom);
    expect(r.totals["cost:offsite_conversion.fb_pixel_purchase"]).toBe(80);
    expect(r.totals["CPP GST"]).toBeCloseTo(94.4);
    expect(r.totals.cpm).toBe(80);
  });
});

// ---------------------------------------------------------------------------------------------

describe("Alerts", () => {
  let sent: string[] = [];
  beforeEach(() => {
    freshDb();
    sent = [];
    db().prepare("INSERT INTO users (email, google_scope) VALUES (?, ?)").run("marketer@example.com", "openid https://www.googleapis.com/auth/gmail.send");
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      if (String(url).includes("gmail.googleapis.com")) {
        const raw = JSON.parse(String(init.body)).raw as string;
        sent.push(Buffer.from(raw, "base64url").toString("utf8"));
        return new Response("{}", { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("a later, different failure under the same subject (Retry failed again for another reason) is emailed", async () => {
    const a = { to: "marketer@example.com", subject: "Launch ab12c: 2 ads not created", lines: ["Ad 1: image too small"], link: "https://app/batches/ab12c" };
    expect((await sendAlert(a)).emailed).toBe(true);
    const again = await sendAlert({ ...a, lines: ["Ad 1: Meta says the Page is restricted from advertising"] });
    expect(again.emailed).toBe(true);
  });

  it("the home-page alert 'ads created but not turned on yet' stays while go-live keeps failing (each go-live retry re-runs the launch, whose end clears the batch's alerts)", async () => {
    process.env.META_MOCK = "1";
    const accountId = upsertAccount({ metaAccountId: "act_1001", name: "Practice", token: "mock-token" });
    const batchId = newBatch(accountId, "marketer@example.com");
    updateBatch(batchId, { campaign_id: "c1", adset_id: "as1", go_live: "now", status: "done" } as never);
    const key = getBatch(batchId)!.key;
    db().prepare("INSERT INTO ads (batch_id, position, key, creative_name, status, meta_adset_id, meta_ad_id) VALUES (?, 1, ?, 'ad1', 'done', 'as1', '901')").run(batchId, `${key}-01`);
    await sendAlert({ to: "marketer@example.com", subject: `Launch ${key}: ads created but not turned on yet`, lines: ["Ads created but not turned on yet: Meta is limiting calls"], link: appLink(`/batches/${key}`) });
    // What runBatch's finish() does on the go-live retry 5 minutes later (0 failed ads, go-live still not done).
    clearBatchAlerts(batchId);
    expect(recentAlerts(10).map((x) => x.subject)).toEqual([`Launch ${key}: ads created but not turned on yet`]);
  });
});
