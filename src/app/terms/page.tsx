import type { Metadata } from "next";
import LegalPage, { CONTACT } from "../LegalPage";

export const metadata: Metadata = { title: "Terms · Sahajta Ads Launcher" };

export default function Terms() {
  return (
    <LegalPage title="Terms of service">
      <h2>Who can use it</h2>
      <p>
        Sahajta Ads Launcher is an internal tool of Sahajta AI. Only people Sahajta AI approves can use it, with their Sahajta Google account. It is
        not offered to the public.
      </p>

      <h2>What it does</h2>
      <p>
        It creates ads in Sahajta AI&apos;s own Meta ad account. Every ad and ad set is created <strong>paused</strong>. A person must check each ad
        in Meta Ads Manager and switch it on there.
      </p>

      <h2>Your responsibilities</h2>
      <ul>
        <li>Use the tool only for Sahajta AI&apos;s own ads.</li>
        <li>Follow Meta&apos;s Advertising Standards and the law for every ad you create.</li>
        <li>Keep your Claude connection key private. If you think someone else has it, delete it in Settings.</li>
      </ul>

      <h2>No warranty</h2>
      <p>
        The tool is provided as it is. Meta can refuse, change or stop ads. Always check your ads in Ads Manager before you switch them on.
      </p>

      <h2>Changes</h2>
      <p>We can change these terms. The date at the top shows the latest version.</p>

      <h2>Contact</h2>
      <p>
        Sahajta AI, <a href={`mailto:${CONTACT}`}>{CONTACT}</a>.
      </p>
    </LegalPage>
  );
}
