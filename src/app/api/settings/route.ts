import { body, route } from "@/lib/http";
import { HttpError } from "@/lib/httperror";
import { getAppSettings, saveAppSettings, type AppSettings } from "@/lib/appsettings";
import { backupHealth } from "@/lib/backup";
import { accountInfo } from "@/lib/manage/objects";
import { clientFor } from "@/lib/meta/factory";
import { getAccount } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * The ad account's currency (the budget ceiling is in it). Read with its name and time zone and
 * kept for a day, so it is usually no Meta call. Null when Meta isn't connected or can't be read
 * now: the settings still show.
 */
async function accountCurrency(): Promise<string | null> {
  const acc = getAccount();
  if (!acc?.token_enc) return null;
  try {
    return (await accountInfo(clientFor(acc.id))).currency;
  } catch {
    return null;
  }
}

/** The settings, the ad account's currency, and how the last backup went (shown in Settings → Safety; read only). */
export const GET = route(async () => ({ ...getAppSettings(), currency: await accountCurrency(), backup: backupHealth() }));

/** Only in the app: Claude can read the ceiling but never raise it. */
export const POST = route(async (req, _ctx, who) => {
  if (who.via !== "session") throw new HttpError(403, "Safety settings can only be changed in the app (Settings → Safety).");
  return saveAppSettings(await body<Partial<AppSettings>>(req), who.email);
});
