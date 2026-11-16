import { requirePageUser } from "@/lib/page-auth";
import BatchClient from "./BatchClient";

export const dynamic = "force-dynamic";

export default async function BatchPage({ params }: { params: Promise<{ key: string }> }) {
  await requirePageUser();
  const { key } = await params;
  return <BatchClient batchKey={key} />;
}
