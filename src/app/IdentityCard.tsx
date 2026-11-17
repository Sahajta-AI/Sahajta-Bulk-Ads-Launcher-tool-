// A Facebook Page or Instagram account shown so it can't be mistaken for one with a similar name:
// profile picture, name, ID and a link that opens it.

export default function IdentityCard({ kind, name, id, pictureUrl, link, warning }: { kind: "page" | "instagram"; name: string; id: string; pictureUrl?: string | null; link?: string | null; warning?: string | null }) {
  return (
    <div className="identity">
      {pictureUrl ? <img src={pictureUrl} alt="" width={36} height={36} referrerPolicy="no-referrer" /> : <span className="identity-blank">{kind === "page" ? "f" : "ig"}</span>}
      <div className="grow">
        <div><strong>{kind === "instagram" && !name.startsWith("@") ? `@${name}` : name}</strong></div>
        <small className="muted">
          {kind === "page" ? "Facebook Page" : "Instagram"} · ID {id}
          {link ? <> · <a href={link} target="_blank" rel="noreferrer">Open ↗</a></> : null}
        </small>
        {warning && <div className="identity-warn">{warning}</div>}
      </div>
    </div>
  );
}
