"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../client-api";
import { msgClass } from "../msg";
import ColumnsEditor from "./ColumnsEditor";
import CustomMetrics from "./CustomMetrics";
import { BREAKDOWNS, DATES, LEVELS, breakdownLabel, breakdownValue, formatValue, isConnectionError, withPlatform, zoneNote } from "./shared";
import type { Catalog, Level, ResultData } from "./shared";
import s from "./results.module.css";

const STORE_KEY = "launcher:results";

interface Controls {
  level: Level;
  date: string;
  since: string;
  until: string;
  breakdowns: string[];
  /** Saved column set in use, or null when the columns were changed without saving. */
  setId: number | null;
  metrics: string[];
  campaignIds: string[];
  adsetIds: string[];
}

const START: Controls = { level: "campaign", date: "last_7d", since: "", until: "", breakdowns: [], setId: null, metrics: [], campaignIds: [], adsetIds: [] };

interface TreeCampaign { id: string; name: string; adsets: { id: string; name: string }[] }
type Sort = { key: string; dir: 1 | -1 } | null;
type Shown = { data: ResultData; breakdowns: string[]; rangeLabel: string };

function readSaved(): Partial<Controls> {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}") as Partial<Controls>;
  } catch {
    return {};
  }
}

function ErrorMsg({ text }: { text: string }) {
  return (
    <div className={msgClass(text)}>
      {text}
      {isConnectionError(text) && <> <a href="/settings#meta">Open Settings → Meta</a></>}
    </div>
  );
}

export default function ResultsClient() {
  const [tab, setTab] = useState<"results" | "columns" | "custom">("results");
  const [c, setC] = useState<Controls>(START);
  const [ready, setReady] = useState(false);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [catalogError, setCatalogError] = useState("");
  const [shown, setShown] = useState<Shown | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [sort, setSort] = useState<Sort>(null);
  const [tree, setTree] = useState<TreeCampaign[] | null>(null);
  const [treeError, setTreeError] = useState("");

  const set = (patch: Partial<Controls>) => setC((prev) => ({ ...prev, ...patch }));

  const loadCatalog = useCallback(async () => {
    const cat = await api<Catalog>("/api/results");
    setCatalog(cat);
    return cat;
  }, []);

  // First load: last controls from this browser, then the saved column sets from the server.
  useEffect(() => {
    const saved = { ...START, ...readSaved() };
    loadCatalog()
      .then((cat) => {
        const chosen = saved.setId !== null ? cat.columnSets.find((x) => x.id === saved.setId) : undefined;
        if (chosen) saved.metrics = chosen.metrics;
        else if (saved.setId !== null || !saved.metrics.length) {
          const def = cat.columnSets.find((x) => x.isDefault) ?? cat.columnSets[0];
          saved.setId = def?.id ?? null;
          saved.metrics = def?.metrics ?? [];
        }
        setC(saved);
        setReady(true);
      })
      .catch((e: Error) => setCatalogError(e.message));
  }, [loadCatalog]);

  useEffect(() => {
    if (!ready) return;
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(c));
    } catch {
      /* private window: ignore */
    }
  }, [c, ready]);

  const currentSet = catalog?.columnSets.find((x) => x.id === c.setId) ?? null;
  const filterIds = c.level === "adset" ? c.adsetIds : c.level === "ad" ? [] : c.campaignIds;

  async function run(metrics = c.metrics) {
    setError("");
    if (c.date === "custom") {
      if (!c.since || !c.until) return setError("Pick both a start date and an end date.");
      if (c.since > c.until) return setError("The start date is after the end date.");
    }
    setLoading(true);
    // Placement alone is always refused by Meta: Platform comes with it (and shows as a column).
    const breakdowns = withPlatform(c.breakdowns);
    try {
      const body = {
        action: "query",
        level: c.level,
        metrics,
        breakdowns,
        ...(c.date === "custom" ? { since: c.since, until: c.until } : { date_preset: c.date }),
        ...(filterIds.length ? { ids: filterIds } : {}),
      };
      const data = await api<ResultData>("/api/results", { method: "POST", body });
      const fmt = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
      const rangeLabel = c.date === "custom" ? `${fmt(c.since)} to ${fmt(c.until)}` : DATES.find(([k]) => k === c.date)?.[1] ?? data.range;
      setShown({ data, breakdowns, rangeLabel });
      setSort(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  function openFilter(open: boolean) {
    if (!open || tree) return;
    setTreeError("");
    api<{ campaigns: TreeCampaign[] }>("/api/manage/tree")
      .then((t) => setTree(t.campaigns))
      .catch((e: Error) => setTreeError(e.message));
  }

  const toggleId = (field: "campaignIds" | "adsetIds", ids: string[], on: boolean) =>
    setC((prev) => {
      const now = new Set(prev[field]);
      for (const id of ids) {
        if (on) now.add(id);
        else now.delete(id);
      }
      return { ...prev, [field]: [...now] };
    });

  const rows = useMemo(() => {
    if (!shown) return [];
    const list = [...shown.data.rows];
    if (!sort) return list;
    const val = (r: (typeof list)[number]): string | number | null =>
      sort.key === "name" ? r.name : sort.key.startsWith("bd:") ? r.breakdown[sort.key.slice(3)] ?? null : r.values[sort.key] ?? null;
    return list.sort((a, b) => {
      const x = val(a);
      const y = val(b);
      if (x === null && y === null) return 0;
      if (x === null) return 1; // empty values always go last
      if (y === null) return -1;
      if (typeof x === "number" && typeof y === "number") return (x - y) * sort.dir;
      return String(x).localeCompare(String(y), "en-IN", { numeric: true }) * sort.dir;
    });
  }, [shown, sort]);

  const sortBy = (key: string, numeric: boolean) =>
    setSort((prev) => (prev?.key === key ? { key, dir: prev.dir === 1 ? -1 : 1 } : { key, dir: numeric ? -1 : 1 }));
  const arrow = (key: string) => (sort?.key === key ? <span className={s.arrow}>{sort.dir === 1 ? "▲" : "▼"}</span> : null);
  const ariaSort = (key: string) => (sort?.key === key ? (sort.dir === 1 ? "ascending" : "descending") : undefined);

  const levelName = shown ? { campaign: "Campaign", adset: "Ad set", ad: "Ad", account: "Account" }[shown.data.level] ?? "Name" : "Name";
  const picked = c.level === "adset" ? c.adsetIds.length : c.campaignIds.length;

  if (catalogError) {
    return (
      <>
        <h1>Results</h1>
        <ErrorMsg text={catalogError} />
      </>
    );
  }

  return (
    <>
      <h1>Results</h1>
      <p className="lead">How your campaigns, ad sets and ads are doing, with the columns you choose.</p>
      <div className="tabs">
        <button className={tab === "results" ? "on" : ""} onClick={() => setTab("results")}>Results</button>
        <button className={tab === "columns" ? "on" : ""} onClick={() => setTab("columns")}>Edit columns</button>
        <button className={tab === "custom" ? "on" : ""} onClick={() => setTab("custom")}>Custom metrics</button>
      </div>

      {!catalog && <p className="muted">Loading…</p>}

      {catalog && tab === "results" && (
        <>
          <div className="panel">
            <div className={s.controls}>
              <label className="field">
                <span>Show</span>
                <select value={c.level} onChange={(e) => set({ level: e.target.value as Level })}>
                  {LEVELS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              </label>
              <label className="field">
                <span>Dates</span>
                <select value={c.date} onChange={(e) => set({ date: e.target.value })}>
                  {DATES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              </label>
              {c.date === "custom" && (
                <div className="field">
                  <span>From – to</span>
                  <div className={s.dates}>
                    <input type="date" aria-label="From" value={c.since} onChange={(e) => set({ since: e.target.value })} />
                    <input type="date" aria-label="To" value={c.until} onChange={(e) => set({ until: e.target.value })} />
                  </div>
                </div>
              )}
              <label className="field">
                <span>Break down by</span>
                <select value={c.breakdowns[0] ?? ""} onChange={(e) => set({ breakdowns: e.target.value ? [e.target.value, ...c.breakdowns.slice(1).filter((b) => b !== e.target.value)] : [] })}>
                  <option value="">Nothing</option>
                  {BREAKDOWNS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              </label>
              {c.breakdowns.length > 0 && (
                <label className="field">
                  <span>And by</span>
                  <select value={c.breakdowns[1] ?? ""} onChange={(e) => set({ breakdowns: e.target.value ? [c.breakdowns[0], e.target.value] : [c.breakdowns[0]] })}>
                    <option value="">Nothing</option>
                    {BREAKDOWNS.filter(([k]) => k !== c.breakdowns[0]).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                  </select>
                </label>
              )}
              <label className="field">
                <span>Columns</span>
                <select
                  value={c.setId === null ? "" : String(c.setId)}
                  onChange={(e) => {
                    const cs = catalog.columnSets.find((x) => String(x.id) === e.target.value);
                    if (cs) set({ setId: cs.id, metrics: cs.metrics });
                  }}
                >
                  {c.setId === null && <option value="">Your changes (not saved)</option>}
                  {catalog.columnSets.map((x) => <option key={x.id} value={x.id}>{x.name}{x.isDefault ? " (default)" : ""}</option>)}
                </select>
              </label>
            </div>

            {c.level !== "ad" ? (
              <details className={s.filterBox} onToggle={(e) => openFilter((e.currentTarget as HTMLDetailsElement).open)}>
                <summary>Only these {c.level === "adset" ? "ad sets" : "campaigns"}{picked ? ` (${picked} picked)` : " (all for now)"}</summary>
                {treeError && <ErrorMsg text={treeError} />}
                {!tree && !treeError && <p className="muted">Loading campaigns…</p>}
                {tree && tree.length === 0 && <p className="muted">No campaigns in this ad account.</p>}
                {tree && tree.length > 0 && (
                  <>
                    <div className={s.filterList}>
                      {tree.map((camp) => {
                        const ids = camp.adsets.map((a) => a.id);
                        const campOn = c.level === "adset" ? ids.length > 0 && ids.every((id) => c.adsetIds.includes(id)) : c.campaignIds.includes(camp.id);
                        return (
                          <div key={camp.id}>
                            <label className="check">
                              <input
                                type="checkbox"
                                checked={campOn}
                                disabled={c.level === "adset" && ids.length === 0}
                                onChange={(e) => (c.level === "adset" ? toggleId("adsetIds", ids, e.target.checked) : toggleId("campaignIds", [camp.id], e.target.checked))}
                              />
                              {camp.name}
                            </label>
                            {c.level === "adset" && (
                              <div className={s.adsets}>
                                {camp.adsets.map((a) => (
                                  <label key={a.id} className="check">
                                    <input type="checkbox" checked={c.adsetIds.includes(a.id)} onChange={(e) => toggleId("adsetIds", [a.id], e.target.checked)} />
                                    {a.name}
                                  </label>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                    {picked > 0 && <button className="link" style={{ marginTop: 8 }} onClick={() => set(c.level === "adset" ? { adsetIds: [] } : { campaignIds: [] })}>Clear, show all</button>}
                  </>
                )}
              </details>
            ) : (
              <p className="hint" style={{ marginTop: 14 }}>When you show ads, all ads in the account are listed.</p>
            )}

            <div className={s.actions}>
              <button className="primary" onClick={() => run()} disabled={loading || !c.metrics.length}>{loading ? "Getting results…" : "Show results"}</button>
              <button className="link" onClick={() => setTab("columns")}>Edit columns</button>
            </div>
          </div>

          {error && <ErrorMsg text={error} />}
          {loading && !shown && <div className="msg info">Getting results from Meta…</div>}

          {shown && (
            <div className="panel" style={{ opacity: loading ? 0.5 : 1 }}>
              <header>
                <h2>{shown.rangeLabel}</h2>
                <span className="muted" style={{ fontSize: 13.5 }}>{shown.data.truncated ? "First " : ""}{shown.data.rows.length} row{shown.data.rows.length === 1 ? "" : "s"}</span>
              </header>
              {zoneNote(shown.data.timezone) && <p className="hint" style={{ marginTop: 0 }}>{zoneNote(shown.data.timezone)}</p>}
              {(shown.data.notes ?? []).map((n) => <div key={n} className="msg warning">{n}</div>)}
              {shown.data.rows.length === 0 ? (
                <p className="muted">No results in this date range.</p>
              ) : (
                <>
                  <div className="table-wrap">
                    <table className={s.table}>
                      <thead>
                        <tr>
                          <th className={s.sortable} aria-sort={ariaSort("name")} onClick={() => sortBy("name", false)}>{levelName}{arrow("name")}</th>
                          {shown.breakdowns.map((b) => (
                            <th key={b} className={s.sortable} aria-sort={ariaSort(`bd:${b}`)} onClick={() => sortBy(`bd:${b}`, false)}>{breakdownLabel(b)}{arrow(`bd:${b}`)}</th>
                          ))}
                          {shown.data.columns.map((col) => (
                            <th key={col.key} className={`${s.sortable} ${s.num}`} aria-sort={ariaSort(col.key)} onClick={() => sortBy(col.key, true)} title={col.key}>{col.label}{arrow(col.key)}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((r, i) => (
                          <tr key={`${r.id}-${i}`}>
                            <td className={s.name}>{r.name}{shown.data.level !== "account" && <small>{r.id}</small>}</td>
                            {shown.breakdowns.map((b) => <td key={b}>{breakdownValue(b, r.breakdown[b])}</td>)}
                            {shown.data.columns.map((col) => <td key={col.key} className={s.num}>{formatValue(r.values[col.key], col.format, shown.data.currency)}</td>)}
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr>
                          <td>TOTAL</td>
                          {shown.breakdowns.map((b) => <td key={b} />)}
                          {shown.data.columns.map((col) => <td key={col.key} className={s.num}>{formatValue(shown.data.totals[col.key], col.format, shown.data.currency)}</td>)}
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                  <p className="hint">Click a column name to sort. Reach and frequency can&apos;t be added up across rows, so their total shows –.</p>
                </>
              )}
            </div>
          )}
        </>
      )}

      {catalog && tab === "columns" && (
        <ColumnsEditor
          catalog={catalog}
          metrics={c.metrics}
          set={currentSet}
          onApply={(metrics) => {
            set({ metrics, setId: null });
            setTab("results");
            if (shown) void run(metrics);
          }}
          onSaved={async (setId, metrics) => {
            await loadCatalog();
            set(setId === null ? { setId: null } : { setId, metrics });
          }}
        />
      )}

      {catalog && tab === "custom" && (
        <CustomMetrics metrics={catalog.custom} onChanged={async () => { await loadCatalog(); }} />
      )}
    </>
  );
}
