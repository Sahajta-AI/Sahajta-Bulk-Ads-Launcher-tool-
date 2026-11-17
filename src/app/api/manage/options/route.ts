import { route } from "@/lib/http";
import { options } from "@/lib/manage/service";

export const dynamic = "force-dynamic";

export const GET = route(async () => options());
