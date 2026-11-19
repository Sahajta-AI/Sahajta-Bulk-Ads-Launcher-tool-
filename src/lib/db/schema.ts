// Each entry is one migration. Never edit an old entry; add a new one.
export const migrations: string[] = [
  `
  CREATE TABLE ad_accounts (
    id INTEGER PRIMARY KEY,
    meta_account_id TEXT NOT NULL UNIQUE,        -- "act_123"
    name TEXT NOT NULL DEFAULT '',
    business_id TEXT,
    token_enc TEXT,                              -- System User token, AES-GCM encrypted
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE users (
    email TEXT PRIMARY KEY,
    name TEXT,
    google_refresh_enc TEXT,
    google_scope TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_login_at TEXT
  );

  CREATE TABLE api_keys (
    id INTEGER PRIMARY KEY,
    user_email TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    key_hash TEXT NOT NULL UNIQUE,
    key_hint TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_used_at TEXT,
    revoked_at TEXT
  );

  CREATE TABLE copy_templates (
    id INTEGER PRIMARY KEY,
    ad_account_id INTEGER NOT NULL REFERENCES ad_accounts(id),
    name TEXT NOT NULL,
    primary_texts TEXT NOT NULL DEFAULT '[]',
    headlines TEXT NOT NULL DEFAULT '[]',
    description TEXT NOT NULL DEFAULT '',
    cta TEXT NOT NULL DEFAULT 'LEARN_MORE',
    link_url TEXT NOT NULL DEFAULT '',
    utm_template TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE naming_templates (
    id INTEGER PRIMARY KEY,
    ad_account_id INTEGER NOT NULL REFERENCES ad_accounts(id),
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('ad', 'adset')),
    pattern TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE settings_presets (
    id INTEGER PRIMARY KEY,
    ad_account_id INTEGER NOT NULL REFERENCES ad_accounts(id),
    name TEXT NOT NULL,
    page_id TEXT NOT NULL DEFAULT '',
    page_name TEXT NOT NULL DEFAULT '',
    ig_user_id TEXT NOT NULL DEFAULT '',
    ig_name TEXT NOT NULL DEFAULT '',
    enhancements TEXT NOT NULL DEFAULT '{}',     -- {feature_key: "OPT_IN"} only for features switched ON
    multi_advertiser INTEGER NOT NULL DEFAULT 0,
    is_default INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE campaign_templates (
    id INTEGER PRIMARY KEY,
    ad_account_id INTEGER NOT NULL REFERENCES ad_accounts(id),
    name TEXT NOT NULL,
    objective TEXT NOT NULL DEFAULT 'OUTCOME_TRAFFIC',
    special_ad_categories TEXT NOT NULL DEFAULT '[]'
  );

  CREATE TABLE batches (
    id INTEGER PRIMARY KEY,
    key TEXT NOT NULL UNIQUE,
    ad_account_id INTEGER NOT NULL REFERENCES ad_accounts(id),
    status TEXT NOT NULL DEFAULT 'draft',        -- draft | queued | running | done | partial | failed
    source_kind TEXT NOT NULL DEFAULT 'upload',  -- drive | upload
    source_ref TEXT,
    source_label TEXT NOT NULL DEFAULT '',
    campaign_id TEXT,
    campaign_name TEXT,
    adset_mode TEXT NOT NULL DEFAULT 'existing', -- existing | new_per_ad
    adset_id TEXT,                               -- target ad set, or the template when new_per_ad
    adset_name TEXT,
    copy_template_id INTEGER,
    copy TEXT,                                   -- JSON copy used for every ad (before per-ad overrides)
    ad_name_template TEXT NOT NULL DEFAULT '{date}_{creative}_{angle}_{format}',
    adset_name_template TEXT NOT NULL DEFAULT '{date}_{creative}',
    preset_id INTEGER,
    preset TEXT,                                 -- JSON snapshot of the settings preset
    angle TEXT NOT NULL DEFAULT '',
    estimate_seconds INTEGER,
    warnings_accepted INTEGER NOT NULL DEFAULT 0,
    run_count INTEGER NOT NULL DEFAULT 0,
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    previewed_at TEXT,
    launched_at TEXT,
    finished_at TEXT
  );

  CREATE TABLE ads (
    id INTEGER PRIMARY KEY,
    batch_id INTEGER NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    key TEXT NOT NULL UNIQUE,                    -- "<batchkey>-<NN>", stamped into every Meta object name
    creative_name TEXT NOT NULL,
    angle TEXT,
    copy_override TEXT,
    name TEXT,
    adset_name TEXT,
    status TEXT NOT NULL DEFAULT 'pending',      -- pending | working | waiting | done | failed
    step TEXT,
    wait_until INTEGER,
    meta_adset_id TEXT,
    meta_creative_id TEXT,
    meta_ad_id TEXT,
    attempts TEXT NOT NULL DEFAULT '{}',         -- create attempts per object: {"adset":1,"creative":1,"ad":1}
    effective_status TEXT,
    review_issues TEXT,
    error TEXT,
    error_detail TEXT,
    checks TEXT NOT NULL DEFAULT '[]',           -- preview findings [{level, code, message}]
    feature_warnings TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX ads_batch ON ads(batch_id, position);

  CREATE TABLE assets (
    id INTEGER PRIMARY KEY,
    batch_id INTEGER NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
    ad_id INTEGER REFERENCES ads(id) ON DELETE SET NULL,
    source_kind TEXT NOT NULL,                   -- drive | upload | local
    source_ref TEXT NOT NULL,                    -- Drive file id, tus upload id, or a local path
    rel_path TEXT NOT NULL DEFAULT '',
    filename TEXT NOT NULL,
    kind TEXT NOT NULL,                          -- image | video | unsupported
    mime TEXT NOT NULL DEFAULT '',
    size_bytes INTEGER NOT NULL DEFAULT 0,
    width INTEGER,
    height INTEGER,
    duration_sec REAL,
    ratio TEXT,                                  -- 9x16 | 4x5 | 1x1 | 16x9 | other
    local_path TEXT,
    sha256 TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX assets_batch ON assets(batch_id);

  CREATE TABLE meta_media (
    ad_account_id INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    kind TEXT NOT NULL,
    image_hash TEXT,
    video_id TEXT,
    status TEXT NOT NULL,                        -- uploading | uploaded | ready | error
    upload_state TEXT,                           -- JSON, resumable upload progress
    thumbnail_url TEXT,
    thumbnail_hash TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (ad_account_id, sha256)
  );

  CREATE TABLE jobs (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,                          -- launch | review_check | backup
    batch_id INTEGER,
    status TEXT NOT NULL DEFAULT 'queued',       -- queued | running | done | failed
    run_after INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    locked_at INTEGER,
    last_error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX jobs_due ON jobs(status, run_after);

  CREATE TABLE rate_state (
    ad_account_id INTEGER PRIMARY KEY,
    state TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE events (
    id INTEGER PRIMARY KEY,
    batch_id INTEGER,
    ad_id INTEGER,
    level TEXT NOT NULL DEFAULT 'info',
    message TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX events_batch ON events(batch_id, id);

  CREATE TABLE cache (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  `,
  // 2: Meta connected from the app (Connect Meta in Settings).
  `
  ALTER TABLE ad_accounts ADD COLUMN token_expires_at INTEGER;   -- ms; NULL = does not expire or unknown
  ALTER TABLE ad_accounts ADD COLUMN meta_user_name TEXT;        -- the Facebook person or system user behind the token
  ALTER TABLE ad_accounts ADD COLUMN connected_by TEXT;          -- launcher user who connected it
  ALTER TABLE ad_accounts ADD COLUMN connected_at TEXT;
  `,
  // 3: The marketer's change list (Nov 2026): campaign naming templates, go-live choice, several
  //    ad sets per launch (sibling batches), change plans, metric column sets, custom metrics.
  `
  CREATE TABLE naming_templates_v3 (
    id INTEGER PRIMARY KEY,
    ad_account_id INTEGER NOT NULL REFERENCES ad_accounts(id),
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('ad', 'adset', 'campaign')),
    pattern TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0
  );
  INSERT INTO naming_templates_v3 (id, ad_account_id, name, kind, pattern, is_default)
    SELECT id, ad_account_id, name, kind, pattern, is_default FROM naming_templates;
  DROP TABLE naming_templates;
  ALTER TABLE naming_templates_v3 RENAME TO naming_templates;

  ALTER TABLE batches ADD COLUMN go_live TEXT NOT NULL DEFAULT 'paused'; -- paused | now | at
  ALTER TABLE batches ADD COLUMN go_live_at TEXT;                         -- ISO time, when go_live = 'at'
  ALTER TABLE batches ADD COLUMN go_live_done INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE batches ADD COLUMN persona TEXT NOT NULL DEFAULT '';
  ALTER TABLE batches ADD COLUMN group_key TEXT;                          -- same value for batches launched together into several ad sets
  ALTER TABLE batches ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE batches ADD COLUMN extra_adsets TEXT NOT NULL DEFAULT '[]';  -- JSON [{id, name, campaignId, campaignName}]: same ads also go here

  CREATE TABLE plans (
    id INTEGER PRIMARY KEY,
    key TEXT NOT NULL UNIQUE,
    ad_account_id INTEGER NOT NULL REFERENCES ad_accounts(id),
    title TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'draft',        -- draft | queued | running | done | partial | failed | cancelled
    ops TEXT NOT NULL,                           -- JSON list of operations, as given
    summary TEXT,                                -- JSON pre-launch summary from the last check
    can_spend INTEGER NOT NULL DEFAULT 0,        -- 1 if running it can make Meta spend money
    run_at TEXT,                                 -- ISO time; NULL = as soon as confirmed
    progress TEXT NOT NULL DEFAULT '[]',         -- JSON per step: {status, ids, message}
    created_by TEXT,
    source TEXT NOT NULL DEFAULT 'app',          -- app | claude
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    confirmed_at TEXT,
    confirmed_by TEXT,
    finished_at TEXT
  );

  CREATE TABLE column_sets (
    id INTEGER PRIMARY KEY,
    ad_account_id INTEGER NOT NULL REFERENCES ad_accounts(id),
    name TEXT NOT NULL,
    metrics TEXT NOT NULL DEFAULT '[]',          -- JSON list of metric names (Meta fields, actions:<type>, or custom metric names)
    is_default INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE custom_metrics (
    id INTEGER PRIMARY KEY,
    ad_account_id INTEGER NOT NULL REFERENCES ad_accounts(id),
    name TEXT NOT NULL,
    formula TEXT NOT NULL,                       -- e.g. spend / actions:offsite_conversion.fb_pixel_custom
    format TEXT NOT NULL DEFAULT 'number',       -- number | money | percent
    description TEXT NOT NULL DEFAULT ''
  );
  `,
  // 4: Fixes from the 17 Nov tests: a file keeps its own copy when it moves between ads, the post
  //    behind each created ad, app-wide settings (daily budget ceiling, alerts), one shared new ad set.
  `
  ALTER TABLE assets ADD COLUMN copy_override TEXT;   -- the copy of the ad this file was in, kept when the file moves
  ALTER TABLE assets ADD COLUMN angle TEXT;
  ALTER TABLE ads ADD COLUMN meta_post_id TEXT;       -- Facebook post behind the ad (pageid_postid), for "ads from a post"
  ALTER TABLE ads ADD COLUMN meta_ig_media_id TEXT;   -- Instagram media behind the ad
  ALTER TABLE batches ADD COLUMN shared_adset_id TEXT; -- adset_mode 'new_shared': the one new ad set all ads go into
  ALTER TABLE copy_templates ADD COLUMN display_link TEXT NOT NULL DEFAULT '';
  ALTER TABLE copy_templates ADD COLUMN lead_form_id TEXT NOT NULL DEFAULT '';
  ALTER TABLE settings_presets ADD COLUMN whatsapp_number TEXT NOT NULL DEFAULT '';
  ALTER TABLE settings_presets ADD COLUMN threads_user_id TEXT NOT NULL DEFAULT '';
  ALTER TABLE settings_presets ADD COLUMN sponsor_page_id TEXT NOT NULL DEFAULT '';
  -- One UTM default (17 Nov tests): templates still on the first default get the current one.
  UPDATE copy_templates SET utm_template = 'utm_source=facebook&utm_medium=paid&utm_campaign={{campaign.name}}&utm_term={{adset.name}}&utm_content={{ad.name}}&utm_id={{ad.id}}'
    WHERE utm_template = 'utm_source=meta&utm_medium=paid&utm_campaign={campaign}&utm_content={creative}';
  CREATE TABLE app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_by TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `,
  // 5: Review fixes (19 Nov): the yes given at launch (the typed total) must not turn ads on after the
  //    launch was stopped, after a Retry pressed long after the launch, or for more than was typed.
  `
  ALTER TABLE batches ADD COLUMN stopped_at TEXT;  -- ISO time "Stop the launch" was pressed (this batch or one launched with it)
  ALTER TABLE batches ADD COLUMN retried_at TEXT;  -- ISO time "Retry" was last pressed
  ALTER TABLE batches ADD COLUMN go_live_total TEXT; -- the total daily budget typed back at launch ("₹1,500"), for "now" / "at a time"
  `,
  // 6: Second review (19 Nov): one turn-on plan for all the ad sets of a launch, found by its batch (not
  //    its title); lifetime budgets compared at the moment the total was typed; a late Retry measured
  //    from the end of the run before it (or the set time); Stops pressed before migration 5 still count.
  //    Old turn-on plans are found by the mark the launcher left when it confirmed them ("… (when
  //    launching batch KEY)", kept when the plan is renamed), else by their first title.
  `
  ALTER TABLE plans ADD COLUMN batch_id INTEGER;          -- a batch launch's turn-on plan: the lowest id of the batches it turns on
  UPDATE plans SET batch_id = COALESCE(
    (SELECT b.id FROM batches b WHERE plans.confirmed_by IS NOT NULL
       AND substr(plans.confirmed_by, -length(' (when launching batch ' || b.key || ')')) = ' (when launching batch ' || b.key || ')'),
    (SELECT b.id FROM batches b WHERE substr(plans.title, 1, length('Turn on batch ' || b.key || ' (')) = 'Turn on batch ' || b.key || ' (')
  ) WHERE confirmed_by LIKE '% (when launching batch %)' OR title LIKE 'Turn on batch %';
  CREATE INDEX plans_batch ON plans(batch_id);
  ALTER TABLE batches ADD COLUMN go_live_total_at TEXT;   -- ISO time the typed total was worked out for (lifetime budgets ÷ days left from then)
  ALTER TABLE batches ADD COLUMN late_retry_from TEXT;    -- a Retry pressed more than an hour after this time (end of the run before it, or the set time): the yes given at launch no longer turns the ads on
  UPDATE batches SET stopped_at = COALESCE(finished_at, launched_at, created_at) WHERE cancel_requested = 1 AND stopped_at IS NULL;
  -- A Retry already held by the old rule (more than an hour after the launch started, or after the set time) stays held.
  UPDATE batches SET late_retry_from = COALESCE(launched_at, finished_at)
    WHERE go_live = 'now' AND go_live_done = 0 AND retried_at IS NOT NULL AND launched_at IS NOT NULL
      AND (julianday(retried_at) - julianday(launched_at)) * 24 > 1;
  UPDATE batches SET late_retry_from = go_live_at
    WHERE go_live = 'at' AND go_live_done = 0 AND retried_at IS NOT NULL AND go_live_at IS NOT NULL
      AND (julianday(retried_at) - julianday(go_live_at)) * 24 > 1;
  `,
  // 7: the marketer's 19 Nov retest: the same ads into several ad sets share one creative (one post) when
  //    the creative sent to Meta is the same, and the time left of a launch uses how fast ads go in.
  `
  ALTER TABLE ads ADD COLUMN creative_hash TEXT;     -- hash of the creative sent to Meta, all but its name (and its version): same hash in one launch = one shared creative
  ALTER TABLE ads ADD COLUMN done_at INTEGER;        -- ms when the ad was created in Meta
  ALTER TABLE ads ADD COLUMN work_points INTEGER;    -- Meta points this ad's own steps used (uploads, creative, ad, reads), for the time left
  CREATE INDEX ads_creative_hash ON ads(creative_hash);
  `,
  // 8: Review of shared creatives (19 Nov): the creatives a launch made, kept apart from the ads, so a
  //    copy change on the ad that made one (or a Retry that gives an ad its own) never hides it from the
  //    other ad sets of the launch: they still use it instead of making an identical second one.
  `
  CREATE TABLE launch_creatives (
    launch TEXT NOT NULL,              -- the batches' group_key, or 'batch:<id>' for a launch into one ad set
    ad_account_id INTEGER NOT NULL,
    creative_hash TEXT NOT NULL,       -- as ads.creative_hash
    meta_creative_id TEXT NOT NULL,
    ad_key TEXT NOT NULL,              -- the ad whose key is in the creative's name
    feature_warnings TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (launch, ad_account_id, creative_hash)
  );
  INSERT OR IGNORE INTO launch_creatives (launch, ad_account_id, creative_hash, meta_creative_id, ad_key, feature_warnings)
    SELECT COALESCE(b.group_key, 'batch:' || b.id), b.ad_account_id, a.creative_hash, a.meta_creative_id, a.key, a.feature_warnings
    FROM ads a JOIN batches b ON b.id = a.batch_id
    WHERE a.creative_hash IS NOT NULL AND a.meta_creative_id IS NOT NULL ORDER BY a.id;
  `,
];
