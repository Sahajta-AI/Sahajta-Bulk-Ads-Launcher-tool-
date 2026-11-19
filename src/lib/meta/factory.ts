import { AsyncLocalStorage } from "node:async_hooks";
import { config } from "../config";
import { decrypt } from "../crypto";
import { db, type DB } from "../db";
import { isMock } from "../setup";
import { getAccount } from "../store";
import { MetaClient } from "./client";
import { MockMeta } from "./mock";
import { DEFAULT_CAP, Pacer, realClock, type Atomic, type PacerState } from "./pacer";

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

function readRate(accountDbId: number, d: DB = db()): PacerState | undefined {
  const row = d.prepare("SELECT state FROM rate_state WHERE ad_account_id = ?").get(accountDbId) as { state: string } | undefined;
  if (!row) return undefined;
  try {
    return JSON.parse(row.state) as PacerState;
  } catch {
    return undefined;
  }
}

/**
 * A Pacer on the ad account's rate_state row. pacerFor keeps one per process. `conn` is for tests:
 * two connections to one database file act as the web app and the worker (real SQLite locks).
 */
export function loadPacer(accountDbId: number, conn?: DB): Pacer {
  const d = () => conn ?? db();
  const read = () => readRate(accountDbId, d());
  // One pacer step in one IMMEDIATE transaction: no other process can change the row in between.
  const atomic: Atomic = (fn) => d().transaction(fn).immediate();
  const save = (s: PacerState) =>
    d()
      .prepare(
        "INSERT INTO rate_state (ad_account_id, state, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(ad_account_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at",
      )
      .run(accountDbId, JSON.stringify(s));
  const fixed = process.env.META_RATE_CAP_POINTS ? Number(process.env.META_RATE_CAP_POINTS) : undefined;
  // The web app and the worker each have a Pacer object, but the rate_state row is the only state:
  // every step reads it, changes it and writes it back in one transaction (see pacer.ts).
  return new Pacer(realClock, read(), save, fixed, read, atomic);
}

/** Pages and Claude tools wait at most this long for Meta's rate limits in one call, then get a plain answer. */
export const INTERACTIVE_MAX_WAIT_MS = 15_000;
let background = false;

/** The worker and command-line scripts: nobody is waiting on a page, so wait as long as Meta asks. */
export function useBackgroundClients() {
  background = true;
}

/** maxWaitMs for a client made in this process: undefined in the worker and scripts (wait as Meta asks). */
export function defaultMaxWaitMs(): number | undefined {
  return background ? undefined : INTERACTIVE_MAX_WAIT_MS;
}

/**
 * One deadline per web request. A request may make several clients (an ad set's details read the
 * ad set, its ads, the Page, Instagram…); they all share this object, so the request as a whole
 * stops waiting 25 s after its first Meta call (client.ts INTERACTIVE_DEADLINE_MS), not 25 s per client.
 */
const requestDeadline = new AsyncLocalStorage<{ at?: number }>();

/** Run `fn` as one web request (route() in http.ts): Meta clients made inside share one deadline. */
export function withRequestDeadline<T>(fn: () => T): T {
  return requestDeadline.run({}, fn);
}

/**
 * The deadline object for a client made now: the web request's (shared), or undefined (the client
 * gets its own, or none in the worker and scripts).
 */
export function sharedDeadline(): { at?: number } | undefined {
  return background ? undefined : requestDeadline.getStore();
}

/** The cap learned for the ad account (saved in rate_state). The web app uses it for time estimates. */
export function learnedCap(accountDbId: number): number {
  const fixed = process.env.META_RATE_CAP_POINTS ? Number(process.env.META_RATE_CAP_POINTS) : undefined;
  if (fixed) return fixed;
  return readRate(accountDbId)?.capPoints ?? DEFAULT_CAP;
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
  const maxWaitMs = defaultMaxWaitMs();
  const deadline = sharedDeadline();
  if (isMock()) {
    const m = mockMeta();
    return new MetaClient({ token: "mock", accountId: m.accountId, version: config.metaApiVersion, fetch: m.fetch, pacer: pacerFor(acc.id), onWait, maxWaitMs, deadline });
  }
  return new MetaClient({
    token: decrypt(acc.token_enc),
    accountId: acc.meta_account_id,
    version: config.metaApiVersion,
    baseUrl: config.metaGraphUrl,
    appSecret: process.env.META_APP_SECRET || undefined,
    pacer: pacerFor(acc.id),
    onWait,
    maxWaitMs,
    deadline,
  });
}
