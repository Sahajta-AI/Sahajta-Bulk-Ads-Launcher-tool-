// Times from people and from Claude. The marketer works in India time, and the server runs in UTC:
// a time written without a zone ("2026-11-20T09:00") means 9:00 am India time, never 9:00 UTC
// (which would be 2:30 pm IST). Times are always shown back in IST.

const HAS_ZONE = /(?:[zZ]|[+-]\d\d:?\d\d)$/;

/**
 * A time as given by a person or Claude → ISO 8601 with its zone, or null when it isn't a time.
 * No zone → India time (+05:30). A date alone → midnight India time.
 */
export function zonedTime(s: string | null | undefined): string | null {
  if (s === null || s === undefined) return null;
  const t = String(s).trim().replace(" ", "T");
  if (!t) return null;
  let iso = t;
  if (/^\d{4}-\d\d-\d\d$/.test(t)) iso = `${t}T00:00:00+05:30`;
  else if (!HAS_ZONE.test(t)) iso = `${/T\d\d:\d\d$/.test(t) ? `${t}:00` : t}+05:30`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

/** A time stored by SQLite's datetime('now') ("2026-11-18 14:12:26", UTC) or any ISO time → milliseconds. */
export function timeMs(s: string | null | undefined): number {
  if (!s) return NaN;
  const t = String(s).trim();
  return Date.parse(HAS_ZONE.test(t) ? t : `${t.replace(" ", "T")}Z`);
}

/** Any stored or given time → "20 Nov 2026, 09:00 am IST". */
export function istLabel(s: string | null | undefined): string {
  const ms = timeMs(s);
  if (Number.isNaN(ms)) return s ? String(s) : "";
  return `${new Date(ms).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })} IST`;
}
