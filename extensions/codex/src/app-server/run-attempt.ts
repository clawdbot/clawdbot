import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  assembleHarnessContextEngine,
  bootstrapHarnessContextEngine,
  buildHarnessContextEngineRuntimeContext,
  buildHarnessContextEngineRuntimeContextFromUsage,
  buildEmbeddedAttemptToolRunContext,
  clearActiveEmbeddedRun,
  embeddedAgentLog,
  emitAgentEvent as emitGlobalAgentEvent,
  finalizeHarnessContextEngineTurn,
  formatErrorMessage,
  isActiveHarnessContextEngine,
  isSubagentSessionKey,
  normalizeAgentRuntimeTools,
  resolveAttemptSpawnWorkspaceDir,
  resolveAgentHarnessBeforePromptBuildResult,
  resolveModelAuthMode,
  resolveSandboxContext,
  resolveSessionAgentIds,
  resolveUserPath,
  runAgentHarnessAgentEndHook,
  runAgentHarnessLlmInputHook,
  runAgentHarnessLlmOutputHook,
  runHarnessContextEngineMaintenance,
  registerNativeHookRelay,
  resolveBootstrapContextForRun,
  setActiveEmbeddedRun,
  supportsModelTools,
  runAgentCleanupStep,
  type AgentMessage,
  type EmbeddedRunAttemptParams,
  type EmbeddedRunAttemptResult,
  type EmbeddedContextFile,
  type NativeHookRelayEvent,
  type NativeHookRelayRegistrationHandle,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { resolveAgentDir } from "openclaw/plugin-sdk/agent-runtime";
import { emitTrustedDiagnosticEvent } from "openclaw/plugin-sdk/diagnostic-runtime";
import { pathExists } from "openclaw/plugin-sdk/security-runtime";
import {
  buildCodexAppInventoryCacheKey,
  defaultCodexAppInventoryCache,
} from "./app-inventory-cache.js";
import { handleCodexAppServerApprovalRequest } from "./approval-bridge.js";
import {
  refreshCodexAppServerAuthTokens,
  resolveCodexAppServerAuthAccountCacheKey,
  resolveCodexAppServerEnvApiKeyCacheKey,
  resolveCodexAppServerHomeDir,
  resolveCodexAppServerAuthProfileId,
  resolveCodexAppServerAuthProfileIdForAgent,
} from "./auth-bridge.js";
import {
  defaultCodexAppServerClientFactory,
  type CodexAppServerClientFactory,
} from "./client-factory.js";
import {
  isCodexAppServerApprovalRequest,
  isCodexAppServerConnectionClosedError,
  type CodexAppServerClient,
} from "./client.js";
import { ensureCodexComputerUse } from "./computer-use.js";
import {
  readCodexPluginConfig,
  resolveCodexPluginsPolicy,
  resolveCodexAppServerRuntimeOptions,
  withMcpElicitationsApprovalPolicy,
  type CodexAppServerRuntimeOptions,
  type CodexPluginConfig,
} from "./config.js";
import { projectContextEngineAssemblyForCodex } from "./context-engine-projection.js";
import { filterCodexDynamicTools, normalizeCodexDynamicToolName } from "./dynamic-tool-profile.js";
import { createCodexDynamicToolBridge, type CodexDynamicToolBridge } from "./dynamic-tools.js";
import { handleCodexAppServerElicitationRequest } from "./elicitation-bridge.js";
import { CodexAppServerEventProjector } from "./event-projector.js";
import {
  buildCodexNativeHookRelayDisabledConfig,
  buildCodexNativeHookRelayConfig,
  CODEX_NATIVE_HOOK_RELAY_EVENTS,
} from "./native-hook-relay.js";
import {
  buildCodexPluginThreadConfig,
  buildCodexPluginThreadConfigInputFingerprint,
  shouldBuildCodexPluginThreadConfig,
} from "./plugin-thread-config.js";
import {
  assertCodexTurnStartResponse,
  readCodexDynamicToolCallParams,
} from "./protocol-validators.js";
import {
  type CodexUserInput,
  isJsonObject,
  type CodexServerNotification,
  type CodexDynamicToolCallParams,
  type CodexDynamicToolCallResponse,
  type CodexTurnStartResponse,
  type JsonObject,
  type JsonValue,
} from "./protocol.js";
import { readRecentCodexRateLimits, rememberCodexRateLimits } from "./rate-limit-cache.js";
import { formatCodexUsageLimitErrorMessage } from "./rate-limits.js";
import { readCodexAppServerBinding, type CodexAppServerThreadBinding } from "./session-binding.js";
import { readCodexMirroredSessionHistoryMessages } from "./session-history.js";
import { clearSharedCodexAppServerClientIfCurrent } from "./shared-client.js";
import {
  areCodexDynamicToolFingerprintsCompatible,
  buildDeveloperInstructions,
  buildTurnStartParams,
  codexDynamicToolsFingerprint,
  startOrResumeThread,
} from "./thread-lifecycle.js";
import {
  inferCodexDynamicToolMeta,
  resolveCodexToolProgressDetailMode,
  sanitizeCodexToolArguments,
  sanitizeCodexToolResponse,
} from "./tool-progress-normalization.js";
import {
  createCodexTrajectoryRecorder,
  normalizeCodexTrajectoryError,
  recordCodexTrajectoryCompletion,
  recordCodexTrajectoryContext,
} from "./trajectory.js";
import { mirrorCodexAppServerTranscript } from "./transcript-mirror.js";
import { createCodexUserInputBridge } from "./user-input-bridge.js";
import { filterToolsForVisionInputs } from "./vision-tools.js";

const CODEX_DYNAMIC_TOOL_TIMEOUT_MS = 30_000;
const CODEX_DYNAMIC_TOOL_MAX_TIMEOUT_MS = 600_000;
const CODEX_DYNAMIC_IMAGE_TOOL_TIMEOUT_MS = 60_000;
const CODEX_APP_SERVER_STARTUP_CONNECTION_CLOSE_MAX_ATTEMPTS = 3;
const CODEX_APP_SERVER_STARTUP_TIMEOUT_FLOOR_MS = 100;
const CODEX_TURN_COMPLETION_IDLE_TIMEOUT_MS = 60_000;
const CODEX_TURN_TERMINAL_IDLE_TIMEOUT_MS = 30 * 60_000;
const CODEX_NATIVE_HOOK_RELAY_MIN_TTL_MS = 30 * 60_000;
const CODEX_NATIVE_HOOK_RELAY_TTL_GRACE_MS = 5 * 60_000;
const CODEX_STEER_ALL_DEBOUNCE_MS = 500;
const LOG_FIELD_MAX_LENGTH = 160;
const CODEX_NATIVE_PROJECT_DOC_BASENAMES = new Set(["agents.md"]);
const CODEX_NATIVE_HOOK_RELAY_EVENTS_WITH_APP_SERVER_APPROVALS =
  CODEX_NATIVE_HOOK_RELAY_EVENTS.filter((event) => event !== "permission_request");
const CODEX_BOOTSTRAP_CONTEXT_ORDER = new Map<string, number>([
  ["soul.md", 10],
  ["identity.md", 20],
  ["user.md", 30],
  ["tools.md", 40],
  ["bootstrap.md", 50],
  ["memory.md", 60],
  ["heartbeat.md", 70],
]);

type OpenClawCodingToolsOptions = NonNullable<
  Parameters<(typeof import("openclaw/plugin-sdk/agent-harness"))["createOpenClawCodingTools"]>[0]
>;
type OpenClawCodingToolsFactory =
  (typeof import("openclaw/plugin-sdk/agent-harness"))["createOpenClawCodingTools"];

const testClientFactoryStorage = new AsyncLocalStorage<CodexAppServerClientFactory | undefined>();
const clientFactory = defaultCodexAppServerClientFactory;
let openClawCodingToolsFactoryForTests: OpenClawCodingToolsFactory | undefined;

function resolveCodexAppServerClientFactory(): CodexAppServerClientFactory {
  return testClientFactoryStorage.getStore() ?? clientFactory;
}

function emitCodexAppServerEvent(
  params: EmbeddedRunAttemptParams,
  event: Parameters<NonNullable<EmbeddedRunAttemptParams["onAgentEvent"]>>[0],
): void {
  try {
    emitGlobalAgentEvent({
      runId: params.runId,
      stream: event.stream,
      data: event.data,
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    });
  } catch (error) {
    embeddedAgentLog.debug("codex app-server global agent event emit failed", { error });
  }
  try {
    const maybePromise = params.onAgentEvent?.(event);
    void Promise.resolve(maybePromise).catch((error: unknown) => {
      embeddedAgentLog.debug("codex app-server agent event handler rejected", { error });
    });
  } catch (error) {
    // Event consumers are observational; they must not abort or strand the
    // canonical app-server turn lifecycle.
    embeddedAgentLog.debug("codex app-server agent event handler threw", { error });
  }
}

function collectTerminalAssistantText(result: EmbeddedRunAttemptResult): string {
  return result.assistantTexts.join("\n\n").trim();
}

type CodexSteeringQueueOptions = {
  steeringMode?: "all" | "one-at-a-time";
  debounceMs?: number;
};

type DynamicToolTimeoutDetails = {
  responseMessage: string;
  consoleMessage: string;
  meta: Record<string, unknown>;
};

function normalizeLogField(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value
    .replaceAll(String.fromCharCode(27), " ")
    .replaceAll("\r", " ")
    .replaceAll("\n", " ")
    .replaceAll("\t", " ")
    .trim();
  if (!normalized) {
    return undefined;
  }
  return normalized.length > LOG_FIELD_MAX_LENGTH
    ? `${normalized.slice(0, LOG_FIELD_MAX_LENGTH - 3)}...`
    : normalized;
}

function readNumericTimeoutMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed)) {
      return Math.max(0, Math.floor(parsed));
    }
  }
  return undefined;
}

function formatDynamicToolTimeoutDetails(params: {
  call: CodexDynamicToolCallParams;
  timeoutMs: number;
}): DynamicToolTimeoutDetails {
  const tool = normalizeLogField(params.call.tool) ?? "unknown";
  const baseMeta: Record<string, unknown> = {
    tool: params.call.tool,
    toolCallId: params.call.callId,
    threadId: params.call.threadId,
    turnId: params.call.turnId,
    timeoutMs: params.timeoutMs,
    timeoutKind: "codex_dynamic_tool_rpc",
  };

  if (tool !== "process" || !isJsonObject(params.call.arguments)) {
    return {
      responseMessage: `OpenClaw dynamic tool call timed out after ${params.timeoutMs}ms while running tool ${tool}.`,
      consoleMessage: `codex dynamic tool timeout: tool=${tool} toolTimeoutMs=${params.timeoutMs}; per-tool-call watchdog, not session idle`,
      meta: baseMeta,
    };
  }

  const action = normalizeLogField(params.call.arguments.action);
  const sessionId = normalizeLogField(params.call.arguments.sessionId);
  const requestedTimeoutMs = readNumericTimeoutMs(params.call.arguments.timeout);
  const actionPart = action ? ` action=${action}` : "";
  const sessionPart = sessionId ? ` sessionId=${sessionId}` : "";
  const requestedPart =
    requestedTimeoutMs === undefined ? "" : ` requestedWaitMs=${requestedTimeoutMs}`;
  const retryHint =
    action === "poll"
      ? "; repeated lines usually mean process-poll retry churn, not model progress"
      : "";
  const responseTarget =
    action || sessionId
      ? ` while waiting for process${actionPart}${sessionPart}`
      : " while waiting for the process tool";

  return {
    responseMessage: `OpenClaw dynamic tool call timed out after ${params.timeoutMs}ms${responseTarget}. This is a tool RPC timeout, not a session idle timeout.`,
    consoleMessage: `codex process tool timeout:${actionPart}${sessionPart} toolTimeoutMs=${params.timeoutMs}${requestedPart}; per-tool-call watchdog, not session idle${retryHint}`,
    meta: {
      ...baseMeta,
      processAction: action,
      processSessionId: sessionId,
      processRequestedTimeoutMs: requestedTimeoutMs,
    },
  };
}

function createCodexSteeringQueue(params: {
  client: CodexAppServerClient;
  threadId: string;
  turnId: string;
  answerPendingUserInput: (text: string) => boolean;
  signal: AbortSignal;
}) {
  let batchedTexts: string[] = [];
  let batchTimer: NodeJS.Timeout | undefined;
  let sendChain: Promise<void> = Promise.resolve();

  const clearBatchTimer = () => {
    if (batchTimer) {
      clearTimeout(batchTimer);
      batchTimer = undefined;
    }
  };

  const sendTexts = async (texts: string[]) => {
    if (texts.length === 0 || params.signal.aborted) {
      return;
    }
    await params.client.request("turn/steer", {
      threadId: params.threadId,
      expectedTurnId: params.turnId,
      input: texts.map(toCodexTextInput),
    });
  };

  const enqueueSend = (texts: string[]) => {
    sendChain = sendChain
      .then(() => sendTexts(texts))
      .catch((error: unknown) => {
        embeddedAgentLog.debug("codex app-server queued steer failed", { error });
      });
    return sendChain;
  };

  const flushBatch = () => {
    clearBatchTimer();
    const texts = batchedTexts;
    batchedTexts = [];
    return enqueueSend(texts);
  };

  return {
    async queue(text: string, options?: CodexSteeringQueueOptions) {
      if (params.answerPendingUserInput(text)) {
        return;
      }
      if (options?.steeringMode === "one-at-a-time") {
        await flushBatch();
        await enqueueSend([text]);
        return;
      }
      batchedTexts.push(text);
      clearBatchTimer();
      const debounceMs = normalizeCodexSteerDebounceMs(options?.debounceMs);
      batchTimer = setTimeout(() => {
        batchTimer = undefined;
        void flushBatch();
      }, debounceMs);
    },
    async flushPending() {
      await flushBatch();
    },
    cancel() {
      clearBatchTimer();
      batchedTexts = [];
    },
  };
}

function normalizeCodexSteerDebounceMs(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : CODEX_STEER_ALL_DEBOUNCE_MS;
}

function toCodexTextInput(text: string): CodexUserInput {
  return { type: "text", text, text_elements: [] };
}

function resolveCodexPluginAppCacheEndpoint(appServer: CodexAppServerRuntimeOptions): string {
  return JSON.stringify({
    transport: appServer.start.transport,
    command: appServer.start.command,
    args: appServer.start.args,
    url: appServer.start.url ?? null,
    credentialFingerprint: fingerprintCodexPluginAppCacheCredentials(appServer.start),
  });
}

function fingerprintCodexPluginAppCacheCredentials(
  startOptions: CodexAppServerRuntimeOptions["start"],
): string | null {
  const authToken = startOptions.authToken ?? "";
  const headers = Object.entries(startOptions.headers)
    .map(([key, value]) => [key.toLowerCase(), value] as const)
    .toSorted(([left], [right]) => left.localeCompare(right));
  if (!authToken && headers.length === 0) {
    return null;
  }
  const hash = createHash("sha256");
  hash.update("openclaw:codex:plugin-app-cache-credentials:v1");
  hash.update("\0");
  hash.update(authToken);
  for (const [key, value] of headers) {
    hash.update("\0");
    hash.update(key);
    hash.update("\0");
    hash.update(value);
  }
  return `sha256:${hash.digest("hex")}`;
}

function resolveCodexPluginAppCacheCodexHome(
  appServer: CodexAppServerRuntimeOptions,
  agentDir: string,
): string | undefined {
  const configuredCodexHome = appServer.start.env?.CODEX_HOME?.trim();
  if (configuredCodexHome) {
    return configuredCodexHome;
  }
  return appServer.start.transport === "stdio" ? resolveCodexAppServerHomeDir(agentDir) : undefined;
}

export async function runCodexAppServerAttempt(
  params: EmbeddedRunAttemptParams,
  options: {
    pluginConfig?: unknown;
    startupTimeoutFloorMs?: number;
    nativeHookRelay?: {
      enabled?: boolean;
      events?: readonly NativeHookRelayEvent[];
      ttlMs?: number;
      gatewayTimeoutMs?: number;
      hookTimeoutSec?: number;
    };
    turnCompletionIdleTimeoutMs?: number;
    turnTerminalIdleTimeoutMs?: number;
  } = {},
): Promise<EmbeddedRunAttemptResult> {
  const attemptStartedAt = Date.now();
  const attemptClientFactory = resolveCodexAppServerClientFactory();
  const pluginConfig = readCodexPluginConfig(options.pluginConfig);
  const appServer = resolveCodexAppServerRuntimeOptions({ pluginConfig });
  let pluginAppServer: CodexAppServerRuntimeOptions = appServer;
  const nativeHookRelayEvents = resolveCodexNativeHookRelayEvents({
    configuredEvents: options.nativeHookRelay?.events,
    appServer,
  });
  const resolvedWorkspace = resolveUserPath(params.workspaceDir);
  await fs.mkdir(resolvedWorkspace, { recursive: true });
  const sandboxSessionKey =
    params.sandboxSessionKey?.trim() || params.sessionKey?.trim() || params.sessionId;
  const sandbox = await resolveSandboxContext({
    config: params.config,
    sessionKey: sandboxSessionKey,
    workspaceDir: resolvedWorkspace,
  });
  const effectiveWorkspace = sandbox?.enabled
    ? sandbox.workspaceAccess === "rw"
      ? resolvedWorkspace
      : sandbox.workspaceDir
    : resolvedWorkspace;
  await fs.mkdir(effectiveWorkspace, { recursive: true });

  const runAbortController = new AbortController();
  const abortFromUpstream = () => {
    runAbortController.abort(params.abortSignal?.reason ?? "upstream_abort");
  };
  if (params.abortSignal?.aborted) {
    abortFromUpstream();
  } else {
    params.abortSignal?.addEventListener("abort", abortFromUpstream, { once: true });
  }

  const { sessionAgentId } = resolveSessionAgentIds({
    sessionKey: params.sessionKey,
    config: params.config,
    agentId: params.agentId,
  });
  const agentDir = params.agentDir ?? resolveAgentDir(params.config ?? {}, sessionAgentId);
  const startupBinding = await readCodexAppServerBinding(params.sessionFile);
  const startupAuthProfileCandidate =
    params.runtimePlan?.auth.forwardedAuthProfileId ??
    params.authProfileId ??
    startupBinding?.authProfileId;
  const startupAuthProfileId = params.authProfileStore
    ? resolveCodexAppServerAuthProfileId({
        authProfileId: startupAuthProfileCandidate,
        store: params.authProfileStore,
        config: params.config,
      })
    : resolveCodexAppServerAuthProfileIdForAgent({
        authProfileId: startupAuthProfileCandidate,
        agentDir,
        config: params.config,
      });
  const runtimeParams = {
    ...params,
    sessionKey: sandboxSessionKey,
    ...(startupAuthProfileId ? { authProfileId: startupAuthProfileId } : {}),
  };
  const startupAuthAccountCacheKey = await resolveCodexAppServerAuthAccountCacheKey({
    authProfileId: startupAuthProfileId,
    authProfileStore: params.authProfileStore,
    agentDir,
    config: params.config,
  });
  const startupEnvApiKeyCacheKey = startupAuthProfileId
    ? undefined
    : resolveCodexAppServerEnvApiKeyCacheKey({
        startOptions: appServer.start,
      });
  const activeContextEngine = isActiveHarnessContextEngine(params.contextEngine)
    ? params.contextEngine
    : undefined;
  let yieldDetected = false;
  const tools = await buildDynamicTools({
    params,
    resolvedWorkspace,
    effectiveWorkspace,
    sandboxSessionKey,
    sandbox,
    runAbortController,
    sessionAgentId,
    pluginConfig,
    onYieldDetected: () => {
      yieldDetected = true;
    },
  });
  const toolBridge = createCodexDynamicToolBridge({
    tools,
    signal: runAbortController.signal,
    loading: pluginConfig.codexDynamicToolsLoading ?? "searchable",
    directToolNames: shouldForceMessageTool(params) ? ["message"] : [],
    hookContext: {
      agentId: sessionAgentId,
      config: params.config,
      sessionId: params.sessionId,
      sessionKey: sandboxSessionKey,
      runId: params.runId,
    },
  });
  const hadSessionFile = await pathExists(params.sessionFile);
  let historyMessages = (await readMirroredSessionHistoryMessages(params.sessionFile)) ?? [];
  const hookContext = {
    runId: params.runId,
    agentId: sessionAgentId,
    sessionKey: sandboxSessionKey,
    sessionId: params.sessionId,
    workspaceDir: params.workspaceDir,
    messageProvider: params.messageProvider ?? undefined,
    trigger: params.trigger,
    channelId: params.messageChannel ?? params.messageProvider ?? undefined,
  };
  if (activeContextEngine) {
    await bootstrapHarnessContextEngine({
      hadSessionFile,
      contextEngine: activeContextEngine,
      sessionId: params.sessionId,
      sessionKey: sandboxSessionKey,
      sessionFile: params.sessionFile,
      runtimeContext: buildHarnessContextEngineRuntimeContext({
        attempt: runtimeParams,
        workspaceDir: effectiveWorkspace,
        agentDir,
        tokenBudget: params.contextTokenBudget,
      }),
      runMaintenance: runHarnessContextEngineMaintenance,
      config: params.config,
      warn: (message) => embeddedAgentLog.warn(message),
    });
    historyMessages =
      (await readMirroredSessionHistoryMessages(params.sessionFile)) ?? historyMessages;
  }
  const baseDeveloperInstructions = buildDeveloperInstructions(params);
  // Build the workspace bootstrap block before finalizing developer
  // instructions so persona files (SOUL.md, IDENTITY.md, ...) reach Codex
  // through the explicit `developerInstructions` field.
  const workspaceBootstrapInstructions = await buildCodexWorkspaceBootstrapInstructions({
    params,
    resolvedWorkspace,
    effectiveWorkspace,
    sessionKey: sandboxSessionKey,
    sessionAgentId,
  });
  let promptText = params.prompt;
  let developerInstructions = joinPresentSections(
    baseDeveloperInstructions,
    workspaceBootstrapInstructions,
  );
  let prePromptMessageCount = historyMessages.length;
  if (activeContextEngine) {
    try {
      const assembled = await assembleHarnessContextEngine({
        contextEngine: activeContextEngine,
        sessionId: params.sessionId,
        sessionKey: sandboxSessionKey,
        messages: historyMessages,
        tokenBudget: params.contextTokenBudget,
        availableTools: new Set(toolBridge.specs.map((tool) => tool.name).filter(isNonEmptyString)),
        citationsMode: params.config?.memory?.citations,
        modelId: params.modelId,
        prompt: params.prompt,
      });
      if (!assembled) {
        throw new Error("context engine assemble returned no result");
      }
      const projection = projectContextEngineAssemblyForCodex({
        assembledMessages: assembled.messages,
        originalHistoryMessages: historyMessages,
        prompt: params.prompt,
        systemPromptAddition: assembled.systemPromptAddition,
      });
      promptText = projection.promptText;
      developerInstructions = joinPresentSections(
        baseDeveloperInstructions,
        workspaceBootstrapInstructions,
        projection.developerInstructionAddition,
      );
      prePromptMessageCount = projection.prePromptMessageCount;
    } catch (assembleErr) {
      embeddedAgentLog.warn("context engine assemble failed; using Codex baseline prompt", {
        error: formatErrorMessage(assembleErr),
      });
    }
  } else if (
    shouldProjectMirroredHistoryForCodexStart({
      startupBinding,
      dynamicToolsFingerprint: codexDynamicToolsFingerprint(toolBridge.specs),
      historyMessages,
    })
  ) {
    const projection = projectContextEngineAssemblyForCodex({
      assembledMessages: historyMessages,
      originalHistoryMessages: historyMessages,
      prompt: params.prompt,
    });
    promptText = projection.promptText;
    prePromptMessageCount = projection.prePromptMessageCount;
  }
  const promptBuild = await resolveAgentHarnessBeforePromptBuildResult({
    prompt: promptText,
    developerInstructions,
    messages: historyMessages,
    ctx: hookContext,
  });
  const trajectoryRecorder = createCodexTrajectoryRecorder({
    attempt: params,
    cwd: effectiveWorkspace,
    developerInstructions: promptBuild.developerInstructions,
    prompt: promptBuild.prompt,
    tools: toolBridge.specs,
  });
  let client: CodexAppServerClient;
  let thread: CodexAppServerThreadBinding;
  let trajectoryEndRecorded = false;
  let nativeHookRelay: NativeHookRelayRegistrationHandle | undefined;
  let startupClientForCleanup: CodexAppServerClient | undefined;
  const startupTimeoutMs = resolveCodexStartupTimeoutMs({
    timeoutMs: params.timeoutMs,
    timeoutFloorMs: options.startupTimeoutFloorMs,
  });
  try {
    emitCodexAppServerEvent(params, {
      stream: "codex_app_server.lifecycle",
      data: { phase: "startup" },
    });
    nativeHookRelay = createCodexNativeHookRelay({
      options: options.nativeHookRelay,
      events: nativeHookRelayEvents,
      agentId: sessionAgentId,
      sessionId: params.sessionId,
      sessionKey: sandboxSessionKey,
      config: params.config,
      runId: params.runId,
      attemptTimeoutMs: params.timeoutMs,
      startupTimeoutMs,
      turnStartTimeoutMs: params.timeoutMs,
      signal: runAbortController.signal,
    });
    const nativeHookRelayConfig = nativeHookRelay
      ? buildCodexNativeHookRelayConfig({
          relay: nativeHookRelay,
          events: nativeHookRelayEvents,
          hookTimeoutSec: options.nativeHookRelay?.hookTimeoutSec,
        })
      : options.nativeHookRelay?.enabled === false
        ? buildCodexNativeHookRelayDisabledConfig()
        : undefined;
    const threadConfig = nativeHookRelayConfig;
    const pluginThreadConfigEnabled = shouldBuildCodexPluginThreadConfig(pluginConfig);
    const pluginAppCacheKey = buildCodexAppInventoryCacheKey({
      codexHome: resolveCodexPluginAppCacheCodexHome(appServer, agentDir),
      endpoint: resolveCodexPluginAppCacheEndpoint(appServer),
      authProfileId: startupAuthProfileId,
      accountId: startupAuthAccountCacheKey,
      envApiKeyFingerprint: startupEnvApiKeyCacheKey,
    });
    const pluginThreadConfigInputFingerprint = pluginThreadConfigEnabled
      ? buildCodexPluginThreadConfigInputFingerprint({
          pluginConfig,
          appCacheKey: pluginAppCacheKey,
        })
      : undefined;
    const resolvedPluginPolicy = pluginThreadConfigEnabled
      ? resolveCodexPluginsPolicy(pluginConfig)
      : undefined;
    const enabledPluginConfigKeys = resolvedPluginPolicy
      ? resolvedPluginPolicy.pluginPolicies
          .filter((plugin) => plugin.enabled)
          .map((plugin) => plugin.configKey)
          .toSorted()
      : undefined;
    pluginAppServer =
      resolvedPluginPolicy?.enabled === true
        ? {
            ...appServer,
            approvalPolicy: withMcpElicitationsApprovalPolicy(appServer.approvalPolicy),
          }
        : appServer;
    ({ client, thread } = await withCodexStartupTimeout({
      timeoutMs: startupTimeoutMs,
      signal: runAbortController.signal,
      operation: async () => {
        let attemptedClient: CodexAppServerClient | undefined;
        const startupAttempt = async () => {
          const startupClient = await attemptClientFactory(
            appServer.start,
            startupAuthProfileId,
            agentDir,
            params.config,
          );
          attemptedClient = startupClient;
          startupClientForCleanup = startupClient;
          await ensureCodexComputerUse({
            client: startupClient,
            pluginConfig: options.pluginConfig,
            timeoutMs: appServer.requestTimeoutMs,
            signal: runAbortController.signal,
          });
          const startupThread = await startOrResumeThread({
            client: startupClient,
            params: runtimeParams,
            cwd: effectiveWorkspace,
            dynamicTools: toolBridge.specs,
            appServer: pluginAppServer,
            developerInstructions: promptBuild.developerInstructions,
            config: threadConfig,
            pluginThreadConfig: pluginThreadConfigEnabled
              ? {
                  enabled: true,
                  inputFingerprint: pluginThreadConfigInputFingerprint,
                  enabledPluginConfigKeys,
                  build: () =>
                    buildCodexPluginThreadConfig({
                      pluginConfig,
                      request: (method, requestParams) =>
                        startupClient.request(method, requestParams, {
                          timeoutMs: appServer.requestTimeoutMs,
                          signal: runAbortController.signal,
                        }),
                      appCache: defaultCodexAppInventoryCache,
                      appCacheKey: pluginAppCacheKey,
                    }),
                }
              : undefined,
          });
          return { client: startupClient, thread: startupThread };
        };
        for (
          let attempt = 1;
          attempt <= CODEX_APP_SERVER_STARTUP_CONNECTION_CLOSE_MAX_ATTEMPTS;
          attempt += 1
        ) {
          try {
            return await startupAttempt();
          } catch (error) {
            if (
              runAbortController.signal.aborted ||
              !isCodexAppServerConnectionClosedError(error)
            ) {
              throw error;
            }
            const failedClient = attemptedClient;
            const clearedSharedClient = clearSharedCodexAppServerClientIfCurrent(failedClient);
            if (startupClientForCleanup === failedClient) {
              startupClientForCleanup = undefined;
            }
            attemptedClient = undefined;
            if (attempt >= CODEX_APP_SERVER_STARTUP_CONNECTION_CLOSE_MAX_ATTEMPTS) {
              embeddedAgentLog.warn(
                "codex app-server connection closed during startup; retries exhausted",
                {
                  attempt,
                  maxAttempts: CODEX_APP_SERVER_STARTUP_CONNECTION_CLOSE_MAX_ATTEMPTS,
                  clearedSharedClient,
                  error: formatErrorMessage(error),
                },
              );
              throw error;
            }
            embeddedAgentLog.warn(
              "codex app-server connection closed during startup; restarting app-server and retrying",
              {
                attempt,
                nextAttempt: attempt + 1,
                maxAttempts: CODEX_APP_SERVER_STARTUP_CONNECTION_CLOSE_MAX_ATTEMPTS,
                clearedSharedClient,
                error: formatErrorMessage(error),
              },
            );
          }
        }
        throw new Error("codex app-server startup retry loop exited unexpectedly");
      },
    }));
    startupClientForCleanup = undefined;
    emitCodexAppServerEvent(params, {
      stream: "codex_app_server.lifecycle",
      data: { phase: "thread_ready", threadId: thread.threadId },
    });
  } catch (error) {
    nativeHookRelay?.unregister();
    clearSharedCodexAppServerClientIfCurrent(startupClientForCleanup);
    params.abortSignal?.removeEventListener("abort", abortFromUpstream);
    throw error;
  }
  trajectoryRecorder?.recordEvent("session.started", {
    sessionFile: params.sessionFile,
    threadId: thread.threadId,
    authProfileId: startupAuthProfileId,
    workspaceDir: effectiveWorkspace,
    toolCount: toolBridge.specs.length,
  });
  recordCodexTrajectoryContext(trajectoryRecorder, {
    attempt: params,
    cwd: effectiveWorkspace,
    developerInstructions: promptBuild.developerInstructions,
    prompt: promptBuild.prompt,
    tools: toolBridge.specs,
  });

  let projector: CodexAppServerEventProjector | undefined;
  let turnId: string | undefined;
  const pendingNotifications: CodexServerNotification[] = [];
  let userInputBridge: ReturnType<typeof createCodexUserInputBridge> | undefined;
  let steeringQueue: ReturnType<typeof createCodexSteeringQueue> | undefined;
  let completed = false;
  let timedOut = false;
  let turnCompletionIdleTimedOut = false;
  let turnCompletionIdleTimeoutMessage: string | undefined;
  let lifecycleStarted = false;
  let lifecycleTerminalEmitted = false;
  let resolveCompletion: (() => void) | undefined;
  const completion = new Promise<void>((resolve) => {
    resolveCompletion = resolve;
  });
  let notificationQueue: Promise<void> = Promise.resolve();
  const turnCompletionIdleTimeoutMs = resolveCodexTurnCompletionIdleTimeoutMs(
    options.turnCompletionIdleTimeoutMs ?? appServer.turnCompletionIdleTimeoutMs,
  );
  const turnTerminalIdleTimeoutMs = resolveCodexTurnTerminalIdleTimeoutMs(
    options.turnTerminalIdleTimeoutMs,
  );
  let turnCompletionIdleTimer: ReturnType<typeof setTimeout> | undefined;
  let turnCompletionIdleWatchArmed = false;
  let turnCompletionIdleWatchPinnedByTerminalError = false;
  let turnTerminalIdleTimer: ReturnType<typeof setTimeout> | undefined;
  let turnTerminalIdleWatchArmed = false;
  let turnCompletionLastActivityAt = Date.now();
  let turnCompletionLastActivityReason = "startup";
  let turnCompletionLastActivityDetails: Record<string, unknown> | undefined;
  let activeAppServerTurnRequests = 0;

  const clearTurnCompletionIdleTimer = () => {
    if (turnCompletionIdleTimer) {
      clearTimeout(turnCompletionIdleTimer);
      turnCompletionIdleTimer = undefined;
    }
  };

  const clearTurnTerminalIdleTimer = () => {
    if (turnTerminalIdleTimer) {
      clearTimeout(turnTerminalIdleTimer);
      turnTerminalIdleTimer = undefined;
    }
  };

  const fireTurnCompletionIdleTimeout = () => {
    if (
      completed ||
      runAbortController.signal.aborted ||
      !turnCompletionIdleWatchArmed ||
      activeAppServerTurnRequests > 0
    ) {
      return;
    }
    const idleMs = Math.max(0, Date.now() - turnCompletionLastActivityAt);
    if (idleMs < turnCompletionIdleTimeoutMs) {
      scheduleTurnCompletionIdleWatch();
      return;
    }
    timedOut = true;
    turnCompletionIdleTimedOut = true;
    turnCompletionIdleTimeoutMessage =
      "codex app-server turn idle timed out waiting for turn/completed";
    projector?.markTimedOut();
    trajectoryRecorder?.recordEvent("turn.completion_idle_timeout", {
      threadId: thread.threadId,
      turnId,
      idleMs,
      timeoutMs: turnCompletionIdleTimeoutMs,
      lastActivityReason: turnCompletionLastActivityReason,
      ...turnCompletionLastActivityDetails,
    });
    embeddedAgentLog.warn("codex app-server turn idle timed out waiting for completion", {
      threadId: thread.threadId,
      turnId,
      idleMs,
      timeoutMs: turnCompletionIdleTimeoutMs,
      lastActivityReason: turnCompletionLastActivityReason,
      ...turnCompletionLastActivityDetails,
    });
    runAbortController.abort("turn_completion_idle_timeout");
  };

  const fireTurnTerminalIdleTimeout = () => {
    if (
      completed ||
      runAbortController.signal.aborted ||
      !turnTerminalIdleWatchArmed ||
      activeAppServerTurnRequests > 0
    ) {
      return;
    }
    const idleMs = Math.max(0, Date.now() - turnCompletionLastActivityAt);
    if (idleMs < turnTerminalIdleTimeoutMs) {
      scheduleTurnTerminalIdleWatch();
      return;
    }
    timedOut = true;
    turnCompletionIdleTimedOut = true;
    turnCompletionIdleTimeoutMessage =
      "codex app-server turn idle timed out waiting for turn/completed";
    projector?.markTimedOut();
    trajectoryRecorder?.recordEvent("turn.terminal_idle_timeout", {
      threadId: thread.threadId,
      turnId,
      idleMs,
      timeoutMs: turnTerminalIdleTimeoutMs,
      lastActivityReason: turnCompletionLastActivityReason,
      ...turnCompletionLastActivityDetails,
    });
    embeddedAgentLog.warn("codex app-server turn idle timed out waiting for terminal event", {
      threadId: thread.threadId,
      turnId,
      idleMs,
      timeoutMs: turnTerminalIdleTimeoutMs,
      lastActivityReason: turnCompletionLastActivityReason,
      ...turnCompletionLastActivityDetails,
    });
    runAbortController.abort("turn_terminal_idle_timeout");
  };

  function scheduleTurnCompletionIdleWatch() {
    clearTurnCompletionIdleTimer();
    if (
      completed ||
      runAbortController.signal.aborted ||
      !turnCompletionIdleWatchArmed ||
      activeAppServerTurnRequests > 0
    ) {
      return;
    }
    const elapsedMs = Math.max(0, Date.now() - turnCompletionLastActivityAt);
    const delayMs = Math.max(1, turnCompletionIdleTimeoutMs - elapsedMs);
    turnCompletionIdleTimer = setTimeout(fireTurnCompletionIdleTimeout, delayMs);
    turnCompletionIdleTimer.unref?.();
  }

  function scheduleTurnTerminalIdleWatch() {
    clearTurnTerminalIdleTimer();
    if (
      completed ||
      runAbortController.signal.aborted ||
      !turnTerminalIdleWatchArmed ||
      activeAppServerTurnRequests > 0
    ) {
      return;
    }
    const elapsedMs = Math.max(0, Date.now() - turnCompletionLastActivityAt);
    const delayMs = Math.max(1, turnTerminalIdleTimeoutMs - elapsedMs);
    turnTerminalIdleTimer = setTimeout(fireTurnTerminalIdleTimeout, delayMs);
    turnTerminalIdleTimer.unref?.();
  }

  const touchTurnCompletionActivity = (
    reason: string,
    options?: { arm?: boolean; details?: Record<string, unknown> },
  ) => {
    turnCompletionLastActivityAt = Date.now();
    turnCompletionLastActivityReason = reason;
    turnCompletionLastActivityDetails = options?.details;
    emitTrustedDiagnosticEvent({
      type: "run.progress",
      runId: params.runId,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      reason: `codex_app_server:${reason}`,
    });
    if (options?.arm) {
      turnCompletionIdleWatchArmed = true;
      turnCompletionIdleWatchPinnedByTerminalError = false;
    }
    scheduleTurnCompletionIdleWatch();
    scheduleTurnTerminalIdleWatch();
  };

  const disarmTurnCompletionIdleWatch = () => {
    turnCompletionIdleWatchArmed = false;
    turnCompletionIdleWatchPinnedByTerminalError = false;
    clearTurnCompletionIdleTimer();
  };

  const armTurnCompletionIdleWatch = (options?: { pinnedByTerminalError?: boolean }) => {
    turnCompletionIdleWatchArmed = true;
    turnCompletionIdleWatchPinnedByTerminalError = options?.pinnedByTerminalError === true;
    scheduleTurnCompletionIdleWatch();
  };

  const emitLifecycleStart = () => {
    emitCodexAppServerEvent(params, {
      stream: "lifecycle",
      data: { phase: "start", startedAt: attemptStartedAt },
    });
    lifecycleStarted = true;
  };

  const emitLifecycleTerminal = (data: Record<string, unknown> & { phase: "end" | "error" }) => {
    if (!lifecycleStarted || lifecycleTerminalEmitted) {
      return;
    }
    emitCodexAppServerEvent(params, {
      stream: "lifecycle",
      data: {
        startedAt: attemptStartedAt,
        endedAt: Date.now(),
        ...data,
      },
    });
    lifecycleTerminalEmitted = true;
  };

  const handleNotification = async (notification: CodexServerNotification) => {
    userInputBridge?.handleNotification(notification);
    if (!projector || !turnId) {
      pendingNotifications.push(notification);
      return;
    }
    const isCurrentTurnNotification = isTurnNotification(
      notification.params,
      thread.threadId,
      turnId,
    );
    if (isCurrentTurnNotification) {
      touchTurnCompletionActivity(`notification:${notification.method}`, {
        details: describeNotificationActivity(notification),
      });
    }
    if (isCurrentTurnNotification && notification.method === "error") {
      if (isRetryableErrorNotification(notification.params)) {
        disarmTurnCompletionIdleWatch();
      } else {
        armTurnCompletionIdleWatch({ pinnedByTerminalError: true });
      }
    } else if (
      turnCompletionIdleWatchArmed &&
      !turnCompletionIdleWatchPinnedByTerminalError &&
      notification.method !== "turn/completed" &&
      isCurrentTurnNotification
    ) {
      // The short completion-idle watchdog only guards the blind gap after
      // OpenClaw hands a turn-scoped request result back to Codex. Once Codex
      // sends another current-turn notification, the app-server is alive again;
      // the longer terminal watchdog remains the stuck-turn backstop.
      disarmTurnCompletionIdleWatch();
    }
    // Determine terminal-turn status before invoking the projector so a throw
    // inside projector.handleNotification still releases the session lane.
    // See openclaw/openclaw#67996.
    const isTurnCompletion = notification.method === "turn/completed" && isCurrentTurnNotification;
    try {
      await projector.handleNotification(notification);
    } catch (error) {
      embeddedAgentLog.debug("codex app-server projector notification threw", {
        method: notification.method,
        error,
      });
    } finally {
      if (isTurnCompletion) {
        if (!timedOut && !runAbortController.signal.aborted) {
          await steeringQueue?.flushPending();
        }
        completed = true;
        clearTurnCompletionIdleTimer();
        clearTurnTerminalIdleTimer();
        resolveCompletion?.();
      }
    }
  };
  const enqueueNotification = (notification: CodexServerNotification): Promise<void> => {
    notificationQueue = notificationQueue.then(
      () => handleNotification(notification),
      () => handleNotification(notification),
    );
    return notificationQueue;
  };

  const notificationCleanup = client.addNotificationHandler(enqueueNotification);
  const requestCleanup = client.addRequestHandler(async (request) => {
    activeAppServerTurnRequests += 1;
    clearTurnCompletionIdleTimer();
    touchTurnCompletionActivity(`request:${request.method}`);
    let armCompletionWatchOnResponse = false;
    try {
      if (request.method === "account/chatgptAuthTokens/refresh") {
        return refreshCodexAppServerAuthTokens({
          agentDir,
          authProfileId: startupAuthProfileId,
          config: params.config,
        });
      }
      if (!turnId) {
        return undefined;
      }
      if (request.method === "mcpServer/elicitation/request") {
        armCompletionWatchOnResponse = true;
        return handleCodexAppServerElicitationRequest({
          requestParams: request.params,
          paramsForRun: params,
          threadId: thread.threadId,
          turnId,
          pluginAppPolicyContext: thread.pluginAppPolicyContext,
          signal: runAbortController.signal,
        });
      }
      if (request.method === "item/tool/requestUserInput") {
        armCompletionWatchOnResponse = true;
        return userInputBridge?.handleRequest({
          id: request.id,
          params: request.params,
        });
      }
      if (request.method !== "item/tool/call") {
        if (isCodexAppServerApprovalRequest(request.method)) {
          armCompletionWatchOnResponse = true;
          return handleApprovalRequest({
            method: request.method,
            params: request.params,
            paramsForRun: params,
            threadId: thread.threadId,
            turnId,
            signal: runAbortController.signal,
          });
        }
        return undefined;
      }
      const call = readDynamicToolCallParams(request.params);
      if (!call || call.threadId !== thread.threadId || call.turnId !== turnId) {
        return undefined;
      }
      armCompletionWatchOnResponse = true;
      trajectoryRecorder?.recordEvent("tool.call", {
        threadId: call.threadId,
        turnId: call.turnId,
        toolCallId: call.callId,
        name: call.tool,
        arguments: call.arguments,
      });
      projector?.recordDynamicToolCall({
        callId: call.callId,
        tool: call.tool,
        arguments: call.arguments,
      });
      const toolProgressDetailMode = resolveCodexToolProgressDetailMode(params.toolProgressDetail);
      const toolMeta = inferCodexDynamicToolMeta(call, toolProgressDetailMode);
      const toolArgs = sanitizeCodexToolArguments(call.arguments);
      emitCodexAppServerEvent(params, {
        stream: "tool",
        data: {
          phase: "start",
          name: call.tool,
          toolCallId: call.callId,
          ...(toolMeta ? { meta: toolMeta } : {}),
          ...(toolArgs ? { args: toolArgs } : {}),
        },
      });
      const dynamicToolTimeoutMs = resolveDynamicToolCallTimeoutMs({
        call,
        config: params.config,
      });
      const response = await handleDynamicToolCallWithTimeout({
        call,
        toolBridge,
        signal: runAbortController.signal,
        timeoutMs: dynamicToolTimeoutMs,
        onTimeout: () => {
          trajectoryRecorder?.recordEvent("tool.timeout", {
            threadId: call.threadId,
            turnId: call.turnId,
            toolCallId: call.callId,
            name: call.tool,
            timeoutMs: dynamicToolTimeoutMs,
          });
        },
      });
      trajectoryRecorder?.recordEvent("tool.result", {
        threadId: call.threadId,
        turnId: call.turnId,
        toolCallId: call.callId,
        name: call.tool,
        success: response.success,
        contentItems: response.contentItems,
      });
      projector?.recordDynamicToolResult({
        callId: call.callId,
        tool: call.tool,
        success: response.success,
        contentItems: response.contentItems,
      });
      emitCodexAppServerEvent(params, {
        stream: "tool",
        data: {
          phase: "result",
          name: call.tool,
          toolCallId: call.callId,
          ...(toolMeta ? { meta: toolMeta } : {}),
          isError: !response.success,
          result: sanitizeCodexToolResponse(response),
        },
      });
      return response as JsonValue;
    } finally {
      activeAppServerTurnRequests = Math.max(0, activeAppServerTurnRequests - 1);
      touchTurnCompletionActivity(`request:${request.method}:response`, {
        arm: armCompletionWatchOnResponse,
      });
    }
  });

  const llmInputEvent = {
    runId: params.runId,
    sessionId: params.sessionId,
    provider: params.provider,
    model: params.modelId,
    systemPrompt: promptBuild.developerInstructions,
    prompt: promptBuild.prompt,
    historyMessages,
    imagesCount: params.images?.length ?? 0,
  };
  const turnStartFailureMessages = [
    ...historyMessages,
    {
      role: "user",
      content: [{ type: "text", text: promptBuild.prompt }],
    },
  ];

  let turn: CodexTurnStartResponse;
  try {
    runAgentHarnessLlmInputHook({
      event: llmInputEvent,
      ctx: hookContext,
    });
    emitCodexAppServerEvent(params, {
      stream: "codex_app_server.lifecycle",
      data: { phase: "turn_starting", threadId: thread.threadId },
    });
    turn = assertCodexTurnStartResponse(
      await client.request(
        "turn/start",
        buildTurnStartParams(params, {
          threadId: thread.threadId,
          cwd: effectiveWorkspace,
          appServer: pluginAppServer,
          promptText: promptBuild.prompt,
        }),
        { timeoutMs: params.timeoutMs, signal: runAbortController.signal },
      ),
    );
  } catch (error) {
    const usageLimitError = formatCodexTurnStartUsageLimitError(error, pendingNotifications);
    const turnStartErrorMessage = usageLimitError ?? formatErrorMessage(error);
    emitCodexAppServerEvent(params, {
      stream: "codex_app_server.lifecycle",
      data: { phase: "turn_start_failed", error: turnStartErrorMessage },
    });
    trajectoryRecorder?.recordEvent("session.ended", {
      status: "error",
      threadId: thread.threadId,
      timedOut,
      aborted: runAbortController.signal.aborted,
      promptError: turnStartErrorMessage,
    });
    trajectoryEndRecorded = true;
    runAgentHarnessLlmOutputHook({
      event: {
        runId: params.runId,
        sessionId: params.sessionId,
        provider: params.provider,
        model: params.modelId,
        resolvedRef:
          params.runtimePlan?.observability.resolvedRef ?? `${params.provider}/${params.modelId}`,
        ...(params.runtimePlan?.observability.harnessId
          ? { harnessId: params.runtimePlan.observability.harnessId }
          : {}),
        assistantTexts: [],
      },
      ctx: hookContext,
    });
    runAgentHarnessAgentEndHook({
      event: {
        messages: turnStartFailureMessages,
        success: false,
        error: turnStartErrorMessage,
        durationMs: Date.now() - attemptStartedAt,
      },
      ctx: hookContext,
    });
    notificationCleanup();
    requestCleanup();
    nativeHookRelay?.unregister();
    await runAgentCleanupStep({
      runId: params.runId,
      sessionId: params.sessionId,
      step: "codex-trajectory-flush-startup-failure",
      log: embeddedAgentLog,
      cleanup: async () => {
        await trajectoryRecorder?.flush();
      },
    });
    params.abortSignal?.removeEventListener("abort", abortFromUpstream);
    if (usageLimitError) {
      throw new Error(usageLimitError, {
        cause: error,
      });
    }
    throw error;
  }
  turnId = turn.turn.id;
  const activeTurnId = turn.turn.id;
  userInputBridge = createCodexUserInputBridge({
    paramsForRun: params,
    threadId: thread.threadId,
    turnId: activeTurnId,
    signal: runAbortController.signal,
  });
  trajectoryRecorder?.recordEvent("prompt.submitted", {
    threadId: thread.threadId,
    turnId: activeTurnId,
    prompt: promptBuild.prompt,
    imagesCount: params.images?.length ?? 0,
  });
  projector = new CodexAppServerEventProjector(params, thread.threadId, activeTurnId);
  emitLifecycleStart();
  const activeProjector = projector;
  for (const notification of pendingNotifications.splice(0)) {
    await enqueueNotification(notification);
  }
  if (!completed && isTerminalTurnStatus(turn.turn.status)) {
    await enqueueNotification({
      method: "turn/completed",
      params: {
        threadId: thread.threadId,
        turnId: activeTurnId,
        turn: turn.turn as unknown as JsonObject,
      },
    });
  }

  const activeSteeringQueue = createCodexSteeringQueue({
    client,
    threadId: thread.threadId,
    turnId: activeTurnId,
    answerPendingUserInput: (text) => userInputBridge?.handleQueuedMessage(text) ?? false,
    signal: runAbortController.signal,
  });
  steeringQueue = activeSteeringQueue;
  const handle = {
    kind: "embedded" as const,
    queueMessage: async (text: string, options?: CodexSteeringQueueOptions) =>
      activeSteeringQueue.queue(text, options),
    isStreaming: () => !completed,
    isCompacting: () => projector?.isCompacting() ?? false,
    cancel: () => runAbortController.abort("cancelled"),
    abort: () => runAbortController.abort("aborted"),
  };
  setActiveEmbeddedRun(params.sessionId, handle, params.sessionKey);
  turnTerminalIdleWatchArmed = true;
  touchTurnCompletionActivity("turn:start");

  const timeout = setTimeout(
    () => {
      timedOut = true;
      projector?.markTimedOut();
      runAbortController.abort("timeout");
    },
    Math.max(100, params.timeoutMs),
  );

  const abortListener = () => {
    interruptCodexTurnBestEffort(client, {
      threadId: thread.threadId,
      turnId: activeTurnId,
    });
    resolveCompletion?.();
  };
  runAbortController.signal.addEventListener("abort", abortListener, { once: true });
  if (runAbortController.signal.aborted) {
    abortListener();
  }

  try {
    await completion;
    const result = activeProjector.buildResult(toolBridge.telemetry, { yieldDetected });
    const finalAborted = result.aborted || runAbortController.signal.aborted;
    const finalPromptError = turnCompletionIdleTimedOut
      ? turnCompletionIdleTimeoutMessage
      : timedOut
        ? "codex app-server attempt timed out"
        : result.promptError;
    const finalPromptErrorSource = timedOut ? "prompt" : result.promptErrorSource;
    recordCodexTrajectoryCompletion(trajectoryRecorder, {
      attempt: params,
      result,
      threadId: thread.threadId,
      turnId: activeTurnId,
      timedOut,
      yieldDetected,
    });
    trajectoryRecorder?.recordEvent("session.ended", {
      status: finalPromptError ? "error" : finalAborted || timedOut ? "interrupted" : "success",
      threadId: thread.threadId,
      turnId: activeTurnId,
      timedOut,
      yieldDetected,
      promptError: normalizeCodexTrajectoryError(finalPromptError),
    });
    trajectoryEndRecorded = true;
    await mirrorTranscriptBestEffort({
      params,
      agentId: sessionAgentId,
      result,
      sessionKey: sandboxSessionKey,
      threadId: thread.threadId,
      turnId: activeTurnId,
    });
    const terminalAssistantText = collectTerminalAssistantText(result);
    if (terminalAssistantText && !finalAborted && !finalPromptError) {
      emitCodexAppServerEvent(params, {
        stream: "assistant",
        data: { text: terminalAssistantText },
      });
    }
    if (finalPromptError) {
      emitLifecycleTerminal({
        phase: "error",
        error: formatErrorMessage(finalPromptError),
      });
    } else {
      emitLifecycleTerminal({
        phase: "end",
        ...(finalAborted ? { aborted: true } : {}),
      });
    }
    if (activeContextEngine) {
      const finalMessages =
        (await readMirroredSessionHistoryMessages(params.sessionFile)) ??
        historyMessages.concat(result.messagesSnapshot);
      await finalizeHarnessContextEngineTurn({
        contextEngine: activeContextEngine,
        promptError: Boolean(finalPromptError),
        aborted: finalAborted,
        yieldAborted: Boolean(result.yieldDetected),
        sessionIdUsed: params.sessionId,
        sessionKey: sandboxSessionKey,
        sessionFile: params.sessionFile,
        messagesSnapshot: finalMessages,
        prePromptMessageCount,
        tokenBudget: params.contextTokenBudget,
        runtimeContext: buildHarnessContextEngineRuntimeContextFromUsage({
          attempt: runtimeParams,
          workspaceDir: effectiveWorkspace,
          agentDir,
          tokenBudget: params.contextTokenBudget,
          lastCallUsage: result.attemptUsage,
          promptCache: result.promptCache,
        }),
        runMaintenance: runHarnessContextEngineMaintenance,
        config: params.config,
        warn: (message) => embeddedAgentLog.warn(message),
      });
    }
    runAgentHarnessLlmOutputHook({
      event: {
        runId: params.runId,
        sessionId: params.sessionId,
        provider: params.provider,
        model: params.modelId,
        resolvedRef:
          params.runtimePlan?.observability.resolvedRef ?? `${params.provider}/${params.modelId}`,
        ...(params.runtimePlan?.observability.harnessId
          ? { harnessId: params.runtimePlan.observability.harnessId }
          : {}),
        assistantTexts: result.assistantTexts,
        ...(result.lastAssistant ? { lastAssistant: result.lastAssistant } : {}),
        ...(result.attemptUsage ? { usage: result.attemptUsage } : {}),
      },
      ctx: hookContext,
    });
    runAgentHarnessAgentEndHook({
      event: {
        messages: result.messagesSnapshot,
        success: !finalAborted && !finalPromptError,
        ...(finalPromptError ? { error: formatErrorMessage(finalPromptError) } : {}),
        durationMs: Date.now() - attemptStartedAt,
      },
      ctx: hookContext,
    });
    return {
      ...result,
      timedOut,
      aborted: finalAborted,
      promptError: finalPromptError,
      promptErrorSource: finalPromptErrorSource,
    };
  } finally {
    emitLifecycleTerminal({
      phase: "error",
      error: "codex app-server run completed without lifecycle terminal event",
    });
    if (trajectoryRecorder && !trajectoryEndRecorded) {
      trajectoryRecorder.recordEvent("session.ended", {
        status: timedOut || runAbortController.signal.aborted ? "interrupted" : "cleanup",
        threadId: thread.threadId,
        turnId: activeTurnId,
        timedOut,
        aborted: runAbortController.signal.aborted,
      });
    }
    await runAgentCleanupStep({
      runId: params.runId,
      sessionId: params.sessionId,
      step: "codex-trajectory-flush",
      log: embeddedAgentLog,
      cleanup: async () => {
        await trajectoryRecorder?.flush();
      },
    });
    if (!timedOut && !runAbortController.signal.aborted) {
      await steeringQueue?.flushPending();
    }
    userInputBridge?.cancelPending();
    clearTimeout(timeout);
    clearTurnCompletionIdleTimer();
    clearTurnTerminalIdleTimer();
    notificationCleanup();
    requestCleanup();
    nativeHookRelay?.unregister();
    runAbortController.signal.removeEventListener("abort", abortListener);
    params.abortSignal?.removeEventListener("abort", abortFromUpstream);
    steeringQueue?.cancel();
    clearActiveEmbeddedRun(params.sessionId, handle, params.sessionKey);
  }
}

async function handleDynamicToolCallWithTimeout(params: {
  call: CodexDynamicToolCallParams;
  toolBridge: Pick<CodexDynamicToolBridge, "handleToolCall">;
  signal: AbortSignal;
  timeoutMs: number;
  onTimeout?: () => void;
}): Promise<CodexDynamicToolCallResponse> {
  if (params.signal.aborted) {
    return failedDynamicToolResponse("OpenClaw dynamic tool call aborted before execution.");
  }

  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let resolveAbort: ((response: CodexDynamicToolCallResponse) => void) | undefined;
  const abortFromRun = () => {
    const message = "OpenClaw dynamic tool call aborted.";
    controller.abort(params.signal.reason ?? new Error(message));
    resolveAbort?.(failedDynamicToolResponse(message));
  };
  const abortPromise = new Promise<CodexDynamicToolCallResponse>((resolve) => {
    resolveAbort = resolve;
  });
  const timeoutPromise = new Promise<CodexDynamicToolCallResponse>((resolve) => {
    const timeoutMs = clampDynamicToolTimeoutMs(params.timeoutMs);
    timeout = setTimeout(() => {
      timedOut = true;
      const timeoutDetails = formatDynamicToolTimeoutDetails({ call: params.call, timeoutMs });
      controller.abort(new Error(timeoutDetails.responseMessage));
      params.onTimeout?.();
      embeddedAgentLog.warn("codex dynamic tool call timed out", {
        ...timeoutDetails.meta,
        consoleMessage: timeoutDetails.consoleMessage,
      });
      resolve(failedDynamicToolResponse(timeoutDetails.responseMessage));
    }, timeoutMs);
    timeout.unref?.();
  });

  try {
    params.signal.addEventListener("abort", abortFromRun, { once: true });
    if (params.signal.aborted) {
      abortFromRun();
    }
    return await Promise.race([
      params.toolBridge.handleToolCall(params.call, { signal: controller.signal }),
      abortPromise,
      timeoutPromise,
    ]);
  } catch (error) {
    return failedDynamicToolResponse(error instanceof Error ? error.message : String(error));
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    params.signal.removeEventListener("abort", abortFromRun);
    resolveAbort = undefined;
    if (!timedOut && !controller.signal.aborted) {
      controller.abort(new Error("OpenClaw dynamic tool call finished."));
    }
  }
}

function failedDynamicToolResponse(message: string): CodexDynamicToolCallResponse {
  return {
    success: false,
    contentItems: [{ type: "inputText", text: message }],
  };
}

function resolveDynamicToolCallTimeoutMs(params: {
  call: CodexDynamicToolCallParams;
  config: EmbeddedRunAttemptParams["config"];
}): number {
  return clampDynamicToolTimeoutMs(
    readDynamicToolCallTimeoutMs(params.call.arguments) ??
      readConfiguredDynamicToolTimeoutMs(params.call.tool, params.config) ??
      CODEX_DYNAMIC_TOOL_TIMEOUT_MS,
  );
}

function readDynamicToolCallTimeoutMs(value: JsonValue | undefined): number | undefined {
  if (!isJsonObject(value)) {
    return undefined;
  }
  return readPositiveFiniteTimeoutMs(value.timeoutMs);
}

function readConfiguredDynamicToolTimeoutMs(
  toolName: string,
  config: EmbeddedRunAttemptParams["config"],
): number | undefined {
  if (toolName === "image_generate") {
    const imageGenerationModel = config?.agents?.defaults?.imageGenerationModel;
    if (!imageGenerationModel || typeof imageGenerationModel !== "object") {
      return undefined;
    }
    return readPositiveFiniteTimeoutMs(imageGenerationModel.timeoutMs);
  }

  if (toolName === "image") {
    return (
      readTimeoutSecondsAsMs(config?.tools?.media?.image?.timeoutSeconds) ??
      CODEX_DYNAMIC_IMAGE_TOOL_TIMEOUT_MS
    );
  }

  return undefined;
}

function readTimeoutSecondsAsMs(value: unknown): number | undefined {
  const seconds = readPositiveFiniteTimeoutMs(value);
  return seconds === undefined ? undefined : seconds * 1000;
}

function readPositiveFiniteTimeoutMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function clampDynamicToolTimeoutMs(timeoutMs: number): number {
  return Math.max(1, Math.min(CODEX_DYNAMIC_TOOL_MAX_TIMEOUT_MS, Math.floor(timeoutMs)));
}

function createCodexNativeHookRelay(params: {
  options:
    | {
        enabled?: boolean;
        ttlMs?: number;
        gatewayTimeoutMs?: number;
      }
    | undefined;
  events: readonly NativeHookRelayEvent[];
  agentId: string | undefined;
  sessionId: string;
  sessionKey: string | undefined;
  config: EmbeddedRunAttemptParams["config"];
  runId: string;
  attemptTimeoutMs: number;
  startupTimeoutMs: number;
  turnStartTimeoutMs: number;
  signal: AbortSignal;
}): NativeHookRelayRegistrationHandle | undefined {
  if (params.options?.enabled === false) {
    return undefined;
  }
  return registerNativeHookRelay({
    provider: "codex",
    relayId: buildCodexNativeHookRelayId({
      agentId: params.agentId,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
    }),
    ...(params.agentId ? { agentId: params.agentId } : {}),
    sessionId: params.sessionId,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    ...(params.config ? { config: params.config } : {}),
    runId: params.runId,
    allowedEvents: params.events,
    ttlMs: resolveCodexNativeHookRelayTtlMs({
      explicitTtlMs: params.options?.ttlMs,
      attemptTimeoutMs: params.attemptTimeoutMs,
      startupTimeoutMs: params.startupTimeoutMs,
      turnStartTimeoutMs: params.turnStartTimeoutMs,
    }),
    signal: params.signal,
    command: {
      timeoutMs: params.options?.gatewayTimeoutMs,
    },
  });
}

function resolveCodexNativeHookRelayEvents(params: {
  configuredEvents?: readonly NativeHookRelayEvent[];
  appServer: Pick<CodexAppServerRuntimeOptions, "approvalPolicy">;
}): readonly NativeHookRelayEvent[] {
  if (params.configuredEvents?.length) {
    return params.configuredEvents;
  }
  // Codex emits PermissionRequest before the app-server approval reviewer has
  // resolved the command. In native approval modes, let Codex's app-server
  // approval bridge own the real escalation instead of surfacing a stale
  // pre-guardian OpenClaw plugin approval prompt.
  return params.appServer.approvalPolicy === "never"
    ? CODEX_NATIVE_HOOK_RELAY_EVENTS
    : CODEX_NATIVE_HOOK_RELAY_EVENTS_WITH_APP_SERVER_APPROVALS;
}

function resolveCodexNativeHookRelayTtlMs(params: {
  explicitTtlMs: number | undefined;
  attemptTimeoutMs: number;
  startupTimeoutMs: number;
  turnStartTimeoutMs: number;
}): number {
  if (params.explicitTtlMs !== undefined) {
    return params.explicitTtlMs;
  }
  const relayBudgetMs =
    params.attemptTimeoutMs +
    params.startupTimeoutMs +
    params.turnStartTimeoutMs +
    CODEX_NATIVE_HOOK_RELAY_TTL_GRACE_MS;
  return Math.max(CODEX_NATIVE_HOOK_RELAY_MIN_TTL_MS, Math.floor(relayBudgetMs));
}

function buildCodexNativeHookRelayId(params: {
  agentId: string | undefined;
  sessionId: string;
  sessionKey: string | undefined;
}): string {
  const hash = createHash("sha256");
  hash.update("openclaw:codex:native-hook-relay:v1");
  hash.update("\0");
  hash.update(params.agentId?.trim() || "");
  hash.update("\0");
  hash.update(params.sessionKey?.trim() || params.sessionId);
  return `codex-${hash.digest("hex").slice(0, 40)}`;
}

function interruptCodexTurnBestEffort(
  client: CodexAppServerClient,
  params: {
    threadId: string;
    turnId: string;
  },
): void {
  void Promise.resolve()
    .then(() => client.request("turn/interrupt", params))
    .catch((error: unknown) => {
      embeddedAgentLog.debug("codex app-server turn interrupt failed during abort", { error });
    });
}

type DynamicToolBuildParams = {
  params: EmbeddedRunAttemptParams;
  resolvedWorkspace: string;
  effectiveWorkspace: string;
  sandboxSessionKey: string;
  sandbox: Awaited<ReturnType<typeof resolveSandboxContext>>;
  runAbortController: AbortController;
  sessionAgentId: string;
  pluginConfig: CodexPluginConfig;
  onYieldDetected: () => void;
};

function resolveOpenClawCodingToolsSessionKeys(
  params: EmbeddedRunAttemptParams,
  sandboxSessionKey: string,
): Pick<OpenClawCodingToolsOptions, "sessionKey" | "runSessionKey"> {
  return {
    sessionKey: sandboxSessionKey,
    runSessionKey:
      params.sessionKey && params.sessionKey !== sandboxSessionKey ? params.sessionKey : undefined,
  };
}

async function buildDynamicTools(input: DynamicToolBuildParams) {
  const { params } = input;
  if (params.disableTools || !supportsModelTools(params.model)) {
    return [];
  }
  const modelHasVision = params.model.input?.includes("image") ?? false;
  const agentDir = params.agentDir ?? resolveAgentDir(params.config ?? {}, input.sessionAgentId);
  const createOpenClawCodingTools =
    openClawCodingToolsFactoryForTests ??
    (await import("openclaw/plugin-sdk/agent-harness")).createOpenClawCodingTools;
  const sessionKeys = resolveOpenClawCodingToolsSessionKeys(params, input.sandboxSessionKey);
  const allTools = createOpenClawCodingTools({
    agentId: input.sessionAgentId,
    ...buildEmbeddedAttemptToolRunContext(params),
    exec: {
      ...params.execOverrides,
      elevated: params.bashElevated,
    },
    sandbox: input.sandbox,
    messageProvider: params.messageChannel ?? params.messageProvider,
    agentAccountId: params.agentAccountId,
    messageTo: params.messageTo,
    messageThreadId: params.messageThreadId,
    groupId: params.groupId,
    groupChannel: params.groupChannel,
    groupSpace: params.groupSpace,
    spawnedBy: params.spawnedBy,
    senderId: params.senderId,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
    senderE164: params.senderE164,
    senderIsOwner: params.senderIsOwner,
    allowGatewaySubagentBinding: params.allowGatewaySubagentBinding,
    ...sessionKeys,
    sessionId: params.sessionId,
    runId: params.runId,
    agentDir,
    workspaceDir: input.effectiveWorkspace,
    spawnWorkspaceDir: resolveAttemptSpawnWorkspaceDir({
      sandbox: input.sandbox,
      resolvedWorkspace: input.resolvedWorkspace,
    }),
    config: params.config,
    abortSignal: input.runAbortController.signal,
    modelProvider: params.model.provider,
    modelId: params.modelId,
    modelCompat:
      params.model.compat && typeof params.model.compat === "object"
        ? (params.model.compat as OpenClawCodingToolsOptions["modelCompat"])
        : undefined,
    modelApi: params.model.api,
    modelContextWindowTokens: params.model.contextWindow,
    modelAuthMode: resolveModelAuthMode(params.model.provider, params.config, undefined, {
      workspaceDir: input.effectiveWorkspace,
    }),
    suppressManagedWebSearch: false,
    currentChannelId: params.currentChannelId,
    currentThreadTs: params.currentThreadTs,
    currentMessageId: params.currentMessageId,
    replyToMode: params.replyToMode,
    hasRepliedRef: params.hasRepliedRef,
    modelHasVision,
    requireExplicitMessageTarget:
      params.requireExplicitMessageTarget ?? isSubagentSessionKey(params.sessionKey),
    sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
    disableMessageTool: params.disableMessageTool,
    forceMessageTool: shouldForceMessageTool(params),
    enableHeartbeatTool: params.trigger === "heartbeat",
    forceHeartbeatTool: params.trigger === "heartbeat",
    onYield: (message) => {
      input.onYieldDetected();
      emitCodexAppServerEvent(params, {
        stream: "codex_app_server.tool",
        data: { name: "sessions_yield", message },
      });
      input.runAbortController.abort("sessions_yield");
    },
  });
  const codexFilteredTools = filterCodexDynamicTools(allTools, input.pluginConfig);
  const visionFilteredTools = filterToolsForVisionInputs(codexFilteredTools, {
    modelHasVision,
    hasInboundImages: (params.images?.length ?? 0) > 0,
  });
  const filteredTools = filterCodexDynamicToolsForAllowlist(visionFilteredTools, params.toolsAllow);
  return normalizeAgentRuntimeTools({
    runtimePlan: params.runtimePlan,
    tools: filteredTools,
    provider: params.provider,
    config: params.config,
    workspaceDir: input.effectiveWorkspace,
    env: process.env,
    modelId: params.modelId,
    modelApi: params.model.api,
    model: params.model,
  });
}

function filterCodexDynamicToolsForAllowlist<T extends { name: string }>(
  tools: T[],
  toolsAllow?: string[],
): T[] {
  if (!toolsAllow || toolsAllow.length === 0) {
    return tools;
  }
  const allowSet = new Set(
    toolsAllow.map((name) => normalizeCodexDynamicToolName(name)).filter(Boolean),
  );
  return tools.filter((tool) => allowSet.has(normalizeCodexDynamicToolName(tool.name)));
}

function shouldForceMessageTool(params: EmbeddedRunAttemptParams): boolean {
  return params.sourceReplyDeliveryMode === "message_tool_only";
}

function shouldProjectMirroredHistoryForCodexStart(params: {
  startupBinding: CodexAppServerThreadBinding | undefined;
  dynamicToolsFingerprint: string;
  historyMessages: AgentMessage[];
}): boolean {
  if (!params.historyMessages.some((message) => message.role === "user")) {
    return false;
  }
  if (!params.startupBinding?.threadId) {
    return true;
  }
  return !areCodexDynamicToolFingerprintsCompatible({
    previous: params.startupBinding.dynamicToolsFingerprint,
    next: params.dynamicToolsFingerprint,
  });
}

async function withCodexStartupTimeout<T>(params: {
  timeoutMs: number;
  signal: AbortSignal;
  operation: () => Promise<T>;
}): Promise<T> {
  if (params.signal.aborted) {
    throw new Error("codex app-server startup aborted");
  }
  let timeout: NodeJS.Timeout | undefined;
  let abortCleanup: (() => void) | undefined;
  try {
    return await Promise.race([
      params.operation(),
      new Promise<never>((_, reject) => {
        const rejectOnce = (error: Error) => {
          if (timeout) {
            clearTimeout(timeout);
            timeout = undefined;
          }
          reject(error);
        };
        timeout = setTimeout(() => {
          rejectOnce(new Error("codex app-server startup timed out"));
        }, params.timeoutMs);
        const abortListener = () => rejectOnce(new Error("codex app-server startup aborted"));
        params.signal.addEventListener("abort", abortListener, { once: true });
        abortCleanup = () => params.signal.removeEventListener("abort", abortListener);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    abortCleanup?.();
  }
}

function resolveCodexStartupTimeoutMs(params: {
  timeoutMs: number;
  timeoutFloorMs?: number;
}): number {
  return Math.max(
    params.timeoutFloorMs ?? CODEX_APP_SERVER_STARTUP_TIMEOUT_FLOOR_MS,
    params.timeoutMs,
  );
}

function resolveCodexTurnCompletionIdleTimeoutMs(value: number | undefined): number {
  if (value === undefined) {
    return CODEX_TURN_COMPLETION_IDLE_TIMEOUT_MS;
  }
  if (!Number.isFinite(value)) {
    return CODEX_TURN_COMPLETION_IDLE_TIMEOUT_MS;
  }
  return Math.max(1, Math.floor(value));
}

function resolveCodexTurnTerminalIdleTimeoutMs(value: number | undefined): number {
  if (value === undefined) {
    return CODEX_TURN_TERMINAL_IDLE_TIMEOUT_MS;
  }
  if (!Number.isFinite(value)) {
    return CODEX_TURN_TERMINAL_IDLE_TIMEOUT_MS;
  }
  return Math.max(1, Math.floor(value));
}

function readDynamicToolCallParams(
  value: JsonValue | undefined,
): CodexDynamicToolCallParams | undefined {
  return readCodexDynamicToolCallParams(value);
}

function formatCodexTurnStartUsageLimitError(
  error: unknown,
  pendingNotifications: CodexServerNotification[],
): string | undefined {
  const notificationError = readLatestCodexErrorNotification(pendingNotifications);
  const errorPayload = readCodexErrorPayload(error);
  return formatCodexUsageLimitErrorMessage({
    message: notificationError?.message ?? errorPayload.message ?? formatErrorMessage(error),
    codexErrorInfo: notificationError?.codexErrorInfo ?? errorPayload.codexErrorInfo,
    rateLimits:
      readLatestRateLimitNotificationPayload(pendingNotifications) ??
      errorPayload.rateLimits ??
      readRecentCodexRateLimits(),
  });
}

function readLatestRateLimitNotificationPayload(
  notifications: CodexServerNotification[],
): JsonValue | undefined {
  for (let index = notifications.length - 1; index >= 0; index -= 1) {
    const notification = notifications[index];
    if (notification?.method === "account/rateLimits/updated") {
      rememberCodexRateLimits(notification.params);
      return notification.params;
    }
  }
  return undefined;
}

function readLatestCodexErrorNotification(
  notifications: CodexServerNotification[],
): { message?: string; codexErrorInfo?: JsonValue | null } | undefined {
  for (let index = notifications.length - 1; index >= 0; index -= 1) {
    const notification = notifications[index];
    if (notification?.method !== "error" || !isJsonObject(notification.params)) {
      continue;
    }
    const error = notification.params.error;
    if (!isJsonObject(error)) {
      continue;
    }
    return {
      message: readString(error, "message"),
      codexErrorInfo: error.codexErrorInfo,
    };
  }
  return undefined;
}

function readCodexErrorPayload(error: unknown): {
  message?: string;
  codexErrorInfo?: JsonValue | null;
  rateLimits?: JsonValue;
} {
  const message = error instanceof Error ? error.message : undefined;
  if (!error || typeof error !== "object" || !("data" in error)) {
    return { message };
  }
  const data = (error as { data?: unknown }).data as JsonValue | undefined;
  if (!isJsonObject(data)) {
    return { message };
  }
  const nestedError = isJsonObject(data.error) ? data.error : data;
  return {
    message: readString(nestedError, "message") ?? message,
    codexErrorInfo: nestedError.codexErrorInfo,
    rateLimits: nestedError.rateLimits ?? data.rateLimits,
  };
}

function describeNotificationActivity(
  notification: CodexServerNotification,
): Record<string, unknown> | undefined {
  if (!isJsonObject(notification.params)) {
    return { lastNotificationMethod: notification.method };
  }
  if (notification.method !== "rawResponseItem/completed") {
    return { lastNotificationMethod: notification.method };
  }
  const item = isJsonObject(notification.params.item) ? notification.params.item : undefined;
  if (!item) {
    return { lastNotificationMethod: notification.method };
  }
  return {
    lastNotificationMethod: notification.method,
    lastNotificationItemId: readString(item, "id"),
    lastNotificationItemType: readString(item, "type"),
    lastNotificationItemRole: readString(item, "role"),
    lastAssistantTextPreview: readRawAssistantTextPreview(item),
  };
}

function readRawAssistantTextPreview(item: JsonObject): string | undefined {
  if (readString(item, "role") !== "assistant" || !Array.isArray(item.content)) {
    return undefined;
  }
  const text = item.content
    .flatMap((content) => {
      if (!isJsonObject(content)) {
        return [];
      }
      const contentText = readString(content, "text");
      return contentText ? [contentText] : [];
    })
    .join("\n")
    .trim();
  if (!text) {
    return undefined;
  }
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}

function isTurnNotification(
  value: JsonValue | undefined,
  threadId: string,
  turnId: string,
): boolean {
  if (!isJsonObject(value)) {
    return false;
  }
  return readString(value, "threadId") === threadId && readNotificationTurnId(value) === turnId;
}

function isRetryableErrorNotification(value: JsonValue | undefined): boolean {
  if (!isJsonObject(value)) {
    return false;
  }
  return readBoolean(value, "willRetry") === true || readBoolean(value, "will_retry") === true;
}

function isTerminalTurnStatus(status: string | undefined): boolean {
  return status === "completed" || status === "interrupted" || status === "failed";
}

function readNotificationTurnId(record: JsonObject): string | undefined {
  return readString(record, "turnId") ?? readNestedTurnId(record);
}

function readNestedTurnId(record: JsonObject): string | undefined {
  const turn = record.turn;
  return isJsonObject(turn) ? readString(turn, "id") : undefined;
}

function readString(record: JsonObject, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readBoolean(record: JsonObject, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

async function readMirroredSessionHistoryMessages(
  sessionFile: string,
): Promise<AgentMessage[] | undefined> {
  const messages = await readCodexMirroredSessionHistoryMessages(sessionFile);
  if (!messages) {
    embeddedAgentLog.warn("failed to read mirrored session history for codex harness hooks", {
      sessionFile,
    });
  }
  return messages;
}

async function buildCodexWorkspaceBootstrapInstructions(params: {
  params: EmbeddedRunAttemptParams;
  resolvedWorkspace: string;
  effectiveWorkspace: string;
  sessionKey: string;
  sessionAgentId: string;
}): Promise<string | undefined> {
  try {
    const { contextFiles } = await resolveBootstrapContextForRun({
      workspaceDir: params.resolvedWorkspace,
      config: params.params.config,
      sessionKey: params.sessionKey,
      sessionId: params.params.sessionId,
      agentId: params.params.agentId ?? params.sessionAgentId,
      warn: (message) => embeddedAgentLog.warn(message),
      contextMode: params.params.bootstrapContextMode,
      runKind: params.params.bootstrapContextRunKind,
    });
    return renderCodexWorkspaceBootstrapInstructions(
      contextFiles.map((file) =>
        remapCodexContextFilePath({
          file,
          sourceWorkspaceDir: params.resolvedWorkspace,
          targetWorkspaceDir: params.effectiveWorkspace,
        }),
      ),
    );
  } catch (error) {
    embeddedAgentLog.warn("failed to load codex workspace bootstrap instructions", { error });
    return undefined;
  }
}

function renderCodexWorkspaceBootstrapInstructions(
  contextFiles: EmbeddedContextFile[],
): string | undefined {
  const files = contextFiles
    .filter((file) => {
      const baseName = getCodexContextFileBasename(file.path);
      return baseName && !CODEX_NATIVE_PROJECT_DOC_BASENAMES.has(baseName);
    })
    .toSorted(compareCodexContextFiles);
  if (files.length === 0) {
    return undefined;
  }
  const hasSoulFile = files.some((file) => getCodexContextFileBasename(file.path) === "soul.md");
  const lines = [
    "OpenClaw loaded these user-editable workspace files. Treat them as project/user context. Codex loads AGENTS.md natively, so AGENTS.md is not repeated here.",
    "",
    "# Project Context",
    "",
    "The following project context files have been loaded:",
  ];
  if (hasSoulFile) {
    lines.push(
      "If SOUL.md is present, embody its persona and tone. Avoid stiff, generic replies; follow its guidance unless higher-priority instructions override it.",
    );
  }
  lines.push("");
  for (const file of files) {
    lines.push(`## ${file.path}`, "", file.content, "");
  }
  return lines.join("\n").trim();
}

function remapCodexContextFilePath(params: {
  file: EmbeddedContextFile;
  sourceWorkspaceDir: string;
  targetWorkspaceDir: string;
}): EmbeddedContextFile {
  const relativePath = path.relative(params.sourceWorkspaceDir, params.file.path);
  if (
    !relativePath ||
    relativePath.startsWith("..") ||
    path.isAbsolute(relativePath) ||
    params.sourceWorkspaceDir === params.targetWorkspaceDir
  ) {
    return params.file;
  }
  return {
    ...params.file,
    path: path.join(params.targetWorkspaceDir, relativePath),
  };
}

function compareCodexContextFiles(left: EmbeddedContextFile, right: EmbeddedContextFile): number {
  const leftPath = normalizeCodexContextFilePath(left.path);
  const rightPath = normalizeCodexContextFilePath(right.path);
  const leftBase = getCodexContextFileBasename(left.path);
  const rightBase = getCodexContextFileBasename(right.path);
  const leftOrder = CODEX_BOOTSTRAP_CONTEXT_ORDER.get(leftBase) ?? Number.MAX_SAFE_INTEGER;
  const rightOrder = CODEX_BOOTSTRAP_CONTEXT_ORDER.get(rightBase) ?? Number.MAX_SAFE_INTEGER;
  if (leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }
  if (leftBase !== rightBase) {
    return leftBase.localeCompare(rightBase);
  }
  return leftPath.localeCompare(rightPath);
}

function normalizeCodexContextFilePath(filePath: string): string {
  return filePath.trim().replaceAll("\\", "/").toLowerCase();
}

function getCodexContextFileBasename(filePath: string): string {
  return normalizeCodexContextFilePath(filePath).split("/").pop() ?? "";
}

async function mirrorTranscriptBestEffort(params: {
  params: EmbeddedRunAttemptParams;
  agentId?: string;
  result: EmbeddedRunAttemptResult;
  sessionKey?: string;
  threadId: string;
  turnId: string;
}): Promise<void> {
  try {
    await mirrorCodexAppServerTranscript({
      sessionFile: params.params.sessionFile,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      messages: params.result.messagesSnapshot,
      // Scope is thread-stable. Each entry in `messagesSnapshot` is tagged
      // with a per-turn `attachCodexMirrorIdentity` value carrying its own
      // turnId, so distinct turns produce distinct dedupe keys via the
      // identity (not via the scope). Dropping `turnId` from the scope
      // here is what lets a re-emitted prior-turn entry — which still
      // carries its original `${turnId}:${kind}` identity — collide with
      // its existing on-disk key and be a true no-op.
      idempotencyScope: `codex-app-server:${params.threadId}`,
      config: params.params.config,
    });
  } catch (error) {
    embeddedAgentLog.warn("failed to mirror codex app-server transcript", { error });
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function joinPresentSections(...sections: Array<string | undefined>): string {
  return sections.filter((section): section is string => Boolean(section?.trim())).join("\n\n");
}

function handleApprovalRequest(params: {
  method: string;
  params: JsonValue | undefined;
  paramsForRun: EmbeddedRunAttemptParams;
  threadId: string;
  turnId: string;
  signal?: AbortSignal;
}): Promise<JsonValue | undefined> {
  return handleCodexAppServerApprovalRequest({
    method: params.method,
    requestParams: params.params,
    paramsForRun: params.paramsForRun,
    threadId: params.threadId,
    turnId: params.turnId,
    signal: params.signal,
  });
}

export const __testing = {
  CODEX_DYNAMIC_TOOL_TIMEOUT_MS,
  CODEX_DYNAMIC_TOOL_MAX_TIMEOUT_MS,
  CODEX_DYNAMIC_IMAGE_TOOL_TIMEOUT_MS,
  CODEX_TURN_COMPLETION_IDLE_TIMEOUT_MS,
  CODEX_TURN_TERMINAL_IDLE_TIMEOUT_MS,
  buildCodexNativeHookRelayId,
  filterCodexDynamicTools,
  buildDynamicTools,
  filterCodexDynamicToolsForAllowlist,
  filterToolsForVisionInputs,
  handleDynamicToolCallWithTimeout,
  resolveDynamicToolCallTimeoutMs,
  resolveCodexPluginAppCacheEndpoint,
  resolveOpenClawCodingToolsSessionKeys,
  shouldForceMessageTool,
  setOpenClawCodingToolsFactoryForTests(factory: OpenClawCodingToolsFactory): void {
    openClawCodingToolsFactoryForTests = factory;
  },
  resetOpenClawCodingToolsFactoryForTests(): void {
    openClawCodingToolsFactoryForTests = undefined;
  },
  setCodexAppServerClientFactoryForTests(factory: CodexAppServerClientFactory): void {
    testClientFactoryStorage.enterWith(factory);
  },
  resetCodexAppServerClientFactoryForTests(): void {
    testClientFactoryStorage.enterWith(undefined);
  },
} as const;
