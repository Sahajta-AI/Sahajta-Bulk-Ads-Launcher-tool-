# How to use the Sahajta Ads Launcher

The launcher puts a folder of images and videos into Meta as ads, in one go. Every ad is created **paused**. Nothing goes live until you switch it on yourself in Ads Manager.

Open **https://launcher.sahajta.com** and sign in with your Sahajta Google account.

## First time only: connect Meta (about 2 minutes)

1. **Accept the invite.** Open https://developers.facebook.com/requests/ while logged in to Facebook and accept "Sahajta Ads Launcher". If Facebook asks you to register as a developer first, click **Get started** and finish it (free, about a minute).
2. **If the ads run from an agency's ad account:** your own Facebook profile must be able to open that ad account in Ads Manager (the agency adds you to it). The agency does not need to share its business portfolio.
3. In the launcher: **Settings → Meta connection → Connect Meta**. Facebook opens.
4. Log in with your own Facebook profile and approve the permissions. Keep every permission ticked. Facebook does not ask for a business portfolio.
5. Back in the launcher, pick the **ad account**, **Facebook Page** and **Instagram account**, then press **Save**.

The page then shows **Connected**, and the date the connection runs out (60 days later). Before that date, click **Reconnect Meta**. To use a different ad account later (for example when the agency account arrives), press **Change ad account or Page**, or **Reconnect Meta** if it is not in the list. Your copy templates, naming templates and presets come with you.

If the Facebook login can't see your ad account, open **Paste a token instead** on the same page and follow the steps there.

## Launch a batch

1. **Pick the files.** Paste a Google Drive folder link and press **Use this folder**. Or press **Upload files** and drag files or whole folders in. Big videos keep uploading if your internet drops.
2. **Check the grouping.** Versions of the same creative become one ad. Example: `hook-01_9x16.mp4` and `hook-01_4x5.mp4` become one ad. The 9:16 file shows in Stories and Reels. The 4:5 (or 1:1) file shows in Feed. The tool measures the real size of each file, so the file name does not have to be perfect.
   - Wrong pairing? Drag a file onto another ad, or onto **Drop a file here to make it a separate ad**.
   - The × on a file takes it out of the batch.
3. **Where they go.** Pick the campaign and the ad set. Tick **One new ad set per ad** if you want each ad in its own new ad set, copied from the ad set you picked (same budget, audience and placements, paused).
   - Ad sets with Dynamic creative switched on can't be used. The tool tells you so.
   - If the ad set you copy has a minimum spend that is higher than a campaign budget, Meta refuses a plain copy. The tool then builds each new ad set from the same settings, without the spend limits.
4. **Copy.** Pick a saved copy template (up to 5 primary texts and 5 headlines; Meta rotates them). To change the copy for one ad only, use **Change copy for this ad** in the preview table.
   - Every ad has its own copy? Open **Paste it from a sheet**, copy the rows from Google Sheets (with the header row: `ad`, `primary_text_1`…`5`, `headline_1`…`5`, `description`, `link`, `cta`) and press **Save copy per ad**.
   - New copy templates add UTM tags to every link, so analytics and the CRM show which campaign, ad set and ad brought each lead.
5. **Names.** Pick a naming template. Type an angle (`{angle}`) and a persona (`{persona}`) if the template uses them. You see the first ad's name right away.
   - Every name ends with a code like `[L:k4r94-03]`. Leave it in Ads Manager: it is how the tool makes sure nothing is ever created twice.
6. **Meta settings.** Pick a preset. The default uses the Page and Instagram account you picked when you connected Meta, with every AI enhancement **off** and multi-advertiser ads **off**.
7. **Preview.** Read the table. Press **Check landing pages** to make sure every link opens.
   - Red items are **errors**: fix them first (the message says how).
   - Orange items are **warnings**: tick **I read the warnings** if you are fine with them.
8. **Launch and summary.** Choose **Create paused**, **Launch now** (turned on once every ad is in) or **Schedule** (turned on at a date and time). To put the same ads into more ad sets, tick them under **Also put the same ads into more ad sets**.
   - Read the **Summary**: ad account, Facebook Page and Instagram account (with photo, ID and link), campaign, every ad set's budget, bid, schedule, audience and placements, the **total daily budget**, copy and link.
9. Press **Launch**. When the ads will be turned on, type the total daily budget from the summary first: nothing goes live without this. The bar shows the time it will take, for example "about 20 minutes". Meta limits how fast a new app may create ads, so a big batch takes a while. You can close the page; the launch carries on. **Stop the launch** stops it after the current step; ads already created stay paused.

## After the launch

- Each ad shows **Created** with an **Open in Ads Manager** link, and Meta's review status: **In Meta review**, **Approved, paused**, **Rejected by Meta** or **Has issues** (with Meta's reason).
- The tool checks the review status again by itself for 24 hours. Press **Check Meta review status now** for a fresh look.
- Paused ads: review them in Ads Manager and switch them on there, or under **Campaigns** in the launcher.
- If some ads failed, the reason is written in plain words. Fix the cause, then press **Retry the failed ads only**. Ads that went through are never touched or doubled.
- If the message says the Meta connection expired or lacks permission: **Settings → Meta connection → Reconnect Meta**, then retry.
- If you see a warning that Meta switched on an AI enhancement, check that ad in Ads Manager and tell your admin.

## Campaigns and ad sets

**Campaigns** lists every campaign with its ad sets, budgets and settings. From there you can create, copy and edit campaigns and ad sets, turn a whole campaign on or off in one go, make ads from an existing post (likes and comments stay on that one post), and paste a table from Google Sheets to create or change many ad sets at once.

Every change becomes a **plan** first. The plan page shows the summary: each step, every budget, the total daily budget, what turns on, and warnings for budgets that look too high. Nothing changes in Meta until you press **Run the plan**. A plan that turns anything on asks you to type the total daily budget. A plan can run at a set time, and can be cancelled until it runs. Nothing can be deleted: turn things off instead.

## Results

**Results** shows spend, impressions, clicks, leads, cost per lead and any other Meta metric, per campaign, ad set or ad, for any dates, split by age, gender, placement, region or day. **Edit columns** saves sets of columns, like Ads Manager's presets. **Custom metrics** are your own formulas, for example *Cost per site visit = spend / actions:offsite_conversion.fb_pixel_custom*.

## History

**History** lists every batch: what launched, what failed and why. Open a batch to see its ads or retry failed ones.

## Settings

- **Meta connection:** which ad account, Page and Instagram account the launcher uses; connect, change or reconnect.
- **Copy templates:** texts, headlines, description, button, landing page, UTM.
- **Naming templates:** for ads, new ad sets and new campaigns, such as `{date}_{creative}_{angle}_{format}` or `{date}_{persona}_{budget}_{n}`, with a live preview.
- **Meta settings presets:** Page and Instagram account (with photo, ID and link), each AI enhancement on or off, multi-advertiser ads. An Instagram account that the ad account may not use is marked: Meta would refuse every ad with it.
- **Claude connection:** create your key for Claude (see below).

## Use it from Claude

1. In the launcher: **Settings → Claude connection → Create a key**. Copy the key.
2. **Claude Desktop:** download **sahajta-ads.mcpb** from the same page and double-click it. Paste the key when Claude asks.
3. Then ask Claude, for example: *"Launch the reels in this Drive folder into the November test ad set with the site-visit copy."* or *"Make 15 ad sets in a new leads campaign, budgets ₹500 to ₹1,500, these 3 ads in each."* or *"Show me cost per lead by ad set for the last 7 days."* Claude first shows which ad account, Page and Instagram account it uses and the full summary with every budget and the total, and asks before anything runs. To turn anything on, you tell Claude the total daily budget yourself.

If something looks wrong, open the batch in the launcher (Claude gives you the link) and fix it there.

---
