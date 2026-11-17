import { requirePageUser } from "@/lib/page-auth";
import ManageClient from "./ManageClient";

export const dynamic = "force-dynamic";

export default async function Manage() {
  await requirePageUser();
  return <ManageClient />;
}
