import {
  isHostScopedAgentToolActive,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { isIncognitoSessionKey } from "../incognito-session.js";
import type { CodexAppServerClient } from "./client.js";
import {
  CODEX_SESSION_OVERRIDABLE_LAYER_TYPES,
  readCodexEffectiveConfig,
} from "./config-layer-policy.js";
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
  type CodexDynamicToolSpec,
  type CodexThreadResumeParams,
  type CodexThreadStartParams,
  type CodexTurnEnvironmentParams,
  type JsonObject,
} from "./protocol.js";
import { CODEX_RING_ZERO_RESTRICTED_FEATURES } from "./thread-managed-requirements.js";
import {
  CODEX_NATIVE_PERSONALITY_NONE,
  resolveCodexAppServerModelProvider,
  resolveCodexAppServerRequestModelSelection,
} from "./thread-model-selection.js";
import { buildDeveloperInstructions, type CodexThreadPromptContext } from "./thread-prompt.js";
import { applyCodexManagedShellEnvironment } from "./thread-shell-environment.js";
import { resolveCodexWebSearchPlan, type CodexNativeWebSearchSupport } from "./web-search.js";

export const CODEX_RING_ZERO_BASE_INSTRUCTIONS = "";

// Stream structured patch snapshots so large generated edits keep the turn active.
// OpenClaw opts into these under-development features deliberately, so silence
// Codex's chat warning that tells operators to edit the managed codex-home config.
const CODEX_CODE_MODE_THREAD_CONFIG: JsonObject = {
  "features.code_mode": true,
  "features.code_mode_only": false,
  // Native code mode replaces OpenClaw's own exec/read/write/edit tools with the
  // Codex shell, and cron creator caps project read/exec on the same premise, so
  // request the shell explicitly instead of relying on the codex-home default.
  "features.shell_tool": true,
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
    SessionEnd: [],
    UserPromptSubmit: [],
    SubagentStart: [],
    SubagentStop: [],
    Stop: [],
    Interrupt: [],
  },
  notify: [],
  web_search: "disabled",
};

export type CodexThreadConfigurationContext = CodexThreadPromptContext &
  Pick<
    EmbeddedRunAttemptParams,
    | "pluginHarnessToolPolicyRestricted"
    | "pluginHarnessToolPolicySafeDeniedTools"
    | "authoredContextTokenCap"
    | "bootstrapContextMode"
    | "scheduledRuntimeAuthority"
  >;

type CodexThreadConfigurationOptions = {
  requireProtectedNativeContext?: boolean;
  cwd?: string;
  dynamicTools?: CodexDynamicToolSpec[];
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
  managedHooksConfig?: JsonObject;
  shellEnvironment?: Readonly<Record<string, string>>;
  disableLoginShell?: boolean;
};

/** Common deterministic start/resume/fork fields; no run resources or unsupported setters. */
export function buildCodexThreadConfiguration(
  params: CodexThreadConfigurationContext,
  options: CodexThreadConfigurationOptions,
) {
  if (options.requireProtectedNativeContext && !options.cwd) {
    throw new Error("Codex protected native context requires the execution workspace");
  }
  return {
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.appServer.sessionRoot
      ? { runtimeWorkspaceRoots: [options.appServer.sessionRoot] }
      : {}),
    approvalPolicy: options.appServer.approvalPolicy,
    approvalsReviewer: resolveCodexThreadApprovalsReviewer(options.appServer, options.config),
    ...codexThreadSandboxOrPermissions(options.appServer),
    ...(options.appServer.serviceTier !== undefined
      ? { serviceTier: options.appServer.serviceTier }
      : {}),
    config: {
      ...buildCodexRuntimeThreadConfigForRun(params, options.config, {
        nativeCodeModeEnabled: options.nativeCodeModeEnabled,
        nativeProviderWebSearchSupport: options.nativeProviderWebSearchSupport,
        nativeCodeModeOnlyEnabled: options.nativeCodeModeOnlyEnabled,
        directOnlyToolNamespaces: resolveDirectOnlyToolNamespaces(options.dynamicTools),
        webSearchAllowed: options.webSearchAllowed,
        appServer: options.appServer,
        hostSystemAgentActive: options.hostSystemAgentActive,
        restrictedToolSurfaceInheritedMcpServerNames:
          options.restrictedToolSurfaceInheritedMcpServerNames,
        managedHooksConfig: options.managedHooksConfig,
        shellEnvironment: options.shellEnvironment,
        disableLoginShell: options.disableLoginShell,
      }),
      ...(options.requireProtectedNativeContext && options.cwd
        ? {
            project_root_markers: [],
            projects: { [options.cwd]: { trust_level: "untrusted" } },
          }
        : {}),
    },
    developerInstructions:
      options.developerInstructions ??
      buildDeveloperInstructions(params, { dynamicTools: options.dynamicTools }),
  };
}

export function buildThreadStartParams(
  params: EmbeddedRunAttemptParams,
  options: CodexThreadConfigurationOptions & { cwd: string; dynamicTools: CodexDynamicToolSpec[] },
): CodexThreadStartParams {
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
    ...buildCodexThreadConfiguration(params, options),
    ...((options.hostSystemAgentActive ?? isHostScopedAgentToolActive("openclaw")) &&
    isSystemAgentOnlyCodexDynamicToolAllowlist(params.toolsAllow)
      ? { baseInstructions: CODEX_RING_ZERO_BASE_INSTRUCTIONS }
      : {}),
    personality: CODEX_NATIVE_PERSONALITY_NONE,
    serviceName: "OpenClaw",
    ...resolveCodexThreadEnvironmentSelection(options),
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
  options: CodexThreadConfigurationOptions & {
    threadId: string;
    authProfileId?: string;
    preserveNativeModel?: boolean;
  },
): CodexThreadResumeParams & { developerInstructions: string } {
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
    ...buildCodexThreadConfiguration(params, options),
    personality: CODEX_NATIVE_PERSONALITY_NONE,
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
    const disabledConfig = expectDefined(
      mergeCodexThreadConfigs(
        configured,
        CODEX_CODE_MODE_DISABLED_THREAD_CONFIG,
        CODEX_GOAL_CONTINUATION_DISABLED_THREAD_CONFIG,
        CODEX_NATIVE_UPDATE_PLAN_DISABLED_THREAD_CONFIG,
      ),
      "Codex disabled code mode config",
    );
    // Native patch streaming is part of native code mode, so do not send it
    // when runtime policy disables that tool surface.
    delete disabledConfig["features.apply_patch_streaming_events"];
    return disabledConfig;
  }
  if (options.nativeCodeModeOnlyEnabled === true) {
    const merged = expectDefined(
      mergeCodexThreadConfigs(
        codeModeConfig,
        configured,
        CODEX_GOAL_CONTINUATION_DISABLED_THREAD_CONFIG,
        CODEX_NATIVE_UPDATE_PLAN_DISABLED_THREAD_CONFIG,
        { "features.code_mode_only": true },
      ),
      "Codex code mode only config",
    );
    return ensureDirectOnlyToolNamespaces(merged, options.directOnlyToolNamespaces);
  }
  const merged = expectDefined(
    mergeCodexThreadConfigs(
      codeModeConfig,
      configured,
      CODEX_GOAL_CONTINUATION_DISABLED_THREAD_CONFIG,
      CODEX_NATIVE_UPDATE_PLAN_DISABLED_THREAD_CONFIG,
    ),
    "Codex code mode config",
  );
  return ensureDirectOnlyToolNamespaces(merged, options.directOnlyToolNamespaces);
}

function ensureDirectOnlyToolNamespaces(
  config: JsonObject,
  requiredNamespaces: readonly string[] | undefined,
): JsonObject {
  if (!requiredNamespaces?.length) {
    return config;
  }
  const feature = expectDefined(config["features.code_mode"], "Codex code mode config");
  const configured: JsonObject = isJsonObject(feature) ? feature : { enabled: feature };
  const namespaces = Array.isArray(configured.direct_only_tool_namespaces)
    ? configured.direct_only_tool_namespaces.filter(
        (entry): entry is string => typeof entry === "string" && entry.length > 0,
      )
    : [];
  return {
    ...config,
    // Codex reads this feature table, not a root code_mode table. One override
    // also avoids a boolean/child-path collision in its unordered request map.
    "features.code_mode": {
      ...configured,
      direct_only_tool_namespaces: [...new Set([...namespaces, ...requiredNamespaces])],
    },
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

function buildCodexRuntimeThreadConfigForRun(
  params: CodexThreadConfigurationContext,
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
    managedHooksConfig?: JsonObject;
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
  // Codex validates each transport before it applies `enabled`. Preserve the
  // transport here; the deny patch below disables it and attestation proves it stayed inactive.
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
        ? buildRestrictedToolConfigPatch(
            restrictedToolSurfaceMcpServerNames,
            Boolean(params.scheduledRuntimeAuthority),
          )
        : buildCodexRingZeroThreadConfigPatch(
            params,
            options.hostSystemAgentActive,
            restrictedToolSurfaceMcpServerNames,
          ),
      restrictedTurnDisablesProjectDocs ? CODEX_NO_PROJECT_DOCS_CONFIG : undefined,
      params.authoredContextTokenCap === undefined
        ? undefined
        : { model_context_window: params.authoredContextTokenCap },
      options.managedHooksConfig,
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

function buildRestrictedToolConfigPatch(
  inheritedMcpServerNames: readonly string[],
  scheduledAppAuthorityActive = false,
): JsonObject {
  // Restricted turns already send environments: [] and disable native code mode.
  // Remove Codex-owned tool sources here; project-document suppression belongs to
  // ring-zero, message-only, and tool-disabled context policy at the caller.
  const mcpServers = Object.fromEntries(
    [...new Set(inheritedMcpServerNames)].toSorted().map((name) => [name, { enabled: false }]),
  );
  return {
    ...CODEX_RING_ZERO_THREAD_CONFIG,
    ...(scheduledAppAuthorityActive
      ? {
          "features.apps": true,
          "orchestrator.mcp.enabled": true,
        }
      : {}),
    ...(Object.keys(mcpServers).length > 0 ? { mcp_servers: mcpServers } : {}),
  };
}

export async function readCodexInheritedMcpServerNames(
  client: Pick<CodexAppServerClient, "request">,
  cwd: string,
  signal?: AbortSignal,
  options: {
    effectiveConfig?: CodexConfigReadResponse;
    requireProtectedNativeContext?: boolean;
  } = {},
): Promise<string[]> {
  const response = options.effectiveConfig ?? (await readCodexEffectiveConfig(client, cwd, signal));
  if (
    options.requireProtectedNativeContext &&
    (!Array.isArray(response.config.project_root_markers) ||
      response.config.project_root_markers.length !== 0)
  ) {
    throw new Error("Codex protected native context requires effective project_root_markers=[]");
  }
  if (options.requireProtectedNativeContext) {
    const projects = response.config.projects;
    const workspace = isJsonObject(projects) ? projects[cwd] : undefined;
    if (!isJsonObject(workspace) || workspace.trust_level !== "untrusted") {
      throw new Error("Codex protected native context requires an effective untrusted workspace");
    }
  }
  if (!Array.isArray(response.layers)) {
    throw new Error("Codex config/read omitted effective config layers");
  }
  for (const layer of response.layers) {
    if (!isJsonObject(layer) || !isJsonObject(layer.name) || typeof layer.name.type !== "string") {
      throw new Error("Codex config/read returned invalid effective config layers");
    }
    if (
      options.requireProtectedNativeContext &&
      layer.name.type === "project" &&
      (typeof layer.disabledReason !== "string" || !layer.disabledReason.trim())
    ) {
      throw new Error(
        "Codex protected native context requires every project config layer to be disabled",
      );
    }
    if (
      layer.name.type === "legacyManagedConfigTomlFromFile" ||
      layer.name.type === "legacyManagedConfigTomlFromMdm"
    ) {
      const migrationGuidance =
        layer.name.type === "legacyManagedConfigTomlFromFile"
          ? 'migrate /etc/codex/managed_config.toml to /etc/codex/requirements.toml before running restricted or isolated turns. For ChatGPT-only authentication, use allowed_login_methods = ["chatgpt"] in /etc/codex/requirements.toml'
          : 'replace the legacy MDM payload with base64-encoded TOML requirements in the com.openai.codex managed preference requirements_toml_base64 before running restricted or isolated turns. For ChatGPT-only authentication, include allowed_login_methods = ["chatgpt"] in that TOML payload';
      throw new Error(
        `Codex restricted tool surface cannot override config layer ${layer.name.type}; ${migrationGuidance}.`,
      );
    }
    if (!CODEX_SESSION_OVERRIDABLE_LAYER_TYPES.has(layer.name.type)) {
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

export {
  assertCodexManagedRequirementsDoNotOverrideToolPolicy,
  readCodexManagedRequirementsFingerprint,
} from "./thread-managed-requirements.js";
export { attestCodexRestrictedToolSurfaceMcpServersDisabled } from "./thread-mcp-attestation.js";

function resolveCodexThreadApprovalsReviewer(
  appServer: CodexAppServerRuntimeOptions,
  config?: JsonObject,
): CodexAppServerRuntimeOptions["approvalsReviewer"] {
  return config?.approvals_reviewer === "user" ? "user" : appServer.approvalsReviewer;
}

function codexThreadSandboxOrPermissions(
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
