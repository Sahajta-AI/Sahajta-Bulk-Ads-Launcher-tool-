import { timeMs } from "../time";

const DAY = 86_400_000;

/**
 * What a budget can spend in one day: the daily budget plus a lifetime budget spread over the whole
 * days left until it ends (a part day is dropped, at least one day). A ₹30,000 lifetime budget ending
 * in 5 days counts as ₹6,000; a ₹10,000 one ending in 25 hours counts in full (Meta can spend most of
 * it in the first day). Rounding the days down counts a little more than Meta may spend (safe), and
 * the amount stays the same within a day.
 */
export function dailyEquivalent(daily: number | null | undefined, lifetime: number | null | undefined, endTime?: string | null, startTime?: string | null, now = Date.now()): number {
  const d = Number(daily) || 0;
  const life = Number(lifetime) || 0;
  if (!life) return d;
  const end = timeMs(endTime);
  const start = timeMs(startTime);
  const from = Math.max(now, Number.isNaN(start) ? now : start);
  const days = Number.isNaN(end) ? 1 : Math.max(1, Math.floor((end - from) / DAY));
  return d + Math.ceil(life / days);
}
