import { createHash } from "node:crypto";
import type { MetaClient } from "../meta/client";
import { mustSurface } from "../meta/errors";

// Custom audiences and lookalikes, made inside a plan (so a later step can use them as "$ref").
// Meta fills a new audience over the next hours; it can be used in ad sets straight away.
// Meta's rule: the ad account must have accepted the Custom Audience terms once
// (Ads Manager → Audiences); otherwise Meta refuses and the launcher says so.

export type AudienceSource =
  | { kind: "website"; pixel_id: string; days: number; url_contains?: string[]; event?: string }
  | { kind: "video"; video_ids: string[]; days: number; watched?: "3s" | "thruplay" | "25%" | "50%" | "75%" | "95%" }
  | { kind: "page"; page_id: string; days: number; engaged?: "all" | "messaged" | "cta_clicked" }
  | { kind: "instagram"; instagram_id: string; days: number; engaged?: "all" | "messaged" | "visited" }
  | { kind: "lead_form"; page_id: string; days: number; action?: "opened" | "submitted" | "opened_not_submitted" }
  | { kind: "customer_list"; emails?: string[]; phones?: string[]; /** Filled by the launcher: SHA-256 of each normalised email / phone. */ hashed?: { schema: ("EMAIL" | "PHONE")[]; rows: string[][] } };

export type AudienceOp =
  | { type: "create_custom_audience"; ref?: string; name: string; description?: string; source: AudienceSource }
  | { type: "create_lookalike"; ref?: string; name: string; source_audience: string; country: string; size_percent: number };

const VIDEO_EVENT: Record<string, string> = { "3s": "video_watched", thruplay: "video_completed", "25%": "video_view_25_percent", "50%": "video_view_50_percent", "75%": "video_view_75_percent", "95%": "video_view_95_percent" };
const PAGE_EVENT: Record<string, string> = { all: "page_engaged", messaged: "page_messaged", cta_clicked: "page_cta_clicked" };
const IG_EVENT: Record<string, string> = { all: "ig_business_profile_all", messaged: "ig_user_messaged_business", visited: "ig_business_profile_visit" };
const LEAD_EVENT: Record<string, string> = { opened: "lead_generation_opened", submitted: "lead_generation_submitted", opened_not_submitted: "lead_generation_dropoff" };

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** Meta's normalisation: emails lower-case and trimmed; phones digits only with country code (India by default). */
export function normaliseEmail(e: string): string | null {
  const v = e.trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) ? v : null;
}
export function normalisePhone(p: string): string | null {
  let d = p.replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  if (d.length === 10) d = `91${d}`;
  return d.length >= 11 && d.length <= 15 ? d : null;
}

/** Replace plain emails and phones with their hashes (done before the plan is saved, so the launcher never keeps them). */
export function hashCustomerList(src: Extract<AudienceSource, { kind: "customer_list" }>): Extract<AudienceSource, { kind: "customer_list" }> & { skipped: number } {
  if (src.hashed) return { ...src, skipped: 0 };
  const emails = (src.emails ?? []).map(normaliseEmail);
  const phones = (src.phones ?? []).map(normalisePhone);
  const rows: string[][] = [];
  let skipped = 0;
  for (const e of emails) e ? rows.push([sha(e), ""]) : skipped++;
  for (const p of phones) p ? rows.push(["", sha(p)]) : skipped++;
  return { kind: "customer_list", hashed: { schema: ["EMAIL", "PHONE"], rows }, skipped };
}

function rule(src: Exclude<AudienceSource, { kind: "customer_list" }>): Record<string, unknown> {
  const seconds = Math.round(src.days * 86400);
  switch (src.kind) {
    case "website": {
      const filters: Record<string, unknown>[] = [];
      if (src.url_contains?.length) filters.push({ operator: "or", filters: src.url_contains.map((u) => ({ field: "url", operator: "i_contains", value: u })) });
      if (src.event) filters.push({ field: "event", operator: "eq", value: src.event });
      return { inclusions: { operator: "or", rules: [{ event_sources: [{ id: src.pixel_id, type: "pixel" }], retention_seconds: seconds, ...(filters.length ? { filter: { operator: "and", filters } } : {}) }] } };
    }
    case "video":
      return { inclusions: { operator: "or", rules: [{ event_sources: src.video_ids.map((id) => ({ id, type: "video" })), retention_seconds: seconds, filter: { operator: "and", filters: [{ field: "event", operator: "eq", value: VIDEO_EVENT[src.watched ?? "3s"] }] } }] } };
    case "page":
      return { inclusions: { operator: "or", rules: [{ event_sources: [{ id: src.page_id, type: "page" }], retention_seconds: seconds, filter: { operator: "and", filters: [{ field: "event", operator: "eq", value: PAGE_EVENT[src.engaged ?? "all"] }] } }] } };
    case "instagram":
      return { inclusions: { operator: "or", rules: [{ event_sources: [{ id: src.instagram_id, type: "ig_business" }], retention_seconds: seconds, filter: { operator: "and", filters: [{ field: "event", operator: "eq", value: IG_EVENT[src.engaged ?? "all"] }] } }] } };
    case "lead_form":
      return { inclusions: { operator: "or", rules: [{ event_sources: [{ id: src.page_id, type: "lead" }], retention_seconds: seconds, filter: { operator: "and", filters: [{ field: "event", operator: "eq", value: LEAD_EVENT[src.action ?? "opened"] }] } }] } };
  }
}

const MAX_DAYS: Record<string, number> = { website: 180, video: 365, page: 365, instagram: 365, lead_form: 90 };

/** A read whose failure means "not found": Meta limiting calls or a lost login is thrown instead. */
const orNull = (e: unknown) => {
  if (mustSurface(e)) throw e;
  return null;
};

/** `nameOf`: the name of an audience this plan makes, from its "$ref" ID. */
export async function audienceSummary(client: MetaClient, op: AudienceOp, resolve: (ref: string) => Promise<string[]>, nameOf?: (id: string) => string | undefined): Promise<{ title: string; lines: string[]; errors: string[]; warnings: string[] }> {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!op.name?.trim()) errors.push("the audience needs a name.");
  if (op.type === "create_lookalike") {
    if (!/^[A-Z]{2}$/.test(op.country ?? "")) errors.push('country must be a 2-letter code, e.g. "IN".');
    if (!(op.size_percent >= 1 && op.size_percent <= 10)) errors.push("size_percent must be 1 to 10.");
    let source = op.source_audience;
    try {
      [source] = await resolve(op.source_audience);
    } catch (e) {
      errors.push((e as Error).message);
    }
    // The source said by its name (an audience of this plan, or the one Meta has), never "$web".
    let sourceName = source?.startsWith("$") ? nameOf?.(source) : undefined;
    if (source?.startsWith("$")) {
      warnings.push(`the lookalike is made from an audience this plan makes. Meta needs about 100 matched people in it first, so making the lookalike may fail until that audience has filled (often a few hours); if it fails, press Retry later.`);
    }
    if (source && !source.startsWith("$")) {
      const a = await client.get<{ name?: string; approximate_count_lower_bound?: number }>(source, { fields: "name,approximate_count_lower_bound" }).catch(orNull);
      if (a?.name) sourceName = a.name;
      if (!a) errors.push(`audience ${source} not found in this ad account.`);
      else if ((a.approximate_count_lower_bound ?? 0) > 0 && (a.approximate_count_lower_bound ?? 0) < 100) errors.push(`"${a.name}" has fewer than 100 people; Meta needs at least 100 to make a lookalike.`);
    }
    return { title: `Create lookalike "${op.name}"`, lines: [`${op.size_percent}% of people in ${op.country} most like audience ${sourceName ? `"${sourceName}"` : source && !source.startsWith("$") ? source : "made in this plan"}. Meta takes up to a few hours to fill it.`], errors, warnings };
  }
  const s = op.source;
  if (!s) return { title: `Create audience "${op.name}"`, lines: [], errors: [...errors, "give source (website, video, page, instagram, lead_form or customer_list)."], warnings };
  if (s.kind === "customer_list") {
    const rows = s.hashed?.rows.length ?? (s.emails?.length ?? 0) + (s.phones?.length ?? 0);
    if (!rows) errors.push("the customer list is empty.");
    const skipped = Number((op as { skipped_rows?: number }).skipped_rows ?? 0);
    const skippedLine = skipped ? ` ${skipped} row${skipped === 1 ? " was" : "s were"} skipped: not an email address or a phone number with country code.` : "";
    return { title: `Create customer list audience "${op.name}"`, lines: [`${rows} email address${rows === 1 ? "" : "es"} and phone number${rows === 1 ? "" : "s"}, sent to Meta hashed (the launcher keeps only the hashes) in parts of up to 10,000. Meta matches them to accounts over the next hours.${skippedLine}`], errors, warnings };
  }
  if (!(s.days >= 1 && s.days <= (MAX_DAYS[s.kind] ?? 365))) errors.push(`days must be 1 to ${MAX_DAYS[s.kind] ?? 365} for this kind of audience.`);
  const what: Record<string, string> = {
    website: `People who visited the website with pixel ${(s as { pixel_id?: string }).pixel_id}${(s as { url_contains?: string[] }).url_contains?.length ? ` on pages containing ${(s as { url_contains: string[] }).url_contains.join(" or ")}` : ""}${(s as { event?: string }).event ? `, event ${(s as { event: string }).event}` : ""}`,
    video: `People who watched ${(s as { watched?: string }).watched ?? "3 seconds"} of ${(s as { video_ids?: string[] }).video_ids?.length ?? 0} video(s)`,
    page: `People who engaged with Facebook Page ${(s as { page_id?: string }).page_id}`,
    instagram: `People who engaged with Instagram account ${(s as { instagram_id?: string }).instagram_id}`,
    lead_form: `People who ${((s as { action?: string }).action ?? "opened").replace(/_/g, " ")} a lead form on Page ${(s as { page_id?: string }).page_id}`,
  };
  if (s.kind === "website") {
    if (!s.pixel_id) errors.push("give pixel_id (lookup pixels lists them).");
    else {
      const px = await client.get<{ id: string; name?: string; last_fired_time?: string }>(s.pixel_id, { fields: "id,name,last_fired_time" }).catch(orNull);
      if (!px) errors.push(`pixel ${s.pixel_id} not found in this ad account.`);
      else if (!px.last_fired_time) errors.push(`pixel "${px.name}" has never fired, so this audience would stay empty.`);
    }
  }
  if (s.kind === "video" && !s.video_ids?.length) errors.push("give video_ids.");
  return { title: `Create audience "${op.name}"`, lines: [`${what[s.kind]} in the last ${s.days} day${s.days === 1 ? "" : "s"}. Meta takes up to a few hours to fill it.`], errors, warnings };
}

export async function createAudience(client: MetaClient, op: AudienceOp, idemKey: string): Promise<string> {
  const act = client.accountId;
  if (op.type === "create_lookalike") {
    const r = await client.post<{ id: string }>(`${act}/customaudiences`, {
      name: op.name,
      subtype: "LOOKALIKE",
      origin_audience_id: op.source_audience,
      lookalike_spec: { type: "similarity", ratio: op.size_percent / 100, country: op.country },
    }, { idempotencyKey: idemKey });
    return r.id;
  }
  const s = op.source;
  if (s.kind === "customer_list") {
    // Only the (empty) audience: the plan uploads the rows in parts, each part tracked on its own
    // (customerChunks / uploadCustomerChunk), so a retry finishes the upload.
    const r = await client.post<{ id: string }>(`${act}/customaudiences`, { name: op.name, description: op.description, subtype: "CUSTOM", customer_file_source: "USER_PROVIDED_ONLY" }, { idempotencyKey: idemKey });
    return r.id;
  }
  const r = await client.post<{ id: string }>(`${act}/customaudiences`, { name: op.name, description: op.description, rule: rule(s), prefill: true }, { idempotencyKey: idemKey });
  return r.id;
}

/** Meta takes up to 10,000 rows per request. */
export const CUSTOMER_CHUNK = 10_000;

/** The hashed rows of a customer list, in parts Meta takes in one request. */
export function customerChunks(src: Extract<AudienceSource, { kind: "customer_list" }>): { schema: ("EMAIL" | "PHONE")[]; parts: string[][][] } {
  const h = src.hashed ?? hashCustomerList(src).hashed!;
  const parts: string[][][] = [];
  for (let i = 0; i < h.rows.length; i += CUSTOMER_CHUNK) parts.push(h.rows.slice(i, i + CUSTOMER_CHUNK));
  return { schema: h.schema, parts };
}

/** Send one part of a customer list. Sending the same part again is harmless (Meta matches each person once). */
export async function uploadCustomerChunk(client: MetaClient, audienceId: string, schema: string[], rows: string[][]): Promise<number> {
  const r = await client.post<{ num_received?: number }>(`${audienceId}/users`, { payload: { schema, data: rows } });
  return r.num_received ?? rows.length;
}
