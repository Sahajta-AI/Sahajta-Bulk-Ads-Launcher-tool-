import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { sha256 } from "@/lib/crypto";
import { db } from "@/lib/db";
import { MockMeta, FakeClock } from "@/lib/meta/mock";
import { pacerFor } from "@/lib/meta/factory";
import { queueGoLive } from "@/lib/manage/golive";
import { httpApi, registerTools } from "@/mcp/tools";
import { getAds } from "@/lib/store";
import { fifteenFileFolder, freshDb, setupBatch } from "./helpers";

// Reviewer's checks on the MCP audit (tests/audit-mcp.test.ts). Same harness: MCP client → tool →
// httpApi → real route handler in-process → service → fake Meta. These tests RECORD how the code
// behaves today (they pass), so each one documents a fact the review relies on.

vi.mock("@/auth", () => ({ auth: async () => null }));
process.env.META_MOCK = "1";
process.env.ALLOWED_EMAILS = "test@example.com";
const BASE = "http://launcher.test";
const KEY = "sal_critique_key_0123456789";
const g = globalThis as unknown as { __mockMeta?: MockMeta };
let mock: MockMeta;
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
  mock = new MockMeta({ clock: new FakeClock(), capPoints: 90000, richAccount: true, allowActive: true, videoProcessingMs: 1000 });
  g.__mockMeta = mock;
  db().prepare("INSERT INTO api_keys (user_email, label, key_hash, key_hint) VALUES (?, ?, ?, ?)").run("test@example.com", "critique", sha256(KEY), KEY.slice(-4));
});

async function claude() {
  const server = new McpServer({ name: "critique", version: "0" });
  registerTools(server, httpApi(BASE, KEY));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "critique", version: "0" });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { text: r.content.map((c) => c.text).join("\n"), isError: !!r.isError };
  };
  return { call, client };
}

async function batch() {
  const r = await setupBatch(folder);
  db().prepare("UPDATE ad_accounts SET is_default = 1 WHERE id = ?").run(r.accountId);
  const key = (db().prepare("SELECT key FROM batches WHERE id = ?").get(r.batchId) as { key: string }).key;
  return { ...r, key };
}
const planKey = (text: string) => /^Plan (\w+):/m.exec(text)?.[1] ?? "";
const future = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

describe("finding 1: side effects of 'keep run_at when not resent'", () => {
  // Recorded the bug "ops are required" (update_plan could not change only the time). Fixed on 19 Nov (T1/P4):
  // ops are optional and the steps left out are kept, so this now checks the fixed behaviour.
  it("update_plan can change only the time: the steps are kept and the new time is saved", async () => {
    await batch();
    const { call } = await claude();
    const p = await call("plan_changes", { ops: [{ type: "edit_adset", adset: "as1", name: "A" }] });
    const key = planKey(p.text);
    const runAt = `${future(3)}T09:00:00+05:30`;
    const r = await call("update_plan", { plan_id: key, run_at: runAt });
    expect(r.text).not.toMatch(/Input validation error/);
    expect(r.isError).toBe(false);
    expect(db().prepare("SELECT run_at FROM plans WHERE key = ?").pluck().get(key)).toBe(runAt);
    expect(JSON.parse(db().prepare("SELECT ops FROM plans WHERE key = ?").pluck().get(key) as string).ops).toEqual([{ type: "edit_adset", adset: "as1", name: "A" }]);
  });

  // Recorded the bug "retry without ops reuses a run_at in the past". Fixed on 19 Nov (P4): a time that has passed
  // (or a plan that already ran part-way) is dropped on retry, with or without ops.
  it("retry_plan without ops on a scheduled plan whose time passed is no longer blocked by 'in the past'", async () => {
    await batch();
    const { call } = await claude();
    const p = await call("plan_changes", { run_at: `${future(3)}T09:00:00+05:30`, ops: [{ type: "edit_adset", adset: "as1", name: "A" }, { type: "edit_adset", adset: "as1", name: "B" }] });
    const key = planKey(p.text);
    const past = new Date(Date.now() - 3 * 3_600_000).toISOString();
    const ops = JSON.parse(db().prepare("SELECT ops FROM plans WHERE key = ?").pluck().get(key) as string);
    ops.run_at = past;
    db().prepare("UPDATE plans SET status = 'partial', run_at = ?, ops = ?, progress = ? WHERE key = ?").run(past, JSON.stringify(ops), JSON.stringify([{ status: "done", ids: ["as1"], message: "" }, { status: "failed", ids: [], message: "x" }]), key);
    const r = await call("retry_plan", { plan_id: key });
    expect(r.text).not.toMatch(/in the past/);
    expect(r.text).toMatch(/Status: Waiting for your confirmation/);
    expect(db().prepare("SELECT run_at FROM plans WHERE key = ?").pluck().get(key)).toBeNull();
    // With ops resent, run_at is dropped too and the retry works.
    const r2 = await call("retry_plan", { plan_id: key, ops: ops.ops });
    expect(r2.text).not.toMatch(/in the past/);
  });
});

describe("finding 3: the raw go_live_at is printed even when it HAS a zone", () => {
  // Recorded the bug (the raw UTC time next to the IST one). Fixed on 19 Nov (T3): every time is shown in IST words.
  it("a time set by the web page (toISOString, UTC 'Z') is shown to Claude only as '09:00 am IST'", async () => {
    const { key } = await batch();
    const { call } = await claude();
    const iso = new Date(`${future(5)}T09:00:00+05:30`).toISOString(); // what LaunchStep.tsx sends
    const r = await call("preview_batch", { batch_id: key, go_live: "at", go_live_at: iso });
    expect(r.text).not.toContain(iso);
    expect(r.text).toMatch(/TURNED ON at \d{1,2} \w{3} \d{4}, 09:00 am IST/);
  });
});

describe("finding 6: list_ads under Meta's speed limit", () => {
  // Recorded the bug (1+N reads, some refused, ads dropped without a word). Fixed on 19 Nov (R3): one paged read of the
  // ad set's ads with their creatives, so the list is complete or the answer says Meta is limiting. Never cut silently.
  it("never drops ads silently when the pacer allows only a few calls", async () => {
    await batch();
    for (let i = 0; i < 12; i++) {
      const id = `ad9${String(i).padStart(2, "0")}`;
      mock.objects.set(id, { id, name: `Ad ${id}`, adset_id: "as1", status: "PAUSED", effective_status: "PAUSED", creative: { id: `cr_${id}` }, _type: "ad" });
    }
    const accId = db().prepare("SELECT id FROM ad_accounts LIMIT 1").pluck().get() as number;
    const p = pacerFor(accId);
    (p as unknown as { fixedCap?: number }).fixedCap = 8; // starter tier is 60 points / 5 min; 8 makes the cut visible with 12 ads
    p.state.capPoints = 8;
    p.state.log = [];
    p.state.lastUtil = undefined;
    p.state.lastBuc = undefined;
    try {
      const { call } = await claude();
      const r = await call("list_ads", { adset: "as1" });
      const shown = (r.text.match(/^- "/gm) ?? []).length;
      if (r.isError) expect(r.text).toMatch(/Meta is limiting/);
      else expect(shown).toBe(12);
      console.log(`list_ads: ${r.isError ? r.text.slice(0, 80) : `${shown} of 12 ads`}`);
    } finally {
      // Never leak the tiny cap into the next test (it made the next test's answer "Meta is limiting…").
      (p as unknown as { fixedCap?: number }).fixedCap = undefined;
      db().prepare("DELETE FROM rate_state").run();
    }
  });
});

describe("finding 6: the audit's delivery_status test fails for another reason", () => {
  // Recorded the bug ("Nothing created yet." for a plan that made an ad set). Fixed on 19 Nov (R2): the plan's own steps
  // say what each ID is, so the ad set the plan changed is listed.
  it("a plan that made a real (numeric) ad set lists it", async () => {
    await batch();
    mock.objects.set("120000000001", { id: "120000000001", name: "Made by plan", campaign_id: "c1", status: "PAUSED", effective_status: "PAUSED", _type: "adset" });
    const { call } = await claude();
    const p = await call("plan_changes", { ops: [{ type: "edit_adset", adset: "as1", name: "x" }] });
    const key = planKey(p.text);
    db().prepare("UPDATE plans SET status = 'done', progress = ? WHERE key = ?").run(JSON.stringify([{ status: "done", ids: ["120000000001"], message: "" }]), key);
    const r = await call("delivery_status", { plan_id: key });
    expect(r.text).not.toBe("Nothing created yet.");
    expect(r.text).toMatch(/Ad set "Made by plan" \(120000000001\)/);
  });
});

describe("finding 11: duplicate copy template names", () => {
  // Recorded the bug (a same-name save made a second template; the batch got the old one). Fixed on 19 Nov (B10):
  // saving with an existing exact name edits that template.
  it("after a same-name save, preview_batch copy_template 'Site Visit' uses the NEW text", async () => {
    const { batchId, key } = await batch();
    const { call } = await claude();
    await call("save_copy_template", { name: "Site Visit", primary_texts: ["old text"], headlines: ["old"], link_url: "https://example.com", cta: "LEARN_MORE" });
    await call("save_copy_template", { name: "Site Visit", primary_texts: ["new text"], headlines: ["new"], link_url: "https://example.com", cta: "LEARN_MORE" });
    await call("preview_batch", { batch_id: key, copy_template: "Site Visit" });
    const copy = JSON.parse(db().prepare("SELECT copy FROM batches WHERE id = ?").pluck().get(batchId) as string);
    expect(copy.primaryTexts).toEqual(["new text"]);
    expect(db().prepare("SELECT COUNT(*) FROM copy_templates WHERE name = 'Site Visit'").pluck().get()).toBe(1);
  });
});

describe("finding 10: go-live after the set time has passed", () => {
  // Recorded the bug (ads turned on at once, two days late, without asking). Fixed on 19 Nov (B9): when the time passed
  // more than an hour ago, the turn-on plan is saved as a draft that needs a fresh confirm_plan.
  it("queueGoLive saves a draft turn-on plan when go_live_at passed more than an hour ago", async () => {
    const { batchId } = await batch();
    const past = new Date(Date.now() - 2 * 86_400_000).toISOString();
    db().prepare("UPDATE batches SET status = 'done', go_live = 'at', go_live_at = ? WHERE id = ?").run(past, batchId);
    for (const a of getAds(batchId)) db().prepare("UPDATE ads SET status = 'done', meta_ad_id = ?, meta_adset_id = 'as1' WHERE id = ?").run(`9${a.id}`, a.id);
    const msg = await queueGoLive(batchId);
    expect(msg).toMatch(/NOT turned on/);
    expect(msg).toMatch(/saved as a draft/);
    const plan = db().prepare("SELECT run_at, status FROM plans ORDER BY id DESC LIMIT 1").get() as { run_at: string | null; status: string };
    expect(plan.status).toBe("draft");
  });
});

describe("finding 9: where the 300-step plan text comes from", () => {
  // Recorded the bug (the TOTAL came after 100,000+ characters). Fixed on 19 Nov (T6): the TOTAL, what turns on and the
  // typed amount come first; long runs of steps and tables are cut with the app link.
  it("puts the TOTAL first and keeps a 300-step plan short", async () => {
    await batch();
    const { call } = await claude();
    const ops = Array.from({ length: 300 }, (_, i) => ({ type: "duplicate_adset", adset: "as1", changes: [{ name: `Copy ${i + 1}`, daily_budget: 500 + i }] }));
    const p = await call("plan_changes", { ops });
    const t = p.text;
    const tableAt = t.indexOf("Every ad set in the plan");
    const totalAt = t.indexOf("TOTAL daily budget");
    console.log(`plan_changes ${t.length} chars: TOTAL at ${totalAt}, table at ${tableAt}`);
    expect(totalAt).toBeGreaterThan(-1);
    expect(totalAt).toBeLessThan(1_000);
    expect(tableAt).toBeGreaterThan(totalAt);
    expect(t.length).toBeLessThan(60_000);
  }, 120_000);
});
