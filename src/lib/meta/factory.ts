import { config } from "../config";
import { decrypt } from "../crypto";
import { db } from "../db";
import { isMock } from "../setup";
import { getAccount } from "../store";
import { MetaClient } from "./client";
import { MockMeta } from "./mock";
import { Pacer, realClock, type PacerState } from "./pacer";

// Builds the Meta client for an ad account: decrypted token, persisted pacing state.
// With META_MOCK=1 the app runs against the fake Graph API (for demos and local work).

const g = globalThis as unknown as { __mockMeta?: MockMeta };

export function mockMeta(): MockMeta {
  g.__mockMeta ??= new MockMeta({
    clock: realClock,
    capPoints: Number(process.env.META_MOCK_CAP ?? 9000),
    videoProcessingMs: 8000,
    blockMs: 60_000,
    stateFile: process.env.META_MOCK_STATE || undefined,
    rejectPacMultiText: process.env.META_MOCK_REJECT_PAC_TEXTS === "1",
    // Practice mode: budgets and a campaign-budget campaign to try plans on, and "turn on" works.
    richAccount: true,
    allowActive: true,
  });
  return g.__mockMeta;
}

function loadPacer(accountDbId: number): Pacer {
  const row = db().prepare("SELECT state FROM rate_state WHERE ad_account_id = ?").get(accountDbId) as { state: string } | undefined;
  const initial = row ? (JSON.parse(row.state) as PacerState) : undefined;
  const save = db().prepare(
    "INSERT INTO rate_state (ad_account_id, state, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(ad_account_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at",
  );
  const fixed = process.env.META_RATE_CAP_POINTS ? Number(process.env.META_RATE_CAP_POINTS) : undefined;
  return new Pacer(realClock, initial, (s) => save.run(accountDbId, JSON.stringify(s)), fixed);
}

/** The cap the worker has learned (saved in rate_state). The web app uses it for time estimates. */
export function learnedCap(accountDbId: number): number {
  const fixed = process.env.META_RATE_CAP_POINTS ? Number(process.env.META_RATE_CAP_POINTS) : undefined;
  if (fixed) return fixed;
  const row = db().prepare("SELECT state FROM rate_state WHERE ad_account_id = ?").get(accountDbId) as { state: string } | undefined;
  return row ? (JSON.parse(row.state) as PacerState).capPoints : 60;
}

const pacers = new Map<number, Pacer>();

export function pacerFor(accountDbId: number): Pacer {
  let p = pacers.get(accountDbId);
  if (!p) {
    p = loadPacer(accountDbId);
    pacers.set(accountDbId, p);
  }
  return p;
}

export class NotConnectedError extends Error {}

export function clientFor(accountDbId?: number, onWait?: (ms: number, reason: string) => void): MetaClient {
  const acc = getAccount(accountDbId);
  if (!acc || !acc.token_enc) throw new NotConnectedError("Meta is not connected yet. Open Settings → Meta connection and click Connect Meta.");
  if (isMock()) {
    const m = mockMeta();
    return new MetaClient({ token: "mock", accountId: m.accountId, version: config.metaApiVersion, fetch: m.fetch, pacer: pacerFor(acc.id), onWait });
  }
  return new MetaClient({
    token: decrypt(acc.token_enc),
    accountId: acc.meta_account_id,
    version: config.metaApiVersion,
    baseUrl: config.metaGraphUrl,
    appSecret: process.env.META_APP_SECRET || undefined,
    pacer: pacerFor(acc.id),
    onWait,
  });
}
