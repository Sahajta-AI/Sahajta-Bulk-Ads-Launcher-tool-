import type { Kind, Ratio } from "./engine/media";

export interface Copy {
  primaryTexts: string[]; // up to 5
  headlines: string[]; // up to 5
  description: string;
  cta: string; // Meta call_to_action type, e.g. LEARN_MORE
  linkUrl: string;
  utmTemplate: string;
  /** Short link shown on the ad instead of the full URL, e.g. "sahajta.com/visit". */
  displayLink?: string;
  /** Instant form (lead form) the button opens, for ad sets that collect leads on Facebook. */
  leadFormId?: string;
}

/** Per-ad changes: copy fields, plus ad-level settings that otherwise come from the batch's preset. */
export type CopyOverride = Partial<Copy> & {
  /** Enhancements switched ON for this ad only (replaces the preset's list). */
  enhancements?: Record<string, "OPT_IN">;
  multiAdvertiser?: boolean;
  /** "carousel": every file of the ad becomes a card (2 to 10). Default: one file, or a 9:16 + 4:5 pair. */
  format?: "single" | "carousel";
};

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
  /** WhatsApp number for "Send WhatsApp message" buttons (with country code, e.g. +919812345678). */
  whatsappNumber?: string;
  /** Threads account ID shown on Threads placements. */
  threadsUserId?: string;
  /** Partnership ad: the partner's Facebook Page ID (shows "Paid partnership"; the Page needs a linked Instagram account). */
  sponsorPageId?: string;
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
  copy_override?: string | null;
  angle?: string | null;
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
  meta_post_id?: string | null;
  meta_ig_media_id?: string | null;
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
  /** existing: into the chosen ad set · new_per_ad: a copy of it per ad · new_shared: one copy for all the ads */
  adset_mode: "existing" | "new_per_ad" | "new_shared";
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
  go_live: "paused" | "now" | "at";
  go_live_at: string | null;
  go_live_done: number;
  persona: string;
  group_key: string | null;
  cancel_requested: number;
  extra_adsets: string;
  shared_adset_id: string | null;
  /** ISO time Stop was pressed (this batch or one launched with it); a Retry after it needs a fresh turn-on confirmation. */
  stopped_at: string | null;
  /** ISO time Retry was last pressed. */
  retried_at: string | null;
  /** The total daily budget typed at launch ("₹1,500"), for go-live "now" / "at a time"; null otherwise. */
  go_live_total: string | null;
  /** ISO time the typed total was worked out for: lifetime budgets are compared per day from then. */
  go_live_total_at: string | null;
  /** "Now": a Retry came more than an hour after the run before it ended (that end time). The yes given
   *  at launch then no longer turns the ads on by itself (kept, also after later Retries). */
  late_retry_from: string | null;
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
