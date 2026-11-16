# Setup: the steps only a person can do

Do the steps in this order. Each step says where to click and what to copy. Keep every secret in your password manager. Do not paste secrets into chat, email or git.

You need about 2 hours in total. Meta's "Full access" comes later (step M8).

---

## M. Meta

The builder (the admin) does M1–M5 once. The person who uses the launcher (the marketer) then connects Meta inside the app (M6). Nobody copies tokens to the server.

### M1. The launcher's own Meta app — done 10 Nov 2026

"Sahajta Ads Launcher", in the verified Sahajta AI business, use case **Create & manage ads with Marketing API**, permission `pages_manage_ads` added. Do not use or change the WhatsApp app ("Sahajta Site Visit Engine").

### M2. Basic settings, then switch the app to Live (after the server is up)

An app in Development mode cannot create ads (Meta error 1885183). Live needs the privacy page, which the launcher serves, so do this after step O5.

1. developers.facebook.com → Sahajta Ads Launcher → **App settings → Basic**. Fill in:
   - App icon: `docs/meta-app-icon.png` (1024 × 1024 PNG).
   - Privacy Policy URL: `https://launcher.sahajta.com/privacy`
   - Terms of Service URL: `https://launcher.sahajta.com/terms`
   - User data deletion: **Data deletion instructions URL** `https://launcher.sahajta.com/data-deletion`
   - Category: **Business and pages**.
2. Save.
3. Left menu **Publish** (or the **App mode** switch at the top) → publish, so the app is Live. Meta checks that the links open.

Done on 15 Nov 2026, except the data-deletion link: Meta refused every link in that box ("should represent a valid URL") and published the app without it. Do not save these settings before the site answers on HTTPS: Meta remembers a failed check for a while. `src/app/robots.ts` lets Meta's checker read the three legal pages.

### M3. Facebook Login for Business — done 10 Nov 2026

- **Facebook Login for Business → Settings:** Valid OAuth Redirect URI `https://launcher.sahajta.com/api/meta/callback` (Strict mode and Enforce HTTPS on).
- **Configurations:**
  - "Launcher connect (personal)", **in use since 16 Nov 2026**: a personal Facebook login (user access token, 60 days). It lists every ad account the person's own Facebook profile can use, in any business portfolio, so an agency's ad account works without the agency sharing its portfolio. Permissions: `ads_management`, `ads_read`, `business_management`, `pages_manage_ads`, `pages_read_engagement`, `pages_show_list`.
  - "Launcher connect": business login (system-user token that never expires). Not used: Facebook only offers portfolios the person fully controls, so an ad account in an agency's portfolio never appears.

If the address changes, add the new `…/api/meta/callback` there.

### M4. App ID, App secret and login configuration on the server

In `.env` on the server (step O5):

- `META_APP_ID=` the App ID (App settings → Basic)
- `META_APP_SECRET=` the **App secret** from App settings → Basic (click Show; Meta asks for your password).
- `META_LOGIN_CONFIG_ID=` the ID of the personal-login configuration (Facebook Login for Business → Configurations)

Restart: `sudo docker compose up -d`.

### M5. Give each person who uses the launcher a role on the app

Until Meta's App Review, Facebook lets only people with a role on the app connect (Meta: "Permissions in standard access will only be requested from people with roles on this app").

1. developers.facebook.com → Sahajta Ads Launcher → **App roles → Roles → Add People** → **Tester** → their name → Add.
2. They accept the invite at https://developers.facebook.com/requests/ (they may first need to click "Get started" to register as a Meta developer; it is free).

### M6. Connect Meta (the person who uses the launcher)

In the app: **Settings → Meta connection → Connect Meta** → Facebook login → tick the business, the ad account (for example the agency's) and the Page → back in the app, pick the ad account, Page and Instagram account → Save. Details for the user are in `HOW-TO-USE.md`.

If an agency owns the ad account: the agency shares it with the Sahajta AI business (its Business ID is in Business Settings → Business info) or with the person's Facebook account, with full control, before this step.

If the Facebook login can't see the ad account, use **Paste a token instead** on the same screen (a system-user token from Business Settings → System users, made for the Sahajta Ads Launcher app with the permissions in M3).

### M7. Run the real-account test

After M6. This creates only PAUSED objects named `TEST_…`, inside a paused campaign `TEST_launcher` (made if missing). It first asks Meta to check the hardest ad (9:16 + 4:5 video with 5 texts and 5 headlines) without creating it, then launches a small real batch, then deletes older `TEST_` ads (it keeps the last good batch for inspection).

```bash
cd ~/ads-launcher && sudo docker compose exec worker npx tsx scripts/real-test.ts
```

Read the result in `docs/LIVE-TEST-RESULTS.md` (inside the container: `sudo docker compose exec worker cat docs/LIVE-TEST-RESULTS.md`). If the first check fails, see `BLOCKERS.md` → "Placement + 5 texts".

### M8. Later: Full access and App Review

- **Full access (speed):** when the app has 500 successful Marketing API calls in 15 days and under 15% errors: App dashboard → **App Review → Permissions and features → Marketing API Access Tier → +Upgrade**. The launcher reads the new limit from Meta's headers and speeds up by itself.
- **App Review (other people):** only needed when people without a role on the app must connect. Not needed for the Sahajta team.

---

## G. Google sign-in and Drive

### G1. Check who is on Workspace

Everyone must sign in with a Google Workspace account on your company domain. **Check that each person who will use the launcher has one.** If someone does not, stop and read `BLOCKERS.md` → "Google: confirm every user is on Workspace".

### G2. Create the Google Cloud project

1. https://console.cloud.google.com → project picker → **New project** → `sahajta-ads-launcher` → Create.
2. **APIs & Services → Library → Google Drive API → Enable**.

### G3. OAuth consent screen

1. **APIs & Services → OAuth consent screen** (Google Auth Platform → Branding / Audience).
2. Audience / User type: **Internal**. (Internal = only sahajta.com accounts; no Google review, no 7-day token expiry.)
3. App name `Sahajta Ads Launcher`, support email: your own address.
4. Data access / Scopes: add `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile`, `.../auth/drive.readonly`.

### G4. OAuth client

1. **Clients → Create client → Web application**. Name `launcher`.
2. Authorized JavaScript origins: `https://launcher.sahajta.com`
3. Authorized redirect URIs: `https://launcher.sahajta.com/api/auth/callback/google`
4. Copy the **Client ID** and **Client secret** into `.env`: `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`.

---

## O. Oracle Cloud server (Always Free, Hyderabad)

Never upgrade the account to Pay As You Go.

### O1. Create the machine

1. Oracle Cloud console → **Compute → Instances → Create instance**.
2. Name `ads-launcher`. Region: **India South (Hyderabad)**.
3. Image: **Canonical Ubuntu 24.04** (aarch64).
4. Shape: **Ampere → VM.Standard.A1.Flex**, **1 OCPU, 2 GB memory** (not 4 GB: see "Idle reclaim" below).
5. Networking: create a new VCN with a public subnet; **Assign a public IPv4 address: Yes**.
6. SSH keys: upload your public key (`~/.ssh/id_ed25519.pub`).
7. Boot volume: 50 GB (free up to 200 GB in total).
8. Create. Copy the **public IP**.

If Oracle says "Out of capacity", try again later or pick another availability domain.

### O2. Open ports 80 and 443

1. Instance → **Subnet → Security list → Add ingress rules**:
   - Source `0.0.0.0/0`, TCP, destination port `80`.
   - Source `0.0.0.0/0`, TCP, destination port `443`.
2. The machine's own firewall is opened by the bootstrap script.

### O3. DNS (GoDaddy)

GoDaddy → `sahajta.com` → **DNS → Add record**: Type **A**, Name `ads`, Value = the public IP, TTL 600. Wait until `nslookup launcher.sahajta.com` shows the IP (usually minutes).

### O4. Put the code on the machine

The code must reach the server. Pick one:

- **Private GitHub repo (recommended):** push this repo to GitHub (private). On the server, create a read-only deploy key: `ssh-keygen -t ed25519 -f ~/.ssh/launcher_deploy -N ""`, add `~/.ssh/launcher_deploy.pub` to the repo (Settings → Deploy keys), then `GIT_SSH_COMMAND="ssh -i ~/.ssh/launcher_deploy" git clone git@github.com:<you>/<repo>.git ~/ads-launcher`.
- **Copy from your laptop:** `rsync -az --exclude node_modules --exclude .next --exclude data --exclude .env.local ./ ubuntu@<IP>:~/ads-launcher/`

### O5. Build and start

```bash
ssh ubuntu@<IP>
cd ~/ads-launcher && ./deploy/bootstrap.sh
```

The first run installs Docker, opens the firewall, creates `.env` with new random keys, and stops. Edit `.env` (`nano .env`) and fill in: `DOMAIN`, `APP_URL`, `ALLOWED_EMAILS`, `AUTH_GOOGLE_ID`. Keep `META_MOCK=0`. Put the secrets in with the helper, which does not show what you paste and keeps it out of the shell history:

```bash
./deploy/set-secret.sh AUTH_GOOGLE_SECRET META_APP_SECRET   # and BACKUP_PAR_URL after step O6
```

**Copy `APP_ENCRYPTION_KEY` into your password manager**: without it the saved Meta connection can't be read after a rebuild (people would have to connect again).

Run it again:

```bash
./deploy/bootstrap.sh
```

The build takes 5–8 minutes. Then open https://launcher.sahajta.com, sign in, do step M2 (Live), and ask the person who uses the launcher to do step M6.

To rebuild a fresh machine later: steps O1–O4, copy the old `.env` (from your password manager), then `RESTORE_FROM=<backup URL> ./deploy/bootstrap.sh`. Total: under 15 minutes.

### O6. Backups to Object Storage

1. Console → **Storage → Buckets → Create bucket** `ads-launcher-backups` (Standard, private).
2. Bucket → **Lifecycle policy rules → Create rule**: delete objects older than 30 days.
3. Bucket → **Pre-authenticated requests → Create**: target **Bucket**, access **Permit object writes**, expiry e.g. 2030-12-31. Copy the URL (ends with `/o/`) into `.env` as `BACKUP_PAR_URL`.
4. Restart: `sudo docker compose up -d`. Test: `sudo docker compose exec worker npx tsx scripts/backup.ts` → "Backed up".

The worker backs up after every batch and every night at about 02:00 IST. To restore: download a backup from the bucket (or make a read link for one object), then `./deploy/restore.sh <file or URL>` and `sudo docker compose up -d`.

### O7. Alert if the app stops

1. The bootstrap installs a cron job that restarts the app if `/api/health` fails twice in a row.
2. For an email alert, create a free https://uptimerobot.com account → **New monitor → HTTP(s)** → URL `https://launcher.sahajta.com/api/health`, every 5 minutes, alert to your own address.

### Idle reclaim

Oracle reclaims an Always Free machine when, over 7 days, CPU, network **and** memory use are all under 20% (95th percentile). The launcher is idle most of the time, so memory is the metric that keeps it alive. Measured in Docker: web app about 125 MB, worker about 140 MB, Caddy about 30 MB, plus Ubuntu about 250 MB: about 550 MB in total. That is about 27% of 2 GB, but only about 13% of 4 GB. So use **2 GB**. The bootstrap adds 2 GB of swap so the build still fits. Check the instance's **Metrics** page (memory utilization) after the first week. If it is under 20%, tell whoever maintains the tool. If Oracle reclaims the machine anyway, rebuild it with steps O1–O5 and `RESTORE_FROM`.

---

## C. Claude

### C1. Allow desktop extensions on the Claude Team plan

claude.ai → **Admin settings** (owner or admin) → **Claude Desktop / Extensions** → allow members to install desktop extensions (custom or unsigned `.mcpb` files). The exact label can differ; look for "Desktop extensions" or "Allow custom extensions".

### C2. Install for the marketer

1. The marketer signs in to the launcher → **Settings → Claude connection → Create a key**.
2. On the same page: download **sahajta-ads.mcpb**, double-click it, Claude Desktop opens an install screen, paste the key, leave the address as `https://launcher.sahajta.com`.

### C3. Claude Code (one line)

Replace `YOUR_KEY` with a key from Settings → Claude connection:

```bash
claude mcp add --transport http sahajta-ads https://launcher.sahajta.com/api/mcp --header "Authorization: Bearer YOUR_KEY"
```

---

## L. Run it on your laptop (practice mode)

Practice mode uses a fake Meta API. Nothing is sent to Meta. In the app, Settings → Meta connection → Connect Meta connects the fake account (Facebook does not open).

```bash
npm install
```

```bash
cp .env.example .env.local
```

In `.env.local` set `META_MOCK=1`, `DEV_LOGIN_EMAIL=you@yourcompany.com`, `ALLOWED_EMAILS=you@yourcompany.com`, `APP_ENCRYPTION_KEY=$(openssl rand -base64 32)`, `APP_URL=http://localhost:3000`. Then, in two terminals:

```bash
npm run dev
```

```bash
npx tsx --env-file=.env.local src/worker/index.ts
```

Tests:

```bash
npm test
```
