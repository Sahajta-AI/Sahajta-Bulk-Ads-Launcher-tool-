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
import { queueGoLive } from "@/lib/manage/golive";
import { sendAlert } from "@/lib/alerts";
import { istLabel } from "@/lib/time";
import { httpApi, registerTools, type LauncherApi } from "@/mcp/tools";
import { cacheSet, getAds, getBatch } from "@/lib/store";
import { EXTENSION_VERSION } from "../mcp/version";
import { LEAD_COPY, fifteenFileFolder, freshDb, setupBatch } from "./helpers";

// Fixes to Claude's tools (19 Nov 2026, group MCP, items T1–T15 and the notes of the server groups).
// Same harness as tests/audit-mcp.test.ts: MCP client → tool → httpApi → the REAL route handler in-process
// → service → fake Meta. A few tests give the tools a hand-made API answer (fakeApi) where the case can't be
// made with the fake Meta (a summary that fails on its own, a NOT_FOUND row, results notes).

vi.mock("@/auth", () => ({ auth: async () => null }));
process.env.META_MOCK = "1";
process.env.ALLOWED_EMAILS = "test@example.com";
const BASE = "http://launcher.test";
const KEY = "sal_fix_mcp_key_0123456789";
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

beforeEach(() => {
  freshDb();
  clock = new FakeClock();
  mock = new MockMeta({ clock, capPoints: 90000, richAccount: true, allowActive: true, videoProcessingMs: 1000 });
  g.__mockMeta = mock;
  db().prepare("INSERT INTO api_keys (user_email, label, key_hash, key_hint) VALUES (?, ?, ?, ?)").run("test@example.com", "fix", sha256(KEY), KEY.slice(-4));
});

async function claude(api: LauncherApi = httpApi(BASE, KEY)) {
  const server = new McpServer({ name: "fix", version: "0" });
  registerTools(server, api);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "fix", version: "0" });
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

/** A batch with a lead form in its copy (as1, as3 and as4 of the practice account are Instant-form ad sets). */
async function batch(opts: { lead?: boolean } = {}) {
  const r = await setupBatch(folder);
  db().prepare("UPDATE ad_accounts SET is_default = 1 WHERE id = ?").run(r.accountId);
  if (opts.lead !== false) db().prepare("UPDATE batches SET copy = ? WHERE id = ?").run(JSON.stringify(LEAD_COPY), r.batchId);
  return { ...r, key: getBatch(r.batchId)!.key };
}
const deps = (accountId: number) => ({ client: clientFor(accountId), files: localFiles, clock, accountDbId: accountId, tmpDir: fs.mkdtempSync(path.join(os.tmpdir(), "fix-mcp-")) });
const planKey = (text: string) => /^Plan (\w+):/m.exec(text)?.[1] ?? "";
const future = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const warningsIn = (text: string) => Number(/(\d+) warning\(s\)\. Show/.exec(text)?.[1] ?? 0);

// ---------------------------------------------------------------------------------------------

describe("T1 · update_plan changes only what it is given", () => {
  it("a new time alone is a valid change: the steps stay, and \"\" clears the time again", async () => {
    await batch();
    const { call } = await claude();
    const p = await call("plan_changes", { ops: [{ type: "edit_adset", adset: "as1", name: "Kept" }] });
    const key = planKey(p.text);
    const at = `${future(4)}T10:00`;
    const u = await call("update_plan", { plan_id: key, run_at: at });
    expect(u.isError).toBe(false);
    expect(u.text).toMatch(/When: Runs at \d{1,2} \w{3} \d{4}, 10:00 am IST/);
    expect(JSON.parse(db().prepare("SELECT ops FROM plans WHERE key = ?").pluck().get(key) as string).ops[0].name).toBe("Kept");
    const c = await call("update_plan", { plan_id: key, run_at: "" });
    expect(c.isError).toBe(false);
    expect(db().prepare("SELECT run_at FROM plans WHERE key = ?").pluck().get(key)).toBeNull();
    const none = await call("update_plan", { plan_id: key });
    expect(none.isError).toBe(true);
    expect(none.text).toMatch(/Give what to change/);
  });
});

describe("T2 · cancel_batch names every batch it stopped", () => {
  it("the launch into a second ad set is stopped too and named", async () => {
    const { key } = await batch();
    const { call } = await claude();
    expect((await call("preview_batch", { batch_id: key, ad_set: ["as1", "as4"] })).isError).toBe(false);
    expect((await call("launch_batch", { batch_id: key, confirm: true, accept_warnings: true })).isError).toBe(false);
    const sib = db().prepare("SELECT key FROM batches WHERE key != ? AND adset_id = 'as4'").pluck().get(key) as string;
    const c = await call("cancel_batch", { batch_id: key });
    expect(c.isError).toBe(false);
    expect(c.text).toMatch(new RegExp(`^Batch ${key}: stopped\\. 0 of 9 ads were created and stay paused\\.`));
    expect(c.text).toContain(`Also stopped: batch ${sib} (same ads, ad set "Min-spend template").`);
  });
});

describe("T3 · times are shown in IST words, and times without a zone are India time", () => {
  it("plan list, connection expiry, preview, launch and batch status never show a raw ISO or database time", async () => {
    const { key, accountId } = await batch();
    const expires = Date.now() + 30 * 86_400_000;
    db().prepare("UPDATE ad_accounts SET token_expires_at = ? WHERE id = ?").run(expires, accountId);
    const { call } = await claude();
    await call("plan_changes", { run_at: `${future(3)}T09:00`, ops: [{ type: "edit_adset", adset: "as1", name: "x" }] });
    const list = await call("plan_status", {});
    expect(list.text).toMatch(/Waiting for your confirmation · 1 step\(s\) · runs \d{1,2} \w{3} \d{4}, 09:00 am IST/);
    expect(list.text).toMatch(/made \d{1,2} \w{3} \d{4}, \d\d:\d\d [ap]m IST/);
    expect(list.text).not.toMatch(/\d{4}-\d\d-\d\d[ T]\d\d:\d\d/);
    const conn = await call("connection_status", {});
    expect(conn.text).toContain(`works until ${istLabel(new Date(expires).toISOString())}`);
    const pv = await call("preview_batch", { batch_id: key, go_live: "at", go_live_at: `${future(5)}T09:00` });
    expect(pv.text).toMatch(/TURNED ON at \d{1,2} \w{3} \d{4}, 09:00 am IST\./);
    expect(pv.text).not.toMatch(/\d{4}-\d\d-\d\dT\d\d:\d\d/);
    const l = await call("launch_batch", { batch_id: key, confirm: true, accept_warnings: warningsIn(pv.text), spend_confirmation: "₹500" });
    expect(l.isError).toBe(false);
    expect(l.text).toMatch(/turned on at \d{1,2} \w{3} \d{4}, 09:00 am IST\./);
    const s = await call("batch_status", { batch_id: key });
    expect(s.text).toMatch(/Times \(IST\): made \d{1,2} \w{3} \d{4}/);
    expect(s.text).not.toMatch(/\d{4}-\d\d-\d\dT\d\d:\d\d|\d{4}-\d\d-\d\d \d\d:\d\d:\d\d/);
  });
});

describe("T4 · set_ad_copy merges, and after a launch it points to retry_failed", () => {
  it("a row with only a lead form keeps the ad's own texts; after the launch the answer says retry_failed", async () => {
    const { key, batchId, accountId } = await batch();
    const { call } = await claude();
    await call("set_ad_copy", { batch_id: key, rows: [{ ad: 2, primary_texts: ["Own text"] }] });
    await call("set_ad_copy", { batch_id: key, rows: [{ ad: 2, lead_form_id: "777" }] });
    const o = JSON.parse(getAds(batchId).find((a) => a.position === 2)!.copy_override ?? "{}");
    expect(o).toMatchObject({ primaryTexts: ["Own text"], leadFormId: "777" });
    const pv = await call("preview_batch", { batch_id: key });
    await call("launch_batch", { batch_id: key, confirm: true, accept_warnings: warningsIn(pv.text) });
    mock.inject({ match: (m, p) => m === "POST" && p.endsWith("/adcreatives"), kind: "error", error: { message: "Invalid parameter", code: 100, error_user_msg: "Text too long." } });
    await runBatch(batchId, deps(accountId));
    const failed = getAds(batchId).find((a) => a.status === "failed")!;
    const r = await call("set_ad_copy", { batch_id: key, rows: [{ ad: failed.position, primary_texts: ["Short."] }] });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/retry_failed creates them with the new copy/);
    expect(r.text).not.toMatch(/preview_batch/);
  });
});

describe("T5 · a missing pre-launch summary is said plainly", () => {
  it("preview_batch says the summary couldn't be loaded and not to launch, never 'Show the summary'", async () => {
    const { key } = await batch();
    const api = fakeApi((m, p) => (m === "GET" && p.endsWith("/summary") ? new Error("Meta is limiting how often the launcher may call this ad account, so this can't be done right now.") : undefined));
    const { call } = await claude(api);
    const r = await call("preview_batch", { batch_id: key });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("The pre-launch summary couldn't be loaded: Meta is limiting how often the launcher may call this ad account, so this can't be done right now. Don't launch until preview_batch shows it.");
    expect(r.text).not.toMatch(/Show the summary/);
    expect(r.text).not.toMatch(/launch_batch with confirm/);
  });
});

describe("T5 (real route) · the summary fails on its own in the launcher", () => {
  it("Meta refuses the summary's campaign read: preview_batch says the summary couldn't be loaded and not to launch", async () => {
    const { key } = await batch();
    const { call } = await claude();
    // Only the summary reads the campaign by its ID (the preview reads the account's lists).
    mock.inject({ match: (m, p) => m === "GET" && p === "c1", kind: "error", error: { message: "Unsupported get request.", code: 100 } });
    const r = await call("preview_batch", { batch_id: key, go_live: "now" });
    expect((mock as unknown as { faults: unknown[] }).faults).toHaveLength(0);
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/\| 1 \| /); // the preview table is there
    expect(r.text).toMatch(/The pre-launch summary couldn't be loaded: .+\. Don't launch until preview_batch shows it\./);
    expect(r.text).not.toMatch(/PRE-LAUNCH SUMMARY|Show the summary|launch_batch with confirm|spend_confirmation|TOTAL daily budget/);
  });
});

describe("T6 · long plans stay readable", () => {
  it("a 300-step plan: TOTAL, what turns on and the typed amount first; repeated steps grouped; table cut with the app link", async () => {
    await batch();
    const { call } = await claude();
    const ops = Array.from({ length: 300 }, (_, i) => ({ type: "duplicate_adset", adset: "as1", changes: [{ name: `Copy ${i + 1}`, daily_budget: 500 + i }] }));
    const p = await call("plan_changes", { ops });
    expect(p.isError).toBe(false);
    expect(p.text.length).toBeLessThan(60_000);
    expect(p.text.indexOf("TOTAL daily budget")).toBeLessThan(600);
    expect(p.text).toMatch(/^Steps 3–300: 298 more steps of the same kind\. They make or change 298 ad sets with daily budgets from ₹502 to ₹799/m);
    expect(p.text).toMatch(/\(270 more ad sets not shown here, daily budgets ₹530 to ₹799\. Every ad set with its budget and settings is in the app: https?:\/\/\S+\/plans\//);
    expect((p.text.match(/^\| \d+ \| Copy /gm) ?? []).length).toBe(30);
    const key = planKey(p.text);
    db().prepare("UPDATE plans SET status = 'running', progress = ? WHERE key = ?").run(JSON.stringify(ops.map((_, i) => ({ status: i < 120 ? "done" : i === 120 ? "failed" : "pending", ids: i < 120 ? [`9${i}`] : [], message: i === 120 ? "Meta said no." : "" }))), key);
    const s = await call("plan_status", { plan_id: key });
    expect(s.text.length).toBeLessThan(3_000);
    expect(s.text).toMatch(/Steps: 120 done, 1 failed, 179 not run yet \(of 300\)\./);
    expect(s.text).toMatch(/121\. .*: failed · Meta said no\./);
    expect(s.text).toMatch(/Done: steps 1–120\./);
    expect(s.text).toMatch(/Not run yet: steps 122–300\./);
  }, 120_000);

  it("the plan's own notes (plan_note) are always shown, and a typed amount that differs from the TOTAL is explained", async () => {
    const view = {
      key: "pabcd",
      title: "Test",
      status: "draft",
      statusLabel: "Waiting for your confirmation",
      canSpend: true,
      runAt: null,
      link: "https://launcher.test/plans/pabcd",
      progress: [],
      summary: {
        account: { id: "act_1001", name: "Sahajta", currency: "INR" },
        steps: [{ n: 1, title: "Turn ON: ad set \"A\"", lines: [] }],
        adsets: [],
        totals: { campaigns: 0, adsets: 0, ads: 0, dailyBudget: 1000, lifetimeBudget: 0, spendNowDaily: 2500, turnsOn: ['ad set "A"'] },
        checks: [
          ...Array.from({ length: 35 }, (_, i) => ({ level: "warning", code: "budget_high", message: `Unusual budget ${i + 1}.` })),
          { level: "warning", code: "plan_note", message: "Step 1 now works on something else, so the 2 items it made are not reused." },
        ],
        errors: 0,
        warnings: 36,
        canSpend: true,
        spendConfirmation: "₹2,500",
        notes: ["₹30,000 lifetime counted as ₹1,500 a day."],
      },
    };
    const { call } = await claude(fakeApi((m, p) => (p === "/api/plans/pabcd/view" ? view : undefined)));
    const r = await call("plan_status", { plan_id: "pabcd" });
    expect(r.text).toMatch(/Warning: Step 1 now works on something else/);
    expect(r.text).toMatch(/Money note: ₹30,000 lifetime counted as ₹1,500 a day\./);
    expect(r.text).toMatch(/To run it, the person types ₹2,500: what can spend in a day once this plan has run\. This differs from the TOTAL above/);
    expect(r.text).toMatch(/… and 6 more warnings: every one is in the app/);
    expect(r.text.indexOf("To run it")).toBeLessThan(r.text.indexOf("Warning:"));
    expect(r.text).toContain('spend_confirmation: "₹2,500"');
  });
});

describe("T6 (real route) · the plan's money notes and a typed amount that differs from the TOTAL", () => {
  it("turning on a campaign whose other ad set is on with a lifetime budget: the note, the amount and why it differs", async () => {
    await batch();
    const { call } = await claude();
    const end = new Date(Date.now() + 20 * 86_400_000 + 3_600_000).toISOString(); // 20 whole days left (days round down)
    Object.assign(mock.objects.get("as4")!, { status: "ACTIVE", effective_status: "CAMPAIGN_PAUSED", daily_budget: undefined, lifetime_budget: "3000000", end_time: end });
    const p = await call("plan_changes", { ops: [{ type: "set_status", status: "ACTIVE", campaigns: ["c1"], adsets: ["as1"] }] });
    expect(p.isError, p.text).toBe(false);
    expect(p.text).toMatch(/^TOTAL daily budget at the end of this plan .*: ₹500\./m);
    expect(p.text).toMatch(/^Money note: Ad set "Min-spend template": ₹30,000 lifetime counted as ₹1,500 a day/m);
    expect(p.text).toMatch(/^To run it, the person types ₹2,000: what can spend in a day once this plan has run\. This differs from the TOTAL above/m);
    expect(p.text.indexOf("To run it")).toBeLessThan(p.text.indexOf("Step 1"));
    expect(p.text).toMatch(/spend_confirmation: "₹2,000" — the person must say this total themselves; do not fill it in for them\.$/);
    // plan_status shows the same plan the same way (the saved summary, read back through the route).
    const s = await call("plan_status", { plan_id: planKey(p.text) });
    expect(s.text).toMatch(/Money note: Ad set "Min-spend template"/);
    expect(s.text).toMatch(/To run it, the person types ₹2,000/);
  });
});

describe("T7 · names are never guessed", () => {
  it("save_copy_template with a part of a name lists the templates it could mean and saves nothing", async () => {
    await batch();
    const { call } = await claude();
    await call("save_copy_template", { name: "Site Visit", primary_texts: ["a"], link_url: "https://example.com" });
    await call("save_copy_template", { name: "Site Tour", primary_texts: ["b"], link_url: "https://example.com" });
    const r = await call("save_copy_template", { template: "Site", headlines: ["x"] });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/No copy template is called exactly "Site"\. Did you mean "Site (Visit|Tour)" \(id \d+\) or "Site (Visit|Tour)"/);
    expect(db().prepare("SELECT COUNT(*) FROM copy_templates WHERE headlines LIKE '%x%'").pluck().get()).toBe(0);
  });

  it("preview_batch with an ad set name that fits several shows the server's list", async () => {
    const { key } = await batch();
    const { call } = await claude();
    const r = await call("preview_batch", { batch_id: key, ad_set: "ad set" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/November test ad set/);
    expect(r.text).toMatch(/CBO ad set/);
  });
});

describe("T8 · numbers and lists as Claude naturally sends them", () => {
  it("expected_daily_total as '₹15,000', regroup to 'ad 3', a column set id as text and one metric as a string", async () => {
    const { key } = await batch();
    const { call } = await claude();
    const p = await call("plan_changes", { expected_daily_total: "₹15,000", ops: [{ type: "edit_adset", adset: "as1", name: "x" }] });
    expect(p.isError).toBe(false);
    expect(JSON.parse(db().prepare("SELECT ops FROM plans").pluck().get() as string).expected_daily_total).toBe(15000);
    const g1 = await call("regroup_files", { batch_id: key, file: "static-price_1x1.jpg", to: "ad 3" });
    expect(g1.isError).toBe(false);
    expect(g1.text).toMatch(/into ad 3/);
    const c1 = await call("save_column_set", { name: "Mine", metrics: "spend" });
    expect(c1.isError).toBe(false);
    const id = /\(id (\d+)\)/.exec(c1.text)![1];
    const c2 = await call("save_column_set", { id: String(id), name: "Mine", metrics: ["spend", "impressions"] });
    expect(c2.isError).toBe(false);
    expect(db().prepare("SELECT COUNT(*) FROM column_sets").pluck().get()).toBe(1);
  });
});

describe("T9 · tool annotations match what each tool does", () => {
  // Rewritten in round 2: the old test compared the labels with a list. Now every tool labelled read-only is
  // called (on a launched batch and a draft plan), and nothing may change in Meta or in the launcher's tables.
  it("every tool marked read-only changes nothing when called; deleting tools are marked destructive", async () => {
    const { key, batchId, accountId } = await batch();
    const { call, client } = await claude();
    const pv = await call("preview_batch", { batch_id: key });
    expect((await call("launch_batch", { batch_id: key, confirm: true, accept_warnings: warningsIn(pv.text) })).isError).toBe(false);
    await runBatch(batchId, deps(accountId));
    const plan = await call("plan_changes", { ops: [{ type: "edit_adset", adset: "as1", name: "x" }] });
    const pk = planKey(plan.text);
    const args: Record<string, Record<string, unknown>> = {
      batch_status: { batch_id: key },
      connection_status: {},
      delivery_status: { batch_id: key },
      get_details: { kind: "adset", id: "as1" },
      get_results: { level: "campaign", date_preset: "last_7d" },
      get_safety_settings: {},
      list_ads: { adset: "November test ad set" },
      list_alerts: {},
      list_batches: {},
      list_campaigns: {},
      list_destinations: { refresh: true },
      list_instagram_accounts: { refresh: true },
      list_metrics: {},
      list_options: {},
      list_templates: {},
      lookup: { what: "pixels" },
      plan_status: { plan_id: pk },
      plan_step_fields: { type: "create_custom_audience" },
    };
    const tools = (await client.listTools()).tools;
    const ro = tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name).sort();
    // A new read-only tool must be added to `args`, so it is called here too.
    expect(ro).toEqual(Object.keys(args).sort());
    const tables = ["batches", "ads", "assets", "plans", "jobs", "copy_templates", "naming_templates", "settings_presets", "column_sets", "custom_metrics", "app_settings", "events"];
    const snapshot = () => tables.map((t) => db().prepare(`SELECT * FROM ${t} ORDER BY rowid`).all());
    const before = snapshot();
    const writes = mock.calls.filter((c) => c.method !== "GET").length;
    for (const name of ro) {
      const r = await call(name, args[name]);
      expect(r.isError, `${name}: ${r.text}`).toBe(false);
    }
    expect(mock.calls.filter((c) => c.method !== "GET").length).toBe(writes);
    expect(snapshot()).toEqual(before);
    // Tools that change things say so; deleting tools are marked destructive.
    for (const t of tools.filter((x) => !x.annotations?.readOnlyHint)) expect(t.annotations?.readOnlyHint, t.name).toBe(false);
    expect(tools.filter((t) => t.annotations?.destructiveHint).map((t) => t.name).sort()).toEqual(["delete_draft", "remove_file"]);
    for (const name of ["delete_draft", "remove_file"]) expect(tools.find((t) => t.name === name)!.inputSchema.required, name).toContain("confirm");
  });
});

describe("T10 · saving a template or preset shows everything saved", () => {
  it("save_copy_template echoes UTM, display link and lead form; list_templates shows them", async () => {
    await batch();
    const { call } = await claude();
    const s = await call("save_copy_template", { name: "Echo", primary_texts: ["T1"], headlines: ["H1"], link_url: "https://example.com/v", display_link: "sahajta.com/v", lead_form_id: "4242", cta: "SIGN_UP" });
    expect(s.text).toMatch(/^Created copy template "Echo" \(id \d+\): 1 primary text\(s\), 1 headline\(s\), 0 description\(s\), SIGN_UP → https:\/\/example.com\/v\./);
    expect(s.text).toMatch(/Descriptions: none\nDisplay link: sahajta\.com\/v · Lead form: 4242/);
    expect(s.text).toMatch(/UTM tags: utm_source=facebook.* \(the default for new templates\)/);
    const e = await call("save_copy_template", { template: "echo", display_link: "" });
    expect(e.text).toMatch(/^Updated copy template "Echo"/);
    expect(e.text).toMatch(/Display link: none · Lead form: 4242/);
    const l = await call("list_templates", {});
    expect(l.text).toMatch(/"Echo" \(id \d+\): .* · display link none · description none · lead form 4242 · UTM utm_source=facebook/);
  });

  it("save_settings_preset echoes WhatsApp, Threads and partner Page; \"\" clears one and keeps the others", async () => {
    await batch();
    const { call } = await claude();
    const s = await call("save_settings_preset", { name: "WA", page_id: "p1", page_name: "Sahajta AI", instagram_id: "none", whatsapp_number: "+91 98123 45678", threads_account_id: "777", partner_page_id: "888" });
    expect(s.text).toMatch(/WhatsApp number: \+919812345678\. Threads account: 777\. Partner Page \(paid partnership\): 888\./);
    const e = await call("save_settings_preset", { preset: "WA", threads_account_id: "" });
    expect(e.text).toMatch(/^Updated preset "WA"/);
    expect(e.text).toMatch(/WhatsApp number: \+919812345678\. Threads account: none\. Partner Page \(paid partnership\): 888\./);
    const l = await call("list_templates", {});
    expect(l.text).toMatch(/"WA" \(id \d+\): .*WhatsApp \+919812345678, Threads account none, partner Page \(branded content\) 888/);
  });
});

describe("T11 · batch_status names the plan that turns the ads on, and when", () => {
  it("after the ads are in, the go-live plan's code and its IST time are shown", async () => {
    const { key, batchId, accountId } = await batch();
    const { call } = await claude();
    const at = `${future(2)}T09:00:00+05:30`;
    const pv = await call("preview_batch", { batch_id: key, go_live: "at", go_live_at: at });
    expect((await call("launch_batch", { batch_id: key, confirm: true, accept_warnings: warningsIn(pv.text), spend_confirmation: "₹500" })).isError).toBe(false);
    const before = await call("batch_status", { batch_id: key });
    expect(before.text).toMatch(/turned on by a plan at \d{1,2} \w{3} \d{4}, 09:00 am IST once every ad is in/);
    await runBatch(batchId, deps(accountId));
    const msg = await queueGoLive(batchId);
    const goKey = /plan (p[a-z0-9]{4})/.exec(msg ?? "")![1];
    const s = await call("batch_status", { batch_id: key });
    expect(s.text).toContain(`Turned on by plan ${goKey} (confirmed) at ${istLabel(at)}. plan_status with plan_id ${goKey} shows it.`);
  });
});

describe("T12 · preview_batch shows each ad's own copy", () => {
  it("an ad with its own copy shows its text, headline and button; the summary's copy line is the batch copy", async () => {
    const { key, batchId } = await batch();
    const { call } = await claude();
    await call("set_ad_copy", { batch_id: key, rows: [{ ad: "static-price_1x1.jpg", primary_texts: ["Price | drop"], headlines: ["Only this week"], cta: "GET_QUOTE", link_url: "https://example.com/price" }] });
    const pv = await call("preview_batch", { batch_id: key });
    const n = getAds(batchId).find((a) => a.creative_name.startsWith("static-price"))!.position;
    const row = pv.text.split("\n").find((x) => x.startsWith(`| ${n} |`))!;
    expect(row).toMatch(/OWN COPY: text "Price \/ drop", headline "Only this week", button GET_QUOTE/);
    expect(pv.text).toMatch(/^Copy \(the batch copy; 1 ad has its own copy, shown in the table; 1 ad has its own link\): 5 primary text\(s\), 5 headline\(s\), LEARN_MORE → https:\/\/example.com\/visit/m);
  });
});

describe("T14 · tools for what the app already has", () => {
  it("list_batches, list_instagram_accounts, get_safety_settings and list_alerts read plainly", async () => {
    const { key } = await batch();
    db().prepare("INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES ('daily_budget_ceiling', '20000', 'test@example.com', datetime('now'))").run();
    await sendAlert({ to: "test@example.com", subject: `Launch ${key}: 2 ads failed`, lines: ["Meta refused two ads."], link: `https://launcher.test/batches/${key}` });
    const { call } = await claude();
    const b = await call("list_batches", { status: "draft" });
    expect(b.text).toMatch(new RegExp(`^${key}: Not launched yet · .* → November tests → November test ad set · 9 ad\\(s\\) · made \\d{1,2} \\w{3} \\d{4}, .* IST`));
    expect((await call("list_batches", { status: "launched" })).text).toBe("No batches like that.");
    const ig = await call("list_instagram_accounts", {});
    expect(ig.text).toMatch(/@sahajta\.ai \(ID ig1\)/);
    const safe = await call("get_safety_settings", {});
    // The ad account's currency comes from /api/settings (round 2): the ceiling reads as money.
    expect(safe.text).toMatch(/Daily budget ceiling: ₹20,000 a day\./);
    expect(safe.text).toMatch(/only in the app: Settings → Safety/);
    const al = await call("list_alerts", {});
    expect(al.text).toMatch(new RegExp(`^- \\d{1,2} \\w{3} \\d{4}, .* IST: Launch ${key}: 2 ads failed\\n  Meta refused two ads\\.\\n  https://launcher.test/batches/${key}`));
  });

  it("refresh_review queues a review check; remove_file and delete_draft work on drafts only and need a yes", async () => {
    const { key, batchId, accountId } = await batch();
    const { call } = await claude();
    // remove_file is destructive: without the person's yes (confirm: true) nothing is removed.
    const rmNoYes = await call("remove_file", { batch_id: key, file: "static-team_4x5" });
    expect(rmNoYes.isError).toBe(true);
    expect(getAds(batchId)).toHaveLength(9);
    const rm = await call("remove_file", { batch_id: key, file: "static-team_4x5", confirm: true });
    expect(rm.isError).toBe(false);
    expect(rm.text).toMatch(/^Removed static-team_4x5\.jpg from batch \w+ \(it was in ad \d+\)\. The batch now has 8 ad\(s\)\./);
    expect(getAds(batchId)).toHaveLength(8);
    expect((await call("remove_file", { batch_id: key, file: "nope.jpg", confirm: true })).text).toMatch(/No file "nope.jpg"/);
    const noYes = await call("delete_draft", { batch_id: key });
    expect(noYes.isError).toBe(true);
    expect(getBatch(batchId)).toBeTruthy();
    const pv = await call("preview_batch", { batch_id: key });
    await call("launch_batch", { batch_id: key, confirm: true, accept_warnings: warningsIn(pv.text) });
    await runBatch(batchId, deps(accountId));
    const rv = await call("refresh_review", { batch_id: key });
    expect(rv.isError).toBe(false);
    expect(db().prepare("SELECT COUNT(*) FROM jobs WHERE kind = 'review' AND batch_id = ? AND status = 'queued'").pluck().get(batchId)).toBeGreaterThan(0);
    expect((await call("delete_draft", { batch_id: key, confirm: true })).text).toMatch(/Only batches that were never launched can be deleted/);
    const { key: k2, batchId: b2 } = await batch();
    const del = await call("delete_draft", { batch_id: k2, confirm: true });
    expect(del.text).toBe(`Deleted draft batch ${k2}. It was never launched, so nothing in Meta changed.`);
    expect(getBatch(b2)).toBeUndefined();
  });
});

describe("T15 · list_ads and delivery_status take names", () => {
  it("names are turned into IDs; a name that fits several is refused with the list; a gone ID reads plainly", async () => {
    const { key, batchId, accountId } = await batch();
    const { call } = await claude();
    const pv = await call("preview_batch", { batch_id: key });
    await call("launch_batch", { batch_id: key, confirm: true, accept_warnings: warningsIn(pv.text) });
    await runBatch(batchId, deps(accountId));
    const byName = await call("list_ads", { adset: "November test ad set" });
    expect(byName.isError).toBe(false);
    expect((byName.text.match(/^- "/gm) ?? []).length).toBe(9);
    const d = await call("delivery_status", { campaign: "November tests" });
    expect(d.isError).toBe(false);
    expect(d.text).toMatch(/Ad set "November test ad set" \(as1\)/);
    expect(d.text).not.toMatch(/%20|does not exist/);
    const many = await call("delivery_status", { adset: "ad set" });
    expect(many.isError).toBe(true);
    expect(many.text).toMatch(/^Several ad sets match "ad set": .*"November test ad set" \(ID as1, in campaign "November tests"\)/);
    const none = await call("list_ads", { adset: "No such ad set name" });
    expect(none.isError).toBe(true);
    expect(none.text).toMatch(/No ad set called "No such ad set name".*list_campaigns/);
    const gone = await call("delivery_status", { adset: "999000111" });
    expect(gone.text).toBe("Ad set (999000111): not found in Meta (deleted, or not in this ad account)");
  });
});

describe("notes from the server groups", () => {
  it("launch_batch sends accept_warnings as the number of warnings seen (also when Claude sends it as text)", async () => {
    const { key, batchId } = await batch();
    const { call } = await claude();
    const pv = await call("preview_batch", { batch_id: key });
    const n = warningsIn(pv.text);
    expect(n).toBeGreaterThan(1);
    expect(pv.text).toContain(`accept_warnings: ${n} (the number of warnings they accepted)`);
    const fewer = await call("launch_batch", { batch_id: key, confirm: true, accept_warnings: String(n - 1) });
    expect(fewer.isError).toBe(true);
    expect(fewer.text).toMatch(/new warnings? since you checked/);
    expect(getBatch(batchId)!.status).toBe("draft");
    const ok = await call("launch_batch", { batch_id: key, confirm: true, accept_warnings: String(n) });
    expect(ok.isError).toBe(false);
    expect(getBatch(batchId)!.status).toBe("queued");
  });

  it("retry_failed can switch the ads not created yet to another settings preset, and says so", async () => {
    const { key, batchId, accountId } = await batch();
    const { call } = await claude();
    await call("save_settings_preset", { name: "No Instagram", page_id: "p1", page_name: "Sahajta AI", instagram_id: "none" });
    const pv = await call("preview_batch", { batch_id: key });
    await call("launch_batch", { batch_id: key, confirm: true, accept_warnings: warningsIn(pv.text) });
    mock.inject({ match: (m, p) => m === "POST" && p.endsWith("/adcreatives"), kind: "error", error: { message: "Invalid parameter", code: 100, error_user_msg: "Something wrong." } });
    await runBatch(batchId, deps(accountId));
    const r = await call("retry_failed", { batch_id: key, settings_preset: "No Instagram" });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(new RegExp(`^Batch ${key}: Retrying 1 ad not created yet with the settings preset "No Instagram"\\..* Use batch_status to follow it\\.$`));
    expect(JSON.parse(getBatch(batchId)!.preset!).name).toBe("No Instagram");
  });

  it("get_results shows the notes, a cut list and the ad account's time zone", async () => {
    const res = {
      currency: "INR",
      level: "campaign",
      range: "1 Nov 2026 to 19 Nov 2026 (today)",
      columns: [{ key: "spend", label: "Amount spent", format: "money" }, { key: "reach", label: "Reach", format: "number" }],
      rows: [
        { name: "A", id: "1", breakdown: {}, values: { spend: 100, reach: 50 } },
        { name: "B", id: "2", breakdown: {}, values: { spend: 200, reach: 70 } },
      ],
      totals: { spend: 300, reach: null },
      truncated: true,
      notes: ["Only the first 2 rows are shown (Meta has more), and the totals add up these rows only."],
      timezone: "America/Los_Angeles",
    };
    const { call } = await claude(fakeApi((m, p) => (m === "POST" && p === "/api/results" ? res : undefined)));
    const r = await call("get_results", { level: "campaign", since: "2026-11-01", metrics: "spend" });
    expect(r.text).toMatch(/^Results by campaign, 1 Nov 2026 to 19 Nov 2026 \(today\) \(days in the ad account's time zone, America\/Los_Angeles\):/);
    expect(r.text).toMatch(/\| TOTAL \| ₹300 \| – \|/);
    expect(r.text).toMatch(/A dash in TOTAL means/);
    expect(r.text).toMatch(/Note: Only the first 2 rows are shown/);
  });

  it("get_results through the real route: a saved column set's broken column is named in a note; a non-India zone is named", async () => {
    await batch();
    const { call } = await claude();
    expect((await call("save_custom_metric", { name: "Cost per site visit", formula: "spend / actions:lead", format: "money" })).isError).toBe(false);
    expect((await call("save_column_set", { name: "Mine", metrics: ["spend", "Cost per site visit"] })).isError).toBe(false);
    db().prepare("DELETE FROM custom_metrics").run(); // the custom metric is gone; the saved column set still names it
    cacheSet("acctinfo:act_1001", { currency: "INR", timezone: "America/Los_Angeles", name: "Sahajta AI (mock)" }, 86_400_000);
    const r = await call("get_results", { level: "campaign", date_preset: "last_7d", column_set: "Mine" });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toMatch(/^Results by campaign, .* \(days in the ad account's time zone, America\/Los_Angeles\):/);
    expect(r.text).toMatch(/^Note: The column "Cost per site visit" was left out: /m);
    expect(r.text).toMatch(/^\| campaign \| Amount spent \|$/m);
  });

  it("the Claude Code endpoint reports the extension's version", async () => {
    const { POST } = await import("@/app/api/mcp/route");
    const res = await POST(
      new Request(`${BASE}/api/mcp`, {
        method: "POST",
        headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } }),
      }),
    );
    const body = (await res.json()) as { result: { serverInfo: { name: string; version: string } } };
    expect(body.result.serverInfo).toEqual({ name: "sahajta-ads", version: EXTENSION_VERSION });
  });
});
