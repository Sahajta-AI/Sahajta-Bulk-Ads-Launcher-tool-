import { route } from "@/lib/http";
import { HttpError } from "@/lib/httperror";
import { objectDetails } from "@/lib/manage/service";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ kind: string; id: string }> };

/** One campaign or ad set with every setting. */
export const GET = route<Ctx>(async (_req, { params }) => {
  const { kind, id } = await params;
  if (kind !== "campaign" && kind !== "adset") throw new HttpError(404, "kind must be campaign or adset");
  return objectDetails(kind, id);
});
