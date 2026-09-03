import crypto from "node:crypto";
import {
  isHostScopedAgentToolActive,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { isIncognitoSessionKey } from "../incognito-session.js";
import type { CodexAppServerClient } from "./client.js";
import { CODEX_SESSION_OVERRIDABLE_LAYER_TYPES } from "./config-layer-policy.js";
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
import { fingerprintJsonObject } from "./thread-fingerprints.js";
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

// Registry features can expose tools directly or re-enable their owning feature.
// One list owns both the thread deny patch and requirement pin rejection.
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
  "context_management",
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
  shellEnvironment?: Readonly<Record<string, string>>;
  disableLoginShell?: boolean;
};

/** Common deterministic start/resume/fork fields; no run resources or unsupported setters. */
export function buildCodexThreadConfiguration(
  params: CodexThreadConfigurationContext,
  options: CodexThreadConfigurationOptions,
) {
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

export function buildCodexRuntimeThreadConfigForRun(
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

export async function assertCodexManagedRequirementsDoNotOverrideToolPolicy(
  client: Pick<CodexAppServerClient, "request">,
  options: {
    restrictedToolSurface: boolean;
    additionalDeniedFeatures?: readonly string[];
    allowedManagedRequirementsFingerprint?: string;
    allowConfiguredManagedHooks?: boolean;
  },
  signal?: AbortSignal,
): Promise<void> {
  const requirements = await readCodexManagedRequirements(client, signal);
  const managedRequirementsFingerprint = buildCodexManagedRequirementsFingerprint(requirements);
  const managedRequirementsMatch =
    options.allowedManagedRequirementsFingerprint !== undefined &&
    managedRequirementsFingerprint === options.allowedManagedRequirementsFingerprint;
  const managedHooksAllowed =
    managedRequirementsMatch || options.allowConfiguredManagedHooks === true;
  if (options.allowedManagedRequirementsFingerprint !== undefined && !managedRequirementsMatch) {
    throw new Error(
      "Codex managed requirements changed since this automation was authorized; reauthorize the automation from a fresh owner turn",
    );
  }
  if (requirements === null) {
    return;
  }
  if (options.restrictedToolSurface) {
    for (const key of ["hooks", "managedHooks", "managed_hooks"] as const) {
      const hooks = requirements[key];
      if (hooks === undefined || hooks === null) {
        continue;
      }
      if (!isJsonObject(hooks)) {
        throw new Error("Codex configRequirements/read returned invalid managed hooks");
      }
      if (hasNonEmptyJsonValue(hooks) && !managedHooksAllowed) {
        throw new Error("Codex restricted tool surface cannot override managed hooks");
      }
    }
  }
  const additionalDeniedFeatures = new Set(options.additionalDeniedFeatures);
  for (const key of ["featureRequirements", "feature_requirements"] as const) {
    const featureRequirements = requirements[key];
    if (featureRequirements === undefined || featureRequirements === null) {
      continue;
    }
    if (!isJsonObject(featureRequirements)) {
      throw new Error("Codex configRequirements/read returned invalid feature requirements");
    }
    for (const [feature, enabled] of Object.entries(featureRequirements)) {
      if (typeof enabled !== "boolean") {
        throw new Error("Codex configRequirements/read returned invalid feature requirements");
      }
      const canonicalFeature = CODEX_RING_ZERO_RESTRICTED_FEATURE_ALIASES.get(feature) ?? feature;
      const deniedByToolPolicy =
        (options.restrictedToolSurface &&
          CODEX_RING_ZERO_RESTRICTED_FEATURES.has(canonicalFeature)) ||
        additionalDeniedFeatures.has(canonicalFeature);
      if (canonicalFeature === "hooks" && managedHooksAllowed) {
        continue;
      }
      if (enabled && deniedByToolPolicy) {
        throw new Error(`Codex tool policy cannot override required feature ${feature}`);
      }
    }
  }
}

/** Hashes the exact managed requirements without retaining their hook commands or policy details. */
function buildCodexManagedRequirementsFingerprint(requirements: JsonObject | null): string {
  const fingerprint = fingerprintJsonObject({ version: 1, requirements });
  return crypto.createHash("sha256").update(fingerprint).digest("hex");
}

/** Reads and fingerprints the exact managed requirements active on this app-server. */
export async function readCodexManagedRequirementsFingerprint(
  client: Pick<CodexAppServerClient, "request">,
  signal?: AbortSignal,
): Promise<string> {
  return buildCodexManagedRequirementsFingerprint(
    await readCodexManagedRequirements(client, signal),
  );
}

async function readCodexManagedRequirements(
  client: Pick<CodexAppServerClient, "request">,
  signal?: AbortSignal,
): Promise<JsonObject | null> {
  const response: CodexConfigRequirementsReadResponse = await client.request(
    "configRequirements/read",
    undefined,
    { signal },
  );
  if (!isJsonObject(response) || !Object.hasOwn(response, "requirements")) {
    throw new Error("Codex configRequirements/read returned an invalid response");
  }
  if (response.requirements !== null && !isJsonObject(response.requirements)) {
    throw new Error("Codex configRequirements/read returned invalid requirements");
  }
  return response.requirements;
}

export { attestCodexRestrictedToolSurfaceMcpServersDisabled } from "./thread-mcp-attestation.js";

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
