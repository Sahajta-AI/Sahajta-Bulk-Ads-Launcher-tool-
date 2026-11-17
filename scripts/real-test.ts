// Real-account test, for when the Meta token exists. Everything is PAUSED and named TEST_.
//   docker compose exec worker npx tsx scripts/real-test.ts [--folder /data/test-creatives] [--cleanup-only]
//
// 1. Makes sure a paused campaign "TEST_launcher" and a paused ad set "TEST_adset" exist.
// 2. Worst case first, with validate_only (Meta checks the request, creates nothing):
//    a 9:16 + 4:5 video pair with 5 primary texts + 5 headlines (placement customization),
//    and an image with 5 + 5. Results go to docs/LIVE-TEST-RESULTS.md.
// 3. Launches a real batch into TEST_adset through the normal engine (paused, TEST_ names).
// 4. Deletes TEST_ ads from earlier test batches, keeping the last successful batch.
//    Never touches anything whose name does not start with TEST_.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { config } from "@/lib/config";
import { db } from "@/lib/db";
import { runBatch } from "@/lib/engine/launcher";
import { autoGroup, buildPreview } from "@/lib/engine/preview";
import { buildCreative, clean } from "@/lib/meta/creative";
import { MetaError } from "@/lib/meta/errors";
import { clientFor } from "@/lib/meta/factory";
import { realClock } from "@/lib/meta/pacer";
import { uploadImage, uploadVideo, videoStatus, videoThumbnail } from "@/lib/meta/upload";
import { sha256File } from "@/lib/engine/media";
import { defaultPreset, newBatch } from "@/lib/setup";
import { localFiles, addLocalFolder } from "@/lib/sources/local";
import { getAccount, getAds, getBatch, updateBatch } from "@/lib/store";
import type { Copy } from "@/lib/types";

process.env.NAME_PREFIX = "TEST_";
const PREFIX = "TEST_";
const flag = (n: string) => process.argv.includes(`--${n}`);
const arg = (n: string) => (process.argv.indexOf(`--${n}`) > 0 ? process.argv[process.argv.indexOf(`--${n}`) + 1] : undefined);
const log = (m: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`);
const results: string[] = [];

const COPY: Copy = {
  primaryTexts: ["TEST primary text one.", "TEST primary text two.", "TEST primary text three.", "TEST primary text four.", "TEST primary text five."],
  headlines: ["TEST headline 1", "TEST headline 2", "TEST headline 3", "TEST headline 4", "TEST headline 5"],
  description: "TEST description",
  cta: "LEARN_MORE",
  linkUrl: process.env.TEST_LINK_URL || "https://sahajta.com",
  utmTemplate: "utm_source=meta&utm_medium=paid&utm_campaign={campaign}&utm_content={creative}",
};

async function makeFixtures(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  const v = (name: string, w: number, h: number) => {
    const f = path.join(dir, name);
    if (!fs.existsSync(f)) execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", `testsrc2=size=${w}x${h}:rate=30`, "-f", "lavfi", "-i", "sine=frequency=440", "-t", "6", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", f]);
  };
  v("TEST-hook_9x16.mp4", 1080, 1920);
  v("TEST-hook_4x5.mp4", 1080, 1350);
  const img = path.join(dir, "TEST-static_4x5.jpg");
  if (!fs.existsSync(img)) await sharp({ create: { width: 1080, height: 1350, channels: 3, background: "#1f5eff" } }).jpeg().toFile(img);
  return dir;
}

async function ensureCampaignAndAdset(client: ReturnType<typeof clientFor>) {
  const camps = await client.getAll<{ id: string; name: string; status: string }>(`${client.accountId}/campaigns`, {
    fields: "id,name,status", filtering: [{ field: "name", operator: "EQUAL", value: "TEST_launcher" }],
  });
  let campaignId = camps[0]?.id;
  if (!campaignId) {
    const tpl = db().prepare("SELECT objective, special_ad_categories FROM campaign_templates ORDER BY id LIMIT 1").get() as { objective: string; special_ad_categories: string };
    campaignId = (await client.post<{ id: string }>(`${client.accountId}/campaigns`, {
      name: "TEST_launcher", objective: tpl.objective, status: "PAUSED", special_ad_categories: JSON.parse(tpl.special_ad_categories), is_adset_budget_sharing_enabled: false,
    })).id;
    log(`Created paused campaign TEST_launcher (${campaignId})`);
  }
  const sets = await client.getAll<{ id: string; name: string }>(`${client.accountId}/adsets`, {
    fields: "id,name", filtering: [{ field: "name", operator: "EQUAL", value: "TEST_adset" }, { field: "campaign.id", operator: "EQUAL", value: campaignId }],
  });
  let adsetId = sets[0]?.id;
  if (!adsetId) {
    adsetId = (await client.post<{ id: string }>(`${client.accountId}/adsets`, {
      name: "TEST_adset", campaign_id: campaignId, status: "PAUSED", daily_budget: Number(process.env.TEST_DAILY_BUDGET ?? 10000),
      billing_event: "IMPRESSIONS", optimization_goal: "LINK_CLICKS", bid_strategy: "LOWEST_COST_WITHOUT_CAP", destination_type: "WEBSITE",
      targeting: { geo_locations: { countries: ["IN"] }, age_min: 18, targeting_automation: { advantage_audience: 0 } }, is_dynamic_creative: false,
    })).id;
    log(`Created paused ad set TEST_adset (${adsetId})`);
  }
  return { campaignId, adsetId };
}

async function validateWorstCase(client: ReturnType<typeof clientFor>, accountDbId: number, dir: string) {
  const preset = defaultPreset(accountDbId)!;
  const up = async (f: string) => {
    const file = path.join(dir, f);
    const sha = await sha256File(file);
    return uploadVideo(client, { accountDbId, sha, file, title: `TEST ${f}` });
  };
  const v9 = await up("TEST-hook_9x16.mp4");
  const v4 = await up("TEST-hook_4x5.mp4");
  for (;;) {
    const [a, b] = [await videoStatus(client, v9), await videoStatus(client, v4)];
    if (a.status === "ready" && b.status === "ready") break;
    if (a.status === "error" || b.status === "error") throw new Error("Meta could not process the test videos");
    await realClock.sleep(30_000);
  }
  const thumbs = [await videoThumbnail(client, v9), await videoThumbnail(client, v4)];
  const imageHash = await uploadImage(client, path.join(dir, "TEST-static_4x5.jpg"), "TEST-static_4x5.jpg");

  const cases: { label: string; body: Record<string, unknown> }[] = [
    {
      label: "9:16 + 4:5 video pair, placement customization, 5 texts + 5 headlines",
      body: buildCreative({ name: "TEST_validate_pac", copy: COPY, urlTags: "", preset, assets: [
        { kind: "video", slot: "vertical", videoId: v9, thumbnailUrl: thumbs[0] ?? undefined },
        { kind: "video", slot: "feed", videoId: v4, thumbnailUrl: thumbs[1] ?? undefined },
      ] }),
    },
    {
      label: "single image, 5 texts + 5 headlines (DEGREES_OF_FREEDOM)",
      body: buildCreative({ name: "TEST_validate_image", copy: COPY, urlTags: "", preset, assets: [{ kind: "image", slot: "feed", imageHash }] }),
    },
    {
      label: "single video, 1 text (object_story_spec.video_data with thumbnail)",
      body: buildCreative({ name: "TEST_validate_video", copy: { ...COPY, primaryTexts: [COPY.primaryTexts[0]], headlines: [COPY.headlines[0]] }, urlTags: "", preset, assets: [{ kind: "video", slot: "vertical", videoId: v9, thumbnailUrl: thumbs[0] ?? undefined }] }),
    },
  ];
  const check = async (label: string, body: Record<string, unknown>) => {
    try {
      await client.post(`${client.accountId}/adcreatives`, { ...clean(body), execution_options: ["validate_only"] });
      results.push(`- PASS: ${label}`);
      log(`validate_only PASS: ${label}`);
      return true;
    } catch (e) {
      const d = e instanceof MetaError ? `${e.detail}${e.body?.error_user_msg ? ` / ${e.body.error_user_msg}` : ""}` : String(e);
      results.push(`- FAIL: ${label}\n  Meta said: ${d}`);
      log(`validate_only FAIL: ${label}: ${d}`);
      return false;
    }
  };
  const pacOk = await check(cases[0].label, cases[0].body);
  for (const c of cases.slice(1)) await check(c.label, c.body);
  if (!pacOk) {
    // Fallback 2: one text and headline per placement-customized ad.
    process.env.META_PAC_TEXTS = "first";
    const pair = cases[0].body as { asset_feed_spec: { videos: { video_id: string; thumbnail_url?: string }[] } };
    const vids = pair.asset_feed_spec.videos;
    const fallback = buildCreative({ name: "TEST_validate_pac_one_text", copy: COPY, urlTags: "", preset, assets: [
      { kind: "video", slot: "vertical", videoId: vids[0].video_id, thumbnailUrl: vids[0].thumbnail_url },
      { kind: "video", slot: "feed", videoId: vids[1].video_id, thumbnailUrl: vids[1].thumbnail_url },
    ] });
    const ok = await check("FALLBACK: same pair with 1 text + 1 headline", fallback);
    results.push(ok
      ? "\n**Decision:** Meta refused several texts with placement customization. Add `META_PAC_TEXTS=first` to `.env` and restart (`sudo docker compose up -d`). Paired ads will use the first text and headline; single-file ads keep all 5. Log this in DECISIONS.md."
      : "\n**Decision needed:** Meta refused both placement-customization shapes. See docs/META-API-NOTES.md 5.2 for the next fallbacks.");
  }
}

async function cleanup(client: ReturnType<typeof clientFor>) {
  // The launcher never deletes anything in Meta (the client refuses it). Old TEST_ ads stay
  // paused inside the paused TEST_ campaign; delete them by hand in Ads Manager if wanted.
  const ads = await client.getAll<{ id: string; name: string }>(`${client.accountId}/ads`, { fields: "id,name", filtering: [{ field: "name", operator: "STARTS_WITH", value: PREFIX }] });
  log(`Cleanup: ${ads.length} TEST_ ad(s) stay paused. The launcher does not delete anything.`);
}

async function main() {
  const connected = getAccount();
  if (!connected?.token_enc) throw new Error("Meta is not connected. Open the app → Settings → Meta connection → Connect Meta, then run this again.");
  const accountDbId = connected.id;
  const client = clientFor(accountDbId, (ms, r) => log(`${r}: ${Math.ceil(ms / 1000)} s`));
  if (flag("cleanup-only")) return cleanup(client);

  const { campaignId, adsetId } = await ensureCampaignAndAdset(client);
  const dir = arg("folder") ?? (await makeFixtures(path.join(config.dataDir, "test-creatives")));
  results.push(`# Live test results\n\nRun on ${new Date().toISOString()} against ${client.accountId}, API ${client.version}.\n\n## validate_only checks`);
  await validateWorstCase(client, accountDbId, dir);

  // Real batch through the normal engine.
  const batchId = newBatch(accountDbId, "real-test", { kind: "upload", label: "TEST real-account run" });
  await addLocalFolder(batchId, dir);
  autoGroup(batchId);
  updateBatch(batchId, { campaign_id: campaignId, campaign_name: "TEST_launcher", adset_mode: "existing", adset_id: adsetId, adset_name: "TEST_adset", copy: JSON.stringify(COPY), angle: "test", status: "draft" });
  const p = buildPreview(batchId, {}, 60, { persist: true, namePrefix: PREFIX });
  log(`Batch ${getBatch(batchId)!.key}: ${p.ads.length} ads, ${p.errors} errors, ${p.warnings} warnings, ${p.estimate.label}`);
  if (p.errors) throw new Error(p.ads.flatMap((a) => a.checks).filter((c) => c.level === "error").map((c) => c.message).join("; "));
  updateBatch(batchId, { status: "queued" });
  const r = await runBatch(batchId, { client, files: localFiles, clock: realClock, accountDbId, tmpDir: path.join(config.dataDir, "tmp"), namePrefix: PREFIX });
  results.push(`\n## Real batch ${getBatch(batchId)!.key}\n\n${r.done} created, ${r.failed} failed (all PAUSED, in TEST_launcher / TEST_adset).`);
  for (const a of getAds(batchId)) results.push(`- ${a.name}: ${a.status}${a.meta_ad_id ? ` (ad ${a.meta_ad_id})` : ""}${a.error ? ` ${a.error}` : ""}${a.feature_warnings !== "[]" ? ` warnings: ${a.feature_warnings}` : ""}`);
  if (r.failed === 0) await cleanup(client);

  const out = path.resolve("docs/LIVE-TEST-RESULTS.md");
  fs.writeFileSync(out, results.join("\n") + "\n");
  log(`Results written to ${out}`);
}

main().catch((e) => {
  console.error(e instanceof MetaError ? e.detail : e);
  process.exit(1);
});
