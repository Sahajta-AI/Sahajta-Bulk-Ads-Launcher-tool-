import { createHash } from "node:crypto";
import fs from "node:fs";
import type { Clock } from "./pacer";

// A fake Graph API for tests and for running the app without a Meta token (META_MOCK=1).
// It enforces the Limited tier's numbers (60 points, read 1, write 3, 5-minute decay,
// 5-minute block) so pacing is tested against the real rules, and it refuses any ad or
// ad set that is not PAUSED, so the "never active" rule is enforced in every test.

type Obj = Record<string, unknown> & { id: string; name?: string };

export interface MockOptions {
  clock: Clock;
  capPoints?: number;
  blockMs?: number;
  videoProcessingMs?: number;
  chunkBytes?: number;
  /** Return no auto thumbnails, to test the ffmpeg fallback. */
  noThumbnails?: boolean;
  /** Refuse the name filter on /adcreatives (Meta doesn't document it there). */
  noCreativeFilter?: boolean;
  /** Refuse the resumable /video_ads flow, as Meta may for system users. */
  noResumableVideo?: boolean;
  /** Refuse several texts in a placement-customized creative (to test the fallback). */
  rejectPacMultiText?: boolean;
  /** Keep the fake account in this JSON file, so it survives a worker restart (kill tests). */
  stateFile?: string;
  /** Allow ACTIVE status (tests of "turn on" and go-live). Off by default: any ACTIVE is a test failure. */
  allowActive?: boolean;
  /** Add a campaign-budget campaign (c2, ₹1,000 a day) with an ad set (as3), budgets on c1/as1, and fake results. */
  richAccount?: boolean;
  /** Meta's account_status for the ad account (1 = active, 2 = disabled, 3 = unsettled). */
  accountStatus?: number;
  /** The ad account may not use the Page's Instagram account: refuse creatives with 200/1815199. */
  igNotAllowed?: boolean;
  /** Ad accounts the Facebook login shows (Connect Meta). Default: the practice account and one disabled account. */
  adAccounts?: { id: string; name: string; account_status: number; business?: { id: string; name: string } }[];
  /**
   * Send X-Ad-Account-Usage (default true). Real Meta on 18 Nov 2026 sent only
   * X-Business-Use-Case-Usage: pass false to test that production behaviour.
   */
  accountUsageHeader?: boolean;
  /**
   * Meta's hourly allowance per ad account (300 calls on the starter tier). When set, the
   * X-Business-Use-Case-Usage call_count is the real percent of it over the last hour, and calls
   * past it are refused (code 80004) with estimated_time_to_regain_access. Unset: a fixed 5%.
   */
  hourlyCalls?: number;
  /** Rows per page when a list call gives no `limit` (Meta's default, 25). A given `limit` is always
   *  honoured, with paging.next and cursors.after while more rows exist. */
  defaultPageSize?: number;
  /**
   * Ads in an Instant form ad set (destination_type ON_AD) need a lead form on the creative's button,
   * as on real Meta. Off by default for now: many older launch tests put link ads into the practice
   * account's as1, which is an Instant form ad set (see the META fix report).
   */
  leadFormRule?: boolean;
  /**
   * Take budget periods (POST {campaign}/budget_schedules), as real Meta does: kept on the campaign and
   * read back by GET {campaign}/budget_schedules. Off by default: older tests count on the practice
   * Meta refusing the send. Reading works either way (a campaign has no periods unless a test adds them
   * as `budget_schedules` rows: id, budget_value, budget_value_type, time_start, time_end, status).
   */
  budgetSchedules?: boolean;
}

type Fault = {
  match: (method: string, path: string) => boolean;
  kind: "network" | "timeout_after_create" | "error";
  error?: Record<string, unknown>;
  /** HTTP status of the error answer (default 400; real Meta sends 500 for code 1 and 2). */
  status?: number;
};

/** What GET {id}?metadata=1 answers as metadata.type for each kind of object. */
const META_TYPE: Record<string, string> = {
  campaign: "campaign",
  adset: "adset",
  ad: "adgroup",
  creative: "adcreative",
  page: "page",
  ig: "instagram_user",
  video: "video",
  image: "adimage",
  audience: "customaudience",
  pixel: "adspixel",
};

export class MockMeta {
  calls: { method: string; path: string; cost: number; t: number }[] = [];
  objects = new Map<string, Obj & { _type: string }>();
  throttled = 0;
  private seq = 1000;
  private score = 0;
  private scoreAt = 0;
  private blockedUntil = 0;
  private faults: Fault[] = [];
  private uploads = new Map<string, { videoId: string; size: number; received: number }>();
  private idem = new Map<string, { body: string; id: string }>();
  idempotentHits = 0;
  readonly accountId = "act_1001";

  constructor(private o: MockOptions) {
    if (o.stateFile && fs.existsSync(o.stateFile)) {
      const saved = JSON.parse(fs.readFileSync(o.stateFile, "utf8")) as { seq: number; objects: (Obj & { _type: string })[] };
      this.seq = saved.seq;
      for (const ob of saved.objects) this.objects.set(ob.id, ob);
      return;
    }
    this.add("campaign", { id: "c1", name: "November tests", status: "PAUSED", objective: "OUTCOME_TRAFFIC", special_ad_categories: [] });
    this.add("adset", { id: "as1", name: "November test ad set", campaign_id: "c1", status: "PAUSED", is_dynamic_creative: false, effective_status: "PAUSED" });
    this.add("adset", { id: "as2", name: "Dynamic creative ad set", campaign_id: "c1", status: "PAUSED", is_dynamic_creative: true, effective_status: "PAUSED" });
    this.add("page", { id: "p1", name: "Sahajta AI" });
    this.add("ig", { id: "ig1", username: "sahajta.ai" });
    if (o.richAccount) {
      const t = { geo_locations: { countries: ["IN"] }, age_min: 25, age_max: 55, targeting_automation: { advantage_audience: 0 } };
      Object.assign(this.objects.get("as1")!, { daily_budget: "50000", optimization_goal: "LEAD_GENERATION", billing_event: "IMPRESSIONS", destination_type: "ON_AD", bid_strategy: "LOWEST_COST_WITHOUT_CAP", targeting: t, promoted_object: { page_id: "p1" } });
      this.add("campaign", { id: "c2", name: "CBO campaign", status: "PAUSED", objective: "OUTCOME_LEADS", daily_budget: "100000", bid_strategy: "LOWEST_COST_WITHOUT_CAP", special_ad_categories: [] });
      this.add("adset", { id: "as3", name: "CBO ad set", campaign_id: "c2", status: "ACTIVE", is_dynamic_creative: false, effective_status: "CAMPAIGN_PAUSED", optimization_goal: "LEAD_GENERATION", billing_event: "IMPRESSIONS", targeting: t });
      this.add("pixel", { id: "px1", name: "Site pixel", last_fired_time: "2026-11-01T10:00:00+0000" });
      this.add("adset", { id: "as4", name: "Min-spend template", campaign_id: "c1", status: "PAUSED", is_dynamic_creative: false, effective_status: "PAUSED", daily_budget: "80000", daily_min_spend_target: "70000", optimization_goal: "LEAD_GENERATION", billing_event: "IMPRESSIONS", targeting: t });
    }
  }

  private add(type: string, o: Obj) {
    this.objects.set(o.id, { ...o, _type: type });
    return o;
  }

  private newId() {
    return String(++this.seq);
  }

  /** When Meta made an object, as Meta writes it ("2026-11-19T10:00:00+0000"), from the app's clock
   *  (Date.now, so a test with fake timers controls it), for lookups after a lost answer. */
  private madeNow() {
    return new Date(Date.now()).toISOString().replace(/\.\d{3}Z$/, "+0000");
  }

  of(type: string) {
    return [...this.objects.values()].filter((o) => o._type === type);
  }

  /** Make the next matching request fail in a chosen way. */
  inject(f: Fault) {
    this.faults.push(f);
  }

  private util(now: number) {
    const cap = this.o.capPoints ?? 60;
    // Linear decay: a full cap drains in 300 s.
    const decayed = Math.max(0, this.score - ((now - this.scoreAt) / 300_000) * cap);
    this.score = decayed;
    this.scoreAt = now;
    return decayed;
  }

  /** Marketing API calls of the last hour (refused ones count too, as on real Meta). */
  private hourCalls(now: number) {
    return this.calls.filter((c) => c.cost > 0 && now - c.t < 3_600_000);
  }

  /** Minutes until the oldest call of the hour ages out (the hourly allowance has room again). */
  private regainMin(now: number) {
    const hourly = this.o.hourlyCalls;
    if (!hourly) return 0;
    const list = this.hourCalls(now);
    if (list.length < hourly) return 0;
    return Math.max(1, Math.ceil((list[list.length - hourly].t + 3_600_000 - now) / 60_000));
  }

  private headers(now: number): Record<string, string> {
    const cap = this.o.capPoints ?? 60;
    const pct = Math.round((this.util(now) / cap) * 10000) / 100;
    // Seconds until the score is back to 0 (or until the block ends).
    const reset = this.blockedUntil > now ? Math.ceil((this.blockedUntil - now) / 1000) : Math.ceil((this.util(now) / cap) * 300);
    const hourly = this.o.hourlyCalls;
    const callCount = hourly ? Math.min(100, Math.round((this.hourCalls(now).length / hourly) * 100)) : 5;
    const bucTier = cap <= 60 ? "development_access" : "standard_access";
    const h: Record<string, string> = {
      "content-type": "application/json",
      "x-business-use-case-usage": JSON.stringify({
        "9001": [
          { type: "ads_management", call_count: callCount, total_cputime: 2, total_time: 3, estimated_time_to_regain_access: this.regainMin(now), ads_api_access_tier: bucTier },
          // Another use case of the same business: its numbers don't pace ads_management calls.
          { type: "ads_insights", call_count: 1, total_cputime: 1, total_time: 1, estimated_time_to_regain_access: 0, ads_api_access_tier: bucTier },
        ],
      }),
    };
    if (this.o.accountUsageHeader !== false) {
      h["x-ad-account-usage"] = JSON.stringify({ acc_id_util_pct: pct, reset_time_duration: reset, ads_api_access_tier: cap > 1000 ? "standard_access" : "development_access" });
    }
    return h;
  }

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.pathname.replace(/^\/v\d+\.\d+\/?/, "");
    const now = this.o.clock.now();

    if (url.hostname.startsWith("rupload")) {
      const videoId = url.pathname.split("/").pop()!;
      const v = this.objects.get(videoId);
      const headers = new Headers(init?.headers);
      const bytes = init?.body ? Buffer.from(await new Response(init.body as BodyInit).arrayBuffer()) : Buffer.alloc(0);
      if (!v || !headers.get("authorization")?.startsWith("OAuth ")) return this.json({ error: { message: "Bad upload", code: 100 } }, now, 400);
      const offset = Number(headers.get("offset"));
      if (offset !== v.received) return this.json({ error: { message: "Wrong offset", code: 100 } }, now, 400);
      v.received = offset + bytes.length;
      v.size = Number(headers.get("file_size"));
      this.calls.push({ method: "POST", path: `rupload/${videoId}`, cost: 0, t: now });
      return this.json({ success: true }, now);
    }

    const params = await this.params(url, init);
    // Connect Meta: only tokens this fake handed out (or a pasted "practice-…" one) are valid for /me.
    if (path === "me" || path.startsWith("me/")) {
      const bearer = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? "";
      if (!bearer.startsWith("practice")) return this.json({ error: { message: "Invalid OAuth access token - Cannot parse access token", type: "OAuthException", code: 190 } }, now, 400);
    }
    const cost = method === "GET" ? 1 : 3;
    this.calls.push({ method, path, cost, t: now });

    const fault = this.faults.find((f) => f.match(method, path));
    if (fault && fault.kind !== "timeout_after_create") {
      this.faults.splice(this.faults.indexOf(fault), 1);
      if (fault.kind === "network") throw new TypeError("fetch failed (simulated)");
      return this.json({ error: fault.error ?? { message: "Simulated error", code: 100 } }, now, fault.status ?? 400);
    }

    // Rate limit, Limited tier rules.
    if (now < this.blockedUntil) {
      this.throttled++;
      return this.json({ error: { message: "User request limit reached", code: 17, error_subcode: 2446079, is_transient: true } }, now, 400);
    }
    // The hourly allowance (when the test sets one); this call is already counted.
    if (this.o.hourlyCalls && this.hourCalls(now).length > this.o.hourlyCalls) {
      this.throttled++;
      return this.json({ error: { message: "There have been too many calls from this ad-account. Wait a bit and try again.", code: 80004, error_subcode: 2446079, is_transient: true } }, now, 400);
    }
    const cap = this.o.capPoints ?? 60;
    if (this.util(now) + cost > cap) {
      this.blockedUntil = now + (this.o.blockMs ?? 300_000);
      this.throttled++;
      return this.json({ error: { message: "User request limit reached", code: 17, error_subcode: 2446079, is_transient: true } }, now, 400);
    }
    this.score += cost;

    // X-Client-Idempotent-Key: same key + same body returns the first object.
    const idemKey = new Headers(init?.headers).get("x-client-idempotent-key");
    const bodyKey = JSON.stringify(params);
    if (idemKey && method === "POST") {
      const prev = this.idem.get(idemKey);
      if (prev && prev.body === bodyKey) {
        this.idempotentHits++;
        return this.json({ id: prev.id }, now);
      }
      if (prev) return this.json({ error: { message: "Idempotency key reused with a different request", code: 100, error_subcode: 1349016 } }, now, 400);
    }
    const result = this.route(method, path, params, now);
    if (method !== "GET" && this.o.stateFile) {
      const tmp = `${this.o.stateFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ seq: this.seq, objects: [...this.objects.values()] }));
      fs.renameSync(tmp, this.o.stateFile);
    }
    if (idemKey && method === "POST" && result.status === 200) this.idem.set(idemKey, { body: bodyKey, id: String((result.body as { id?: string }).id) });
    if (fault?.kind === "timeout_after_create") {
      // The object was created, but the answer never arrives.
      this.faults.splice(this.faults.indexOf(fault), 1);
      throw new TypeError("network timeout after create (simulated)");
    }
    return this.json(result.body, now, result.status);
  };

  private json(body: unknown, now: number, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: this.headers(now) });
  }

  private async params(url: URL, init?: RequestInit): Promise<Record<string, unknown>> {
    const p: Record<string, unknown> = {};
    for (const [k, v] of url.searchParams) p[k] = v;
    const body = init?.body;
    if (body instanceof FormData) {
      for (const [k, v] of body) {
        p[k] = typeof v === "string" ? v : Buffer.from(await (v as Blob).arrayBuffer());
        // The file name sent with an upload (Meta keeps it as the image's name in the library).
        if (typeof v !== "string" && (v as File).name) p[`${k}__name`] = (v as File).name;
      }
    } else if (typeof body === "string") {
      for (const [k, v] of new URLSearchParams(body)) p[k] = v;
    }
    for (const [k, v] of Object.entries(p)) {
      if (typeof v === "string" && /^[[{]/.test(v)) {
        try {
          p[k] = JSON.parse(v);
        } catch {
          /* keep string */
        }
      }
    }
    return p;
  }

  /** Meta's `filtering` on list edges: name (CONTAIN, EQUAL, STARTS_WITH) and IN / NOT_IN on any field,
   *  including id, adset.id and campaign.id. */
  private nameFilter(params: Record<string, unknown>) {
    const list = (params.filtering as { field: string; operator: string; value: unknown }[] | undefined) ?? [];
    const fieldOf = (o: Obj, field: string): unknown => {
      if (field === "name") return o.name ?? "";
      if (field === "adset.id") return o.adset_id;
      if (field === "campaign.id") return o.campaign_id ?? this.objects.get(String(o.adset_id ?? ""))?.campaign_id;
      return o[field];
    };
    return (o: Obj) =>
      list.every((f) => {
        const raw = fieldOf(o, f.field);
        const v = String(raw ?? "");
        const value = f.value;
        if (f.operator === "CONTAIN") return v.includes(String(value));
        if (f.operator === "EQUAL") return v === String(value);
        if (f.operator === "STARTS_WITH") return v.startsWith(String(value));
        if (f.operator === "IN" || f.operator === "NOT_IN") {
          const set = (Array.isArray(value) ? value : [value]).map(String);
          const has = raw !== undefined && raw !== null && set.includes(v);
          return f.operator === "IN" ? has : !has;
        }
        return true;
      });
  }

  /** One page of a list, as Meta pages it: `limit` rows from the `after` cursor, with paging.next when more rows exist. */
  private page(list: unknown[], p: Record<string, unknown>) {
    const limit = p.limit !== undefined && p.limit !== "" ? Math.max(1, Number(p.limit) || 25) : (this.o.defaultPageSize ?? 25);
    const start = typeof p.after === "string" && /^o\d+$/.test(p.after) ? Number(p.after.slice(1)) : 0;
    const data = list.slice(start, start + limit);
    const end = start + data.length;
    const paging = end < list.length ? { cursors: { before: `o${start}`, after: `o${end}` }, next: `https://graph.facebook.com/v26.0/next?after=o${end}` } : { cursors: {} };
    return { data, paging };
  }

  private fields(o: Obj, params: Record<string, unknown>) {
    // Split "a,b,creative{x,y}" at top-level commas.
    const want: string[] = [];
    let depth = 0;
    let cur = "";
    for (const ch of String(params.fields ?? "id,name")) {
      if (ch === "{") depth++;
      if (ch === "}") depth--;
      if (ch === "," && depth === 0) { want.push(cur); cur = ""; } else cur += ch;
    }
    if (cur) want.push(cur);
    const out: Record<string, unknown> = { id: o.id };
    for (const f of want) {
      const m = /^(\w+)\{(.*)\}$/.exec(f);
      if (m && m[1] === "creative" && o.creative_id) {
        const c = this.objects.get(String(o.creative_id));
        if (c) out.creative = this.fields({ ...(c.body as Obj), ...c }, { fields: m[2] });
        continue;
      }
      // Meta's field expansion of an ad's ad set: "adset{name}".
      if (m && m[1] === "adset" && o.adset_id) {
        const a = this.objects.get(String(o.adset_id));
        if (a) out.adset = this.fields(a, { fields: m[2] });
        continue;
      }
      if (f in o) out[f] = o[f];
    }
    return out;
  }

  private route(method: string, path: string, p: Record<string, unknown>, now: number): { status: number; body: unknown } {
    const ok = (body: unknown) => ({ status: 200, body });
    const fail = (message: string, code = 100) => ({ status: 400, body: { error: { message, code, error_user_msg: message } } });
    const [first, edge] = path.split("/");
    const act = this.accountId;

    if (path === "") return fail("Root requests with ?ids= are not supported from v26.0");

    // Connect Meta: Facebook login code → short token → 60-day token; system-user tokens never expire.
    if (path === "oauth/access_token" && method === "POST") {
      if (p.client_id !== "mock-app" || p.client_secret !== "mock-secret") return fail("Invalid client_id or client_secret", 101);
      if (p.code) return p.code === "practice" ? ok({ access_token: "practice-short-token", token_type: "bearer", expires_in: 7200 }) : fail("Invalid verification code format.");
      if (p.grant_type === "fb_exchange_token") return ok({ access_token: "practice-long-token", token_type: "bearer", expires_in: 5_184_000 });
      return fail("Missing code");
    }
    if (path === "debug_token") {
      const t = String(p.input_token ?? "");
      const scopes = ["ads_management", "ads_read", "business_management", "pages_show_list", "pages_read_engagement", "pages_manage_ads"];
      if (t.includes("system")) return ok({ data: { app_id: "mock-app", type: "SYSTEM_USER", is_valid: true, expires_at: 0, scopes } });
      const life = t.includes("long") ? 5_184_000 : 7200;
      return ok({ data: { app_id: "mock-app", type: "USER", is_valid: true, expires_at: Math.floor(now / 1000) + life, scopes } });
    }
    if (first === "me" && method === "GET") {
      if (!edge) return ok({ id: "u1", name: "Practice user" });
      if (edge === "adaccounts") {
        const list = this.o.adAccounts ?? [
          { id: act, name: "Sahajta (practice)", account_status: 1, business: { id: "b1", name: "Sahajta AI" } },
          { id: "act_3003", name: "Old account (practice)", account_status: 2, business: { id: "b1", name: "Sahajta AI" } },
        ];
        return ok(this.page(list.map((a) => ({ ...a, currency: "INR" })), p));
      }
      if (edge === "accounts") {
        const ig = this.of("ig")[0];
        return ok(this.page(this.of("page").map((pg) => ({ id: pg.id, name: pg.name, instagram_business_account: ig ? { id: ig.id, username: ig.username } : undefined })), p));
      }
    }

    if (path === "search" && method === "GET") {
      if (p.type === "adinterest") return ok({ data: [{ id: "6003", name: `Real estate (${String(p.q)})`, audience_size_lower_bound: 1000000 }] });
      return ok({ data: [{ key: "1234", name: String(p.q), type: "city", country_code: "IN" }] });
    }
    if (first === act && method === "GET" && edge === "generatepreviews") {
      const cr = p.creative as { object_story_spec?: unknown; asset_feed_spec?: unknown } | undefined;
      if (!cr?.object_story_spec) return fail("creative spec is required");
      return ok({ data: [{ body: `<iframe src="https://mock.facebook.com/ads/api/preview_iframe.php?d=x&amp;format=${String(p.ad_format)}" width="320" height="560"></iframe>` }] });
    }
    if (first === act && method === "GET" && edge === "insights") {
      const level = String(p.level ?? "ad");
      const list = level === "account" ? [{ id: act, name: "acct" }] : this.of(level === "adset" ? "adset" : level);
      const rows = list.map((o, i) => ({
        [`${level}_id`]: o.id,
        [`${level}_name`]: o.name,
        spend: String(1000 + i * 100),
        impressions: String(50000 + i),
        reach: "30000",
        clicks: "900",
        inline_link_clicks: "600",
        ctr: "1.8",
        cpm: "20",
        actions: [{ action_type: "lead", value: String(20 + i) }, { action_type: "landing_page_view", value: "400" }],
        cost_per_action_type: [{ action_type: "lead", value: String((1000 + i * 100) / (20 + i)) }],
        date_start: "2026-11-10",
      }));
      return ok(this.page(rows, p));
    }
    // Another ad account the login can see (Connect Meta): no Instagram account assigned to it.
    if (first !== act && first.startsWith("act_") && method === "GET" && edge === "instagram_accounts" && (this.o.adAccounts ?? []).some((a) => a.id === first)) {
      return ok(this.page([], p));
    }
    if (first === act && method === "GET") {
      // The image library by hash: GET act/adimages?hashes=["h1","h2"] (each image's hash and the file name it was uploaded with).
      if (edge === "adimages") {
        const want = new Set((typeof p.hashes === "string" ? (JSON.parse(p.hashes) as string[]) : ((p.hashes as string[] | undefined) ?? [])).map(String));
        return ok(this.page(this.of("image").filter((o) => !want.size || want.has(String(o.hash ?? o.id))).map((o) => ({ hash: o.hash ?? o.id, name: o.name, id: o.id })), p));
      }
      const typeOf: Record<string, string> = { campaigns: "campaign", adsets: "adset", ads: "ad", adcreatives: "creative", promote_pages: "page", instagram_accounts: "ig", customaudiences: "audience", adspixels: "pixel" };
      if (!edge) return ok({ id: act, name: "Sahajta AI (mock)", currency: "INR", timezone_name: "Asia/Kolkata", account_status: this.o.accountStatus ?? 1, amount_spent: "0", spend_cap: "0", funding_source_details: { display_string: "Visa *1234" } });
      if (edge === "instagram_accounts" && this.o.igNotAllowed) return ok({ data: [], paging: { cursors: {} } });
      const t = typeOf[edge];
      if (!t) return fail(`Unknown edge ${edge}`);
      // Real Meta has no name filter for creatives (1A, 20 Nov 2026): "(#100) Filtering field 'name' with operation 'contain' is not supported".
      if (edge === "adcreatives" && p.filtering && (this.o.noCreativeFilter || JSON.stringify(p.filtering).includes('"name"'))) return fail(`Filtering field 'name' with operation 'contain' is not supported`, 100);
      // Real Meta refuses DELETED in an account-level list's effective_status (code 100, subcode 1815001; checked 19 Nov 2026).
      if (JSON.stringify(p.effective_status ?? "").includes("DELETED")) return { status: 400, body: { error: { message: "Invalid parameter", code: 100, error_subcode: 1815001 } } };
      const list = this.of(t).filter(this.nameFilter(p)).filter((o) => !p.campaign_id || o.campaign_id === p.campaign_id).map((o) => this.fields(o, p));
      return ok(this.page(list, p));
    }

    if (first === act && method === "POST") {
      if (edge === "adimages") {
        const bytes = p.filename as Buffer;
        const hash = createHash("md5").update(bytes).digest("hex");
        this.add("image", { id: hash, hash, name: typeof p.filename__name === "string" ? p.filename__name : "image" });
        return ok({ images: { file: { hash, url: `https://mock/${hash}.jpg` } } });
      }
      if (edge === "video_ads") {
        if (this.o.noResumableVideo) return fail("Uploading videos to business accounts is not yet supported for system users", 100);
        if (p.upload_phase === "start") {
          const videoId = this.newId();
          this.add("video", { id: videoId, name: "video", received: 0, size: -1, status: { video_status: "uploading" } });
          return ok({ video_id: videoId, upload_url: `https://rupload.facebook.com/video-ads-upload/v26.0/${videoId}` });
        }
        if (p.upload_phase === "finish") {
          const v = this.objects.get(String(p.video_id));
          if (!v || v.received !== v.size) return fail("Upload incomplete", 6001);
          v.status = { video_status: "processing", processing_progress: 0 };
          v.readyAt = now + (this.o.videoProcessingMs ?? 60_000);
          return ok({ success: true });
        }
      }
      if (edge === "advideos") {
        if (p.upload_phase === "start") {
          const videoId = this.newId();
          const session = `s${videoId}`;
          const size = Number(p.file_size);
          this.uploads.set(session, { videoId, size, received: 0 });
          this.add("video", { id: videoId, name: "video", status: { video_status: "uploading" } });
          return ok({ video_id: videoId, upload_session_id: session, start_offset: "0", end_offset: String(Math.min(size, this.chunk)) });
        }
        if (p.upload_phase === "transfer") {
          const u = this.uploads.get(String(p.upload_session_id));
          if (!u) return fail("Upload session expired", 6000);
          const chunk = p.video_file_chunk as Buffer;
          u.received = Number(p.start_offset) + chunk.length;
          return ok({ start_offset: String(u.received), end_offset: String(Math.min(u.size, u.received + this.chunk)) });
        }
        if (p.upload_phase === "finish") {
          const u = this.uploads.get(String(p.upload_session_id));
          if (!u || u.received !== u.size) return fail("Upload incomplete", 6001);
          const v = this.objects.get(u.videoId)!;
          v.status = { video_status: "processing", processing_progress: 0 };
          v.readyAt = now + (this.o.videoProcessingMs ?? 60_000);
          return ok({ success: true });
        }
      }
      if (edge === "adcreatives") {
        const afs = p.asset_feed_spec as { asset_customization_rules?: unknown[]; bodies?: unknown[] } | undefined;
        if (this.o.rejectPacMultiText && afs?.asset_customization_rules && (afs.bodies?.length ?? 0) > 1) return fail("Invalid parameter: body_label must refer to one body", 100);
        // Real Meta (20 Nov 2026, validate_only on 1A): one description in an ad with placement rules.
        if (afs?.asset_customization_rules && ((afs as { descriptions?: unknown[] }).descriptions?.length ?? 0) > 1) {
          return { status: 400, body: { error: { message: "Invalid parameter", code: 100, error_subcode: 1885878, error_user_title: "Invalid asset count in dynamic creative target rule", error_user_msg: "Multiple descriptions assets cannot be applied to rule no. 1 (priority number if specified, or the index of the rule) in the ad asset feed." } } };
        }
        const fromPost = !!(p.object_story_id || p.source_instagram_media_id);
        const ossLink = p.object_story_spec as { link_data?: { link?: string }; video_data?: unknown } | undefined;
        const afsAny = p.asset_feed_spec as { optimization_type?: string } | undefined;
        if (afsAny?.optimization_type === "DEGREES_OF_FREEDOM" && !ossLink?.link_data?.link && !ossLink?.video_data) {
          return { status: 400, body: { error: { message: "Invalid parameter", code: 100, error_subcode: 2061015, error_user_title: "Required field is missing", error_user_msg: "The link field is required. Please complete the field to continue." } } };
        }
        // Real Meta (18 Nov 2026): an Instagram post that was made for an ad is refused as source_instagram_media_id.
        if (String(p.source_instagram_media_id ?? "").startsWith("ig_")) {
          return { status: 400, body: { error: { message: "Invalid parameter", code: 100, error_subcode: 1815897, error_user_title: "Invalid Instagram story ID", error_user_msg: "The instagram_story_id value doesn't belong to an Instagram organic story." } } };
        }
        const oss = p.object_story_spec as { instagram_user_id?: string } | undefined;
        if (this.o.igNotAllowed && oss?.instagram_user_id) return { status: 400, body: { error: { message: "Permissions error", code: 200, error_subcode: 1815199, error_user_title: "No permission to use this Instagram account", error_user_msg: "The ad account is not allowed to advertise with this Instagram account." } } };
        if ((p.execution_options as string[] | undefined)?.includes("validate_only")) return ok({ success: true });
        if (!fromPost && !String(p.name ?? "").includes("[L:")) return fail("Test guard: creative name has no launch key");
        const dof = (p.degrees_of_freedom_spec as { creative_features_spec?: Record<string, unknown> } | undefined)?.creative_features_spec ?? {};
        if ("standard_enhancements" in dof) return fail("standard_enhancements is deprecated");
        const id = this.newId();
        this.add("creative", { id, name: String(p.name), body: p, object_story_id: p.object_story_id, object_story_spec: p.object_story_spec, asset_feed_spec: p.asset_feed_spec, url_tags: p.url_tags, effective_object_story_id: p.object_story_id ?? `p1_${id}`, effective_instagram_media_id: p.source_instagram_media_id ?? `ig_${id}`, degrees_of_freedom_spec: { creative_features_spec: { ...dof, new_feature_june_2026: { enroll_status: "OPT_OUT" } } } });
        return ok({ id });
      }
      if (edge === "ads") {
        if (p.status !== "PAUSED" && !this.o.allowActive) throw new Error(`TEST GUARD: ad created with status ${String(p.status)}`);
        const cr = this.objects.get((p.creative as { creative_id: string }).creative_id);
        // A launch names its ads with its key; a new ad on a creative another ad already uses (a copied ad
        // on the same post) is not a launch.
        const reused = this.of("ad").some((a) => a.creative_id === (p.creative as { creative_id?: string } | undefined)?.creative_id);
        if (!reused && !cr?.object_story_id && !(cr?.body as { source_instagram_media_id?: string } | undefined)?.source_instagram_media_id && !String(p.name ?? "").includes("[L:")) return fail("Test guard: ad name has no launch key");
        const adset = this.objects.get(String(p.adset_id));
        if (!adset) return fail("Ad set does not exist");
        const creativeId = (p.creative as { creative_id: string }).creative_id;
        if (!this.objects.get(creativeId)) return fail("Creative does not exist");
        // Real Meta: an ad in an Instant form ad set needs a lead form on its button.
        if (this.o.leadFormRule && adset.destination_type === "ON_AD" && !this.hasLeadForm(this.objects.get(creativeId)!)) {
          return { status: 400, body: { error: { message: "Invalid parameter", code: 100, error_user_title: "Instant form required", error_user_msg: "This ad set uses instant forms. Add an instant form (lead form) to the ad's call to action." } } };
        }
        const id = this.newId();
        this.add("ad", { id, name: String(p.name), adset_id: String(p.adset_id), creative_id: creativeId, status: String(p.status), effective_status: "PENDING_REVIEW", created_time: this.madeNow() });
        return ok({ id });
      }
      if (edge === "customaudiences") {
        if (!p.name) return fail("name is required");
        if (p.subtype === "LOOKALIKE" && !this.objects.get(String(p.origin_audience_id))) return fail("Origin audience does not exist");
        const id = this.newId();
        this.add("audience", { id, name: String(p.name), subtype: p.subtype ?? "WEBSITE", rule: p.rule, lookalike_spec: p.lookalike_spec, approximate_count_lower_bound: 1000, users: [] as unknown[], time_created: Math.floor(Date.now() / 1000) });
        return ok({ id });
      }
      if (edge === "campaigns") {
        if (p.status !== "PAUSED" && !this.o.allowActive) throw new Error("TEST GUARD: campaign not paused");
        if (!p.objective) return fail("objective is required");
        if (p.bid_strategy && !p.daily_budget && !p.lifetime_budget) {
          return { status: 400, body: { error: { message: "Invalid parameter", code: 100, error_subcode: 1885737, error_user_title: "No budget for campaign", error_user_msg: "Add a budget to edit the bid strategy." } } };
        }
        if ((p.execution_options as string[] | undefined)?.includes("validate_only")) return ok({ success: true });
        const id = this.newId();
        const { execution_options: _e, ...rest } = p;
        this.add("campaign", { ...rest, id, name: String(p.name), status: String(p.status), objective: p.objective, special_ad_categories: p.special_ad_categories, created_time: this.madeNow() });
        return ok({ id });
      }
      if (edge === "adsets") {
        if (p.status !== "PAUSED" && !this.o.allowActive) throw new Error("TEST GUARD: ad set not paused");
        const camp = this.objects.get(String(p.campaign_id));
        if (!camp) return fail("Campaign does not exist");
        const cbo = !!(Number(camp.daily_budget) || Number(camp.lifetime_budget));
        if (cbo && (p.daily_budget || p.lifetime_budget)) return fail("Can't set an ad set budget in a campaign with campaign budget", 100);
        if (!cbo && !p.daily_budget && !p.lifetime_budget) return fail("Ad set needs a budget", 100);
        if (!p.optimization_goal) return fail("optimization_goal is required");
        const tooMuch = this.minSpendRefused(String(p.campaign_id), null, Number(p.daily_min_spend_target));
        if (tooMuch) return tooMuch;
        // Meta (18 Nov 2026, plan psx4n): an ad set in a campaign without campaign budget and
        // without bid strategy is refused as if it were a bid cap.
        if (!cbo && !p.bid_strategy) {
          return { status: 400, body: { error: { message: "Invalid parameter", code: 100, error_subcode: 2490487, error_user_title: "Bid amount or bid constraints required for bid strategy", error_user_msg: "For a bid cap, provide bid_amount." } } };
        }
        if (cbo && p.bid_strategy && p.bid_strategy !== camp.bid_strategy && !["LOWEST_COST_WITH_BID_CAP", "COST_CAP"].includes(String(p.bid_strategy))) {
          return fail("The ad set's bid strategy must match the campaign's", 100);
        }
        if ((p.execution_options as string[] | undefined)?.includes("validate_only")) return ok({ success: true });
        const id = this.newId();
        const { execution_options: _e, ...rest } = p;
        this.add("adset", { ...rest, id, name: String(p.name), campaign_id: String(p.campaign_id), status: String(p.status), is_dynamic_creative: false, effective_status: String(p.status), created_time: this.madeNow() });
        return ok({ id });
      }
    }

    const obj = this.objects.get(first);
    if (!obj) return fail(`Object ${first} does not exist`, 100);

    if (method === "POST" && edge === "users" && obj._type === "audience") {
      const payload = p.payload as { schema: string[]; data: string[][] };
      (obj.users as unknown[]).push(...payload.data);
      return ok({ num_received: payload.data.length });
    }
    if (method === "GET" && edge === "adsets") {
      return ok(this.page(this.of("adset").filter((a) => a.campaign_id === obj.id).filter(this.nameFilter(p)).map((a) => this.fields(a, p)), p));
    }
    if (method === "GET" && edge === "ads") {
      const list = this.of("ad").filter((a) => a.adset_id === obj.id).filter(this.nameFilter(p));
      if (p.summary) return ok({ data: list.slice(0, 1).map((a) => this.fields(a, p)), summary: { total_count: list.length }, paging: { cursors: {} } });
      return ok(this.page(list.map((a) => this.fields(a, p)), p));
    }
    if (edge === "budget_schedules" && obj._type === "campaign") {
      const rows = (obj.budget_schedules as Obj[] | undefined) ?? [];
      if (method === "GET") return ok(this.page(rows.map((r) => this.fields(r, p)), p));
      if (method === "POST" && this.o.budgetSchedules) {
        // Meta's budget scheduling: a daily campaign budget only; a fixed amount (minor units) or a multiplier.
        if (!Number(obj.daily_budget)) return fail("Budget scheduling needs a daily campaign budget");
        const type = String(p.budget_value_type ?? "");
        if (!["ABSOLUTE", "MULTIPLIER"].includes(type)) return fail("budget_value_type must be ABSOLUTE or MULTIPLIER");
        const start = Number(p.time_start);
        const end = Number(p.time_end);
        if (!(end > start)) return fail("time_end must be after time_start");
        const id = this.newId();
        obj.budget_schedules = [...rows, { id, budget_value: String(p.budget_value), budget_value_type: type, time_start: start, time_end: end, status: "ACTIVE" }];
        return ok({ id });
      }
    }
    if (method === "GET" && edge === "thumbnails") {
      return ok({ data: this.o.noThumbnails ? [] : [{ id: `${obj.id}_t`, uri: `https://mock/thumb/${obj.id}.jpg`, is_preferred: true }] });
    }
    if (method === "GET" && !edge) {
      if (obj._type === "video" && typeof obj.readyAt === "number" && now >= obj.readyAt) obj.status = { video_status: "ready", processing_progress: 100 };
      if (obj._type === "video" && typeof obj.received === "number") (obj.status as Record<string, unknown>).uploading_phase = { bytes_transferred: obj.received };
      const out = this.fields(obj, p);
      // ?metadata=1: Meta says what kind of object the ID is.
      if (String(p.metadata ?? "") === "1" || p.metadata === true) out.metadata = { type: META_TYPE[obj._type] ?? obj._type };
      return ok(out);
    }
    if (method === "POST" && edge === "copies") {
      if (p.status_option !== "PAUSED") throw new Error("TEST GUARD: copy not paused");
      if (p.deep_copy === true || p.deep_copy === "true") {
        // Meta (plan pwjd6): a deep copy may hold fewer than 3 objects in all.
        const kids = obj._type === "campaign" ? this.of("adset").filter((a) => a.campaign_id === obj.id) : obj._type === "adset" ? this.of("ad").filter((a) => a.adset_id === obj.id) : [];
        const grandKids = obj._type === "campaign" ? this.of("ad").filter((a) => kids.some((k) => k.id === a.adset_id)) : [];
        if (1 + kids.length + grandKids.length >= 3) {
          return { status: 400, body: { error: { message: "Invalid parameter", code: 100, error_subcode: 1885194, error_user_title: "Copy request is too large", error_user_msg: "The total number of ads, ad sets and campaigns to copy at once must be fewer than 3." } } };
        }
      }
      if (obj._type === "ad") {
        const id = this.newId();
        this.add("ad", { ...obj, id, adset_id: String(p.adset_id ?? obj.adset_id), name: `${obj.name}${(p.rename_options as { rename_suffix?: string } | undefined)?.rename_suffix ?? " - Copy"}`, status: "PAUSED", effective_status: "PAUSED", created_time: this.madeNow() });
        return ok({ copied_ad_id: id, ad_object_ids: [{ ad_object_type: "ad", source_id: obj.id, copied_id: id }] });
      }
      const r = (p.rename_options as { rename_suffix?: string } | undefined) ?? {};
      const id = this.newId();
      if (obj._type === "campaign") {
        this.add("campaign", { ...obj, id, name: `${obj.name}${r.rename_suffix ?? " - Copy"}`, status: "PAUSED", created_time: this.madeNow() });
        if (p.deep_copy === true || p.deep_copy === "true") for (const a of this.of("adset").filter((x) => x.campaign_id === obj.id)) this.add("adset", { ...a, id: this.newId(), campaign_id: id, status: "PAUSED" });
        return ok({ copied_campaign_id: id, ad_object_ids: [{ ad_object_type: "campaign", source_id: obj.id, copied_id: id }] });
      }
      const target = this.objects.get(String(p.campaign_id ?? obj.campaign_id));
      // Meta copies the spend limits: the copy's minimum must fit the campaign budget with the others'.
      const tooMuch = target ? this.minSpendRefused(target.id, null, Number(obj.daily_min_spend_target)) : null;
      if (tooMuch) return tooMuch;
      // In a campaign with a campaign budget the copy has no budget of its own.
      const cbo = !!target && !!(Number(target.daily_budget) || Number(target.lifetime_budget));
      const { daily_budget: _d, lifetime_budget: _l, ...noBudget } = obj;
      this.add("adset", { ...(cbo ? noBudget : obj), id, campaign_id: target?.id ?? obj.campaign_id, name: `${obj.name}${r.rename_suffix ?? " - Copy"}`, status: "PAUSED", effective_status: "PAUSED", created_time: this.madeNow() });
      return ok({ copied_adset_id: id, ad_object_ids: [{ ad_object_type: "ad_set", source_id: obj.id, copied_id: id }] });
    }
    if (method === "POST" && !edge) {
      if (p.status && p.status !== "PAUSED" && !this.o.allowActive) throw new Error(`TEST GUARD: tried to set ${obj.id} to ${String(p.status)}`);
      if (obj._type === "adset" && p.daily_min_spend_target !== undefined) {
        const tooMuch = this.minSpendRefused(String(obj.campaign_id), obj.id, Number(p.daily_min_spend_target));
        if (tooMuch) return tooMuch;
      }
      if ((p.execution_options as string[] | undefined)?.includes("validate_only")) return ok({ success: true });
      const { execution_options: _e, creative, ...rest } = p;
      Object.assign(obj, rest);
      if ((creative as { creative_id?: string } | undefined)?.creative_id) {
        if (!this.objects.get(String((creative as { creative_id: string }).creative_id))) return fail("Creative does not exist");
        obj.creative_id = String((creative as { creative_id: string }).creative_id);
      }
      if (p.name) obj.name = String(p.name);
      if (p.status) obj.effective_status = String(p.status);
      return ok({ success: true });
    }
    if (method === "DELETE") throw new Error("TEST GUARD: something tried to DELETE in Meta");
    return fail(`Mock has no route for ${method} ${path}`);
  }

  /**
   * Meta's rule in a campaign with a campaign budget (100/1885648): the minimum daily spends of its ad sets
   * (paused ones too, as on real Meta, plan pt64e) may not add up to more than the daily budget. `adsetId`:
   * the ad set being changed (its old minimum doesn't count). A campaign with a lifetime budget refuses
   * any daily minimum. null: fine.
   */
  private minSpendRefused(campaignId: string, adsetId: string | null, min: number): { status: number; body: unknown } | null {
    const camp = this.objects.get(campaignId);
    if (!camp || !(min > 0)) return null;
    const daily = Number(camp.daily_budget);
    const refuse = { status: 400, body: { error: { message: "Invalid parameter", code: 100, error_subcode: 1885648, error_user_title: "Minimum spend limit is higher than campaign budget", error_user_msg: "Your ad sets' combined minimum spend is higher than your campaign budget." } } };
    if (!daily) return Number(camp.lifetime_budget) ? refuse : null;
    const others = this.of("adset").filter((a) => a.campaign_id === campaignId && a.id !== adsetId && !/DELETED|ARCHIVED/.test(String(a.status))).reduce((t, a) => t + (Number(a.daily_min_spend_target) || 0), 0);
    return others + min > daily ? refuse : null;
  }

  /** A lead form (lead_gen_form_id) on the creative's call to action, in any of the places Meta takes it. */
  private hasLeadForm(cr: Obj): boolean {
    const body = (cr.body ?? cr) as Record<string, unknown>;
    return /"lead_gen_form_id":"[^"]+"/.test(JSON.stringify({ oss: body.object_story_spec, afs: body.asset_feed_spec }));
  }

  private get chunk() {
    return this.o.chunkBytes ?? 4 * 1024 * 1024;
  }
}

/** A clock where sleeping only moves time forward. Tests run instantly. */
export class FakeClock implements Clock {
  t = Date.UTC(2026, 10, 3, 9, 0, 0);
  slept = 0;
  now() {
    return this.t;
  }
  async sleep(ms: number) {
    this.t += ms;
    this.slept += ms;
  }
}
