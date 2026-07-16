import {
  isHostScopedAgentToolActive,
  type EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { CodexAppServerClient } from "./client.js";
import type { CodexAppServerRuntimeOptions } from "./config.js";
import {
  isSystemAgentOnlyCodexDynamicToolAllowlist,
  shouldDisableCodexToolSearchForModel,
} from "./dynamic-tool-profile.js";
import { mergeCodexThreadConfigs } from "./plugin-thread-config.js";
import {
  CODEX_OPENCLAW_DIRECT_DYNAMIC_TOOL_NAMESPACE,
  isJsonObject,
  type CodexConfigReadResponse,
  type CodexConfigRequirementsReadResponse,
  type CodexDynamicToolSpec,
  type CodexThreadResumeParams,
  type CodexThreadStartParams,
  type CodexTurnEnvironmentParams,
  type JsonObject,
  type JsonValue,
} from "./protocol.js";
import {
  CODEX_NATIVE_PERSONALITY_NONE,
  resolveCodexAppServerModelProvider,
  resolveCodexAppServerRequestModelSelection,
} from "./thread-model-selection.js";
import { buildDeveloperInstructions } from "./thread-prompt.js";
import { resolveCodexWebSearchPlan, type CodexNativeWebSearchSupport } from "./web-search.js";

export const CODEX_RING_ZERO_BASE_INSTRUCTIONS = "";

// Stream structured patch snapshots so large generated edits keep the turn active.
const CODEX_CODE_MODE_THREAD_CONFIG: JsonObject = {
  "features.code_mode": true,
  "features.code_mode_only": false,
  "features.apply_patch_streaming_events": true,
};

const CODEX_CODE_MODE_DISABLED_THREAD_CONFIG: JsonObject = {
  "features.code_mode": false,
  "features.code_mode_only": false,
};

const CODEX_LIGHTWEIGHT_CONTEXT_THREAD_CONFIG: JsonObject = {
  project_doc_max_bytes: 0,
};

const CODEX_TOOL_SEARCH_UNSUPPORTED_THREAD_CONFIG: JsonObject = {
  "features.multi_agent": false,
};

const CODEX_RING_ZERO_THREAD_CONFIG: JsonObject = {
  "features.apps": false,
  "features.current_time_reminder": false,
  "features.deferred_executor": false,
  "features.enable_fanout": false,
  "features.goals": false,
  "features.hooks": false,
  "features.image_generation": false,
  "features.memories": false,
  "features.multi_agent": false,
  "features.multi_agent_v2": false,
  "features.plugins": false,
  "features.standalone_web_search": false,
  "features.token_budget": false,
  "orchestrator.mcp.enabled": false,
  "orchestrator.skills.enabled": false,
  "tools.experimental_request_user_input.enabled": false,
  hooks: {
    PreToolUse: [],
    PermissionRequest: [],
    PostToolUse: [],
    PreCompact: [],
    PostCompact: [],
    SessionStart: [],
    UserPromptSubmit: [],
    SubagentStart: [],
    SubagentStop: [],
    Stop: [],
  },
  project_doc_max_bytes: 0,
  notify: [],
  web_search: "disabled",
};

const CODEX_RING_ZERO_RESTRICTED_FEATURES = new Set([
  "apps",
  "code_mode",
  "code_mode_only",
  "current_time_reminder",
  "deferred_executor",
  "enable_fanout",
  "goals",
  "hooks",
  "image_generation",
  "memories",
  "multi_agent",
  "multi_agent_v2",
  "plugins",
  "standalone_web_search",
  "token_budget",
]);

const CODEX_RING_ZERO_OVERRIDABLE_LAYER_TYPES = new Set([
  "mdm",
  "system",
  "enterpriseManaged",
  "user",
  "project",
  "sessionFlags",
]);

export function buildThreadStartParams(
  params: EmbeddedRunAttemptParams,
  options: {
    cwd: string;
    dynamicTools: CodexDynamicToolSpec[];
    appServer: CodexAppServerRuntimeOptions;
    developerInstructions?: string;
    config?: JsonObject;
    nativeCodeModeEnabled?: boolean;
    nativeProviderWebSearchSupport?: CodexNativeWebSearchSupport;
    nativeCodeModeOnlyEnabled?: boolean;
    webSearchAllowed?: boolean;
    environmentSelection?: CodexTurnEnvironmentParams[];
    model?: string | null;
    modelProvider?: string | null;
    hostSystemAgentActive?: boolean;
    ringZeroInheritedMcpServerNames?: readonly string[];
  },
): CodexThreadStartParams {
  const ringZeroActive =
    (options.hostSystemAgentActive ?? isHostScopedAgentToolActive("openclaw")) &&
    isSystemAgentOnlyCodexDynamicToolAllowlist(params.toolsAllow);
  const resolvedModelProvider = resolveCodexAppServerModelProvider({
    provider: params.provider,
    authProfileId: params.authProfileId,
    authProfileStore: params.authProfileStore,
    agentDir: params.agentDir,
    config: params.config,
  });
  const modelSelection = resolveCodexAppServerRequestModelSelection({
    model: options.model ?? params.modelId,
    modelProvider: options.modelProvider ?? resolvedModelProvider,
    authProfileId: params.authProfileId,
    authProfileStore: params.authProfileStore,
    agentDir: params.agentDir,
    config: params.config,
  });
  return {
    model: modelSelection.model,
    ...(modelSelection.modelProvider ? { modelProvider: modelSelection.modelProvider } : {}),
    cwd: options.cwd,
    approvalPolicy: options.appServer.approvalPolicy,
    approvalsReviewer: resolveCodexThreadApprovalsReviewer(options.appServer, options.config),
    ...codexThreadSandboxOrPermissions(options.appServer),
    ...(options.appServer.serviceTier !== undefined
      ? { serviceTier: options.appServer.serviceTier }
      : {}),
    personality: CODEX_NATIVE_PERSONALITY_NONE,
    serviceName: "OpenClaw",
    ...(ringZeroActive ? { baseInstructions: CODEX_RING_ZERO_BASE_INSTRUCTIONS } : {}),
    config: buildCodexRuntimeThreadConfigForRun(params, options.config, {
      nativeCodeModeEnabled: options.nativeCodeModeEnabled,
      nativeProviderWebSearchSupport: options.nativeProviderWebSearchSupport,
      nativeCodeModeOnlyEnabled: options.nativeCodeModeOnlyEnabled,
      directOnlyToolNamespaces: resolveDirectOnlyToolNamespaces(options.dynamicTools),
      webSearchAllowed: options.webSearchAllowed,
      appServer: options.appServer,
      hostSystemAgentActive: options.hostSystemAgentActive,
      ringZeroInheritedMcpServerNames: options.ringZeroInheritedMcpServerNames,
    }),
    ...resolveCodexThreadEnvironmentSelection(options),
    developerInstructions:
      options.developerInstructions ??
      buildDeveloperInstructions(params, { dynamicTools: options.dynamicTools }),
    // Canonical typed specs (`type: "function" | "namespace"`); the 0.142 floor
    // accepts them natively (codex-rs normalize_dynamic_tool_specs).
    dynamicTools: [...options.dynamicTools],
    experimentalRawEvents: true,
  };
}

export function buildThreadResumeParams(
  params: EmbeddedRunAttemptParams,
  options: {
    threadId: string;
    authProfileId?: string;
    modelProvider?: string | null;
    appServer: CodexAppServerRuntimeOptions;
    dynamicTools?: CodexDynamicToolSpec[];
    developerInstructions?: string;
    config?: JsonObject;
    nativeCodeModeEnabled?: boolean;
    nativeProviderWebSearchSupport?: CodexNativeWebSearchSupport;
    nativeCodeModeOnlyEnabled?: boolean;
    webSearchAllowed?: boolean;
    model?: string | null;
    hostSystemAgentActive?: boolean;
    ringZeroInheritedMcpServerNames?: readonly string[];
    preserveNativeModel?: boolean;
  },
): CodexThreadResumeParams {
  const modelSelection = options.preserveNativeModel
    ? undefined
    : resolveCodexAppServerRequestModelSelection({
        model: options.model ?? params.modelId,
        modelProvider:
          options.modelProvider ??
          resolveCodexAppServerModelProvider({
            provider: params.provider,
            authProfileId: options.authProfileId ?? params.authProfileId,
            authProfileStore: params.authProfileStore,
            agentDir: params.agentDir,
            config: params.config,
          }),
        authProfileId: options.authProfileId ?? params.authProfileId,
        authProfileStore: params.authProfileStore,
        agentDir: params.agentDir,
        config: params.config,
      });
  return {
    threadId: options.threadId,
    ...(modelSelection
      ? {
          model: modelSelection.model,
          ...(modelSelection.modelProvider ? { modelProvider: modelSelection.modelProvider } : {}),
        }
      : {}),
    approvalPolicy: options.appServer.approvalPolicy,
    approvalsReviewer: resolveCodexThreadApprovalsReviewer(options.appServer, options.config),
    ...codexThreadSandboxOrPermissions(options.appServer),
    ...(options.appServer.serviceTier !== undefined
      ? { serviceTier: options.appServer.serviceTier }
      : {}),
    personality: CODEX_NATIVE_PERSONALITY_NONE,
    config: buildCodexRuntimeThreadConfigForRun(params, options.config, {
      nativeCodeModeEnabled: options.nativeCodeModeEnabled,
      nativeProviderWebSearchSupport: options.nativeProviderWebSearchSupport,
      nativeCodeModeOnlyEnabled: options.nativeCodeModeOnlyEnabled,
      directOnlyToolNamespaces: resolveDirectOnlyToolNamespaces(options.dynamicTools),
      webSearchAllowed: options.webSearchAllowed,
      appServer: options.appServer,
      hostSystemAgentActive: options.hostSystemAgentActive,
      ringZeroInheritedMcpServerNames: options.ringZeroInheritedMcpServerNames,
    }),
    developerInstructions:
      options.developerInstructions ??
      buildDeveloperInstructions(params, { dynamicTools: options.dynamicTools }),
  };
}

export function buildCodexRuntimeThreadConfig(
  config: JsonObject | undefined,
  options: {
    nativeCodeModeEnabled?: boolean;
    nativeCodeModeOnlyEnabled?: boolean;
    directOnlyToolNamespaces?: readonly string[];
  } = {},
): JsonObject {
  const codeModeConfig: JsonObject = {
    ...CODEX_CODE_MODE_THREAD_CONFIG,
    "features.code_mode_only": options.nativeCodeModeOnlyEnabled === true,
  };
  if (options.nativeCodeModeEnabled === false) {
    const disabledConfig = mergeCodexThreadConfigs(
      config,
      CODEX_CODE_MODE_DISABLED_THREAD_CONFIG,
    ) ?? {
      ...CODEX_CODE_MODE_DISABLED_THREAD_CONFIG,
    };
    // Native patch streaming is part of native code mode, so do not send it
    // when runtime policy disables that tool surface.
    delete disabledConfig["features.apply_patch_streaming_events"];
    return disabledConfig;
  }
  if (options.nativeCodeModeOnlyEnabled === true) {
    const merged = mergeCodexThreadConfigs(codeModeConfig, config, {
      "features.code_mode_only": true,
    }) ?? {
      ...codeModeConfig,
      "features.code_mode_only": true,
    };
    return ensureDirectOnlyToolNamespaces(merged, options.directOnlyToolNamespaces);
  }
  const merged = mergeCodexThreadConfigs(codeModeConfig, config) ?? {
    ...codeModeConfig,
  };
  return ensureDirectOnlyToolNamespaces(merged, options.directOnlyToolNamespaces);
}

function ensureDirectOnlyToolNamespaces(
  config: JsonObject,
  requiredNamespaces: readonly string[] | undefined,
): JsonObject {
  if (!requiredNamespaces?.length) {
    return config;
  }
  const configured = config["code_mode.direct_only_tool_namespaces"];
  const namespaces = Array.isArray(configured)
    ? configured.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
  return {
    ...config,
    "code_mode.direct_only_tool_namespaces": [...new Set([...namespaces, ...requiredNamespaces])],
  };
}

function resolveDirectOnlyToolNamespaces(
  dynamicTools: readonly CodexDynamicToolSpec[] | undefined,
): string[] {
  return (dynamicTools ?? [])
    .filter(
      (tool) =>
        tool.type === "namespace" && tool.name === CODEX_OPENCLAW_DIRECT_DYNAMIC_TOOL_NAMESPACE,
    )
    .map((tool) => tool.name);
}

export function buildCodexRuntimeThreadConfigForRun(
  params: EmbeddedRunAttemptParams,
  config: JsonObject | undefined,
  options: {
    nativeCodeModeEnabled?: boolean;
    nativeProviderWebSearchSupport?: CodexNativeWebSearchSupport;
    nativeCodeModeOnlyEnabled?: boolean;
    directOnlyToolNamespaces?: readonly string[];
    webSearchAllowed?: boolean;
    appServer?: Pick<CodexAppServerRuntimeOptions, "networkProxy">;
    hostSystemAgentActive?: boolean;
    ringZeroInheritedMcpServerNames?: readonly string[];
  } = {},
): JsonObject {
  const ringZeroActive =
    (options.hostSystemAgentActive ?? isHostScopedAgentToolActive("openclaw")) &&
    isSystemAgentOnlyCodexDynamicToolAllowlist(params.toolsAllow);
  const configMcpServers = config?.mcp_servers;
  if (ringZeroActive && configMcpServers !== undefined && !isJsonObject(configMcpServers)) {
    throw new Error("Codex ring-zero received invalid thread mcp_servers config");
  }
  const ringZeroMcpServerNames = [
    ...(options.ringZeroInheritedMcpServerNames ?? []),
    ...(isJsonObject(configMcpServers) ? Object.keys(configMcpServers) : []),
  ];
  const webSearchConfig = resolveCodexWebSearchPlan({
    config: params.config,
    disableTools: params.disableTools,
    nativeToolSurfaceEnabled: options.nativeCodeModeEnabled,
    nativeProviderWebSearchSupport: options.nativeProviderWebSearchSupport,
    webSearchAllowed: options.webSearchAllowed,
  }).threadConfig;
  const baseConfig = buildCodexRuntimeThreadConfig(
    mergeCodexThreadConfigs(config, webSearchConfig),
    options,
  );
  const runtimeConfig =
    mergeCodexThreadConfigs(
      baseConfig,
      options.appServer?.networkProxy?.configPatch,
      shouldDisableCodexToolSearchForModel(params.modelId)
        ? CODEX_TOOL_SEARCH_UNSUPPORTED_THREAD_CONFIG
        : undefined,
      buildCodexRingZeroThreadConfigPatch(
        params,
        options.hostSystemAgentActive,
        ringZeroMcpServerNames,
      ),
    ) ?? baseConfig;
  if (params.bootstrapContextMode !== "lightweight") {
    return runtimeConfig;
  }
  return (
    mergeCodexThreadConfigs(runtimeConfig, CODEX_LIGHTWEIGHT_CONTEXT_THREAD_CONFIG) ?? {
      ...runtimeConfig,
      ...CODEX_LIGHTWEIGHT_CONTEXT_THREAD_CONFIG,
    }
  );
}

export function buildCodexRingZeroThreadConfigPatch(
  params: Pick<EmbeddedRunAttemptParams, "toolsAllow">,
  hostSystemAgentActive = isHostScopedAgentToolActive("openclaw"),
  inheritedMcpServerNames: readonly string[] = [],
): JsonObject | undefined {
  if (!hostSystemAgentActive || !isSystemAgentOnlyCodexDynamicToolAllowlist(params.toolsAllow)) {
    return undefined;
  }
  // Narrow OpenClaw allowlists already send environments: [] and disable
  // native code mode. Also remove every configurable Codex-owned tool source;
  // upstream still adds its inert update_plan utility unconditionally.
  const mcpServers = Object.fromEntries(
    [...new Set(inheritedMcpServerNames)].toSorted().map((name) => [name, { enabled: false }]),
  );
  return {
    ...CODEX_RING_ZERO_THREAD_CONFIG,
    ...(Object.keys(mcpServers).length > 0 ? { mcp_servers: mcpServers } : {}),
  };
}

export async function readCodexInheritedMcpServerNames(
  client: Pick<CodexAppServerClient, "request">,
  cwd: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const response: CodexConfigReadResponse = await client.request(
    "config/read",
    {
      cwd,
      includeLayers: true,
    },
    { signal },
  );
  if (!isJsonObject(response) || !isJsonObject(response.config)) {
    throw new Error("Codex config/read returned an invalid effective config");
  }
  if (!Array.isArray(response.layers)) {
    throw new Error("Codex config/read omitted effective config layers");
  }
  for (const layer of response.layers) {
    if (!isJsonObject(layer) || !isJsonObject(layer.name) || typeof layer.name.type !== "string") {
      throw new Error("Codex config/read returned invalid effective config layers");
    }
    if (
      layer.name.type === "legacyManagedConfigTomlFromFile" ||
      layer.name.type === "legacyManagedConfigTomlFromMdm"
    ) {
      throw new Error(`Codex ring-zero cannot override config layer ${layer.name.type}`);
    }
    if (!CODEX_RING_ZERO_OVERRIDABLE_LAYER_TYPES.has(layer.name.type)) {
      throw new Error(`Codex ring-zero does not recognize config layer ${layer.name.type}`);
    }
  }
  const configuredServers = response.config.mcp_servers;
  if (configuredServers === undefined) {
    return [];
  }
  if (!isJsonObject(configuredServers)) {
    throw new Error("Codex config/read returned invalid mcp_servers");
  }
  return Object.keys(configuredServers).toSorted();
}

export async function assertCodexRingZeroHasNoManagedHooks(
  client: Pick<CodexAppServerClient, "request">,
  signal?: AbortSignal,
): Promise<void> {
  const response: CodexConfigRequirementsReadResponse = await client.request(
    "configRequirements/read",
    undefined,
    { signal },
  );
  if (!isJsonObject(response) || !Object.hasOwn(response, "requirements")) {
    throw new Error("Codex configRequirements/read returned an invalid response");
  }
  if (response.requirements === null) {
    return;
  }
  if (!isJsonObject(response.requirements)) {
    throw new Error("Codex configRequirements/read returned invalid requirements");
  }
  for (const key of ["hooks", "managedHooks", "managed_hooks"] as const) {
    const hooks = response.requirements[key];
    if (hooks === undefined || hooks === null) {
      continue;
    }
    if (!isJsonObject(hooks)) {
      throw new Error("Codex configRequirements/read returned invalid managed hooks");
    }
    if (hasNonEmptyJsonValue(hooks)) {
      throw new Error("Codex ring-zero cannot override managed hooks");
    }
  }
  for (const key of ["featureRequirements", "feature_requirements"] as const) {
    const requirements = response.requirements[key];
    if (requirements === undefined || requirements === null) {
      continue;
    }
    if (!isJsonObject(requirements)) {
      throw new Error("Codex configRequirements/read returned invalid feature requirements");
    }
    for (const [feature, enabled] of Object.entries(requirements)) {
      if (typeof enabled !== "boolean") {
        throw new Error("Codex configRequirements/read returned invalid feature requirements");
      }
      if (enabled && CODEX_RING_ZERO_RESTRICTED_FEATURES.has(feature)) {
        throw new Error(`Codex ring-zero cannot override required feature ${feature}`);
      }
    }
  }
}

export async function attestCodexRingZeroThreadHasNoMcpServers(
  client: Pick<CodexAppServerClient, "request">,
  threadId: string,
  signal?: AbortSignal,
): Promise<void> {
  const response = await client.request(
    "mcpServerStatus/list",
    { threadId, limit: 1, detail: "toolsAndAuthOnly" },
    { signal },
  );
  if (!isJsonObject(response) || !Array.isArray(response.data)) {
    throw new Error("Codex mcpServerStatus/list returned an invalid ring-zero attestation");
  }
  if (response.data.length > 0) {
    const first = response.data[0];
    const serverName =
      isJsonObject(first) && typeof first.name === "string" ? first.name : "unknown";
    throw new Error(`Codex ring-zero MCP attestation found server ${serverName}`);
  }
  if (response.nextCursor !== undefined && response.nextCursor !== null) {
    throw new Error("Codex mcpServerStatus/list returned an invalid empty-page cursor");
  }
}

function hasNonEmptyJsonValue(value: JsonValue): boolean {
  if (value === null || value === false || value === "") {
    return false;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (typeof value === "object") {
    return Object.values(value).some(hasNonEmptyJsonValue);
  }
  return true;
}

export function resolveCodexThreadApprovalsReviewer(
  appServer: CodexAppServerRuntimeOptions,
  config?: JsonObject,
): CodexAppServerRuntimeOptions["approvalsReviewer"] {
  return config?.approvals_reviewer === "user" ? "user" : appServer.approvalsReviewer;
}

export function codexThreadSandboxOrPermissions(
  appServer: Pick<CodexAppServerRuntimeOptions, "networkProxy" | "sandbox">,
): Pick<CodexThreadStartParams, "sandbox"> {
  if (appServer.networkProxy) {
    return {};
  }
  return { sandbox: appServer.sandbox };
}

function resolveCodexThreadEnvironmentSelection(options: {
  nativeCodeModeEnabled?: boolean;
  environmentSelection?: CodexTurnEnvironmentParams[];
}): Pick<CodexThreadStartParams, "environments"> {
  if (options.nativeCodeModeEnabled === false) {
    return { environments: [] };
  }
  if (options.environmentSelection) {
    return { environments: options.environmentSelection };
  }
  return {};
}
