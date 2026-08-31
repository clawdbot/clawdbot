// Policy doctor health-check factories for one policy scope.
import type { HealthCheck } from "openclaw/plugin-sdk/health";
import { repairPolicyAutomaticNarrower } from "../automatic-repairs.js";
import { createPolicyScopedChecks } from "../check-factory.js";
import { CHECK_IDS } from "../check-ids.js";
import type { PolicyDoctorCheckDeps } from "../types.js";

export function createPolicyAgentToolChecks(deps: PolicyDoctorCheckDeps): readonly HealthCheck[] {
  return createPolicyScopedChecks(deps, [
    [CHECK_IDS.policyAgentsWorkspaceAccessDenied, "Agent sandbox workspace access matches policy."],
    [
      CHECK_IDS.policyAgentsToolNotDenied,
      "Agent workspace mutation/runtime tools are denied when policy requires it.",
      (ctx, findings) =>
        repairPolicyAutomaticNarrower(ctx, findings, CHECK_IDS.policyAgentsToolNotDenied),
    ],
    [CHECK_IDS.policyToolsProfileUnapproved, "Configured tool profiles match policy allow rules."],
    [
      CHECK_IDS.policyToolsFsWorkspaceOnlyRequired,
      "Filesystem tools use workspace-only posture when policy requires it.",
    ],
    [
      CHECK_IDS.policyToolsExecSecurityUnapproved,
      "Exec tool security mode matches policy allow rules.",
    ],
    [CHECK_IDS.policyToolsExecAskUnapproved, "Exec tool ask mode matches policy allow rules."],
    [CHECK_IDS.policyToolsExecHostUnapproved, "Exec tool host routing matches policy allow rules."],
    [
      CHECK_IDS.policyToolsElevatedEnabled,
      "Elevated tool mode remains disabled when policy requires it.",
      (ctx, findings) =>
        repairPolicyAutomaticNarrower(ctx, findings, CHECK_IDS.policyToolsElevatedEnabled),
    ],
    [
      CHECK_IDS.policyToolsAlsoAllowMissing,
      "Configured tools.alsoAllow entries include policy expected lists.",
    ],
    [
      CHECK_IDS.policyToolsAlsoAllowUnexpected,
      "Configured tools.alsoAllow entries match policy expected lists.",
    ],
    [
      CHECK_IDS.policyToolsRequiredDenyMissing,
      "Configured tool deny lists include tools required by policy.",
      (ctx, findings) =>
        repairPolicyAutomaticNarrower(ctx, findings, CHECK_IDS.policyToolsRequiredDenyMissing),
    ],
  ]);
}

export function createPolicyToolMetadataChecks(
  deps: PolicyDoctorCheckDeps,
): readonly HealthCheck[] {
  return createPolicyScopedChecks(deps, [
    [
      CHECK_IDS.policyUnmigratedToolsFile,
      "Governed tool declarations have been migrated from TOOLS.md into AGENTS.md.",
    ],
    [
      CHECK_IDS.policyMissingToolRisk,
      "AGENTS.md tool policy entries declare explicit risk levels.",
    ],
    [CHECK_IDS.policyUnknownToolRisk, "AGENTS.md tool policy entries use known risk levels."],
    [
      CHECK_IDS.policyMissingToolSensitivity,
      "AGENTS.md tool policy entries declare default artifact sensitivity.",
    ],
    [
      CHECK_IDS.policyMissingToolOwner,
      "AGENTS.md tool policy entries declare an accountable owner.",
    ],
    [
      CHECK_IDS.policyUnknownToolSensitivity,
      "AGENTS.md tool policy entries use known sensitivity levels.",
    ],
  ]);
}
