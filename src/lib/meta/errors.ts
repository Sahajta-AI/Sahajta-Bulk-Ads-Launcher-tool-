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
const THROTTLE_CODES = new Set([4, 17, 32, 613, 80000, 80003, 80004, 80014]);
const THROTTLE_SUBCODES = new Set([2446079, 1487742, 1504022, 1504039]);

export class MetaError extends Error {
  code?: number;
  subcode?: number;
  status: number;
  body?: GraphErrorBody;
  /** The request may or may not have created something in Meta (timeout, network drop, 5xx). */
  unknownOutcome: boolean;

  constructor(message: string, opts: { status: number; body?: GraphErrorBody; unknownOutcome?: boolean }) {
    super(message);
    this.status = opts.status;
    this.body = opts.body;
    this.code = opts.body?.code;
    this.subcode = opts.body?.error_subcode;
    this.unknownOutcome = opts.unknownOutcome ?? false;
  }

  get isThrottle() {
    return (this.code !== undefined && THROTTLE_CODES.has(this.code)) || (this.subcode !== undefined && THROTTLE_SUBCODES.has(this.subcode));
  }

  /** Worth trying again later without changing anything. */
  get isTransient() {
    return this.unknownOutcome || this.isThrottle || this.body?.is_transient === true || this.code === 1 || this.code === 2;
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

export function isThrottleBody(body?: GraphErrorBody) {
  return !!body && ((body.code !== undefined && THROTTLE_CODES.has(body.code)) || (body.error_subcode !== undefined && THROTTLE_SUBCODES.has(body.error_subcode)));
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
  if (!(err instanceof MetaError)) {
    const msg = err instanceof Error ? err.message : String(err);
    return `${doing} failed: ${msg}`;
  }
  const base = plainBase(err, doing);
  // Throttle and connection messages are ours alone; everything else carries Meta's words.
  if (err.isThrottle || err.unknownOutcome) return base;
  return base + metaSaid(err);
}

function plainBase(err: MetaError, doing: string): string {
  const b = err.body ?? {};
  const code = err.code;
  const sub = err.subcode;

  if (code === 190) return `${doing} failed: the Meta connection has expired or was removed. Open Settings → Meta connection and click Reconnect Meta, then use "Retry failed".`;
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
  if (err.unknownOutcome) return `${doing} did not get an answer from Meta (connection problem). Retry will check Meta first, so nothing is created twice.`;
  if (b.error_user_msg) return `${doing} failed.`;
  if (code === 100) return `${doing} failed: Meta rejected one of the settings.`;
  if (code === 1 || code === 2) return `${doing} failed: Meta had a temporary problem. Use "Retry failed" in a few minutes.`;
  return `${doing} failed.`;
}
