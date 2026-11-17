import { requirePageUser } from "@/lib/page-auth";
import ResultsClient from "./ResultsClient";

export const dynamic = "force-dynamic";

export default async function Results() {
  await requirePageUser();
  return <ResultsClient />;
}
