// Policy doctor health-check factories for one policy scope.
import type { HealthCheck } from "openclaw/plugin-sdk/health";
import { CHECK_IDS } from "../check-ids.js";
import type { PolicyDoctorCheckDeps } from "../types.js";

export function createPolicyCoreChecks(deps: PolicyDoctorCheckDeps): readonly HealthCheck[] {
  const { evaluatePolicy, findingsForCheck } = deps;

  const policyMissingFileCheck: HealthCheck = {
    id: CHECK_IDS.policyMissingFile,
    kind: "plugin",
    description: "The enabled Policy plugin has a policy file to verify.",
    source: "policy",
    async detect(ctx) {
      return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyMissingFile);
    },
  };
  const policyHashMismatchCheck: HealthCheck = {
    id: CHECK_IDS.policyHashMismatch,
    kind: "plugin",
    description: "The policy file matches the configured expected hash.",
    source: "policy",
    async detect(ctx) {
      return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyHashMismatch);
    },
  };
  const policyAttestationMismatchCheck: HealthCheck = {
    id: CHECK_IDS.policyAttestationMismatch,
    kind: "plugin",
    description: "The current policy check matches the accepted attestation.",
    source: "policy",
    async detect(ctx) {
      return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyAttestationMismatch);
    },
  };
  const policyInvalidFileCheck: HealthCheck = {
    id: CHECK_IDS.policyInvalidFile,
    kind: "plugin",
    description: "The enabled policy file parses before policy checks run.",
    source: "policy",
    async detect(ctx) {
      return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyInvalidFile);
    },
  };

  return [
    policyMissingFileCheck,
    policyInvalidFileCheck,
    policyHashMismatchCheck,
    policyAttestationMismatchCheck,
  ];
}
