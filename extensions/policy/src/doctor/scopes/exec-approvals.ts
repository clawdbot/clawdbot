// Policy doctor health-check factories for one policy scope.
import type { HealthCheck } from "openclaw/plugin-sdk/health";
import { CHECK_IDS } from "../check-ids.js";
import type { PolicyDoctorCheckDeps } from "../types.js";

export function createPolicyExecApprovalChecks(
  deps: PolicyDoctorCheckDeps,
): readonly HealthCheck[] {
  const { evaluatePolicy, findingsForCheck } = deps;

  const policyExecApprovalsMissingCheck: HealthCheck = {
    id: CHECK_IDS.policyExecApprovalsMissing,
    kind: "plugin",
    description: "Required exec approvals artifact is present for policy conformance.",
    source: "policy",
    async detect(ctx) {
      return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyExecApprovalsMissing);
    },
  };
  const policyExecApprovalsInvalidCheck: HealthCheck = {
    id: CHECK_IDS.policyExecApprovalsInvalid,
    kind: "plugin",
    description: "Exec approvals artifact parses before policy checks run.",
    source: "policy",
    async detect(ctx) {
      return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyExecApprovalsInvalid);
    },
  };
  const policyExecApprovalsDefaultSecurityUnapprovedCheck: HealthCheck = {
    id: CHECK_IDS.policyExecApprovalsDefaultSecurityUnapproved,
    kind: "plugin",
    description: "Exec approval defaults use a policy-approved security mode.",
    source: "policy",
    async detect(ctx) {
      return findingsForCheck(
        await evaluatePolicy(ctx),
        CHECK_IDS.policyExecApprovalsDefaultSecurityUnapproved,
      );
    },
  };
  const policyExecApprovalsAgentSecurityUnapprovedCheck: HealthCheck = {
    id: CHECK_IDS.policyExecApprovalsAgentSecurityUnapproved,
    kind: "plugin",
    description: "Per-agent exec approval settings use policy-approved security modes.",
    source: "policy",
    async detect(ctx) {
      return findingsForCheck(
        await evaluatePolicy(ctx),
        CHECK_IDS.policyExecApprovalsAgentSecurityUnapproved,
      );
    },
  };
  const policyExecApprovalsAutoAllowSkillsEnabledCheck: HealthCheck = {
    id: CHECK_IDS.policyExecApprovalsAutoAllowSkillsEnabled,
    kind: "plugin",
    description:
      "Exec approval agents do not implicitly auto-allow skill CLIs unless policy allows it.",
    source: "policy",
    async detect(ctx) {
      return findingsForCheck(
        await evaluatePolicy(ctx),
        CHECK_IDS.policyExecApprovalsAutoAllowSkillsEnabled,
      );
    },
  };
  const policyExecApprovalsAllowlistMissingCheck: HealthCheck = {
    id: CHECK_IDS.policyExecApprovalsAllowlistMissing,
    kind: "plugin",
    description: "Exec approval allowlists include every pattern required by policy.",
    source: "policy",
    async detect(ctx) {
      return findingsForCheck(
        await evaluatePolicy(ctx),
        CHECK_IDS.policyExecApprovalsAllowlistMissing,
      );
    },
  };
  const policyExecApprovalsAllowlistUnexpectedCheck: HealthCheck = {
    id: CHECK_IDS.policyExecApprovalsAllowlistUnexpected,
    kind: "plugin",
    description: "Exec approval allowlists do not contain patterns outside policy.",
    source: "policy",
    async detect(ctx) {
      return findingsForCheck(
        await evaluatePolicy(ctx),
        CHECK_IDS.policyExecApprovalsAllowlistUnexpected,
      );
    },
  };

  return [
    policyExecApprovalsMissingCheck,
    policyExecApprovalsInvalidCheck,
    policyExecApprovalsDefaultSecurityUnapprovedCheck,
    policyExecApprovalsAgentSecurityUnapprovedCheck,
    policyExecApprovalsAutoAllowSkillsEnabledCheck,
    policyExecApprovalsAllowlistMissingCheck,
    policyExecApprovalsAllowlistUnexpectedCheck,
  ];
}
