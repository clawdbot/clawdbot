// Agent liveness tests cover blocked-run state detection and error formatting.
import { describe, expect, it } from "vitest";
import {
  isBlockedLivenessState,
  formatBlockedLivenessError,
  normalizeBlockedLivenessWaitStatus,
} from "./agent-liveness.js";

describe("isBlockedLivenessState", () => {
  it("returns true for blocked in any casing or with surrounding whitespace", () => {
    expect(isBlockedLivenessState("blocked")).toBe(true);
    expect(isBlockedLivenessState("BLOCKED")).toBe(true);
    expect(isBlockedLivenessState(" Blocked ")).toBe(true);
  });

  it("returns false for non-blocked or non-string values", () => {
    expect(isBlockedLivenessState("ok")).toBe(false);
    expect(isBlockedLivenessState("")).toBe(false);
    expect(isBlockedLivenessState(undefined)).toBe(false);
    expect(isBlockedLivenessState(null)).toBe(false);
    expect(isBlockedLivenessState(123)).toBe(false);
  });
});

describe("formatBlockedLivenessError", () => {
  it("returns the trimmed error message when given a string", () => {
    expect(formatBlockedLivenessError("timeout")).toBe("timeout");
    expect(formatBlockedLivenessError("  connection lost ")).toBe("connection lost");
  });

  it("returns a default message for empty or non-string values", () => {
    expect(formatBlockedLivenessError("")).toBe(
      "Agent run blocked before producing a usable result.",
    );
    expect(formatBlockedLivenessError(undefined)).toBe(
      "Agent run blocked before producing a usable result.",
    );
    expect(formatBlockedLivenessError(null)).toBe(
      "Agent run blocked before producing a usable result.",
    );
    expect(formatBlockedLivenessError(123)).toBe(
      "Agent run blocked before producing a usable result.",
    );
  });
});

describe("normalizeBlockedLivenessWaitStatus", () => {
  it("converts status to error when liveness state is blocked", () => {
    expect(
      normalizeBlockedLivenessWaitStatus({
        status: "ok",
        livenessState: "blocked",
      }),
    ).toEqual({
      status: "error",
      error: "Agent run blocked before producing a usable result.",
    });
  });

  it("preserves the original status when liveness is not blocked", () => {
    expect(
      normalizeBlockedLivenessWaitStatus({
        status: "ok",
        livenessState: undefined,
      }),
    ).toEqual({ status: "ok" });
    expect(
      normalizeBlockedLivenessWaitStatus({
        status: "timeout",
        livenessState: "running",
      }),
    ).toEqual({ status: "timeout" });
  });

  it("passes through error string when liveness is not blocked", () => {
    expect(
      normalizeBlockedLivenessWaitStatus({
        status: "timeout",
        error: "request timed out",
      }),
    ).toEqual({ status: "timeout", error: "request timed out" });
  });

  it("uses provided error message in blocked state", () => {
    expect(
      normalizeBlockedLivenessWaitStatus({
        status: "pending",
        livenessState: "blocked",
        error: "gateway unavailable",
      }),
    ).toEqual({ status: "error", error: "gateway unavailable" });
  });

  it("falls back to default message when blocked with non-string error", () => {
    expect(
      normalizeBlockedLivenessWaitStatus({
        status: "error",
        livenessState: "blocked",
        error: 500,
      }),
    ).toEqual({
      status: "error",
      error: "Agent run blocked before producing a usable result.",
    });
  });
});
