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
4. **Copy.** Pick a saved copy template (up to 5 primary texts and 5 headlines; Meta rotates them). To change the copy for one ad only, use **Change copy for this ad** in the preview table.
5. **Names.** Pick a naming template. Type an angle if the template uses `{angle}`. You see the first ad's name right away.
   - Every name ends with a code like `[L:k4r94-03]`. Leave it in Ads Manager: it is how the tool makes sure nothing is ever created twice.
6. **Meta settings.** Pick a preset. The default uses the Page and Instagram account you picked when you connected Meta, with every AI enhancement **off** and multi-advertiser ads **off**.
7. **Preview.** Read the table. Press **Check landing pages** to make sure every link opens.
   - Red items are **errors**: fix them first (the message says how).
   - Orange items are **warnings**: tick **I read the warnings** if you are fine with them.
8. Press **Launch (paused)**. The bar shows the time it will take, for example "about 20 minutes". Meta limits how fast a new app may create ads, so a big batch takes a while. You can close the page; the launch carries on.

## After the launch

- Each ad shows **Created** with an **Open in Ads Manager** link, and Meta's review status: **In Meta review**, **Approved, paused**, **Rejected by Meta** or **Has issues** (with Meta's reason).
- The tool checks the review status again by itself for 24 hours. Press **Check Meta review status now** for a fresh look.
- Review the ads in Ads Manager and switch them on yourself.
- If some ads failed, the reason is written in plain words. Fix the cause, then press **Retry the failed ads only**. Ads that went through are never touched or doubled.
- If the message says the Meta connection expired or lacks permission: **Settings → Meta connection → Reconnect Meta**, then retry.
- If you see a warning that Meta switched on an AI enhancement, check that ad in Ads Manager and tell your admin.

## History

**History** lists every batch: what launched, what failed and why. Open a batch to see its ads or retry failed ones.

## Settings

- **Meta connection:** which ad account, Page and Instagram account the launcher uses; connect, change or reconnect.
- **Copy templates:** texts, headlines, description, button, landing page, UTM.
- **Naming templates:** patterns such as `{date}_{creative}_{angle}_{format}`, with a live preview.
- **Meta settings presets:** Page, Instagram account, AI enhancements, multi-advertiser ads.
- **Claude connection:** create your key for Claude (see below).

## Use it from Claude

1. In the launcher: **Settings → Claude connection → Create a key**. Copy the key.
2. **Claude Desktop:** download **sahajta-ads.mcpb** from the same page and double-click it. Paste the key when Claude asks.
3. Then ask Claude, for example: *"Launch the reels in this Drive folder into the November test ad set with the site-visit copy."* Claude shows you the preview first and asks before it launches. Ads are always created paused.

If something looks wrong, open the batch in the launcher (Claude gives you the link) and fix it there.

---
