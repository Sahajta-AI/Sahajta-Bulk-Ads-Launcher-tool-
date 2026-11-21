import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import sharp from "sharp";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, setDb } from "@/lib/db";
import { runBatch, type LaunchDeps } from "@/lib/engine/launcher";
import { siblings } from "@/lib/manage/golive";
import { MetaClient } from "@/lib/meta/client";
import { FakeClock, MockMeta } from "@/lib/meta/mock";
import { Pacer } from "@/lib/meta/pacer";
import { localFiles } from "@/lib/sources/local";
import { launchBatch, updateSettings } from "@/lib/service";
import { getAds, getBatch, updateBatch } from "@/lib/store";
import type { BatchRow } from "@/lib/types";
import { LEAD_COPY, freshDb, setupBatch } from "./helpers";

// Independent review of 21 Nov 2026: ads carry no launch key in their name, so after a database restore
// (a backup taken before the launch ran) the launcher must still find every ad it made, even when Meta's
// idempotency key no longer matches (days later, or not rolled out). deploy/restore.sh marks the unfinished ads.
process.env.META_MOCK = "1";
const g = globalThis as unknown as { __mockMeta?: MockMeta };
let three: string;
let mock: MockMeta;
let clock: FakeClock;

beforeAll(async () => {
  three = path.join(os.tmpdir(), "review21-three");
  fs.mkdirSync(three, { recursive: true });
  for (const [i, c] of ["#c33", "#3c3", "#33c"].entries()) {
    const f = path.join(three, `img-${i + 1}_1x1.jpg`);
    if (!fs.existsSync(f)) await sharp({ create: { width: 1080, height: 1080, channels: 3, background: c } }).jpeg().toFile(f);
  }
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", (url: string | URL | Request, init?: RequestInit) => (String(url).startsWith("https://example.com") ? Promise.resolve(new Response("ok")) : real(url, init)));
}, 120_000);

beforeEach(() => {
  freshDb();
  clock = new FakeClock();
  mock = new MockMeta({ clock, capPoints: 9000, richAccount: true, allowActive: true, videoProcessingMs: 60_000 });
  g.__mockMeta = mock;
});

function deps(accountDbId: number): LaunchDeps {
  const pacer = new Pacer(clock, undefined, undefined, 60);
  const client = new MetaClient({ token: "mock-token", accountId: mock.accountId, version: "v26.0", fetch: mock.fetch, pacer, clock });
  return { client, files: localFiles, clock, accountDbId, tmpDir: fs.mkdtempSync(path.join(os.tmpdir(), "review21-")) };
}

function restoreFrom(backup: Buffer) {
  // Days later: Meta's idempotency keys no longer match (or Meta has not rolled them out to this account).
  (mock as unknown as { idem: Map<string, unknown> }).idem.clear();
  setDb(new Database(backup));
  // What deploy/restore.sh runs on the backup before it goes back in place.
  const sql = fs.readFileSync(path.join(__dirname, "../deploy/restore.sh"), "utf8").match(/sqlite3 "\$TMP\/launcher.db" "(UPDATE ads SET attempts[^"]+)"/)![1].replace(/\\\$/g, "$");
  db().exec(sql);
}

describe("restore", () => {
  it("sibling ad set (shared creative) after a restore: no second ad", async () => {
    mock.objects.set("as5", { ...mock.objects.get("as4")!, id: "as5", name: "Ad set 5" });
    const { accountId, batchId } = await setupBatch(three, { adsetId: "as1" });
    db().prepare("UPDATE ad_accounts SET is_default = 1 WHERE id = ?").run(accountId);
    updateBatch(batchId, { copy: JSON.stringify(LEAD_COPY) });
    const key = getBatch(batchId)!.key;
    await updateSettings(key, { extraAdsetIds: ["as4"] });
    await launchBatch(key, { confirm: true, acceptWarnings: true });
    let group: BatchRow[] = siblings(getBatch(batchId)!);
    const backup = db().serialize();
    const d = deps(accountId);
    for (const b of group) expect(await runBatch(b.id, d)).toEqual({ done: 3, failed: 0 });
    expect(mock.of("ad")).toHaveLength(6);
    restoreFrom(backup);
    group = group.map((b) => getBatch(b.id)!);
    for (const b of group) await runBatch(b.id, d);
    expect(mock.of("ad")).toHaveLength(6);
  });

  it("new_shared batch after a restore: no second ad", async () => {
    const { accountId, batchId } = await setupBatch(three, { adsetId: "as1" });
    db().prepare("UPDATE ad_accounts SET is_default = 1 WHERE id = ?").run(accountId);
    updateBatch(batchId, { copy: JSON.stringify(LEAD_COPY), adset_mode: "new_shared" });
    const key = getBatch(batchId)!.key;
    await launchBatch(key, { confirm: true, acceptWarnings: true });
    const backup = db().serialize();
    const d = deps(accountId);
    expect(await runBatch(batchId, d)).toEqual({ done: 3, failed: 0 });
    expect(mock.of("ad")).toHaveLength(3);
    restoreFrom(backup);
    await runBatch(batchId, d);
    expect(mock.of("ad")).toHaveLength(3);
  });
});
