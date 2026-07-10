// Codex plugin module implements thread lifecycle behavior.
import {
  buildSkillWorkshopPromptSection,
  embeddedAgentLog,
  formatErrorMessage,
  isActiveHarnessContextEngine,
  SKILL_WORKSHOP_TOOL_NAME,
  type EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { buildCodexUserMcpServersThreadConfigPatch } from "openclaw/plugin-sdk/codex-mcp-projection";
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
  isCodexAppServerConnectionClosedError,
  type CodexAppServerClient,
} from "./client.js";
import { codexSandboxPolicyForTurn, type CodexAppServerRuntimeOptions } from "./config.js";
import {
  resolveCodexContextEngineProjectionMaxChars,
  resolveCodexContextEngineProjectionReserveTokens,
} from "./context-engine-projection.js";
import {
  normalizeCodexDynamicToolName,
  shouldDisableCodexToolSearchForModel,
} from "./dynamic-tool-profile.js";
import { invalidInlineImageText, sanitizeInlineImageDataUrl } from "./image-payload-sanitizer.js";
import {
  buildCodexPluginAppsConfigPatchFromPolicyContext,
  isCodexPluginThreadBindingStale,
  mergeCodexThreadConfigs,
  type CodexPluginThreadConfig,
} from "./plugin-thread-config.js";
import { isCodexAppServerProfilerEnabled } from "./profiler-flag.js";
import { assertCodexThreadStartResponse } from "./protocol-validators.js";
import {
  CODEX_OPENCLAW_DIRECT_DYNAMIC_TOOL_NAMESPACE,
  flattenCodexDynamicToolFunctions,
  isJsonObject,
  type CodexDynamicToolSpec,
  type CodexSandboxPolicy,
  type CodexThreadResumeParams,
  type CodexThreadStartParams,
  type CodexTurnEnvironmentParams,
  type CodexTurnStartParams,
  type JsonObject,
  type CodexUserInput,
  type JsonValue,
} from "./protocol.js";
import {
  isCodexAppServerNativeAuthProfile,
  normalizeCodexAppServerBindingModelProvider,
  reclaimCurrentCodexSessionGeneration,
  sessionBindingIdentity,
  type CodexAppServerAuthProfileLookup,
  type CodexAppServerBindingIdentity,
  type CodexAppServerBindingStore,
  type CodexAppServerContextEngineBinding,
  type CodexAppServerContextEngineProjectionBinding,
  type CodexAppServerThreadBinding,
} from "./session-binding.js";
import { resumeCodexAppServerThread } from "./thread-resume.js";
import { resolveCodexWebSearchPlan, type CodexNativeWebSearchSupport } from "./web-search.js";

export type CodexAppServerThreadLifecycle = {
  action: "started" | "resumed";
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

export type CodexThreadLifecycleTimingAction = "started" | "resumed" | "rotated";

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
        : buildCodexUserMcpServersThreadConfigPatch(params.params.config, {
            agentId: params.agentId ?? params.params.agentId,
          });
    const userMcpServersFingerprint =
      fingerprintUserMcpServersConfigPatch(userMcpServersConfigPatch);
    const environmentSelectionFingerprint = fingerprintEnvironmentSelection(
      params.environmentSelection,
    );
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
    const clearCurrentBinding = async (operation: string) => {
      const current = binding;
      if (!current?.threadId) {
        return;
      }
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
      shouldRotateCodexAppServerBindingForRuntime({
        connectionClass: params.appServer.connectionClass,
        current: params.appServerRuntimeFingerprint,
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
      params.nativeProviderWebSearchSupport === "unknown" && !binding?.threadId;
    let rotatedContextEngineBinding = false;
    let prebuiltPluginThreadConfig: CodexPluginThreadConfig | undefined;
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
      if (
        transientNativeToolRestriction ||
        (webSearchBindingChanged &&
          (explicitTransientWebSearchRestriction || unknownProviderWebSearchSupport))
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
      if (transientWebSearchRestriction) {
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
    if (binding?.threadId && transientNativeToolRestriction) {
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
          const authProfileId = params.params.authProfileId ?? resumeBinding.authProfileId;
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
              appServer: params.appServer,
              dynamicTools: params.dynamicTools,
              developerInstructions: params.developerInstructions,
              config: resumeConfig,
              nativeCodeModeEnabled: params.nativeCodeModeEnabled,
              nativeProviderWebSearchSupport: params.nativeProviderWebSearchSupport,
              nativeCodeModeOnlyEnabled: params.nativeCodeModeOnlyEnabled,
              webSearchAllowed: params.webSearchAllowed,
            }),
          );
          const requestModelProvider =
            typeof resumeParams.modelProvider === "string" && resumeParams.modelProvider.trim()
              ? resumeParams.modelProvider
              : undefined;
          // Keep ownership accounting atomic with the resume request: a
          // pre-aborted request retains no subscription, so it must not reserve.
          throwIfAborted();
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
            modelProvider: normalizeBindingModelProvider(
              boundAuthProfileId,
              response.modelProvider ?? requestModelProvider ?? startModelProvider,
            ),
            dynamicToolsFingerprint,
            dynamicToolsContainDeferred,
            webSearchThreadConfigFingerprint,
            userMcpServersFingerprint,
            mcpServersFingerprint: nextMcpServersFingerprint,
            networkProxyProfileName: params.appServer.networkProxy?.profileName,
            networkProxyConfigFingerprint,
            nativeHookRelayGeneration:
              finalConfigPatch.nativeHookRelayGeneration ?? resumeBinding.nativeHookRelayGeneration,
            appServerRuntimeFingerprint: params.appServerRuntimeFingerprint,
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
  },
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
    cwd: options.cwd,
    approvalPolicy: options.appServer.approvalPolicy,
    approvalsReviewer: resolveCodexThreadApprovalsReviewer(options.appServer, options.config),
    ...codexThreadSandboxOrPermissions(options.appServer),
    ...(options.appServer.serviceTier !== undefined
      ? { serviceTier: options.appServer.serviceTier }
      : {}),
    personality: CODEX_NATIVE_PERSONALITY_NONE,
    serviceName: "OpenClaw",
    config: buildCodexRuntimeThreadConfigForRun(params, options.config, {
      nativeCodeModeEnabled: options.nativeCodeModeEnabled,
      nativeProviderWebSearchSupport: options.nativeProviderWebSearchSupport,
      nativeCodeModeOnlyEnabled: options.nativeCodeModeOnlyEnabled,
      directOnlyToolNamespaces: resolveDirectOnlyToolNamespaces(options.dynamicTools),
      webSearchAllowed: options.webSearchAllowed,
      appServer: options.appServer,
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
  },
): CodexThreadResumeParams {
  const resolvedModelProvider = resolveCodexAppServerModelProvider({
    provider: params.provider,
    authProfileId: options.authProfileId ?? params.authProfileId,
    authProfileStore: params.authProfileStore,
    agentDir: params.agentDir,
    config: params.config,
  });
  const modelSelection = resolveCodexAppServerRequestModelSelection({
    model: options.model ?? params.modelId,
    modelProvider: options.modelProvider ?? resolvedModelProvider,
    authProfileId: options.authProfileId ?? params.authProfileId,
    authProfileStore: params.authProfileStore,
    agentDir: params.agentDir,
    config: params.config,
  });
  return {
    threadId: options.threadId,
    model: modelSelection.model,
    ...(modelSelection.modelProvider ? { modelProvider: modelSelection.modelProvider } : {}),
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
  } = {},
): JsonObject {
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
  },
): CodexTurnStartParams {
  const modelSelection = resolveCodexAppServerRequestModelSelection({
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
    model: modelSelection.model,
    personality: CODEX_NATIVE_PERSONALITY_NONE,
    ...(options.appServer.serviceTier !== undefined
      ? { serviceTier: options.appServer.serviceTier }
      : {}),
    effort: resolveReasoningEffort(
      params.thinkLevel,
      modelSelection.model,
      readCodexSupportedReasoningEfforts(params.model?.compat),
    ),
    ...(options.environmentSelection ? { environments: options.environmentSelection } : {}),
    collaborationMode: buildTurnCollaborationMode(params, {
      model: modelSelection.model,
      turnScopedDeveloperInstructions: options.turnScopedDeveloperInstructions,
      skillsCollaborationInstructions: options.skillsCollaborationInstructions,
      memoryCollaborationInstructions: options.memoryCollaborationInstructions,
      heartbeatCollaborationInstructions: options.heartbeatCollaborationInstructions,
    }),
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
  return configPatch ? JSON.stringify(stabilizeJsonValue(configPatch)) : undefined;
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
