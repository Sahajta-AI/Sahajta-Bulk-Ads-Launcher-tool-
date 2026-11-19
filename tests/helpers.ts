import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { openDb, setDb } from "@/lib/db";
import { MetaClient } from "@/lib/meta/client";
import { FakeClock, MockMeta, type MockOptions } from "@/lib/meta/mock";
import { Pacer } from "@/lib/meta/pacer";
import { autoGroup } from "@/lib/engine/preview";
import { localFiles, addLocalFolder } from "@/lib/sources/local";
import { newBatch, upsertAccount } from "@/lib/setup";
import { updateBatch } from "@/lib/store";
import type { LaunchDeps } from "@/lib/engine/launcher";

process.env.APP_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");

const FIXTURE_DIR = path.join(os.tmpdir(), "sahajta-launcher-fixtures-v2");

async function image(file: string, w: number, h: number, color: string) {
  if (fs.existsSync(file)) return;
  await sharp({ create: { width: w, height: h, channels: 3, background: color } }).jpeg().toFile(file);
}

function video(file: string, w: number, h: number, hue: number, seconds = 2) {
  if (fs.existsSync(file)) return;
  // A different hue per file, so every video (and its frames) has different bytes.
  execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", `testsrc=size=${w}x${h}:rate=24,hue=h=${hue}`, "-t", String(seconds), "-pix_fmt", "yuv420p", file]);
}

/**
 * The "done means" folder: 15 files, mixed images and 9:16 + 4:5 video pairs.
 * 5 video pairs (10 files) + 3 single images + 1 image pair (2 files) = 15 files -> 9 ads.
 */
export async function fifteenFileFolder(): Promise<string> {
  const dir = path.join(FIXTURE_DIR, "fifteen");
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 1; i <= 5; i++) {
    const n = String(i).padStart(2, "0");
    video(path.join(dir, `hook-${n}_9x16.mp4`), 360, 640, i * 60);
    video(path.join(dir, `hook-${n}_4x5.mp4`), 400, 500, i * 60 + 30);
  }
  await image(path.join(dir, "static-price_1x1.jpg"), 1080, 1080, "#c33");
  await image(path.join(dir, "static-team_4x5.jpg"), 1080, 1350, "#3c3");
  await image(path.join(dir, "Static Offer.jpg"), 1080, 1350, "#33c");
  // Image pair, named without ratio tokens in one file: grouping must use real pixels.
  await image(path.join(dir, "testimonial_story.jpg"), 1080, 1920, "#cc3");
  await image(path.join(dir, "testimonial_feed.jpg"), 1080, 1350, "#3cc");
  return dir;
}

export function freshDb() {
  const d = openDb(":memory:");
  setDb(d);
  return d;
}

export const COPY = {
  primaryTexts: ["Book a free site visit.", "Plots from 20 lakh.", "Weekend site tours.", "Talk to our team.", "See the layout today."],
  headlines: ["Free site visit", "Plots from 20L", "Weekend tours", "Call us", "See the layout"],
  description: "Sahajta Estates",
  cta: "LEARN_MORE",
  linkUrl: "https://example.com/visit",
  utmTemplate: "utm_source=meta&utm_medium=paid&utm_campaign={campaign}&utm_content={creative}",
};

/** COPY with a lead form: the practice account's as1, as3 and as4 collect leads with an Instant form,
 *  and since 19 Nov a launch there without a lead form is refused before anything is made (B13). */
export const LEAD_COPY = { ...COPY, leadFormId: "555000111" };

export async function setupBatch(folder: string, opts: { mode?: "existing" | "new_per_ad"; adsetId?: string } = {}) {
  const accountId = upsertAccount({ metaAccountId: "act_1001", name: "Sahajta (mock)", token: "mock-token" });
  const batchId = newBatch(accountId, "test@example.com");
  await addLocalFolder(batchId, folder);
  autoGroup(batchId);
  updateBatch(batchId, {
    campaign_id: "c1",
    campaign_name: "November tests",
    adset_mode: opts.mode ?? "existing",
    adset_id: opts.adsetId ?? "as1",
    adset_name: "November test ad set",
    copy: JSON.stringify(COPY),
    angle: "site-visit",
    preset: JSON.stringify({ name: "All off", pageId: "p1", pageName: "Sahajta AI", igUserId: "ig1", igName: "sahajta.ai", enhancements: {}, multiAdvertiser: false }),
  });
  return { accountId, batchId };
}

export function mockDeps(accountDbId: number, mockOpts: Partial<MockOptions> = {}) {
  const clock = new FakeClock();
  const mock = new MockMeta({ clock, ...mockOpts });
  const pacer = new Pacer(clock);
  const client = new MetaClient({ token: "mock-token", accountId: mock.accountId, version: "v26.0", fetch: mock.fetch, pacer, clock });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-test-"));
  const deps: LaunchDeps = { client, files: localFiles, clock, accountDbId, tmpDir };
  return { clock, mock, pacer, client, deps };
}
