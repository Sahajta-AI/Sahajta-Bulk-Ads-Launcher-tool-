import { route } from "@/lib/http";
import { HttpError } from "@/lib/httperror";
import { deleteResultsItem } from "@/lib/manage/service";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ kind: string; id: string }> };

/**
 * Remove a saved column set or custom metric (launcher settings only; nothing in Meta).
 * `removedFrom`: the column sets a removed custom metric was taken out of.
 */
export const DELETE = route<Ctx>(async (_req, { params }) => {
  const { kind, id } = await params;
  if (kind !== "column_set" && kind !== "custom_metric") throw new HttpError(404, "Not found.");
  const { removedFrom } = deleteResultsItem(kind, Number(id));
  return { ok: true, removedFrom };
});
