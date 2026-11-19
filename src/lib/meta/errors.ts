// Meta errors, turned into sentences the marketer can act on.

export interface GraphErrorBody {
  message?: string;
  type?: string;
  code?: number;
  error_subcode?: number;
  error_user_title?: string;
  error_user_msg?: string;
  fbtrace_id?: string;
  is_transient?: boolean;
}

// Rate-limit codes from the Marketing API docs (see docs/META-API-NOTES.md).
const THROTTLE_CODES = new Set([4, 17, 32, 613, 80000, 80001, 80002, 80003, 80004, 80005, 80014]);
const THROTTLE_SUBCODES = new Set([2446079, 1487742, 1504022, 1504039]);
/** Limits with a throttle code that are not a short pause of the ad account: waiting minutes and
 *  blocking the whole account can't help, so they are normal errors with Meta's words. */
export const AD_CREATION_CAP = 1487225; // 613: ads this account may create, by its daily spend limit
export const BUDGET_CHANGES_PER_HOUR = 1487632; // 613: 4 budget changes per hour per ad set
export const SPEND_LIMIT_CHANGES_PER_DAY = 1885172; // 17: 10 spend limit changes per day
/** 613: one edit per object every 30 seconds. The worker waits 30 s and repeats only that call. */
export const ONE_EDIT_PER_30S = 4841018;
const NOT_RATE_LIMIT_SUBCODES = new Set([AD_CREATION_CAP, BUDGET_CHANGES_PER_HOUR, SPEND_LIMIT_CHANGES_PER_DAY, ONE_EDIT_PER_30S]);
const NOT_TRANSIENT_SUBCODES = new Set([AD_CREATION_CAP, BUDGET_CHANGES_PER_HOUR, SPEND_LIMIT_CHANGES_PER_DAY]);

function isRateLimit(code?: number, subcode?: number): boolean {
  if (subcode !== undefined && NOT_RATE_LIMIT_SUBCODES.has(subcode)) return false;
  return (code !== undefined && THROTTLE_CODES.has(code)) || (subcode !== undefined && THROTTLE_SUBCODES.has(subcode));
}

/** Meta's "Please reduce the amount of data you're asking for" (HTTP 500, code 1): the read is too big. */
export function isTooMuchDataBody(body?: GraphErrorBody): boolean {
  return !!body && body.code === 1 && /reduce the amount of data/i.test(body.message ?? "");
}

export function isTooMuchData(e: unknown): boolean {
  return e instanceof MetaError && isTooMuchDataBody(e.body);
}

/** Meta's "one change to the same item every 30 seconds" (613/4841018). */
export function isOneEditAtATime(body?: GraphErrorBody): boolean {
  return !!body && body.error_subcode === ONE_EDIT_PER_30S;
}

export class MetaError extends Error {
  code?: number;
  subcode?: number;
  status: number;
  body?: GraphErrorBody;
  /** A write may or may not have created something in Meta (timeout, network drop, 5xx). Never set for reads. */
  unknownOutcome: boolean;
  /** No clear answer from Meta (timeout, network drop, 5xx without a clear error). Reads may repeat. */
  noAnswer: boolean;
  /** "GET" for a read, "POST" for a write; unknown when built outside the client. */
  method?: string;

  constructor(message: string, opts: { status: number; body?: GraphErrorBody; unknownOutcome?: boolean; noAnswer?: boolean; method?: string }) {
    super(message);
    this.status = opts.status;
    this.body = opts.body;
    this.code = opts.body?.code;
    this.subcode = opts.body?.error_subcode;
    this.unknownOutcome = opts.unknownOutcome ?? false;
    this.noAnswer = opts.noAnswer ?? this.unknownOutcome;
    this.method = opts.method;
  }

  get isThrottle() {
    return isRateLimit(this.code, this.subcode);
  }

  /** Worth trying again later without changing anything. */
  get isTransient() {
    if (this.subcode !== undefined && NOT_TRANSIENT_SUBCODES.has(this.subcode)) return false;
    if (isTooMuchDataBody(this.body)) return false;
    if (this.subcode === ONE_EDIT_PER_30S) return true;
    return this.unknownOutcome || this.noAnswer || this.isThrottle || this.body?.is_transient === true || this.code === 1 || this.code === 2;
  }

  /** A read (GET): repeating it creates nothing. */
  get isRead() {
    return this.method === "GET";
  }

  /** Technical detail for the History page's "details" fold. Never contains the token. */
  get detail() {
    const b = this.body;
    if (!b) return this.message;
    return [`code ${b.code ?? "?"}${b.error_subcode ? `/${b.error_subcode}` : ""}`, b.message, b.fbtrace_id ? `trace ${b.fbtrace_id}` : ""]
      .filter(Boolean)
      .join(" · ");
  }
}

/** "8:49 pm" in India time. */
function istClock(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit", hour12: true }).toLowerCase();
}

/**
 * Meta is limiting calls for this ad account, and the person is waiting (a page or a Claude tool),
 * so we say so at once instead of waiting with no reply. Background work (launches, plans) waits instead.
 */
export class RateLimitedError extends MetaError {
  readonly until: number;
  constructor(until: number, tier?: string, now = Date.now()) {
    const mins = Math.max(1, Math.ceil((until - now) / 60_000));
    super(
      `Meta is limiting how often the launcher may call this ad account, so this can't be done right now. Try again after about ${istClock(until)} IST (in ${mins} minute${mins === 1 ? "" : "s"}). Nothing is broken: launches and plans that are running carry on by themselves when Meta allows.` +
        (tier?.includes("development") ? " The launcher's Meta app is on Meta's starter access level, which allows about 300 calls an hour per ad account; Meta's full access level raises this a lot." : ""),
      { status: 429 },
    );
    this.until = until;
  }
  override get isThrottle() {
    return true;
  }
}

/**
 * The request someone is waiting for used up its own time (about 25 s: slow answers from Meta, many
 * pages to read) and the next call needed only a short wait. Meta is not refusing anything, so the
 * words say so. Handled like a rate limit everywhere else (shown, never swallowed, never retried).
 */
export class OutOfTimeError extends RateLimitedError {
  constructor(until: number, tier?: string, now = Date.now()) {
    super(until, tier, now);
    this.message = "This took too long: the launcher waits about 25 seconds for Meta, so the page doesn't hang. Nothing is broken. Try again in a minute; if it happens again, ask for less at once (fewer items or days).";
  }
}

/**
 * Errors that must never be swallowed into an empty list or a "nothing to show": Meta limiting calls,
 * or a login that no longer works. A `.catch(() => [])` must rethrow these so the person sees why.
 */
export function mustSurface(e: unknown): boolean {
  if (e instanceof RateLimitedError) return true;
  if (!(e instanceof MetaError)) return false;
  return e.isThrottle || e.code === 190 || e.code === 102;
}

/** A short rate limit of the ad account (block it and wait), not one of the longer limits above. */
export function isThrottleBody(body?: GraphErrorBody) {
  return !!body && isRateLimit(body.code, body.error_subcode);
}

/** Meta's own words and codes, e.g. ` Meta said: "Permissions error" (code 200/1815199).` */
export function metaSaid(err: MetaError): string {
  const b = err.body;
  if (!b) return "";
  const words = [b.error_user_title, b.error_user_msg || b.message].filter(Boolean).join(": ");
  return ` Meta said: "${words || err.message}" (code ${b.code ?? "?"}${b.error_subcode ? `/${b.error_subcode}` : ""}).`;
}

/** One plain sentence for the person, given what we were doing ("Uploading hook-01_9x16.mp4"),
 *  followed by Meta's own message and error code, so the exact cause is never hidden. */
export function plainError(err: unknown, doing: string): string {
  if (err instanceof RateLimitedError) return err.message;
  if (!(err instanceof MetaError)) {
    const msg = err instanceof Error ? err.message : String(err);
    return `${doing} failed: ${msg}`;
  }
  const base = plainBase(err, doing);
  // Throttle and connection messages are ours alone; everything else carries Meta's words.
  if (err.isThrottle || err.unknownOutcome || err.noAnswer) return base;
  return base + metaSaid(err);
}

function plainBase(err: MetaError, doing: string): string {
  const b = err.body ?? {};
  const code = err.code;
  const sub = err.subcode;

  if (code === 190) return `${doing} failed: the Meta connection has expired or was removed. Open Settings → Meta connection and click Reconnect Meta, then use "Retry failed".`;
  if (sub === AD_CREATION_CAP) {
    return `${doing} failed: Meta caps how many ads this ad account may create, based on the account's daily spending limit, and the cap is reached. This is not a short pause, so the launcher stops trying. Raise the account's spending limit in Meta, or try again tomorrow, then press "Retry failed".`;
  }
  if (sub === BUDGET_CHANGES_PER_HOUR) return `${doing} failed: Meta allows only 4 budget changes per hour on the same ad set, and they are used up. Try again in an hour.`;
  if (sub === SPEND_LIMIT_CHANGES_PER_DAY) return `${doing} failed: Meta allows only 10 changes to the account spending limit per day, and they are used up. Try again tomorrow.`;
  if (sub === ONE_EDIT_PER_30S) return `${doing} failed: Meta allows one change to the same item every 30 seconds. Wait a minute and try again.`;
  if (isTooMuchDataBody(b)) {
    return err.method === "GET" || err.method === undefined
      ? `${doing} failed: Meta says this is too much data at once; pick fewer days, fewer breakdowns or a higher level.`
      : `${doing} failed: Meta says the request is too big.`;
  }
  if (sub === 1885183 || /development mode/i.test(b.message ?? "")) {
    return `${doing} failed: the launcher's Meta app is still in Development mode, and apps in that mode cannot create ads. Ask your admin to switch it to Live (docs/SETUP.md, Meta step 2).`;
  }
  if (sub === 1815199) {
    return `${doing} failed: the ad account is not allowed to use the Instagram account in the settings preset. Fix one of two ways: (1) in Meta Business settings → Accounts → Instagram accounts → pick the account → Assign assets / Connected assets → add this ad account; or (2) in the launcher's settings preset choose "No Instagram account (use the Facebook Page)". Then press "Retry failed".`;
  }
  if (sub === 1885648) {
    return `${doing} failed: the copied ad set has a minimum spend limit that is higher than the campaign budget (Meta's rule for campaign budget campaigns). The launcher now creates the copy without spend limits; press "Retry failed". If it still fails, lower the limit on the template ad set in Ads Manager.`;
  }
  if (code === 10 || code === 200 || code === 294 || (code !== undefined && code >= 200 && code < 300)) {
    return `${doing} failed: the launcher does not have permission for that in Meta. Open Settings → Meta connection, click Reconnect Meta, and tick this ad account, Page and Instagram account. If an agency owns the ad account, they must give you full control first.`;
  }
  if (err.isThrottle) return `${doing} is waiting: Meta asked us to slow down. It will continue on its own.`;
  // "Nothing is created twice" only means something for a write; a read creates nothing.
  if (err.unknownOutcome) return `${doing} did not get an answer from Meta (connection problem). Retry will check Meta first, so nothing is created twice.`;
  if (err.noAnswer) return `${doing} did not get an answer from Meta (connection problem). Try again in a minute.`;
  if (b.error_user_msg) return `${doing} failed.`;
  if (code === 100) return `${doing} failed: Meta rejected one of the settings.`;
  if (code === 1 || code === 2) return `${doing} failed: Meta had a temporary problem. Use "Retry failed" in a few minutes.`;
  return `${doing} failed.`;
}
