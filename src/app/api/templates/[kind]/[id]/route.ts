import { route } from "@/lib/http";
import { HttpError } from "@/lib/httperror";
import { deleteTemplate } from "@/lib/service";

type Ctx = { params: Promise<{ kind: string; id: string }> };

export const DELETE = route<Ctx>(async (_req, { params }) => {
  const { kind, id } = await params;
  if (kind !== "copy" && kind !== "naming" && kind !== "preset") throw new HttpError(400, "Unknown template kind");
  deleteTemplate(kind, Number(id));
});
