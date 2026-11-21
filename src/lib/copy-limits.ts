// Meta's text limits for ad copy (docs/META-API-NOTES.md: body ≤1024, title and description ≤255).
// Used by the preview checks and when copy is saved (Claude's set_ad_copy and save_copy_template), so
// copy over a limit is flagged the moment it is set, not first on launch day. No database here: the
// Claude extension bundles this file too.

export const TEXT_LIMITS = {
  primaryTextSoft: 125,
  primaryTextHard: 1024,
  headlineSoft: 40,
  headlineHard: 255,
  descriptionSoft: 30,
  descriptionHard: 255,
};

/** The texts over Meta's hard limits, in plain words ("primary text 2 is 1,140 characters; Meta's limit is 1,024"). */
export function overLimit(c: { primaryTexts?: string[]; headlines?: string[]; descriptions?: string[] }): string[] {
  const out: string[] = [];
  const check = (label: string, list: string[] | undefined, hard: number) =>
    (list ?? []).forEach((t, i) => {
      const n = String(t ?? "").length; // counted as the preview counts (its errors and these warnings agree)
      if (n > hard) out.push(`${label}${(list?.length ?? 0) > 1 ? ` ${i + 1}` : ""} is ${n.toLocaleString("en-IN")} characters; Meta's limit is ${hard.toLocaleString("en-IN")}`);
    });
  check("primary text", c.primaryTexts, TEXT_LIMITS.primaryTextHard);
  check("headline", c.headlines, TEXT_LIMITS.headlineHard);
  check("description", c.descriptions, TEXT_LIMITS.descriptionHard);
  return out;
}
