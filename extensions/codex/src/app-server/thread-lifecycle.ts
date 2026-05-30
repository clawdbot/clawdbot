import {
  embeddedAgentLog,
  formatErrorMessage,
  isActiveHarnessContextEngine,
  type EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { buildCodexUserMcpServersThreadConfigPatch } from "openclaw/plugin-sdk/codex-mcp-projection";
import { listRegisteredPluginAgentPromptGuidance } from "openclaw/plugin-sdk/plugin-runtime";
import { CODEX_GPT5_HEARTBEAT_PROMPT_OVERLAY } from "../../prompt-overlay.js";
import { isModernCodexModel } from "../../provider.js";
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
import { invalidInlineImageText, sanitizeInlineImageDataUrl } from "./image-payload-sanitizer.js";
import {
  isCodexPluginThreadBindingStale,
  mergeCodexThreadConfigs,
  type CodexPluginThreadConfig,
} from "./plugin-thread-config.js";
import { isCodexAppServerProfilerEnabled } from "./profiler-flag.js";
import {
  assertCodexThreadResumeResponse,
  assertCodexThreadStartResponse,
} from "./protocol-validators.js";
import {
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
  clearCodexAppServerBinding,
  isCodexAppServerNativeAuthProfile,
  readCodexAppServerBinding,
  writeCodexAppServerBinding,
  type CodexAppServerAuthProfileLookup,
  type CodexAppServerContextEngineBinding,
  type CodexAppServerContextEngineProjectionBinding,
  type CodexAppServerThreadBinding,
} from "./session-binding.js";

export type CodexAppServerThreadLifecycle = {
  action: "started" | "resumed";
  rotatedContextEngineBinding?: boolean;
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

export function isCodexThreadStartRequestError(error: unknown): boolean {
  return error instanceof CodexThreadStartRequestError;
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

type CodexThreadLifecycleTimingSpan = {
  name: string;
  durationMs: number;
  elapsedMs: number;
};

type CodexThreadLifecycleTimingSummary = {
  totalMs: number;
  spans: CodexThreadLifecycleTimingSpan[];
};

const CODEX_THREAD_LIFECYCLE_TIMING_WARN_TOTAL_MS = 1_000;
const CODEX_THREAD_LIFECYCLE_TIMING_WARN_STAGE_MS = 500;

function createCodexThreadLifecycleTimingTracker(options: { enabled?: boolean } = {}): {
  measure: <T>(name: string, run: () => Promise<T> | T) => Promise<T>;
  measureSync: <T>(name: string, run: () => T) => T;
  logIfSlow: (params: {
    runId: string;
    sessionId: string;
    sessionKey?: string;
    action: "started" | "resumed" | "rotated";
    threadId?: string;
  }) => void;
} {
  if (!options.enabled) {
    return {
      async measure(_name, run) {
        return await run();
      },
      measureSync(_name, run) {
        return run();
      },
      logIfSlow() {},
    };
  }

  const startedAt = Date.now();
  let didLog = false;
  const spans: CodexThreadLifecycleTimingSpan[] = [];
  const toMs = (value: number) => Math.max(0, Math.round(value));
  const record = (name: string, spanStartedAt: number) => {
    spans.push({
      name,
      durationMs: toMs(Date.now() - spanStartedAt),
      elapsedMs: toMs(Date.now() - startedAt),
    });
  };
  const snapshot = (): CodexThreadLifecycleTimingSummary => ({
    totalMs: toMs(Date.now() - startedAt),
    spans: spans.slice(),
  });
  const shouldLog = (summary: CodexThreadLifecycleTimingSummary) =>
    summary.totalMs >= CODEX_THREAD_LIFECYCLE_TIMING_WARN_TOTAL_MS ||
    summary.spans.some((span) => span.durationMs >= CODEX_THREAD_LIFECYCLE_TIMING_WARN_STAGE_MS);
  const formatSpans = (summary: CodexThreadLifecycleTimingSummary) =>
    summary.spans.length > 0
      ? summary.spans
          .map((span) => `${span.name}:${span.durationMs}ms@${span.elapsedMs}ms`)
          .join(",")
      : "none";
  return {
    async measure(name, run) {
      const spanStartedAt = Date.now();
      try {
        return await run();
      } finally {
        record(name, spanStartedAt);
      }
    },
    measureSync(name, run) {
      const spanStartedAt = Date.now();
      try {
        return run();
      } finally {
        record(name, spanStartedAt);
      }
    },
    logIfSlow(params) {
      if (didLog) {
        return;
      }
      const summary = snapshot();
      if (!shouldLog(summary)) {
        return;
      }
      didLog = true;
      embeddedAgentLog.warn(
        `codex app-server thread lifecycle timings runId=${params.runId} sessionId=${
          params.sessionId
        } sessionKey=${params.sessionKey ?? "unknown"} action=${params.action} totalMs=${
          summary.totalMs
        } stages=${formatSpans(summary)}`,
        {
          runId: params.runId,
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          action: params.action,
          threadId: params.threadId,
          totalMs: summary.totalMs,
          spans: summary.spans,
        },
      );
    },
  };
}

export async function startOrResumeThread(params: {
  client: CodexAppServerClient;
  params: EmbeddedRunAttemptParams;
  agentId?: string;
  cwd: string;
  dynamicTools: CodexDynamicToolSpec[];
  appServer: CodexAppServerRuntimeOptions;
  developerInstructions?: string;
  config?: JsonObject;
  finalConfigPatch?: JsonObject;
  buildFinalConfigPatch?: (
    decision: CodexThreadFinalConfigPatchDecision,
  ) => CodexThreadFinalConfigPatchResult;
  nativeHookRelayGeneration?: string;
  nativeCodeModeEnabled?: boolean;
  nativeCodeModeOnlyEnabled?: boolean;
  userMcpServersEnabled?: boolean;
  mcpServersFingerprint?: string;
  mcpServersFingerprintEvaluated?: boolean;
  environmentSelection?: CodexTurnEnvironmentParams[];
  pluginThreadConfig?: CodexPluginThreadConfigProvider;
  contextEngineProjection?: CodexContextEngineThreadBootstrapProjection;
}): Promise<CodexAppServerThreadLifecycleBinding> {
  // Thread lifecycle spans are useful when profiling startup churn, but normal
  // turns should not pay Date.now/span-array overhead while resuming threads.
  const lifecycleTiming = createCodexThreadLifecycleTimingTracker({
    enabled: isCodexAppServerProfilerEnabled(params.params.config),
  });
  const dynamicToolsFingerprint = lifecycleTiming.measureSync("fingerprint_dynamic_tools", () =>
    fingerprintDynamicTools(params.dynamicTools),
  );
  const contextEngineBinding = lifecycleTiming.measureSync("context_engine_binding", () =>
    buildContextEngineBinding(params.params, params.contextEngineProjection),
  );
  const userMcpServersConfigPatch =
    params.userMcpServersEnabled === false
      ? undefined
      : buildCodexUserMcpServersThreadConfigPatch(params.params.config, {
          agentId: params.agentId ?? params.params.agentId,
        });
  const userMcpServersFingerprint = fingerprintUserMcpServersConfigPatch(userMcpServersConfigPatch);
  const environmentSelectionFingerprint = fingerprintEnvironmentSelection(
    params.environmentSelection,
  );
  let binding = await lifecycleTiming.measure("read_binding", () =>
    readCodexAppServerBinding(params.params.sessionFile, {
      authProfileStore: params.params.authProfileStore,
      agentDir: params.params.agentDir,
      config: params.params.config,
    }),
  );
  let preserveExistingBinding = false;
  let rotatedContextEngineBinding = false;
  let prebuiltPluginThreadConfig: CodexPluginThreadConfig | undefined;
  if (binding?.threadId && params.nativeCodeModeEnabled === false) {
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
      await clearCodexAppServerBinding(params.params.sessionFile);
      binding = undefined;
      rotatedContextEngineBinding = true;
    }
  }
  if (binding?.threadId && binding.userMcpServersFingerprint !== userMcpServersFingerprint) {
    embeddedAgentLog.debug("codex app-server user MCP config changed; starting a new thread", {
      threadId: binding.threadId,
    });
    await clearCodexAppServerBinding(params.params.sessionFile);
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
    await clearCodexAppServerBinding(params.params.sessionFile);
    binding = undefined;
  }
  if (
    binding?.threadId &&
    params.mcpServersFingerprintEvaluated === true &&
    binding.mcpServersFingerprint !== params.mcpServersFingerprint
  ) {
    embeddedAgentLog.debug("codex app-server MCP config changed; starting a new thread", {
      threadId: binding.threadId,
    });
    await clearCodexAppServerBinding(params.params.sessionFile);
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
        prebuiltPluginThreadConfig = await lifecycleTiming.measure("plugin_config_recovery", () =>
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
      embeddedAgentLog.debug("codex app-server plugin app config changed; starting a new thread", {
        threadId: binding.threadId,
      });
      await clearCodexAppServerBinding(params.params.sessionFile);
      binding = undefined;
    }
  }
  if (
    binding?.threadId &&
    params.mcpServersFingerprintEvaluated === true &&
    binding.mcpServersFingerprint !== params.mcpServersFingerprint
  ) {
    embeddedAgentLog.debug("codex app-server MCP config changed; starting a new thread", {
      threadId: binding.threadId,
    });
    await clearCodexAppServerBinding(params.params.sessionFile);
    binding = undefined;
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
        await clearCodexAppServerBinding(params.params.sessionFile);
      }
    } else {
      try {
        const authProfileId = params.params.authProfileId ?? binding.authProfileId;
        const finalConfigPatch = params.buildFinalConfigPatch?.({
          action: "resume",
          binding,
        }) ?? {
          configPatch: params.finalConfigPatch,
          nativeHookRelayGeneration: params.nativeHookRelayGeneration,
        };
        const resumeConfig = mergeCodexThreadConfigs(
          params.config,
          userMcpServersConfigPatch,
          finalConfigPatch.configPatch,
        );
        const resumeParams = lifecycleTiming.measureSync("thread_resume_params", () =>
          buildThreadResumeParams(params.params, {
            threadId: binding.threadId,
            authProfileId,
            appServer: params.appServer,
            dynamicTools: params.dynamicTools,
            developerInstructions: params.developerInstructions,
            config: resumeConfig,
            nativeCodeModeEnabled: params.nativeCodeModeEnabled,
            nativeCodeModeOnlyEnabled: params.nativeCodeModeOnlyEnabled,
          }),
        );
        const response = assertCodexThreadResumeResponse(
          await lifecycleTiming.measure("thread_resume_request", () =>
            params.client.request("thread/resume", resumeParams),
          ),
        );
        const boundAuthProfileId = authProfileId;
        const fallbackModelProvider = resolveCodexAppServerModelProvider({
          provider: params.params.provider,
          authProfileId: boundAuthProfileId,
          authProfileStore: params.params.authProfileStore,
          agentDir: params.params.agentDir,
          config: params.params.config,
        });
        const nextMcpServersFingerprint =
          params.mcpServersFingerprintEvaluated === true
            ? params.mcpServersFingerprint
            : binding.mcpServersFingerprint;
        await lifecycleTiming.measure("thread_resume_write_binding", () =>
          writeCodexAppServerBinding(
            params.params.sessionFile,
            {
              threadId: response.thread.id,
              cwd: params.cwd,
              authProfileId: boundAuthProfileId,
              model: params.params.modelId,
              modelProvider: response.modelProvider ?? fallbackModelProvider,
              dynamicToolsFingerprint,
              userMcpServersFingerprint,
              mcpServersFingerprint: nextMcpServersFingerprint,
              nativeHookRelayGeneration:
                finalConfigPatch.nativeHookRelayGeneration ?? binding.nativeHookRelayGeneration,
              pluginAppsFingerprint: binding.pluginAppsFingerprint,
              pluginAppsInputFingerprint: binding.pluginAppsInputFingerprint,
              pluginAppPolicyContext: binding.pluginAppPolicyContext,
              contextEngine: contextEngineBinding,
              environmentSelectionFingerprint,
              createdAt: binding.createdAt,
            },
            {
              authProfileStore: params.params.authProfileStore,
              agentDir: params.params.agentDir,
              config: params.params.config,
            },
          ),
        );
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
        lifecycleTiming.logIfSlow({
          runId: params.params.runId,
          sessionId: params.params.sessionId,
          sessionKey: params.params.sessionKey,
          threadId: response.thread.id,
          action: "resumed",
        });
        return {
          ...binding,
          threadId: response.thread.id,
          cwd: params.cwd,
          authProfileId: boundAuthProfileId,
          model: params.params.modelId,
          modelProvider: response.modelProvider ?? fallbackModelProvider,
          dynamicToolsFingerprint,
          userMcpServersFingerprint,
          mcpServersFingerprint: nextMcpServersFingerprint,
          nativeHookRelayGeneration:
            finalConfigPatch.nativeHookRelayGeneration ?? binding.nativeHookRelayGeneration,
          pluginAppsFingerprint: binding.pluginAppsFingerprint,
          pluginAppsInputFingerprint: binding.pluginAppsInputFingerprint,
          pluginAppPolicyContext: binding.pluginAppPolicyContext,
          contextEngine: contextEngineBinding,
          environmentSelectionFingerprint,
          lifecycle: { action: "resumed" },
        };
      } catch (error) {
        if (isCodexAppServerConnectionClosedError(error)) {
          throw error;
        }
        embeddedAgentLog.warn("codex app-server thread resume failed; starting a new thread", {
          error,
        });
        await clearCodexAppServerBinding(params.params.sessionFile);
      }
    }
  }

  const pluginThreadConfig = params.pluginThreadConfig?.enabled
    ? (prebuiltPluginThreadConfig ??
      (await lifecycleTiming.measure("plugin_config_build", () =>
        params.pluginThreadConfig?.build(),
      )))
    : undefined;
  const finalConfigPatch = params.buildFinalConfigPatch?.({ action: "start" }) ?? {
    configPatch: params.finalConfigPatch,
    nativeHookRelayGeneration: params.nativeHookRelayGeneration,
  };
  const config = lifecycleTiming.measureSync("merge_thread_config", () =>
    mergeCodexThreadConfigs(
      params.config,
      userMcpServersConfigPatch,
      pluginThreadConfig?.configPatch,
      finalConfigPatch.configPatch,
    ),
  );
  const startParams = lifecycleTiming.measureSync("thread_start_params", () =>
    buildThreadStartParams(params.params, {
      cwd: params.cwd,
      dynamicTools: params.dynamicTools,
      appServer: params.appServer,
      developerInstructions: params.developerInstructions,
      config,
      nativeCodeModeEnabled: params.nativeCodeModeEnabled,
      nativeCodeModeOnlyEnabled: params.nativeCodeModeOnlyEnabled,
      environmentSelection: params.environmentSelection,
    }),
  );
  const threadStartResponse = await lifecycleTiming.measure("thread_start_request", async () => {
    try {
      return await params.client.request("thread/start", startParams);
    } catch (error) {
      if (error instanceof CodexAppServerRpcError) {
        throw new CodexThreadStartRequestError(error);
      }
      throw error;
    }
  });
  const response = assertCodexThreadStartResponse(threadStartResponse);
  const modelProvider = resolveCodexAppServerModelProvider({
    provider: params.params.provider,
    authProfileId: params.params.authProfileId,
    authProfileStore: params.params.authProfileStore,
    agentDir: params.params.agentDir,
    config: params.params.config,
  });
  const createdAt = new Date().toISOString();
  const nextMcpServersFingerprint =
    params.mcpServersFingerprintEvaluated === true ? params.mcpServersFingerprint : undefined;
  if (!preserveExistingBinding) {
    await lifecycleTiming.measure("thread_start_write_binding", () =>
      writeCodexAppServerBinding(
        params.params.sessionFile,
        {
          threadId: response.thread.id,
          cwd: params.cwd,
          authProfileId: params.params.authProfileId,
          model: response.model ?? params.params.modelId,
          modelProvider: response.modelProvider ?? modelProvider,
          dynamicToolsFingerprint,
          userMcpServersFingerprint,
          mcpServersFingerprint: nextMcpServersFingerprint,
          nativeHookRelayGeneration: finalConfigPatch.nativeHookRelayGeneration,
          pluginAppsFingerprint: pluginThreadConfig?.fingerprint,
          pluginAppsInputFingerprint: pluginThreadConfig?.inputFingerprint,
          pluginAppPolicyContext: pluginThreadConfig?.policyContext,
          contextEngine: contextEngineBinding,
          environmentSelectionFingerprint,
          createdAt,
        },
        {
          authProfileStore: params.params.authProfileStore,
          agentDir: params.params.agentDir,
          config: params.params.config,
        },
      ),
    );
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
  lifecycleTiming.logIfSlow({
    runId: params.params.runId,
    sessionId: params.params.sessionId,
    sessionKey: params.params.sessionKey,
    threadId: response.thread.id,
    action: rotatedContextEngineBinding ? "rotated" : "started",
  });
  return {
    schemaVersion: 1,
    threadId: response.thread.id,
    sessionFile: params.params.sessionFile,
    cwd: params.cwd,
    authProfileId: params.params.authProfileId,
    model: response.model ?? params.params.modelId,
    modelProvider: response.modelProvider ?? modelProvider,
    dynamicToolsFingerprint,
    userMcpServersFingerprint,
    mcpServersFingerprint: nextMcpServersFingerprint,
    nativeHookRelayGeneration: finalConfigPatch.nativeHookRelayGeneration,
    pluginAppsFingerprint: pluginThreadConfig?.fingerprint,
    pluginAppsInputFingerprint: pluginThreadConfig?.inputFingerprint,
    pluginAppPolicyContext: pluginThreadConfig?.policyContext,
    contextEngine: contextEngineBinding,
    environmentSelectionFingerprint,
    createdAt,
    updatedAt: createdAt,
    lifecycle: {
      action: "started",
      ...(rotatedContextEngineBinding ? { rotatedContextEngineBinding } : {}),
    },
  };
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
    nativeCodeModeOnlyEnabled?: boolean;
    environmentSelection?: CodexTurnEnvironmentParams[];
  },
): CodexThreadStartParams {
  const modelProvider = resolveCodexAppServerModelProvider({
    provider: params.provider,
    authProfileId: params.authProfileId,
    authProfileStore: params.authProfileStore,
    agentDir: params.agentDir,
    config: params.config,
  });
  return {
    model: params.modelId,
    ...(modelProvider ? { modelProvider } : {}),
    cwd: options.cwd,
    approvalPolicy: options.appServer.approvalPolicy,
    approvalsReviewer: options.appServer.approvalsReviewer,
    sandbox: options.appServer.sandbox,
    ...(options.appServer.serviceTier ? { serviceTier: options.appServer.serviceTier } : {}),
    personality: CODEX_NATIVE_PERSONALITY_NONE,
    serviceName: "OpenClaw",
    config: buildCodexRuntimeThreadConfigForRun(params, options.config, {
      nativeCodeModeEnabled: options.nativeCodeModeEnabled,
      nativeCodeModeOnlyEnabled: options.nativeCodeModeOnlyEnabled,
    }),
    ...resolveCodexThreadEnvironmentSelection(options),
    developerInstructions:
      options.developerInstructions ??
      buildDeveloperInstructions(params, { dynamicTools: options.dynamicTools }),
    dynamicTools: options.dynamicTools,
    experimentalRawEvents: true,
    persistExtendedHistory: true,
  };
}

export function buildThreadResumeParams(
  params: EmbeddedRunAttemptParams,
  options: {
    threadId: string;
    authProfileId?: string;
    appServer: CodexAppServerRuntimeOptions;
    dynamicTools?: CodexDynamicToolSpec[];
    developerInstructions?: string;
    config?: JsonObject;
    nativeCodeModeEnabled?: boolean;
    nativeCodeModeOnlyEnabled?: boolean;
  },
): CodexThreadResumeParams {
  const modelProvider = resolveCodexAppServerModelProvider({
    provider: params.provider,
    authProfileId: options.authProfileId ?? params.authProfileId,
    authProfileStore: params.authProfileStore,
    agentDir: params.agentDir,
    config: params.config,
  });
  return {
    threadId: options.threadId,
    model: params.modelId,
    ...(modelProvider ? { modelProvider } : {}),
    approvalPolicy: options.appServer.approvalPolicy,
    approvalsReviewer: options.appServer.approvalsReviewer,
    sandbox: options.appServer.sandbox,
    ...(options.appServer.serviceTier ? { serviceTier: options.appServer.serviceTier } : {}),
    personality: CODEX_NATIVE_PERSONALITY_NONE,
    config: buildCodexRuntimeThreadConfigForRun(params, options.config, {
      nativeCodeModeEnabled: options.nativeCodeModeEnabled,
      nativeCodeModeOnlyEnabled: options.nativeCodeModeOnlyEnabled,
    }),
    developerInstructions:
      options.developerInstructions ??
      buildDeveloperInstructions(params, { dynamicTools: options.dynamicTools }),
    persistExtendedHistory: true,
  };
}

export function buildCodexRuntimeThreadConfig(
  config: JsonObject | undefined,
  options: { nativeCodeModeEnabled?: boolean; nativeCodeModeOnlyEnabled?: boolean } = {},
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
    return (
      mergeCodexThreadConfigs(codeModeConfig, config, {
        "features.code_mode_only": true,
      }) ?? {
        ...codeModeConfig,
        "features.code_mode_only": true,
      }
    );
  }
  return (
    mergeCodexThreadConfigs(codeModeConfig, config) ?? {
      ...codeModeConfig,
    }
  );
}

function buildCodexRuntimeThreadConfigForRun(
  params: EmbeddedRunAttemptParams,
  config: JsonObject | undefined,
  options: { nativeCodeModeEnabled?: boolean; nativeCodeModeOnlyEnabled?: boolean } = {},
): JsonObject {
  const runtimeConfig = buildCodexRuntimeThreadConfig(config, options);
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
    turnScopedDeveloperInstructions?: string;
    skillsCollaborationInstructions?: string;
    memoryCollaborationInstructions?: string;
    heartbeatCollaborationInstructions?: string;
  },
): CodexTurnStartParams {
  return {
    threadId: options.threadId,
    input: buildUserInput(params, options.promptText),
    cwd: options.cwd,
    approvalPolicy: options.appServer.approvalPolicy,
    approvalsReviewer: options.appServer.approvalsReviewer,
    sandboxPolicy:
      options.sandboxPolicy ?? codexSandboxPolicyForTurn(options.appServer.sandbox, options.cwd),
    model: params.modelId,
    personality: CODEX_NATIVE_PERSONALITY_NONE,
    ...(options.appServer.serviceTier ? { serviceTier: options.appServer.serviceTier } : {}),
    effort: resolveReasoningEffort(params.thinkLevel, params.modelId),
    ...(options.environmentSelection ? { environments: options.environmentSelection } : {}),
    collaborationMode: buildTurnCollaborationMode(params, {
      turnScopedDeveloperInstructions: options.turnScopedDeveloperInstructions,
      skillsCollaborationInstructions: options.skillsCollaborationInstructions,
      memoryCollaborationInstructions: options.memoryCollaborationInstructions,
      heartbeatCollaborationInstructions: options.heartbeatCollaborationInstructions,
    }),
  };
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
    turnScopedDeveloperInstructions?: string;
    skillsCollaborationInstructions?: string;
    memoryCollaborationInstructions?: string;
    heartbeatCollaborationInstructions?: string;
  } = {},
): CodexTurnCollaborationMode {
  return {
    mode: "default",
    settings: {
      model: params.modelId,
      reasoning_effort: resolveReasoningEffort(params.thinkLevel, params.modelId),
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
  if (params.trigger === "heartbeat") {
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

function fingerprintEnvironmentSelection(
  environments: CodexTurnEnvironmentParams[] | undefined,
): string | undefined {
  return environments ? JSON.stringify(environments.map(stabilizeJsonValue)) : undefined;
}

function fingerprintDynamicToolSpec(tool: JsonValue): JsonValue {
  if (!isJsonObject(tool)) {
    return stabilizeJsonValue(tool);
  }
  const stable: JsonObject = {};
  for (const [key, child] of Object.entries(tool).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    // Tool-search presentation can change per turn without changing the
    // durable app-server execution contract for an existing thread.
    if (key === "description" || key === "deferLoading" || key === "namespace") {
      continue;
    }
    stable[key] = stabilizeJsonValue(child);
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
    "Use Codex native `spawn_agent` for Codex subagents. Use OpenClaw `sessions_spawn` only for OpenClaw or ACP delegation.",
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
      (dynamicTools ?? [])
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

function buildVisibleReplyInstruction(
  params: EmbeddedRunAttemptParams,
  dynamicTools: readonly CodexDynamicToolSpec[] | undefined,
): string {
  const messageToolAvailable = dynamicTools
    ? dynamicTools.some((tool) => tool.name.trim() === "message")
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
  if (
    isCodexAppServerNativeAuthProfile(params) &&
    (normalizedLower === "openai" || normalizedLower === "openai-codex")
  ) {
    // When OpenClaw is forwarding ChatGPT/Codex OAuth, `openai` is Codex's
    // native provider id, not a public OpenAI API-key choice. Omit the override
    // so app-server keeps its configured provider/auth pair for this session.
    return undefined;
  }
  return normalizedLower === "openai-codex" ? "openai" : normalized;
}

// Modern Codex models (gpt-5.5, gpt-5.4, gpt-5.4-mini, gpt-5.3-codex-spark) use the
// none/low/medium/high/xhigh effort enum and reject "minimal". The CLI
// defaults thinkLevel to "minimal", so without translation EVERY agent turn
// on those models pays a wasted first request + retry-with-low fallback in
// embedded-agent-runner. Map "minimal" -> "low" upfront for modern models so the
// first request is accepted. Older Codex models still accept "minimal"
// directly. (#71946)
// Exported for unit-test coverage of the model-aware translation path.
export function resolveReasoningEffort(
  thinkLevel: EmbeddedRunAttemptParams["thinkLevel"],
  modelId: string,
): "minimal" | "low" | "medium" | "high" | "xhigh" | null {
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
  return null;
}
