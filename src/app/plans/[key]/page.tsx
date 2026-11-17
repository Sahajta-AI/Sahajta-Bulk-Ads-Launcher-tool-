import { requirePageUser } from "@/lib/page-auth";
import PlanClient from "./PlanClient";

export const dynamic = "force-dynamic";

export default async function PlanPage({ params }: { params: Promise<{ key: string }> }) {
  await requirePageUser();
  const { key } = await params;
  return <PlanClient planKey={key} />;
}
