import { body, route } from "@/lib/http";
import { batchView, regroupFile } from "@/lib/service";

type Ctx = { params: Promise<{ key: string }> };

/** Move a file to another ad: { file: "hook-01_4x5.mp4", to: 3 | "new" } */
export const POST = route<Ctx>(async (req, { params }) => {
  const { key } = await params;
  const b = await body<{ file?: string; to?: number | "new" }>(req);
  regroupFile(key, b.file ?? "", b.to ?? "new");
  return batchView(key);
});
