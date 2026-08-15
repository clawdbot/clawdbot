// Policy doctor health-check factories for one policy scope.
import type { HealthCheck } from "openclaw/plugin-sdk/health";
import { createPolicyScopedChecks } from "../check-factory.js";
import { CHECK_IDS } from "../check-ids.js";
import type { PolicyDoctorCheckDeps } from "../types.js";

export function createPolicyExecApprovalChecks(
  deps: PolicyDoctorCheckDeps,
): readonly HealthCheck[] {
  return createPolicyScopedChecks(deps, [
    [
      CHECK_IDS.policyExecApprovalsMissing,
      "Required exec approvals artifact is present for policy conformance.",
    ],
    [
      CHECK_IDS.policyExecApprovalsInvalid,
      "Exec approvals artifact parses before policy checks run.",
    ],
    [
      CHECK_IDS.policyExecApprovalsDefaultSecurityUnapproved,
      "Exec approval defaults use a policy-approved security mode.",
    ],
    [
      CHECK_IDS.policyExecApprovalsAgentSecurityUnapproved,
      "Per-agent exec approval settings use policy-approved security modes.",
    ],
    [
      CHECK_IDS.policyExecApprovalsAutoAllowSkillsEnabled,
      "Exec approval agents do not implicitly auto-allow skill CLIs unless policy allows it.",
    ],
    [
      CHECK_IDS.policyExecApprovalsAllowlistMissing,
      "Exec approval allowlists include every pattern required by policy.",
    ],
    [
      CHECK_IDS.policyExecApprovalsAllowlistUnexpected,
      "Exec approval allowlists do not contain patterns outside policy.",
    ],
  ]);
}
