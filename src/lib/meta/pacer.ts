// Pacing for Meta's Marketing API rate limits, per ad account.
//
// Two guards, both must allow a call:
//  1. Our own log of calls in the last 5 minutes (read = 1 point, write = 3 points),
//     kept under TARGET of the account's point cap. This stops bursts between responses.
//  2. Meta's own numbers from the X-Ad-Account-Usage and X-Business-Use-Case-Usage
//     headers. If Meta says we are above TARGET, we wait for the score to decay.
//
// The cap is learned from the headers (points we spent / percent Meta reports), so the
// same code speeds up by itself when the app moves from the 60-point tier to the
// 9,000-point tier. Rate limits only ever make a batch slower, never fail it.

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
  /** X-Ad-Account-Usage: ads_api_access_tier (label only; we go by the numbers) */
  tier?: string;
  /** Highest of call_count / total_cputime / total_time in X-Business-Use-Case-Usage (0-100) */
  bucMaxPct?: number;
  /** X-Business-Use-Case-Usage: estimated_time_to_regain_access (minutes) */
  bucRegainMin?: number;
}

export interface PacerState {
  log: [number, number][]; // [time ms, points]
  capPoints: number;
  blockedUntil: number;
  lastUtil?: { pct: number; at: number };
  lastBuc?: { pct: number; at: number };
}

export const WINDOW_MS = 300_000;
export const TARGET = 0.75;
export const DEFAULT_CAP = 60;
export const READ_COST = 1;
export const WRITE_COST = 3;

export class Pacer {
  state: PacerState;

  constructor(
    private clock: Clock = realClock,
    initial?: Partial<PacerState>,
    private persist?: (s: PacerState) => void,
    private fixedCap?: number,
  ) {
    this.state = {
      log: initial?.log ?? [],
      capPoints: fixedCap ?? initial?.capPoints ?? DEFAULT_CAP,
      blockedUntil: initial?.blockedUntil ?? 0,
      lastUtil: initial?.lastUtil,
      lastBuc: initial?.lastBuc,
    };
  }

  get capPoints() {
    return this.state.capPoints;
  }

  /** Points we can spend per second while staying under the target. Used by the time estimate. */
  get pointsPerSecond() {
    return (this.state.capPoints * TARGET) / (WINDOW_MS / 1000);
  }

  private prune(now: number) {
    const cutoff = now - WINDOW_MS;
    while (this.state.log.length && this.state.log[0][0] <= cutoff) this.state.log.shift();
  }

  windowPoints(now = this.clock.now()): number {
    this.prune(now);
    return this.state.log.reduce((s, [, p]) => s + p, 0);
  }

  /** How long to wait before a call of `cost` points may go out, and why. 0 = go now. */
  waitFor(cost: number): { ms: number; reason: string } {
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

    // Guard 1: our own 5-minute log.
    this.prune(now);
    const budget = Math.max(this.state.capPoints * TARGET, WRITE_COST);
    let points = this.windowPoints(now);
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
    const b = this.state.lastBuc;
    if (b && b.pct >= 90) take(b.at + 60_000 - now, "Close to Meta's hourly limit; slowing down");

    return { ms: Math.max(0, Math.ceil(ms)), reason };
  }

  async acquire(cost: number, onWait?: (ms: number, reason: string) => void) {
    for (;;) {
      const { ms, reason } = this.waitFor(cost);
      if (ms <= 0) break;
      onWait?.(ms, reason);
      await this.clock.sleep(ms);
    }
    this.state.log.push([this.clock.now(), cost]);
    this.save();
  }

  /** Feed Meta's usage headers back after every response. */
  observe(usage: Usage) {
    const now = this.clock.now();
    if (usage.accUtilPct !== undefined) {
      this.state.lastUtil = { pct: usage.accUtilPct, at: now };
      if (!this.fixedCap) this.learnCap(usage.accUtilPct, now);
    }
    if (usage.bucMaxPct !== undefined) this.state.lastBuc = { pct: usage.bucMaxPct, at: now };
    if (usage.bucRegainMin && usage.bucRegainMin > 0) {
      this.state.blockedUntil = Math.max(this.state.blockedUntil, now + usage.bucRegainMin * 60_000);
    }
    this.save();
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
    this.state.capPoints = Math.round(Math.min(Math.max(next, 30), 20_000));
  }

  /** Meta refused a call for rate reasons. Block until it says, or a full window if it doesn't. */
  throttled(usage: Usage) {
    this.observe(usage);
    const now = this.clock.now();
    // While blocked, the time until the score is back to 0 is the best guide.
    if (usage.accResetSec && usage.accResetSec > 0) {
      this.state.blockedUntil = Math.max(this.state.blockedUntil, now + usage.accResetSec * 1000);
    }
    if (this.state.blockedUntil <= now) {
      // 60-point tier blocks for 300 s, the 9,000-point tier for 60 s.
      const fallback = this.state.capPoints > 1000 ? 60_000 : WINDOW_MS;
      this.state.blockedUntil = now + fallback;
    }
    this.save();
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
      let max = 0;
      let regain = 0;
      for (const list of Object.values(j)) {
        for (const e of list) {
          max = Math.max(max, e.call_count ?? 0, e.total_cputime ?? 0, e.total_time ?? 0);
          regain = Math.max(regain, e.estimated_time_to_regain_access ?? 0);
          if (!usage.tier && e.ads_api_access_tier) usage.tier = e.ads_api_access_tier;
        }
      }
      usage.bucMaxPct = max;
      if (regain > 0) usage.bucRegainMin = regain;
    } catch {
      /* ignore */
    }
  }
  return usage;
}
