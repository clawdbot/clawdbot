import { createHash } from "node:crypto";
import { hostname as readHostName } from "node:os";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { isLoopbackHost } from "openclaw/plugin-sdk/ssrf-runtime";
import type {
  CodexAppServerConnectionClass,
  CodexAppServerDefaultPolicy,
  CodexAppServerEffectiveApprovalPolicy,
  CodexAppServerNetworkProxyConfig,
  CodexAppServerPolicyMode,
  CodexAppServerRuntimeOptions,
  CodexAppServerSandboxMode,
  CodexAppServerTransportMode,
  OpenClawExecMode,
  ResolvedCodexAppServerNetworkProxyConfig,
} from "./config-contracts.js";
import { selectGuardianSandbox } from "./config-exec-policy.js";
import { DEFAULT_CODEX_APP_SERVER_NETWORK_PROXY_PROFILE_PREFIX } from "./config-parsing.js";
import {
  parseAllowedApprovalPoliciesFromCodexRequirements,
  parseAllowedApprovalsReviewersFromCodexRequirements,
  parseAllowedSandboxModesFromCodexRequirements,
  readCodexRequirementsToml,
  selectGuardianApprovalPolicy,
  selectGuardianApprovalsReviewer,
  selectUserApprovalsReviewer,
} from "./config-requirements.js";
import { readNonEmptyString } from "./config-utils.js";
import type { JsonObject, JsonValue } from "./protocol.js";

export function shouldAutoApproveCodexAppServerApprovals(
  appServer: Pick<CodexAppServerRuntimeOptions, "approvalPolicy" | "networkProxy" | "sandbox">,
): boolean {
  return (
    appServer.networkProxy === undefined &&
    appServer.approvalPolicy === "never" &&
    appServer.sandbox === "danger-full-access"
  );
}

export function resolveCodexAppServerNetworkProxy(
  config: CodexAppServerNetworkProxyConfig | undefined,
  sandbox: CodexAppServerSandboxMode,
): { networkProxy?: ResolvedCodexAppServerNetworkProxyConfig } {
  if (config?.enabled !== true) {
    return {};
  }
  const fileSystemMode =
    config.baseProfile === "read-only" || (!config.baseProfile && sandbox === "read-only")
      ? "read"
      : "write";
  const networkConfig = removeUndefinedJsonFields({
    enabled: true,
    mode: config.mode,
    domains: normalizeNetworkProxyPermissionMap(config.domains),
    unix_sockets: normalizeNetworkProxyPermissionMap(config.unixSockets),
    proxy_url: readNonEmptyString(config.proxyUrl),
    socks_url: readNonEmptyString(config.socksUrl),
    enable_socks5: config.enableSocks5,
    enable_socks5_udp: config.enableSocks5Udp,
    allow_upstream_proxy: config.allowUpstreamProxy,
    allow_local_binding: config.allowLocalBinding,
    dangerously_allow_non_loopback_proxy: config.dangerouslyAllowNonLoopbackProxy,
    dangerously_allow_all_unix_sockets: config.dangerouslyAllowAllUnixSockets,
  });
  const profile = {
    filesystem: {
      ":minimal": "read",
      ":project_roots": {
        ".": fileSystemMode,
      },
    },
    network: networkConfig,
  };
  const profileName = resolveNetworkProxyPermissionProfileName(config, profile);
  const configPatch: JsonObject = {
    "features.network_proxy.enabled": true,
    default_permissions: profileName,
    permissions: {
      [profileName]: profile,
    },
  };
  return {
    networkProxy: {
      profileName,
      configFingerprint: fingerprintCodexAppServerNetworkProxyConfigPatch(configPatch),
      configPatch,
    },
  };
}

function resolveNetworkProxyPermissionProfileName(
  config: CodexAppServerNetworkProxyConfig,
  profile: JsonObject,
): string {
  const explicitProfileName = readNonEmptyString(config.profileName);
  if (explicitProfileName) {
    return explicitProfileName;
  }
  const suffix = createHash("sha256")
    .update(stableStringifyJson({ version: 1, profile }))
    .digest("hex")
    .slice(0, 16);
  return `${DEFAULT_CODEX_APP_SERVER_NETWORK_PROXY_PROFILE_PREFIX}-${suffix}`;
}

function fingerprintCodexAppServerNetworkProxyConfigPatch(configPatch: JsonObject): string {
  return createHash("sha256").update(stableStringifyJson(configPatch)).digest("hex");
}

function normalizeNetworkProxyPermissionMap<TPermission extends string>(
  value: Record<string, TPermission> | undefined,
): Record<string, TPermission> | undefined {
  const entries = Object.entries(value ?? {})
    .map(([key, permission]) => [key.trim(), permission] as const)
    .filter(([key]) => key.length > 0);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function removeUndefinedJsonFields(value: Record<string, JsonValue | undefined>): JsonObject {
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, JsonValue] => entry[1] !== undefined),
  );
}

function stableStringifyJson(value: JsonValue): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringifyJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringifyJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Explicit MCP prompting must bypass Codex's unconditional Never-policy approval. */
export function hasCodexMcpToolApprovalOverrides(
  servers: NonNullable<OpenClawConfig["mcp"]>["servers"],
  serverNames?: readonly string[],
  projectedMcpServers?: Record<string, Record<string, unknown>>,
): boolean {
  const modes = new Map(
    Object.entries(projectedMcpServers ?? {}).map(([name, server]) => [
      name,
      server.default_tools_approval_mode,
    ]),
  );
  for (const name of serverNames ?? Object.keys(servers ?? {})) {
    const server = servers?.[name];
    const mode = server?.codex?.defaultToolsApprovalMode;
    // Prepared names already include session overrides that can re-enable a saved disabled server.
    if (mode !== undefined && (serverNames !== undefined || server?.enabled !== false)) {
      modes.set(name, mode);
    }
  }
  return [...modes.values()].some((mode) => mode === "auto" || mode === "prompt");
}

export function withMcpElicitationsApprovalPolicy(
  policy: CodexAppServerEffectiveApprovalPolicy,
): CodexAppServerEffectiveApprovalPolicy {
  // UnlessTrusted already allows MCP elicitation; granular would erase per-command approvals.
  if (policy === "untrusted") {
    return policy;
  }
  if (typeof policy !== "string") {
    return {
      granular: {
        ...policy.granular,
        mcp_elicitations: true,
      },
    };
  }
  if (policy === "never") {
    return {
      granular: {
        mcp_elicitations: true,
        rules: false,
        sandbox_approval: false,
        request_permissions: false,
        skill_approval: false,
      },
    };
  }
  return {
    granular: {
      mcp_elicitations: true,
      rules: true,
      sandbox_approval: true,
      request_permissions: true,
      skill_approval: true,
    },
  };
}

export function resolveTransport(value: unknown): CodexAppServerTransportMode {
  return value === "websocket" || value === "unix" ? value : "stdio";
}

export function normalizeRemoteWorkspaceRoot(value: string | undefined): string | undefined {
  return readNonEmptyString(value);
}

export function inferCodexAppServerConnectionClass(params: {
  transport: CodexAppServerTransportMode;
  url?: string;
}): CodexAppServerConnectionClass {
  if (params.transport !== "websocket") {
    return "local-loopback";
  }
  return params.url && isLoopbackWebSocketUrl(params.url) ? "local-loopback" : "remote";
}

function assertCodexAppServerConnectionClassConfig(params: {
  connectionClass: CodexAppServerConnectionClass;
  authToken?: string;
  headers: Record<string, string>;
}): void {
  if (
    params.connectionClass === "remote" &&
    !hasIdentityBearingWebSocketAuth({
      authToken: params.authToken,
      headers: params.headers,
    })
  ) {
    throw new Error(
      "remote Codex app-server WebSocket URLs require appServer.authToken or an Authorization header",
    );
  }
}

/** Applies the canonical remote-auth boundary to any Codex AppServer transport. */
export function assertCodexAppServerConnectionSecurity(params: {
  transport: CodexAppServerTransportMode;
  url?: string;
  authToken?: string;
  headers: Record<string, string>;
}): void {
  assertCodexAppServerConnectionClassConfig({
    connectionClass: inferCodexAppServerConnectionClass(params),
    authToken: params.authToken,
    headers: params.headers,
  });
}

function isLoopbackWebSocketUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    return false;
  }
  return isLoopbackHost(parsed.hostname);
}

function hasIdentityBearingWebSocketAuth(params: {
  authToken?: string;
  headers: Record<string, string>;
}): boolean {
  if (readNonEmptyString(params.authToken)) {
    return true;
  }
  return Object.entries(params.headers).some(
    ([key, value]) =>
      key.trim().toLowerCase() === "authorization" && Boolean(readNonEmptyString(value)),
  );
}

export function resolvePolicyMode(value: unknown): CodexAppServerPolicyMode | undefined {
  return value === "guardian" || value === "yolo" ? value : undefined;
}

export function resolveDefaultCodexAppServerPolicy(params: {
  transport: CodexAppServerTransportMode;
  forceGuardian?: boolean;
  forceUserReviewer?: boolean;
  execModeRequiringPromptingApprovals?: Extract<OpenClawExecMode, "auto" | "ask">;
  execModeRequiringUserReviewer?: OpenClawExecMode;
  env?: NodeJS.ProcessEnv;
  requirementsToml?: string | null;
  requirementsPath?: string;
  readRequirementsFile?: (path: string) => string | undefined;
  platform?: NodeJS.Platform;
  hostName?: string;
}): CodexAppServerDefaultPolicy {
  if (params.transport !== "stdio") {
    return { mode: "yolo", dangerFullAccessAllowed: true };
  }
  const content = readCodexRequirementsToml(params);
  if (content === undefined) {
    if (!params.forceGuardian) {
      return { mode: "yolo", dangerFullAccessAllowed: true };
    }
    return {
      mode: "guardian",
      dangerFullAccessAllowed: true,
      approvalPolicy: selectGuardianApprovalPolicy(
        undefined,
        params.execModeRequiringPromptingApprovals,
      ),
      approvalsReviewer: params.forceUserReviewer
        ? selectUserApprovalsReviewer(undefined, params.execModeRequiringUserReviewer)
        : selectGuardianApprovalsReviewer(
            undefined,
            params.execModeRequiringPromptingApprovals === "auto" ? "auto" : undefined,
          ),
      sandbox: selectGuardianSandbox(undefined),
    };
  }
  const allowedSandboxModes = parseAllowedSandboxModesFromCodexRequirements(
    content,
    readNonEmptyString(params.hostName) ?? readHostName(),
  );
  const allowedApprovalPolicies = parseAllowedApprovalPoliciesFromCodexRequirements(content);
  const allowedApprovalsReviewers = parseAllowedApprovalsReviewersFromCodexRequirements(content);
  const yoloSandboxAllowed =
    allowedSandboxModes === undefined || allowedSandboxModes.has("danger-full-access");
  const yoloApprovalAllowed =
    allowedApprovalPolicies === undefined ||
    (allowedApprovalPolicies.has("never") && !allowedApprovalPolicies.has("untrusted"));
  const yoloReviewerAllowed =
    allowedApprovalsReviewers === undefined || allowedApprovalsReviewers.has("user");
  if (!params.forceGuardian && yoloSandboxAllowed && yoloApprovalAllowed && yoloReviewerAllowed) {
    return { mode: "yolo", dangerFullAccessAllowed: true };
  }
  return {
    mode: "guardian",
    dangerFullAccessAllowed: yoloSandboxAllowed,
    approvalPolicy: selectGuardianApprovalPolicy(
      allowedApprovalPolicies,
      params.execModeRequiringPromptingApprovals,
    ),
    approvalsReviewer: params.forceUserReviewer
      ? selectUserApprovalsReviewer(allowedApprovalsReviewers, params.execModeRequiringUserReviewer)
      : selectGuardianApprovalsReviewer(
          allowedApprovalsReviewers,
          params.execModeRequiringPromptingApprovals === "auto" ? "auto" : undefined,
        ),
    sandbox: selectGuardianSandbox(allowedSandboxModes),
  };
}
