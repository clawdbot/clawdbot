import type { HealthCheckContext, HealthFinding } from "openclaw/plugin-sdk/health";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  collectPolicyEvidence,
  createPolicyAttestation,
  policyDocumentHash,
  type PolicyEvidence,
} from "../policy-state.js";
import {
  authProfileMetadataRequirementFindings,
  invalidChannelDenyRuleFindings,
} from "./access-findings.js";
import { agentWorkspaceFindings } from "./agent-workspace-findings.js";
import { CHECK_IDS, POLICY_CHECK_IDS } from "./check-ids.js";
import { dataHandlingFindings, secretAuthProvenanceFindings } from "./data-auth-findings.js";
import { execApprovalsFindings } from "./exec-approval-findings.js";
import { ingressFindings } from "./ingress-findings.js";
import { SUPPORTED_TOOL_METADATA } from "./policy-constants.js";
import {
  execApprovalsDisplayName,
  parsePolicyFile,
  policyChecksEnabled,
  policyDisplayName,
  policySettings,
  readChannelDenyRules,
  readExecApprovalsFile,
  readPolicyFile,
  readWorkspaceFile,
  requiredToolMetadata,
  type PolicySettings,
} from "./policy-runtime.js";
import {
  policyHasAgentWorkspaceRules,
  policyHasAuthProfileRules,
  policyHasDataHandlingRules,
  policyHasExecApprovalsRules,
  policyHasGatewayRules,
  policyHasIngressRules,
  policyHasSandboxPostureRules,
  policyHasSecretRules,
  policyHasToolPostureRules,
} from "./policy-scope.js";
import { policyContainerShapeFindings } from "./policy-shape.js";
import { sandboxPostureFindings } from "./sandbox-findings.js";
import { gatewayExposureFindings } from "./scopes/gateway.js";
import {
  mcpServerFindings,
  modelProviderFindings,
  networkFindings,
} from "./scopes/model-network.js";
import {
  toolOwnerFindings,
  toolPostureFindings,
  toolRiskFindings,
  toolSensitivityFindings,
  toolUnknownRiskFindings,
} from "./tool-findings.js";
import type { PolicyEvaluation } from "./types.js";

const policyEvaluationCache = new WeakMap<HealthCheckContext, Promise<PolicyEvaluation>>();

export function evaluatePolicy(ctx: HealthCheckContext): Promise<PolicyEvaluation> {
  const cached = policyEvaluationCache.get(ctx);
  if (cached !== undefined) {
    return cached;
  }
  const next = evaluatePolicyUncached(ctx);
  policyEvaluationCache.set(ctx, next);
  return next;
}

async function evaluatePolicyUncached(ctx: HealthCheckContext): Promise<PolicyEvaluation> {
  const settings = policySettings(ctx);
  const policyPath = policyDisplayName(ctx);
  let evidence: PolicyEvidence = collectPolicyEvidence(ctx.cfg as Record<string, unknown>, {
    includeIngress: false,
    includeGatewayExposure: false,
    includeAgentWorkspace: false,
    includeToolPosture: false,
    includeSandboxPosture: false,
    includeSecrets: false,
    includeAuthProfiles: false,
    includeExecApprovals: false,
  });
  const findings: HealthFinding[] = [];

  if (!policyChecksEnabled(ctx, settings)) {
    return {
      policyPath,
      evidence,
      expectedAttestationHash: settings.expectedAttestationHash,
      findings,
      attestedFindings: findings,
    };
  }

  const policyFile = await readPolicyFile(ctx);
  if (policyFile === null) {
    findings.push({
      checkId: CHECK_IDS.policyMissingFile,
      severity: "warning",
      message: `${policyPath} is missing for the enabled Policy plugin.`,
      source: "policy",
      path: policyPath,
      fixHint: `Restore ${policyPath} or add the policy artifact for this workspace.`,
    });
    return {
      policyPath,
      evidence,
      expectedAttestationHash: settings.expectedAttestationHash,
      findings,
      attestedFindings: findings,
    };
  }

  const parsedPolicy = parsePolicyFile(policyFile.raw);
  if (!parsedPolicy.ok) {
    findings.push(policyParseFinding(policyFile.displayName, policyFile.ocDocName, parsedPolicy));
    return {
      policyPath,
      evidence,
      expectedAttestationHash: settings.expectedAttestationHash,
      findings,
      attestedFindings: findings,
    };
  }

  const policy = parsedPolicy.value;
  const policyHash = policyDocumentHash(policy);
  const expectedHash = settings.expectedHash;
  if (
    typeof expectedHash === "string" &&
    expectedHash.trim() !== "" &&
    policyHash !== expectedHash.trim()
  ) {
    findings.push({
      checkId: CHECK_IDS.policyHashMismatch,
      severity: "error",
      message: `${policyFile.displayName} does not match the configured policy hash.`,
      source: "policy",
      path: policyFile.displayName,
      target: `oc://${policyFile.ocDocName}`,
      requirement: "oc://openclaw.config/plugins/entries/policy/config/expectedHash",
      fixHint: `Restore the approved policy artifact or update plugins.entries.policy.config.expectedHash after review.`,
    });
    return {
      policyPath,
      policy: { value: policy, hash: policyHash },
      evidence,
      expectedAttestationHash: settings.expectedAttestationHash,
      findings,
      attestedFindings: findings,
    };
  }

  const metadataRequirementFindings = toolMetadataRequirementFindings(
    policy,
    policyFile.displayName,
    policyFile.ocDocName,
  );
  const authMetadataRequirementFindings = authProfileMetadataRequirementFindings(
    policy,
    policyFile.displayName,
    policyFile.ocDocName,
  );
  const requiredMetadata =
    metadataRequirementFindings.length === 0 ? requiredToolMetadata(policy) : new Set<string>();
  const includeSecrets = policyHasSecretRules(policy);
  const includeAuthProfiles = policyHasAuthProfileRules(policy);
  const includeIngress = policyHasIngressRules(policy);
  const includeGatewayExposure = policyHasGatewayRules(policy);
  const includeAgentWorkspace = policyHasAgentWorkspaceRules(policy);
  const includeDataHandling = policyHasDataHandlingRules(policy);
  const includeSandboxPosture = policyHasSandboxPostureRules(policy);
  const includeExecApprovals = policyHasExecApprovalsRules(policy);
  const execApprovalsFile = includeExecApprovals ? await readExecApprovalsFile(ctx) : undefined;
  if (requiredMetadata.size > 0) {
    const toolsFile = await readWorkspaceFile(ctx, "TOOLS.md");
    evidence = await collectPolicyEvidence(ctx.cfg as Record<string, unknown>, {
      toolsRaw: toolsFile?.raw ?? "",
      includeIngress,
      includeGatewayExposure,
      includeAgentWorkspace,
      includeDataHandling,
      includeToolPosture: policyHasToolPostureRules(policy),
      includeSandboxPosture,
      includeSecrets,
      includeAuthProfiles,
      includeExecApprovals,
      execApprovalsRaw: includeExecApprovals ? (execApprovalsFile?.raw ?? null) : undefined,
    });
  } else {
    evidence = collectPolicyEvidence(ctx.cfg as Record<string, unknown>, {
      includeIngress,
      includeGatewayExposure,
      includeAgentWorkspace,
      includeDataHandling,
      includeToolPosture: policyHasToolPostureRules(policy),
      includeSandboxPosture,
      includeSecrets,
      includeAuthProfiles,
      includeExecApprovals,
      execApprovalsRaw: includeExecApprovals ? (execApprovalsFile?.raw ?? null) : undefined,
    });
  }
  const policyFindings: HealthFinding[] = [
    ...policyContainerShapeFindings(policy, policyFile.displayName, policyFile.ocDocName),
    ...channelFindings(policy, policyFile.displayName, policyFile.ocDocName, evidence),
    ...mcpServerFindings(policy, policyFile.ocDocName, evidence),
    ...modelProviderFindings(policy, policyFile.ocDocName, evidence),
    ...networkFindings(policy, policyFile.ocDocName, evidence),
    ...ingressFindings(policy, policyFile.displayName, policyFile.ocDocName, evidence),
    ...gatewayExposureFindings(policy, policyFile.ocDocName, evidence),
    ...agentWorkspaceFindings(policy, policyFile.displayName, policyFile.ocDocName, evidence),
    ...toolPostureFindings(policy, policyFile.displayName, policyFile.ocDocName, evidence),
    ...sandboxPostureFindings(policy, policyFile.displayName, policyFile.ocDocName, evidence),
    ...dataHandlingFindings(policy, policyFile.displayName, policyFile.ocDocName, evidence),
    ...secretAuthProvenanceFindings(policy, policyFile.displayName, policyFile.ocDocName, evidence),
    ...execApprovalsFindings(
      policy,
      policyFile.displayName,
      policyFile.ocDocName,
      evidence,
      execApprovalsFile,
      execApprovalsDisplayName(),
    ),
    ...authMetadataRequirementFindings,
    ...metadataRequirementFindings,
  ];
  if (requiredMetadata.has("risk")) {
    policyFindings.push(...toolRiskFindings(policyFile.ocDocName, evidence));
    policyFindings.push(...toolUnknownRiskFindings(policyFile.ocDocName, evidence));
  }
  if (requiredMetadata.has("sensitivity")) {
    policyFindings.push(...toolSensitivityFindings(policyFile.ocDocName, evidence));
  }
  if (requiredMetadata.has("owner")) {
    policyFindings.push(...toolOwnerFindings(policyFile.ocDocName, evidence));
  }
  const attestationFindings = policyAttestationFindings(
    policyFile.displayName,
    policyHash,
    evidence,
    policyFindings,
    settings,
  );
  if (hasPolicyValidationFinding(policyFindings)) {
    findings.push(...policyFindings);
  } else if (attestationFindings.length > 0) {
    findings.push(...attestationFindings);
  } else {
    findings.push(...policyFindings);
  }

  return {
    policyPath,
    policy: { value: policy, hash: policyHash },
    evidence,
    expectedAttestationHash: settings.expectedAttestationHash,
    findings,
    attestedFindings: policyFindings,
  };
}

function policyParseFinding(
  policyPath: string,
  policyDocName: string,
  parseError: { readonly message: string },
): HealthFinding {
  return {
    checkId: CHECK_IDS.policyInvalidFile,
    severity: "error",
    message: `${policyPath} could not be parsed: ${parseError.message}`,
    source: "policy",
    path: policyPath,
    target: `oc://${policyDocName}`,
    fixHint: `Fix ${policyPath} so policy conformance checks can run.`,
  };
}

export function findingsForCheck(
  evaluation: PolicyEvaluation,
  checkId: (typeof POLICY_CHECK_IDS)[number],
): readonly HealthFinding[] {
  return evaluation.findings.filter((finding) => finding.checkId === checkId);
}

function hasPolicyValidationFinding(findings: readonly HealthFinding[]): boolean {
  return findings.some((finding) => finding.checkId === CHECK_IDS.policyInvalidFile);
}

function channelFindings(
  policy: unknown,
  policyPath: string,
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  const invalidRules = invalidChannelDenyRuleFindings(policy, policyPath, policyDocName);
  if (invalidRules.length > 0) {
    return invalidRules;
  }
  const denyRules = readChannelDenyRules(policy, policyDocName);
  if (denyRules.length === 0) {
    return [];
  }
  return evidence.channels.flatMap((channel): HealthFinding[] => {
    if (channel.enabled === false) {
      return [];
    }
    const rule = denyRules.find((candidate) => candidate.when?.provider === channel.provider);
    if (rule === undefined) {
      return [];
    }
    return [
      {
        checkId: CHECK_IDS.policyDeniedChannelProvider,
        severity: "error",
        message: `Channel '${channel.id}' uses denied provider '${channel.provider}'.`,
        source: "policy",
        path: "openclaw config",
        ocPath: channel.source,
        target: channel.source,
        requirement: rule.requirement,
        fixHint:
          rule.reason ??
          "Disable this channel, remove it from config, or update the policy deny rule.",
      },
    ];
  });
}

function policyAttestationFindings(
  policyPath: string,
  policyHash: string,
  evidence: PolicyEvidence,
  findings: readonly HealthFinding[],
  settings: PolicySettings,
): readonly HealthFinding[] {
  const expected = settings.expectedAttestationHash?.trim();
  if (!expected) {
    return [];
  }
  const current = createPolicyAttestation({
    ok: findings.length === 0,
    checkedAt: new Date(0).toISOString(),
    policyPath,
    policyHash,
    evidence,
    findings: findings.map(toAttestedFinding),
  });
  if (current.attestationHash === expected) {
    return [];
  }
  return [
    {
      checkId: CHECK_IDS.policyAttestationMismatch,
      severity: "error",
      message: "The current policy check no longer matches the accepted policy attestation.",
      source: "policy",
      path: "policy attestation",
      target: "oc://policy/attestation/current",
      requirement: "oc://openclaw.config/plugins/entries/policy/config/expectedAttestationHash",
      fixHint: `Run policy check, review attestation ${current.attestationHash}, then update plugins.entries.policy.config.expectedAttestationHash and the supervisor/gateway accepted attestation.`,
    },
  ];
}

function toAttestedFinding(finding: HealthFinding): Record<string, unknown> {
  return {
    checkId: finding.checkId,
    severity: finding.severity,
    message: finding.message,
    ...(finding.source !== undefined ? { source: finding.source } : {}),
    ...(finding.path !== undefined ? { path: finding.path } : {}),
    ...(finding.line !== undefined ? { line: finding.line } : {}),
    ...(finding.column !== undefined ? { column: finding.column } : {}),
    ...(finding.ocPath !== undefined ? { ocPath: finding.ocPath } : {}),
    ...(finding.target !== undefined ? { target: finding.target } : {}),
    ...(finding.requirement !== undefined ? { requirement: finding.requirement } : {}),
    ...(finding.fixHint !== undefined ? { fixHint: finding.fixHint } : {}),
  };
}

function toolMetadataRequirementFindings(
  policy: unknown,
  policyPath: string,
  policyDocName: string,
): readonly HealthFinding[] {
  if (!isRecord(policy) || !isRecord(policy.tools) || policy.tools.requireMetadata === undefined) {
    return [];
  }
  if (!Array.isArray(policy.tools.requireMetadata)) {
    return [
      {
        checkId: CHECK_IDS.policyInvalidFile,
        severity: "error",
        message: `${policyPath} tools.requireMetadata must be an array of metadata keys.`,
        source: "policy",
        path: policyPath,
        target: `oc://${policyDocName}/tools/requireMetadata`,
        fixHint: `Use supported metadata keys: ${SUPPORTED_TOOL_METADATA.join(", ")}.`,
      },
    ];
  }
  const invalidIndex = policy.tools.requireMetadata.findIndex(
    (entry) =>
      typeof entry !== "string" ||
      !SUPPORTED_TOOL_METADATA.includes(
        entry.trim().toLowerCase() as (typeof SUPPORTED_TOOL_METADATA)[number],
      ),
  );
  if (invalidIndex < 0) {
    return [];
  }
  return [
    {
      checkId: CHECK_IDS.policyInvalidFile,
      severity: "error",
      message: `${policyPath} tools.requireMetadata[${invalidIndex}] must be a supported metadata key.`,
      source: "policy",
      path: policyPath,
      target: `oc://${policyDocName}/tools/requireMetadata/#${invalidIndex}`,
      fixHint: `Use supported metadata keys: ${SUPPORTED_TOOL_METADATA.join(", ")}.`,
    },
  ];
}
