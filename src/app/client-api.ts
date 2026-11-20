"use client";

// Browser helpers: JSON calls to our API with plain error messages, and remembered choices.

export async function api<T>(url: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(url, {
    method: opts.method ?? "GET",
    headers: opts.body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok || data.error) {
    if (res.status === 401) window.location.href = "/login";
    throw new Error(data.error ?? `Something went wrong (error ${res.status}).`);
  }
  return data as T;
}

/** Copy templates, naming patterns and presets from /api/templates (Settings and the batch page). */
export interface Templates {
  copy: { id: number; name: string; primaryTexts: string[]; headlines: string[]; descriptions: string[]; cta: string; linkUrl: string; utmTemplate: string; displayLink?: string; leadFormId?: string }[];
  naming: { id: number; name: string; kind: "ad" | "adset" | "campaign"; pattern: string; is_default: number }[];
  presets: { id: number; name: string; pageName: string; pageId: string; igName: string; igUserId: string; enhancementsOn: string[]; multiAdvertiser: boolean; isDefault: boolean; whatsappNumber?: string; threadsUserId?: string; sponsorPageId?: string }[];
  tokens: { token: string; meaning: string }[];
  ctaTypes: string[];
  /** AI creative enhancements that can be switched on (key sent to Meta, plain label). */
  features: { key: string; label: string }[];
}

const KEY = "launcher:last";

export interface LastUsed {
  adsetId?: string;
  adsetMode?: "existing" | "new_per_ad" | "new_shared";
  copyTemplateId?: number;
  presetId?: number;
  angle?: string;
}

export const lastUsed = {
  get(): LastUsed {
    try {
      return JSON.parse(localStorage.getItem(KEY) ?? "{}") as LastUsed;
    } catch {
      return {};
    }
  },
  set(patch: LastUsed) {
    try {
      localStorage.setItem(KEY, JSON.stringify({ ...lastUsed.get(), ...patch }));
    } catch {
      /* private window: ignore */
    }
  },
};
