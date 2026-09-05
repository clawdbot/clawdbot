// @vitest-environment node
// Unit tests for the run-failure label classifier used by view-runs.ts.
import { describe, expect, it } from "vitest";
import { runFailureLabel } from "./completion-cause.js";

const NOW = Date.parse("2026-09-01T12:00:00.000Z");
const ONE_DAY = 24 * 60 * 60 * 1000;

describe("runFailureLabel", () => {
  it("maps gateway-restart producer cause to the restart label", () => {
    expect(
      runFailureLabel(
        { completionCause: "gateway-restart", completionStatus: "failed", ts: NOW },
        NOW,
      ),
    ).toBe("gatewayRestart");
  });

  it("maps owner-unavailable producer cause to the owner label", () => {
    expect(
      runFailureLabel(
        { completionCause: "owner-unavailable", completionStatus: "failed", ts: NOW },
        NOW,
      ),
    ).toBe("ownerUnavailable");
  });

  it("maps budget-exhausted producer cause to the budget label", () => {
    expect(
      runFailureLabel(
        { completionCause: "budget-exhausted", completionStatus: "failed", ts: NOW },
        NOW,
      ),
    ).toBe("budgetExhausted");
  });

  it("derives active failure for a recent error with no producer cause", () => {
    expect(runFailureLabel({ completionStatus: "failed", ts: NOW - 60_000 }, NOW)).toBe("active");
  });

  it("falls back to the legacy status field when completionStatus is absent", () => {
    expect(runFailureLabel({ status: "error", ts: NOW - 60_000 }, NOW)).toBe("active");
    expect(runFailureLabel({ status: "ok", ts: NOW - 60_000 }, NOW)).toBeNull();
  });

  it("derives previous failure once the error is older than the active window", () => {
    expect(runFailureLabel({ completionStatus: "failed", ts: NOW - ONE_DAY - 1 }, NOW)).toBe(
      "previous",
    );
  });

  it("returns null for a succeeded run with no producer cause", () => {
    expect(runFailureLabel({ completionStatus: "succeeded", ts: NOW }, NOW)).toBeNull();
  });
});
