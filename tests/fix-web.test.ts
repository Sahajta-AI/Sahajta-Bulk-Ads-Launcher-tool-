import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { parseCopySheet } from "@/app/batches/[key]/copy-sheet";
import {
  REVIEW_POLL_MS, copyStale, lastUploadDone, notEditedHere, pollDelay, presetStale, reloadAfterPatch, reloadWithDest, reviewSnapshot, summaryFor, summaryKey, waitForReview,
} from "@/app/batches/[key]/batch-logic";
import LaunchStep from "@/app/batches/[key]/LaunchStep";
import { FailedCopyEditor } from "@/app/batches/[key]/Progress";
import { isMetaLimit, msgClass } from "@/app/msg";
import { PresetEditor } from "@/app/settings/SettingsClient";
import { ceilingQuestion, createKeyWith, keyUseText, presetBody, presetForm, readCeiling, removesCeiling } from "@/app/settings/settings-logic";
import { isoToIstInput, istInputToIso, rupees } from "@/app/manage/util";

// Fixes for the web pages (Group WEB, 18 Nov audit). Pure logic is tested directly; where the fix
// is what a page shows, the page's component is rendered to HTML (React's server renderer, no
// browser): no test reads a page's source text any more (round 2).

/** A component's first render as HTML (effects don't run: what the page shows before any loading). */
const html = <P,>(c: ComponentType<P>, props: P) => renderToStaticMarkup(createElement(c as ComponentType<object>, props as object));

type View = Parameters<typeof summaryKey>[0] & { ads: { id: number; effectiveStatus: string | null; metaAdId: string | null; reviewIssues: string[] }[] };

function draftView(over: Record<string, unknown> = {}, ads = 3) {
  const settings = {
    campaignId: "c1", campaignName: "C", adsetMode: "existing", adsetId: "as1", adsetName: "A", copyTemplateId: 1,
    copy: { primaryTexts: ["Hi"], headlines: ["H"], description: "", cta: "LEARN_MORE", linkUrl: "https://example.com", utmTemplate: "" },
    adNameTemplate: "{creative}", adsetNameTemplate: "{creative}", presetId: 1,
    preset: { name: "P", pageId: "p1", pageName: "Page", igUserId: "", igName: "", enhancements: {}, multiAdvertiser: false },
    angle: "", persona: "", extraAdsets: [], goLive: "paused", goLiveAt: null, ...over,
  };
  return {
    key: "k1", status: "draft", settings,
    ads: Array.from({ length: ads }, (_, i) => ({ id: i + 1, effectiveStatus: null, metaAdId: null, reviewIssues: [] as string[] })),
  } as unknown as View;
}

describe("W1 Settings → Safety: the daily budget ceiling box", () => {
  it("reads rupees typed with ₹, commas and spaces", () => {
    expect(readCeiling("₹1,500").value).toBe(1500);
    expect(readCeiling(" 2 000 ").value).toBe(2000);
    expect(readCeiling("1,00,000").value).toBe(100000);
  });

  it("an empty box is not read as 0 (no ceiling); 0 typed on purpose is", () => {
    expect(readCeiling("").error).toBeTruthy();
    expect(readCeiling("   ").error).toBeTruthy();
    expect(readCeiling("0").value).toBe(0);
  });

  it("refuses words and negative amounts", () => {
    expect(readCeiling("five thousand").error).toBeTruthy();
    expect(readCeiling("-500").error).toBeTruthy();
  });

  it("asks before a set ceiling becomes 0", () => {
    expect(removesCeiling(5000, 0)).toBe(true);
    expect(removesCeiling(0, 0)).toBe(false);
    expect(removesCeiling(5000, 3000)).toBe(false);
  });

  it("removing a set ceiling asks first, naming the amount it removes", () => {
    expect(ceilingQuestion(5000, rupees)).toBe("This removes the daily budget ceiling (now ₹5,000 a day). Launches and plans will have no daily limit. Remove it?");
  });
});

describe("W2 Settings → Ad presets: Threads account and partner Page", () => {
  it("a saved preset's Threads account and partner Page are in the form and in the save", () => {
    const body = presetBody(presetForm({ id: 4, name: "Main", pageId: "p1", threadsUserId: "1784", sponsorPageId: "5550" }), ["add_text_overlay"]);
    expect(body).toMatchObject({ kind: "preset", id: 4, threadsUserId: "1784", sponsorPageId: "5550", enhancements: { add_text_overlay: "OPT_IN" } });
  });

  it("an emptied field is sent empty (so it is cleared), not left out", () => {
    const form = { ...presetForm({ id: 4, name: "Main", threadsUserId: "1784", sponsorPageId: "5550" }), threadsUserId: "", sponsorPageId: " " };
    const body = presetBody(form, []);
    expect(body).toHaveProperty("threadsUserId", "");
    expect(body).toHaveProperty("sponsorPageId", "");
    expect(body).toHaveProperty("whatsappNumber", "");
  });

  it("the preset editor shows both fields with the saved values", () => {
    const out = html(PresetEditor, { p: { id: 4, name: "Main", pageId: "p1", threadsUserId: "1784", sponsorPageId: "5550", enhancementsOn: [] }, features: [], onSaved: () => {}, onCancel: () => {} });
    expect(out).toMatch(/Threads account ID<\/span><input[^>]*value="1784"/);
    expect(out).toMatch(/Partner Page ID \(partnership ads\)<\/span><input[^>]*value="5550"/);
  });

  it("'Add a preset' asks the server to refuse a name already in use; editing does not", () => {
    expect(presetBody(presetForm({ name: "Main" }), []).create).toBe(true);
    expect(presetBody(presetForm({ id: 4, name: "Main" }), []).create).toBe(false);
  });
});

describe("W3 Batch page: 'this template was edited' notice", () => {
  const copy = { primaryTexts: ["Hi"], headlines: ["H"], description: "", cta: "LEARN_MORE", linkUrl: "https://x.in", utmTemplate: "", displayLink: "x.in", leadFormId: "" };
  it("notices a changed display link or lead form", () => {
    expect(copyStale({ ...copy, displayLink: "x.in/visit" }, copy)).toBe(true);
    expect(copyStale({ ...copy, leadFormId: "99" }, copy)).toBe(true);
    expect(copyStale({ ...copy }, copy)).toBe(false);
  });

  it("an empty field and a missing one are the same", () => {
    expect(copyStale({ ...copy, leadFormId: "" }, { ...copy, leadFormId: undefined })).toBe(false);
  });

  const tpl = { id: 1, name: "P", pageName: "Page", pageId: "p1", igName: "", igUserId: "", enhancementsOn: [], multiAdvertiser: false, isDefault: true };
  const preset = { name: "P", pageId: "p1", pageName: "Page", igUserId: "", igName: "", enhancements: {}, multiAdvertiser: false };
  it("notices a changed WhatsApp number, Threads account or partner Page", () => {
    expect(presetStale({ ...tpl, whatsappNumber: "+919812345678" }, preset)).toBe(true);
    expect(presetStale({ ...tpl, threadsUserId: "1784" }, preset)).toBe(true);
    expect(presetStale({ ...tpl, sponsorPageId: "5550" }, preset)).toBe(true);
    expect(presetStale(tpl, { ...preset, threadsUserId: undefined })).toBe(false);
  });
});

describe("W4 Settings: key errors shown, key times in India time", () => {
  it("'Create a key' gives the new key, or the reason it failed (never an unhandled error)", async () => {
    expect(await createKeyWith(async () => ({ key: "sk_1" }))).toEqual({ key: "sk_1" });
    expect(await createKeyWith(async () => { throw new Error("Only admins can create keys."); })).toEqual({ error: "Only admins can create keys." });
  });
  it("key times are India time with the date (SQLite's UTC time read as UTC)", () => {
    expect(keyUseText({ createdAt: "2026-11-19 09:35:00", lastUsedAt: null })).toMatch(/^created 19 Nov 2026, 3:05\s?pm IST · never used$/i);
    expect(keyUseText({ createdAt: "2026-11-19 09:35:00", lastUsedAt: "2026-11-20T03:30:00Z" })).toMatch(/last used 20 Nov 2026, 9:00\s?am IST$/i);
  });
});

describe("W5 Copy sheet: cells with line breaks", () => {
  it("a quoted cell with a line break stays one cell in one row", () => {
    const rows = parseCopySheet('ad\tprimary_text_1\theadline_1\n1\t"Line one\nLine two"\tFree site visit\n2\tSecond ad text\tCall us');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ ad: "1", copy: { primaryTexts: ["Line one\nLine two"], headlines: ["Free site visit"] } });
    expect(rows[1]).toMatchObject({ ad: "2", copy: { primaryTexts: ["Second ad text"] } });
  });

  it("keeps a blank line inside a quoted cell, and quote marks Sheets doubled", () => {
    const rows = parseCopySheet('ad\tprimary_text_1\n1\t"Para one\n\nPara two"\n2\t"Say ""hello"""');
    expect(rows[0].copy.primaryTexts).toEqual(["Para one\n\nPara two"]);
    expect(rows[1].copy.primaryTexts).toEqual(['Say "hello"']);
  });

  it("Windows line ends and blank rows between ads", () => {
    const rows = parseCopySheet("ad\theadline_1\r\n1\tOne\r\n\r\n2\tTwo\r\n");
    expect(rows.map((r) => r.copy.headlines)).toEqual([["One"], ["Two"]]);
  });

  it("comma-separated text works too", () => {
    const rows = parseCopySheet('ad,headline_1,link\n3,"Big, bright",https://x.in');
    expect(rows[0]).toMatchObject({ ad: "3", copy: { headlines: ["Big, bright"], linkUrl: "https://x.in" } });
  });

  it("a quote mark that is never closed does not swallow the rows after it", () => {
    const rows = parseCopySheet('ad\theadline_1\n1\t"Best deal\n2\tSecond');
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ ad: "2", copy: { headlines: ["Second"] } });
  });

  it("problems are still reported", () => {
    const rows = parseCopySheet("ad\theadline_1\tmulti_advertiser\n\tNo ad\t\n1\tX\tmaybe", [{ key: "a" }]);
    expect(rows[0].problem).toMatch(/no ad number/);
    expect(rows[1].problem).toMatch(/multi_advertiser must be yes or no/);
  });
});

describe("W6 Batch page: no Meta reads per upload or per poll", () => {
  it("the summary is asked for only for a loaded draft", () => {
    expect(summaryKey(null)).toBeNull();
    expect(summaryKey({ ...draftView(), status: "running" } as View)).toBeNull();
    expect(summaryKey(draftView())).not.toBeNull();
  });

  // Fixed in round 2 (finding 4): with "a new ad set for each ad" the total is per ad, so there the
  // number of ads counts (the old test said an upload never asks again, also in that mode).
  it("an upload (more ads) asks for the summary again only with a new ad set per ad; a new ad set, copy, preset or go-live does", () => {
    const base = summaryKey(draftView());
    expect(summaryKey(draftView({}, 9))).toBe(base);
    const perAd = summaryKey(draftView({ adsetMode: "new_per_ad" }, 3));
    expect(summaryKey(draftView({ adsetMode: "new_per_ad" }, 9))).not.toBe(perAd);
    expect(summaryKey(draftView({ adsetMode: "new_shared" }, 9))).toBe(summaryKey(draftView({ adsetMode: "new_shared" }, 3)));
    expect(summaryKey(draftView({ adsetId: "as2" }))).not.toBe(base);
    expect(summaryKey(draftView({ copyTemplateId: 2 }))).not.toBe(base);
    expect(summaryKey(draftView({ presetId: 2 }))).not.toBe(base);
    expect(summaryKey(draftView({ goLive: "now" }))).not.toBe(base);
    expect(summaryKey(draftView({ extraAdsets: [{ id: "as9", name: "X", campaignId: "c1", campaignName: "C" }] }))).not.toBe(base);
  });

  const preview = (codes: string[]) => ({ batchChecks: codes.map((code) => ({ level: "error" as const, code, message: code })), ads: [] });
  it("after a settings change, a second load with destination checks only when needed", () => {
    expect(reloadAfterPatch({ angle: "price" }, preview(["x"]), { preview: preview(["x"]) })).toBe(false);
    expect(reloadAfterPatch({ goLive: "now" }, preview([]), { preview: preview([]) })).toBe(false);
    expect(reloadAfterPatch({ adsetId: "as2" }, preview([]), { preview: preview([]) })).toBe(true);
    expect(reloadAfterPatch({ presetId: 2 }, preview([]), { preview: preview([]) })).toBe(true);
    // A check vanished from the quick answer (it may be a destination check): load again.
    expect(reloadAfterPatch({ angle: "x" }, preview(["dynamic_creative"]), { preview: preview([]) })).toBe(true);
    // The server says its answer has the destination checks: nothing more to load.
    expect(reloadAfterPatch({ adsetId: "as2" }, preview([]), { preview: preview([]), destChecked: true })).toBe(false);
  });

  it("live progress keeps polling after a failed reload", () => {
    const running = { status: "running", ads: [] };
    expect(pollDelay(running, false)).toBe(3000);
    expect(pollDelay(running, true)).toBeGreaterThan(0);
    expect(pollDelay({ status: "done", ads: [{ id: 1, effectiveStatus: "PENDING_REVIEW", metaAdId: "9", reviewIssues: [] }] }, true)).toBe(60_000);
    expect(pollDelay({ status: "done", ads: [{ id: 1, effectiveStatus: "ACTIVE", metaAdId: "9", reviewIssues: [] }] }, false)).toBeNull();
  });

  it("a summary asked for another key (other ad set, budget, number of ads) is never shown, so its total can't be typed", () => {
    const k1 = summaryKey(draftView({ adsetMode: "new_per_ad" }, 3));
    const k2 = summaryKey(draftView({ adsetMode: "new_per_ad" }, 4));
    const got = { key: k1, value: { total: "₹1,500" } };
    expect(summaryFor(got, k1)).toEqual({ total: "₹1,500" });
    expect(summaryFor(got, k2)).toBeNull();
    expect(summaryFor(got, null)).toBeNull(); // launched: no summary
    expect(summaryFor(null, k1)).toBeNull();
  });

  it("uploads reload without destination checks until the last one is done", () => {
    expect(reloadWithDest(2)).toBe(false);
    expect(reloadWithDest(0)).toBe(true);
    expect(lastUploadDone(1, 0)).toBe(true);
    expect(lastUploadDone(2, 1)).toBe(false);
    expect(lastUploadDone(0, 0)).toBe(false);
  });
});

describe("W7 After launch: change copy and review check", () => {
  it("'Change copy for this ad' keeps the carousel format and link tags", () => {
    expect(notEditedHere({ format: "carousel", utmTemplate: "utm_source=fb" })).toEqual({ format: "carousel", utmTemplate: "utm_source=fb" });
    expect(notEditedHere({ headlines: ["x"] })).toEqual({});
  });

  it("a failed ad's copy has one box per primary text (a text may have line breaks)", () => {
    const ad = { id: 7, position: 2, override: {}, copy: { primaryTexts: ["Line one\nLine two", "Second"], headlines: ["H"], description: "", cta: "LEARN_MORE", linkUrl: "https://x.in", utmTemplate: "", displayLink: "" } };
    const out = html(FailedCopyEditor, { ad: ad as never, tpl: null, batchKey: "k1", busy: "", act: () => {}, onClose: () => {} });
    expect(out.match(/<textarea /g)).toHaveLength(5);
    expect(out).toMatch(/aria-label="Primary text 1"[^>]*>\n?Line one\nLine two<\/textarea>/);
    expect(out).not.toMatch(/one per line/);
  });

  const ads = [{ id: 1, effectiveStatus: "PENDING_REVIEW", metaAdId: "9", reviewIssues: [] as string[] }];
  it("'Check Meta review status now' reloads a few times, and stops as soon as the check ran", async () => {
    expect(REVIEW_POLL_MS.length).toBeGreaterThan(1);
    expect(reviewSnapshot(ads)).not.toBe(reviewSnapshot([{ ...ads[0], effectiveStatus: "ACTIVE" }]));
    const waited: number[] = [];
    const sleep = async (ms: number) => { waited.push(ms); };
    // The worker read Meta at the second reload: "same", no third reload.
    let n = 0;
    const reload = async () => (++n < 2 ? { ads, reviewCheckedAt: null } : { ads, reviewCheckedAt: "2026-11-19T10:00:00Z" });
    expect(await waitForReview({ ads, reviewCheckedAt: null }, reload, { sleep })).toBe("same");
    expect(waited).toEqual(REVIEW_POLL_MS.slice(0, 2));
    // Never read: every reload is used, then "late".
    waited.length = 0;
    expect(await waitForReview({ ads, reviewCheckedAt: null }, async () => ({ ads, reviewCheckedAt: null }), { sleep })).toBe("late");
    expect(waited).toEqual(REVIEW_POLL_MS);
  });

  it("the review wait ends quietly when the page went away, and survives a failed reload", async () => {
    const sleep = async () => {};
    expect(await waitForReview({ ads, reviewCheckedAt: null }, async () => ({ ads, reviewCheckedAt: null }), { sleep, alive: () => false })).toBeNull();
    let n = 0;
    const flaky = async () => (++n === 1 ? null : { ads: [{ ...ads[0], effectiveStatus: "ACTIVE" }], reviewCheckedAt: null });
    expect(await waitForReview({ ads, reviewCheckedAt: null }, flaky, { sleep })).toBe("news");
  });
});

describe("W8 Schedule time is India time on any laptop", () => {
  it("the input's value is read as India time", () => {
    expect(Date.parse(istInputToIso("2026-11-20T09:30")!)).toBe(Date.parse("2026-11-20T04:00:00Z"));
    expect(isoToIstInput("2026-11-20T04:00:00Z")).toBe("2026-11-20T09:30");
  });
  it("the launch step shows the saved time in India time, whatever the laptop's zone", () => {
    const out = html(LaunchStep, { view: draftView({ goLive: "at", goLiveAt: "2026-11-20T04:00:00Z" }) as never, dest: [], patch: () => {}, summary: null, summaryError: "", summaryLoading: false, retrySummary: () => {} });
    expect(out).toMatch(/Turn on at \(India time\)<\/span><input type="datetime-local" value="2026-11-20T09:30"/);
  });
});

describe("W10 'Meta is limiting…' is a warning, not a red error", () => {
  it("picks the box by the start of the message", () => {
    expect(isMetaLimit("Meta is limiting how often the launcher may call this ad account, so…")).toBe(true);
    expect(msgClass("Meta is limiting calls right now.")).toBe("msg warning");
    expect(msgClass("Reconnect Meta in Settings.")).toBe("msg error");
    expect(msgClass("")).toBe("msg error");
  });

  it("the launch summary shows 'Meta is limiting…' in the amber box, other errors in red", () => {
    const step = (summaryError: string) => html(LaunchStep, { view: draftView() as never, dest: [], patch: () => {}, summary: null, summaryError, summaryLoading: false, retrySummary: () => {} });
    expect(step("Meta is limiting how often the launcher may call this ad account. Try again in a few minutes.")).toMatch(/<div class="msg warning">Meta is limiting/);
    expect(step("Reconnect Meta in Settings.")).toMatch(/<div class="msg error">Reconnect Meta/);
  });
});
