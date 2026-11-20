# Sahajta Ads Launcher: specification

This document describes the system as built. Meta facts and their sources are in `META-API-NOTES.md`. Reasons for choices are in `../DECISIONS.md`.

## 1. Overview

```
Drive folder / dropped files → server disk → grouping + checks (preview) → jobs table → worker → Meta (all PAUSED)
                                                                                     ↘ review checks → History page
Claude (MCP) → app API (per-user key) → same engine
```

- Web app: Next.js 16 (App Router). UI and HTTP API.
- Worker: one Node process (`src/worker/index.ts`) with two lanes. The launch lane runs one batch at a time. The other lane runs review checks and backups, so they do not wait for a launch. Both lanes use the same pacer for each ad account.
- Database: one SQLite file (`/data/launcher.db`, WAL mode). The `jobs` table is the queue.
- Hosting: Docker Compose on one Oracle Arm machine: `app`, `worker`, `caddy` (HTTPS).

## 2. Screens

| Screen | Path | Purpose |
|---|---|---|
| Sign in | `/login` | Google sign-in. Only emails in `ALLOWED_EMAILS`. |
| New batch | `/` | Paste a Drive folder link, or start an upload batch. Shows recent batches. |
| Batch (draft) | `/batches/{code}` | One page, six steps: 1 creatives (drop zone + grouping board with drag and drop), 2 destination, 3 copy, 4 names, 5 Meta settings, 6 preview table. Sticky bar: estimate, errors/warnings, "accept warnings" tick, Launch. |
| Batch (launched) | `/batches/{code}` | Live progress per ad, Ads Manager links, Meta review status, failures in plain words, "Retry failed only", activity log. |
| History | `/history` | Every batch with status, source, destination, counts. |
| Settings | `/settings` | Tabs: Meta connection (Connect Meta → pick ad account, Page, Instagram; change, reconnect, disconnect; paste a token instead), copy templates, naming templates, Meta settings presets (Page, Instagram, 24 AI enhancements, multi-advertiser), Claude connection (API keys, install), connection status. |

Choices are remembered per browser (last ad set, copy template, preset), so a repeat launch needs few clicks: paste link → Launch.

## 3. Data model (SQLite)

| Table | Holds |
|---|---|
| `ad_accounts` | Meta ad account id, name, **encrypted** Meta token from Connect Meta, when it expires, who connected it. The one marked default is in use. |
| `users` | Allowed people; **encrypted** Google refresh token (read-only Drive). |
| `api_keys` | SHA-256 of each Claude API key, owner, last use. The key itself is never stored. |
| `copy_templates` | ≤5 primary texts, ≤5 headlines, ≤5 descriptions (`descriptions` JSON; `description` keeps the first, for older versions), CTA, link, UTM template. |
| `naming_templates` | Ad and ad set name patterns with tokens. |
| `settings_presets` | Page, Instagram account, enhancements switched ON (all others are sent OFF), multi-advertiser flag. |
| `campaign_templates` | Objective and special ad categories (`[]` for Sahajta; a client could store `["HOUSING"]`). Used when the tool creates a campaign (test campaign only in v1). |
| `batches` | One launch: short code (`key`), source, destination, copy snapshot, preset snapshot, name templates, status, estimate, run count. |
| `ads` | One ad: position, key (`<batch>-NN`), names, per-ad copy override and angle, status and current step, Meta ad set / creative / ad ids, create attempts, review status, errors, preview checks, enhancement warnings. |
| `assets` | One file: source (Drive id / upload id / local path), size, pixels, duration, ratio, local path, SHA-256, owning ad. |
| `meta_media` | Upload cache per ad account and file SHA-256: image hash or video id, upload progress, thumbnail. A file is never uploaded twice. |
| `jobs` | Queue: `launch`, `review`, `backup`. |
| `rate_state` | Pacer state per ad account (5-minute log, learned cap, block end). |
| `events` | Activity log per batch. |
| `cache` | Destination lists (5 minutes), worker heartbeat. |

## 4. HTTP API

All routes need a signed-in session or `Authorization: Bearer <api key>`. Errors return `{ "error": "<plain sentence>" }`.

| Method | Path | Does |
|---|---|---|
| GET | `/api/health` | Public. `ok` (app, database and worker heartbeat) and the age in hours of the last backup and the last off-site copy. 503 if the worker is silent > 2 min or the database can't be read. No backup messages (they can name server paths): those are in Settings → Safety. |
| GET | `/api/destinations[?refresh=1]` | Campaigns with their ad sets (`isDynamicCreative`). |
| GET | `/api/identities` | Pages and Instagram accounts of the ad account. |
| GET/POST | `/api/templates` | List all templates / create or update one (`kind`: copy, naming, preset). |
| DELETE | `/api/templates/{kind}/{id}` | Delete a template. |
| GET/POST | `/api/batches` | History / create a batch (optional `driveFolder` and settings). |
| GET/PATCH/DELETE | `/api/batches/{code}` | Batch view (preview included) / change settings / delete a draft. |
| POST | `/api/batches/{code}/move` | Move a file to another ad or a new ad; or remove it. |
| PATCH | `/api/batches/{code}/ads/{id}` | Per-ad copy override and angle. |
| POST | `/api/batches/{code}/preview` | Full check including landing pages. Saves the result. |
| POST | `/api/batches/{code}/launch` | `{confirm: true, acceptWarnings}`. Refuses on errors, and on warnings unless accepted. |
| POST | `/api/batches/{code}/retry` | Failed ads only. |
| POST | `/api/batches/{code}/review` | Check Meta review status now. |
| GET | `/api/meta/connect` | Connect Meta button: sends the browser to the Facebook login (state in a 15-minute cookie). |
| GET | `/api/meta/callback` | Facebook sends the browser back with a code; the server swaps it for a token (kept encrypted for 30 minutes) and opens Settings to pick. |
| GET | `/api/meta/status`, `/api/meta/assets`, `/api/meta/instagram?adAccountId=` | The connection; ad accounts and Pages the login can use; Instagram accounts for an ad account. |
| POST | `/api/meta/select`, `/api/meta/token`, `/api/meta/disconnect` | Save the pick; paste a token instead; forget the token. Only from the app, not with an API key. |
| * | `/api/upload/*` | tus resumable upload. Metadata: `batch`, `filename`, `relativePath`. A finished file joins the batch and is grouped. |
| GET/POST | `/api/keys`, DELETE `/api/keys/{id}` | Claude API keys (create only from a browser session). |
| POST | `/api/mcp` | MCP over HTTP for Claude Code (API key only). |

## 5. MCP tools

Two transports, one tool file (`src/mcp/tools.ts`): the Claude Desktop extension (`mcp/`, stdio, `.mcpb`) and `/api/mcp` (HTTP, for Claude Code). Both call the HTTP API above with the person's key. Neither holds the Meta token.

| Tool | Input | Output |
|---|---|---|
| `list_destinations` | `refresh?` | Campaigns and ad sets; dynamic-creative ad sets marked unusable. |
| `list_templates` | — | Copy, naming and settings presets. |
| `preview_batch` | `drive_folder_url` or `batch_id`; `ad_set`, `new_ad_set_per_ad`, `copy_template`, `settings_preset`, `angle`, name templates (names or ids) | Preview table, errors, warnings, estimate, app link. Creates nothing in Meta. |
| `launch_batch` | `batch_id`, `confirm: true` (required literal), `accept_warnings?` | Starts the paused launch. |
| `batch_status` | `batch_id` | Progress, Ads Manager links, review status, failures. |

## 6. Grouping and checks

- Ratio from real pixels: images with sharp (EXIF rotation applied), videos with ffprobe (rotation applied). 3% tolerance. 9:16 → "Stories and Reels". 4:5, 1:1, 16:9 → "Feed and everything else". Other shapes are allowed only as a single-file ad.
- Group key: folder + file name with ratio words removed (`9x16`, `4x5`, `1x1`, `16x9`, `vertical`, `story`, `reels`, `feed`, `square`, ...). An empty result uses the folder name. Images and videos never share an ad.
- Errors (block launch): no files, file too big (image 30 MB, video 4 GB), video over 241 min, image under 600 px wide, two files for one placement, image and video in one ad, unknown shape in a multi-file ad, no primary text, more than 5 texts, headlines or descriptions, text over Meta's limit (body 1024, headline and description 255), missing or malformed link, no campaign / ad set, ad set gone, dynamic creative ad set, no Page.
- Warnings (need acceptance): missing vertical or feed version, low resolution, vertical video over 90 s, text over the "See more" length (125 / 40 / 30), no headline, no Instagram account, landing page not loading, skipped files, unknown name or UTM tokens.

## 7. Meta call sequence per ad (Graph API v26.0)

Every name sent to Meta ends with ` [L:<batch>-<NN>]`. With `NAME_PREFIX=TEST_` it also starts with `TEST_`.

**Once per run:** `GET /act_x/ads` (and `/act_x/adsets` for a new ad set per ad) with `filtering=[{field:"name",operator:"CONTAIN",value:"[L:<batch>-"}]`; a found ad also gives its creative. Creatives only when a try of one was saved without its ID (each try is saved before it is sent) or after a restore (`deploy/restore.sh` marks unfinished ads): Meta has no name filter on `/act_x/adcreatives` ("Filtering field 'name' with operation 'contain' is not supported", 20 Nov 2026), so the tool lists recent creatives (up to 1,000, 100 a page) and matches names itself. Objects found are adopted (no new create).

**Image, one text and one headline:**
1. `POST /act_x/adimages` (multipart `filename`) → `images.{name}.hash` (skipped if this file's SHA-256 is cached).
2. `POST /act_x/adcreatives` with `object_story_spec.link_data` {image_hash, link, message, name, description, call_to_action}, `url_tags`, `degrees_of_freedom_spec.creative_features_spec` (24 keys, each `OPT_OUT` unless the preset says on), `contextual_multi_ads.enroll_status=OPT_OUT`. Header `X-Client-Idempotent-Key`.
3. `GET /{creative}?fields=degrees_of_freedom_spec` → warn if any feature the preset did not ask for is on.
4. `POST /act_x/ads` {name, adset_id, creative{creative_id}, status: PAUSED}. Header `X-Client-Idempotent-Key`.

**Video, one text:** as above, but upload is:
1. `POST /act_x/video_ads` `upload_phase=start` → `video_id`, `upload_url` (saved at once).
2. `POST https://rupload.facebook.com/video-ads-upload/v26.0/{video_id}` with headers `Authorization: OAuth`, `offset`, `file_size`, body = file bytes. On resume: `GET /{video_id}?fields=status` → `uploading_phase.bytes_transferred`, then send from there.
3. `POST /act_x/video_ads` `upload_phase=finish`.
4. `GET /{video_id}?fields=status` every 30 s until `ready` (other ads keep working meanwhile).
5. `GET /{video_id}/thumbnails` → preferred `uri`. If none: ffmpeg frame → `POST /act_x/adimages` → hash.
Creative uses `object_story_spec.video_data` {video_id, image_url or image_hash, message, title, link_description, call_to_action}.
If Meta refuses step 1 (system users may not be supported), the run falls back to `POST /act_x/advideos` `upload_phase=start|transfer|finish` (chunks chosen by Meta), and keeps that method for the rest of the run.

**Several texts, one file:** creative uses `object_story_spec` {page_id, instagram_user_id} + `asset_feed_spec` {ad_formats:[SINGLE_IMAGE|SINGLE_VIDEO], images|videos, bodies ≤5, titles ≤5, descriptions ≤5, link_urls, call_to_action_types, optimization_type: DEGREES_OF_FREEDOM}. Several descriptions alone (one text, one headline) also use this form. An ad with a 9:16 and a 4:5 file (placement rules) takes one description: Meta refuses several there (100/1885878, checked with validate_only on 20 Nov 2026), so the first is sent and the preview warns.

**9:16 + 4:5 pair (placement customization), any number of texts:** `asset_feed_spec` with:
- files labelled `f_vertical` / `f_feed`;
- every body labelled `b_vertical` and `b_feed`, every title `t_vertical` and `t_feed` (Meta's "PAC + multi-text" pattern: each placement rotates all texts);
- `asset_customization_rules`: rule 1 `{publisher_platforms:[facebook,instagram], facebook_positions:[story,facebook_reels], instagram_positions:[story,reels]}` → `f_vertical`, `b_vertical`, `t_vertical`, priority 1; rule 2 `{}` (catch-all) → `f_feed`, `b_feed`, `t_feed`, priority 2;
- `optimization_type: PLACEMENT`.
Not yet confirmed on a live account (see `BLOCKERS.md`). `scripts/real-test.ts` checks it first with `execution_options=["validate_only"]`.

**New ad set per ad:** before the creative:
1. `POST /{template_adset}/copies` {deep_copy:false, status_option:PAUSED, rename_options:{rename_strategy:ONLY_TOP_LEVEL_RENAME, rename_suffix:" [L:key]"}} → `copied_adset_id`. The key is in the name from the start.
2. `POST /{new_adset}` {name} → the naming template's name. Repeated after a crash if needed.

**After the run:** review job at +2, 10, 30, 60, 180, 360, 720, 1440 minutes while ads are pending: `GET /act_x/ads?filtering=[name CONTAIN "[L:<batch>-"]&fields=effective_status,ad_review_feedback,issues_info` (one read per 100 ads; `GET /?ids=` is an error since v26). Then a database backup.

**Approximate cost (points):** image ad 3 writes + 1 read ≈ 10; video pair ad ≈ 4 writes for upload + 8 reads + 2 writes + 1 read ≈ 21; new ad set adds 6.

## 8. No duplicates

1. Keys in names (see §7).
2. Reconcile at the start of every run (1 read for the ads, 1 more for new ad sets; creatives only after a try without an answer or a restore).
3. Write-ahead attempts: the database records "attempted" before each create. A retry with an attempt on record looks the object up by its key before creating again.
4. `X-Client-Idempotent-Key`: a UUID made from the ad key + object kind. A repeated create with the same body returns the first object (Meta is rolling this out). If Meta says the key was used with a different body (`100/1349016`), a new key is used.
5. Media cache by SHA-256; the video id is saved right after `start`.
6. Database backup after every batch and nightly.

Proof: `tests/launch.test.ts` (kill after Meta creates the 5th ad and before we save it; timeouts after create; retry-failed-only; kill between ad set copy and rename) and a real `kill -9` of the CLI process (see `BLOCKERS.md` → "What was proven").

## 9. Pacing

- Per ad account. Read = 1 point, write = 3.
- Guard 1: our own log of the last 300 s stays under 75% of the cap.
- Guard 2: Meta's `X-Ad-Account-Usage.acc_id_util_pct`; above 75% we wait for the score to decay (linear over 300 s). `X-Business-Use-Case-Usage` (any of call_count / total_cputime / total_time ≥ 90%) → slow down; `estimated_time_to_regain_access` (minutes) → wait.
- Throttle errors (4, 17, 32, 613, 80000–80014, subcodes 2446079, 1487742, ...): block until `reset_time_duration` or a full window (300 s; 60 s on the large tier), then retry the same call. Never fails a batch.
- The cap starts at 60 and is learned from the headers: points spent (decayed) ÷ percent reported. On the 9,000-point tier the reported percent stays under 1% after a burst, which raises the cap at once. No config change after the upgrade.
- Estimate = max(points ÷ allowed points per second, upload bytes ÷ 8 MB/s) + 2 min if videos must be processed. Shown as "about N minutes".
- The pacer state is saved in `rate_state`, so a restart respects a block.
