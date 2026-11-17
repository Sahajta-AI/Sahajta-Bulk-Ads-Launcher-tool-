import { route } from "@/lib/http";
import { lookup } from "@/lib/manage/service";

export const dynamic = "force-dynamic";

/** ?what=saved_audiences|custom_audiences|pixels|custom_conversions|interests|locations|pages&q=search */
export const GET = route(async (req) => {
  const u = new URL(req.url).searchParams;
  return { items: await lookup(u.get("what") ?? "", u.get("q") ?? undefined) };
});
