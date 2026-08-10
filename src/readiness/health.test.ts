import { describe, expect, it } from "vitest";
import type { CanonicalReadinessResult, ReadinessCondition } from "./conditions.js";
import { deriveConditionHealth, listNonPassingReadinessConditions } from "./health.js";
import { createProcessReadinessIdentity } from "./subjects.js";

function condition(
  status: ReadinessCondition["status"],
  requirement: ReadinessCondition["requirement"],
): ReadinessCondition {
  return {
    type: `${requirement}.${status}`,
    subjectRef: "openclaw/gateway/test",
    status,
    requirement,
    reason: `${requirement}.${status}`,
    message: `${requirement} condition is ${status}.`,
  };
}

function readiness(conditions: ReadinessCondition[]): CanonicalReadinessResult {
  return {
    contractVersion: 1,
    evaluatedAtMs: 123,
    identity: createProcessReadinessIdentity({
      processId: "test-process",
      gatewayId: "test-gateway",
    }),
    ready: !conditions.some((entry) => entry.requirement === "required" && entry.status !== "True"),
    conditions,
    failures: [],
    advisories: [],
  };
}

describe("deriveConditionHealth", () => {
  it.each([
    {
      name: "passing",
      conditions: [condition("True", "required"), condition("True", "advisory")],
      expected: "passing",
    },
    {
      name: "degraded",
      conditions: [condition("True", "required"), condition("False", "advisory")],
      expected: "degraded",
    },
    {
      name: "failing",
      conditions: [condition("False", "required"), condition("Unknown", "required")],
      expected: "failing",
    },
    {
      name: "unknown",
      conditions: [condition("Unknown", "required"), condition("False", "advisory")],
      expected: "unknown",
    },
  ])("derives $name from selected conditions", ({ conditions, expected }) => {
    expect(deriveConditionHealth(readiness(conditions))).toEqual({
      contractVersion: 1,
      evaluatedAtMs: 123,
      scope: "selected-readiness-conditions",
      status: expected,
      ready: expected === "passing" || expected === "degraded",
    });
  });

  it("returns canonical non-passing conditions unchanged", () => {
    const failing = condition("False", "required");
    const unknown = condition("Unknown", "advisory");

    expect(
      listNonPassingReadinessConditions(
        readiness([condition("True", "required"), failing, unknown]),
      ),
    ).toEqual([failing, unknown]);
  });
});
