import { body, route } from "@/lib/http";
import { batchView, updateAdOverride } from "@/lib/service";
import type { CopyOverride } from "@/lib/types";

type Ctx = { params: Promise<{ key: string; adId: string }> };

/** Per-ad changes: { copy?: partial copy (empty fields = use the batch copy), angle?: string } */
export const PATCH = route<Ctx>(async (req, { params }) => {
  const { key, adId } = await params;
  updateAdOverride(key, Number(adId), await body<{ copy?: CopyOverride; angle?: string }>(req));
  return batchView(key);
});
