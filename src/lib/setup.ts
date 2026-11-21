import { db } from "./db";
import { encrypt, shortKey } from "./crypto";
import type { Preset } from "./types";

// First-run data for an ad account: default templates and the "all enhancements off" preset.

export function upsertAccount(opts: { metaAccountId: string; name?: string; token?: string; businessId?: string }): number {
  const id = opts.metaAccountId.startsWith("act_") ? opts.metaAccountId : `act_${opts.metaAccountId}`;
  const existing = db().prepare("SELECT id FROM ad_accounts WHERE meta_account_id = ?").get(id) as { id: number } | undefined;
  const isFirst = !(db().prepare("SELECT 1 FROM ad_accounts LIMIT 1").get());
  if (existing) {
    if (opts.token) db().prepare("UPDATE ad_accounts SET token_enc = ? WHERE id = ?").run(encrypt(opts.token), existing.id);
    if (opts.name) db().prepare("UPDATE ad_accounts SET name = ? WHERE id = ?").run(opts.name, existing.id);
    if (opts.businessId) db().prepare("UPDATE ad_accounts SET business_id = ? WHERE id = ?").run(opts.businessId, existing.id);
    return existing.id;
  }
  const res = db()
    .prepare("INSERT INTO ad_accounts (meta_account_id, name, token_enc, business_id, is_default) VALUES (?, ?, ?, ?, ?)")
    .run(id, opts.name ?? "", opts.token ? encrypt(opts.token) : null, opts.businessId ?? null, isFirst ? 1 : 0);
  const accountId = Number(res.lastInsertRowid);
  seedDefaults(accountId);
  return accountId;
}

export function seedDefaults(accountId: number, page?: { pageId: string; pageName: string; igUserId?: string; igName?: string }) {
  const d = db();
  const has = (table: string) => d.prepare(`SELECT 1 FROM ${table} WHERE ad_account_id = ? LIMIT 1`).get(accountId);
  if (!has("naming_templates")) {
    const ins = d.prepare("INSERT INTO naming_templates (ad_account_id, name, kind, pattern, is_default) VALUES (?, ?, ?, ?, ?)");
    ins.run(accountId, "Date, creative, angle, format", "ad", "{date}_{creative}_{angle}_{format}", 1);
    ins.run(accountId, "Date and creative", "adset", "{date}_{creative}", 1);
  }
  if (!has("settings_presets")) {
    d.prepare(
      "INSERT INTO settings_presets (ad_account_id, name, page_id, page_name, ig_user_id, ig_name, enhancements, multi_advertiser, is_default) VALUES (?, ?, ?, ?, ?, ?, '{}', 0, 1)",
    ).run(accountId, "All AI enhancements off", page?.pageId ?? "", page?.pageName ?? "", page?.igUserId ?? "", page?.igName ?? "");
  }
  if (!has("campaign_templates")) {
    d.prepare("INSERT INTO campaign_templates (ad_account_id, name, objective, special_ad_categories) VALUES (?, ?, ?, ?)").run(accountId, "Traffic, no special category", "OUTCOME_TRAFFIC", "[]");
  }
}

export function newBatch(accountId: number, createdBy: string | null, source: { kind: "drive" | "upload"; ref?: string; label?: string } = { kind: "upload" }): number {
  const preset = defaultPreset(accountId);
  const adTpl = db().prepare("SELECT pattern FROM naming_templates WHERE ad_account_id = ? AND kind = 'ad' ORDER BY is_default DESC, id LIMIT 1").get(accountId) as { pattern: string } | undefined;
  const setTpl = db().prepare("SELECT pattern FROM naming_templates WHERE ad_account_id = ? AND kind = 'adset' ORDER BY is_default DESC, id LIMIT 1").get(accountId) as { pattern: string } | undefined;
  let key = shortKey();
  while (db().prepare("SELECT 1 FROM batches WHERE key = ?").get(key)) key = shortKey();
  const res = db()
    .prepare(
      `INSERT INTO batches (key, ad_account_id, source_kind, source_ref, source_label, preset_id, preset, ad_name_template, adset_name_template, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      key,
      accountId,
      source.kind,
      source.ref ?? null,
      source.label ?? "",
      preset?.id ?? null,
      preset ? JSON.stringify(preset) : null,
      adTpl?.pattern ?? "{date}_{creative}_{angle}_{format}",
      setTpl?.pattern ?? "{date}_{creative}",
      createdBy,
    );
  return Number(res.lastInsertRowid);
}

interface PresetRow {
  id: number;
  name: string;
  page_id: string;
  page_name: string;
  ig_user_id: string;
  ig_name: string;
  enhancements: string;
  multi_advertiser: number;
}

/** "1, 2" → ["1", "2"]; nothing → undefined. */
const idList = (v: string | undefined | null) => {
  const l = String(v ?? "").split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
  return l.length ? l : undefined;
};

export function presetFromRow(r: PresetRow): Preset {
  return {
    id: r.id,
    name: r.name,
    pageId: r.page_id,
    pageName: r.page_name,
    igUserId: r.ig_user_id,
    igName: r.ig_name,
    enhancements: JSON.parse(r.enhancements) as Preset["enhancements"],
    multiAdvertiser: !!r.multi_advertiser,
    whatsappNumber: (r as PresetRow & { whatsapp_number?: string }).whatsapp_number || undefined,
    threadsUserId: (r as PresetRow & { threads_user_id?: string }).threads_user_id || undefined,
    sponsorPageId: (r as PresetRow & { sponsor_page_id?: string }).sponsor_page_id || undefined,
    offlineDatasetIds: idList((r as PresetRow & { offline_dataset_ids?: string }).offline_dataset_ids),
  };
}

export function defaultPreset(accountId: number): Preset | undefined {
  const r = db().prepare("SELECT * FROM settings_presets WHERE ad_account_id = ? ORDER BY is_default DESC, id LIMIT 1").get(accountId) as PresetRow | undefined;
  return r ? presetFromRow(r) : undefined;
}

export function isMock() {
  return process.env.META_MOCK === "1";
}
