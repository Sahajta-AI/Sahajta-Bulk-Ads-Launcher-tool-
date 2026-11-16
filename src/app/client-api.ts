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

const KEY = "launcher:last";

export interface LastUsed {
  adsetId?: string;
  adsetMode?: "existing" | "new_per_ad";
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
