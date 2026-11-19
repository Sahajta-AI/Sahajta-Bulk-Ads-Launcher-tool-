import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { sha256 } from "@/lib/crypto";
import { db } from "@/lib/db";
import { MockMeta, FakeClock } from "@/lib/meta/mock";
import { httpApi, registerTools } from "@/mcp/tools";
import { getAds } from "@/lib/store";
import { istLabel, timeMs } from "@/lib/time";
import { LEAD_COPY, fifteenFileFolder, freshDb, setupBatch } from "./helpers";

// Audit of Claude's tools and their wiring (Nov 2026). Each test calls a tool the way Claude does:
// MCP client → tool → httpApi → the REAL app route handler (in-process) → service → fake Meta.
// A failing test names the behaviour the marketer should get.

// next-auth can't load under vitest; the routes only need it for browser sessions (Claude uses API keys).
vi.mock("@/auth", () => ({ auth: async () => null }));

process.env.META_MOCK = "1";
process.env.ALLOWED_EMAILS = "test@example.com";
const BASE = "http://launcher.test";
const KEY = "sal_audit_key_0123456789";
const g = globalThis as unknown as { __mockMeta?: MockMeta };
let mock: MockMeta;
let folder: string;

// ---- In-process router: /api/... → src/app/api/**/route.ts, with Next.js-style params ----
const mods = import.meta.glob("../src/app/api/**/route.ts");
const table = Object.keys(mods)
  .filter((p) => !p.includes("[..."))
  .map((p) => {
    const rel = p.replace("../src/app", "").replace("/route.ts", "");
    const names: string[] = [];
    const re = new RegExp(
      "^" +
        rel
          .split("/")
          .map((seg) => {
            const m = /^\[(\w+)\]$/.exec(seg);
            if (m) {
              names.push(m[1]);
              return "([^/]+)";
            }
            return seg;
          })
          .join("/") +
        "$",
    );
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
  return new Response("<html><body>404</body></html>", { status: 404, headers: { "content-type": "text/html" } });
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
  db().prepare("INSERT INTO api_keys (user_email, label, key_hash, key_hint) VALUES (?, ?, ?, ?)").run("test@example.com", "audit", sha256(KEY), KEY.slice(-4));
});

/**
 * Run with the process time zone set to `zone` (as in the Docker container, UTC), and put it back
 * whatever happens, so no other test runs in it.
 */
async function inZone<T>(zone: string, f: () => Promise<T>): Promise<T> {
  const before = process.env.TZ;
  process.env.TZ = zone;
  try {
    return await f();
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
}

async function claude() {
  const server = new McpServer({ name: "audit", version: "0" });
  registerTools(server, httpApi(BASE, KEY));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "audit", version: "0" });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { text: r.content.map((c) => c.text).join("\n"), isError: !!r.isError };
  };
  return { call, client };
}

async function batch(opts: Parameters<typeof setupBatch>[1] = {}) {
  const r = await setupBatch(folder, opts);
  db().prepare("UPDATE ad_accounts SET is_default = 1 WHERE id = ?").run(r.accountId);
  const key = (db().prepare("SELECT key FROM batches WHERE id = ?").get(r.batchId) as { key: string }).key;
  return { ...r, key };
}

const planKey = (text: string) => /^Plan (\w+):/m.exec(text)?.[1] ?? "";
const future = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

// -------------------------------------------------------------------------------------------

describe("update_plan keeps what Claude didn't resend", () => {
  it("changing the steps of a scheduled plan keeps its scheduled time", async () => {
    await batch();
    const { call } = await claude();
    const runAt = `${future(3)}T09:00:00+05:30`;
    const p = await call("plan_changes", { run_at: runAt, ops: [{ type: "edit_adset", adset: "as1", name: "Renamed 1" }] });
    expect(p.isError).toBe(false);
    expect(p.text).toMatch(/Runs at/);
    const key = planKey(p.text);
    // The marketer: "change the name in step 1". Claude resends the steps, not the time.
    const u = await call("update_plan", { plan_id: key, ops: [{ type: "edit_adset", adset: "as1", name: "Renamed 2" }] });
    expect(u.isError).toBe(false);
    expect(db().prepare("SELECT run_at FROM plans WHERE key = ?").pluck().get(key)).toBe(runAt);
    expect(u.text).toMatch(/Runs at/);
  });
});

describe("set_ad_copy changes only what it is given", () => {
  it("a row with only an angle keeps the ad's own primary texts", async () => {
    const { batchId, key } = await batch();
    const { call } = await claude();
    expect((await call("set_ad_copy", { batch_id: key, rows: [{ ad: 1, primary_texts: ["Only for ad 1"] }] })).isError).toBe(false);
    expect((await call("set_ad_copy", { batch_id: key, rows: [{ ad: 1, angle: "pain-point" }] })).isError).toBe(false);
    const ad = getAds(batchId).find((a) => a.position === 1)!;
    expect(ad.angle).toBe("pain-point");
    expect(JSON.parse(ad.copy_override ?? "{}").primaryTexts).toEqual(["Only for ad 1"]);
  });

  it("a second row for the same ad with only headlines keeps the first row's primary texts", async () => {
    const { batchId, key } = await batch();
    const { call } = await claude();
    await call("set_ad_copy", { batch_id: key, rows: [{ ad: 2, primary_texts: ["Text for ad 2"] }] });
    await call("set_ad_copy", { batch_id: key, rows: [{ ad: 2, headlines: ["Headline for ad 2"] }] });
    const o = JSON.parse(getAds(batchId).find((a) => a.position === 2)!.copy_override ?? "{}");
    expect(o.headlines).toEqual(["Headline for ad 2"]);
    expect(o.primaryTexts).toEqual(["Text for ad 2"]);
  });
});

describe("times without a time zone (the server runs in UTC)", () => {
  // Rewritten in round 2: the old tests passed whatever happened (refused or not, any time shown) and
  // changed TZ for the rest of the file. These check the exact moment saved and the exact words shown.
  it("go_live_at '09:00' without a zone is saved as 9 am IST and shown as 09:00 am IST, in UTC and in New York", async () => {
    for (const zone of ["UTC", "America/New_York"]) {
      await inZone(zone, async () => {
        freshDb();
        db().prepare("INSERT INTO api_keys (user_email, label, key_hash, key_hint) VALUES (?, ?, ?, ?)").run("test@example.com", "audit", sha256(KEY), KEY.slice(-4));
        const { key, batchId } = await batch();
        const { call } = await claude();
        const day = future(5);
        const r = await call("preview_batch", { batch_id: key, go_live: "at", go_live_at: `${day}T09:00` });
        expect(r.isError, r.text).toBe(false);
        const saved = db().prepare("SELECT go_live_at FROM batches WHERE id = ?").pluck().get(batchId) as string;
        expect(timeMs(saved), zone).toBe(Date.parse(`${day}T09:00:00+05:30`));
        const label = istLabel(`${day}T09:00:00+05:30`);
        expect(label).toMatch(/09:00 am IST$/);
        expect(r.text).toContain(`TURNED ON at ${label}`);
        expect(r.text).not.toMatch(/0?2:30 pm IST|0?3:30 am IST/);
      });
    }
    expect(process.env.TZ).not.toBe("America/New_York");
  });

  it("plan_changes run_at '09:00' without a zone is saved as 9 am IST and shown as 09:00 am IST, in UTC", async () => {
    await inZone("UTC", async () => {
      await batch();
      const { call } = await claude();
      const day = future(5);
      const r = await call("plan_changes", { run_at: `${day}T09:00`, ops: [{ type: "edit_adset", adset: "as1", name: "x" }] });
      expect(r.isError, r.text).toBe(false);
      const saved = db().prepare("SELECT run_at FROM plans WHERE key = ?").pluck().get(planKey(r.text)) as string;
      expect(timeMs(saved)).toBe(Date.parse(`${day}T09:00:00+05:30`));
      expect(r.text).toContain(istLabel(`${day}T09:00:00+05:30`));
      expect(r.text).not.toMatch(/0?2:30 pm IST|0?3:30 am IST/);
    });
  });
});

describe("read tools never turn a failed Meta read into 'nothing there'", () => {
  // Rewritten in round 2: list_ads reads the ad set's ads in one list read ("as1/ads"), so the fault is put
  // on that read (the old faults on each ad's own read were never used).
  it("list_ads says Meta couldn't be read instead of 'No ads in ad set …'", async () => {
    await batch();
    for (const id of ["ad901", "ad902"]) mock.objects.set(id, { id, name: `Ad ${id}`, adset_id: "as1", status: "PAUSED", effective_status: "PAUSED", creative: { id: `cr_${id}` }, _type: "ad" });
    const { call } = await claude();
    expect((await call("list_ads", { adset: "as1" })).text).toMatch(/Ad ad901/); // control: both ads are listed
    mock.inject({ match: (m, p) => m === "GET" && p === "as1/ads", kind: "error", error: { message: "Unsupported get request.", code: 100 } });
    const r = await call("list_ads", { adset: "as1" });
    expect((mock as unknown as { faults: unknown[] }).faults).toHaveLength(0); // the fault was used
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^Reading the ads of this ad set/);
    expect(r.text).not.toMatch(/No ads in/);
  });

  // Rewritten in round 2: the first preview_batch keeps the summary for a minute, so the old fault was never
  // reached and its `if` never ran. Here the kept summary is dropped first, and the check always runs.
  it("preview_batch says the pre-launch summary is missing when Meta couldn't give it, instead of 'Show the summary'", async () => {
    const { key } = await batch();
    const { call } = await claude();
    expect((await call("preview_batch", { batch_id: key })).text).toMatch(/PRE-LAUNCH SUMMARY/); // control
    db().prepare("DELETE FROM cache WHERE key LIKE 'bsum:%'").run();
    mock.inject({ match: (m, p) => m === "GET" && p === "c1", kind: "error", error: { message: "Unsupported get request.", code: 100 } });
    const r = await call("preview_batch", { batch_id: key });
    expect((mock as unknown as { faults: unknown[] }).faults).toHaveLength(0); // the summary met the fault
    expect(r.isError).toBe(false);
    expect(r.text).not.toContain("PRE-LAUNCH SUMMARY");
    expect(r.text).toMatch(/The pre-launch summary couldn't be loaded: .*Don't launch until preview_batch shows it\./);
    expect(r.text).not.toMatch(/Show the summary|launch_batch with confirm/);
  });

  it("delivery_status for a plan that made ad set as1 does not answer 'Nothing created yet.'", async () => {
    await batch();
    const { call } = await claude();
    const p = await call("plan_changes", { ops: [{ type: "edit_adset", adset: "as1", name: "x" }] });
    const key = planKey(p.text);
    db().prepare("UPDATE plans SET status = 'done', progress = ? WHERE key = ?").run(JSON.stringify([{ status: "done", ids: ["as1"], message: "" }]), key);
    const r = await call("delivery_status", { plan_id: key });
    expect(r.text).not.toBe("Nothing created yet.");
  });
});

describe("get_results never answers a different date range than asked", () => {
  it("since without until is refused or used, not silently replaced by the last 7 days", async () => {
    await batch();
    const { call } = await claude();
    const r = await call("get_results", { level: "campaign", since: "2026-11-01" });
    if (!r.isError) expect(r.text).not.toMatch(/last 7d/);
  });

  it("an unknown date_preset is refused, not silently replaced by the last 7 days", async () => {
    await batch();
    const { call } = await claude();
    const r = await call("get_results", { level: "campaign", date_preset: "this_week_mon_today" });
    if (!r.isError) expect(r.text).not.toMatch(/last 7d/);
  });
});

describe("names that match several ad sets", () => {
  it("preview_batch with an ad set name that fits several asks which one, instead of picking the first", async () => {
    const { key } = await batch();
    const { call } = await claude();
    // "ad set" is in "November test ad set", "Dynamic creative ad set" and "CBO ad set".
    const r = await call("preview_batch", { batch_id: key, ad_set: "ad set" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/November test ad set/);
    expect(r.text).toMatch(/CBO ad set/);
  });
});

describe("cancel_batch stops the whole launch", () => {
  it("cancelling a launch that put the same ads into two ad sets also stops (or names) the second ad set's batch", async () => {
    const { key, batchId } = await batch();
    // as1 and as4 collect leads with an Instant form: since 19 Nov (B13) the launch needs a lead form in the copy.
    db().prepare("UPDATE batches SET copy = ? WHERE id = ?").run(JSON.stringify(LEAD_COPY), batchId);
    const { call } = await claude();
    expect((await call("preview_batch", { batch_id: key, ad_set: ["as1", "as4"] })).isError).toBe(false);
    const l = await call("launch_batch", { batch_id: key, confirm: true, accept_warnings: true });
    expect(l.isError).toBe(false);
    const sib = db().prepare("SELECT key, status FROM batches WHERE key != ? AND adset_id = 'as4'").get(key) as { key: string; status: string };
    expect(sib.status).toBe("queued");
    const c = await call("cancel_batch", { batch_id: key });
    expect(c.isError).toBe(false);
    const after = db().prepare("SELECT status FROM batches WHERE key = ?").pluck().get(sib.key);
    if (after === "queued") expect(c.text).toContain(sib.key);
    // Since 19 Nov (B3/T2) the second ad set's batch is stopped too, and the answer names it.
    expect(after).not.toBe("queued");
    expect(c.text).toContain(sib.key);
  });
});

describe("settings preset by name", () => {
  it("settings_preset 'Sahajta' picks the preset called exactly 'Sahajta', not an older 'Sahajta + IG reels'", async () => {
    const { batchId, key } = await batch();
    const { call } = await claude();
    expect((await call("save_settings_preset", { name: "Sahajta + IG reels", page_id: "p1", instagram_id: "ig1", switch_on: ["image_touchups"] })).isError).toBe(false);
    expect((await call("save_settings_preset", { name: "Sahajta", page_id: "p1", instagram_id: "none" })).isError).toBe(false);
    const r = await call("preview_batch", { batch_id: key, settings_preset: "Sahajta" });
    expect(r.text).toMatch(/Settings preset: Sahajta\./);
    expect(JSON.parse(db().prepare("SELECT preset FROM batches WHERE id = ?").pluck().get(batchId) as string).name).toBe("Sahajta");
  });
});

describe("times shown to the marketer", () => {
  it("plan_status's list of plans shows IST times, not the database's UTC clock without a zone", async () => {
    await batch();
    const { call } = await claude();
    await call("plan_changes", { ops: [{ type: "edit_adset", adset: "as1", name: "x" }] });
    const r = await call("plan_status", {});
    expect(r.text).not.toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/m);
  });
});

describe("inputs Claude naturally sends", () => {
  it("expected_daily_total as a string ('15000') is accepted", async () => {
    await batch();
    const { call } = await claude();
    const r = await call("plan_changes", { expected_daily_total: "15000", ops: [{ type: "edit_adset", adset: "as1", name: "x" }] });
    expect(r.text).not.toMatch(/Input validation error/);
  });

  it("regroup_files with to: '3' (a string) is accepted", async () => {
    const { key } = await batch();
    const { call } = await claude();
    const r = await call("regroup_files", { batch_id: key, file: "static-price_1x1.jpg", to: "3" });
    expect(r.text).not.toMatch(/Input validation error/);
  });
});

describe("tool annotations match what the tool does", () => {
  // Rewritten in round 2: ad_previews is not read-only (it uploads the image), so the old `if (ro)` never ran.
  // Now: it says it may change things, and the only thing it writes in Meta is the image in the library.
  it("ad_previews is marked as not read-only, and its only Meta write is the image upload", async () => {
    const { key } = await batch();
    const { call, client } = await claude();
    const tools = await client.listTools();
    const t = tools.tools.find((x) => x.name === "ad_previews")!;
    expect(t.annotations?.readOnlyHint).toBe(false);
    expect(t.description).toMatch(/uploaded to the ad account's image library/);
    const ad = getAds(Number(db().prepare("SELECT id FROM batches WHERE key = ?").pluck().get(key))).find((a) => a.creative_name.startsWith("static-price"))!;
    const before = mock.calls.length;
    const r = await call("ad_previews", { batch_id: key, ad: ad.position });
    expect(r.isError, r.text).toBe(false);
    const writes = mock.calls.slice(before).filter((c) => c.method !== "GET").map((w) => w.path);
    expect(writes.length).toBeGreaterThan(0);
    for (const w of writes) expect(w).toMatch(/\/adimages$/);
  });
});

describe("templates edited by name", () => {
  it("save_copy_template with name = an existing template's name edits it instead of making a second one", async () => {
    await batch();
    const { call } = await claude();
    await call("save_copy_template", { name: "Site Visit", primary_texts: ["old"], headlines: ["old"], link_url: "https://example.com", cta: "LEARN_MORE" });
    await call("save_copy_template", { name: "Site Visit", headlines: ["new"] });
    expect(db().prepare("SELECT COUNT(*) FROM copy_templates WHERE name = 'Site Visit'").pluck().get()).toBe(1);
  });
});

describe("a failed preview_batch leaves no orphan draft", () => {
  it("POST /api/batches with an unknown ad set makes no batch (Claude never learns its code)", async () => {
    await batch();
    const before = db().prepare("SELECT COUNT(*) FROM batches").pluck().get();
    await expect(httpApi(BASE, KEY).call("POST", "/api/batches", { adsetId: "no such ad set" })).rejects.toThrow(/Couldn't find an ad set/);
    expect(db().prepare("SELECT COUNT(*) FROM batches").pluck().get()).toBe(before);
  });
});

describe("errors reach Claude as plain sentences", () => {
  it("a revoked key and an HTML 502 page from Caddy reach Claude as plain sentences (passes today)", async () => {
    await batch();
    db().prepare("UPDATE api_keys SET revoked_at = datetime('now')").run();
    const { call } = await claude();
    const r1 = await call("list_campaigns", {});
    expect(r1.isError).toBe(true);
    expect(r1.text).toMatch(/API key is not valid/);
    vi.stubGlobal("fetch", () => Promise.resolve(new Response("<html><body><h1>502 Bad Gateway</h1></body></html>", { status: 502, headers: { "content-type": "text/html" } })));
    try {
      const r2 = await call("batch_status", { batch_id: "abcde" });
      expect(r2.isError).toBe(true);
      expect(r2.text).not.toMatch(/<html|\[object Object\]/);
    } finally {
      vi.stubGlobal("fetch", (url: string | URL | Request, init?: RequestInit) => {
        const s = url instanceof Request ? url.url : String(url);
        if (s.startsWith(BASE)) return dispatch(new Request(s, init));
        if (s.startsWith("https://example.com")) return Promise.resolve(new Response("ok"));
        return realFetch(url, init);
      });
    }
  });
});

describe("output size (Claude Desktop context)", () => {
  it("plan_status of a running 300-step plan stays under 60,000 characters", async () => {
    await batch();
    const { call } = await claude();
    const ops = Array.from({ length: 300 }, (_, i) => ({ type: "duplicate_adset", adset: "as1", changes: [{ name: `Copy ${i + 1}`, daily_budget: 500 + i }] }));
    const p = await call("plan_changes", { ops });
    expect(p.isError).toBe(false);
    const key = planKey(p.text);
    db().prepare("UPDATE plans SET status = 'running' WHERE key = ?").run(key);
    const s = await call("plan_status", { plan_id: key });
    console.log(`plan_changes: ${p.text.length} chars; plan_status (running): ${s.text.length} chars`);
    expect(s.text.length).toBeLessThan(60_000);
  }, 120_000);
});
