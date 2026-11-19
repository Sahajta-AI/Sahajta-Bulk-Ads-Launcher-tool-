import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { sha256 } from "@/lib/crypto";
import { db } from "@/lib/db";
import { MockMeta, FakeClock } from "@/lib/meta/mock";
import { clientFor } from "@/lib/meta/factory";
import { runBatch } from "@/lib/engine/launcher";
import { localFiles } from "@/lib/sources/local";
import { goLivePlan, queueGoLive } from "@/lib/manage/golive";
import { sendAlert } from "@/lib/alerts";
import { newBatch } from "@/lib/setup";
import { cacheSet, getBatch, logEvent } from "@/lib/store";
import { httpApi, registerTools, type LauncherApi } from "@/mcp/tools";
import { LEAD_COPY, fifteenFileFolder, freshDb, setupBatch } from "./helpers";

// Independent review of Claude's tools (19 Nov 2026). Each probe runs the REAL tool code:
// MCP client → tool → httpApi → the real route handler in-process → service → the practice Meta mock.
// A few probes give the tools a hand-made server answer (fakeApi) where only the tool's own formatting
// is under test (big accounts, names with "|", a summary that fails on its own).
// "FINDING" probes fail today and pass once the bug is fixed. "OK" probes pass: cases checked and fine.

vi.mock("@/auth", () => ({ auth: async () => null }));
process.env.META_MOCK = "1";
process.env.ALLOWED_EMAILS = "test@example.com";
const BASE = "http://launcher.test";
const HTML_BASE = "http://proxy-page.test";
const KEY = "sal_review_mcp_key_0123456789";
const g = globalThis as unknown as { __mockMeta?: MockMeta };
let mock: MockMeta;
let clock: FakeClock;
let folder: string;

const mods = import.meta.glob("../src/app/api/**/route.ts");
const table = Object.keys(mods)
  .filter((p) => !p.includes("[..."))
  .map((p) => {
    const rel = p.replace("../src/app", "").replace("/route.ts", "");
    const names: string[] = [];
    const re = new RegExp("^" + rel.split("/").map((seg) => { const m = /^\[(\w+)\]$/.exec(seg); if (m) { names.push(m[1]); return "([^/]+)"; } return seg; }).join("/") + "$");
    return { re, names, load: mods[p] };
  })
  .sort((a, b) => a.names.length - b.names.length);

async function dispatch(req: Request): Promise<Response> {
  const u = new URL(req.url);
  for (const r of table) {
    const m = r.re.exec(u.pathname);
    if (!m) continue;
    const mod = (await r.load()) as Record<string, (req: Request, ctx: unknown) => Promise<Response>>;
    const h = mod[req.method];
    if (!h) return new Response("Method Not Allowed", { status: 405 });
    return h(req, { params: Promise.resolve(Object.fromEntries(r.names.map((n, i) => [n, decodeURIComponent(m[i + 1])]))) });
  }
  return new Response("404", { status: 404 });
}

const realFetch = globalThis.fetch;
beforeAll(async () => {
  folder = await fifteenFileFolder();
  vi.stubGlobal("fetch", (url: string | URL | Request, init?: RequestInit) => {
    const s = url instanceof Request ? url.url : String(url);
    if (s.startsWith(BASE)) return dispatch(new Request(s, init));
    // A proxy or captive page that answers 200 with HTML instead of the launcher's JSON.
    if (s.startsWith(HTML_BASE)) return Promise.resolve(new Response("<html><body>Please wait…</body></html>", { status: 200, headers: { "Content-Type": "text/html" } }));
    if (s.startsWith("https://example.com")) return Promise.resolve(new Response("ok"));
    return realFetch(url, init);
  });
}, 120_000);

function fresh(opts: Partial<ConstructorParameters<typeof MockMeta>[0]> = {}) {
  freshDb();
  clock = new FakeClock();
  mock = new MockMeta({ clock, capPoints: 90000, richAccount: true, allowActive: true, videoProcessingMs: 1000, ...opts });
  g.__mockMeta = mock;
  db().prepare("INSERT INTO api_keys (user_email, label, key_hash, key_hint) VALUES (?, ?, ?, ?)").run("test@example.com", "review", sha256(KEY), KEY.slice(-4));
}
beforeEach(() => fresh());

async function claude(api: LauncherApi = httpApi(BASE, KEY)) {
  const server = new McpServer({ name: "review", version: "0" });
  registerTools(server, api);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "review", version: "0" });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { text: r.content.map((c) => c.text).join("\n"), isError: !!r.isError };
  };
  return { call, client };
}

/** The real API, except for the paths `over` answers (a hand-made answer, or an error). */
function fakeApi(over: (method: string, path: string, body?: unknown) => unknown | undefined): LauncherApi {
  const real = httpApi(BASE, KEY);
  return {
    async call<T>(method: "GET" | "POST" | "PATCH" | "DELETE", p: string, body?: unknown): Promise<T> {
      const r = over(method, p, body);
      if (r instanceof Error) throw r;
      if (r !== undefined) return r as T;
      return real.call<T>(method, p, body);
    },
  };
}

async function batch() {
  const r = await setupBatch(folder);
  db().prepare("UPDATE ad_accounts SET is_default = 1 WHERE id = ?").run(r.accountId);
  db().prepare("UPDATE batches SET copy = ? WHERE id = ?").run(JSON.stringify(LEAD_COPY), r.batchId);
  return { ...r, key: getBatch(r.batchId)!.key };
}
const deps = (accountId: number) => ({ client: clientFor(accountId), files: localFiles, clock, accountDbId: accountId, tmpDir: fs.mkdtempSync(path.join(os.tmpdir(), "review-mcp-")) });
const planKey = (text: string) => /^Plan (\w+):/m.exec(text)?.[1] ?? "";
const future = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const warningsIn = (text: string) => Number(/(\d+) warning\(s\)\. Show/.exec(text)?.[1] ?? 0);
const spendIn = (text: string) => /spend_confirmation: "([^"]+)"/.exec(text)?.[1];

/** Preview (go live as asked) and launch with the amount the summary showed, as the person would say it. */
async function launched(call: Awaited<ReturnType<typeof claude>>["call"], key: string, goLive: Record<string, unknown> = {}) {
  const pv = await call("preview_batch", { batch_id: key, ...goLive });
  const l = await call("launch_batch", { batch_id: key, confirm: true, accept_warnings: warningsIn(pv.text), spend_confirmation: spendIn(pv.text) });
  expect(l.isError, l.text).toBe(false);
  return pv;
}

// ---------------------------------------------------------------------------------------------
// FINDINGS (fail today)
// ---------------------------------------------------------------------------------------------

describe("FINDING 1 · a spend refusal reads to Claude as 'type this amount yourself'", () => {
  it("launch_batch without the person's amount: the answer must say the PERSON types it, not hand Claude the number to send", async () => {
    const { key } = await batch();
    const { call } = await claude();
    const pv = await call("preview_batch", { batch_id: key, go_live: "now" });
    const l = await call("launch_batch", { batch_id: key, confirm: true, accept_warnings: warningsIn(pv.text) });
    expect(l.isError).toBe(true);
    // Today: "…then confirm by typing the total daily budget exactly as shown: ₹500." — words for the web page,
    // which Claude reads as an instruction to retry with spend_confirmation "₹500" on its own.
    expect(l.text).toMatch(/person/i);
    expect(l.text).toMatch(/never fill|do not fill|don't fill|not fill it in/i);
  });

  it("confirm_plan without the person's amount: same", async () => {
    await batch();
    const { call } = await claude();
    const p = await call("plan_changes", { ops: [{ type: "set_status", status: "ACTIVE", adsets: ["as1"], campaigns: ["c1"] }] });
    const c = await call("confirm_plan", { plan_id: planKey(p.text), confirm: true, accept_warnings: true });
    expect(c.isError).toBe(true);
    expect(c.text).toMatch(/person/i);
  });

  it("confirm_plan after budgets changed in Meta: 'confirm with the new total' must not read as an order to Claude", async () => {
    await batch();
    const { call } = await claude();
    const p = await call("plan_changes", { ops: [{ type: "set_status", status: "ACTIVE", adsets: ["as1"], campaigns: ["c1"] }] });
    mock.objects.get("as1")!.daily_budget = "5000000"; // someone raised it to ₹50,000 in Ads Manager
    const c = await call("confirm_plan", { plan_id: planKey(p.text), confirm: true, accept_warnings: true, spend_confirmation: "₹500" });
    expect(c.isError).toBe(true);
    expect(c.text).toMatch(/₹50,000/);
    expect(c.text).toMatch(/person/i);
  });
});

describe("FINDING 2 · cancel_batch can't stop a scheduled turn-on, and doesn't say what can", () => {
  it("all ads created, turn-on plan queued for later: the answer must name the plan and cancel_plan", async () => {
    const { key, batchId, accountId } = await batch();
    const { call } = await claude();
    await launched(call, key, { go_live: "at", go_live_at: `${future(2)}T09:00` });
    await runBatch(batchId, deps(accountId));
    await queueGoLive(batchId);
    const gp = goLivePlan(key)!;
    expect(gp.status).toBe("queued");
    const c = await call("cancel_batch", { batch_id: key });
    // Today: "This batch is not launching (all ads created)." The ads still go on at 9:00 am.
    expect(c.text).toContain(gp.key);
    // Round 2: the server (cancelBatch) now cancels the waiting turn-on plan in the same call, so the answer
    // says it is cancelled; pointing at cancel_plan is only needed when the server can't stop it (older server).
    if (goLivePlan(key)!.status === "cancelled") expect(c.text).toMatch(/is now cancelled, so they stay paused/);
    else expect(c.text).toMatch(/cancel_plan/);
  });
});

describe("FINDING 3 · batch_status promises a turn-on that will not happen", () => {
  it("after the worker gave up turning the ads on, batch_status must not say they are turned on 'once every ad is in'", async () => {
    const { key, batchId, accountId } = await batch();
    const { call } = await claude();
    await launched(call, key, { go_live: "now" });
    await runBatch(batchId, deps(accountId));
    // What src/worker/run.ts goLive() leaves after its 12th failed try (no plan was made).
    cacheSet(`golive_retry:${batchId}:`, 12, 86_400_000);
    logEvent(batchId, null, "warn", `All ads are created, but turning them on didn't work after 12 tries: Meta is limiting calls. The ads stay paused. Press "Retry" on the batch to try again.`);
    const s = await call("batch_status", { batch_id: key });
    expect(s.text).not.toMatch(/turned on by a plan once every ad is in/);
    expect(s.text).toMatch(/not turned on|didn't work|stay paused/i);
    expect(s.text).toMatch(/retry_failed/);
  });
});

describe("FINDING 4 · retry_failed turns ads on with the old yes, whatever can spend now", () => {
  /** Launched with go_live now and ₹500 typed; one ad failed; then the ad set went to ₹50,000 a day. */
  async function partialThenRaised() {
    const { key, batchId, accountId } = await batch();
    const { call } = await claude();
    const pv = await launched(call, key, { go_live: "now" });
    expect(spendIn(pv.text)).toBe("₹500");
    mock.inject({ match: (m, p) => m === "POST" && p.endsWith("/adcreatives"), kind: "error", error: { message: "Invalid parameter", code: 100, error_user_msg: "Text too long." } });
    await runBatch(batchId, deps(accountId));
    expect(getBatch(batchId)!.status).toBe("partial");
    mock.objects.get("as1")!.daily_budget = "5000000";
    return { key, batchId, accountId, call };
  }

  it("tool: the retry_failed answer doesn't say the ads will spend, or how much", async () => {
    const { key, call } = await partialThenRaised();
    const r = await call("retry_failed", { batch_id: key });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/turned on/);
    expect(r.text).toMatch(/₹50,000|person/);
  });

  it("server (golive.ts): the turn-on after the retry runs as confirmed although ₹50,000 ≠ the ₹500 the person typed", async () => {
    const { key, batchId, accountId, call } = await partialThenRaised();
    expect((await call("retry_failed", { batch_id: key })).isError).toBe(false);
    await runBatch(batchId, deps(accountId));
    await queueGoLive(batchId);
    const gp = goLivePlan(key)!;
    const typed = JSON.parse(db().prepare("SELECT summary FROM plans WHERE key = ?").pluck().get(gp.key) as string).spendConfirmation;
    expect(typed).toBe("₹50,000");
    expect(gp.status).toBe("draft");
  });
});

describe("FINDING 5 · preview_batch says 'launch' while the summary shows a failed check", () => {
  it("ad account disabled: CHECK FAILED is in the summary, but the last line still tells Claude to launch", async () => {
    fresh({ accountStatus: 2 });
    const { key } = await batch();
    const { call } = await claude();
    const pv = await call("preview_batch", { batch_id: key });
    expect(pv.text).toMatch(/CHECK FAILED: The ad account .* is disabled/);
    const last = pv.text.trim().split("\n").pop()!;
    expect(last).toMatch(/CHECK FAILED|disabled|won't deliver|check failed/i);
  });
});

describe("FINDING 6 · get_results tables break on names with '|'", () => {
  it("a campaign called 'Diwali | Leads | BLR' shifts every number one column to the right", async () => {
    const res = {
      currency: "INR",
      level: "campaign",
      range: "last 7 days",
      columns: [{ key: "spend", label: "Amount spent", format: "money" }, { key: "actions:lead", label: "Leads", format: "number" }],
      rows: [
        { name: "Diwali | Leads | BLR", id: "1", breakdown: {}, values: { spend: 1000, "actions:lead": 10 } },
        { name: "Plain", id: "2", breakdown: {}, values: { spend: 500, "actions:lead": 5 } },
      ],
      totals: { spend: 1500, "actions:lead": 15 },
    };
    const { call } = await claude(fakeApi((m, p) => (m === "POST" && p === "/api/results" ? res : undefined)));
    const r = await call("get_results", { level: "campaign", date_preset: "last_7d" });
    const rows = r.text.split("\n").filter((l) => l.startsWith("|"));
    const cells = (l: string) => l.split("|").length;
    for (const l of rows) expect(cells(l), l).toBe(cells(rows[0]));
  });
});

describe("FINDING 7 · delivery_status says 'Nothing created yet.' for a campaign that isn't there", () => {
  it("a wrong campaign ID, or a one-word name that isn't a campaign, is not 'nothing created yet'", async () => {
    await batch();
    const { call } = await claude();
    expect((await call("delivery_status", { campaign: "999000111" })).text).not.toBe("Nothing created yet.");
    expect((await call("delivery_status", { campaign: "Diwali" })).text).not.toBe("Nothing created yet.");
  });
});

describe("FINDING 8 · one-word names are sent to Meta as IDs", () => {
  it("list_ads / get_details with the one-word name 'Diwali' show Meta's raw 'Object Diwali does not exist'", async () => {
    await batch();
    const { call } = await claude();
    const l = await call("list_ads", { adset: "Diwali" });
    expect(l.text).not.toMatch(/Object Diwali does not exist/);
    expect(l.text).toMatch(/No ad set called "Diwali"/);
    const d = await call("get_details", { kind: "adset", id: "Diwali" });
    expect(d.text).not.toMatch(/Object Diwali does not exist/);
  });

  it("when the campaign list can't be read, a one-word name comes back as 'not found in Meta (deleted…)'", async () => {
    await batch();
    const api = fakeApi((m, p) => (p.startsWith("/api/manage/tree") ? new Error("Meta is limiting how often the launcher may call this ad account. Try again in about 5 minutes.") : undefined));
    const { call } = await claude(api);
    const d = await call("delivery_status", { adset: "Retarget" });
    // Today: "Ad set (Retarget): not found in Meta (deleted, or not in this ad account)" — false; the real cause is hidden.
    expect(d.text).not.toMatch(/not found in Meta/);
    expect(d.text).toMatch(/limiting/);
  });
});

describe("FINDING 9 · long answers with no limit", () => {
  it("delivery_status of a big campaign (1,500 ads) is not cut and has no note", async () => {
    const rows = [
      ...Array.from({ length: 60 }, (_, i) => ({ kind: "adset", id: `5${i}`, name: `Ad set ${i}`, plain: "delivering", learning: "learning", issues: [] as string[] })),
      ...Array.from({ length: 1500 }, (_, i) => ({ kind: "ad", id: `6${i}`, name: `2026-11-19_creative-${i}_site-visit_VID-9x16+4x5 [L:abcde-${i}]`, plain: "rejected", learning: null, issues: ["Meta review: Ad text mentions personal attributes."] })),
    ];
    const { call } = await claude(fakeApi((m, p) => (p.startsWith("/api/manage/delivery") ? { rows } : undefined)));
    const r = await call("delivery_status", { campaign: "120000000001" });
    expect(r.text.length).toBeLessThan(60_000);
  });

  it("list_destinations of a big account (300 campaigns × 10 ad sets) is not cut and has no note", async () => {
    const campaigns = Array.from({ length: 300 }, (_, i) => ({ id: `12000${i}`, name: `Campaign ${i} | Leads | Bangalore`, status: "ACTIVE", adsets: Array.from({ length: 10 }, (_, j) => ({ id: `13000${i}${j}`, name: `Ad set ${i}-${j} women 25-45`, status: "ACTIVE", isDynamicCreative: false })) }));
    const { call } = await claude(fakeApi((m, p) => (p.startsWith("/api/destinations") ? { campaigns } : undefined)));
    const r = await call("list_destinations", {});
    expect(r.text.length).toBeLessThan(60_000);
  });

  it("preview_batch with 40 ads that all have warnings: the cut note says the hidden ads have no problems", async () => {
    const ad = (n: number) => ({ position: n, creativeName: `c${n}`, metaName: `ad ${n}`, adsetName: "A", files: [{ id: n, filename: `c${n}.jpg`, ratio: "1x1", placement: "All placements", size: "1 MB", durationSec: null }], copy: { primaryTexts: ["t"], headlines: ["h"], linkUrl: "https://example.com", cta: "LEARN_MORE" }, hasOverride: false, checks: [{ level: "warning", message: `Ad ${n}: this image has no vertical (9:16) version.` }], status: "pending", step: null, error: null, reviewLabel: "", reviewIssues: [], metaPostId: null, metaIgMediaId: null, leftover: null, featureWarnings: [], adsManagerUrl: null });
    const view = { key: "big40", status: "draft", statusLabel: "Not launched yet", source: { kind: "upload", label: "" }, settings: { campaignName: "C", adsetMode: "existing", adsetName: "A", copyTemplateId: null, preset: null, goLive: "paused", goLiveAt: null, extraAdsets: [] }, preview: { batchChecks: [], errors: 0, warnings: 40, estimate: { label: "about 5 minutes", rateLimited: false } }, launchEstimate: null, progress: { total: 40, done: 0, failed: 0, working: 0 }, links: { app: "https://launcher.test/batches/big40", campaign: null }, ads: Array.from({ length: 40 }, (_, i) => ad(i + 1)), unassigned: [] };
    const summary = { connection: { connected: true, adAccount: { id: "act_1", name: "A", adsManagerLink: "x" }, page: null, instagram: null, loginBy: null, loginExpiresAt: null, loginExpired: false, problems: [] }, launch: { account: { name: "A", id: "act_1" }, campaign: { name: "C", status: "PAUSED", budget: "set on each ad set" }, adsets: [], totalDailyLabel: "₹500", alsoSpends: [], adCount: 40, copy: { primaryTexts: 1, headlines: 1, firstText: "t", link: "https://example.com", cta: "LEARN_MORE", utm: "" }, goLive: "Created PAUSED.", warnings: [], spendConfirmation: null } };
    const { call } = await claude(fakeApi((m, p) => (p === "/api/batches/big40/preview" ? view : p === "/api/batches/big40/summary" ? summary : undefined)));
    const r = await call("preview_batch", { batch_id: "big40" });
    expect(r.text).toMatch(/40 warning\(s\)/);
    // Today: "(10 more ads without problems are not listed here…)" — but each of those 10 has a warning.
    expect(r.text).not.toMatch(/more ads without problems/);
  });
});

describe("FINDING 10 · small input and wording gaps", () => {
  it("list_ads with part of a name uses the one ad set it fits, but never says which", async () => {
    const { key, batchId, accountId } = await batch();
    const { call } = await claude();
    await launched(call, key);
    await runBatch(batchId, deps(accountId));
    const r = await call("list_ads", { adset: "test ad" });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("November test ad set");
  });

  it("remove_file is marked destructive but needs no confirm (delete_draft does)", async () => {
    const { client } = await claude();
    const tools = (await client.listTools()).tools;
    const rm = tools.find((t) => t.name === "remove_file")!;
    expect(rm.annotations?.destructiveHint).toBe(true);
    expect(rm.inputSchema.required).toContain("confirm");
  });

  it("list_batches status 'problems' only looks at the latest 50 and says 'No batches like that.' without saying so", async () => {
    const { accountId } = await batch();
    const old = db().prepare("SELECT id FROM batches ORDER BY id LIMIT 1").pluck().get() as number;
    db().prepare("UPDATE batches SET status = 'failed' WHERE id = ?").run(old);
    for (let i = 0; i < 50; i++) newBatch(accountId, "test@example.com");
    const { call } = await claude();
    const r = await call("list_batches", { status: "problems" });
    expect(r.text).toMatch(/50/);
  });

  it("list_alerts shows only the 10 newest and doesn't say more exist", async () => {
    await batch();
    for (let i = 1; i <= 12; i++) await sendAlert({ to: "test@example.com", subject: `Launch b${i}: ads failed`, lines: ["x"], link: "https://launcher.test" });
    const { call } = await claude();
    const r = await call("list_alerts", {});
    const shown = (r.text.match(/^- /gm) ?? []).length;
    if (shown < 12) expect(r.text).toMatch(/more|only the|newest/i);
  });

  it("spend_confirmation sent as a number, and confirm_plan's accept_warnings sent as a count (as launch_batch asks), are refused by the schema", async () => {
    const { key } = await batch();
    const { call } = await claude();
    const pv = await call("preview_batch", { batch_id: key, go_live: "now" });
    const l = await call("launch_batch", { batch_id: key, confirm: true, accept_warnings: warningsIn(pv.text), spend_confirmation: 500 });
    expect(l.text).not.toMatch(/Input validation error/);
    const p = await call("plan_changes", { ops: [{ type: "edit_adset", adset: "as1", name: "x" }] });
    const c = await call("confirm_plan", { plan_id: planKey(p.text), confirm: true, accept_warnings: 2 });
    expect(c.text).not.toMatch(/Input validation error/);
  });

  it("a 200 answer that isn't the launcher's JSON (a proxy page) reaches Claude as a JavaScript error", async () => {
    const { call } = await claude(httpApi(HTML_BASE, KEY));
    const r = await call("batch_status", { batch_id: "abcde" });
    expect(r.isError).toBe(true);
    expect(r.text).not.toMatch(/Cannot read properties|undefined|TypeError/);
  });
});

// ---------------------------------------------------------------------------------------------
// OK (cases checked and found fine)
// ---------------------------------------------------------------------------------------------

describe("OK · checked and fine", () => {
  it("preview_batch with go_live now and a summary that fails: no amount, no launch instruction", async () => {
    const { key } = await batch();
    const api = fakeApi((m, p) => (m === "GET" && p.endsWith("/summary") ? new Error("Meta is limiting how often the launcher may call this ad account, so this can't be done right now.") : undefined));
    const { call } = await claude(api);
    const r = await call("preview_batch", { batch_id: key, go_live: "now" });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/The pre-launch summary couldn't be loaded: .*Don't launch until preview_batch shows it\./);
    expect(r.text).not.toMatch(/spend_confirmation|launch_batch with confirm|TOTAL daily budget/);
  });

  it("preview_batch with go_live now and the summary: the closing line carries the exact total and 'never fill it in yourself'", async () => {
    const { key } = await batch();
    const { call } = await claude();
    const r = await call("preview_batch", { batch_id: key, go_live: "now" });
    expect(r.text).toMatch(/TOTAL daily budget: ₹500\./);
    expect(r.text.trim().split("\n").pop()).toMatch(/spend_confirmation: "₹500" \(the total daily budget, said by the person; never fill it in yourself\)/);
  });

  it("times in words are refused, not guessed: go_live_at and run_at 'tomorrow 9am'", async () => {
    const { key } = await batch();
    const { call } = await claude();
    const pv = await call("preview_batch", { batch_id: key, go_live: "at", go_live_at: "tomorrow 9am" });
    expect(pv.isError).toBe(true);
    expect(pv.text).toMatch(/"tomorrow 9am" is not a date and time/);
    const p = await call("plan_changes", { run_at: "tomorrow 9am", ops: [{ type: "set_status", status: "ACTIVE", adsets: ["as1"], campaigns: ["c1"] }] });
    expect(p.text).toMatch(/ERROR: "tomorrow 9am" is not a date and time/);
    const c = await call("confirm_plan", { plan_id: planKey(p.text), confirm: true, accept_warnings: true, spend_confirmation: "₹500" });
    expect(c.isError).toBe(true);
    expect(db().prepare("SELECT status FROM plans").pluck().get()).toBe("draft");
  });

  it("read-only tools change nothing: no Meta write and no new row in the launcher's own tables", async () => {
    const { key, batchId, accountId } = await batch();
    const { call } = await claude();
    await launched(call, key);
    await runBatch(batchId, deps(accountId));
    const p = await call("plan_changes", { ops: [{ type: "edit_adset", adset: "as1", name: "x" }] });
    const tables = ["batches", "ads", "assets", "plans", "jobs", "copy_templates", "naming_templates", "settings_presets", "column_sets", "custom_metrics", "app_settings"];
    const counts = () => tables.map((t) => db().prepare(`SELECT COUNT(*) FROM ${t}`).pluck().get());
    const plansBefore = db().prepare("SELECT key, status, ops, summary FROM plans").all();
    const before = counts();
    const writesBefore = mock.calls.filter((c) => c.method !== "GET").length;
    const reads: [string, Record<string, unknown>][] = [
      ["batch_status", { batch_id: key }],
      ["connection_status", {}],
      ["delivery_status", { batch_id: key }],
      ["delivery_status", { adset: "November test ad set" }],
      ["get_details", { kind: "campaign", id: "November tests" }],
      ["get_results", { level: "campaign", date_preset: "last_7d" }],
      ["get_safety_settings", {}],
      ["list_ads", { adset: "as1" }],
      ["list_alerts", {}],
      ["list_batches", {}],
      ["list_campaigns", {}],
      ["list_destinations", { refresh: true }],
      ["list_instagram_accounts", { refresh: true }],
      ["list_metrics", {}],
      ["list_options", {}],
      ["list_templates", {}],
      ["lookup", { what: "pixels" }],
      ["plan_status", {}],
      ["plan_status", { plan_id: planKey(p.text) }],
    ];
    for (const [name, args] of reads) {
      const r = await call(name, args);
      expect(r.isError, `${name}: ${r.text}`).toBe(false);
    }
    expect(mock.calls.filter((c) => c.method !== "GET").length).toBe(writesBefore);
    expect(counts()).toEqual(before);
    expect(db().prepare("SELECT key, status, ops, summary FROM plans").all()).toEqual(plansBefore);
  });

  it("no answer carries the Meta token, the API key or the encryption key", async () => {
    const { key, batchId, accountId } = await batch();
    const { call } = await claude();
    await launched(call, key);
    await runBatch(batchId, deps(accountId));
    const out: string[] = [];
    for (const [name, args] of [
      ["connection_status", {}],
      ["get_details", { kind: "adset", id: "as1" }],
      ["list_templates", {}],
      ["get_safety_settings", {}],
      ["list_instagram_accounts", {}],
      ["batch_status", { batch_id: key }],
      ["list_ads", { adset: "as1" }],
    ] as [string, Record<string, unknown>][]) out.push((await call(name, args)).text);
    const all = out.join("\n");
    expect(all).not.toContain("mock-token");
    expect(all).not.toContain(KEY);
    expect(all).not.toContain(process.env.APP_ENCRYPTION_KEY!);
    expect(all).not.toMatch(/access_token|appsecret/i);
  });

  it("an unknown metric written as 'spend, ctr' is refused in a plain sentence that names the fix", async () => {
    await batch();
    const { call } = await claude();
    const r = await call("get_results", { level: "campaign", date_preset: "last_7d", metrics: "spend, ctr" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^Unknown metric "spend, ctr"\. Use list_metrics/);
  });

  it("a draft plan that turns things on tells Claude the person must say the total, and confirm_plan with it runs", async () => {
    await batch();
    const { call } = await claude();
    const p = await call("plan_changes", { ops: [{ type: "set_status", status: "ACTIVE", adsets: ["as1"], campaigns: ["c1"] }] });
    expect(p.text.indexOf("TOTAL daily budget")).toBeLessThan(p.text.indexOf("Step 1"));
    expect(p.text).toMatch(/TURNS ON: campaign "November tests"; ad set "November test ad set"\. Daily budget able to spend afterwards: ₹500\./);
    expect(p.text).toMatch(/spend_confirmation: "₹500" — the person must say this total themselves; do not fill it in for them\.$/);
    const c = await call("confirm_plan", { plan_id: planKey(p.text), confirm: true, accept_warnings: true, spend_confirmation: "500" });
    expect(c.isError, c.text).toBe(false);
    expect(c.text).toMatch(/What can spend once it has run: ₹500 a day/);
  });
});

// ---------------------------------------------------------------------------------------------
// Evidence that some existing MCP tests can't fail (they pass whatever the tools do)
// ---------------------------------------------------------------------------------------------

describe("PROVES NOTHING · existing tests whose check never runs or can't fail", () => {
  it("audit-mcp 'list_ads says Meta couldn't be read': the faults it injects are never used (list_ads no longer reads each ad)", async () => {
    await batch();
    for (const id of ["ad901", "ad902"]) mock.objects.set(id, { id, name: `Ad ${id}`, adset_id: "as1", status: "PAUSED", effective_status: "PAUSED", creative: { id: `cr_${id}` }, _type: "ad" });
    const { call } = await claude();
    for (const id of ["ad901", "ad902"]) mock.inject({ match: (m, p) => m === "GET" && p.endsWith(id), kind: "error", error: { message: "Please reduce the amount of data you're asking for", code: 1 } });
    const r = await call("list_ads", { adset: "as1" });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/Ad ad901/);
    expect((mock as unknown as { faults: unknown[] }).faults).toHaveLength(2); // still waiting: nothing failed
    // …and its check `not.toBe("No ads in this ad set.")` compares with a sentence the tool no longer writes.
  });

  it("audit-mcp 'preview_batch says the pre-launch summary is missing': the fault is used up before the summary, so its `if` never runs", async () => {
    const { key } = await batch();
    const { call } = await claude();
    await call("preview_batch", { batch_id: key });
    mock.inject({ match: (m, p) => m === "GET" && p === "c1", kind: "error", error: { message: "Unsupported get request.", code: 100 } });
    const r = await call("preview_batch", { batch_id: key });
    expect(r.text).toContain("PRE-LAUNCH SUMMARY");
  });
});
