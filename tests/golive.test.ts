import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { runBatch } from "@/lib/engine/launcher";
import { queueGoLive } from "@/lib/manage/golive";
import { runPlan } from "@/lib/manage/plan";
import { clientFor, mockMeta } from "@/lib/meta/factory";
import { localFiles } from "@/lib/sources/local";
import { launchBatch, updateSettings, cancelBatch } from "@/lib/service";
import { getAds, getBatch, updateBatch } from "@/lib/store";
import { FakeClock, MockMeta } from "@/lib/meta/mock";
import { COPY, fifteenFileFolder, freshDb, setupBatch } from "./helpers";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The whole "Launch now" path through the service layer, on practice mode's fake Meta.

process.env.META_MOCK = "1";
const g = globalThis as unknown as { __mockMeta?: unknown };
let folder: string;
beforeAll(async () => {
  folder = await fifteenFileFolder();
  // Landing-page checks: answer locally instead of going to the internet.
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", (url: string | URL | Request, init?: RequestInit) => (String(url).startsWith("https://example.com") ? Promise.resolve(new Response("ok")) : real(url, init)));
}, 120_000);
let clock: FakeClock;
beforeEach(() => {
  freshDb();
  // Practice mode's fake Meta, on a clock the test moves (videos "process" instantly).
  clock = new FakeClock();
  g.__mockMeta = new MockMeta({ clock, capPoints: 9000, richAccount: true, allowActive: true, videoProcessingMs: 1000 });
});

async function batchWithBudget() {
  const { accountId, batchId } = await setupBatch(folder);
  db().prepare("UPDATE ad_accounts SET is_default = 1 WHERE id = ?").run(accountId);
  // as1 and as4 in the practice account collect leads with an Instant form: Meta refuses ads there
  // without a lead form, and since 19 Nov the launch is refused before anything is made.
  updateBatch(batchId, { copy: JSON.stringify({ ...COPY, leadFormId: "555000111" }) });
  const key = getBatch(batchId)!.key;
  return { accountId, batchId, key };
}

describe("launch now / scheduled, with the budget guardrail", () => {
  it("needs the total daily budget typed back, launches into two ad sets, then turns everything on", async () => {
    const { batchId, key, accountId } = await batchWithBudget();
    mockMeta(); // practice account: as1 has ₹500 a day, as4 ₹800 a day, both in c1
    await updateSettings(key, { goLive: "now", extraAdsetIds: ["as4"] });
    await expect(launchBatch(key, { confirm: true, acceptWarnings: true })).rejects.toThrow(/₹1,300/);
    await expect(launchBatch(key, { confirm: true, acceptWarnings: true, spendConfirmation: "₹500" })).rejects.toThrow(/total daily budget/);
    const v = await launchBatch(key, { confirm: true, acceptWarnings: true, spendConfirmation: "1,300" });
    expect(v.status).toBe("queued");
    expect(v.together).toHaveLength(1);
    const sib = getBatch(db().prepare("SELECT id FROM batches WHERE key = ?").pluck().get(v.together[0].key) as number)!;
    expect(sib.adset_id).toBe("as4");
    expect(getAds(sib.id)).toHaveLength(9);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "golive-"));
    const deps = { client: clientFor(accountId), files: localFiles, clock, accountDbId: accountId, tmpDir };
    for (const id of [batchId, sib.id]) {
      const r = await runBatch(id, deps);
      if (r.failed) console.log(getAds(id).filter((a) => a.status === "failed").map((a) => a.error));
      expect(r).toEqual({ done: 9, failed: 0 });
      // The ad sets of one launch are turned on together, by one plan: the first waits for the second.
      expect(await queueGoLive(id)).toMatch(id === batchId ? /waits for the other ad sets of this launch/ : /Turning the ads on now/);
    }
    expect(await queueGoLive(batchId)).toBeNull(); // only once, for both
    expect(await queueGoLive(sib.id)).toBeNull();
    const m = mockMeta();
    expect(m.of("ad").every((a) => a.status === "PAUSED")).toBe(true); // created paused
    const plans = db().prepare("SELECT id, status, confirmed_by FROM plans").all() as { id: number; status: string; confirmed_by: string }[];
    expect(plans).toHaveLength(1);
    expect(plans.every((p) => p.status === "queued" && p.confirmed_by.includes("when launching batch"))).toBe(true);
    for (const p of plans) await runPlan(p.id, { client: clientFor(accountId), clock });
    expect(m.of("ad")).toHaveLength(18);
    expect(m.of("ad").every((a) => a.status === "ACTIVE")).toBe(true);
    expect(m.objects.get("as1")!.status).toBe("ACTIVE");
    expect(m.objects.get("as4")!.status).toBe("ACTIVE");
    expect(m.objects.get("c1")!.status).toBe("ACTIVE");
  }, 120_000);

  it("a paused launch needs no budget confirmation; a schedule in the past is refused", async () => {
    const { key } = await batchWithBudget();
    mockMeta();
    await updateSettings(key, { goLive: "at", goLiveAt: "2020-01-01T09:00:00+05:30" });
    await expect(launchBatch(key, { confirm: true, acceptWarnings: true, spendConfirmation: "₹500" })).rejects.toThrow(/time in the future/);
    await updateSettings(key, { goLive: "paused" });
    expect((await launchBatch(key, { confirm: true, acceptWarnings: true })).status).toBe("queued");
  }, 60_000);

  it("a go-live batch with a failed ad is not turned on", async () => {
    const { batchId } = await batchWithBudget();
    updateBatch(batchId, { go_live: "now", status: "partial" });
    db().prepare("UPDATE ads SET status = 'failed' WHERE batch_id = ? AND position = 1").run(batchId);
    db().prepare("UPDATE ads SET status = 'done' WHERE batch_id = ? AND position > 1").run(batchId);
    expect(await queueGoLive(batchId)).toMatch(/waits for 1 failed/);
    expect(db().prepare("SELECT COUNT(*) FROM plans").pluck().get()).toBe(0);
  });

  it("cancel: a queued launch stops before it starts and keeps nothing half-made", async () => {
    const { key, batchId } = await batchWithBudget();
    mockMeta();
    await launchBatch(key, { confirm: true, acceptWarnings: true });
    expect(cancelBatch(key).cancelled.map((c) => [c.key, c.result])).toEqual([[key, "cancelled"]]);
    expect(getBatch(batchId)!.status).toBe("failed");
    expect(getAds(batchId).every((a) => a.status === "failed" && /Cancelled/.test(a.error ?? ""))).toBe(true);
    expect(db().prepare("SELECT COUNT(*) FROM jobs WHERE status = 'queued'").pluck().get()).toBe(0);
  }, 60_000);
});
