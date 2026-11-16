import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { connectPractice, dialogUrl, disconnect, exchangeCode, inspect, listAssets, listInstagram, metaStatus, savePending, selectAssets } from "@/lib/meta/connect";
import { clientFor } from "@/lib/meta/factory";
import { MockMeta } from "@/lib/meta/mock";
import { realClock } from "@/lib/meta/pacer";
import { defaultPreset } from "@/lib/setup";
import { getAccount } from "@/lib/store";
import { freshDb } from "./helpers";

// Connect Meta, run against the fake Graph API (practice mode).

const g = globalThis as unknown as { __mockMeta?: MockMeta };
const EMAIL = "marketer@example.com";
const before = process.env.META_MOCK;

beforeEach(() => {
  process.env.META_MOCK = "1";
  g.__mockMeta = new MockMeta({ clock: realClock, capPoints: 9000 });
  freshDb();
});
afterAll(() => {
  process.env.META_MOCK = before;
});

describe("Connect Meta", () => {
  it("login → 60-day token → pick → saved encrypted, Page and Instagram in the default preset", async () => {
    expect(dialogUrl("abc")).toBe("/api/meta/callback?code=practice&state=abc");
    const t = await exchangeCode("practice");
    expect(t.token).toBe("practice-long-token"); // the 2-hour token was swapped for the 60-day one
    expect(t.expiresAt! - Date.now()).toBeGreaterThan(59 * 86_400_000);
    savePending(EMAIL, t);
    expect(metaStatus(EMAIL)).toMatchObject({ connected: false, pending: true });

    const a = await listAssets(EMAIL);
    expect(a.missing).toEqual([]);
    expect(a.adAccounts.map((x) => [x.id, x.active])).toEqual([["act_1001", true], ["act_3003", false]]);
    expect(a.pages[0]).toMatchObject({ id: "p1", instagram: { id: "ig1", username: "sahajta.ai" } });

    expect(await listInstagram(EMAIL, "act_1001")).toEqual([{ id: "ig1", username: "sahajta.ai" }]);
    await expect(selectAssets(EMAIL, { adAccountId: "act_3003", pageId: "p1" })).rejects.toThrow(/not active/);
    await expect(selectAssets(EMAIL, { adAccountId: "act_1001", pageId: "p1", igUserId: "ig-unknown" })).rejects.toThrow(/Instagram/);
    const id = await selectAssets(EMAIL, { adAccountId: "act_1001", pageId: "p1", igUserId: "ig1" });

    const acc = getAccount()!;
    expect(acc.id).toBe(id);
    expect(acc.token_enc).toBeTruthy();
    expect(acc.token_enc).not.toContain("practice-long-token");
    expect(acc.connected_by).toBe(EMAIL);
    expect(defaultPreset(id)).toMatchObject({ pageId: "p1", pageName: "Sahajta AI", igUserId: "ig1", igName: "sahajta.ai" });
    // Nothing readable is left in the database: the pending token is gone, the saved one is encrypted.
    const dump = JSON.stringify(db().prepare("SELECT * FROM cache").all()) + JSON.stringify(db().prepare("SELECT * FROM ad_accounts").all());
    expect(dump).not.toContain("practice-");
    expect(metaStatus(EMAIL)).toMatchObject({ connected: true, pending: false, adAccount: { id: "act_1001" }, page: "Sahajta AI", instagram: "@sahajta.ai", expired: false });

    // The launcher can now call Meta with it.
    expect((await clientFor().get<{ id: string }>("act_1001")).id).toBe("act_1001");
  });

  it("a pasted system-user token does not expire and ends in the same picking step", async () => {
    savePending(EMAIL, await inspect("practice-system-user-token"));
    const a = await listAssets(EMAIL);
    expect(a.expiresAt).toBeNull();
    await selectAssets(EMAIL, { adAccountId: "act_1001", pageId: "p1" });
    expect(metaStatus(EMAIL)).toMatchObject({ connected: true, expiresAt: null, instagram: null });
  });

  it("switching to another ad account (for example the agency's) keeps the templates", async () => {
    g.__mockMeta = new MockMeta({
      clock: realClock,
      capPoints: 9000,
      adAccounts: [
        { id: "act_1001", name: "Sahajta (practice)", account_status: 1 },
        { id: "act_2002", name: "Agency account (practice)", account_status: 1, business: { id: "b9", name: "The Agency" } },
      ],
    });
    const first = await connectPractice(EMAIL);
    db().prepare("INSERT INTO copy_templates (ad_account_id, name) VALUES (?, 'Diwali copy')").run(first);

    savePending(EMAIL, await exchangeCode("practice"));
    const second = await selectAssets(EMAIL, { adAccountId: "act_2002", pageId: "p1", igUserId: "ig1" });
    expect(second).not.toBe(first);
    expect(getAccount()!.meta_account_id).toBe("act_2002");
    const names = (db().prepare("SELECT name FROM copy_templates WHERE ad_account_id = ?").all(second) as { name: string }[]).map((r) => r.name);
    expect(names).toContain("Diwali copy");
    expect(db().prepare("SELECT COUNT(*) AS n FROM settings_presets WHERE ad_account_id = ?").get(second)).toEqual({ n: 1 });

    // Change only the Page or account later, with the same login (no new Facebook window).
    await selectAssets(EMAIL, { adAccountId: "act_1001", pageId: "p1" });
    expect(getAccount()!.meta_account_id).toBe("act_1001");
  });

  it("a wrong token is refused in plain words; disconnect stops launches but keeps templates", async () => {
    await expect(inspect("not-a-token")).rejects.toThrow(/Meta did not accept this token: it may be expired, cut short when copied, or made for another app/);
    await connectPractice(EMAIL);
    disconnect();
    expect(metaStatus(EMAIL).connected).toBe(false);
    expect(() => clientFor()).toThrow(/Connect Meta/);
    expect(db().prepare("SELECT COUNT(*) AS n FROM naming_templates").get()).toEqual({ n: 2 });
  });
});
