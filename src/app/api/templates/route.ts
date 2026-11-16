import { body, route } from "@/lib/http";
import { HttpError } from "@/lib/httperror";
import { listTemplates, saveCopyTemplate, saveNamingTemplate, savePreset } from "@/lib/service";

export const dynamic = "force-dynamic";

export const GET = route(async () => listTemplates());

/** Create or update: { kind: "copy" | "naming" | "preset", ...fields } */
export const POST = route(async (req) => {
  const b = await body<{ kind: string } & Record<string, unknown>>(req);
  if (b.kind === "copy") return { id: saveCopyTemplate(b as never) };
  if (b.kind === "naming") return { id: saveNamingTemplate({ ...(b as Record<string, unknown>), kind: b.namingKind } as Parameters<typeof saveNamingTemplate>[0]) };
  if (b.kind === "preset") return { id: savePreset(b as never) };
  throw new HttpError(400, "kind must be copy, naming or preset");
});
