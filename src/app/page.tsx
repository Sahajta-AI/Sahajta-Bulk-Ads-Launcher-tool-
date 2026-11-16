import { requirePageUser } from "@/lib/page-auth";
import { listBatches } from "@/lib/service";
import { getAccount } from "@/lib/store";
import NewBatch from "./NewBatch";

export const dynamic = "force-dynamic";

export default async function Home() {
  await requirePageUser();
  const recent = listBatches(5);
  return (
    <>
      <h1>Launch ads</h1>
      <p className="lead">Start with a folder of images and videos. Versions of the same creative (9:16 and 4:5) become one ad. Every ad is created paused.</p>
      {!getAccount()?.token_enc && (
        <div className="msg warning" style={{ marginBottom: 20 }}>
          Meta isn&apos;t connected yet. <a href="/settings#meta">Connect Meta</a> first. It takes about a minute.
        </div>
      )}
      <NewBatch />
      {recent.length > 0 && (
        <>
          <p className="section-title">Recent batches</p>
          <div className="panel" style={{ padding: "4px 20px" }}>
            {recent.map((b) => (
              <a className="list-item" key={b.key} href={`/batches/${b.key}`} style={{ color: "inherit", textDecoration: "none" }}>
                <span className="grow">
                  {b.source} · {b.ads} ad{b.ads === 1 ? "" : "s"}
                  <small style={{ display: "block" }}>{b.destination.includes("?") ? "Not set up yet" : b.destination}</small>
                </span>
                <span className={`status ${b.status}`}>{b.statusLabel}</span>
              </a>
            ))}
          </div>
          <a href="/history" style={{ fontSize: 14 }}>See all batches →</a>
        </>
      )}
    </>
  );
}
