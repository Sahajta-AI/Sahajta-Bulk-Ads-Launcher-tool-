import { requirePageUser } from "@/lib/page-auth";
import { listBatches } from "@/lib/service";

export const dynamic = "force-dynamic";

export default async function History() {
  await requirePageUser();
  const batches = listBatches(200);
  return (
    <>
      <h1>History</h1>
      <p className="muted">Every batch: what launched, what failed and why. Open one to retry failed ads.</p>
      <div className="panel">
        {batches.length === 0 && <p className="muted">No batches yet.</p>}
        {batches.length > 0 && (
          <table>
            <thead>
              <tr><th>Batch</th><th>Status</th><th>Files from</th><th>Went to</th><th>Ads</th><th>By</th><th>Launched</th></tr>
            </thead>
            <tbody>
              {batches.map((b) => (
                <tr key={b.key}>
                  <td><a href={`/batches/${b.key}`}>{b.key}</a></td>
                  <td><span className={`status ${b.status}`}>{b.statusLabel}</span></td>
                  <td>{b.source}</td>
                  <td>{b.destination}</td>
                  <td>{b.done}/{b.ads}{b.failed ? <span style={{ color: "var(--err)" }}> · {b.failed} failed</span> : null}</td>
                  <td><small>{b.createdBy}</small></td>
                  <td><small>{b.launchedAt ? new Date(b.launchedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" }) : "Not launched"}</small></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
