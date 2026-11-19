// Meta's review and delivery problems in plain words. Shared by the batch review check (launcher.ts)
// and the delivery tab (delivery.ts), so both read the same.
//
// ad_review_feedback has a "global" section ({ policy: text }) and a "placement_specific" section
// ({ instagram: { policy: text }, facebook: { ... } }), one level deeper. issues_info lists delivery issues.

export type Issue = { error_summary?: string; error_message?: string; level?: string };

const PLACES: Record<string, string> = {
  facebook: "Facebook",
  instagram: "Instagram",
  audience_network: "Audience Network",
  messenger: "Messenger",
  threads: "Threads",
  whatsapp: "WhatsApp",
};

const place = (k: string) => PLACES[k] ?? k.replace(/_/g, " ");

function text(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(text).filter(Boolean).join("; ");
  if (typeof v === "object") return Object.entries(v as Record<string, unknown>).map(([k, x]) => `${k}: ${text(x)}`).join("; ");
  return "";
}

/** Every problem Meta reports for an ad or ad set, one plain line each, without repeats. */
export function feedbackLines(r: { issues_info?: Issue[]; ad_review_feedback?: Record<string, unknown> }): string[] {
  const out: string[] = [];
  for (const i of r.issues_info ?? []) {
    const line = [i.error_summary, i.error_message].filter(Boolean).join(": ");
    if (line) out.push(line);
  }
  for (const [section, value] of Object.entries(r.ad_review_feedback ?? {})) {
    if (!value || typeof value !== "object") {
      const t = text(value);
      if (t) out.push(t);
      continue;
    }
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (section === "placement_specific" && v && typeof v === "object" && !Array.isArray(v)) {
        for (const [policy, why] of Object.entries(v as Record<string, unknown>)) out.push(`${place(k)} – ${policy}: ${text(why)}`);
      } else if (section === "placement_specific") {
        out.push(`${place(k)}: ${text(v)}`);
      } else {
        out.push(`${k}: ${text(v)}`);
      }
    }
  }
  return [...new Set(out)];
}
