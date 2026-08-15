/** Tests ACP backend failover candidate ordering and transient-error detection. */
import { describe, expect, it } from "vitest";
import {
  isFailoverWorthyBackendError,
  resolveBackendCandidatePlan,
  shouldAttemptBackendFailover,
} from "./manager.backend-failover.js";

describe("ACP manager backend failover helpers", () => {
  it("dedupes configured, resolved, and fallback backends while preserving order", () => {
    const plan = resolveBackendCandidatePlan({
      configuredPrimaryBackend: " primary ",
      resolvedPrimaryBackend: "resolved",
      fallbackBackends: ["fallback-a", "primary", "", undefined, "fallback-b"],
    });

    expect(plan.candidateBackends).toEqual(["primary", "fallback-a", "fallback-b"]);
    expect(plan.describeBackendCandidate("")).toBe("resolved");
    expect(plan.describeBackendCandidate("fallback-a")).toBe("fallback-a");
  });

  it("keeps auto backend as a candidate when no backend is configured", () => {
    const plan = resolveBackendCandidatePlan({});

    expect(plan.candidateBackends).toEqual([""]);
    expect(plan.describeBackendCandidate("")).toBe("<auto>");
  });

  it("classifies only early transient backend errors as failover-worthy", () => {
    expect(
      isFailoverWorthyBackendError({
        backend: "primary",
        code: "ACP_TURN_FAILED",
        error: "backend temporarily overloaded",
        sawOutput: false,
      }),
    ).toBe(true);
    expect(
      isFailoverWorthyBackendError({
        backend: "primary",
        code: "ACP_TURN_FAILED",
        error: "backend temporarily overloaded",
        sawOutput: true,
      }),
    ).toBe(false);
    expect(
      isFailoverWorthyBackendError({
        backend: "primary",
        code: "ACP_BACKEND_MISSING",
        error: "backend unavailable",
        sawOutput: false,
      }),
    ).toBe(false);
  });

  it("allows failover only when another candidate remains", () => {
    const candidateBackends = ["primary", "fallback"];

    expect(shouldAttemptBackendFailover({ backendIndex: 0, candidateBackends })).toBe(true);
    expect(shouldAttemptBackendFailover({ backendIndex: 1, candidateBackends })).toBe(false);
  });
});
