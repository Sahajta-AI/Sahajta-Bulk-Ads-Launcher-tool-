import { route } from "@/lib/http";
import { listIdentities } from "@/lib/service";

export const dynamic = "force-dynamic";

export const GET = route(async (req) => listIdentities(new URL(req.url).searchParams.get("refresh") === "1"));
