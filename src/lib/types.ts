import type { Kind, Ratio } from "./engine/media";

export interface Copy {
  primaryTexts: string[]; // up to 5
  headlines: string[]; // up to 5
  description: string;
  cta: string; // Meta call_to_action type, e.g. LEARN_MORE
  linkUrl: string;
  utmTemplate: string;
}

export type CopyOverride = Partial<Copy>;

export interface Preset {
  id?: number;
  name: string;
  pageId: string;
  pageName: string;
  igUserId: string;
  igName: string;
  /** Features switched ON. Everything not listed here is sent as OPT_OUT. */
  enhancements: Record<string, "OPT_IN">;
  multiAdvertiser: boolean;
}

export interface Check {
  level: "error" | "warning";
  code: string;
  message: string;
}

export type BatchStatus = "draft" | "queued" | "running" | "done" | "partial" | "failed";
export type AdStatus = "pending" | "working" | "waiting" | "done" | "failed";

export interface AssetRow {
  id: number;
  batch_id: number;
  ad_id: number | null;
  source_kind: "drive" | "upload" | "local";
  source_ref: string;
  rel_path: string;
  filename: string;
  kind: Kind;
  mime: string;
  size_bytes: number;
  width: number | null;
  height: number | null;
  duration_sec: number | null;
  ratio: Ratio | null;
  local_path: string | null;
  sha256: string | null;
}

export interface AdRow {
  id: number;
  batch_id: number;
  position: number;
  key: string;
  creative_name: string;
  angle: string | null;
  copy_override: string | null;
  name: string | null;
  adset_name: string | null;
  status: AdStatus;
  step: string | null;
  wait_until: number | null;
  meta_adset_id: string | null;
  meta_creative_id: string | null;
  meta_ad_id: string | null;
  attempts: string;
  effective_status: string | null;
  review_issues: string | null;
  error: string | null;
  error_detail: string | null;
  checks: string;
  feature_warnings: string;
}

export interface BatchRow {
  id: number;
  key: string;
  ad_account_id: number;
  status: BatchStatus;
  source_kind: "drive" | "upload";
  source_ref: string | null;
  source_label: string;
  campaign_id: string | null;
  campaign_name: string | null;
  adset_mode: "existing" | "new_per_ad";
  adset_id: string | null;
  adset_name: string | null;
  copy_template_id: number | null;
  copy: string | null;
  ad_name_template: string;
  adset_name_template: string;
  preset_id: number | null;
  preset: string | null;
  angle: string;
  estimate_seconds: number | null;
  warnings_accepted: number;
  run_count: number;
  created_by: string | null;
  created_at: string;
  previewed_at: string | null;
  launched_at: string | null;
  finished_at: string | null;
}

export interface AdAccountRow {
  id: number;
  meta_account_id: string;
  name: string;
  business_id: string | null;
  token_enc: string | null;
  is_default: number;
  token_expires_at: number | null;
  meta_user_name: string | null;
  connected_by: string | null;
  connected_at: string | null;
}
