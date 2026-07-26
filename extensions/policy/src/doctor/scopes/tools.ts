// Policy doctor health-check factories for one policy scope.
import type { HealthCheck } from "openclaw/plugin-sdk/health";
import { repairPolicyAutomaticNarrower } from "../automatic-repairs.js";
import { CHECK_IDS } from "../check-ids.js";
import type { PolicyDoctorCheckDeps } from "../types.js";

export function createPolicyAgentToolChecks(deps: PolicyDoctorCheckDeps): readonly HealthCheck[] {
  const { evaluatePolicy, findingsForCheck } = deps;

  const policyAgentsWorkspaceAccessDeniedCheck: HealthCheck = {
    id: CHECK_IDS.policyAgentsWorkspaceAccessDenied,
    kind: "plugin",
    description: "Agent sandbox workspace access matches policy.",
    source: "policy",
    async detect(ctx) {
      return findingsForCheck(
        await evaluatePolicy(ctx),
        CHECK_IDS.policyAgentsWorkspaceAccessDenied,
      );
    },
  };
  const policyAgentsToolNotDeniedCheck: HealthCheck = {
    id: CHECK_IDS.policyAgentsToolNotDenied,
    kind: "plugin",
    description: "Agent workspace mutation/runtime tools are denied when policy requires it.",
    source: "policy",
    async detect(ctx) {
      return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyAgentsToolNotDenied);
    },
    repair(ctx, findings) {
      return repairPolicyAutomaticNarrower(ctx, findings, CHECK_IDS.policyAgentsToolNotDenied);
    },
  };
  const policyToolsProfileUnapprovedCheck: HealthCheck = {
    id: CHECK_IDS.policyToolsProfileUnapproved,
    kind: "plugin",
    description: "Configured tool profiles match policy allow rules.",
    source: "policy",
    async detect(ctx) {
      return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyToolsProfileUnapproved);
    },
  };
  const policyToolsFsWorkspaceOnlyRequiredCheck: HealthCheck = {
    id: CHECK_IDS.policyToolsFsWorkspaceOnlyRequired,
    kind: "plugin",
    description: "Filesystem tools use workspace-only posture when policy requires it.",
    source: "policy",
    async detect(ctx) {
      return findingsForCheck(
        await evaluatePolicy(ctx),
        CHECK_IDS.policyToolsFsWorkspaceOnlyRequired,
      );
    },
  };
  const policyToolsExecSecurityUnapprovedCheck: HealthCheck = {
    id: CHECK_IDS.policyToolsExecSecurityUnapproved,
    kind: "plugin",
    description: "Exec tool security mode matches policy allow rules.",
    source: "policy",
    async detect(ctx) {
      return findingsForCheck(
        await evaluatePolicy(ctx),
        CHECK_IDS.policyToolsExecSecurityUnapproved,
      );
    },
  };
  const policyToolsExecAskUnapprovedCheck: HealthCheck = {
    id: CHECK_IDS.policyToolsExecAskUnapproved,
    kind: "plugin",
    description: "Exec tool ask mode matches policy allow rules.",
    source: "policy",
    async detect(ctx) {
      return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyToolsExecAskUnapproved);
    },
  };
  const policyToolsExecHostUnapprovedCheck: HealthCheck = {
    id: CHECK_IDS.policyToolsExecHostUnapproved,
    kind: "plugin",
    description: "Exec tool host routing matches policy allow rules.",
    source: "policy",
    async detect(ctx) {
      return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyToolsExecHostUnapproved);
    },
  };
  const policyToolsElevatedEnabledCheck: HealthCheck = {
    id: CHECK_IDS.policyToolsElevatedEnabled,
    kind: "plugin",
    description: "Elevated tool mode remains disabled when policy requires it.",
    source: "policy",
    async detect(ctx) {
      return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyToolsElevatedEnabled);
    },
    repair(ctx, findings) {
      return repairPolicyAutomaticNarrower(ctx, findings, CHECK_IDS.policyToolsElevatedEnabled);
    },
  };
  const policyToolsAlsoAllowMissingCheck: HealthCheck = {
    id: CHECK_IDS.policyToolsAlsoAllowMissing,
    kind: "plugin",
    description: "Configured tools.alsoAllow entries include policy expected lists.",
    source: "policy",
    async detect(ctx) {
      return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyToolsAlsoAllowMissing);
    },
  };
  const policyToolsAlsoAllowUnexpectedCheck: HealthCheck = {
    id: CHECK_IDS.policyToolsAlsoAllowUnexpected,
    kind: "plugin",
    description: "Configured tools.alsoAllow entries match policy expected lists.",
    source: "policy",
    async detect(ctx) {
      return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyToolsAlsoAllowUnexpected);
    },
  };
  const policyToolsRequiredDenyMissingCheck: HealthCheck = {
    id: CHECK_IDS.policyToolsRequiredDenyMissing,
    kind: "plugin",
    description: "Configured tool deny lists include tools required by policy.",
    source: "policy",
    async detect(ctx) {
      return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyToolsRequiredDenyMissing);
    },
    repair(ctx, findings) {
      return repairPolicyAutomaticNarrower(ctx, findings, CHECK_IDS.policyToolsRequiredDenyMissing);
    },
  };

  return [
    policyAgentsWorkspaceAccessDeniedCheck,
    policyAgentsToolNotDeniedCheck,
    policyToolsProfileUnapprovedCheck,
    policyToolsFsWorkspaceOnlyRequiredCheck,
    policyToolsExecSecurityUnapprovedCheck,
    policyToolsExecAskUnapprovedCheck,
    policyToolsExecHostUnapprovedCheck,
    policyToolsElevatedEnabledCheck,
    policyToolsAlsoAllowMissingCheck,
    policyToolsAlsoAllowUnexpectedCheck,
    policyToolsRequiredDenyMissingCheck,
  ];
}

export function createPolicyToolMetadataChecks(
  deps: PolicyDoctorCheckDeps,
): readonly HealthCheck[] {
  const { evaluatePolicy, findingsForCheck } = deps;

  const policyToolsMissingRiskCheck: HealthCheck = {
    id: CHECK_IDS.policyMissingToolRisk,
    kind: "plugin",
    description: "TOOLS.md policy entries declare explicit risk levels.",
    source: "policy",
    async detect(ctx) {
      return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyMissingToolRisk);
    },
  };
  const policyToolsUnknownRiskCheck: HealthCheck = {
    id: CHECK_IDS.policyUnknownToolRisk,
    kind: "plugin",
    description: "TOOLS.md policy entries use known risk levels.",
    source: "policy",
    async detect(ctx) {
      return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyUnknownToolRisk);
    },
  };
  const policyToolsMissingSensitivityCheck: HealthCheck = {
    id: CHECK_IDS.policyMissingToolSensitivity,
    kind: "plugin",
    description: "TOOLS.md policy entries declare default artifact sensitivity.",
    source: "policy",
    async detect(ctx) {
      return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyMissingToolSensitivity);
    },
  };
  const policyToolsUnknownSensitivityCheck: HealthCheck = {
    id: CHECK_IDS.policyUnknownToolSensitivity,
    kind: "plugin",
    description: "TOOLS.md policy entries use known sensitivity levels.",
    source: "policy",
    async detect(ctx) {
      return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyUnknownToolSensitivity);
    },
  };
  const policyToolsMissingOwnerCheck: HealthCheck = {
    id: CHECK_IDS.policyMissingToolOwner,
    kind: "plugin",
    description: "TOOLS.md policy entries declare an accountable owner.",
    source: "policy",
    async detect(ctx) {
      return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyMissingToolOwner);
    },
  };

  return [
    policyToolsMissingRiskCheck,
    policyToolsUnknownRiskCheck,
    policyToolsMissingSensitivityCheck,
    policyToolsMissingOwnerCheck,
    policyToolsUnknownSensitivityCheck,
  ];
}
