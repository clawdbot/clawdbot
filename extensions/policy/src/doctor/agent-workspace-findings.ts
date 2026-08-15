import type { HealthFinding } from "openclaw/plugin-sdk/health";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { PolicyAgentWorkspaceEvidence, PolicyEvidence } from "../policy-state.js";
import { agentsPolicyShapeFinding } from "./access-shapes.js";
import { CHECK_IDS } from "./check-ids.js";
import { agentScopedPolicyTargets, scopedWorkspaceAgentMatches } from "./policy-scope.js";
import { hasValidScopedPolicy } from "./scoped-policy-shape.js";
import { ocPathSegment, readStringList } from "./utils.js";

export function agentWorkspaceFindings(
  policy: unknown,
  policyPath: string,
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  if (
    agentsPolicyShapeFinding(isRecord(policy) ? policy.agents : undefined, {
      policyDocName,
      policyPath,
    }) !== undefined
  ) {
    return [];
  }
  return [
    ...agentWorkspaceAccessFindings(
      policy,
      ["agents", "workspace", "allowedAccess"],
      policyDocName,
      "agents/workspace/allowedAccess",
      evidence,
      () => true,
    ),
    ...agentWorkspaceToolDenyFindings(
      policy,
      ["agents", "workspace", "denyTools"],
      policyDocName,
      "agents/workspace/denyTools",
      evidence,
      () => true,
    ),
    ...agentScopedWorkspaceFindings(policy, policyPath, policyDocName, evidence),
  ];
}

function agentWorkspaceAccessFindings(
  policy: unknown,
  policyPath: readonly string[],
  policyDocName: string,
  requirementPath: string,
  evidence: PolicyEvidence,
  evidenceFilter: (entry: PolicyAgentWorkspaceEvidence) => boolean,
): readonly HealthFinding[] {
  const allowed = new Set(readStringList(policy, policyPath));
  if (allowed.size === 0) {
    return [];
  }
  return (evidence.agentWorkspace ?? [])
    .filter(evidenceFilter)
    .filter(
      (entry) =>
        entry.kind === "workspaceAccess" &&
        entry.value !== undefined &&
        (entry.sandboxEnabled !== true || !allowed.has(entry.value)),
    )
    .map((entry): HealthFinding => {
      const label = entry.agentId === undefined ? "agents.defaults" : `agent '${entry.agentId}'`;
      const sandboxDisabled = entry.sandboxEnabled !== true;
      const observed = sandboxDisabled
        ? `sandbox mode '${entry.sandboxMode ?? "off"}'`
        : `sandbox workspaceAccess '${entry.value ?? ""}'`;
      const ocPath = sandboxDisabled ? (entry.sandboxModeSource ?? entry.source) : entry.source;
      return {
        checkId: CHECK_IDS.policyAgentsWorkspaceAccessDenied,
        severity: "error",
        message: `${label} ${observed} is not allowed by policy.`,
        source: "policy",
        path: "openclaw config",
        ocPath,
        target: ocPath,
        requirement: `oc://${policyDocName}/${requirementPath}`,
        fixHint: "Enable sandbox mode with workspaceAccess none/ro or update policy after review.",
      };
    });
}

function agentWorkspaceToolDenyFindings(
  policy: unknown,
  policyPath: readonly string[],
  policyDocName: string,
  requirementPath: string,
  evidence: PolicyEvidence,
  evidenceFilter: (entry: PolicyAgentWorkspaceEvidence) => boolean,
): readonly HealthFinding[] {
  const requiredDeniedTools = new Set(readStringList(policy, policyPath));
  if (requiredDeniedTools.size === 0) {
    return [];
  }
  return (evidence.agentWorkspace ?? [])
    .filter(evidenceFilter)
    .filter(
      (entry) =>
        entry.kind === "toolDeny" &&
        entry.tool !== undefined &&
        requiredDeniedTools.has(entry.tool) &&
        entry.denied !== true,
    )
    .map((entry): HealthFinding => {
      const label = entry.agentId === undefined ? "agents.defaults" : `agent '${entry.agentId}'`;
      return {
        checkId: CHECK_IDS.policyAgentsToolNotDenied,
        severity: "error",
        message: `${label} does not deny required tool '${entry.tool ?? ""}'.`,
        source: "policy",
        path: "openclaw config",
        ocPath: entry.source,
        target: entry.source,
        requirement: `oc://${policyDocName}/${requirementPath}`,
        fixHint:
          "Add the tool to tools.deny or agents.list[].tools.deny, or update policy after review.",
      };
    });
}

function agentScopedWorkspaceFindings(
  policy: unknown,
  policyPath: string,
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  if (!hasValidScopedPolicy(policy, policyPath, policyDocName)) {
    return [];
  }
  const findings: HealthFinding[] = [];
  for (const target of agentScopedPolicyTargets(policy)) {
    const scopedAgents = isRecord(target.overlay.agents) ? target.overlay.agents : {};
    const workspace = isRecord(scopedAgents.workspace) ? scopedAgents.workspace : {};
    const requirementBase = `scopes/${ocPathSegment(target.scopeName)}/agents/workspace`;
    const evidenceFilter = (entry: PolicyAgentWorkspaceEvidence) =>
      scopedWorkspaceAgentMatches(entry, target.agentId, evidence.agentWorkspace ?? []);
    findings.push(
      ...agentWorkspaceAccessFindings(
        { workspace },
        ["workspace", "allowedAccess"],
        policyDocName,
        `${requirementBase}/allowedAccess`,
        evidence,
        evidenceFilter,
      ),
      ...agentWorkspaceToolDenyFindings(
        { workspace },
        ["workspace", "denyTools"],
        policyDocName,
        `${requirementBase}/denyTools`,
        evidence,
        evidenceFilter,
      ),
    );
  }
  return findings;
}
