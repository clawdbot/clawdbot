import { describe, expect, it } from "vitest";
import { resolveCanonicalPluginApprovalRequestAllowedDecisions } from "./plugin-approval-canonical-decisions.js";
import { resolvePluginApprovalRequestAllowedDecisions } from "./plugin-approvals.js";

describe("plugin approval decisions", () => {
  it("preserves the shipped explicit list while canonical decisions add deny", () => {
    const request = { allowedDecisions: ["allow-once"] as const };

    const legacyDecisions = resolvePluginApprovalRequestAllowedDecisions(request);
    expect(legacyDecisions).toEqual(["allow-once"]);
    expect(legacyDecisions.includes("deny")).toBe(false);
    expect(resolveCanonicalPluginApprovalRequestAllowedDecisions(request)).toEqual([
      "allow-once",
      "deny",
    ]);
  });
});
