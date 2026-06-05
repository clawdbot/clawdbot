// Policy plugin module implements policy state behavior.
import { createHash } from "node:crypto";
import { normalizeProviderId } from "openclaw/plugin-sdk/provider-model-shared";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import { coerceSecretRef } from "openclaw/plugin-sdk/secret-input";
import {
  asBoolean as readBoolean,
  isRecord,
  normalizeOptionalString as readString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { POLICY_TOOL_GROUPS } from "./tool-policy-conformance.js";

// Mirrors the sandbox browser config default without importing core internals into the policy plugin.
const DEFAULT_POLICY_SANDBOX_BROWSER_NETWORK = "openclaw-sandbox-browser";
const ALLOWLIST_DEFAULT_INGRESS_GROUP_POLICY_CHANNELS = new Set([
  "googlechat",
  "irc",
  "line",
  "mattermost",
  "matrix",
  "msteams",
  "nextcloud-talk",
  "signal",
]);
const OPEN_GROUPS_DEFAULT_TO_NO_MENTION_CHANNELS = new Set(["feishu", "qa-channel"]);

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
    | "remote"
    | "tailscale";
  readonly source: string;
  readonly value?: boolean | string;
  readonly nonLoopback?: boolean;
  readonly explicit?: boolean;
  readonly endpoint?: string;
  readonly hasAllowlist?: boolean;
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

type SecretRefEvidence = {
  readonly source: "env" | "file" | "exec";
  readonly provider: string;
  readonly id: string;
};
type SecretRefDefaults = NonNullable<Parameters<typeof coerceSecretRef>[1]>;

const RESERVED_CHANNEL_CONFIG_KEYS = new Set(["defaults", "modelByChannel"]);
const NON_SLUG_CHARS = /[^a-z0-9-]+/g;
const COLLAPSE_HYPHENS = /-+/g;
const TRIM_HYPHENS = /^-+|-+$/g;

export function policyDocumentHash(policy: unknown): string {
  return sha256(stableJson(policy));
}

export function policyWorkspaceHash(evidence: PolicyEvidence): string {
  return sha256(stableJson(evidence));
}

export function policyFindingsHash(findings: readonly unknown[]): string {
  return sha256(stableJson(findings));
}

export function policyAttestationHash(input: {
  readonly ok: boolean;
  readonly policyHash?: string;
  readonly workspaceHash: string;
  readonly findingsHash: string;
}): string {
  return sha256(stableJson(input));
}

export function createPolicyAttestation(input: {
  readonly ok: boolean;
  readonly checkedAt: string;
  readonly policyPath: string;
  readonly policyHash?: string;
  readonly evidence: PolicyEvidence;
  readonly findings: readonly unknown[];
}): PolicyAttestation {
  const workspaceHash = policyWorkspaceHash(input.evidence);
  const findingsHash = policyFindingsHash(input.findings);
  return {
    checkedAt: input.checkedAt,
    ...(input.policyHash === undefined
      ? {}
      : {
          policy: {
            path: input.policyPath,
            hash: input.policyHash,
          },
        }),
    workspace: {
      scope: "policy",
      hash: workspaceHash,
    },
    findingsHash,
    attestationHash: policyAttestationHash({
      ok: input.ok,
      policyHash: input.policyHash,
      workspaceHash,
      findingsHash,
    }),
  };
}

export function collectPolicyEvidence(
  cfg: Record<string, unknown>,
  options?: {
    readonly toolsRaw?: undefined;
    readonly includeIngress?: boolean;
    readonly includeGatewayExposure?: boolean;
    readonly includeAgentWorkspace?: boolean;
    readonly includeDataHandling?: boolean;
    readonly includeToolPosture?: boolean;
    readonly includeSandboxPosture?: boolean;
    readonly includeSecrets?: boolean;
    readonly includeAuthProfiles?: boolean;
  },
): PolicyEvidence;
export function collectPolicyEvidence(
  cfg: Record<string, unknown>,
  options: {
    readonly toolsRaw: string;
    readonly includeIngress?: boolean;
    readonly includeGatewayExposure?: boolean;
    readonly includeAgentWorkspace?: boolean;
    readonly includeDataHandling?: boolean;
    readonly includeToolPosture?: boolean;
    readonly includeSandboxPosture?: boolean;
    readonly includeSecrets?: boolean;
    readonly includeAuthProfiles?: boolean;
  },
): Promise<PolicyEvidence>;
export function collectPolicyEvidence(
  cfg: Record<string, unknown>,
  options: {
    readonly toolsRaw?: string;
    readonly includeIngress?: boolean;
    readonly includeGatewayExposure?: boolean;
    readonly includeAgentWorkspace?: boolean;
    readonly includeDataHandling?: boolean;
    readonly includeToolPosture?: boolean;
    readonly includeSandboxPosture?: boolean;
    readonly includeSecrets?: boolean;
    readonly includeAuthProfiles?: boolean;
  } = {},
): PolicyEvidence | Promise<PolicyEvidence> {
  const evidence = {
    channels: scanPolicyChannels(cfg),
    mcpServers: scanPolicyMcpServers(cfg),
    modelProviders: scanPolicyModelProviders(cfg),
    modelRefs: scanPolicyModelRefs(cfg),
    network: scanPolicyNetwork(cfg),
    ...(options.includeIngress === false ? {} : { ingress: scanPolicyIngress(cfg) }),
    ...(options.includeGatewayExposure === false
      ? {}
      : { gatewayExposure: scanPolicyGatewayExposure(cfg) }),
    ...(options.includeAgentWorkspace === false
      ? {}
      : { agentWorkspace: scanPolicyAgentWorkspace(cfg) }),
    ...(options.includeDataHandling === false ? {} : { dataHandling: scanPolicyDataHandling(cfg) }),
    ...(options.includeToolPosture === false ? {} : { toolPosture: scanPolicyToolPosture(cfg) }),
    ...(options.includeSandboxPosture === false
      ? {}
      : { sandboxPosture: scanPolicySandboxPosture(cfg) }),
    ...(options.includeSecrets === false ? {} : { secrets: scanPolicySecrets(cfg) }),
    ...(options.includeAuthProfiles === false ? {} : { authProfiles: scanPolicyAuthProfiles(cfg) }),
  };
  if (options.toolsRaw === undefined) {
    return evidence;
  }
  return scanPolicyTools(options.toolsRaw).then((tools) => ({ ...evidence, tools }));
}

export function scanPolicyChannels(cfg: Record<string, unknown>): readonly PolicyChannelEvidence[] {
  return Object.entries(configuredChannels(cfg))
    .filter(([id]) => !RESERVED_CHANNEL_CONFIG_KEYS.has(id))
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([id, value]) => {
      const entry: {
        id: string;
        provider: string;
        source: string;
        enabled?: boolean;
      } = {
        id,
        provider: id,
        source: `oc://openclaw.config/channels/${id}`,
      };
      if (isRecord(value) && typeof value.enabled === "boolean") {
        entry.enabled = value.enabled;
      }
      return entry;
    });
}

export function scanPolicyMcpServers(
  cfg: Record<string, unknown>,
): readonly PolicyMcpServerEvidence[] {
  return Object.entries(configuredMcpServers(cfg))
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([id, value]) => {
      const entry: {
        id: string;
        transport: "stdio" | "sse" | "streamable-http" | "unknown";
        source: string;
        command?: string;
        url?: string;
      } = {
        id,
        transport: mcpServerTransport(value),
        source: `oc://openclaw.config/mcp/servers/${ocPathSegment(id)}`,
      };
      if (isRecord(value)) {
        if (typeof value.command === "string") {
          entry.command = value.command;
        }
        if (typeof value.url === "string") {
          entry.url = redactMcpUrlForEvidence(value.url);
        }
      }
      return entry;
    });
}

export function scanPolicyModelProviders(
  cfg: Record<string, unknown>,
): readonly PolicyModelProviderEvidence[] {
  return Object.keys(configuredModelProviders(cfg))
    .toSorted((a, b) => a.localeCompare(b))
    .map((id) => ({
      id: normalizeProviderId(id),
      source: `oc://openclaw.config/models/providers/${id}`,
    }));
}

export function scanPolicyModelRefs(
  cfg: Record<string, unknown>,
): readonly PolicyModelRefEvidence[] {
  const refs: PolicyModelRefEvidence[] = [];
  if (isRecord(cfg.agents)) {
    collectModelRefsFromRecord(refs, cfg.agents, "oc://openclaw.config/agents");
    collectModelRefsFromAgentAllowlist(refs, cfg.agents);
  }
  return refs.toSorted(
    (a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model),
  );
}

export function scanPolicyNetwork(cfg: Record<string, unknown>): readonly PolicyNetworkEvidence[] {
  return [
    networkBooleanEvidence(
      cfg,
      "browser-private-network",
      ["browser", "ssrfPolicy", "dangerouslyAllowPrivateNetwork"],
      "oc://openclaw.config/browser/ssrfPolicy/dangerouslyAllowPrivateNetwork",
    ),
    networkBooleanEvidence(
      cfg,
      "browser-private-network-legacy",
      ["browser", "ssrfPolicy", "allowPrivateNetwork"],
      "oc://openclaw.config/browser/ssrfPolicy/allowPrivateNetwork",
    ),
    networkBooleanEvidence(
      cfg,
      "web-fetch-private-network",
      ["tools", "web", "fetch", "ssrfPolicy", "dangerouslyAllowPrivateNetwork"],
      "oc://openclaw.config/tools/web/fetch/ssrfPolicy/dangerouslyAllowPrivateNetwork",
    ),
    networkBooleanEvidence(
      cfg,
      "web-fetch-private-network-legacy",
      ["tools", "web", "fetch", "ssrfPolicy", "allowPrivateNetwork"],
      "oc://openclaw.config/tools/web/fetch/ssrfPolicy/allowPrivateNetwork",
    ),
    networkBooleanEvidence(
      cfg,
      "web-fetch-rfc2544-benchmark-range",
      ["tools", "web", "fetch", "ssrfPolicy", "allowRfc2544BenchmarkRange"],
      "oc://openclaw.config/tools/web/fetch/ssrfPolicy/allowRfc2544BenchmarkRange",
    ),
    networkBooleanEvidence(
      cfg,
      "web-fetch-ipv6-unique-local-range",
      ["tools", "web", "fetch", "ssrfPolicy", "allowIpv6UniqueLocalRange"],
      "oc://openclaw.config/tools/web/fetch/ssrfPolicy/allowIpv6UniqueLocalRange",
    ),
  ].filter((entry): entry is PolicyNetworkEvidence => entry !== undefined);
}

export function scanPolicyIngress(cfg: Record<string, unknown>): readonly PolicyIngressEvidence[] {
  const channels = configuredChannels(cfg);
  const channelDefaults = isRecord(channels.defaults) ? channels.defaults : {};
  const inheritedChannelDefaults = pickSupportedIngressDefaults(channelDefaults);
  const channelDefaultsSource = "oc://openclaw.config/channels/defaults";
  const entries: PolicyIngressEvidence[] = [];
  const session = isRecord(cfg.session) ? cfg.session : {};
  const dmScope = readString(session.dmScope)?.toLowerCase();
  entries.push({
    id: "session-dm-scope",
    kind: "sessionDmScope",
    source: "oc://openclaw.config/session/dmScope",
    value: dmScope ?? "main",
    explicit: dmScope !== undefined,
  });

  for (const [channel, value] of Object.entries(channels)) {
    if (RESERVED_CHANNEL_CONFIG_KEYS.has(channel) || !isRecord(value) || value.enabled === false) {
      continue;
    }
    const channelSource = `oc://openclaw.config/channels/${ocPathSegment(channel)}`;
    const accounts = isRecord(value.accounts) ? value.accounts : {};
    const configuredAccounts = Object.entries(accounts).filter(
      (entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]),
    );
    const activeAccounts = configuredAccounts.filter(([, account]) => account.enabled !== false);
    if (configuredAccounts.length === 0 || hasImplicitDefaultAccountConfig(channel, value)) {
      pushChannelIngress(entries, {
        channel,
        config: value,
        inheritedConfig: inheritedChannelDefaults,
        sourceBase: channelSource,
        inheritedSourceBase: channelDefaultsSource,
        fallbackSourceBase: channelSource,
      });
    }
    for (const [accountId, account] of activeAccounts) {
      const inheritsNestedContainers = channel !== "telegram" || configuredAccounts.length <= 1;
      pushChannelIngress(entries, {
        channel,
        accountId,
        config: account,
        inheritedConfig: value,
        inheritNestedContainers: inheritsNestedContainers,
        sourceBase: `${channelSource}/accounts/${ocPathSegment(accountId)}`,
        inheritedSourceBase: channelSource,
        fallbackConfig: inheritedChannelDefaults,
        fallbackSourceBase: channelDefaultsSource,
      });
    }
  }
  return entries.toSorted((a, b) => a.source.localeCompare(b.source) || a.id.localeCompare(b.id));
}

export function scanPolicyGatewayExposure(
  cfg: Record<string, unknown>,
): readonly PolicyGatewayExposureEvidence[] {
  const gateway = isRecord(cfg.gateway) ? cfg.gateway : {};
  const entries: PolicyGatewayExposureEvidence[] = [];
  const bind = typeof gateway.bind === "string" ? gateway.bind : undefined;
  const customBindHost =
    typeof gateway.customBindHost === "string" ? gateway.customBindHost : undefined;
  const hasCustomBindHost = customBindHost !== undefined && customBindHost.trim() !== "";
  const tailscale = isRecord(gateway.tailscale) ? gateway.tailscale : {};
  const tailscaleForcesLoopback = tailscale.mode === "serve" || tailscale.mode === "funnel";
  entries.push({
    id: bind === undefined ? "gateway-bind-default" : "gateway-bind",
    kind: "bind",
    source: "oc://openclaw.config/gateway/bind",
    value: bind ?? (tailscaleForcesLoopback ? "loopback" : "runtime-default"),
    nonLoopback:
      bind === undefined
        ? !tailscaleForcesLoopback
        : bind === "custom"
          ? false
          : isGatewayNonLoopbackBind(bind),
    explicit: bind !== undefined,
  });
  if (bind === "custom" && hasCustomBindHost) {
    entries.push({
      id: "gateway-custom-bind-host",
      kind: "bind",
      source: "oc://openclaw.config/gateway/customBindHost",
      value: customBindHost,
      nonLoopback: isRuntimeNonLoopbackCustomBindHost(customBindHost),
    });
  }

  const auth = isRecord(gateway.auth) ? gateway.auth : {};
  entries.push({
    id: "gateway-auth-mode",
    kind: "auth",
    source: "oc://openclaw.config/gateway/auth/mode",
    value: typeof auth.mode === "string" ? auth.mode : "token",
    explicit: typeof auth.mode === "string",
  });
  entries.push({
    id: "gateway-auth-rate-limit",
    kind: "authRateLimit",
    source: "oc://openclaw.config/gateway/auth/rateLimit",
    value: isRecord(auth.rateLimit),
    explicit: isRecord(auth.rateLimit),
  });

  const controlUi = isRecord(gateway.controlUi) ? gateway.controlUi : {};
  pushGatewayBooleanEvidence(
    entries,
    "gateway-control-ui-enabled",
    "controlUi",
    controlUi.enabled,
    "oc://openclaw.config/gateway/controlUi/enabled",
  );
  pushGatewayBooleanEvidence(
    entries,
    "gateway-control-ui-insecure-auth",
    "controlUi",
    controlUi.allowInsecureAuth,
    "oc://openclaw.config/gateway/controlUi/allowInsecureAuth",
  );
  pushGatewayBooleanEvidence(
    entries,
    "gateway-control-ui-device-auth-disabled",
    "controlUi",
    controlUi.dangerouslyDisableDeviceAuth,
    "oc://openclaw.config/gateway/controlUi/dangerouslyDisableDeviceAuth",
  );
  pushGatewayBooleanEvidence(
    entries,
    "gateway-control-ui-host-origin-fallback",
    "controlUi",
    controlUi.dangerouslyAllowHostHeaderOriginFallback,
    "oc://openclaw.config/gateway/controlUi/dangerouslyAllowHostHeaderOriginFallback",
  );

  if (typeof tailscale.mode === "string") {
    entries.push({
      id: "gateway-tailscale-mode",
      kind: "tailscale",
      source: "oc://openclaw.config/gateway/tailscale/mode",
      value: tailscale.mode,
    });
  }
  if (tailscale.mode === "serve" && tailscale.preserveFunnel === true) {
    entries.push({
      id: "gateway-tailscale-preserve-funnel",
      kind: "tailscale",
      source: "oc://openclaw.config/gateway/tailscale/preserveFunnel",
      value: "funnel",
    });
  }

  const remote = isRecord(gateway.remote) ? gateway.remote : {};
  if (gateway.mode === "remote") {
    entries.push({
      id: "gateway-mode-remote",
      kind: "remote",
      source: "oc://openclaw.config/gateway/mode",
      value: "remote",
    });
    if (typeof remote.url === "string" && remote.url.trim() !== "") {
      entries.push({
        id: "gateway-remote-url",
        kind: "remote",
        source: "oc://openclaw.config/gateway/remote/url",
        value: true,
      });
    }
  }

  const http = isRecord(gateway.http) ? gateway.http : {};
  const endpoints = isRecord(http.endpoints) ? http.endpoints : {};
  pushGatewayHttpEndpointEvidence(entries, endpoints, "chatCompletions");
  pushGatewayHttpEndpointEvidence(entries, endpoints, "responses");
  return entries.toSorted((a, b) => a.source.localeCompare(b.source));
}

export function scanPolicyAgentWorkspace(
  cfg: Record<string, unknown>,
): readonly PolicyAgentWorkspaceEvidence[] {
  const agents = isRecord(cfg.agents) ? cfg.agents : {};
  const defaults = isRecord(agents.defaults) ? agents.defaults : {};
  const defaultSandbox = isRecord(defaults.sandbox) ? defaults.sandbox : {};
  const defaultTools = isRecord(cfg.tools) ? cfg.tools : {};
  const entries: PolicyAgentWorkspaceEvidence[] = [];
  pushAgentWorkspaceEvidence(entries, {
    id: "agents-defaults",
    scope: "defaults",
    sandbox: defaultSandbox,
    inheritedSandbox: {},
    tools: defaultTools,
    inheritedTools: {},
    workspaceSourceBase: "oc://openclaw.config/agents/defaults",
    inheritedWorkspaceSourceBase: "oc://openclaw.config/agents/defaults",
    toolsSourceBase: "oc://openclaw.config/tools",
    inheritedToolsSourceBase: "oc://openclaw.config/tools",
  });

  const list = Array.isArray(agents.list) ? agents.list : [];
  list.forEach((agent, index) => {
    if (!isRecord(agent)) {
      return;
    }
    const agentId =
      typeof agent.id === "string" && agent.id.trim() !== "" ? agent.id.trim() : undefined;
    const sandbox = isRecord(agent.sandbox) ? agent.sandbox : {};
    const tools = isRecord(agent.tools) ? agent.tools : {};
    pushAgentWorkspaceEvidence(entries, {
      id: agentId ?? `agent-${index}`,
      scope: "agent",
      agentId,
      sandbox,
      inheritedSandbox: defaultSandbox,
      tools,
      inheritedTools: defaultTools,
      workspaceSourceBase: `oc://openclaw.config/agents/list/#${index}`,
      inheritedWorkspaceSourceBase: "oc://openclaw.config/agents/defaults",
      toolsSourceBase: `oc://openclaw.config/agents/list/#${index}/tools`,
      inheritedToolsSourceBase: "oc://openclaw.config/tools",
    });
  });
  return entries.toSorted((a, b) => a.source.localeCompare(b.source) || a.id.localeCompare(b.id));
}

export function scanPolicySandboxPosture(
  cfg: Record<string, unknown>,
): readonly PolicySandboxPostureEvidence[] {
  const agents = isRecord(cfg.agents) ? cfg.agents : {};
  const defaults = isRecord(agents.defaults) ? agents.defaults : {};
  const defaultSandbox = isRecord(defaults.sandbox) ? defaults.sandbox : {};
  const entries: PolicySandboxPostureEvidence[] = [];
  pushSandboxPostureEvidence(entries, {
    id: "agents-defaults",
    scope: "defaults",
    sandbox: defaultSandbox,
    inheritedSandbox: {},
    sourceBase: "oc://openclaw.config/agents/defaults/sandbox",
    inheritedSourceBase: "oc://openclaw.config/agents/defaults/sandbox",
  });

  const list = Array.isArray(agents.list) ? agents.list : [];
  list.forEach((agent, index) => {
    if (!isRecord(agent)) {
      return;
    }
    const agentId =
      typeof agent.id === "string" && agent.id.trim() !== "" ? agent.id.trim() : undefined;
    const sandbox = isRecord(agent.sandbox) ? agent.sandbox : {};
    pushSandboxPostureEvidence(entries, {
      id: agentId ?? `agent-${index}`,
      scope: "agent",
      agentId,
      sandbox,
      inheritedSandbox: defaultSandbox,
      sharedSandboxScope: sandboxScopeIsShared(sandbox, defaultSandbox),
      sourceBase: `oc://openclaw.config/agents/list/#${index}/sandbox`,
      inheritedSourceBase: "oc://openclaw.config/agents/defaults/sandbox",
    });
  });

  return entries.toSorted((a, b) => a.source.localeCompare(b.source) || a.id.localeCompare(b.id));
}

export function scanPolicyToolPosture(
  cfg: Record<string, unknown>,
): readonly PolicyToolPostureEvidence[] {
  const globalTools = isRecord(cfg.tools) ? cfg.tools : {};
  const agents = isRecord(cfg.agents) ? cfg.agents : {};
  const defaults = isRecord(agents.defaults) ? agents.defaults : {};
  const defaultSandbox = isRecord(defaults.sandbox) ? defaults.sandbox : {};
  const entries: PolicyToolPostureEvidence[] = [];
  pushToolPostureEvidence(entries, {
    id: "tools",
    scope: "global",
    tools: globalTools,
    inheritedTools: {},
    sandbox: defaultSandbox,
    inheritedSandbox: {},
    sourceBase: "oc://openclaw.config/tools",
    inheritedSourceBase: "oc://openclaw.config/tools",
  });

  const list = Array.isArray(agents.list) ? agents.list : [];
  list.forEach((agent, index) => {
    if (!isRecord(agent)) {
      return;
    }
    const agentId =
      typeof agent.id === "string" && agent.id.trim() !== "" ? agent.id.trim() : undefined;
    pushToolPostureEvidence(entries, {
      id: agentId ?? `agent-${index}`,
      scope: "agent",
      agentId,
      tools: isRecord(agent.tools) ? agent.tools : {},
      inheritedTools: globalTools,
      sandbox: isRecord(agent.sandbox) ? agent.sandbox : {},
      inheritedSandbox: defaultSandbox,
      sourceBase: `oc://openclaw.config/agents/list/#${index}/tools`,
      inheritedSourceBase: "oc://openclaw.config/tools",
    });
  });

  return entries.toSorted((a, b) => a.source.localeCompare(b.source) || a.id.localeCompare(b.id));
}

export function scanPolicySecrets(cfg: Record<string, unknown>): readonly PolicySecretEvidence[] {
  return [...scanPolicySecretProviders(cfg), ...scanPolicySecretInputs(cfg)].toSorted((a, b) =>
    a.source.localeCompare(b.source),
  );
}

export function scanPolicyAuthProfiles(
  cfg: Record<string, unknown>,
): readonly PolicyAuthProfileEvidence[] {
  const auth = isRecord(cfg.auth) ? cfg.auth : {};
  const profiles = isRecord(auth.profiles) ? auth.profiles : {};
  return Object.entries(profiles)
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([id, value]) => {
      const entry: {
        id: string;
        source: string;
        validMetadata: boolean;
        provider?: string;
        mode?: string;
      } = {
        id,
        source: `oc://openclaw.config/auth/profiles/${ocPathSegment(id)}`,
        validMetadata: isValidAuthProfileMetadata(value),
      };
      if (isRecord(value)) {
        if (typeof value.provider === "string") {
          entry.provider = value.provider;
        }
        if (typeof value.mode === "string") {
          entry.mode = value.mode;
        }
      }
      return entry;
    });
}

export function scanPolicyDataHandling(
  cfg: Record<string, unknown>,
): readonly PolicyDataHandlingEvidence[] {
  const entries: PolicyDataHandlingEvidence[] = [];
  const logging = isRecord(cfg.logging) ? cfg.logging : {};
  entries.push({
    id: "logging-redaction",
    kind: "sensitiveLoggingRedaction",
    source: "oc://openclaw.config/logging/redactSensitive",
    scope: "global",
    value: logging.redactSensitive !== "off",
    explicit: logging.redactSensitive !== undefined,
  });

  const diagnostics = isRecord(cfg.diagnostics) ? cfg.diagnostics : {};
  const otel = isRecord(diagnostics.otel) ? diagnostics.otel : {};
  const otelEnabled = diagnostics.enabled !== false && otel.enabled === true;
  const tracesEnabled = otelEnabled && otel.traces !== false;
  const logsEnabled = otelEnabled && otel.logs === true;
  const captureContent =
    otelEnabled &&
    telemetryContentCaptureEnabled(otel.captureContent, {
      tracesEnabled,
      logsEnabled,
    });
  entries.push({
    id: "diagnostics-otel-content-capture",
    kind: "telemetryContentCapture",
    source: "oc://openclaw.config/diagnostics/otel/captureContent",
    scope: "global",
    value: captureContent,
    explicit: otel.captureContent !== undefined,
  });

  const session = isRecord(cfg.session) ? cfg.session : {};
  const maintenance = isRecord(session.maintenance) ? session.maintenance : {};
  const retentionMode = typeof maintenance.mode === "string" ? maintenance.mode : "enforce";
  entries.push({
    id: "session-maintenance-mode",
    kind: "sessionRetentionMode",
    source: "oc://openclaw.config/session/maintenance/mode",
    scope: "global",
    value: retentionMode,
    explicit: maintenance.mode !== undefined,
  });

  pushMemorySessionTranscriptIndexing(entries, cfg);
  return entries.toSorted((a, b) => a.source.localeCompare(b.source));
}

function telemetryContentCaptureEnabled(
  value: unknown,
  signals: { readonly tracesEnabled: boolean; readonly logsEnabled: boolean },
): boolean {
  if (value === true) {
    return signals.tracesEnabled || signals.logsEnabled;
  }
  if (!isRecord(value)) {
    return false;
  }
  if (!signals.tracesEnabled) {
    return false;
  }
  if (value.enabled !== true) {
    return false;
  }
  return (
    value.inputMessages === true ||
    value.outputMessages === true ||
    value.toolInputs === true ||
    value.toolOutputs === true ||
    value.systemPrompt === true ||
    value.toolDefinitions === true
  );
}

function pushMemorySessionTranscriptIndexing(
  entries: PolicyDataHandlingEvidence[],
  cfg: Record<string, unknown>,
): void {
  const memory = isRecord(cfg.memory) ? cfg.memory : {};
  const qmd = isRecord(memory.qmd) ? memory.qmd : {};
  const qmdSessions = isRecord(qmd.sessions) ? qmd.sessions : {};
  if (qmdSessions.enabled !== undefined) {
    entries.push({
      id: "memory-qmd-session-transcripts",
      kind: "memorySessionTranscriptIndexing",
      source: "oc://openclaw.config/memory/qmd/sessions/enabled",
      scope: "global",
      value: memory.backend === "qmd" && readBoolean(qmdSessions.enabled) === true,
      explicit: true,
    });
  }

  const agents = isRecord(cfg.agents) ? cfg.agents : {};
  const defaults = isRecord(agents.defaults) ? agents.defaults : {};
  const defaultsMemorySearch = isRecord(defaults.memorySearch) ? defaults.memorySearch : {};
  const defaultSessionMemory = memorySearchSessionTranscriptIndexing(defaultsMemorySearch);
  if (defaultSessionMemory !== undefined) {
    entries.push({
      id: "agents-defaults-memory-session-transcripts",
      kind: "memorySessionTranscriptIndexing",
      source: "oc://openclaw.config/agents/defaults/memorySearch/experimental/sessionMemory",
      scope: "global",
      value: defaultSessionMemory,
      explicit: true,
    });
  }

  if (!Array.isArray(agents.list)) {
    return;
  }
  agents.list.forEach((rawAgent, index) => {
    if (!isRecord(rawAgent)) {
      return;
    }
    const agentId =
      readString(rawAgent.id) ??
      readString(rawAgent.name) ??
      readString(rawAgent.slug) ??
      `agent-${index}`;
    const memorySearch = isRecord(rawAgent.memorySearch) ? rawAgent.memorySearch : undefined;
    const agentSessionMemory =
      memorySearch === undefined
        ? defaultSessionMemory
        : memorySearchSessionTranscriptIndexing(memorySearch, defaultsMemorySearch);
    if (agentSessionMemory === undefined) {
      return;
    }
    const explicit = memorySearchSessionTranscriptIndexingHasLocalConfig(memorySearch);
    entries.push({
      id: `${agentId}-memory-session-transcripts`,
      kind: "memorySessionTranscriptIndexing",
      source: explicit
        ? `oc://openclaw.config/agents/list/#${index}/memorySearch/experimental/sessionMemory`
        : "oc://openclaw.config/agents/defaults/memorySearch/experimental/sessionMemory",
      scope: "agent",
      agentId: normalizeAgentId(agentId),
      value: agentSessionMemory,
      explicit,
    });
  });
}

function memorySearchSessionTranscriptIndexing(
  memorySearch: unknown,
  inheritedMemorySearch?: unknown,
): boolean | undefined {
  if (!isRecord(memorySearch)) {
    return undefined;
  }
  const experimental = isRecord(memorySearch.experimental) ? memorySearch.experimental : {};
  const inherited = isRecord(inheritedMemorySearch) ? inheritedMemorySearch : {};
  const inheritedExperimental = isRecord(inherited.experimental) ? inherited.experimental : {};
  const enabled = readBoolean(memorySearch.enabled) ?? readBoolean(inherited.enabled) ?? true;
  const sessionMemory =
    readBoolean(experimental.sessionMemory) ?? readBoolean(inheritedExperimental.sessionMemory);
  const sourcesIncludeSessions =
    memorySearchSourcesIncludeSessions(memorySearch) ??
    memorySearchSourcesIncludeSessions(inherited) ??
    false;
  if (
    sessionMemory === undefined &&
    memorySearchSourcesIncludeSessions(memorySearch) === undefined &&
    readBoolean(memorySearch.enabled) === undefined
  ) {
    return undefined;
  }
  if (!enabled) {
    return false;
  }
  return sessionMemory === true && sourcesIncludeSessions;
}

function memorySearchSessionTranscriptIndexingHasLocalConfig(memorySearch: unknown): boolean {
  if (!isRecord(memorySearch)) {
    return false;
  }
  const experimental = isRecord(memorySearch.experimental) ? memorySearch.experimental : {};
  return (
    readBoolean(memorySearch.enabled) !== undefined ||
    readBoolean(experimental.sessionMemory) !== undefined ||
    memorySearchSourcesIncludeSessions(memorySearch) !== undefined
  );
}

function memorySearchSourcesIncludeSessions(memorySearch: unknown): boolean | undefined {
  if (!isRecord(memorySearch) || memorySearch.sources === undefined) {
    return undefined;
  }
  if (!Array.isArray(memorySearch.sources)) {
    return false;
  }
  return memorySearch.sources.includes("sessions");
}

function scanPolicySecretProviders(cfg: Record<string, unknown>): readonly PolicySecretEvidence[] {
  const secrets = isRecord(cfg.secrets) ? cfg.secrets : {};
  const providers = isRecord(secrets.providers) ? secrets.providers : {};
  return Object.entries(providers).map(([id, value]) => {
    const insecure = secretProviderInsecureFlags(value);
    const entry: {
      id: string;
      kind: "provider";
      source: string;
      providerSource?: string;
      insecure?: readonly string[];
    } = {
      id,
      kind: "provider",
      source: `oc://openclaw.config/secrets/providers/${ocPathSegment(id)}`,
    };
    if (isRecord(value) && typeof value.source === "string") {
      entry.providerSource = value.source;
    }
    if (insecure.length > 0) {
      entry.insecure = insecure;
    }
    return entry;
  });
}

function scanPolicySecretInputs(cfg: Record<string, unknown>): readonly PolicySecretEvidence[] {
  const entries: PolicySecretEvidence[] = [];
  const secrets = isRecord(cfg.secrets) ? cfg.secrets : {};
  collectSecretInputs(entries, cfg, [], secretRefDefaults(secrets.defaults));
  return entries;
}

function collectSecretInputs(
  entries: PolicySecretEvidence[],
  value: unknown,
  path: readonly string[],
  defaults: SecretRefDefaults | undefined,
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectSecretInputs(entries, item, [...path, `#${index}`], defaults),
    );
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const childPath = [...path, key];
    const source = configPathSource(childPath);
    const secretInputPath = isSecretInputPath(childPath);
    const ref = secretInputPath ? secretRefEvidence(child, defaults) : undefined;
    if (ref !== undefined) {
      entries.push({
        id: source,
        kind: "input",
        source,
        provenance: "secretRef",
        refSource: ref.source,
        refProvider: ref.provider,
      });
      continue;
    }
    collectSecretInputs(entries, child, childPath, defaults);
  }
}

function configPathSource(path: readonly string[]): string {
  return `oc://openclaw.config/${path.map(ocPathSegment).join("/")}`;
}

function isSecretInputPath(path: readonly string[]): boolean {
  const key = path.at(-1);
  if (key === undefined) {
    return false;
  }
  if (
    matchesConfigPath(path, ["plugins", "entries", "acpx", "config", "mcpServers", "*", "env", "*"])
  ) {
    return true;
  }
  if (isRawEnvMapValuePath(path)) {
    return false;
  }
  if (isSecretInputKey(key)) {
    return true;
  }
  return (
    matchesConfigPath(path, ["models", "providers", "*", "headers", "*"]) ||
    isConfiguredProviderRequestSecretPath(path, ["models", "providers", "*"]) ||
    isMediaConfiguredProviderRequestSecretPath(path) ||
    matchesConfigPath(path, ["agents", "defaults", "memorySearch", "remote", "headers", "*"]) ||
    matchesConfigPath(path, ["diagnostics", "otel", "headers", "*"])
  );
}

function isRawEnvMapValuePath(path: readonly string[]): boolean {
  return path.length >= 2 && path.at(-2) === "env";
}

function isMediaConfiguredProviderRequestSecretPath(path: readonly string[]): boolean {
  return (
    isConfiguredProviderRequestSecretPath(path, ["tools", "media", "models", "#"]) ||
    isConfiguredProviderRequestSecretPath(path, ["tools", "media", "audio"]) ||
    isConfiguredProviderRequestSecretPath(path, ["tools", "media", "audio", "models", "#"]) ||
    isConfiguredProviderRequestSecretPath(path, ["tools", "media", "image"]) ||
    isConfiguredProviderRequestSecretPath(path, ["tools", "media", "image", "models", "#"]) ||
    isConfiguredProviderRequestSecretPath(path, ["tools", "media", "video"]) ||
    isConfiguredProviderRequestSecretPath(path, ["tools", "media", "video", "models", "#"])
  );
}

function pushAgentWorkspaceEvidence(
  entries: PolicyAgentWorkspaceEvidence[],
  params: {
    readonly id: string;
    readonly scope: "defaults" | "agent";
    readonly agentId?: string;
    readonly sandbox: Record<string, unknown>;
    readonly inheritedSandbox: Record<string, unknown>;
    readonly tools: Record<string, unknown>;
    readonly inheritedTools: Record<string, unknown>;
    readonly workspaceSourceBase: string;
    readonly inheritedWorkspaceSourceBase: string;
    readonly toolsSourceBase: string;
    readonly inheritedToolsSourceBase: string;
  },
): void {
  const explicitSandboxMode = readString(params.sandbox.mode);
  const inheritedSandboxMode = readString(params.inheritedSandbox.mode);
  const sandboxMode = explicitSandboxMode ?? inheritedSandboxMode ?? "off";
  const sandboxModeCoversAgentMain = sandboxMode === "all";
  const sandboxModeSource =
    explicitSandboxMode !== undefined
      ? `${params.workspaceSourceBase}/sandbox/mode`
      : inheritedSandboxMode !== undefined
        ? `${params.inheritedWorkspaceSourceBase}/sandbox/mode`
        : "oc://openclaw.config/agents/defaults/sandbox/mode";
  const explicitWorkspaceAccess = readString(params.sandbox.workspaceAccess);
  const inheritedWorkspaceAccess = readString(params.inheritedSandbox.workspaceAccess);
  entries.push({
    id: `${params.id}-workspace-access`,
    kind: "workspaceAccess",
    source:
      explicitWorkspaceAccess !== undefined
        ? `${params.workspaceSourceBase}/sandbox/workspaceAccess`
        : inheritedWorkspaceAccess !== undefined
          ? `${params.inheritedWorkspaceSourceBase}/sandbox/workspaceAccess`
          : "oc://openclaw.config/agents/defaults/sandbox/workspaceAccess",
    scope: params.scope,
    ...(params.agentId === undefined ? {} : { agentId: params.agentId }),
    value: explicitWorkspaceAccess ?? inheritedWorkspaceAccess ?? "none",
    sandboxMode,
    sandboxModeSource,
    sandboxEnabled: sandboxModeCoversAgentMain,
    explicit: explicitWorkspaceAccess !== undefined,
  });

  for (const tool of AGENT_WORKSPACE_POLICY_TOOLS) {
    const denyEvidence = agentWorkspaceToolDenyEvidence(params, tool, sandboxModeCoversAgentMain);
    entries.push({
      id: `${params.id}-tool-${tool}`,
      kind: "toolDeny",
      source: denyEvidence.source,
      scope: params.scope,
      ...(params.agentId === undefined ? {} : { agentId: params.agentId }),
      tool,
      denied: denyEvidence.denied,
      explicit: denyEvidence.denied,
    });
  }
}

function agentWorkspaceToolDenyEvidence(
  params: {
    readonly tools: Record<string, unknown>;
    readonly inheritedTools: Record<string, unknown>;
    readonly toolsSourceBase: string;
    readonly inheritedToolsSourceBase: string;
  },
  tool: string,
  sandboxModeCoversAgentMain: boolean,
): { readonly denied: boolean; readonly source: string } {
  const localSandboxToolDeny = configuredSandboxToolDenyEntries(params.tools);
  const inheritedSandboxToolDeny = configuredSandboxToolDenyEntries(params.inheritedTools);
  const sources = [
    {
      entries: readStringArray(params.tools.deny),
      source: `${params.toolsSourceBase}/deny`,
    },
    {
      entries: readStringArray(params.inheritedTools.deny),
      source: `${params.inheritedToolsSourceBase}/deny`,
    },
    ...(sandboxModeCoversAgentMain
      ? [
          localSandboxToolDeny !== undefined
            ? {
                entries: localSandboxToolDeny,
                source: `${params.toolsSourceBase}/sandbox/tools/deny`,
              }
            : {
                entries: inheritedSandboxToolDeny ?? [],
                source: `${params.inheritedToolsSourceBase}/sandbox/tools/deny`,
              },
        ]
      : []),
  ];
  const match = sources.find((entry) => toolListCoversTool(entry.entries, tool));
  if (match !== undefined) {
    return { denied: true, source: match.source };
  }
  return { denied: false, source: `${params.toolsSourceBase}/deny` };
}

function configuredSandboxToolDenyEntries(
  tools: Record<string, unknown>,
): readonly string[] | undefined {
  const sandbox = isRecord(tools.sandbox) ? tools.sandbox : {};
  const sandboxTools = isRecord(sandbox.tools) ? sandbox.tools : {};
  return Array.isArray(sandboxTools.deny) ? readStringArray(sandboxTools.deny) : undefined;
}

function pushToolPostureEvidence(
  entries: PolicyToolPostureEvidence[],
  params: {
    readonly id: string;
    readonly scope: "global" | "agent";
    readonly agentId?: string;
    readonly tools: Record<string, unknown>;
    readonly inheritedTools: Record<string, unknown>;
    readonly sandbox: Record<string, unknown>;
    readonly inheritedSandbox: Record<string, unknown>;
    readonly sourceBase: string;
    readonly inheritedSourceBase: string;
  },
): void {
  const localProfile = readString(params.tools.profile);
  const inheritedProfile = readString(params.inheritedTools.profile);
  pushToolPostureValue(entries, params, {
    suffix: "profile",
    kind: "profile",
    value: localProfile ?? inheritedProfile ?? "full",
    explicit: localProfile !== undefined || inheritedProfile !== undefined,
    inherited: localProfile === undefined && inheritedProfile !== undefined,
  });

  pushToolPostureList(entries, params, "allow");
  pushToolAlsoAllowPostureList(entries, params);
  pushToolPostureList(entries, params, "deny");
  pushToolFsPosture(entries, params);
  pushToolExecPosture(entries, params);
  pushToolElevatedPosture(entries, params);
}

function pushToolFsPosture(entries: PolicyToolPostureEvidence[], params: ToolPostureParams): void {
  const localFs = isRecord(params.tools.fs) ? params.tools.fs : {};
  const inheritedFs = isRecord(params.inheritedTools.fs) ? params.inheritedTools.fs : {};
  const localWorkspaceOnly = readBoolean(localFs.workspaceOnly);
  const inheritedWorkspaceOnly = readBoolean(inheritedFs.workspaceOnly);
  pushToolPostureValue(entries, params, {
    suffix: "fs/workspaceOnly",
    kind: "fsWorkspaceOnly",
    value: localWorkspaceOnly ?? inheritedWorkspaceOnly ?? false,
    explicit: localWorkspaceOnly !== undefined || inheritedWorkspaceOnly !== undefined,
    inherited: localWorkspaceOnly === undefined && inheritedWorkspaceOnly !== undefined,
  });
}

function pushToolExecPosture(
  entries: PolicyToolPostureEvidence[],
  params: ToolPostureParams,
): void {
  const localExec = isRecord(params.tools.exec) ? params.tools.exec : {};
  const inheritedExec = isRecord(params.inheritedTools.exec) ? params.inheritedTools.exec : {};
  const localHost = readString(localExec.host);
  const inheritedHost = readString(inheritedExec.host);
  const host = localHost ?? inheritedHost ?? "auto";
  pushToolPostureValue(entries, params, {
    suffix: "exec/host",
    kind: "execHost",
    value: host,
    explicit: localHost !== undefined || inheritedHost !== undefined,
    inherited: localHost === undefined && inheritedHost !== undefined,
  });

  const localSecurity = readString(localExec.security);
  const inheritedSecurity = readString(inheritedExec.security);
  // Config conformance intentionally ignores exec-approvals.json runtime/operator state.
  const sandboxMode = readString(params.sandbox.mode) ?? readString(params.inheritedSandbox.mode);
  const sandboxCanApply = sandboxMode === "all";
  pushToolPostureValue(entries, params, {
    suffix: "exec/security",
    kind: "execSecurity",
    value:
      localSecurity ??
      inheritedSecurity ??
      (host === "sandbox" || (host === "auto" && sandboxCanApply) ? "deny" : "full"),
    explicit: localSecurity !== undefined || inheritedSecurity !== undefined,
    inherited: localSecurity === undefined && inheritedSecurity !== undefined,
  });

  const localAsk = readString(localExec.ask);
  const inheritedAsk = readString(inheritedExec.ask);
  pushToolPostureValue(entries, params, {
    suffix: "exec/ask",
    kind: "execAsk",
    value: localAsk ?? inheritedAsk ?? "off",
    explicit: localAsk !== undefined || inheritedAsk !== undefined,
    inherited: localAsk === undefined && inheritedAsk !== undefined,
  });
}

function pushToolElevatedPosture(
  entries: PolicyToolPostureEvidence[],
  params: ToolPostureParams,
): void {
  const localElevated = isRecord(params.tools.elevated) ? params.tools.elevated : {};
  const inheritedElevated = isRecord(params.inheritedTools.elevated)
    ? params.inheritedTools.elevated
    : {};
  const localEnabled = readBoolean(localElevated.enabled);
  const inheritedEnabled = readBoolean(inheritedElevated.enabled);
  const effectiveEnabled =
    inheritedEnabled === false ? false : (localEnabled ?? inheritedEnabled ?? true);
  pushToolPostureValue(entries, params, {
    suffix: "elevated/enabled",
    kind: "elevatedEnabled",
    value: effectiveEnabled,
    explicit: localEnabled !== undefined || inheritedEnabled !== undefined,
    inherited:
      (inheritedEnabled === false && localEnabled !== false) ||
      (localEnabled === undefined && inheritedEnabled !== undefined),
  });

  const localAllowFrom = isRecord(localElevated.allowFrom) ? localElevated.allowFrom : {};
  const inheritedAllowFrom = isRecord(inheritedElevated.allowFrom)
    ? inheritedElevated.allowFrom
    : {};
  const providers = [
    ...new Set([...Object.keys(inheritedAllowFrom), ...Object.keys(localAllowFrom)]),
  ].toSorted((a, b) => a.localeCompare(b));
  for (const provider of providers) {
    const localEntries = readStringOrNumberArray(localAllowFrom[provider]);
    const inheritedEntries = readStringOrNumberArray(inheritedAllowFrom[provider]);
    const inherited = localEntries.length === 0 && inheritedEntries.length > 0;
    entries.push({
      id: `${params.id}-elevated-allow-from-${ocPathSegment(provider)}`,
      kind: "elevatedAllowFrom",
      source: `${inherited ? params.inheritedSourceBase : params.sourceBase}/elevated/allowFrom/${ocPathSegment(provider)}`,
      scope: params.scope,
      ...(params.agentId === undefined ? {} : { agentId: params.agentId }),
      entries: localEntries.length > 0 ? localEntries : inheritedEntries,
      explicit: localEntries.length > 0 || inheritedEntries.length > 0,
    });
  }
}

type SandboxPostureParams = {
  readonly id: string;
  readonly scope: "defaults" | "agent";
  readonly agentId?: string;
  readonly effectiveBackend?: string;
  readonly sandbox: Record<string, unknown>;
  readonly inheritedSandbox: Record<string, unknown>;
  readonly sharedSandboxScope?: boolean;
  readonly sourceBase: string;
  readonly inheritedSourceBase: string;
};

function pushSandboxPostureEvidence(
  entries: PolicySandboxPostureEvidence[],
  params: SandboxPostureParams,
): void {
  const localMode = readString(params.sandbox.mode);
  const inheritedMode = readString(params.inheritedSandbox.mode);
  pushSandboxPostureValue(entries, params, {
    suffix: "mode",
    kind: "mode",
    value: localMode ?? inheritedMode ?? "off",
    explicit: localMode !== undefined || inheritedMode !== undefined,
    inherited: localMode === undefined && inheritedMode !== undefined,
  });

  const localBackend = readString(params.sandbox.backend);
  const inheritedBackend = readString(params.inheritedSandbox.backend);
  const effectiveBackend = (localBackend ?? inheritedBackend ?? "docker").toLowerCase();
  const effectiveParams = { ...params, effectiveBackend };
  pushSandboxPostureValue(entries, params, {
    suffix: "backend",
    kind: "backend",
    value: effectiveBackend,
    explicit: localBackend !== undefined || inheritedBackend !== undefined,
    inherited: localBackend === undefined && inheritedBackend !== undefined,
  });

  if (effectiveBackend === "docker") {
    pushSandboxDockerPosture(entries, effectiveParams);
  }
  pushSandboxBrowserPosture(entries, effectiveParams);
}

function pushSandboxDockerPosture(
  entries: PolicySandboxPostureEvidence[],
  params: SandboxPostureParams,
): void {
  const localDocker =
    !params.sharedSandboxScope && isRecord(params.sandbox.docker) ? params.sandbox.docker : {};
  const inheritedDocker = isRecord(params.inheritedSandbox.docker)
    ? params.inheritedSandbox.docker
    : {};
  const localNetwork = readString(localDocker.network);
  const inheritedNetwork = readString(inheritedDocker.network);
  pushSandboxPostureValue(entries, params, {
    suffix: "docker/network",
    kind: "containerNetwork",
    value: localNetwork ?? inheritedNetwork ?? "none",
    networkSurface: "docker",
    explicit: localNetwork !== undefined || inheritedNetwork !== undefined,
    inherited: localNetwork === undefined && inheritedNetwork !== undefined,
  });

  pushSandboxDockerProfilePosture(entries, params, localDocker, inheritedDocker, "seccomp");
  pushSandboxDockerProfilePosture(entries, params, localDocker, inheritedDocker, "apparmor");

  pushSandboxBindPosture(entries, params, {
    inheritedBinds: readStringArray(inheritedDocker.binds),
    localBinds: readStringArray(localDocker.binds),
    sourceSuffix: "docker/binds",
    surface: "docker",
  });
}

function pushSandboxBindPosture(
  entries: PolicySandboxPostureEvidence[],
  params: SandboxPostureParams,
  bindParams: {
    readonly inheritedBinds: readonly string[];
    readonly localBinds: readonly string[];
    readonly sourceSuffix: string;
    readonly surface: "browser" | "docker";
  },
): void {
  const { inheritedBinds, localBinds } = bindParams;
  for (const [index, bind] of [...inheritedBinds, ...localBinds].entries()) {
    const inherited = index < inheritedBinds.length;
    const parsed = splitPolicyBindSpec(bind);
    entries.push({
      id: `${params.id}-${bindParams.surface}-bind-${index}`,
      kind: "containerMount",
      source: `${inherited ? params.inheritedSourceBase : params.sourceBase}/${bindParams.sourceSuffix}/#${
        inherited ? index : index - inheritedBinds.length
      }`,
      scope: params.scope,
      ...(params.agentId === undefined ? {} : { agentId: params.agentId }),
      bind,
      bindHost: parsed?.host,
      bindMode: parsed?.mode ?? "rw",
      bindSurface: bindParams.surface,
      explicit: true,
    });
  }
}

function pushSandboxDockerProfilePosture(
  entries: PolicySandboxPostureEvidence[],
  params: SandboxPostureParams,
  localDocker: Record<string, unknown>,
  inheritedDocker: Record<string, unknown>,
  profile: "apparmor" | "seccomp",
): void {
  const key = profile === "apparmor" ? "apparmorProfile" : "seccompProfile";
  const localValue = readString(localDocker[key]);
  const inheritedValue = readString(inheritedDocker[key]);
  const inherited = localValue === undefined && inheritedValue !== undefined;
  const value = localValue ?? inheritedValue;
  entries.push({
    id: `${params.id}-docker-${profile}-profile`,
    kind: "containerSecurityProfile",
    source: `${inherited ? params.inheritedSourceBase : params.sourceBase}/docker/${key}`,
    scope: params.scope,
    ...(params.agentId === undefined ? {} : { agentId: params.agentId }),
    profile,
    ...(value === undefined ? {} : { value }),
    explicit: value !== undefined,
  });
}

function pushSandboxBrowserPosture(
  entries: PolicySandboxPostureEvidence[],
  params: SandboxPostureParams,
): void {
  const localBrowser =
    !params.sharedSandboxScope && isRecord(params.sandbox.browser) ? params.sandbox.browser : {};
  const inheritedBrowser = isRecord(params.inheritedSandbox.browser)
    ? params.inheritedSandbox.browser
    : {};
  const localEnabled = readBoolean(localBrowser.enabled);
  const inheritedEnabled = readBoolean(inheritedBrowser.enabled);
  const enabled = localEnabled ?? inheritedEnabled ?? false;
  if (!enabled) {
    const disabledInherited = localEnabled === undefined && inheritedEnabled !== undefined;
    if (localEnabled !== undefined || inheritedEnabled !== undefined) {
      entries.push({
        id: `${params.id}-browser-cdp-source-range`,
        kind: "browserCdpSourceRange",
        source: `${disabledInherited ? params.inheritedSourceBase : params.sourceBase}/browser/enabled`,
        scope: params.scope,
        ...(params.agentId === undefined ? {} : { agentId: params.agentId }),
        value: false,
        explicit: true,
      });
    }
    return;
  }
  const hasLocalRange = Object.hasOwn(localBrowser, "cdpSourceRange");
  const localRange = readString(localBrowser.cdpSourceRange);
  const inheritedRange = readString(inheritedBrowser.cdpSourceRange);
  const inherited = !hasLocalRange && inheritedRange !== undefined;
  const value = hasLocalRange ? localRange : inheritedRange;
  entries.push({
    id: `${params.id}-browser-cdp-source-range`,
    kind: "browserCdpSourceRange",
    source: `${inherited ? params.inheritedSourceBase : params.sourceBase}/browser/cdpSourceRange`,
    scope: params.scope,
    ...(params.agentId === undefined ? {} : { agentId: params.agentId }),
    ...(value === undefined ? {} : { value }),
    explicit: value !== undefined,
  });

  const localNetwork = readString(localBrowser.network);
  const inheritedNetwork = readString(inheritedBrowser.network);
  pushSandboxPostureValue(entries, params, {
    suffix: "browser/network",
    kind: "containerNetwork",
    value: localNetwork ?? inheritedNetwork ?? DEFAULT_POLICY_SANDBOX_BROWSER_NETWORK,
    networkSurface: "browser",
    explicit: localNetwork !== undefined || inheritedNetwork !== undefined,
    inherited: localNetwork === undefined && inheritedNetwork !== undefined,
  });

  const browserBindsConfigured =
    inheritedBrowser.binds !== undefined || localBrowser.binds !== undefined;
  if (browserBindsConfigured) {
    pushSandboxBindPosture(entries, params, {
      inheritedBinds: readStringArray(inheritedBrowser.binds),
      localBinds: readStringArray(localBrowser.binds),
      sourceSuffix: "browser/binds",
      surface: "browser",
    });
  } else if (params.effectiveBackend !== "docker") {
    const localDocker =
      !params.sharedSandboxScope && isRecord(params.sandbox.docker) ? params.sandbox.docker : {};
    const inheritedDocker = isRecord(params.inheritedSandbox.docker)
      ? params.inheritedSandbox.docker
      : {};
    pushSandboxBindPosture(entries, params, {
      inheritedBinds: readStringArray(inheritedDocker.binds),
      localBinds: readStringArray(localDocker.binds),
      sourceSuffix: "docker/binds",
      surface: "browser",
    });
  }
}

function sandboxScopeIsShared(
  sandbox: Record<string, unknown>,
  inheritedSandbox: Record<string, unknown>,
): boolean {
  const localScope = readString(sandbox.scope);
  const inheritedScope = readString(inheritedSandbox.scope);
  const configuredScope = localScope ?? inheritedScope;
  if (configuredScope !== undefined) {
    return configuredScope === "shared";
  }
  const localPerSession = readBoolean(sandbox.perSession);
  const inheritedPerSession = readBoolean(inheritedSandbox.perSession);
  return (localPerSession ?? inheritedPerSession) === false;
}

function pushSandboxPostureValue(
  entries: PolicySandboxPostureEvidence[],
  params: SandboxPostureParams,
  entry: {
    readonly suffix: string;
    readonly kind: PolicySandboxPostureEvidence["kind"];
    readonly value: string | undefined;
    readonly networkSurface?: "browser" | "docker";
    readonly explicit: boolean;
    readonly inherited: boolean;
  },
): void {
  entries.push({
    id: `${params.id}-${entry.suffix.replaceAll("/", "-")}`,
    kind: entry.kind,
    source: `${entry.inherited ? params.inheritedSourceBase : params.sourceBase}/${entry.suffix}`,
    scope: params.scope,
    ...(params.agentId === undefined ? {} : { agentId: params.agentId }),
    ...(entry.value === undefined ? {} : { value: entry.value }),
    ...(entry.networkSurface === undefined ? {} : { networkSurface: entry.networkSurface }),
    explicit: entry.explicit,
  });
}

function splitPolicyBindSpec(
  value: string,
): { readonly host: string; readonly mode: string } | undefined {
  const separator = policyBindSeparatorIndex(value);
  if (separator < 0) {
    return undefined;
  }
  const host = value.slice(0, separator);
  const rest = value.slice(separator + 1);
  const optionsStart = policyBindOptionsSeparatorIndex(rest);
  const options = optionsStart < 0 ? "" : rest.slice(optionsStart + 1);
  const mode = options
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .includes("ro")
    ? "ro"
    : "rw";
  return { host, mode };
}

function policyBindSeparatorIndex(value: string): number {
  const hasDriveLetterPrefix = /^[A-Za-z]:[\\/]/.test(value);
  for (let index = hasDriveLetterPrefix ? 2 : 0; index < value.length; index += 1) {
    if (value[index] === ":") {
      return index;
    }
  }
  return -1;
}

function policyBindOptionsSeparatorIndex(value: string): number {
  const hasDriveLetterPrefix = /^[A-Za-z]:[\\/]/.test(value);
  for (let index = hasDriveLetterPrefix ? 2 : 0; index < value.length; index += 1) {
    if (value[index] === ":") {
      return index;
    }
  }
  return -1;
}

type ToolPostureParams = {
  readonly id: string;
  readonly scope: "global" | "agent";
  readonly agentId?: string;
  readonly tools: Record<string, unknown>;
  readonly inheritedTools: Record<string, unknown>;
  readonly sandbox: Record<string, unknown>;
  readonly inheritedSandbox: Record<string, unknown>;
  readonly sourceBase: string;
  readonly inheritedSourceBase: string;
};

function pushToolPostureValue(
  entries: PolicyToolPostureEvidence[],
  params: ToolPostureParams,
  entry: {
    readonly suffix: string;
    readonly kind: PolicyToolPostureEvidence["kind"];
    readonly value: boolean | string | undefined;
    readonly explicit: boolean;
    readonly inherited: boolean;
  },
): void {
  entries.push({
    id: `${params.id}-${entry.suffix.replaceAll("/", "-")}`,
    kind: entry.kind,
    source: `${entry.inherited ? params.inheritedSourceBase : params.sourceBase}/${entry.suffix}`,
    scope: params.scope,
    ...(params.agentId === undefined ? {} : { agentId: params.agentId }),
    ...(entry.value === undefined ? {} : { value: entry.value }),
    explicit: entry.explicit,
  });
}

function pushToolPostureList(
  entries: PolicyToolPostureEvidence[],
  params: ToolPostureParams,
  key: "allow" | "deny",
): void {
  const localEntries = readStringArray(params.tools[key]);
  const inheritedEntries = readStringArray(params.inheritedTools[key]);
  const inherited = localEntries.length === 0 && inheritedEntries.length > 0;
  entries.push({
    id: `${params.id}-${key}`,
    kind: key,
    source: `${inherited ? params.inheritedSourceBase : params.sourceBase}/${key}`,
    scope: params.scope,
    ...(params.agentId === undefined ? {} : { agentId: params.agentId }),
    entries: [...inheritedEntries, ...localEntries],
    explicit: localEntries.length > 0 || inheritedEntries.length > 0,
  });
}

function pushToolAlsoAllowPostureList(
  entries: PolicyToolPostureEvidence[],
  params: ToolPostureParams,
): void {
  const localValue = params.tools.alsoAllow;
  const inheritedValue = params.inheritedTools.alsoAllow;
  const localConfigured = Array.isArray(localValue);
  const inheritedConfigured = Array.isArray(inheritedValue);
  const localEntries = localConfigured ? readStringArray(localValue) : [];
  const inheritedEntries = inheritedConfigured ? readStringArray(inheritedValue) : [];
  const inherited = !localConfigured && inheritedConfigured;
  entries.push({
    id: `${params.id}-alsoAllow`,
    kind: "alsoAllow",
    source: `${inherited ? params.inheritedSourceBase : params.sourceBase}/alsoAllow`,
    scope: params.scope,
    ...(params.agentId === undefined ? {} : { agentId: params.agentId }),
    entries: inherited ? inheritedEntries : localEntries,
    explicit: localConfigured || inheritedConfigured,
  });
}

const AGENT_WORKSPACE_POLICY_TOOLS = ["exec", "process", "write", "edit", "apply_patch"] as const;
const IMPLICIT_DEFAULT_ACCOUNT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  discord: ["token"],
  googlechat: ["serviceAccount", "serviceAccountRef", "serviceAccountFile"],
  imessage: ["cliPath", "dbPath"],
  "qa-channel": ["baseUrl"],
  qqbot: ["appId", "clientSecret", "clientSecretFile"],
  signal: ["account"],
  slack: ["appToken", "botToken", "signingSecret"],
  "synology-chat": ["token"],
  telegram: ["botToken", "tokenFile"],
  tlon: ["ship"],
  twitch: ["username"],
  whatsapp: ["authDir"],
  zalo: ["botToken", "tokenFile"],
  zalouser: ["profile"],
};

function readStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
}

function readStringOrNumberArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const entries: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry.trim() !== "") {
      entries.push(entry.trim());
    } else if (typeof entry === "number" && Number.isFinite(entry)) {
      entries.push(String(entry));
    }
  }
  return entries;
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

function isConfiguredProviderRequestSecretPath(
  path: readonly string[],
  prefix: readonly string[],
): boolean {
  if (path.length < prefix.length + 3) {
    return false;
  }
  if (!matchesConfigPathPrefix(path, prefix)) {
    return false;
  }
  const requestIndex = prefix.length;
  if (path[requestIndex] !== "request") {
    return false;
  }
  const suffix = path.slice(requestIndex + 1);
  if (suffix.length === 2 && suffix[0] === "headers") {
    return true;
  }
  if (suffix.length === 2 && suffix[0] === "auth" && isConfiguredProviderAuthSecretKey(suffix[1])) {
    return true;
  }
  if (suffix.length === 2 && suffix[0] === "tls" && isConfiguredProviderTlsSecretKey(suffix[1])) {
    return true;
  }
  return (
    suffix.length === 3 &&
    suffix[0] === "proxy" &&
    suffix[1] === "tls" &&
    isConfiguredProviderTlsSecretKey(suffix[2])
  );
}

function matchesConfigPathPrefix(path: readonly string[], prefix: readonly string[]): boolean {
  if (path.length < prefix.length) {
    return false;
  }
  return prefix.every((segment, index) => {
    const value = path[index];
    if (segment === "*") {
      return value !== undefined && value !== "";
    }
    if (segment === "#") {
      return value?.startsWith("#") ?? false;
    }
    return value === segment;
  });
}

function matchesConfigPath(path: readonly string[], pattern: readonly string[]): boolean {
  return path.length === pattern.length && matchesConfigPathPrefix(path, pattern);
}

function isConfiguredProviderTlsSecretKey(key: string | undefined): boolean {
  return key === "ca" || key === "cert" || key === "key" || key === "passphrase";
}

function isConfiguredProviderAuthSecretKey(key: string | undefined): boolean {
  return key === "token" || key === "value";
}

function isSecretInputKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return (
    normalized === "apikey" ||
    normalized === "keyref" ||
    normalized === "token" ||
    normalized === "tokenref" ||
    normalized === "password" ||
    normalized === "secret" ||
    normalized === "encryptkey" ||
    normalized === "webhooksecret" ||
    normalized === "serviceaccount" ||
    normalized === "serviceaccountref" ||
    normalized === "privatekey" ||
    normalized === "certificate" ||
    normalized === "certificatedata" ||
    normalized === "identitydata" ||
    normalized === "knownhosts" ||
    normalized === "knownhostsdata" ||
    normalized.endsWith("apikey") ||
    normalized.endsWith("token") ||
    normalized.endsWith("secret") ||
    normalized.endsWith("password")
  );
}

function secretRefDefaults(value: unknown): SecretRefDefaults | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const defaults: SecretRefDefaults = {};
  if (typeof value.env === "string") {
    defaults.env = value.env;
  }
  if (typeof value.file === "string") {
    defaults.file = value.file;
  }
  if (typeof value.exec === "string") {
    defaults.exec = value.exec;
  }
  return defaults;
}

function secretRefEvidence(
  value: unknown,
  defaults: SecretRefDefaults | undefined,
): SecretRefEvidence | undefined {
  const ref = coerceSecretRef(value, defaults);
  return ref === null ? undefined : { source: ref.source, provider: ref.provider, id: ref.id };
}

function secretProviderInsecureFlags(value: unknown): readonly string[] {
  if (!isRecord(value)) {
    return [];
  }
  return [
    ...(value.allowInsecurePath === true ? ["allowInsecurePath"] : []),
    ...(value.allowSymlinkCommand === true ? ["allowSymlinkCommand"] : []),
  ];
}

function isValidAuthProfileMetadata(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.provider === "string" &&
    value.provider.trim() !== "" &&
    isAuthProfileMode(value.mode)
  );
}

function isAuthProfileMode(value: unknown): boolean {
  return value === "api_key" || value === "aws-sdk" || value === "oauth" || value === "token";
}

export function scanPolicyTools(raw: string): Promise<readonly PolicyToolEvidence[]> {
  return Promise.resolve(scanPolicyToolHeaders(raw));
}

function scanPolicyToolHeaders(raw: string): readonly PolicyToolEvidence[] {
  const section = markdownSectionLines(raw, "tools");
  if (section.length === 0) {
    return [];
  }
  const tools: PolicyToolEvidence[] = [];
  for (let index = 0; index < section.length; index += 1) {
    const line = section[index]?.text ?? "";
    const heading = /^###\s+([^\s#]+)(.*)$/.exec(line);
    const bullet = /^[-*+]\s+([^:\s][^:]*?)\s*:(.*)$/.exec(line);
    const match = heading ?? bullet;
    if (match === null || slugify(match[1]).length === 0) {
      continue;
    }
    const id = slugify(match[1]);
    const entry: {
      id: string;
      source: string;
      line: number;
      risk?: string;
      sensitivity?: string;
      owner?: string;
      capabilities?: readonly string[];
    } = {
      id,
      source: `oc://TOOLS.md/tools/${id}`,
      line: section[index]?.line ?? index + 1,
    };
    const metaLines = [match[2] ?? ""];
    for (let metaIndex = index + 1; metaIndex < section.length; metaIndex += 1) {
      const metaLine = section[metaIndex]?.text ?? "";
      if (/^###\s+\S+/.test(metaLine.trim()) || /^[-*+]\s+[^:\s][^:]*?\s*:/.test(metaLine)) {
        break;
      }
      metaLines.push(metaLine);
    }
    const meta = metaLines.join("\n");
    const risk = riskFromMeta(meta);
    const sensitivity = /\bsensitivity\s*:\s*([a-z0-9_-]+)\b/i.exec(meta)?.[1]?.toLowerCase();
    const owner = /\bowner\s*:\s*([^\s#]+)\b/i.exec(meta)?.[1];
    const capabilities = capabilityTokensFromMetaLines(metaLines);
    if (risk !== undefined) {
      entry.risk = risk;
    }
    if (sensitivity !== undefined) {
      entry.sensitivity = sensitivity;
    }
    if (owner !== undefined) {
      entry.owner = owner;
    }
    if (capabilities.length > 0) {
      entry.capabilities = capabilities;
    }
    tools.push(entry);
  }
  return tools;
}

function markdownSectionLines(
  raw: string,
  sectionSlug: string,
): readonly { readonly line: number; readonly text: string }[] {
  const lines = raw.split(/\r?\n/);
  let sectionDepth: number | undefined;
  const section: { line: number; text: string }[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading !== null) {
      const depth = heading[1]?.length ?? 0;
      const slug = slugify(heading[2] ?? "");
      if (sectionDepth !== undefined && depth <= sectionDepth) {
        break;
      }
      if (sectionDepth !== undefined) {
        section.push({ line: index + 1, text: line });
        continue;
      }
      if (sectionDepth === undefined && slug === sectionSlug) {
        sectionDepth = depth;
      }
      continue;
    }
    if (sectionDepth !== undefined) {
      section.push({ line: index + 1, text: line });
    }
  }
  return section;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/_/g, "-")
    .replace(NON_SLUG_CHARS, "-")
    .replace(COLLAPSE_HYPHENS, "-")
    .replace(TRIM_HYPHENS, "");
}

function riskFromMeta(meta: string): string | undefined {
  const namedRisk = /\brisk\s*:\s*([a-z0-9_-]+)\b/i.exec(meta)?.[1];
  if (namedRisk !== undefined) {
    return namedRisk.toLowerCase();
  }
  const alias = /\bR([0-5])\b/.exec(meta)?.[1];
  switch (alias) {
    case "0":
    case "1":
      return "low";
    case "2":
    case "3":
      return "medium";
    case "4":
      return "high";
    case "5":
      return "critical";
    default:
      return undefined;
  }
}

function capabilityTokensFromMetaLines(lines: readonly string[]): readonly string[] {
  return lines.flatMap((line, index): string[] => {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return [];
    }
    const tokens = trimmed.match(/\b[A-Z][A-Z0-9_]{2,}\b/g) ?? [];
    if (index === 0 || /\bcapabilities\s*:/i.test(trimmed)) {
      return tokens;
    }
    const withoutTokens = tokens.reduce((remaining, token) => {
      return remaining.replace(token, "");
    }, trimmed);
    return /^[\s,;:[\](){}#*_-]*$/.test(withoutTokens) ? tokens : [];
  });
}

function configuredChannels(cfg: Record<string, unknown>): Record<string, unknown> {
  return isRecord(cfg.channels) ? cfg.channels : {};
}

function configuredMcpServers(cfg: Record<string, unknown>): Record<string, unknown> {
  return isRecord(cfg.mcp) && isRecord(cfg.mcp.servers) ? cfg.mcp.servers : {};
}

function mcpServerTransport(value: unknown): PolicyMcpServerEvidence["transport"] {
  if (!isRecord(value)) {
    return "unknown";
  }
  if (typeof value.command === "string") {
    return "stdio";
  }
  if (value.transport === "sse" || value.transport === "streamable-http") {
    return value.transport;
  }
  if (typeof value.url === "string") {
    return "streamable-http";
  }
  return "unknown";
}

function redactMcpUrlForEvidence(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}`;
  } catch {
    return "[redacted-url]";
  }
}

function configuredModelProviders(cfg: Record<string, unknown>): Record<string, unknown> {
  return isRecord(cfg.models) && isRecord(cfg.models.providers) ? cfg.models.providers : {};
}

function networkBooleanEvidence(
  cfg: Record<string, unknown>,
  id: string,
  path: readonly string[],
  source: string,
): PolicyNetworkEvidence | undefined {
  const value = readBooleanPath(cfg, path);
  return value === undefined ? undefined : { id, source, value };
}

function pickSupportedIngressDefaults(config: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (config.groupPolicy !== undefined) {
    result.groupPolicy = config.groupPolicy;
  }
  return result;
}

function hasImplicitDefaultAccountConfig(
  channel: string,
  config: Record<string, unknown>,
): boolean {
  switch (channel) {
    case "clickclack":
      return (
        hasConfiguredAccountValue(config.baseUrl) &&
        hasConfiguredAccountValue(config.workspace) &&
        hasConfiguredAccountValue(config.token)
      );
    case "feishu":
      return hasConfiguredAccountValue(config.appId) && hasConfiguredAccountValue(config.appSecret);
    case "irc":
      return hasConfiguredAccountValue(config.host) && hasConfiguredAccountValue(config.nick);
    case "line":
      return (
        hasConfiguredAccountValue(config.channelAccessToken) ||
        hasConfiguredAccountValue(config.tokenFile)
      );
    case "matrix":
      return (
        hasConfiguredAccountValue(config.homeserver) &&
        (hasConfiguredAccountValue(config.accessToken) ||
          (hasConfiguredAccountValue(config.userId) && hasConfiguredAccountValue(config.password)))
      );
    case "mattermost":
      return (
        hasConfiguredAccountValue(config.baseUrl) && hasConfiguredAccountValue(config.botToken)
      );
    case "nextcloud-talk":
      return (
        hasConfiguredAccountValue(config.baseUrl) &&
        (hasConfiguredAccountValue(config.botSecret) ||
          hasConfiguredAccountValue(config.botSecretFile))
      );
    default:
      return (IMPLICIT_DEFAULT_ACCOUNT_FIELDS[channel] ?? []).some((field) =>
        hasConfiguredAccountValue(config[field]),
      );
  }
}

function hasConfiguredAccountValue(value: unknown): boolean {
  return typeof value === "string"
    ? value.trim().length > 0
    : value !== undefined && value !== null;
}

type ChannelIngressParams = {
  readonly channel: string;
  readonly accountId?: string;
  readonly config: Record<string, unknown>;
  readonly inheritedConfig: Record<string, unknown>;
  readonly inheritNestedContainers?: boolean;
  readonly sourceBase: string;
  readonly inheritedSourceBase: string;
  readonly fallbackConfig?: Record<string, unknown>;
  readonly fallbackSourceBase: string;
};

function pushChannelIngress(entries: PolicyIngressEvidence[], params: ChannelIngressParams): void {
  const localDmPolicy = channelDmPolicy(params.config);
  const inheritedDmPolicy = channelDmPolicy(params.inheritedConfig);
  const fallbackDmPolicy = channelDmPolicy(params.fallbackConfig ?? {});
  const effectiveDmPolicy =
    localDmPolicy.disabledByEnabled === true
      ? localDmPolicy
      : localDmPolicy.value !== undefined
        ? localDmPolicy
        : inheritedDmPolicy.disabledByEnabled === true
          ? inheritedDmPolicy
          : inheritedDmPolicy.value !== undefined
            ? inheritedDmPolicy
            : fallbackDmPolicy.disabledByEnabled === true || fallbackDmPolicy.value !== undefined
              ? fallbackDmPolicy
              : undefined;
  const dmPolicySource =
    effectiveDmPolicy?.sourceSuffix === undefined
      ? `${params.fallbackSourceBase}/dmPolicy`
      : effectiveDmPolicy === localDmPolicy
        ? `${params.sourceBase}/${effectiveDmPolicy.sourceSuffix}`
        : effectiveDmPolicy === inheritedDmPolicy
          ? `${params.inheritedSourceBase}/${effectiveDmPolicy.sourceSuffix}`
          : `${params.fallbackSourceBase}/${effectiveDmPolicy.sourceSuffix}`;
  entries.push({
    id: channelIngressId(params, "dm-policy"),
    kind: "channelDmPolicy",
    source: dmPolicySource,
    channel: params.channel,
    ...(params.accountId === undefined ? {} : { accountId: params.accountId }),
    value: effectiveDmPolicy?.value ?? "pairing",
    explicit: effectiveDmPolicy !== undefined,
  });

  const localGroupPolicy = readString(params.config.groupPolicy);
  const inheritedGroupPolicy = readString(params.inheritedConfig.groupPolicy);
  const fallbackGroupPolicy = readString(params.fallbackConfig?.groupPolicy);
  const implicitGroupPolicy = channelImplicitGroupPolicy(params);
  entries.push({
    id: channelIngressId(params, "group-policy"),
    kind: "channelGroupPolicy",
    source:
      localGroupPolicy !== undefined
        ? `${params.sourceBase}/groupPolicy`
        : inheritedGroupPolicy !== undefined
          ? `${params.inheritedSourceBase}/groupPolicy`
          : fallbackGroupPolicy !== undefined
            ? `${params.fallbackSourceBase}/groupPolicy`
            : implicitGroupPolicy.source,
    channel: params.channel,
    ...(params.accountId === undefined ? {} : { accountId: params.accountId }),
    value:
      localGroupPolicy ?? inheritedGroupPolicy ?? fallbackGroupPolicy ?? implicitGroupPolicy.value,
    explicit:
      localGroupPolicy !== undefined ||
      inheritedGroupPolicy !== undefined ||
      fallbackGroupPolicy !== undefined,
  });

  pushChannelRequireMentionIngress(entries, params);
}

function channelImplicitGroupPolicy(params: ChannelIngressParams): {
  readonly source: string;
  readonly value: "allowlist" | "open";
} {
  for (const [config, sourceBase] of [
    [params.config, params.sourceBase],
    ...(params.inheritNestedContainers === true
      ? ([[params.inheritedConfig, params.inheritedSourceBase]] as const)
      : []),
    [params.fallbackConfig, params.fallbackSourceBase],
  ] as const) {
    if (config === undefined || sourceBase === undefined) {
      continue;
    }
    for (const key of ["groups"] as const) {
      const container = isRecord(config[key]) ? config[key] : undefined;
      if (container !== undefined && Object.keys(container).length > 0) {
        return { source: `${sourceBase}/${key}`, value: "allowlist" };
      }
    }
  }
  return {
    source: `${params.sourceBase}/groupPolicy`,
    value: ALLOWLIST_DEFAULT_INGRESS_GROUP_POLICY_CHANNELS.has(params.channel)
      ? "allowlist"
      : "open",
  };
}

function pushChannelRequireMentionIngress(
  entries: PolicyIngressEvidence[],
  params: ChannelIngressParams,
): void {
  const localRequireMention = readBoolean(params.config.requireMention);
  const inheritedRequireMention = readBoolean(params.inheritedConfig.requireMention);
  const fallbackRequireMention = readBoolean(params.fallbackConfig?.requireMention);
  const wildcardRequireMention = channelWildcardRequireMention(params);
  const defaultRequireMention = channelDefaultRequireMention(params);
  entries.push({
    id: channelIngressId(params, "require-mention"),
    kind: "channelRequireMention",
    source:
      wildcardRequireMention !== undefined
        ? wildcardRequireMention.source
        : localRequireMention !== undefined
          ? `${params.sourceBase}/requireMention`
          : inheritedRequireMention !== undefined
            ? `${params.inheritedSourceBase}/requireMention`
            : fallbackRequireMention !== undefined
              ? `${params.fallbackSourceBase}/requireMention`
              : `${params.sourceBase}/requireMention`,
    channel: params.channel,
    ...(params.accountId === undefined ? {} : { accountId: params.accountId }),
    value:
      wildcardRequireMention?.value ??
      localRequireMention ??
      inheritedRequireMention ??
      fallbackRequireMention ??
      defaultRequireMention,
    explicit:
      wildcardRequireMention !== undefined ||
      localRequireMention !== undefined ||
      inheritedRequireMention !== undefined ||
      fallbackRequireMention !== undefined,
  });

  const containers = nestedIngressContainers(params);
  for (const { containerKey, container, sourceBase } of containers) {
    for (const [groupId, groupConfig] of Object.entries(container)) {
      if (!isRecord(groupConfig)) {
        continue;
      }
      pushNestedRequireMentionIngress(
        entries,
        params,
        containerKey,
        groupId,
        groupConfig,
        sourceBase,
      );
    }
  }
}

function channelDefaultRequireMention(params: ChannelIngressParams): boolean {
  const groupPolicy =
    readString(params.config.groupPolicy) ??
    readString(params.inheritedConfig.groupPolicy) ??
    readString(params.fallbackConfig?.groupPolicy) ??
    channelImplicitGroupPolicy(params).value;
  return !(
    groupPolicy === "open" && OPEN_GROUPS_DEFAULT_TO_NO_MENTION_CHANNELS.has(params.channel)
  );
}

function channelWildcardRequireMention(
  params: ChannelIngressParams,
): { readonly source: string; readonly value: boolean } | undefined {
  for (const [config, sourceBase] of [
    [params.config, params.sourceBase],
    [params.inheritedConfig, params.inheritedSourceBase],
    [params.fallbackConfig, params.fallbackSourceBase],
  ] as const) {
    if (config === undefined || sourceBase === undefined) {
      continue;
    }
    for (const key of ["groups", "guilds", "channels", "rooms", "teams"] as const) {
      const container = isRecord(config[key]) ? config[key] : undefined;
      const wildcard = isRecord(container?.["*"]) ? container["*"] : undefined;
      const requireMention = readBoolean(wildcard?.requireMention);
      if (wildcard?.enabled !== false && requireMention !== undefined) {
        return {
          source: `${sourceBase}/${key}/${ocPathSegment("*")}/requireMention`,
          value: requireMention,
        };
      }
    }
  }
  return undefined;
}

function nestedIngressContainers(params: ChannelIngressParams): readonly {
  readonly containerKey: string;
  readonly container: Record<string, unknown>;
  readonly sourceBase: string;
}[] {
  const containers: {
    readonly containerKey: string;
    readonly container: Record<string, unknown>;
    readonly sourceBase: string;
  }[] = [];
  for (const key of ["groups", "guilds", "channels", "rooms", "teams"] as const) {
    const local = isRecord(params.config[key]) ? params.config[key] : undefined;
    const inherited = isRecord(params.inheritedConfig[key])
      ? params.inheritedConfig[key]
      : undefined;
    if (local !== undefined) {
      if (Object.keys(local).length > 0) {
        containers.push({ containerKey: key, container: local, sourceBase: params.sourceBase });
      }
    } else if (params.inheritNestedContainers === true && inherited !== undefined) {
      containers.push({
        containerKey: key,
        container: inherited,
        sourceBase: params.inheritedSourceBase,
      });
    }
  }
  return containers;
}

function pushNestedRequireMentionIngress(
  entries: PolicyIngressEvidence[],
  params: ChannelIngressParams,
  containerKey: string,
  groupId: string,
  config: Record<string, unknown>,
  parentSourceBase: string,
): void {
  if (config.enabled === false) {
    return;
  }
  const sourceBase = `${parentSourceBase}/${containerKey}/${ocPathSegment(groupId)}`;
  const requireMention = readBoolean(config.requireMention);
  if (requireMention !== undefined) {
    entries.push({
      id: `${channelIngressId(params, `${containerKey}-${ocPathSegment(groupId)}`)}-require-mention`,
      kind: "channelRequireMention",
      source: `${sourceBase}/requireMention`,
      channel: params.channel,
      ...(params.accountId === undefined ? {} : { accountId: params.accountId }),
      groupId,
      value: requireMention ?? true,
      explicit: requireMention !== undefined,
    });
  }
  for (const nestedKey of ["channels", "topics"] as const) {
    const nested = config[nestedKey];
    if (!isRecord(nested)) {
      continue;
    }
    for (const [nestedId, nestedConfig] of Object.entries(nested)) {
      if (isRecord(nestedConfig)) {
        pushNestedRequireMentionIngress(
          entries,
          params,
          `${containerKey}/${ocPathSegment(groupId)}/${nestedKey}`,
          nestedId,
          nestedConfig,
          parentSourceBase,
        );
      }
    }
  }
}

function channelDmPolicy(config: Record<string, unknown>): {
  readonly value?: string;
  readonly sourceSuffix?: string;
  readonly disabledByEnabled?: boolean;
} {
  const dm = isRecord(config.dm) ? config.dm : {};
  if (dm.enabled === false) {
    return { value: "disabled", sourceSuffix: "dm/enabled", disabledByEnabled: true };
  }
  const direct = readString(config.dmPolicy);
  if (direct !== undefined) {
    return { value: direct, sourceSuffix: "dmPolicy" };
  }
  const legacy = readString(dm.policy);
  return legacy === undefined ? {} : { value: legacy, sourceSuffix: "dm/policy" };
}

function channelIngressId(params: ChannelIngressParams, suffix: string): string {
  return params.accountId === undefined
    ? `${params.channel}-${suffix}`
    : `${params.channel}-${params.accountId}-${suffix}`;
}

function pushGatewayBooleanEvidence(
  entries: PolicyGatewayExposureEvidence[],
  id: string,
  kind: PolicyGatewayExposureEvidence["kind"],
  value: unknown,
  source: string,
): void {
  if (typeof value !== "boolean") {
    return;
  }
  entries.push({ id, kind, source, value });
}

function pushGatewayHttpEndpointEvidence(
  entries: PolicyGatewayExposureEvidence[],
  endpoints: Record<string, unknown>,
  endpoint: "chatCompletions" | "responses",
): void {
  const config = endpoints[endpoint];
  if (!isRecord(config)) {
    return;
  }
  const source = `oc://openclaw.config/gateway/http/endpoints/${endpoint}`;
  const enabled = config.enabled === true;
  if (enabled) {
    entries.push({
      id: `gateway-http-${endpoint}`,
      kind: "httpEndpoint",
      source: `${source}/enabled`,
      value: true,
      endpoint,
    });
  }
  if (!enabled) {
    return;
  }
  if (endpoint === "chatCompletions") {
    pushGatewayHttpUrlFetchEvidence(entries, source, endpoint, ["images"], config.images);
    return;
  }
  pushGatewayHttpUrlFetchEvidence(entries, source, endpoint, ["files"], config.files);
  pushGatewayHttpUrlFetchEvidence(entries, source, endpoint, ["images"], config.images);
}

function pushGatewayHttpUrlFetchEvidence(
  entries: PolicyGatewayExposureEvidence[],
  endpointSource: string,
  endpoint: string,
  path: readonly string[],
  value: unknown,
): void {
  const allowUrl = isRecord(value) ? value.allowUrl : undefined;
  if (allowUrl === false || (allowUrl !== true && endpoint !== "responses")) {
    return;
  }
  const allowlist = isRecord(value) ? value.urlAllowlist : undefined;
  const hasEffectiveAllowlist =
    Array.isArray(allowlist) &&
    allowlist.some((entry) => isEffectiveGatewayUrlAllowlistEntry(entry));
  entries.push({
    id: `gateway-http-${endpoint}-${path.join("-")}-url-fetch`,
    kind: "httpUrlFetch",
    source: `${endpointSource}/${path.map(ocPathSegment).join("/")}/allowUrl`,
    value: true,
    endpoint,
    explicit: allowUrl === true,
    hasAllowlist: hasEffectiveAllowlist,
  });
}

function isEffectiveGatewayUrlAllowlistEntry(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized !== "" && normalized !== "*" && normalized !== "*.";
}

function isGatewayNonLoopbackBind(value: string): boolean {
  return value === "auto" || value === "lan" || value === "custom" || value === "tailnet";
}

function isRuntimeNonLoopbackCustomBindHost(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return isCanonicalDottedDecimalIPv4(normalized) && !normalized.startsWith("127.");
}

function isCanonicalDottedDecimalIPv4(value: string): boolean {
  return /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(
    value,
  );
}

function readBooleanPath(value: unknown, path: readonly string[]): boolean | undefined {
  let current = value;
  for (const part of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[part];
  }
  return typeof current === "boolean" ? current : undefined;
}

function collectModelRefsFromValue(
  refs: PolicyModelRefEvidence[],
  value: unknown,
  source: string,
): void {
  if (typeof value === "string") {
    pushModelRef(refs, value, source);
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  if (typeof value.primary === "string") {
    pushModelRef(refs, value.primary, `${source}/primary`);
  }
  if (Array.isArray(value.fallbacks)) {
    for (const [index, fallback] of value.fallbacks.entries()) {
      if (typeof fallback === "string") {
        pushModelRef(refs, fallback, `${source}/fallbacks/#${index}`);
      }
    }
  }
}

function collectModelRefsFromRecord(
  refs: PolicyModelRefEvidence[],
  value: Record<string, unknown>,
  source: string,
): void {
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${source}/${key}`;
    if (isModelSettingKey(key)) {
      collectModelRefsFromValue(refs, child, childPath);
      continue;
    }
    if (Array.isArray(child)) {
      for (const [index, item] of child.entries()) {
        if (isRecord(item)) {
          collectModelRefsFromRecord(refs, item, `${childPath}/#${index}`);
        }
      }
      continue;
    }
    if (isRecord(child)) {
      collectModelRefsFromRecord(refs, child, childPath);
    }
  }
}

function collectModelRefsFromAgentAllowlist(
  refs: PolicyModelRefEvidence[],
  agents: Record<string, unknown>,
): void {
  const defaults = agents.defaults;
  if (isRecord(defaults) && isRecord(defaults.models)) {
    collectModelRefsFromModelMap(
      refs,
      defaults.models,
      "oc://openclaw.config/agents/defaults/models",
    );
  }

  const list = agents.list;
  if (!Array.isArray(list)) {
    return;
  }
  for (const [index, agent] of list.entries()) {
    if (!isRecord(agent) || !isRecord(agent.models)) {
      continue;
    }
    collectModelRefsFromModelMap(
      refs,
      agent.models,
      `oc://openclaw.config/agents/list/#${index}/models`,
    );
  }
}

function collectModelRefsFromModelMap(
  refs: PolicyModelRefEvidence[],
  models: Record<string, unknown>,
  source: string,
): void {
  for (const ref of Object.keys(models)) {
    pushModelRef(refs, ref, `${source}/${ocPathSegment(ref)}`);
  }
}

function isModelSettingKey(key: string): boolean {
  return key === "model" || key.endsWith("Model");
}

function ocPathSegment(value: string): string {
  if (/^(?:[A-Za-z0-9_-]+|#\d+)$/.test(value)) {
    return value;
  }
  if (value.includes('"') || value.includes("\\")) {
    return value;
  }
  return `"${value}"`;
}

function pushModelRef(refs: PolicyModelRefEvidence[], ref: string, source: string): void {
  const parsed = parseModelRef(ref);
  if (parsed === undefined) {
    return;
  }
  refs.push({ ref, provider: parsed.provider, model: parsed.model, source });
}

function parseModelRef(
  ref: string,
): { readonly provider: string; readonly model: string } | undefined {
  const trimmed = ref.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash >= trimmed.length - 1) {
    return undefined;
  }
  return {
    provider: normalizeProviderId(trimmed.slice(0, slash)),
    model: trimmed.slice(slash + 1),
  };
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
