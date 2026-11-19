"use client";

// New custom audiences and lookalikes. Like every change, each one becomes a plan to check and
// confirm first. Customer lists are sent hashed; the launcher keeps only the hashes.

import { useState } from "react";
import type { AudienceSource } from "@/lib/manage/audiences";
import { FormBox, Select, whole, type FormProps } from "./forms";
import s from "./manage.module.css";
import { ListSelect } from "./pickers";
import { countryList } from "./util";

type Kind = AudienceSource["kind"];
type Watched = Extract<AudienceSource, { kind: "video" }>["watched"];
type LeadAction = Extract<AudienceSource, { kind: "lead_form" }>["action"];

const KINDS: { value: Kind; label: string }[] = [
  { value: "website", label: "People who visited your website" },
  { value: "video", label: "People who watched your videos" },
  { value: "page", label: "People who engaged with your Facebook Page" },
  { value: "instagram", label: "People who engaged with your Instagram account" },
  { value: "lead_form", label: "People who opened or sent your lead form" },
  { value: "customer_list", label: "Your customer list (emails and phone numbers)" },
];

const MAX_DAYS: Record<string, number> = { website: 180, video: 365, page: 365, instagram: 365, lead_form: 90 };

const WATCHED = [
  { value: "3s", label: "At least 3 seconds" },
  { value: "thruplay", label: "ThruPlay (15 seconds or to the end)" },
  { value: "25%", label: "25% of the video" },
  { value: "50%", label: "50% of the video" },
  { value: "75%", label: "75% of the video" },
  { value: "95%", label: "95% of the video" },
];

const LEAD_ACTION = [
  { value: "opened", label: "Opened the form" },
  { value: "submitted", label: "Sent the form" },
  { value: "opened_not_submitted", label: "Opened but did not send" },
];

const SIZES = Array.from({ length: 10 }, (_, i) => ({ value: String(i + 1), label: `${i + 1}%${i === 0 ? " (most similar)" : i === 9 ? " (widest reach)" : ""}` }));

const list = (v: string) => v.split(/[,\n]+/).map((x) => x.trim()).filter(Boolean);

export function AudiencesPanel(props: FormProps) {
  const [which, setWhich] = useState<"custom" | "lookalike">("custom");
  return (
    <div className="panel">
      <header><h2>Audiences</h2></header>
      <p className="muted" style={{ marginTop: 0 }}>
        Make a new audience to use in ad sets. Meta fills it over the next few hours. Ad account rule: the Custom Audience terms must be accepted once in Ads Manager.
      </p>
      <div className={s.radios}>
        <label className="check"><input type="radio" checked={which === "custom"} onChange={() => setWhich("custom")} />New custom audience</label>
        <label className="check"><input type="radio" checked={which === "lookalike"} onChange={() => setWhich("lookalike")} />New lookalike audience</label>
      </div>
      {which === "custom" ? <CustomAudienceForm {...props} /> : <LookalikeForm {...props} />}
    </div>
  );
}

function CustomAudienceForm({ submit, close }: FormProps) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<Kind>("website");
  const [days, setDays] = useState("30");
  const [pixel, setPixel] = useState("");
  const [urls, setUrls] = useState("");
  const [event, setEvent] = useState("");
  const [videos, setVideos] = useState("");
  const [watched, setWatched] = useState("3s");
  const [page, setPage] = useState("");
  const [ig, setIg] = useState("");
  const [action, setAction] = useState("opened");
  const [people, setPeople] = useState("");

  const lines = people.split("\n").map((l) => l.trim()).filter(Boolean);
  const emails = lines.filter((l) => l.includes("@"));
  const phones = lines.filter((l) => !l.includes("@"));
  const max = MAX_DAYS[kind];

  return (
    <FormBox
      title="New custom audience"
      close={close}
      onSubmit={async () => {
        if (!name.trim()) throw new Error("Give the audience a name.");
        let source: AudienceSource;
        const d = () => {
          const n = whole(days, "Days");
          if (!n || n < 1 || n > max) throw new Error(`Days must be from 1 to ${max} for this kind of audience.`);
          return n;
        };
        switch (kind) {
          case "website":
            if (!pixel) throw new Error("Pick the pixel on your website.");
            source = { kind, pixel_id: pixel, days: d(), ...(list(urls).length ? { url_contains: list(urls) } : {}), ...(event.trim() ? { event: event.trim() } : {}) };
            break;
          case "video":
            if (!list(videos).length) throw new Error("Type at least one video ID.");
            source = { kind, video_ids: list(videos), days: d(), watched: watched as Watched };
            break;
          case "page":
            if (!page) throw new Error("Pick the Facebook Page.");
            source = { kind, page_id: page, days: d() };
            break;
          case "instagram":
            if (!ig.trim()) throw new Error("Type the Instagram account ID.");
            source = { kind, instagram_id: ig.trim(), days: d() };
            break;
          case "lead_form":
            if (!page) throw new Error("Pick the Facebook Page of the lead form.");
            source = { kind, page_id: page, days: d(), action: action as LeadAction };
            break;
          case "customer_list":
            if (!lines.length) throw new Error("Paste at least one email address or phone number.");
            source = { kind, ...(emails.length ? { emails } : {}), ...(phones.length ? { phones } : {}) };
            break;
        }
        await submit({ title: `New audience "${name.trim()}"`, ops: [{ type: "create_custom_audience", name: name.trim(), source }] });
      }}
    >
      <div className="row">
        <label><span>Audience name</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Website visitors 30 days" /></label>
        <label>
          <span>Who is in it</span>
          <select value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
            {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
          </select>
        </label>
      </div>

      {kind === "website" && (
        <>
          <div className="row">
            <label><span>Pixel on your website</span><ListSelect what="pixels" value={pixel} onChange={setPixel} none="Pick a pixel" /></label>
            <label style={{ maxWidth: 200 }}><span>In the last (days, 1–180)</span><input value={days} onChange={(e) => setDays(e.target.value)} inputMode="numeric" /></label>
          </div>
          <div className="row">
            <label><span>Only pages whose link contains (optional, comma between)</span><input value={urls} onChange={(e) => setUrls(e.target.value)} placeholder="e.g. /pricing, /checkout" /></label>
            <label><span>Only people who did this event (optional)</span><input value={event} onChange={(e) => setEvent(e.target.value)} placeholder="e.g. Lead or Purchase" /></label>
          </div>
        </>
      )}

      {kind === "video" && (
        <>
          <div className="row">
            <label><span>Video IDs (comma between)</span><input value={videos} onChange={(e) => setVideos(e.target.value)} placeholder="e.g. 1234567890, 2345678901" /></label>
          </div>
          <div className="row">
            <label><span>Watched</span><Select value={watched} onChange={setWatched} list={WATCHED} /></label>
            <label style={{ maxWidth: 200 }}><span>In the last (days, 1–365)</span><input value={days} onChange={(e) => setDays(e.target.value)} inputMode="numeric" /></label>
          </div>
        </>
      )}

      {(kind === "page" || kind === "lead_form") && (
        <div className="row">
          <label><span>Facebook Page</span><ListSelect what="pages" value={page} onChange={setPage} none="Pick a Page" /></label>
          {kind === "lead_form" && <label><span>People who</span><Select value={action} onChange={setAction} list={LEAD_ACTION} /></label>}
          <label style={{ maxWidth: 200 }}><span>In the last (days, 1–{max})</span><input value={days} onChange={(e) => setDays(e.target.value)} inputMode="numeric" /></label>
        </div>
      )}

      {kind === "instagram" && (
        <div className="row">
          <label><span>Instagram account ID</span><input value={ig} onChange={(e) => setIg(e.target.value)} placeholder="e.g. 17841400000000000" /></label>
          <label style={{ maxWidth: 200 }}><span>In the last (days, 1–365)</span><input value={days} onChange={(e) => setDays(e.target.value)} inputMode="numeric" /></label>
        </div>
      )}

      {kind === "customer_list" && (
        <>
          <div className="row">
            <label className="field">
              <span>One email address or phone number per line</span>
              <textarea rows={6} value={people} onChange={(e) => setPeople(e.target.value)} placeholder={"priya@example.com\n9876543210"} />
            </label>
          </div>
          <p className="hint" style={{ marginTop: -6 }}>
            {emails.length} email address{emails.length === 1 ? "" : "es"} and {phones.length} phone number{phones.length === 1 ? "" : "s"}.
            Indian numbers without +91 are read as Indian. They are sent to Meta hashed (scrambled); the launcher keeps only the hashes.
          </p>
        </>
      )}
    </FormBox>
  );
}

function LookalikeForm({ submit, close }: FormProps) {
  const [name, setName] = useState("");
  const [source, setSource] = useState("");
  const [country, setCountry] = useState("IN");
  const [size, setSize] = useState("1");

  return (
    <FormBox
      title="New lookalike audience"
      close={close}
      onSubmit={async () => {
        if (!name.trim()) throw new Error("Give the audience a name.");
        if (!source) throw new Error("Pick the audience to find people like.");
        const [cc] = countryList(country);
        if (!cc || !/^[A-Z]{2}$/.test(cc)) throw new Error("Type one country code, like IN.");
        await submit({ title: `New lookalike "${name.trim()}"`, ops: [{ type: "create_lookalike", name: name.trim(), source_audience: source, country: cc, size_percent: Number(size) }] });
      }}
    >
      <div className="row">
        <label><span>Audience name</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Lookalike 1% buyers IN" /></label>
        <label><span>Find people like</span><ListSelect what="custom_audiences" value={source} onChange={setSource} none="Pick an audience" /></label>
      </div>
      <div className="row">
        <label style={{ maxWidth: 200 }}><span>Country</span><input value={country} onChange={(e) => setCountry(e.target.value)} placeholder="IN" /></label>
        <label><span>Size (% of the country)</span><Select value={size} onChange={setSize} list={SIZES} /></label>
      </div>
      <p className="hint" style={{ marginTop: -6 }}>The source audience needs at least 100 people.</p>
    </FormBox>
  );
}
