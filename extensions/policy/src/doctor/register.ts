import { basename, isAbsolute, resolve } from "node:path";
import JSON5 from "json5";
import {
  registerHealthCheck as registerPluginHealthCheck,
  type HealthCheck,
  type HealthCheckContext,
  type HealthFinding,
} from "openclaw/plugin-sdk/health";
import { normalizeProviderId } from "openclaw/plugin-sdk/provider-model-shared";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import { isRecord, uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  collectPolicyEvidence,
  createPolicyAttestation,
  policyDocumentHash,
  type PolicyAuthProfileEvidence,
  type PolicyAgentWorkspaceEvidence,
  type PolicyEvidence,
  type PolicyToolPostureEvidence,
} from "../policy-state.js";
import { POLICY_TOOL_GROUPS } from "../tool-policy-conformance.js";

const CHECK_IDS = {
  policyAttestationMismatch: "policy/attestation-hash-mismatch",
  policyDeniedChannelProvider: "policy/channels-denied-provider",
  policyHashMismatch: "policy/policy-hash-mismatch",
  policyInvalidFile: "policy/policy-jsonc-invalid",
  policyMissingFile: "policy/policy-jsonc-missing",
  policyDeniedMcpServer: "policy/mcp-denied-server",
  policyUnapprovedMcpServer: "policy/mcp-unapproved-server",
  policyDeniedModelProvider: "policy/models-denied-provider",
  policyUnapprovedModelProvider: "policy/models-unapproved-provider",
  policyPrivateNetworkAccess: "policy/network-private-access-enabled",
  policyGatewayNonLoopbackBind: "policy/gateway-non-loopback-bind",
  policyGatewayAuthDisabled: "policy/gateway-auth-disabled",
  policyGatewayRateLimitMissing: "policy/gateway-rate-limit-missing",
  policyGatewayControlUiInsecure: "policy/gateway-control-ui-insecure",
  policyGatewayTailscaleFunnel: "policy/gateway-tailscale-funnel",
  policyGatewayRemoteEnabled: "policy/gateway-remote-enabled",
  policyGatewayHttpEndpointEnabled: "policy/gateway-http-endpoint-enabled",
  policyGatewayHttpUrlFetchUnrestricted: "policy/gateway-http-url-fetch-unrestricted",
  policyAgentsWorkspaceAccessDenied: "policy/agents-workspace-access-denied",
  policyAgentsToolNotDenied: "policy/agents-tool-not-denied",
  policyToolsElevatedEnabled: "policy/tools-elevated-enabled",
  policyToolsAlsoAllowMissing: "policy/tools-also-allow-missing",
  policyToolsAlsoAllowUnexpected: "policy/tools-also-allow-unexpected",
  policyToolsExecAskUnapproved: "policy/tools-exec-ask-unapproved",
  policyToolsExecHostUnapproved: "policy/tools-exec-host-unapproved",
  policyToolsExecSecurityUnapproved: "policy/tools-exec-security-unapproved",
  policyToolsFsWorkspaceOnlyRequired: "policy/tools-fs-workspace-only-required",
  policyToolsProfileUnapproved: "policy/tools-profile-unapproved",
  policyToolsRequiredDenyMissing: "policy/tools-required-deny-missing",
  policySecretsUnmanagedProvider: "policy/secrets-unmanaged-provider",
  policySecretsDeniedProviderSource: "policy/secrets-denied-provider-source",
  policySecretsInsecureProvider: "policy/secrets-insecure-provider",
  policyAuthProfileInvalidMetadata: "policy/auth-profile-invalid-metadata",
  policyAuthProfileUnapprovedMode: "policy/auth-profile-unapproved-mode",
  policyMissingToolOwner: "policy/tools-missing-owner",
  policyMissingToolRisk: "policy/tools-missing-risk-level",
  policyMissingToolSensitivity: "policy/tools-missing-sensitivity-token",
  policyUnknownToolRisk: "policy/tools-unknown-risk-level",
  policyUnknownToolSensitivity: "policy/tools-unknown-sensitivity-token",
} as const;

export const POLICY_CHECK_IDS = [
  CHECK_IDS.policyMissingFile,
  CHECK_IDS.policyInvalidFile,
  CHECK_IDS.policyHashMismatch,
  CHECK_IDS.policyAttestationMismatch,
  CHECK_IDS.policyDeniedChannelProvider,
  CHECK_IDS.policyDeniedMcpServer,
  CHECK_IDS.policyUnapprovedMcpServer,
  CHECK_IDS.policyDeniedModelProvider,
  CHECK_IDS.policyUnapprovedModelProvider,
  CHECK_IDS.policyPrivateNetworkAccess,
  CHECK_IDS.policyGatewayNonLoopbackBind,
  CHECK_IDS.policyGatewayAuthDisabled,
  CHECK_IDS.policyGatewayRateLimitMissing,
  CHECK_IDS.policyGatewayControlUiInsecure,
  CHECK_IDS.policyGatewayTailscaleFunnel,
  CHECK_IDS.policyGatewayRemoteEnabled,
  CHECK_IDS.policyGatewayHttpEndpointEnabled,
  CHECK_IDS.policyGatewayHttpUrlFetchUnrestricted,
  CHECK_IDS.policyAgentsWorkspaceAccessDenied,
  CHECK_IDS.policyAgentsToolNotDenied,
  CHECK_IDS.policyToolsProfileUnapproved,
  CHECK_IDS.policyToolsFsWorkspaceOnlyRequired,
  CHECK_IDS.policyToolsExecSecurityUnapproved,
  CHECK_IDS.policyToolsExecAskUnapproved,
  CHECK_IDS.policyToolsExecHostUnapproved,
  CHECK_IDS.policyToolsElevatedEnabled,
  CHECK_IDS.policyToolsAlsoAllowMissing,
  CHECK_IDS.policyToolsAlsoAllowUnexpected,
  CHECK_IDS.policyToolsRequiredDenyMissing,
  CHECK_IDS.policySecretsUnmanagedProvider,
  CHECK_IDS.policySecretsDeniedProviderSource,
  CHECK_IDS.policySecretsInsecureProvider,
  CHECK_IDS.policyAuthProfileInvalidMetadata,
  CHECK_IDS.policyAuthProfileUnapprovedMode,
  CHECK_IDS.policyMissingToolRisk,
  CHECK_IDS.policyUnknownToolRisk,
  CHECK_IDS.policyMissingToolSensitivity,
  CHECK_IDS.policyMissingToolOwner,
  CHECK_IDS.policyUnknownToolSensitivity,
] as const;

export type PolicyStrictnessKind =
  | "allowlist-subset"
  | "denylist-superset"
  | "requires-true"
  | "requires-false"
  | "exact-list";

export type PolicyEmptyListSemantics = "disabled" | "meaningful";

export type PolicyScopeSelectorKind = "agentIds";

export type PolicyRuleMetadata = {
  readonly policyPath: readonly string[];
  readonly strictness: PolicyStrictnessKind;
  readonly valueType: "boolean" | "string-list";
  readonly checkIds: readonly (typeof POLICY_CHECK_IDS)[number][];
  readonly emptyList?: PolicyEmptyListSemantics;
  readonly caseSensitive?: boolean;
  readonly scopeSelectors?: readonly PolicyScopeSelectorKind[];
};

export const POLICY_RULE_METADATA = [
  {
    policyPath: ["agents", "workspace", "allowedAccess"],
    strictness: "allowlist-subset",
    valueType: "string-list",
    checkIds: [CHECK_IDS.policyAgentsWorkspaceAccessDenied],
    emptyList: "disabled",
    scopeSelectors: ["agentIds"],
  },
  {
    policyPath: ["agents", "workspace", "denyTools"],
    strictness: "denylist-superset",
    valueType: "string-list",
    checkIds: [CHECK_IDS.policyAgentsToolNotDenied],
    scopeSelectors: ["agentIds"],
  },
  {
    policyPath: ["tools", "profiles", "allow"],
    strictness: "allowlist-subset",
    valueType: "string-list",
    checkIds: [CHECK_IDS.policyToolsProfileUnapproved],
    emptyList: "disabled",
    scopeSelectors: ["agentIds"],
  },
  {
    policyPath: ["tools", "fs", "requireWorkspaceOnly"],
    strictness: "requires-true",
    valueType: "boolean",
    checkIds: [CHECK_IDS.policyToolsFsWorkspaceOnlyRequired],
    scopeSelectors: ["agentIds"],
  },
  {
    policyPath: ["tools", "exec", "allowSecurity"],
    strictness: "allowlist-subset",
    valueType: "string-list",
    checkIds: [CHECK_IDS.policyToolsExecSecurityUnapproved],
    emptyList: "disabled",
    scopeSelectors: ["agentIds"],
  },
  {
    policyPath: ["tools", "exec", "requireAsk"],
    strictness: "allowlist-subset",
    valueType: "string-list",
    checkIds: [CHECK_IDS.policyToolsExecAskUnapproved],
    emptyList: "disabled",
    scopeSelectors: ["agentIds"],
  },
  {
    policyPath: ["tools", "exec", "allowHosts"],
    strictness: "allowlist-subset",
    valueType: "string-list",
    checkIds: [CHECK_IDS.policyToolsExecHostUnapproved],
    emptyList: "disabled",
    scopeSelectors: ["agentIds"],
  },
  {
    policyPath: ["tools", "elevated", "allow"],
    strictness: "requires-false",
    valueType: "boolean",
    checkIds: [CHECK_IDS.policyToolsElevatedEnabled],
    scopeSelectors: ["agentIds"],
  },
  {
    policyPath: ["tools", "alsoAllow", "expected"],
    strictness: "exact-list",
    valueType: "string-list",
    checkIds: [CHECK_IDS.policyToolsAlsoAllowMissing, CHECK_IDS.policyToolsAlsoAllowUnexpected],
    emptyList: "meaningful",
    scopeSelectors: ["agentIds"],
  },
  {
    policyPath: ["tools", "denyTools"],
    strictness: "denylist-superset",
    valueType: "string-list",
    checkIds: [CHECK_IDS.policyToolsRequiredDenyMissing],
    scopeSelectors: ["agentIds"],
  },
] as const satisfies readonly PolicyRuleMetadata[];

const KNOWN_RISK_LEVELS = ["low", "medium", "high", "critical"] as const;
const KNOWN_SENSITIVITY_LEVELS = ["public", "internal", "confidential", "restricted"] as const;
const SUPPORTED_TOOL_METADATA = ["risk", "sensitivity", "owner"] as const;
const SUPPORTED_AUTH_PROFILE_METADATA = ["provider", "mode"] as const;
const SUPPORTED_AUTH_PROFILE_MODES = ["api_key", "aws-sdk", "oauth", "token"] as const;
const SUPPORTED_GATEWAY_HTTP_ENDPOINTS = ["chatCompletions", "responses"] as const;
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
let registered = false;
const policyEvaluationCache = new WeakMap<HealthCheckContext, Promise<PolicyEvaluation>>();

export type PolicyDoctorRegistrationHost = {
  readonly registerHealthCheck: (check: HealthCheck) => void;
};

export type PolicyEvaluation = {
  readonly policyPath: string;
  readonly policy?: {
    readonly value: unknown;
    readonly hash: string;
  };
  readonly evidence: PolicyEvidence;
  readonly expectedAttestationHash?: string;
  readonly findings: readonly HealthFinding[];
  readonly attestedFindings: readonly HealthFinding[];
};

export function registerPolicyDoctorChecks(host?: PolicyDoctorRegistrationHost): void {
  if (registered) {
    return;
  }
  const registerHealthCheck = host?.registerHealthCheck ?? registerPluginHealthCheck;
  registerHealthCheck(policyMissingFileCheck);
  registerHealthCheck(policyInvalidFileCheck);
  registerHealthCheck(policyHashMismatchCheck);
  registerHealthCheck(policyAttestationMismatchCheck);
  registerHealthCheck(policyChannelsDeniedProviderCheck);
  registerHealthCheck(policyMcpDeniedServerCheck);
  registerHealthCheck(policyMcpUnapprovedServerCheck);
  registerHealthCheck(policyModelsDeniedProviderCheck);
  registerHealthCheck(policyModelsUnapprovedProviderCheck);
  registerHealthCheck(policyNetworkPrivateAccessCheck);
  registerHealthCheck(policyGatewayNonLoopbackBindCheck);
  registerHealthCheck(policyGatewayAuthDisabledCheck);
  registerHealthCheck(policyGatewayRateLimitMissingCheck);
  registerHealthCheck(policyGatewayControlUiInsecureCheck);
  registerHealthCheck(policyGatewayTailscaleFunnelCheck);
  registerHealthCheck(policyGatewayRemoteEnabledCheck);
  registerHealthCheck(policyGatewayHttpEndpointEnabledCheck);
  registerHealthCheck(policyGatewayHttpUrlFetchUnrestrictedCheck);
  registerHealthCheck(policyAgentsWorkspaceAccessDeniedCheck);
  registerHealthCheck(policyAgentsToolNotDeniedCheck);
  registerHealthCheck(policyToolsProfileUnapprovedCheck);
  registerHealthCheck(policyToolsFsWorkspaceOnlyRequiredCheck);
  registerHealthCheck(policyToolsExecSecurityUnapprovedCheck);
  registerHealthCheck(policyToolsExecAskUnapprovedCheck);
  registerHealthCheck(policyToolsExecHostUnapprovedCheck);
  registerHealthCheck(policyToolsElevatedEnabledCheck);
  registerHealthCheck(policyToolsAlsoAllowMissingCheck);
  registerHealthCheck(policyToolsAlsoAllowUnexpectedCheck);
  registerHealthCheck(policyToolsRequiredDenyMissingCheck);
  registerHealthCheck(policySecretsUnmanagedProviderCheck);
  registerHealthCheck(policySecretsDeniedProviderSourceCheck);
  registerHealthCheck(policySecretsInsecureProviderCheck);
  registerHealthCheck(policyAuthProfileInvalidMetadataCheck);
  registerHealthCheck(policyAuthProfileUnapprovedModeCheck);
  registerHealthCheck(policyToolsMissingRiskCheck);
  registerHealthCheck(policyToolsUnknownRiskCheck);
  registerHealthCheck(policyToolsMissingSensitivityCheck);
  registerHealthCheck(policyToolsMissingOwnerCheck);
  registerHealthCheck(policyToolsUnknownSensitivityCheck);
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

const policyChannelsDeniedProviderCheck: HealthCheck = {
  id: CHECK_IDS.policyDeniedChannelProvider,
  kind: "plugin",
  description: "Configured channels satisfy policy deny rules.",
  source: "policy",
  async detect(ctx) {
    return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyDeniedChannelProvider);
  },
  async repair(ctx, findings) {
    if (!workspaceRepairsEnabled(ctx)) {
      return workspaceRepairsDisabledResult("channel config");
    }
    const channelIds = channelIdsFromFindings(findings);
    if (channelIds.length === 0) {
      return {
        status: "skipped",
        reason: "no channel findings matched a configurable channel",
        changes: [],
      };
    }
    const next = disableChannels(ctx.cfg, channelIds);
    if (next.changed.length === 0) {
      return {
        status: "skipped",
        reason: "matching channels were already disabled or missing",
        changes: [],
      };
    }
    return {
      config: next.config,
      changes: next.changed.map((id) => `Disabled channels.${id}.enabled for policy conformance.`),
    };
  },
};

const policyMcpDeniedServerCheck: HealthCheck = {
  id: CHECK_IDS.policyDeniedMcpServer,
  kind: "plugin",
  description: "Configured MCP servers do not match policy deny rules.",
  source: "policy",
  async detect(ctx) {
    return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyDeniedMcpServer);
  },
};

const policyMcpUnapprovedServerCheck: HealthCheck = {
  id: CHECK_IDS.policyUnapprovedMcpServer,
  kind: "plugin",
  description: "Configured MCP servers do not match policy allow rules.",
  source: "policy",
  async detect(ctx) {
    return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyUnapprovedMcpServer);
  },
};

const policyModelsDeniedProviderCheck: HealthCheck = {
  id: CHECK_IDS.policyDeniedModelProvider,
  kind: "plugin",
  description: "Configured model providers do not match policy deny rules.",
  source: "policy",
  async detect(ctx) {
    return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyDeniedModelProvider);
  },
};

const policyModelsUnapprovedProviderCheck: HealthCheck = {
  id: CHECK_IDS.policyUnapprovedModelProvider,
  kind: "plugin",
  description: "Configured model providers do not match policy allow rules.",
  source: "policy",
  async detect(ctx) {
    return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyUnapprovedModelProvider);
  },
};

const policyNetworkPrivateAccessCheck: HealthCheck = {
  id: CHECK_IDS.policyPrivateNetworkAccess,
  kind: "plugin",
  description: "Network SSRF policy settings match private-network requirements.",
  source: "policy",
  async detect(ctx) {
    return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyPrivateNetworkAccess);
  },
};

const policyGatewayNonLoopbackBindCheck: HealthCheck = {
  id: CHECK_IDS.policyGatewayNonLoopbackBind,
  kind: "plugin",
  description: "Gateway bind posture matches policy exposure requirements.",
  source: "policy",
  async detect(ctx) {
    return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyGatewayNonLoopbackBind);
  },
};

const policyGatewayAuthDisabledCheck: HealthCheck = {
  id: CHECK_IDS.policyGatewayAuthDisabled,
  kind: "plugin",
  description: "Gateway authentication remains enabled when required by policy.",
  source: "policy",
  async detect(ctx) {
    return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyGatewayAuthDisabled);
  },
};

const policyGatewayRateLimitMissingCheck: HealthCheck = {
  id: CHECK_IDS.policyGatewayRateLimitMissing,
  kind: "plugin",
  description: "Gateway authentication rate-limit posture is explicit when required by policy.",
  source: "policy",
  async detect(ctx) {
    return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyGatewayRateLimitMissing);
  },
};

const policyGatewayControlUiInsecureCheck: HealthCheck = {
  id: CHECK_IDS.policyGatewayControlUiInsecure,
  kind: "plugin",
  description: "Gateway Control UI insecure exposure toggles remain disabled by policy.",
  source: "policy",
  async detect(ctx) {
    return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyGatewayControlUiInsecure);
  },
};

const policyGatewayTailscaleFunnelCheck: HealthCheck = {
  id: CHECK_IDS.policyGatewayTailscaleFunnel,
  kind: "plugin",
  description: "Gateway Tailscale Funnel exposure matches policy.",
  source: "policy",
  async detect(ctx) {
    return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyGatewayTailscaleFunnel);
  },
};

const policyGatewayRemoteEnabledCheck: HealthCheck = {
  id: CHECK_IDS.policyGatewayRemoteEnabled,
  kind: "plugin",
  description: "Remote gateway mode matches policy.",
  source: "policy",
  async detect(ctx) {
    return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyGatewayRemoteEnabled);
  },
};

const policyGatewayHttpEndpointEnabledCheck: HealthCheck = {
  id: CHECK_IDS.policyGatewayHttpEndpointEnabled,
  kind: "plugin",
  description: "Gateway HTTP API endpoints match policy.",
  source: "policy",
  async detect(ctx) {
    return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyGatewayHttpEndpointEnabled);
  },
};

const policyGatewayHttpUrlFetchUnrestrictedCheck: HealthCheck = {
  id: CHECK_IDS.policyGatewayHttpUrlFetchUnrestricted,
  kind: "plugin",
  description: "Gateway HTTP URL-fetch inputs have allowlists when required by policy.",
  source: "policy",
  async detect(ctx) {
    return findingsForCheck(
      await evaluatePolicy(ctx),
      CHECK_IDS.policyGatewayHttpUrlFetchUnrestricted,
    );
  },
};

const policyAgentsWorkspaceAccessDeniedCheck: HealthCheck = {
  id: CHECK_IDS.policyAgentsWorkspaceAccessDenied,
  kind: "plugin",
  description: "Agent sandbox workspace access matches policy.",
  source: "policy",
  async detect(ctx) {
    return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyAgentsWorkspaceAccessDenied);
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
    return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyToolsExecSecurityUnapproved);
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
};

const policySecretsUnmanagedProviderCheck: HealthCheck = {
  id: CHECK_IDS.policySecretsUnmanagedProvider,
  kind: "plugin",
  description:
    "OpenClaw config SecretRefs use configured secret providers when policy requires managed providers.",
  source: "policy",
  async detect(ctx) {
    return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policySecretsUnmanagedProvider);
  },
};

const policySecretsDeniedProviderSourceCheck: HealthCheck = {
  id: CHECK_IDS.policySecretsDeniedProviderSource,
  kind: "plugin",
  description:
    "OpenClaw config secret providers and SecretRefs do not use sources denied by policy.",
  source: "policy",
  async detect(ctx) {
    return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policySecretsDeniedProviderSource);
  },
};

const policySecretsInsecureProviderCheck: HealthCheck = {
  id: CHECK_IDS.policySecretsInsecureProvider,
  kind: "plugin",
  description:
    "Configured secret providers do not opt into insecure posture unless policy allows it.",
  source: "policy",
  async detect(ctx) {
    return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policySecretsInsecureProvider);
  },
};

const policyAuthProfileInvalidMetadataCheck: HealthCheck = {
  id: CHECK_IDS.policyAuthProfileInvalidMetadata,
  kind: "plugin",
  description: "OpenClaw config auth profiles declare required provider and mode metadata.",
  source: "policy",
  async detect(ctx) {
    return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyAuthProfileInvalidMetadata);
  },
};

const policyAuthProfileUnapprovedModeCheck: HealthCheck = {
  id: CHECK_IDS.policyAuthProfileUnapprovedMode,
  kind: "plugin",
  description: "OpenClaw config auth profile modes stay within the policy allowlist.",
  source: "policy",
  async detect(ctx) {
    return findingsForCheck(await evaluatePolicy(ctx), CHECK_IDS.policyAuthProfileUnapprovedMode);
  },
};

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

async function evaluatePolicyUncached(ctx: HealthCheckContext): Promise<PolicyEvaluation> {
  const settings = policySettings(ctx);
  const policyPath = policyDisplayName(ctx);
  let evidence: PolicyEvidence = collectPolicyEvidence(ctx.cfg as Record<string, unknown>, {
    includeGatewayExposure: false,
    includeAgentWorkspace: false,
    includeToolPosture: false,
    includeSecrets: false,
    includeAuthProfiles: false,
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
  const includeGatewayExposure = policyHasGatewayRules(policy);
  const includeAgentWorkspace = policyHasAgentWorkspaceRules(policy);
  if (requiredMetadata.size > 0) {
    const toolsFile = await readWorkspaceFile(ctx, "TOOLS.md");
    evidence = await collectPolicyEvidence(ctx.cfg as Record<string, unknown>, {
      toolsRaw: toolsFile?.raw ?? "",
      includeGatewayExposure,
      includeAgentWorkspace,
      includeToolPosture: policyHasToolPostureRules(policy),
      includeSecrets,
      includeAuthProfiles,
    });
  } else {
    evidence = collectPolicyEvidence(ctx.cfg as Record<string, unknown>, {
      includeGatewayExposure,
      includeAgentWorkspace,
      includeToolPosture: policyHasToolPostureRules(policy),
      includeSecrets,
      includeAuthProfiles,
    });
  }
  const policyFindings: HealthFinding[] = [
    ...policyContainerShapeFindings(policy, policyFile.displayName, policyFile.ocDocName),
    ...channelFindings(policy, policyFile.displayName, policyFile.ocDocName, evidence),
    ...mcpServerFindings(policy, policyFile.ocDocName, evidence),
    ...modelProviderFindings(policy, policyFile.ocDocName, evidence),
    ...networkFindings(policy, policyFile.ocDocName, evidence),
    ...gatewayExposureFindings(policy, policyFile.ocDocName, evidence),
    ...agentWorkspaceFindings(policy, policyFile.displayName, policyFile.ocDocName, evidence),
    ...toolPostureFindings(policy, policyFile.displayName, policyFile.ocDocName, evidence),
    ...secretAuthProvenanceFindings(policy, policyFile.displayName, policyFile.ocDocName, evidence),
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

function policyContainerShapeFindings(
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
    if (policy.tools.settings !== undefined && !isRecord(policy.tools.settings)) {
      return [
        policyShapeFinding(
          policyPath,
          `oc://${policyDocName}/tools/settings`,
          `${policyPath} tools.settings must be an object.`,
          `Fix ${policyPath} so tools.settings is an object.`,
        ),
      ];
    }
    if (policy.tools.entries !== undefined && !Array.isArray(policy.tools.entries)) {
      return [
        policyShapeFinding(
          policyPath,
          `oc://${policyDocName}/tools/entries`,
          `${policyPath} tools.entries must be an array.`,
          `Fix ${policyPath} so tools.entries is an array.`,
        ),
      ];
    }
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
    if (overlay.agentIds === undefined) {
      return policyShapeFinding(
        params.policyPath,
        `oc://${params.policyDocName}/${targetPrefix}/agentIds`,
        `${params.policyPath} scopes.${scopeName}.agentIds is required for scoped tools or agent workspace policy.`,
        `List the runtime agent ids that this named policy scope applies to.`,
      );
    }
    const agentIdsFinding = policyStringArrayPropertyShapeFinding(overlay.agentIds, {
      policyDocName: params.policyDocName,
      policyPath: params.policyPath,
      property: `scopes.${scopeName}.agentIds`,
      target: `${targetPrefix}/agentIds`,
      valueName: "agent id",
    });
    if (agentIdsFinding !== undefined) {
      return agentIdsFinding;
    }
    if (Array.isArray(overlay.agentIds) && overlay.agentIds.length === 0) {
      return policyShapeFinding(
        params.policyPath,
        `oc://${params.policyDocName}/${targetPrefix}/agentIds`,
        `${params.policyPath} scopes.${scopeName}.agentIds must include at least one agent id.`,
        `Add one or more runtime agent ids to ${params.policyPath} scopes.${scopeName}.agentIds.`,
      );
    }
    if (Array.isArray(overlay.agentIds)) {
      const seen = new Map<string, number>();
      for (const [index, agentId] of overlay.agentIds.entries()) {
        if (typeof agentId !== "string") {
          continue;
        }
        const normalized = normalizeAgentId(agentId);
        const previous = seen.get(normalized);
        if (previous !== undefined) {
          return policyShapeFinding(
            params.policyPath,
            `oc://${params.policyDocName}/${targetPrefix}/agentIds/#${index}`,
            `${params.policyPath} scopes.${scopeName}.agentIds[${index}] duplicates agentIds[${previous}] after normalization.`,
            `List each runtime agent id only once per named policy scope.`,
          );
        }
        seen.set(normalized, index);
      }
    }
    const unsupportedKey = Object.keys(overlay).find(
      (key) => key !== "agentIds" && key !== "agents" && key !== "tools",
    );
    if (unsupportedKey !== undefined) {
      return policyShapeFinding(
        params.policyPath,
        `oc://${params.policyDocName}/${targetPrefix}/${ocPathSegment(unsupportedKey)}`,
        `${params.policyPath} scopes.${scopeName}.${unsupportedKey} is not supported by the agentIds selector.`,
        `Use only agentIds with agents.workspace or tools in this policy scope.`,
      );
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
  }
  return duplicateScopedAgentFieldFinding(value, {
    policyDocName: params.policyDocName,
    policyPath: params.policyPath,
    policy: params.policy,
  });
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
  if (fs.requireWorkspaceOnly !== undefined && typeof fs.requireWorkspaceOnly !== "boolean") {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${targetPrefix}/fs/requireWorkspaceOnly`,
      `${params.policyPath} ${propertyPrefix}.fs.requireWorkspaceOnly must be a boolean.`,
      `Set ${propertyPrefix}.fs.requireWorkspaceOnly to true or false.`,
    );
  }

  const exec = isRecord(tools.exec) ? tools.exec : {};
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
  if (elevated.allow !== undefined && typeof elevated.allow !== "boolean") {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${targetPrefix}/elevated/allow`,
      `${params.policyPath} ${propertyPrefix}.elevated.allow must be a boolean.`,
      `Set ${propertyPrefix}.elevated.allow to true or false.`,
    );
  }

  const alsoAllow = isRecord(tools.alsoAllow) ? tools.alsoAllow : {};
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

  for (const section of ["exposure", "auth", "controlUi", "remote", "http"] as const) {
    if (value[section] !== undefined && !isRecord(value[section])) {
      return policyShapeFinding(
        params.policyPath,
        `oc://${params.policyDocName}/gateway/${section}`,
        `${params.policyPath} gateway.${section} must be an object.`,
        `Fix ${params.policyPath} so gateway.${section} is an object.`,
      );
    }
  }

  const exposure = isRecord(value.exposure) ? value.exposure : {};
  const auth = isRecord(value.auth) ? value.auth : {};
  const controlUi = isRecord(value.controlUi) ? value.controlUi : {};
  const remote = isRecord(value.remote) ? value.remote : {};
  const http = isRecord(value.http) ? value.http : {};
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

function mcpServerFindings(
  policy: unknown,
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  const denied = new Set(readStringList(policy, ["mcp", "servers", "deny"], { lowercase: false }));
  const allowed = readStringList(policy, ["mcp", "servers", "allow"], { lowercase: false });
  const allowedSet = new Set(allowed);
  const findings: HealthFinding[] = [];

  for (const server of evidence.mcpServers) {
    if (denied.has(server.id)) {
      findings.push({
        checkId: CHECK_IDS.policyDeniedMcpServer,
        severity: "error",
        message: `MCP server '${server.id}' is denied by policy.`,
        source: "policy",
        path: "openclaw config",
        ocPath: server.source,
        target: server.source,
        requirement: `oc://${policyDocName}/mcp/servers/deny`,
        fixHint: "Remove this configured MCP server or update the policy after review.",
      });
      continue;
    }
    if (allowedSet.size > 0 && !allowedSet.has(server.id)) {
      findings.push({
        checkId: CHECK_IDS.policyUnapprovedMcpServer,
        severity: "error",
        message: `MCP server '${server.id}' is not in the policy allowlist.`,
        source: "policy",
        path: "openclaw config",
        ocPath: server.source,
        target: server.source,
        requirement: `oc://${policyDocName}/mcp/servers/allow`,
        fixHint: "Use an approved MCP server or update the policy after review.",
      });
    }
  }

  return findings;
}

function modelProviderFindings(
  policy: unknown,
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  const denied = new Set(readModelProviderPolicyList(policy, ["models", "providers", "deny"]));
  const allowed = readModelProviderPolicyList(policy, ["models", "providers", "allow"]);
  const allowedSet = new Set(allowed);
  const findings: HealthFinding[] = [];

  for (const provider of evidence.modelProviders) {
    findings.push(...modelProviderConformanceFindings(provider, denied, allowedSet, policyDocName));
  }
  for (const modelRef of evidence.modelRefs) {
    findings.push(...modelRefConformanceFindings(modelRef, denied, allowedSet, policyDocName));
  }

  return findings;
}

function readModelProviderPolicyList(policy: unknown, path: readonly string[]): readonly string[] {
  return readStringList(policy, path).map((provider) => normalizeProviderId(provider));
}

function modelProviderConformanceFindings(
  provider: PolicyEvidence["modelProviders"][number],
  denied: ReadonlySet<string>,
  allowed: ReadonlySet<string>,
  policyDocName: string,
): readonly HealthFinding[] {
  const findings: HealthFinding[] = [];
  if (denied.has(provider.id)) {
    findings.push({
      checkId: CHECK_IDS.policyDeniedModelProvider,
      severity: "error",
      message: `Model provider '${provider.id}' is denied by policy.`,
      source: "policy",
      path: "openclaw config",
      ocPath: provider.source,
      target: provider.source,
      requirement: `oc://${policyDocName}/models/providers/deny`,
      fixHint: "Remove this configured provider or update the policy after review.",
    });
  }
  if (!denied.has(provider.id) && allowed.size > 0 && !allowed.has(provider.id)) {
    findings.push({
      checkId: CHECK_IDS.policyUnapprovedModelProvider,
      severity: "error",
      message: `Model provider '${provider.id}' is not in the policy allowlist.`,
      source: "policy",
      path: "openclaw config",
      ocPath: provider.source,
      target: provider.source,
      requirement: `oc://${policyDocName}/models/providers/allow`,
      fixHint: "Use an approved model provider or update the policy after review.",
    });
  }
  return findings;
}

function modelRefConformanceFindings(
  modelRef: PolicyEvidence["modelRefs"][number],
  denied: ReadonlySet<string>,
  allowed: ReadonlySet<string>,
  policyDocName: string,
): readonly HealthFinding[] {
  const findings: HealthFinding[] = [];
  if (denied.has(modelRef.provider)) {
    findings.push({
      checkId: CHECK_IDS.policyDeniedModelProvider,
      severity: "error",
      message: `Model ref '${modelRef.ref}' uses denied provider '${modelRef.provider}'.`,
      source: "policy",
      path: "openclaw config",
      ocPath: modelRef.source,
      target: modelRef.source,
      requirement: `oc://${policyDocName}/models/providers/deny`,
      fixHint: "Select an approved model provider or update the policy after review.",
    });
  }
  if (!denied.has(modelRef.provider) && allowed.size > 0 && !allowed.has(modelRef.provider)) {
    findings.push({
      checkId: CHECK_IDS.policyUnapprovedModelProvider,
      severity: "error",
      message: `Model ref '${modelRef.ref}' uses unapproved provider '${modelRef.provider}'.`,
      source: "policy",
      path: "openclaw config",
      ocPath: modelRef.source,
      target: modelRef.source,
      requirement: `oc://${policyDocName}/models/providers/allow`,
      fixHint: "Select an approved model provider or update the policy after review.",
    });
  }
  return findings;
}

function networkFindings(
  policy: unknown,
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  const allowPrivateNetwork = readPolicyBoolean(policy, ["network", "privateNetwork", "allow"]);
  if (allowPrivateNetwork !== false) {
    return [];
  }
  return evidence.network
    .filter((setting) => setting.value)
    .map((setting): HealthFinding => {
      return {
        checkId: CHECK_IDS.policyPrivateNetworkAccess,
        severity: "error",
        message: `Network setting '${setting.id}' allows private-network access.`,
        source: "policy",
        path: "openclaw config",
        ocPath: setting.source,
        target: setting.source,
        requirement: `oc://${policyDocName}/network/privateNetwork/allow`,
        fixHint: "Disable this private-network access setting or update policy after review.",
      };
    });
}

function gatewayExposureFindings(
  policy: unknown,
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  return [
    ...gatewayNonLoopbackBindFindings(policy, policyDocName, evidence),
    ...gatewayAuthFindings(policy, policyDocName, evidence),
    ...gatewayControlUiFindings(policy, policyDocName, evidence),
    ...gatewayTailscaleFindings(policy, policyDocName, evidence),
    ...gatewayRemoteFindings(policy, policyDocName, evidence),
    ...gatewayHttpEndpointFindings(policy, policyDocName, evidence),
    ...gatewayHttpUrlFetchFindings(policy, policyDocName, evidence),
  ];
}

function gatewayNonLoopbackBindFindings(
  policy: unknown,
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  if (readPolicyBoolean(policy, ["gateway", "exposure", "allowNonLoopbackBind"]) !== false) {
    return [];
  }
  return (evidence.gatewayExposure ?? [])
    .filter((entry) => entry.kind === "bind" && entry.nonLoopback === true)
    .map((entry): HealthFinding => {
      return {
        checkId: CHECK_IDS.policyGatewayNonLoopbackBind,
        severity: "error",
        message:
          entry.explicit === false
            ? "Gateway bind is omitted while the runtime default can permit non-loopback exposure."
            : `Gateway bind setting '${entry.id}' permits non-loopback exposure.`,
        source: "policy",
        path: "openclaw config",
        ocPath: entry.source,
        target: entry.source,
        requirement: `oc://${policyDocName}/gateway/exposure/allowNonLoopbackBind`,
        fixHint: "Use gateway.bind=loopback or update policy after review.",
      };
    });
}

function gatewayAuthFindings(
  policy: unknown,
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  const findings: HealthFinding[] = [];
  if (readPolicyBoolean(policy, ["gateway", "auth", "requireAuth"]) === true) {
    findings.push(
      ...(evidence.gatewayExposure ?? [])
        .filter((entry) => entry.kind === "auth" && entry.value === "none")
        .map((entry): HealthFinding => {
          return {
            checkId: CHECK_IDS.policyGatewayAuthDisabled,
            severity: "error",
            message: "Gateway authentication is disabled.",
            source: "policy",
            path: "openclaw config",
            ocPath: entry.source,
            target: entry.source,
            requirement: `oc://${policyDocName}/gateway/auth/requireAuth`,
            fixHint: "Set gateway.auth.mode to token, password, or trusted-proxy.",
          };
        }),
    );
  }
  if (readPolicyBoolean(policy, ["gateway", "auth", "requireExplicitRateLimit"]) === true) {
    findings.push(
      ...(evidence.gatewayExposure ?? [])
        .filter((entry) => entry.kind === "authRateLimit" && entry.explicit !== true)
        .map((entry): HealthFinding => {
          return {
            checkId: CHECK_IDS.policyGatewayRateLimitMissing,
            severity: "error",
            message: "Gateway authentication rate-limit posture is not explicit.",
            source: "policy",
            path: "openclaw config",
            ocPath: entry.source,
            target: entry.source,
            requirement: `oc://${policyDocName}/gateway/auth/requireExplicitRateLimit`,
            fixHint: "Configure gateway.auth.rateLimit or update policy after review.",
          };
        }),
    );
  }
  return findings;
}

function gatewayControlUiFindings(
  policy: unknown,
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  if (readPolicyBoolean(policy, ["gateway", "controlUi", "allowInsecure"]) !== false) {
    return [];
  }
  return (evidence.gatewayExposure ?? [])
    .filter(
      (entry) =>
        entry.kind === "controlUi" &&
        entry.value === true &&
        (entry.id === "gateway-control-ui-insecure-auth" ||
          entry.id === "gateway-control-ui-device-auth-disabled" ||
          entry.id === "gateway-control-ui-host-origin-fallback"),
    )
    .map((entry): HealthFinding => {
      return {
        checkId: CHECK_IDS.policyGatewayControlUiInsecure,
        severity: "error",
        message: `Gateway Control UI insecure toggle '${entry.id}' is enabled.`,
        source: "policy",
        path: "openclaw config",
        ocPath: entry.source,
        target: entry.source,
        requirement: `oc://${policyDocName}/gateway/controlUi/allowInsecure`,
        fixHint: "Disable the insecure Control UI toggle or update policy after review.",
      };
    });
}

function gatewayTailscaleFindings(
  policy: unknown,
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  if (readPolicyBoolean(policy, ["gateway", "exposure", "allowTailscaleFunnel"]) !== false) {
    return [];
  }
  return (evidence.gatewayExposure ?? [])
    .filter((entry) => entry.kind === "tailscale" && entry.value === "funnel")
    .map((entry): HealthFinding => {
      return {
        checkId: CHECK_IDS.policyGatewayTailscaleFunnel,
        severity: "error",
        message: "Gateway Tailscale Funnel exposure is enabled.",
        source: "policy",
        path: "openclaw config",
        ocPath: entry.source,
        target: entry.source,
        requirement: `oc://${policyDocName}/gateway/exposure/allowTailscaleFunnel`,
        fixHint: "Use tailscale serve/off or update policy after review.",
      };
    });
}

function gatewayRemoteFindings(
  policy: unknown,
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  if (readPolicyBoolean(policy, ["gateway", "remote", "allow"]) !== false) {
    return [];
  }
  return (evidence.gatewayExposure ?? [])
    .filter((entry) => entry.kind === "remote")
    .map((entry): HealthFinding => {
      return {
        checkId: CHECK_IDS.policyGatewayRemoteEnabled,
        severity: "error",
        message: `Gateway remote posture '${entry.id}' is enabled.`,
        source: "policy",
        path: "openclaw config",
        ocPath: entry.source,
        target: entry.source,
        requirement: `oc://${policyDocName}/gateway/remote/allow`,
        fixHint: "Disable remote gateway mode/config or update policy after review.",
      };
    });
}

function gatewayHttpEndpointFindings(
  policy: unknown,
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  const denied = new Set(
    readStringList(policy, ["gateway", "http", "denyEndpoints"]).map((endpoint) =>
      endpoint.toLowerCase(),
    ),
  );
  if (denied.size === 0) {
    return [];
  }
  return (evidence.gatewayExposure ?? [])
    .filter(
      (entry) =>
        entry.kind === "httpEndpoint" &&
        entry.endpoint !== undefined &&
        denied.has(entry.endpoint.toLowerCase()),
    )
    .map((entry): HealthFinding => {
      return {
        checkId: CHECK_IDS.policyGatewayHttpEndpointEnabled,
        severity: "error",
        message: `Gateway HTTP endpoint '${entry.endpoint ?? entry.id}' is denied by policy.`,
        source: "policy",
        path: "openclaw config",
        ocPath: entry.source,
        target: entry.source,
        requirement: `oc://${policyDocName}/gateway/http/denyEndpoints`,
        fixHint: "Disable the HTTP endpoint or update policy after review.",
      };
    });
}

function gatewayHttpUrlFetchFindings(
  policy: unknown,
  policyDocName: string,
  evidence: PolicyEvidence,
): readonly HealthFinding[] {
  if (readPolicyBoolean(policy, ["gateway", "http", "requireUrlAllowlists"]) !== true) {
    return [];
  }
  return (evidence.gatewayExposure ?? [])
    .filter((entry) => entry.kind === "httpUrlFetch" && entry.hasAllowlist !== true)
    .map((entry): HealthFinding => {
      return {
        checkId: CHECK_IDS.policyGatewayHttpUrlFetchUnrestricted,
        severity: "error",
        message: `Gateway HTTP URL-fetch input '${entry.id}' has no URL allowlist.`,
        source: "policy",
        path: "openclaw config",
        ocPath: entry.source,
        target: entry.source,
        requirement: `oc://${policyDocName}/gateway/http/requireUrlAllowlists`,
        fixHint: "Add a urlAllowlist for this URL-fetch input or update policy after review.",
      };
    });
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
      (gateway.http.denyEndpoints !== undefined || gateway.http.requireUrlAllowlists !== undefined))
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

type ScopedAgentPolicyField = {
  readonly fieldPath: string;
  readonly propertyPath: string;
  readonly targetPath: string;
  readonly metadata: PolicyRuleMetadata;
  readonly value: unknown;
};

function duplicateScopedAgentFieldFinding(
  scopedAgents: Record<string, unknown>,
  params: {
    readonly policyDocName: string;
    readonly policyPath: string;
    readonly policy: Record<string, unknown>;
  },
): HealthFinding | undefined {
  const seen = new Map<
    string,
    {
      readonly scopeName: string;
      readonly propertyPath: string;
      readonly field: ScopedAgentPolicyField;
    }
  >();
  for (const [scopeName, overlay] of Object.entries(scopedAgents)) {
    if (!isRecord(overlay) || !Array.isArray(overlay.agentIds)) {
      continue;
    }
    const fields = scopedAgentPolicyFields(scopeName, overlay);
    for (const rawAgentId of overlay.agentIds) {
      if (typeof rawAgentId !== "string" || rawAgentId.trim() === "") {
        continue;
      }
      const agentId = normalizeAgentId(rawAgentId);
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
        const key = `${agentId}\0${field.fieldPath}`;
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
            `${params.policyPath} scopes.${scopeName}.${field.propertyPath} is not an equally or more restrictive override of ${previous.propertyPath} for agent '${agentId}'.`,
            `Use one effective scoped value per agent, or make later scoped values stricter according to policy metadata.`,
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

function scopedAgentPolicyFields(
  scopeName: string,
  overlay: Record<string, unknown>,
): readonly ScopedAgentPolicyField[] {
  const prefix = `scopes/${ocPathSegment(scopeName)}`;
  return POLICY_RULE_METADATA.filter((rule) => rule.scopeSelectors?.includes("agentIds"))
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

export function isPolicyValueAtLeastAsStrict(
  metadata: PolicyRuleMetadata,
  candidate: unknown,
  baseline: unknown,
): boolean {
  switch (metadata.strictness) {
    case "allowlist-subset":
      return isPolicyAllowlistSubset(metadata, candidate, baseline);
    case "denylist-superset":
      return isPolicyDenylistSuperset(metadata, candidate, baseline);
    case "requires-true":
      return baseline !== true || candidate === true;
    case "requires-false":
      return baseline !== false || candidate === false;
    case "exact-list":
      return samePolicyStringList(candidate, baseline, metadata);
  }
  return false;
}

function isPolicyAllowlistSubset(
  metadata: PolicyRuleMetadata,
  candidate: unknown,
  baseline: unknown,
): boolean {
  const candidateList = policyStringList(candidate, metadata);
  const baselineList = policyStringList(baseline, metadata);
  if (candidateList === undefined || baselineList === undefined) {
    return false;
  }
  if (metadata.emptyList === "disabled" && baselineList.length === 0) {
    return true;
  }
  if (metadata.emptyList === "disabled" && baselineList.length > 0 && candidateList.length === 0) {
    return false;
  }
  const allowed = new Set(baselineList);
  return candidateList.every((entry) => allowed.has(entry));
}

function isPolicyDenylistSuperset(
  metadata: PolicyRuleMetadata,
  candidate: unknown,
  baseline: unknown,
): boolean {
  const candidateList = policyStringList(candidate, metadata);
  const baselineList = policyStringList(baseline, metadata);
  if (candidateList === undefined || baselineList === undefined) {
    return false;
  }
  if (metadata.policyPath.join(".") === "tools.denyTools") {
    return baselineList
      .flatMap(expandPolicyToolRequirement)
      .every((tool) => toolListCoversTool(candidateList, tool));
  }
  const denied = new Set(candidateList);
  return baselineList.every((entry) => denied.has(entry));
}

function samePolicyStringList(
  candidate: unknown,
  baseline: unknown,
  metadata: PolicyRuleMetadata,
): boolean {
  const candidateList = policyStringList(candidate, metadata);
  const baselineList = policyStringList(baseline, metadata);
  if (candidateList === undefined || baselineList === undefined) {
    return false;
  }
  const candidateSorted = candidateList.toSorted();
  const baselineSorted = baselineList.toSorted();
  return (
    candidateSorted.length === baselineSorted.length &&
    candidateSorted.every((entry, index) => entry === baselineSorted[index])
  );
}

function policyStringList(
  value: unknown,
  metadata: PolicyRuleMetadata,
): readonly string[] | undefined {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    return undefined;
  }
  return value
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => (metadata.caseSensitive === true ? entry : entry.toLowerCase()));
}

function scopedPolicyValue(overlay: Record<string, unknown>, path: readonly string[]): unknown {
  const scopedRoot = path[0] === "agents" ? overlay.agents : overlay[path[0]];
  if (path[0] === "agents") {
    return getPolicyPath(scopedRoot, path.slice(1));
  }
  return getPolicyPath(scopedRoot, path.slice(1));
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
    const fs = await import("node:fs/promises");
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

async function readWorkspaceFile(
  ctx: HealthCheckContext,
  fileName: string,
): Promise<{ raw: string; path: string } | null> {
  const path = resolveWorkspacePath(ctx, fileName);
  try {
    const fs = await import("node:fs/promises");
    return { raw: await fs.readFile(path, "utf-8"), path };
  } catch (err) {
    if (isNotFound(err)) {
      return null;
    }
    throw err;
  }
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

function readPolicyStringArray(
  policy: unknown,
  path: readonly string[],
  options: { readonly lowercase?: boolean } = {},
): readonly string[] | undefined {
  let current: unknown = policy;
  for (const part of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[part];
  }
  if (!Array.isArray(current) || !current.every((entry) => typeof entry === "string")) {
    return undefined;
  }
  const lowercase = options.lowercase ?? true;
  return current
    .map((entry) => {
      const trimmed = entry.trim();
      return lowercase ? trimmed.toLowerCase() : trimmed;
    })
    .filter(Boolean);
}

function readStringList(
  policy: unknown,
  path: readonly string[],
  options?: { readonly lowercase?: boolean },
): readonly string[] {
  return readPolicyStringArray(policy, path, options) ?? [];
}

function ocPathSegment(value: string): string {
  if (/^(?:[A-Za-z0-9_-]+|#\d+)$/.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}

function readPolicyBoolean(policy: unknown, path: readonly string[]): boolean | undefined {
  let current: unknown = policy;
  for (const part of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[part];
  }
  return typeof current === "boolean" ? current : undefined;
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
