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
  /** The ad account may not use the Page's Instagram account: refuse creatives with 200/1815199. */
  igNotAllowed?: boolean;
  /** Ad accounts the Facebook login shows (Connect Meta). Default: the practice account and one disabled account. */
  adAccounts?: { id: string; name: string; account_status: number; business?: { id: string; name: string } }[];
}

type Fault = { match: (method: string, path: string) => boolean; kind: "network" | "timeout_after_create" | "error"; error?: Record<string, unknown> };

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

  private headers(now: number): Record<string, string> {
    const cap = this.o.capPoints ?? 60;
    const pct = Math.round((this.util(now) / cap) * 10000) / 100;
    // Seconds until the score is back to 0 (or until the block ends).
    const reset = this.blockedUntil > now ? Math.ceil((this.blockedUntil - now) / 1000) : Math.ceil((this.util(now) / cap) * 300);
    return {
      "content-type": "application/json",
      "x-ad-account-usage": JSON.stringify({ acc_id_util_pct: pct, reset_time_duration: reset, ads_api_access_tier: cap > 1000 ? "standard_access" : "development_access" }),
      "x-business-use-case-usage": JSON.stringify({ "9001": [{ type: "ads_management", call_count: 5, total_cputime: 2, total_time: 3, estimated_time_to_regain_access: 0, ads_api_access_tier: "development_access" }] }),
    };
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
      return this.json({ error: fault.error ?? { message: "Simulated error", code: 100 } }, now, 400);
    }

    // Rate limit, Limited tier rules.
    if (now < this.blockedUntil) {
      this.throttled++;
      return this.json({ error: { message: "User request limit reached", code: 17, error_subcode: 2446079, is_transient: true } }, now, 400);
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
      for (const [k, v] of body) p[k] = typeof v === "string" ? v : Buffer.from(await (v as Blob).arrayBuffer());
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

  private nameFilter(params: Record<string, unknown>) {
    const list = (params.filtering as { field: string; operator: string; value: string }[] | undefined) ?? [];
    return (o: Obj) =>
      list.every((f) => {
        const v = String(f.field === "campaign.id" ? o.campaign_id : f.field === "name" ? (o.name ?? "") : (o[f.field] ?? ""));
        if (f.operator === "CONTAIN") return v.includes(f.value);
        if (f.operator === "EQUAL") return v === f.value;
        if (f.operator === "STARTS_WITH") return v.startsWith(f.value);
        return true;
      });
  }

  private fields(o: Obj, params: Record<string, unknown>) {
    const want = String(params.fields ?? "id,name").split(",");
    const out: Record<string, unknown> = { id: o.id };
    for (const f of want) if (f in o) out[f] = o[f];
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
        return ok({ data: list.map((a) => ({ ...a, currency: "INR" })), paging: { cursors: {} } });
      }
      if (edge === "accounts") {
        const ig = this.of("ig")[0];
        return ok({ data: this.of("page").map((pg) => ({ id: pg.id, name: pg.name, instagram_business_account: ig ? { id: ig.id, username: ig.username } : undefined })), paging: { cursors: {} } });
      }
    }

    if (path === "search" && method === "GET") {
      if (p.type === "adinterest") return ok({ data: [{ id: "6003", name: `Real estate (${String(p.q)})`, audience_size_lower_bound: 1000000 }] });
      return ok({ data: [{ key: "1234", name: String(p.q), type: "city", country_code: "IN" }] });
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
      return ok({ data: rows, paging: { cursors: {} } });
    }
    if (first === act && method === "GET") {
      const typeOf: Record<string, string> = { campaigns: "campaign", adsets: "adset", ads: "ad", adcreatives: "creative", promote_pages: "page", instagram_accounts: "ig" };
      if (!edge) return ok({ id: act, name: "Sahajta AI (mock)", currency: "INR", timezone_name: "Asia/Kolkata", account_status: 1 });
      if (edge === "instagram_accounts" && this.o.igNotAllowed) return ok({ data: [], paging: { cursors: {} } });
      const t = typeOf[edge];
      if (!t) return fail(`Unknown edge ${edge}`);
      if (edge === "adcreatives" && p.filtering && this.o.noCreativeFilter) return fail("Filtering is not supported on this edge");
      const list = this.of(t).filter(this.nameFilter(p)).filter((o) => !p.campaign_id || o.campaign_id === p.campaign_id).map((o) => this.fields(o, p));
      return ok({ data: list, paging: { cursors: {} } });
    }

    if (first === act && method === "POST") {
      if (edge === "adimages") {
        const bytes = p.filename as Buffer;
        const hash = createHash("md5").update(bytes).digest("hex");
        this.add("image", { id: hash, name: "image" });
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
        if ((p.execution_options as string[] | undefined)?.includes("validate_only")) return ok({ success: true });
        const fromPost = !!(p.object_story_id || p.source_instagram_media_id);
        const oss = p.object_story_spec as { instagram_user_id?: string } | undefined;
        if (this.o.igNotAllowed && oss?.instagram_user_id) return { status: 400, body: { error: { message: "Permissions error", code: 200, error_subcode: 1815199, error_user_title: "No permission to use this Instagram account", error_user_msg: "The ad account is not allowed to advertise with this Instagram account." } } };
        if (!fromPost && !String(p.name ?? "").includes("[L:")) return fail("Test guard: creative name has no launch key");
        const dof = (p.degrees_of_freedom_spec as { creative_features_spec?: Record<string, unknown> } | undefined)?.creative_features_spec ?? {};
        if ("standard_enhancements" in dof) return fail("standard_enhancements is deprecated");
        const id = this.newId();
        this.add("creative", { id, name: String(p.name), body: p, object_story_id: p.object_story_id, degrees_of_freedom_spec: { creative_features_spec: { ...dof, new_feature_june_2026: { enroll_status: "OPT_OUT" } } } });
        return ok({ id });
      }
      if (edge === "ads") {
        if (p.status !== "PAUSED" && !this.o.allowActive) throw new Error(`TEST GUARD: ad created with status ${String(p.status)}`);
        const cr = this.objects.get((p.creative as { creative_id: string }).creative_id);
        if (!cr?.object_story_id && !(cr?.body as { source_instagram_media_id?: string } | undefined)?.source_instagram_media_id && !String(p.name ?? "").includes("[L:")) return fail("Test guard: ad name has no launch key");
        if (!this.objects.get(String(p.adset_id))) return fail("Ad set does not exist");
        const creativeId = (p.creative as { creative_id: string }).creative_id;
        if (!this.objects.get(creativeId)) return fail("Creative does not exist");
        const id = this.newId();
        this.add("ad", { id, name: String(p.name), adset_id: String(p.adset_id), creative_id: creativeId, status: String(p.status), effective_status: "PENDING_REVIEW" });
        return ok({ id });
      }
      if (edge === "campaigns") {
        if (p.status !== "PAUSED" && !this.o.allowActive) throw new Error("TEST GUARD: campaign not paused");
        if (!p.objective) return fail("objective is required");
        if ((p.execution_options as string[] | undefined)?.includes("validate_only")) return ok({ success: true });
        const id = this.newId();
        const { execution_options: _e, ...rest } = p;
        this.add("campaign", { ...rest, id, name: String(p.name), status: String(p.status), objective: p.objective, special_ad_categories: p.special_ad_categories });
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
        if ((p.execution_options as string[] | undefined)?.includes("validate_only")) return ok({ success: true });
        const id = this.newId();
        const { execution_options: _e, ...rest } = p;
        this.add("adset", { ...rest, id, name: String(p.name), campaign_id: String(p.campaign_id), status: String(p.status), is_dynamic_creative: false, effective_status: String(p.status) });
        return ok({ id });
      }
    }

    const obj = this.objects.get(first);
    if (!obj) return fail(`Object ${first} does not exist`, 100);

    if (method === "GET" && edge === "adsets") {
      return ok({ data: this.of("adset").filter((a) => a.campaign_id === obj.id).map((a) => this.fields(a, p)), paging: { cursors: {} } });
    }
    if (method === "GET" && edge === "ads") {
      const list = this.of("ad").filter((a) => a.adset_id === obj.id).filter(this.nameFilter(p));
      if (p.summary) return ok({ data: list.slice(0, 1).map((a) => this.fields(a, p)), summary: { total_count: list.length }, paging: { cursors: {} } });
      return ok({ data: list.map((a) => this.fields(a, p)), paging: { cursors: {} } });
    }
    if (method === "GET" && edge === "thumbnails") {
      return ok({ data: this.o.noThumbnails ? [] : [{ id: `${obj.id}_t`, uri: `https://mock/thumb/${obj.id}.jpg`, is_preferred: true }] });
    }
    if (method === "GET" && !edge) {
      if (obj._type === "video" && typeof obj.readyAt === "number" && now >= obj.readyAt) obj.status = { video_status: "ready", processing_progress: 100 };
      if (obj._type === "video" && typeof obj.received === "number") (obj.status as Record<string, unknown>).uploading_phase = { bytes_transferred: obj.received };
      return ok(this.fields(obj, p));
    }
    if (method === "POST" && edge === "copies") {
      if (p.status_option !== "PAUSED") throw new Error("TEST GUARD: copy not paused");
      const r = (p.rename_options as { rename_suffix?: string } | undefined) ?? {};
      const id = this.newId();
      if (obj._type === "campaign") {
        this.add("campaign", { ...obj, id, name: `${obj.name}${r.rename_suffix ?? " - Copy"}`, status: "PAUSED" });
        if (p.deep_copy) for (const a of this.of("adset").filter((x) => x.campaign_id === obj.id)) this.add("adset", { ...a, id: this.newId(), campaign_id: id, status: "PAUSED" });
        return ok({ copied_campaign_id: id, ad_object_ids: [{ ad_object_type: "campaign", source_id: obj.id, copied_id: id }] });
      }
      const target = this.objects.get(String(p.campaign_id ?? obj.campaign_id));
      if (target && (Number(target.daily_budget) || Number(target.lifetime_budget)) && Number(obj.daily_min_spend_target)) {
        return { status: 400, body: { error: { message: "Invalid parameter", code: 100, error_subcode: 1885648, error_user_title: "Minimum spend limit is higher than campaign budget", error_user_msg: "Your ad sets' combined minimum spend is higher than your campaign budget." } } };
      }
      this.add("adset", { ...obj, id, campaign_id: target?.id ?? obj.campaign_id, name: `${obj.name}${r.rename_suffix ?? " - Copy"}`, status: "PAUSED", effective_status: "PAUSED" });
      return ok({ copied_adset_id: id, ad_object_ids: [{ ad_object_type: "ad_set", source_id: obj.id, copied_id: id }] });
    }
    if (method === "POST" && !edge) {
      if (p.status && p.status !== "PAUSED" && !this.o.allowActive) throw new Error(`TEST GUARD: tried to set ${obj.id} to ${String(p.status)}`);
      if ((p.execution_options as string[] | undefined)?.includes("validate_only")) return ok({ success: true });
      const { execution_options: _e, ...rest } = p;
      Object.assign(obj, rest);
      if (p.name) obj.name = String(p.name);
      if (p.status) obj.effective_status = String(p.status);
      return ok({ success: true });
    }
    if (method === "DELETE") throw new Error("TEST GUARD: something tried to DELETE in Meta");
    return fail(`Mock has no route for ${method} ${path}`);
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
