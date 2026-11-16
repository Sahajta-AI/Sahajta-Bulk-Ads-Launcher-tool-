// The launch engine without the web app.
//
//   npm run launch -- --folder ./creatives --adset "November test ad set" --copy "Site-visit copy" [--angle price]
//                     [--new-adset-per-ad] [--accept-warnings] [--yes]
//   npm run launch -- --resume <batch code>      continue a batch that stopped (crash, kill, restart)
//   npm run launch -- --retry <batch code>       retry failed ads only
//
// Reads the same .env as the app. With META_MOCK=1 it talks to the practice (fake) Meta API.
// Every ad and ad set is created PAUSED.

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { config } from "@/lib/config";
import { checkReview, resetFailed, runBatch } from "@/lib/engine/launcher";
import { autoGroup, buildPreview } from "@/lib/engine/preview";
import { clientFor, pacerFor } from "@/lib/meta/factory";
import { realClock } from "@/lib/meta/pacer";
import { batchView, updateSettings } from "@/lib/service";
import { connectPractice } from "@/lib/meta/connect";
import { isMock, newBatch } from "@/lib/setup";
import { anyFiles } from "@/lib/sources/drive";
import { addLocalFolder } from "@/lib/sources/local";
import { getAccount, getAds, getBatch, getBatchByKey, updateBatch } from "@/lib/store";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);
const log = (msg: string) => console.log(`${new Date().toLocaleTimeString("en-IN", { hour12: false })}  ${msg}`);

async function run(batchId: number) {
  const batch = getBatch(batchId)!;
  const client = clientFor(batch.ad_account_id, (ms, reason) => log(`${reason}: waiting ${Math.ceil(ms / 1000)} s`));
  const tmpDir = path.join(config.dataDir, "tmp");
  fs.mkdirSync(tmpDir, { recursive: true });
  let last = "";
  const timer = setInterval(() => {
    const ads = getAds(batchId);
    const line = ads.map((a) => ({ done: "✓", failed: "✗", waiting: "…", working: "▸", pending: "·" })[a.status]).join("");
    if (line !== last) log(`progress ${line}  (${ads.filter((a) => a.status === "done").length}/${ads.length})`);
    last = line;
  }, 2000);
  const res = await runBatch(batchId, { client, files: anyFiles, clock: realClock, accountDbId: batch.ad_account_id, tmpDir, namePrefix: config.namePrefix });
  clearInterval(timer);
  await checkReview(client, batchId).catch(() => undefined);
  const view = await batchView(batch.key);
  console.log(`\nBatch ${batch.key}: ${res.done} created, ${res.failed} failed. All PAUSED.`);
  for (const a of view.ads) {
    console.log(`  ${String(a.position).padStart(2)}  ${a.status.padEnd(7)} ${a.metaName}${a.metaAdId ? `  ad ${a.metaAdId} (${a.reviewLabel})` : ""}${a.error ? `\n        ${a.error}` : ""}`);
  }
  return res;
}

async function main() {
  const connected = getAccount();
  const accountId = connected?.token_enc ? connected.id : isMock() ? await connectPractice() : undefined;
  if (!accountId) throw new Error("Meta is not connected. Open the app → Settings → Meta connection → Connect Meta.");

  const resume = arg("resume");
  const retry = arg("retry");
  if (resume || retry) {
    const b = getBatchByKey((resume ?? retry)!);
    if (!b) throw new Error(`No batch ${resume ?? retry}`);
    if (retry) log(`Retrying ${resetFailed(b.id)} failed ad(s).`);
    updateBatch(b.id, { status: "queued" });
    const r = await run(b.id);
    process.exit(r.failed ? 2 : 0);
  }

  const folder = arg("folder");
  if (!folder) throw new Error("Give --folder <path>, or --resume <batch code>.");
  const batchId = newBatch(accountId, "cli", { kind: "upload", label: path.basename(path.resolve(folder)) });
  const key = getBatch(batchId)!.key;
  log(`Batch ${key}: reading ${folder}`);
  await addLocalFolder(batchId, path.resolve(folder));
  autoGroup(batchId);
  await updateSettings(key, {
    adsetId: arg("adset"),
    adsetMode: flag("new-adset-per-ad") ? "new_per_ad" : "existing",
    copyTemplateId: arg("copy"),
    angle: arg("angle"),
    presetId: arg("preset"),
  });

  const view = await batchView(key, { withDestination: true });
  const p = buildPreview(batchId, {}, pacerFor(accountId).capPoints, { namePrefix: config.namePrefix });
  console.log(`\n${view.ads.length} ads → ${view.settings.campaignName} / ${view.settings.adsetMode === "new_per_ad" ? "new ad set per ad" : view.settings.adsetName}. Estimate: ${view.preview.estimate.label}.\n`);
  for (const a of view.ads) {
    console.log(`  ${String(a.position).padStart(2)}  ${a.metaName}`);
    for (const f of a.files) console.log(`        ${f.ratio ?? "?"}  ${f.filename}  → ${f.placement}`);
    for (const c of a.checks) console.log(`        ${c.level === "error" ? "ERROR" : "warning"}: ${c.message}`);
  }
  for (const c of view.preview.batchChecks) console.log(`  ${c.level === "error" ? "ERROR" : "warning"}: ${c.message}`);
  if (view.preview.errors) {
    console.log(`\n${view.preview.errors} error(s). Nothing was sent to Meta.`);
    process.exit(1);
  }
  if (p.warnings && !flag("accept-warnings")) {
    console.log(`\n${p.warnings} warning(s). Re-run with --accept-warnings to launch anyway.`);
    process.exit(1);
  }
  if (!flag("yes")) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`\nCreate these ${view.ads.length} ads, PAUSED? [y/N] `);
    rl.close();
    if (answer.trim().toLowerCase() !== "y") process.exit(0);
  }
  updateBatch(batchId, { status: "queued", warnings_accepted: p.warnings ? 1 : 0 });
  const r = await run(batchId);
  process.exit(r.failed ? 2 : 0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
