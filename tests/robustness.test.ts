import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildPreview } from "@/lib/engine/preview";
import { isTransientError, resetFailed, runBatch } from "@/lib/engine/launcher";
import { db } from "@/lib/db";
import { getAds, getBatch } from "@/lib/store";
import { fifteenFileFolder, freshDb, mockDeps, setupBatch } from "./helpers";

// What a real first launch can throw at the launcher, beyond the happy path.

let folder: string;
beforeAll(async () => {
  folder = await fifteenFileFolder();
});
beforeEach(() => {
  freshDb();
});

describe("robustness", () => {
  it("Meta refusing the fast video upload at 'finish' falls back to the chunked upload; every ad is still made", async () => {
    const { accountId, batchId } = await setupBatch(folder);
    const { mock, deps } = mockDeps(accountId);
    let n = 0;
    mock.inject({
      match: (m, p) => m === "POST" && p.endsWith("/video_ads") && ++n === 2, // the first video's "finish"
      kind: "error",
      error: { message: "(#100) This upload method is not supported for this user", code: 100 },
    });
    const result = await runBatch(batchId, deps);
    expect(result).toEqual({ done: 9, failed: 0 });
    expect(mock.calls.some((c) => c.path.endsWith("/advideos"))).toBe(true);
    expect(mock.of("ad")).toHaveLength(9);
  });

  it("an expired Meta connection stops the run at once, with the reconnect message on every remaining ad", async () => {
    const { accountId, batchId } = await setupBatch(folder);
    const { mock, deps } = mockDeps(accountId);
    for (let i = 0; i < 20; i++) {
      mock.inject({ match: (m, p) => m === "POST" && p.endsWith("/adcreatives"), kind: "error", error: { message: "Error validating access token: Session has expired", type: "OAuthException", code: 190 } });
    }
    const result = await runBatch(batchId, deps);
    expect(result.done).toBe(0);
    expect(result.failed).toBe(9);
    expect(mock.calls.filter((c) => c.path.endsWith("/adcreatives") && c.method === "POST")).toHaveLength(1); // stopped after the first
    expect(getAds(batchId).every((a) => /Reconnect Meta/.test(a.error ?? ""))).toBe(true);
    expect(getBatch(batchId)!.status).toBe("failed");
  });

  it("retry also picks up ads that a stopped run left half-way", async () => {
    const { batchId } = await setupBatch(folder);
    db().prepare("UPDATE ads SET status = CASE position WHEN 1 THEN 'done' WHEN 2 THEN 'working' WHEN 3 THEN 'waiting' ELSE 'failed' END WHERE batch_id = ?").run(batchId);
    expect(resetFailed(batchId)).toBe(8);
    expect(getAds(batchId).filter((a) => a.status === "done")).toHaveLength(1);
  });

  it("refuses to put more than 50 ads in an existing ad set, counting the ads already there", async () => {
    const { batchId } = await setupBatch(folder); // 9 ads
    const p1 = buildPreview(batchId, { adset: { id: "as1", name: "Test", ad_count: 45 } }, 60);
    expect(p1.batchChecks.find((c) => c.code === "adset_full")?.message).toMatch(/already has 45, and this batch adds 9/);
    const p2 = buildPreview(batchId, { adset: { id: "as1", name: "Test", ad_count: 41 } }, 60);
    expect(p2.batchChecks.find((c) => c.code === "adset_full")).toBeUndefined();
  });

  it("network and Google hiccups count as 'try again', real mistakes don't", () => {
    expect(isTransientError(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }))).toBe(true);
    expect(isTransientError(Object.assign(new Error("Backend Error"), { response: { status: 503 } }))).toBe(true);
    expect(isTransientError(new TypeError("fetch failed"))).toBe(true);
    expect(isTransientError(Object.assign(new Error("File not found"), { response: { status: 404 } }))).toBe(false);
  });
});
