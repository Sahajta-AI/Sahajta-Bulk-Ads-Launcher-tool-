# Blockers

What still needs a person or a real account, and the exact step to unblock it. Steps refer to `docs/SETUP.md`.

## What was proven, and how

Nothing here ran against the real Meta, Google or Oracle accounts: the project had no `.env` and no credentials. Everything below ran against a fake Graph API (`src/lib/meta/mock.ts`). The fake enforces the 60-point tier (read 1, write 3, 5-minute decay, 5-minute block), Meta's v26 behaviour (`GET /?ids=` refused, `reset_time_duration`), idempotency keys, and it throws if any ad, ad set or copy is not PAUSED.

| Claim | Proof |
|---|---|
| 15 files (5 video pairs + 5 images) → 9 ads, correctly grouped and named, paused, all enhancements off, multi-advertiser off | `tests/launch.test.ts` "groups, names, and launches"; also clicked through in the browser (practice mode) and run through the CLI inside the production Docker image. |
| Ratio from real pixels, not names | `testimonial_story.jpg` / `testimonial_feed.jpg` paired by measured 9:16 and 4:5; unit tests for EXIF and rotation-free cases. |
| Killed halfway → retry → zero duplicates | Test: crash right after Meta creates the 5th ad and before the ID is saved → resume → 9 ads, 9 keys. Real process: `kill -9` of the CLI after 4 of 9 ads, then `--resume` → 9 ads, 9 unique keys, 9 creatives, 10 videos (none uploaded twice). |
| Timeouts after a create don't duplicate | Tests: creative and ad creates that time out after Meta saved them are adopted, not repeated. |
| Retry failed only | Test: one ad fails with Meta's plain message, retry creates only that ad, reuses its creative. |
| New ad set per ad | Test: crash between copy and rename → 9 ad sets, each named by the template with its key, paused. |
| Rate limits only slow a batch | Tests: Limited tier → 0 refusals, simulated time 20.0 min vs estimate "about 20 minutes"; a cap lower than assumed (30) → finishes, < 5 refusals; 9,000-point tier → learned automatically, < 10 min. |
| Same launch from Claude | Bundled `.mcpb` server over stdio: list tools, list destinations/templates, preview (table + warnings + estimate + link), refusal without `confirm`, refusal until warnings accepted, launch. `/api/mcp` over HTTP inside Docker: tools/list, batch_status, 401 without key. |
| Server rebuild | Docker image builds on Arm64 (same as Oracle A1); app + worker start healthy; backup writes a `.db.gz`. Not run on an Oracle machine (see below). |

## 1. Meta (blocks every real-account test)

**Done (10–11 Nov 2026):** Meta app "Sahajta Ads Launcher" in the verified Sahajta AI business; Facebook Login for Business set up (redirect `https://launcher.sahajta.com/api/meta/callback`, a business-login and a personal-login configuration); `pages_manage_ads` added; the marketer invited as a Tester. Connect Meta is built into the app and tested in practice mode.
**Done (15 Nov 2026):** `META_APP_SECRET` is in the server `.env`; Basic settings saved (privacy, terms, app domain `launcher.sahajta.com`, category); the app is **Published (Live)**.
**Not saved:** the "Data deletion instructions URL". Meta answers "should represent a valid URL" for any link in that box, even the privacy page that it accepts one field above, and even though its crawler fetches the page with status 200. Meta did not require it to publish. Try again later; if Meta starts requiring it, the alternative is a data-deletion callback endpoint.
**Left:**
- The marketer: accept the Tester invite at https://developers.facebook.com/requests/, then Settings → Meta connection → Connect Meta (M6).
- Switched to the personal login (16 Nov 2026): The marketer's ad account sits in the agency's portfolio, where they have ad-account access but not full control, so the business login never showed it. Not proven yet: the personal login with that agency ad account (first real connect). Possible snag: Meta's standard access may not cover ad accounts of other businesses (App Review for advanced `ads_management`); the first connect and a 2-ad test will show it. The token lasts 60 days; Settings shows when to reconnect.
- Leftover from the first setup: the system user `ads-launcher` has full control of the app but no ad account or Page. Unused unless someone pastes a token from it; it can stay.

**Ad account from an agency.** The agency shares its ad account with the Sahajta AI business or with the marketer's Facebook account, with full control; then it appears in the Connect Meta list. Risk: Meta's docs say an app "managing other people's ad accounts" needs advanced access to `ads_management` (App Review). With the marketer as a Tester on the app this is probably not needed; the first `validate_only` check in M7 shows it without creating anything.
**Also open:** which Page and Instagram account the ads run from. The marketer picks them when connecting.

## 2. Placement + 5 texts in one ad (needs a live test)

Meta documents the pattern only for an image in an app campaign. The launcher sends the video version for traffic. `scripts/real-test.ts` checks it first with `validate_only`.
**If the check fails:** the script then checks fallback 2 (the same pair with one text and one headline). If that passes, it writes the decision into `docs/LIVE-TEST-RESULTS.md`: add `META_PAC_TEXTS=first` to `.env` and restart. Paired ads then use the first text and headline (the preview warns per ad); single-file ads keep all 5. If both fail, the next fallbacks are in `docs/META-API-NOTES.md` §5.2.

## 3. Other Meta behaviour to confirm in the first real run

All are handled with a fallback in code, but unproven:
- `video_ads` resumable upload with a **system-user** token (fallback: chunked `/advideos`, automatic).
- Whether rupload calls count against the 60 points (the estimate assumes not).
- Name filter `CONTAIN` on `/adcreatives` (fallback: list and match, automatic).
- `X-Client-Idempotent-Key` active for our app (the name-key lookups work without it).
- `video_data` needing a thumbnail (we always send Meta's own or an ffmpeg frame).
- Header tier strings after Meta's May 2026 rename (we go by the numbers, not the label).
- Music: Meta has no `creative_features_spec` key for it. Unknown whether Meta adds music by default. Check one video ad in Ads Manager after M8.
- Which Advantage+ features Meta switches on by default for our account: shown as warnings after each creative; read them after M8.

## 4. Google: confirm every user is on Workspace

The build assumes every user has a Google Workspace account on the company domain (Internal consent screen, `drive.readonly`, no token expiry).
**Unblock:** check each user's sign-in email. If it is on the company domain: do SETUP G2–G4.
If it is not: the Internal consent screen will refuse him. Options: (a) give them a company Workspace account (simplest), or (b) build the Google Picker with `drive.file` scope and an External consent screen, published to Production (Testing mode expires tokens every 7 days). (b) is not built.

## 5. Google OAuth client (blocks sign-in on the server)

**Unblock:** SETUP G2–G4, put `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` in `.env`. Drive import code (`src/lib/sources/drive.ts`) is written but **never ran against Google**; the first real test is pasting a Drive folder link after sign-in.

## 6. Oracle machine, DNS and code on the server

**Done (15 Nov 2026):** temporary server `ads-launcher-temp` (AMD, trial credits, see DECISIONS → Hosting), ports 80/443 open, DNS `launcher.sahajta.com` → the server's public IP (GoDaddy), Google sign-in client in Google Cloud project `sahajta-ads-launcher`, secrets in `.env`, code copied with `git archive`.
**Left:** move to the free Arm machine when `~/.oci/arm-retry.sh` gets one, before the trial ends (about 1 Dec 2026): bootstrap it (O4–O5), restore the latest backup, change the GoDaddy `ads` record to the new IP, then delete `ads-launcher-temp`. Backups (O6) are not set up yet, so copy the database by hand for that move.
**Not proven:** the "under 15 minutes" rebuild on an Oracle 1 OCPU machine. On an Apple-silicon laptop a clean image build took the time shown in "Build timing" below; a 1-OCPU Ampere core is slower. Time the first bootstrap and note it here.

## 7. Oracle idle reclaim

Measured memory (Docker, idle): app 124 MB, worker 138 MB (+ Caddy and Ubuntu). On 4 GB that is ~13%: the machine could be reclaimed when idle. SETUP O1 therefore says **2 GB** (~27%).
**Unblock:** after one week, open the instance's Metrics → Memory utilization. If the 95th percentile is under 20%, lower the memory or tell the maintainer.

## 8. Claude Team plan: allow desktop extensions

**Unblock:** SETUP C1 (admin setting). Then C2 for the marketer. The exact label of the admin setting was not checked.

## 9. Backups to Object Storage

**Unblock:** SETUP O6 (bucket, lifecycle rule, write-only pre-authenticated request URL in `BACKUP_PAR_URL`). Without it, backups stay on the server's disk only.

## Build timing

Clean Docker image build (no cache) on an Apple-silicon laptop, Arm64: **69 seconds** (apt 22 s, npm ci 16 s, Next build 4 s, image export 11 s). An Oracle A1 machine with 1 OCPU is several times slower; expect about 6–10 minutes for the image plus 2–3 minutes for Docker and system packages. Not yet timed on Oracle.
