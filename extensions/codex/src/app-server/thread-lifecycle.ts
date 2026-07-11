// Codex plugin module implements thread lifecycle behavior.
import crypto from "node:crypto";
import {
  buildSkillWorkshopPromptSection,
  embeddedAgentLog,
  formatErrorMessage,
  isActiveHarnessContextEngine,
  isHostScopedAgentToolActive,
  SKILL_WORKSHOP_TOOL_NAME,
  type EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { buildCodexUserMcpServersThreadConfigPatchForRuntime } from "openclaw/plugin-sdk/codex-mcp-projection";
import { listRegisteredPluginAgentPromptGuidance } from "openclaw/plugin-sdk/plugin-runtime";
import { CODEX_GPT5_HEARTBEAT_PROMPT_OVERLAY } from "../../prompt-overlay.js";
import {
  isMaxReasoningCodexModel,
  isModernCodexModel,
  readCodexSupportedReasoningEfforts,
  resolveCodexFallbackReasoningEfforts,
  resolveCodexSupportedReasoningEffort,
  type CodexReasoningEffort,
} from "../../provider.js";
import {
  CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
  closeCodexStartupClientBestEffort,
  CodexAppServerUnsafeSubscriptionError,
  isCodexAppServerUnsafeSubscriptionError,
  unsubscribeCodexThreadBestEffort,
} from "./attempt-client-cleanup.js";
import {
  CodexAppServerRpcError,
  getCodexAppServerClientInstanceId,
  isCodexAppServerConnectionClosedError,
  type CodexAppServerClient,
} from "./client.js";
import { codexSandboxPolicyForTurn, type CodexAppServerRuntimeOptions } from "./config.js";
import {
  resolveCodexContextEngineProjectionMaxChars,
  resolveCodexContextEngineProjectionReserveTokens,
} from "./context-engine-projection.js";
import {
  isCrestodianOnlyCodexDynamicToolAllowlist,
  normalizeCodexDynamicToolName,
  shouldDisableCodexToolSearchForModel,
} from "./dynamic-tool-profile.js";
import { invalidInlineImageText, sanitizeInlineImageDataUrl } from "./image-payload-sanitizer.js";
import { buildCodexAppServerConnectionFingerprint } from "./plugin-app-cache-key.js";
import {
  buildCodexPluginAppsConfigPatchFromPolicyContext,
  isCodexPluginThreadBindingStale,
  mergeCodexThreadConfigs,
  type CodexPluginThreadConfig,
} from "./plugin-thread-config.js";
import { isCodexAppServerProfilerEnabled } from "./profiler-flag.js";
import {
  assertCodexThreadForkResponse,
  assertCodexThreadStartResponse,
} from "./protocol-validators.js";
import {
  CODEX_OPENCLAW_DIRECT_DYNAMIC_TOOL_NAMESPACE,
  flattenCodexDynamicToolFunctions,
  isJsonObject,
  type CodexDynamicToolSpec,
  type CodexConfigReadResponse,
  type CodexConfigRequirementsReadResponse,
  type CodexSandboxPolicy,
  type CodexThread,
  type CodexThreadForkParams,
  type CodexThreadResumeParams,
  type CodexThreadStartParams,
  type CodexTurnEnvironmentParams,
  type CodexTurnStartParams,
  type JsonObject,
  type CodexUserInput,
  type JsonValue,
} from "./protocol.js";
import {
  assertCodexBindingMayBeReplaced,
  isCodexAppServerNativeAuthProfile,
  normalizeCodexAppServerBindingModelProvider,
  reclaimCurrentCodexSessionGeneration,
  sessionBindingIdentity,
  type CodexAppServerAuthProfileLookup,
  type CodexAppServerBindingIdentity,
  type CodexAppServerBindingStore,
  type CodexAppServerContextEngineBinding,
  type CodexAppServerContextEngineProjectionBinding,
  type CodexAppServerPendingSupervisionBranch,
  type CodexAppServerThreadBinding,
} from "./session-binding.js";
import { isCodexAppServerStartSelectionChangedError } from "./shared-client.js";
import { resumeCodexAppServerThread } from "./thread-resume.js";
import { projectBoundedCodexThreadHistory } from "./transcript-mirror.js";
import { resolveCodexWebSearchPlan, type CodexNativeWebSearchSupport } from "./web-search.js";

export type CodexAppServerThreadLifecycle = {
  action: "started" | "resumed" | "forked";
  rotatedContextEngineBinding?: boolean;
  activeTurnIds?: string[];
};

export type CodexAppServerThreadLifecycleBinding = CodexAppServerThreadBinding & {
  lifecycle: CodexAppServerThreadLifecycle;
};

class CodexThreadStartRequestError extends Error {
  constructor(cause: unknown) {
    super(formatErrorMessage(cause), { cause });
    this.name = "CodexThreadStartRequestError";
  }
}

class CodexThreadBindingConflictError extends Error {
  constructor(threadId: string, operation: string) {
    super(`Codex thread binding changed while ${operation}: ${threadId}`);
    this.name = "CodexThreadBindingConflictError";
  }
}

class CodexRingZeroAttestationError extends Error {
  constructor(cause: unknown) {
    super("Codex ring-zero MCP attestation failed", { cause });
    this.name = "CodexRingZeroAttestationError";
  }
}

class CodexThreadBindingConflictAfterCleanupError extends CodexThreadBindingConflictError {}

class CodexAdoptedThreadActiveError extends Error {
  constructor() {
    super("Codex session became active in another runner; wait for it to finish before continuing");
    this.name = "CodexAdoptedThreadActiveError";
  }
}

export type CodexThreadFinalConfigPatchDecision =
  | { action: "resume"; binding: CodexAppServerThreadBinding }
  | { action: "start" };

export type CodexThreadFinalConfigPatchResult = {
  configPatch?: JsonObject;
  nativeHookRelayGeneration?: string;
};

export type CodexContextEngineThreadBootstrapProjection = {
  mode: "thread_bootstrap";
  epoch: string;
  fingerprint?: string;
};

export type CodexPluginThreadConfigProvider = {
  enabled: boolean;
  inputFingerprint?: string;
  enabledPluginConfigKeys?: readonly string[];
  build: () => Promise<CodexPluginThreadConfig>;
};

export const CODEX_NATIVE_PERSONALITY_NONE = "none";
const CODEX_RING_ZERO_BASE_INSTRUCTIONS = "";

// Stream structured patch snapshots so large generated edits keep the turn active.
export const CODEX_CODE_MODE_THREAD_CONFIG: JsonObject = {
  "features.code_mode": true,
  "features.code_mode_only": false,
  "features.apply_patch_streaming_events": true,
};

export const CODEX_CODE_MODE_DISABLED_THREAD_CONFIG: JsonObject = {
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

export type CodexThreadLifecycleTimingSpan = {
  name: string;
  durationMs: number;
  elapsedMs: number;
};

export type CodexThreadLifecycleTimingSummary = {
  totalMs: number;
  spans: CodexThreadLifecycleTimingSpan[];
};

export type CodexThreadLifecycleTimingLogger = {
  isEnabled?: (level: "trace") => boolean;
  trace: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
};

export type CodexThreadLifecycleTimingAction = "started" | "resumed" | "forked" | "rotated";

export type CodexThreadLifecycleTimingOptions = {
  enabled?: boolean;
  now?: () => number;
  log?: CodexThreadLifecycleTimingLogger;
  totalThresholdMs?: number;
  stageThresholdMs?: number;
};

const CODEX_THREAD_LIFECYCLE_TIMING_WARN_TOTAL_MS = 1_000;
const CODEX_THREAD_LIFECYCLE_TIMING_WARN_STAGE_MS = 500;

export function shouldWarnCodexThreadLifecycleTimingSummary(
  summary: CodexThreadLifecycleTimingSummary,
  options: CodexThreadLifecycleTimingOptions = {},
): boolean {
  const totalThresholdMs = options.totalThresholdMs ?? CODEX_THREAD_LIFECYCLE_TIMING_WARN_TOTAL_MS;
  const stageThresholdMs = options.stageThresholdMs ?? CODEX_THREAD_LIFECYCLE_TIMING_WARN_STAGE_MS;
  return (
    summary.totalMs >= totalThresholdMs ||
    summary.spans.some((span) => span.durationMs >= stageThresholdMs)
  );
}

export function formatCodexThreadLifecycleTimingSummary(params: {
  runId: string;
  sessionId: string;
  sessionKey?: string;
  action: CodexThreadLifecycleTimingAction;
  summary: CodexThreadLifecycleTimingSummary;
}): string {
  const spans =
    params.summary.spans.length > 0
      ? params.summary.spans
          .map((span) => `${span.name}:${span.durationMs}ms@${span.elapsedMs}ms`)
          .join(",")
      : "none";
  return (
    `[trace:codex-app-server] thread lifecycle: runId=${params.runId} ` +
    `sessionId=${params.sessionId} sessionKey=${params.sessionKey ?? "unknown"} ` +
    `action=${params.action} totalMs=${params.summary.totalMs} stages=${spans}`
  );
}

function createCodexThreadLifecycleTimingTracker(options: CodexThreadLifecycleTimingOptions = {}): {
  measure: <T>(name: string, run: () => Promise<T> | T) => Promise<T>;
  measureSync: <T>(name: string, run: () => T) => T;
  mark: (name: string) => void;
  logSummary: (params: {
    runId: string;
    sessionId: string;
    sessionKey?: string;
    action: CodexThreadLifecycleTimingAction;
    threadId?: string;
  }) => void;
} {
  const log = options.log ?? embeddedAgentLog;
  if (!options.enabled && log.isEnabled?.("trace") !== true) {
    return {
      async measure(_name, run) {
        return await run();
      },
      measureSync(_name, run) {
        return run();
      },
      mark() {},
      logSummary() {},
    };
  }

  const now = options.now ?? Date.now;
  const startedAt = now();
  let didLog = false;
  const spans: CodexThreadLifecycleTimingSpan[] = [];
  const toMs = (value: number) => Math.max(0, Math.round(value));
  const record = (name: string, spanStartedAt: number) => {
    const currentAt = now();
    spans.push({
      name,
      durationMs: toMs(currentAt - spanStartedAt),
      elapsedMs: toMs(currentAt - startedAt),
    });
  };
  const snapshot = (): CodexThreadLifecycleTimingSummary => ({
    totalMs: toMs(now() - startedAt),
    spans: spans.slice(),
  });
  return {
    async measure(name, run) {
      const spanStartedAt = now();
      try {
        return await run();
      } finally {
        record(name, spanStartedAt);
      }
    },
    measureSync(name, run) {
      const spanStartedAt = now();
      try {
        return run();
      } finally {
        record(name, spanStartedAt);
      }
    },
    mark(name) {
      record(name, now());
    },
    logSummary(params) {
      if (didLog) {
        return;
      }
      const summary = snapshot();
      const shouldWarn = shouldWarnCodexThreadLifecycleTimingSummary(summary, options);
      if (!shouldWarn && !log.isEnabled?.("trace")) {
        return;
      }
      didLog = true;
      const message = formatCodexThreadLifecycleTimingSummary({
        runId: params.runId,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        action: params.action,
        summary,
      });
      const meta = {
        runId: params.runId,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        action: params.action,
        threadId: params.threadId,
        totalMs: summary.totalMs,
        spans: summary.spans,
      };
      if (shouldWarn) {
        log.warn(message, meta);
      } else {
        log.trace(message, meta);
      }
    },
  };
}

export async function startOrResumeThread(params: {
  client: CodexAppServerClient;
  abandonClient?: () => Promise<void>;
  reserveResumeThread?: (threadId: string) => { release: () => void };
  bindingStore: CodexAppServerBindingStore;
  params: EmbeddedRunAttemptParams;
  agentId?: string;
  cwd: string;
  dynamicTools: CodexDynamicToolSpec[];
  persistentWebSearchAllowed?: boolean;
  webSearchAllowed?: boolean;
  appServer: CodexAppServerRuntimeOptions;
  developerInstructions?: string;
  config?: JsonObject;
  finalConfigPatch?: JsonObject;
  buildFinalConfigPatch?: (
    decision: CodexThreadFinalConfigPatchDecision,
  ) => CodexThreadFinalConfigPatchResult;
  nativeHookRelayGeneration?: string;
  nativeCodeModeEnabled?: boolean;
  nativeProviderWebSearchSupport?: CodexNativeWebSearchSupport;
  nativeCodeModeOnlyEnabled?: boolean;
  userMcpServersEnabled?: boolean;
  mcpServersFingerprint?: string;
  mcpServersFingerprintEvaluated?: boolean;
  environmentSelection?: CodexTurnEnvironmentParams[];
  appServerRuntimeFingerprint?: string;
  pluginThreadConfig?: CodexPluginThreadConfigProvider;
  contextEngineProjection?: CodexContextEngineThreadBootstrapProjection;
  signal?: AbortSignal;
  timing?: CodexThreadLifecycleTimingOptions;
  hostCrestodianActive?: boolean;
}): Promise<CodexAppServerThreadLifecycleBinding> {
  const bindingIdentity: CodexAppServerBindingIdentity = sessionBindingIdentity({
    sessionId: params.params.sessionId,
    sessionKey: params.params.sessionKey,
    agentId: params.agentId ?? params.params.agentId,
    config: params.params.config,
  });
  return await params.bindingStore.withLease(bindingIdentity, async () => {
    // Thread lifecycle spans are useful when profiling startup churn, but normal
    // turns should not pay Date.now/span-array overhead while resuming threads.
    const lifecycleTiming = createCodexThreadLifecycleTimingTracker({
      ...params.timing,
      enabled: params.timing?.enabled ?? isCodexAppServerProfilerEnabled(params.params.config),
    });
    const dynamicToolsFingerprint = lifecycleTiming.measureSync("dynamic-tools-fingerprint", () =>
      fingerprintDynamicTools(params.dynamicTools),
    );
    const dynamicToolsContainDeferred = flattenCodexDynamicToolFunctions(params.dynamicTools).some(
      (tool) => tool.deferLoading === true,
    );
    const webSearchPlan = lifecycleTiming.measureSync("web-search-plan", () =>
      resolveCodexWebSearchPlan({
        config: params.params.config,
        disableTools: params.params.disableTools,
        nativeToolSurfaceEnabled: params.nativeCodeModeEnabled,
        nativeProviderWebSearchSupport: params.nativeProviderWebSearchSupport,
        webSearchAllowed: params.webSearchAllowed,
      }),
    );
    const webSearchThreadConfigFingerprint = fingerprintJsonObject(webSearchPlan.threadConfig);
    const networkProxyConfigFingerprint = params.appServer.networkProxy?.configFingerprint;
    const contextEngineBinding = lifecycleTiming.measureSync("context-engine-binding", () =>
      buildContextEngineBinding(params.params, params.contextEngineProjection),
    );
    const userMcpServersConfigPatch =
      params.userMcpServersEnabled === false
        ? undefined
        : await buildCodexUserMcpServersThreadConfigPatchForRuntime(params.params.config, {
            agentId: params.agentId ?? params.params.agentId,
            agentDir: params.params.agentDir,
            allowLiteralOAuthProjection: params.appServer.connectionClass !== "remote",
            onServerUnavailable: (serverName, error) =>
              embeddedAgentLog.warn("skipping unavailable MCP OAuth server", {
                serverName,
                error: formatErrorMessage(error),
              }),
          });
    const userMcpServersFingerprint =
      fingerprintUserMcpServersConfigPatch(userMcpServersConfigPatch);
    const environmentSelectionFingerprint = fingerprintEnvironmentSelection(
      params.environmentSelection,
    );
    const hostCrestodianActive =
      params.hostCrestodianActive ?? isHostScopedAgentToolActive("crestodian");
    const ringZeroActive =
      hostCrestodianActive && isCrestodianOnlyCodexDynamicToolAllowlist(params.params.toolsAllow);
    if (ringZeroActive && params.nativeCodeModeEnabled !== false) {
      throw new Error("Codex ring-zero requires native code mode to be disabled");
    }
    const ringZeroInheritedMcpServerNames = ringZeroActive
      ? await lifecycleTiming.measure("ring-zero-mcp-config-read", () =>
          readCodexInheritedMcpServerNames(params.client, params.cwd, params.signal),
        )
      : [];
    if (ringZeroActive) {
      await lifecycleTiming.measure("ring-zero-config-requirements-read", () =>
        assertCodexRingZeroHasNoManagedHooks(params.client, params.signal),
      );
    }
    const ringZeroConfigFingerprint = ringZeroActive
      ? fingerprintJsonObject({
          version: 1,
          baseInstructions: CODEX_RING_ZERO_BASE_INSTRUCTIONS,
          config: buildCodexRingZeroThreadConfigPatch(
            params.params,
            true,
            ringZeroInheritedMcpServerNames,
          )!,
        })
      : undefined;
    const ringZeroClientInstanceId = ringZeroActive
      ? getCodexAppServerClientInstanceId(params.client)
      : undefined;
    let binding = await lifecycleTiming.measure("read-binding", () =>
      params.bindingStore.read(bindingIdentity),
    );
    const normalizeBindingModelProvider = (
      authProfileId: string | undefined,
      modelProvider: string | undefined,
    ) =>
      normalizeCodexAppServerBindingModelProvider({
        authProfileId,
        modelProvider,
        authProfileStore: params.params.authProfileStore,
        agentDir: params.params.agentDir,
        config: params.params.config,
      });
    const throwIfAborted = () => {
      if (!params.signal?.aborted) {
        return;
      }
      const reason = params.signal.reason;
      if (reason instanceof Error) {
        throw reason;
      }
      const error = new Error(
        typeof reason === "string" && reason.length > 0
          ? reason
          : "codex app-server thread lifecycle aborted",
      );
      error.name = "AbortError";
      throw error;
    };
    if (!binding && bindingIdentity.kind === "session" && bindingIdentity.sessionKey) {
      // Reset may rotate the OpenClaw session while this plugin is unloaded. Only
      // the authoritative session store may let its successor displace that stale owner.
      const reclaimed = await lifecycleTiming.measure("reclaim-binding-generation", () =>
        reclaimCurrentCodexSessionGeneration({
          bindingStore: params.bindingStore,
          identity: bindingIdentity,
          config: params.params.config,
        }),
      );
      if (!reclaimed) {
        throw new Error(
          `Codex session generation is no longer current: ${bindingIdentity.sessionId}`,
        );
      }
    }
    if (binding?.pendingSupervisionBranch) {
      const pendingBinding = binding as CodexAppServerThreadBinding & {
        pendingSupervisionBranch: CodexAppServerPendingSupervisionBranch;
      };
      const pluginThreadConfig = params.pluginThreadConfig?.enabled
        ? await lifecycleTiming.measure("plugin-config-build", () =>
            params.pluginThreadConfig?.build(),
          )
        : undefined;
      const finalConfigPatch = params.buildFinalConfigPatch?.({ action: "start" }) ?? {
        configPatch: params.finalConfigPatch,
        nativeHookRelayGeneration: params.nativeHookRelayGeneration,
      };
      const config = lifecycleTiming.measureSync("merge-thread-config", () =>
        mergeCodexThreadConfigs(
          params.config,
          userMcpServersConfigPatch,
          pluginThreadConfig?.configPatch,
          finalConfigPatch.configPatch,
        ),
      );
      return await materializePendingSupervisionBranch({
        client: params.client,
        abandonClient:
          params.abandonClient ?? (() => closeCodexStartupClientBestEffort(params.client)),
        bindingStore: params.bindingStore,
        bindingIdentity,
        binding: pendingBinding,
        attempt: params.params,
        cwd: params.cwd,
        dynamicTools: params.dynamicTools,
        appServer: params.appServer,
        developerInstructions: params.developerInstructions,
        config,
        nativeCodeModeEnabled: params.nativeCodeModeEnabled,
        nativeProviderWebSearchSupport: params.nativeProviderWebSearchSupport,
        nativeCodeModeOnlyEnabled: params.nativeCodeModeOnlyEnabled,
        webSearchAllowed: params.webSearchAllowed,
        environmentSelection: params.environmentSelection,
        signal: params.signal,
        throwIfAborted,
        lifecycleTiming,
        normalizeBindingModelProvider,
        bindingPatch: {
          cwd: params.cwd,
          // Supervised threads stay on the native user-home connection. Never
          // persist an outer OpenClaw auth profile onto that private ownership.
          authProfileId: undefined,
          preserveNativeModel: true,
          dynamicToolsFingerprint,
          dynamicToolsContainDeferred,
          webSearchThreadConfigFingerprint,
          userMcpServersFingerprint,
          mcpServersFingerprint:
            params.mcpServersFingerprintEvaluated === true
              ? params.mcpServersFingerprint
              : pendingBinding.mcpServersFingerprint,
          networkProxyProfileName: params.appServer.networkProxy?.profileName,
          networkProxyConfigFingerprint,
          nativeHookRelayGeneration: finalConfigPatch.nativeHookRelayGeneration,
          appServerRuntimeFingerprint: buildCodexAppServerConnectionFingerprint(
            params.appServer,
            params.params.agentDir,
          ),
          pluginAppsFingerprint: pluginThreadConfig?.fingerprint,
          pluginAppsInputFingerprint: pluginThreadConfig?.inputFingerprint,
          pluginAppPolicyContext: pluginThreadConfig?.policyContext,
          contextEngine: contextEngineBinding,
          environmentSelectionFingerprint,
          conversationSourceTransferComplete: true,
        },
      });
    }
    const clearCurrentBinding = async (operation: string) => {
      const current = binding;
      if (!current?.threadId) {
        return;
      }
      assertCodexBindingMayBeReplaced(current, operation);
      const cleared = await params.bindingStore.mutate(bindingIdentity, {
        kind: "clear",
        threadId: current.threadId,
      });
      if (!cleared) {
        throw new CodexThreadBindingConflictError(current.threadId, operation);
      }
      binding = undefined;
    };
    if (
      binding?.threadId &&
      (binding.ringZeroConfigFingerprint !== ringZeroConfigFingerprint ||
        binding.ringZeroClientInstanceId !== ringZeroClientInstanceId) &&
      (ringZeroActive || binding.ringZeroConfigFingerprint !== undefined)
    ) {
      // Resume config cannot safely change a loaded Codex thread. Reuse a
      // ring-zero thread only when its creation-time restrictions still match.
      embeddedAgentLog.debug("codex app-server ring-zero restriction changed; rotating thread", {
        threadId: binding.threadId,
      });
      await clearCurrentBinding("rotating a ring-zero thread binding");
    }
    if (
      binding?.threadId &&
      shouldRotateCodexAppServerBindingForRuntime({
        connectionClass: params.appServer.connectionClass,
        current:
          binding.connectionScope === "supervision"
            ? buildCodexAppServerConnectionFingerprint(params.appServer, params.params.agentDir)
            : params.appServerRuntimeFingerprint,
        binding: binding.appServerRuntimeFingerprint,
      })
    ) {
      embeddedAgentLog.debug("codex app-server runtime identity changed; starting a new thread", {
        threadId: binding.threadId,
        connectionClass: params.appServer.connectionClass,
      });
      await clearCurrentBinding("rotating a stale thread binding");
      binding = undefined;
    }
    if (
      binding?.threadId &&
      shouldRotateCodexGpt56MultiAgentBinding({
        bindingModel: binding.model,
        requestedModel: params.params.modelId,
      })
    ) {
      // Codex locks the model-selected multi-agent version on the first turn.
      // Sol/Terra (V2) and Luna (V1) therefore cannot share one resumed thread.
      embeddedAgentLog.debug(
        "codex app-server GPT-5.6 multi-agent version changed; starting a new thread",
        {
          threadId: binding.threadId,
          bindingModel: binding.model,
          requestedModel: params.params.modelId,
        },
      );
      await clearCurrentBinding("rotating a GPT-5.6 multi-agent thread binding");
      binding = undefined;
    }
    const startModelSelection = resolveCodexAppServerThreadModelSelection({
      provider: params.params.provider,
      model: params.params.modelId,
      binding,
      authProfileId: params.params.authProfileId,
      authProfileStore: params.params.authProfileStore,
      agentDir: params.params.agentDir,
      config: params.params.config,
    });
    const startModelProvider = startModelSelection.modelProvider;
    // Capability read failures use managed search for this turn but must not
    // create a binding that later looks like a confirmed provider-policy change.
    let preserveExistingBinding =
      !ringZeroActive && params.nativeProviderWebSearchSupport === "unknown" && !binding?.threadId;
    let rotatedContextEngineBinding = false;
    let prebuiltPluginThreadConfig: CodexPluginThreadConfig | undefined;
    const webSearchBindingChanged =
      binding?.threadId &&
      binding.webSearchThreadConfigFingerprint !== webSearchThreadConfigFingerprint;
    const persistentWebSearchRestriction =
      params.webSearchAllowed === false && params.persistentWebSearchAllowed === false;
    const transientNativeToolRestriction =
      params.nativeCodeModeEnabled === false && !persistentWebSearchRestriction;
    const transientWebSearchRestriction = isTransientWebSearchRestriction(params);
    const explicitTransientWebSearchRestriction =
      params.webSearchAllowed === false &&
      params.persistentWebSearchAllowed !== false &&
      transientWebSearchRestriction;
    const unknownProviderWebSearchSupport = params.nativeProviderWebSearchSupport === "unknown";
    if (
      binding?.threadId &&
      params.mcpServersFingerprintEvaluated === true &&
      binding.mcpServersFingerprint !== params.mcpServersFingerprint
    ) {
      assertCodexBindingMayBeReplaced(binding, "changing MCP configuration");
      if (
        !ringZeroActive &&
        (transientNativeToolRestriction ||
          (webSearchBindingChanged &&
            (explicitTransientWebSearchRestriction || unknownProviderWebSearchSupport)))
      ) {
        embeddedAgentLog.debug(
          "codex app-server MCP config changed during transient restricted turn; starting transient thread",
          {
            threadId: binding.threadId,
          },
        );
        preserveExistingBinding = true;
      } else {
        embeddedAgentLog.debug("codex app-server MCP config changed; starting a new thread", {
          threadId: binding.threadId,
        });
        await clearCurrentBinding("rotating a stale thread binding");
      }
      binding = undefined;
    }
    // A transient native-tool restriction must not replace a legacy binding just
    // because that binding predates search fingerprints. Explicit persistent
    // search denial still rotates first so the restricted thread can persist.
    const deferLegacyWebSearchRotationToTransientNativeSurface =
      params.nativeCodeModeEnabled === false &&
      binding?.webSearchThreadConfigFingerprint === undefined &&
      !persistentWebSearchRestriction;
    if (
      binding?.threadId &&
      webSearchBindingChanged &&
      !deferLegacyWebSearchRotationToTransientNativeSurface
    ) {
      assertCodexBindingMayBeReplaced(binding, "changing web-search configuration");
      if (!ringZeroActive && transientWebSearchRestriction) {
        embeddedAgentLog.debug(
          "codex app-server web search restricted for turn; starting transient thread",
          {
            threadId: binding.threadId,
          },
        );
        preserveExistingBinding = true;
      } else {
        // Codex can ignore resume overrides for a loaded thread, so persistent
        // search-policy changes and legacy bindings without metadata rotate first.
        embeddedAgentLog.debug(
          "codex app-server web search config changed; starting a new thread",
          {
            threadId: binding.threadId,
          },
        );
        await clearCurrentBinding("rotating a stale thread binding");
      }
      binding = undefined;
    }
    if (binding?.threadId && transientNativeToolRestriction && !ringZeroActive) {
      assertCodexBindingMayBeReplaced(binding, "starting a native-tool-restricted turn");
      embeddedAgentLog.debug(
        "codex app-server native tool surface disabled for turn; starting transient thread",
        {
          threadId: binding.threadId,
        },
      );
      preserveExistingBinding = true;
      binding = undefined;
    }
    if (binding?.threadId && (binding.contextEngine || contextEngineBinding)) {
      if (
        !contextEngineBinding ||
        !isContextEngineBindingCompatible(binding.contextEngine, contextEngineBinding)
      ) {
        embeddedAgentLog.debug(
          "codex app-server context-engine binding changed; starting a new thread",
          {
            threadId: binding.threadId,
            engineId: contextEngineBinding?.engineId,
            previousEngineId: binding.contextEngine?.engineId,
            epoch: contextEngineBinding?.projection?.epoch,
            previousEpoch: binding.contextEngine?.projection?.epoch,
            fingerprint: contextEngineBinding?.projection?.fingerprint,
            previousFingerprint: binding.contextEngine?.projection?.fingerprint,
            policyFingerprint: contextEngineBinding?.policyFingerprint,
            previousPolicyFingerprint: binding.contextEngine?.policyFingerprint,
          },
        );
        await clearCurrentBinding("rotating a stale thread binding");
        binding = undefined;
        rotatedContextEngineBinding = true;
      }
    }
    if (binding?.threadId && binding.userMcpServersFingerprint !== userMcpServersFingerprint) {
      embeddedAgentLog.debug("codex app-server user MCP config changed; starting a new thread", {
        threadId: binding.threadId,
      });
      await clearCurrentBinding("rotating a stale thread binding");
      binding = undefined;
    }
    if (
      binding?.threadId &&
      binding.environmentSelectionFingerprint !== environmentSelectionFingerprint
    ) {
      embeddedAgentLog.debug(
        "codex app-server environment selection changed; starting a new thread",
        {
          threadId: binding.threadId,
        },
      );
      await clearCurrentBinding("rotating a stale thread binding");
      binding = undefined;
    }
    if (
      binding?.threadId &&
      (binding.networkProxyConfigFingerprint !== networkProxyConfigFingerprint ||
        binding.networkProxyProfileName !== params.appServer.networkProxy?.profileName)
    ) {
      embeddedAgentLog.debug(
        "codex app-server network proxy config changed; starting a new thread",
        {
          threadId: binding.threadId,
        },
      );
      await clearCurrentBinding("rotating a stale thread binding");
      binding = undefined;
    }
    if (binding?.threadId) {
      let pluginBindingStale = isCodexPluginThreadBindingStale({
        codexPluginsEnabled: params.pluginThreadConfig?.enabled ?? false,
        bindingFingerprint: binding.pluginAppsFingerprint,
        bindingInputFingerprint: binding.pluginAppsInputFingerprint,
        currentInputFingerprint: params.pluginThreadConfig?.inputFingerprint,
        hasBindingPolicyContext: Boolean(binding.pluginAppPolicyContext),
      });
      if (
        !pluginBindingStale &&
        shouldRecheckRecoverablePluginBinding({
          binding,
          pluginThreadConfig: params.pluginThreadConfig,
        })
      ) {
        try {
          prebuiltPluginThreadConfig = await lifecycleTiming.measure("plugin-config-recovery", () =>
            params.pluginThreadConfig?.build(),
          );
          pluginBindingStale =
            prebuiltPluginThreadConfig?.fingerprint !== binding.pluginAppsFingerprint;
        } catch (error) {
          embeddedAgentLog.warn("codex app-server plugin app config recovery check failed", {
            error,
            threadId: binding.threadId,
          });
        }
      }
      if (pluginBindingStale) {
        embeddedAgentLog.debug(
          "codex app-server plugin app config changed; starting a new thread",
          {
            threadId: binding.threadId,
          },
        );
        await clearCurrentBinding("rotating a stale thread binding");
        binding = undefined;
      }
    }
    if (binding?.threadId) {
      if (
        binding.dynamicToolsFingerprint &&
        params.dynamicTools.length > 0 &&
        binding.dynamicToolsContainDeferred !== dynamicToolsContainDeferred &&
        (binding.dynamicToolsContainDeferred !== undefined || !dynamicToolsContainDeferred)
      ) {
        embeddedAgentLog.debug(
          "codex app-server dynamic tool loading changed; starting a new thread",
          {
            threadId: binding.threadId,
          },
        );
        await clearCurrentBinding("rotating a stale thread binding");
        binding = undefined;
      }
    }
    if (binding?.threadId) {
      // `/codex resume <thread>` writes a binding before the next turn can know
      // the dynamic tool catalog, so only invalidate fingerprints we actually have.
      if (
        binding.dynamicToolsFingerprint &&
        !areDynamicToolFingerprintsCompatible(
          binding.dynamicToolsFingerprint,
          dynamicToolsFingerprint,
        )
      ) {
        assertCodexBindingMayBeReplaced(binding, "changing the dynamic tool catalog");
        preserveExistingBinding = shouldStartTransientNoToolThread({
          previous: binding.dynamicToolsFingerprint,
          next: dynamicToolsFingerprint,
        });
        if (preserveExistingBinding) {
          embeddedAgentLog.debug(
            "codex app-server dynamic tools unavailable for turn; starting transient thread",
            {
              threadId: binding.threadId,
            },
          );
        } else {
          embeddedAgentLog.debug(
            "codex app-server dynamic tool catalog changed; starting a new thread",
            {
              threadId: binding.threadId,
            },
          );
          await clearCurrentBinding("rotating a stale thread binding");
        }
      } else {
        const resumeBinding = binding;
        let resumeReservation: { release: () => void } | undefined;
        try {
          const authProfileId =
            resumeBinding.connectionScope === "supervision"
              ? undefined
              : (params.params.authProfileId ?? resumeBinding.authProfileId);
          const finalConfigPatch = params.buildFinalConfigPatch?.({
            action: "resume",
            binding: resumeBinding,
          }) ?? {
            configPatch: params.finalConfigPatch,
            nativeHookRelayGeneration: params.nativeHookRelayGeneration,
          };
          // Codex rebuilds effective config on thread/resume, so replay the app
          // allowlist persisted at thread/start or plugin tools disappear after one turn.
          const pluginAppsConfigPatch =
            params.pluginThreadConfig?.enabled && resumeBinding.pluginAppPolicyContext
              ? buildCodexPluginAppsConfigPatchFromPolicyContext(
                  resumeBinding.pluginAppPolicyContext,
                )
              : undefined;
          const resumeConfig = mergeCodexThreadConfigs(
            params.config,
            userMcpServersConfigPatch,
            pluginAppsConfigPatch,
            finalConfigPatch.configPatch,
          );
          const resumeParams = lifecycleTiming.measureSync("thread-resume-params", () =>
            buildThreadResumeParams(params.params, {
              threadId: resumeBinding.threadId,
              authProfileId,
              model: startModelSelection.model,
              modelProvider: startModelProvider,
              preserveNativeModel: resumeBinding.preserveNativeModel === true,
              appServer: params.appServer,
              dynamicTools: params.dynamicTools,
              developerInstructions: params.developerInstructions,
              config: resumeConfig,
              nativeCodeModeEnabled: params.nativeCodeModeEnabled,
              nativeProviderWebSearchSupport: params.nativeProviderWebSearchSupport,
              nativeCodeModeOnlyEnabled: params.nativeCodeModeOnlyEnabled,
              webSearchAllowed: params.webSearchAllowed,
              hostCrestodianActive,
              ringZeroInheritedMcpServerNames,
            }),
          );
          const requestModelProvider =
            typeof resumeParams.modelProvider === "string" && resumeParams.modelProvider.trim()
              ? resumeParams.modelProvider
              : undefined;
          // Keep ownership accounting atomic with the resume request: a
          // pre-aborted request retains no subscription, so it must not reserve.
          throwIfAborted();
          if (resumeBinding.preserveNativeModel === true) {
            const current = await lifecycleTiming.measure("thread-read-adoption-status", () =>
              params.client.request(
                "thread/read",
                { threadId: resumeBinding.threadId, includeTurns: false },
                { signal: params.signal },
              ),
            );
            throwIfAborted();
            if (current.thread.status?.type === "active") {
              throw new CodexAdoptedThreadActiveError();
            }
          }
          resumeReservation = params.reserveResumeThread?.(resumeBinding.threadId);
          const response = await lifecycleTiming.measure("thread-resume-request", () =>
            resumeCodexAppServerThread({
              client: params.client,
              // Retiring the exact client keeps an indeterminate resume
              // subscription from ever re-entering the shared pool.
              abandonClient:
                params.abandonClient ?? (() => closeCodexStartupClientBestEffort(params.client)),
              request: resumeParams,
              signal: params.signal,
            }),
          );
          if (ringZeroActive) {
            try {
              await lifecycleTiming.measure("ring-zero-mcp-attestation", () =>
                attestCodexRingZeroThreadHasNoMcpServers(
                  params.client,
                  response.thread.id,
                  params.signal,
                ),
              );
            } catch (error) {
              await (
                params.abandonClient ?? (() => closeCodexStartupClientBestEffort(params.client))
              )();
              throw new CodexRingZeroAttestationError(error);
            }
          }
          throwIfAborted();
          const boundAuthProfileId = authProfileId;
          const nextMcpServersFingerprint =
            params.mcpServersFingerprintEvaluated === true
              ? params.mcpServersFingerprint
              : resumeBinding.mcpServersFingerprint;
          const resumePatch = {
            cwd: params.cwd,
            authProfileId: boundAuthProfileId,
            model: response.model ?? resumeParams.model ?? params.params.modelId,
            preserveNativeModel: resumeBinding.preserveNativeModel === true ? true : undefined,
            modelProvider: normalizeBindingModelProvider(
              boundAuthProfileId,
              response.modelProvider ?? requestModelProvider ?? startModelProvider,
            ),
            dynamicToolsFingerprint,
            dynamicToolsContainDeferred,
            webSearchThreadConfigFingerprint,
            userMcpServersFingerprint,
            mcpServersFingerprint: nextMcpServersFingerprint,
            ringZeroConfigFingerprint,
            ringZeroClientInstanceId,
            networkProxyProfileName: params.appServer.networkProxy?.profileName,
            networkProxyConfigFingerprint,
            nativeHookRelayGeneration:
              finalConfigPatch.nativeHookRelayGeneration ?? resumeBinding.nativeHookRelayGeneration,
            appServerRuntimeFingerprint:
              resumeBinding.connectionScope === "supervision"
                ? buildCodexAppServerConnectionFingerprint(params.appServer, params.params.agentDir)
                : params.appServerRuntimeFingerprint,
            pluginAppsFingerprint: resumeBinding.pluginAppsFingerprint,
            pluginAppsInputFingerprint: resumeBinding.pluginAppsInputFingerprint,
            pluginAppPolicyContext: resumeBinding.pluginAppPolicyContext,
            contextEngine: contextEngineBinding,
            environmentSelectionFingerprint,
          } satisfies Partial<Omit<CodexAppServerThreadBinding, "threadId">>;
          const committed = await lifecycleTiming.measure("thread-resume-write-binding", () =>
            params.bindingStore.mutate(bindingIdentity, {
              kind: "patch",
              threadId: resumeBinding.threadId,
              patch: resumePatch,
            }),
          );
          if (!committed) {
            throw new CodexThreadBindingConflictError(
              resumeBinding.threadId,
              "committing a resumed thread",
            );
          }
          if (contextEngineBinding) {
            embeddedAgentLog.info("codex app-server wrote context-engine thread binding", {
              sessionId: params.params.sessionId,
              sessionKey: params.params.sessionKey,
              threadId: response.thread.id,
              engineId: contextEngineBinding.engineId,
              epoch: contextEngineBinding.projection?.epoch,
              fingerprint: contextEngineBinding.projection?.fingerprint,
              action: "resumed",
            });
          }
          lifecycleTiming.mark("thread-ready");
          lifecycleTiming.logSummary({
            runId: params.params.runId,
            sessionId: params.params.sessionId,
            sessionKey: params.params.sessionKey,
            threadId: response.thread.id,
            action: "resumed",
          });
          const activeTurnIds = readActiveCodexTurnIds(response.thread);
          return {
            ...resumeBinding,
            threadId: response.thread.id,
            ...resumePatch,
            lifecycle: {
              action: "resumed",
              ...(activeTurnIds.length ? { activeTurnIds } : {}),
            },
          };
        } catch (error) {
          resumeReservation?.release();
          if (isCodexAppServerStartSelectionChangedError(error)) {
            throw error;
          }
          if (error instanceof CodexRingZeroAttestationError) {
            await clearCurrentBinding("retiring a failed ring-zero thread attestation");
            throw error;
          }
          if (error instanceof CodexAdoptedThreadActiveError) {
            // The passive preflight does not subscribe, so cleanup would target
            // another runner's ownership and can turn a clear conflict into rotation.
            throw error;
          }
          if (isCodexAppServerUnsafeSubscriptionError(error)) {
            // The resume client is already retired; a fresh start here would
            // race the possibly-live subscription on the abandoned process.
            throw error;
          }
          // A structured RPC rejection proves Codex never subscribed the
          // resume, so the best-effort unsubscribe below is cosmetic for that
          // case. Only post-acceptance failures must prove the release.
          const resumeRejected = error instanceof CodexAppServerRpcError;
          const subscriptionReleased = await unsubscribeCodexThreadBestEffort(params.client, {
            threadId: resumeBinding.threadId,
            timeoutMs: CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
          });
          if (
            !subscriptionReleased &&
            !resumeRejected &&
            !isCodexAppServerConnectionClosedError(error) &&
            !params.signal?.aborted
          ) {
            throw new CodexAppServerUnsafeSubscriptionError(
              "Codex thread/resume subscription cleanup failed",
              { cause: error },
            );
          }
          if (isCodexAppServerConnectionClosedError(error) || params.signal?.aborted) {
            throw error;
          }
          embeddedAgentLog.warn("codex app-server thread resume failed; starting a new thread", {
            error,
          });
          await clearCurrentBinding("rotating a stale thread binding");
        }
      }
    }

    const pluginThreadConfig = params.pluginThreadConfig?.enabled
      ? (prebuiltPluginThreadConfig ??
        (await lifecycleTiming.measure("plugin-config-build", () =>
          params.pluginThreadConfig?.build(),
        )))
      : undefined;
    const finalConfigPatch = params.buildFinalConfigPatch?.({ action: "start" }) ?? {
      configPatch: params.finalConfigPatch,
      nativeHookRelayGeneration: params.nativeHookRelayGeneration,
    };
    const config = lifecycleTiming.measureSync("merge-thread-config", () =>
      mergeCodexThreadConfigs(
        params.config,
        userMcpServersConfigPatch,
        pluginThreadConfig?.configPatch,
        finalConfigPatch.configPatch,
      ),
    );
    const startParams = lifecycleTiming.measureSync("thread-start-params", () =>
      buildThreadStartParams(params.params, {
        cwd: params.cwd,
        dynamicTools: params.dynamicTools,
        appServer: params.appServer,
        developerInstructions: params.developerInstructions,
        config,
        nativeCodeModeEnabled: params.nativeCodeModeEnabled,
        nativeProviderWebSearchSupport: params.nativeProviderWebSearchSupport,
        nativeCodeModeOnlyEnabled: params.nativeCodeModeOnlyEnabled,
        webSearchAllowed: params.webSearchAllowed,
        environmentSelection: params.environmentSelection,
        model: startModelSelection.model,
        modelProvider: startModelProvider,
        hostCrestodianActive,
        ringZeroInheritedMcpServerNames,
      }),
    );
    const requestModelProvider =
      typeof startParams.modelProvider === "string" && startParams.modelProvider.trim()
        ? startParams.modelProvider
        : undefined;
    const threadStartResponse = await lifecycleTiming.measure("thread-start-request", async () => {
      try {
        return await params.client.request("thread/start", startParams, { signal: params.signal });
      } catch (error) {
        if (error instanceof CodexAppServerRpcError) {
          throw new CodexThreadStartRequestError(error);
        }
        throw error;
      }
    });
    const response = assertCodexThreadStartResponse(threadStartResponse);
    if (ringZeroActive) {
      try {
        await lifecycleTiming.measure("ring-zero-mcp-attestation", () =>
          attestCodexRingZeroThreadHasNoMcpServers(
            params.client,
            response.thread.id,
            params.signal,
          ),
        );
      } catch (error) {
        await (params.abandonClient ?? (() => closeCodexStartupClientBestEffort(params.client)))();
        throw error;
      }
    }
    throwIfAborted();
    const modelProvider = resolveCodexAppServerModelProvider({
      provider: params.params.provider,
      authProfileId: params.params.authProfileId,
      authProfileStore: params.params.authProfileStore,
      agentDir: params.params.agentDir,
      config: params.params.config,
    });
    const nextMcpServersFingerprint =
      params.mcpServersFingerprintEvaluated === true ? params.mcpServersFingerprint : undefined;
    if (!preserveExistingBinding) {
      const committed = await lifecycleTiming.measure("thread-start-write-binding", () =>
        params.bindingStore.mutate(bindingIdentity, {
          kind: "set",
          if: { kind: "absent" },
          binding: {
            threadId: response.thread.id,
            cwd: params.cwd,
            authProfileId: params.params.authProfileId,
            model: response.model ?? startParams.model ?? params.params.modelId,
            modelProvider: normalizeBindingModelProvider(
              params.params.authProfileId,
              response.modelProvider ?? requestModelProvider ?? startModelProvider ?? modelProvider,
            ),
            dynamicToolsFingerprint,
            dynamicToolsContainDeferred,
            webSearchThreadConfigFingerprint,
            userMcpServersFingerprint,
            mcpServersFingerprint: nextMcpServersFingerprint,
            ringZeroConfigFingerprint,
            ringZeroClientInstanceId,
            networkProxyProfileName: params.appServer.networkProxy?.profileName,
            networkProxyConfigFingerprint,
            nativeHookRelayGeneration: finalConfigPatch.nativeHookRelayGeneration,
            appServerRuntimeFingerprint: params.appServerRuntimeFingerprint,
            pluginAppsFingerprint: pluginThreadConfig?.fingerprint,
            pluginAppsInputFingerprint: pluginThreadConfig?.inputFingerprint,
            pluginAppPolicyContext: pluginThreadConfig?.policyContext,
            contextEngine: contextEngineBinding,
            environmentSelectionFingerprint,
          },
        }),
      );
      if (!committed) {
        throw new CodexThreadBindingConflictError(response.thread.id, "committing a fresh thread");
      }
      if (contextEngineBinding) {
        embeddedAgentLog.info("codex app-server wrote context-engine thread binding", {
          sessionId: params.params.sessionId,
          sessionKey: params.params.sessionKey,
          threadId: response.thread.id,
          engineId: contextEngineBinding.engineId,
          epoch: contextEngineBinding.projection?.epoch,
          fingerprint: contextEngineBinding.projection?.fingerprint,
          action: rotatedContextEngineBinding ? "rotated" : "started",
        });
      }
    }
    lifecycleTiming.mark("thread-ready");
    lifecycleTiming.logSummary({
      runId: params.params.runId,
      sessionId: params.params.sessionId,
      sessionKey: params.params.sessionKey,
      threadId: response.thread.id,
      action: rotatedContextEngineBinding ? "rotated" : "started",
    });
    return {
      threadId: response.thread.id,
      cwd: params.cwd,
      authProfileId: params.params.authProfileId,
      model: response.model ?? startParams.model ?? params.params.modelId,
      modelProvider:
        response.modelProvider ?? requestModelProvider ?? startModelProvider ?? modelProvider,
      dynamicToolsFingerprint,
      dynamicToolsContainDeferred,
      userMcpServersFingerprint,
      mcpServersFingerprint: nextMcpServersFingerprint,
      ringZeroConfigFingerprint,
      ringZeroClientInstanceId,
      networkProxyProfileName: params.appServer.networkProxy?.profileName,
      networkProxyConfigFingerprint,
      nativeHookRelayGeneration: finalConfigPatch.nativeHookRelayGeneration,
      appServerRuntimeFingerprint: params.appServerRuntimeFingerprint,
      pluginAppsFingerprint: pluginThreadConfig?.fingerprint,
      pluginAppsInputFingerprint: pluginThreadConfig?.inputFingerprint,
      pluginAppPolicyContext: pluginThreadConfig?.policyContext,
      contextEngine: contextEngineBinding,
      environmentSelectionFingerprint,
      lifecycle: {
        action: "started",
        ...(rotatedContextEngineBinding ? { rotatedContextEngineBinding } : {}),
      },
    };
  });
}

type PendingSupervisionMaterializationParams = {
  client: CodexAppServerClient;
  abandonClient: () => Promise<void>;
  bindingStore: CodexAppServerBindingStore;
  bindingIdentity: CodexAppServerBindingIdentity;
  binding: CodexAppServerThreadBinding & {
    pendingSupervisionBranch: CodexAppServerPendingSupervisionBranch;
  };
  attempt: EmbeddedRunAttemptParams;
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
  signal?: AbortSignal;
  throwIfAborted: () => void;
  lifecycleTiming: Pick<
    ReturnType<typeof createCodexThreadLifecycleTimingTracker>,
    "measure" | "mark" | "logSummary"
  >;
  normalizeBindingModelProvider: (
    authProfileId: string | undefined,
    modelProvider: string | undefined,
  ) => string | undefined;
  bindingPatch: Partial<Omit<CodexAppServerThreadBinding, "threadId" | "pendingSupervisionBranch">>;
};

async function materializePendingSupervisionBranch(
  params: PendingSupervisionMaterializationParams,
): Promise<CodexAppServerThreadLifecycleBinding> {
  let pending = params.binding.pendingSupervisionBranch;
  const connectionFingerprint = buildCodexAppServerConnectionFingerprint(
    params.appServer,
    params.attempt.agentDir,
  );
  if (!pending.connectionFingerprint || pending.connectionFingerprint !== connectionFingerprint) {
    throw new Error("Codex supervision source connection changed before branch materialization");
  }
  pending = await recoverPendingSupervisionArtifacts(params, pending);
  params.throwIfAborted();

  const sourceResponse = await params.lifecycleTiming.measure("supervision-source-read", () =>
    params.client.request(
      "thread/read",
      { threadId: pending.sourceThreadId, includeTurns: true },
      { signal: params.signal },
    ),
  );
  params.throwIfAborted();
  const sourceThread = sourceResponse.thread;
  if (sourceThread.id !== pending.sourceThreadId) {
    throw new Error(
      `Codex supervision source read returned ${sourceThread.id} for ${pending.sourceThreadId}`,
    );
  }
  assertPendingSupervisionSnapshotUnchanged(sourceThread, pending);
  const history = projectBoundedCodexThreadHistory({
    thread: sourceThread,
    throughTurnId: pending.lastTurnId ?? null,
    importedAt: Date.now(),
    modelProvider: sourceThread.modelProvider,
  });

  let bindingCommitted = false;
  let provisionalCleanupSafe = true;
  try {
    const probeParams = buildPendingSupervisionProbeForkParams(params, pending);
    const rawProbeResponse = await params.lifecycleTiming.measure(
      "supervision-model-probe-fork",
      async () => {
        try {
          return await params.client.request("thread/fork", probeParams, {
            signal: params.signal,
          });
        } catch (error) {
          if (!(error instanceof CodexAppServerRpcError)) {
            throw new CodexAppServerUnsafeSubscriptionError(
              "Codex model probe fork may have materialized without a response",
              { cause: error },
            );
          }
          throw error;
        }
      },
    );
    const probeThreadId = requireDistinctSupervisionThreadId({
      threadId: readSupervisionResponseThreadId(rawProbeResponse),
      sourceThreadId: pending.sourceThreadId,
      role: "model probe",
    });
    pending = await trackPendingSupervisionArtifacts(params, pending, [probeThreadId]);
    params.throwIfAborted();
    const probeResponse = assertCodexThreadForkResponse(rawProbeResponse);
    const nativeModel = requireNonBlankSupervisionValue(probeResponse.model, "native model");
    const nativeModelProvider = requireNativeSupervisionModelProvider({
      responseModelProvider: probeResponse.modelProvider,
      responseThreadModelProvider: probeResponse.thread.modelProvider,
    });

    const nativeAttempt = { ...params.attempt, modelId: nativeModel };
    const startParams = buildThreadStartParams(nativeAttempt, {
      cwd: params.cwd,
      dynamicTools: params.dynamicTools,
      appServer: params.appServer,
      developerInstructions: params.developerInstructions,
      config: params.config,
      nativeCodeModeEnabled: params.nativeCodeModeEnabled,
      nativeProviderWebSearchSupport: params.nativeProviderWebSearchSupport,
      nativeCodeModeOnlyEnabled: params.nativeCodeModeOnlyEnabled,
      webSearchAllowed: params.webSearchAllowed,
      environmentSelection: params.environmentSelection,
      model: nativeModel,
      modelProvider: nativeModelProvider,
    });
    assertExactSupervisionModelSelection(startParams, {
      model: nativeModel,
      modelProvider: nativeModelProvider,
      operation: "thread/start request",
    });
    const rawStartResponse = await params.lifecycleTiming.measure(
      "supervision-thread-start",
      async () => {
        try {
          return await params.client.request("thread/start", startParams, {
            signal: params.signal,
          });
        } catch (error) {
          if (error instanceof CodexAppServerRpcError) {
            throw new CodexThreadStartRequestError(error);
          }
          throw new CodexAppServerUnsafeSubscriptionError(
            "Canonical Codex branch may have started without a response",
            { cause: error },
          );
        }
      },
    );
    const finalThreadId = requireDistinctSupervisionThreadId({
      threadId: readSupervisionResponseThreadId(rawStartResponse),
      sourceThreadId: pending.sourceThreadId,
      otherThreadId: probeThreadId,
      role: "canonical branch",
    });
    pending = await trackPendingSupervisionArtifacts(params, pending, [
      probeThreadId,
      finalThreadId,
    ]);
    params.throwIfAborted();
    const startResponse = assertCodexThreadStartResponse(rawStartResponse);
    assertExactSupervisionModelSelection(startResponse, {
      model: nativeModel,
      modelProvider: nativeModelProvider,
      operation: "thread/start response",
    });
    if (history.responseItems.length > 0) {
      await params.lifecycleTiming.measure("supervision-history-inject", () =>
        params.client.request(
          "thread/inject_items",
          { threadId: finalThreadId, items: history.responseItems },
          { signal: params.signal },
        ),
      );
      params.throwIfAborted();
    }

    if (!(await archiveSupervisionArtifact(params.client, probeThreadId))) {
      throw new Error(`Failed to archive temporary Codex model probe: ${probeThreadId}`);
    }
    pending = await trackPendingSupervisionArtifacts(params, pending, [finalThreadId]);
    const historyCoveredThrough = new Date().toISOString();
    const bindingModelProvider = params.normalizeBindingModelProvider(
      params.attempt.authProfileId,
      nativeModelProvider,
    );
    let committed = false;
    try {
      committed = await params.bindingStore.mutate(params.bindingIdentity, {
        kind: "commit-pending-supervision-branch",
        expected: pending,
        threadId: finalThreadId,
        patch: {
          ...params.bindingPatch,
          model: nativeModel,
          modelProvider: bindingModelProvider,
          historyCoveredThrough,
        },
      });
    } catch (error) {
      let current: CodexAppServerThreadBinding | undefined;
      try {
        current = await params.bindingStore.read(params.bindingIdentity);
      } catch (readError) {
        provisionalCleanupSafe = false;
        throw new CodexAppServerUnsafeSubscriptionError(
          `Canonical Codex branch binding could not be verified: ${finalThreadId}`,
          { cause: new AggregateError([error, readError]) },
        );
      }
      if (
        matchesMaterializedSupervisionBranch(current, {
          sourceThreadId: pending.sourceThreadId,
          connectionFingerprint,
          threadId: finalThreadId,
          model: nativeModel,
          modelProvider: bindingModelProvider,
          historyCoveredThrough,
        })
      ) {
        committed = true;
      } else {
        if (!matchesPendingSupervisionState(current, pending)) {
          provisionalCleanupSafe = false;
          throw new CodexAppServerUnsafeSubscriptionError(
            `Canonical Codex branch binding changed while commit was uncertain: ${finalThreadId}`,
            { cause: error },
          );
        }
        throw error;
      }
    }
    if (!committed) {
      throw new CodexThreadBindingConflictError(
        pending.sourceThreadId,
        "committing a supervised Codex branch",
      );
    }
    // This thread now belongs to the durable binding. Later diagnostics must
    // never route it through provisional artifact cleanup.
    bindingCommitted = true;
    params.lifecycleTiming.mark("thread-ready");
    params.lifecycleTiming.logSummary({
      runId: params.attempt.runId,
      sessionId: params.attempt.sessionId,
      sessionKey: params.attempt.sessionKey,
      threadId: finalThreadId,
      action: "forked",
    });
    return {
      ...params.binding,
      ...params.bindingPatch,
      threadId: finalThreadId,
      pendingSupervisionBranch: undefined,
      model: nativeModel,
      modelProvider: bindingModelProvider,
      historyCoveredThrough,
      lifecycle: { action: "forked" },
    };
  } catch (error) {
    if (bindingCommitted) {
      throw error;
    }
    // The tracking CAS owner already cleaned every known artifact. Its stale
    // pending snapshot must not drive another cleanup or binding mutation.
    if (error instanceof CodexThreadBindingConflictAfterCleanupError) {
      throw error;
    }
    if (!provisionalCleanupSafe) {
      await params.abandonClient();
      throw error;
    }
    const cleanup = await cleanPendingSupervisionArtifacts(params.client, pending);
    let cleanupStateError: unknown;
    if (cleanup.remaining.length !== (pending.cleanupThreadIds?.length ?? 0)) {
      const nextPending = withPendingSupervisionCleanup(pending, cleanup.remaining);
      try {
        const updated = await params.bindingStore.mutate(params.bindingIdentity, {
          kind: "patch-pending-supervision-branch",
          expected: pending,
          pending: nextPending,
        });
        if (updated) {
          pending = nextPending;
        }
      } catch (stateError) {
        cleanupStateError = stateError;
      }
    }
    const unsafeCleanup =
      cleanup.remaining.length > 0 || isCodexAppServerUnsafeSubscriptionError(error);
    if (unsafeCleanup) {
      await params.abandonClient();
    }
    if (cleanupStateError) {
      const cause = new AggregateError([error, cleanupStateError]);
      if (unsafeCleanup) {
        throw new CodexAppServerUnsafeSubscriptionError(
          "Codex supervised branch cleanup state could not be recorded",
          { cause },
        );
      }
      const aggregateError = new AggregateError(
        [error, cleanupStateError],
        "Codex supervised branch cleanup state could not be recorded",
        { cause: error },
      );
      throw aggregateError;
    }
    if (cleanup.remaining.length > 0) {
      throw new CodexAppServerUnsafeSubscriptionError(
        `Codex supervised branch cleanup remains pending: ${cleanup.remaining.join(", ")}`,
        { cause: error },
      );
    }
    throw error;
  }
}

function buildPendingSupervisionProbeForkParams(
  params: PendingSupervisionMaterializationParams,
  pending: CodexAppServerPendingSupervisionBranch,
): CodexThreadForkParams {
  const runtimeConfig = buildCodexRuntimeThreadConfigForRun(params.attempt, params.config, {
    nativeCodeModeEnabled: params.nativeCodeModeEnabled,
    nativeProviderWebSearchSupport: params.nativeProviderWebSearchSupport,
    nativeCodeModeOnlyEnabled: params.nativeCodeModeOnlyEnabled,
    webSearchAllowed: params.webSearchAllowed,
    appServer: params.appServer,
  });
  return {
    threadId: pending.sourceThreadId,
    ...(pending.lastTurnId ? { lastTurnId: pending.lastTurnId } : {}),
    cwd: params.cwd,
    approvalPolicy: params.appServer.approvalPolicy,
    approvalsReviewer: resolveCodexThreadApprovalsReviewer(params.appServer, runtimeConfig),
    ...codexThreadSandboxOrPermissions(params.appServer),
    ...(params.appServer.serviceTier !== undefined
      ? { serviceTier: params.appServer.serviceTier }
      : {}),
    config: runtimeConfig,
    developerInstructions:
      params.developerInstructions ??
      buildDeveloperInstructions(params.attempt, { dynamicTools: params.dynamicTools }),
    ephemeral: false,
    threadSource: "appServer",
    excludeTurns: true,
  };
}

function assertPendingSupervisionSnapshotUnchanged(
  thread: CodexThread,
  pending: CodexAppServerPendingSupervisionBranch,
): void {
  if (pending.lastTurnId) {
    return;
  }
  if (thread.status?.type === "active" || (thread.turns?.length ?? 0) > 0) {
    throw new Error(
      "Codex source changed after Continue; reopen the source session before sending a message",
    );
  }
}

function requireNonBlankSupervisionValue(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Codex supervision ${label} is missing`);
  }
  return value.trim();
}

function requireNativeSupervisionModelProvider(params: {
  responseModelProvider?: string | null;
  responseThreadModelProvider?: string | null;
}): string {
  const responseProvider = requireNonBlankSupervisionValue(
    params.responseModelProvider,
    "native model provider",
  );
  const threadProvider = params.responseThreadModelProvider?.trim();
  if (threadProvider && threadProvider !== responseProvider) {
    throw new Error(
      `Codex supervision model provider mismatch: ${responseProvider} != ${threadProvider}`,
    );
  }
  return responseProvider;
}

function assertExactSupervisionModelSelection(
  value: { model?: string | null; modelProvider?: string | null },
  expected: { model: string; modelProvider: string; operation: string },
): void {
  if (value.model !== expected.model || value.modelProvider !== expected.modelProvider) {
    throw new Error(
      `Codex supervision ${expected.operation} changed native model selection: ` +
        `${value.modelProvider ?? "unknown"}/${value.model ?? "unknown"}`,
    );
  }
}

function matchesPendingSupervisionState(
  binding: CodexAppServerThreadBinding | undefined,
  expected: CodexAppServerPendingSupervisionBranch,
): boolean {
  const pending = binding?.pendingSupervisionBranch;
  const cleanupThreadIds = pending?.cleanupThreadIds ?? [];
  const expectedCleanupThreadIds = expected.cleanupThreadIds ?? [];
  return (
    binding?.threadId === expected.sourceThreadId &&
    binding.connectionScope === "supervision" &&
    binding.supervisionSourceThreadId === expected.sourceThreadId &&
    pending?.sourceThreadId === expected.sourceThreadId &&
    pending.connectionFingerprint === expected.connectionFingerprint &&
    pending.lastTurnId === expected.lastTurnId &&
    cleanupThreadIds.length === expectedCleanupThreadIds.length &&
    cleanupThreadIds.every((threadId, index) => threadId === expectedCleanupThreadIds[index])
  );
}

function matchesMaterializedSupervisionBranch(
  binding: CodexAppServerThreadBinding | undefined,
  expected: {
    sourceThreadId: string;
    connectionFingerprint: string;
    threadId: string;
    model: string;
    modelProvider: string | undefined;
    historyCoveredThrough: string;
  },
): boolean {
  return (
    binding?.threadId === expected.threadId &&
    binding.connectionScope === "supervision" &&
    binding.supervisionSourceThreadId === expected.sourceThreadId &&
    binding.appServerRuntimeFingerprint === expected.connectionFingerprint &&
    binding.pendingSupervisionBranch === undefined &&
    binding.model === expected.model &&
    binding.modelProvider === expected.modelProvider &&
    binding.historyCoveredThrough === expected.historyCoveredThrough
  );
}

function requireDistinctSupervisionThreadId(params: {
  threadId: unknown;
  sourceThreadId: string;
  otherThreadId?: string;
  role: string;
}): string {
  let threadId: string;
  try {
    threadId = requireNonBlankSupervisionValue(params.threadId, `${params.role} thread id`);
  } catch (error) {
    throw new CodexAppServerUnsafeSubscriptionError(
      `Codex supervision ${params.role} may have materialized without a safe thread id`,
      { cause: error },
    );
  }
  if (threadId === params.sourceThreadId || threadId === params.otherThreadId) {
    throw new CodexAppServerUnsafeSubscriptionError(
      `Codex supervision ${params.role} reused an existing thread: ${threadId}`,
    );
  }
  return threadId;
}

function readSupervisionResponseThreadId(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const thread = (value as { thread?: unknown }).thread;
  if (!thread || typeof thread !== "object" || Array.isArray(thread)) {
    return undefined;
  }
  return (thread as { id?: unknown }).id;
}

async function recoverPendingSupervisionArtifacts(
  params: PendingSupervisionMaterializationParams,
  pending: CodexAppServerPendingSupervisionBranch,
): Promise<CodexAppServerPendingSupervisionBranch> {
  if (!pending.cleanupThreadIds?.length) {
    return pending;
  }
  const cleanup = await cleanPendingSupervisionArtifacts(params.client, pending);
  const next = withPendingSupervisionCleanup(pending, cleanup.remaining);
  if (cleanup.remaining.length > 0) {
    if (cleanup.remaining.length !== pending.cleanupThreadIds.length) {
      const updated = await params.bindingStore.mutate(params.bindingIdentity, {
        kind: "patch-pending-supervision-branch",
        expected: pending,
        pending: next,
      });
      if (!updated) {
        throw new CodexThreadBindingConflictError(
          pending.sourceThreadId,
          "recording supervised Codex cleanup recovery",
        );
      }
    }
    throw new Error(
      `Codex supervised branch cleanup must finish before retry: ${cleanup.remaining.join(", ")}`,
    );
  }
  const updated = await params.bindingStore.mutate(params.bindingIdentity, {
    kind: "patch-pending-supervision-branch",
    expected: pending,
    pending: next,
  });
  if (!updated) {
    throw new CodexThreadBindingConflictError(
      pending.sourceThreadId,
      "recovering a supervised Codex branch",
    );
  }
  return next;
}

async function trackPendingSupervisionArtifacts(
  params: PendingSupervisionMaterializationParams,
  pending: CodexAppServerPendingSupervisionBranch,
  cleanupThreadIds: string[],
): Promise<CodexAppServerPendingSupervisionBranch> {
  const next = withPendingSupervisionCleanup(pending, cleanupThreadIds);
  const updated = await params.bindingStore.mutate(params.bindingIdentity, {
    kind: "patch-pending-supervision-branch",
    expected: pending,
    pending: next,
  });
  if (!updated) {
    const cleanupFailed: string[] = [];
    for (const threadId of cleanupThreadIds) {
      if (!(await archiveSupervisionArtifact(params.client, threadId))) {
        cleanupFailed.push(threadId);
      }
    }
    if (cleanupFailed.length > 0) {
      throw new CodexAppServerUnsafeSubscriptionError(
        `Codex supervised branch CAS cleanup failed: ${cleanupFailed.join(", ")}`,
      );
    }
    throw new CodexThreadBindingConflictAfterCleanupError(
      pending.sourceThreadId,
      "tracking supervised Codex branch cleanup",
    );
  }
  return next;
}

function withPendingSupervisionCleanup(
  pending: CodexAppServerPendingSupervisionBranch,
  cleanupThreadIds: string[],
): CodexAppServerPendingSupervisionBranch {
  return {
    sourceThreadId: pending.sourceThreadId,
    ...(pending.connectionFingerprint
      ? { connectionFingerprint: pending.connectionFingerprint }
      : {}),
    ...(pending.lastTurnId ? { lastTurnId: pending.lastTurnId } : {}),
    ...(cleanupThreadIds.length > 0 ? { cleanupThreadIds } : {}),
  };
}

async function cleanPendingSupervisionArtifacts(
  client: CodexAppServerClient,
  pending: CodexAppServerPendingSupervisionBranch,
): Promise<{ remaining: string[] }> {
  const remaining: string[] = [];
  for (const threadId of pending.cleanupThreadIds ?? []) {
    if (!(await archiveSupervisionArtifact(client, threadId))) {
      remaining.push(threadId);
    }
  }
  return { remaining };
}

async function archiveSupervisionArtifact(
  client: CodexAppServerClient,
  threadId: string,
): Promise<boolean> {
  try {
    await client.request(
      "thread/archive",
      { threadId },
      { timeoutMs: CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS },
    );
    return true;
  } catch (error) {
    const message = formatErrorMessage(error).toLowerCase();
    if (
      message.includes("no rollout found for thread id") ||
      message.includes("thread not found") ||
      message.includes("already archived")
    ) {
      return true;
    }
    await unsubscribeCodexThreadBestEffort(client, {
      threadId,
      timeoutMs: CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
    });
    embeddedAgentLog.warn("failed to archive temporary Codex supervision thread", {
      threadId,
      error,
    });
    return false;
  }
}

export function shouldRotateCodexAppServerBindingForRuntime(params: {
  connectionClass: CodexAppServerRuntimeOptions["connectionClass"];
  current?: string;
  binding?: string;
}): boolean {
  if (!params.current) {
    return false;
  }
  if (params.binding === params.current) {
    return false;
  }
  return params.connectionClass === "remote" || Boolean(params.binding);
}

type CodexGpt56MultiAgentVersion = "v1" | "v2";

function resolveCodexGpt56MultiAgentVersion(
  modelRef: string | undefined,
): CodexGpt56MultiAgentVersion | undefined {
  let modelId = modelRef?.trim().toLowerCase();
  if (!modelId) {
    return undefined;
  }
  const slashIndex = modelId.indexOf("/");
  if (slashIndex > 0) {
    const provider = modelId.slice(0, slashIndex);
    if (provider !== "openai" && provider !== "codex") {
      return undefined;
    }
    modelId = modelId.slice(slashIndex + 1);
  }
  if (modelId === "gpt-5.6-sol" || modelId === "gpt-5.6-terra") {
    return "v2";
  }
  return modelId === "gpt-5.6-luna" ? "v1" : undefined;
}

function shouldRotateCodexGpt56MultiAgentBinding(params: {
  bindingModel?: string;
  requestedModel: string;
}): boolean {
  const bindingVersion = resolveCodexGpt56MultiAgentVersion(params.bindingModel);
  const requestedVersion = resolveCodexGpt56MultiAgentVersion(params.requestedModel);
  return Boolean(bindingVersion && requestedVersion && bindingVersion !== requestedVersion);
}

function isTransientWebSearchRestriction(
  params: Pick<
    Parameters<typeof startOrResumeThread>[0],
    | "params"
    | "nativeCodeModeEnabled"
    | "nativeProviderWebSearchSupport"
    | "persistentWebSearchAllowed"
    | "webSearchAllowed"
  >,
): boolean {
  if (params.nativeProviderWebSearchSupport === "unknown") {
    return true;
  }
  if (params.params.config?.tools?.web?.search?.enabled === false) {
    return false;
  }
  if (params.params.disableTools === true) {
    return true;
  }
  const persistentWebSearchRestriction =
    params.webSearchAllowed === false && params.persistentWebSearchAllowed === false;
  if (params.nativeCodeModeEnabled === false && !persistentWebSearchRestriction) {
    return true;
  }
  if (params.webSearchAllowed !== false) {
    return false;
  }
  if (params.persistentWebSearchAllowed !== undefined) {
    return params.persistentWebSearchAllowed;
  }
  if (params.params.toolsAllow === undefined) {
    return false;
  }
  return !params.params.toolsAllow.some((name) => {
    const normalized = normalizeCodexDynamicToolName(name);
    return normalized === "*" || normalized === "web_search";
  });
}

export function buildContextEngineBinding(
  params: EmbeddedRunAttemptParams,
  projection?: CodexContextEngineThreadBootstrapProjection,
): CodexAppServerContextEngineBinding | undefined {
  const contextEngine = isActiveHarnessContextEngine(params.contextEngine)
    ? params.contextEngine
    : undefined;
  const engineId = contextEngine?.info?.id?.trim();
  if (!contextEngine || !engineId) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    engineId,
    policyFingerprint: JSON.stringify({
      schemaVersion: 1,
      engineId,
      engineVersion: contextEngine.info.version,
      ownsCompaction: contextEngine.info.ownsCompaction === true,
      turnMaintenanceMode: contextEngine.info.turnMaintenanceMode,
      citationsMode: resolveContextEngineCitationsMode(params.config),
      contextTokenBudget: params.contextTokenBudget,
      projectionMaxChars: resolveCodexContextEngineProjectionMaxChars({
        contextTokenBudget: params.contextTokenBudget,
        reserveTokens: resolveCodexContextEngineProjectionReserveTokens({
          config: params.config,
        }),
      }),
    }),
    projection: projection ? buildContextEngineProjectionBinding(projection) : undefined,
  };
}

function buildContextEngineProjectionBinding(
  projection: CodexContextEngineThreadBootstrapProjection,
): CodexAppServerContextEngineProjectionBinding {
  return {
    schemaVersion: 1,
    mode: "thread_bootstrap",
    epoch: projection.epoch,
    fingerprint: projection.fingerprint,
  };
}

export function isContextEngineBindingCompatible(
  previous: CodexAppServerContextEngineBinding | undefined,
  next: CodexAppServerContextEngineBinding,
): boolean {
  return (
    previous?.schemaVersion === next.schemaVersion &&
    previous.engineId === next.engineId &&
    previous.policyFingerprint === next.policyFingerprint &&
    areContextEngineProjectionBindingsCompatible(previous.projection, next.projection)
  );
}

function areContextEngineProjectionBindingsCompatible(
  previous: CodexAppServerContextEngineProjectionBinding | undefined,
  next: CodexAppServerContextEngineProjectionBinding | undefined,
): boolean {
  if (!next) {
    return previous === undefined;
  }
  return (
    previous?.schemaVersion === next.schemaVersion &&
    previous.mode === next.mode &&
    previous.epoch === next.epoch &&
    previous.fingerprint === next.fingerprint
  );
}

function resolveContextEngineCitationsMode(config: unknown): JsonValue | undefined {
  const rootConfig = isUnknownRecord(config) ? config : undefined;
  const memoryConfig = isUnknownRecord(rootConfig?.memory) ? rootConfig.memory : undefined;
  const citations = memoryConfig?.citations;
  return isJsonConfigValue(citations) ? citations : undefined;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isJsonConfigValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonConfigValue);
  }
  return isUnknownRecord(value) && Object.values(value).every(isJsonConfigValue);
}

function shouldRecheckRecoverablePluginBinding(params: {
  binding: CodexAppServerThreadBinding;
  pluginThreadConfig?: CodexPluginThreadConfigProvider;
}): boolean {
  if (!params.pluginThreadConfig?.enabled) {
    return false;
  }
  if (
    !params.binding.pluginAppsFingerprint ||
    !params.binding.pluginAppsInputFingerprint ||
    params.binding.pluginAppsInputFingerprint !== params.pluginThreadConfig.inputFingerprint
  ) {
    return false;
  }
  const policyContext = params.binding.pluginAppPolicyContext;
  if (!policyContext) {
    return false;
  }
  const expectedPluginConfigKeys = params.pluginThreadConfig.enabledPluginConfigKeys ?? [];
  return Object.keys(policyContext.apps).length === 0 || expectedPluginConfigKeys.length > 0;
}

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
    hostCrestodianActive?: boolean;
    ringZeroInheritedMcpServerNames?: readonly string[];
  },
): CodexThreadStartParams {
  const ringZeroActive =
    (options.hostCrestodianActive ?? isHostScopedAgentToolActive("crestodian")) &&
    isCrestodianOnlyCodexDynamicToolAllowlist(params.toolsAllow);
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
      hostCrestodianActive: options.hostCrestodianActive,
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
    hostCrestodianActive?: boolean;
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
      hostCrestodianActive: options.hostCrestodianActive,
      ringZeroInheritedMcpServerNames: options.ringZeroInheritedMcpServerNames,
    }),
    developerInstructions:
      options.developerInstructions ??
      buildDeveloperInstructions(params, { dynamicTools: options.dynamicTools }),
  };
}

export function resolveCodexBindingModelProviderFallback(params: {
  provider?: string;
  currentModel: string | undefined;
  bindingModel: string | undefined;
  bindingModelProvider: string | undefined;
}): string | undefined {
  const provider = params.provider?.trim().toLowerCase();
  if (provider && provider !== "codex") {
    return undefined;
  }
  const currentModel = params.currentModel?.trim();
  const bindingModel = params.bindingModel?.trim();
  if (
    currentModel &&
    bindingModel &&
    currentModel === bindingModel &&
    params.bindingModelProvider
  ) {
    return params.bindingModelProvider;
  }
  return hasProviderQualifiedModelRef(currentModel) ? undefined : params.bindingModelProvider;
}

export function resolveCodexAppServerThreadModelSelection(params: {
  provider: string;
  model: string;
  binding?: Pick<
    CodexAppServerThreadBinding,
    "threadId" | "authProfileId" | "model" | "modelProvider"
  >;
  authProfileId?: string;
  authProfileStore?: CodexAppServerAuthProfileLookup["authProfileStore"];
  agentDir?: string;
  config?: CodexAppServerAuthProfileLookup["config"];
}): { model: string; modelProvider?: string } {
  const authProfileId = params.authProfileId ?? params.binding?.authProfileId;
  const explicitModelProvider = resolveCodexAppServerModelProvider({
    provider: params.provider,
    authProfileId,
    authProfileStore: params.authProfileStore,
    agentDir: params.agentDir,
    config: params.config,
  });
  const bindingModelProvider = params.binding?.threadId
    ? resolveCodexBindingModelProviderFallback({
        provider: params.provider,
        currentModel: params.model,
        bindingModel: params.binding.model,
        bindingModelProvider: params.binding.modelProvider,
      })
    : undefined;
  return resolveCodexAppServerRequestModelSelection({
    model: params.model,
    modelProvider: explicitModelProvider ?? bindingModelProvider,
    authProfileId,
    authProfileStore: params.authProfileStore,
    agentDir: params.agentDir,
    config: params.config,
  });
}

export function resolveCodexAppServerRequestModelSelection(params: {
  model: string;
  modelProvider?: string | null;
  authProfileId?: string;
  authProfileStore?: CodexAppServerAuthProfileLookup["authProfileStore"];
  agentDir?: string;
  config?: CodexAppServerAuthProfileLookup["config"];
}): { model: string; modelProvider?: string } {
  const model = params.model.trim();
  const modelProvider = params.modelProvider?.trim();
  if (modelProvider) {
    return { model, modelProvider };
  }
  // Codex app-server expects provider-qualified refs as separate fields. Keep
  // explicit providers intact so provider-owned slashy model ids are not split.
  const slashIndex = model.indexOf("/");
  if (slashIndex <= 0 || slashIndex >= model.length - 1) {
    return { model };
  }
  const inferredProvider = model.slice(0, slashIndex);
  const inferredModelProvider = resolveCodexAppServerModelProvider({
    provider: inferredProvider,
    authProfileId: params.authProfileId,
    authProfileStore: params.authProfileStore,
    agentDir: params.agentDir,
    config: params.config,
  });
  return {
    model: model.slice(slashIndex + 1).trim(),
    ...(inferredModelProvider ? { modelProvider: inferredModelProvider } : {}),
  };
}

function hasProviderQualifiedModelRef(model: string | undefined): boolean {
  const trimmed = model?.trim();
  const slashIndex = trimmed?.indexOf("/") ?? -1;
  return slashIndex > 0 && slashIndex < (trimmed?.length ?? 0) - 1;
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

function buildCodexRuntimeThreadConfigForRun(
  params: EmbeddedRunAttemptParams,
  config: JsonObject | undefined,
  options: {
    nativeCodeModeEnabled?: boolean;
    nativeProviderWebSearchSupport?: CodexNativeWebSearchSupport;
    nativeCodeModeOnlyEnabled?: boolean;
    directOnlyToolNamespaces?: readonly string[];
    webSearchAllowed?: boolean;
    appServer?: Pick<CodexAppServerRuntimeOptions, "networkProxy">;
    hostCrestodianActive?: boolean;
    ringZeroInheritedMcpServerNames?: readonly string[];
  } = {},
): JsonObject {
  const ringZeroActive =
    (options.hostCrestodianActive ?? isHostScopedAgentToolActive("crestodian")) &&
    isCrestodianOnlyCodexDynamicToolAllowlist(params.toolsAllow);
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
        options.hostCrestodianActive,
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
  hostCrestodianActive = isHostScopedAgentToolActive("crestodian"),
  inheritedMcpServerNames: readonly string[] = [],
): JsonObject | undefined {
  if (!hostCrestodianActive || !isCrestodianOnlyCodexDynamicToolAllowlist(params.toolsAllow)) {
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

export function buildTurnStartParams(
  params: EmbeddedRunAttemptParams,
  options: {
    threadId: string;
    cwd: string;
    appServer: CodexAppServerRuntimeOptions;
    promptText?: string;
    sandboxPolicy?: CodexSandboxPolicy;
    environmentSelection?: CodexTurnEnvironmentParams[];
    model?: string | null;
    modelProvider?: string | null;
    turnScopedDeveloperInstructions?: string;
    skillsCollaborationInstructions?: string;
    memoryCollaborationInstructions?: string;
    heartbeatCollaborationInstructions?: string;
    preserveNativeTurnSettings?: boolean;
  },
): CodexTurnStartParams {
  const modelSelection = options.preserveNativeTurnSettings
    ? undefined
    : resolveCodexAppServerRequestModelSelection({
        model: options.model ?? params.modelId,
        modelProvider: options.modelProvider,
        authProfileId: params.authProfileId,
        authProfileStore: params.authProfileStore,
        agentDir: params.agentDir,
        config: params.config,
      });
  const useThreadPermissionProfile = options.appServer.networkProxy && !options.sandboxPolicy;
  return {
    threadId: options.threadId,
    input: buildUserInput(params, options.promptText),
    cwd: options.cwd,
    approvalPolicy: options.appServer.approvalPolicy,
    approvalsReviewer: options.appServer.approvalsReviewer,
    ...(useThreadPermissionProfile
      ? {}
      : {
          sandboxPolicy:
            options.sandboxPolicy ??
            codexSandboxPolicyForTurn(options.appServer.sandbox, options.cwd),
        }),
    ...(modelSelection
      ? { model: modelSelection.model, personality: CODEX_NATIVE_PERSONALITY_NONE }
      : {}),
    ...(options.appServer.serviceTier !== undefined
      ? { serviceTier: options.appServer.serviceTier }
      : {}),
    ...(modelSelection
      ? {
          effort: resolveReasoningEffort(
            params.thinkLevel,
            modelSelection.model,
            readCodexSupportedReasoningEfforts(params.model?.compat),
          ),
        }
      : {}),
    ...(options.environmentSelection ? { environments: options.environmentSelection } : {}),
    ...(modelSelection
      ? {
          collaborationMode: buildTurnCollaborationMode(params, {
            model: modelSelection.model,
            turnScopedDeveloperInstructions: options.turnScopedDeveloperInstructions,
            skillsCollaborationInstructions: options.skillsCollaborationInstructions,
            memoryCollaborationInstructions: options.memoryCollaborationInstructions,
            heartbeatCollaborationInstructions: options.heartbeatCollaborationInstructions,
          }),
        }
      : {}),
  };
}

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

type CodexTurnCollaborationMode = NonNullable<CodexTurnStartParams["collaborationMode"]>;

export function buildTurnCollaborationMode(
  params: EmbeddedRunAttemptParams,
  options: {
    model?: string;
    turnScopedDeveloperInstructions?: string;
    skillsCollaborationInstructions?: string;
    memoryCollaborationInstructions?: string;
    heartbeatCollaborationInstructions?: string;
  } = {},
): CodexTurnCollaborationMode {
  const model = options.model ?? params.modelId;
  return {
    mode: "default",
    settings: {
      model,
      reasoning_effort: resolveReasoningEffort(
        params.thinkLevel,
        model,
        readCodexSupportedReasoningEfforts(params.model?.compat),
      ),
      developer_instructions: buildTurnScopedCollaborationInstructions(params, options),
    },
  };
}

function buildTurnScopedCollaborationInstructions(
  params: EmbeddedRunAttemptParams,
  options: {
    turnScopedDeveloperInstructions?: string;
    skillsCollaborationInstructions?: string;
    memoryCollaborationInstructions?: string;
    heartbeatCollaborationInstructions?: string;
  } = {},
): string | null {
  const contextInstructions = joinPresentSections(
    options.turnScopedDeveloperInstructions,
    options.memoryCollaborationInstructions,
    options.skillsCollaborationInstructions,
  );
  if (params.trigger === "cron") {
    return joinPresentSections(buildCronCollaborationInstructions(), contextInstructions);
  }
  if (params.trigger === "heartbeat" && params.bootstrapContextRunKind !== "commitment-only") {
    return joinPresentSections(
      buildHeartbeatCollaborationInstructions(),
      contextInstructions,
      options.heartbeatCollaborationInstructions,
    );
  }
  if (contextInstructions?.trim()) {
    return joinPresentSections(buildDefaultCollaborationInstructions(), contextInstructions);
  }
  return null;
}

function buildDefaultCollaborationInstructions(): string {
  // Codex only applies the built-in Default-mode preset when `developer_instructions`
  // is null. OpenClaw adds per-turn workspace instructions here, so preserve that
  // pinned Codex default behavior before appending the workspace overlay.
  return [
    "# Collaboration Mode: Default",
    "",
    "You are now in Default mode. Any previous instructions for other modes (e.g. Plan mode) are no longer active.",
    "",
    "Your active mode changes only when new developer instructions with a different `<collaboration_mode>...</collaboration_mode>` change it; user requests or tool descriptions do not change mode by themselves. Known mode names are Default and Plan.",
    "",
    "## request_user_input availability",
    "",
    "Use the `request_user_input` tool only when it is listed in the available tools for this turn.",
    "",
    "In Default mode, strongly prefer making reasonable assumptions and executing the user's request rather than stopping to ask questions. If you absolutely must ask a question because the answer cannot be discovered from local context and a reasonable assumption would be risky, ask the user directly with a concise plain-text question. Never write a multiple choice question as a textual assistant message.",
  ].join("\n");
}

function buildCronCollaborationInstructions(): string {
  return [
    "This is an OpenClaw cron automation turn. Apply these instructions only to this scheduled job; ordinary chat turns should stay in Codex Default mode.",
    "Execute the cron payload directly. If it asks you to run an exact command, run that command before doing any investigation, planning, memory review, or workspace bootstrap.",
    "Use context already provided by the runtime, but do not spend time loading or re-reading workspace bootstrap, memory, or project-doc files before executing the cron payload. Inspect those files only if the payload asks for them or the command fails and they are needed to diagnose it.",
    "Keep output concise and automation-oriented. Prefer the final command result or a short failure summary over status narration.",
  ].join("\n\n");
}

function buildHeartbeatCollaborationInstructions(): string {
  return [
    "This is an OpenClaw heartbeat turn. Apply these instructions only to this heartbeat wake; ordinary chat turns should stay in Codex Default mode.",
    "When you are ready to end the heartbeat, prefer the structured `heartbeat_respond` tool so OpenClaw can record the wake outcome and notification decision. If `heartbeat_respond` is not already available and `tool_search` is available, search for `heartbeat_respond`, load it, then call it. Use `notify=false` when nothing should visibly interrupt the user.",
    CODEX_GPT5_HEARTBEAT_PROMPT_OVERLAY,
  ].join("\n\n");
}

function joinPresentSections(...sections: Array<string | undefined>): string {
  return sections.filter((section): section is string => Boolean(section?.trim())).join("\n\n");
}

export function codexDynamicToolsFingerprint(dynamicTools: CodexDynamicToolSpec[]): string {
  return fingerprintDynamicTools(dynamicTools);
}

export function areCodexDynamicToolFingerprintsCompatible(params: {
  previous?: string;
  next: string;
}): boolean {
  return areDynamicToolFingerprintsCompatible(params.previous, params.next);
}

function fingerprintDynamicTools(dynamicTools: CodexDynamicToolSpec[]): string {
  return JSON.stringify(
    dynamicTools.map(fingerprintDynamicToolSpec).toSorted(compareJsonFingerprint),
  );
}

function fingerprintUserMcpServersConfigPatch(
  configPatch: JsonObject | undefined,
): string | undefined {
  return configPatch
    ? JSON.stringify(stabilizeJsonValue(redactUserMcpServersFingerprintSecrets(configPatch)))
    : undefined;
}

function redactUserMcpServersFingerprintSecrets(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(redactUserMcpServersFingerprintSecrets);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const next: JsonObject = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "http_headers" && entry && typeof entry === "object" && !Array.isArray(entry)) {
      next[key] = Object.fromEntries(
        Object.entries(entry).map(([header, headerValue]) => [
          header,
          header.toLowerCase() === "authorization"
            ? fingerprintUserMcpServersAuthorizationHeader(headerValue)
            : headerValue,
        ]),
      ) as JsonObject;
      continue;
    }
    next[key] = redactUserMcpServersFingerprintSecrets(entry);
  }
  return next;
}

function fingerprintUserMcpServersAuthorizationHeader(value: unknown): string {
  return typeof value === "string" && value.length > 0
    ? `<redacted:sha256:${crypto.createHash("sha256").update(value).digest("hex")}>`
    : "<redacted>";
}

function fingerprintJsonObject(value: JsonObject): string {
  return JSON.stringify(stabilizeJsonValue(value));
}

function fingerprintEnvironmentSelection(
  environments: CodexTurnEnvironmentParams[] | undefined,
): string | undefined {
  return environments ? JSON.stringify(environments.map(stabilizeJsonValue)) : undefined;
}

function fingerprintDynamicToolSpec(tool: JsonValue): JsonValue {
  return stabilizeDynamicToolFingerprintValue(tool);
}

function stabilizeDynamicToolFingerprintValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(stabilizeDynamicToolFingerprintValue);
  }
  if (!isJsonObject(value)) {
    return value;
  }

  const stable: JsonObject = {};
  for (const [key, child] of Object.entries(value).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (key === "description") {
      continue;
    }
    stable[key] = stabilizeDynamicToolFingerprintValue(child);
  }
  return stable;
}

function stabilizeJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(stabilizeJsonValue);
  }
  if (!isJsonObject(value)) {
    return value;
  }
  const stable: JsonObject = {};
  for (const [key, child] of Object.entries(value).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    stable[key] = stabilizeJsonValue(child);
  }
  return stable;
}

function readActiveCodexTurnIds(thread: unknown): string[] {
  const turns = (thread as { turns?: Array<{ id?: unknown; status?: unknown }> }).turns;
  return (turns ?? [])
    .filter((turn) => turn.status === "inProgress")
    .map((turn) => (typeof turn.id === "string" ? turn.id : ""))
    .filter((turnId) => turnId.trim().length > 0);
}

const EMPTY_DYNAMIC_TOOLS_FINGERPRINT = JSON.stringify([]);

function areDynamicToolFingerprintsCompatible(previous: string | undefined, next: string): boolean {
  return !previous || previous === next;
}

function shouldStartTransientNoToolThread(params: {
  previous: string | undefined;
  next: string;
}): boolean {
  return Boolean(
    params.previous &&
    params.previous !== EMPTY_DYNAMIC_TOOLS_FINGERPRINT &&
    params.next === EMPTY_DYNAMIC_TOOLS_FINGERPRINT,
  );
}

function compareJsonFingerprint(left: JsonValue, right: JsonValue): number {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}

export function buildDeveloperInstructions(
  params: EmbeddedRunAttemptParams,
  options: { dynamicTools?: readonly CodexDynamicToolSpec[] } = {},
): string {
  const nativeCommandGuidance = listRegisteredPluginAgentPromptGuidance({
    surface: "codex_app_server",
    includeLegacyGlobalGuidance: false,
  }).join("\n");
  const sections = [
    "You are a personal agent running inside OpenClaw. OpenClaw has dynamic tools for OpenClaw-owned messaging, cron, sessions, media, gateway, and nodes.",
    buildDeferredDynamicToolManifest(options.dynamicTools),
    buildSkillWorkshopInstruction(options.dynamicTools),
    // Codex defers native collab tools behind tool_search on search-capable
    // models (codex-rs spec_plan add_collaboration_tools). Without this hint
    // models cannot see spawn_agent and grab the always-direct sessions_spawn.
    "Use Codex native `spawn_agent` for Codex subagents. `spawn_agent` and the other native collaboration tools may be deferred: when `spawn_agent` is not directly listed, load it with `tool_search` before spawning. Use OpenClaw `sessions_spawn` only for OpenClaw or ACP delegation, never as a substitute for `spawn_agent`.",
    buildVisibleReplyInstruction(params, options.dynamicTools),
    nativeCommandGuidance,
    params.extraSystemPrompt,
  ];
  return sections.filter((section) => typeof section === "string" && section.trim()).join("\n\n");
}

function buildDeferredDynamicToolManifest(
  dynamicTools: readonly CodexDynamicToolSpec[] | undefined,
): string | undefined {
  const deferredToolNames = [
    ...new Set(
      flattenCodexDynamicToolFunctions(dynamicTools)
        .filter((tool) => tool.deferLoading === true)
        .map((tool) => tool.name.trim())
        .filter(Boolean),
    ),
  ].toSorted((left, right) => left.localeCompare(right));
  if (deferredToolNames.length === 0) {
    return undefined;
  }
  return `Deferred searchable OpenClaw dynamic tools available: ${deferredToolNames.join(", ")}. Use \`tool_search\` to load exact callable specs before use.`;
}

function buildSkillWorkshopInstruction(
  dynamicTools: readonly CodexDynamicToolSpec[] | undefined,
): string | undefined {
  const hasSkillWorkshop = flattenCodexDynamicToolFunctions(dynamicTools).some(
    (tool) => tool.name.trim() === SKILL_WORKSHOP_TOOL_NAME,
  );
  if (!hasSkillWorkshop) {
    return undefined;
  }
  return buildSkillWorkshopPromptSection().join("\n");
}

function buildVisibleReplyInstruction(
  params: EmbeddedRunAttemptParams,
  dynamicTools: readonly CodexDynamicToolSpec[] | undefined,
): string {
  const messageToolAvailable = dynamicTools
    ? flattenCodexDynamicToolFunctions(dynamicTools).some((tool) => tool.name.trim() === "message")
    : params.disableMessageTool !== true;
  if (params.sourceReplyDeliveryMode === "message_tool_only" && messageToolAvailable) {
    return "Visible source replies are not automatically delivered for this run. Use `message(action=send)` for user-visible source-channel output. Do not repeat that visible content in your final answer.";
  }
  if (messageToolAvailable) {
    return "For the current source conversation, reply normally in your final assistant message; OpenClaw will deliver it through the active source conversation. Use `message` only for explicit out-of-band sends, media/file sends, or sends to a different target.";
  }
  return "For the current source conversation, reply normally in your final assistant message; OpenClaw will deliver it through the active source conversation.";
}

function buildUserInput(
  params: EmbeddedRunAttemptParams,
  promptText: string = params.prompt,
): CodexUserInput[] {
  const imageInputs = (params.images ?? []).map((image): CodexUserInput => {
    const imageUrl = sanitizeInlineImageDataUrl(`data:${image.mimeType};base64,${image.data}`);
    return imageUrl
      ? { type: "image", url: imageUrl }
      : {
          type: "text",
          text: invalidInlineImageText("codex user input"),
          text_elements: [],
        };
  });
  return [{ type: "text", text: promptText, text_elements: [] }, ...imageInputs];
}

export function resolveCodexAppServerModelProvider(params: {
  provider: string;
  authProfileId?: string;
  authProfileStore?: CodexAppServerAuthProfileLookup["authProfileStore"];
  agentDir?: string;
  config?: CodexAppServerAuthProfileLookup["config"];
}): string | undefined {
  const normalized = params.provider.trim();
  const normalizedLower = normalized.toLowerCase();
  if (!normalized || normalizedLower === "codex") {
    // `codex` is OpenClaw's virtual provider; let Codex app-server keep its
    // native provider/auth selection instead of forcing the legacy OpenAI path.
    return undefined;
  }
  if (isCodexAppServerNativeAuthProfile(params) && normalizedLower === "openai") {
    // When OpenClaw is forwarding ChatGPT/Codex OAuth, `openai` is Codex's
    // native provider id, not a public OpenAI API-key choice. Omit the override
    // so app-server keeps its configured provider/auth pair for this session.
    return undefined;
  }
  return normalizedLower === "openai" ? "openai" : normalized;
}

// Modern Codex models reject the legacy CLI `minimal` default. Prefer
// app-server metadata, then use the provider-owned fallback effort contract
// for Pro models whose minimum supported effort is `medium`.
// Other modern models translate `minimal` to `low`. (#71946)
// Exported for unit-test coverage of the model-aware translation path.
export function resolveReasoningEffort(
  thinkLevel: EmbeddedRunAttemptParams["thinkLevel"] | "ultra",
  modelId: string,
  supportedReasoningEfforts?: readonly string[],
): CodexReasoningEffort | null {
  if (thinkLevel === "off" || thinkLevel === "adaptive") {
    return null;
  }
  if (supportedReasoningEfforts) {
    return (
      resolveCodexSupportedReasoningEffort({
        requested: thinkLevel,
        supportedReasoningEfforts,
      }) ?? null
    );
  }
  const fallbackReasoningEfforts = resolveCodexFallbackReasoningEfforts(modelId);
  if (fallbackReasoningEfforts) {
    return (
      resolveCodexSupportedReasoningEffort({
        requested: thinkLevel,
        supportedReasoningEfforts: fallbackReasoningEfforts,
      }) ?? null
    );
  }
  if (thinkLevel === "minimal") {
    return isModernCodexModel(modelId) ? "low" : "minimal";
  }
  if (
    thinkLevel === "low" ||
    thinkLevel === "medium" ||
    thinkLevel === "high" ||
    thinkLevel === "xhigh"
  ) {
    return thinkLevel;
  }
  if (thinkLevel === "max" && isMaxReasoningCodexModel(modelId)) {
    return "max";
  }
  return null;
}
