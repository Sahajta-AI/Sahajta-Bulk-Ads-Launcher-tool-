import { body, route } from "@/lib/http";
import { HttpError } from "@/lib/httperror";
import { metricsCatalog, results, saveColumnSet, saveCustomMetric } from "@/lib/manage/service";
import { checkDates, type InsightsQuery } from "@/lib/manage/insights";

export const dynamic = "force-dynamic";

/** Metric names, custom metrics and column sets. */
export const GET = route(async () => metricsCatalog());

// POST { action: "query", ...InsightsQuery, column_set? }
// POST { action: "save_column_set", id?, name, metrics, isDefault? }
// POST { action: "save_custom_metric", id?, name, formula, format?, description? }
export const POST = route(async (req) => {
  const b = await body<{ action?: string } & Record<string, unknown>>(req);
  if (b.action === "query") {
    const q = b as unknown as InsightsQuery & { column_set?: string };
    // A wrong date or an unknown date range is refused here, before any Meta call. A start date
    // without an end date runs to today in the ad account's time zone (results() works that out,
    // and the range then reads "… to … (today)").
    try {
      checkDates(q);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    // The answer carries the ad account's time zone (Meta's days follow it), read with its currency.
    return await results(q);
  }
  if (b.action === "save_column_set") return { id: saveColumnSet(b as never) };
  if (b.action === "save_custom_metric") return { id: saveCustomMetric(b as never) };
  throw new HttpError(400, "action must be query, save_column_set or save_custom_metric");
});
