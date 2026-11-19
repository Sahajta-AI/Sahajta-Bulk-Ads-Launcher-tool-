import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Round 2, group READS-INFRA: go-live retries, alerts that stay until the problem is gone,
// delivery reads (missing IDs, IDs of unknown kind, campaigns), settings currency, Results helpers.
// Practice Meta (mock) and a fake Gmail only.

const ctl = vi.hoisted(() => ({
  runBatchCalls: 0,
  queueGoLive: null as null | ((id: number) => Promise<string | null>),
}));

vi.mock("@/auth", () => ({ auth: async () => null }));
vi.mock("@/lib/engine/launcher", async (orig) => {
  const real = await orig<typeof import("@/lib/engine/launcher")>();
  return {
    ...real,
    runBatch: (id: number, deps: never) => {
      ctl.runBatchCalls++;
      return real.runBatch(id, deps);
    },
  };
});
vi.mock("@/lib/manage/golive", async (orig) => {
  const real = await orig<typeof import("@/lib/manage/golive")>();
  return { ...real, queueGoLive: (id: number) => (ctl.queueGoLive ? ctl.queueGoLive(id) : real.queueGoLive(id)) };
});
vi.mock("@/lib/cleanup", async (orig) => {
  const real = await orig<typeof import("@/lib/cleanup")>();
  return { ...real, removeBatchFiles: () => 0 };
});
vi.mock("@/lib/sources/drive", async (orig) => ({
  ...(await orig<typeof import("@/lib/sources/drive")>()),
  authFor: () => ({ getAccessToken: async () => ({ token: "fake-gmail-token" }) }),
}));

import { sha256 } from "@/lib/crypto";
import { db } from "@/lib/db";
import { goLiveNote, recentAlerts, sendAlert, appLink } from "@/lib/alerts";
import { GO_LIVE_MAX_TRIES, GO_LIVE_NOTE_MS, LANES, claimNext, enqueue, goLiveRetryKey } from "@/lib/jobs";
import { cancelBatch, retryFailed } from "@/lib/service";
import { MetaClient } from "@/lib/meta/client";
import { FakeClock, MockMeta } from "@/lib/meta/mock";
import { NOT_FOUND, deliveryStatus, planDeliveryTargets } from "@/lib/manage/delivery";
import { newBatch, upsertAccount } from "@/lib/setup";
import { cacheSet, getBatch, updateBatch } from "@/lib/store";
import { goLive, runClaimed } from "@/worker/run";
import { withPlatform } from "@/app/results/shared";
import { freshDb } from "./helpers";

process.env.ALLOWED_EMAILS = "r2@example.com";
const KEY = "sal_r2_reads_infra_key";
const g = globalThis as unknown as { __mockMeta?: MockMeta };
const WHO = "marketer@example.com";

let mock: MockMeta;
let accountId: number;
let sent: string[] = [];

beforeEach(() => {
  process.env.META_MOCK = "1";
  freshDb();
  mock = new MockMeta({ clock: new FakeClock(), capPoints: 9000, richAccount: true });
  g.__mockMeta = mock;
  accountId = upsertAccount({ metaAccountId: "act_1001", name: "Practice", token: "mock-token" });
  db().prepare("INSERT INTO api_keys (user_email, label, key_hash, key_hint) VALUES (?, 'test', ?, 'test')").run("r2@example.com", sha256(KEY));
  db().prepare("INSERT INTO users (email, google_scope) VALUES (?, ?)").run(WHO, "openid https://www.googleapis.com/auth/gmail.send");
  ctl.runBatchCalls = 0;
  ctl.queueGoLive = null;
  sent = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    if (String(url).includes("gmail.googleapis.com")) {
      sent.push(Buffer.from(JSON.parse(String(init.body)).raw as string, "base64url").toString("utf8"));
      return new Response("{}", { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** A batch launched with "now" whose two ads are already in Meta (the launch run makes no Meta call). */
function launchedBatch(): { id: number; key: string } {
  const id = newBatch(accountId, WHO);
  const key = getBatch(id)!.key;
  for (const n of [1, 2]) {
    db().prepare("INSERT INTO ads (batch_id, position, key, creative_name, status, meta_adset_id, meta_ad_id) VALUES (?, ?, ?, ?, 'done', 'as1', ?)").run(id, n, `${key}-0${n}`, `ad${n}`, `90${n}`);
    // The ads in the practice Meta, so the real turn-on step (queueGoLive) can read them.
    mock.objects.set(`90${n}`, { id: `90${n}`, name: `[L:${key}-0${n}] ad${n}`, adset_id: "as1", campaign_id: "c1", status: "PAUSED", effective_status: "PAUSED", _type: "ad" } as never);
  }
  updateBatch(id, { campaign_id: "c1", adset_id: "as1", go_live: "now", go_live_total: "₹500", status: "queued" } as never);
  return { id, key };
}

const jobs = (kind: string, batchId: number | null, status = "queued") =>
  db().prepare("SELECT * FROM jobs WHERE kind = ? AND batch_id IS ? AND status = ?").all(kind, batchId, status) as { id: number; run_after: number }[];
const turnOnPlans = (key: string) => db().prepare("SELECT status FROM plans WHERE title LIKE ? ORDER BY id").pluck().all(`Turn on batch ${key} (%`) as string[];
/** Meta refuses the next call: the login expired (the go-live try fails). */
const refuseNext = () => mock.inject({ match: () => true, kind: "error", error: { message: "Invalid OAuth access token", code: 190 }, status: 400 });
const events = (batchId: number) => db().prepare("SELECT message FROM events WHERE batch_id = ? ORDER BY id").pluck().all(batchId) as string[];

// ---------------------------------------------------------------------------------------------

describe("Go-live retries run only the turn-on step (META+INFRA 3)", () => {
  it(`${GO_LIVE_MAX_TRIES} failed tries: the launch runs once, no new run, no status change, no review check moved, no backup per try`, async () => {
    const b = launchedBatch();
    ctl.queueGoLive = async () => {
      throw new Error("Meta did not answer");
    };
    enqueue("launch", b.id);
    await runClaimed(claimNext(LANES.launch)!);
    expect(ctl.runBatchCalls).toBe(1);
    expect(getBatch(b.id)).toMatchObject({ status: "done", run_count: 1 });
    const review = jobs("review", b.id)[0].run_after;
    // The backup after the launch ran.
    db().prepare("UPDATE jobs SET status = 'done' WHERE kind = 'backup'").run();
    expect(goLiveNote(b.id)).toMatch(/^Turning the ads on failed 1 time \(Meta did not answer\)\. Trying again at \d{1,2}:\d\d [ap]m IST\.$/);

    for (let i = 2; i <= GO_LIVE_MAX_TRIES; i++) {
      db().prepare("UPDATE jobs SET run_after = 0 WHERE kind = 'golive' AND status = 'queued'").run();
      const job = claimNext(LANES.other)!;
      expect(job.kind).toBe("golive");
      await runClaimed(job);
      expect(getBatch(b.id)!.status).toBe("done");
    }
    expect(ctl.runBatchCalls).toBe(1);
    expect(getBatch(b.id)!.run_count).toBe(1);
    expect(jobs("launch", b.id, "done")).toHaveLength(1);
    expect(events(b.id).filter((m) => /^Run \d+ started|^Launch started|^Finished:/.test(m))).toEqual(["Launch started.", "Finished: 2 ads created."]);
    expect(jobs("backup", null)).toHaveLength(0);
    expect(jobs("review", b.id)[0].run_after).toBe(review);
    expect(jobs("golive", b.id)).toHaveLength(0); // gave up
    expect(events(b.id).at(-1)).toMatch(/didn't work after 12 tries: Meta did not answer\. The ads stay paused/);
    expect(goLiveNote(b.id)).toBe("The ads were NOT turned on: Meta did not answer. They stay paused.");
    // The person heard twice (first try and giving up), not 12 times; the alert stays on the home page.
    expect(sent).toHaveLength(2);
    expect(recentAlerts(5).map((a) => a.subject)).toEqual([`Launch ${b.key}: ads created but not turned on yet`]);
  });

  it("a go-live retry that finds the batch launching again (Retry) leaves the turn-on to that launch", async () => {
    const b = launchedBatch();
    let called = 0;
    ctl.queueGoLive = async () => {
      called++;
      return null;
    };
    enqueue("golive", b.id, 0);
    await runClaimed(claimNext(LANES.other)!);
    expect(called).toBe(0);
  });

  // Round 3: these ran with a mocked queueGoLive; they now run the real turn-on step on the practice Meta.
  // (The web Retry pressed while the worker's try reads Meta: review2-infra "Retry pressed on the page…".)
  it("a retry in one lane and a launch's own go-live in another never run at the same time: one turn-on plan", async () => {
    const b = launchedBatch();
    updateBatch(b.id, { status: "done" } as never);
    // Each real try reads Meta before it saves its plan: run side by side, each would make one.
    await Promise.all([goLive(b.id), goLive(b.id), goLive(b.id)]);
    expect(turnOnPlans(b.key)).toEqual(["queued"]);
    expect(db().prepare("SELECT COUNT(*) FROM jobs WHERE kind = 'plan' AND status = 'queued'").pluck().get()).toBe(1);
  });

  it("goLiveNote: null for a paused launch, before anything failed, while Stop is in force and once the turn-on step went through; kept 14 days after the worker gave up", async () => {
    const b = launchedBatch();
    updateBatch(b.id, { status: "done" } as never);
    expect(goLiveNote(b.id)).toBeNull();
    refuseNext();
    await goLive(b.id);
    expect(goLiveNote(b.id)).toMatch(/^Turning the ads on failed 1 time \(Invalid OAuth access token\)\. Trying again at/);
    updateBatch(b.id, { go_live: "paused" } as never);
    expect(goLiveNote(b.id)).toBeNull();
    updateBatch(b.id, { go_live: "now" } as never);

    // Stop pressed while the worker waits to try again: no "trying again" any more, and the waiting try is dropped.
    cancelBatch(b.key);
    expect(goLiveNote(b.id)).toBeNull();
    db().prepare("UPDATE jobs SET run_after = 0 WHERE kind = 'golive' AND status = 'queued'").run();
    await runClaimed(claimNext(LANES.other)!);
    expect(jobs("golive", b.id)).toHaveLength(0);
    expect(turnOnPlans(b.key)).toEqual([]);
    expect(recentAlerts(5).filter((a) => a.subject.includes(b.key))).toEqual([]);

    // Retry after the Stop: the Stop is no longer in force, a new failure is said again.
    retryFailed(b.key);
    refuseNext();
    await goLive(b.id);
    expect(goLiveNote(b.id)).toMatch(/^Turning the ads on failed 1 time \(Invalid OAuth access token\)\. Trying again at/);

    // The worker gives up (12th try); a day later the batch still says so (kept 14 days).
    cacheSet(goLiveRetryKey(b.id), GO_LIVE_MAX_TRIES - 1, GO_LIVE_NOTE_MS);
    db().prepare("UPDATE jobs SET status = 'done' WHERE kind = 'golive' AND status = 'queued'").run();
    refuseNext();
    await goLive(b.id);
    expect(goLiveNote(b.id)).toBe("The ads were NOT turned on: Invalid OAuth access token. They stay paused.");
    db().prepare("UPDATE cache SET expires_at = ? WHERE key LIKE 'golive_retry:%' AND expires_at <= ?").run(Date.now() - 1, Date.now() + 25 * 3_600_000);
    expect(goLiveNote(b.id)).toBe("The ads were NOT turned on: Invalid OAuth access token. They stay paused.");
    // Retry, and the turn-on step goes through: null.
    retryFailed(b.key);
    db().prepare("UPDATE jobs SET run_after = 0 WHERE kind = 'golive' AND status = 'queued'").run();
    await runClaimed(claimNext(LANES.other)!);
    expect(getBatch(b.id)!.go_live_done).toBe(1);
    expect(goLiveNote(b.id)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------

describe("Alerts stay until the problem is really gone (READS 1, 3)", () => {
  it("every ad in: 'not created' and 'stopped' leave the home page; 'not turned on yet' stays until the turn-on step went through", async () => {
    const b = launchedBatch();
    const link = appLink(`/batches/${b.key}`);
    await sendAlert({ to: WHO, kind: "create_failed", subject: `Launch ${b.key}: 1 ad not created`, lines: ["Ad 2: image too small"], link });
    await sendAlert({ to: WHO, kind: "stopped", subject: `Launch ${b.key} stopped`, lines: ["network drop"], link });
    await sendAlert({ to: WHO, subject: "Plan p1 was not run at 9:00 am", lines: ["x"], link: appLink("/plans/p1") });
    // The launch's own turn-on step (real queueGoLive): Meta refuses its first read.
    refuseNext();
    enqueue("launch", b.id);
    await runClaimed(claimNext(LANES.launch)!);
    expect(getBatch(b.id)!.go_live_done).toBe(0);
    expect(recentAlerts(10).map((a) => a.subject)).toEqual([`Launch ${b.key}: ads created but not turned on yet`, "Plan p1 was not run at 9:00 am"]);
    // The next go-live try works (its turn-on plan is queued): the go-live alert goes too; the plan's stays.
    db().prepare("UPDATE jobs SET run_after = 0 WHERE kind = 'golive' AND status = 'queued'").run();
    await runClaimed(claimNext(LANES.other)!);
    expect(getBatch(b.id)!.go_live_done).toBe(1);
    expect(turnOnPlans(b.key)).toEqual(["queued"]);
    expect(recentAlerts(10).map((a) => a.subject)).toEqual(["Plan p1 was not run at 9:00 am"]);
    expect(goLiveNote(b.id)).toBeNull();
  });

  it("the same words again within 6 hours are not emailed again (counted on the home page); new words are", async () => {
    const a = { to: WHO, kind: "create_failed" as const, subject: "Launch ab12c: 1 ad not created", lines: ["Ad 1: image too small"], link: "https://app/batches/ab12c" };
    expect((await sendAlert(a)).emailed).toBe(true);
    expect((await sendAlert(a)).emailed).toBe(false);
    expect((await sendAlert({ ...a, lines: ["Ad 1: the Page is restricted"] })).emailed).toBe(true);
    expect((await sendAlert({ ...a, lines: ["Ad 1: the Page is restricted"] })).emailed).toBe(false);
    expect(sent).toHaveLength(2);
    expect(recentAlerts(10).map((x) => [x.lines[0], x.count])).toEqual([["Ad 1: the Page is restricted", 4]]);
  });
});

// ---------------------------------------------------------------------------------------------

describe("Delivery reads (READS 2, 6 and campaigns not found)", () => {
  const client = () => new MetaClient({ token: "t", accountId: mock.accountId, version: "v26.0", fetch: mock.fetch, clock: new FakeClock() });
  const addAd = (id: string, adset: string) => mock.objects.set(id, { id, name: `Ad ${id}`, adset_id: adset, status: "PAUSED", effective_status: "PENDING_REVIEW", _type: "ad" } as never);

  it("when Meta refuses the filter and then refuses a field, the one-by-one reads stop at the first error (not one call per ID)", async () => {
    for (const id of ["901", "902", "903", "904"]) addAd(id, "as1");
    mock.inject({ match: (m, p) => m === "GET" && p === `${mock.accountId}/ads`, kind: "error", error: { message: "(#100) Filtering field id with operation in is not supported", code: 100 } });
    for (let i = 0; i < 4; i++) mock.inject({ match: (m) => m === "GET", kind: "error", error: { message: "(#100) Tried accessing nonexisting field (ad_review_feedback) on node type (Adgroup)", code: 100 } });
    const before = mock.calls.length;
    await expect(deliveryStatus(client(), { ads: ["901", "902", "903", "904"] })).rejects.toThrow(/nonexisting field/);
    expect(mock.calls.length - before).toBe(2);
  });

  it("an ID Meta says does not exist (subcode 33) is 'not found'; the others are read", async () => {
    addAd("901", "as1");
    mock.inject({ match: (m, p) => m === "GET" && p === `${mock.accountId}/ads`, kind: "error", error: { message: "Invalid filtering field", code: 100 } });
    mock.inject({ match: (m, p) => m === "GET" && p === "777", kind: "error", error: { message: "Unsupported get request. Object with ID '777' cannot be loaded due to missing permissions", code: 100, error_subcode: 33 } });
    const rows = await deliveryStatus(client(), { ads: ["777", "901"] });
    expect(rows.map((r) => [r.id, r.status])).toEqual([["901", "PENDING_REVIEW"], ["777", NOT_FOUND]]);
  });

  it("a plan's older turn-on step without saved kinds: its IDs are read as ad sets and ads (one list read each), a campaign ID is left out", async () => {
    for (const id of ["901", "902"]) addAd(id, "as1");
    addAd("903", "as2");
    const t = planDeliveryTargets(
      [{ type: "set_status", campaigns: ["November tests"], adsets: ["November test ad set"], ads: ["903"], whole_campaigns: ["c2"] }],
      [{ ids: ["c1", "as1", "903", "c2"] }],
    );
    expect(t).toEqual({ campaigns: ["c2"], adsets: [], ads: ["903"], unknown: ["c1", "as1"] });
    const before = mock.calls.length;
    const rows = await deliveryStatus(client(), t);
    expect(mock.calls.length - before).toBeLessThanOrEqual(5);
    const ids = rows.map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining(["as1", "901", "902", "903"]));
    expect(ids).not.toContain("c1");
    expect(rows.filter((r) => r.status === NOT_FOUND)).toEqual([]);
  });

  it("a campaign Meta doesn't have gets a 'not found' row; a real campaign gets its ad sets and no campaign row", async () => {
    const gone = await deliveryStatus(client(), { campaigns: ["999000111"] });
    expect(gone).toEqual([{ kind: "campaign", id: "999000111", name: "", status: NOT_FOUND, plain: "not found in Meta (deleted, or not in this ad account)", learning: null, issues: [] }]);
    const real = await deliveryStatus(client(), { campaigns: ["c1"] });
    expect(real.length).toBeGreaterThan(0);
    expect(real.some((r) => r.kind === "campaign")).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------

describe("Small fixes (READS 8, settings currency)", () => {
  const req = (url: string, init: RequestInit = {}) => new Request(`http://app${url}`, { ...init, headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" } });
  const ctx = { params: Promise.resolve({}) };

  it("/api/settings gives the ad account's currency (null when Meta isn't connected)", async () => {
    const { GET } = await import("@/app/api/settings/route");
    expect(((await (await GET(req("/api/settings"), ctx)).json()) as { currency: string | null }).currency).toBe("INR");
    db().prepare("UPDATE ad_accounts SET token_enc = NULL").run();
    db().prepare("DELETE FROM cache").run();
    expect(((await (await GET(req("/api/settings"), ctx)).json()) as { currency: string | null }).currency).toBeNull();
  });

  it("removing a custom metric says which column sets it was taken out of", async () => {
    const { saveColumnSet, saveCustomMetric } = await import("@/lib/manage/service");
    const id = saveCustomMetric({ name: "CPL GST", formula: "spend / actions:lead * 1.18", format: "money" });
    saveColumnSet({ name: "Leads view", metrics: ["spend", "CPL GST"], isDefault: false });
    const { DELETE } = await import("@/app/api/results/[kind]/[id]/route");
    const res = await DELETE(req(`/api/results/custom_metric/${id}`, { method: "DELETE" }), { params: Promise.resolve({ kind: "custom_metric", id: String(id) }) });
    expect(await res.json()).toEqual({ ok: true, removedFrom: ["Leads view"] });
  });

  it("Results: Placement picked alone brings Platform with it", () => {
    expect(withPlatform(["platform_position"])).toEqual(["platform_position", "publisher_platform"]);
    expect(withPlatform(["publisher_platform", "platform_position"])).toEqual(["publisher_platform", "platform_position"]);
    expect(withPlatform(["age"])).toEqual(["age"]);
  });

  it("the ads list of a carousel without a main link takes the cards' link", async () => {
    const spec = { page_id: "p1", link_data: { message: "Book a visit", child_attachments: [{ link: "https://example.com/a", name: "Card A" }, { link: "https://example.com/b", name: "Card B" }] } };
    mock.objects.set("cr88", { id: "cr88", name: "carousel", object_story_spec: spec, _type: "creative" } as never);
    mock.objects.set("9888", { id: "9888", name: "Carousel ad", adset_id: "as1", creative_id: "cr88", status: "PAUSED", effective_status: "PAUSED", _type: "ad" } as never);
    const { GET } = await import("@/app/api/manage/ads/route");
    const body = (await (await GET(req("/api/manage/ads?adset=as1"), ctx)).json()) as { ads: { id: string; headlines: string[]; link: string | null }[] };
    expect(body.ads.find((a) => a.id === "9888")).toMatchObject({ headlines: ["Card A", "Card B"], link: "https://example.com/a" });
  });
});
