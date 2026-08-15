import { describe, expect, it } from "vitest";
import { isPendingApprovalToolResult } from "./embedded-agent-subscribe.handlers.tools.results.js";

describe("isPendingApprovalToolResult", () => {
  it("recognizes an approval-pending result", () => {
    expect(isPendingApprovalToolResult({ details: { status: "approval-pending" } })).toBe(true);
  });

  it("rejects an approval-unavailable result", () => {
    // Regression: ClawSweeper flagged that approval-unavailable is an error/no-approval-route
    // outcome, not a future completion -- a yield right after one still has no automatic wake.
    expect(isPendingApprovalToolResult({ details: { status: "approval-unavailable" } })).toBe(
      false,
    );
  });

  it("rejects an unrelated status", () => {
    expect(isPendingApprovalToolResult({ details: { status: "started" } })).toBe(false);
  });

  it("rejects a result with no details", () => {
    expect(isPendingApprovalToolResult({ text: "ok" })).toBe(false);
  });

  it("rejects a non-object result", () => {
    expect(isPendingApprovalToolResult("ok")).toBe(false);
  });
});
