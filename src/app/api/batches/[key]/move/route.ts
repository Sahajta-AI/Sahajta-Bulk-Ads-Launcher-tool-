import { body, route } from "@/lib/http";
import { HttpError } from "@/lib/httperror";
import { moveAsset, removeAsset } from "@/lib/engine/preview";
import { getBatchByKey } from "@/lib/store";
import { batchView } from "@/lib/service";

type Ctx = { params: Promise<{ key: string }> };

/** Drag and drop: { assetId, toAdId: number | "new" } or { assetId, remove: true } */
export const POST = route<Ctx>(async (req, { params }) => {
  const { key } = await params;
  const b = getBatchByKey(key);
  if (!b) throw new HttpError(404, "Batch not found.");
  const { assetId, toAdId, remove } = await body<{ assetId: number; toAdId?: number | "new"; remove?: boolean }>(req);
  if (remove) removeAsset(b.id, assetId);
  else moveAsset(b.id, assetId, toAdId ?? "new");
  return batchView(key);
});
