import { db } from "./db";
import { HttpError } from "./httperror";

// App-wide settings people change in Settings → Safety (not through Claude).

export interface AppSettings {
  /** No batch or plan may let more than this spend per day (account currency). 0 = no ceiling. */
  dailyBudgetCeiling: number;
  /** Send an email when a scheduled or background launch or plan fails. */
  alertEmails: boolean;
}

const DEFAULTS: AppSettings = { dailyBudgetCeiling: 0, alertEmails: true };
const KEYS: Record<keyof AppSettings, string> = { dailyBudgetCeiling: "daily_budget_ceiling", alertEmails: "alert_emails" };

export function getAppSettings(): AppSettings {
  const rows = db().prepare("SELECT key, value FROM app_settings").all() as { key: string; value: string }[];
  const get = (k: string) => rows.find((r) => r.key === k)?.value;
  return {
    dailyBudgetCeiling: Number(get(KEYS.dailyBudgetCeiling) ?? DEFAULTS.dailyBudgetCeiling) || 0,
    alertEmails: (get(KEYS.alertEmails) ?? (DEFAULTS.alertEmails ? "1" : "0")) === "1",
  };
}

export function saveAppSettings(patch: Partial<AppSettings>, who: string): AppSettings {
  const put = db().prepare("INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at");
  if (patch.dailyBudgetCeiling !== undefined) {
    const v = Number(patch.dailyBudgetCeiling);
    if (!Number.isFinite(v) || v < 0) throw new HttpError(400, "The daily budget ceiling must be 0 (none) or more.");
    put.run(KEYS.dailyBudgetCeiling, String(Math.round(v)), who);
  }
  if (patch.alertEmails !== undefined) put.run(KEYS.alertEmails, patch.alertEmails ? "1" : "0", who);
  return getAppSettings();
}

// Values the worker keeps in the same table (not settings people change).

/** The last backup's result as JSON (see BackupStatus in backup.ts). Shown in /api/health and Settings → Safety. */
export const BACKUP_STATUS_KEY = "backup_status";
/** The India-time day (YYYY-MM-DD) the nightly cleanup and backup last ran. */
export const NIGHTLY_DAY_KEY = "nightly_last_day";

export function getSetting(key: string): string | undefined {
  return (db().prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as { value: string } | undefined)?.value;
}

export function putSetting(key: string, value: string, who = "worker") {
  db().prepare("INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at")
    .run(key, value, who);
}
