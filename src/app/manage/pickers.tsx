"use client";

// Pickers that read lists from Meta through /api/manage/lookup: saved audiences, pixels,
// custom audiences, pages (loaded once), and searches for interests and locations.

import { useEffect, useRef, useState } from "react";
import { api } from "../client-api";
import s from "./manage.module.css";

export interface LookupItem {
  id?: string;
  key?: string;
  name: string;
  type?: string;
  region?: string;
  country_name?: string;
  country_code?: string;
  subtype?: string;
}

export const itemId = (i: LookupItem) => String(i.id ?? i.key ?? "");

export function itemLabel(i: LookupItem): string {
  if (i.type && i.key) {
    const where = [i.region, i.country_name].filter((x) => x && x !== i.name).join(", ");
    return `${i.name}${where ? `, ${where}` : ""} (${i.type})`;
  }
  return i.name || itemId(i);
}

const cache = new Map<string, Promise<LookupItem[]>>();

function loadList(what: string): Promise<LookupItem[]> {
  let p = cache.get(what);
  if (!p) {
    p = api<{ items: LookupItem[] }>(`/api/manage/lookup?what=${what}`).then((r) => r.items ?? []);
    p.catch(() => cache.delete(what));
    cache.set(what, p);
  }
  return p;
}

/** A list that loads once (saved audiences, pixels, custom conversions, custom audiences, pages). */
export function useLookupList(what: string) {
  const [items, setItems] = useState<LookupItem[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    loadList(what)
      .then((x) => live && setItems(x))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [what]);
  return { items, error };
}

/** One choice from a list, e.g. a pixel. Value is the item's id ("" = none). */
export function ListSelect({ what, value, onChange, none = "None" }: { what: string; value: string; onChange: (v: string) => void; none?: string }) {
  const { items, error } = useLookupList(what);
  return (
    <>
      <select value={value} onChange={(e) => onChange(e.target.value)} disabled={!items}>
        <option value="">{items ? none : error ? "Could not load the list" : "Loading…"}</option>
        {items?.map((i) => (
          <option key={itemId(i)} value={itemId(i)}>{itemLabel(i)}</option>
        ))}
      </select>
      {error && <small style={{ color: "var(--err)" }}>{error}</small>}
    </>
  );
}

function Tags({ picked, onRemove }: { picked: LookupItem[]; onRemove: (id: string) => void }) {
  if (!picked.length) return null;
  return (
    <div className={s.picked}>
      {picked.map((p) => (
        <span key={itemId(p)} className={s.tag}>
          {itemLabel(p)}
          <button type="button" aria-label={`Remove ${p.name}`} onClick={() => onRemove(itemId(p))}>×</button>
        </span>
      ))}
    </div>
  );
}

/** Several choices from a list, e.g. custom audiences. */
export function ListMulti({ what, picked, onChange }: { what: string; picked: LookupItem[]; onChange: (v: LookupItem[]) => void }) {
  const { items, error } = useLookupList(what);
  const left = (items ?? []).filter((i) => !picked.some((p) => itemId(p) === itemId(i)));
  return (
    <>
      <select
        value=""
        disabled={!items}
        onChange={(e) => {
          const it = items?.find((i) => itemId(i) === e.target.value);
          if (it) onChange([...picked, it]);
        }}
      >
        <option value="">{items ? (left.length ? "Add one…" : "Nothing more to add") : error ? "Could not load the list" : "Loading…"}</option>
        {left.map((i) => (
          <option key={itemId(i)} value={itemId(i)}>{itemLabel(i)}</option>
        ))}
      </select>
      {error && <small style={{ color: "var(--err)" }}>{error}</small>}
      <Tags picked={picked} onRemove={(id) => onChange(picked.filter((p) => itemId(p) !== id))} />
    </>
  );
}

/** Search Meta as you type (interests, locations) and pick several. */
export function SearchMulti({ what, picked, onChange, placeholder }: { what: "interests" | "locations"; picked: LookupItem[]; onChange: (v: LookupItem[]) => void; placeholder: string }) {
  const [q, setQ] = useState("");
  const [found, setFound] = useState<LookupItem[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (q.trim().length < 2) {
      setFound([]);
      return;
    }
    timer.current = setTimeout(async () => {
      setLoading(true);
      setError("");
      try {
        const r = await api<{ items: LookupItem[] }>(`/api/manage/lookup?what=${what}&q=${encodeURIComponent(q.trim())}`);
        setFound(r.items ?? []);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    }, 400);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [q, what]);

  const left = found.filter((i) => !picked.some((p) => itemId(p) === itemId(i)));
  return (
    <>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder} />
      {loading && <small>Searching…</small>}
      {error && <small style={{ color: "var(--err)" }}>{error}</small>}
      {left.length > 0 && (
        <div className={s.results}>
          {left.map((i) => (
            <button
              type="button"
              key={itemId(i)}
              onClick={() => {
                onChange([...picked, i]);
                setQ("");
              }}
            >
              {itemLabel(i)}
            </button>
          ))}
        </div>
      )}
      <Tags picked={picked} onRemove={(id) => onChange(picked.filter((p) => itemId(p) !== id))} />
    </>
  );
}
