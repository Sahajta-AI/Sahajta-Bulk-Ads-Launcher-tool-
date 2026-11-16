import { body, route } from "@/lib/http";
import { batchView, createBatch, listBatches, type BatchSettings } from "@/lib/service";

export const dynamic = "force-dynamic";

export const GET = route(async () => ({ batches: listBatches() }));

/** Create a batch, optionally from a Drive folder link, optionally with its settings in one go (used by Claude). */
export const POST = route(async (req, _ctx, who) => {
  const b = await body<{ driveFolder?: string } & BatchSettings>(req);
  const key = await createBatch(who.email, b);
  return batchView(key, { withDestination: true });
});
