# Decisions

One line each: what was decided, and why. Newest at the bottom of each section.

## Stack
- Single repo, single npm package: Next.js 16 (UI + API) and a separate worker process (`tsx src/worker/index.ts`) sharing one SQLite file in WAL mode. Simplest thing that runs long launches; rejected a monorepo with workspaces (more moving parts, no gain at this size).
- SQLite driver: better-sqlite3 (synchronous, prebuilt Arm64 binaries). Rejected Node's built-in `node:sqlite` (still marked release-candidate).
- Google Drive: `@googleapis/drive` + `google-auth-library` instead of the full `googleapis` package. Same Google-maintained code, about 1/50 of the install size.
- Meta: plain `fetch`, no Meta SDK. The SDK adds nothing for pacing, and we need full control over headers and retries.
- TypeScript 5.9, not 7.0: Next.js 16's type-check still uses the TypeScript JS API, which 7.0 (native compiler) does not provide yet.
- No CSS framework: one hand-written stylesheet. Fewer dependencies, and the app has five screens.
- Worker runs TypeScript with `tsx` in production. Rejected a separate esbuild step: one less build to break.

## Launch engine
- Every Meta object name ends with `[L:<batch key>-<ad number>]`, e.g. `[L:k4r94-03]`. Brackets read clearly in Ads Manager and work with Meta's `CONTAIN` name filter.
- Every run (first run included) starts with 3 reads that list ads, creatives and ad sets whose name contains `[L:<batch key>-`, and adopts them. Costs 3 points per run, whatever the batch size, and covers crashes, timeouts and database restores. Rejected: a lookup before every create (about 10% more points on the 60-point tier).
- Before each create, the attempt is written to the database first. If a create got no clear answer, the retry looks up that one object by its key before creating again.
- New ad set per ad: `POST /{template}/copies` with `rename_suffix: " [L:key]"`, then a rename to the naming template. The key is in the name from the first moment, so a crash between copy and rename can't cause a duplicate. Rename is tracked separately and repeated if needed.
- The pacer keeps our own 5-minute log under 75% of the cap AND obeys Meta's usage headers (waits when Meta reports over 75%). The cap starts at 60 and is learned from the headers (points spent / percent reported), so the 9,000-point tier is picked up without a config change.
- Rate-limit errors are retried forever (they only slow a batch). Other transient errors: 3 retries per ad, then the ad is marked failed with a plain message.
- The worker has two lanes in one process: launches (one batch at a time) and review checks + backups. A review check takes a few reads, so it no longer waits up to 20 minutes behind a launch. Both lanes share the one pacer per ad account, so together they stay under the limit. Rejected: review checks in the web process (a second pacer that can't see the worker's calls).
- Video status is polled every 30 seconds per waiting ad. While one ad waits for Meta to process its video, the worker carries on with the next ad's uploads.
- Images and videos with the same base name never share an ad (split automatically); mixing them in one placement-customized ad is not something we can test without a real account.
- Ratio is read from real pixels (sharp for images incl. EXIF rotation, ffprobe for videos incl. rotation metadata). 3% tolerance. 9:16 serves Stories and Reels; 4:5, 1:1 and 16:9 serve Feed.
- Dates in names use India time (IST), so a 1 a.m. launch gets the right date.
- Errors block launch; warnings need one "I accept the warnings" tick (or `accept_warnings: true` from Claude).

## From the Meta research (docs/META-API-NOTES.md)
- Graph API pinned to v26.0 (`META_API_VERSION`). v24.0, the version this code was first written against, stops on 10 Nov 2026.
- Video upload: Meta's resumable ad-video flow (`/act_x/video_ads` start → rupload.facebook.com → finish): 3 calls for any size, resumable from the byte Meta has. If Meta refuses it (its docs say system users may not be supported yet), the run falls back to the older chunked `/advideos` upload. Rejected: `file_url` (would need a public link to our files).
- Placement pair + several texts: Meta's documented "PAC + multi-text" pattern (each body and title carries both rules' labels). Rule 2 is the empty catch-all `{}` instead of a list of feed positions, because Meta removes positions between versions (v26 dropped Explore Feed and Messenger Stories, and naming them is an error).
- Several texts on one file: `asset_feed_spec` with `optimization_type: DEGREES_OF_FREEDOM` (Meta's own example), not Dynamic creative.
- Enhancements: send `OPT_OUT` for the 24 documented keys only (unknown or gated keys may be rejected); read back and warn about anything else switched on, naming it. The 84 keys in Meta's SDK are known by name for clearer warnings.
- `X-Client-Idempotent-Key` on every create: a UUID made from the ad key and object kind. Meta returns the first object for a repeat. Kept together with the name-key lookups, because Meta is still rolling this out.
- Review check reads `/act_x/ads` filtered by the batch key (one read per 100 ads). `GET /?ids=` returns an error since v26.
- `reset_time_duration` is "seconds until the score is back to 0", not a block; it is used only when Meta has actually refused a call.
- If Meta refuses the name filter on `/adcreatives` (not documented there), the tool lists the last 1,000 creatives and matches names itself.

## Web app and Claude
- One page per batch with six numbered steps, saved as you go (no Save button), and remembered last choices. Fewer clicks than a wizard: a repeat launch is paste link → Launch.
- Drive: paste a folder link (sub-folders up to 3 levels). Sizes, ratios and durations come from Drive's own metadata, so the preview needs no download; files are downloaded by the worker at launch. Rejected for v1: a Drive folder browser.
- Google: Internal consent screen + `drive.readonly`, assuming both people are on sahajta.com Workspace (see BLOCKERS). The Picker / `drive.file` fallback is not built.
- Google refresh tokens are stored encrypted in the database, not in the session cookie, so the worker can download Drive files when nobody is online.
- Meta connection (changed 11 Nov 2026): the person who uses the launcher connects Meta in the app (Settings → Meta connection), not the builder on the server. Facebook Login for Business with a configuration that gives a system-user token that never expires (a 60-day personal-login configuration is the backup), then they pick the ad account, Page and Instagram account. The code is swapped for the token on the server; the token is stored AES-256-GCM encrypted and never sent to a browser. "Paste a token instead" covers ad accounts the login can't see. Rejected: the server-side `meta-setup.ts` script (only the builder could do it) and per-person Meta connections (one connection for the team is enough now).
- Login method changed to the personal Facebook login (16 Nov 2026): the agency keeps the ad account in its own portfolio and won't share it, and the business login only offers portfolios the person fully controls. The personal login lists every ad account the person's profile can use, the way AdManage and Bïrch do. Cost: the token lasts 60 days, so someone reconnects every two months (the app shows the date).
- Connecting a different ad account copies the copy templates, naming templates and presets from the one in use, so nothing is lost when the agency account arrives.
- Instagram accounts are listed through the ad account (`/act_…/instagram_accounts`, covered by `ads_management`); `instagram_basic` is not offered for this app type.
- Claude: one tool file, two transports. Claude Desktop gets a `.mcpb` (stdio, bundled into one 1.3 MB file, Claude Desktop supplies Node). Claude Code gets `/api/mcp` (stateless HTTP with the API key as a Bearer header), which makes the one-line `claude mcp add` possible without downloading anything. Both call our HTTP API with the person's key. Not OAuth, not for claude.ai web (phase 2).
- `launch_batch` takes `confirm: true` as a required literal, and refuses when there are warnings unless `accept_warnings: true`. Claude's tool descriptions tell it to show the preview and ask first.
- API keys: shown once, stored as SHA-256, revocable, per person.
- Every address the app sends a browser to (after Google sign-in, Connect Meta, uploads) is built from `APP_URL`, never from the incoming request: behind Caddy, Next.js sees each request as `localhost:3000`. `AUTH_URL` defaults to `APP_URL`; uploads use relative addresses. Found on the first real sign-in (16 Nov 2026), which landed on `https://localhost:3000`.

## Hosting
- Docker Compose: `app`, `worker` (same image), `caddy`. Named volume for `/data` (no host permission problems).
- Backups: Oracle Object Storage pre-authenticated request (write-only URL) + plain HTTP PUT. No SDK, no keys on the server. Bucket lifecycle deletes after 30 days.
- Machine size: 1 OCPU / **2 GB**, not the brief's 4 GB. Measured in Docker: app ~125 MB + worker ~140 MB + Caddy ~30 MB + Ubuntu ~250 MB ≈ 550 MB = ~27% of 2 GB but ~13% of 4 GB, which would let Oracle reclaim an idle machine. 2 GB swap covers the build.
- Health: `/api/health` (app, database, worker heartbeat) + cron restart after two failures + free UptimeRobot email (manual step).
- Image is built on the server from the repo (one script). Rejected: a registry (another account and secret to manage).
- Hosting stays on Oracle at `ads.sahajta.com` (10 Nov 2026). Rejected: Vercel. Launches run 15–25 minutes in a worker (Vercel stops a request after 5 minutes, 13 on Pro), the database is a file on disk, uploads go up to 4 GB (Vercel limit 4.5 MB per request), and the free Hobby plan is for non-commercial use only (Pro is paid).
- Temporary server until a free Arm machine is available (15 Nov 2026): Hyderabad had no free A1 capacity ("Out of host capacity"). The app runs on `ads-launcher-temp` (VM.Standard.E5.Flex, AMD, 1 OCPU, 4 GB), paid from the trial credits. The account has no card and can't be upgraded, so it can't be charged. Oracle deletes non-free machines when the trial ends (about 1 Dec 2026), so move to the Arm machine before then. A script on the admin's Mac (`~/.oci/arm-retry.sh`, log `~/.oci/arm-retry.log`) asks for the A1 machine every 3 minutes and stops once it exists. Rejected: the free AMD micro (1/8 CPU, 1 GB; likely reclaimed as idle) and pay-as-you-go (forbidden).
- Address moved from `ads.sahajta.com` to `launcher.sahajta.com` (16 Nov 2026): ad-blocking browser extensions block every file from a host that starts with `ads.`, so the page loaded without its styles and scripts. The per-ad API path `/ads/` became `/items/` for the same reason. Rejected: asking each user to allow the site in their ad blocker.
- Fallback for "placement + several texts" is one setting, not a code change: `META_PAC_TEXTS=first` sends only the first text and headline in paired ads (Meta's fallback 2) and the preview warns per ad. `scripts/real-test.ts` tries the full version first, then the fallback, and writes which one to use.

## Change list from the marketer (17 Nov 2026)
- Batch rbqdz failed with Meta code 200/1815199: the ad account had no Instagram account assigned; the Instagram account was offered only because it is linked to the Page. Now the Instagram list marks accounts the ad account may not use (from `/act_x/instagram_accounts`), picking one is refused with the fix in plain words, and the preview blocks the launch. Every Meta error also shows Meta's own words and code.
- Batch u2942 (minimum spend above the campaign budget, 1885648): the copy is rebuilt from the template's settings without the spend limits. Rejected: lowering the template's limits in Meta (changes the person's own ad set).
- Never delete: `MetaClient` has no delete method and refuses DELETE requests and the statuses DELETED and ARCHIVED before anything is sent. The fake Meta throws if a DELETE ever reaches it.
- One "plan" engine for every change to campaigns and ad sets (create, copy, edit, turn on/off, ads from a post), used by the app and by Claude. A plan is checked first (reads only, plus Meta's `validate_only` for the first create of each kind), shows every budget and the total, and runs only after confirm. Rejected: one tool per action that writes at once (no single place for the guardrail, no bulk).
- Guardrail for spending: anything that turns something on, or raises a budget on something that is on, needs the total daily budget typed back exactly as the summary shows it, in the app and through Claude. The check runs again right before the plan starts; if budgets changed in Ads Manager since, the old total is refused. Budgets above `BUDGET_WARN_DAILY` (default ₹10,000 a day) or more than 3 times the plan's usual budget are warnings.
- "Launch now" and "Schedule" for batches: ads are still created paused; once every ad is in, a confirmed plan turns on the ads, their ad sets and the campaign (ads first, campaign last). The summary lists other ad sets that start spending when the campaign is turned on. Scheduling uses the worker's queue (a third worker lane for plans, so a 9:00 plan never waits behind a long launch). Rejected: Meta's `start_time`, which can't be changed on ad sets that already ran.
- Same ads into several ad sets: one sibling batch per extra ad set, cloned and checked before anything is queued. Media is uploaded once (by checksum). Shared upload files are kept until every sibling is done.
- Plan copies are first named "<original> [P:plan.step.item]" and renamed after, so a crash in the middle of 100 copies resumes without duplicates.
- Results: Meta's API can't edit Ads Manager's column presets or custom metrics, so column sets and formulas live in the launcher (tables `column_sets`, `custom_metrics`). Formulas are parsed by a small parser (numbers, metric names, + - * / and brackets), never `eval`.
- Default UTM tags for new copy templates use Meta's own URL parameters ({{campaign.name}}, {{adset.name}}, {{ad.name}}, {{ad.id}}), which Meta fills in per ad.

