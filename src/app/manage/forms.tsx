"use client";

// The forms on the Campaigns page. Each one only builds a plan (a list of steps) and sends it
// for checking. Nothing changes in Meta until the person confirms the plan on the next page.

import { useEffect, useState, type ReactNode } from "react";
import type { Op } from "@/lib/manage/plan";
import type { AdSetSpec, CampaignSpec } from "@/lib/manage/objects";
import { api } from "../client-api";
import s from "./manage.module.css";
import { itemId, ListMulti, ListSelect, SearchMulti, type LookupItem } from "./pickers";
import { countryList, isoToIstInput, istInputToIso, num, rupees, type Options, type PlanInput, type Tree, type TreeAdSet, type TreeCampaign } from "./util";

export interface FormProps {
  tree: Tree;
  options: Options;
  submit: (input: PlanInput) => Promise<void>;
  close: () => void;
}

const ROAS = "LOWEST_COST_WITH_MIN_ROAS";
const NEEDS_AMOUNT = ["COST_CAP", "LOWEST_COST_WITH_BID_CAP", ROAS];
const NO_MINOR = new Set(["JPY", "KRW", "VND", "CLP", "COP", "CRC", "HUF", "ISK", "IDR", "PYG", "TWD"]);
const fromMinor = (v: unknown, currency: string) => (v === undefined || v === null || v === "" ? undefined : Number(v) / (NO_MINOR.has(currency.toUpperCase()) ? 1 : 100));

/** A money or number field: blank → undefined; anything else must be a number ≥ 0. */
function amount(v: string, what: string): number | undefined {
  const n = num(v);
  if (n === undefined) return undefined;
  if (!Number.isFinite(n) || n < 0) throw new Error(`${what}: type a number, like 1500.`);
  return n;
}

function whole(v: string, what: string): number | undefined {
  const n = amount(v, what);
  if (n !== undefined && !Number.isInteger(n)) throw new Error(`${what}: type a whole number.`);
  return n;
}

function FormBox({ title, children, onSubmit, close, hint }: { title: string; children: ReactNode; onSubmit: () => Promise<void>; close: () => void; hint?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function go() {
    setError("");
    setBusy(true);
    try {
      await onSubmit();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <div className={s.form}>
      <h3>{title}</h3>
      {children}
      {error && <div className="msg error" style={{ whiteSpace: "pre-line" }}>{error}</div>}
      <div className={s.actions}>
        <button className="primary" disabled={busy} onClick={go}>{busy ? "Checking…" : "Check plan"}</button>
        <button disabled={busy} onClick={close}>Close</button>
      </div>
      <p className="hint">{hint ?? "Nothing changes in Meta yet. Next you see a full summary and confirm."}</p>
    </div>
  );
}

function Select({ value, onChange, list, blank }: { value: string; onChange: (v: string) => void; list: { value: string; label: string }[]; blank?: string }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      {blank !== undefined && <option value="">{blank}</option>}
      {list.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}

/** Bid strategy and the amount it needs (cost cap / bid cap in rupees, ROAS as a number). */
function BidFields({ options, strategy, setStrategy, amt, setAmt, blank }: { options: Options; strategy: string; setStrategy: (v: string) => void; amt: string; setAmt: (v: string) => void; blank?: string }) {
  return (
    <div className="row">
      <label>
        <span>Bid strategy</span>
        <Select value={strategy} onChange={setStrategy} list={options.bidStrategies} blank={blank} />
      </label>
      {NEEDS_AMOUNT.includes(strategy) && (
        <label>
          <span>{strategy === ROAS ? "ROAS goal (e.g. 2.5)" : strategy === "COST_CAP" ? "Cost per result goal (₹)" : "Bid cap (₹)"}</span>
          <input value={amt} onChange={(e) => setAmt(e.target.value)} inputMode="decimal" placeholder={strategy === ROAS ? "2.5" : "250"} />
        </label>
      )}
    </div>
  );
}

function bidSpec(strategy: string, amt: string): Pick<AdSetSpec, "bid_strategy" | "bid_amount" | "roas_average_floor"> {
  const out: Pick<AdSetSpec, "bid_strategy" | "bid_amount" | "roas_average_floor"> = {};
  if (strategy) out.bid_strategy = strategy;
  if (NEEDS_AMOUNT.includes(strategy)) {
    const n = amount(amt, strategy === ROAS ? "ROAS goal" : "Bid amount");
    if (n === undefined) throw new Error(strategy === ROAS ? "Type the ROAS goal." : "Type the bid amount for this bid strategy.");
    if (strategy === ROAS) out.roas_average_floor = n;
    else out.bid_amount = n;
  }
  return out;
}

// ---------- Campaigns ----------

export function NewCampaignForm({ options, submit, close }: FormProps) {
  const [name, setName] = useState("");
  const [objective, setObjective] = useState(options.objectives[0]?.value ?? "OUTCOME_LEADS");
  const [level, setLevel] = useState<"campaign" | "adset">("adset");
  const [daily, setDaily] = useState("");
  const [bid, setBid] = useState("LOWEST_COST_WITHOUT_CAP");
  const [cat, setCat] = useState("NONE");

  return (
    <FormBox
      title="New campaign"
      close={close}
      hint="The campaign is made switched off. Add ad sets to it after this plan runs."
      onSubmit={async () => {
        if (!name.trim()) throw new Error("Give the campaign a name.");
        const spec: CampaignSpec = { name: name.trim(), objective, budget_level: level, special_ad_categories: cat && cat !== "NONE" ? [cat] : [] };
        if (level === "campaign") {
          const d = amount(daily, "Daily budget");
          if (!d) throw new Error("Type the campaign's daily budget.");
          spec.daily_budget = d;
          spec.bid_strategy = bid || undefined;
        }
        await submit({ title: `New campaign "${spec.name}"`, ops: [{ type: "create_campaign", ...spec }] });
      }}
    >
      <div className="row">
        <label><span>Campaign name</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Nov_Leads_Mumbai" /></label>
        <label><span>Objective</span><Select value={objective} onChange={setObjective} list={options.objectives} /></label>
      </div>
      <div className="row">
        <div className="field">
          <span>Where is the budget set?</span>
          <div className={s.radios}>
            <label className="check"><input type="radio" checked={level === "adset"} onChange={() => setLevel("adset")} />On each ad set</label>
            <label className="check"><input type="radio" checked={level === "campaign"} onChange={() => setLevel("campaign")} />On the campaign (Meta shares it across ad sets)</label>
          </div>
        </div>
      </div>
      {level === "campaign" && (
        <div className="row">
          <label><span>Daily budget (₹)</span><input value={daily} onChange={(e) => setDaily(e.target.value)} inputMode="decimal" placeholder="5000" /></label>
          <label><span>Bid strategy</span><Select value={bid} onChange={setBid} list={options.bidStrategies.filter((b) => b.value === "LOWEST_COST_WITHOUT_CAP" || b.value === "COST_CAP" || b.value === "LOWEST_COST_WITH_BID_CAP" || b.value === ROAS)} /></label>
        </div>
      )}
      <div className="row">
        <label><span>Special ad category</span><Select value={cat} onChange={setCat} list={options.specialAdCategories} /></label>
      </div>
    </FormBox>
  );
}

export function EditCampaignForm({ options, submit, close, campaign: c, tree }: FormProps & { campaign: TreeCampaign }) {
  const [name, setName] = useState(c.name);
  const [daily, setDaily] = useState(c.dailyBudget !== null ? String(c.dailyBudget) : "");
  const [bid, setBid] = useState("");
  const [cap, setCap] = useState("");
  const [initial, setInitial] = useState<{ bid: string; cap: string } | null>(null);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    api<{ raw: { bid_strategy?: string; spend_cap?: string }; currency: string }>(`/api/manage/object/campaign/${c.id}`)
      .then((r) => {
        const b = r.raw.bid_strategy ?? "";
        const sc = fromMinor(r.raw.spend_cap, r.currency);
        const capS = sc ? String(sc) : "";
        setBid(b);
        setCap(capS);
        setInitial({ bid: b, cap: capS });
      })
      .catch((e: Error) => {
        setLoadError(e.message);
        setInitial({ bid: "", cap: "" });
      });
  }, [c.id]);

  return (
    <FormBox
      title={`Edit campaign "${c.name}"`}
      close={close}
      onSubmit={async () => {
        if (!initial) throw new Error("Still loading the campaign. Try again in a moment.");
        const spec: CampaignSpec = {};
        if (name.trim() && name.trim() !== c.name) spec.name = name.trim();
        if (c.cbo && c.dailyBudget !== null) {
          const d = amount(daily, "Daily budget");
          if (d !== undefined && d !== c.dailyBudget) spec.daily_budget = d;
        }
        if (c.cbo && bid && bid !== initial.bid) spec.bid_strategy = bid;
        if (cap.trim() !== initial.cap) {
          const n = amount(cap, "Spend limit");
          if (!n) throw new Error("To remove the spend limit, use Ads Manager. Here you can only set or change it.");
          spec.spend_cap = n;
        }
        if (!Object.keys(spec).length) throw new Error("Nothing was changed.");
        await submit({ title: `Edit campaign "${c.name}"`, ops: [{ type: "edit_campaign", campaign: c.id, ...spec }] });
      }}
    >
      {loadError && <div className="msg warning">Could not read all current settings: {loadError}</div>}
      <div className="row">
        <label><span>Campaign name</span><input value={name} onChange={(e) => setName(e.target.value)} /></label>
      </div>
      {c.cbo && c.dailyBudget !== null && (
        <div className="row">
          <label><span>Daily budget (₹)</span><input value={daily} onChange={(e) => setDaily(e.target.value)} inputMode="decimal" /></label>
          <label><span>Bid strategy</span><Select value={bid} onChange={setBid} list={options.bidStrategies} blank={initial ? "Keep as it is" : "Loading…"} /></label>
        </div>
      )}
      {c.cbo && c.dailyBudget === null && <p className="hint">This campaign has a lifetime budget. Change it in Ads Manager.</p>}
      {!c.cbo && <p className="hint">Budgets are set on each ad set in this campaign. Edit the ad sets to change them.</p>}
      <div className="row">
        <label>
          <span>Spend limit for the whole campaign (₹, blank = none)</span>
          <input value={cap} onChange={(e) => setCap(e.target.value)} inputMode="decimal" placeholder="No limit" />
        </label>
      </div>
      <p className="hint">Currency: {tree.currency}</p>
    </FormBox>
  );
}

export function CopyCampaignForm({ submit, close, campaign: c }: FormProps & { campaign: TreeCampaign }) {
  const [copies, setCopies] = useState("1");
  const [withContents, setWithContents] = useState(true);
  const [rows, setRows] = useState<{ name: string; daily: string }[]>([{ name: "", daily: "" }]);
  const n = Math.min(Math.max(Number(copies) || 0, 0), 50);

  useEffect(() => {
    setRows((r) => Array.from({ length: n }, (_, i) => r[i] ?? { name: "", daily: "" }));
  }, [n]);

  return (
    <FormBox
      title={`Copy campaign "${c.name}"`}
      close={close}
      hint="Copies are made switched off. Nothing changes in Meta until you confirm the plan."
      onSubmit={async () => {
        const count = whole(copies, "Number of copies");
        if (!count || count < 1) throw new Error("Type how many copies to make (1 or more).");
        const changes: CampaignSpec[] = rows.slice(0, count).map((r, i) => {
          const ch: CampaignSpec = {};
          if (r.name.trim()) ch.name = r.name.trim();
          if (c.cbo) {
            const d = amount(r.daily, `Copy ${i + 1} daily budget`);
            if (d !== undefined) ch.daily_budget = d;
          }
          return ch;
        });
        const op: Op = { type: "duplicate_campaign", campaign: c.id, copies: count, with_contents: withContents };
        if (changes.some((ch) => Object.keys(ch).length)) op.changes = changes;
        await submit({ title: `Copy campaign "${c.name}" ${count} time${count > 1 ? "s" : ""}`, ops: [op] });
      }}
    >
      <div className="row">
        <label style={{ maxWidth: 200 }}><span>Number of copies</span><input value={copies} onChange={(e) => setCopies(e.target.value)} inputMode="numeric" /></label>
      </div>
      <label className="check" style={{ marginBottom: 12 }}>
        <input type="checkbox" checked={withContents} onChange={(e) => setWithContents(e.target.checked)} />
        Also copy its ad sets and ads
      </label>
      {n > 0 && (
        <>
          <p className="hint" style={{ marginBottom: 6 }}>Leave a box blank to keep the original.</p>
          <div className="table-wrap">
            <table className={s.copyTable}>
              <thead><tr><th>Copy</th><th>Name</th>{c.cbo && <th>Daily budget (₹)</th>}</tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td>{i + 1}</td>
                    <td><input value={r.name} placeholder={`${c.name} - copy ${i + 1}`} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} /></td>
                    {c.cbo && <td><input value={r.daily} placeholder={c.dailyBudget !== null ? String(c.dailyBudget) : ""} inputMode="decimal" onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, daily: e.target.value } : x)))} /></td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </FormBox>
  );
}

// ---------- Ad sets ----------

export function NewAdSetForm({ tree, options, submit, close, campaignId }: FormProps & { campaignId?: string }) {
  const [campaign, setCampaign] = useState(campaignId ?? tree.campaigns[0]?.id ?? "");
  const [name, setName] = useState("");
  const [budgetKind, setBudgetKind] = useState<"daily" | "lifetime">("daily");
  const [budget, setBudget] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [destination, setDestination] = useState("WEBSITE");
  const [goal, setGoal] = useState("OFFSITE_CONVERSIONS");
  const [convKind, setConvKind] = useState<"pixel" | "custom">("pixel");
  const [pixel, setPixel] = useState("");
  const [event, setEvent] = useState("LEAD");
  const [customEvent, setCustomEvent] = useState("");
  const [customConv, setCustomConv] = useState("");
  const [page, setPage] = useState("");
  const [bid, setBid] = useState("LOWEST_COST_WITHOUT_CAP");
  const [bidAmt, setBidAmt] = useState("");
  const [audKind, setAudKind] = useState<"build" | "saved">("build");
  const [saved, setSaved] = useState("");
  const [countries, setCountries] = useState("IN");
  const [places, setPlaces] = useState<LookupItem[]>([]);
  const [ageMin, setAgeMin] = useState("18");
  const [ageMax, setAgeMax] = useState("65");
  const [gender, setGender] = useState("all");
  const [interests, setInterests] = useState<LookupItem[]>([]);
  const [include, setInclude] = useState<LookupItem[]>([]);
  const [exclude, setExclude] = useState<LookupItem[]>([]);
  const [advantage, setAdvantage] = useState(false);
  const [placeKind, setPlaceKind] = useState<"advantage" | "manual">("advantage");
  const [platforms, setPlatforms] = useState<string[]>(["facebook", "instagram"]);
  const [attribution, setAttribution] = useState("");

  const c = tree.campaigns.find((x) => x.id === campaign);
  const conversions = goal === "OFFSITE_CONVERSIONS" || goal === "VALUE";
  const genders = { all: "all", "1": "men", "2": "women" } as const;

  return (
    <FormBox
      title="New ad set"
      close={close}
      hint="The ad set is made switched off. Nothing changes in Meta until you confirm the plan."
      onSubmit={async () => {
        if (!c) throw new Error("Pick a campaign.");
        if (!name.trim()) throw new Error("Give the ad set a name.");
        const spec: AdSetSpec = { name: name.trim(), destination, goal, status: "PAUSED", ...bidSpec(bid, bidAmt) };
        if (!c.cbo) {
          const b = amount(budget, "Budget");
          if (!b) throw new Error("Type the ad set's budget.");
          if (budgetKind === "daily") spec.daily_budget = b;
          else spec.lifetime_budget = b;
        }
        spec.start_time = istInputToIso(start);
        spec.end_time = istInputToIso(end);
        if (spec.lifetime_budget !== undefined && !spec.end_time) throw new Error("A lifetime budget needs an end time.");
        if (conversions) {
          if (convKind === "pixel") {
            if (!pixel) throw new Error("Pick the pixel.");
            spec.pixel_id = pixel;
            spec.event = event;
            if (event === "OTHER") {
              if (!customEvent.trim()) throw new Error("Type the custom event name.");
              spec.custom_event_str = customEvent.trim();
            }
          } else {
            if (!customConv) throw new Error("Pick the custom conversion.");
            spec.custom_conversion_id = customConv;
          }
        }
        if (page) spec.page_id = page;
        if (audKind === "saved") {
          if (!saved) throw new Error("Pick the saved audience.");
          spec.saved_audience_id = saved;
        } else {
          const cs = countryList(countries);
          const extraCountries = places.filter((p) => p.type === "country").map((p) => p.country_code ?? itemId(p));
          const allCountries = [...new Set([...cs, ...extraCountries])];
          const regions = places.filter((p) => p.type === "region").map((p) => ({ key: itemId(p), name: p.name }));
          const cities = places.filter((p) => p.type === "city").map((p) => ({ key: itemId(p), name: p.name }));
          if (!allCountries.length && !regions.length && !cities.length) throw new Error("Add at least one country or city.");
          if (allCountries.length) spec.countries = allCountries;
          if (regions.length) spec.regions = regions;
          if (cities.length) spec.cities = cities;
          spec.age_min = whole(ageMin, "Minimum age");
          spec.age_max = whole(ageMax, "Maximum age");
          spec.genders = genders[gender as keyof typeof genders] ?? "all";
          if (interests.length) spec.interests = interests.map((i) => ({ id: itemId(i), name: i.name }));
          if (include.length) spec.custom_audiences = include.map((i) => ({ id: itemId(i), name: i.name }));
          if (exclude.length) spec.excluded_custom_audiences = exclude.map((i) => ({ id: itemId(i), name: i.name }));
        }
        spec.advantage_audience = advantage;
        if (placeKind === "advantage") spec.placements = "advantage";
        else {
          if (!platforms.length) throw new Error("Pick at least one platform for placements.");
          spec.placements = { platforms };
        }
        if (attribution) spec.attribution = attribution;
        await submit({ title: `New ad set "${spec.name}" in "${c.name}"`, ops: [{ type: "create_adset", campaign: c.id, ...spec }] });
      }}
    >
      <div className="row">
        <label><span>Ad set name</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Mumbai_25-45_Leads" /></label>
        <label>
          <span>Campaign</span>
          <select value={campaign} onChange={(e) => setCampaign(e.target.value)}>
            {tree.campaigns.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        </label>
      </div>

      <div className={s.section}>Budget and schedule (India time)</div>
      {c?.cbo ? (
        <p className="hint" style={{ marginBottom: 12 }}>This campaign has a campaign budget ({c.details.budget}). The ad set shares it.</p>
      ) : (
        <div className="row">
          <label>
            <span>Budget type</span>
            <select value={budgetKind} onChange={(e) => setBudgetKind(e.target.value as "daily" | "lifetime")}>
              <option value="daily">Daily budget</option>
              <option value="lifetime">Lifetime budget</option>
            </select>
          </label>
          <label><span>{budgetKind === "daily" ? "Daily budget (₹)" : "Lifetime budget (₹)"}</span><input value={budget} onChange={(e) => setBudget(e.target.value)} inputMode="decimal" placeholder="1500" /></label>
        </div>
      )}
      <div className="row">
        <label><span>Start (blank = when turned on)</span><input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} /></label>
        <label><span>End {budgetKind === "lifetime" && !c?.cbo ? "(needed)" : "(optional)"}</span><input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} /></label>
      </div>

      <div className={s.section}>Goal</div>
      <div className="row">
        <label><span>Conversion location</span><Select value={destination} onChange={setDestination} list={options.destinations} /></label>
        <label><span>Performance goal</span><Select value={goal} onChange={setGoal} list={options.goals} /></label>
      </div>
      {conversions && (
        <>
          <div className={s.radios} style={{ marginBottom: 10 }}>
            <label className="check"><input type="radio" checked={convKind === "pixel"} onChange={() => setConvKind("pixel")} />Pixel event</label>
            <label className="check"><input type="radio" checked={convKind === "custom"} onChange={() => setConvKind("custom")} />Custom conversion</label>
          </div>
          {convKind === "pixel" ? (
            <div className="row">
              <label><span>Pixel</span><ListSelect what="pixels" value={pixel} onChange={setPixel} none="Pick a pixel" /></label>
              <label><span>Event</span><Select value={event} onChange={setEvent} list={options.pixelEvents} /></label>
              {event === "OTHER" && <label><span>Custom event name</span><input value={customEvent} onChange={(e) => setCustomEvent(e.target.value)} /></label>}
            </div>
          ) : (
            <div className="row">
              <label><span>Custom conversion</span><ListSelect what="custom_conversions" value={customConv} onChange={setCustomConv} none="Pick one" /></label>
            </div>
          )}
        </>
      )}
      {destination !== "WEBSITE" && destination !== "APP" && (
        <div className="row">
          <label><span>Facebook Page (for forms, messages and calls)</span><ListSelect what="pages" value={page} onChange={setPage} none="Not needed" /></label>
        </div>
      )}
      <BidFields options={options} strategy={bid} setStrategy={setBid} amt={bidAmt} setAmt={setBidAmt} />

      <div className={s.section}>Audience</div>
      <div className={s.radios} style={{ marginBottom: 10 }}>
        <label className="check"><input type="radio" checked={audKind === "build"} onChange={() => setAudKind("build")} />Choose people here</label>
        <label className="check"><input type="radio" checked={audKind === "saved"} onChange={() => setAudKind("saved")} />Use a saved audience</label>
      </div>
      {audKind === "saved" ? (
        <div className="row">
          <label><span>Saved audience</span><ListSelect what="saved_audiences" value={saved} onChange={setSaved} none="Pick one" /></label>
        </div>
      ) : (
        <>
          <div className="row">
            <label><span>Countries (codes, comma between)</span><input value={countries} onChange={(e) => setCountries(e.target.value)} placeholder="IN" /></label>
          </div>
          <div className="row">
            <label className="field"><span>Cities or states (search)</span><SearchMulti what="locations" picked={places} onChange={setPlaces} placeholder="Type a city, e.g. Pune" /></label>
          </div>
          <p className="hint" style={{ marginTop: -6, marginBottom: 12 }}>To show ads only in some cities, clear the countries box.</p>
          <div className="row">
            <label><span>Age from</span><input value={ageMin} onChange={(e) => setAgeMin(e.target.value)} inputMode="numeric" /></label>
            <label><span>Age to</span><input value={ageMax} onChange={(e) => setAgeMax(e.target.value)} inputMode="numeric" /></label>
            <label><span>Gender</span><Select value={gender} onChange={setGender} list={options.genders} /></label>
          </div>
          <div className="row">
            <label className="field"><span>Interests (search)</span><SearchMulti what="interests" picked={interests} onChange={setInterests} placeholder="Type an interest, e.g. real estate" /></label>
          </div>
          <div className="row">
            <label className="field"><span>Custom audiences to include</span><ListMulti what="custom_audiences" picked={include} onChange={setInclude} /></label>
            <label className="field"><span>Custom audiences to leave out</span><ListMulti what="custom_audiences" picked={exclude} onChange={setExclude} /></label>
          </div>
        </>
      )}
      <label className="check" style={{ marginBottom: 12 }}>
        <input type="checkbox" checked={advantage} onChange={(e) => setAdvantage(e.target.checked)} />
        Advantage+ audience (let Meta reach people beyond these choices)
      </label>

      <div className={s.section}>Placements</div>
      <div className={s.radios} style={{ marginBottom: 10 }}>
        <label className="check"><input type="radio" checked={placeKind === "advantage"} onChange={() => setPlaceKind("advantage")} />Advantage+ placements (Meta picks)</label>
        <label className="check"><input type="radio" checked={placeKind === "manual"} onChange={() => setPlaceKind("manual")} />Pick platforms</label>
      </div>
      {placeKind === "manual" && (
        <div className={s.checkGrid} style={{ marginBottom: 12 }}>
          {options.placementPlatforms.map((p) => (
            <label key={p.value} className="check">
              <input type="checkbox" checked={platforms.includes(p.value)} onChange={(e) => setPlatforms(e.target.checked ? [...platforms, p.value] : platforms.filter((x) => x !== p.value))} />
              {p.label}
            </label>
          ))}
        </div>
      )}
      <div className="row">
        <label><span>Attribution</span><Select value={attribution} onChange={setAttribution} list={options.attribution} blank="Meta's default" /></label>
      </div>
    </FormBox>
  );
}

interface RawAdSet {
  bid_strategy?: string;
  bid_amount?: string;
  bid_constraints?: { roas_average_floor?: number };
  start_time?: string;
  end_time?: string;
  targeting?: { age_min?: number; age_max?: number; genders?: number[]; geo_locations?: { countries?: string[] }; targeting_automation?: { advantage_audience?: number } };
}

export function EditAdSetForm({ options, submit, close, adset: a, campaign: c }: FormProps & { adset: TreeAdSet; campaign: TreeCampaign }) {
  const [init, setInit] = useState<Record<string, string> | null>(null);
  const [v, setV] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState("");
  const set = (k: string) => (x: string) => setV((o) => ({ ...o, [k]: x }));

  useEffect(() => {
    api<{ raw: RawAdSet; currency: string }>(`/api/manage/object/adset/${a.id}`)
      .then(({ raw, currency }) => {
        const t = raw.targeting ?? {};
        const g = t.genders?.length === 1 ? String(t.genders[0]) : "all";
        const first: Record<string, string> = {
          name: a.name,
          daily: a.dailyBudget !== null ? String(a.dailyBudget) : "",
          lifetime: a.lifetimeBudget !== null ? String(a.lifetimeBudget) : "",
          bid: raw.bid_strategy ?? "",
          bidAmt: raw.bid_strategy === ROAS ? String((raw.bid_constraints?.roas_average_floor ?? 0) / 10000 || "") : String(fromMinor(raw.bid_amount, currency) ?? ""),
          start: isoToIstInput(raw.start_time),
          end: isoToIstInput(raw.end_time),
          ageMin: t.age_min !== undefined ? String(t.age_min) : "",
          ageMax: t.age_max !== undefined ? String(t.age_max) : "",
          gender: g,
          countries: (t.geo_locations?.countries ?? []).join(", "),
          advantage: t.targeting_automation?.advantage_audience === 1 ? "on" : "off",
        };
        setInit(first);
        setV(first);
      })
      .catch((e: Error) => setLoadError(e.message));
  }, [a.id, a.name, a.dailyBudget, a.lifetimeBudget]);

  if (loadError) {
    return (
      <div className={s.form}>
        <div className="msg error">Could not read this ad set: {loadError}</div>
        <button onClick={close}>Close</button>
      </div>
    );
  }
  if (!init) return <div className={s.form}><p className="muted">Loading the ad set…</p></div>;

  const changed = (k: string) => (v[k] ?? "") !== (init[k] ?? "");
  const genders = { all: "all", "1": "men", "2": "women" } as const;

  return (
    <FormBox
      title={`Edit ad set "${a.name}"`}
      close={close}
      onSubmit={async () => {
        const spec: AdSetSpec = {};
        if (changed("name") && v.name.trim()) spec.name = v.name.trim();
        if (changed("daily")) {
          const d = amount(v.daily, "Daily budget");
          if (!d) throw new Error("Type a daily budget above 0.");
          spec.daily_budget = d;
        }
        if (changed("lifetime")) {
          const d = amount(v.lifetime, "Lifetime budget");
          if (!d) throw new Error("Type a lifetime budget above 0.");
          spec.lifetime_budget = d;
        }
        if (changed("bid") || changed("bidAmt")) Object.assign(spec, bidSpec(v.bid, v.bidAmt));
        if (changed("start")) spec.start_time = istInputToIso(v.start);
        if (changed("end")) spec.end_time = istInputToIso(v.end);
        if (changed("ageMin")) spec.age_min = whole(v.ageMin, "Minimum age");
        if (changed("ageMax")) spec.age_max = whole(v.ageMax, "Maximum age");
        if (changed("gender")) spec.genders = genders[v.gender as keyof typeof genders] ?? "all";
        if (changed("countries")) {
          const cs = countryList(v.countries);
          if (!cs.length) throw new Error("Type at least one country code, like IN.");
          spec.countries = cs;
        }
        if (changed("advantage")) spec.advantage_audience = v.advantage === "on";
        for (const k of Object.keys(spec) as (keyof AdSetSpec)[]) if (spec[k] === undefined) delete spec[k];
        if (!Object.keys(spec).length) throw new Error("Nothing was changed.");
        await submit({ title: `Edit ad set "${a.name}"`, ops: [{ type: "edit_adset", adset: a.id, ...spec }] });
      }}
    >
      <div className="row">
        <label><span>Ad set name</span><input value={v.name} onChange={(e) => set("name")(e.target.value)} /></label>
      </div>
      {c.cbo ? (
        <p className="hint" style={{ marginBottom: 12 }}>Budget is set on the campaign ({c.details.budget}). Edit the campaign to change it.</p>
      ) : (
        <div className="row">
          {init.lifetime === "" ? (
            <label><span>Daily budget (₹)</span><input value={v.daily} onChange={(e) => set("daily")(e.target.value)} inputMode="decimal" /></label>
          ) : (
            <label><span>Lifetime budget (₹)</span><input value={v.lifetime} onChange={(e) => set("lifetime")(e.target.value)} inputMode="decimal" /></label>
          )}
        </div>
      )}
      <BidFields options={options} strategy={v.bid} setStrategy={set("bid")} amt={v.bidAmt} setAmt={set("bidAmt")} blank="Keep as it is" />
      <div className={s.section}>Schedule (India time)</div>
      <div className="row">
        <label><span>Start</span><input type="datetime-local" value={v.start} onChange={(e) => set("start")(e.target.value)} /></label>
        <label><span>End</span><input type="datetime-local" value={v.end} onChange={(e) => set("end")(e.target.value)} /></label>
      </div>
      <div className={s.section}>Audience</div>
      <div className="row">
        <label><span>Age from</span><input value={v.ageMin} onChange={(e) => set("ageMin")(e.target.value)} inputMode="numeric" /></label>
        <label><span>Age to</span><input value={v.ageMax} onChange={(e) => set("ageMax")(e.target.value)} inputMode="numeric" /></label>
        <label><span>Gender</span><Select value={v.gender} onChange={set("gender")} list={options.genders} /></label>
      </div>
      <div className="row">
        <label><span>Countries (codes, comma between)</span><input value={v.countries} onChange={(e) => set("countries")(e.target.value)} placeholder="IN" /></label>
        <label>
          <span>Advantage+ audience</span>
          <select value={v.advantage} onChange={(e) => set("advantage")(e.target.value)}>
            <option value="on">On</option>
            <option value="off">Off</option>
          </select>
        </label>
      </div>
      <p className="hint" style={{ marginTop: -6 }}>Changing countries replaces any cities or states on this ad set. Only the boxes you change are sent.</p>
    </FormBox>
  );
}

export function CopyAdSetForm({ tree, submit, close, adset: a, campaign: c }: FormProps & { adset: TreeAdSet; campaign: TreeCampaign }) {
  const [target, setTarget] = useState(c.id);
  const [copies, setCopies] = useState("1");
  const [withAds, setWithAds] = useState(true);
  const [rows, setRows] = useState<{ name: string; daily: string; bid: string }[]>([{ name: "", daily: "", bid: "" }]);
  const n = Math.min(Math.max(Number(copies) || 0, 0), 50);
  const t = tree.campaigns.find((x) => x.id === target) ?? c;

  useEffect(() => {
    setRows((r) => Array.from({ length: n }, (_, i) => r[i] ?? { name: "", daily: "", bid: "" }));
  }, [n]);

  const upd = (i: number, k: "name" | "daily" | "bid", val: string) => setRows(rows.map((x, j) => (j === i ? { ...x, [k]: val } : x)));

  return (
    <FormBox
      title={`Copy ad set "${a.name}"`}
      close={close}
      hint="Copies are made switched off. Nothing changes in Meta until you confirm the plan."
      onSubmit={async () => {
        const count = whole(copies, "Number of copies");
        if (!count || count < 1) throw new Error("Type how many copies to make (1 or more).");
        const changes: AdSetSpec[] = rows.slice(0, count).map((r, i) => {
          const ch: AdSetSpec = {};
          if (r.name.trim()) ch.name = r.name.trim();
          if (!t.cbo) {
            const d = amount(r.daily, `Copy ${i + 1} daily budget`);
            if (d !== undefined) ch.daily_budget = d;
          }
          const b = amount(r.bid, `Copy ${i + 1} bid amount`);
          if (b !== undefined) ch.bid_amount = b;
          return ch;
        });
        const op: Op = { type: "duplicate_adset", adset: a.id, copies: count, with_ads: withAds };
        if (target !== c.id) op.campaign = target;
        if (changes.some((ch) => Object.keys(ch).length)) op.changes = changes;
        await submit({ title: `Copy ad set "${a.name}" ${count} time${count > 1 ? "s" : ""}${target !== c.id ? ` into "${t.name}"` : ""}`, ops: [op] });
      }}
    >
      <div className="row">
        <label>
          <span>Put the copies in campaign</span>
          <select value={target} onChange={(e) => setTarget(e.target.value)}>
            {tree.campaigns.map((x) => <option key={x.id} value={x.id}>{x.name}{x.id === c.id ? " (same campaign)" : ""}</option>)}
          </select>
        </label>
        <label style={{ maxWidth: 180 }}><span>Number of copies</span><input value={copies} onChange={(e) => setCopies(e.target.value)} inputMode="numeric" /></label>
      </div>
      <label className="check" style={{ marginBottom: 12 }}>
        <input type="checkbox" checked={withAds} onChange={(e) => setWithAds(e.target.checked)} />
        Also copy its ads
      </label>
      {t.cbo && <p className="hint">“{t.name}” has a campaign budget, so the copies share it.</p>}
      {n > 0 && (
        <>
          <p className="hint" style={{ marginBottom: 6 }}>Leave a box blank to keep the original.</p>
          <div className="table-wrap">
            <table className={s.copyTable}>
              <thead><tr><th>Copy</th><th>Name</th>{!t.cbo && <th>Daily budget (₹)</th>}<th>Bid amount (₹)</th></tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td>{i + 1}</td>
                    <td><input value={r.name} placeholder={`${a.name} - copy ${i + 1}`} onChange={(e) => upd(i, "name", e.target.value)} /></td>
                    {!t.cbo && <td><input value={r.daily} placeholder={a.dailyBudget !== null ? String(a.dailyBudget) : ""} inputMode="decimal" onChange={(e) => upd(i, "daily", e.target.value)} /></td>}
                    <td><input value={r.bid} placeholder="Same" inputMode="decimal" onChange={(e) => upd(i, "bid", e.target.value)} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </FormBox>
  );
}

// ---------- Ads from an existing post ----------

export function PostAdsForm({ tree, submit, close }: FormProps) {
  const [postId, setPostId] = useState("");
  const [source, setSource] = useState<"facebook" | "instagram">("facebook");
  const [picked, setPicked] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [page, setPage] = useState("");

  return (
    <FormBox
      title="Ads from an existing post"
      close={close}
      hint="One ad per ad set, all using the same post, so likes and comments add up on it. Ads are made switched off."
      onSubmit={async () => {
        if (!postId.trim()) throw new Error("Type the post ID.");
        if (!picked.length) throw new Error("Tick at least one ad set.");
        const op: Op = { type: "ads_from_post", post_id: postId.trim(), source, adsets: picked, status: "PAUSED" };
        if (name.trim()) op.name = name.trim();
        if (source === "facebook" && page) op.page_id = page;
        await submit({ title: `Ads from post ${postId.trim()} in ${picked.length} ad set${picked.length > 1 ? "s" : ""}`, ops: [op] });
      }}
    >
      <div className="row">
        <label><span>Post ID</span><input value={postId} onChange={(e) => setPostId(e.target.value)} placeholder="e.g. 1234567890123456" /></label>
        <label>
          <span>The post is on</span>
          <select value={source} onChange={(e) => setSource(e.target.value as "facebook" | "instagram")}>
            <option value="facebook">Facebook</option>
            <option value="instagram">Instagram</option>
          </select>
        </label>
      </div>
      <div className="row">
        <label><span>Ad name (optional)</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Diwali offer post" /></label>
        {source === "facebook" && <label><span>Facebook Page of the post</span><ListSelect what="pages" value={page} onChange={setPage} none="Not needed (ID has the page)" /></label>}
      </div>
      <div className={s.section}>Ad sets to put the ad in</div>
      {tree.campaigns.filter((c) => c.adsets.length).map((c) => (
        <div key={c.id} style={{ marginBottom: 10 }}>
          <small>{c.name}</small>
          {c.adsets.map((a) => (
            <label key={a.id} className="check" style={{ marginTop: 4 }}>
              <input type="checkbox" checked={picked.includes(a.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, a.id] : picked.filter((x) => x !== a.id))} />
              {a.name} <span className="muted">({a.dailyBudget !== null ? `${rupees(a.dailyBudget)} a day` : a.details.budget})</span>
            </label>
          ))}
        </div>
      ))}
      {!tree.campaigns.some((c) => c.adsets.length) && <p className="muted">There are no ad sets yet.</p>}
    </FormBox>
  );
}
