import { body, route } from "@/lib/http";
import { batchView, setAdCopyBy } from "@/lib/service";
import type { CopyOverride } from "@/lib/types";

type Ctx = { params: Promise<{ key: string }> };

/** Per-ad copy: { rows: [{ ad: number | creative name, copy: {...}, angle? }] } */
export const POST = route<Ctx>(async (req, { params }) => {
  const { key } = await params;
  const b = await body<{ rows?: { ad: string | number; copy: CopyOverride; angle?: string }[] }>(req);
  setAdCopyBy(key, b.rows ?? []);
  return batchView(key);
});
