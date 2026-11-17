import { body, route } from "@/lib/http";
import { HttpError } from "@/lib/httperror";
import { metricsCatalog, results, saveColumnSet, saveCustomMetric } from "@/lib/manage/service";
import type { InsightsQuery } from "@/lib/manage/insights";

export const dynamic = "force-dynamic";

/** Metric names, custom metrics and column sets. */
export const GET = route(async () => metricsCatalog());

// POST { action: "query", ...InsightsQuery, column_set? }
// POST { action: "save_column_set", id?, name, metrics, isDefault? }
// POST { action: "save_custom_metric", id?, name, formula, format?, description? }
export const POST = route(async (req) => {
  const b = await body<{ action?: string } & Record<string, unknown>>(req);
  if (b.action === "query") return results(b as unknown as InsightsQuery & { column_set?: string });
  if (b.action === "save_column_set") return { id: saveColumnSet(b as never) };
  if (b.action === "save_custom_metric") return { id: saveCustomMetric(b as never) };
  throw new HttpError(400, "action must be query, save_column_set or save_custom_metric");
});
