import { body, route } from "@/lib/http";
import { batchView, deleteDraft, updateSettings, type BatchSettings } from "@/lib/service";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ key: string }> };

export const GET = route<Ctx>(async (req, { params }) => {
  const { key } = await params;
  return batchView(key, { withDestination: new URL(req.url).searchParams.get("dest") === "1" });
});

export const PATCH = route<Ctx>(async (req, { params }) => {
  const { key } = await params;
  await updateSettings(key, await body<BatchSettings>(req));
  return batchView(key);
});

export const DELETE = route<Ctx>(async (_req, { params }) => {
  const { key } = await params;
  deleteDraft(key);
});
