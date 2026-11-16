import { route } from "@/lib/http";
import { listDestinations } from "@/lib/service";

export const dynamic = "force-dynamic";

export const GET = route(async (req) => listDestinations(new URL(req.url).searchParams.get("refresh") === "1"));
