// Public pages Meta needs for the app: privacy policy, terms, data deletion. No sign-in.

export const UPDATED = "10 November 2026";
// Set LEGAL_CONTACT_EMAIL on the server to the address people should write to.
export const CONTACT = process.env.LEGAL_CONTACT_EMAIL || "hello@sahajta.com";

export default function LegalPage({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="panel legal">
      <h1>{title}</h1>
      <p className="muted">Sahajta Ads Launcher, by Sahajta AI. Last updated {UPDATED}.</p>
      {children}
      <p className="muted" style={{ marginTop: 24 }}>
        <a href="/privacy">Privacy policy</a> · <a href="/terms">Terms</a> · <a href="/data-deletion">Data deletion</a> · Contact:{" "}
        <a href={`mailto:${CONTACT}`}>{CONTACT}</a>
      </p>
    </div>
  );
}
