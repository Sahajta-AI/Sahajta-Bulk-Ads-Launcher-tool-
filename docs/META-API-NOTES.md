# Meta Marketing API notes: bulk launcher (paused ads, one ad account)

Researched 3 Nov 2026. Not tested against a live account.

**Confidence tags**
- **VERIFIED**: read in official Meta docs or in Meta's SDK / codegen source.
- **LIKELY**: indirect evidence (a doc example for a nearby case, an SDK field with no doc text, or a page read through a summary).
- **UNKNOWN**: not found. Needs a live test.

**Sources used**
- Marketing API docs. Every page is also served as plain markdown: add `.md` to `https://developers.facebook.com/documentation/ads-commerce/marketing-api/<path>`. Index: `https://developers.facebook.com/documentation/ads-commerce/llms.txt`. Reference index: `.../marketing-api/reference/llms.txt`.
- Graph API docs on `developers.facebook.com/docs/graph-api/...`. These were read through WebFetch summaries, so they are less exact.
- `meta/facebook-business-sdk-codegen`, `api_specs/specs/*.json`, commit `39395f6` (29 Oct 2026). These are the generated field and enum lists for SDK v26.
- `facebook/facebook-python-business-sdk` 26.0.2 (21 Sep 2026): `video_uploader.py`, `adobjects/advideo.py`. `facebook/facebook-nodejs-business-sdk` v26.0.2: `src/video-uploader.js`.
- facebook.com/business/ads-guide pages (read through summaries).
- No admanage.ai page was opened.

---

## Summary table

| # | Question | Answer (one line) | Confidence |
|---|---|---|---|
| 1 | API version | Latest is **v26.0** (29 Jul 2026). Marketing API v24.0 stops on **10 Nov 2026**, and v25.0 runs until 23 Feb 2027. Pin **v26.0**. | VERIFIED |
| 2 | Rate limits | Brief numbers are right for Limited: 60 pts, read 1 / write 3, 300 s decay, 300 s block. Full: 9000 pts, 300 s decay, 60 s block. Hourly ads_management BUC is 300 + 40×active ads (Limited) or **100,000** + 40×active ads (Full). There is also a 100 QPS mutation cap and a limit of 1 edit per object per 30 s. | VERIFIED |
| 3 | Image upload | `POST /act_{id}/adimages` as multipart (`filename=@file.jpg`) or `bytes`=base64. Returns `{"images":{"<name>":{"hash","url",...}}}`. JPG/PNG, max 30 MB. | VERIFIED (shape), LIKELY (`bytes` key name) |
| 4 | Video upload | New documented ad-account flow: `POST /act_{id}/video_ads` (upload_phase=start) → `POST rupload.facebook.com/video-ads-upload/v26.0/{video_id}` → `POST /act_{id}/video_ads` (upload_phase=finish). This is 3 calls whatever the file size, and it can resume. Legacy chunked `/advideos` needs 2 + about one call per 50 MB. | VERIFIED (flow), UNKNOWN (rate cost of rupload, system-user support) |
| 5 | PAC + 5 bodies + 5 titles | **Yes, as a documented pattern.** Meta's "Placement Asset Customization + Multi-Text Example" binds `body_label`/`title_label` in each rule and puts **both rules' labels on all 5 bodies and all 5 titles**. It is shown for SINGLE_IMAGE in an app campaign only. | LIKELY for SINGLE_VIDEO + traffic (needs `validate_only` test) |
| 6 | creative_features_spec | 23 keys are documented for single-media ads (list in §6). `enroll_status` is `OPT_IN` or `OPT_OUT`. `standard_enhancements` opt-in ended in v22.0. Read back with `GET /{creative_id}?fields=degrees_of_freedom_spec`. | VERIFIED |
| 7 | IG identity | Use `instagram_user_id` (in `object_story_spec`, or top-level for existing posts). `instagram_actor_id` was deprecated in v22.0 and removed from all versions on 9 Sep 2025. List accounts with `GET /act_{id}/instagram_accounts`. | VERIFIED |
| 8 | Multi-advertiser opt-out | Top-level creative field `contextual_multi_ads={"enroll_status":"OPT_OUT"}`. If you leave it out, the creative is opted IN. | VERIFIED |
| 9 | Campaign / ad set / ad | Campaign: `special_ad_categories=[]` and `is_adset_budget_sharing_enabled` is required (v24+) when budgets are at ad set level. Ad set: `targeting.targeting_automation.advantage_audience` must be 0 or 1 explicitly (v23+). `/copies` returns `copied_adset_id` and runs synchronously (async through `asyncbatch`). | VERIFIED |
| 10 | Review status | 12 `effective_status` values. Problems show in `ad_review_feedback`, `issues_info`, `recommendations`, `failed_delivery_checks`. | VERIFIED |
| 11 | Find by name | `filtering=[{"field":"name","operator":"CONTAIN","value":"x"}]`. The syntax is documented for insights. Use on /ads and /adsets is not in the reference docs. | LIKELY (ads/adsets), UNKNOWN (adcreatives) |
| 12 | Sandbox | Still offered (App Dashboard → Marketing API Quickstart → "Create Sandbox Ad Account"). Docs disagree on whether creatives and ads can be created there. | LIKELY exists, UNKNOWN limits |
| 13 | Error 1885183 | Confirmed: "Ads creative post was created by an app that is in development mode." Switch the app to Live; this needs the basic-settings fields filled. | VERIFIED |
| 14 | Creative limits | Asset feed: body ≤1024 chars, title/description ≤255 chars, ≤5 each. IG caption ≤2200 chars. Image JPG/PNG ≤30 MB. Video MP4/MOV ≤4 GB (Ads Guide). Reels up to 15 min. | VERIFIED (API limits), LIKELY (Ads Guide numbers) |
| 15 | Permissions | `ads_management` (needs `pages_read_engagement` and `pages_show_list`) + `business_management` + `pages_manage_ads`. `ads_read` and `instagram_basic` are optional. Limited tier: 1 system user + 1 admin system user (Full: 10 + 1). | VERIFIED (limits), LIKELY (minimum scope set) |

---

## 1. API version

- **Latest: `v26.0`, released 29 Jul 2026. "Available until" is TBD.** VERIFIED. Sources: https://developers.facebook.com/docs/graph-api/changelog and https://developers.facebook.com/documentation/ads-commerce/marketing-api/marketing-api-changelog/versions
- Marketing API versions still available:

  | Version | Released | Available until |
  |---|---|---|
  | v26.0 | 29 Jul 2026 | TBD |
  | v25.0 | 18 Feb 2026 | 23 Feb 2027 |
  | v24.0 | 8 Oct 2025 | **10 Nov 2026** (7 days from today) |

- Graph API (non-ads) oldest is v21.0, available until 21 Jan 2027. v20.0 ended 24 Sep 2026. For Marketing API endpoints the oldest is **v24.0**, then **v25.0** after 10 Nov 2026.
- SDK releases: Python and Node business SDK `26.0.2` (21 Sep 2026).
- **Recommendation:** hard-code `v26.0`.

**2026 changelog items that matter here** (sources: version26.0, version25.0, and out-of-cycle changes at `.../marketing-api/out-of-cycle-changes/occ-2026`):
- **28 Jun 2026 (all versions):** three new `creative_features_spec` keys: `image_animation`, `video_filtering`, `video_uncrop`. Each is opt-in or opt-out per creative. VERIFIED.
- **1 Jun 2026:** `POST /act_{id}/advideos` takes `source_instagram_media_id` + `selected_audio_spec` (IG Reels audio swap). `GET /{ad-video-id}` gains `replace_audio_status` and `selected_audio_spec`. VERIFIED.
- **19 Oct 2026:** creative audience pairing. New `targeting_automation.creative_audience_pairing` (0/1) and `creative_audience_pairing_persona` on ad, creative and `media_sourcing_spec` items. VERIFIED.
- **6 Oct 2026:** video ads in IG search results (`ig_search`) are rolling out. Error `100/5234001` if the account is not enabled yet. VERIFIED.
- **v26.0:** Instagram **Explore Feed placement removed**, and requests that name it return errors. Messenger `story` removed from `messenger_positions`. Poll ads removed (`poll_spec`, from 27 Oct 2026 on all versions). `wamo_whatsapp_identity_spec` added. HEF special-category ad sets must send `advantage_audience` explicitly. VERIFIED.
- **v26.0 Graph protocol (all versions from 27 Oct 2026):** `GET /?ids=...` root requests now **return an error**. `date_format` returns an error. `pretty` and `debug` are ignored, and ETag/304 behaviour is removed. Do not use `?ids=` batching. Use the `batch` API or per-object calls. VERIFIED (read through a summary of the v26 Graph changelog).
- **4 May 2026:** "Ads Management Standard Access" was renamed "Marketing API Access Tier". Standard → **Limited access**, Advanced → **Full access**. The auto-approval threshold dropped from 1,500 to **500** calls in 15 days. The error rate is now measured over a rolling 500-request window and must be under 15%. The screen-recording requirement was removed. VERIFIED.
- Nothing in 2026 changelogs touches `asset_feed_spec`, `instagram_user_id`, or the `advideos` upload phases. Video upload docs say the `graph-video.facebook.com` host "has been deprecated", so use `graph.facebook.com` (no date given). The Python and Node SDK uploaders still post to `graph-video.facebook.com`. VERIFIED (Video API overview), LIKELY (still works).
- Earlier items still in force: `instagram_actor_id` deprecated (v22.0). Standard-enhancements bundle removed (v22.0). `advantage_audience` explicit (v23.0). `is_adset_budget_sharing_enabled` required (v24.0). Advantage+ shopping/app campaign creation ended on all versions (19 May 2026).

---

## 2. Rate limiting

Source: https://developers.facebook.com/documentation/ads-commerce/marketing-api/overview/rate-limiting (VERIFIED) and https://developers.facebook.com/docs/graph-api/overview/rate-limiting (VERIFIED through a summary).

### 2.1 Ad-account score (point system)

| | Limited access (default, "development tier") | Full access |
|---|---|---|
| Max score | **60** | **9000** |
| Read / write cost | 1 / 3 | 1 / 3 |
| Decay | 300 s | 300 s |
| Block when max reached | **300 s** | **60 s** |
| Error | `17` / subcode `2446079` "User request limit reached", or `613` / `1487742` "There have been too many calls from this ad-account" | same |

All brief numbers are confirmed. Practical meaning for Limited: about 20 writes per rolling 5 minutes per ad account.

### 2.2 Other ad-account limits (new or not in the brief)

- **Mutation QPS:** 100 requests/s per app + ad account on create/edit of campaigns, ad sets and ads. Error `613` / `5044001`. VERIFIED.
- **Concurrent edits of the same object:** default 1 edit per object per 30 s. Error `613` / `4841018`. Retry at least 30 s later with growing delay. VERIFIED.
- **Ad set budget changes:** 4 per hour per ad set. Error `613` / `1487632`. VERIFIED.
- **Account spend-limit changes:** 10 per day. Error `17` / `1885172`. VERIFIED.
- **Ad creation capped by daily spend limit.** Error `613` / `1487225`. VERIFIED.
- **Abuse prevention:** `613` with **no** subcode. VERIFIED.

### 2.3 Business Use Case (BUC) limits, per ad account per hour

- `ads_management` = **300** (Limited / "Dev tier") or **100,000** (Full) **+ 40 × number of active ads**. VERIFIED.
  - Brief "300 + 40 × active ads" is right **for Limited only**.
- `custom_audience` = 5,000 (Limited) or 190,000 (Full) + 40 × active audiences, max 700,000. `ads_insights` = 600 (Limited) or 190,000 (Full) + 400 × active ads − 0.001 × user errors. VERIFIED.
- BUC errors: `80000` (Ads Insights), `80001` (Pages), `80002` (Instagram), `80003` (Custom Audience), `80004` (**Ads Management**), `80005` (LeadGen), `80006` (Messenger), `80008` (WhatsApp Business Mgmt), `80009` (Catalog Mgmt), `80014` (Catalog Batch). `80000`, `80003` and `80004` come with subcode `2446079`. VERIFIED.

### 2.4 Headers (exact names and shapes)

```
X-Ad-Account-Usage: {"acc_id_util_pct": 9.67, "reset_time_duration": 100, "ads_api_access_tier": "standard_access"}
```
- `acc_id_util_pct`: float, **percent** of the ad-account score used.
- `reset_time_duration`: **seconds** until the score is back to 0.
- `ads_api_access_tier`: string. VERIFIED.

```
X-Business-Use-Case-Usage: {
  "<business-object-id>": [
    {"type": "ads_management", "call_count": 28, "total_cputime": 25, "total_time": 25,
     "estimated_time_to_regain_access": 0, "ads_api_access_tier": "development_access"}
  ]
}
```
- `type` is one of `ads_insights`, `ads_management`, `custom_audience`, `instagram`, `leadgen`, `messenger`, `pages`.
- `call_count`, `total_cputime` and `total_time` are whole-number **percent** of the hourly allowance.
- `estimated_time_to_regain_access` is in **minutes**.
- `ads_api_access_tier` is present only for `ads_insights` and `ads_management`.
- The header can hold up to 32 objects. VERIFIED.
- The Marketing doc calls this header "X-Business-Use-Case". The real name in the Graph doc is **`X-Business-Use-Case-Usage`**.
- For ads types, the key is LIKELY the ad account ID (the doc only says "business object ID").

```
X-App-Usage: {"call_count": 28, "total_time": 25, "total_cputime": 25}   (percent, rolling 1 h)
X-FB-Ads-Insights-Throttle: {"app_id_util_pct": 100, "acc_id_util_pct": 10, "ads_api_access_tier": "standard_access"}
```

- **Tier strings in headers:** `development_access` (Limited) and `standard_access` (Full). VERIFIED in docs. The May 2026 rename says "No code changes are needed… underlying permission identifier remains the same", so the strings are LIKELY unchanged. Confirm in a live test.
- The Graph doc labels `X-Ad-Account-Usage` and `X-Business-Use-Case-Usage` as "(v3.3 and older Ads API calls)". This looks like an old label, because the Marketing doc tells you to read both. Confirm in a live test.

### 2.5 Other throttling codes

| Code / subcode | Meaning |
|---|---|
| `4` | App-level limit ("Application request limit reached") |
| `4` / `1504022`, `1504039` | Ads Insights platform throttle |
| `17` | User-level limit |
| `17` / `2446079` | Ad-account score limit ("User request limit reached") |
| `32` | Pages API limit (user or app token) |
| `613` | Custom limit. The subcode tells which one (see 2.1 and 2.2). `613` / `1996` means "inconsistent request volume". |

### 2.6 Batch requests

- `batch=[...]` takes max **50** sub-requests. For ad creation, Meta says use ≤10 ads per batch.
- "Each call within the batch is counted separately for … API call limits." VERIFIED.
- **Brief is right: batching saves HTTP round trips, not points.** The Marketing rate-limit page still lists batching as a mitigation, which is a doc inconsistency.
- Batch and async request sets do **not** support idempotency keys.

### 2.7 Upgrade to Full access

- App Dashboard → App Review → Permissions and Features → **+Upgrade** on "Marketing API Access Tier".
- Requirements: ≥500 successful Marketing API calls in the last 15 days, and an error rate under 15% over the last 500 calls. VERIFIED.
- The changelog calls this an "auto-approval threshold". The authorization page table labels Full as "(after App Review)".
- Advanced access permissions need Business Verification (permissions reference). LIKELY also needed here.

### 2.8 Budget math for Limited tier (planning, not a Meta figure)

- One PAC video ad ≈ 2 video uploads + about 2 status reads + 1 creative + 1 ad.
- That is 4–8 writes plus reads, roughly 15–25 points.
- So expect **about 2–4 ads per 5 minutes and under 300 calls per hour** per ad account on Limited.
- Read `X-Ad-Account-Usage` on every response. Pause when `acc_id_util_pct` is above about 80. Wait `reset_time_duration` seconds.

---

## 3. Ad image upload

Source: `.../reference/ad-image`, `.../reference/ad-account/adimages`, `.../marketing-api/image-crops`. VERIFIED.

- **Multipart:** `POST /v26.0/act_{id}/adimages` with `-F 'filename=@/path/img.jpg'` (from Meta's image-crops example). The file name must have an extension ("sample.jpg", not "sample"). A **zip** of images is also accepted.
- **Base64:** `-F 'bytes=<base64>'`. The SDK lists only `bytes` and `copy_from` as POST params.
- **Copy from another account:** `copy_from={"source_account_id":"<id without act_>","hash":"<hash>"}`.
- **Response** (read-after-write map). Outer key is `images`, inner key is the uploaded file name (LIKELY `bytes` when sent as base64):
  ```json
  {"images": {"img.jpg": {"hash": "…", "url": "…", "url_128": "…", "url_256": "…",
                          "url_256_height": "…", "url_256_width": "…", "height": 1800, "width": 1440, "name": "img.jpg"}}}
  ```
- Do **not** use the returned `url` in creatives. Meta calls it temporary. Use `hash`.
- Read back: `GET /act_{id}/adimages?hashes=["<hash>"]&fields=hash,width,height,name,status`.
- Limits (Ads Guide, FB feed image): JPG or PNG, **max 30 MB**, recommended 4:5 at 1440×1800, min width 600 px, aspect-ratio tolerance 3%. LIKELY (read through a summary).
- API minimum: images ≥600 px wide for IG (IG media requirements). VERIFIED.

---

## 4. Ad video upload

### 4a. Single request
- `POST /v26.0/act_{id}/advideos` with `source=@file.mp4` (multipart). 1 call. VERIFIED that the param exists.
- Max size for one request: **UNKNOWN** for advideos.
  - Meta's Business Management guide says single-request upload suits videos "less than a few megabytes".
  - Old Graph Video docs gave non-resumable at 1 GB / 20 min.
- **`file_url`** param: Meta fetches the file from a public or pre-signed URL. 1 call. The param is in the reference and the SDK, but the description is only "SELF_EXPLANATORY". LIKELY works. Max size UNKNOWN.

### 4b. Legacy chunked (still in the reference and SDK)
All calls are `POST /act_{id}/advideos`. The SDK posts to `https://graph-video.facebook.com`.

1. `upload_phase=start`, `file_size=<bytes>` → `{"upload_session_id","video_id","start_offset":"0","end_offset":"52428800"}`
2. `upload_phase=transfer`, `upload_session_id`, `start_offset`, `video_file_chunk=@<bytes start..end>` → `{"start_offset","end_offset"}`. Repeat until `start_offset == end_offset`.
   - On a chunk error, `error.error_data` carries the correct `start_offset`/`end_offset` to retry from (SDK behaviour).
3. `upload_phase=finish`, `upload_session_id`, optional `title` → `{"success": true}`

- The server picks the chunk size. Meta's example uses **50 MiB** (`52428800`).
- A 300 MB file ≈ 6 transfer calls, so **8 calls total**. A 500 MB file ≈ 12 calls.
- VERIFIED protocol (SDK + reference). LIKELY 50 MB chunks for advideos (example is from the `/{business_id}/videos` doc).
- `upload_phase` also accepts `cancel`.

### 4c. Newer resumable flow for ad accounts (`rupload.facebook.com`) — VERIFIED doc
Source: https://developers.facebook.com/documentation/ads-commerce/marketing-api/guides/videoads/fbvideoads ("Publishing video ads involves the Resumable (non-chunking) protocol").

1. **Start:** `POST https://graph.facebook.com/v26.0/act_{id}/video_ads` with `upload_phase=start`.
   - Response: `{"video_id":"<VIDEO_ID>","upload_url":"https://rupload.facebook.com/video-ads-upload/v26.0/<VIDEO_ID>"}`
2. **Upload:** `POST https://rupload.facebook.com/video-ads-upload/v26.0/<VIDEO_ID>`
   - Headers: `Authorization: OAuth <TOKEN>`, `offset: 0`, `file_size: <total bytes>`. Body = raw bytes (`--data-binary`).
   - Response: `{"success": true}`.
   - **Hosted file variant:** headers `Authorization: OAuth <TOKEN>` + `file_url: https://…` (http/https, no auth), with no body.
   - **Resume:** `GET https://graph.facebook.com/v26.0/<VIDEO_ID>?fields=status`, read `status.uploading_phase.bytes_transferred`, then POST again with `offset: <that value>` and the bytes from that point.
3. **Finish:** `POST https://graph.facebook.com/v26.0/act_{id}/video_ads` with `upload_phase=finish&video_id=<VIDEO_ID>` → `{"success": true}`.
   - The doc's finish example URL has a typo (`graph.facebook.com/video-ads-upload/v26.0/act_…`). Use the endpoint from the doc's table: `/v26.0/act_{id}/video_ads`.

Other details:
- SDK `POST video_ads` params: `description, is_ai_generated, privacy, title, upload_phase, video_id, video_state`. `GET /act_{id}/video_ads` takes `since` and `until`. VERIFIED.
- Spec on that page: MP4 recommended, 16:9 to 9:16, "Up to 10 GB recommended", min width 1200 px, 24–60 fps, H.264/H.265 (VP9 and AV1 also supported), AAC 128 kbps+ stereo 48 kHz.
- Prerequisites from the doc:
  - The token user needs the `CREATE_CONTENT` task on the ad account.
  - The doc also says: *"If using a business system user in your API requests, note that uploading videos to business accounts is not yet supported."* This is ambiguous, so **test with the system-user token**.
- Whether the rupload call counts toward the ad-account score or BUC: **UNKNOWN**. It is a different host and has no `act_` path.
- The generic Resumable Upload API (`POST /{app-id}/uploads` → `POST /upload:<session>` with `Authorization: OAuth` and `file_offset` → handle `h`) is documented only for Page videos (`fbuploader_video_file_chunk`). `fbuploader_video_file_chunk` does appear in the SDK's `advideos` POST params, so it is LIKELY usable but undocumented for ads. Not recommended.

### Brief check and recommendation
- **"Each video costs ~3 writes":** true only for 4c. 4a costs 1. 4b costs 2 + ceil(size / ~50 MB).
- **Fewest Marketing-API calls for ≤500 MB:**
  - `advideos` with `file_url` (1 call, needs a public or pre-signed URL; size cap unknown), or
  - **4c `video_ads`** (2 graph.facebook.com calls + 1 rupload call, flat for any size, resumable).
- **Recommended default: 4c.** It is documented for ad accounts and it can resume. If the files are already on S3 or a CDN, use the `file_url` header so bytes do not pass through our server.
- **Fallback:** 4b chunked, which the SDK supports.

### Video status
`GET /{video_id}?fields=status`. Shape from SDK `VideoStatus`:
```json
{"status": {"video_status": "processing", "processing_progress": 40,
  "uploading_phase": {"status": "complete", "bytes_transferred": 50002, "source_file_size": 73400320, "errors": []},
  "processing_phase": {"status": "in_progress", "errors": []},
  "publishing_phase": {"status": "not_started", "publish_status": "…", "publish_time": 0, "errors": []},
  "copyright_check_status": {…}}}
```
- `video_status` values:
  - Ad video doc: `ready`, `processing`, `expired`, `error`.
  - Reels doc adds `uploading`, `upload_failed`, `upload_complete`.
  - SDK waits while the value is `processing` and treats anything other than `ready` as failure.
- Phase `status` values: `not_started`, `in_progress`, `complete` / `completed` (docs disagree), `error`.
- `processing_progress`: unsigned int (percent). VERIFIED fields; LIKELY value lists.
- Use a video in a creative only after `video_status == "ready"`.
- IG eligibility check: `GET /{video_id}?fields=is_instagram_eligible`.

### Thumbnails
- `GET /{video_id}?fields=picture` returns a small thumbnail URL.
- `GET /{video_id}/thumbnails` → `data: [{id, uri, is_preferred, width, height, scale, name}]`.
- `POST /{video_id}/thumbnails` with `source=@thumb.jpg` and `is_preferred=true` sets a custom thumbnail. VERIFIED (SDK spec).
- **`object_story_spec.video_data`:** send `image_url` (or `image_hash`).
  - The `video_data` reference does not mark it required.
  - The IG media-requirements page says "`video_data` requires a thumbnail image" with the same aspect ratio as the video, ≥600 px wide.
  - Treat it as required. Use the `is_preferred` thumbnail `uri` as `image_url`. LIKELY required, so test.
- **`asset_feed_spec.videos[]`:** `thumbnail_url` / `thumbnail_hash` are optional.
  - Meta's placement-customization examples send only `video_id` + `adlabels`.
  - On read, Meta fills `thumbnail_url` and `thumbnail_hash`.
  - LIKELY auto-generated thumbnails are accepted.

---

## 5. `asset_feed_spec`, placement customization, multi-text (KEY QUESTION)

Sources:
- `.../ad-creative/asset-feed-spec`, `.../asset-feed-spec/options`, `.../asset-feed-spec/asset-customization-rules`, `.../dynamic-creative/placement-asset-customization`, `.../multi-language-ads`, `.../creative/generative-ai-features`
- **https://developers.facebook.com/documentation/app-ads/advantage-app-campaigns** (sections "Multi-Text Example" and "Placement Asset Customization + Multi-Text Example")
- SDK specs `AdAssetFeedSpec*.json`

### 5.1 Shape (SDK field names, VERIFIED)
```
asset_feed_spec {
  ad_formats: ["SINGLE_IMAGE"|"SINGLE_VIDEO"|"CAROUSEL"|"AUTOMATIC_FORMAT"]   // one only; POST enum also lists CAROUSEL_IMAGE, CAROUSEL_VIDEO, COLLECTION, POST
  optimization_type: string
  images[]:  {hash | url, image_crops?, url_tags?, adlabels?: [{name}]}
  videos[]:  {video_id, thumbnail_url?, thumbnail_hash?, url_tags?, adlabels?: [{name}]}
  bodies[]:  {text, url_tags?, adlabels?}
  titles[]:  {text, url_tags?, adlabels?}
  descriptions[]: {text, url_tags?, adlabels?}
  link_urls[]: {website_url, display_url?, deeplink_url?, url_tags?, adlabels?}
  call_to_action_types: ["LEARN_MORE", ...]      // required except OUTCOME_AWARENESS
  asset_customization_rules[]: {
     customization_spec: {publisher_platforms[], facebook_positions[], instagram_positions[],
                          messenger_positions[], audience_network_positions[], threads_positions[],
                          device_platforms[], age_min, age_max, geo_locations, locales[]},
     image_label | video_label | carousel_label | body_label | title_label | description_label |
     link_url_label | caption_label | call_to_action_label | call_to_action_type_label: {name},
     priority: int,        // "priority number based on the position of this rule in list"
     is_default: bool      // multi-language only
  }
}
```

- **`customization_spec` position enums** (POST `/adcreatives` reference):
  - `facebook_positions`: feed, instant_article, instream_video, marketplace, right_hand_column, search, story, suggested_video, video_feeds, story_sticker, facebook_reels_overlay, biz_disco_feed, **facebook_reels**, profile_feed, profile_reels, notification
  - `instagram_positions`: **reels**, reels_overlay, **stream**, **story**, explore, explore_home, ig_search, shop, profile_feed, profile_reels, effect_tray. Explore Feed was removed in v26.
  - `messenger_positions`: messenger_home, story (removed in v26), marketing_messages
  - `threads_positions`: threads_stream. Needs instagram + `stream` in the same ad.
  - `publisher_platforms`: facebook, instagram, audience_network, messenger, oculus, whatsapp, threads
- **`optimization_type` values:**
  - Options page: `ASSET_CUSTOMIZATION`, `LANGUAGE`, `PLACEMENT`, `REGULAR`, `UNIFIED_PROFILE_VISIT_DESTINATION`.
  - POST reference enum: `REGULAR`, `LANGUAGE`, `PLACEMENT`, `BRAND`, `LOCALIZED_PLACEMENTS`, `FORMAT_AUTOMATION`, `DOF_MESSAGING_DESTINATION`, `ACO_AUTOFLOW`, `MULTI_CREATOR`, `UNIFIED_PROFILE_VISIT_DESTINATION`.
  - **`DEGREES_OF_FREEDOM` is not in either list.** It appears in Meta's text-generation read-back and in the AAC "Multi-Text Example" create call. LIKELY accepted on create.
  - When each is used:
    - `REGULAR`: Dynamic Creative (read-back).
    - `PLACEMENT`: placement customization.
    - `LANGUAGE`: multi-language, with exactly one `is_default` rule.
    - `LOCALIZED_PLACEMENTS`: language + placement in one rule (GitHub issue reply on the Python SDK repo, not official).
    - `DEGREES_OF_FREEDOM`: multiple texts on a normal, non-DC ad.
- **Count limits** (options page, VERIFIED):
  - ≤30 assets in total, and `ad_format` counts as 1.
  - images ≤10, videos ≤10, bodies ≤5, titles ≤5, descriptions ≤5, link_urls ≤5, CTAs ≤5.
  - Title and description ≤255 chars. Body ≤1024 chars.
  - The same page says "If you use Instagram as your placement, only square videos or landscape videos allowed". This is an old Dynamic-Creative note that conflicts with Reels. Ignore it, but test.
- **Rules:**
  - Asset customization needs **≥2 rules**.
  - A rule label that matches no asset gives error `2446173`.
  - Duplicate asset values give error `1815629`.
  - Placement Asset Customization (PAC) on **existing posts** is not supported in the API.
- **Ad set flags:**
  - PAC and multi-language: the ad set uses `is_dynamic_creative=false`. VERIFIED.
  - Dynamic Creative: `is_dynamic_creative=true`, **one ad per ad set**, no customization rules. An ad cannot be deleted; delete the ad set instead (error `1340029`). VERIFIED.
  - Docs list PAC as supported for `APP_INSTALLS`, `BRAND_AWARENESS`, `CONVERSIONS`, `LEAD_GENERATION`, **`LINK_CLICKS`** (legacy names). OUTCOME_TRAFFIC maps from LINK_CLICKS, so LIKELY fine.

### 5.2 KEY ANSWER: one ad with 9:16 (Stories/Reels) + 4:5 (Feed) + 5 bodies + 5 titles

**Yes, using a pattern Meta documents.** In the "Placement Asset Customization + Multi-Text Example":
- each rule binds `image_label`, `body_label` and `title_label`;
- every one of the 5 bodies carries **both** body labels (`[{name: body-label1}, {name: body-label2}]`);
- every one of the 5 titles carries both title labels.

So one label maps to 5 texts and each placement rotates all 5. Labels are many-to-many.

Limits of this evidence:
- The example is SINGLE_IMAGE in an app-install campaign. It has no `optimization_type`, so the default is PLACEMENT.
- Not shown for SINGLE_VIDEO or OUTCOME_TRAFFIC. **LIKELY works. Confirm first with `execution_options=["validate_only"]` on `POST /adcreatives`** (the SDK lists `execution_options` for this endpoint).
- Counter-evidence: the multi-language page describes `body_label` as "Label attached to **one** of the body assets".
- Counter-evidence: a search-result snippet from a non-Meta GitHub repo (outside the allowed sources, not opened) reported error `100` for 3 bodies + 2 placement rules. Treat it as a warning only.

Request to test (adapted from the documented example):
```
POST /v26.0/act_{id}/adcreatives
name=...
object_story_spec={"page_id":"<PAGE_ID>","instagram_user_id":"<IG_USER_ID>"}
asset_feed_spec={
 "ad_formats":["SINGLE_VIDEO"],
 "optimization_type":"PLACEMENT",
 "videos":[{"video_id":"<V_9x16>","adlabels":[{"name":"v_vert"}]},
           {"video_id":"<V_4x5>","adlabels":[{"name":"v_feed"}]}],
 "bodies":[{"text":"B1","adlabels":[{"name":"b_vert"},{"name":"b_feed"}]}, … ×5],
 "titles":[{"text":"T1","adlabels":[{"name":"t_vert"},{"name":"t_feed"}]}, … ×5],
 "link_urls":[{"website_url":"https://example.com"}],
 "call_to_action_types":["LEARN_MORE"],
 "asset_customization_rules":[
  {"customization_spec":{"publisher_platforms":["facebook","instagram"],
                         "facebook_positions":["story","facebook_reels"],
                         "instagram_positions":["story","reels"]},
   "video_label":{"name":"v_vert"},"body_label":{"name":"b_vert"},"title_label":{"name":"t_vert"},"priority":1},
  {"customization_spec":{},
   "video_label":{"name":"v_feed"},"body_label":{"name":"b_feed"},"title_label":{"name":"t_feed"},"priority":2}
 ]}
degrees_of_freedom_spec={"creative_features_spec":{ …all OPT_OUT, see §6… }}
contextual_multi_ads={"enroll_status":"OPT_OUT"}
```

Notes on this request:
- The empty `customization_spec: {}` catch-all rule copies Meta's Threads PAC example, where the last rule has `{}`.
- Alternative: an explicit feed rule, e.g. `facebook_positions:["feed","video_feeds","marketplace","search","profile_feed"]` + `instagram_positions:["stream","explore_home","profile_feed"]`.
- Putting two publisher platforms in one rule is LIKELY allowed: positions are documented as "required if X is selected in publisher_platforms".
- Test with `optimization_type` both `PLACEMENT` and omitted.

**Fallbacks if 5.2 is rejected (most to least faithful):**
1. **Multi-media ad** (`creative.media_sourcing_spec`, new, `.../ad-creative/multi-media-ads`).
   - Up to 10 media in one ad. Each video has `{video_id, original_video_id, source:"multi_media", opt_in_status:"opt_in", thumbnail_url, thumbnail_source, placement_customizations:[{publisher_platform:"instagram", placement_exclusions:["story","reels"]}]}`.
   - Global `titles[]` / `bodies[]` / `descriptions[]` at the `media_sourcing_spec` root ("allow the system to test different text combinations").
   - Exclude the 4:5 video from story/reels and the 9:16 video from feed.
   - It is created inline in `POST /act_{id}/ads`. The primary media must also sit in `object_story_spec.video_data`.
   - VERIFIED doc. Availability for this account: UNKNOWN.
2. PAC with **one** body and title per rule (rotation lost). VERIFIED pattern.
3. Two ads in two ad sets (placements are an ad set setting): a Stories/Reels-only ad set with the 9:16 video and a Feed-only ad set with the 4:5 video. Each ad uses `optimization_type:"DEGREES_OF_FREEDOM"` multi-text. LIKELY.
4. One ad with DOF multi-text and one video, and let Meta adapt it with `video_auto_crop` / `video_uncrop`. You lose control of the 9:16 version.
5. Dynamic Creative ad set (`is_dynamic_creative=true`) with 2 videos, 5 bodies and 5 titles. No placement control and 1 ad per ad set.
6. Flexible ad format (`creative_asset_groups_spec`) only supports **OUTCOME_SALES / OUTCOME_APP_PROMOTION**, so it does not apply to traffic. VERIFIED.

### 5.3 Several texts on a single image or single video ad
- `object_story_spec.link_data.message` and `video_data.message` hold **one** string. Several primary texts or headlines need `asset_feed_spec`.
- Meta's "Multi-Text Example":
  ```
  object_story_spec={"page_id","instagram_user_id"}
  asset_feed_spec={"optimization_type":"DEGREES_OF_FREEDOM",
                   "bodies":[×5], "titles":[×5], "images":[{"hash"}],
                   "link_urls":[…], "call_to_action_types":[…]}
  ```
  - The doc example wraps `asset_feed_spec` twice (a typo) and has no `ad_formats`. Add `"ad_formats":["SINGLE_VIDEO"]` or `["SINGLE_IMAGE"]`. LIKELY.
- Ad set flag: not stated for DOF. LIKELY a normal ad set (`is_dynamic_creative=false`).
- Sending an asset feed with no rules and no DOF type to a non-DC ad set: error code UNKNOWN.
- `text_optimizations` (a creative feature) can also mix the texts you give. Opt out unless you want it.

---

## 6. `degrees_of_freedom_spec.creative_features_spec`

Sources: `.../creative/advantage-creative/get-started` (VERIFIED), the out-of-cycle 2026 page, the v22.0 changelog, and `https://developers.facebook.com/docs/marketing-api/reference/ad-creative-features-spec/` (v26, through a summary).

- **Shape:** `degrees_of_freedom_spec={"creative_features_spec":{"<key>":{"enroll_status":"OPT_IN"|"OPT_OUT","customizations":{…}?}}}`. `enroll_status` has only `OPT_IN` and `OPT_OUT`. VERIFIED.
- **Documented keys for normal ads** (get-started table, current), plus `text_generation` (generative-AI page):
  ```
  adapt_to_placement, add_text_overlay, creative_stickers, description_automation, enhance_cta,
  image_animation*, image_background_gen, image_brightness_and_contrast, image_templates,
  image_text_translation, image_touchups, image_uncrop, inline_comment, media_type_automation,
  pac_relaxation, product_extensions, reveal_details_over_time, text_optimizations, text_translation,
  translate_voiceover, video_auto_crop, video_filtering*, video_uncrop*, text_generation
  ```
  `*` = added 28 Jun 2026.
- **Music** is not a key. Opt out by sending `asset_feed_spec.audios: []`.
- The get-started example writes `image_template` (singular). The table and SDK use `image_templates`. Use `image_templates`.
- **Full SDK key list** (`AdCreativeFeaturesSpec.json`, v26 codegen, 84 keys; many are catalog, WhatsApp or gated):
  `adapt_to_placement, add_text_overlay, ads_with_benefits, advantage_plus_creative, app_highlights, audio, auto_promotion_tag, biz_ai, carousel_to_video, catalog_feed_tag, creative_stickers, customize_product_recommendation, cv_transformation, description_automation, dha_optimization, dynamic_cta_text, dynamic_partner_content, enable_ncs_testimonials, enhance_cta, fb_feed_tag, fb_reels_tag, fb_story_tag, feed_caption_optimization, generate_cta, hide_price, hyperlink_formatting, ig_feed_tag, ig_glados_feed, ig_reels_tag, ig_stream_tag, ig_video_native_subtitle, image_animation, image_auto_crop, image_background_gen, image_banner, image_brightness_and_contrast, image_end_card, image_enhancement, image_templates, image_text_translation, image_touchups, image_uncrop, inline_comment, local_store_extension, media_liquidity_animated_image, media_order, media_type_automation, multi_creative_post_carousel, multi_photo_to_video, music_generation, pac_genai_recomposition, pac_recomposition, pac_relaxation, product_browsing, product_extensions, product_metadata_automation, product_tags, profile_card, profile_extension, replace_media_text, reveal_details_over_time, show_destination_blurbs, show_summary, site_extensions, standard_enhancements, standard_enhancements_catalog, text_extraction_for_headline, text_extraction_for_tap_target, text_formatting_optimization, text_generation, text_optimizations, text_overlay_translation, text_translation, translate_voiceover, video_auto_crop, video_filtering, video_highlight, video_highlights, video_to_image, video_uncrop, video_uncrop_9x16_to_9x18, video_voiceover, wa_mm_image_filtering, wa_mm_text_truncation_length`
- **Defaults:**
  - The reference marks `adapt_to_placement`, `description_automation` and `inline_comment` as "Default is opt-in". The get-started guide confirms this for `adapt_to_placement`.
  - The June 2026 keys are **not** documented as default opt-in.
  - Defaults for other keys when omitted: UNKNOWN.
  - Brief "some default to opt-in" is true, but for these three older keys, not the June ones.
  - **Send `OPT_OUT` explicitly for every documented key you do not want, then read back.**
  - Opting in to an ineligible feature is silently dropped. Sending an unknown or gated key may error, so send only the documented list above.
- **AI-generated features** (image_animation, image_background_gen, image_uncrop, image_templates, video_uncrop, translate_voiceover, text_generation): Meta says create the ad `PAUSED` and preview with `GET /{ad_id}/previews?creative_feature=<key>&ad_format=…` before activating. This is no issue for us because everything stays paused.
- **`standard_enhancements`:**
  - Opt-in and preview of the bundle stopped in **v22.0** (21 Jan 2025).
  - Per-feature keys replace it ("same effect as previously opting in/out of standard enhancements").
  - The old bundle covered image_template, image_touchups, text_optimizations, inline_comment (image) and video_auto_crop, text_optimizations, inline_comment (video).
  - What happens if you send it now: UNKNOWN (likely ignored or an error), so do not send it.
  - On read, Meta may add `standard_enhancements` sub-keys. Ignore them unless one is `OPT_IN`.
  - Legacy error `3858082` = "eligible for Standard Enhancements, but enroll_status was not provided".
- **Read back effective features:**
  - `GET /v26.0/{creative_id}?fields=degrees_of_freedom_spec,contextual_multi_ads`, or
  - `GET /{ad_id}?fields=creative{degrees_of_freedom_spec,contextual_multi_ads,asset_feed_spec}`.
  - The POST reference shows `action_metadata.type` (DEFAULT, DEFAULT_OPT_IN, DEFAULT_OPT_OUT, MANUAL, STICKY_OPT_IN, …) on these specs, which can tell defaults apart from your choices. LIKELY present on read.

---

## 7. Instagram identity

- **Current field: `instagram_user_id`.** VERIFIED (v26 `object_story_spec` reference, SDK).
- `instagram_actor_id`:
  - Deprecated in v22.0 (21 Jan 2025). "Will apply to all versions September 9, 2025."
  - It is gone from SDK `AdCreative` and `AdCreativeObjectStorySpec`.
  - Sending both fields gives error `2238055` or `2446149`.
- **Where it goes:**
  - New post creatives: `object_story_spec.instagram_user_id`, next to `page_id`. All asset-feed examples do this.
  - There is also a top-level creative param `instagram_user_id`, used with `object_story_id` or `source_instagram_media_id`. VERIFIED (POST reference and SDK).
- **Page rule:** if the IG account is Page-connected or Page-backed, `page_id` **must** be that Page.
- Error `1815199` = "Ad account has no access to this Instagram account".
- **Listing usable accounts:**
  - `GET /v26.0/act_{id}/instagram_accounts?fields=id,username`. Doc: "check all the Instagram accounts associated with an ad account". The `id` is "Required for creating ads". VERIFIED.
  - `GET /act_{id}/connected_instagram_accounts`. The edge exists. VERIFIED.
  - `GET /{business_id}/instagram_accounts` (owned or accessible) and `/{business_id}/instagram_business_accounts`. VERIFIED.
  - `GET /{page_id}/instagram_accounts` with a **Page token** returns the Page-connected account. `GET /{page_id}/page_backed_instagram_accounts` returns the PBIA (a POST creates one). VERIFIED.
  - `GET /{page_id}?fields=instagram_business_account` (IG platform IG-User ID). LIKELY the same ID as `instagram_user_id`, because the ads docs now point to the IGUser ID. Test.
  - Link an IG account to an ad account: `POST /{ig_user_id}/authorized_adaccounts` with `business` + `account_id`. VERIFIED.

---

## 8. Multi-advertiser ads opt-out
- `POST /act_{id}/adcreatives` (or inline creative) with top-level `contextual_multi_ads={"enroll_status":"OPT_OUT"}`. VERIFIED.
- Ads created on or after 19 Aug 2024 **without** this field are opted **in** by default.
- It is a sibling of `object_story_spec`, not inside `degrees_of_freedom_spec`.
- Source: `.../creative/multi-advertiser-ads`.

---

## 9. Campaigns, ad sets, ads, copies

**Campaign (PAUSED, traffic)** — VERIFIED (reference example):
```
POST /v26.0/act_{id}/campaigns
name=…  objective=OUTCOME_TRAFFIC  status=PAUSED  special_ad_categories=[]  is_adset_budget_sharing_enabled=false
→ {"id":"<CAMPAIGN_ID>"}
```
- `special_ad_categories`: `[]` is the documented form. The enum also has `NONE` (`["NONE"]` LIKELY accepted). It is required.
- `is_adset_budget_sharing_enabled` is required since v24 when the budget sits on the ad sets (no campaign budget). Set it to true or false. `true` shares up to 20% of budget between ad sets.

**Ad set (PAUSED, website traffic)** — VERIFIED fields, LIKELY minimal set:
```
POST /v26.0/act_{id}/adsets
name=…  campaign_id=…  status=PAUSED
daily_budget=<minor units, e.g. 50000 = ₹500.00>     # "specified in cents"; currency offset applies
billing_event=IMPRESSIONS  optimization_goal=LINK_CLICKS (or LANDING_PAGE_VIEWS)
bid_strategy=LOWEST_COST_WITHOUT_CAP                  # else LOWEST_COST_WITH_BID_CAP needs bid_amount
destination_type=WEBSITE                               # optional for website traffic (LIKELY)
targeting={"geo_locations":{"countries":["IN"]},"age_min":18,
           "targeting_automation":{"advantage_audience":1}}   # 0 or 1, explicit since v23
is_dynamic_creative=false
→ {"id":"<ADSET_ID>"}
```
- No `promoted_object` for website LINK_CLICKS or LANDING_PAGE_VIEWS. It is needed only for app traffic (`application_id`, `object_store_url`).
- `end_time` is not needed with a daily budget (`end_time=0` means ongoing).
- EU (DSA) targeting needs `dsa_beneficiary` and `dsa_payor`. Brazil needs `regional_regulated_categories:["BRAZIL_REGULATION"]`.
- If placements are set by hand, `targeting.publisher_platforms` / `facebook_positions` / `instagram_positions` must include the positions your PAC rules use.

**Detect Dynamic Creative:** `GET /{adset_id}?fields=is_dynamic_creative` (bool, default false). VERIFIED.

**Ad (PAUSED):**
```
POST /v26.0/act_{id}/ads
name=…  adset_id=…  creative={"creative_id":"<CREATIVE_ID>"}  status=PAUSED
→ {"id":"<AD_ID>"}
```
- `creative` can also be an inline spec (`{"name":…,"object_story_spec":…,"asset_feed_spec":…}`). That gives 1 write per ad instead of 2. VERIFIED.
- `conversion_domain` is needed only if the campaign shares data with a pixel.
- New ads pass through `PENDING_REVIEW`.

**Ad set copy** — VERIFIED (`.../reference/ad-campaign/copies`):
```
POST /v26.0/{adset_id}/copies
deep_copy=true  status_option=PAUSED (default PAUSED; ACTIVE | INHERITED_FROM_SOURCE)
rename_options={"rename_strategy":"DEEP_RENAME|ONLY_TOP_LEVEL_RENAME(default)|NO_RENAME","rename_prefix":"…","rename_suffix":"…"}
campaign_id?  start_time?  end_time?
→ {"copied_adset_id":"…","ad_object_ids":[{"ad_object_type":"ad|ad_set|unique_adcreative|…","source_id":"…","copied_id":"…"}]}
```
- It runs **synchronously**. A sync `deep_copy` is limited to **3** child ads.
- For more child ads use `asyncbatch=[{"method":"POST","relative_url":"<adset_id>/copies","name":"c1","body":"deep_copy=true&…"}]` (≤50 requests, ≤51 ads each).
- The default `rename_suffix` adds " - Copy".
- v26: HEF campaign copies must carry `advantage_audience`.

**Retry-safe creates (new, worth using):** send header `X-Client-Idempotent-Key: <uuid v4>` on `POST /act_{id}/campaigns|adsets|ads|adcreatives`.
- The key is scoped to the ad account and kept 7 days.
- A retry with the same key and the same body returns the original object.
- The same key with a different body gives error `100/1349016`.
- It is not supported in batch or async requests. It is rolling out gradually and ignored where not enabled.
- Source: `.../marketing-api/idempotent-requests`. VERIFIED.

---

## 10. Review status
- `effective_status` (ad) = `ACTIVE, PAUSED, DELETED, PENDING_REVIEW, DISAPPROVED, PREAPPROVED, PENDING_BILLING_INFO, CAMPAIGN_PAUSED, ARCHIVED, ADSET_PAUSED, IN_PROCESS, WITH_ISSUES`. VERIFIED (reference + SDK enum).
- Ad set `effective_status` = `ACTIVE, PAUSED, DELETED, CAMPAIGN_PAUSED, ARCHIVED, IN_PROCESS, WITH_ISSUES`.
- Creative `status` = `ACTIVE, IN_PROCESS, WITH_ISSUES, DELETED`.
- `configured_status` = what you set.
- **Problem fields** (VERIFIED shapes from SDK):
  - `ad_review_feedback`: `{"global": {"<policy_key>": "<message>"}, "placement_specific": {"facebook": {...}, "instagram": {...}, …}}`
  - `issues_info`: `[{"error_code", "error_message", "error_summary", "error_type", "level", "mid"}]`
  - `recommendations`: `[{"blame_field", "code", "confidence": HIGH|MEDIUM|LOW, "importance": HIGH|MEDIUM|LOW, "message", "title", "value", "recommendation_data": {"link"}}]`
  - `failed_delivery_checks`: list of DeliveryCheck.
- Poll: `GET /{ad_id}?fields=effective_status,configured_status,ad_review_feedback,issues_info,recommendations,creative{id,status}`.
- The webhooks page writes `review_feedback`, but the reference and SDK use **`ad_review_feedback`**.
- Push option: `effective_status` webhook on the `ad_account` object. It sends a `field_changed` notice only, so you still poll the object.

---

## 11. Finding objects by name
- Syntax: `GET /v26.0/act_{id}/ads?fields=id,name,adset_id,effective_status&filtering=[{"field":"name","operator":"CONTAIN","value":"LAUNCH-123"}]`. URL-encode the JSON. Same form on `/adsets` and `/campaigns`.
- The `filtering` param and `CONTAIN` / `STARTS_WITH` / `IN` / `GREATER_THAN` are documented for insights (`.../insights/best-practices`).
- The SDK operator enum (`AdRuleFilters_operator`): `ALL, ANY, CONTAIN, EQUAL, GREATER_THAN, IN, IN_RANGE, LESS_THAN, NONE, NOT_CONTAIN, NOT_EQUAL, NOT_IN, NOT_IN_RANGE`.
- The ads, adsets and adcreatives edge references do **not** list `filtering`. LIKELY works on /ads and /adsets (common use). UNKNOWN on `/adcreatives`.
- Fallback: `GET …?fields=id,name&limit=500`, page with `paging.cursors.after`, and match on our side.
- Documented list params: `effective_status=["ACTIVE","PAUSED"]`, `updated_since`, `date_preset`, `time_range` on /ads and /adsets.
- Names are not unique in Meta. Store the IDs we create.

---

## 12. Sandbox ad accounts
- **Still offered:** App Dashboard → Use cases → Marketing API → **Quickstart** → "**Create Sandbox Ad Account**". Pick a Page in the popup.
  - Doc text: "test ad creation and reporting … without incurring charges. These ad accounts don't require a payment method and the ads you create won't run … mock ad performance data."
  - Source: https://developers.facebook.com/documentation/development/create-an-app/marketing-api-use-cases. VERIFIED.
- **Conflict:** the Marketing API best-practices page says "in sandbox mode you cannot create ads or ad creative". The 2016 sandbox blog says one sandbox account per developer and that it is not visible in Ads Manager.
- Whether it accepts real Pages, IG accounts and `advideos` / `video_ads` uploads: **UNKNOWN**.
- Safer test plan: a real ad account with the campaign, ad sets and ads all `PAUSED` (no delivery), plus `execution_options=["validate_only"]` on creates.

## 13. App mode and error 1885183
- Error `1885183`: "Ads creative post was created by an app that is in development mode. It must be in public to create this ad." VERIFIED (`.../marketing-api/error-reference`).
- The unpublished Page post that `object_story_spec` creates is visible only to app role users while the app is in Development mode.
- **Fix:** switch the app to **Live** using the App Dashboard mode toggle (or Publish → Go live). Then create creatives again. LIKELY needed for creatives made in dev mode.
- Fields the docs mark required to go Live: display name, contact email, Terms of Service URL, app icon, category, app purpose. Also fill Privacy Policy URL and data-deletion URL.
- Business Verification is "not required to Go Live". App Review is needed only for permissions or features that non-role users must grant.

## 14. Creative limits

| Item | Value | Source / confidence |
|---|---|---|
| Asset feed body | ≤1024 chars, ≤5 bodies | options page, VERIFIED |
| Asset feed title / description | ≤255 chars, ≤5 each | VERIFIED |
| IG caption (message) | ≤2200 chars. IG-only ads error; mixed-placement ads are created but not delivered on IG. ≤30 hashtags. | IG media requirements, VERIFIED |
| Recommended text (Ads Guide) | FB feed: primary 50, headline 27. IG feed/stories: primary 125. IG Reels: primary 44 | Ads Guide via summary, LIKELY |
| Hard limits for `object_story_spec` message / name / description | not documented | UNKNOWN |
| Image | JPG/PNG, ≤30 MB, 4:5 recommended 1440×1800, min 600 px wide (IG ≥600 px), tolerance 3% | Ads Guide (LIKELY) + IG reqs (VERIFIED) |
| Image crop keys | `100x100, 191x100, 400x500, 90x160, 600x360, 400x150, 100x72, 300x400`. Stories ignore crops. | VERIFIED |
| Video (Ads Guide) | MP4/MOV/GIF, ≤4 GB. FB feed: 4:5 recommended, 1 s–241 min, min 120 px. IG Stories: 9:16 ±1%, 1 s–60 min (cards split at 16 s), min 250 px. IG Reels: 9:16, 0 s–15 min, 1440×2560 recommended, min width 250 px (500 px if ≥30 s). Safe zones: top 14%, bottom 35%, sides 6%. | LIKELY |
| Video (video_ads upload page) | "Up to 10 GB recommended", min width 1200 px, 16:9 to 9:16, 24–60 fps | VERIFIED (conflicts with 4 GB above) |
| Video (old IG ads page) | ≤2.3 GB, 3–60 s | VERIFIED but outdated |

## 15. Permissions and system users
- **Token scopes for a system user that creates Page + IG ads:**
  - `ads_management` (its listed dependencies are `pages_read_engagement` and `pages_show_list`)
  - `business_management` (Business Manager asset edges such as `/{business_id}/instagram_accounts`; also listed for system-user tokens in Meta's system-user guide)
  - `pages_manage_ads` ("Create ads for your Page")
  - `pages_read_engagement` (the video-ads guide lists it with `ads_management` for creatives)
  - Optional: `ads_read` (reporting) and `instagram_basic` (reading IG profile data).
  - VERIFIED descriptions; LIKELY that this is the minimal set.
- **Asset assignment in Business Settings:**
  - The system user needs the ad account (full control or "Manage campaigns"), the Page (at least the Advertiser task), the IG account, and the app.
  - Video upload doc: the user needs the `CREATE_CONTENT` task on the ad account.
- **System-user limits:** Limited access "Can create 1 system user and 1 admin system user". Full access "10 system users and 1 admin system user". VERIFIED (`.../get-started/authorization`). Matches the brief.
- Limited access also has "No Business Manager access to manage ad accounts, user permissions, and Pages" through the API. Reading our own assets is fine.

---

## Disagreements with the brief
1. **BUC hourly cap:** "300 + 40 × active ads" is the **Limited** formula only. Full is **100,000 + 40 × active ads**.
2. **Video cost "~3 writes (start, upload, finish)":**
   - True only for the new `video_ads` + rupload flow, and the rupload call may not count against the ad account.
   - Legacy chunked `/advideos` is 2 + ceil(size / ~50 MB) calls (8 for 300 MB).
   - Single `source` or `file_url` is 1 call.
3. **Upgrade:** you click "+Upgrade" in App Review when the thresholds are met (auto-approval). The threshold is 500 calls in 15 days (it was 1,500 before 4 May 2026). The error rate is <15% over the last 500 calls, not a fixed period. Screen recording is no longer required.
4. **creative_features_spec defaults:** the June 2026 keys (`image_animation`, `video_filtering`, `video_uncrop`) are **not** documented as default opt-in. The documented default opt-ins are `adapt_to_placement`, `description_automation` and `inline_comment` (plus `contextual_multi_ads`).
5. **`optimization_type: DEGREES_OF_FREEDOM`** is used in Meta examples but is **not** in the documented enum for POST `/adcreatives`.
6. **Tier names:** the official names are now "Limited access" and "Full access" (since May 2026). Headers still document `development_access` and `standard_access`.
7. Not a disagreement, but missing from the brief: **100 QPS mutation cap** (`613/5044001`), **1 edit per object per 30 s** (`613/4841018`), and Marketing API **v24 ends 10 Nov 2026**.

## Needs a live test
1. PAC + 5 bodies + 5 titles with `SINGLE_VIDEO` (9:16 + 4:5) in an OUTCOME_TRAFFIC ad set, using `execution_options=["validate_only"]`.
   - Check `optimization_type` `PLACEMENT` vs omitted.
   - Check the empty `{}` catch-all rule vs an explicit feed rule.
   - Check two platforms in one rule.
2. `optimization_type:"DEGREES_OF_FREEDOM"` accepted on create. Which `ad_formats` it needs.
3. Whether `video_data` without `image_url` / `image_hash` is rejected. Whether `asset_feed_spec.videos` without a thumbnail is accepted.
4. `video_ads` + rupload with the **system-user** token.
   - Does the rupload call show `X-Ad-Account-Usage` or count toward the BUC?
   - Does the returned `video_id` work in creatives?
5. `POST /advideos` with `file_url` (1 call): max size and processing time. Max size of a single `source` upload.
6. Chunk size returned by `/advideos` `upload_phase=start`.
7. Header strings after the tier rename (`development_access` / `standard_access`?). Whether `X-Business-Use-Case-Usage` appears on ads_management calls and what its key is.
8. `filtering` `CONTAIN` on `/adcreatives` (and on `/ads` and `/adsets`).
9. Sandbox account: can it create creatives with our real Page and IG account, and upload videos?
10. `GET /{page_id}?fields=instagram_business_account` ID == ID from `/act_{id}/instagram_accounts`, and accepted as `instagram_user_id`.
11. Read back `degrees_of_freedom_spec` with no features sent, to see real defaults. What happens when a gated key is sent.
12. Error returned when a multi-body `asset_feed_spec` (no rules, no DOF) goes to an `is_dynamic_creative=false` ad set.
13. `bytes` upload: the response key name.
14. Whether `X-Client-Idempotent-Key` is active for our app (it is rolling out).
15. Multi-media ads (`media_sourcing_spec`) available for our ad account as fallback 1.
16. Exact block length and recovery on Limited when 60 points are hit (300 s per docs).
