import { describe, expect, it } from "vitest";
import { feedbackLines } from "@/lib/manage/feedback";

describe("Meta's review feedback in plain words", () => {
  it("global and placement-specific reasons, and delivery issues, without [object Object]", () => {
    const lines = feedbackLines({
      issues_info: [{ error_summary: "Ad set budget too low", error_message: "Raise it to ₹100" }],
      ad_review_feedback: { global: { "Personal attributes": "The ad implies a personal attribute." }, placement_specific: { instagram: { "Personal attributes": "Same on Instagram." }, audience_network: "Not allowed" } },
    });
    expect(lines).toEqual([
      "Ad set budget too low: Raise it to ₹100",
      "Personal attributes: The ad implies a personal attribute.",
      "Instagram – Personal attributes: Same on Instagram.",
      "Audience Network: Not allowed",
    ]);
    expect(lines.join(" ")).not.toContain("[object Object]");
  });
});
