// Covers approval-not-found error detection.
import { describe, expect, it } from "vitest";
import { isApprovalNotFoundError } from "./approval-errors.js";

describe("isApprovalNotFoundError", () => {
  it("matches direct approval-not-found gateway codes", () => {
    const err = new Error("approval not found") as Error & { gatewayCode?: string };
    err.gatewayCode = "APPROVAL_NOT_FOUND";
    expect(isApprovalNotFoundError(err)).toBe(true);
  });

  it("matches structured invalid-request approval-not-found details", () => {
    const err = new Error("approval not found") as Error & {
      gatewayCode?: string;
      details?: { reason?: string };
    };
    err.gatewayCode = "INVALID_REQUEST";
    err.details = { reason: "APPROVAL_NOT_FOUND" };
    expect(isApprovalNotFoundError(err)).toBe(true);
  });

  it("matches legacy message-only not-found errors", () => {
    expect(isApprovalNotFoundError(new Error("unknown or expired approval id"))).toBe(true);
  });

  it("ignores unrelated errors", () => {
    expect(isApprovalNotFoundError(new Error("network timeout"))).toBe(false);
    expect(isApprovalNotFoundError("unknown or expired approval id")).toBe(false);
  });
});
