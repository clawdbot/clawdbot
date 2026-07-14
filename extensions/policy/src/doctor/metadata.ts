// Policy doctor rule metadata.
import { CHECK_IDS, POLICY_CHECK_IDS } from "./check-ids.js";

type PolicyStrictnessKind =
  | "allowlist-subset"
  | "denylist-superset"
  | "ordered-string"
  | "requires-true"
  | "requires-false"
  | "exact-list";

type PolicyEmptyListSemantics = "disabled" | "meaningful";

export type PolicyScopeSelectorKind = "agentIds" | "channelIds";

export type PolicyRuleMetadata = {
  readonly policyPath: readonly string[];
  readonly strictness: PolicyStrictnessKind;
  readonly valueType: "boolean" | "channel-provider-deny-rules" | "string" | "string-list";
  readonly checkIds: readonly (typeof POLICY_CHECK_IDS)[number][];
  readonly emptyList?: PolicyEmptyListSemantics;
  readonly allowedValues?: readonly string[];
  readonly caseSensitive?: boolean;
  readonly normalizeValues?: "model-provider";
  readonly orderedValues?: readonly string[];
  readonly scopeSelectors?: readonly PolicyScopeSelectorKind[];
};

export const SANDBOX_CONTAINER_POLICY_RULES = [
  {
    key: "denyHostNetwork",
    label: "host network posture",
    checkIds: [CHECK_IDS.policySandboxContainerHostNetworkDenied],
  },
  {
    key: "denyContainerNamespaceJoin",
    label: "container namespace posture",
    checkIds: [CHECK_IDS.policySandboxContainerNamespaceJoinDenied],
  },
  {
    key: "requireReadOnlyMounts",
    label: "container mount mode posture",
    checkIds: [CHECK_IDS.policySandboxContainerMountModeRequired],
  },
  {
    key: "denyContainerRuntimeSocketMounts",
    label: "container runtime socket mount posture",
    checkIds: [CHECK_IDS.policySandboxContainerRuntimeSocketMount],
  },
  {
    key: "denyUnconfinedProfiles",
    label: "container security profile posture",
    checkIds: [CHECK_IDS.policySandboxContainerUnconfinedProfile],
  },
] as const;

const SANDBOX_POLICY_RULE_METADATA = [
  {
    policyPath: ["sandbox", "requireMode"],
    strictness: "allowlist-subset",
    valueType: "string-list",
    checkIds: [CHECK_IDS.policySandboxModeUnapproved],
    emptyList: "disabled",
    allowedValues: ["off", "non-main", "all"],
    scopeSelectors: ["agentIds"],
  },
  {
    policyPath: ["sandbox", "allowBackends"],
    strictness: "allowlist-subset",
    valueType: "string-list",
    checkIds: [CHECK_IDS.policySandboxBackendUnapproved],
    emptyList: "disabled",
    scopeSelectors: ["agentIds"],
  },
  ...SANDBOX_CONTAINER_POLICY_RULES.map((rule) => ({
    policyPath: ["sandbox", "containers", rule.key] as const,
    strictness: "requires-true" as const,
    valueType: "boolean" as const,
    checkIds: rule.checkIds,
    scopeSelectors: ["agentIds"] as const,
  })),
  {
    policyPath: ["sandbox", "browser", "requireCdpSourceRange"],
    strictness: "requires-true",
    valueType: "boolean",
    checkIds: [CHECK_IDS.policySandboxBrowserCdpSourceRangeMissing],
    scopeSelectors: ["agentIds"],
  },
] as const satisfies readonly PolicyRuleMetadata[];

export const POLICY_RULE_METADATA = [
  {
    policyPath: ["channels", "denyRules"],
    strictness: "denylist-superset",
    valueType: "channel-provider-deny-rules",
    checkIds: [CHECK_IDS.policyDeniedChannelProvider],
    emptyList: "meaningful",
    caseSensitive: true,
  },
  {
    policyPath: ["mcp", "servers", "allow"],
    strictness: "allowlist-subset",
    valueType: "string-list",
    checkIds: [CHECK_IDS.policyUnapprovedMcpServer],
    emptyList: "disabled",
    caseSensitive: true,
  },
  {
    policyPath: ["mcp", "servers", "deny"],
    strictness: "denylist-superset",
    valueType: "string-list",
    checkIds: [CHECK_IDS.policyDeniedMcpServer],
    caseSensitive: true,
  },
  {
    policyPath: ["models", "providers", "allow"],
    strictness: "allowlist-subset",
    valueType: "string-list",
    checkIds: [CHECK_IDS.policyUnapprovedModelProvider],
    emptyList: "disabled",
    normalizeValues: "model-provider",
  },
  {
    policyPath: ["models", "providers", "deny"],
    strictness: "denylist-superset",
    valueType: "string-list",
    checkIds: [CHECK_IDS.policyDeniedModelProvider],
    normalizeValues: "model-provider",
  },
  {
    policyPath: ["network", "privateNetwork", "allow"],
    strictness: "requires-false",
    valueType: "boolean",
    checkIds: [CHECK_IDS.policyPrivateNetworkAccess],
  },
  {
    policyPath: ["ingress", "session", "requireDmScope"],
    strictness: "ordered-string",
    valueType: "string",
    orderedValues: ["main", "per-peer", "per-channel-peer", "per-account-channel-peer"],
    checkIds: [CHECK_IDS.policyIngressDmScopeUnapproved],
  },
  {
    policyPath: ["gateway", "exposure", "allowNonLoopbackBind"],
    strictness: "requires-false",
    valueType: "boolean",
    checkIds: [CHECK_IDS.policyGatewayNonLoopbackBind],
  },
  {
    policyPath: ["gateway", "exposure", "allowTailscaleFunnel"],
    strictness: "requires-false",
    valueType: "boolean",
    checkIds: [CHECK_IDS.policyGatewayTailscaleFunnel],
  },
  {
    policyPath: ["gateway", "auth", "requireAuth"],
    strictness: "requires-true",
    valueType: "boolean",
    checkIds: [CHECK_IDS.policyGatewayAuthDisabled],
  },
  {
    policyPath: ["gateway", "auth", "requireExplicitRateLimit"],
    strictness: "requires-true",
    valueType: "boolean",
    checkIds: [CHECK_IDS.policyGatewayRateLimitMissing],
  },
  {
    policyPath: ["gateway", "controlUi", "allowInsecure"],
    strictness: "requires-false",
    valueType: "boolean",
    checkIds: [CHECK_IDS.policyGatewayControlUiInsecure],
  },
  {
    policyPath: ["gateway", "remote", "allow"],
    strictness: "requires-false",
    valueType: "boolean",
    checkIds: [CHECK_IDS.policyGatewayRemoteEnabled],
  },
  {
    policyPath: ["gateway", "http", "denyEndpoints"],
    strictness: "denylist-superset",
    valueType: "string-list",
    checkIds: [CHECK_IDS.policyGatewayHttpEndpointEnabled],
    allowedValues: ["chatCompletions", "responses"],
    caseSensitive: true,
  },
  {
    policyPath: ["gateway", "http", "requireUrlAllowlists"],
    strictness: "requires-true",
    valueType: "boolean",
    checkIds: [CHECK_IDS.policyGatewayHttpUrlFetchUnrestricted],
  },
  {
    policyPath: ["gateway", "nodes", "denyCommands"],
    strictness: "denylist-superset",
    valueType: "string-list",
    checkIds: [CHECK_IDS.policyGatewayNodeCommandDenied],
    caseSensitive: true,
  },
  {
    policyPath: ["agents", "workspace", "allowedAccess"],
    strictness: "allowlist-subset",
    valueType: "string-list",
    checkIds: [CHECK_IDS.policyAgentsWorkspaceAccessDenied],
    emptyList: "disabled",
    allowedValues: ["none", "ro", "rw"],
    scopeSelectors: ["agentIds"],
  },
  {
    policyPath: ["agents", "workspace", "denyTools"],
    strictness: "denylist-superset",
    valueType: "string-list",
    checkIds: [CHECK_IDS.policyAgentsToolNotDenied],
    allowedValues: ["exec", "process", "write", "edit", "apply_patch"],
    scopeSelectors: ["agentIds"],
  },
  {
    policyPath: ["tools", "profiles", "allow"],
    strictness: "allowlist-subset",
    valueType: "string-list",
    checkIds: [CHECK_IDS.policyToolsProfileUnapproved],
    emptyList: "disabled",
    allowedValues: ["minimal", "coding", "messaging", "full"],
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
    allowedValues: ["deny", "allowlist", "full"],
    scopeSelectors: ["agentIds"],
  },
  {
    policyPath: ["tools", "exec", "requireAsk"],
    strictness: "allowlist-subset",
    valueType: "string-list",
    checkIds: [CHECK_IDS.policyToolsExecAskUnapproved],
    emptyList: "disabled",
    allowedValues: ["off", "on-miss", "always"],
    scopeSelectors: ["agentIds"],
  },
  {
    policyPath: ["tools", "exec", "allowHosts"],
    strictness: "allowlist-subset",
    valueType: "string-list",
    checkIds: [CHECK_IDS.policyToolsExecHostUnapproved],
    emptyList: "disabled",
    allowedValues: ["auto", "sandbox", "gateway", "node"],
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
  {
    policyPath: ["tools", "requireMetadata"],
    strictness: "denylist-superset",
    valueType: "string-list",
    checkIds: [
      CHECK_IDS.policyMissingToolRisk,
      CHECK_IDS.policyMissingToolSensitivity,
      CHECK_IDS.policyMissingToolOwner,
    ],
    allowedValues: ["risk", "sensitivity", "owner"],
  },
  ...SANDBOX_POLICY_RULE_METADATA,
  {
    policyPath: ["ingress", "channels", "allowDmPolicies"],
    strictness: "allowlist-subset",
    valueType: "string-list",
    checkIds: [CHECK_IDS.policyIngressDmPolicyUnapproved],
    emptyList: "disabled",
    allowedValues: ["pairing", "allowlist", "open", "disabled"],
    scopeSelectors: ["channelIds"],
  },
  {
    policyPath: ["ingress", "channels", "denyOpenGroups"],
    strictness: "requires-true",
    valueType: "boolean",
    checkIds: [CHECK_IDS.policyIngressOpenGroupsDenied],
    scopeSelectors: ["channelIds"],
  },
  {
    policyPath: ["ingress", "channels", "requireMentionInGroups"],
    strictness: "requires-true",
    valueType: "boolean",
    checkIds: [CHECK_IDS.policyIngressGroupMentionRequired],
    scopeSelectors: ["channelIds"],
  },
  {
    policyPath: ["dataHandling", "sensitiveLogging", "requireRedaction"],
    strictness: "requires-true",
    valueType: "boolean",
    checkIds: [CHECK_IDS.policyDataHandlingRedactionDisabled],
  },
  {
    policyPath: ["dataHandling", "telemetry", "denyContentCapture"],
    strictness: "requires-true",
    valueType: "boolean",
    checkIds: [CHECK_IDS.policyDataHandlingTelemetryContentCapture],
  },
  {
    policyPath: ["dataHandling", "retention", "requireSessionMaintenance"],
    strictness: "requires-true",
    valueType: "boolean",
    checkIds: [CHECK_IDS.policyDataHandlingSessionRetentionNotEnforced],
  },
  {
    policyPath: ["dataHandling", "memory", "denySessionTranscriptIndexing"],
    strictness: "requires-true",
    valueType: "boolean",
    checkIds: [CHECK_IDS.policyDataHandlingSessionTranscriptMemory],
    scopeSelectors: ["agentIds"],
  },
  {
    policyPath: ["secrets", "requireManagedProviders"],
    strictness: "requires-true",
    valueType: "boolean",
    checkIds: [CHECK_IDS.policySecretsUnmanagedProvider],
  },
  {
    policyPath: ["secrets", "denySources"],
    strictness: "denylist-superset",
    valueType: "string-list",
    checkIds: [CHECK_IDS.policySecretsDeniedProviderSource],
  },
  {
    policyPath: ["secrets", "allowInsecureProviders"],
    strictness: "requires-false",
    valueType: "boolean",
    checkIds: [CHECK_IDS.policySecretsInsecureProvider],
  },

  {
    policyPath: ["execApprovals", "requireFile"],
    strictness: "requires-true",
    valueType: "boolean",
    checkIds: [CHECK_IDS.policyExecApprovalsMissing],
  },
  {
    policyPath: ["execApprovals", "defaults", "allowSecurity"],
    strictness: "allowlist-subset",
    valueType: "string-list",
    checkIds: [CHECK_IDS.policyExecApprovalsDefaultSecurityUnapproved],
    emptyList: "disabled",
    allowedValues: ["deny", "allowlist", "full"],
  },
  {
    policyPath: ["execApprovals", "agents", "allowSecurity"],
    strictness: "allowlist-subset",
    valueType: "string-list",
    checkIds: [CHECK_IDS.policyExecApprovalsAgentSecurityUnapproved],
    emptyList: "disabled",
    allowedValues: ["deny", "allowlist", "full"],
    scopeSelectors: ["agentIds"],
  },
  {
    policyPath: ["execApprovals", "agents", "allowAutoAllowSkills"],
    strictness: "requires-false",
    valueType: "boolean",
    checkIds: [CHECK_IDS.policyExecApprovalsAutoAllowSkillsEnabled],
    scopeSelectors: ["agentIds"],
  },
  {
    policyPath: ["execApprovals", "agents", "allowlist", "expected"],
    strictness: "exact-list",
    valueType: "string-list",
    checkIds: [
      CHECK_IDS.policyExecApprovalsAllowlistMissing,
      CHECK_IDS.policyExecApprovalsAllowlistUnexpected,
    ],
    emptyList: "meaningful",
    caseSensitive: true,
    scopeSelectors: ["agentIds"],
  },
  {
    policyPath: ["auth", "profiles", "requireMetadata"],
    strictness: "denylist-superset",
    valueType: "string-list",
    checkIds: [CHECK_IDS.policyAuthProfileInvalidMetadata],
    allowedValues: ["provider", "mode"],
  },
  {
    policyPath: ["auth", "profiles", "allowModes"],
    strictness: "allowlist-subset",
    valueType: "string-list",
    checkIds: [CHECK_IDS.policyAuthProfileUnapprovedMode],
    emptyList: "disabled",
    allowedValues: ["api_key", "aws-sdk", "oauth", "token"],
  },
] as const satisfies readonly PolicyRuleMetadata[];
