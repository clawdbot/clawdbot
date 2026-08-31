// Policy doctor health-check factories for one policy scope.
import type { HealthCheck } from "openclaw/plugin-sdk/health";
import { createPolicyScopedChecks } from "../check-factory.js";
import { CHECK_IDS } from "../check-ids.js";
import type { PolicyDoctorCheckDeps } from "../types.js";

export function createPolicyCoreChecks(deps: PolicyDoctorCheckDeps): readonly HealthCheck[] {
  return createPolicyScopedChecks(deps, [
    [CHECK_IDS.policyMissingFile, "The enabled Policy plugin has a policy file to verify."],
    [CHECK_IDS.policyInvalidFile, "The enabled policy file parses before policy checks run."],
    [CHECK_IDS.policyHashMismatch, "The policy file matches the configured expected hash."],
    [
      CHECK_IDS.policyAttestationMismatch,
      "The current policy check matches the accepted attestation.",
    ],
  ]);
}
