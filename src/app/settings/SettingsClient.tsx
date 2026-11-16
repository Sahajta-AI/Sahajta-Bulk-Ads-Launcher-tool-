"use client";

import { useCallback, useEffect, useState } from "react";
import { renderName } from "@/lib/engine/naming";
import type { Templates } from "../batches/[key]/BatchClient";
import { api } from "../client-api";
import MetaTab from "./MetaTab";

type FullTemplates = Templates & { features: { key: string; label: string }[] };
type CopyT = Templates["copy"][number];
type PresetT = Templates["presets"][number] & { enhancements?: Record<string, string> };

interface Status {
  account: string | null;
  tokenSet: boolean;
  mock: boolean;
  apiVersion: string;
  tier: string;
  worker: string;
  appUrl: string;
}

const TABS = [
  ["meta", "Meta"],
  ["copy", "Copy"],
  ["naming", "Names"],
  ["presets", "Ad presets"],
  ["claude", "Claude"],
  ["status", "Status"],
] as const;

function CopyEditor({ t, ctas, onSaved, onCancel }: { t: Partial<CopyT>; ctas: string[]; onSaved: () => void; onCancel: () => void }) {
  const pad = (a?: string[]) => [...(a ?? []), "", "", "", "", ""].slice(0, 5);
  const [name, setName] = useState(t.name ?? "");
  const [texts, setTexts] = useState(pad(t.primaryTexts));
  const [heads, setHeads] = useState(pad(t.headlines));
  const [desc, setDesc] = useState(t.description ?? "");
  const [cta, setCta] = useState(t.cta ?? "LEARN_MORE");
  const [link, setLink] = useState(t.linkUrl ?? "");
  const [utm, setUtm] = useState(t.utmTemplate ?? "utm_source=meta&utm_medium=paid&utm_campaign={campaign}&utm_content={creative}");
  const [error, setError] = useState("");

  async function save() {
    try {
      await api("/api/templates", { method: "POST", body: { kind: "copy", id: t.id, name, primaryTexts: texts, headlines: heads, description: desc, cta, linkUrl: link, utmTemplate: utm } });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="panel">
      <label className="field"><span>Template name</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Site-visit copy" /></label>
      <div className="grid2" style={{ marginTop: 10 }}>
        <div>
          <small>Primary texts (up to 5; Meta rotates them)</small>
          {texts.map((x, i) => (
            <div key={i}>
              <textarea rows={2} value={x} onChange={(e) => setTexts(texts.map((y, j) => (j === i ? e.target.value : y)))} style={{ marginBottom: 2 }} />
              {x.length > 125 && <small style={{ color: "var(--warn)" }}>{x.length} characters; over 125 gets cut off with "See more"</small>}
            </div>
          ))}
        </div>
        <div>
          <small>Headlines (up to 5)</small>
          {heads.map((x, i) => (
            <div key={i}>
              <input value={x} onChange={(e) => setHeads(heads.map((y, j) => (j === i ? e.target.value : y)))} style={{ marginBottom: 2 }} />
              {x.length > 40 && <small style={{ color: "var(--warn)" }}>{x.length} characters; may be cut off</small>}
            </div>
          ))}
          <label className="field"><span>Description</span><input value={desc} onChange={(e) => setDesc(e.target.value)} /></label>
          <label className="field"><span>Button</span>
            <select value={cta} onChange={(e) => setCta(e.target.value)}>{ctas.map((c) => <option key={c} value={c}>{c.replace(/_/g, " ").toLowerCase()}</option>)}</select>
          </label>
          <label className="field"><span>Landing page URL</span><input type="url" value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://" /></label>
          <label className="field"><span>UTM template (added to the link)</span><input value={utm} onChange={(e) => setUtm(e.target.value)} /></label>
          <small>Use {"{campaign}"}, {"{creative}"}, {"{angle}"}, {"{date}"}, or Meta&apos;s own {"{{ad.name}}"}.</small>
        </div>
      </div>
      {error && <div className="msg error">{error}</div>}
      <div className="row" style={{ marginTop: 10 }}>
        <button className="primary" onClick={save}>Save</button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function NamingTab({ tpl, reload }: { tpl: FullTemplates; reload: () => void }) {
  const [draft, setDraft] = useState<{ id?: number; name: string; kind: "ad" | "adset"; pattern: string; isDefault: boolean } | null>(null);
  const [error, setError] = useState("");
  const sample = { date: new Date(), creative: "hook-01", angle: "price", format: "VID-9x16+4x5", n: 1, copy: "Site-visit copy", campaign: "November tests", adset: "Broad 25-45", batch: "k4r94" };

  async function save() {
    try {
      await api("/api/templates", { method: "POST", body: { kind: "naming", namingKind: draft!.kind, ...draft } });
      setDraft(null);
      reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <>
      {(["ad", "adset"] as const).map((kind) => (
        <div className="panel" key={kind}>
          <header><h2>{kind === "ad" ? "Ad names" : "New ad set names"}</h2>
            <button style={{ marginLeft: "auto" }} onClick={() => setDraft({ name: "", kind, pattern: kind === "ad" ? "{date}_{creative}_{angle}_{format}" : "{date}_{creative}", isDefault: false })}>Add</button>
          </header>
          {tpl.naming.filter((n) => n.kind === kind).map((n) => (
            <div className="list-item" key={n.id}>
              <div className="grow">
                <strong>{n.name}</strong> {n.is_default ? <span className="badge">default</span> : null}
                <div><code>{n.pattern}</code> → <span className="preview-name">{renderName(n.pattern, sample)}</span></div>
              </div>
              <button onClick={() => setDraft({ id: n.id, name: n.name, kind: n.kind, pattern: n.pattern, isDefault: !!n.is_default })}>Edit</button>
              <button className="danger" onClick={() => confirm(`Delete the naming template "${n.name}"?`) && api(`/api/templates/naming/${n.id}`, { method: "DELETE" }).then(reload).catch((e: Error) => alert(e.message))}>Delete</button>
            </div>
          ))}
        </div>
      ))}
      {draft && (
        <div className="panel">
          <div className="row">
            <label><span>Name</span><input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
            <label><span>Pattern</span><input value={draft.pattern} onChange={(e) => setDraft({ ...draft, pattern: e.target.value })} /></label>
          </div>
          <p>Preview: <span className="preview-name">{renderName(draft.pattern, sample)} [L:k4r94-01]</span></p>
          <label className="check"><input type="checkbox" checked={draft.isDefault} onChange={(e) => setDraft({ ...draft, isDefault: e.target.checked })} /> Use for new batches</label>
          <details open><summary>Words you can use</summary>{tpl.tokens.map((t) => <div key={t.token}><code>{t.token}</code> {t.meaning}</div>)}</details>
          {error && <div className="msg error">{error}</div>}
          <div className="row" style={{ marginTop: 10 }}><button className="primary" onClick={save}>Save</button><button onClick={() => setDraft(null)}>Cancel</button></div>
        </div>
      )}
    </>
  );
}

function PresetEditor({ p, features, onSaved, onCancel }: { p: Partial<PresetT>; features: FullTemplates["features"]; onSaved: () => void; onCancel: () => void }) {
  const [form, setForm] = useState({ id: p.id, name: p.name ?? "", pageId: p.pageId ?? "", pageName: p.pageName ?? "", igUserId: p.igUserId ?? "", igName: p.igName ?? "", multiAdvertiser: p.multiAdvertiser ?? false, isDefault: p.isDefault ?? false });
  const [on, setOn] = useState<Set<string>>(new Set(p.enhancementsOn ?? []));
  const [ids, setIds] = useState<{ pages: { id: string; name: string }[]; instagram: { id: string; username: string }[] } | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api<typeof ids>("/api/identities").then(setIds).catch((e: Error) => setError(e.message));
  }, []);

  async function save() {
    try {
      await api("/api/templates", { method: "POST", body: { kind: "preset", ...form, enhancements: Object.fromEntries([...on].map((k) => [k, "OPT_IN"])) } });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="panel">
      <label className="field"><span>Preset name</span><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
      <div className="row" style={{ marginTop: 10 }}>
        <label><span>Facebook Page</span>
          <select value={form.pageId} onChange={(e) => setForm({ ...form, pageId: e.target.value, pageName: ids?.pages.find((x) => x.id === e.target.value)?.name ?? "" })}>
            <option value="">Pick a Page</option>
            {ids?.pages.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            {form.pageId && !ids?.pages.some((x) => x.id === form.pageId) && <option value={form.pageId}>{form.pageName || form.pageId}</option>}
          </select>
        </label>
        <label><span>Instagram account</span>
          <select value={form.igUserId} onChange={(e) => setForm({ ...form, igUserId: e.target.value, igName: ids?.instagram.find((x) => x.id === e.target.value)?.username ?? "" })}>
            <option value="">None (use the Facebook Page)</option>
            {ids?.instagram.map((x) => <option key={x.id} value={x.id}>@{x.username}</option>)}
            {form.igUserId && !ids?.instagram.some((x) => x.id === form.igUserId) && <option value={form.igUserId}>{form.igName || form.igUserId}</option>}
          </select>
        </label>
      </div>
      <h2 style={{ marginTop: 16 }}>AI creative enhancements</h2>
      <p className="muted">Off means Meta shows your files and text exactly as you made them. Tick only what you want Meta to change.</p>
      <div className="grid2">
        {features.map((f) => (
          <label className="check" key={f.key}>
            <input type="checkbox" checked={on.has(f.key)} onChange={(e) => { const n = new Set(on); if (e.target.checked) n.add(f.key); else n.delete(f.key); setOn(n); }} />
            {f.label}
          </label>
        ))}
      </div>
      <label className="check" style={{ marginTop: 12 }}><input type="checkbox" checked={form.multiAdvertiser} onChange={(e) => setForm({ ...form, multiAdvertiser: e.target.checked })} /> Allow multi-advertiser ads (your ad may show next to other brands' ads)</label>
      <label className="check"><input type="checkbox" checked={form.isDefault} onChange={(e) => setForm({ ...form, isDefault: e.target.checked })} /> Use for new batches</label>
      {error && <div className="msg error">{error}</div>}
      <div className="row" style={{ marginTop: 10 }}><button className="primary" onClick={save}>Save</button><button onClick={onCancel}>Cancel</button></div>
    </div>
  );
}

function ClaudeTab({ appUrl }: { appUrl: string }) {
  const [keys, setKeys] = useState<{ id: number; label: string; hint: string; createdAt: string; lastUsedAt: string | null }[]>([]);
  const [fresh, setFresh] = useState("");
  const load = useCallback(() => api<typeof keys>("/api/keys").then(setKeys), []);
  useEffect(() => void load(), [load]);

  return (
    <>
      <div className="panel">
        <header><h2>Use the launcher from Claude</h2></header>
        <ol>
          <li>Create a key below and copy it. It is shown once.</li>
          <li>Claude Desktop: download <a href="/downloads/sahajta-ads.mcpb">sahajta-ads.mcpb</a>, double-click it, and paste the key when Claude asks.</li>
          <li>Claude Code: run this once in a terminal (replace YOUR_KEY):
            <pre className="secret" style={{ whiteSpace: "pre-wrap" }}>claude mcp add --transport http sahajta-ads {appUrl}/api/mcp --header &quot;Authorization: Bearer YOUR_KEY&quot;</pre>
          </li>
          <li>Then ask Claude, for example: &quot;Launch the reels in this Drive folder into the November test ad set with the site-visit copy.&quot; Claude shows you the preview and asks before launching. Ads are always created paused.</li>
        </ol>
      </div>
      <div className="panel">
        <header><h2>Your keys</h2>
          <button className="primary" style={{ marginLeft: "auto" }} onClick={async () => { const r = await api<{ key: string }>("/api/keys", { method: "POST", body: { label: "Claude" } }); setFresh(r.key); void load(); }}>Create a key</button>
        </header>
        {fresh && <div className="msg ok">Copy this key now; it won&apos;t be shown again:<div className="secret">{fresh}</div></div>}
        {keys.map((k) => (
          <div className="list-item" key={k.id}>
            <div className="grow">{k.label} ending in <code>{k.hint}</code> <small>· created {k.createdAt.slice(0, 10)} · {k.lastUsedAt ? `last used ${k.lastUsedAt.slice(0, 16)}` : "never used"}</small></div>
            <button className="danger" onClick={() => confirm("Remove this key? Claude stops working with it straight away.") && api(`/api/keys/${k.id}`, { method: "DELETE" }).then(load).catch((e: Error) => alert(e.message))}>Remove</button>
          </div>
        ))}
        {!keys.length && <p className="muted">No keys yet.</p>}
      </div>
    </>
  );
}

export default function SettingsClient({ status }: { status: Status }) {
  const [tab, setTab] = useState<(typeof TABS)[number][0]>(status.tokenSet ? "copy" : "meta");
  const [tpl, setTpl] = useState<FullTemplates | null>(null);
  const [editCopy, setEditCopy] = useState<Partial<CopyT> | null>(null);
  const [editPreset, setEditPreset] = useState<Partial<PresetT> | null>(null);
  const [error, setError] = useState("");
  const reload = useCallback(() => api<FullTemplates>("/api/templates").then(setTpl).catch((e: Error) => setError(e.message)), []);

  useEffect(() => {
    void reload();
    const h = window.location.hash.slice(1);
    if (TABS.some(([k]) => k === h)) setTab(h as typeof tab);
  }, [reload]);

  return (
    <>
      <h1>Settings</h1>
      <div className="tabs">
        {TABS.map(([k, label]) => (
          <button key={k} className={tab === k ? "on" : ""} onClick={() => { setTab(k); history.replaceState(null, "", `#${k}`); }}>{label}</button>
        ))}
      </div>
      {error && tab !== "meta" && <div className="msg error">{error}</div>}

      {tab === "meta" && <MetaTab />}

      {tab === "copy" && tpl && (
        editCopy ? <CopyEditor t={editCopy} ctas={tpl.ctaTypes} onSaved={() => { setEditCopy(null); void reload(); }} onCancel={() => setEditCopy(null)} /> : (
          <div className="panel">
            <header><h2>Copy templates</h2><button className="primary" style={{ marginLeft: "auto" }} onClick={() => setEditCopy({})}>Add a copy template</button></header>
            {tpl.copy.map((c) => (
              <div className="list-item" key={c.id}>
                <div className="grow"><strong>{c.name}</strong><div><small>{c.primaryTexts.length} texts · {c.headlines.length} headlines · {c.cta.replace(/_/g, " ").toLowerCase()} → {c.linkUrl}</small></div></div>
                <button onClick={() => setEditCopy(c)}>Edit</button>
                <button onClick={() => setEditCopy({ ...c, id: undefined, name: `${c.name} (copy)` })}>Duplicate</button>
                <button className="danger" onClick={() => confirm(`Delete the copy template "${c.name}"?`) && api(`/api/templates/copy/${c.id}`, { method: "DELETE" }).then(reload).catch((e: Error) => alert(e.message))}>Delete</button>
              </div>
            ))}
            {!tpl.copy.length && <p className="muted">No copy templates yet.</p>}
          </div>
        )
      )}

      {tab === "naming" && tpl && <NamingTab tpl={tpl} reload={reload} />}

      {tab === "presets" && tpl && (
        editPreset ? <PresetEditor p={editPreset} features={tpl.features} onSaved={() => { setEditPreset(null); void reload(); }} onCancel={() => setEditPreset(null)} /> : (
          <div className="panel">
            <header><h2>Meta settings presets</h2><button className="primary" style={{ marginLeft: "auto" }} onClick={() => setEditPreset({})}>Add a preset</button></header>
            {tpl.presets.map((p) => (
              <div className="list-item" key={p.id}>
                <div className="grow">
                  <strong>{p.name}</strong> {p.isDefault && <span className="badge">default</span>}
                  <div><small>Page: {p.pageName || p.pageId || "not set"} · Instagram: {p.igName || p.igUserId || "not set"} · AI enhancements: {p.enhancementsOn.length ? `${p.enhancementsOn.length} on` : "all off"} · Multi-advertiser: {p.multiAdvertiser ? "on" : "off"}</small></div>
                </div>
                <button onClick={() => setEditPreset(p)}>Edit</button>
                <button className="danger" onClick={() => confirm(`Delete the preset "${p.name}"?`) && api(`/api/templates/preset/${p.id}`, { method: "DELETE" }).then(reload).catch((e: Error) => setError(e.message))}>Delete</button>
              </div>
            ))}
          </div>
        )
      )}

      {tab === "claude" && <ClaudeTab appUrl={status.appUrl} />}

      {tab === "status" && (
        <div className="panel">
          <div className="list-item"><span className="grow">Meta ad account</span>{status.tokenSet ? status.account : <span style={{ color: "var(--err)" }}>Not connected (see the Meta connection tab)</span>}</div>
          {status.mock && <div className="list-item"><span className="grow">Practice mode</span>On: nothing is sent to Meta</div>}
          <div className="list-item"><span className="grow">Meta API version</span>{status.apiVersion}</div>
          <div className="list-item"><span className="grow">Meta speed limit</span>{status.tier}</div>
          <div className="list-item"><span className="grow">Launch worker</span>{status.worker}</div>
        </div>
      )}
    </>
  );
}
