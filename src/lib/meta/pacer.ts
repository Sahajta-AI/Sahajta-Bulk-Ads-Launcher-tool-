// Pacing for Meta's Marketing API rate limits, per ad account.
//
// Guards, all must allow a call:
//  1. Our own log of calls in the last 5 minutes (read = 1 point, write = 3 points),
//     kept under TARGET of the account's point cap (background work) or INTERACTIVE_TARGET
//     (a page or a Claude tool). This stops bursts between responses.
//  2. Meta's own numbers from the X-Ad-Account-Usage header. If Meta says we are above TARGET,
//     we wait for the score to decay.
//  3. Meta's hourly allowance from X-Business-Use-Case-Usage (the ads_management entry).
//
// The web app and the worker are two processes calling the same ad account. The rate_state row
// in SQLite is the only state: every step (check + reservation, Meta's numbers, a refusal, a
// success) reads the row, changes it and writes it back in one IMMEDIATE transaction, so the
// log holds both processes' calls and nobody overwrites the other's block.
//
// The cap is learned from X-Ad-Account-Usage (points we spent / percent Meta reports), or set from
// the access tier when Meta does not send that header (production, 18 Nov 2026). Rate limits only
// ever make a batch slower, never fail it.

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

export interface Usage {
  /** X-Ad-Account-Usage: acc_id_util_pct (0-100) */
  accUtilPct?: number;
  /** X-Ad-Account-Usage: reset_time_duration (seconds until the score is back to 0). Not a block by itself. */
  accResetSec?: number;
  /** ads_api_access_tier from either header, e.g. "development_access". */
  tier?: string;
  /** Highest of call_count / total_cputime / total_time in the ads_management entry of X-Business-Use-Case-Usage (0-100) */
  bucMaxPct?: number;
  /** X-Business-Use-Case-Usage (ads_management): estimated_time_to_regain_access (minutes) */
  bucRegainMin?: number;
}

export interface PacerState {
  log: [number, number][]; // [time ms, points]; every process's calls, refused ones too
  capPoints: number;
  blockedUntil: number;
  lastUtil?: { pct: number; at: number };
  lastBuc?: { pct: number; at: number };
  /** Meta's ads_api_access_tier, e.g. "development_access" (the starter level). */
  tier?: string;
  /** Rate refusals in a row; each one doubles the wait (Meta counts refused calls too). */
  strikes?: number;
  /** When Meta last refused a call for rate reasons (ms). Missing = long ago. */
  lastRefusalAt?: number;
}

export const WINDOW_MS = 300_000;
/** Background work (launches, plans) keeps to this share of the cap; the time estimates use it too. */
export const TARGET = 0.75;
/** A page or a Claude tool may use up to this share, so people still get answers during a launch. */
export const INTERACTIVE_TARGET = 0.9;
export const DEFAULT_CAP = 60;
export const READ_COST = 1;
export const WRITE_COST = 3;
/** Meta's starter tier: at most 60 points per 5 minutes per ad account, and a 300-second block. */
export const DEV_CAP = 60;
/** Meta's standard (full) access tier: 9,000 points per 5 minutes per ad account. */
export const STANDARD_CAP = 9000;
const HOUR_MS = 3_600_000;

export const isDevTier = (tier?: string) => !!tier && tier.includes("development");

/** The cap Meta documents for an access tier, when the tier is known. */
export function capForTier(tier?: string): number | undefined {
  if (!tier) return undefined;
  if (isDevTier(tier)) return DEV_CAP;
  if (/standard|full|advanced/i.test(tier)) return STANDARD_CAP;
  return undefined;
}

/** Thrown when a call would have to wait longer than the caller allows (a page or a Claude tool). */
export class WaitTooLong extends Error {
  constructor(readonly until: number, readonly tier?: string, readonly now = Date.now()) {
    super("Meta is limiting calls right now.");
  }
}

/** Runs one pacer step as one database transaction (the factory passes db().transaction(fn).immediate()). */
export type Atomic = <T>(fn: () => T) => T;

function isBusy(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.startsWith("SQLITE_BUSY");
}

/** What steps did while the database was busy (calls sent, a block from Meta, a success): saved by the next step that gets it. */
interface Unsaved {
  log: [number, number][];
  blockedUntil: number;
  strikes: number;
  lastRefusalAt?: number;
  /** A call sent at this time went through, so the refusals before it are over (strikes back to 0). */
  clearedAt?: number;
}

export class Pacer {
  state: PacerState;
  private unsaved?: Unsaved;
  /** Set by resetStrikes during one step: when the call that ended the refusals was sent. */
  private cleared?: number;

  constructor(
    private clock: Clock = realClock,
    initial?: Partial<PacerState>,
    private persist?: (s: PacerState) => void,
    private fixedCap?: number,
    /** Reads the shared rate_state row (all processes). When given, every step starts from it. */
    private read?: () => Partial<PacerState> | undefined,
    /** Runs a step as one transaction: read row → change → write. */
    private atomic?: Atomic,
  ) {
    this.state = this.fromRow(initial);
  }

  private fromRow(row?: Partial<PacerState>): PacerState {
    const s: PacerState = {
      log: row?.log ? row.log.map(([t, p]) => [t, p] as [number, number]) : [],
      capPoints: this.fixedCap ?? row?.capPoints ?? DEFAULT_CAP,
      blockedUntil: row?.blockedUntil ?? 0,
      lastUtil: row?.lastUtil ? { ...row.lastUtil } : undefined,
      lastBuc: row?.lastBuc ? { ...row.lastBuc } : undefined,
      tier: row?.tier,
      strikes: row?.strikes ?? 0,
      lastRefusalAt: row?.lastRefusalAt,
    };
    if (isDevTier(s.tier) && !this.fixedCap) s.capPoints = Math.min(s.capPoints, DEV_CAP);
    return s;
  }

  /**
   * One pacer step. With a shared row: read it, run `fn` on it, write it back (when `write` says
   * so), all in one transaction.
   *
   * If another process holds the database past the busy timeout, decide on the row as it is now
   * (reading still works in WAL mode; else our last copy) and write nothing: a write outside the
   * transaction could wipe what the other process saved meanwhile (a block from Meta, its calls).
   * What this step did (a call sent, a block from Meta) is kept and saved by the next step that
   * gets the database.
   */
  private step<T>(fn: () => T, write: (out: T) => boolean = () => true): T {
    if (!this.read) {
      const out = fn();
      if (write(out)) this.save();
      return out;
    }
    const mine = this.state;
    let saved = false;
    const run = () => {
      this.load();
      const out = fn();
      if (write(out) || this.unsaved) {
        this.save();
        saved = true;
      }
      return out;
    };
    try {
      const out = this.atomic ? this.atomic(run) : run();
      if (saved) this.unsaved = undefined;
      return out;
    } catch (e) {
      if (!isBusy(e)) throw e;
      try {
        this.load();
      } catch {
        this.state = mine;
      }
      const before = new Set(this.state.log);
      const { blockedUntil, lastRefusalAt } = this.state;
      this.cleared = undefined;
      const out = fn();
      if (write(out)) this.keepUnsaved(before, blockedUntil, lastRefusalAt);
      return out;
    }
  }

  /** The shared row as it is now, plus what our steps did while the database was busy. */
  private load() {
    this.state = this.fromRow(this.read!());
    const u = this.unsaved;
    if (!u) return;
    const s = this.state;
    s.log.push(...u.log.map(([t, p]) => [t, p] as [number, number]));
    s.log.sort((a, b) => a[0] - b[0]);
    s.blockedUntil = Math.max(s.blockedUntil, u.blockedUntil);
    if (u.lastRefusalAt !== undefined && (s.lastRefusalAt === undefined || u.lastRefusalAt > s.lastRefusalAt)) {
      s.lastRefusalAt = u.lastRefusalAt;
      s.strikes = Math.max(s.strikes ?? 0, u.strikes);
    }
    // A success seen while busy ends the refusals, unless a refusal (ours or the other process's) came after its call was sent.
    if (u.clearedAt !== undefined && (s.lastRefusalAt === undefined || s.lastRefusalAt < u.clearedAt)) s.strikes = 0;
  }

  /** Remember what a step did while the database was busy (only what matters to the other process). */
  private keepUnsaved(before: Set<[number, number]>, blockedBefore: number, refusalBefore?: number) {
    const s = this.state;
    const u: Unsaved = this.unsaved ?? { log: [], blockedUntil: 0, strikes: 0 };
    u.log.push(...s.log.filter((e) => !before.has(e)).map(([t, p]) => [t, p] as [number, number]));
    if (s.blockedUntil > blockedBefore) u.blockedUntil = Math.max(u.blockedUntil, s.blockedUntil);
    if (s.lastRefusalAt !== undefined && s.lastRefusalAt !== refusalBefore) {
      u.lastRefusalAt = s.lastRefusalAt;
      u.strikes = s.strikes ?? 0;
    }
    if (this.cleared !== undefined) u.clearedAt = Math.max(u.clearedAt ?? 0, this.cleared);
    this.cleared = undefined;
    if (u.log.length || u.blockedUntil || u.lastRefusalAt !== undefined || u.clearedAt !== undefined) this.unsaved = u;
  }

  /** Read-only look at the shared row (no write, no transaction needed for one SELECT). */
  private refresh() {
    if (this.read) this.load();
  }

  private setTier(tier: string) {
    this.state.tier = tier;
    if (isDevTier(tier) && !this.fixedCap) this.state.capPoints = Math.min(this.state.capPoints, DEV_CAP);
  }

  get capPoints() {
    this.refresh();
    return this.state.capPoints;
  }

  /** Points background work may spend per second while staying under the target. Used by the time estimate. */
  get pointsPerSecond() {
    return (this.capPoints * TARGET) / (WINDOW_MS / 1000);
  }

  private prune(now: number) {
    const cutoff = now - WINDOW_MS;
    while (this.state.log.length && this.state.log[0][0] <= cutoff) this.state.log.shift();
  }

  private sum(now: number): number {
    this.prune(now);
    return this.state.log.reduce((s, [, p]) => s + p, 0);
  }

  windowPoints(now = this.clock.now()): number {
    this.refresh();
    return this.sum(now);
  }

  /**
   * How long to wait before a call of `cost` points may go out, and why. 0 = go now.
   * `interactive`: someone is waiting for the answer (a page, a Claude tool). Such a call may use
   * up to 90% of the 5-minute cap and the hour's last headroom; background work stops at 75%,
   * so pages and Claude keep working during a launch.
   */
  waitFor(cost: number, interactive = false): { ms: number; reason: string } {
    this.refresh();
    return this.check(cost, interactive);
  }

  private check(cost: number, interactive: boolean): { ms: number; reason: string } {
    const now = this.clock.now();
    let ms = 0;
    let reason = "";
    const take = (m: number, r: string) => {
      if (m > ms) {
        ms = m;
        reason = r;
      }
    };

    if (this.state.blockedUntil > now) take(this.state.blockedUntil - now, "Meta paused us for a few minutes");

    // Guard 1: the shared 5-minute log (both processes' calls).
    const budget = Math.max(this.state.capPoints * (interactive ? INTERACTIVE_TARGET : TARGET), WRITE_COST);
    let points = this.sum(now);
    if (points + cost > budget) {
      for (const [t, p] of this.state.log) {
        points -= p;
        if (points + cost <= budget) {
          take(t + WINDOW_MS - now + 50, "Pacing to stay under Meta's limit");
          break;
        }
      }
    }

    // Guard 2: Meta's reported usage, assumed to decay to zero over the 5-minute window.
    const u = this.state.lastUtil;
    if (u && u.pct > TARGET * 100) {
      const decayMs = ((u.pct - TARGET * 100) / 100) * WINDOW_MS;
      take(u.at + decayMs - now, "Meta reports high usage; waiting for it to drop");
    }
    // Guard 3: Meta's hourly allowance (X-Business-Use-Case-Usage, a rolling hour). Background work
    // stops at 75% and waits for older calls to age out, leaving the rest for pages and Claude.
    const b = this.state.lastBuc;
    if (b && !interactive && b.pct >= 75) take(b.at + Math.max(60_000, ((b.pct - 70) / 100) * HOUR_MS) - now, "Close to Meta's hourly limit for this ad account; waiting so pages and Claude keep working");
    if (b && interactive && b.pct >= 98) take(b.at + 60_000 - now, "At Meta's hourly limit for this ad account");

    return { ms: Math.max(0, Math.ceil(ms)), reason };
  }

  /**
   * Wait until a call may go out, then write it in the shared log (check and reservation are one
   * step, so two processes can't both take the last points).
   *
   * Someone waiting for the answer (a page or a Claude tool) passes `deadline` (a time, ms) and/or
   * `maxWaitMs` (from now). Every wait is checked against that one time, so waits that each look
   * short (other requests keep taking the points that free up) still end there: a wait that would
   * pass it throws WaitTooLong at once, and the person gets a clear answer instead of a request
   * that never returns. Background work passes neither and waits as long as needed.
   */
  async acquire(cost: number, onWait?: (ms: number, reason: string) => void, opts: { maxWaitMs?: number; deadline?: number } = {}) {
    const interactive = opts.maxWaitMs !== undefined || opts.deadline !== undefined;
    const until = Math.min(opts.deadline ?? Infinity, opts.maxWaitMs !== undefined ? this.clock.now() + opts.maxWaitMs : Infinity);
    for (;;) {
      const { ms, reason } = this.step(
        () => {
          const w = this.check(cost, interactive);
          if (w.ms <= 0) this.state.log.push([this.clock.now(), cost]);
          return w;
        },
        (w) => w.ms <= 0,
      );
      if (ms <= 0) return;
      const now = this.clock.now();
      if (now + ms > until) throw new WaitTooLong(now + ms, this.state.tier, now);
      onWait?.(ms, reason);
      await this.clock.sleep(ms);
    }
  }

  /**
   * A call went through: Meta is no longer refusing us. Only a call sent after the last refusal
   * proves that (an answer to a call sent earlier says nothing about the block).
   */
  succeeded(sentAt?: number) {
    this.step(() => this.resetStrikes(sentAt), (changed) => changed);
  }

  /** observe() and succeeded() in one step: one transaction per answer instead of two. */
  answered(usage: Usage, sentAt?: number) {
    this.step(() => {
      this.observeStep(usage);
      this.resetStrikes(sentAt);
    });
  }

  /** Without `sentAt` the caller vouches that the call went out after the last refusal. */
  private resetStrikes(sentAt?: number): boolean {
    if (!this.state.strikes) return false;
    if (sentAt !== undefined && this.state.lastRefusalAt !== undefined && sentAt <= this.state.lastRefusalAt) return false;
    this.state.strikes = 0;
    // Kept if the database is busy now (step): the next step that gets it saves strikes 0 too.
    this.cleared = sentAt ?? this.clock.now();
    return true;
  }

  /** Feed Meta's usage headers back after every response. */
  observe(usage: Usage) {
    this.step(() => this.observeStep(usage));
  }

  private observeStep(usage: Usage) {
    const now = this.clock.now();
    if (usage.tier && usage.tier !== this.state.tier) this.setTier(usage.tier);
    if (usage.accUtilPct !== undefined) {
      this.state.lastUtil = { pct: usage.accUtilPct, at: now };
      if (!this.fixedCap) this.learnCap(usage.accUtilPct, now);
    } else if (usage.tier && !this.fixedCap) {
      // No X-Ad-Account-Usage (production on 18 Nov 2026): the tier is the only guide.
      const c = capForTier(usage.tier);
      if (c) this.state.capPoints = c;
    }
    if (usage.bucMaxPct !== undefined) this.state.lastBuc = { pct: usage.bucMaxPct, at: now };
    if (usage.bucRegainMin && usage.bucRegainMin > 0) {
      this.state.blockedUntil = Math.max(this.state.blockedUntil, now + usage.bucRegainMin * 60_000);
    }
  }

  /**
   * Learn the cap from Meta's percentage, so a tier upgrade speeds us up by itself.
   * - With a clear reading (1% or more): cap = our decayed points / percent.
   * - With almost nothing reported (under 1%) after 9+ points in the last 30 seconds,
   *   the cap must be much bigger than we think: raise it to that lower bound.
   */
  private learnCap(pct: number, now: number) {
    const cur = this.state.capPoints;
    let next = cur;
    if (pct >= 1) {
      const decayed = this.state.log.reduce((s, [t, p]) => s + p * Math.max(0, 1 - (now - t) / WINDOW_MS), 0);
      if (decayed >= 3) {
        const inferred = (decayed * 100) / pct;
        // Big jumps (tier change) apply at once; small ones are smoothed.
        next = inferred > cur * 2 || inferred < cur / 2 ? inferred : cur * 0.7 + inferred * 0.3;
      }
    } else {
      const recent = this.state.log.filter(([t]) => now - t <= 30_000).reduce((s, [, p]) => s + p, 0);
      if (recent >= 9) next = Math.max(cur, recent * 90);
    }
    this.state.capPoints = Math.round(Math.min(Math.max(next, 30), isDevTier(this.state.tier) ? DEV_CAP : 20_000));
  }

  /**
   * Meta refused a call for rate reasons. Block for the longer of what Meta says and its documented
   * block (300 s on the starter tier, 60 s on full access), doubled for every refusal in a row, up to
   * an hour. Refused calls count against Meta's hourly allowance too, so retrying every minute would
   * keep the account blocked (18 Nov 2026: five waiting requests retried every 60 s for an hour).
   *
   * Refusals of calls that were already on their way while a block runs are the same refusal: no
   * new strike, no new block. A refusal more than an hour after the last one starts again at 1.
   */
  throttled(usage: Usage) {
    this.step(() => {
      const now = this.clock.now();
      const running = this.state.blockedUntil > now;
      this.observeStep(usage);
      if (this.state.lastRefusalAt === undefined || now - this.state.lastRefusalAt > HOUR_MS) this.state.strikes = 0;
      this.state.lastRefusalAt = now;
      // While blocked, the time until the score is back to 0 is the best guide.
      if (usage.accResetSec && usage.accResetSec > 0) {
        this.state.blockedUntil = Math.max(this.state.blockedUntil, now + usage.accResetSec * 1000);
      }
      if (running) return;
      this.state.strikes = (this.state.strikes ?? 0) + 1;
      // Never shorter than Meta's documented block: a refusal for the hourly allowance can come with
      // a 5-second reset_time_duration (the 5-minute score), and retrying every 5 s keeps the account
      // refused (18 Nov 2026).
      const base = isDevTier(this.state.tier) || this.state.capPoints <= 1000 ? WINDOW_MS : 60_000;
      this.state.blockedUntil = Math.max(this.state.blockedUntil, now + Math.min(HOUR_MS, base * 2 ** Math.min(this.state.strikes - 1, 4)));
    });
  }

  private save() {
    this.persist?.(this.state);
  }
}

/** Parse Meta's usage headers. Unknown or malformed headers are ignored. */
export function parseUsage(headers: Headers): Usage {
  const usage: Usage = {};
  const acc = headers.get("x-ad-account-usage");
  if (acc) {
    try {
      const j = JSON.parse(acc) as { acc_id_util_pct?: number; reset_time_duration?: number; ads_api_access_tier?: string };
      if (typeof j.acc_id_util_pct === "number") usage.accUtilPct = j.acc_id_util_pct;
      if (typeof j.reset_time_duration === "number") usage.accResetSec = j.reset_time_duration;
      if (j.ads_api_access_tier) usage.tier = j.ads_api_access_tier;
    } catch {
      /* ignore */
    }
  }
  const buc = headers.get("x-business-use-case-usage");
  if (buc) {
    try {
      const j = JSON.parse(buc) as Record<string, { type?: string; call_count?: number; total_cputime?: number; total_time?: number; estimated_time_to_regain_access?: number; ads_api_access_tier?: string }[]>;
      let max: number | undefined;
      let regain = 0;
      for (const list of Object.values(j)) {
        if (!Array.isArray(list)) continue;
        for (const e of list) {
          if (!usage.tier && e.ads_api_access_tier) usage.tier = e.ads_api_access_tier;
          // Only the ads_management use case paces our calls; ads_insights etc. have their own allowance.
          if (e.type !== "ads_management") continue;
          max = Math.max(max ?? 0, e.call_count ?? 0, e.total_cputime ?? 0, e.total_time ?? 0);
          regain = Math.max(regain, e.estimated_time_to_regain_access ?? 0);
        }
      }
      if (max !== undefined) usage.bucMaxPct = max;
      if (regain > 0) usage.bucRegainMin = regain;
    } catch {
      /* ignore */
    }
  }
  return usage;
}
