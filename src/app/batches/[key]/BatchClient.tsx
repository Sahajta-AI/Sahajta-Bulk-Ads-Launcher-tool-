"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { BatchView, CampaignInfo } from "@/lib/service";
import type { Check } from "@/lib/types";
import { api, lastUsed } from "../../client-api";
import Groups from "./Groups";
import PreviewTable from "./PreviewTable";
import Progress from "./Progress";
import Uploader from "./Uploader";

export interface Templates {
  copy: { id: number; name: string; primaryTexts: string[]; headlines: string[]; description: string; cta: string; linkUrl: string; utmTemplate: string }[];
  naming: { id: number; name: string; kind: "ad" | "adset"; pattern: string; is_default: number }[];
  presets: { id: number; name: string; pageName: string; pageId: string; igName: string; igUserId: string; enhancementsOn: string[]; multiAdvertiser: boolean; isDefault: boolean }[];
  tokens: { token: string; meaning: string }[];
  ctaTypes: string[];
}

function Checks({ list }: { list: Check[] }) {
  if (!list.length) return null;
  return (
    <ul className="checks">
      {list.map((c) => (
        <li key={c.code + c.message} className={c.level}>{c.message}</li>
      ))}
    </ul>
  );
}

export default function BatchClient({ batchKey }: { batchKey: string }) {
  const [view, setView] = useState<BatchView | null>(null);
  const [tpl, setTpl] = useState<Templates | null>(null);
  const [dest, setDest] = useState<CampaignInfo[] | null>(null);
  const [destError, setDestError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [accept, setAccept] = useState(false);
  const [uploading, setUploading] = useState(0);
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (withDest = false) => {
    try {
      setView(await api<BatchView>(`/api/batches/${batchKey}${withDest ? "?dest=1" : ""}`));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [batchKey]);

  // Uploads finish one by one: reload at most every 1.5 s.
  const reloadSoon = useCallback(() => {
    if (reloadTimer.current) return;
    reloadTimer.current = setTimeout(() => {
      reloadTimer.current = null;
      void load(true);
    }, 1500);
  }, [load]);

  const loadDest = useCallback(async (refresh = false) => {
    try {
      setDestError("");
      const d = await api<{ campaigns: CampaignInfo[] }>(`/api/destinations${refresh ? "?refresh=1" : ""}`);
      setDest(d.campaigns);
    } catch (e) {
      setDestError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load(true);
    void api<Templates>("/api/templates").then(setTpl).catch((e: Error) => setError(e.message));
    void loadDest();
  }, [load, loadDest]);

  // Live progress while launching; slower checks for Meta's review afterwards.
  useEffect(() => {
    if (!view) return;
    const running = view.status === "queued" || view.status === "running";
    const inReview = view.ads.some((a) => a.effectiveStatus === "PENDING_REVIEW" || a.effectiveStatus === "IN_PROCESS" || (a.metaAdId && !a.effectiveStatus));
    if (!running && !inReview) return;
    const t = setTimeout(() => void load(), running ? 3000 : 60000);
    return () => clearTimeout(t);
  }, [view, load]);

  const warningsSeen = useRef(0);
  useEffect(() => {
    if (view && view.status === "draft" && view.preview.warnings !== warningsSeen.current) {
      warningsSeen.current = view.preview.warnings;
      setAccept(false); // new or different warnings must be read again
    }
  }, [view]);

  async function patch(body: Record<string, unknown>) {
    setError("");
    try {
      setView(await api<BatchView>(`/api/batches/${batchKey}`, { method: "PATCH", body }));
      lastUsed.set(body as never);
      void load(true);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function act(label: string, fn: () => Promise<BatchView | void>) {
    setBusy(label);
    setError("");
    try {
      const v = await fn();
      if (v) setView(v);
      else await load();
    } catch (e) {
      setError((e as Error).message);
      // A refused launch may have found new warnings (e.g. a landing page that stopped loading).
      void load(true);
    } finally {
      setBusy("");
    }
  }

  if (!view) return error ? <div className="msg error">{error}</div> : <p className="muted">Loading…</p>;
  if (view.status !== "draft") {
    return <Progress view={view} busy={busy} error={error} act={act} batchKey={batchKey} />;
  }

  const s = view.settings;
  const campaign = dest?.find((c) => c.id === s.campaignId);
  const adNames = tpl?.naming.filter((n) => n.kind === "ad") ?? [];
  const setNames = tpl?.naming.filter((n) => n.kind === "adset") ?? [];
  // What the launch will use is the batch's own copy of the preset and copy template. If they
  // were edited in Settings since, offer to take the latest version.
  const presetTpl = tpl?.presets.find((p) => p.id === s.presetId);
  const preset = s.preset ? { ...s.preset, enhancementsOn: Object.keys(s.preset.enhancements ?? {}) } : null;
  const presetStale = !!(presetTpl && preset && (presetTpl.pageId !== preset.pageId || presetTpl.igUserId !== preset.igUserId || presetTpl.multiAdvertiser !== preset.multiAdvertiser || [...presetTpl.enhancementsOn].sort().join() !== [...preset.enhancementsOn].sort().join()));
  const copyTpl = tpl?.copy.find((c) => c.id === s.copyTemplateId);
  const copyStale = !!(copyTpl && JSON.stringify([copyTpl.primaryTexts, copyTpl.headlines, copyTpl.description, copyTpl.cta, copyTpl.linkUrl, copyTpl.utmTemplate]) !== JSON.stringify([s.copy.primaryTexts, s.copy.headlines, s.copy.description, s.copy.cta, s.copy.linkUrl, s.copy.utmTemplate]));
  const p = view.preview;
  const destChecks = p.batchChecks.filter((c) => ["no_campaign", "no_adset", "adset_missing", "dynamic_creative"].includes(c.code));
  const otherChecks = p.batchChecks.filter((c) => !destChecks.includes(c));
  const blocked = p.errors > 0;
  const needsAccept = p.warnings > 0 && !accept;

  const todo = [...p.batchChecks, ...p.ads.flatMap((a) => a.checks)].filter((c) => c.level === "error").map((c) => c.message);
  const todoAll = [...new Set(todo)];
  const todoShort = todoAll.slice(0, 3);

  return (
    <>
      <h1>New batch</h1>
      <p className="lead">
        {view.source.kind === "drive" ? `From Drive: ${view.source.label}` : "Uploaded files"} · {view.ads.length} ad{view.ads.length === 1 ? "" : "s"}. Nothing is sent to Meta until you press Launch.
      </p>

      <section className="panel">
        <header>
          <span className={`step ${view.ads.length ? "done" : ""}`}>1</span><h2>Creatives</h2>
          <p className="hint">Drag a file onto another ad to pair them. 9:16 shows in Stories and Reels; 4:5 or 1:1 shows in Feed.</p>
        </header>
        <Groups
          view={view}
          onMove={(assetId, to) => act("move", () => api<BatchView>(`/api/batches/${batchKey}/move`, { method: "POST", body: { assetId, toAdId: to } }))}
          onRemove={(assetId) => act("move", () => api<BatchView>(`/api/batches/${batchKey}/move`, { method: "POST", body: { assetId, remove: true } }))}
        />
        <div style={{ marginTop: view.ads.length ? 16 : 0 }}>
          <Uploader batchKey={batchKey} onUploaded={reloadSoon} onBusy={setUploading} />
        </div>
        <Checks list={otherChecks.filter((c) => c.code === "skipped_files")} />
      </section>

      <section className="panel">
        <header>
          <span className={`step ${s.adsetId ? "done" : ""}`}>2</span><h2>Where they go</h2>
          <button className="link" style={{ marginLeft: "auto", fontSize: 13.5 }} onClick={() => loadDest(true)}>Refresh from Meta</button>
        </header>
        {destError && <div className="msg error">{destError}</div>}
        <div className="row">
          <label>
            <span>Campaign</span>
            <select value={s.campaignId ?? ""} onChange={(e) => patch({ campaignId: e.target.value })}>
              <option value="" disabled>{dest ? "Choose a campaign" : "Loading campaigns…"}</option>
              {dest?.map((c) => (
                <option key={c.id} value={c.id}>{c.name} ({c.status.toLowerCase()})</option>
              ))}
            </select>
          </label>
          <label>
            <span>{s.adsetMode === "new_per_ad" ? "Ad set to copy for each ad" : "Ad set"}</span>
            <select value={s.adsetId ?? ""} onChange={(e) => patch({ adsetId: e.target.value })} disabled={!campaign}>
              <option value="" disabled>{campaign ? "Choose an ad set" : "Choose a campaign first"}</option>
              {campaign?.adsets.map((a) => (
                <option key={a.id} value={a.id}>{a.name}{a.isDynamicCreative ? " (Dynamic creative: can't use)" : ""}</option>
              ))}
            </select>
          </label>
        </div>
        <label className="check" style={{ marginTop: 14 }}>
          <input type="checkbox" checked={s.adsetMode === "new_per_ad"} onChange={(e) => patch({ adsetMode: e.target.checked ? "new_per_ad" : "existing" })} />
          <span>Put each ad in its own new ad set <small>(a paused copy of the ad set above: same budget, audience and placements)</small></span>
        </label>
        <Checks list={destChecks.filter((c) => c.code !== "no_campaign" && c.code !== "no_adset")} />
      </section>

      <section className="panel">
        <header>
          <span className={`step ${s.copyTemplateId ? "done" : ""}`}>3</span><h2>Copy</h2>
          <a href="/settings#copy" style={{ marginLeft: "auto", fontSize: 13.5 }}>Edit templates</a>
          <p className="hint">The same texts go on every ad. To change one ad, use the preview at the bottom.</p>
        </header>
        <select aria-label="Copy template" value={s.copyTemplateId ?? ""} onChange={(e) => patch({ copyTemplateId: Number(e.target.value) })}>
          <option value="" disabled>{tpl?.copy.length ? "Choose a copy template" : "No copy templates yet: add one in Settings"}</option>
          {tpl?.copy.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        {copyStale && (
          <div className="msg info">This template was edited in Settings after you picked it. <button className="link" onClick={() => patch({ copyTemplateId: s.copyTemplateId })}>Use the latest version</button></div>
        )}
        {s.copyTemplateId ? (
          <div className="copybox grid2">
            <div>
              <small>{s.copy.primaryTexts.length} primary text{s.copy.primaryTexts.length === 1 ? "" : "s"}</small>
              {s.copy.primaryTexts.map((t, i) => <p key={i}>{t}</p>)}
            </div>
            <div>
              <small>{s.copy.headlines.length} headline{s.copy.headlines.length === 1 ? "" : "s"}</small>
              {s.copy.headlines.map((t, i) => <p key={i}><strong>{t}</strong></p>)}
              <small>Description</small><p>{s.copy.description || "—"}</p>
              <small>Button and link</small><p>{s.copy.cta.replace(/_/g, " ").toLowerCase()} → {s.copy.linkUrl || "no link"}</p>
              {s.copy.utmTemplate && <><small>UTM</small><p><code>{s.copy.utmTemplate}</code></p></>}
            </div>
          </div>
        ) : null}
      </section>

      <section className="panel">
        <header><span className="step done">4</span><h2>Names</h2></header>
        <div className="row">
          <label>
            <span>Ad name</span>
            <select value={adNames.find((n) => n.pattern === s.adNameTemplate)?.id ?? ""} onChange={(e) => patch({ adNameTemplate: adNames.find((n) => n.id === Number(e.target.value))?.pattern })}>
              <option value="">Custom</option>
              {adNames.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
            </select>
          </label>
          <label style={{ maxWidth: 220 }}>
            <span>Angle <small>(fills {"{angle}"})</small></span>
            <input defaultValue={s.angle} key={`angle-${s.angle}`} placeholder="e.g. price" onBlur={(e) => e.target.value !== s.angle && patch({ angle: e.target.value })} />
          </label>
        </div>
        {view.ads[0] && (
          <div style={{ marginTop: 14 }}>
            <small>First ad will be named</small>
            <div className="preview-name">{view.ads[0].metaName}</div>
            {s.adsetMode === "new_per_ad" && <><small style={{ display: "block", marginTop: 8 }}>in a new ad set named</small><div className="preview-name">{view.ads[0].adsetName}</div></>}
          </div>
        )}
        <details>
          <summary>Change the pattern</summary>
          <div className="row">
            <label>
              <span>Ad name pattern</span>
              <input defaultValue={s.adNameTemplate} key={s.adNameTemplate} onBlur={(e) => e.target.value !== s.adNameTemplate && patch({ adNameTemplate: e.target.value })} />
            </label>
          </div>
          {s.adsetMode === "new_per_ad" && (
            <div className="row" style={{ marginTop: 12 }}>
              <label>
                <span>New ad set name</span>
                <select value={setNames.find((n) => n.pattern === s.adsetNameTemplate)?.id ?? ""} onChange={(e) => patch({ adsetNameTemplate: setNames.find((n) => n.id === Number(e.target.value))?.pattern })}>
                  <option value="">Custom</option>
                  {setNames.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
                </select>
              </label>
              <label>
                <span>Ad set name pattern</span>
                <input defaultValue={s.adsetNameTemplate} key={s.adsetNameTemplate} onBlur={(e) => e.target.value !== s.adsetNameTemplate && patch({ adsetNameTemplate: e.target.value })} />
              </label>
            </div>
          )}
          <div className="copybox">
            {tpl?.tokens.map((t) => <div key={t.token} style={{ padding: "2px 0" }}><code>{t.token}</code> {t.meaning}</div>)}
            <p className="hint">The code in square brackets at the end, like [L:{view.key}-01], is added to every name. A retry uses it to find ads Meta already made, so nothing is created twice.</p>
          </div>
        </details>
      </section>

      <section className="panel">
        <header>
          <span className={`step ${preset?.pageId ? "done" : ""}`}>5</span><h2>Meta settings</h2>
          <a href="/settings#presets" style={{ marginLeft: "auto", fontSize: 13.5 }}>Edit presets</a>
        </header>
        <select aria-label="Settings preset" value={s.presetId ?? ""} onChange={(e) => patch({ presetId: Number(e.target.value) })}>
          {tpl?.presets.map((p2) => <option key={p2.id} value={p2.id}>{p2.name}</option>)}
        </select>
        {presetStale && (
          <div className="msg info" style={{ marginTop: 12 }}>This preset was edited in Settings after you picked it. <button className="link" onClick={() => patch({ presetId: s.presetId })}>Use the latest version</button></div>
        )}
        {preset && (
          <dl className="kv">
            <dt>Facebook Page</dt><dd>{preset.pageName || preset.pageId || <span style={{ color: "var(--err)" }}>not set</span>}</dd>
            <dt>Instagram</dt><dd>{preset.igName || preset.igUserId || "not set (uses the Facebook Page)"}</dd>
            <dt>AI enhancements</dt><dd>{preset.enhancementsOn.length ? `${preset.enhancementsOn.length} switched on` : "All off"}</dd>
            <dt>Multi-advertiser ads</dt><dd>{preset.multiAdvertiser ? "On" : "Off"}</dd>
          </dl>
        )}
        <Checks list={otherChecks.filter((c) => c.code === "no_page" || c.code === "no_instagram")} />
      </section>

      <section className="panel">
        <header>
          <span className="step">6</span><h2>Preview</h2>
          <button style={{ marginLeft: "auto" }} disabled={!!busy || !view.ads.length} onClick={() => act("check", () => api<BatchView>(`/api/batches/${batchKey}/preview`, { method: "POST" }))}>
            {busy === "check" ? "Checking…" : "Check landing pages"}
          </button>
        </header>
        <Checks list={otherChecks.filter((c) => !["skipped_files", "no_page", "no_instagram", "no_ads"].includes(c.code))} />
        {view.ads.length ? <div className="table-wrap"><PreviewTable view={view} tpl={tpl} batchKey={batchKey} onChange={(v) => setView(v)} /></div> : <p className="muted">Add images or videos in step 1 to see the ads here.</p>}
      </section>

      {error && <div className="msg error" style={{ whiteSpace: "pre-line" }}>{error}</div>}

      <div className="launchbar">
        <div className="grow">
          <div className="estimate">
            <strong>{view.ads.length} ad{view.ads.length === 1 ? "" : "s"}</strong>, created paused · {p.estimate.label}
          </div>
          {uploading > 0 ? (
            <small>Wait for the uploads to finish: {uploading} file{uploading === 1 ? "" : "s"} still uploading.</small>
          ) : blocked ? (
            <small>Before launch: {todoShort.join(" · ").replace(/\.(?= ·|$)/g, "")}{todoAll.length > 3 ? ` · and ${todoAll.length - 3} more` : ""}</small>
          ) : (
            <small>{p.warnings ? `${p.warnings} warning${p.warnings === 1 ? "" : "s"} in the preview` : "Ready to launch"}{p.estimate.rateLimited ? " · Meta's speed limit for new apps sets the pace" : ""}</small>
          )}
        </div>
        {p.warnings > 0 && !blocked && (
          <label className="check">
            <input type="checkbox" checked={accept} onChange={(e) => setAccept(e.target.checked)} /> I read the warnings
          </label>
        )}
        <button className="primary big" disabled={blocked || needsAccept || !!busy || uploading > 0}
          onClick={() => act("launch", () => api<BatchView>(`/api/batches/${batchKey}/launch`, { method: "POST", body: { confirm: true, acceptWarnings: accept } }))}>
          {busy === "launch" ? "Starting…" : "Launch (paused)"}
        </button>
      </div>
    </>
  );
}
