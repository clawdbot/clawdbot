// Policy doctor fix metadata classifies findings before patch builders exist.
import { CHECK_IDS, POLICY_CHECK_IDS } from "./check-ids.js";

type PolicyFixClass = "automatic" | "reviewRequired" | "manual" | "validateOnly" | "unsupported";

type PolicyFixMetadata = {
  readonly checkId: (typeof POLICY_CHECK_IDS)[number];
  readonly fixClass: PolicyFixClass;
  readonly policyPath?: readonly string[];
  readonly configTargets?: readonly string[];
  readonly summary: string;
};

const m = (
  checkId: (typeof POLICY_CHECK_IDS)[number],
  fixClass: PolicyFixClass,
  summary: string,
  options: Omit<PolicyFixMetadata, "checkId" | "fixClass" | "summary"> = {},
): PolicyFixMetadata => ({
  checkId,
  fixClass,
  summary,
  ...options,
});

const POLICY_FIX_METADATA = [
  m(CHECK_IDS.policyMissingFile, "manual", "Restore or author the approved policy artifact."),
  m(CHECK_IDS.policyInvalidFile, "manual", "Repair the policy JSONC syntax or schema."),
  m(
    CHECK_IDS.policyHashMismatch,
    "manual",
    "Restore the approved artifact or update the expected hash after review.",
    { configTargets: ["plugins.entries.policy.config.expectedHash"] },
  ),
  m(
    CHECK_IDS.policyAttestationMismatch,
    "manual",
    "Review the current attestation and update accepted hashes after approval.",
    { configTargets: ["plugins.entries.policy.config.expectedAttestationHash"] },
  ),
  m(
    CHECK_IDS.policyDeniedChannelProvider,
    "automatic",
    "Disable product-managed channels matching the denied provider.",
    { policyPath: ["channels", "denyRules"], configTargets: ["channels"] },
  ),
  m(CHECK_IDS.policyDeniedMcpServer, "reviewRequired", "Remove or disable the denied MCP server.", {
    policyPath: ["mcp", "servers", "deny"],
    configTargets: ["mcp.servers"],
  }),
  m(
    CHECK_IDS.policyUnapprovedMcpServer,
    "reviewRequired",
    "Remove the unapproved MCP server or select an approved replacement.",
    { policyPath: ["mcp", "servers", "allow"], configTargets: ["mcp.servers"] },
  ),
  m(
    CHECK_IDS.policyDeniedModelProvider,
    "reviewRequired",
    "Remove the model provider or switch references to an approved provider.",
    { policyPath: ["models", "providers", "deny"], configTargets: ["models"] },
  ),
  m(
    CHECK_IDS.policyUnapprovedModelProvider,
    "reviewRequired",
    "Select an approved model provider.",
    { policyPath: ["models", "providers", "allow"], configTargets: ["models"] },
  ),
  m(
    CHECK_IDS.policyPrivateNetworkAccess,
    "reviewRequired",
    "Disable the concrete private-network access opt-in.",
    { policyPath: ["network", "privateNetwork", "allow"], configTargets: ["network"] },
  ),
  m(
    CHECK_IDS.policyIngressDmPolicyUnapproved,
    "reviewRequired",
    "Set channel DM policy to an allowed value.",
    { policyPath: ["ingress", "channels", "allowDmPolicies"], configTargets: ["channels"] },
  ),
  m(
    CHECK_IDS.policyIngressDmScopeUnapproved,
    "reviewRequired",
    "Move session DM scope to the required or stricter ordered value.",
    { policyPath: ["ingress", "session", "requireDmScope"], configTargets: ["ingress"] },
  ),
  m(
    CHECK_IDS.policyIngressOpenGroupsDenied,
    "automatic",
    "Disable product-managed open group ingress.",
    { policyPath: ["ingress", "channels", "denyOpenGroups"], configTargets: ["channels"] },
  ),
  m(
    CHECK_IDS.policyIngressGroupMentionRequired,
    "automatic",
    "Require mention in product-managed group channels.",
    { policyPath: ["ingress", "channels", "requireMentionInGroups"], configTargets: ["channels"] },
  ),
  m(
    CHECK_IDS.policyGatewayNonLoopbackBind,
    "reviewRequired",
    "Set gateway bind address to loopback when remote exposure is not intended.",
    {
      policyPath: ["gateway", "exposure", "allowNonLoopbackBind"],
      configTargets: ["gateway.bind"],
    },
  ),
  m(
    CHECK_IDS.policyGatewayAuthDisabled,
    "manual",
    "Configure token, password, or trusted-proxy auth.",
    { policyPath: ["gateway", "auth", "requireAuth"], configTargets: ["gateway.auth"] },
  ),
  m(
    CHECK_IDS.policyGatewayRateLimitMissing,
    "reviewRequired",
    "Add explicit gateway auth rate limits from product defaults.",
    {
      policyPath: ["gateway", "auth", "requireExplicitRateLimit"],
      configTargets: ["gateway.auth.rateLimit"],
    },
  ),
  m(
    CHECK_IDS.policyGatewayControlUiInsecure,
    "automatic",
    "Disable the insecure Control UI toggle.",
    { policyPath: ["gateway", "controlUi", "allowInsecure"], configTargets: ["gateway.controlUi"] },
  ),
  m(
    CHECK_IDS.policyGatewayTailscaleFunnel,
    "reviewRequired",
    "Disable Tailscale funnel or serve exposure.",
    { policyPath: ["gateway", "exposure", "allowTailscaleFunnel"], configTargets: ["tailscale"] },
  ),
  m(
    CHECK_IDS.policyGatewayRemoteEnabled,
    "automatic",
    "Disable product-managed remote gateway mode.",
    { policyPath: ["gateway", "remote", "allow"], configTargets: ["gateway.remote"] },
  ),
  m(
    CHECK_IDS.policyGatewayHttpEndpointEnabled,
    "automatic",
    "Disable denied Gateway HTTP endpoints.",
    { policyPath: ["gateway", "http", "denyEndpoints"], configTargets: ["gateway.http"] },
  ),
  m(
    CHECK_IDS.policyGatewayHttpUrlFetchUnrestricted,
    "manual",
    "Add URL allowlists for each URL-fetch input.",
    { policyPath: ["gateway", "http", "requireUrlAllowlists"], configTargets: ["gateway.http"] },
  ),
  m(
    CHECK_IDS.policyGatewayNodeCommandDenied,
    "reviewRequired",
    "Add the command to gateway node denyCommands or update policy after review.",
    {
      policyPath: ["gateway", "nodes", "denyCommands"],
      configTargets: ["gateway.nodes.denyCommands"],
    },
  ),
  m(
    CHECK_IDS.policyAgentsWorkspaceAccessDenied,
    "reviewRequired",
    "Set agent workspace access to an allowed mode.",
    { policyPath: ["agents", "workspace", "allowedAccess"], configTargets: ["agents"] },
  ),
  m(
    CHECK_IDS.policyAgentsToolNotDenied,
    "automatic",
    "Merge required built-in workspace tool denies.",
    { policyPath: ["agents", "workspace", "denyTools"], configTargets: ["agents"] },
  ),
  m(
    CHECK_IDS.policyToolsProfileUnapproved,
    "reviewRequired",
    "Set the tool profile to an allowed profile.",
    { policyPath: ["tools", "profiles", "allow"], configTargets: ["tools.profile"] },
  ),
  m(
    CHECK_IDS.policyToolsFsWorkspaceOnlyRequired,
    "reviewRequired",
    "Set workspace-only filesystem posture when required assets remain readable.",
    {
      policyPath: ["tools", "fs", "requireWorkspaceOnly"],
      configTargets: ["tools.fs.workspaceOnly"],
    },
  ),
  m(
    CHECK_IDS.policyToolsExecSecurityUnapproved,
    "reviewRequired",
    "Set exec security to an allowed value.",
    { policyPath: ["tools", "exec", "allowSecurity"], configTargets: ["tools.exec.security"] },
  ),
  m(
    CHECK_IDS.policyToolsExecAskUnapproved,
    "reviewRequired",
    "Set exec ask mode to an allowed value.",
    { policyPath: ["tools", "exec", "requireAsk"], configTargets: ["tools.exec.ask"] },
  ),
  m(
    CHECK_IDS.policyToolsExecHostUnapproved,
    "reviewRequired",
    "Move exec host to an allowed host mode.",
    { policyPath: ["tools", "exec", "allowHosts"], configTargets: ["tools.exec.host"] },
  ),
  m(CHECK_IDS.policyToolsElevatedEnabled, "automatic", "Set tools elevated mode to disabled.", {
    policyPath: ["tools", "elevated", "allow"],
    configTargets: ["tools.elevated.enabled"],
  }),
  m(
    CHECK_IDS.policyToolsAlsoAllowMissing,
    "reviewRequired",
    "Add expected alsoAllow entries only when policy intentionally grants them.",
    { policyPath: ["tools", "alsoAllow", "expected"], configTargets: ["tools.alsoAllow"] },
  ),
  m(
    CHECK_IDS.policyToolsAlsoAllowUnexpected,
    "reviewRequired",
    "Remove unexpected alsoAllow entries.",
    { policyPath: ["tools", "alsoAllow", "expected"], configTargets: ["tools.alsoAllow"] },
  ),
  m(
    CHECK_IDS.policyToolsRequiredDenyMissing,
    "automatic",
    "Merge required built-in deny tool classes.",
    {
      policyPath: ["tools", "denyTools"],
      configTargets: ["tools.deny", "agents.list[].tools.deny"],
    },
  ),
  m(
    CHECK_IDS.policySandboxModeUnapproved,
    "reviewRequired",
    "Set sandbox mode to an allowed value.",
    { policyPath: ["sandbox", "requireMode"], configTargets: ["sandbox.mode"] },
  ),
  m(
    CHECK_IDS.policySandboxBackendUnapproved,
    "reviewRequired",
    "Choose an approved sandbox backend that is installed.",
    { policyPath: ["sandbox", "allowBackends"], configTargets: ["sandbox.backend"] },
  ),
  m(
    CHECK_IDS.policySandboxContainerPostureUnobservable,
    "unsupported",
    "Add observable container posture evidence before patching.",
  ),
  m(
    CHECK_IDS.policySandboxContainerHostNetworkDenied,
    "reviewRequired",
    "Disable container host networking.",
    {
      policyPath: ["sandbox", "containers", "denyHostNetwork"],
      configTargets: ["sandbox.containers"],
    },
  ),
  m(
    CHECK_IDS.policySandboxContainerNamespaceJoinDenied,
    "reviewRequired",
    "Disable joining container namespaces.",
    {
      policyPath: ["sandbox", "containers", "denyContainerNamespaceJoin"],
      configTargets: ["sandbox.containers"],
    },
  ),
  m(
    CHECK_IDS.policySandboxContainerMountModeRequired,
    "reviewRequired",
    "Change required mounts to read-only.",
    {
      policyPath: ["sandbox", "containers", "requireReadOnlyMounts"],
      configTargets: ["sandbox.containers"],
    },
  ),
  m(
    CHECK_IDS.policySandboxContainerRuntimeSocketMount,
    "reviewRequired",
    "Remove container runtime socket binds.",
    {
      policyPath: ["sandbox", "containers", "denyContainerRuntimeSocketMounts"],
      configTargets: ["sandbox.containers"],
    },
  ),
  m(
    CHECK_IDS.policySandboxContainerUnconfinedProfile,
    "reviewRequired",
    "Remove unconfined container profiles.",
    {
      policyPath: ["sandbox", "containers", "denyUnconfinedProfiles"],
      configTargets: ["sandbox.containers"],
    },
  ),
  m(
    CHECK_IDS.policySandboxBrowserCdpSourceRangeMissing,
    "manual",
    "Add an explicit browser CDP source range.",
    {
      policyPath: ["sandbox", "browser", "requireCdpSourceRange"],
      configTargets: ["agents.sandbox.browser"],
    },
  ),
  m(
    CHECK_IDS.policyDataHandlingRedactionDisabled,
    "automatic",
    "Set sensitive logging to a redacting mode.",
    {
      policyPath: ["dataHandling", "sensitiveLogging", "requireRedaction"],
      configTargets: ["logging.redactSensitive"],
    },
  ),
  m(
    CHECK_IDS.policyDataHandlingTelemetryContentCapture,
    "automatic",
    "Disable telemetry content capture.",
    {
      policyPath: ["dataHandling", "telemetry", "denyContentCapture"],
      configTargets: ["diagnostics.otel.captureContent"],
    },
  ),
  m(
    CHECK_IDS.policyDataHandlingSessionRetentionNotEnforced,
    "reviewRequired",
    "Set session maintenance to enforced mode.",
    {
      policyPath: ["dataHandling", "retention", "requireSessionMaintenance"],
      configTargets: ["session.maintenance.mode"],
    },
  ),
  m(
    CHECK_IDS.policyDataHandlingSessionTranscriptMemory,
    "reviewRequired",
    "Disable transcript indexing for the affected agent scope.",
    {
      policyPath: ["dataHandling", "memory", "denySessionTranscriptIndexing"],
      configTargets: ["memory"],
    },
  ),
  m(
    CHECK_IDS.policySecretsUnmanagedProvider,
    "manual",
    "Migrate the secret to a managed provider.",
    { policyPath: ["secrets", "requireManagedProviders"], configTargets: ["secrets"] },
  ),
  m(
    CHECK_IDS.policySecretsDeniedProviderSource,
    "reviewRequired",
    "Move the secret out of the denied source.",
    { policyPath: ["secrets", "denySources"], configTargets: ["secrets"] },
  ),
  m(
    CHECK_IDS.policySecretsInsecureProvider,
    "reviewRequired",
    "Remove insecure provider overrides.",
    { policyPath: ["secrets", "allowInsecureProviders"], configTargets: ["secrets"] },
  ),
  m(
    CHECK_IDS.policyAuthProfileInvalidMetadata,
    "manual",
    "Add required provider and mode metadata to auth profiles.",
    { policyPath: ["auth", "profiles", "requireMetadata"], configTargets: ["auth.profiles"] },
  ),
  m(
    CHECK_IDS.policyAuthProfileUnapprovedMode,
    "manual",
    "Change auth mode and credentials through the auth owner flow.",
    { policyPath: ["auth", "profiles", "allowModes"], configTargets: ["auth.profiles"] },
  ),
  m(
    CHECK_IDS.policyExecApprovalsMissing,
    "manual",
    "Restore an attributable exec-approvals evidence file.",
    { policyPath: ["execApprovals", "requireFile"], configTargets: ["exec-approvals.json"] },
  ),
  m(CHECK_IDS.policyExecApprovalsInvalid, "manual", "Repair the exec approvals evidence artifact."),
  m(
    CHECK_IDS.policyExecApprovalsDefaultSecurityUnapproved,
    "manual",
    "Update reviewed default approval evidence or policy.",
    {
      policyPath: ["execApprovals", "defaults", "allowSecurity"],
      configTargets: ["exec-approvals.json"],
    },
  ),
  m(
    CHECK_IDS.policyExecApprovalsAgentSecurityUnapproved,
    "manual",
    "Update reviewed agent approval evidence or policy.",
    {
      policyPath: ["execApprovals", "agents", "allowSecurity"],
      configTargets: ["exec-approvals.json"],
    },
  ),
  m(
    CHECK_IDS.policyExecApprovalsAutoAllowSkillsEnabled,
    "reviewRequired",
    "Disable auto-allow skills in the approval owner surface.",
    {
      policyPath: ["execApprovals", "agents", "allowAutoAllowSkills"],
      configTargets: ["exec-approvals.json"],
    },
  ),
  m(
    CHECK_IDS.policyExecApprovalsAllowlistMissing,
    "manual",
    "Add expected approval patterns through approval review.",
    {
      policyPath: ["execApprovals", "agents", "allowlist", "expected"],
      configTargets: ["exec-approvals.json"],
    },
  ),
  m(
    CHECK_IDS.policyExecApprovalsAllowlistUnexpected,
    "manual",
    "Remove unexpected approval patterns through approval review.",
    {
      policyPath: ["execApprovals", "agents", "allowlist", "expected"],
      configTargets: ["exec-approvals.json"],
    },
  ),
  m(
    CHECK_IDS.policyMissingToolRisk,
    "manual",
    "Add tool risk metadata in the owning tool declaration.",
    { policyPath: ["tools", "requireMetadata"], configTargets: ["tools"] },
  ),
  m(CHECK_IDS.policyUnknownToolRisk, "manual", "Use a supported tool risk level.", {
    policyPath: ["tools", "requireMetadata"],
    configTargets: ["tools"],
  }),
  m(
    CHECK_IDS.policyMissingToolSensitivity,
    "manual",
    "Add tool sensitivity metadata in the owning tool declaration.",
    { policyPath: ["tools", "requireMetadata"], configTargets: ["tools"] },
  ),
  m(
    CHECK_IDS.policyMissingToolOwner,
    "manual",
    "Add owner metadata in the owning tool declaration.",
    { policyPath: ["tools", "requireMetadata"], configTargets: ["tools"] },
  ),
  m(CHECK_IDS.policyUnknownToolSensitivity, "manual", "Use a supported tool sensitivity token.", {
    policyPath: ["tools", "requireMetadata"],
    configTargets: ["tools"],
  }),
] as const satisfies readonly PolicyFixMetadata[];

export const POLICY_FIX_METADATA_BY_CHECK_ID = new Map(
  POLICY_FIX_METADATA.map((rule) => [rule.checkId, rule] as const),
);
