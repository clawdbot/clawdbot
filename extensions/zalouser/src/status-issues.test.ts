import { expectOpenDmPolicyConfigIssue } from "openclaw/plugin-sdk/channel-test-helpers";
import { describe, expect, it } from "vitest";
import { collectZalouserStatusIssues } from "./status-issues.js";

describe("collectZalouserStatusIssues", () => {
  it("flags missing auth when configured is false", () => {
    const issues = collectZalouserStatusIssues([
      {
        accountId: "default",
        enabled: true,
        configured: false,
        lastError: "not authenticated",
      },
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.kind).toBe("auth");
    expect(issues[0]?.message).toMatch(/Not authenticated/i);
  });

  it("warns when dmPolicy is open", () => {
    expectOpenDmPolicyConfigIssue({
      collectIssues: collectZalouserStatusIssues,
      account: {
        accountId: "default",
        enabled: true,
        configured: true,
        dmPolicy: "open",
      },
    });
  });
});
