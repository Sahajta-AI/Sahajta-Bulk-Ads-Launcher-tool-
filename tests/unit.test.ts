import { describe, expect, it } from "vitest";
import { baseName, formatLabel, groupFiles } from "@/lib/engine/grouping";
import { ratioOf } from "@/lib/engine/media";
import { metaName, renderName, renderUtm } from "@/lib/engine/naming";
import { estimate } from "@/lib/engine/estimate";
import { FakeClock } from "@/lib/meta/mock";
import { Pacer } from "@/lib/meta/pacer";
import { buildCreative, creativeShape } from "@/lib/meta/creative";
import { featureWarnings } from "@/lib/meta/features";

describe("ratio from pixels", () => {
  it("classifies common exports", () => {
    expect(ratioOf(1080, 1920)).toBe("9x16");
    expect(ratioOf(1080, 1919)).toBe("9x16");
    expect(ratioOf(1080, 1350)).toBe("4x5");
    expect(ratioOf(1080, 1080)).toBe("1x1");
    expect(ratioOf(1920, 1080)).toBe("16x9");
    expect(ratioOf(1000, 1500)).toBe("other");
    expect(ratioOf(undefined, 10)).toBeNull();
  });
});

describe("grouping", () => {
  it("strips ratio words from names", () => {
    expect(baseName("hook-01_9x16.mp4")).toBe("hook-01");
    expect(baseName("hook-01_4x5.mp4")).toBe("hook-01");
    expect(baseName("Hook 11 - Vertical.mov")).toBe("Hook 11");
    expect(baseName("testimonial_story.jpg")).toBe("testimonial");
    expect(baseName("price-45.jpg")).toBe("price-45");
  });
  it("pairs versions of the same creative and keeps others apart", () => {
    const g = groupFiles([
      { id: 1, filename: "hook-01_9x16.mp4", relPath: "hook-01_9x16.mp4", kind: "video", ratio: "9x16" },
      { id: 2, filename: "hook-01_4x5.mp4", relPath: "hook-01_4x5.mp4", kind: "video", ratio: "4x5" },
      { id: 3, filename: "hook-02_9x16.mp4", relPath: "hook-02_9x16.mp4", kind: "video", ratio: "9x16" },
      { id: 4, filename: "hook-01.jpg", relPath: "hook-01.jpg", kind: "image", ratio: "1x1" },
      { id: 5, filename: "notes.pdf", relPath: "notes.pdf", kind: "unsupported", ratio: null },
      { id: 6, filename: "9x16.mp4", relPath: "creative-a/9x16.mp4", kind: "video", ratio: "9x16" },
      { id: 7, filename: "feed.mp4", relPath: "creative-a/feed.mp4", kind: "video", ratio: "4x5" },
    ]);
    expect(new Map(g.map((x) => [x.name, x.assetIds]))).toEqual(
      new Map([
        ["creative-a", [6, 7]],
        ["hook-01-video", [1, 2]],
        ["hook-01-image", [4]],
        ["hook-02", [3]],
      ]),
    );
  });
  it("labels formats", () => {
    expect(formatLabel([{ kind: "video", ratio: "4x5" }, { kind: "video", ratio: "9x16" }])).toBe("VID-9x16+4x5");
  });
});

describe("naming", () => {
  const date = new Date("2026-11-03T10:00:00Z");
  it("renders tokens and tidies empty ones", () => {
    expect(renderName("{date}_{creative}_{angle}_{format}", { date, creative: "hook-01", angle: "", format: "VID-9x16+4x5" })).toBe("2026-11-03_hook-01_VID-9x16+4x5");
    expect(renderName("{date:YYMMDD} | {creative} | {n}", { date, creative: "x", n: 3 })).toBe("261103 | x | 03");
  });
  it("uses India time for the date", () => {
    expect(renderName("{date}", { date: new Date("2026-11-03T20:00:00Z") })).toBe("2026-11-04");
  });
  it("stamps the launch key and test prefix", () => {
    expect(metaName("2026-11-03_hook", "ab3cd-01", "TEST_")).toBe("TEST_2026-11-03_hook [L:ab3cd-01]");
  });
  it("encodes UTM values but leaves Meta's {{ }} macros", () => {
    expect(renderUtm("utm_campaign={campaign}&utm_content={{ad.name}}", { campaign: "Nov tests" })).toBe("utm_campaign=Nov%20tests&utm_content={{ad.name}}");
  });
});

describe("pacer", () => {
  it("never lets our own 5-minute window exceed 75% of the cap", async () => {
    const clock = new FakeClock();
    const p = new Pacer(clock);
    for (let i = 0; i < 100; i++) {
      await p.acquire(3);
      expect(p.windowPoints()).toBeLessThanOrEqual(45);
    }
    // 100 writes = 300 points at 45 points per 5 minutes ~ 28 minutes.
    expect(clock.slept / 60000).toBeGreaterThan(25);
  });
  it("learns a bigger cap from Meta's headers (tier upgrade speeds up by itself)", async () => {
    const clock = new FakeClock();
    const p = new Pacer(clock);
    // On the 9,000-point tier, 15 writes in a few seconds show up as about 0.5%.
    for (let round = 0; round < 6; round++) {
      for (let i = 0; i < 5; i++) await p.acquire(3);
      p.observe({ accUtilPct: (p.windowPoints() / 9000) * 100 });
      await clock.sleep(1000);
    }
    expect(p.capPoints).toBeGreaterThan(4000);
    expect(p.capPoints).toBeLessThanOrEqual(20000);
  });
  it("does not mistake old, decayed calls for a bigger cap", async () => {
    const clock = new FakeClock();
    const p = new Pacer(clock);
    for (let i = 0; i < 5; i++) await p.acquire(3);
    await clock.sleep(280_000);
    p.observe({ accUtilPct: 0 });
    expect(p.capPoints).toBe(60);
  });
  it("treats reset_time_duration as time-to-zero, not a block", () => {
    const clock = new FakeClock();
    const p = new Pacer(clock);
    p.observe({ accUtilPct: 10, accResetSec: 30 });
    expect(p.waitFor(1).ms).toBe(0);
  });
  it("waits out a block Meta reports", async () => {
    const clock = new FakeClock();
    const p = new Pacer(clock);
    p.throttled({ accResetSec: 120 });
    const start = clock.now();
    await p.acquire(1);
    expect(clock.now() - start).toBeGreaterThanOrEqual(120_000);
  });
  it("slows down when Meta reports high usage", () => {
    const clock = new FakeClock();
    const p = new Pacer(clock);
    p.observe({ accUtilPct: 90 });
    expect(p.waitFor(1).ms).toBeGreaterThan(40_000);
  });
});

describe("estimate", () => {
  it("is honest for the brief's example: video pairs at the 60-point tier", () => {
    const ads = Array.from({ length: 10 }, () => ({ newAdset: false, assets: [{ kind: "video" as const, sizeBytes: 50e6, alreadyUploaded: false }, { kind: "video" as const, sizeBytes: 50e6, alreadyUploaded: false }] }));
    const e = estimate(ads, 60);
    expect(e.seconds / 60).toBeGreaterThan(15);
    expect(e.seconds / 60).toBeLessThan(40);
    expect(e.rateLimited).toBe(true);
    expect(estimate(ads, 9000).seconds / 60).toBeLessThan(5);
  });
});

describe("creative", () => {
  const preset = { name: "x", pageId: "p1", pageName: "", igUserId: "ig1", igName: "", enhancements: {}, multiAdvertiser: false };
  const copy = { primaryTexts: ["a", "b"], headlines: ["h"], descriptions: [], cta: "LEARN_MORE", linkUrl: "https://x.com", utmTemplate: "" };
  it("switches every enhancement off and never sends standard_enhancements", () => {
    const c = buildCreative({ name: "n", copy, urlTags: "", preset, assets: [{ kind: "image", slot: "feed", imageHash: "h1" }] }) as { degrees_of_freedom_spec: { creative_features_spec: Record<string, { enroll_status: string }> }; contextual_multi_ads: { enroll_status: string } };
    const spec = c.degrees_of_freedom_spec.creative_features_spec;
    expect(Object.values(spec).every((v) => v.enroll_status === "OPT_OUT")).toBe(true);
    expect(spec.standard_enhancements).toBeUndefined();
    expect(c.contextual_multi_ads.enroll_status).toBe("OPT_OUT");
  });
  it("picks the request shape", () => {
    expect(creativeShape({ assets: [{ kind: "image", slot: "feed" }], copy: { ...copy, primaryTexts: ["a"] } })).toBe("story_spec");
    expect(creativeShape({ assets: [{ kind: "image", slot: "feed" }], copy })).toBe("feed_spec_texts");
    expect(creativeShape({ assets: [{ kind: "video", slot: "feed" }, { kind: "video", slot: "vertical" }], copy })).toBe("feed_spec_placement");
  });
  it("builds placement customization with every text in every placement", () => {
    const c = buildCreative({
      name: "n",
      copy: { ...copy, primaryTexts: ["a", "b", "c", "d", "e"], headlines: ["1", "2", "3", "4", "5"] },
      urlTags: "",
      preset,
      assets: [{ kind: "video", slot: "vertical", videoId: "v9" }, { kind: "video", slot: "feed", videoId: "v4" }],
    }) as { asset_feed_spec: { bodies: { adlabels: { name: string }[] }[]; asset_customization_rules: Record<string, unknown>[]; videos: { adlabels: { name: string }[] }[]; optimization_type: string } };
    const f = c.asset_feed_spec;
    expect(f.optimization_type).toBe("PLACEMENT");
    expect(f.bodies).toHaveLength(5);
    expect(f.bodies.every((b) => b.adlabels.map((l) => l.name).join() === "b_vertical,b_feed")).toBe(true);
    expect(f.asset_customization_rules).toEqual([
      { customization_spec: { publisher_platforms: ["facebook", "instagram"], facebook_positions: ["story", "facebook_reels"], instagram_positions: ["story", "reels"] }, video_label: { name: "f_vertical" }, body_label: { name: "b_vertical" }, title_label: { name: "t_vertical" }, priority: 1 },
      { customization_spec: {}, video_label: { name: "f_feed" }, body_label: { name: "b_feed" }, title_label: { name: "t_feed" }, priority: 2 },
    ]);
    expect(JSON.stringify(c)).not.toMatch(/explore|messenger/);
  });
  it("META_PAC_TEXTS=first sends one text in paired ads only", () => {
    process.env.META_PAC_TEXTS = "first";
    try {
      const five = { ...copy, primaryTexts: ["a", "b", "c", "d", "e"], headlines: ["1", "2"] };
      const pair = buildCreative({ name: "n", copy: five, urlTags: "", preset, assets: [{ kind: "video", slot: "vertical", videoId: "v9" }, { kind: "video", slot: "feed", videoId: "v4" }] }) as { asset_feed_spec: { bodies: unknown[]; titles: unknown[] } };
      expect(pair.asset_feed_spec.bodies).toHaveLength(1);
      expect(pair.asset_feed_spec.titles).toHaveLength(1);
      const single = buildCreative({ name: "n", copy: five, urlTags: "", preset, assets: [{ kind: "image", slot: "feed", imageHash: "h" }] }) as { asset_feed_spec: { bodies: unknown[] } };
      expect(single.asset_feed_spec.bodies).toHaveLength(5);
    } finally {
      delete process.env.META_PAC_TEXTS;
    }
  });
  it("warns about unknown enhancements Meta switched on", () => {
    const w = featureWarnings({ image_touchups: { enroll_status: "OPT_OUT" }, brand_new_ai_thing: { enroll_status: "OPT_IN" } }, {});
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("brand_new_ai_thing");
  });
});
