import type { HealthCheck } from "openclaw/plugin-sdk/health";
import type { POLICY_CHECK_IDS } from "./check-ids.js";
import type { PolicyDoctorCheckDeps } from "./types.js";

type PolicyDoctorCheckDefinition = readonly [
  id: (typeof POLICY_CHECK_IDS)[number],
  description: string,
  repair?: NonNullable<HealthCheck["repair"]>,
];

export function createPolicyScopedChecks(
  deps: Pick<PolicyDoctorCheckDeps, "evaluatePolicy" | "findingsForCheck">,
  definitions: readonly PolicyDoctorCheckDefinition[],
): readonly HealthCheck[] {
  const { evaluatePolicy, findingsForCheck } = deps;
  return definitions.map(([id, description, repair]) => ({
    id,
    kind: "plugin",
    description,
    source: "policy",
    async detect(ctx) {
      return findingsForCheck(await evaluatePolicy(ctx), id);
    },
    ...(repair ? { repair } : {}),
  }));
}
