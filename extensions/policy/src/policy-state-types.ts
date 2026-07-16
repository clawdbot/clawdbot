// Policy plugin evidence types.
import type { coerceSecretRef } from "openclaw/plugin-sdk/secret-input";

export type PolicyAttestation = {
  readonly checkedAt: string;
  readonly policy?: {
    readonly path: string;
    readonly hash: string;
  };
  readonly workspace: {
    readonly scope: "policy";
    readonly hash: string;
  };
  readonly findingsHash?: string;
  readonly attestationHash?: string;
};

export type PolicyEvidence = {
  readonly channels: readonly PolicyChannelEvidence[];
  readonly tools?: readonly PolicyToolEvidence[];
  readonly toolPosture?: readonly PolicyToolPostureEvidence[];
  readonly sandboxPosture?: readonly PolicySandboxPostureEvidence[];
  readonly mcpServers: readonly PolicyMcpServerEvidence[];
  readonly modelProviders: readonly PolicyModelProviderEvidence[];
  readonly modelRefs: readonly PolicyModelRefEvidence[];
  readonly network: readonly PolicyNetworkEvidence[];
  readonly ingress?: readonly PolicyIngressEvidence[];
  readonly gatewayExposure?: readonly PolicyGatewayExposureEvidence[];
  readonly agentWorkspace?: readonly PolicyAgentWorkspaceEvidence[];
  readonly dataHandling?: readonly PolicyDataHandlingEvidence[];
  readonly secrets?: readonly PolicySecretEvidence[];
  readonly authProfiles?: readonly PolicyAuthProfileEvidence[];
  readonly execApprovals?: readonly PolicyExecApprovalEvidence[];
};

export type PolicyChannelEvidence = {
  readonly id: string;
  readonly provider: string;
  readonly source: string;
  readonly enabled?: boolean;
};

export type PolicyMcpServerEvidence = {
  readonly id: string;
  readonly transport: "stdio" | "sse" | "streamable-http" | "unknown";
  readonly source: string;
  readonly command?: string;
  readonly url?: string;
};

export type PolicyToolEvidence = {
  readonly id: string;
  readonly source: string;
  readonly line: number;
  readonly risk?: string;
  readonly sensitivity?: string;
  readonly owner?: string;
  readonly capabilities?: readonly string[];
};

export type PolicyToolPostureEvidence = {
  readonly id: string;
  readonly kind:
    | "allow"
    | "alsoAllow"
    | "deny"
    | "elevatedAllowFrom"
    | "elevatedEnabled"
    | "execAsk"
    | "execHost"
    | "execSecurity"
    | "fsWorkspaceOnly"
    | "profile";
  readonly source: string;
  readonly scope: "global" | "agent";
  readonly agentId?: string;
  readonly value?: boolean | string;
  readonly entries?: readonly string[];
  readonly explicit?: boolean;
};

export type PolicySandboxPostureEvidence = {
  readonly id: string;
  readonly kind:
    | "backend"
    | "browserCdpSourceRange"
    | "containerMount"
    | "containerNetwork"
    | "containerSecurityProfile"
    | "mode";
  readonly source: string;
  readonly scope: "defaults" | "agent";
  readonly agentId?: string;
  readonly value?: boolean | string;
  readonly bind?: string;
  readonly bindMode?: string;
  readonly bindHost?: string;
  readonly bindSurface?: "browser" | "docker";
  readonly networkSurface?: "browser" | "docker";
  readonly profile?: "apparmor" | "seccomp";
  readonly explicit?: boolean;
};

export type PolicyModelProviderEvidence = {
  readonly id: string;
  readonly source: string;
};

export type PolicyModelRefEvidence = {
  readonly ref: string;
  readonly provider: string;
  readonly model: string;
  readonly source: string;
};

export type PolicyNetworkEvidence = {
  readonly id: string;
  readonly source: string;
  readonly value: boolean;
};

export type PolicyIngressEvidence = {
  readonly id: string;
  readonly kind:
    | "channelDmPolicy"
    | "channelGroupPolicy"
    | "channelRequireMention"
    | "sessionDmScope";
  readonly source: string;
  readonly channel?: string;
  readonly accountId?: string;
  readonly groupId?: string;
  readonly value?: boolean | string;
  readonly explicit?: boolean;
};

export type PolicyGatewayExposureEvidence = {
  readonly id: string;
  readonly kind:
    | "auth"
    | "authRateLimit"
    | "bind"
    | "controlUi"
    | "httpEndpoint"
    | "httpUrlFetch"
    | "nodeCommand"
    | "nodeDenyCommand"
    | "remote"
    | "tailscale";
  readonly source: string;
  readonly value?: boolean | string;
  readonly nonLoopback?: boolean;
  readonly explicit?: boolean;
  readonly endpoint?: string;
  readonly hasAllowlist?: boolean;
  readonly command?: string;
};

export type PolicyAgentWorkspaceEvidence = {
  readonly id: string;
  readonly kind: "workspaceAccess" | "toolDeny";
  readonly source: string;
  readonly scope: "defaults" | "agent";
  readonly agentId?: string;
  readonly value?: string;
  readonly sandboxMode?: string;
  readonly sandboxModeSource?: string;
  readonly sandboxEnabled?: boolean;
  readonly tool?: string;
  readonly denied?: boolean;
  readonly explicit?: boolean;
};

export type PolicySecretEvidence = {
  readonly id: string;
  readonly kind: "input" | "provider";
  readonly source: string;
  readonly provenance?: "secretRef";
  readonly refSource?: "env" | "file" | "exec";
  readonly refProvider?: string;
  readonly providerSource?: string;
  readonly insecure?: readonly string[];
};

export type PolicyAuthProfileEvidence = {
  readonly id: string;
  readonly source: string;
  readonly validMetadata: boolean;
  readonly provider?: string;
  readonly mode?: string;
};

export type PolicyExecApprovalEvidence = {
  readonly id: string;
  readonly kind: "agent" | "allowlist" | "defaults";
  readonly source: string;
  readonly agentId?: string;
  readonly security?: string;
  readonly securityConfigured?: boolean;
  readonly ask?: string;
  readonly askFallback?: string;
  readonly autoAllowSkills?: boolean;
  readonly pattern?: string;
  readonly argPattern?: string;
  readonly entrySource?: string;
};

export type PolicyDataHandlingEvidence = {
  readonly id: string;
  readonly kind:
    | "memorySessionTranscriptIndexing"
    | "sensitiveLoggingRedaction"
    | "sessionRetentionMode"
    | "telemetryContentCapture";
  readonly source: string;
  readonly scope: "global" | "agent";
  readonly agentId?: string;
  readonly value?: boolean | string;
  readonly explicit?: boolean;
};

export type SecretRefEvidence = {
  readonly source: "env" | "file" | "exec";
  readonly provider: string;
  readonly id: string;
};

export type SecretRefDefaults = NonNullable<Parameters<typeof coerceSecretRef>[1]>;

export const RESERVED_CHANNEL_CONFIG_KEYS = new Set(["defaults", "modelByChannel"]);

export const NON_SLUG_CHARS = /[^a-z0-9-]+/g;

export const COLLAPSE_HYPHENS = /-+/g;

export const TRIM_HYPHENS = /^-+|-+$/g;
