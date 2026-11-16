import type { Metadata } from "next";
import LegalPage, { CONTACT } from "../LegalPage";

export const metadata: Metadata = { title: "Privacy policy · Sahajta Ads Launcher" };

export default function Privacy() {
  return (
    <LegalPage title="Privacy policy">
      <h2>What this tool is</h2>
      <p>
        Sahajta Ads Launcher is an internal tool of Sahajta AI. Only Sahajta AI team members on an approved list can sign in. It creates ads in
        Sahajta AI&apos;s own Meta ad account, from images and videos the team picks. It is not offered to the public.
      </p>

      <h2>What data we use</h2>
      <ul>
        <li>
          <strong>Your Google account:</strong> your name and email address, to sign you in. We also ask for read-only access to Google Drive. The
          launcher only opens the Drive folders you paste into it, to read and download the images and videos in them. It never changes, shares or
          deletes your Drive files.
        </li>
        <li>
          <strong>Meta:</strong> the launcher uses Meta&apos;s Marketing API with Sahajta AI&apos;s own business access. It creates and reads
          campaigns, ad sets, ads, images and videos in Sahajta AI&apos;s ad account, and reads each ad&apos;s review status. It does not collect
          data about the people who see or click the ads.
        </li>
        <li>
          <strong>Your work in the tool:</strong> the files you upload or pick, the ad text and settings you enter, and a log of each launch (who
          launched it, when, and what Meta replied).
        </li>
      </ul>

      <h2>How we use it</h2>
      <p>
        Only to create and track Sahajta AI&apos;s own ads. We do not sell your data, share it with advertisers, or use it to build advertising
        profiles. We send data only to Meta (to create the ads) and Google (to sign you in and read the Drive folders you pick).
      </p>

      <h2>Where it is stored and how long</h2>
      <p>
        On Sahajta AI&apos;s server in India (Oracle Cloud, Hyderabad region). Access tokens are stored encrypted. Launch records and files stay
        until we delete them. Backups are deleted automatically after 30 days. The tool uses one cookie, to keep you signed in.
      </p>

      <h2>Your choices</h2>
      <p>
        To see or delete your data, email <a href={`mailto:${CONTACT}`}>{CONTACT}</a>. See <a href="/data-deletion">Data deletion</a> for the
        steps. You can remove the launcher&apos;s access to your Google account at any time at{" "}
        <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>.
      </p>

      <h2>Contact</h2>
      <p>
        Sahajta AI, <a href={`mailto:${CONTACT}`}>{CONTACT}</a>.
      </p>
    </LegalPage>
  );
}
