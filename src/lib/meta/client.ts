import crypto from "node:crypto";
import { MetaError, isThrottleBody, type GraphErrorBody } from "./errors";
import { Pacer, READ_COST, WRITE_COST, parseUsage, realClock, type Clock } from "./pacer";

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
    this.opts = opts;
    this.accountId = opts.accountId.startsWith("act_") ? opts.accountId : `act_${opts.accountId}`;
    this.clock = opts.clock ?? realClock;
    this.pacer = opts.pacer ?? new Pacer(this.clock);
    this.f = opts.fetch ?? fetch;
  }

  get version() {
    return this.opts.version;
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
    // Reads are safe to repeat, so network hiccups get three tries.
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.request<T>("GET", path, params, READ_COST);
      } catch (e) {
        if (e instanceof MetaError && e.unknownOutcome && attempt < 3) {
          await this.clock.sleep(2000 * attempt);
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
    // Rate-limit refusals are retried for as long as it takes. They only make a batch slower.
    for (;;) {
      await this.pacer.acquire(cost, this.opts.onWait);
      let res: Response;
      try {
        res = await this.send(method, path, params, extraHeaders);
      } catch (e) {
        throw new MetaError(`Network error: ${e instanceof Error ? e.message : String(e)}`, { status: 0, unknownOutcome: true });
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
        this.pacer.observe(usage);
        return body as T;
      }
      if (isThrottleBody(err)) {
        this.pacer.throttled(usage);
        continue;
      }
      this.pacer.observe(usage);
      throw new MetaError(err?.message ?? `HTTP ${res.status}`, {
        status: res.status,
        body: err,
        // A 5xx without a clear Meta error may still have created the object.
        unknownOutcome: res.status >= 500 && (!err || err.code === 1 || err.code === 2),
      });
    }
  }

  private async send(method: string, path: string, params: Params | FormData, extraHeaders?: Record<string, string>): Promise<Response> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.opts.token}`, ...extraHeaders };
    const signal = AbortSignal.timeout(this.opts.timeoutMs ?? 120_000);
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

  /** Follow paging.next until done (or `max` items). Each page is one read. */
  async getAll<T>(path: string, params: Params = {}, max = 500): Promise<T[]> {
    const out: T[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await this.get<{ data: T[]; paging?: { cursors?: { after?: string }; next?: string } }>(path, { limit: 100, ...params, after });
      out.push(...page.data);
      after = page.paging?.cursors?.after;
      if (!page.paging?.next || !after || out.length >= max) return out;
    }
  }
}
