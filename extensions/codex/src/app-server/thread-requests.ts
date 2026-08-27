import {
  isHostScopedAgentToolActive,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { isIncognitoSessionKey } from "../incognito-session.js";
import type { CodexAppServerClient } from "./client.js";
import type { CodexAppServerRuntimeOptions } from "./config.js";
import {
  isMessageOnlyCodexSourceReply,
  isSystemAgentOnlyCodexDynamicToolAllowlist,
  shouldDisableCodexToolSearchForModel,
} from "./dynamic-tool-profile.js";
import { mergeCodexThreadConfigs } from "./plugin-thread-config.js";
import { buildCodexProjectDocThreadConfig } from "./project-doc-thread-config.js";
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
import { applyCodexManagedShellEnvironment } from "./thread-shell-environment.js";
import { resolveCodexWebSearchPlan, type CodexNativeWebSearchSupport } from "./web-search.js";

export const CODEX_RING_ZERO_BASE_INSTRUCTIONS = "";

// Stream structured patch snapshots so large generated edits keep the turn active.
// OpenClaw opts into these under-development features deliberately, so silence
// Codex's chat warning that tells operators to edit the managed codex-home config.
const CODEX_CODE_MODE_THREAD_CONFIG: JsonObject = {
  "features.code_mode": true,
  "features.code_mode_only": false,
  "features.apply_patch_streaming_events": true,
  suppress_unstable_features_warning: true,
};

const CODEX_GOAL_CONTINUATION_DISABLED_THREAD_CONFIG: JsonObject = {
  "features.goals": false,
};

const CODEX_NATIVE_UPDATE_PLAN_DISABLED_THREAD_CONFIG: JsonObject = {
  // OpenClaw owns the durable progress card; Codex's native checklist would create a second owner.
  "tools.update_plan.enabled": false,
};

const CODEX_CODE_MODE_DISABLED_THREAD_CONFIG: JsonObject = {
  "features.code_mode": false,
  "features.code_mode_only": false,
};

const CODEX_NO_PROJECT_DOCS_CONFIG: JsonObject = {
  project_doc_max_bytes: 0,
};

const CODEX_TOOL_SEARCH_UNSUPPORTED_THREAD_CONFIG: JsonObject = {
  "features.multi_agent": false,
};

const CODEX_DELEGATION_DISABLED_THREAD_CONFIG: JsonObject = {
  "agents.enabled": false,
  "features.multi_agent": false,
  "features.multi_agent_v2": false,
};

// Exact Codex 0.149 registry features that can expose a model-visible tool or
// host capability. One list owns both the thread deny patch and requirement pin rejection.
const CODEX_RING_ZERO_RESTRICTED_FEATURES = new Set([
  "apps",
  "artifact",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "chronicle",
  "code_mode",
  "code_mode_only",
  "computer_use",
  "current_time_reminder",
  "default_mode_request_user_input",
  "deferred_executor",
  "goals",
  "hooks",
  "image_generation",
  "memories",
  "multi_agent",
  "multi_agent_v2",
  "plugins",
  "request_permissions_tool",
  "skill_search",
  "shell_tool",
  "standalone_web_search",
  "token_budget",
  "unified_exec",
  "view_image",
  "web_search_cached",
  "web_search_request",
  "workspace_dependencies",
]);

const CODEX_RING_ZERO_THREAD_CONFIG: JsonObject = {
  ...CODEX_DELEGATION_DISABLED_THREAD_CONFIG,
  ...Object.fromEntries(
    [...CODEX_RING_ZERO_RESTRICTED_FEATURES].map((feature) => [`features.${feature}`, false]),
  ),
  "orchestrator.mcp.enabled": false,
  "orchestrator.skills.enabled": false,
  "skills.bundled.enabled": false,
  "skills.include_instructions": false,
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
  notify: [],
  web_search: "disabled",
};

const CODEX_RING_ZERO_RESTRICTED_FEATURE_ALIASES = new Map<string, string>([
  ["connectors", "apps"],
  ["imagegenext", "image_generation"],
  ["collab", "multi_agent"],
  ["memory_tool", "memories"],
  ["telepathy", "chronicle"],
  ["codex_hooks", "hooks"],
]);

const CODEX_RING_ZERO_OVERRIDABLE_LAYER_TYPES = new Set([
  "packagedDefaults",
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
    restrictedToolSurfaceInheritedMcpServerNames?: readonly string[];
    shellEnvironment?: Readonly<Record<string, string>>;
    disableLoginShell?: boolean;
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
    ...(options.appServer.sessionRoot
      ? { runtimeWorkspaceRoots: [options.appServer.sessionRoot] }
      : {}),
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
      restrictedToolSurfaceInheritedMcpServerNames:
        options.restrictedToolSurfaceInheritedMcpServerNames,
      shellEnvironment: options.shellEnvironment,
      disableLoginShell: options.disableLoginShell,
    }),
    ...resolveCodexThreadEnvironmentSelection(options),
    developerInstructions:
      options.developerInstructions ??
      buildDeveloperInstructions(params, { dynamicTools: options.dynamicTools }),
    // Codex 0.146 accepts canonical typed function and namespace specs natively.
    dynamicTools: [...options.dynamicTools],
    experimentalRawEvents: true,
    // Codex `ephemeral` skips rollout/state DB writes while loaded threads remain reusable
    // (`codex-rs/app-server-protocol/src/protocol/v2/thread.rs:108`;
    // `codex-rs/core/src/session/session.rs:599-683`, `thread_manager.rs:1157-1163`).
    ...(isIncognitoSessionKey(params.sessionKey) ? { ephemeral: true } : {}),
  };
}

export function buildThreadResumeParams(
  params: EmbeddedRunAttemptParams,
  options: {
    threadId: string;
    cwd?: string;
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
    restrictedToolSurfaceInheritedMcpServerNames?: readonly string[];
    shellEnvironment?: Readonly<Record<string, string>>;
    disableLoginShell?: boolean;
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
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.appServer.sessionRoot
      ? { runtimeWorkspaceRoots: [options.appServer.sessionRoot] }
      : {}),
    // Only the latest turn id/status is needed to preserve active-turn conflict
    // handling; avoid rebuilding and validating the full persisted history.
    excludeTurns: true,
    initialTurnsPage: {
      limit: 1,
      sortDirection: "desc",
      itemsView: "notLoaded",
    },
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
      restrictedToolSurfaceInheritedMcpServerNames:
        options.restrictedToolSurfaceInheritedMcpServerNames,
      shellEnvironment: options.shellEnvironment,
      disableLoginShell: options.disableLoginShell,
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
  const configured = buildCodexProjectDocThreadConfig(config);
  // Native goal RPCs remain available through app-server, but the Codex goals
  // feature also starts autonomous turns. Keep it disabled until a run owner exists.
  const codeModeConfig: JsonObject = {
    ...CODEX_CODE_MODE_THREAD_CONFIG,
    "features.code_mode_only": options.nativeCodeModeOnlyEnabled === true,
  };
  if (options.nativeCodeModeEnabled === false) {
    const disabledConfig = mergeCodexThreadConfigs(
      configured,
      CODEX_CODE_MODE_DISABLED_THREAD_CONFIG,
      CODEX_GOAL_CONTINUATION_DISABLED_THREAD_CONFIG,
      CODEX_NATIVE_UPDATE_PLAN_DISABLED_THREAD_CONFIG,
    ) ?? {
      ...CODEX_CODE_MODE_DISABLED_THREAD_CONFIG,
      ...CODEX_GOAL_CONTINUATION_DISABLED_THREAD_CONFIG,
      ...CODEX_NATIVE_UPDATE_PLAN_DISABLED_THREAD_CONFIG,
    };
    // Native patch streaming is part of native code mode, so do not send it
    // when runtime policy disables that tool surface.
    delete disabledConfig["features.apply_patch_streaming_events"];
    return disabledConfig;
  }
  if (options.nativeCodeModeOnlyEnabled === true) {
    const merged = mergeCodexThreadConfigs(
      codeModeConfig,
      configured,
      CODEX_GOAL_CONTINUATION_DISABLED_THREAD_CONFIG,
      CODEX_NATIVE_UPDATE_PLAN_DISABLED_THREAD_CONFIG,
      {
        "features.code_mode_only": true,
      },
    ) ?? {
      ...codeModeConfig,
      ...CODEX_GOAL_CONTINUATION_DISABLED_THREAD_CONFIG,
      ...CODEX_NATIVE_UPDATE_PLAN_DISABLED_THREAD_CONFIG,
      "features.code_mode_only": true,
    };
    return ensureDirectOnlyToolNamespaces(merged, options.directOnlyToolNamespaces);
  }
  const merged = mergeCodexThreadConfigs(
    codeModeConfig,
    configured,
    CODEX_GOAL_CONTINUATION_DISABLED_THREAD_CONFIG,
    CODEX_NATIVE_UPDATE_PLAN_DISABLED_THREAD_CONFIG,
  ) ?? {
    ...codeModeConfig,
    ...CODEX_GOAL_CONTINUATION_DISABLED_THREAD_CONFIG,
    ...CODEX_NATIVE_UPDATE_PLAN_DISABLED_THREAD_CONFIG,
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
    restrictedToolSurfaceInheritedMcpServerNames?: readonly string[];
    shellEnvironment?: Readonly<Record<string, string>>;
    disableLoginShell?: boolean;
  } = {},
): JsonObject {
  const ringZeroActive =
    (options.hostSystemAgentActive ?? isHostScopedAgentToolActive("openclaw")) &&
    isSystemAgentOnlyCodexDynamicToolAllowlist(params.toolsAllow);
  const messageOnlySourceReply = isMessageOnlyCodexSourceReply(params);
  const restrictedToolSurface =
    ringZeroActive || messageOnlySourceReply || params.pluginHarnessToolPolicyRestricted === true;
  const restrictedTurnDisablesProjectDocs =
    ringZeroActive ||
    messageOnlySourceReply ||
    (params.pluginHarnessToolPolicyRestricted && params.disableTools);
  const configMcpServers = config?.mcp_servers;
  if (restrictedToolSurface && configMcpServers !== undefined && !isJsonObject(configMcpServers)) {
    throw new Error("Codex restricted tool surface received invalid thread mcp_servers config");
  }
  const restrictedToolSurfaceMcpServerNames = [
    ...(options.restrictedToolSurfaceInheritedMcpServerNames ?? []),
    ...(isJsonObject(configMcpServers) ? Object.keys(configMcpServers) : []),
  ];
  // Per-thread configs deep-merge; drop server launch details before the
  // final disabled-server patch so a delivery turn cannot retain MCP access.
  const restrictedRunConfig =
    restrictedToolSurface && isJsonObject(configMcpServers)
      ? { ...config, mcp_servers: {} }
      : config;
  const webSearchConfig = resolveCodexWebSearchPlan({
    config: params.config,
    disableTools: params.disableTools,
    nativeToolSurfaceEnabled: options.nativeCodeModeEnabled,
    nativeProviderWebSearchSupport: options.nativeProviderWebSearchSupport,
    webSearchAllowed: options.webSearchAllowed,
  }).threadConfig;
  const baseConfig = buildCodexRuntimeThreadConfig(
    mergeCodexThreadConfigs(restrictedRunConfig, webSearchConfig),
    options,
  );
  const runtimeConfig =
    mergeCodexThreadConfigs(
      baseConfig,
      options.appServer?.networkProxy?.configPatch,
      params.pluginHarnessToolPolicySafeDeniedTools?.includes("image_generate")
        ? { "features.image_generation": false }
        : undefined,
      shouldDisableCodexToolSearchForModel(params.modelId)
        ? CODEX_TOOL_SEARCH_UNSUPPORTED_THREAD_CONFIG
        : undefined,
      params.delegationCapability === "report_only"
        ? CODEX_DELEGATION_DISABLED_THREAD_CONFIG
        : undefined,
      messageOnlySourceReply || params.pluginHarnessToolPolicyRestricted === true
        ? buildRestrictedToolConfigPatch(restrictedToolSurfaceMcpServerNames)
        : buildCodexRingZeroThreadConfigPatch(
            params,
            options.hostSystemAgentActive,
            restrictedToolSurfaceMcpServerNames,
          ),
      restrictedTurnDisablesProjectDocs ? CODEX_NO_PROJECT_DOCS_CONFIG : undefined,
      params.authoredContextTokenCap === undefined
        ? undefined
        : { model_context_window: params.authoredContextTokenCap },
    ) ?? baseConfig;
  const contextConfig = {
    ...runtimeConfig,
    ...(params.bootstrapContextMode === "lightweight" ? CODEX_NO_PROJECT_DOCS_CONFIG : {}),
  };
  return applyCodexManagedShellEnvironment(
    contextConfig,
    options.shellEnvironment,
    options.disableLoginShell,
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
  return {
    ...buildRestrictedToolConfigPatch(inheritedMcpServerNames),
    ...CODEX_NO_PROJECT_DOCS_CONFIG,
  };
}

function buildRestrictedToolConfigPatch(inheritedMcpServerNames: readonly string[]): JsonObject {
  // Restricted turns already send environments: [] and disable native code mode.
  // Remove Codex-owned tool sources here; project-document suppression belongs to
  // ring-zero, message-only, and tool-disabled context policy at the caller.
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
      throw new Error(
        `Codex restricted tool surface cannot override config layer ${layer.name.type}`,
      );
    }
    if (!CODEX_RING_ZERO_OVERRIDABLE_LAYER_TYPES.has(layer.name.type)) {
      throw new Error(
        `Codex restricted tool surface does not recognize config layer ${layer.name.type}`,
      );
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

export async function assertCodexManagedRequirementsDoNotOverrideToolPolicy(
  client: Pick<CodexAppServerClient, "request">,
  options: {
    restrictedToolSurface: boolean;
    additionalDeniedFeatures?: readonly string[];
  },
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
  if (options.restrictedToolSurface) {
    for (const key of ["hooks", "managedHooks", "managed_hooks"] as const) {
      const hooks = response.requirements[key];
      if (hooks === undefined || hooks === null) {
        continue;
      }
      if (!isJsonObject(hooks)) {
        throw new Error("Codex configRequirements/read returned invalid managed hooks");
      }
      if (hasNonEmptyJsonValue(hooks)) {
        throw new Error("Codex restricted tool surface cannot override managed hooks");
      }
    }
  }
  const additionalDeniedFeatures = new Set(options.additionalDeniedFeatures);
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
      const canonicalFeature = CODEX_RING_ZERO_RESTRICTED_FEATURE_ALIASES.get(feature) ?? feature;
      const deniedByToolPolicy =
        (options.restrictedToolSurface &&
          CODEX_RING_ZERO_RESTRICTED_FEATURES.has(canonicalFeature)) ||
        additionalDeniedFeatures.has(canonicalFeature);
      if (enabled && deniedByToolPolicy) {
        throw new Error(`Codex tool policy cannot override required feature ${feature}`);
      }
    }
  }
}

export async function attestCodexRestrictedToolSurfaceMcpServersDisabled(
  client: Pick<CodexAppServerClient, "request">,
  threadId: string,
  threadConfig: JsonObject | undefined,
  signal?: AbortSignal,
): Promise<void> {
  const configuredServers = threadConfig?.mcp_servers;
  if (configuredServers !== undefined && !isJsonObject(configuredServers)) {
    throw new Error("Codex restricted-tool-surface thread config has invalid mcp_servers");
  }
  // Codex reports configured-but-disabled servers as inactive status rows.
  // Match those rows to the exact per-thread deny patch instead of requiring an empty inventory.
  const expectedDisabledServerNames = new Set<string>();
  for (const [name, serverConfig] of Object.entries(configuredServers ?? {})) {
    if (!isJsonObject(serverConfig) || serverConfig.enabled !== false) {
      throw new Error(`Codex restricted-tool-surface MCP server ${name} is not disabled`);
    }
    expectedDisabledServerNames.add(name);
  }
  const response = await client.request(
    "mcpServerStatus/list",
    { threadId, detail: "toolsAndAuthOnly" },
    { signal },
  );
  if (!isJsonObject(response) || !Array.isArray(response.data)) {
    throw new Error(
      "Codex mcpServerStatus/list returned an invalid restricted-tool-surface attestation",
    );
  }
  const observedDisabledServerNames = new Set<string>();
  for (const status of response.data) {
    if (!isJsonObject(status) || typeof status.name !== "string" || !isJsonObject(status.tools)) {
      throw new Error(
        "Codex mcpServerStatus/list returned an invalid restricted-tool-surface server",
      );
    }
    if (!expectedDisabledServerNames.has(status.name)) {
      throw new Error(
        `Codex restricted-tool-surface MCP attestation found unexpected server ${status.name}`,
      );
    }
    if (observedDisabledServerNames.has(status.name)) {
      throw new Error(
        `Codex restricted-tool-surface MCP attestation returned duplicate server ${status.name}`,
      );
    }
    observedDisabledServerNames.add(status.name);
    if (!Object.hasOwn(status, "serverInfo")) {
      throw new Error(
        `Codex restricted-tool-surface MCP attestation returned malformed server ${status.name}`,
      );
    }
    if (status.serverInfo !== null) {
      throw new Error(
        `Codex restricted-tool-surface MCP attestation found active server ${status.name}`,
      );
    }
    if (Object.keys(status.tools).length > 0) {
      throw new Error(
        `Codex restricted-tool-surface MCP attestation found tools for server ${status.name}`,
      );
    }
  }
  for (const expectedName of expectedDisabledServerNames) {
    if (!observedDisabledServerNames.has(expectedName)) {
      throw new Error(
        `Codex restricted-tool-surface MCP attestation is missing server ${expectedName}`,
      );
    }
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
