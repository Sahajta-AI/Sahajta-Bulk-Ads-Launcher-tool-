import { config } from "@/lib/config";
import { lastHeartbeat } from "@/lib/jobs";
import { learnedCap } from "@/lib/meta/factory";
import { requirePageUser } from "@/lib/page-auth";
import { getAccount } from "@/lib/store";
import SettingsClient from "./SettingsClient";

export const dynamic = "force-dynamic";

export default async function Settings() {
  await requirePageUser();
  const acc = getAccount();
  const beat = lastHeartbeat();
  const cap = acc ? learnedCap(acc.id) : 60;
  const status = {
    account: acc ? `${acc.name || "Ad account"} (${acc.meta_account_id})` : null,
    tokenSet: !!acc?.token_enc,
    mock: process.env.META_MOCK === "1",
    apiVersion: config.metaApiVersion,
    tier: cap > 1000 ? `Full access (about ${cap.toLocaleString("en-IN")} points)` : `Limited access (${cap} points per 5 minutes)`,
    worker: beat && Date.now() - beat < 120_000 ? "Running" : "Not running",
    appUrl: config.appUrl,
  };
  return <SettingsClient status={status} />;
}
