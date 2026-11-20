// Settings form logic (pure: no React, so it can be unit tested).

import type { Templates } from "../client-api";
import { ist, num } from "../manage/util";

/** The daily budget ceiling as typed ("₹1,500", "1500", "0"). Empty is not 0: the person must type 0. */
export function readCeiling(text: string): { value: number; error?: undefined } | { value?: undefined; error: string } {
  const n = num(text);
  if (n === undefined) return { error: "Type an amount in rupees, or 0 for no ceiling." };
  if (!Number.isFinite(n) || n < 0) return { error: "Type 0 (no ceiling) or an amount in rupees, like 5000." };
  return { value: Math.round(n) };
}

/** Saving this would remove a ceiling that is set now: ask first. */
export function removesCeiling(savedCeiling: number, value: number): boolean {
  return savedCeiling > 0 && value === 0;
}

/** The question asked before the ceiling is removed. */
export function ceilingQuestion(savedCeiling: number, money: (n: number) => string): string {
  return `This removes the daily budget ceiling (now ${money(savedCeiling)} a day). Launches and plans will have no daily limit. Remove it?`;
}

/** "Create a key": the new key, or the reason it failed (shown on the page, never lost). */
export async function createKeyWith(post: () => Promise<{ key: string }>): Promise<{ key: string; error?: undefined } | { key?: undefined; error: string }> {
  try {
    return { key: (await post()).key };
  } catch (e) {
    return { error: (e as Error).message || "Couldn't create the key. Try again." };
  }
}

/** "created 19 Nov 2026, 3:05 pm IST · last used …" for a key in the list (India time). */
export function keyUseText(k: { createdAt: string; lastUsedAt: string | null }): string {
  return `created ${ist(k.createdAt)} · ${k.lastUsedAt ? `last used ${ist(k.lastUsedAt)}` : "never used"}`;
}

type PresetT = Partial<Templates["presets"][number]>;

/** What the preset form shows and edits. Every field is a string the person sees (empty = none). */
export function presetForm(p: PresetT) {
  return {
    id: p.id,
    name: p.name ?? "",
    pageId: p.pageId ?? "",
    pageName: p.pageName ?? "",
    igUserId: p.igUserId ?? "",
    igName: p.igName ?? "",
    whatsappNumber: p.whatsappNumber ?? "",
    threadsUserId: p.threadsUserId ?? "",
    sponsorPageId: p.sponsorPageId ?? "",
    multiAdvertiser: p.multiAdvertiser ?? false,
    isDefault: p.isDefault ?? false,
  };
}

export type PresetForm = ReturnType<typeof presetForm>;

/**
 * The body sent to save a preset: exactly what the form shows, empty fields included (they clear).
 * Without an id it is "Add a preset" (create: the server refuses a name already in use instead of
 * overwriting that preset).
 */
export function presetBody(form: PresetForm, on: Iterable<string>) {
  return {
    kind: "preset" as const,
    ...form,
    threadsUserId: form.threadsUserId.trim(),
    sponsorPageId: form.sponsorPageId.trim(),
    enhancements: Object.fromEntries([...on].map((k) => [k, "OPT_IN" as const])),
    create: !form.id,
  };
}

/** What the copy template form edits (texts, headlines and descriptions are the five boxes each). */
export interface CopyForm {
  id?: number;
  name: string;
  texts: string[];
  heads: string[];
  /** Up to 5 description boxes. */
  descs: string[];
  cta: string;
  link: string;
  utm: string;
  displayLink: string;
  leadFormId: string;
}

/**
 * The body sent to save a copy template. Without an id ("Add a copy template", "Duplicate") it is a
 * new one: create tells the server to refuse a name already in use instead of overwriting that template.
 */
export function copyBody(f: CopyForm) {
  return {
    kind: "copy" as const,
    id: f.id,
    name: f.name,
    primaryTexts: f.texts,
    headlines: f.heads,
    descriptions: f.descs,
    cta: f.cta,
    linkUrl: f.link,
    utmTemplate: f.utm,
    displayLink: f.displayLink,
    leadFormId: f.leadFormId,
    create: !f.id,
  };
}
