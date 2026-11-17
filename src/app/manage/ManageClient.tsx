"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "../client-api";
import { BULK_HEADERS, parseBulk } from "./bulk";
import { CopyAdSetForm, CopyCampaignForm, EditAdSetForm, EditCampaignForm, NewAdSetForm, NewCampaignForm, PostAdsForm, type FormProps } from "./forms";
import s from "./manage.module.css";
import { ist, metaPill, planPill, rupees, type Options, type PlanInput, type PlanListItem, type PlanView, type Tree, type TreeAdSet, type TreeCampaign } from "./util";

type Open =
  | { kind: "newCampaign" }
  | { kind: "postAds" }
  | { kind: "bulk" }
  | { kind: "newAdset"; campaignId?: string }
  | { kind: "editCampaign" | "copyCampaign"; id: string }
  | { kind: "editAdset" | "copyAdset"; id: string };

export default function ManageClient() {
  const router = useRouter();
  const [tree, setTree] = useState<Tree | null>(null);
  const [treeError, setTreeError] = useState("");
  const [options, setOptions] = useState<Options | null>(null);
  const [plans, setPlans] = useState<PlanListItem[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<Open | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const loadTree = useCallback(async (refresh = false) => {
    setRefreshing(true);
    try {
      setTree(await api<Tree>(`/api/manage/tree${refresh ? "?refresh=1" : ""}`));
      setTreeError("");
    } catch (e) {
      setTreeError((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadTree();
    void api<Options>("/api/manage/options").then(setOptions).catch((e: Error) => setError(e.message));
    void api<{ plans: PlanListItem[] }>("/api/plans").then((r) => setPlans(r.plans)).catch(() => setPlans([]));
  }, [loadTree]);

  // Every action ends here: save and check the plan, then show its summary. Nothing runs yet.
  const submit = useCallback(async (input: PlanInput) => {
    const v = await api<PlanView>("/api/plans", { method: "POST", body: input });
    router.push(`/plans/${v.key}`);
  }, [router]);

  async function quick(id: string, input: PlanInput) {
    setBusy(id);
    setError("");
    try {
      await submit(input);
    } catch (e) {
      setError((e as Error).message);
      setBusy("");
    }
  }

  const toggle = (id: string) => setExpanded((x) => {
    const n = new Set(x);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });

  const show = (o: Open) => setOpen((cur) => (cur && JSON.stringify(cur) === JSON.stringify(o) ? null : o));
  const is = (o: Open) => !!open && JSON.stringify(open) === JSON.stringify(o);
  const props: FormProps | null = tree && options ? { tree, options, submit, close: () => setOpen(null) } : null;

  return (
    <>
      <h1>Campaigns</h1>
      <p className="lead">Turn campaigns and ad sets on or off, copy them, change budgets and make new ones. Every change first becomes a plan you check and confirm. Nothing is ever deleted.</p>

      <div className={s.toolbar}>
        <button className="primary" disabled={!props} onClick={() => show({ kind: "newCampaign" })}>New campaign</button>
        <button disabled={!props || !tree?.campaigns.length} onClick={() => show({ kind: "newAdset" })}>New ad set</button>
        <button disabled={!props || !tree?.campaigns.length} onClick={() => show({ kind: "postAds" })}>Ads from an existing post</button>
        <button disabled={!props || !tree?.campaigns.length} onClick={() => show({ kind: "bulk" })}>Bulk changes</button>
        <button disabled={refreshing} onClick={() => void loadTree(true)}>{refreshing ? "Reading Meta…" : "Refresh from Meta"}</button>
      </div>

      {error && <div className="msg error" style={{ whiteSpace: "pre-line" }}>{error}</div>}

      {props && open?.kind === "newCampaign" && <div className="panel"><NewCampaignForm {...props} /></div>}
      {props && open?.kind === "newAdset" && !open.campaignId && <div className="panel"><NewAdSetForm {...props} /></div>}
      {props && open?.kind === "postAds" && <div className="panel"><PostAdsForm {...props} /></div>}
      {props && open?.kind === "bulk" && <BulkPanel {...props} />}

      {treeError && (
        <div className="msg error">
          {treeError} {/connect/i.test(treeError) && <a href="/settings#meta">Open Meta settings</a>}
        </div>
      )}
      {!tree && !treeError && <p className="muted">Reading your campaigns from Meta…</p>}

      {tree && (
        <>
          <p className="hint" style={{ marginBottom: 12 }}>
            {tree.campaigns.length} campaign{tree.campaigns.length === 1 ? "" : "s"} · read from Meta {ist(tree.fetchedAt)}
          </p>
          {tree.campaigns.length === 0 && (
            <div className="panel">
              <p className="muted" style={{ margin: 0 }}>This ad account has no campaigns yet. Click <strong>New campaign</strong> to make one.</p>
            </div>
          )}
          {tree.campaigns.map((c) => (
            <CampaignCard
              key={c.id}
              c={c}
              currency={tree.currency}
              open={expanded.has(c.id)}
              onToggle={() => toggle(c.id)}
              busy={busy}
              is={is}
              show={show}
              props={props}
              quick={quick}
            />
          ))}
        </>
      )}

      <div className="panel" style={{ marginTop: 32 }}>
        <header><h2>Recent plans</h2></header>
        {!plans && <p className="muted">Loading…</p>}
        {plans?.length === 0 && <p className="muted">No plans yet.</p>}
        {plans?.slice(0, 15).map((p) => (
          <div key={p.key} className="list-item">
            <div className="grow">
              <a href={`/plans/${p.key}`}>{p.title || p.key}</a>
              <div className="hint" style={{ marginTop: 2 }}>
                {p.steps} step{p.steps === 1 ? "" : "s"}
                {p.dailyBudget ? ` · ${rupees(p.dailyBudget)} a day` : ""} · {p.createdBy ?? "someone"}
                {p.source === "claude" ? " via Claude" : ""} · {ist(p.createdAt)}
                {p.runAt ? ` · runs ${ist(p.runAt)}` : ""}
              </div>
            </div>
            <span className={`status ${planPill(p.status)}`}>{p.statusLabel}</span>
          </div>
        ))}
      </div>
    </>
  );
}

function OnOff({ status }: { status: string }) {
  const p = metaPill(status);
  return <span className={`status ${p.cls}`}>{p.label}</span>;
}

function CampaignCard({ c, currency, open, onToggle, busy, is, show, props, quick }: {
  c: TreeCampaign;
  currency: string;
  open: boolean;
  onToggle: () => void;
  busy: string;
  is: (o: Open) => boolean;
  show: (o: Open) => void;
  props: FormProps | null;
  quick: (id: string, input: PlanInput) => Promise<void>;
}) {
  const on = c.status === "ACTIVE";
  return (
    <div className="panel">
      <div className={s.title}>
        <h2>{c.name}</h2>
        <OnOff status={c.effectiveStatus} />
      </div>
      <div className={s.meta}>
        {c.details.objective || c.objective} · {c.cbo ? c.details.budget : "Budget on each ad set"}
        {c.cbo && c.details.bid ? ` · ${c.details.bid}` : ""}
        {c.details.spendCap && c.details.spendCap !== "none" ? ` · spend limit ${c.details.spendCap}` : ""}
      </div>
      <div className={s.actions}>
        <button
          className={on ? "danger" : undefined}
          disabled={!!busy}
          onClick={() => void quick(c.id, { title: `Turn ${on ? "off" : "on"} campaign "${c.name}"`, ops: [{ type: "set_status", status: on ? "PAUSED" : "ACTIVE", whole_campaigns: [c.id] }] })}
        >
          {busy === c.id ? "Checking…" : on ? "Turn off" : "Turn on"}
        </button>
        <button disabled={!props} onClick={() => show({ kind: "copyCampaign", id: c.id })}>Copy</button>
        <button disabled={!props} onClick={() => show({ kind: "editCampaign", id: c.id })}>Edit</button>
        <button disabled={!props} onClick={() => show({ kind: "newAdset", campaignId: c.id })}>New ad set</button>
        <button className="link" onClick={onToggle} style={{ marginLeft: "auto" }}>
          {open ? "Hide ad sets" : `Show ${c.adsets.length} ad set${c.adsets.length === 1 ? "" : "s"}`}
        </button>
      </div>

      {props && is({ kind: "copyCampaign", id: c.id }) && <CopyCampaignForm {...props} campaign={c} />}
      {props && is({ kind: "editCampaign", id: c.id }) && <EditCampaignForm {...props} campaign={c} />}
      {props && is({ kind: "newAdset", campaignId: c.id }) && <NewAdSetForm {...props} campaignId={c.id} />}

      {open && (
        <div className={s.adsets}>
          {c.adsets.length === 0 && <p className="muted" style={{ marginTop: 12 }}>No ad sets in this campaign yet.</p>}
          {c.adsets.map((a) => (
            <AdSetItem key={a.id} a={a} c={c} currency={currency} busy={busy} is={is} show={show} props={props} quick={quick} />
          ))}
        </div>
      )}
    </div>
  );
}

function AdSetItem({ a, c, currency, busy, is, show, props, quick }: {
  a: TreeAdSet;
  c: TreeCampaign;
  currency: string;
  busy: string;
  is: (o: Open) => boolean;
  show: (o: Open) => void;
  props: FormProps | null;
  quick: (id: string, input: PlanInput) => Promise<void>;
}) {
  const on = a.status === "ACTIVE";
  const d = a.details;
  const budget = a.dailyBudget !== null ? `${rupees(a.dailyBudget, currency)} a day` : a.lifetimeBudget !== null ? `${rupees(a.lifetimeBudget, currency)} lifetime` : d.budget;
  return (
    <div className={s.adset}>
      <div className={s.title}>
        <h3>{a.name}</h3>
        <OnOff status={a.effectiveStatus} />
      </div>
      <dl className={s.kvSmall}>
        <dt>Budget</dt><dd>{budget}</dd>
        <dt>Bid</dt><dd>{d.bid}</dd>
        <dt>Schedule</dt><dd>{d.schedule}</dd>
        <dt>Goal</dt><dd>{d.goal}</dd>
        <dt>Audience</dt><dd>{d.audience}</dd>
        <dt>Placements</dt><dd>{d.placements}</dd>
      </dl>
      <div className={s.actions}>
        <button
          className={on ? "danger" : undefined}
          disabled={!!busy}
          onClick={() => void quick(a.id, { title: `Turn ${on ? "off" : "on"} ad set "${a.name}"`, ops: [{ type: "set_status", status: on ? "PAUSED" : "ACTIVE", adsets: [a.id] }] })}
        >
          {busy === a.id ? "Checking…" : on ? "Turn off" : "Turn on"}
        </button>
        <button disabled={!props} onClick={() => show({ kind: "copyAdset", id: a.id })}>Copy</button>
        <button disabled={!props} onClick={() => show({ kind: "editAdset", id: a.id })}>Edit</button>
      </div>
      {props && is({ kind: "copyAdset", id: a.id }) && <CopyAdSetForm {...props} adset={a} campaign={c} />}
      {props && is({ kind: "editAdset", id: a.id }) && <EditAdSetForm {...props} adset={a} campaign={c} />}
    </div>
  );
}

const SAMPLE = ["action\tname\tcampaign\tsource_adset\tadset\tdaily_budget\tcountries", "copy\tPune_25-45\tNov_Leads\tMumbai_25-45\t\t2000\tIN", "edit\t\t\t\tDelhi_Leads\t1500\t"].join("\n");

function BulkPanel({ tree, options, submit, close }: FormProps) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const parsed = useMemo(() => parseBulk(text, tree, options.bidStrategies, options.goals, options.destinations), [text, tree, options]);
  const bad = parsed.rows.filter((r) => r.errors.length).length;
  const ready = parsed.rows.length > 0 && bad === 0;

  async function check() {
    setBusy(true);
    setError("");
    try {
      const ops = parsed.rows.map((r) => r.op!).filter(Boolean);
      await submit({ title: `Bulk changes from a sheet (${ops.length} row${ops.length === 1 ? "" : "s"})`, ops });
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <header><h2>Bulk changes</h2></header>
      <p className="muted" style={{ marginTop: 0 }}>
        Copy rows from Google Sheets and paste them here. The first row must be the headers. Each row is one change:
        <strong> create</strong> a new ad set, <strong>copy</strong> an ad set once, or <strong>edit</strong> an ad set.
        Campaigns and ad sets can be written by name or ID.
      </p>
      <details>
        <summary>Which columns can I use?</summary>
        <p className="hint">{BULK_HEADERS.join(", ")}</p>
        <p className="hint">
          Copy needs <code>source_adset</code> (and <code>campaign</code> to put the copy in another campaign). Edit needs <code>adset</code>.
          Create needs <code>name</code>, <code>campaign</code> and a <code>goal</code>. Times are India time, like 2026-11-20 09:00.
          Countries are codes with commas, like IN, AE. Genders: all, men or women. Status: on or off. Blank cells keep the original.
        </p>
        <button className="link" onClick={() => setText(SAMPLE)}>Fill in an example</button>
      </details>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={8}
        placeholder={"action\tname\tcampaign\tsource_adset\tdaily_budget\ncopy\tPune_25-45\tNov_Leads\tMumbai_25-45\t2000"}
        style={{ marginTop: 12, fontFamily: "ui-monospace, monospace", fontSize: 13 }}
      />
      {parsed.error && <div className="msg error">{parsed.error}</div>}
      {parsed.ignored.length > 0 && <div className="msg warning">These columns are not used and will be ignored: {parsed.ignored.join(", ")}</div>}
      {parsed.rows.length > 0 && (
        <div className="table-wrap" style={{ marginTop: 12 }}>
          <table className={s.bulkTable}>
            <thead><tr><th>Row</th><th>Action</th><th>What</th><th>Changes</th><th>Problems</th></tr></thead>
            <tbody>
              {parsed.rows.map((r) => (
                <tr key={r.line} className={r.errors.length ? s.rowError : undefined}>
                  <td>{r.line}</td>
                  <td>{r.action || "–"}</td>
                  <td style={{ whiteSpace: "normal", minWidth: 180 }}>{r.target}</td>
                  <td style={{ whiteSpace: "normal", minWidth: 200 }}>{r.changes || <span className="muted">none</span>}</td>
                  <td style={{ whiteSpace: "normal", minWidth: 160, color: "var(--err)" }}>{r.errors.join("; ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {bad > 0 && <div className="msg error">{bad} row{bad === 1 ? " has" : "s have"} problems. Fix them in the sheet and paste again.</div>}
      {error && <div className="msg error" style={{ whiteSpace: "pre-line" }}>{error}</div>}
      <div className={s.actions}>
        <button className="primary" disabled={!ready || busy} onClick={check}>{busy ? "Checking…" : `Check plan${parsed.rows.length ? ` (${parsed.rows.length} rows)` : ""}`}</button>
        <button disabled={busy} onClick={close}>Close</button>
      </div>
      <p className="hint">Nothing changes in Meta yet. Next you see a full summary and confirm.</p>
    </div>
  );
}
