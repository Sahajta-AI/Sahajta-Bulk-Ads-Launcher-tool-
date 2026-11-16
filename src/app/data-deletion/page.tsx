import type { Metadata } from "next";
import LegalPage, { CONTACT } from "../LegalPage";

export const metadata: Metadata = { title: "Data deletion · Sahajta Ads Launcher" };

export default function DataDeletion() {
  return (
    <LegalPage title="Delete your data">
      <h2>Ask us to delete it</h2>
      <ol>
        <li>
          Email <a href={`mailto:${CONTACT}?subject=Delete%20my%20launcher%20data`}>{CONTACT}</a> from the Google account you use with the launcher.
          Subject: &quot;Delete my launcher data&quot;.
        </li>
        <li>
          Within 30 days we delete your account record, your Claude connection keys and your saved Google access, and reply to confirm. Backups
          that still hold this data are deleted automatically after 30 days.
        </li>
      </ol>

      <h2>Remove Google access yourself</h2>
      <p>
        Open <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>, choose Sahajta Ads Launcher, and click Remove
        access. The launcher can then no longer read your Drive.
      </p>

      <h2>Ads in Meta</h2>
      <p>Ads the launcher created belong to Sahajta AI&apos;s ad account. To remove them, delete them in Meta Ads Manager.</p>
    </LegalPage>
  );
}
