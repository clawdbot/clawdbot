import type { CanonicalReadinessResult, ReadinessCondition } from "./conditions.js";

export type ConditionHealthStatus = "passing" | "degraded" | "failing" | "unknown";

export type ConditionHealthSummary = {
  contractVersion: 1;
  evaluatedAtMs: number;
  scope: "selected-readiness-conditions";
  status: ConditionHealthStatus;
  ready: boolean;
};

export function deriveConditionHealth(
  readiness: Pick<CanonicalReadinessResult, "evaluatedAtMs" | "ready" | "conditions">,
): ConditionHealthSummary {
  const required = readiness.conditions.filter((condition) => condition.requirement === "required");
  const status: ConditionHealthStatus = required.some((condition) => condition.status === "False")
    ? "failing"
    : required.some((condition) => condition.status === "Unknown")
      ? "unknown"
      : readiness.conditions.some(
            (condition) => condition.requirement === "advisory" && condition.status !== "True",
          )
        ? "degraded"
        : "passing";

  return {
    contractVersion: 1,
    evaluatedAtMs: readiness.evaluatedAtMs,
    scope: "selected-readiness-conditions",
    status,
    ready: readiness.ready,
  };
}

export function listNonPassingReadinessConditions(
  readiness: Pick<CanonicalReadinessResult, "conditions">,
): ReadinessCondition[] {
  return readiness.conditions.filter((condition) => condition.status !== "True");
}
