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
import { enqueue, goLiveRetryKey } from "@/lib/jobs";
import { newBatch } from "@/lib/setup";
import { cacheSet, getBatch, logEvent } from "@/lib/store";
import { httpApi, registerTools, type LauncherApi } from "@/mcp/tools";
import { LEAD_COPY, fifteenFileFolder, freshDb, setupBatch } from "./helpers";

vi.mock("@/auth", () => ({ auth: async () => null }));
process.env.META_MOCK = "1";
process.env.ALLOWED_EMAILS = "test@example.com";
const BASE = "http://launcher.test";
const KEY = "sal_r2_mcp_key_0123456789";
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
    if (s.startsWith("https://example.com")) return Promise.resolve(new Response("ok"));
    return realFetch(url, init);
  });
}, 120_000);

function fresh(opts: Partial<ConstructorParameters<typeof MockMeta>[0]> = {}) {
  freshDb();
  clock = new FakeClock();
  mock = new MockMeta({ clock, capPoints: 90000, richAccount: true, allowActive: true, videoProcessingMs: 1000, ...opts });
  g.__mockMeta = mock;
  db().prepare("INSERT INTO api_keys (user_email, label, key_hash, key_hint) VALUES (?, ?, ?, ?)").run("test@example.com", "r2", sha256(KEY), KEY.slice(-4));
}
beforeEach(() => fresh());

async function claude(api: LauncherApi = httpApi(BASE, KEY)) {
  const server = new McpServer({ name: "r2", version: "0" });
  registerTools(server, api);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "r2", version: "0" });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { text: r.content.map((c) => c.text).join("\n"), isError: !!r.isError };
  };
  return { call, client };
}

async function batch() {
  const r = await setupBatch(folder);
  db().prepare("UPDATE ad_accounts SET is_default = 1 WHERE id = ?").run(r.accountId);
  db().prepare("UPDATE batches SET copy = ? WHERE id = ?").run(JSON.stringify(LEAD_COPY), r.batchId);
  return { ...r, key: getBatch(r.batchId)!.key };
}

/** The real API, except for the paths `over` answers (a hand-made answer, or an error). */
function fakeApi(over: (method: string, path: string, body?: unknown) => unknown | undefined, change?: (method: string, path: string, answer: unknown) => unknown): LauncherApi {
  const real = httpApi(BASE, KEY);
  return {
    async call<T>(method: "GET" | "POST" | "PATCH" | "DELETE", p: string, body?: unknown): Promise<T> {
      const r = over(method, p, body);
      if (r instanceof Error) throw r;
      if (r !== undefined) return r as T;
      const a = await real.call<T>(method, p, body);
      return (change ? change(method, p, a) : a) as T;
    },
  };
}

const deps = (accountId: number) => ({ client: clientFor(accountId), files: localFiles, clock, accountDbId: accountId, tmpDir: fs.mkdtempSync(path.join(os.tmpdir(), "r2-mcp-")) });
const planKey = (text: string) => /^Plan (\w+):/m.exec(text)?.[1] ?? "";
const future = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const warningsIn = (text: string) => Number(/(\d+) warning\(s\)\. Show/.exec(text)?.[1] ?? 0);
const spendIn = (text: string) => /spend_confirmation: "([^"]+)"/.exec(text)?.[1];
type Call = Awaited<ReturnType<typeof claude>>["call"];

/** Preview (go live as asked) and launch with the amount the summary showed, as the person said it. */
async function launched(call: Call, key: string, goLive: Record<string, unknown> = {}) {
  const pv = await call("preview_batch", { batch_id: key, ...goLive });
  const l = await call("launch_batch", { batch_id: key, confirm: true, accept_warnings: warningsIn(pv.text), spend_confirmation: spendIn(pv.text) });
  expect(l.isError, l.text).toBe(false);
  return pv;
}

/** Launched with go_live now (₹500 typed); one ad failed; then the ad set was raised to ₹50,000 a day. */
async function partialThenRaised(call: Call) {
  const { key, batchId, accountId } = await batch();
  await launched(call, key, { go_live: "now" });
  mock.inject({ match: (m, p) => m === "POST" && p.endsWith("/adcreatives"), kind: "error", error: { message: "Invalid parameter", code: 100, error_user_msg: "Text too long." } });
  await runBatch(batchId, deps(accountId));
  expect(getBatch(batchId)!.status).toBe("partial");
  mock.objects.get("as1")!.daily_budget = "5000000";
  return { key, batchId, accountId };
}

const PERSON = /For Claude: the person must type this amount themselves, after seeing the summary \((preview_batch|plan_status) shows it\)\. .*Never fill in spend_confirmation yourself/;

// ---------------------------------------------------------------------------------------------

describe("R2-1 · a spend refusal tells Claude the person types the amount", () => {
  it("launch_batch: no amount, then a wrong one: refused, the person types it, nothing is launched", async () => {
    const { key, batchId } = await batch();
    const { call } = await claude();
    const pv = await call("preview_batch", { batch_id: key, go_live: "now" });
    const none = await call("launch_batch", { batch_id: key, confirm: true, accept_warnings: warningsIn(pv.text) });
    expect(none.isError).toBe(true);
    expect(none.text).toMatch(/confirm by typing the total daily budget exactly as shown: ₹500\./);
    expect(none.text).toMatch(PERSON);
    expect(none.text).toMatch(/preview_batch shows it/);
    const wrong = await call("launch_batch", { batch_id: key, confirm: true, accept_warnings: warningsIn(pv.text), spend_confirmation: 400 });
    expect(wrong.isError).toBe(true);
    expect(wrong.text).toMatch(/The total you typed doesn't match/);
    expect(wrong.text).toMatch(PERSON);
    expect(getBatch(batchId)!.status).toBe("draft");
    // A number is read as the amount: 500 launches (the schema takes it).
    const ok = await call("launch_batch", { batch_id: key, confirm: true, accept_warnings: warningsIn(pv.text), spend_confirmation: 500 });
    expect(ok.isError, ok.text).toBe(false);
    expect(getBatch(batchId)!.status).toBe("queued");
  });

  it("launch_batch with fewer warnings accepted than there are: the person sees the warnings first", async () => {
    const { key, batchId } = await batch();
    const { call } = await claude();
    const pv = await call("preview_batch", { batch_id: key });
    const n = warningsIn(pv.text);
    expect(n).toBeGreaterThan(1);
    const r = await call("launch_batch", { batch_id: key, confirm: true, accept_warnings: n - 1 });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/new warnings? since you checked/);
    expect(r.text).toMatch(/For Claude: show these warnings to the person first \(preview_batch lists them\)\. Set accept_warnings only after they have read them and said yes\./);
    expect(r.text).not.toMatch(/For Claude: the person must type/);
    expect(getBatch(batchId)!.status).toBe("draft");
  });

  it("confirm_plan: no amount, then budgets raised in Meta: refused with the person line; the plan stays a draft", async () => {
    await batch();
    const { call } = await claude();
    const p = await call("plan_changes", { ops: [{ type: "set_status", status: "ACTIVE", adsets: ["as1"], campaigns: ["c1"] }] });
    const key = planKey(p.text);
    const none = await call("confirm_plan", { plan_id: key, confirm: true, accept_warnings: true });
    expect(none.isError).toBe(true);
    expect(none.text).toMatch(PERSON);
    expect(none.text).toMatch(/plan_status shows it/);
    mock.objects.get("as1")!.daily_budget = "5000000";
    const raised = await call("confirm_plan", { plan_id: key, confirm: true, accept_warnings: true, spend_confirmation: "₹500" });
    expect(raised.isError).toBe(true);
    expect(raised.text).toMatch(/what can spend is now ₹50,000 a day \(it was ₹500\)/);
    expect(raised.text).toMatch(PERSON);
    expect(db().prepare("SELECT status FROM plans WHERE key = ?").pluck().get(key)).toBe("draft");
  });

  it("confirm_plan's accept_warnings as a count: fewer than the plan's warnings is refused, enough runs it; a number amount is read", async () => {
    await batch();
    const { call } = await claude();
    const p = await call("plan_changes", { ops: [{ type: "set_status", status: "ACTIVE", adsets: ["as1"], campaigns: ["c1"] }] });
    const key = planKey(p.text);
    const w = JSON.parse(db().prepare("SELECT summary FROM plans WHERE key = ?").pluck().get(key) as string).warnings as number;
    if (w > 0) {
      const few = await call("confirm_plan", { plan_id: key, confirm: true, accept_warnings: w - 1 || "0", spend_confirmation: 500 });
      expect(few.isError).toBe(true);
      expect(db().prepare("SELECT status FROM plans WHERE key = ?").pluck().get(key)).toBe("draft");
    }
    const ok = await call("confirm_plan", { plan_id: key, confirm: true, accept_warnings: w, spend_confirmation: 500 });
    expect(ok.isError, ok.text).toBe(false);
    expect(db().prepare("SELECT status FROM plans WHERE key = ?").pluck().get(key)).toBe("queued");
  });
});

describe("R2-2 · retry_failed says it can turn ads on, and a changed amount makes a draft", () => {
  it("the description warns that it turns ads on and to ask the person first", async () => {
    const { client } = await claude();
    const t = (await client.listTools()).tools.find((x) => x.name === "retry_failed")!;
    expect(t.description).toMatch(/THIS CAN TURN ADS ON AND SPEND MONEY/);
    expect(t.description).toMatch(/Ask the person first/);
  });

  it("go live now, an ad failed, budget raised: the answer says it turns ads on; after the retry the plan is a draft and batch_status says so", async () => {
    const { call } = await claude();
    const { key, batchId, accountId } = await partialThenRaised(call);
    const r = await call("retry_failed", { batch_id: key });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toMatch(/This turns the ads on: once every ad is in, they are turned on and their ad sets' daily budgets can spend/);
    expect(r.text).toMatch(/cancel_batch stops it now/);
    await runBatch(batchId, deps(accountId));
    await queueGoLive(batchId);
    const gp = goLivePlan(key)!;
    expect(gp.status).toBe("draft");
    const s = await call("batch_status", { batch_id: key });
    expect(s.text).toContain(`NOT turned on: the plan that turns the ads on (${gp.key}) is saved as a draft`);
    expect(s.text).toMatch(/they type the amount that can spend themselves, then confirm_plan\. Never fill in that amount yourself\./);
    expect(s.text).not.toMatch(/once every ad is in/);
  });

  it("after a Stop, retry_failed says the ads are NOT turned on by themselves and the person confirms a draft", async () => {
    const { key } = await batch();
    const { call } = await claude();
    await launched(call, key, { go_live: "now" });
    expect((await call("cancel_batch", { batch_id: key })).isError).toBe(false);
    const r = await call("retry_failed", { batch_id: key });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toMatch(/NOT turned on by themselves/);
    expect(r.text).toMatch(/Once every ad is in, the plan that turns them on is saved as a draft: batch_status names it, plan_status shows its summary\. Show it to the person; they type the amount that can spend themselves, then confirm_plan\. Never fill in that amount yourself\./);
    expect(r.text).not.toMatch(/This turns the ads on/);
    const s = await call("batch_status", { batch_id: key });
    expect(s.text).toMatch(/NOT turned on by themselves: the launch was stopped/);
  });

  it("a paused batch: the retry answer is as before, with no turn-on line", async () => {
    const { key, batchId, accountId } = await batch();
    const { call } = await claude();
    await launched(call, key);
    mock.inject({ match: (m, p) => m === "POST" && p.endsWith("/adcreatives"), kind: "error", error: { message: "Invalid parameter", code: 100, error_user_msg: "Text too long." } });
    await runBatch(batchId, deps(accountId));
    const r = await call("retry_failed", { batch_id: key });
    expect(r.text).toBe(`Batch ${key}: Retrying 1 ad not created yet. Ads that already went through are not touched. Use batch_status to follow it.`);
  });
});

describe("R2-3 · cancel_batch and a waiting turn-on plan", () => {
  async function doneWithQueuedPlan(call: Call) {
    const { key, batchId, accountId } = await batch();
    await launched(call, key, { go_live: "at", go_live_at: `${future(2)}T09:00` });
    await runBatch(batchId, deps(accountId));
    await queueGoLive(batchId);
    const gp = goLivePlan(key)!;
    expect(gp.status).toBe("queued");
    return { key, gp };
  }

  it("the server cancels the plan: the answer names it and says the ads stay paused", async () => {
    const { call } = await claude();
    const { key, gp } = await doneWithQueuedPlan(call);
    const c = await call("cancel_batch", { batch_id: key });
    expect(c.isError, c.text).toBe(false);
    expect(c.text).toBe(`Batch ${key} (9 of 9 ads created): the plan that was to turn its ads on (${gp.key}) is now cancelled, so they stay paused.`);
    expect(goLivePlan(key)!.status).toBe("cancelled");
  });

  it("an older server that refuses: the answer names the waiting plan and cancel_plan, and cancels nothing itself", async () => {
    const { call: real } = await claude();
    const { key, gp } = await doneWithQueuedPlan(real);
    const api = fakeApi((m, p) => (m === "POST" && p.endsWith("/cancel") ? new Error("This batch is not launching (all ads created).") : undefined));
    const { call } = await claude(api);
    const c = await call("cancel_batch", { batch_id: key });
    expect(c.isError).toBe(true);
    expect(c.text).toMatch(new RegExp(`^This batch is not launching \\(all ads created\\)\\. But its ads are still to be turned on by plan ${gp.key} at \\d{1,2} \\w{3} \\d{4}, 09:00 am IST\\. cancel_plan with plan_id ${gp.key} stops that \\(ask the person first\\)`));
    expect(goLivePlan(key)!.status).toBe("queued");
  });

  it("the plan already ran: the answer says Stop doesn't turn the ads off and names the tools that do", async () => {
    const { call } = await claude();
    const { key, gp } = await doneWithQueuedPlan(call);
    db().prepare("UPDATE plans SET status = 'done' WHERE key = ?").run(gp.key);
    const c = await call("cancel_batch", { batch_id: key });
    expect(c.text).toMatch(new RegExp(`plan ${gp.key}`));
    expect(c.text).toMatch(/Its ads are ON: plan \w+ already turned them on, and stopping does not turn them off\. To turn them off, use plan_changes with set_status PAUSED, then confirm_plan after the person's yes\./);
    expect(c.text).not.toMatch(/stay paused/);
  });
});

describe("R2-4 · batch_status never promises a turn-on that will not happen", () => {
  async function doneNoPlan(call: Call) {
    const { key, batchId, accountId } = await batch();
    await launched(call, key, { go_live: "now" });
    await runBatch(batchId, deps(accountId));
    return { key, batchId };
  }

  it("while the worker tries again: the launcher's note, and the ads stay paused until it works", async () => {
    const { call } = await claude();
    const { key, batchId } = await doneNoPlan(call);
    const next = Date.now() + 5 * 60_000;
    cacheSet(goLiveRetryKey(batchId), 2, 86_400_000);
    cacheSet(`${goLiveRetryKey(batchId)}info`, { reason: "Meta is limiting calls", nextAt: next }, 86_400_000);
    enqueue("golive", batchId, next);
    const s = await call("batch_status", { batch_id: key });
    expect(s.text).toMatch(/Turning the ads on failed 2 times \(Meta is limiting calls\)\. Trying again at .* IST\./);
    expect(s.text).toMatch(/Until it works the ads stay paused\./);
    expect(s.text).not.toMatch(/once every ad is in|retry_failed tries again/);
  });

  it("after the worker gave up: NOT turned on, and retry_failed only after asking the person", async () => {
    const { call } = await claude();
    const { key, batchId } = await doneNoPlan(call);
    cacheSet(goLiveRetryKey(batchId), 12, 86_400_000);
    const s = await call("batch_status", { batch_id: key });
    expect(s.text).toMatch(/The ads were NOT turned on.*They stay paused\./);
    expect(s.text).toMatch(/retry_failed tries again \(ask the person first: it turns the ads on, and then they can spend\)/);
    expect(s.text).not.toMatch(/once every ad is in/);
  });

  it("a server without goLiveNote: every ad in and no plan is said plainly, with the last warning of the log", async () => {
    const { call: real } = await claude();
    const { key, batchId } = await doneNoPlan(real);
    logEvent(batchId, null, "warn", "Turning the ads on didn't work: Meta is limiting calls. The ads stay paused.");
    const api = fakeApi(() => undefined, (m, p, a) => {
      if (m === "GET" && p === `/api/batches/${key}`) {
        const v = { ...(a as Record<string, unknown>) };
        delete v.goLiveNote;
        delete v.goLiveHold;
        return v;
      }
      return a;
    });
    const { call } = await claude(api);
    const s = await call("batch_status", { batch_id: key });
    expect(s.text).toMatch(/Every ad is in, but no plan to turn them on has been made yet, so they are still paused\./);
    expect(s.text).toMatch(/Last note in the batch log: Turning the ads on didn't work: Meta is limiting calls\. The ads stay paused\./);
    expect(s.text).not.toMatch(/once every ad is in;/);
  });

  it("a stopped launch: not turned on", async () => {
    const { key } = await batch();
    const { call } = await claude();
    await launched(call, key, { go_live: "now" });
    expect((await call("cancel_batch", { batch_id: key })).isError).toBe(false);
    const s = await call("batch_status", { batch_id: key });
    expect(s.text).toMatch(/Not turned on: the launch was stopped, so the ads that were created stay paused\./);
  });
});

describe("R2-5 · get_results escapes names (real route)", () => {
  it("a campaign called 'Diwali | Leads | BLR' keeps every column in place", async () => {
    await batch();
    mock.objects.get("c1")!.name = "Diwali | Leads | BLR";
    const { call } = await claude();
    const r = await call("get_results", { level: "campaign", date_preset: "last_7d" });
    expect(r.isError, r.text).toBe(false);
    const rows = r.text.split("\n").filter((l) => l.startsWith("|"));
    expect(rows.length).toBeGreaterThan(3);
    for (const l of rows) expect(l.split("|").length, l).toBe(rows[0].split("|").length);
    expect(r.text).toContain("| Diwali / Leads / BLR (c1) |");
  });
});

describe("R2-6 · delivery_status for what isn't there", () => {
  it("a campaign ID Meta doesn't have reads 'Campaign … not found'; a one-word non-name is refused; empty answers say what was asked", async () => {
    await batch();
    const { call } = await claude();
    expect((await call("delivery_status", { campaign: "999000111" })).text).toBe("Campaign (999000111): not found in Meta (deleted, or not in this ad account)");
    const word = await call("delivery_status", { campaign: "Diwali" });
    expect(word.isError).toBe(true);
    expect(word.text).toMatch(/^No campaign called "Diwali"/);
    const { call: c2 } = await claude(fakeApi((m, p) => (p.startsWith("/api/manage/delivery?campaign=") ? { rows: [] } : undefined)));
    expect((await c2("delivery_status", { campaign: "120000000001" })).text).toBe("No ad sets found in campaign 120000000001: it has none, or it is not in this ad account (list_campaigns shows the campaigns).");
    expect((await c2("delivery_status", { campaign: "November tests" })).text).toMatch(/^No ad sets found in campaign "November tests" \(ID c1\)/);
  });

  it("1,500 rejected ads with 60 delivering ad sets: problems first, counts of the rest, under 20,000 characters", async () => {
    const rows = [
      ...Array.from({ length: 60 }, (_, i) => ({ kind: "adset", id: `5${i}`, name: `Ad set ${i}`, status: "ACTIVE", plain: "delivering", learning: "learning", issues: [] as string[] })),
      ...Array.from({ length: 1490 }, (_, i) => ({ kind: "ad", id: `6${i}`, name: `ad ${i}`, status: "ACTIVE", plain: "delivering", learning: null, issues: [] as string[] })),
      ...Array.from({ length: 10 }, (_, i) => ({ kind: "ad", id: `7${i}`, name: `bad ad ${i}`, status: "DISAPPROVED", plain: "rejected", learning: null, issues: ["Meta review: Ad text mentions personal attributes."] })),
    ];
    const { call } = await claude(fakeApi((m, p) => (p.startsWith("/api/manage/delivery") ? { rows } : undefined)));
    const r = await call("delivery_status", { campaign: "120000000001" });
    expect(r.text.length).toBeLessThan(20_000);
    expect(r.text).toMatch(/^60 ad set\(s\) and 1,500 ads: too many to list\./);
    for (let i = 0; i < 10; i++) expect(r.text).toContain(`Ad "bad ad ${i}" (7${i}): rejected · Meta review: Ad text mentions personal attributes.`);
    expect(r.text).toMatch(/Ads \(10 with problems\):/);
    expect(r.text).toMatch(/Not listed: 40 more ad set\(s\) \(delivering: 40\)\./);
    expect(r.text).toMatch(/Not listed: 1,490 more ads \(delivering: 1,490\)\./);
    expect(r.text).toMatch(/give adset \(its name or ID\)/);
  });
});

describe("R2-7 · names are never sent to Meta as IDs", () => {
  it("practice IDs on the list work; a one-word name that matches nothing is refused without a Meta call for it", async () => {
    await batch();
    const { call } = await claude();
    expect((await call("list_ads", { adset: "as1" })).isError).toBe(false);
    const before = mock.calls.length;
    const r = await call("get_details", { kind: "adset", id: "Diwali" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^No ad set called "Diwali"/);
    expect(mock.calls.slice(before).some((c) => c.path.includes("Diwali"))).toBe(false);
  });

  it("the campaign list can't be read: a name gets that error; digits skip the list", async () => {
    await batch();
    const api = fakeApi((m, p) => (p.startsWith("/api/manage/tree") ? new Error("Meta is limiting how often the launcher may call this ad account. Try again in about 5 minutes.") : undefined));
    const { call } = await claude(api);
    const d = await call("delivery_status", { adset: "Retarget" });
    expect(d.isError).toBe(true);
    expect(d.text).toBe('Couldn\'t look up the ad set "Retarget" by name: Meta is limiting how often the launcher may call this ad account. Try again in about 5 minutes. Try again later, or give its ID (a number).');
    const byId = await call("delivery_status", { adset: "999000111" });
    expect(byId.text).toBe("Ad set (999000111): not found in Meta (deleted, or not in this ad account)");
  });
});

describe("R2-8 · preview_batch's last line follows a failed summary check", () => {
  it("ad account disabled, paused launch: the last line names the failed check, never 'No problems found'", async () => {
    fresh({ accountStatus: 2 });
    const { key } = await batch();
    const { call } = await claude();
    const pv = await call("preview_batch", { batch_id: key });
    const last = pv.text.trim().split("\n").pop()!;
    expect(last).toMatch(/^CHECK FAILED in the summary \(1\): The ad account .* is disabled.*Until this is fixed the launch may fail, or the ads may not deliver\. Show it to the person and fix it first/);
    expect(last).toMatch(/launch only if they still want the paused ads created now: launch_batch with confirm: true( and accept_warnings: \d+ \(the number of warnings they read and accepted\))?\.$/);
    expect(pv.text).not.toMatch(/No problems found/);
  });

  it("ad account disabled, go live now: the launch is refused until fixed, and no amount is offered", async () => {
    fresh({ accountStatus: 2 });
    const { key } = await batch();
    const { call } = await claude();
    const pv = await call("preview_batch", { batch_id: key, go_live: "now" });
    const last = pv.text.trim().split("\n").pop()!;
    expect(last).toMatch(/^CHECK FAILED in the summary \(1\): .*The launch is refused until this is fixed, and nothing would be turned on\./);
    expect(last).not.toMatch(/spend_confirmation/);
  });
});

describe("R2-9 · long answers are cut with a note", () => {
  it("list_destinations of 300 campaigns × 10 ad sets: under 20,000 characters, counts, and how to narrow", async () => {
    const campaigns = Array.from({ length: 300 }, (_, i) => ({ id: `12000${i}`, name: `Campaign ${i} | Leads | Bangalore`, status: "ACTIVE", adsets: Array.from({ length: 10 }, (_, j) => ({ id: `13000${i}${j}`, name: `Ad set ${i}-${j} women 25-45`, status: "ACTIVE", isDynamicCreative: false })) }));
    const { call } = await claude(fakeApi((m, p) => (p.startsWith("/api/destinations") ? { campaigns } : undefined)));
    const r = await call("list_destinations", {});
    expect(r.text.length).toBeLessThan(20_000);
    expect((r.text.match(/^  - Ad set/gm) ?? []).length).toBe(150);
    expect(r.text).toMatch(/\(285 more campaigns not shown, 300 in all with 3000 ad sets; give campaign to narrow the list\.\)/);
    expect(r.text).toMatch(/more campaigns or ad sets than the launcher reads at once \(500\)/);
    const one = await call("list_destinations", { campaign: "Campaign 299 |" });
    expect((one.text.match(/^Campaign /gm) ?? []).length).toBe(1);
    expect((one.text.match(/^  - Ad set/gm) ?? []).length).toBe(10);
  });

  it("list_destinations through the real route: campaign narrows the list", async () => {
    await batch();
    const { call } = await claude();
    const r = await call("list_destinations", { campaign: "CBO" });
    expect(r.text).toMatch(/^Campaign "CBO campaign" \(id c2, paused\)\n  - Ad set "CBO ad set"/);
    expect(r.text).not.toMatch(/November tests/);
  });

  it("preview_batch with 40 ads, 30 with errors and 10 with warnings: the note counts the hidden ads' warnings", async () => {
    const ad = (n: number) => ({ position: n, creativeName: `c${n}`, metaName: `ad ${n}`, adsetName: "A", files: [{ id: n, filename: `c${n}.jpg`, ratio: "1x1", placement: "All placements", size: "1 MB", durationSec: null }], copy: { primaryTexts: ["t"], headlines: ["h"], linkUrl: "https://example.com", cta: "LEARN_MORE" }, hasOverride: false, checks: [{ level: n <= 30 ? "error" : "warning", message: `Ad ${n}: a problem.` }], status: "pending", step: null, error: null, reviewLabel: "", reviewIssues: [], metaPostId: null, metaIgMediaId: null, leftover: null, featureWarnings: [], adsManagerUrl: null });
    const view = { key: "big40", status: "draft", statusLabel: "Not launched yet", source: { kind: "upload", label: "" }, settings: { campaignName: "C", adsetMode: "existing", adsetName: "A", copyTemplateId: null, preset: null, goLive: "paused", goLiveAt: null, extraAdsets: [] }, preview: { batchChecks: [], errors: 30, warnings: 10, estimate: { label: "about 5 minutes", rateLimited: false } }, launchEstimate: null, progress: { total: 40, done: 0, failed: 0, working: 0 }, links: { app: "https://launcher.test/batches/big40", campaign: null }, ads: Array.from({ length: 40 }, (_, i) => ad(i + 1)), unassigned: [] };
    const { call } = await claude(fakeApi((m, p) => (p === "/api/batches/big40/preview" ? view : p === "/api/batches/big40/summary" ? new Error("no summary") : undefined)));
    const r = await call("preview_batch", { batch_id: "big40" });
    expect(r.text).toContain("(10 more ads are not listed here: 10 with warnings. Every ad and its problems are in the app: https://launcher.test/batches/big40)");
  });
});

describe("R2-10 · small input and wording fixes", () => {
  it("list_ads with part of a name names the ad set it used", async () => {
    const { key, batchId, accountId } = await batch();
    const { call } = await claude();
    await launched(call, key);
    await runBatch(batchId, deps(accountId));
    const r = await call("list_ads", { adset: "test ad" });
    expect(r.text.split("\n")[0]).toBe('Ads in ad set "November test ad set" (ID as1), the only ad set whose name contains "test ad":');
    const exact = await call("list_ads", { adset: "November test ad set" });
    expect(exact.text.split("\n")[0]).toBe('Ads in ad set "November test ad set" (ID as1):');
  });

  it("remove_file without confirm: true is refused and the file stays", async () => {
    const { key, batchId } = await batch();
    const { call } = await claude();
    const before = db().prepare("SELECT COUNT(*) FROM assets WHERE batch_id = ?").pluck().get(batchId);
    const r = await call("remove_file", { batch_id: key, file: "static-team_4x5.jpg" });
    expect(r.isError).toBe(true);
    expect(db().prepare("SELECT COUNT(*) FROM assets WHERE batch_id = ?").pluck().get(batchId)).toBe(before);
  });

  it("list_batches says it looks at the latest 50 only when there are 50", async () => {
    const { accountId } = await batch();
    const { call } = await claude();
    expect((await call("list_batches", { status: "problems" })).text).toBe("No batches like that.");
    for (let i = 0; i < 50; i++) newBatch(accountId, "test@example.com");
    expect((await call("list_batches", { status: "problems" })).text).toBe("No batches like that among the latest 50 batches (older ones are in the app's batch list).");
    expect((await call("list_batches", {})).text).toMatch(/\(Only the latest 50 batches are looked at; older ones are in the app's batch list\.\)$/);
  });

  it("list_alerts notes the cut at 10, and not below", async () => {
    await batch();
    const { call } = await claude();
    for (let i = 1; i <= 9; i++) await sendAlert({ to: "test@example.com", subject: `Launch b${i}: ads failed`, lines: ["x"], link: "https://launcher.test" });
    expect((await call("list_alerts", {})).text).not.toMatch(/newest alerts are listed/);
    for (let i = 10; i <= 12; i++) await sendAlert({ to: "test@example.com", subject: `Launch b${i}: ads failed`, lines: ["x"], link: "https://launcher.test" });
    expect((await call("list_alerts", {})).text).toMatch(/\(Only the 10 newest alerts are listed; older ones from the last 14 days may exist and are not shown\.\)$/);
  });

  it("answers that aren't the launcher's JSON object reach Claude as one plain sentence", async () => {
    const answers: Record<string, () => Response> = {
      "http://html.test": () => new Response("<html><body>Please wait…</body></html>", { status: 200, headers: { "Content-Type": "text/html" } }),
      "http://empty.test": () => new Response("", { status: 200 }),
      "http://null.test": () => new Response("null", { status: 200, headers: { "Content-Type": "application/json" } }),
      "http://list.test": () => new Response("[1,2]", { status: 200, headers: { "Content-Type": "application/json" } }),
    };
    vi.stubGlobal("fetch", (url: string | URL | Request, init?: RequestInit) => {
      const s = url instanceof Request ? url.url : String(url);
      const hit = Object.keys(answers).find((b) => s.startsWith(b));
      if (hit) return Promise.resolve(answers[hit]());
      if (s.startsWith(BASE)) return dispatch(new Request(s, init));
      return realFetch(url, init);
    });
    try {
      for (const base of Object.keys(answers)) {
        const { call } = await claude(httpApi(base, KEY));
        const r = await call("batch_status", { batch_id: "abcde" });
        expect(r.isError, base).toBe(true);
        expect(r.text).toBe(`The launcher's address (${base}) answered with something that is not the launcher (for example a web page from a proxy or a sign-in page). Check the launcher address in the Claude extension's settings, or try again in a minute.`);
      }
    } finally {
      vi.stubGlobal("fetch", (url: string | URL | Request, init?: RequestInit) => {
        const s = url instanceof Request ? url.url : String(url);
        if (s.startsWith(BASE)) return dispatch(new Request(s, init));
        if (s.startsWith("https://example.com")) return Promise.resolve(new Response("ok"));
        return realFetch(url, init);
      });
    }
  });

  it("get_safety_settings names the ad account's currency", async () => {
    await batch();
    db().prepare("INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES ('daily_budget_ceiling', '20000', 'test@example.com', datetime('now'))").run();
    const { call } = await claude();
    expect((await call("get_safety_settings", {})).text).toMatch(/^Daily budget ceiling: ₹20,000 a day\./);
    const { call: c2 } = await claude(fakeApi((m, p) => (p === "/api/settings" ? { dailyBudgetCeiling: 20000, currency: null, alertEmails: false } : undefined)));
    expect((await c2("get_safety_settings", {})).text).toMatch(/^Daily budget ceiling: 20,000 \(in the ad account's currency\) a day\./);
  });
});
