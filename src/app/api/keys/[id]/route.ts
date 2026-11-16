import { route } from "@/lib/http";
import { db } from "@/lib/db";

type Ctx = { params: Promise<{ id: string }> };

export const DELETE = route<Ctx>(async (_req, { params }, who) => {
  const { id } = await params;
  db().prepare("UPDATE api_keys SET revoked_at = datetime('now') WHERE id = ? AND user_email = ?").run(Number(id), who.email);
});
