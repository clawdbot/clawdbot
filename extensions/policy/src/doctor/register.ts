// Policy plugin module implements register behavior.
import os from "node:os";
import { basename, isAbsolute, resolve } from "node:path";
import JSON5 from "json5";
import {
  registerHealthCheck as registerPluginHealthCheck,
  type HealthCheck,
  type HealthCheckContext,
  type HealthFinding,
} from "openclaw/plugin-sdk/health";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import { isRecord, uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  collectPolicyEvidence,
  createPolicyAttestation,
  policyDocumentHash,
  type PolicyAuthProfileEvidence,
  type PolicyAgentWorkspaceEvidence,
  type PolicyDataHandlingEvidence,
  type PolicyEvidence,
  type PolicyExecApprovalEvidence,
  type PolicyIngressEvidence,
  type PolicySandboxPostureEvidence,
  type PolicyToolPostureEvidence,
} from "../policy-state.js";
import { POLICY_TOOL_GROUPS } from "../tool-policy-conformance.js";

const loadFsPromisesModule = createLazyRuntimeModule(() => import("node:fs/promises"));

import { createPolicyDoctorChecks } from "./checks.js";
import {
  CHECK_IDS,
  POLICY_CHECK_IDS,
  POLICY_RULE_METADATA,
  SANDBOX_CONTAINER_POLICY_RULES,
  type PolicyRuleMetadata,
  type PolicyScopeSelectorKind,
} from "./metadata.js";
import { gatewayExposureFindings } from "./scopes/gateway.js";
import {
  mcpServerFindings,
  modelProviderFindings,
  networkFindings,
} from "./scopes/model-network.js";
import { isPolicyValueAtLeastAsStrict } from "./strictness.js";
import type { PolicyEvaluation } from "./types.js";
import {
  ocPathSegment,
  readPolicyBoolean,
  readPolicyStringArray,
  readString,
  readStringList,
} from "./utils.js";
export {
  POLICY_CHECK_IDS,
  POLICY_RULE_METADATA,
  SANDBOX_CONTAINER_POLICY_RULES,
  type PolicyEmptyListSemantics,
  type PolicyRuleMetadata,
  type PolicyScopeSelectorKind,
  type PolicyStrictnessKind,
} from "./metadata.js";
export { isPolicyValueAtLeastAsStrict } from "./strictness.js";
export type { PolicyEvaluation } from "./types.js";

const POLICY_RULES: readonly PolicyRuleMetadata[] = POLICY_RULE_METADATA;

const KNOWN_RISK_LEVELS = ["low", "medium", "high", "critical"] as const;
const KNOWN_SENSITIVITY_LEVELS = ["public", "internal", "confidential", "restricted"] as const;
const SUPPORTED_TOOL_METADATA = ["risk", "sensitivity", "owner"] as const;
const SUPPORTED_AUTH_PROFILE_METADATA = ["provider", "mode"] as const;
const SUPPORTED_AUTH_PROFILE_MODES = ["api_key", "aws-sdk", "oauth", "token"] as const;
const SUPPORTED_POLICY_SECTIONS = [
  "auth",
  "agents",
  "channels",
  "dataHandling",
  "execApprovals",
  "gateway",
  "ingress",
  "mcp",
  "models",
  "network",
  "sandbox",
  "scopes",
  "secrets",
  "tools",
] as const;
const SUPPORTED_GATEWAY_POLICY_SECTIONS = [
  "auth",
  "controlUi",
  "exposure",
  "http",
  "nodes",
  "remote",
] as const;
const SUPPORTED_GATEWAY_HTTP_ENDPOINTS = ["chatCompletions", "responses"] as const;
const SUPPORTED_DM_POLICIES = ["pairing", "allowlist", "open", "disabled"] as const;
const SUPPORTED_DM_SCOPES = [
  "main",
  "per-peer",
  "per-channel-peer",
  "per-account-channel-peer",
] as const;
const SUPPORTED_AGENT_WORKSPACE_DENY_TOOLS = [
  "exec",
  "process",
  "write",
  "edit",
  "apply_patch",
] as const;
const SUPPORTED_TOOL_PROFILES = ["minimal", "coding", "messaging", "full"] as const;
const SUPPORTED_TOOL_EXEC_SECURITY = ["deny", "allowlist", "full"] as const;
const SUPPORTED_TOOL_EXEC_ASK = ["off", "on-miss", "always"] as const;
const SUPPORTED_TOOL_EXEC_HOST = ["auto", "sandbox", "gateway", "node"] as const;
const SUPPORTED_EXEC_APPROVAL_SECURITY = ["deny", "allowlist", "full"] as const;
const SUPPORTED_SANDBOX_MODES = ["off", "non-main", "all"] as const;
let registered = false;
const policyEvaluationCache = new WeakMap<HealthCheckContext, Promise<PolicyEvaluation>>();

type PolicyDoctorRegistrationHost = {
  readonly registerHealthCheck: (check: HealthCheck) => void;
};

export function registerPolicyDoctorChecks(host?: PolicyDoctorRegistrationHost): void {
  if (registered) {
    return;
  }
  const registerHealthCheck = host?.registerHealthCheck ?? registerPluginHealthCheck;
  for (const check of createPolicyDoctorChecks({
    channelIdsFromFindings,
    disableChannels,
    evaluatePolicy,
    findingsForCheck,
    workspaceRepairsDisabledResult,
    workspaceRepairsEnabled,
  })) {
    registerHealthCheck(check);
  }
  registered = true;
}

export function resetPolicyDoctorChecksForTest(): void {
  registered = false;
}

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

function findingsForCheck(
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

export function policyContainerShapeFindings(
  policy: unknown,
  policyPath: string,
  policyDocName: string,
): readonly HealthFinding[] {
  if (!isRecord(policy)) {
    return [
      policyShapeFinding(
        policyPath,
        `oc://${policyDocName}`,
        `${policyPath} must contain a policy object.`,
        `Fix ${policyPath} so the top-level policy is an object.`,
      ),
    ];
  }
  const unsupportedTopLevel = unsupportedPolicyKey(policy, SUPPORTED_POLICY_SECTIONS);
  if (unsupportedTopLevel !== undefined) {
    return [
      policyShapeFinding(
        policyPath,
        `oc://${policyDocName}/${ocPathSegment(unsupportedTopLevel)}`,
        `${policyPath} ${unsupportedTopLevel} is not a supported policy section.`,
        `Remove ${unsupportedTopLevel} or use a supported policy section.`,
      ),
    ];
  }
  if (policy.tools !== undefined && !isRecord(policy.tools)) {
    return [
      policyShapeFinding(
        policyPath,
        `oc://${policyDocName}/tools`,
        `${policyPath} tools must be an object.`,
        `Fix ${policyPath} so tools is an object.`,
      ),
    ];
  }
  if (isRecord(policy.tools)) {
    const postureFinding = toolPosturePolicyShapeFinding(policy.tools, {
      policyDocName,
      policyPath,
    });
    if (postureFinding !== undefined) {
      return [postureFinding];
    }
  }
  if (policy.channels !== undefined && !isRecord(policy.channels)) {
    return [
      policyShapeFinding(
        policyPath,
        `oc://${policyDocName}/channels`,
        `${policyPath} channels must be an object.`,
        `Fix ${policyPath} so channels is an object.`,
      ),
    ];
  }
  if (isRecord(policy.channels)) {
    const unsupportedChannelKey = unsupportedPolicyKey(policy.channels, ["denyRules"]);
    if (unsupportedChannelKey !== undefined) {
      return [
        policyShapeFinding(
          policyPath,
          `oc://${policyDocName}/channels/${ocPathSegment(unsupportedChannelKey)}`,
          `${policyPath} channels.${unsupportedChannelKey} is not supported in channel policy.`,
          `Remove channels.${unsupportedChannelKey} or use channels.denyRules.`,
        ),
      ];
    }
  }
  if (policy.mcp !== undefined && !isRecord(policy.mcp)) {
    return [
      policyShapeFinding(
        policyPath,
        `oc://${policyDocName}/mcp`,
        `${policyPath} mcp must be an object.`,
        `Fix ${policyPath} so mcp is an object.`,
      ),
    ];
  }
  if (isRecord(policy.mcp)) {
    const unsupportedMcpKey = unsupportedPolicyKey(policy.mcp, ["servers"]);
    if (unsupportedMcpKey !== undefined) {
      return [
        policyShapeFinding(
          policyPath,
          `oc://${policyDocName}/mcp/${ocPathSegment(unsupportedMcpKey)}`,
          `${policyPath} mcp.${unsupportedMcpKey} is not supported in MCP policy.`,
          `Remove mcp.${unsupportedMcpKey} or use mcp.servers.`,
        ),
      ];
    }
  }
  if (policy.dataHandling !== undefined && !isRecord(policy.dataHandling)) {
    return [
      policyShapeFinding(
        policyPath,
        `oc://${policyDocName}/dataHandling`,
        `${policyPath} dataHandling must be an object.`,
        `Fix ${policyPath} so dataHandling is an object.`,
      ),
    ];
  }
  if (isRecord(policy.mcp)) {
    const finding = policyStringArrayShapeFinding(policy.mcp.servers, {
      property: "mcp.servers",
      policyDocName,
      policyPath,
      target: "mcp/servers",
      valueName: "MCP server id",
    });
    if (finding !== undefined) {
      return [finding];
    }
  }
  if (policy.models !== undefined && !isRecord(policy.models)) {
    return [
      policyShapeFinding(
        policyPath,
        `oc://${policyDocName}/models`,
        `${policyPath} models must be an object.`,
        `Fix ${policyPath} so models is an object.`,
      ),
    ];
  }
  if (isRecord(policy.models)) {
    const unsupportedModelsKey = unsupportedPolicyKey(policy.models, ["providers"]);
    if (unsupportedModelsKey !== undefined) {
      return [
        policyShapeFinding(
          policyPath,
          `oc://${policyDocName}/models/${ocPathSegment(unsupportedModelsKey)}`,
          `${policyPath} models.${unsupportedModelsKey} is not supported in model policy.`,
          `Remove models.${unsupportedModelsKey} or use models.providers.`,
        ),
      ];
    }
  }
  if (isRecord(policy.models)) {
    const finding = policyStringArrayShapeFinding(policy.models.providers, {
      property: "models.providers",
      policyDocName,
      policyPath,
      target: "models/providers",
      valueName: "model provider id",
    });
    if (finding !== undefined) {
      return [finding];
    }
  }
  if (policy.network !== undefined && !isRecord(policy.network)) {
    return [
      policyShapeFinding(
        policyPath,
        `oc://${policyDocName}/network`,
        `${policyPath} network must be an object.`,
        `Fix ${policyPath} so network is an object.`,
      ),
    ];
  }
  if (isRecord(policy.network)) {
    const unsupportedNetworkKey = unsupportedPolicyKey(policy.network, ["privateNetwork"]);
    if (unsupportedNetworkKey !== undefined) {
      return [
        policyShapeFinding(
          policyPath,
          `oc://${policyDocName}/network/${ocPathSegment(unsupportedNetworkKey)}`,
          `${policyPath} network.${unsupportedNetworkKey} is not supported in network policy.`,
          `Remove network.${unsupportedNetworkKey} or use network.privateNetwork.`,
        ),
      ];
    }
    if (policy.network.privateNetwork !== undefined && !isRecord(policy.network.privateNetwork)) {
      return [
        policyShapeFinding(
          policyPath,
          `oc://${policyDocName}/network/privateNetwork`,
          `${policyPath} network.privateNetwork must be an object.`,
          `Fix ${policyPath} so network.privateNetwork is an object.`,
        ),
      ];
    }
    if (isRecord(policy.network.privateNetwork)) {
      const unsupportedPrivateNetworkKey = unsupportedPolicyKey(policy.network.privateNetwork, [
        "allow",
      ]);
      if (unsupportedPrivateNetworkKey !== undefined) {
        return [
          policyShapeFinding(
            policyPath,
            `oc://${policyDocName}/network/privateNetwork/${ocPathSegment(unsupportedPrivateNetworkKey)}`,
            `${policyPath} network.privateNetwork.${unsupportedPrivateNetworkKey} is not supported in network policy.`,
            `Remove network.privateNetwork.${unsupportedPrivateNetworkKey} or use network.privateNetwork.allow.`,
          ),
        ];
      }
    }
    if (
      isRecord(policy.network.privateNetwork) &&
      policy.network.privateNetwork.allow !== undefined &&
      typeof policy.network.privateNetwork.allow !== "boolean"
    ) {
      return [
        policyShapeFinding(
          policyPath,
          `oc://${policyDocName}/network/privateNetwork/allow`,
          `${policyPath} network.privateNetwork.allow must be a boolean.`,
          `Fix ${policyPath} so network.privateNetwork.allow is true or false.`,
        ),
      ];
    }
  }
  if (policy.secrets !== undefined && !isRecord(policy.secrets)) {
    return [
      policyShapeFinding(
        policyPath,
        `oc://${policyDocName}/secrets`,
        `${policyPath} secrets must be an object.`,
        `Fix ${policyPath} so secrets is an object.`,
      ),
    ];
  }
  if (isRecord(policy.secrets)) {
    const unsupportedSecretsKey = unsupportedPolicyKey(policy.secrets, [
      "allowInsecureProviders",
      "denySources",
      "requireManagedProviders",
    ]);
    if (unsupportedSecretsKey !== undefined) {
      return [
        policyShapeFinding(
          policyPath,
          `oc://${policyDocName}/secrets/${ocPathSegment(unsupportedSecretsKey)}`,
          `${policyPath} secrets.${unsupportedSecretsKey} is not supported in secrets policy.`,
          `Remove secrets.${unsupportedSecretsKey} or use a supported secrets policy rule.`,
        ),
      ];
    }
  }
  if (policy.auth !== undefined && !isRecord(policy.auth)) {
    return [
      policyShapeFinding(
        policyPath,
        `oc://${policyDocName}/auth`,
        `${policyPath} auth must be an object.`,
        `Fix ${policyPath} so auth is an object.`,
      ),
    ];
  }
  if (isRecord(policy.auth)) {
    const unsupportedAuthKey = unsupportedPolicyKey(policy.auth, ["profiles"]);
    if (unsupportedAuthKey !== undefined) {
      return [
        policyShapeFinding(
          policyPath,
          `oc://${policyDocName}/auth/${ocPathSegment(unsupportedAuthKey)}`,
          `${policyPath} auth.${unsupportedAuthKey} is not supported in auth policy.`,
          `Remove auth.${unsupportedAuthKey} or use auth.profiles.`,
        ),
      ];
    }
  }
  if (
    isRecord(policy.auth) &&
    policy.auth.profiles !== undefined &&
    !isRecord(policy.auth.profiles)
  ) {
    return [
      policyShapeFinding(
        policyPath,
        `oc://${policyDocName}/auth/profiles`,
        `${policyPath} auth.profiles must be an object.`,
        `Fix ${policyPath} so auth.profiles is an object.`,
      ),
    ];
  }
  if (isRecord(policy.auth) && isRecord(policy.auth.profiles)) {
    const unsupportedProfilesKey = unsupportedPolicyKey(policy.auth.profiles, [
      "allowModes",
      "requireMetadata",
    ]);
    if (unsupportedProfilesKey !== undefined) {
      return [
        policyShapeFinding(
          policyPath,
          `oc://${policyDocName}/auth/profiles/${ocPathSegment(unsupportedProfilesKey)}`,
          `${policyPath} auth.profiles.${unsupportedProfilesKey} is not supported in auth profile policy.`,
          `Remove auth.profiles.${unsupportedProfilesKey} or use a supported auth profile policy rule.`,
        ),
      ];
    }
  }

  const execApprovalsFinding = execApprovalsPolicyShapeFinding(policy.execApprovals, {
    policyDocName,
    policyPath,
  });
  if (execApprovalsFinding !== undefined) {
    return [execApprovalsFinding];
  }
  const sandboxFinding = sandboxPolicyShapeFinding(policy.sandbox, {
    policyDocName,
    policyPath,
  });
  if (sandboxFinding !== undefined) {
    return [sandboxFinding];
  }
  const ingressFindingValue = ingressPolicyShapeFinding(policy.ingress, {
    policyDocName,
    policyPath,
  });
  if (ingressFindingValue !== undefined) {
    return [ingressFindingValue];
  }
  const gatewayFinding = gatewayPolicyShapeFinding(policy.gateway, {
    policyDocName,
    policyPath,
  });
  if (gatewayFinding !== undefined) {
    return [gatewayFinding];
  }
  const agentsFinding = agentsPolicyShapeFinding(policy.agents, {
    policyDocName,
    policyPath,
  });
  if (agentsFinding !== undefined) {
    return [agentsFinding];
  }
  const scopesFinding = scopedPolicyShapeFinding(policy.scopes, {
    policyDocName,
    policyPath,
    policy,
  });
  if (scopesFinding !== undefined) {
    return [scopesFinding];
  }
  return [];
}

function ingressPolicyShapeFinding(
  value: unknown,
  params: {
    readonly policyDocName: string;
    readonly policyPath: string;
    readonly targetPrefix?: string;
    readonly propertyPrefix?: string;
    readonly allowSession?: boolean;
  },
): HealthFinding | undefined {
  const targetPrefix = params.targetPrefix ?? "ingress";
  const propertyPrefix = params.propertyPrefix ?? "ingress";
  const allowSession = params.allowSession ?? true;
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${targetPrefix}`,
      `${params.policyPath} ${propertyPrefix} must be an object.`,
      `Fix ${params.policyPath} so ${propertyPrefix} is an object.`,
    );
  }
  if (!allowSession && value.session !== undefined) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${targetPrefix}/session`,
      `${params.policyPath} ${propertyPrefix}.session is not supported by the channelIds selector.`,
      `Move session ingress rules to top-level ingress; scoped ingress currently supports ingress.channels.*.`,
    );
  }
  const unsupportedIngressKey = unsupportedPolicyKey(value, ["channels", "session"]);
  if (unsupportedIngressKey !== undefined) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${targetPrefix}/${ocPathSegment(unsupportedIngressKey)}`,
      `${params.policyPath} ${propertyPrefix}.${unsupportedIngressKey} is not supported in ingress policy.`,
      `Remove ${propertyPrefix}.${unsupportedIngressKey} or use ingress.session or ingress.channels.`,
    );
  }
  for (const section of ["session", "channels"] as const) {
    if (value[section] !== undefined && !isRecord(value[section])) {
      return policyShapeFinding(
        params.policyPath,
        `oc://${params.policyDocName}/${targetPrefix}/${section}`,
        `${params.policyPath} ${propertyPrefix}.${section} must be an object.`,
        `Fix ${params.policyPath} so ${propertyPrefix}.${section} is an object.`,
      );
    }
  }
  const session = isRecord(value.session) ? value.session : {};
  const unsupportedSessionKey = unsupportedPolicyKey(session, ["requireDmScope"]);
  if (unsupportedSessionKey !== undefined) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${targetPrefix}/session/${ocPathSegment(unsupportedSessionKey)}`,
      `${params.policyPath} ${propertyPrefix}.session.${unsupportedSessionKey} is not supported in ingress policy.`,
      `Remove ${propertyPrefix}.session.${unsupportedSessionKey} or use ${propertyPrefix}.session.requireDmScope.`,
    );
  }
  if (
    session.requireDmScope !== undefined &&
    !SUPPORTED_DM_SCOPES.includes(session.requireDmScope as (typeof SUPPORTED_DM_SCOPES)[number])
  ) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${targetPrefix}/session/requireDmScope`,
      `${params.policyPath} ${propertyPrefix}.session.requireDmScope must be a supported DM scope.`,
      `Use supported DM scopes: ${SUPPORTED_DM_SCOPES.join(", ")}.`,
    );
  }
  const channels = isRecord(value.channels) ? value.channels : {};
  const unsupportedChannelsKey = unsupportedPolicyKey(channels, [
    "allowDmPolicies",
    "denyOpenGroups",
    "requireMentionInGroups",
  ]);
  if (unsupportedChannelsKey !== undefined) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${targetPrefix}/channels/${ocPathSegment(unsupportedChannelsKey)}`,
      `${params.policyPath} ${propertyPrefix}.channels.${unsupportedChannelsKey} is not supported in ingress policy.`,
      `Remove ${propertyPrefix}.channels.${unsupportedChannelsKey} or use a supported ingress channel policy rule.`,
    );
  }
  const allowDmPoliciesFinding = policyStringArrayPropertyShapeFinding(channels.allowDmPolicies, {
    allowed: SUPPORTED_DM_POLICIES,
    policyDocName: params.policyDocName,
    policyPath: params.policyPath,
    property: `${propertyPrefix}.channels.allowDmPolicies`,
    target: `${targetPrefix}/channels/allowDmPolicies`,
    valueName: "DM policy",
  });
  if (allowDmPoliciesFinding !== undefined) {
    return allowDmPoliciesFinding;
  }
  for (const key of ["denyOpenGroups", "requireMentionInGroups"] as const) {
    if (channels[key] !== undefined && typeof channels[key] !== "boolean") {
      return policyShapeFinding(
        params.policyPath,
        `oc://${params.policyDocName}/${targetPrefix}/channels/${key}`,
        `${params.policyPath} ${propertyPrefix}.channels.${key} must be a boolean.`,
        `Set ${propertyPrefix}.channels.${key} to true or false.`,
      );
    }
  }
  return undefined;
}

function execApprovalsPolicyShapeFinding(
  value: unknown,
  params: {
    readonly policyDocName: string;
    readonly policyPath: string;
    readonly targetPrefix?: string;
    readonly propertyPrefix?: string;
    readonly allowDefaults?: boolean;
  },
): HealthFinding | undefined {
  const targetPrefix = params.targetPrefix ?? "execApprovals";
  const propertyPrefix = params.propertyPrefix ?? "execApprovals";
  const allowDefaults = params.allowDefaults ?? true;
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${targetPrefix}`,
      `${params.policyPath} ${propertyPrefix} must be an object.`,
      `Fix ${params.policyPath} so ${propertyPrefix} is an object.`,
    );
  }
  const unsupportedTopLevel = unsupportedPolicyKey(
    value,
    allowDefaults ? ["agents", "defaults", "requireFile"] : ["agents"],
  );
  if (unsupportedTopLevel !== undefined) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${targetPrefix}/${ocPathSegment(unsupportedTopLevel)}`,
      `${params.policyPath} ${propertyPrefix}.${unsupportedTopLevel} is not supported in exec approvals policy.`,
      `Remove ${propertyPrefix}.${unsupportedTopLevel} or use a supported execApprovals rule.`,
    );
  }
  if (value.requireFile !== undefined && typeof value.requireFile !== "boolean") {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${targetPrefix}/requireFile`,
      `${params.policyPath} ${propertyPrefix}.requireFile must be a boolean.`,
      `Set execApprovals.requireFile to true or false.`,
    );
  }
  for (const section of (allowDefaults ? ["defaults", "agents"] : ["agents"]) as readonly (
    | "agents"
    | "defaults"
  )[]) {
    if (value[section] !== undefined && !isRecord(value[section])) {
      return policyShapeFinding(
        params.policyPath,
        `oc://${params.policyDocName}/${targetPrefix}/${section}`,
        `${params.policyPath} ${propertyPrefix}.${section} must be an object.`,
        `Fix ${params.policyPath} so ${propertyPrefix}.${section} is an object.`,
      );
    }
  }
  const defaults = allowDefaults && isRecord(value.defaults) ? value.defaults : {};
  const unsupportedDefaultsKey = unsupportedPolicyKey(defaults, ["allowSecurity"]);
  if (unsupportedDefaultsKey !== undefined) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${targetPrefix}/defaults/${ocPathSegment(unsupportedDefaultsKey)}`,
      `${params.policyPath} ${propertyPrefix}.defaults.${unsupportedDefaultsKey} is not supported in exec approvals policy.`,
      `Use execApprovals.defaults.allowSecurity or remove the unsupported rule.`,
    );
  }
  const defaultsSecurityFinding = policyStringArrayPropertyShapeFinding(defaults.allowSecurity, {
    allowed: SUPPORTED_EXEC_APPROVAL_SECURITY,
    policyDocName: params.policyDocName,
    policyPath: params.policyPath,
    property: `${propertyPrefix}.defaults.allowSecurity`,
    target: `${targetPrefix}/defaults/allowSecurity`,
    valueName: "exec approval security mode",
  });
  if (defaultsSecurityFinding !== undefined) {
    return defaultsSecurityFinding;
  }
  const agents = isRecord(value.agents) ? value.agents : {};
  const unsupportedAgentsKey = unsupportedPolicyKey(agents, [
    "allowAutoAllowSkills",
    "allowSecurity",
    "allowlist",
  ]);
  if (unsupportedAgentsKey !== undefined) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${targetPrefix}/agents/${ocPathSegment(unsupportedAgentsKey)}`,
      `${params.policyPath} ${propertyPrefix}.agents.${unsupportedAgentsKey} is not supported in exec approvals policy.`,
      `Use execApprovals.agents.allowSecurity, execApprovals.agents.allowAutoAllowSkills, or execApprovals.agents.allowlist.expected.`,
    );
  }
  const agentSecurityFinding = policyStringArrayPropertyShapeFinding(agents.allowSecurity, {
    allowed: SUPPORTED_EXEC_APPROVAL_SECURITY,
    policyDocName: params.policyDocName,
    policyPath: params.policyPath,
    property: `${propertyPrefix}.agents.allowSecurity`,
    target: `${targetPrefix}/agents/allowSecurity`,
    valueName: "exec approval security mode",
  });
  if (agentSecurityFinding !== undefined) {
    return agentSecurityFinding;
  }
  if (
    agents.allowAutoAllowSkills !== undefined &&
    typeof agents.allowAutoAllowSkills !== "boolean"
  ) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${targetPrefix}/agents/allowAutoAllowSkills`,
      `${params.policyPath} ${propertyPrefix}.agents.allowAutoAllowSkills must be a boolean.`,
      `Set execApprovals.agents.allowAutoAllowSkills to true or false.`,
    );
  }
  if (agents.allowlist !== undefined && !isRecord(agents.allowlist)) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${targetPrefix}/agents/allowlist`,
      `${params.policyPath} ${propertyPrefix}.agents.allowlist must be an object.`,
      `Fix ${params.policyPath} so ${propertyPrefix}.agents.allowlist is an object.`,
    );
  }
  const allowlist = isRecord(agents.allowlist) ? agents.allowlist : {};
  const unsupportedAllowlistKey = unsupportedPolicyKey(allowlist, ["expected"]);
  if (unsupportedAllowlistKey !== undefined) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${targetPrefix}/agents/allowlist/${ocPathSegment(unsupportedAllowlistKey)}`,
      `${params.policyPath} ${propertyPrefix}.agents.allowlist.${unsupportedAllowlistKey} is not supported in exec approvals policy.`,
      `Use execApprovals.agents.allowlist.expected or remove the unsupported rule.`,
    );
  }
  return execApprovalAllowlistExpectedShapeFinding(allowlist.expected, {
    policyDocName: params.policyDocName,
    policyPath: params.policyPath,
    property: `${propertyPrefix}.agents.allowlist.expected`,
    target: `${targetPrefix}/agents/allowlist/expected`,
  });
}

function agentsPolicyShapeFinding(
  value: unknown,
  params: {
    readonly policyDocName: string;
    readonly policyPath: string;
  },
): HealthFinding | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/agents`,
      `${params.policyPath} agents must be an object.`,
      `Fix ${params.policyPath} so agents is an object.`,
    );
  }
  const unsupportedAgentsKey = unsupportedPolicyKey(value, ["workspace"]);
  if (unsupportedAgentsKey !== undefined) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/agents/${ocPathSegment(unsupportedAgentsKey)}`,
      `${params.policyPath} agents.${unsupportedAgentsKey} is not supported in agents policy.`,
      `Remove agents.${unsupportedAgentsKey} or use agents.workspace.`,
    );
  }
  const workspaceFinding = agentWorkspacePolicyShapeFinding(value.workspace, {
    policyDocName: params.policyDocName,
    policyPath: params.policyPath,
    targetPrefix: "agents/workspace",
    propertyPrefix: "agents.workspace",
  });
  if (workspaceFinding !== undefined) {
    return workspaceFinding;
  }
  return undefined;
}

function scopedPolicyShapeFinding(
  value: unknown,
  params: {
    readonly policyDocName: string;
    readonly policyPath: string;
    readonly policy: Record<string, unknown>;
  },
): HealthFinding | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/scopes`,
      `${params.policyPath} scopes must be an object.`,
      `Fix ${params.policyPath} so scopes maps scope names to policy overlays with selectors such as agentIds.`,
    );
  }
  for (const [scopeName, overlay] of Object.entries(value)) {
    const targetPrefix = `scopes/${ocPathSegment(scopeName)}`;
    if (!isRecord(overlay)) {
      return policyShapeFinding(
        params.policyPath,
        `oc://${params.policyDocName}/${targetPrefix}`,
        `${params.policyPath} scopes.${scopeName} must be an object.`,
        `Fix ${params.policyPath} so the named policy scope is an object.`,
      );
    }
    const hasAgentIds = overlay.agentIds !== undefined;
    const hasChannelIds = overlay.channelIds !== undefined;
    if (!hasAgentIds && !hasChannelIds) {
      return policyShapeFinding(
        params.policyPath,
        `oc://${params.policyDocName}/${targetPrefix}`,
        `${params.policyPath} scopes.${scopeName} must define at least one selector.`,
        `List agentIds for agent-scoped policy or channelIds for channel-scoped ingress policy.`,
      );
    }
    const agentIdsFinding = scopedSelectorShapeFinding(overlay.agentIds, {
      policyDocName: params.policyDocName,
      policyPath: params.policyPath,
      property: `scopes.${scopeName}.agentIds`,
      target: `${targetPrefix}/agentIds`,
      valueName: "agent id",
      normalize: normalizeAgentId,
    });
    if (agentIdsFinding !== undefined) {
      return agentIdsFinding;
    }
    const channelIdsFinding = scopedSelectorShapeFinding(overlay.channelIds, {
      policyDocName: params.policyDocName,
      policyPath: params.policyPath,
      property: `scopes.${scopeName}.channelIds`,
      target: `${targetPrefix}/channelIds`,
      valueName: "channel id",
      normalize: normalizePolicyChannelId,
    });
    if (channelIdsFinding !== undefined) {
      return channelIdsFinding;
    }
    if (overlay.ingress !== undefined && !hasChannelIds) {
      return policyShapeFinding(
        params.policyPath,
        `oc://${params.policyDocName}/${targetPrefix}/ingress`,
        `${params.policyPath} scopes.${scopeName}.ingress requires the channelIds selector.`,
        `Move global ingress rules to top-level ingress, or list channelIds for channel-scoped ingress policy.`,
      );
    }
    if (
      (overlay.agents !== undefined ||
        overlay.dataHandling !== undefined ||
        overlay.execApprovals !== undefined ||
        overlay.tools !== undefined ||
        overlay.sandbox !== undefined) &&
      !hasAgentIds
    ) {
      return policyShapeFinding(
        params.policyPath,
        `oc://${params.policyDocName}/${targetPrefix}`,
        `${params.policyPath} scopes.${scopeName} uses agent-scoped sections without agentIds.`,
        `List agentIds for agents.workspace, dataHandling.memory, tools, or sandbox policy sections.`,
      );
    }
    const unsupportedKey = Object.keys(overlay).find(
      (key) =>
        key !== "agentIds" &&
        key !== "channelIds" &&
        key !== "agents" &&
        key !== "dataHandling" &&
        key !== "execApprovals" &&
        key !== "tools" &&
        key !== "sandbox" &&
        key !== "ingress",
    );
    if (unsupportedKey !== undefined) {
      return policyShapeFinding(
        params.policyPath,
        `oc://${params.policyDocName}/${targetPrefix}/${ocPathSegment(unsupportedKey)}`,
        `${params.policyPath} scopes.${scopeName}.${unsupportedKey} is not a supported scoped policy section.`,
        `Use agentIds with agents.workspace, dataHandling.memory, execApprovals, tools, or sandbox, and channelIds with ingress.channels.`,
      );
    }
    if (overlay.dataHandling !== undefined && !isRecord(overlay.dataHandling)) {
      return policyShapeFinding(
        params.policyPath,
        `oc://${params.policyDocName}/${targetPrefix}/dataHandling`,
        `${params.policyPath} scopes.${scopeName}.dataHandling must be an object.`,
        `Fix ${params.policyPath} so the scoped dataHandling policy section is an object.`,
      );
    }
    if (isRecord(overlay.dataHandling)) {
      const scopedDataHandlingFinding = scopedDataHandlingPolicyShapeFinding(overlay.dataHandling, {
        policyPath: params.policyPath,
        policyDocName: params.policyDocName,
        targetPrefix,
        scopeName,
      });
      if (scopedDataHandlingFinding !== undefined) {
        return scopedDataHandlingFinding;
      }
    }
    if (overlay.agents !== undefined && !isRecord(overlay.agents)) {
      return policyShapeFinding(
        params.policyPath,
        `oc://${params.policyDocName}/${targetPrefix}/agents`,
        `${params.policyPath} scopes.${scopeName}.agents must be an object.`,
        `Fix ${params.policyPath} so the scoped agents policy section is an object.`,
      );
    }
    const scopedAgents = isRecord(overlay.agents) ? overlay.agents : {};
    const unsupportedAgentKey = Object.keys(scopedAgents).find((key) => key !== "workspace");
    if (unsupportedAgentKey !== undefined) {
      return policyShapeFinding(
        params.policyPath,
        `oc://${params.policyDocName}/${targetPrefix}/agents/${ocPathSegment(unsupportedAgentKey)}`,
        `${params.policyPath} scopes.${scopeName}.agents.${unsupportedAgentKey} is not supported by the agentIds selector.`,
        `Move the rule under agents.workspace or a supported scoped top-level section.`,
      );
    }
    const workspaceFinding = agentWorkspacePolicyShapeFinding(scopedAgents.workspace, {
      policyDocName: params.policyDocName,
      policyPath: params.policyPath,
      targetPrefix: `${targetPrefix}/agents/workspace`,
      propertyPrefix: `scopes.${scopeName}.agents.workspace`,
    });
    if (workspaceFinding !== undefined) {
      return workspaceFinding;
    }

    const scopedExecApprovalsFinding = execApprovalsPolicyShapeFinding(overlay.execApprovals, {
      policyDocName: params.policyDocName,
      policyPath: params.policyPath,
      targetPrefix: `${targetPrefix}/execApprovals`,
      propertyPrefix: `scopes.${scopeName}.execApprovals`,
      allowDefaults: false,
    });
    if (scopedExecApprovalsFinding !== undefined) {
      return scopedExecApprovalsFinding;
    }
    if (overlay.tools !== undefined && !isRecord(overlay.tools)) {
      return policyShapeFinding(
        params.policyPath,
        `oc://${params.policyDocName}/${targetPrefix}/tools`,
        `${params.policyPath} scopes.${scopeName}.tools must be an object.`,
        `Fix ${params.policyPath} so the scoped tools policy overlay is an object.`,
      );
    }
    if (isRecord(overlay.tools)) {
      const toolsFinding = scopedToolsPolicyShapeFinding(overlay.tools, {
        policyDocName: params.policyDocName,
        policyPath: params.policyPath,
        targetPrefix: `${targetPrefix}/tools`,
        propertyPrefix: `scopes.${scopeName}.tools`,
      });
      if (toolsFinding !== undefined) {
        return toolsFinding;
      }
    }
    const sandboxFinding = sandboxPolicyShapeFinding(overlay.sandbox, {
      policyDocName: params.policyDocName,
      policyPath: params.policyPath,
      targetPrefix: `${targetPrefix}/sandbox`,
      propertyPrefix: `scopes.${scopeName}.sandbox`,
    });
    if (sandboxFinding !== undefined) {
      return sandboxFinding;
    }
    const ingressFindingLocal = ingressPolicyShapeFinding(overlay.ingress, {
      policyDocName: params.policyDocName,
      policyPath: params.policyPath,
      targetPrefix: `${targetPrefix}/ingress`,
      propertyPrefix: `scopes.${scopeName}.ingress`,
      allowSession: false,
    });
    if (ingressFindingLocal !== undefined) {
      return ingressFindingLocal;
    }
  }
  return duplicateScopedPolicyFieldFinding(value, {
    policyDocName: params.policyDocName,
    policyPath: params.policyPath,
    policy: params.policy,
  });
}

function scopedDataHandlingPolicyShapeFinding(
  dataHandling: Record<string, unknown>,
  params: {
    readonly policyPath: string;
    readonly policyDocName: string;
    readonly targetPrefix: string;
    readonly scopeName: string;
  },
): HealthFinding | undefined {
  const unsupportedKey = Object.keys(dataHandling).find((key) => key !== "memory");
  if (unsupportedKey !== undefined) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${params.targetPrefix}/dataHandling/${ocPathSegment(unsupportedKey)}`,
      `${params.policyPath} scopes.${params.scopeName}.dataHandling.${unsupportedKey} is not a supported scoped policy section.`,
      `Move global data-handling rules to top-level dataHandling, or use dataHandling.memory with agentIds.`,
    );
  }
  if (dataHandling.memory !== undefined && !isRecord(dataHandling.memory)) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${params.targetPrefix}/dataHandling/memory`,
      `${params.policyPath} scopes.${params.scopeName}.dataHandling.memory must be an object.`,
      `Fix ${params.policyPath} so the scoped dataHandling.memory policy section is an object.`,
    );
  }
  if (!isRecord(dataHandling.memory)) {
    return undefined;
  }
  const unsupportedMemoryKey = Object.keys(dataHandling.memory).find(
    (key) => key !== "denySessionTranscriptIndexing",
  );
  if (unsupportedMemoryKey !== undefined) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${params.targetPrefix}/dataHandling/memory/${ocPathSegment(unsupportedMemoryKey)}`,
      `${params.policyPath} scopes.${params.scopeName}.dataHandling.memory.${unsupportedMemoryKey} is not a supported scoped policy rule.`,
      `Use dataHandling.memory.denySessionTranscriptIndexing or remove the unsupported rule.`,
    );
  }
  if (
    dataHandling.memory.denySessionTranscriptIndexing !== undefined &&
    typeof dataHandling.memory.denySessionTranscriptIndexing !== "boolean"
  ) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${params.targetPrefix}/dataHandling/memory/denySessionTranscriptIndexing`,
      `${params.policyPath} scopes.${params.scopeName}.dataHandling.memory.denySessionTranscriptIndexing must be a boolean.`,
      `Set dataHandling.memory.denySessionTranscriptIndexing to true or false.`,
    );
  }
  return undefined;
}

function scopedSelectorShapeFinding(
  value: unknown,
  params: {
    readonly policyDocName: string;
    readonly policyPath: string;
    readonly property: string;
    readonly target: string;
    readonly valueName: string;
    readonly normalize: (value: string) => string;
  },
): HealthFinding | undefined {
  const selectorFinding = policyStringArrayPropertyShapeFinding(value, {
    policyDocName: params.policyDocName,
    policyPath: params.policyPath,
    property: params.property,
    target: params.target,
    valueName: params.valueName,
  });
  if (selectorFinding !== undefined) {
    return selectorFinding;
  }
  if (value === undefined) {
    return undefined;
  }
  if (Array.isArray(value) && value.length === 0) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${params.target}`,
      `${params.policyPath} ${params.property} must include at least one ${params.valueName}.`,
      `Add one or more ${params.valueName}s to ${params.policyPath} ${params.property}.`,
    );
  }
  if (Array.isArray(value)) {
    const seen = new Map<string, number>();
    for (const [index, rawValue] of value.entries()) {
      if (typeof rawValue !== "string") {
        continue;
      }
      const normalized = params.normalize(rawValue);
      const previous = seen.get(normalized);
      if (previous !== undefined) {
        return policyShapeFinding(
          params.policyPath,
          `oc://${params.policyDocName}/${params.target}/#${index}`,
          `${params.policyPath} ${params.property}[${index}] duplicates ${params.property}[${previous}] after normalization.`,
          `List each ${params.valueName} only once per named policy scope.`,
        );
      }
      seen.set(normalized, index);
    }
  }
  return undefined;
}

function scopedToolsPolicyShapeFinding(
  value: Record<string, unknown>,
  params: {
    readonly policyDocName: string;
    readonly policyPath: string;
    readonly targetPrefix: string;
    readonly propertyPrefix: string;
  },
): HealthFinding | undefined {
  const allowedTopLevel = new Set(["profiles", "fs", "exec", "elevated", "alsoAllow", "denyTools"]);
  const unsupportedTopLevel = Object.keys(value).find((key) => !allowedTopLevel.has(key));
  if (unsupportedTopLevel !== undefined) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${params.targetPrefix}/${ocPathSegment(unsupportedTopLevel)}`,
      `${params.policyPath} ${params.propertyPrefix}.${unsupportedTopLevel} is not supported in agent-scoped tools policy.`,
      `Move ${params.propertyPrefix}.${unsupportedTopLevel} to top-level tools or use a supported scoped tools posture rule.`,
    );
  }
  for (const [section, allowedKeys] of [
    ["profiles", ["allow"]],
    ["fs", ["requireWorkspaceOnly"]],
    ["exec", ["allowSecurity", "requireAsk", "allowHosts"]],
    ["elevated", ["allow"]],
    ["alsoAllow", ["expected"]],
  ] as const) {
    const sectionValue = value[section];
    if (!isRecord(sectionValue)) {
      continue;
    }
    const allowed = new Set<string>(allowedKeys);
    const unsupportedKey = Object.keys(sectionValue).find((key) => !allowed.has(key));
    if (unsupportedKey !== undefined) {
      return policyShapeFinding(
        params.policyPath,
        `oc://${params.policyDocName}/${params.targetPrefix}/${section}/${ocPathSegment(unsupportedKey)}`,
        `${params.policyPath} ${params.propertyPrefix}.${section}.${unsupportedKey} is not supported in agent-scoped tools policy.`,
        `Move ${params.propertyPrefix}.${section}.${unsupportedKey} to top-level tools or use a supported scoped tools posture rule.`,
      );
    }
  }
  return toolPosturePolicyShapeFinding(value, params);
}

function agentWorkspacePolicyShapeFinding(
  value: unknown,
  params: {
    readonly policyDocName: string;
    readonly policyPath: string;
    readonly targetPrefix: string;
    readonly propertyPrefix: string;
  },
): HealthFinding | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${params.targetPrefix}`,
      `${params.policyPath} ${params.propertyPrefix} must be an object.`,
      `Fix ${params.policyPath} so ${params.propertyPrefix} is an object.`,
    );
  }
  const unsupportedWorkspaceKey = unsupportedPolicyKey(value, ["allowedAccess", "denyTools"]);
  if (unsupportedWorkspaceKey !== undefined) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${params.targetPrefix}/${ocPathSegment(unsupportedWorkspaceKey)}`,
      `${params.policyPath} ${params.propertyPrefix}.${unsupportedWorkspaceKey} is not supported in agent workspace policy.`,
      `Remove ${params.propertyPrefix}.${unsupportedWorkspaceKey} or use a supported agent workspace policy rule.`,
    );
  }
  const allowedAccess = value.allowedAccess;
  if (allowedAccess !== undefined && !Array.isArray(allowedAccess)) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${params.targetPrefix}/allowedAccess`,
      `${params.policyPath} ${params.propertyPrefix}.allowedAccess must be an array.`,
      'Use workspace access values such as ["none", "ro"].',
    );
  }
  if (Array.isArray(allowedAccess)) {
    const invalidIndex = allowedAccess.findIndex(
      (entry) => entry !== "none" && entry !== "ro" && entry !== "rw",
    );
    if (invalidIndex >= 0) {
      return policyShapeFinding(
        params.policyPath,
        `oc://${params.policyDocName}/${params.targetPrefix}/allowedAccess/#${invalidIndex}`,
        `${params.policyPath} ${params.propertyPrefix}.allowedAccess[${invalidIndex}] must be none, ro, or rw.`,
        'Use workspace access values such as ["none", "ro"].',
      );
    }
  }
  const denyTools = value.denyTools;
  if (denyTools !== undefined && !Array.isArray(denyTools)) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${params.targetPrefix}/denyTools`,
      `${params.policyPath} ${params.propertyPrefix}.denyTools must be an array.`,
      'Use tool ids such as ["exec", "process", "write", "edit", "apply_patch"].',
    );
  }
  if (Array.isArray(denyTools)) {
    const invalidIndex = denyTools.findIndex(
      (entry) =>
        typeof entry !== "string" ||
        !SUPPORTED_AGENT_WORKSPACE_DENY_TOOLS.includes(
          entry.trim() as (typeof SUPPORTED_AGENT_WORKSPACE_DENY_TOOLS)[number],
        ),
    );
    if (invalidIndex >= 0) {
      return policyShapeFinding(
        params.policyPath,
        `oc://${params.policyDocName}/${params.targetPrefix}/denyTools/#${invalidIndex}`,
        `${params.policyPath} ${params.propertyPrefix}.denyTools[${invalidIndex}] must be a supported agent workspace tool id.`,
        `Use supported tool ids: ${SUPPORTED_AGENT_WORKSPACE_DENY_TOOLS.join(", ")}.`,
      );
    }
  }
  return undefined;
}

function toolPosturePolicyShapeFinding(
  tools: Record<string, unknown>,
  params: {
    readonly policyDocName: string;
    readonly policyPath: string;
    readonly targetPrefix?: string;
    readonly propertyPrefix?: string;
  },
): HealthFinding | undefined {
  const targetPrefix = params.targetPrefix ?? "tools";
  const propertyPrefix = params.propertyPrefix ?? "tools";
  const allowedTopLevel = [
    "alsoAllow",
    "denyTools",
    "elevated",
    "exec",
    "fs",
    "profiles",
    "requireMetadata",
  ];
  const unsupportedTopLevel = unsupportedPolicyKey(tools, allowedTopLevel);
  if (unsupportedTopLevel !== undefined) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${targetPrefix}/${ocPathSegment(unsupportedTopLevel)}`,
      `${params.policyPath} ${propertyPrefix}.${unsupportedTopLevel} is not supported in tools policy.`,
      `Remove ${propertyPrefix}.${unsupportedTopLevel} or use a supported tools policy rule.`,
    );
  }
  for (const section of ["profiles", "fs", "exec", "elevated", "alsoAllow"] as const) {
    if (tools[section] !== undefined && !isRecord(tools[section])) {
      return policyShapeFinding(
        params.policyPath,
        `oc://${params.policyDocName}/${targetPrefix}/${section}`,
        `${params.policyPath} ${propertyPrefix}.${section} must be an object.`,
        `Fix ${params.policyPath} so ${propertyPrefix}.${section} is an object.`,
      );
    }
  }

  const profiles = isRecord(tools.profiles) ? tools.profiles : {};
  const unsupportedProfileKey = unsupportedPolicyKey(profiles, ["allow"]);
  if (unsupportedProfileKey !== undefined) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${targetPrefix}/profiles/${ocPathSegment(unsupportedProfileKey)}`,
      `${params.policyPath} ${propertyPrefix}.profiles.${unsupportedProfileKey} is not supported in tools policy.`,
      `Remove ${propertyPrefix}.profiles.${unsupportedProfileKey} or use ${propertyPrefix}.profiles.allow.`,
    );
  }
  const profileAllowFinding = policyStringArrayPropertyShapeFinding(profiles.allow, {
    allowed: SUPPORTED_TOOL_PROFILES,
    policyDocName: params.policyDocName,
    policyPath: params.policyPath,
    property: `${propertyPrefix}.profiles.allow`,
    target: `${targetPrefix}/profiles/allow`,
    valueName: "tool profile id",
  });
  if (profileAllowFinding !== undefined) {
    return profileAllowFinding;
  }

  const fs = isRecord(tools.fs) ? tools.fs : {};
  const unsupportedFsKey = unsupportedPolicyKey(fs, ["requireWorkspaceOnly"]);
  if (unsupportedFsKey !== undefined) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${targetPrefix}/fs/${ocPathSegment(unsupportedFsKey)}`,
      `${params.policyPath} ${propertyPrefix}.fs.${unsupportedFsKey} is not supported in tools policy.`,
      `Remove ${propertyPrefix}.fs.${unsupportedFsKey} or use ${propertyPrefix}.fs.requireWorkspaceOnly.`,
    );
  }
  if (fs.requireWorkspaceOnly !== undefined && typeof fs.requireWorkspaceOnly !== "boolean") {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${targetPrefix}/fs/requireWorkspaceOnly`,
      `${params.policyPath} ${propertyPrefix}.fs.requireWorkspaceOnly must be a boolean.`,
      `Set ${propertyPrefix}.fs.requireWorkspaceOnly to true or false.`,
    );
  }

  const exec = isRecord(tools.exec) ? tools.exec : {};
  const unsupportedExecKey = unsupportedPolicyKey(exec, [
    "allowHosts",
    "allowSecurity",
    "requireAsk",
  ]);
  if (unsupportedExecKey !== undefined) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${targetPrefix}/exec/${ocPathSegment(unsupportedExecKey)}`,
      `${params.policyPath} ${propertyPrefix}.exec.${unsupportedExecKey} is not supported in tools policy.`,
      `Remove ${propertyPrefix}.exec.${unsupportedExecKey} or use a supported tools exec policy rule.`,
    );
  }
  const execLists = [
    ["allowSecurity", SUPPORTED_TOOL_EXEC_SECURITY, "exec security mode"],
    ["requireAsk", SUPPORTED_TOOL_EXEC_ASK, "exec ask mode"],
    ["allowHosts", SUPPORTED_TOOL_EXEC_HOST, "exec host"],
  ] as const;
  for (const [key, supported, valueName] of execLists) {
    const finding = policyStringArrayPropertyShapeFinding(exec[key], {
      allowed: supported,
      policyDocName: params.policyDocName,
      policyPath: params.policyPath,
      property: `${propertyPrefix}.exec.${key}`,
      target: `${targetPrefix}/exec/${key}`,
      valueName,
    });
    if (finding !== undefined) {
      return finding;
    }
  }

  const elevated = isRecord(tools.elevated) ? tools.elevated : {};
  const unsupportedElevatedKey = unsupportedPolicyKey(elevated, ["allow"]);
  if (unsupportedElevatedKey !== undefined) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${targetPrefix}/elevated/${ocPathSegment(unsupportedElevatedKey)}`,
      `${params.policyPath} ${propertyPrefix}.elevated.${unsupportedElevatedKey} is not supported in tools policy.`,
      `Remove ${propertyPrefix}.elevated.${unsupportedElevatedKey} or use ${propertyPrefix}.elevated.allow.`,
    );
  }
  if (elevated.allow !== undefined && typeof elevated.allow !== "boolean") {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${targetPrefix}/elevated/allow`,
      `${params.policyPath} ${propertyPrefix}.elevated.allow must be a boolean.`,
      `Set ${propertyPrefix}.elevated.allow to true or false.`,
    );
  }

  const alsoAllow = isRecord(tools.alsoAllow) ? tools.alsoAllow : {};
  const unsupportedAlsoAllowKey = unsupportedPolicyKey(alsoAllow, ["expected"]);
  if (unsupportedAlsoAllowKey !== undefined) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${targetPrefix}/alsoAllow/${ocPathSegment(unsupportedAlsoAllowKey)}`,
      `${params.policyPath} ${propertyPrefix}.alsoAllow.${unsupportedAlsoAllowKey} is not supported in tools policy.`,
      `Remove ${propertyPrefix}.alsoAllow.${unsupportedAlsoAllowKey} or use ${propertyPrefix}.alsoAllow.expected.`,
    );
  }
  const alsoAllowExpectedFinding = policyStringArrayPropertyShapeFinding(alsoAllow.expected, {
    policyDocName: params.policyDocName,
    policyPath: params.policyPath,
    property: `${propertyPrefix}.alsoAllow.expected`,
    target: `${targetPrefix}/alsoAllow/expected`,
    valueName: "tool id",
  });
  if (alsoAllowExpectedFinding !== undefined) {
    return alsoAllowExpectedFinding;
  }

  const denyToolsFinding = policyStringArrayPropertyShapeFinding(tools.denyTools, {
    policyDocName: params.policyDocName,
    policyPath: params.policyPath,
    property: `${propertyPrefix}.denyTools`,
    target: `${targetPrefix}/denyTools`,
    valueName: "tool id or group",
  });
  return denyToolsFinding;
}

function sandboxPolicyShapeFinding(
  value: unknown,
  params: {
    readonly policyDocName: string;
    readonly policyPath: string;
    readonly targetPrefix?: string;
    readonly propertyPrefix?: string;
  },
): HealthFinding | undefined {
  const targetPrefix = params.targetPrefix ?? "sandbox";
  const propertyPrefix = params.propertyPrefix ?? "sandbox";
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${targetPrefix}`,
      `${params.policyPath} ${propertyPrefix} must be an object.`,
      `Fix ${params.policyPath} so ${propertyPrefix} is an object.`,
    );
  }
  const unsupportedTopLevel = unsupportedPolicyKey(value, [
    "requireMode",
    "allowBackends",
    "containers",
    "browser",
  ]);
  if (unsupportedTopLevel !== undefined) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${targetPrefix}/${ocPathSegment(unsupportedTopLevel)}`,
      `${params.policyPath} ${propertyPrefix}.${unsupportedTopLevel} is not supported in sandbox policy.`,
      `Remove ${propertyPrefix}.${unsupportedTopLevel} or use a supported sandbox posture rule.`,
    );
  }
  const modeFinding = policyStringArrayPropertyShapeFinding(value.requireMode, {
    allowed: SUPPORTED_SANDBOX_MODES,
    policyDocName: params.policyDocName,
    policyPath: params.policyPath,
    property: `${propertyPrefix}.requireMode`,
    target: `${targetPrefix}/requireMode`,
    valueName: "sandbox mode",
  });
  if (modeFinding !== undefined) {
    return modeFinding;
  }
  const backendFinding = policyStringArrayPropertyShapeFinding(value.allowBackends, {
    policyDocName: params.policyDocName,
    policyPath: params.policyPath,
    property: `${propertyPrefix}.allowBackends`,
    target: `${targetPrefix}/allowBackends`,
    valueName: "sandbox backend id",
  });
  if (backendFinding !== undefined) {
    return backendFinding;
  }
  for (const section of ["containers", "browser"] as const) {
    if (value[section] !== undefined && !isRecord(value[section])) {
      return policyShapeFinding(
        params.policyPath,
        `oc://${params.policyDocName}/${targetPrefix}/${section}`,
        `${params.policyPath} ${propertyPrefix}.${section} must be an object.`,
        `Fix ${params.policyPath} so ${propertyPrefix}.${section} is an object.`,
      );
    }
  }
  const containers = isRecord(value.containers) ? value.containers : {};
  const unsupportedContainerKey = unsupportedPolicyKey(
    containers,
    SANDBOX_CONTAINER_POLICY_RULES.map((rule) => rule.key),
  );
  if (unsupportedContainerKey !== undefined) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${targetPrefix}/containers/${ocPathSegment(unsupportedContainerKey)}`,
      `${params.policyPath} ${propertyPrefix}.containers.${unsupportedContainerKey} is not supported in sandbox policy.`,
      `Remove ${propertyPrefix}.containers.${unsupportedContainerKey} or use a supported sandbox container posture rule.`,
    );
  }
  for (const { key } of SANDBOX_CONTAINER_POLICY_RULES) {
    if (containers[key] !== undefined && typeof containers[key] !== "boolean") {
      return policyShapeFinding(
        params.policyPath,
        `oc://${params.policyDocName}/${targetPrefix}/containers/${key}`,
        `${params.policyPath} ${propertyPrefix}.containers.${key} must be a boolean.`,
        `Set ${propertyPrefix}.containers.${key} to true or false.`,
      );
    }
  }
  const browser = isRecord(value.browser) ? value.browser : {};
  const unsupportedBrowserKey = unsupportedPolicyKey(browser, ["requireCdpSourceRange"]);
  if (unsupportedBrowserKey !== undefined) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${targetPrefix}/browser/${ocPathSegment(unsupportedBrowserKey)}`,
      `${params.policyPath} ${propertyPrefix}.browser.${unsupportedBrowserKey} is not supported in sandbox policy.`,
      `Remove ${propertyPrefix}.browser.${unsupportedBrowserKey} or use a supported sandbox browser posture rule.`,
    );
  }
  if (
    browser.requireCdpSourceRange !== undefined &&
    typeof browser.requireCdpSourceRange !== "boolean"
  ) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${targetPrefix}/browser/requireCdpSourceRange`,
      `${params.policyPath} ${propertyPrefix}.browser.requireCdpSourceRange must be a boolean.`,
      `Set ${propertyPrefix}.browser.requireCdpSourceRange to true or false.`,
    );
  }
  return undefined;
}

function unsupportedPolicyKey(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
): string | undefined {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).find((key) => !allowed.has(key));
}

function gatewayPolicyShapeFinding(
  value: unknown,
  params: {
    readonly policyDocName: string;
    readonly policyPath: string;
  },
): HealthFinding | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/gateway`,
      `${params.policyPath} gateway must be an object.`,
      `Fix ${params.policyPath} so gateway is an object.`,
    );
  }

  for (const section of ["exposure", "auth", "controlUi", "remote", "http", "nodes"] as const) {
    if (value[section] !== undefined && !isRecord(value[section])) {
      return policyShapeFinding(
        params.policyPath,
        `oc://${params.policyDocName}/gateway/${section}`,
        `${params.policyPath} gateway.${section} must be an object.`,
        `Fix ${params.policyPath} so gateway.${section} is an object.`,
      );
    }
  }
  const unsupportedGatewayKey = unsupportedPolicyKey(value, SUPPORTED_GATEWAY_POLICY_SECTIONS);
  if (unsupportedGatewayKey !== undefined) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/gateway/${ocPathSegment(unsupportedGatewayKey)}`,
      `${params.policyPath} gateway.${unsupportedGatewayKey} is not supported in Gateway policy.`,
      `Remove gateway.${unsupportedGatewayKey} or use a supported Gateway policy section.`,
    );
  }

  const exposure = isRecord(value.exposure) ? value.exposure : {};
  const auth = isRecord(value.auth) ? value.auth : {};
  const controlUi = isRecord(value.controlUi) ? value.controlUi : {};
  const remote = isRecord(value.remote) ? value.remote : {};
  const http = isRecord(value.http) ? value.http : {};
  const nodes = isRecord(value.nodes) ? value.nodes : {};
  for (const [section, sectionValue, allowedKeys] of [
    ["exposure", exposure, ["allowNonLoopbackBind", "allowTailscaleFunnel"]],
    ["auth", auth, ["requireAuth", "requireExplicitRateLimit"]],
    ["controlUi", controlUi, ["allowInsecure"]],
    ["remote", remote, ["allow"]],
    ["http", http, ["denyEndpoints", "requireUrlAllowlists"]],
    ["nodes", nodes, ["denyCommands"]],
  ] as const) {
    const unsupportedKey = unsupportedPolicyKey(sectionValue, allowedKeys);
    if (unsupportedKey !== undefined) {
      return policyShapeFinding(
        params.policyPath,
        `oc://${params.policyDocName}/gateway/${section}/${ocPathSegment(unsupportedKey)}`,
        `${params.policyPath} gateway.${section}.${unsupportedKey} is not supported in Gateway policy.`,
        `Remove gateway.${section}.${unsupportedKey} or use a supported Gateway policy rule.`,
      );
    }
  }
  const booleanRules = [
    [
      "gateway/exposure/allowNonLoopbackBind",
      "gateway.exposure.allowNonLoopbackBind",
      exposure.allowNonLoopbackBind,
    ],
    [
      "gateway/exposure/allowTailscaleFunnel",
      "gateway.exposure.allowTailscaleFunnel",
      exposure.allowTailscaleFunnel,
    ],
    ["gateway/auth/requireAuth", "gateway.auth.requireAuth", auth.requireAuth],
    [
      "gateway/auth/requireExplicitRateLimit",
      "gateway.auth.requireExplicitRateLimit",
      auth.requireExplicitRateLimit,
    ],
    ["gateway/controlUi/allowInsecure", "gateway.controlUi.allowInsecure", controlUi.allowInsecure],
    ["gateway/remote/allow", "gateway.remote.allow", remote.allow],
    [
      "gateway/http/requireUrlAllowlists",
      "gateway.http.requireUrlAllowlists",
      http.requireUrlAllowlists,
    ],
  ] as const;
  for (const [target, property, ruleValue] of booleanRules) {
    if (ruleValue !== undefined && typeof ruleValue !== "boolean") {
      return policyShapeFinding(
        params.policyPath,
        `oc://${params.policyDocName}/${target}`,
        `${params.policyPath} ${property} must be a boolean.`,
        `Fix ${params.policyPath} so ${property} is true or false.`,
      );
    }
  }

  const denyEndpoints = http.denyEndpoints;
  if (denyEndpoints !== undefined && !Array.isArray(denyEndpoints)) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/gateway/http/denyEndpoints`,
      `${params.policyPath} gateway.http.denyEndpoints must be an array.`,
      'Use an array of endpoint ids such as ["responses"] or remove gateway.http.denyEndpoints.',
    );
  }
  if (Array.isArray(denyEndpoints)) {
    const invalidIndex = denyEndpoints.findIndex(
      (entry) =>
        typeof entry !== "string" ||
        !SUPPORTED_GATEWAY_HTTP_ENDPOINTS.includes(
          entry.trim() as (typeof SUPPORTED_GATEWAY_HTTP_ENDPOINTS)[number],
        ),
    );
    if (invalidIndex >= 0) {
      return policyShapeFinding(
        params.policyPath,
        `oc://${params.policyDocName}/gateway/http/denyEndpoints/#${invalidIndex}`,
        `${params.policyPath} gateway.http.denyEndpoints[${invalidIndex}] must be a supported endpoint id.`,
        `Use supported endpoint ids: ${SUPPORTED_GATEWAY_HTTP_ENDPOINTS.join(", ")}.`,
      );
    }
  }
  const denyCommands = nodes.denyCommands;
  if (denyCommands !== undefined && !Array.isArray(denyCommands)) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/gateway/nodes/denyCommands`,
      `${params.policyPath} gateway.nodes.denyCommands must be an array.`,
      'Use an array of node command ids such as ["system.run"] or remove gateway.nodes.denyCommands.',
    );
  }
  if (Array.isArray(denyCommands)) {
    const invalidIndex = denyCommands.findIndex(
      (entry) => typeof entry !== "string" || entry.trim() === "",
    );
    if (invalidIndex >= 0) {
      return policyShapeFinding(
        params.policyPath,
        `oc://${params.policyDocName}/gateway/nodes/denyCommands/#${invalidIndex}`,
        `${params.policyPath} gateway.nodes.denyCommands[${invalidIndex}] must be a non-empty node command id.`,
        "Use non-empty node command ids.",
      );
    }
  }
  return undefined;
}

function policyStringArrayShapeFinding(
  value: unknown,
  params: {
    readonly property: string;
    readonly policyDocName: string;
    readonly policyPath: string;
    readonly target: string;
    readonly valueName: string;
  },
): HealthFinding | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${params.target}`,
      `${params.policyPath} ${params.property} must be an object.`,
      `Fix ${params.policyPath} so ${params.property} is an object.`,
    );
  }
  const unsupportedKey = unsupportedPolicyKey(value, ["allow", "deny"]);
  if (unsupportedKey !== undefined) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${params.target}/${ocPathSegment(unsupportedKey)}`,
      `${params.policyPath} ${params.property}.${unsupportedKey} is not supported in policy.`,
      `Remove ${params.property}.${unsupportedKey} or use ${params.property}.allow or ${params.property}.deny.`,
    );
  }
  for (const key of ["allow", "deny"] as const) {
    const entries = value[key];
    if (entries === undefined) {
      continue;
    }
    const target = `oc://${params.policyDocName}/${params.target}/${key}`;
    if (!Array.isArray(entries)) {
      return policyShapeFinding(
        params.policyPath,
        target,
        `${params.policyPath} ${params.property}.${key} must be an array.`,
        `Fix ${params.policyPath} so ${params.property}.${key} is an array of ${params.valueName}s.`,
      );
    }
    const invalidIndex = entries.findIndex(
      (entry) => typeof entry !== "string" || entry.trim() === "",
    );
    if (invalidIndex >= 0) {
      return policyShapeFinding(
        params.policyPath,
        `${target}/#${invalidIndex}`,
        `${params.policyPath} ${params.property}.${key}[${invalidIndex}] must be a non-empty string.`,
        `Fix ${params.policyPath} so each ${params.property}.${key} entry is a ${params.valueName}.`,
      );
    }
  }
  return undefined;
}

function execApprovalAllowlistExpectedShapeFinding(
  value: unknown,
  params: {
    readonly property: string;
    readonly policyDocName: string;
    readonly policyPath: string;
    readonly target: string;
  },
): HealthFinding | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${params.target}`,
      `${params.policyPath} ${params.property} must be an array.`,
      `Fix ${params.policyPath} so ${params.property} is an array of exec approval allowlist entries.`,
    );
  }
  const invalidIndex = value.findIndex(
    (entry) => execApprovalAllowlistRequirement(entry) === undefined,
  );
  if (invalidIndex < 0) {
    return undefined;
  }
  return policyShapeFinding(
    params.policyPath,
    `oc://${params.policyDocName}/${params.target}/#${invalidIndex}`,
    `${params.policyPath} ${params.property}[${invalidIndex}] must be a non-empty string or an object with pattern and optional argPattern strings.`,
    `Use entries such as "deploy" or { "pattern": "deploy", "argPattern": "^--prod$" }.`,
  );
}

function policyStringArrayPropertyShapeFinding(
  value: unknown,
  params: {
    readonly allowed?: readonly string[];
    readonly property: string;
    readonly policyDocName: string;
    readonly policyPath: string;
    readonly target: string;
    readonly valueName: string;
  },
): HealthFinding | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${params.target}`,
      `${params.policyPath} ${params.property} must be an array.`,
      `Fix ${params.policyPath} so ${params.property} is an array of ${params.valueName}s.`,
    );
  }
  const invalidIndex = value.findIndex((entry) => {
    if (typeof entry !== "string" || entry.trim() === "") {
      return true;
    }
    return params.allowed !== undefined && !params.allowed.includes(entry.trim());
  });
  if (invalidIndex < 0) {
    return undefined;
  }
  const allowedHint =
    params.allowed === undefined ? "" : ` Supported values: ${params.allowed.join(", ")}.`;
  return policyShapeFinding(
    params.policyPath,
    `oc://${params.policyDocName}/${params.target}/#${invalidIndex}`,
    `${params.policyPath} ${params.property}[${invalidIndex}] must be a supported ${params.valueName}.`,
    `Use non-empty ${params.valueName} entries.${allowedHint}`,
  );
}

function policyShapeFinding(
  policyPath: string,
  target: string,
  message: string,
  fixHint: string,
): HealthFinding {
  return {
    checkId: CHECK_IDS.policyInvalidFile,
    severity: "error",
    message,
    source: "policy",
    path: policyPath,
    target,
    fixHint,
  };
}

function authProfileMetadataRequirementFindings(
  policy: unknown,
  policyPath: string,
  policyDocName: string,
): readonly HealthFinding[] {
  if (
    !isRecord(policy) ||
    !isRecord(policy.auth) ||
    !isRecord(policy.auth.profiles) ||
    policy.auth.profiles.requireMetadata === undefined
  ) {
    return [];
  }
  if (!Array.isArray(policy.auth.profiles.requireMetadata)) {
    return [
      {
        checkId: CHECK_IDS.policyInvalidFile,
        severity: "error",
        message: `${policyPath} auth.profiles.requireMetadata must be an array of metadata keys.`,
        source: "policy",
        path: policyPath,
        target: `oc://${policyDocName}/auth/profiles/requireMetadata`,
        fixHint: `Use supported metadata keys: ${SUPPORTED_AUTH_PROFILE_METADATA.join(", ")}.`,
      },
    ];
  }
  const invalidIndex = policy.auth.profiles.requireMetadata.findIndex(
    (entry) =>
      typeof entry !== "string" ||
      !SUPPORTED_AUTH_PROFILE_METADATA.includes(
        entry.trim().toLowerCase() as (typeof SUPPORTED_AUTH_PROFILE_METADATA)[number],
      ),
  );
  if (invalidIndex < 0) {
    return [];
  }
  return [
    {
      checkId: CHECK_IDS.policyInvalidFile,
      severity: "error",
      message: `${policyPath} auth.profiles.requireMetadata[${invalidIndex}] must be a supported metadata key.`,
      source: "policy",
      path: policyPath,
      target: `oc://${policyDocName}/auth/profiles/requireMetadata/#${invalidIndex}`,
      fixHint: `Use supported metadata keys: ${SUPPORTED_AUTH_PROFILE_METADATA.join(", ")}.`,
    },
  ];
}

function invalidChannelDenyRuleFindings(
  policy: unknown,
  policyPath: string,
  policyDocName: string,
): readonly HealthFinding[] {
  if (!isRecord(policy) || !isRecord(policy.channels) || policy.channels.denyRules === undefined) {
    return [];
  }
  if (!Array.isArray(policy.channels.denyRules)) {
    return [
      {
        checkId: CHECK_IDS.policyInvalidFile,
        severity: "error",
        message: `${policyPath} channels.denyRules must be an array.`,
        source: "policy",
        path: policyPath,
        target: `oc://${policyDocName}/channels/denyRules`,
        fixHint: `Fix ${policyPath} so channel deny rules are an array.`,
      },
    ];
  }
  for (const [index, rule] of policy.channels.denyRules.entries()) {
    if (!isRecord(rule)) {
      continue;
    }
    const unsupportedRuleKey = unsupportedPolicyKey(rule, ["id", "reason", "when"]);
    if (unsupportedRuleKey !== undefined) {
      return [
        {
          checkId: CHECK_IDS.policyInvalidFile,
          severity: "error",
          message: `${policyPath} channels.denyRules[${index}].${unsupportedRuleKey} is not supported in channel deny rules.`,
          source: "policy",
          path: policyPath,
          target: `oc://${policyDocName}/channels/denyRules/#${index}/${ocPathSegment(unsupportedRuleKey)}`,
          fixHint: `Remove channels.denyRules[${index}].${unsupportedRuleKey} or use id, when.provider, and reason.`,
        },
      ];
    }
    if (isRecord(rule.when)) {
      const unsupportedWhenKey = unsupportedPolicyKey(rule.when, ["provider"]);
      if (unsupportedWhenKey !== undefined) {
        return [
          {
            checkId: CHECK_IDS.policyInvalidFile,
            severity: "error",
            message: `${policyPath} channels.denyRules[${index}].when.${unsupportedWhenKey} is not supported in channel deny rules.`,
            source: "policy",
            path: policyPath,
            target: `oc://${policyDocName}/channels/denyRules/#${index}/when/${ocPathSegment(unsupportedWhenKey)}`,
            fixHint: `Remove channels.denyRules[${index}].when.${unsupportedWhenKey} or use when.provider.`,
          },
        ];
      }
    }
  }
  const invalid = policy.channels.denyRules.findIndex((rule) => !isChannelDenyRule(rule));
  if (invalid < 0) {
    return [];
  }
  return [
    {
      checkId: CHECK_IDS.policyInvalidFile,
      severity: "error",
      message: `${policyPath} channels.denyRules[${invalid}] must define when.provider as a string.`,
      source: "policy",
      path: policyPath,
      target: `oc://${policyDocName}/channels/denyRules/#${invalid}`,
      fixHint: `Fix ${policyPath} so each channel deny rule has a provider match.`,
    },
  ];
}

function ingressFindings(
  policy: unknown,
  policyPath: string,
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  if (!isRecord(policy)) {
    return [];
  }
  const findings: HealthFinding[] = [];
  const ingressPolicy = policy.ingress;
  if (
    ingressPolicyShapeFinding(ingressPolicy, { policyDocName, policyPath }) === undefined &&
    isRecord(ingressPolicy)
  ) {
    findings.push(
      ...ingressFindingsForRule(ingressPolicy, policyDocName, "ingress", evidence, () => true),
    );
  }
  if (hasValidScopedPolicy(policy, policyPath, policyDocName)) {
    for (const target of channelScopedPolicyTargets(policy)) {
      if (
        ingressPolicyShapeFinding(target.overlay.ingress, {
          policyDocName,
          policyPath,
          targetPrefix: `scopes/${ocPathSegment(target.scopeName)}/ingress`,
          propertyPrefix: `scopes.${target.scopeName}.ingress`,
          allowSession: false,
        }) !== undefined ||
        !isRecord(target.overlay.ingress)
      ) {
        continue;
      }
      findings.push(
        ...ingressFindingsForRule(
          target.overlay.ingress,
          policyDocName,
          `scopes/${ocPathSegment(target.scopeName)}/ingress`,
          evidence,
          (entry) => scopedIngressChannelMatches(entry, target.channelId),
        ),
      );
    }
  }
  return findings;
}

function ingressFindingsForRule(
  ingressPolicy: Record<string, unknown> | undefined,
  policyDocName: string,
  requirementBase: string,
  evidence: PolicyEvidence,
  evidenceFilter: (entry: PolicyIngressEvidence) => boolean,
): readonly HealthFinding[] {
  if (!isRecord(ingressPolicy)) {
    return [];
  }
  return [
    ...ingressDmScopeFindings(
      ingressPolicy,
      policyDocName,
      requirementBase,
      evidence,
      evidenceFilter,
    ),
    ...ingressDmPolicyFindings(
      ingressPolicy,
      policyDocName,
      requirementBase,
      evidence,
      evidenceFilter,
    ),
    ...ingressOpenGroupFindings(
      ingressPolicy,
      policyDocName,
      requirementBase,
      evidence,
      evidenceFilter,
    ),
    ...ingressRequireMentionFindings(
      ingressPolicy,
      policyDocName,
      requirementBase,
      evidence,
      evidenceFilter,
    ),
  ];
}

function ingressDmScopeFindings(
  ingressPolicy: Record<string, unknown>,
  policyDocName: string,
  requirementBase: string,
  evidence: PolicyEvidence,
  evidenceFilter: (entry: PolicyIngressEvidence) => boolean,
): readonly HealthFinding[] {
  const required = readString(ingressPolicy, ["session", "requireDmScope"]);
  if (required === undefined) {
    return [];
  }
  return ingressEntries(evidence, "sessionDmScope")
    .filter(evidenceFilter)
    .filter((entry) => entry.value !== required)
    .map((entry) =>
      ingressFinding(entry, {
        checkId: CHECK_IDS.policyIngressDmScopeUnapproved,
        message: `session.dmScope '${entry.value ?? ""}' does not match policy.`,
        requirement: `oc://${policyDocName}/${requirementBase}/session/requireDmScope`,
        fixHint:
          "Set session.dmScope to the required isolation scope or update policy after review.",
      }),
    );
}

function ingressDmPolicyFindings(
  ingressPolicy: Record<string, unknown>,
  policyDocName: string,
  requirementBase: string,
  evidence: PolicyEvidence,
  evidenceFilter: (entry: PolicyIngressEvidence) => boolean,
): readonly HealthFinding[] {
  const allowed = new Set(readStringList(ingressPolicy, ["channels", "allowDmPolicies"]));
  if (allowed.size === 0) {
    return [];
  }
  return ingressEntries(evidence, "channelDmPolicy")
    .filter(evidenceFilter)
    .filter((entry) => typeof entry.value === "string" && !allowed.has(entry.value.toLowerCase()))
    .map((entry) =>
      ingressFinding(entry, {
        checkId: CHECK_IDS.policyIngressDmPolicyUnapproved,
        message: `${ingressLabel(entry)} uses unapproved DM policy '${entry.value ?? ""}'.`,
        requirement: `oc://${policyDocName}/${requirementBase}/channels/allowDmPolicies`,
        fixHint: "Set the channel DM policy to an allowed value or update policy after review.",
      }),
    );
}

function ingressOpenGroupFindings(
  ingressPolicy: Record<string, unknown>,
  policyDocName: string,
  requirementBase: string,
  evidence: PolicyEvidence,
  evidenceFilter: (entry: PolicyIngressEvidence) => boolean,
): readonly HealthFinding[] {
  if (readPolicyBoolean(ingressPolicy, ["channels", "denyOpenGroups"]) !== true) {
    return [];
  }
  return ingressEntries(evidence, "channelGroupPolicy")
    .filter(evidenceFilter)
    .filter((entry) => entry.value !== "allowlist" && entry.value !== "disabled")
    .map((entry) =>
      ingressFinding(entry, {
        checkId: CHECK_IDS.policyIngressOpenGroupsDenied,
        message: `${ingressLabel(entry)} allows open group ingress.`,
        requirement: `oc://${policyDocName}/${requirementBase}/channels/denyOpenGroups`,
        fixHint: "Set groupPolicy to allowlist or disabled, or update policy after review.",
      }),
    );
}

function ingressRequireMentionFindings(
  ingressPolicy: Record<string, unknown>,
  policyDocName: string,
  requirementBase: string,
  evidence: PolicyEvidence,
  evidenceFilter: (entry: PolicyIngressEvidence) => boolean,
): readonly HealthFinding[] {
  if (readPolicyBoolean(ingressPolicy, ["channels", "requireMentionInGroups"]) !== true) {
    return [];
  }
  const groupPolicies = ingressEntries(evidence, "channelGroupPolicy").filter(evidenceFilter);
  return ingressEntries(evidence, "channelRequireMention")
    .filter(evidenceFilter)
    .filter((entry) => !isGroupIngressDisabled(entry, groupPolicies))
    .filter((entry) => entry.value !== true)
    .map((entry) =>
      ingressFinding(entry, {
        checkId: CHECK_IDS.policyIngressGroupMentionRequired,
        message: `${ingressLabel(entry)} does not require group mentions.`,
        requirement: `oc://${policyDocName}/${requirementBase}/channels/requireMentionInGroups`,
        fixHint:
          "Set requireMention=true for the channel/group entry or update policy after review.",
      }),
    );
}

function isGroupIngressDisabled(
  entry: PolicyIngressEvidence,
  groupPolicies: readonly PolicyIngressEvidence[],
): boolean {
  const entryParent = ocPathParent(entry.source);
  const channelDefaultsParent = "oc://openclaw.config/channels/defaults";
  const matches = groupPolicies
    .filter((candidate) => {
      const candidateParent = ocPathParent(candidate.source);
      return (
        candidate.channel === entry.channel &&
        (candidate.accountId ?? "") === (entry.accountId ?? "") &&
        (candidateParent === channelDefaultsParent ||
          entryParent === candidateParent ||
          entryParent.startsWith(`${candidateParent}/`))
      );
    })
    .toSorted(
      (left, right) => ocPathParent(right.source).length - ocPathParent(left.source).length,
    );
  return matches[0]?.value === "disabled";
}

function ocPathParent(source: string): string {
  return source.slice(0, Math.max(0, source.lastIndexOf("/")));
}

function ingressEntries(
  evidence: PolicyEvidence,
  kind: PolicyIngressEvidence["kind"],
): readonly PolicyIngressEvidence[] {
  return (evidence.ingress ?? []).filter((entry) => entry.kind === kind);
}

function scopedIngressChannelMatches(
  entry: PolicyIngressEvidence,
  policyChannelId: string,
): boolean {
  return normalizePolicyChannelId(entry.channel ?? "") === policyChannelId;
}

function ingressFinding(
  entry: PolicyIngressEvidence,
  params: {
    readonly checkId: (typeof POLICY_CHECK_IDS)[number];
    readonly message: string;
    readonly requirement: string;
    readonly fixHint: string;
  },
): HealthFinding {
  return {
    checkId: params.checkId,
    severity: "error",
    message: params.message,
    source: "policy",
    path: "openclaw config",
    ocPath: entry.source,
    target: entry.source,
    requirement: params.requirement,
    fixHint: params.fixHint,
  };
}

function ingressLabel(entry: PolicyIngressEvidence): string {
  const account = entry.accountId === undefined ? "" : ` account '${entry.accountId}'`;
  const group = entry.groupId === undefined ? "" : ` group '${entry.groupId}'`;
  return `channel '${entry.channel ?? "unknown"}'${account}${group}`;
}

function agentWorkspaceFindings(
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

function execApprovalsFindings(
  policy: unknown,
  policyPath: string,
  policyDocName: string,
  evidence: PolicyEvidence,
  file:
    | { readonly raw: string; readonly displayName: string; readonly ocDocName: string }
    | null
    | undefined,
  displayName: string,
): readonly HealthFinding[] {
  if (!isRecord(policy)) {
    return [];
  }
  const findings: HealthFinding[] = [];
  const entries = evidence.execApprovals ?? [];
  const defaults = entries.find((entry) => entry.kind === "defaults");
  const defaultSecurity = defaults?.security ?? "full";

  if (isRecord(policy.execApprovals)) {
    const shapeFinding = execApprovalsPolicyShapeFinding(policy.execApprovals, {
      policyDocName,
      policyPath,
    });
    if (shapeFinding !== undefined) {
      return [shapeFinding];
    }
    const fileFindings = execApprovalsFileFindings(policy.execApprovals, {
      policyDocName,
      file,
      displayName,
      requirementBase: "execApprovals",
    });
    findings.push(...fileFindings);
    if (fileFindings.length > 0) {
      return findings;
    }
    findings.push(
      ...execApprovalsRuleFindings(policy.execApprovals, {
        entries,
        defaultSecurity,
        defaults,
        displayName,
        fileDisplayName: file?.displayName,
        policyDocName,
        requirementBase: "execApprovals",
      }),
    );
  }

  if (!hasValidScopedPolicy(policy, policyPath, policyDocName)) {
    return findings;
  }
  const scopedFileFindingScopes = new Set<string>();
  for (const target of agentScopedPolicyTargets(policy)) {
    if (!isRecord(target.overlay.execApprovals)) {
      continue;
    }
    const requirementBase = `scopes/${ocPathSegment(target.scopeName)}/execApprovals`;
    const shapeFinding = execApprovalsPolicyShapeFinding(target.overlay.execApprovals, {
      policyDocName,
      policyPath,
      targetPrefix: requirementBase,
      propertyPrefix: `scopes.${target.scopeName}.execApprovals`,
      allowDefaults: false,
    });
    if (shapeFinding !== undefined) {
      findings.push(shapeFinding);
      continue;
    }
    const fileFindings = execApprovalsFileFindings(target.overlay.execApprovals, {
      policyDocName,
      file,
      displayName,
      requirementBase,
    });
    if (fileFindings.length > 0) {
      if (!scopedFileFindingScopes.has(target.scopeName)) {
        findings.push(...fileFindings);
        scopedFileFindingScopes.add(target.scopeName);
      }
      continue;
    }
    findings.push(
      ...execApprovalsRuleFindings(target.overlay.execApprovals, {
        entries,
        defaultSecurity,
        defaults,
        displayName,
        fileDisplayName: file?.displayName,
        policyDocName,
        requirementBase,
        targetAgentId: target.agentId,
      }),
    );
  }
  return findings;
}

function execApprovalsFileFindings(
  execApprovalsPolicy: Record<string, unknown>,
  params: {
    readonly policyDocName: string;
    readonly file:
      | { readonly raw: string; readonly displayName: string; readonly ocDocName: string }
      | null
      | undefined;
    readonly displayName: string;
    readonly requirementBase: string;
  },
): readonly HealthFinding[] {
  const requireFile = readPolicyBoolean(execApprovalsPolicy, ["requireFile"]) === true;
  const needsArtifactEvidence =
    requireFile || execApprovalsPolicyNeedsArtifactEvidence(execApprovalsPolicy);
  if (needsArtifactEvidence && params.file === null) {
    return [
      {
        checkId: CHECK_IDS.policyExecApprovalsMissing,
        severity: "error",
        message: "exec-approvals.json evidence is required by policy but was not found.",
        source: "policy",
        path: params.displayName,
        target: "oc://exec-approvals.json",
        requirement: `oc://${params.policyDocName}/${
          requireFile ? `${params.requirementBase}/requireFile` : params.requirementBase
        }`,
        fixHint: "Restore the approved exec approvals artifact or update policy after review.",
      },
    ];
  }
  if (params.file === null || params.file === undefined) {
    return [];
  }
  const parsed = parseExecApprovalsFile(params.file.raw);
  if (parsed.ok || !needsArtifactEvidence) {
    return [];
  }
  return [
    {
      checkId: CHECK_IDS.policyExecApprovalsInvalid,
      severity: "error",
      message: `${params.file.displayName} could not be parsed: ${parsed.message}`,
      source: "policy",
      path: params.file.displayName,
      target: `oc://${params.file.ocDocName}`,
      requirement: `oc://${params.policyDocName}/${params.requirementBase}`,
      fixHint: "Fix exec-approvals.json so it is valid JSON.",
    },
  ];
}

function execApprovalsPolicyNeedsArtifactEvidence(
  execApprovalsPolicy: Record<string, unknown>,
): boolean {
  return isRecord(execApprovalsPolicy.defaults) || isRecord(execApprovalsPolicy.agents);
}

function execApprovalsRuleFindings(
  execApprovalsPolicy: Record<string, unknown>,
  params: {
    readonly entries: readonly PolicyExecApprovalEvidence[];
    readonly defaultSecurity: string;
    readonly defaults?: PolicyExecApprovalEvidence;
    readonly displayName: string;
    readonly fileDisplayName?: string;
    readonly policyDocName: string;
    readonly requirementBase: string;
    readonly targetAgentId?: string;
  },
): readonly HealthFinding[] {
  const findings: HealthFinding[] = [];
  const allowedDefaults = new Set(
    readStringList(execApprovalsPolicy, ["defaults", "allowSecurity"]),
  );
  if (
    params.targetAgentId === undefined &&
    allowedDefaults.size > 0 &&
    !allowedDefaults.has(params.defaultSecurity.toLowerCase())
  ) {
    findings.push(
      execApprovalFinding(params.defaults, {
        checkId: CHECK_IDS.policyExecApprovalsDefaultSecurityUnapproved,
        message: `exec approvals defaults use unapproved security mode '${params.defaultSecurity}'.`,
        requirement: `oc://${params.policyDocName}/${params.requirementBase}/defaults/allowSecurity`,
        fixHint: "Set defaults.security to an approved mode or update policy after review.",
      }),
    );
  }

  const allowedAgents = new Set(readStringList(execApprovalsPolicy, ["agents", "allowSecurity"]));
  if (allowedAgents.size > 0) {
    const agentEntries =
      params.targetAgentId === undefined
        ? globalExecApprovalAgentSecurityEntries(params.entries, params.defaults)
        : [
            effectiveExecApprovalAgentSecurityEntry(params.entries, params.targetAgentId) ??
              params.defaults ??
              syntheticExecApprovalAgentEntry(params.targetAgentId),
          ];
    for (const entry of agentEntries) {
      const security = entry.security ?? params.defaultSecurity;
      if (allowedAgents.has(security.toLowerCase())) {
        continue;
      }
      findings.push(
        execApprovalFinding(entry, {
          checkId: CHECK_IDS.policyExecApprovalsAgentSecurityUnapproved,
          message: `exec approvals agent '${entry.agentId ?? params.targetAgentId ?? "inherited defaults"}' uses unapproved security mode '${security}'.`,
          requirement: `oc://${params.policyDocName}/${params.requirementBase}/agents/allowSecurity`,
          fixHint:
            "Set the agent approval security mode to an approved value or update policy after review.",
        }),
      );
    }
  }

  const allowAutoAllowSkills = readPolicyBoolean(execApprovalsPolicy, [
    "agents",
    "allowAutoAllowSkills",
  ]);
  if (allowAutoAllowSkills === false) {
    const autoAllowEntries =
      params.targetAgentId === undefined
        ? globalExecApprovalAgentAutoAllowSkillsEntries(params.entries, params.defaults)
        : [
            effectiveExecApprovalAgentAutoAllowSkillsEntry(params.entries, params.targetAgentId) ??
              params.defaults ??
              syntheticExecApprovalAgentEntry(params.targetAgentId),
          ];
    for (const entry of autoAllowEntries) {
      if (entry.autoAllowSkills !== true) {
        continue;
      }
      findings.push(
        execApprovalFinding(entry, {
          checkId: CHECK_IDS.policyExecApprovalsAutoAllowSkillsEnabled,
          message: `exec approvals agent '${entry.agentId ?? params.targetAgentId ?? "inherited defaults"}' enables autoAllowSkills outside policy.`,
          requirement: `oc://${params.policyDocName}/${params.requirementBase}/agents/allowAutoAllowSkills`,
          fixHint:
            "Set autoAllowSkills to false or update policy after reviewing implicit skill CLI trust.",
        }),
      );
    }
  }

  const expected = readExecApprovalAllowlistRequirements(execApprovalsPolicy, [
    "agents",
    "allowlist",
    "expected",
  ]);
  if (expected !== undefined) {
    const expectedSet = new Set(expected.map((entry) => entry.key));
    const actualEntries = execApprovalAllowlistEntries(params.entries, params.targetAgentId).filter(
      (entry) => entry.pattern !== undefined,
    );
    const actual = actualEntries
      .map((entry) =>
        execApprovalAllowlistRequirementKey(entry.pattern as string, entry.argPattern),
      )
      .toSorted();
    const actualSet = new Set(actual);
    for (const entry of expected.toSorted((a, b) => a.key.localeCompare(b.key))) {
      if (!actualSet.has(entry.key)) {
        const requirement = `oc://${params.policyDocName}/${params.requirementBase}/agents/allowlist/expected`;
        const target = execApprovalAllowlistMissingTarget(params.targetAgentId);
        findings.push({
          checkId: CHECK_IDS.policyExecApprovalsAllowlistMissing,
          severity: "error",
          message: `exec approvals allowlist is missing expected pattern '${formatExecApprovalAllowlistRequirement(entry)}'.`,
          source: "policy",
          path: params.fileDisplayName ?? params.displayName,
          target,
          requirement,
          fixHint: "Add the expected approval pattern or update policy after review.",
        });
      }
    }
    for (const key of actualSet) {
      if (expectedSet.has(key)) {
        continue;
      }
      const entry = actualEntries.find(
        (candidate) =>
          candidate.pattern !== undefined &&
          execApprovalAllowlistRequirementKey(candidate.pattern, candidate.argPattern) === key,
      );
      findings.push(
        execApprovalFinding(entry, {
          checkId: CHECK_IDS.policyExecApprovalsAllowlistUnexpected,
          message: `exec approvals allowlist has unexpected pattern '${formatExecApprovalAllowlistEntry(entry)}'.`,
          requirement: `oc://${params.policyDocName}/${params.requirementBase}/agents/allowlist/expected`,
          fixHint: "Remove the unexpected approval pattern or update policy after review.",
        }),
      );
    }
  }
  return findings;
}

function globalExecApprovalAgentSecurityEntries(
  entries: readonly PolicyExecApprovalEvidence[],
  defaults: PolicyExecApprovalEvidence | undefined,
): readonly PolicyExecApprovalEvidence[] {
  const agentEntries = entries.filter((candidate) => candidate.kind === "agent");
  const wildcard = agentEntries.find((entry) => entry.agentId === "*");
  const securityEntries = agentEntries.filter(
    (entry) =>
      entry.agentId === "*" || entry.security !== undefined || entry.securityConfigured === true,
  );
  return wildcard === undefined
    ? [...securityEntries, defaults ?? syntheticExecApprovalAgentEntry("*")]
    : securityEntries;
}

function globalExecApprovalAgentAutoAllowSkillsEntries(
  entries: readonly PolicyExecApprovalEvidence[],
  defaults: PolicyExecApprovalEvidence | undefined,
): readonly PolicyExecApprovalEvidence[] {
  const agentEntries = entries.filter((candidate) => candidate.kind === "agent");
  const wildcard = agentEntries.find((entry) => entry.agentId === "*");
  const explicitEntries = agentEntries.filter((entry) => entry.autoAllowSkills !== undefined);
  return wildcard?.autoAllowSkills === undefined
    ? [...explicitEntries, defaults ?? syntheticExecApprovalAgentEntry("*")]
    : explicitEntries;
}

type ExecApprovalAllowlistRequirement = {
  readonly key: string;
  readonly pattern: string;
  readonly argPattern?: string;
};

function readExecApprovalAllowlistRequirements(
  policy: unknown,
  path: readonly string[],
): readonly ExecApprovalAllowlistRequirement[] | undefined {
  let current: unknown = policy;
  for (const part of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[part];
  }
  if (!Array.isArray(current)) {
    return undefined;
  }
  const entries = current.map(execApprovalAllowlistRequirement);
  return entries.every((entry): entry is ExecApprovalAllowlistRequirement => entry !== undefined)
    ? entries
    : undefined;
}

function execApprovalAllowlistRequirement(
  value: unknown,
): ExecApprovalAllowlistRequirement | undefined {
  if (typeof value === "string") {
    const pattern = value.trim();
    return pattern === "" ? undefined : execApprovalAllowlistRequirementFromParts(pattern);
  }
  if (!isRecord(value)) {
    return undefined;
  }
  if (unsupportedPolicyKey(value, ["argPattern", "pattern"]) !== undefined) {
    return undefined;
  }
  const pattern = typeof value.pattern === "string" ? value.pattern.trim() : "";
  if (pattern === "") {
    return undefined;
  }
  const argPattern = typeof value.argPattern === "string" ? value.argPattern.trim() : undefined;
  if (value.argPattern !== undefined && argPattern === undefined) {
    return undefined;
  }
  return execApprovalAllowlistRequirementFromParts(
    pattern,
    argPattern === "" ? undefined : argPattern,
  );
}

function execApprovalAllowlistRequirementFromParts(
  pattern: string,
  argPattern?: string,
): ExecApprovalAllowlistRequirement {
  return {
    key: execApprovalAllowlistRequirementKey(pattern, argPattern),
    pattern,
    ...(argPattern === undefined ? {} : { argPattern }),
  };
}

function execApprovalAllowlistRequirementKey(
  pattern: string,
  argPattern: string | undefined,
): string {
  return `${pattern}\0${argPattern ?? ""}`;
}

function execApprovalAllowlistMissingTarget(agentId: string | undefined): string {
  return agentId === undefined
    ? "oc://exec-approvals.json"
    : `oc://exec-approvals.json/agents/${ocPathSegment(agentId)}/allowlist`;
}

function formatExecApprovalAllowlistRequirement(entry: ExecApprovalAllowlistRequirement): string {
  return formatExecApprovalAllowlistParts(entry.pattern, entry.argPattern);
}

function formatExecApprovalAllowlistEntry(entry: PolicyExecApprovalEvidence | undefined): string {
  return formatExecApprovalAllowlistParts(entry?.pattern ?? "", entry?.argPattern);
}

function formatExecApprovalAllowlistParts(pattern: string, argPattern: string | undefined): string {
  return argPattern === undefined ? pattern : `${pattern} argPattern=${argPattern}`;
}

function effectiveExecApprovalAgentSecurityEntry(
  entries: readonly PolicyExecApprovalEvidence[],
  agentId: string,
): PolicyExecApprovalEvidence | undefined {
  const exact = entries.find(
    (entry) =>
      entry.kind === "agent" &&
      entry.agentId !== undefined &&
      normalizeAgentId(entry.agentId) === normalizeAgentId(agentId),
  );
  const wildcard = entries.find((entry) => entry.kind === "agent" && entry.agentId === "*");
  if (exact?.security !== undefined || exact?.securityConfigured === true) {
    return exact;
  }
  return wildcard?.security === undefined ? (exact ?? wildcard) : wildcard;
}

function effectiveExecApprovalAgentAutoAllowSkillsEntry(
  entries: readonly PolicyExecApprovalEvidence[],
  agentId: string,
): PolicyExecApprovalEvidence | undefined {
  const exact = entries.find(
    (entry) =>
      entry.kind === "agent" &&
      entry.agentId !== undefined &&
      normalizeAgentId(entry.agentId) === normalizeAgentId(agentId),
  );
  if (exact?.autoAllowSkills !== undefined) {
    return exact;
  }
  const wildcard = entries.find((entry) => entry.kind === "agent" && entry.agentId === "*");
  return wildcard?.autoAllowSkills === undefined ? undefined : wildcard;
}

function syntheticExecApprovalAgentEntry(agentId: string): PolicyExecApprovalEvidence {
  return {
    id: `agent:${agentId}:runtime-defaults`,
    kind: "agent",
    source: "oc://exec-approvals.json",
    agentId,
  };
}

function execApprovalAllowlistEntries(
  entries: readonly PolicyExecApprovalEvidence[],
  agentId: string | undefined,
): readonly PolicyExecApprovalEvidence[] {
  if (agentId === undefined) {
    return entries.filter((entry) => entry.kind === "allowlist");
  }
  return entries.filter(
    (entry) =>
      entry.kind === "allowlist" &&
      entry.agentId !== undefined &&
      (normalizeAgentId(entry.agentId) === normalizeAgentId(agentId) || entry.agentId === "*"),
  );
}

function execApprovalFinding(
  entry: PolicyExecApprovalEvidence | undefined,
  params: {
    readonly checkId: (typeof POLICY_CHECK_IDS)[number];
    readonly message: string;
    readonly requirement: string;
    readonly fixHint: string;
  },
): HealthFinding {
  const target = entry?.source ?? "oc://exec-approvals.json";
  return {
    checkId: params.checkId,
    severity: "error",
    message: params.message,
    source: "policy",
    path: "exec-approvals.json",
    ocPath: target,
    target,
    requirement: params.requirement,
    fixHint: params.fixHint,
  };
}

function toolPostureFindings(
  policy: unknown,
  policyPath: string,
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  const findings: HealthFinding[] = [];
  if (
    isRecord(policy) &&
    isRecord(policy.tools) &&
    toolPosturePolicyShapeFinding(policy.tools, { policyDocName, policyPath }) === undefined
  ) {
    findings.push(
      ...toolPostureFindingsForRule(policy.tools, policyDocName, "tools", evidence, () => true),
    );
  }
  if (!hasValidScopedPolicy(policy, policyPath, policyDocName)) {
    return findings;
  }
  for (const target of agentScopedPolicyTargets(policy)) {
    if (!isRecord(target.overlay.tools)) {
      continue;
    }
    const requirementBase = `scopes/${ocPathSegment(target.scopeName)}/tools`;
    if (
      toolPosturePolicyShapeFinding(target.overlay.tools, {
        policyDocName,
        policyPath,
        targetPrefix: requirementBase,
        propertyPrefix: `scopes.${target.scopeName}.tools`,
      }) !== undefined
    ) {
      continue;
    }
    findings.push(
      ...toolPostureFindingsForRule(
        target.overlay.tools,
        policyDocName,
        requirementBase,
        evidence,
        (entry) => scopedToolAgentMatches(entry, target.agentId, evidence.toolPosture ?? []),
      ),
    );
  }
  return findings;
}

function hasValidScopedPolicy(policy: unknown, policyPath: string, policyDocName: string): boolean {
  return (
    isRecord(policy) &&
    scopedPolicyShapeFinding(policy.scopes, { policyDocName, policyPath, policy }) === undefined
  );
}

function scopedWorkspaceAgentMatches(
  entry: PolicyAgentWorkspaceEvidence,
  policyAgentId: string,
  entries: readonly PolicyAgentWorkspaceEvidence[],
): boolean {
  if (scopedAgentIdMatches(entry.agentId, policyAgentId)) {
    return true;
  }
  return entry.scope === "defaults" && !hasScopedAgentEvidence(entries, entry.kind, policyAgentId);
}

function scopedToolAgentMatches(
  entry: PolicyToolPostureEvidence,
  policyAgentId: string,
  entries: readonly PolicyToolPostureEvidence[],
): boolean {
  if (scopedAgentIdMatches(entry.agentId, policyAgentId)) {
    return true;
  }
  return entry.scope === "global" && !hasScopedToolEvidence(entries, entry.kind, policyAgentId);
}

function hasScopedAgentEvidence(
  entries: readonly PolicyAgentWorkspaceEvidence[],
  kind: PolicyAgentWorkspaceEvidence["kind"],
  policyAgentId: string,
): boolean {
  return entries.some(
    (candidate) =>
      candidate.scope === "agent" &&
      candidate.kind === kind &&
      scopedAgentIdMatches(candidate.agentId, policyAgentId),
  );
}

function hasScopedToolEvidence(
  entries: readonly PolicyToolPostureEvidence[],
  kind: PolicyToolPostureEvidence["kind"],
  policyAgentId: string,
): boolean {
  return entries.some(
    (candidate) =>
      candidate.scope === "agent" &&
      candidate.kind === kind &&
      scopedAgentIdMatches(candidate.agentId, policyAgentId),
  );
}

function scopedAgentIdMatches(evidenceAgentId: string | undefined, policyAgentId: string): boolean {
  return (
    evidenceAgentId !== undefined &&
    normalizeAgentId(evidenceAgentId) === normalizeAgentId(policyAgentId)
  );
}

function toolPostureFindingsForRule(
  toolsPolicy: Record<string, unknown>,
  policyDocName: string,
  requirementBase: string,
  evidence: PolicyEvidence,
  evidenceFilter: (entry: PolicyToolPostureEvidence) => boolean,
): readonly HealthFinding[] {
  return [
    ...toolProfileFindings(toolsPolicy, policyDocName, requirementBase, evidence, evidenceFilter),
    ...toolFsWorkspaceOnlyFindings(
      toolsPolicy,
      policyDocName,
      requirementBase,
      evidence,
      evidenceFilter,
    ),
    ...toolExecPostureFindings(
      toolsPolicy,
      policyDocName,
      requirementBase,
      evidence,
      evidenceFilter,
    ),
    ...toolElevatedFindings(toolsPolicy, policyDocName, requirementBase, evidence, evidenceFilter),
    ...toolAlsoAllowExpectedFindings(
      toolsPolicy,
      policyDocName,
      requirementBase,
      evidence,
      evidenceFilter,
    ),
    ...toolRequiredDenyFindings(
      toolsPolicy,
      policyDocName,
      requirementBase,
      evidence,
      evidenceFilter,
    ),
  ];
}

function toolProfileFindings(
  toolsPolicy: Record<string, unknown>,
  policyDocName: string,
  requirementBase: string,
  evidence: PolicyEvidence,
  evidenceFilter: (entry: PolicyToolPostureEvidence) => boolean,
): readonly HealthFinding[] {
  const allowed = new Set(readStringList(toolsPolicy, ["profiles", "allow"]));
  if (allowed.size === 0) {
    return [];
  }
  return toolPostureEntries(evidence, "profile")
    .filter(evidenceFilter)
    .filter((entry) => typeof entry.value === "string" && !allowed.has(entry.value.toLowerCase()))
    .map((entry): HealthFinding => {
      return toolPostureFinding(entry, {
        checkId: CHECK_IDS.policyToolsProfileUnapproved,
        message: `${toolPostureLabel(entry)} uses unapproved tool profile '${entry.value ?? ""}'.`,
        requirement: `oc://${policyDocName}/${requirementBase}/profiles/allow`,
        fixHint: "Use an approved tools.profile value or update policy after review.",
      });
    });
}

function toolFsWorkspaceOnlyFindings(
  toolsPolicy: Record<string, unknown>,
  policyDocName: string,
  requirementBase: string,
  evidence: PolicyEvidence,
  evidenceFilter: (entry: PolicyToolPostureEvidence) => boolean,
): readonly HealthFinding[] {
  if (readPolicyBoolean(toolsPolicy, ["fs", "requireWorkspaceOnly"]) !== true) {
    return [];
  }
  return toolPostureEntries(evidence, "fsWorkspaceOnly")
    .filter(evidenceFilter)
    .filter((entry) => entry.value !== true)
    .map((entry): HealthFinding => {
      return toolPostureFinding(entry, {
        checkId: CHECK_IDS.policyToolsFsWorkspaceOnlyRequired,
        message: `${toolPostureLabel(entry)} does not require workspace-only filesystem tools.`,
        requirement: `oc://${policyDocName}/${requirementBase}/fs/requireWorkspaceOnly`,
        fixHint: "Set tools.fs.workspaceOnly=true or update policy after review.",
      });
    });
}

function toolExecPostureFindings(
  toolsPolicy: Record<string, unknown>,
  policyDocName: string,
  requirementBase: string,
  evidence: PolicyEvidence,
  evidenceFilter: (entry: PolicyToolPostureEvidence) => boolean,
): readonly HealthFinding[] {
  return [
    ...toolStringPostureAllowFindings(toolsPolicy, policyDocName, requirementBase, evidence, {
      checkId: CHECK_IDS.policyToolsExecSecurityUnapproved,
      kind: "execSecurity",
      policyPath: ["exec", "allowSecurity"],
      requirementPath: "exec/allowSecurity",
      settingLabel: "exec security",
      evidenceFilter,
    }),
    ...toolStringPostureAllowFindings(toolsPolicy, policyDocName, requirementBase, evidence, {
      checkId: CHECK_IDS.policyToolsExecAskUnapproved,
      kind: "execAsk",
      policyPath: ["exec", "requireAsk"],
      requirementPath: "exec/requireAsk",
      settingLabel: "exec ask",
      evidenceFilter,
    }),
    ...toolStringPostureAllowFindings(toolsPolicy, policyDocName, requirementBase, evidence, {
      checkId: CHECK_IDS.policyToolsExecHostUnapproved,
      kind: "execHost",
      policyPath: ["exec", "allowHosts"],
      requirementPath: "exec/allowHosts",
      settingLabel: "exec host",
      evidenceFilter,
    }),
  ];
}

function toolStringPostureAllowFindings(
  toolsPolicy: Record<string, unknown>,
  policyDocName: string,
  requirementBase: string,
  evidence: PolicyEvidence,
  params: {
    readonly checkId: (typeof POLICY_CHECK_IDS)[number];
    readonly kind: PolicyToolPostureEvidence["kind"];
    readonly policyPath: readonly string[];
    readonly requirementPath: string;
    readonly settingLabel: string;
    readonly evidenceFilter: (entry: PolicyToolPostureEvidence) => boolean;
  },
): readonly HealthFinding[] {
  const allowed = new Set(readStringList(toolsPolicy, params.policyPath));
  if (allowed.size === 0) {
    return [];
  }
  return toolPostureEntries(evidence, params.kind)
    .filter(params.evidenceFilter)
    .filter((entry) => typeof entry.value === "string" && !allowed.has(entry.value.toLowerCase()))
    .map((entry): HealthFinding => {
      return toolPostureFinding(entry, {
        checkId: params.checkId,
        message: `${toolPostureLabel(entry)} uses unapproved ${params.settingLabel} '${entry.value ?? ""}'.`,
        requirement: `oc://${policyDocName}/${requirementBase}/${params.requirementPath}`,
        fixHint: "Adjust the configured tool posture or update policy after review.",
      });
    });
}

function toolElevatedFindings(
  toolsPolicy: Record<string, unknown>,
  policyDocName: string,
  requirementBase: string,
  evidence: PolicyEvidence,
  evidenceFilter: (entry: PolicyToolPostureEvidence) => boolean,
): readonly HealthFinding[] {
  if (readPolicyBoolean(toolsPolicy, ["elevated", "allow"]) !== false) {
    return [];
  }
  return toolPostureEntries(evidence, "elevatedEnabled")
    .filter(evidenceFilter)
    .filter((entry) => entry.value !== false)
    .map((entry): HealthFinding => {
      return toolPostureFinding(entry, {
        checkId: CHECK_IDS.policyToolsElevatedEnabled,
        message: `${toolPostureLabel(entry)} permits elevated tool mode.`,
        requirement: `oc://${policyDocName}/${requirementBase}/elevated/allow`,
        fixHint: "Set tools.elevated.enabled=false or update policy after review.",
      });
    });
}

function toolAlsoAllowExpectedFindings(
  toolsPolicy: Record<string, unknown>,
  policyDocName: string,
  requirementBase: string,
  evidence: PolicyEvidence,
  evidenceFilter: (entry: PolicyToolPostureEvidence) => boolean,
): readonly HealthFinding[] {
  const alsoAllowPolicy = isRecord(toolsPolicy.alsoAllow) ? toolsPolicy.alsoAllow : {};
  if (alsoAllowPolicy.expected === undefined) {
    return [];
  }
  const expected = normalizedStringSet(readStringList(toolsPolicy, ["alsoAllow", "expected"]));
  const findings: HealthFinding[] = [];
  for (const entry of toolPostureEntries(evidence, "alsoAllow").filter(evidenceFilter)) {
    const actual = normalizedStringSet(entry.entries ?? []);
    for (const expectedTool of expected) {
      if (actual.has(expectedTool)) {
        continue;
      }
      findings.push(
        toolPostureFinding(entry, {
          checkId: CHECK_IDS.policyToolsAlsoAllowMissing,
          message: `${toolPostureLabel(entry)} is missing expected tools.alsoAllow entry '${expectedTool}'.`,
          requirement: `oc://${policyDocName}/${requirementBase}/alsoAllow/expected`,
          fixHint: "Add the expected tools.alsoAllow entry or update policy after review.",
        }),
      );
    }
    for (const actualTool of actual) {
      if (expected.has(actualTool)) {
        continue;
      }
      findings.push(
        toolPostureFinding(entry, {
          checkId: CHECK_IDS.policyToolsAlsoAllowUnexpected,
          message: `${toolPostureLabel(entry)} has unexpected tools.alsoAllow entry '${actualTool}'.`,
          requirement: `oc://${policyDocName}/${requirementBase}/alsoAllow/expected`,
          fixHint: "Remove the unexpected tools.alsoAllow entry or update policy after review.",
        }),
      );
    }
  }
  return findings;
}

function normalizedStringSet(entries: readonly string[]): ReadonlySet<string> {
  return new Set(
    entries
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
      .toSorted(),
  );
}

function toolRequiredDenyFindings(
  toolsPolicy: Record<string, unknown>,
  policyDocName: string,
  requirementBase: string,
  evidence: PolicyEvidence,
  evidenceFilter: (entry: PolicyToolPostureEvidence) => boolean,
): readonly HealthFinding[] {
  const required = readStringList(toolsPolicy, ["denyTools"]);
  if (required.length === 0) {
    return [];
  }
  const requiredTools = uniqueStrings(required.flatMap(expandPolicyToolRequirement));
  const findings: HealthFinding[] = [];
  for (const entry of toolPostureEntries(evidence, "deny").filter(evidenceFilter)) {
    for (const tool of requiredTools) {
      if (toolListCoversTool(entry.entries ?? [], tool)) {
        continue;
      }
      findings.push(
        toolPostureFinding(entry, {
          checkId: CHECK_IDS.policyToolsRequiredDenyMissing,
          message: `${toolPostureLabel(entry)} does not deny required tool '${tool}'.`,
          requirement: `oc://${policyDocName}/${requirementBase}/denyTools`,
          fixHint:
            "Add the tool or group to tools.deny/agents.list[].tools.deny, or update policy after review.",
        }),
      );
    }
  }
  return findings;
}

function toolPostureEntries(
  evidence: PolicyEvidence,
  kind: PolicyToolPostureEvidence["kind"],
): readonly PolicyToolPostureEvidence[] {
  return (evidence.toolPosture ?? []).filter((entry) => entry.kind === kind);
}

function toolPostureFinding(
  entry: PolicyToolPostureEvidence,
  params: {
    readonly checkId: (typeof POLICY_CHECK_IDS)[number];
    readonly message: string;
    readonly requirement: string;
    readonly fixHint: string;
  },
): HealthFinding {
  return {
    checkId: params.checkId,
    severity: "error",
    message: params.message,
    source: "policy",
    path: "openclaw config",
    ocPath: entry.source,
    target: entry.source,
    requirement: params.requirement,
    fixHint: params.fixHint,
  };
}

function toolPostureLabel(entry: PolicyToolPostureEvidence): string {
  return entry.agentId === undefined ? "global tools config" : `agent '${entry.agentId}'`;
}

function sandboxPostureFindings(
  policy: unknown,
  policyPath: string,
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  if (!isRecord(policy)) {
    return [];
  }
  const findings: HealthFinding[] = [];
  const sandboxPolicy = policy.sandbox;
  if (
    isRecord(sandboxPolicy) &&
    sandboxPolicyShapeFinding(sandboxPolicy, { policyDocName, policyPath }) === undefined
  ) {
    findings.push(
      ...sandboxPostureFindingsForRule(
        sandboxPolicy,
        policyDocName,
        "sandbox",
        evidence,
        () => true,
      ),
    );
  }
  if (!hasValidScopedPolicy(policy, policyPath, policyDocName)) {
    return findings;
  }
  for (const target of agentScopedPolicyTargets(policy)) {
    const scopedSandboxPolicy = target.overlay.sandbox;
    if (
      sandboxPolicyShapeFinding(scopedSandboxPolicy, {
        policyDocName,
        policyPath,
        targetPrefix: `scopes/${ocPathSegment(target.scopeName)}/sandbox`,
        propertyPrefix: `scopes.${target.scopeName}.sandbox`,
      }) !== undefined ||
      !isRecord(scopedSandboxPolicy)
    ) {
      continue;
    }
    findings.push(
      ...sandboxPostureFindingsForRule(
        scopedSandboxPolicy,
        policyDocName,
        `scopes/${ocPathSegment(target.scopeName)}/sandbox`,
        evidence,
        (entry) => scopedSandboxAgentMatches(entry, target.agentId, evidence.sandboxPosture ?? []),
      ),
    );
  }
  return findings;
}

function sandboxPostureFindingsForRule(
  sandboxPolicy: Record<string, unknown> | undefined,
  policyDocName: string,
  requirementBase: string,
  evidence: PolicyEvidence,
  evidenceFilter: (entry: PolicySandboxPostureEvidence) => boolean,
): readonly HealthFinding[] {
  if (!isRecord(sandboxPolicy)) {
    return [];
  }
  return [
    ...sandboxModeFindings(sandboxPolicy, policyDocName, requirementBase, evidence, evidenceFilter),
    ...sandboxBackendFindings(
      sandboxPolicy,
      policyDocName,
      requirementBase,
      evidence,
      evidenceFilter,
    ),
    ...sandboxContainerPostureUnobservableFindings(
      sandboxPolicy,
      policyDocName,
      requirementBase,
      evidence,
      evidenceFilter,
    ),
    ...sandboxContainerHostNetworkFindings(
      sandboxPolicy,
      policyDocName,
      requirementBase,
      evidence,
      evidenceFilter,
    ),
    ...sandboxContainerNamespaceJoinFindings(
      sandboxPolicy,
      policyDocName,
      requirementBase,
      evidence,
      evidenceFilter,
    ),
    ...sandboxContainerMountModeFindings(
      sandboxPolicy,
      policyDocName,
      requirementBase,
      evidence,
      evidenceFilter,
    ),
    ...sandboxContainerRuntimeSocketMountFindings(
      sandboxPolicy,
      policyDocName,
      requirementBase,
      evidence,
      evidenceFilter,
    ),
    ...sandboxContainerUnconfinedProfileFindings(
      sandboxPolicy,
      policyDocName,
      requirementBase,
      evidence,
      evidenceFilter,
    ),
    ...sandboxBrowserCdpSourceRangeFindings(
      sandboxPolicy,
      policyDocName,
      requirementBase,
      evidence,
      evidenceFilter,
    ),
  ];
}

function scopedSandboxAgentMatches(
  entry: PolicySandboxPostureEvidence,
  policyAgentId: string,
  entries: readonly PolicySandboxPostureEvidence[],
): boolean {
  if (scopedAgentIdMatches(entry.agentId, policyAgentId)) {
    return true;
  }
  return (
    entry.scope === "defaults" &&
    !scopedSandboxDefaultDisabledForAgent(entry, policyAgentId, entries) &&
    !entries.some(
      (candidate) =>
        candidate.scope === "agent" &&
        sandboxPostureEntriesDescribeSameField(candidate, entry) &&
        scopedAgentIdMatches(candidate.agentId, policyAgentId),
    )
  );
}

function scopedSandboxDefaultDisabledForAgent(
  entry: PolicySandboxPostureEvidence,
  policyAgentId: string,
  entries: readonly PolicySandboxPostureEvidence[],
): boolean {
  if (sandboxEntryRequiresContainerBackend(entry)) {
    const backend = entries.find(
      (candidate) =>
        candidate.scope === "agent" &&
        candidate.kind === "backend" &&
        scopedAgentIdMatches(candidate.agentId, policyAgentId),
    );
    if (typeof backend?.value === "string" && backend.value.toLowerCase() !== "docker") {
      return true;
    }
  }

  if (sandboxEntryRequiresBrowser(entry)) {
    const browser = entries.find(
      (candidate) =>
        candidate.scope === "agent" &&
        candidate.kind === "browserCdpSourceRange" &&
        scopedAgentIdMatches(candidate.agentId, policyAgentId),
    );
    if (browser?.value === false) {
      return true;
    }
  }

  return false;
}

function sandboxEntryRequiresContainerBackend(entry: PolicySandboxPostureEvidence): boolean {
  return (
    (entry.kind === "containerNetwork" && entry.networkSurface === "docker") ||
    entry.kind === "containerSecurityProfile" ||
    (entry.kind === "containerMount" && entry.bindSurface === "docker")
  );
}

function sandboxEntryRequiresBrowser(entry: PolicySandboxPostureEvidence): boolean {
  return (
    entry.kind === "browserCdpSourceRange" ||
    (entry.kind === "containerNetwork" && entry.networkSurface === "browser") ||
    (entry.kind === "containerMount" && entry.bindSurface === "browser")
  );
}

function sandboxPostureEntriesDescribeSameField(
  candidate: PolicySandboxPostureEvidence,
  baseline: PolicySandboxPostureEvidence,
): boolean {
  return (
    candidate.kind === baseline.kind &&
    candidate.bindSurface === baseline.bindSurface &&
    candidate.networkSurface === baseline.networkSurface &&
    candidate.profile === baseline.profile
  );
}

function sandboxModeFindings(
  sandboxPolicy: Record<string, unknown>,
  policyDocName: string,
  requirementBase: string,
  evidence: PolicyEvidence,
  evidenceFilter: (entry: PolicySandboxPostureEvidence) => boolean,
): readonly HealthFinding[] {
  const allowed = new Set(readStringList(sandboxPolicy, ["requireMode"]));
  if (allowed.size === 0) {
    return [];
  }
  return sandboxPostureEntries(evidence, "mode")
    .filter(evidenceFilter)
    .filter((entry) => typeof entry.value === "string" && !allowed.has(entry.value.toLowerCase()))
    .map((entry) =>
      sandboxPostureFinding(entry, {
        checkId: CHECK_IDS.policySandboxModeUnapproved,
        message: `${sandboxPostureLabel(entry)} uses unapproved sandbox mode '${entry.value ?? ""}'.`,
        requirement: `oc://${policyDocName}/${requirementBase}/requireMode`,
        fixHint:
          "Set agents.defaults.sandbox.mode or agents.list[].sandbox.mode to an approved value.",
      }),
    );
}

function sandboxBackendFindings(
  sandboxPolicy: Record<string, unknown>,
  policyDocName: string,
  requirementBase: string,
  evidence: PolicyEvidence,
  evidenceFilter: (entry: PolicySandboxPostureEvidence) => boolean,
): readonly HealthFinding[] {
  const allowed = new Set(readStringList(sandboxPolicy, ["allowBackends"]));
  if (allowed.size === 0) {
    return [];
  }
  return sandboxPostureEntries(evidence, "backend")
    .filter(evidenceFilter)
    .filter((entry) => typeof entry.value === "string" && !allowed.has(entry.value.toLowerCase()))
    .map((entry) =>
      sandboxPostureFinding(entry, {
        checkId: CHECK_IDS.policySandboxBackendUnapproved,
        message: `${sandboxPostureLabel(entry)} uses unapproved sandbox backend '${entry.value ?? ""}'.`,
        requirement: `oc://${policyDocName}/${requirementBase}/allowBackends`,
        fixHint: "Use an approved sandbox backend or update policy after review.",
      }),
    );
}

function sandboxContainerPostureUnobservableFindings(
  sandboxPolicy: Record<string, unknown>,
  policyDocName: string,
  requirementBase: string,
  evidence: PolicyEvidence,
  evidenceFilter: (entry: PolicySandboxPostureEvidence) => boolean,
): readonly HealthFinding[] {
  const enabledRules = SANDBOX_CONTAINER_POLICY_RULES.filter(
    (rule) => readPolicyBoolean(sandboxPolicy, ["containers", rule.key]) === true,
  );
  if (enabledRules.length === 0) {
    return [];
  }
  return sandboxPostureEntries(evidence, "backend")
    .filter(evidenceFilter)
    .filter((entry) => typeof entry.value === "string" && entry.value.toLowerCase() !== "docker")
    .flatMap((entry) =>
      enabledRules.map((rule) =>
        sandboxPostureFinding(entry, {
          checkId: CHECK_IDS.policySandboxContainerPostureUnobservable,
          message: `${sandboxPostureLabel(entry)} uses sandbox backend '${entry.value ?? ""}', which cannot observe ${rule.label}.`,
          requirement: `oc://${policyDocName}/${requirementBase}/containers/${rule.key}`,
          fixHint:
            "Use an observable container backend for this sandbox or remove the container posture rule.",
        }),
      ),
    );
}

function sandboxContainerHostNetworkFindings(
  sandboxPolicy: Record<string, unknown>,
  policyDocName: string,
  requirementBase: string,
  evidence: PolicyEvidence,
  evidenceFilter: (entry: PolicySandboxPostureEvidence) => boolean,
): readonly HealthFinding[] {
  if (readPolicyBoolean(sandboxPolicy, ["containers", "denyHostNetwork"]) !== true) {
    return [];
  }
  return sandboxPostureEntries(evidence, "containerNetwork")
    .filter(evidenceFilter)
    .filter((entry) => typeof entry.value === "string" && entry.value.toLowerCase() === "host")
    .map((entry) =>
      sandboxPostureFinding(entry, {
        checkId: CHECK_IDS.policySandboxContainerHostNetworkDenied,
        message: `${sandboxPostureLabel(entry)} uses host container network mode.`,
        requirement: `oc://${policyDocName}/${requirementBase}/containers/denyHostNetwork`,
        fixHint: "Change the container network mode or update policy after review.",
      }),
    );
}

function sandboxContainerNamespaceJoinFindings(
  sandboxPolicy: Record<string, unknown>,
  policyDocName: string,
  requirementBase: string,
  evidence: PolicyEvidence,
  evidenceFilter: (entry: PolicySandboxPostureEvidence) => boolean,
): readonly HealthFinding[] {
  if (readPolicyBoolean(sandboxPolicy, ["containers", "denyContainerNamespaceJoin"]) !== true) {
    return [];
  }
  const containerNamespacePrefix = "container:";
  return sandboxPostureEntries(evidence, "containerNetwork")
    .filter(evidenceFilter)
    .filter(
      (entry) =>
        typeof entry.value === "string" &&
        entry.value.toLowerCase().startsWith(containerNamespacePrefix),
    )
    .map((entry) =>
      sandboxPostureFinding(entry, {
        checkId: CHECK_IDS.policySandboxContainerNamespaceJoinDenied,
        message: `${sandboxPostureLabel(entry)} joins another container network namespace '${entry.value ?? ""}'.`,
        requirement: `oc://${policyDocName}/${requirementBase}/containers/denyContainerNamespaceJoin`,
        fixHint: "Change the container network mode or update policy after review.",
      }),
    );
}

function sandboxContainerMountModeFindings(
  sandboxPolicy: Record<string, unknown>,
  policyDocName: string,
  requirementBase: string,
  evidence: PolicyEvidence,
  evidenceFilter: (entry: PolicySandboxPostureEvidence) => boolean,
): readonly HealthFinding[] {
  if (readPolicyBoolean(sandboxPolicy, ["containers", "requireReadOnlyMounts"]) !== true) {
    return [];
  }
  return sandboxPostureEntries(evidence, "containerMount")
    .filter(evidenceFilter)
    .filter((entry) => entry.bindMode !== "ro")
    .map((entry) =>
      sandboxPostureFinding(entry, {
        checkId: CHECK_IDS.policySandboxContainerMountModeRequired,
        message: `${sandboxPostureLabel(entry)} has container mount '${entry.bind ?? ""}' with mode '${entry.bindMode ?? "unknown"}'.`,
        requirement: `oc://${policyDocName}/${requirementBase}/containers/requireReadOnlyMounts`,
        fixHint: "Set the mount mode to read-only or update policy after review.",
      }),
    );
}

function sandboxContainerRuntimeSocketMountFindings(
  sandboxPolicy: Record<string, unknown>,
  policyDocName: string,
  requirementBase: string,
  evidence: PolicyEvidence,
  evidenceFilter: (entry: PolicySandboxPostureEvidence) => boolean,
): readonly HealthFinding[] {
  if (
    readPolicyBoolean(sandboxPolicy, ["containers", "denyContainerRuntimeSocketMounts"]) !== true
  ) {
    return [];
  }
  return sandboxPostureEntries(evidence, "containerMount")
    .filter(evidenceFilter)
    .filter((entry) => bindHostLooksLikeContainerRuntimeSocket(entry.bindHost))
    .map((entry) =>
      sandboxPostureFinding(entry, {
        checkId: CHECK_IDS.policySandboxContainerRuntimeSocketMount,
        message: `${sandboxPostureLabel(entry)} binds host container runtime socket '${entry.bindHost ?? ""}'.`,
        requirement: `oc://${policyDocName}/${requirementBase}/containers/denyContainerRuntimeSocketMounts`,
        fixHint: "Remove the container runtime socket bind or update policy after review.",
      }),
    );
}

function sandboxContainerUnconfinedProfileFindings(
  sandboxPolicy: Record<string, unknown>,
  policyDocName: string,
  requirementBase: string,
  evidence: PolicyEvidence,
  evidenceFilter: (entry: PolicySandboxPostureEvidence) => boolean,
): readonly HealthFinding[] {
  if (readPolicyBoolean(sandboxPolicy, ["containers", "denyUnconfinedProfiles"]) !== true) {
    return [];
  }
  return sandboxPostureEntries(evidence, "containerSecurityProfile")
    .filter(evidenceFilter)
    .filter(
      (entry) => typeof entry.value === "string" && entry.value.toLowerCase() === "unconfined",
    )
    .map((entry) =>
      sandboxPostureFinding(entry, {
        checkId: CHECK_IDS.policySandboxContainerUnconfinedProfile,
        message: `${sandboxPostureLabel(entry)} sets container ${entry.profile ?? "security"} profile to unconfined.`,
        requirement: `oc://${policyDocName}/${requirementBase}/containers/denyUnconfinedProfiles`,
        fixHint: "Remove the unconfined container profile or update policy after review.",
      }),
    );
}

function sandboxBrowserCdpSourceRangeFindings(
  sandboxPolicy: Record<string, unknown>,
  policyDocName: string,
  requirementBase: string,
  evidence: PolicyEvidence,
  evidenceFilter: (entry: PolicySandboxPostureEvidence) => boolean,
): readonly HealthFinding[] {
  if (readPolicyBoolean(sandboxPolicy, ["browser", "requireCdpSourceRange"]) !== true) {
    return [];
  }
  return sandboxPostureEntries(evidence, "browserCdpSourceRange")
    .filter(evidenceFilter)
    .filter((entry) => entry.value === undefined)
    .map((entry) =>
      sandboxPostureFinding(entry, {
        checkId: CHECK_IDS.policySandboxBrowserCdpSourceRangeMissing,
        message: `${sandboxPostureLabel(entry)} enables sandbox browser without cdpSourceRange.`,
        requirement: `oc://${policyDocName}/${requirementBase}/browser/requireCdpSourceRange`,
        fixHint: "Set agents.*.sandbox.browser.cdpSourceRange or update policy after review.",
      }),
    );
}

function sandboxPostureEntries(
  evidence: PolicyEvidence,
  kind: PolicySandboxPostureEvidence["kind"],
): readonly PolicySandboxPostureEvidence[] {
  return (evidence.sandboxPosture ?? []).filter((entry) => entry.kind === kind);
}

function sandboxPostureFinding(
  entry: PolicySandboxPostureEvidence,
  params: {
    readonly checkId: (typeof POLICY_CHECK_IDS)[number];
    readonly message: string;
    readonly requirement: string;
    readonly fixHint: string;
  },
): HealthFinding {
  return {
    checkId: params.checkId,
    severity: "error",
    message: params.message,
    source: "policy",
    path: "openclaw config",
    ocPath: entry.source,
    target: entry.source,
    requirement: params.requirement,
    fixHint: params.fixHint,
  };
}

function sandboxPostureLabel(entry: PolicySandboxPostureEvidence): string {
  return entry.agentId === undefined ? "default sandbox config" : `agent '${entry.agentId}'`;
}

const CONTAINER_RUNTIME_SOCKET_BASENAMES = new Set([
  "containerd.sock",
  "docker.sock",
  "podman.sock",
]);

const CONTAINER_RUNTIME_SOCKET_PATHS = new Set([
  "/run/containerd/containerd.sock",
  "/run/docker.sock",
  "/run/podman/podman.sock",
  "/var/run/docker.sock",
  "/var/run/podman/podman.sock",
]);

function bindHostLooksLikeContainerRuntimeSocket(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  const normalized = value.replaceAll("\\", "/").toLowerCase();
  const basenameLocal = normalized.split("/").at(-1) ?? "";
  return (
    CONTAINER_RUNTIME_SOCKET_PATHS.has(normalized) ||
    CONTAINER_RUNTIME_SOCKET_BASENAMES.has(basenameLocal)
  );
}

function secretAuthProvenanceFindings(
  policy: unknown,
  policyPath: string,
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  const secretShapeFindings = secretPolicyShapeFindings(policy, policyPath, policyDocName);
  const authShapeFindings = authProfileAllowModesShapeFindings(policy, policyPath, policyDocName);
  return [
    ...(secretShapeFindings.length > 0
      ? secretShapeFindings
      : [
          ...secretManagedProviderFindings(policy, policyDocName, evidence),
          ...secretDeniedSourceFindings(policy, policyDocName, evidence),
          ...secretInsecureProviderFindings(policy, policyDocName, evidence),
        ]),
    ...(authShapeFindings.length > 0
      ? authShapeFindings
      : [
          ...authProfileMetadataFindings(policy, policyDocName, evidence),
          ...authProfileModeFindings(policy, policyDocName, evidence),
        ]),
  ];
}

function dataHandlingFindings(
  policy: unknown,
  policyPath: string,
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  const shapeFindings = dataHandlingPolicyShapeFindings(policy, policyPath, policyDocName);
  if (shapeFindings.length > 0) {
    return shapeFindings;
  }
  const findings: HealthFinding[] = [];
  findings.push(
    ...dataHandlingFindingsForRule(policy, policyDocName, "dataHandling", evidence, () => true),
  );
  for (const target of agentScopedPolicyTargets(policy)) {
    if (!dataHandlingPolicyHasRules(target.overlay.dataHandling)) {
      continue;
    }
    findings.push(
      ...dataHandlingFindingsForRule(
        target.overlay,
        policyDocName,
        `scopes/${ocPathSegment(target.scopeName)}/dataHandling`,
        evidence,
        (entry) =>
          entry.kind !== "memorySessionTranscriptIndexing" ||
          scopedDataHandlingAgentMatches(entry, target.agentId, evidence.dataHandling ?? []),
      ),
    );
  }
  return findings;
}

function scopedDataHandlingAgentMatches(
  entry: PolicyDataHandlingEvidence,
  policyAgentId: string,
  entries: readonly PolicyDataHandlingEvidence[],
): boolean {
  if (entry.id === "memory-qmd-session-transcripts") {
    return true;
  }
  if (scopedAgentIdMatches(entry.agentId, policyAgentId)) {
    return true;
  }
  return (
    entry.id === "agents-defaults-memory-session-transcripts" &&
    !entries.some(
      (candidate) =>
        candidate.scope === "agent" &&
        candidate.kind === entry.kind &&
        scopedAgentIdMatches(candidate.agentId, policyAgentId),
    )
  );
}

function dataHandlingFindingsForRule(
  policy: unknown,
  policyDocName: string,
  requirementBase: string,
  evidence: PolicyEvidence,
  evidenceFilter: (entry: PolicyDataHandlingEvidence) => boolean,
): readonly HealthFinding[] {
  const dataHandling = isRecord(policy) ? policy.dataHandling : undefined;
  if (!isRecord(dataHandling)) {
    return [];
  }
  const findings: HealthFinding[] = [];
  if (readPolicyBoolean(dataHandling, ["sensitiveLogging", "requireRedaction"]) === true) {
    findings.push(
      ...dataHandlingEntries(evidence, "sensitiveLoggingRedaction")
        .filter(evidenceFilter)
        .filter((entry) => entry.value !== true)
        .map((entry) =>
          dataHandlingFinding(entry, {
            checkId: CHECK_IDS.policyDataHandlingRedactionDisabled,
            message: "Sensitive logging redaction is disabled.",
            requirement: `oc://${policyDocName}/${requirementBase}/sensitiveLogging/requireRedaction`,
            fixHint: "Set logging.redactSensitive to tools or update policy after review.",
          }),
        ),
    );
  }
  if (readPolicyBoolean(dataHandling, ["telemetry", "denyContentCapture"]) === true) {
    findings.push(
      ...dataHandlingEntries(evidence, "telemetryContentCapture")
        .filter(evidenceFilter)
        .filter((entry) => entry.value === true)
        .map((entry) =>
          dataHandlingFinding(entry, {
            checkId: CHECK_IDS.policyDataHandlingTelemetryContentCapture,
            message: "Telemetry content capture is enabled.",
            requirement: `oc://${policyDocName}/${requirementBase}/telemetry/denyContentCapture`,
            fixHint: "Disable diagnostics.otel.captureContent or update policy after review.",
          }),
        ),
    );
  }
  if (readPolicyBoolean(dataHandling, ["retention", "requireSessionMaintenance"]) === true) {
    findings.push(
      ...dataHandlingEntries(evidence, "sessionRetentionMode")
        .filter(evidenceFilter)
        .filter((entry) => entry.value !== "enforce")
        .map((entry) =>
          dataHandlingFinding(entry, {
            checkId: CHECK_IDS.policyDataHandlingSessionRetentionNotEnforced,
            message: `Session retention maintenance mode is '${entry.value ?? "unknown"}'.`,
            requirement: `oc://${policyDocName}/${requirementBase}/retention/requireSessionMaintenance`,
            fixHint: "Set session.maintenance.mode to enforce or update policy after review.",
          }),
        ),
    );
  }
  if (readPolicyBoolean(dataHandling, ["memory", "denySessionTranscriptIndexing"]) === true) {
    findings.push(
      ...dataHandlingEntries(evidence, "memorySessionTranscriptIndexing")
        .filter(evidenceFilter)
        .filter((entry) => entry.value === true)
        .map((entry) =>
          dataHandlingFinding(entry, {
            checkId: CHECK_IDS.policyDataHandlingSessionTranscriptMemory,
            message: `${dataHandlingLabel(entry)} enables session transcript memory indexing.`,
            requirement: `oc://${policyDocName}/${requirementBase}/memory/denySessionTranscriptIndexing`,
            fixHint:
              "Disable session transcript memory indexing for the matching config surface or update policy after review.",
          }),
        ),
    );
  }
  return findings;
}

function dataHandlingPolicyShapeFindings(
  policy: unknown,
  policyPath: string,
  policyDocName: string,
): readonly HealthFinding[] {
  if (!isRecord(policy)) {
    return [];
  }
  if (!isRecord(policy.dataHandling)) {
    return [];
  }
  return [
    policySectionUnsupportedKeyFinding(policy.dataHandling, {
      policyPath,
      policyDocName,
      propertyPath: "dataHandling",
      targetPath: "dataHandling",
      sectionName: "data-handling",
      allowedKeys: ["memory", "retention", "sensitiveLogging", "telemetry"],
    }),
    dataHandlingSectionShapeFinding(policy.dataHandling, {
      policyPath,
      policyDocName,
      propertyPath: "dataHandling.sensitiveLogging",
      targetPath: "dataHandling/sensitiveLogging",
      section: "sensitiveLogging",
    }),
    dataHandlingSectionShapeFinding(policy.dataHandling, {
      policyPath,
      policyDocName,
      propertyPath: "dataHandling.telemetry",
      targetPath: "dataHandling/telemetry",
      section: "telemetry",
    }),
    dataHandlingSectionShapeFinding(policy.dataHandling, {
      policyPath,
      policyDocName,
      propertyPath: "dataHandling.retention",
      targetPath: "dataHandling/retention",
      section: "retention",
    }),
    dataHandlingSectionShapeFinding(policy.dataHandling, {
      policyPath,
      policyDocName,
      propertyPath: "dataHandling.memory",
      targetPath: "dataHandling/memory",
      section: "memory",
    }),
    dataHandlingBooleanShapeFinding(policy.dataHandling, {
      policyPath,
      policyDocName,
      propertyPath: "dataHandling.sensitiveLogging.requireRedaction",
      targetPath: "dataHandling/sensitiveLogging/requireRedaction",
      path: ["sensitiveLogging", "requireRedaction"],
    }),
    dataHandlingBooleanShapeFinding(policy.dataHandling, {
      policyPath,
      policyDocName,
      propertyPath: "dataHandling.telemetry.denyContentCapture",
      targetPath: "dataHandling/telemetry/denyContentCapture",
      path: ["telemetry", "denyContentCapture"],
    }),
    dataHandlingBooleanShapeFinding(policy.dataHandling, {
      policyPath,
      policyDocName,
      propertyPath: "dataHandling.retention.requireSessionMaintenance",
      targetPath: "dataHandling/retention/requireSessionMaintenance",
      path: ["retention", "requireSessionMaintenance"],
    }),
    dataHandlingBooleanShapeFinding(policy.dataHandling, {
      policyPath,
      policyDocName,
      propertyPath: "dataHandling.memory.denySessionTranscriptIndexing",
      targetPath: "dataHandling/memory/denySessionTranscriptIndexing",
      path: ["memory", "denySessionTranscriptIndexing"],
    }),
  ].filter((finding): finding is HealthFinding => finding !== undefined);
}

function policySectionUnsupportedKeyFinding(
  value: Record<string, unknown>,
  params: {
    readonly policyPath: string;
    readonly policyDocName: string;
    readonly propertyPath: string;
    readonly targetPath: string;
    readonly sectionName: string;
    readonly allowedKeys: readonly string[];
  },
): HealthFinding | undefined {
  const unsupportedKey = unsupportedPolicyKey(value, params.allowedKeys);
  if (unsupportedKey === undefined) {
    return undefined;
  }
  return policyShapeFinding(
    params.policyPath,
    `oc://${params.policyDocName}/${params.targetPath}/${ocPathSegment(unsupportedKey)}`,
    `${params.policyPath} ${params.propertyPath}.${unsupportedKey} is not supported in ${params.sectionName} policy.`,
    `Remove ${params.propertyPath}.${unsupportedKey} or use a supported ${params.sectionName} policy rule.`,
  );
}

function dataHandlingSectionShapeFinding(
  dataHandling: Record<string, unknown>,
  params: {
    readonly policyPath: string;
    readonly policyDocName: string;
    readonly propertyPath: string;
    readonly targetPath: string;
    readonly section: string;
  },
): HealthFinding | undefined {
  const value = dataHandling[params.section];
  if (value === undefined || isRecord(value)) {
    return undefined;
  }
  return policyShapeFinding(
    params.policyPath,
    `oc://${params.policyDocName}/${params.targetPath}`,
    `${params.policyPath} ${params.propertyPath} must be an object.`,
    `Fix ${params.propertyPath} so it contains boolean policy rules.`,
  );
}

function dataHandlingBooleanShapeFinding(
  dataHandling: unknown,
  params: {
    readonly policyPath: string;
    readonly policyDocName: string;
    readonly propertyPath: string;
    readonly targetPath: string;
    readonly path: readonly string[];
  },
): HealthFinding | undefined {
  const value = getPolicyPath(dataHandling, params.path);
  if (isRecord(dataHandling) && typeof params.path[0] === "string") {
    const section = dataHandling[params.path[0]];
    if (isRecord(section) && typeof params.path[1] === "string") {
      const sectionPath = params.path.slice(0, -1).join(".");
      const unsupportedKey = unsupportedPolicyKey(section, [params.path[1]]);
      if (unsupportedKey !== undefined) {
        return policyShapeFinding(
          params.policyPath,
          `oc://${params.policyDocName}/${params.targetPath
            .split("/")
            .slice(0, -1)
            .join("/")}/${ocPathSegment(unsupportedKey)}`,
          `${params.policyPath} dataHandling.${sectionPath}.${unsupportedKey} is not supported in data-handling policy.`,
          `Remove dataHandling.${sectionPath}.${unsupportedKey} or use ${params.propertyPath}.`,
        );
      }
    }
  }
  if (value === undefined || typeof value === "boolean") {
    return undefined;
  }
  return policyShapeFinding(
    params.policyPath,
    `oc://${params.policyDocName}/${params.targetPath}`,
    `${params.policyPath} ${params.propertyPath} must be a boolean.`,
    `Set ${params.propertyPath} to true or false.`,
  );
}

function dataHandlingEntries(
  evidence: PolicyEvidence,
  kind: PolicyDataHandlingEvidence["kind"],
): readonly PolicyDataHandlingEvidence[] {
  return (evidence.dataHandling ?? []).filter((entry) => entry.kind === kind);
}

function dataHandlingFinding(
  entry: PolicyDataHandlingEvidence,
  params: {
    readonly checkId: (typeof POLICY_CHECK_IDS)[number];
    readonly message: string;
    readonly requirement: string;
    readonly fixHint: string;
  },
): HealthFinding {
  return {
    checkId: params.checkId,
    severity: "error",
    message: params.message,
    source: "policy",
    path: "openclaw config",
    ocPath: entry.source,
    target: entry.source,
    requirement: params.requirement,
    fixHint: params.fixHint,
  };
}

function dataHandlingLabel(entry: PolicyDataHandlingEvidence): string {
  return entry.agentId === undefined ? "Global data handling config" : `agent '${entry.agentId}'`;
}

function policyHasExecApprovalsRules(policy: unknown): boolean {
  if (!isRecord(policy)) {
    return false;
  }
  if (execApprovalsPolicyHasRules(policy.execApprovals)) {
    return true;
  }
  return agentScopedPolicyOverlays(policy).some(([, overlay]) =>
    execApprovalsPolicyHasRules(overlay.execApprovals),
  );
}

function execApprovalsPolicyHasRules(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.requireFile !== undefined || isRecord(value.defaults) || isRecord(value.agents))
  );
}

function policyHasSecretRules(policy: unknown): boolean {
  if (!isRecord(policy) || !isRecord(policy.secrets)) {
    return false;
  }
  return (
    policy.secrets.requireManagedProviders !== undefined ||
    policy.secrets.denySources !== undefined ||
    policy.secrets.allowInsecureProviders !== undefined
  );
}

function policyHasAuthProfileRules(policy: unknown): boolean {
  return (
    isRecord(policy) &&
    isRecord(policy.auth) &&
    isRecord(policy.auth.profiles) &&
    (policy.auth.profiles.requireMetadata !== undefined ||
      policy.auth.profiles.allowModes !== undefined)
  );
}

function policyHasIngressRules(policy: unknown): boolean {
  if (!isRecord(policy)) {
    return false;
  }
  if (ingressPolicyHasRules(policy.ingress)) {
    return true;
  }
  return agentScopedPolicyOverlays(policy).some(([, overlay]) =>
    ingressPolicyHasRules(overlay.ingress),
  );
}

function ingressPolicyHasRules(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const ingress = value;
  return (
    (isRecord(ingress.session) && ingress.session.requireDmScope !== undefined) ||
    (isRecord(ingress.channels) &&
      (ingress.channels.allowDmPolicies !== undefined ||
        ingress.channels.denyOpenGroups !== undefined ||
        ingress.channels.requireMentionInGroups !== undefined))
  );
}

function policyHasGatewayRules(policy: unknown): boolean {
  if (!isRecord(policy) || !isRecord(policy.gateway)) {
    return false;
  }
  const gateway = policy.gateway;
  return (
    (isRecord(gateway.exposure) &&
      (gateway.exposure.allowNonLoopbackBind !== undefined ||
        gateway.exposure.allowTailscaleFunnel !== undefined)) ||
    (isRecord(gateway.auth) &&
      (gateway.auth.requireAuth !== undefined ||
        gateway.auth.requireExplicitRateLimit !== undefined)) ||
    (isRecord(gateway.controlUi) && gateway.controlUi.allowInsecure !== undefined) ||
    (isRecord(gateway.remote) && gateway.remote.allow !== undefined) ||
    (isRecord(gateway.http) &&
      (gateway.http.denyEndpoints !== undefined ||
        gateway.http.requireUrlAllowlists !== undefined)) ||
    (isRecord(gateway.nodes) && gateway.nodes.denyCommands !== undefined)
  );
}

function policyHasAgentWorkspaceRules(policy: unknown): boolean {
  if (!isRecord(policy)) {
    return false;
  }
  if (isRecord(policy.agents) && workspacePolicyHasRules(policy.agents.workspace)) {
    return true;
  }
  return agentScopedPolicyOverlays(policy).some(([, overlay]) => {
    const scopedAgents = isRecord(overlay.agents) ? overlay.agents : {};
    return workspacePolicyHasRules(scopedAgents.workspace);
  });
}

function policyHasSandboxPostureRules(policy: unknown): boolean {
  if (!isRecord(policy)) {
    return false;
  }
  if (sandboxPosturePolicyHasRules(policy.sandbox)) {
    return true;
  }
  return agentScopedPolicyOverlays(policy).some(([, overlay]) =>
    sandboxPosturePolicyHasRules(overlay.sandbox),
  );
}

function sandboxPosturePolicyHasRules(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const sandbox = value;
  const containers = isRecord(sandbox.containers) ? sandbox.containers : undefined;
  const browser = isRecord(sandbox.browser) ? sandbox.browser : undefined;
  return (
    sandbox.requireMode !== undefined ||
    sandbox.allowBackends !== undefined ||
    (containers !== undefined &&
      SANDBOX_CONTAINER_POLICY_RULES.some((rule) => containers[rule.key] !== undefined)) ||
    browser?.requireCdpSourceRange !== undefined
  );
}

function policyHasDataHandlingRules(policy: unknown): boolean {
  if (!isRecord(policy)) {
    return false;
  }
  if (dataHandlingPolicyHasRules(policy.dataHandling)) {
    return true;
  }
  return agentScopedPolicyOverlays(policy).some(([, overlay]) =>
    dataHandlingPolicyHasRules(overlay.dataHandling),
  );
}

function dataHandlingPolicyHasRules(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const dataHandling = value;
  return (
    (isRecord(dataHandling.sensitiveLogging) &&
      dataHandling.sensitiveLogging.requireRedaction !== undefined) ||
    (isRecord(dataHandling.telemetry) && dataHandling.telemetry.denyContentCapture !== undefined) ||
    (isRecord(dataHandling.retention) &&
      dataHandling.retention.requireSessionMaintenance !== undefined) ||
    (isRecord(dataHandling.memory) &&
      dataHandling.memory.denySessionTranscriptIndexing !== undefined)
  );
}

function policyHasToolPostureRules(policy: unknown): boolean {
  if (!isRecord(policy)) {
    return false;
  }
  if (toolPosturePolicyHasRules(policy.tools)) {
    return true;
  }
  return agentScopedPolicyOverlays(policy).some(([, overlay]) =>
    toolPosturePolicyHasRules(overlay.tools),
  );
}

function workspacePolicyHasRules(value: unknown): boolean {
  return isRecord(value) && (value.allowedAccess !== undefined || value.denyTools !== undefined);
}

function toolPosturePolicyHasRules(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const tools = value;
  return (
    (isRecord(tools.profiles) && tools.profiles.allow !== undefined) ||
    (isRecord(tools.fs) && tools.fs.requireWorkspaceOnly !== undefined) ||
    (isRecord(tools.exec) &&
      (tools.exec.allowSecurity !== undefined ||
        tools.exec.requireAsk !== undefined ||
        tools.exec.allowHosts !== undefined)) ||
    (isRecord(tools.elevated) && tools.elevated.allow !== undefined) ||
    (isRecord(tools.alsoAllow) && tools.alsoAllow.expected !== undefined) ||
    tools.denyTools !== undefined
  );
}

type AgentScopedPolicyTarget = {
  readonly scopeName: string;
  readonly agentId: string;
  readonly overlay: Record<string, unknown>;
};

type ChannelScopedPolicyTarget = {
  readonly scopeName: string;
  readonly channelId: string;
  readonly overlay: Record<string, unknown>;
};

function agentScopedPolicyOverlays(
  policy: unknown,
): readonly (readonly [string, Record<string, unknown>])[] {
  if (!isRecord(policy) || !isRecord(policy.scopes)) {
    return [];
  }
  return Object.entries(policy.scopes).filter((entry): entry is [string, Record<string, unknown>] =>
    isRecord(entry[1]),
  );
}

function agentScopedPolicyTargets(policy: unknown): readonly AgentScopedPolicyTarget[] {
  const targets: AgentScopedPolicyTarget[] = [];
  for (const [scopeName, overlay] of agentScopedPolicyOverlays(policy)) {
    if (!Array.isArray(overlay.agentIds)) {
      continue;
    }
    for (const rawAgentId of overlay.agentIds) {
      if (typeof rawAgentId !== "string" || rawAgentId.trim() === "") {
        continue;
      }
      targets.push({ scopeName, agentId: normalizeAgentId(rawAgentId), overlay });
    }
  }
  return targets;
}

function channelScopedPolicyTargets(policy: unknown): readonly ChannelScopedPolicyTarget[] {
  const targets: ChannelScopedPolicyTarget[] = [];
  for (const [scopeName, overlay] of agentScopedPolicyOverlays(policy)) {
    if (!Array.isArray(overlay.channelIds)) {
      continue;
    }
    for (const rawChannelId of overlay.channelIds) {
      if (typeof rawChannelId !== "string" || rawChannelId.trim() === "") {
        continue;
      }
      targets.push({ scopeName, channelId: normalizePolicyChannelId(rawChannelId), overlay });
    }
  }
  return targets;
}

type ScopedPolicyField = {
  readonly fieldPath: string;
  readonly propertyPath: string;
  readonly targetPath: string;
  readonly metadata: PolicyRuleMetadata;
  readonly value: unknown;
};

function duplicateScopedPolicyFieldFinding(
  scopes: Record<string, unknown>,
  params: {
    readonly policyDocName: string;
    readonly policyPath: string;
    readonly policy: Record<string, unknown>;
  },
): HealthFinding | undefined {
  return (
    duplicateScopedFieldFinding(scopes, {
      ...params,
      selector: "agentIds",
      selectorLabel: "agent",
      normalize: normalizeAgentId,
    }) ??
    duplicateScopedFieldFinding(scopes, {
      ...params,
      selector: "channelIds",
      selectorLabel: "channel",
      normalize: normalizePolicyChannelId,
    })
  );
}

function duplicateScopedFieldFinding(
  scopes: Record<string, unknown>,
  params: {
    readonly policyDocName: string;
    readonly policyPath: string;
    readonly policy: Record<string, unknown>;
    readonly selector: PolicyScopeSelectorKind;
    readonly selectorLabel: string;
    readonly normalize: (value: string) => string;
  },
): HealthFinding | undefined {
  const seen = new Map<
    string,
    {
      readonly scopeName: string;
      readonly propertyPath: string;
      readonly field: ScopedPolicyField;
    }
  >();
  for (const [scopeName, overlay] of Object.entries(scopes)) {
    if (!isRecord(overlay)) {
      continue;
    }
    const selectorValues = overlay[params.selector];
    if (!Array.isArray(selectorValues)) {
      continue;
    }
    const fields = scopedPolicyFields(scopeName, overlay, params.selector);
    for (const rawSelectorValue of selectorValues) {
      if (typeof rawSelectorValue !== "string" || rawSelectorValue.trim() === "") {
        continue;
      }
      const selectorValue = params.normalize(rawSelectorValue);
      for (const field of fields) {
        const topLevelValue = getPolicyPath(params.policy, field.metadata.policyPath);
        if (
          topLevelValue !== undefined &&
          !isPolicyValueAtLeastAsStrict(field.metadata, field.value, topLevelValue)
        ) {
          return policyShapeFinding(
            params.policyPath,
            `oc://${params.policyDocName}/${field.targetPath}`,
            `${params.policyPath} scopes.${scopeName}.${field.propertyPath} is weaker than the top-level ${field.propertyPath} policy.`,
            `Use an equally or more restrictive scoped value, or remove the scoped override.`,
          );
        }
        const key = `${selectorValue}\0${field.fieldPath}`;
        const previous = seen.get(key);
        if (previous !== undefined) {
          if (isPolicyValueAtLeastAsStrict(field.metadata, field.value, previous.field.value)) {
            seen.set(key, {
              scopeName,
              propertyPath: `scopes.${scopeName}.${field.propertyPath}`,
              field,
            });
            continue;
          }
          return policyShapeFinding(
            params.policyPath,
            `oc://${params.policyDocName}/${field.targetPath}`,
            `${params.policyPath} scopes.${scopeName}.${field.propertyPath} is not an equally or more restrictive override of ${previous.propertyPath} for ${params.selectorLabel} '${selectorValue}'.`,
            `Use one effective scoped value per ${params.selectorLabel}, or make later scoped values stricter according to policy metadata.`,
          );
        }
        seen.set(key, {
          scopeName,
          propertyPath: `scopes.${scopeName}.${field.propertyPath}`,
          field,
        });
      }
    }
  }
  return undefined;
}

function scopedPolicyFields(
  scopeName: string,
  overlay: Record<string, unknown>,
  selector: PolicyScopeSelectorKind,
): readonly ScopedPolicyField[] {
  const prefix = `scopes/${ocPathSegment(scopeName)}`;
  return POLICY_RULES.filter((rule) => rule.scopeSelectors?.includes(selector) === true)
    .map((rule) => ({ rule, value: scopedPolicyValue(overlay, rule.policyPath) }))
    .filter((entry) => entry.value !== undefined)
    .map(({ rule, value }) => ({
      fieldPath: rule.policyPath.join("."),
      propertyPath: rule.policyPath.join("."),
      targetPath: `${prefix}/${rule.policyPath.map(ocPathSegment).join("/")}`,
      metadata: rule,
      value,
    }));
}

function scopedPolicyValue(overlay: Record<string, unknown>, path: readonly string[]): unknown {
  const [root, ...remainingPath] = path;
  if (!root) {
    return undefined;
  }
  const scopedRoot = root === "agents" ? overlay.agents : overlay[root];
  return getPolicyPath(scopedRoot, remainingPath);
}

function getPolicyPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const part of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

function secretPolicyShapeFindings(
  policy: unknown,
  policyPath: string,
  policyDocName: string,
): readonly HealthFinding[] {
  if (!isRecord(policy) || !isRecord(policy.secrets)) {
    return [];
  }
  const findings: HealthFinding[] = [];
  for (const key of ["requireManagedProviders", "allowInsecureProviders"] as const) {
    if (policy.secrets[key] !== undefined && typeof policy.secrets[key] !== "boolean") {
      findings.push(
        policyShapeFinding(
          policyPath,
          `oc://${policyDocName}/secrets/${key}`,
          `${policyPath} secrets.${key} must be a boolean.`,
          `Set secrets.${key} to true or false.`,
        ),
      );
    }
  }
  if (policy.secrets.denySources !== undefined && !Array.isArray(policy.secrets.denySources)) {
    findings.push(
      policyShapeFinding(
        policyPath,
        `oc://${policyDocName}/secrets/denySources`,
        `${policyPath} secrets.denySources must be an array of source names.`,
        'Use an array such as ["exec"] or remove secrets.denySources.',
      ),
    );
  } else if (Array.isArray(policy.secrets.denySources)) {
    const invalidIndex = policy.secrets.denySources.findIndex(
      (entry) => typeof entry !== "string" || entry.trim() === "",
    );
    if (invalidIndex >= 0) {
      findings.push(
        policyShapeFinding(
          policyPath,
          `oc://${policyDocName}/secrets/denySources/#${invalidIndex}`,
          `${policyPath} secrets.denySources[${invalidIndex}] must be a non-empty source name.`,
          "Use non-empty source names such as env, file, exec, or openclaw.",
        ),
      );
    }
  }
  return findings;
}

function authProfileAllowModesShapeFindings(
  policy: unknown,
  policyPath: string,
  policyDocName: string,
): readonly HealthFinding[] {
  if (
    !isRecord(policy) ||
    !isRecord(policy.auth) ||
    !isRecord(policy.auth.profiles) ||
    policy.auth.profiles.allowModes === undefined
  ) {
    return [];
  }
  if (!Array.isArray(policy.auth.profiles.allowModes)) {
    return [
      policyShapeFinding(
        policyPath,
        `oc://${policyDocName}/auth/profiles/allowModes`,
        `${policyPath} auth.profiles.allowModes must be an array of auth modes.`,
        `Use supported auth modes: ${SUPPORTED_AUTH_PROFILE_MODES.join(", ")}.`,
      ),
    ];
  }
  const invalidIndex = policy.auth.profiles.allowModes.findIndex(
    (entry) =>
      typeof entry !== "string" ||
      !SUPPORTED_AUTH_PROFILE_MODES.includes(
        entry.trim().toLowerCase() as (typeof SUPPORTED_AUTH_PROFILE_MODES)[number],
      ),
  );
  if (invalidIndex < 0) {
    return [];
  }
  return [
    policyShapeFinding(
      policyPath,
      `oc://${policyDocName}/auth/profiles/allowModes/#${invalidIndex}`,
      `${policyPath} auth.profiles.allowModes[${invalidIndex}] must be a supported auth mode.`,
      `Use supported auth modes: ${SUPPORTED_AUTH_PROFILE_MODES.join(", ")}.`,
    ),
  ];
}

function secretManagedProviderFindings(
  policy: unknown,
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  if (readPolicyBoolean(policy, ["secrets", "requireManagedProviders"]) !== true) {
    return [];
  }
  const secrets = evidence.secrets ?? [];
  const providerKeys = new Set(
    secrets
      .filter((secret) => secret.kind === "provider" && secret.providerSource !== undefined)
      .map((secret) => `${secret.providerSource}:${secret.id}`),
  );
  return secrets
    .filter(
      (secret) =>
        secret.kind === "input" &&
        secret.provenance === "secretRef" &&
        (secret.refProvider === undefined ||
          secret.refSource === undefined ||
          !providerKeys.has(`${secret.refSource}:${secret.refProvider}`)),
    )
    .map((secret): HealthFinding => {
      return {
        checkId: CHECK_IDS.policySecretsUnmanagedProvider,
        severity: "error",
        message: `SecretRef uses unmanaged provider '${secret.refProvider ?? "default"}'.`,
        source: "policy",
        path: "openclaw config",
        ocPath: secret.source,
        target: secret.source,
        requirement: `oc://${policyDocName}/secrets/requireManagedProviders`,
        fixHint:
          "Declare the referenced provider under secrets.providers or update policy after review.",
      };
    });
}

function secretDeniedSourceFindings(
  policy: unknown,
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  const deniedSources = new Set(readStringList(policy, ["secrets", "denySources"]));
  if (deniedSources.size === 0) {
    return [];
  }
  return (evidence.secrets ?? [])
    .filter((secret) => {
      const source = secret.kind === "provider" ? secret.providerSource : secret.refSource;
      return source !== undefined && deniedSources.has(source);
    })
    .map((secret): HealthFinding => {
      const source = secret.kind === "provider" ? secret.providerSource : secret.refSource;
      return {
        checkId: CHECK_IDS.policySecretsDeniedProviderSource,
        severity: "error",
        message: `Secret ${secret.kind} '${secret.id}' uses denied source '${source}'.`,
        source: "policy",
        path: "openclaw config",
        ocPath: secret.source,
        target: secret.source,
        requirement: `oc://${policyDocName}/secrets/denySources`,
        fixHint: "Move this secret to an approved source or update policy after review.",
      };
    });
}

function secretInsecureProviderFindings(
  policy: unknown,
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  if (readPolicyBoolean(policy, ["secrets", "allowInsecureProviders"]) !== false) {
    return [];
  }
  return (evidence.secrets ?? [])
    .filter((secret) => secret.kind === "provider" && (secret.insecure?.length ?? 0) > 0)
    .map((secret): HealthFinding => {
      return {
        checkId: CHECK_IDS.policySecretsInsecureProvider,
        severity: "error",
        message: `Secret provider '${secret.id}' enables insecure posture: ${(secret.insecure ?? []).join(", ")}.`,
        source: "policy",
        path: "openclaw config",
        ocPath: secret.source,
        target: secret.source,
        requirement: `oc://${policyDocName}/secrets/allowInsecureProviders`,
        fixHint: "Remove insecure provider overrides or update policy after review.",
      };
    });
}

function authProfileMetadataFindings(
  policy: unknown,
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  const requiredMetadata = requiredAuthProfileMetadata(policy);
  if (requiredMetadata.size === 0) {
    return [];
  }
  return (evidence.authProfiles ?? []).flatMap((profile): HealthFinding[] => {
    const missing = [...requiredMetadata].filter(
      (metadata) => !authProfileHasMetadata(profile, metadata),
    );
    if (missing.length === 0) {
      return [];
    }
    return [
      {
        checkId: CHECK_IDS.policyAuthProfileInvalidMetadata,
        severity: "error",
        message: `Auth profile '${profile.id}' is missing required metadata: ${missing.join(", ")}.`,
        source: "policy",
        path: "openclaw config",
        ocPath: profile.source,
        target: profile.source,
        requirement: `oc://${policyDocName}/auth/profiles/requireMetadata`,
        fixHint: "Set auth.profiles.<id>.provider and a supported auth profile mode.",
      },
    ];
  });
}

function authProfileModeFindings(
  policy: unknown,
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  const allowedModes = new Set(readStringList(policy, ["auth", "profiles", "allowModes"]));
  if (allowedModes.size === 0) {
    return [];
  }
  return (evidence.authProfiles ?? [])
    .filter((profile) => profile.mode !== undefined && !allowedModes.has(profile.mode))
    .map((profile): HealthFinding => {
      return {
        checkId: CHECK_IDS.policyAuthProfileUnapprovedMode,
        severity: "error",
        message: `Auth profile '${profile.id}' uses mode '${profile.mode}' outside the policy allowlist.`,
        source: "policy",
        path: "openclaw config",
        ocPath: profile.source,
        target: profile.source,
        requirement: `oc://${policyDocName}/auth/profiles/allowModes`,
        fixHint: "Change the auth profile mode or update policy after review.",
      };
    });
}

function toolRiskFindings(
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  return (evidence.tools ?? [])
    .filter((tool) => tool.risk === undefined)
    .map((tool): HealthFinding => {
      return {
        checkId: CHECK_IDS.policyMissingToolRisk,
        severity: "error",
        message: `TOOLS.md tool '${tool.id}' has no explicit risk classification.`,
        source: "policy",
        path: "TOOLS.md",
        line: tool.line,
        ocPath: tool.source,
        target: tool.source,
        requirement: `oc://${policyDocName}/tools/requireMetadata`,
        fixHint:
          "Declare risk:low, risk:medium, risk:high, risk:critical, or an R0-R5 review alias.",
      };
    });
}

function toolUnknownRiskFindings(
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  return (evidence.tools ?? [])
    .filter(
      (tool) =>
        tool.risk !== undefined &&
        !KNOWN_RISK_LEVELS.includes(tool.risk as (typeof KNOWN_RISK_LEVELS)[number]),
    )
    .map((tool): HealthFinding => {
      return {
        checkId: CHECK_IDS.policyUnknownToolRisk,
        severity: "error",
        message: `TOOLS.md tool '${tool.id}' declares unknown risk '${tool.risk}'.`,
        source: "policy",
        path: "TOOLS.md",
        line: tool.line,
        ocPath: tool.source,
        target: tool.source,
        requirement: `oc://${policyDocName}/tools/requireMetadata`,
        fixHint: `Use one of: ${KNOWN_RISK_LEVELS.join(", ")}.`,
      };
    });
}

function toolSensitivityFindings(
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  return (evidence.tools ?? []).flatMap((tool): HealthFinding[] => {
    if (tool.sensitivity === undefined) {
      return [
        {
          checkId: CHECK_IDS.policyMissingToolSensitivity,
          severity: "error",
          message: `TOOLS.md tool '${tool.id}' has no declared artifact sensitivity.`,
          source: "policy",
          path: "TOOLS.md",
          line: tool.line,
          ocPath: tool.source,
          target: tool.source,
          requirement: `oc://${policyDocName}/tools/requireMetadata`,
          fixHint: `Declare sensitivity as one of: ${KNOWN_SENSITIVITY_LEVELS.join(", ")}.`,
        },
      ];
    }
    if (
      KNOWN_SENSITIVITY_LEVELS.includes(
        tool.sensitivity as (typeof KNOWN_SENSITIVITY_LEVELS)[number],
      )
    ) {
      return [];
    }
    return [
      {
        checkId: CHECK_IDS.policyUnknownToolSensitivity,
        severity: "error",
        message: `TOOLS.md tool '${tool.id}' declares unknown sensitivity '${tool.sensitivity}'.`,
        source: "policy",
        path: "TOOLS.md",
        line: tool.line,
        ocPath: tool.source,
        target: tool.source,
        requirement: `oc://${policyDocName}/tools/requireMetadata`,
        fixHint: `Use one of: ${KNOWN_SENSITIVITY_LEVELS.join(", ")}.`,
      },
    ];
  });
}

function toolOwnerFindings(
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  return (evidence.tools ?? [])
    .filter((tool) => tool.owner === undefined)
    .map((tool): HealthFinding => {
      return {
        checkId: CHECK_IDS.policyMissingToolOwner,
        severity: "error",
        message: `TOOLS.md tool '${tool.id}' has no declared owner.`,
        source: "policy",
        path: "TOOLS.md",
        line: tool.line,
        ocPath: tool.source,
        target: tool.source,
        requirement: `oc://${policyDocName}/tools/requireMetadata`,
        fixHint: "Declare owner:<team-or-person> for this tool.",
      };
    });
}

async function readPolicyFile(
  ctx: HealthCheckContext,
): Promise<{ raw: string; path: string; displayName: string; ocDocName: string } | null> {
  const displayName = policyDisplayName(ctx);
  const path = resolveWorkspacePath(ctx, policyPathSetting(ctx));
  try {
    const fs = await loadFsPromisesModule();
    return {
      raw: await fs.readFile(path, "utf-8"),
      path,
      displayName,
      ocDocName: basename(displayName),
    };
  } catch (err) {
    if (isNotFound(err)) {
      return null;
    }
    throw err;
  }
}

async function readExecApprovalsFile(
  ctx: HealthCheckContext,
): Promise<{ raw: string; path: string; displayName: string; ocDocName: string } | null> {
  const artifact = execApprovalsArtifactLocation(ctx);
  try {
    const fs = await loadFsPromisesModule();
    return {
      raw: await fs.readFile(artifact.path, "utf-8"),
      path: artifact.path,
      displayName: artifact.displayName,
      ocDocName: "exec-approvals.json",
    };
  } catch (err) {
    if (isNotFound(err)) {
      return null;
    }
    throw err;
  }
}

async function readWorkspaceFile(
  ctx: HealthCheckContext,
  fileName: string,
): Promise<{ raw: string; path: string } | null> {
  const path = resolveWorkspacePath(ctx, fileName);
  try {
    const fs = await loadFsPromisesModule();
    return { raw: await fs.readFile(path, "utf-8"), path };
  } catch (err) {
    if (isNotFound(err)) {
      return null;
    }
    throw err;
  }
}

function resolvePolicyArtifactPath(ctx: HealthCheckContext, fileName: string): string {
  if (fileName.startsWith("~/") || fileName.startsWith("~\\")) {
    const home = resolvePolicyArtifactHomeDir();
    if (home !== undefined) {
      return resolve(home, fileName.slice(2));
    }
  }
  return resolveWorkspacePath(ctx, fileName);
}

function resolvePolicyArtifactHomeDir(): string | undefined {
  const explicitHome = normalizedEnvValue(process.env.OPENCLAW_HOME);
  if (explicitHome !== undefined) {
    if (explicitHome === "~" || explicitHome.startsWith("~/") || explicitHome.startsWith("~\\")) {
      return resolvePolicyHomeRelativePath(explicitHome);
    }
    return resolve(explicitHome);
  }
  return resolveOsPolicyHomeDir();
}

function resolvePolicyHomeRelativePath(value: string): string {
  const fallbackHome = resolveOsPolicyHomeDir();
  return fallbackHome === undefined
    ? resolve(value)
    : resolve(value.replace(/^~(?=$|[\\/])/, fallbackHome));
}

function resolveOsPolicyHomeDir(): string | undefined {
  return (
    normalizedEnvValue(process.env.HOME) ??
    normalizedEnvValue(process.env.USERPROFILE) ??
    safeOsHomeDir()
  );
}

function safeOsHomeDir(): string | undefined {
  try {
    return normalizedEnvValue(os.homedir());
  } catch {
    return undefined;
  }
}

function normalizedEnvValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" || trimmed === "undefined" || trimmed === "null"
    ? undefined
    : trimmed;
}

function resolveWorkspacePath(ctx: HealthCheckContext, fileName: string): string {
  if (isAbsolute(fileName)) {
    return fileName;
  }
  return resolve(ctx.cwd ?? process.cwd(), fileName);
}

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
}

function parseExecApprovalsFile(
  raw: string,
):
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly message: string } {
  try {
    const value = JSON.parse(raw);
    if (!isRecord(value) || value.version !== 1) {
      return { ok: false, message: "unsupported exec approvals version" };
    }
    return { ok: true, value };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

function parsePolicyFile(
  raw: string,
):
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly message: string } {
  try {
    return { ok: true, value: JSON5.parse(raw) };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

function workspaceRepairsEnabled(ctx: HealthCheckContext): boolean {
  return policySettings(ctx).workspaceRepairs === true;
}

function workspaceRepairsDisabledResult(fileName: string): {
  readonly status: "skipped";
  readonly reason: string;
  readonly changes: readonly string[];
  readonly warnings: readonly string[];
} {
  const reason = "workspace repairs are disabled";
  return {
    status: "skipped",
    reason,
    changes: [],
    warnings: [
      `Skipped ${fileName} repair. Enable plugins.entries.policy.config.workspaceRepairs to let doctor --fix edit workspace files.`,
    ],
  };
}

function readChannelDenyRules(
  policy: unknown,
  policyDocName: string,
): readonly {
  readonly id?: string;
  readonly when?: { readonly provider?: string };
  readonly reason?: string;
  readonly requirement: string;
}[] {
  if (
    !isRecord(policy) ||
    !isRecord(policy.channels) ||
    !Array.isArray(policy.channels.denyRules)
  ) {
    return [];
  }
  return policy.channels.denyRules
    .map((rule, index) => ({ rule, index }))
    .filter(
      (
        entry,
      ): entry is {
        readonly index: number;
        readonly rule: {
          readonly id?: string;
          readonly when?: { readonly provider?: string };
          readonly reason?: string;
        };
      } => isChannelDenyRule(entry.rule),
    )
    .map(({ rule, index }) => {
      const next: {
        id?: string;
        when?: { readonly provider?: string };
        reason?: string;
        requirement: string;
      } = {
        when: rule.when,
        requirement: `oc://${policyDocName}/channels/denyRules/#${index}`,
      };
      if (rule.id !== undefined) {
        next.id = rule.id;
      }
      if (rule.reason !== undefined) {
        next.reason = rule.reason;
      }
      return next;
    });
}

function isChannelDenyRule(value: unknown): value is {
  readonly id?: string;
  readonly when?: { readonly provider?: string };
  readonly reason?: string;
} {
  return (
    isRecord(value) &&
    (value.id === undefined || typeof value.id === "string") &&
    (value.reason === undefined || typeof value.reason === "string") &&
    isRecord(value.when) &&
    typeof value.when.provider === "string"
  );
}

function channelIdsFromFindings(findings: readonly HealthFinding[]): readonly string[] {
  return [
    ...new Set(
      findings
        .filter((finding) => finding.checkId === CHECK_IDS.policyDeniedChannelProvider)
        .map((finding) => finding.ocPath?.match(/^oc:\/\/openclaw\.config\/channels\/(.+)$/)?.[1])
        .filter((id): id is string => id !== undefined && id !== ""),
    ),
  ];
}

function disableChannels(
  cfg: HealthCheckContext["cfg"],
  channelIds: readonly string[],
): { readonly config: HealthCheckContext["cfg"]; readonly changed: readonly string[] } {
  if (!isRecord(cfg.channels)) {
    return { config: cfg, changed: [] };
  }
  const channels: Record<string, unknown> = { ...cfg.channels };
  const changed: string[] = [];
  for (const id of channelIds) {
    const current = channels[id];
    if (!isRecord(current) || current.enabled === false) {
      continue;
    }
    channels[id] = { ...current, enabled: false };
    changed.push(id);
  }
  if (changed.length === 0) {
    return { config: cfg, changed };
  }
  return { config: { ...cfg, channels }, changed };
}

type PolicySettings = {
  readonly enabled?: boolean;
  readonly workspaceRepairs?: boolean;
  readonly expectedHash?: string;
  readonly expectedAttestationHash?: string;
  readonly path?: string;
};

function policySettings(ctx: HealthCheckContext): PolicySettings {
  const pluginConfig = ctx.cfg.plugins?.entries?.["policy"]?.config;
  if (!isRecord(pluginConfig)) {
    return {};
  }
  return pluginConfig;
}

function policyChecksEnabled(ctx: HealthCheckContext, settings: PolicySettings): boolean {
  const entry = ctx.cfg.plugins?.entries?.["policy"];
  if (!isRecord(entry) || entry.enabled === false) {
    return false;
  }
  return settings.enabled !== false;
}

function requiredToolMetadata(policy: unknown): ReadonlySet<string> {
  return new Set(readPolicyStringArray(policy, ["tools", "requireMetadata"]) ?? []);
}

function requiredAuthProfileMetadata(
  policy: unknown,
): ReadonlySet<(typeof SUPPORTED_AUTH_PROFILE_METADATA)[number]> {
  const entries = readPolicyStringArray(policy, ["auth", "profiles", "requireMetadata"]) ?? [];
  return new Set(
    entries.filter((entry): entry is (typeof SUPPORTED_AUTH_PROFILE_METADATA)[number] =>
      SUPPORTED_AUTH_PROFILE_METADATA.includes(
        entry as (typeof SUPPORTED_AUTH_PROFILE_METADATA)[number],
      ),
    ),
  );
}

function authProfileHasMetadata(
  profile: PolicyAuthProfileEvidence,
  metadata: (typeof SUPPORTED_AUTH_PROFILE_METADATA)[number],
): boolean {
  if (metadata === "provider") {
    return profile.provider !== undefined && profile.provider.trim() !== "";
  }
  return SUPPORTED_AUTH_PROFILE_MODES.includes(
    profile.mode as (typeof SUPPORTED_AUTH_PROFILE_MODES)[number],
  );
}

function policyToolGlobMatches(tool: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replaceAll("\\*", ".*")}$`).test(tool);
}

function toolListCoversTool(list: readonly string[], tool: string): boolean {
  for (const entry of list) {
    const normalized = normalizePolicyToolName(entry);
    if (normalized === "*" || normalized === tool) {
      return true;
    }
    if (POLICY_TOOL_GROUPS[normalized]?.includes(tool)) {
      return true;
    }
    if (normalized.includes("*") && policyToolGlobMatches(tool, normalized)) {
      return true;
    }
  }
  return false;
}

function expandPolicyToolRequirement(value: string): readonly string[] {
  const normalized = normalizePolicyToolName(value);
  return POLICY_TOOL_GROUPS[normalized] ?? [normalized];
}

function normalizePolicyToolName(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === "bash") {
    return "exec";
  }
  if (normalized === "apply-patch") {
    return "apply_patch";
  }
  return normalized;
}

function normalizePolicyChannelId(value: string): string {
  return value.trim().toLowerCase();
}

function canonicalExecApprovalsPath(): string {
  return "~/.openclaw/exec-approvals.json";
}

function execApprovalsArtifactLocation(ctx: HealthCheckContext): {
  readonly path: string;
  readonly displayName: string;
} {
  const stateDir = normalizedEnvValue(process.env.OPENCLAW_STATE_DIR);
  if (stateDir !== undefined) {
    const path = resolve(resolvePolicyStateDir(stateDir), "exec-approvals.json");
    return { path, displayName: path };
  }
  return {
    path: resolvePolicyArtifactPath(ctx, canonicalExecApprovalsPath()),
    displayName: canonicalExecApprovalsPath(),
  };
}

function execApprovalsDisplayName(): string {
  const stateDir = normalizedEnvValue(process.env.OPENCLAW_STATE_DIR);
  if (stateDir === undefined) {
    return canonicalExecApprovalsPath();
  }
  return resolve(resolvePolicyStateDir(stateDir), "exec-approvals.json");
}

function resolvePolicyStateDir(stateDir: string): string {
  return stateDir.startsWith("~") ? resolvePolicyHomeRelativePath(stateDir) : resolve(stateDir);
}

function policyPathSetting(ctx: HealthCheckContext): string {
  const configured = policySettings(ctx).path;
  return typeof configured === "string" && configured.trim() !== ""
    ? configured.trim()
    : "policy.jsonc";
}

function policyDisplayName(ctx: HealthCheckContext): string {
  const configured = policyPathSetting(ctx);
  return isAbsolute(configured) ? basename(configured) : configured;
}
