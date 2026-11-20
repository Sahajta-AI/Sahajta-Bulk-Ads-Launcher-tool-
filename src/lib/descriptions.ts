// An ad has up to 5 descriptions (the line under the headline), like its primary texts and headlines.
// Until 20 Nov 2026 an ad had one `description` string. Copies saved before then (batches, per-ad
// copy, files that remember their copy, plan steps) still have that field, and Claude may still send
// it, so every read and every input goes through these helpers.

export const MAX_DESCRIPTIONS = 5;

const clean = (list: unknown[]): string[] => list.map((x) => (typeof x === "string" ? x.trim() : String(x ?? "").trim())).filter(Boolean);

/**
 * The descriptions given in an object: `descriptions` (a list, or one string), else the old
 * `description` (one string). undefined = neither field given; [] = given empty (clears).
 */
export function descriptionsIn(o: unknown): string[] | undefined {
  if (!o || typeof o !== "object") return undefined;
  const r = o as { descriptions?: unknown; description?: unknown };
  if (r.descriptions !== undefined && r.descriptions !== null) return clean(Array.isArray(r.descriptions) ? r.descriptions : [r.descriptions]);
  if (r.description !== undefined && r.description !== null) return clean([r.description]);
  if (r.descriptions === null || r.description === null) return [];
  return undefined;
}

/** The same object with the old `description` turned into `descriptions` (absent stays absent). */
export function withDescriptions<T extends object>(o: T): Omit<T, "description"> & { descriptions?: string[] } {
  const list = descriptionsIn(o);
  const { description: _old, ...rest } = o as T & { description?: unknown };
  return list === undefined ? (rest as Omit<T, "description">) : { ...(rest as Omit<T, "description">), descriptions: list };
}

/** Error text when there are more than 5, or "" when the list is fine. */
export function tooManyDescriptions(list: string[] | undefined): string {
  return (list?.length ?? 0) > MAX_DESCRIPTIONS ? `Up to ${MAX_DESCRIPTIONS} descriptions (${list!.length} given).` : "";
}
