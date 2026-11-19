import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Round 3, group INFRA3: the parts of the fixes the review2-infra probes don't reach.
// Real code on the practice Meta (mock) and a fake Gmail only.

vi.mock("@/auth", () => ({ auth: async () => null }));
vi.mock("@/lib/sources/drive", async (orig) => ({
  ...(await orig<typeof import("@/lib/sources/drive")>()),
  authFor: () => ({ getAccessToken: async () => ({ token: "fake-gmail-token" }) }),
}));

import { appLink, recentAlerts, sendAlert } from "@/lib/alerts";
import { db } from "@/lib/db";
import { LANES, claimNext, enqueue, goLiveStopped, requeueStale } from "@/lib/jobs";
import { cancelPlan, confirmPlan, createPlan } from "@/lib/manage/service";
import { FakeClock, MockMeta } from "@/lib/meta/mock";
import { upsertAccount } from "@/lib/setup";
import { runClaimed } from "@/worker/run";
import { freshDb } from "./helpers";

const WHO = "infra3@example.com";
process.env.ALLOWED_EMAILS = WHO;
const g = globalThis as unknown as { __mockMeta?: MockMeta };
let mock: MockMeta;
let sent: string[] = [];

beforeEach(() => {
  process.env.META_MOCK = "1";
  freshDb();
  mock = new MockMeta({ clock: new FakeClock(), capPoints: 9000, richAccount: true, allowActive: true });
  g.__mockMeta = mock;
  upsertAccount({ metaAccountId: "act_1001", name: "Practice", token: "mock-token" });
  db().prepare("INSERT INTO users (email, google_scope) VALUES (?, ?)").run(WHO, "openid https://www.googleapis.com/auth/gmail.send");
  sent = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    if (String(url).includes("gmail.googleapis.com")) {
      sent.push(Buffer.from(JSON.parse(String(init.body)).raw as string, "base64url").toString("utf8"));
      return new Response("{}", { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const jobsOf = (kind: string, batchId: number) => db().prepare("SELECT status FROM jobs WHERE kind = ? AND batch_id = ? ORDER BY id").pluck().all(kind, batchId) as string[];

describe("worker restart (item 7, the crash case)", () => {
  it("a go-live try killed while emailing, its next try already queued: the restart leaves one waiting job, not two", () => {
    const tried = enqueue("golive", 7, 0);
    db().prepare("UPDATE jobs SET status = 'running', attempts = 1 WHERE id = ?").run(tried);
    enqueue("golive", 7, Date.now() + 5 * 60_000); // the follow-up it queued before the email
    const lone = enqueue("review", 8, 0); // a job with no follow-up goes back in the queue as before
    db().prepare("UPDATE jobs SET status = 'running', attempts = 1 WHERE id = ?").run(lone);
    expect(requeueStale().requeued).toBe(2);
    expect(jobsOf("golive", 7)).toEqual(["done", "queued"]);
    expect(jobsOf("review", 8)).toEqual(["queued"]);
  });
});

describe("Stop in force (item 2)", () => {
  it("pressed and no Retry since; a Retry after it ends it", () => {
    const at = (min: number) => new Date(Date.UTC(2026, 10, 19, 9, min)).toISOString();
    expect(goLiveStopped({ cancel_requested: 1 })).toBe(true);
    expect(goLiveStopped({ cancel_requested: 0, stopped_at: at(0) })).toBe(true);
    expect(goLiveStopped({ cancel_requested: 0, stopped_at: at(5), retried_at: at(1) })).toBe(true);
    expect(goLiveStopped({ cancel_requested: 0, stopped_at: at(0), retried_at: at(1) })).toBe(false);
    expect(goLiveStopped({ cancel_requested: 0, stopped_at: null })).toBe(false);
  });
});

describe("plan alerts (item 3)", () => {
  it("a plan cancelled while the worker runs it: its 'not turned on' and 'stopped' alerts leave the home page, and no 'stopped' email is sent", async () => {
    const v = await createPlan({ title: "Pause two campaigns", ops: [{ type: "set_status", status: "PAUSED", campaigns: ["c1"] }, { type: "set_status", status: "PAUSED", campaigns: ["c2"] }] }, WHO, "app");
    await confirmPlan(v.key, { confirm: true, acceptWarnings: true }, WHO);
    const link = appLink(`/plans/${v.key}`);
    await sendAlert({ to: WHO, kind: "golive", subject: `Launch ab12c: ads created but not turned on`, lines: ["draft"], link });
    await sendAlert({ to: WHO, kind: "stopped", subject: `Plan ${v.key} stopped`, lines: ["network drop"], link });
    await sendAlert({ to: WHO, subject: `Plan ${v.key} was not run at 9:00 am`, lines: ["x"], link }); // no kind: never removed by this
    sent = [];
    // Hold the plan's first Meta call until the person has pressed Cancel.
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    let hit!: () => void;
    const reached = new Promise<void>((r) => (hit = r));
    const real = mock.fetch;
    let first = true;
    mock.fetch = (async (u: RequestInfo | URL, init?: RequestInit) => {
      if (first) {
        first = false;
        hit();
        await gate;
      }
      return real(u, init);
    }) as typeof fetch;
    const job = claimNext(LANES.plan)!;
    expect(job.kind).toBe("plan");
    const running = runClaimed(job);
    await reached;
    cancelPlan(v.key);
    open();
    await running;
    expect(db().prepare("SELECT status FROM plans WHERE key = ?").pluck().get(v.key)).toBe("cancelled");
    expect(recentAlerts(10).map((a) => a.subject)).toEqual([`Plan ${v.key} was not run at 9:00 am`]);
    expect(sent).toEqual([]);
  });
});
