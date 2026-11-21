# Meta Full access for the Sahajta Ads Launcher

For: the owner of the "Sahajta Ads Launcher" Meta app
Researched: 21 Nov 2026, from Meta's official developer docs and Meta's developer blog. Each rule has a source tag, for example [S1]. The full links are in "Sources" at the end. Items marked **not confirmed** have no official source.

---

## 1. Summary

1. Apply for one thing only: **Full access** on the **Marketing API Access Tier** feature. Its old name was "Ads Management Standard Access". This feature alone sets our speed limits. [S1] [S2] [S4]
2. Today we are on **Limited access**: 60 points per 5 minutes (a read costs 1 point, a write costs 3) and 300 `ads_management` calls per hour per ad account. Full access gives 9,000 points per 5 minutes and 100,000 calls per hour. [S2]
3. Meta lets us apply when the app has **500 or more successful Marketing API calls in the last 15 days** and **fewer than 15% errors in the last 500 calls**. The App Dashboard shows our progress against both numbers. [S1] [S4]
4. We do **not** need Advanced Access for the six permissions while every person who connects Meta has a role on the app (today: one marketer, as Tester). Business Verification is already done for Sahajta AI. [S5] [S7] [S12]
5. Meta usually decides in less than a week, often in 2 to 3 days. No code change is needed: the launcher reads the new limit from Meta's replies and speeds up by itself. [S10] [S1]

---

## 2. Words used in this file

- **Marketing API Access Tier**: a "feature" of our Meta app. It has two levels. **Limited access** is the default level. **Full access** is the higher level. Meta renamed these on 4 May 2026: "Standard Access" became Limited access and "Advanced Access" became Full access. [S4]
- **Standard access and Advanced access (for permissions)**: this is a different thing with similar names. With standard access, only people who have a role on the app can give the app a permission. With advanced access, anyone can. Advanced access needs App Review. [S5]
- **Role**: Admin, Developer or Tester on the app. People with a role in the business portfolio that owns the app count too. [S7]
- **App Review**: the form in the App Dashboard where we ask Meta for a higher level. Meta reads it and says yes or no. [S7]
- **Header value**: Meta adds a line to each reply. `development_access` means Limited access. `standard_access` means Full access. Yes, the names are confusing. [S2]

---

## 3. What to apply for, and what not

| Item | Apply now? | Why | Source |
|---|---|---|---|
| Marketing API Access Tier → **Full access** | **Yes** | It sets the rate limits, the system-user count (1 → 10) and Business Manager API access. | [S1] [S3] |
| Advanced access for `ads_management`, `ads_read`, `business_management`, `pages_show_list`, `pages_read_engagement`, `pages_manage_ads` | **No, not now** | If only people with a role on the app use it, standard access is enough. We need advanced access only when people without a role must connect, for example a client's own staff. | [S5] [S7] |
| `instagram_basic` | **No** | The launcher does not ask for it (`src/lib/meta/connect.ts`: Instagram accounts come through the ad account). Meta says asking for permissions you do not need is a common reason for rejection. | [S6] |
| Business Verification | Already done | Advanced access and App Review need a verified business. Sahajta AI is verified (`docs/SETUP.md`, step M1). Check that the app is connected to it (step 6.2). | [S5] [S8] [S12] |
| Access Verification / Tech Provider | **No** | Meta retired Access Verification in Oct 2026. It never covered ads permissions. | [S16] |
| Data handling questions | Probably yes, inside the form | Meta asks them of apps that are Live with a use case or that ask for advanced access. Our app is Live. | [S13] |
| Data Use Checkup | Yes, once a year, later | It is required for apps that are Live with a use case. Meta sends a notice. | [S14] |

**One risk to know.** The Marketing API "Authorization" page says: "If your app is managing other people's ad accounts, you need advanced access to the `ads_read` and/or `ads_management` permissions." [S1] Our marketer works on ad accounts that Sahajta AI runs for clients, through their own Facebook login, and they have a role on the app. The general rule in [S5] and [S7] says that is enough, and launches work today. But a reviewer may read that sentence differently and ask for advanced access on `ads_management` and `ads_read`. If that happens, use the texts in section 7.4 and the screencast in section 8. **Not confirmed** which way Meta reads it.

---

## 4. The eligibility rules

| Rule | Value | Source |
|---|---|---|
| Successful Marketing API calls | **500 or more in the last 15 days** (was 1,500 before 4 May 2026) | [S1] [S2] [S4] |
| Error rate | **Less than 15%, over the last 500 calls** (a rolling window, not a fixed time period) | [S1] [S4] |
| Screen recording for this feature | **No longer required** (since 4 May 2026) | [S4] |
| Business Verification | Required to finish App Review | [S8] |

**Where the dashboard shows it**
- App Dashboard → **App Review → Permissions and Features**. Your current level shows there. Since 4 May 2026 the two requirements and your progress also show there. [S1] [S4]
- In the newer dashboard layout: left menu **Use cases** → **Create & manage ads with Marketing API** → **Customize**. The feature has an **Actions** button with **Request higher limit**. The page may still show the old name "Ads Management Standard Access". [S15]
- The Marketing API use case **Settings** page shows the "Ads API access level". [S15]
- The launcher shows it too: **Settings → Status → Meta speed limit**. Today it says "Limited access (60 points per 5 minutes)".

**What Meta did not say**
- What counts as an "error". Meta's pages do not define it. **Not confirmed** whether rate-limit refusals (codes 17, 613, 80000) count.
- Whether Meta removes Full access later if we drop below 500 calls in 15 days. The Authorization page lists the same two numbers as what you must do "to maintain your status" for advanced access, and says they also apply to the tier upgrade. [S1] **Not confirmed** how Meta applies this to Full access.

**How we reach 500 calls**
- Our own estimate, not a Meta number: the 15-ad launch hit the 300-calls-per-hour limit for about an hour, so one such launch is roughly 300 calls. Two normal launches plus daily use of Campaigns and Results within 15 days should pass 500.
- Do not guess. Read the counter in the dashboard before you apply.
- To keep errors low: avoid many quick retries of the same failed launch. Fix the cause first, then use **Retry the failed ads only**.

---

## 5. Checklist before you submit

Tick each line before you press Submit.

- [ ] **Business verified and connected.** App settings → Basic → Verification shows "connected to a verified business" (Sahajta AI). [S12]
- [ ] **App is Live.** Done on 15 Nov 2026 (`docs/SETUP.md`, step M2).
- [ ] **App icon** is 1024 × 1024 and has no Meta logo. We use `docs/meta-app-icon.png`. [S9]
- [ ] **Privacy Policy URL** `https://launcher.sahajta.com/privacy` opens without sign-in. The page exists (`src/app/privacy/page.tsx`), but its text is out of date. See "What is missing" below. Meta shows this link to people on the Facebook login screen. [S9]
- [ ] **Terms of Service URL** `https://launcher.sahajta.com/terms` opens. The page exists (`src/app/terms/page.tsx`), but it is out of date too.
- [ ] **User data deletion URL** `https://launcher.sahajta.com/data-deletion` is saved in App settings → Basic. The page exists (`src/app/data-deletion/page.tsx`), but **it is not saved in Meta**: on 15 Nov 2026 Meta refused the link and published the app without it (`docs/SETUP.md`, step M2). Meta lists "User data deletion" as a required setting to publish. [S15] Try to save it again now that the site works on HTTPS.
- [ ] **Category** is "Business and pages". **Primary contact** email is one you read: Meta sends the decision there. [S9]
- [ ] **App purpose** is "Yourself or your own business". Meta says to choose this when only people with a role on the app (or in the business that owns it) use it. [S9]
- [ ] **500+ calls and under 15% errors** both show as met in the dashboard. [S1] [S4]
- [ ] **Reviewer access ready**, in case the form asks how to test. The launcher only lets in approved Google Workspace accounts. If needed, make a separate Google account just for the Meta reviewer, add it to the launcher's allow list, and delete it after the decision. Never give your own Facebook login: Meta says not to. [S9]
- [ ] **Screencast recorded** as a backup (section 8). Meta's blog says this feature no longer needs one [S4], but Meta's submission guide (updated 30 Jun 2026) still says a request without a recording is not approved [S9]. Having it ready costs 30 minutes.
- [ ] Only for advanced access requests (not now): at least one successful call with each requested permission in the last 30 days. [S9]

**What is missing in our legal pages** (fix before you submit; Meta reviewers check them)
1. Privacy and Terms say the launcher works only in "Sahajta AI's own Meta ad account". Since 16 Nov 2026 it uses a personal Facebook login and works on ad accounts Sahajta AI manages for clients. Say that.
2. Privacy does not list the Meta data we keep: the person's Facebook name and ID, the Meta access token (stored encrypted), the ad accounts, Pages and Instagram accounts they can use, campaigns, ad sets, ads and their results, and Page posts picked for ads.
3. Privacy says "It does not collect data about the people who see or click the ads". The Audiences tool sends customer lists to Meta hashed and keeps the hashes. Say so.
4. Privacy does not say that ad data goes to Anthropic (Claude) when a team member uses the Claude connection, or to Gmail in failure emails.
5. Terms say every ad "is created paused" and must be switched on in Ads Manager. The launcher can now turn ads on (Launch now, Schedule, plans), always after the person types the total daily budget. Say that.
6. The data deletion page does not say how to remove the Meta connection. Add: Settings → Meta connection → **Disconnect** deletes the saved token, and the person can also remove the app in their Facebook settings.

---

## 6. Steps in the App Dashboard

Click path for the whole job: check counter → fix settings → request upgrade → answer questions → submit → wait.

**6.1 Open the app**
1. Go to https://developers.facebook.com/apps.
2. Click **Sahajta Ads Launcher**. Do not open the WhatsApp app ("Sahajta Site Visit Engine").

**6.2 Check verification**
3. Click **App settings → Basic**. Scroll to **Verification**. It must say the app is connected to a verified business. [S12]
4. If it does not, click **Start Verification** and choose the Sahajta AI business. [S12]

**6.3 Fix the basic settings**
5. Still in **App settings → Basic**, check: App icon, Privacy Policy URL, Terms of Service URL, User data deletion (Data deletion instructions URL), Category. [S9] [S15]
6. Click **Save changes**.

**6.4 Check that we qualify**
7. Click **App Review → Permissions and Features**. [S1]
8. Search for **Marketing API Access Tier**.
9. Read the two requirements and the progress next to them: "500+ Marketing API calls in the past 15 days" and "Error rate < 15% in the last 500 calls". [S4]
10. If either is not met, stop. Use the launcher normally for a few more days and check again.

If your dashboard shows **Use cases** in the left menu instead: **Use cases → Create & manage ads with Marketing API → Customize** → find the feature → **Actions → Request higher limit**. [S15]

**6.5 Request the upgrade**
11. Click **+Upgrade** on Marketing API Access Tier (or **Request higher limit**). [S1] [S15]
12. Do not add any other permission or feature. [S6]
13. Click **Continue the Request**. [S1]
14. A window shows your Business Verification status. It should say verified. Continue. [S8] [S9]
15. If Meta shows **data handling questions**, answer them with section 7.3. Meta checks the answers in about 30 seconds. [S9] [S13]

**6.6 Fill in the submission**
16. Left menu **App Review** (newer layout: **Review → App Review**) → click **Edit** on the open request. [S15]
17. **Complete App Settings**: confirm icon, Privacy Policy URL, App purpose ("Yourself or your own business"), category and primary contact. [S9]
18. **Complete App Verification** (if shown): Meta asks if people sign in to the app with a Meta login. Ours sign in with Google and then connect Meta with Facebook Login, so pick the answer that fits and explain it in the box. Confirm the platform (Website, `https://launcher.sahajta.com`) and paste section 7.2. [S9]
19. **Requested permissions and features** → click **Marketing API Access Tier** → paste section 7.1 into the description box. [S9] [S15]
20. If the form asks for a screen recording, upload the video from section 8. [S9]
21. Tick the box that you will use the data only for its allowed usage. [S15]

**6.7 Submit**
22. Click **Submit for Review**. Read and accept the **Platform Onboarding Terms**. [S9]
23. Do not change App settings → Basic or Advanced while Meta reviews: changes may need a new review. [S9] [S10]

---

## 7. Text to paste

Meta asks for a separate text for each permission or feature, and says not to copy and paste the same text. [S9] Each text below is different. Change the numbers if they change.

### 7.1 Marketing API Access Tier: how the app uses it and why it needs higher limits

> Sahajta Ads Launcher (https://launcher.sahajta.com) is an internal web tool of Sahajta AI. Our team uses it to create and manage Meta ads in the ad accounts we run for our clients. Only people with a role on this app use it (one marketer today), each with their own Facebook login.
>
> How it works: the marketer picks a folder of images and videos. The tool groups the files into ads, shows a full preview with every name, text, link and placement, and then creates the campaign, ad sets and ads through the Marketing API. Ads are created paused unless the marketer chooses to turn them on and types the total daily budget to confirm. The tool then reads each ad's review status. On the Campaigns page the marketer can change budgets and ad sets in bulk. Every change is first shown as a plan and runs only after the person confirms it. On the Results page the marketer reads spend, impressions, reach, clicks and leads per campaign, ad set and ad.
>
> Why we need Full access: on Limited access each ad account gets 60 points per 5 minutes and about 300 calls per hour. One ad needs several calls: upload the image or video, create the creative, create the ad, and read back its review status. A real launch of 15 ads took about one hour, mostly waiting for the limit to reset. Our marketers plan launches of 45 ads at a time, which would take about 3 hours. While a launch uses up the limit, the Campaigns and Results pages also have to wait. Full access lets a launch finish in minutes and keeps reporting usable.
>
> How we stay within limits: the tool reads the X-Ad-Account-Usage and X-Business-Use-Case-Usage headers on every response, slows down before the limit, waits for the reset time Meta gives, and retries a refused call only after that wait. Plans ask Meta to check the first change of each kind with validate_only before anything runs. A failed launch can be retried for the failed ads only, so successful ads are never created twice.

### 7.2 Test instructions (app verification)

> 1. Open https://launcher.sahajta.com and click "Sign in with Google". Use this test account: [reviewer Google account, created only for this review] / [password]. The launcher accepts only approved Google accounts.
> 2. The launcher is already connected to Meta. Open Settings → Meta connection to see the connected ad account, Facebook Page and Instagram account. Settings → Status shows the current Meta speed limit.
> 3. New batch: paste this Google Drive folder link: [link to a folder with 2–3 test images]. Press "Use this folder". Pick the campaign "TEST_launcher" and an ad set. Press Preview, then "Launch and summary", choose "Create paused", and press Launch. The progress bar shows each ad as it is created, with an "Open in Ads Manager" link.
> 4. Campaigns: open TEST_launcher, press Edit on a paused ad set, change the daily budget, and save. The plan page shows the change. Press "Run the plan".
> 5. Results: choose the last 7 days to see spend, impressions, reach and link clicks per campaign, ad set and ad.
> Everything in step 3 and 4 stays paused. Please do not turn anything on.

### 7.3 Data handling questions (check each answer with your own knowledge before you submit)

The questions come from Meta's preview page. [S13]

- **Do you have data processors or service providers that will have access to the Platform Data you get from Meta?** Yes.
  - **Oracle (Oracle Cloud Infrastructure)**: category "IT solutions and services, including cloud storage and processing". Country: India (India South, Hyderabad). This is our server and our backups.
  - **Google (Gmail API)**: category "IT solutions and services". Failure emails can contain ad names and Meta's error text. Country: list where Google processes Gmail data (**not confirmed**; check Google's page).
  - **Anthropic (Claude)**: only when a team member uses the Claude connection; ad data then passes through Claude. Category "IT solutions and services". Country: **not confirmed**; check Anthropic's page.
- **Who is responsible for the Platform Data (data controller)?** [Sahajta AI's registered legal name, exactly as on the business verification documents]. Country: India.
- **Have you given personal data to public authorities for national security requests in the past 12 months?** No (confirm this is true).
- **Which policies do you have for requests from public authorities?** Tick only what is true and written down. If Sahajta AI has no written policy yet, choose "None of the above", or write a one-page policy first and then tick what it covers.

### 7.4 Only if Meta asks for advanced access on permissions

Use these only if the reviewer or the form asks for advanced access, or later, when people without a role on the app (for example a client's staff) must connect. Each needs its own screen recording that shows the Facebook login and the feature. [S6] [S11]

**`ads_management`**
> Our marketers use the launcher to create and manage ads in the ad accounts Sahajta AI runs for its clients. With ads_management the launcher uploads images and videos to the ad account, creates campaigns, ad sets, creatives and ads (paused by default), changes budgets, names and on/off status after the person confirms a plan, builds custom and lookalike audiences, and reads each ad's review status and Meta's reasons for any rejection. Without it the tool cannot create or change any ad.

**`ads_read`**
> The Results page uses ads_read to pull insights for the selected ad account: spend, impressions, reach, link clicks, leads and cost per result, by campaign, ad set and ad, for any date range, with breakdowns by age, gender, placement, region and day. Marketers use it to decide which ads to keep, copy or turn off. The data is shown only to Sahajta AI team members who sign in to the launcher.

**`business_management`**
> When a marketer connects Meta, the launcher lists the ad accounts their Facebook profile can use, including ad accounts in a client's or agency's business portfolio, with the business name next to each, so they pick the right one. It also reads which Instagram accounts are assigned to that ad account. Without business_management the marketer cannot see ad accounts that sit in another business portfolio. This permission supports ads_management.

**`pages_show_list`**
> After the Facebook login, the launcher shows the marketer the list of Facebook Pages they manage, with name and picture, so they choose the Page that the ads will run for. The chosen Page is saved as the default for new ads. This permission is required by ads_management and business_management.

**`pages_read_engagement`**
> On the Campaigns page, "Ads from an existing post" reads the recent published posts of the chosen Page (text, date, link) so the marketer can pick a post and run it as an ad. Likes and comments then stay on that one post. This permission is required by ads_management.

**`pages_manage_ads`**
> The launcher creates the ads for the client's Facebook Page: each ad's creative becomes an ad post of that Page (not shown on the Page's timeline) with the marketer's text, link and button. The marketer then sees the paused ad on the Page in Ads Manager. Without pages_manage_ads the tool cannot create ads for the Page.

---

## 8. Screencast script (about 3 minutes)

Use it as the backup for 7.1, or for the permissions in 7.4.

**Before you record** (rules from Meta's guide [S9] [S11])
- Keep the app in English. Record at 1080p or better. Make the browser full screen. Set the screen width to 1440 or less.
- Make the mouse pointer bigger. Use the mouse, not the keyboard, where you can.
- No sound: reviewers do not listen. Add short text captions in the video instead.
- Start logged out of the launcher and of Facebook. Meta wants to see the whole login. [S11]
- Use only the paused campaign `TEST_launcher` and test images. Turn nothing on. Do not show tokens or the App secret.

| Time | What to show | Caption on screen |
|---|---|---|
| 0:00–0:15 | `launcher.sahajta.com` logged out → **Sign in with Google** → home page. | "Sahajta team member signs in to the launcher" |
| 0:15–0:50 | **Settings → Meta connection → Connect Meta** → Facebook login → the permission screen (ads_management, ads_read, business_management, Pages) → Continue → back in the launcher → pick ad account, Page and Instagram account → **Save** → **Settings → Status** shows **Meta speed limit: Limited access (60 points per 5 minutes)**. | "User grants the permissions with Facebook Login for Business" / "Picks the client ad account and Page" |
| 0:50–1:40 | **New batch** → paste the Drive folder link → **Use this folder** → files grouped into ads → pick campaign `TEST_launcher` and an ad set → copy template → **Preview** (table of names, texts, links) → **Launch and summary** → **Create paused** → **Launch**. | "Bulk creation through the Marketing API: ads are created paused" |
| 1:40–2:05 | Progress bar fills; each ad shows **Created** and **Open in Ads Manager**. Click one → Ads Manager shows the paused ad for the Page. | "Ads created successfully for the Page (paused)" |
| 2:05–2:40 | **Campaigns** → open `TEST_launcher` → **Edit** a paused ad set → change the daily budget → the plan page shows each step and the total → **Run the plan** → done. Optional: **Ads from an existing post** → **Find a post** shows the Page's posts. | "Every change is a plan the person confirms" / "Page posts read for ads" |
| 2:40–3:10 | **Results** → last 7 days → columns **Impressions**, **Reach**, **Amount spent**, **Link clicks**, by campaign, ad set and ad. | "Ad performance data shown in the app" |
| 3:10–3:20 | Back to **Settings → Status**. | "Today a 15-ad launch takes about 1 hour on Limited access" |

Meta asks the recording for `ads_management`, `ads_read` and `business_management` to show the login and the ad results (impressions, spend, clicks, reach). [S6] The Results scene covers that. For `pages_manage_ads` it asks to show an ad created for the Page; the Ads Manager scene covers that. [S6]

---

## 9. After you submit

**Where to see the status**
- App Dashboard → **App Review → Requests**, and **Alerts → Inbox**. Meta also emails the primary contact. [S10]

**How long**
- "Typically less than one week", "often only 2–3 days", longer at busy times. [S10] The submission guide says you should get a decision within a week. [S9]

**If Meta says yes**
- Nothing to change in the code. Meta says no code change is needed. [S1] The header value changes from `development_access` to `standard_access`. [S2]
- The launcher's **Settings → Status → Meta speed limit** should then say "Full access (about 9,000 points)".
- Run one real launch and write down the time. Our guess is minutes instead of an hour for 15 ads, and minutes instead of about 3 hours for 45 ads. This is **our estimate, not a Meta number**.

**What still limits us on Full access** [S2]
- 100 create or edit requests per second per ad account.
- One edit to the same object every 30 seconds.
- A budget change at most 4 times per hour per ad set.
- 190,000 insights calls per hour per ad account (plus 400 per active ad).
- File upload time and Meta's own video processing.

**If Meta says no**
- Read the reason in **App Review → Requests**. Fix the cause and submit again. Meta's blog invites apps that did not qualify before to try again. [S4]

**To keep it**
- Do the yearly **Data Use Checkup** when Meta asks. It is required for apps that are Live with a use case. [S14]
- Keep normal use going. Meta lists 500 calls in 15 days and under 15% errors as what you must do "to maintain your status". **Not confirmed** whether Meta checks this again for Full access. [S1]

**Later: when people without a role must connect**
- Then request advanced access for the six permissions (texts in 7.4, recordings as in section 8). Business Verification is required for that, and we already have it. [S5] [S12]

---

## 10. What I could not confirm

- What Meta counts as an "error" for the 15% rule, and whether rate-limit refusals count.
- Whether Meta removes Full access later if use drops below 500 calls in 15 days.
- Whether the form forces advanced access on `ads_management` or `ads_read` together with the tier upgrade. The feature needs "at a minimum" one of these permissions [S3], but Meta does not say at which access level.
- Whether a Meta reviewer will sign in and test the app for this feature, now that the screen recording is no longer needed for it. [S4] [S9]
- The exact menu names in our dashboard: Meta documents two layouts (App Review → Permissions and Features, and Use cases → Customize). [S1] [S15]
- The real speed on Full access. Measure it after approval.
- Countries where Google and Anthropic process data, for the data handling questions.

---

## Sources

All read on 21 Nov 2026. "Updated" is the date printed on the page.

- **[S1]** Marketing API, Authorization (updated 5 May 2026): https://developers.facebook.com/documentation/ads-commerce/marketing-api/get-started/authorization
- **[S2]** Marketing API, Rate Limiting (updated 19 Aug 2026): https://developers.facebook.com/documentation/ads-commerce/marketing-api/overview/rate-limiting
- **[S3]** Features Reference, "Marketing API Access Tier" (updated 20 Nov 2026): https://developers.facebook.com/docs/features-reference#marketing-api-access-tier
- **[S4]** Meta developer blog, "Update to Ads Management Standard Access: New Name, Revised Requirements, and More Transparency" (4 May 2026): https://developers.meta.com/blog/updates-to-ads-management-standard-access-feature/
- **[S5]** Graph API, Access Levels (updated 30 Jun 2026): https://developers.facebook.com/docs/graph-api/overview/access-levels
- **[S6]** Permissions Reference (updated 20 Nov 2026): https://developers.facebook.com/docs/permissions
- **[S7]** App Review overview: https://developers.facebook.com/docs/app-review
- **[S8]** App Review, "Complete your App Review submission": https://developers.facebook.com/documentation/resp-plat-initiatives/individual-processes/app-review/content
- **[S9]** App Review submission walkthrough (updated 30 Jun 2026): https://developers.facebook.com/documentation/resp-plat-initiatives/individual-processes/app-review/submission-guide
- **[S10]** App Review introduction (review time, status panels, re-review): https://developers.facebook.com/docs/resp-plat-initiatives/app-review/introduction
- **[S11]** App Review, Screen Recordings: https://developers.facebook.com/docs/app-review/submission-guide/screen-recordings
- **[S12]** Business Verification: https://developers.facebook.com/documentation/development/release/business-verification
- **[S13]** Data Handling Questions: https://developers.facebook.com/documentation/resp-plat-initiatives/individual-processes/data-handling-questions and the question list: https://developers.facebook.com/docs/development/release/data-handling-questions/questions-preview
- **[S14]** Data Use Checkup: https://developers.facebook.com/documentation/resp-plat-initiatives/individual-processes/data-use-checkup
- **[S15]** Marketing API Use Cases (newer dashboard layout, App Review and Publish steps): https://developers.facebook.com/documentation/development/create-an-app/marketing-api-use-cases
- **[S16]** Access Verification (retired): https://developers.facebook.com/documentation/development/release/access-verification

Related files in this repo: `docs/SETUP.md` (steps M1–M8), `docs/META-API-NOTES.md` (section 2, rate limits), `src/lib/meta/connect.ts` (the six permissions), `src/lib/meta/pacer.ts` (reads the tier from Meta's headers).

Read it fully once, 10-minute timer, before sending.
