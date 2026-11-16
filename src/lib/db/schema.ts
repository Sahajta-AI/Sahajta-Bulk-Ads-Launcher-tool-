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
];
