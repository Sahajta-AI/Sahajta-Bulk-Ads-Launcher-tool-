import crypto from "node:crypto";
import { MetaError, OutOfTimeError, RateLimitedError, isOneEditAtATime, isThrottleBody, isTooMuchData, isTooMuchDataBody, type GraphErrorBody } from "./errors";
import { Pacer, READ_COST, WRITE_COST, WaitTooLong, parseUsage, realClock, type Clock } from "./pacer";

/** A page or a Claude tool gets its answer within about this long: pacing waits and read retries stop here. */
export const INTERACTIVE_DEADLINE_MS = 25_000;
/** How long one request to Meta may take when someone is waiting for it. */
export const INTERACTIVE_TIMEOUT_MS = 30_000;
/** Background work (launches, plans): one request may take this long. */
export const BACKGROUND_TIMEOUT_MS = 120_000;
/** Meta allows one change to the same item every 30 seconds (613/4841018). */
const ONE_EDIT_WAIT_MS = 30_000;
const ONE_EDIT_TRIES = 4;
/** The smallest page getAll asks for when Meta says a page is too much data. */
const MIN_PAGE = 5;

// Thin Graph API client. Every call goes through the account's Pacer.
// The token travels only in the Authorization header, never in URLs or logs.

export type Params = Record<string, unknown>;

export interface MetaClientOptions {
  token: string;
  accountId: string; // "act_123"
  version: string; // "v26.0"
  baseUrl?: string;
  appSecret?: string;
  fetch?: typeof fetch;
  pacer?: Pacer;
  clock?: Clock;
  /** Called when pacing makes us wait, so the UI can say why. */
  onWait?: (ms: number, reason: string) => void;
  timeoutMs?: number;
  /**
   * Someone is waiting for the answer (a page or a Claude tool): one call never waits longer than
   * this for Meta's rate limits, and a rate refusal is never retried; say so with the time instead.
   * Background work (launches, plans) leaves it out and waits as long as Meta asks.
   */
  maxWaitMs?: number;
  /** With maxWaitMs: all waits and read retries end this long after the first call (see `deadline`). */
  deadlineMs?: number;
  /**
   * With maxWaitMs: the deadline, set at the first call. Clients that get the same object share it:
   * copies made with withToken, and every client made while answering one web request (factory.ts).
   */
  deadline?: { at?: number };
}

function encodeParams(params: Params): URLSearchParams {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    q.set(k, typeof v === "string" ? v : JSON.stringify(v));
  }
  return q;
}

/** Values of `status` that remove an object from Ads Manager. The launcher never sends them. */
const DELETING_STATUSES = new Set(["DELETED", "ARCHIVED"]);

export class DeletionRefused extends Error {}

/**
 * The launcher never deletes or archives anything in Meta: no DELETE requests, and no
 * status DELETED or ARCHIVED on any object. Turning off (PAUSED) is allowed.
 */
export function refuseDeletion(method: string, params: Params | FormData) {
  if (method === "DELETE") throw new DeletionRefused("Deleting is turned off in the launcher. Turn the item off (pause it) instead.");
  const get = (k: string) => (params instanceof FormData ? params.get(k) : (params as Params)[k]);
  for (const k of ["status", "status_option", "configured_status"]) {
    const v = get(k);
    if (typeof v === "string" && DELETING_STATUSES.has(v.toUpperCase())) throw new DeletionRefused("Deleting or archiving is turned off in the launcher. Turn the item off (pause it) instead.");
  }
}

export class MetaClient {
  readonly accountId: string;
  readonly pacer: Pacer;
  private opts: MetaClientOptions;
  private f: typeof fetch;
  private clock: Clock;

  constructor(opts: MetaClientOptions) {
    this.opts = { ...opts, deadline: opts.deadline ?? {} };
    this.accountId = opts.accountId.startsWith("act_") ? opts.accountId : `act_${opts.accountId}`;
    this.clock = opts.clock ?? realClock;
    this.pacer = opts.pacer ?? new Pacer(this.clock);
    this.f = opts.fetch ?? fetch;
  }

  /** Someone is waiting for the answer (a page or a Claude tool). */
  get interactive() {
    return this.opts.maxWaitMs !== undefined;
  }

  /** The time an interactive client must have answered by (set at the first call that shares it). */
  private deadlineAt(): number {
    const d = this.opts.deadline!;
    d.at ??= this.clock.now() + (this.opts.deadlineMs ?? INTERACTIVE_DEADLINE_MS);
    return d.at;
  }

  /** Someone is waiting and the deadline has passed: no more retries. */
  private pastDeadline(): boolean {
    return this.interactive && this.clock.now() >= this.deadlineAt();
  }

  /** The time the pacer must stop waiting for this call: undefined = as long as Meta asks (background). */
  private waitUntil(): number | undefined {
    if (!this.interactive) return undefined;
    return Math.min(this.deadlineAt(), this.clock.now() + this.opts.maxWaitMs!);
  }

  get version() {
    return this.opts.version;
  }

  /** The same client with another token (a Page token for Page-only reads). Shares the pacer. */
  withToken(token: string): MetaClient {
    return new MetaClient({ ...this.opts, token, accountId: this.accountId, pacer: this.pacer });
  }

  private url(path: string) {
    const base = (this.opts.baseUrl ?? "https://graph.facebook.com").replace(/\/$/, "");
    return `${base}/${this.opts.version}/${path.replace(/^\//, "")}`;
  }

  private authParams(): Params {
    if (!this.opts.appSecret) return {};
    return { appsecret_proof: crypto.createHmac("sha256", this.opts.appSecret).update(this.opts.token).digest("hex") };
  }

  async get<T = Record<string, unknown>>(path: string, params: Params = {}): Promise<T> {
    // Reads are safe to repeat, so network hiccups get three tries (not past an interactive deadline).
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.request<T>("GET", path, params, READ_COST);
      } catch (e) {
        if (e instanceof MetaError && e.noAnswer && attempt < 3) {
          const pause = 2000 * attempt;
          if (this.interactive && this.clock.now() + pause > this.deadlineAt()) throw e;
          await this.clock.sleep(pause);
          continue;
        }
        throw e;
      }
    }
  }

  /**
   * Writes are never retried here: the launcher decides, after checking Meta for an existing object.
   * `idempotencyKey` sets X-Client-Idempotent-Key: a repeat with the same key and body returns the
   * object Meta already made (creates on /act_x/campaigns|adsets|ads|adcreatives; rolling out).
   */
  post<T = Record<string, unknown>>(path: string, params: Params | FormData = {}, opts: { idempotencyKey?: string } = {}): Promise<T> {
    return this.request<T>("POST", path, params, WRITE_COST, opts.idempotencyKey ? { "X-Client-Idempotent-Key": opts.idempotencyKey } : undefined);
  }

  private async request<T>(method: string, path: string, params: Params | FormData, cost: number, extraHeaders?: Record<string, string>): Promise<T> {
    refuseDeletion(method, params);
    const interactive = this.interactive;
    const write = method !== "GET";
    let editTries = 0;
    // Rate-limit refusals: background work retries when Meta allows (only slower, never failed);
    // a page or a Claude tool gets the plain message with the time instead.
    for (;;) {
      const deadline = this.waitUntil();
      try {
        await this.pacer.acquire(cost, this.opts.onWait, deadline !== undefined ? { deadline } : {});
      } catch (e) {
        if (!(e instanceof WaitTooLong)) throw e;
        // A wait one call may make (up to maxWaitMs) that only the request's own deadline stopped:
        // the request ran out of time, Meta isn't limiting it. Only the words differ.
        if (this.interactive && e.until <= e.now + this.opts.maxWaitMs! && e.until > this.deadlineAt()) throw new OutOfTimeError(e.until, e.tier, e.now);
        throw new RateLimitedError(e.until, e.tier, e.now);
      }
      const sentAt = this.clock.now();
      let res: Response;
      try {
        res = await this.send(method, path, params, extraHeaders);
      } catch (e) {
        // A write may have reached Meta; a read creates nothing either way.
        throw new MetaError(`Network error: ${e instanceof Error ? e.message : String(e)}`, { status: 0, unknownOutcome: write, noAnswer: true, method });
      }
      const usage = parseUsage(res.headers);
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        body = undefined;
      }
      const err = (body as { error?: GraphErrorBody } | undefined)?.error;
      if (res.ok && !err) {
        this.pacer.answered(usage, sentAt);
        return body as T;
      }
      if (isOneEditAtATime(err)) {
        // One item, not the ad account: wait 30 s and repeat only this call (background work).
        this.pacer.observe(usage);
        if (!interactive && ++editTries < ONE_EDIT_TRIES) {
          this.opts.onWait?.(ONE_EDIT_WAIT_MS, "Meta allows one change to the same item every 30 seconds");
          await this.clock.sleep(ONE_EDIT_WAIT_MS);
          continue;
        }
        throw new MetaError(err?.message ?? `HTTP ${res.status}`, { status: res.status, body: err, method });
      }
      if (isThrottleBody(err)) {
        this.pacer.throttled(usage);
        if (interactive) throw new RateLimitedError(this.pacer.state.blockedUntil, this.pacer.state.tier, this.clock.now());
        continue;
      }
      this.pacer.observe(usage);
      // A 5xx without a clear Meta error: no answer. For a write, it may still have created the object.
      // "Please reduce the amount of data" (HTTP 500, code 1) is a clear answer: the read is too big.
      const noAnswer = res.status >= 500 && !isTooMuchDataBody(err) && (!err || err.code === 1 || err.code === 2);
      throw new MetaError(err?.message ?? `HTTP ${res.status}`, { status: res.status, body: err, unknownOutcome: write && noAnswer, noAnswer, method });
    }
  }

  private async send(method: string, path: string, params: Params | FormData, extraHeaders?: Record<string, string>): Promise<Response> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.opts.token}`, ...extraHeaders };
    const signal = AbortSignal.timeout(this.opts.timeoutMs ?? (this.interactive ? INTERACTIVE_TIMEOUT_MS : BACKGROUND_TIMEOUT_MS));
    const auth = this.authParams();
    if (method === "GET") {
      const q = encodeParams({ ...(params as Params), ...auth });
      const qs = q.toString();
      return this.f(this.url(path) + (qs ? `?${qs}` : ""), { method, headers, signal });
    }
    if (params instanceof FormData) {
      for (const [k, v] of Object.entries(auth)) params.set(k, String(v));
      return this.f(this.url(path), { method, headers, body: params, signal });
    }
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    return this.f(this.url(path), { method, headers, body: encodeParams({ ...params, ...auth }).toString(), signal });
  }

  /** Raw byte upload to a URL Meta gave us (resumable video upload). Not a Marketing API call. */
  async uploadBytes(url: string, headers: Record<string, string>, body: BodyInit): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await this.f(url, {
        method: "POST",
        headers: { Authorization: `OAuth ${this.opts.token}`, ...headers },
        body,
        signal: AbortSignal.timeout(30 * 60_000),
        // Node needs this to stream a request body.
        ...({ duplex: "half" } as object),
      });
    } catch (e) {
      throw new MetaError(`Upload connection error: ${e instanceof Error ? e.message : String(e)}`, { status: 0, unknownOutcome: true });
    }
    this.pacer.observe(parseUsage(res.headers));
    const body2 = (await res.json().catch(() => ({}))) as Record<string, unknown> & { error?: GraphErrorBody };
    if (!res.ok || body2.error) {
      throw new MetaError(body2.error?.message ?? `Upload failed with HTTP ${res.status}`, { status: res.status, body: body2.error, unknownOutcome: res.status >= 500 });
    }
    return body2;
  }

  /**
   * Follow paging.next until done (or `max` items). Each page is one read. When Meta says a page is
   * too much data, ask for the same page again with half the rows (down to 5 rows); each try is one
   * more read, so `shrinkPages: false` asks only once (the caller says "pick fewer days" instead).
   * When someone is waiting, no smaller try starts after the deadline: they get Meta's answer.
   */
  async getAll<T>(path: string, params: Params = {}, max = 500, opts: { shrinkPages?: boolean } = {}): Promise<T[]> {
    const out: T[] = [];
    let after: string | undefined;
    let limit = Number(params.limit ?? 100) || 100;
    for (;;) {
      let page: { data: T[]; paging?: { cursors?: { after?: string }; next?: string } };
      try {
        page = await this.get(path, { ...params, limit, after });
      } catch (e) {
        if (isTooMuchData(e) && opts.shrinkPages !== false && limit > MIN_PAGE && !this.pastDeadline()) {
          limit = Math.max(MIN_PAGE, Math.floor(limit / 2));
          continue;
        }
        throw e;
      }
      out.push(...page.data);
      after = page.paging?.cursors?.after;
      if (!page.paging?.next || !after || out.length >= max) return out;
    }
  }
}
