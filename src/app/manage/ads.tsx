"use client";

// The ads inside one ad set: read them from Meta, and turn them on or off, copy them into other
// ad sets, edit them, or rename several at once. Every action becomes a plan to check first.
// Ads are never deleted: turning off is the only way to stop one.

import { useCallback, useEffect, useState } from "react";
import type { Op } from "@/lib/manage/plan";
import type { AdEditSpec } from "@/lib/manage/ads";
import { CTA_TYPES } from "@/lib/manage/cta";
import { api } from "../client-api";
import { msgClass } from "../msg";
import { AdSetChecklist, FormBox, Select } from "./forms";
import s from "./manage.module.css";
import { metaPill, type PlanInput, type Tree, type TreeAdSet } from "./util";

export interface AdRow {
  id: string;
  name: string;
  status: string;
  effectiveStatus: string;
  fromPost: boolean;
  postId: string | null;
  instagramMediaId: string | null;
  primaryTexts: string[];
  headlines: string[];
  descriptions?: string[];
  link: string | null;
  button?: string | null;
  utmTags?: string | null;
  tracking?: { pixels: { id: string; name: string | null }[]; offline: { id: string; name: string | null }[] };
  files?: { kind: "image" | "video"; id: string; name: string | null }[];
}

type AdOpen = { kind: "copy" | "edit"; id: string } | { kind: "rename" } | null;

const CTA_LABEL: Record<string, string> = { WHATSAPP_MESSAGE: "WhatsApp message", NO_BUTTON: "No button" };
const CTA_LIST = CTA_TYPES.map((v) => ({ value: v, label: CTA_LABEL[v] ?? v.charAt(0) + v.slice(1).replace(/_/g, " ").toLowerCase() }));

const short = (t: string, n = 140) => (t.length > n ? `${t.slice(0, n)}…` : t);

export function AdsList({ adset, tree, submit, busy, quick }: {
  adset: TreeAdSet;
  tree: Tree;
  submit: (input: PlanInput) => Promise<void>;
  busy: string;
  quick: (id: string, input: PlanInput) => Promise<void>;
}) {
  const [ads, setAds] = useState<AdRow[] | null>(null);
  const [cutNote, setCutNote] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<AdOpen>(null);
  const [selected, setSelected] = useState<string[]>([]);

  const load = useCallback(async () => {
    setError("");
    try {
      const r = await api<{ ads: AdRow[]; truncated?: boolean; note?: string | null }>(`/api/manage/ads?adset=${encodeURIComponent(adset.id)}`);
      setAds(r.ads);
      setCutNote(r.truncated ? r.note || `Only the first ${r.ads.length} ads of this ad set are listed.` : null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [adset.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleOpen = (o: AdOpen) => setOpen((cur) => (cur && o && JSON.stringify(cur) === JSON.stringify(o) ? null : o));
  const renaming = open?.kind === "rename";

  if (error) {
    return (
      <div className={s.ads}>
        <div className={msgClass(error)}>Could not read the ads: {error}</div>
        <button className="link" onClick={() => void load()}>Try again</button>
      </div>
    );
  }
  if (!ads) return <div className={s.ads}><p className="muted" style={{ margin: 0 }}>Reading the ads from Meta…</p></div>;
  if (!ads.length) return <div className={s.ads}><p className="muted" style={{ margin: 0 }}>No ads in this ad set yet.</p></div>;

  return (
    <div className={s.ads}>
      <div className={s.actions} style={{ marginTop: 0, marginBottom: 4 }}>
        <small style={{ flex: 1 }}>{ads.length} ad{ads.length === 1 ? "" : "s"}{cutNote ? ` · ${cutNote}` : ""}</small>
        {ads.length > 1 && (
          <button className="link" onClick={() => { toggleOpen({ kind: "rename" }); setSelected([]); }}>{renaming ? "Stop renaming" : "Rename several"}</button>
        )}
      </div>
      {renaming && <p className="hint" style={{ marginTop: 0 }}>Tick the ads to rename, then set the name pattern below the list.</p>}

      {ads.map((ad) => {
        const pill = metaPill(ad.effectiveStatus);
        const on = ad.status === "ACTIVE";
        return (
          <div key={ad.id} className={s.ad}>
            <div className={s.title}>
              {renaming && (
                <input
                  type="checkbox"
                  aria-label={`Rename ${ad.name}`}
                  className={s.tick}
                  checked={selected.includes(ad.id)}
                  onChange={(e) => setSelected(e.target.checked ? [...selected, ad.id] : selected.filter((x) => x !== ad.id))}
                />
              )}
              <span className={s.adName}>{ad.name}</span>
              <span className={`status ${pill.cls}`}>{pill.label}</span>
            </div>
            {ad.primaryTexts[0] && <div className={s.adText}><span className="muted">Text:</span> {short(ad.primaryTexts[0])}{ad.primaryTexts.length > 1 ? <span className="muted"> (+{ad.primaryTexts.length - 1} more)</span> : null}</div>}
            {ad.headlines[0] && <div className={s.adText}><span className="muted">Headline:</span> {ad.headlines[0]}{ad.headlines.length > 1 ? <span className="muted"> (+{ad.headlines.length - 1} more)</span> : null}</div>}
            {!!ad.descriptions?.length && <div className={s.adText}><span className="muted">Description:</span> {ad.descriptions[0]}{ad.descriptions.length > 1 ? <span className="muted"> (+{ad.descriptions.length - 1} more)</span> : null}</div>}
            {(ad.button || !!ad.files?.length) && (
              <div className={s.adText}>
                {ad.button && <><span className="muted">Button:</span> {CTA_LIST.find((c) => c.value === ad.button)?.label ?? ad.button.replace(/_/g, " ").toLowerCase()}{ad.files?.length ? " · " : ""}</>}
                {!!ad.files?.length && <><span className="muted">File:</span> {ad.files.map((f) => f.name ?? `${f.kind} ${f.id}`).join(", ")}</>}
              </div>
            )}
            {ad.link && <div className={s.adText}><span className="muted">Link:</span> <a href={ad.link} target="_blank" rel="noopener noreferrer">{short(ad.link, 80)}</a></div>}
            {ad.utmTags && <div className={s.adText}><span className="muted">UTM tags:</span> {short(ad.utmTags, 120)}</div>}
            {ad.tracking && (
              <div className={s.adText}>
                <span className="muted">Tracking:</span> website pixel {ad.tracking.pixels.map((p) => p.name ?? p.id).join(", ") || "none"} · offline event sets {ad.tracking.offline.map((p) => p.name ?? p.id).join(", ") || "none"}
              </div>
            )}
            {(ad.postId || ad.instagramMediaId) && (
              <div className={s.idLine}>
                {ad.postId && <CopyId label="Post ID" value={ad.postId} />}
                {ad.instagramMediaId && <CopyId label="Instagram media ID" value={ad.instagramMediaId} />}
              </div>
            )}
            {!renaming && (
              <div className={s.actions} style={{ marginTop: 8 }}>
                <button
                  className={on ? "danger" : undefined}
                  disabled={!!busy}
                  onClick={() => void quick(ad.id, { title: `Turn ${on ? "off" : "on"} ad "${ad.name}"`, ops: [{ type: "set_status", status: on ? "PAUSED" : "ACTIVE", ads: [ad.id] }] })}
                >
                  {busy === ad.id ? "Checking…" : on ? "Turn off" : "Turn on"}
                </button>
                <button onClick={() => toggleOpen({ kind: "copy", id: ad.id })}>Copy to ad sets</button>
                <button onClick={() => toggleOpen({ kind: "edit", id: ad.id })}>Edit</button>
              </div>
            )}
            {open?.kind === "copy" && open.id === ad.id && <CopyAdForm ad={ad} tree={tree} submit={submit} close={() => setOpen(null)} />}
            {open?.kind === "edit" && open.id === ad.id && <EditAdForm ad={ad} submit={submit} close={() => setOpen(null)} />}
          </div>
        );
      })}

      {renaming && <RenameForm adset={adset} ads={ads.filter((a) => selected.includes(a.id))} submit={submit} close={() => setOpen(null)} />}
    </div>
  );
}

/** A small ID people can select or copy with one tap. */
function CopyId({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className={s.copyId}>
      {label}: <code>{value}</code>
      <button
        type="button"
        className="link"
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </span>
  );
}

function CopyAdForm({ ad, tree, submit, close }: { ad: AdRow; tree: Tree; submit: (input: PlanInput) => Promise<void>; close: () => void }) {
  const [picked, setPicked] = useState<string[]>([]);
  return (
    <FormBox
      title={`Copy ad "${ad.name}" to other ad sets`}
      close={close}
      hint="The copies use the same creative, so a post's likes and comments add up. Copies are made switched off."
      onSubmit={async () => {
        if (!picked.length) throw new Error("Tick at least one ad set.");
        await submit({ title: `Copy ad "${ad.name}" into ${picked.length} ad set${picked.length > 1 ? "s" : ""}`, ops: [{ type: "copy_ad", ad: ad.id, adsets: picked }] });
      }}
    >
      <AdSetChecklist tree={tree} picked={picked} setPicked={setPicked} />
    </FormBox>
  );
}

function EditAdForm({ ad, submit, close }: { ad: AdRow; submit: (input: PlanInput) => Promise<void>; close: () => void }) {
  const [name, setName] = useState(ad.name);
  const [texts, setTexts] = useState<string[]>(ad.primaryTexts.length ? ad.primaryTexts : [""]);
  const [heads, setHeads] = useState(ad.headlines.join("\n"));
  const [descs, setDescs] = useState((ad.descriptions ?? []).join("\n"));
  const [link, setLink] = useState(ad.link ?? "");
  const [display, setDisplay] = useState("");
  const [cta, setCta] = useState("");
  const [utm, setUtm] = useState("");
  const [media, setMedia] = useState("");
  const same = (a: string[], b: string[]) => JSON.stringify(a.map((x) => x.trim())) === JSON.stringify(b.map((x) => x.trim()));

  return (
    <FormBox
      title={`Edit ad "${ad.name}"`}
      close={close}
      hint={ad.fromPost ? undefined : "A change to the text, link, button or file makes a new creative for the ad, and Meta reviews the ad again. Ads Manager keeps its results. Nothing changes until you confirm the plan."}
      onSubmit={async () => {
        const e: AdEditSpec = {};
        if (name.trim() && name.trim() !== ad.name) e.name = name.trim();
        if (!ad.fromPost) {
          const pt = texts.map((t) => t.trim()).filter(Boolean);
          if (!same(pt, ad.primaryTexts)) {
            if (!pt.length) throw new Error("Keep at least one primary text.");
            if (pt.length > 5) throw new Error("Up to 5 primary texts.");
            e.primary_texts = pt;
          }
          const hl = heads.split("\n").map((t) => t.trim()).filter(Boolean);
          if (!same(hl, ad.headlines)) {
            if (!hl.length) throw new Error("Keep at least one headline.");
            if (hl.length > 5) throw new Error("Up to 5 headlines, one per line.");
            e.headlines = hl;
          }
          const ds = descs.split("\n").map((t) => t.trim()).filter(Boolean);
          if (!same(ds, ad.descriptions ?? [])) {
            if (ds.length > 5) throw new Error("Up to 5 descriptions, one per line.");
            e.descriptions = ds;
          }
          if (link.trim() && link.trim() !== (ad.link ?? "")) {
            if (!/^https?:\/\//i.test(link.trim())) throw new Error("The link must start with https://");
            e.link_url = link.trim();
          }
          if (display.trim()) e.display_link = display.trim();
          if (cta) e.cta = cta;
          if (utm.trim()) e.url_tags = utm.trim().replace(/^\?/, "");
          if (media.trim()) {
            if (!/(drive|docs)\.google\.com/i.test(media)) throw new Error("Paste a Google Drive file link, like https://drive.google.com/file/d/…");
            e.media_url = media.trim();
          }
        }
        if (!Object.keys(e).length) throw new Error("Nothing was changed.");
        const op: Op = { type: "edit_ad", ad: ad.id, ...e };
        await submit({ title: `Edit ad "${ad.name}"`, ops: [op] });
      }}
    >
      <div className="row">
        <label><span>Ad name</span><input value={name} onChange={(e) => setName(e.target.value)} /></label>
      </div>
      {ad.fromPost ? (
        <div className="msg info">This ad runs an existing post, so its text and file can’t change. Only the name can change here.</div>
      ) : (
        <>
          <div className={s.section}>Primary text (up to 5)</div>
          {texts.map((t, i) => (
            <div key={i} style={{ marginBottom: 8 }}>
              <textarea rows={3} value={t} onChange={(e) => setTexts(texts.map((x, j) => (j === i ? e.target.value : x)))} placeholder={`Primary text ${i + 1}`} />
              {texts.length > 1 && <button type="button" className="link" onClick={() => setTexts(texts.filter((_, j) => j !== i))}>Remove this text</button>}
            </div>
          ))}
          {texts.length < 5 && <button type="button" className="link" style={{ marginBottom: 12 }} onClick={() => setTexts([...texts, ""])}>+ Add another text</button>}
          <div className="row">
            <label className="field">
              <span>Headlines (up to 5, one per line)</span>
              <textarea rows={3} value={heads} onChange={(e) => setHeads(e.target.value)} />
            </label>
          </div>
          <div className="row">
            <label className="field">
              <span>Descriptions (up to 5, one per line; empty removes them)</span>
              <textarea rows={3} value={descs} onChange={(e) => setDescs(e.target.value)} />
            </label>
          </div>
          <p className="hint" style={{ marginTop: -6, marginBottom: 12 }}>Several texts, headlines or descriptions work only on ads that already have several (Meta refuses them on others, and the plan says so).</p>
          <div className="row">
            <label><span>Button</span><Select value={cta} onChange={setCta} list={CTA_LIST} blank="Keep as it is" /></label>
          </div>
          <div className="row">
            <label><span>Link</span><input type="url" value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://" /></label>
            <label><span>Display link (blank = keep)</span><input value={display} onChange={(e) => setDisplay(e.target.value)} placeholder="e.g. yoursite.com" /></label>
          </div>
          <div className="row">
            <label><span>UTM tags (blank = keep)</span><input value={utm} onChange={(e) => setUtm(e.target.value)} placeholder="utm_source=facebook&utm_campaign={{campaign.name}}" /></label>
          </div>
          <div className="row">
            <label><span>Swap the file: Google Drive file link (blank = keep)</span><input type="url" value={media} onChange={(e) => setMedia(e.target.value)} placeholder="https://drive.google.com/file/d/…" /></label>
          </div>
          <p className="hint" style={{ marginTop: -6 }}>An image ad needs an image, a video ad needs a video.</p>
        </>
      )}
    </FormBox>
  );
}

/** "{adset}_{n}" → "Mumbai_25-45_01", "Mumbai_25-45_02", … in the order the ads are listed; {n:1} → 1, 2, …; {n:3} → 001, 002, … */
export function renderName(pattern: string, adsetName: string, i: number, count: number): string {
  const n = (width: number) => String(i + 1).padStart(width, "0");
  return pattern
    .split("{adset}").join(adsetName)
    .replace(/\{n:([1-6])\}/g, (_, w: string) => n(Number(w)))
    .split("{n}").join(n(Math.max(2, String(count).length)))
    .trim();
}

function RenameForm({ adset, ads, submit, close }: { adset: TreeAdSet; ads: AdRow[]; submit: (input: PlanInput) => Promise<void>; close: () => void }) {
  const [pattern, setPattern] = useState("{adset}_{n}");
  const names = ads.map((a, i) => renderName(pattern, adset.name, i, ads.length));
  return (
    <FormBox
      title={`Rename ${ads.length || "several"} ad${ads.length === 1 ? "" : "s"}`}
      close={close}
      onSubmit={async () => {
        if (!ads.length) throw new Error("Tick the ads to rename.");
        if (!pattern.trim()) throw new Error("Type a name pattern, like {adset}_{n}.");
        if (ads.length > 1 && !/\{n(:[1-6])?\}/.test(pattern)) throw new Error("Add {n} (or {n:1}) to the pattern so each ad gets its own name.");
        if (names.some((n) => !n)) throw new Error("The pattern makes an empty name.");
        const ops: Op[] = ads.map((a, i) => ({ type: "edit_ad", ad: a.id, name: names[i] }));
        await submit({ title: `Rename ${ads.length} ad${ads.length === 1 ? "" : "s"} in "${adset.name}"`, ops });
      }}
    >
      <div className="row">
        <label><span>Name pattern</span><input value={pattern} onChange={(e) => setPattern(e.target.value)} /></label>
      </div>
      <p className="hint" style={{ marginTop: -6, marginBottom: 8 }}>
        <code>{"{adset}"}</code> = the ad set name, <code>{"{n}"}</code> = 01, 02, 03… in the order shown above (<code>{"{n:1}"}</code> = 1, 2, 3…).
      </p>
      {ads.length > 0 ? (
        <ul className={s.stepLines}>
          {ads.map((a, i) => <li key={a.id}>{a.name} → <strong style={{ fontWeight: 600 }}>{names[i]}</strong></li>)}
        </ul>
      ) : (
        <p className="muted" style={{ margin: 0 }}>No ads ticked yet.</p>
      )}
    </FormBox>
  );
}
