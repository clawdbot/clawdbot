import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  assembleHarnessContextEngine,
  bootstrapHarnessContextEngine,
  buildAgentHookContextChannelFields,
  buildHarnessContextEngineRuntimeContext,
  buildHarnessContextEngineRuntimeContextFromUsage,
  buildEmbeddedAttemptToolRunContext,
  clearActiveEmbeddedRun,
  compactContextEngineWithSafetyTimeout,
  embeddedAgentLog,
  emitAgentEvent as emitGlobalAgentEvent,
  finalizeHarnessContextEngineTurn,
  formatErrorMessage,
  hasBeforeToolCallPolicy,
  isActiveHarnessContextEngine,
  isSubagentSessionKey,
  loadCodexBundleMcpThreadConfig,
  normalizeAgentRuntimeTools,
  resolveAttemptSpawnWorkspaceDir,
  resolveAgentHarnessBeforePromptBuildResult,
  resolveCompactionTimeoutMs,
  resolveModelAuthMode,
  resolveContextEngineOwnerPluginId,
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
  hasSandboxBindContainerPathAliases,
  hasSandboxBindReadonlyHostShadows,
  resolveWritableSandboxBindHostRoots,
  runAgentCleanupStep,
  type AgentMessage,
  type EmbeddedRunAttemptParams,
  type EmbeddedRunAttemptResult,
  type EmbeddedContextFile,
  type ContextEngineProjection,
  type NativeHookRelayEvent,
  type NativeHookRelayRegistrationHandle,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { markAuthProfileBlockedUntil, resolveAgentDir } from "openclaw/plugin-sdk/agent-runtime";
import {
  emitTrustedDiagnosticEvent,
  hasPendingInternalDiagnosticEvent,
  onInternalDiagnosticEvent,
  type DiagnosticEventPayload,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { pathExists } from "openclaw/plugin-sdk/security-runtime";
import { defaultCodexAppInventoryCache } from "./app-inventory-cache.js";
import { handleCodexAppServerApprovalRequest } from "./approval-bridge.js";
import {
  refreshCodexAppServerAuthTokens,
  resolveCodexAppServerAuthAccountCacheKey,
  resolveCodexAppServerEnvApiKeyCacheKey,
  resolveCodexAppServerHomeDir,
  resolveCodexAppServerAuthProfileId,
  resolveCodexAppServerAuthProfileIdForAgent,
} from "./auth-bridge.js";
import { CODEX_CONTROL_METHODS } from "./capabilities.js";
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
  isCodexAppServerApprovalPolicyAllowedByRequirements,
  readCodexPluginConfig,
  resolveCodexComputerUseConfig,
  resolveCodexPluginsPolicy,
  resolveCodexAppServerRuntimeOptions,
  withMcpElicitationsApprovalPolicy,
  type CodexAppServerRuntimeOptions,
  type CodexPluginConfig,
} from "./config.js";
import {
  projectContextEngineAssemblyForCodex,
  resolveCodexContextEngineProjectionMaxChars,
  resolveCodexContextEngineProjectionReserveTokens,
} from "./context-engine-projection.js";
import {
  emitDynamicToolErrorDiagnostic,
  emitDynamicToolStartedDiagnostic,
  emitDynamicToolTerminalDiagnostic,
} from "./dynamic-tool-diagnostics.js";
import {
  filterCodexDynamicTools,
  isForcedPrivateQaCodexRuntime,
  normalizeCodexDynamicToolName,
  resolveCodexDynamicToolsLoading,
} from "./dynamic-tool-profile.js";
import { createCodexDynamicToolBridge, type CodexDynamicToolBridge } from "./dynamic-tools.js";
import { handleCodexAppServerElicitationRequest } from "./elicitation-bridge.js";
import {
  CodexAppServerEventProjector,
  shouldEmitTranscriptToolProgress,
} from "./event-projector.js";
import {
  buildCodexNativeHookRelayDisabledConfig,
  buildCodexNativeHookRelayConfig,
  CODEX_NATIVE_HOOK_RELAY_EVENTS,
} from "./native-hook-relay.js";
import { buildCodexPluginAppCacheKey } from "./plugin-app-cache-key.js";
import {
  buildCodexPluginThreadConfig,
  buildCodexPluginThreadConfigInputFingerprint,
  mergeCodexThreadConfigs,
  shouldBuildCodexPluginThreadConfig,
} from "./plugin-thread-config.js";
import {
  assertCodexTurnStartResponse,
  readCodexDynamicToolCallParams,
} from "./protocol-validators.js";
import {
  type CodexUserInput,
  isJsonObject,
  type CodexSandboxPolicy,
  type CodexServerNotification,
  type CodexDynamicToolSpec,
  type CodexDynamicToolCallParams,
  type CodexDynamicToolCallResponse,
  type CodexThreadItem,
  type CodexTurnStartResponse,
  type JsonObject,
  type JsonValue,
} from "./protocol.js";
import { readRecentCodexRateLimits, rememberCodexRateLimits } from "./rate-limit-cache.js";
import {
  formatCodexUsageLimitErrorMessage,
  resolveCodexUsageLimitResetAtMs,
  shouldRefreshCodexRateLimitsForUsageLimitMessage,
} from "./rate-limits.js";
import {
  clearCodexAppServerBinding,
  readCodexAppServerBinding,
  type CodexAppServerThreadBinding,
} from "./session-binding.js";
import { readCodexMirroredSessionHistoryMessages } from "./session-history.js";
import { clearSharedCodexAppServerClientIfCurrent } from "./shared-client.js";
import {
  areCodexDynamicToolFingerprintsCompatible,
  buildDeveloperInstructions,
  buildContextEngineBinding,
  buildTurnStartParams,
  codexDynamicToolsFingerprint,
  isContextEngineBindingCompatible,
  startOrResumeThread,
  type CodexAppServerThreadLifecycleBinding,
  type CodexContextEngineThreadBootstrapProjection,
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
import {
  buildCodexUserPromptMessage,
  mirrorCodexAppServerTranscript,
} from "./transcript-mirror.js";
import { createCodexUserInputBridge } from "./user-input-bridge.js";
import { filterToolsForVisionInputs } from "./vision-tools.js";

const CODEX_DYNAMIC_TOOL_TIMEOUT_MS = 30_000;
const CODEX_DYNAMIC_TOOL_MAX_TIMEOUT_MS = 600_000;
const CODEX_DYNAMIC_IMAGE_GENERATION_TOOL_TIMEOUT_MS = 120_000;
const CODEX_DYNAMIC_IMAGE_TOOL_TIMEOUT_MS = 60_000;
const CODEX_APP_SERVER_STARTUP_CONNECTION_CLOSE_MAX_ATTEMPTS = 3;
const CODEX_APP_SERVER_STARTUP_TIMEOUT_FLOOR_MS = 100;
const CODEX_APP_SERVER_INTERRUPT_TIMEOUT_MS = 5_000;
const CODEX_USAGE_LIMIT_RATE_LIMIT_REFRESH_TIMEOUT_MS = 5_000;
const CODEX_TURN_COMPLETION_IDLE_TIMEOUT_MS = 60_000;
const CODEX_TURN_ASSISTANT_COMPLETION_IDLE_TIMEOUT_MS = 10_000;
const CODEX_TURN_TERMINAL_IDLE_TIMEOUT_MS = 30 * 60_000;
const CODEX_NATIVE_HOOK_RELAY_MIN_TTL_MS = 30 * 60_000;
const CODEX_NATIVE_HOOK_RELAY_TTL_GRACE_MS = 5 * 60_000;
const CODEX_NATIVE_HOOK_RELAY_RENEW_INTERVAL_MS = 60_000;
const CODEX_STEER_ALL_DEBOUNCE_MS = 500;
const LOG_FIELD_MAX_LENGTH = 160;
const CODEX_NATIVE_PROJECT_DOC_BASENAMES = new Set(["agents.md"]);
const CODEX_WORKSPACE_DEVELOPER_CONTEXT_BASENAMES = new Set([
  "identity.md",
  "soul.md",
  "tools.md",
  "user.md",
]);
const CODEX_HEARTBEAT_CONTEXT_BASENAME = "heartbeat.md";
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
type OpenClawDynamicTool = ReturnType<OpenClawCodingToolsFactory>[number];
type CodexBootstrapContext = Awaited<ReturnType<typeof resolveBootstrapContextForRun>>;
type CodexBootstrapFile = CodexBootstrapContext["bootstrapFiles"][number];
type CodexSystemPromptReport = NonNullable<EmbeddedRunAttemptResult["systemPromptReport"]>;
type CodexToolReportEntry = CodexSystemPromptReport["tools"]["entries"][number];
type CodexWorkspaceBootstrapContext = CodexBootstrapContext & {
  promptContextFiles?: EmbeddedContextFile[];
  developerInstructionFiles?: EmbeddedContextFile[];
  heartbeatReferenceFiles?: EmbeddedContextFile[];
  promptContext?: string;
  developerInstructions?: string;
  heartbeatCollaborationInstructions?: string;
};

let openClawCodingToolsFactoryForTests: OpenClawCodingToolsFactory | undefined;

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
  type PendingSteerText = {
    text: string;
    resolve: () => void;
    reject: (error: unknown) => void;
  };
  let batchedTexts: PendingSteerText[] = [];
  let batchTimer: NodeJS.Timeout | undefined;
  let sendChain: Promise<void> = Promise.resolve();

  const clearBatchTimer = () => {
    if (batchTimer) {
      clearTimeout(batchTimer);
      batchTimer = undefined;
    }
  };

  const sendTexts = async (texts: string[]) => {
    if (texts.length === 0) {
      return;
    }
    if (params.signal.aborted) {
      throw new Error("codex app-server steering queue aborted");
    }
    await params.client.request("turn/steer", {
      threadId: params.threadId,
      expectedTurnId: params.turnId,
      input: texts.map(toCodexTextInput),
    });
  };

  const enqueueSend = (texts: string[]) => {
    const send = sendChain.then(() => sendTexts(texts));
    sendChain = send.catch((error: unknown) => {
      embeddedAgentLog.debug("codex app-server queued steer failed", { error });
    });
    return send;
  };

  const flushBatch = () => {
    clearBatchTimer();
    const items = batchedTexts;
    batchedTexts = [];
    const send = enqueueSend(items.map((item) => item.text));
    void send.then(
      () => {
        for (const item of items) {
          item.resolve();
        }
      },
      (error: unknown) => {
        for (const item of items) {
          item.reject(error);
        }
      },
    );
    return send;
  };

  return {
    async queue(text: string, options?: CodexSteeringQueueOptions) {
      if (params.answerPendingUserInput(text)) {
        return;
      }
      return await new Promise<void>((resolve, reject) => {
        batchedTexts.push({ text, resolve, reject });
        clearBatchTimer();
        const debounceMs = normalizeCodexSteerDebounceMs(options?.debounceMs);
        batchTimer = setTimeout(() => {
          batchTimer = undefined;
          void flushBatch().catch(() => undefined);
        }, debounceMs);
      });
    },
    async flushPending() {
      await flushBatch().catch(() => undefined);
    },
    cancel() {
      clearBatchTimer();
      const items = batchedTexts;
      batchedTexts = [];
      for (const item of items) {
        item.reject(new Error("codex app-server steering queue cancelled"));
      }
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

type OpenClawSandboxContext = Awaited<ReturnType<typeof resolveSandboxContext>>;

function resolveCodexAppServerSandboxPolicyForOpenClawSandbox(
  appServer: CodexAppServerRuntimeOptions,
  sandbox: OpenClawSandboxContext,
  cwd: string,
): CodexSandboxPolicy | undefined {
  if (!sandbox?.enabled || appServer.sandbox === "read-only") {
    return undefined;
  }
  const networkAccess = codexNetworkAccessForOpenClawSandbox(sandbox);
  const writableRoots = new Set([cwd]);
  if (sandbox.backendId === "docker") {
    for (const root of resolveWritableSandboxBindHostRoots(sandbox.docker.binds)) {
      writableRoots.add(root);
    }
  }
  // Codex app-server still runs on the Gateway host, so keep Codex's
  // filesystem sandbox while mirroring the OpenClaw sandbox egress policy.
  return {
    type: "workspaceWrite",
    writableRoots: [...writableRoots],
    networkAccess,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

function codexNetworkAccessForOpenClawSandbox(sandbox: OpenClawSandboxContext): boolean {
  if (!sandbox?.enabled || sandbox.backendId !== "docker") {
    return true;
  }
  return sandbox.docker.network.trim().toLowerCase() !== "none";
}

function resolveCodexAppServerForOpenClawToolPolicy(params: {
  appServer: CodexAppServerRuntimeOptions;
  pluginConfig: CodexPluginConfig;
  env: NodeJS.ProcessEnv;
  shouldPromote: boolean;
  canUseUntrustedApprovalPolicy: boolean;
}): CodexAppServerRuntimeOptions {
  if (
    !params.shouldPromote ||
    !params.canUseUntrustedApprovalPolicy ||
    params.appServer.approvalPolicy !== "never"
  ) {
    return params.appServer;
  }
  const explicitMode =
    params.pluginConfig.appServer?.mode !== undefined ||
    isCodexAppServerPolicyMode(params.env.OPENCLAW_CODEX_APP_SERVER_MODE);
  const explicitApprovalPolicy =
    params.pluginConfig.appServer?.approvalPolicy !== undefined ||
    isCodexAppServerApprovalPolicy(params.env.OPENCLAW_CODEX_APP_SERVER_APPROVAL_POLICY);
  if (explicitMode || explicitApprovalPolicy) {
    return params.appServer;
  }
  return {
    ...params.appServer,
    approvalPolicy: "untrusted",
  };
}

function isCodexAppServerPolicyMode(value: unknown): boolean {
  return value === "guardian" || value === "yolo";
}

function isCodexAppServerApprovalPolicy(value: unknown): boolean {
  return (
    value === "never" || value === "on-request" || value === "on-failure" || value === "untrusted"
  );
}

const CODEX_APP_SERVER_NATIVE_THREAD_MAX_TOKENS = 70_000;
const CODEX_APP_SERVER_BYTE_UNITS: Record<string, number> = {
  b: 1,
  k: 1024,
  kb: 1024,
  kib: 1024,
  m: 1024 * 1024,
  mb: 1024 * 1024,
  mib: 1024 * 1024,
  g: 1024 * 1024 * 1024,
  gb: 1024 * 1024 * 1024,
  gib: 1024 * 1024 * 1024,
  t: 1024 * 1024 * 1024 * 1024,
  tb: 1024 * 1024 * 1024 * 1024,
  tib: 1024 * 1024 * 1024 * 1024,
};

function parseCodexAppServerByteLimit(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*([a-z]+)?$/i);
  if (!match) {
    return undefined;
  }
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) {
    return undefined;
  }
  const unit = (match[2] ?? "b").toLowerCase();
  const multiplier = CODEX_APP_SERVER_BYTE_UNITS[unit];
  if (multiplier === undefined) {
    return undefined;
  }
  return Math.max(1, Math.round(amount * multiplier));
}

async function listCodexAppServerRolloutFilesForThread(
  agentDir: string,
  threadId: string,
  codexHome?: string,
): Promise<Array<{ path: string; bytes: number }>> {
  const resolvedAgentDir = path.resolve(agentDir);
  const resolvedCodexHome = codexHome?.trim()
    ? path.resolve(codexHome)
    : resolveCodexAppServerHomeDir(resolvedAgentDir);
  const roots = [
    path.join(resolvedCodexHome, "sessions"),
    path.join(resolveCodexAppServerHomeDir(resolvedAgentDir), "sessions"),
    path.join(resolvedAgentDir, "agent", "codex-home", "sessions"),
    path.join(path.dirname(resolvedAgentDir), "codex-home", "sessions"),
  ];
  const files: Array<{ path: string; bytes: number }> = [];
  const visited = new Set<string>();
  for (const root of roots) {
    if (visited.has(root)) {
      continue;
    }
    visited.add(root);
    const stack = [root];
    while (stack.length > 0) {
      const dir = stack.pop();
      if (!dir) {
        continue;
      }
      let entries: Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(file);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith(".jsonl") || !entry.name.includes(threadId)) {
          continue;
        }
        try {
          files.push({ path: file, bytes: (await fs.stat(file)).size });
        } catch {
          // Ignore rollout files that disappeared while the guard was scanning.
        }
      }
    }
  }
  return files;
}

async function readCodexSessionRecordForSessionFile(
  sessionFile: string,
): Promise<(Record<string, unknown> & { sessionKey: string }) | undefined> {
  const sessionsFile = path.join(path.dirname(sessionFile), "sessions.json");
  let store: JsonValue | undefined;
  try {
    store = JSON.parse(await fs.readFile(sessionsFile, "utf8")) as JsonValue;
  } catch {
    return undefined;
  }
  if (!isJsonObject(store)) {
    return undefined;
  }
  const resolvedSessionFile = path.resolve(sessionFile);
  for (const [sessionKey, record] of Object.entries(store)) {
    if (!isJsonObject(record) || typeof record.sessionFile !== "string") {
      continue;
    }
    if (path.resolve(record.sessionFile) !== resolvedSessionFile) {
      continue;
    }
    return { sessionKey, ...record };
  }
  return undefined;
}

async function readCodexAppServerRolloutTokenUsage(file: string): Promise<number | undefined> {
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(file, "r");
  } catch {
    return undefined;
  }
  let totalTokens: number | undefined;
  try {
    for await (const line of handle.readLines()) {
      const lineTokens = readCodexAppServerRolloutTokenUsageLine(line);
      if (lineTokens !== undefined) {
        totalTokens = lineTokens;
      }
    }
  } finally {
    await handle.close();
  }
  return totalTokens;
}

function readCodexAppServerRolloutTokenUsageLine(line: string): number | undefined {
  if (!line.trim()) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(line) as JsonValue;
    const payload = isJsonObject(parsed) ? parsed.payload : undefined;
    const info =
      isJsonObject(payload) && payload.type === "token_count" && isJsonObject(payload.info)
        ? payload.info
        : undefined;
    if (!info) {
      return undefined;
    }
    const usage = isJsonObject(info.last_token_usage)
      ? info.last_token_usage
      : isJsonObject(info.total_token_usage)
        ? info.total_token_usage
        : undefined;
    const value = usage?.total_tokens ?? usage?.totalTokens;
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function maxFiniteNumber(values: Array<number | undefined>): number | undefined {
  const nums = values.filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value),
  );
  if (nums.length === 0) {
    return undefined;
  }
  return Math.max(...nums);
}

async function rotateOversizedCodexAppServerStartupBinding(params: {
  binding: CodexAppServerThreadBinding | undefined;
  sessionFile: string;
  agentDir: string;
  codexHome?: string;
  config: EmbeddedRunAttemptParams["config"] | undefined;
}): Promise<CodexAppServerThreadBinding | undefined> {
  const binding = params.binding;
  if (!binding?.threadId) {
    return binding;
  }
  if (params.config?.agents?.defaults?.compaction?.truncateAfterCompaction !== true) {
    return binding;
  }
  const sessionRecord = await readCodexSessionRecordForSessionFile(params.sessionFile);
  const maxBytes = parseCodexAppServerByteLimit(
    params.config?.agents?.defaults?.compaction?.maxActiveTranscriptBytes,
  );
  const rolloutFiles = await listCodexAppServerRolloutFilesForThread(
    params.agentDir,
    binding.threadId,
    params.codexHome,
  );
  if (maxBytes !== undefined) {
    const oversizedFiles = rolloutFiles.filter((file) => file.bytes >= maxBytes);
    if (oversizedFiles.length > 0) {
      embeddedAgentLog.warn(
        "codex app-server native transcript exceeded active byte limit; starting a fresh thread",
        {
          threadId: binding.threadId,
          maxBytes,
          files: oversizedFiles.map((file) => ({ path: file.path, bytes: file.bytes })),
        },
      );
      await clearCodexAppServerBinding(params.sessionFile);
      return undefined;
    }
  }
  const nativeTokens = maxFiniteNumber(
    await Promise.all(
      rolloutFiles.map(async (file) => readCodexAppServerRolloutTokenUsage(file.path)),
    ),
  );
  const sessionTokens =
    sessionRecord?.totalTokensFresh !== false &&
    typeof sessionRecord?.totalTokens === "number" &&
    Number.isFinite(sessionRecord.totalTokens)
      ? sessionRecord.totalTokens
      : undefined;
  const tokenCount = maxFiniteNumber([sessionTokens, nativeTokens]);
  if (tokenCount !== undefined && tokenCount >= CODEX_APP_SERVER_NATIVE_THREAD_MAX_TOKENS) {
    embeddedAgentLog.warn(
      "codex app-server native transcript exceeded active token limit; starting a fresh thread",
      {
        threadId: binding.threadId,
        maxTokens: CODEX_APP_SERVER_NATIVE_THREAD_MAX_TOKENS,
        sessionKey: sessionRecord?.sessionKey,
        sessionTokens,
        nativeTokens,
      },
    );
    await clearCodexAppServerBinding(params.sessionFile);
    return undefined;
  }
  return binding;
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
    turnAssistantCompletionIdleTimeoutMs?: number;
    turnTerminalIdleTimeoutMs?: number;
    clientFactory?: CodexAppServerClientFactory;
  } = {},
): Promise<EmbeddedRunAttemptResult> {
  const attemptStartedAt = Date.now();
  const attemptClientFactory = options.clientFactory ?? defaultCodexAppServerClientFactory;
  const pluginConfig = readCodexPluginConfig(options.pluginConfig);
  const computerUseConfig = resolveCodexComputerUseConfig({ pluginConfig });
  const configuredAppServer = resolveCodexAppServerRuntimeOptions({ pluginConfig });
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
  const codexSandboxPolicy = resolveCodexAppServerSandboxPolicyForOpenClawSandbox(
    configuredAppServer,
    sandbox,
    effectiveWorkspace,
  );
  const appServer = resolveCodexAppServerForOpenClawToolPolicy({
    appServer: configuredAppServer,
    pluginConfig,
    env: process.env,
    shouldPromote: hasBeforeToolCallPolicy(),
    canUseUntrustedApprovalPolicy:
      configuredAppServer.start.transport !== "stdio" ||
      isCodexAppServerApprovalPolicyAllowedByRequirements("untrusted"),
  });
  let pluginAppServer: CodexAppServerRuntimeOptions = appServer;
  const nativeHookRelayEvents = resolveCodexNativeHookRelayEvents({
    configuredEvents: options.nativeHookRelay?.events,
    appServer,
  });

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
  let startupBinding = await readCodexAppServerBinding(params.sessionFile);
  const startupBindingAuthProfileId = startupBinding?.authProfileId;
  startupBinding = await rotateOversizedCodexAppServerStartupBinding({
    binding: startupBinding,
    sessionFile: params.sessionFile,
    agentDir,
    codexHome: appServer.start.env?.CODEX_HOME,
    config: params.config,
  });
  const startupAuthProfileCandidate =
    params.runtimePlan?.auth.forwardedAuthProfileId ??
    params.authProfileId ??
    startupBinding?.authProfileId ??
    startupBindingAuthProfileId;
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
  let activeSessionId = params.sessionId;
  let activeSessionFile = params.sessionFile;
  const buildActiveRunAttemptParams = (): EmbeddedRunAttemptParams => ({
    ...runtimeParams,
    sessionId: activeSessionId,
    sessionFile: activeSessionFile,
  });
  const adoptContextEngineCompactionTranscript = (compactResult: {
    result?: { sessionId?: string; sessionFile?: string };
  }): void => {
    if (compactResult.result?.sessionId) {
      activeSessionId = compactResult.result.sessionId;
    }
    if (compactResult.result?.sessionFile) {
      activeSessionFile = compactResult.result.sessionFile;
    }
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
  const bundleMcpThreadConfig = await loadCodexBundleMcpThreadConfig({
    workspaceDir: effectiveWorkspace,
    cfg: params.config,
    toolsEnabled: supportsModelTools(params.model),
    disableTools: params.disableTools,
    toolsAllow: params.toolsAllow,
  });
  const nativeToolSurfaceEnabled = shouldEnableCodexAppServerNativeToolSurface(params, sandbox);
  for (const diagnostic of bundleMcpThreadConfig.diagnostics) {
    embeddedAgentLog.warn(`bundle-mcp: ${diagnostic.pluginId}: ${diagnostic.message}`);
  }
  const activeContextEngine = isActiveHarnessContextEngine(params.contextEngine)
    ? params.contextEngine
    : undefined;
  const hookChannelId = resolveCodexAppServerHookChannelId(params, sandboxSessionKey);
  let yieldDetected = false;
  const tools = await buildDynamicTools({
    params,
    resolvedWorkspace,
    effectiveWorkspace,
    sandboxSessionKey,
    sandbox,
    nativeToolSurfaceEnabled,
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
    loading: resolveCodexDynamicToolsLoading(pluginConfig),
    directToolNames: shouldForceMessageTool(params) ? ["message"] : [],
    hookContext: {
      agentId: sessionAgentId,
      config: params.config,
      sessionId: params.sessionId,
      sessionKey: sandboxSessionKey,
      runId: params.runId,
      channelId: hookChannelId,
    },
  });
  const hadSessionFile = await pathExists(activeSessionFile);
  let historyMessages = (await readMirroredSessionHistoryMessages(activeSessionFile)) ?? [];
  const hookContextWindowFields = {
    ...(params.contextWindowInfo?.tokens
      ? { contextTokenBudget: params.contextWindowInfo.tokens }
      : params.contextTokenBudget
        ? { contextTokenBudget: params.contextTokenBudget }
        : {}),
    ...(params.contextWindowInfo?.source
      ? { contextWindowSource: params.contextWindowInfo.source }
      : {}),
    ...(params.contextWindowInfo?.referenceTokens
      ? { contextWindowReferenceTokens: params.contextWindowInfo.referenceTokens }
      : {}),
  };
  const hookContext = {
    runId: params.runId,
    agentId: sessionAgentId,
    sessionKey: sandboxSessionKey,
    sessionId: params.sessionId,
    workspaceDir: params.workspaceDir,
    messageProvider: params.messageProvider ?? undefined,
    trigger: params.trigger,
    channelId: hookChannelId,
    ...hookContextWindowFields,
  };
  const activeContextEnginePluginId = activeContextEngine
    ? resolveContextEngineOwnerPluginId(activeContextEngine)
    : undefined;
  const buildActiveContextEngineRuntimeContext = () =>
    buildHarnessContextEngineRuntimeContext({
      attempt: buildActiveRunAttemptParams(),
      workspaceDir: effectiveWorkspace,
      agentDir,
      activeAgentId: sessionAgentId,
      contextEnginePluginId: activeContextEnginePluginId,
      tokenBudget: params.contextTokenBudget,
    });
  if (activeContextEngine) {
    await bootstrapHarnessContextEngine({
      hadSessionFile,
      contextEngine: activeContextEngine,
      sessionId: activeSessionId,
      sessionKey: sandboxSessionKey,
      sessionFile: activeSessionFile,
      runtimeContext: buildActiveContextEngineRuntimeContext(),
      runMaintenance: runHarnessContextEngineMaintenance,
      config: params.config,
      warn: (message) => embeddedAgentLog.warn(message),
    });
    historyMessages =
      (await readMirroredSessionHistoryMessages(activeSessionFile)) ?? historyMessages;
  }
  const workspaceBootstrapContext = await buildCodexWorkspaceBootstrapContext({
    params,
    resolvedWorkspace,
    effectiveWorkspace,
    sessionKey: sandboxSessionKey,
    sessionAgentId,
  });
  const baseDeveloperInstructions = joinPresentSections(
    buildDeveloperInstructions(params, {
      dynamicTools: toolBridge.specs,
    }),
    workspaceBootstrapContext.developerInstructions,
  );
  const openClawPromptContext = buildCodexOpenClawPromptContext({
    params,
    skillsPrompt: params.skillsSnapshot?.prompt,
    workspacePromptContext: workspaceBootstrapContext.promptContext,
  });
  let promptText = params.prompt;
  let developerInstructions = baseDeveloperInstructions;
  let prePromptMessageCount = historyMessages.length;
  let contextEngineProjection: CodexContextEngineThreadBootstrapProjection | undefined;
  const resetCodexPromptInputs = () => {
    promptText = params.prompt;
    developerInstructions = baseDeveloperInstructions;
    prePromptMessageCount = historyMessages.length;
    contextEngineProjection = undefined;
  };
  const applyActiveContextEngineProjection = async (
    decisionStartupBinding: CodexAppServerThreadBinding | undefined,
  ) => {
    if (!activeContextEngine) {
      return;
    }
    const assembled = await assembleHarnessContextEngine({
      contextEngine: activeContextEngine,
      sessionId: activeSessionId,
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
    contextEngineProjection = readContextEngineThreadBootstrapProjection(
      assembled.contextProjection,
    );
    const projection = projectContextEngineAssemblyForCodex({
      assembledMessages: assembled.messages,
      originalHistoryMessages: historyMessages,
      prompt: params.prompt,
      systemPromptAddition: assembled.systemPromptAddition,
      maxRenderedContextChars: resolveCodexContextEngineProjectionMaxChars({
        contextTokenBudget: params.contextTokenBudget,
        reserveTokens: resolveCodexContextEngineProjectionReserveTokens({
          config: params.config,
        }),
      }),
      toolPayloadMode: contextEngineProjection ? "preserve" : "elide",
    });
    const projectionDecision = contextEngineProjection
      ? resolveContextEngineBootstrapProjectionDecision({
          startupBinding: decisionStartupBinding,
          expectedBinding: buildContextEngineBinding(
            buildActiveRunAttemptParams(),
            contextEngineProjection,
          ),
          projection: contextEngineProjection,
          dynamicToolsFingerprint: codexDynamicToolsFingerprint(toolBridge.specs),
        })
      : { project: true, reason: "per-turn-projection" };
    embeddedAgentLog.info("codex app-server context-engine projection decision", {
      sessionId: params.sessionId,
      sessionKey: sandboxSessionKey,
      engineId: activeContextEngine.info.id,
      mode: contextEngineProjection?.mode ?? assembled.contextProjection?.mode ?? "per_turn",
      epoch: contextEngineProjection?.epoch,
      fingerprint: contextEngineProjection?.fingerprint,
      previousThreadId: decisionStartupBinding?.threadId,
      previousEpoch: decisionStartupBinding?.contextEngine?.projection?.epoch,
      previousFingerprint: decisionStartupBinding?.contextEngine?.projection?.fingerprint,
      projected: projectionDecision.project,
      reason: projectionDecision.reason,
      assembledMessages: assembled.messages.length,
      originalHistoryMessages: historyMessages.length,
      projectedPromptChars: projection.promptText.length,
      developerInstructionAdditionChars: projection.developerInstructionAddition?.length ?? 0,
    });
    promptText = projectionDecision.project ? projection.promptText : params.prompt;
    developerInstructions = joinPresentSections(
      baseDeveloperInstructions,
      projection.developerInstructionAddition,
    );
    prePromptMessageCount = projection.prePromptMessageCount;
  };
  if (activeContextEngine) {
    try {
      await applyActiveContextEngineProjection(startupBinding);
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
  const buildPromptFromCurrentInputs = () =>
    resolveAgentHarnessBeforePromptBuildResult({
      prompt: prependCurrentInboundContext(promptText, params.currentInboundContext),
      developerInstructions,
      messages: historyMessages,
      ctx: hookContext,
    });
  let promptBuild = await buildPromptFromCurrentInputs();
  const decorateCodexTurnPromptText = (prompt: string) =>
    prependCodexOpenClawPromptContext(prompt, openClawPromptContext);
  let codexTurnPromptText = decorateCodexTurnPromptText(promptBuild.prompt);
  const refreshCodexTurnPromptText = () => {
    codexTurnPromptText = decorateCodexTurnPromptText(promptBuild.prompt);
  };
  const systemPromptReport = buildCodexSystemPromptReport({
    attempt: params,
    sessionKey: sandboxSessionKey,
    workspaceDir: effectiveWorkspace,
    developerInstructions: promptBuild.developerInstructions,
    workspaceBootstrapContext,
    skillsPrompt: openClawPromptContext ? (params.skillsSnapshot?.prompt ?? "") : "",
    tools: toolBridge.specs,
  });
  const trajectoryRecorder = createCodexTrajectoryRecorder({
    attempt: params,
    cwd: effectiveWorkspace,
    developerInstructions: promptBuild.developerInstructions,
    prompt: codexTurnPromptText,
    tools: toolBridge.specs,
  });
  let client: CodexAppServerClient;
  let thread: CodexAppServerThreadLifecycleBinding;
  let trajectoryEndRecorded = false;
  let nativeHookRelay: NativeHookRelayRegistrationHandle | undefined;
  let startupClientForCleanup: CodexAppServerClient | undefined;
  let restartContextEngineCodexThread:
    | (() => Promise<CodexAppServerThreadLifecycleBinding>)
    | undefined;
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
      channelId: hookChannelId,
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
    const threadConfig = mergeCodexThreadConfigs(
      bundleMcpThreadConfig?.configPatch as JsonObject | undefined,
    );
    const nativeToolSurfaceRestricted = !nativeToolSurfaceEnabled;
    const pluginThreadConfigRequired =
      nativeToolSurfaceRestricted || shouldBuildCodexPluginThreadConfig(pluginConfig);
    // Restricted runs still need a plugin thread config so thread/start
    // carries the explicit apps._default denial patch without app/list.
    const pluginThreadConfigPluginConfig = nativeToolSurfaceEnabled
      ? pluginConfig
      : disableCodexPluginThreadConfig(pluginConfig);
    const pluginAppCacheKeyInput = {
      appServer,
      agentDir,
      authProfileId: startupAuthProfileId,
      accountId: startupAuthAccountCacheKey,
      envApiKeyFingerprint: startupEnvApiKeyCacheKey,
    };
    const pluginAppCacheKey = buildCodexPluginAppCacheKey(pluginAppCacheKeyInput);
    const pluginThreadConfigInputFingerprint = pluginThreadConfigRequired
      ? buildCodexPluginThreadConfigInputFingerprint({
          pluginConfig: pluginThreadConfigPluginConfig,
          appCacheKey: pluginAppCacheKey,
        })
      : undefined;
    const resolvedPluginPolicy = pluginThreadConfigRequired
      ? resolveCodexPluginsPolicy(pluginThreadConfigPluginConfig)
      : undefined;
    const computerUseMcpElicitationDelegationRequired = computerUseConfig.enabled;
    const mcpElicitationDelegationRequired =
      resolvedPluginPolicy?.enabled === true || computerUseMcpElicitationDelegationRequired;
    const enabledPluginConfigKeys = resolvedPluginPolicy
      ? resolvedPluginPolicy.pluginPolicies
          .filter((plugin) => plugin.enabled)
          .map((plugin) => plugin.configKey)
          .toSorted()
      : undefined;
    embeddedAgentLog.info(
      "codex plugin thread config eligibility",
      buildCodexPluginThreadConfigEligibilityLogData({
        sessionId: params.sessionId,
        sessionKey: sandboxSessionKey,
        pluginThreadConfigRequired,
        resolvedPluginPolicy,
        enabledPluginConfigKeys,
        pluginAppCacheKey,
        startupAuthProfileId,
        appServer,
      }),
    );
    pluginAppServer = mcpElicitationDelegationRequired
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
            pluginConfig,
            timeoutMs: appServer.requestTimeoutMs,
            signal: runAbortController.signal,
          });
          const buildThreadLifecycleParams = () =>
            ({
              client: startupClient,
              params: buildActiveRunAttemptParams(),
              agentId: sessionAgentId,
              cwd: effectiveWorkspace,
              dynamicTools: toolBridge.specs,
              appServer: pluginAppServer,
              developerInstructions: promptBuild.developerInstructions,
              config: threadConfig,
              finalConfigPatch: nativeHookRelayConfig,
              nativeCodeModeEnabled: nativeToolSurfaceEnabled,
              nativeCodeModeOnlyEnabled: appServer.codeModeOnly,
              userMcpServersEnabled: nativeToolSurfaceEnabled,
              mcpServersFingerprint: bundleMcpThreadConfig.fingerprint,
              mcpServersFingerprintEvaluated: bundleMcpThreadConfig.evaluated,
              contextEngineProjection,
              pluginThreadConfig: pluginThreadConfigRequired
                ? {
                    enabled: true,
                    inputFingerprint: pluginThreadConfigInputFingerprint,
                    enabledPluginConfigKeys,
                    build: () =>
                      buildCodexPluginThreadConfig({
                        pluginConfig: pluginThreadConfigPluginConfig,
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
            }) satisfies Parameters<typeof startOrResumeThread>[0];
          restartContextEngineCodexThread = () => startOrResumeThread(buildThreadLifecycleParams());
          const startupThread = await startOrResumeThread(buildThreadLifecycleParams());
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
    prompt: codexTurnPromptText,
    tools: toolBridge.specs,
  });

  let projector: CodexAppServerEventProjector | undefined;
  let turnId: string | undefined;
  const pendingNotifications: CodexServerNotification[] = [];
  let userInputBridge: ReturnType<typeof createCodexUserInputBridge> | undefined;
  let steeringQueue: ReturnType<typeof createCodexSteeringQueue> | undefined;
  let completed = false;
  let terminalTurnNotificationQueued = false;
  let timedOut = false;
  let turnCompletionIdleTimedOut = false;
  let turnCompletionIdleTimeoutMessage: string | undefined;
  let clientClosedPromptError: string | undefined;
  let clientClosedAbort = false;
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
  const turnAssistantCompletionIdleTimeoutMs = resolveCodexTurnAssistantCompletionIdleTimeoutMs(
    options.turnAssistantCompletionIdleTimeoutMs,
  );
  const turnTerminalIdleTimeoutMs = resolveCodexTurnTerminalIdleTimeoutMs(
    options.turnTerminalIdleTimeoutMs,
  );
  let turnCompletionIdleTimer: ReturnType<typeof setTimeout> | undefined;
  let turnCompletionIdleWatchArmed = false;
  let turnCompletionIdleWatchPinnedByTerminalError = false;
  let turnCompletionIdleTimeoutOverrideMs: number | undefined;
  let turnAssistantCompletionIdleTimer: ReturnType<typeof setTimeout> | undefined;
  let turnAssistantCompletionIdleWatchArmed = false;
  let turnAssistantCompletionLastActivityAt = Date.now();
  let turnAssistantCompletionLastActivityDetails: Record<string, unknown> | undefined;
  const turnAttemptIdleTimeoutMs = Math.max(100, Math.floor(params.timeoutMs));
  let turnAttemptIdleTimer: ReturnType<typeof setTimeout> | undefined;
  let turnAttemptIdleWatchArmed = false;
  let turnTerminalIdleTimer: ReturnType<typeof setTimeout> | undefined;
  let turnTerminalIdleWatchArmed = false;
  let turnCompletionLastActivityAt = Date.now();
  let turnCompletionLastActivityReason = "startup";
  let turnCompletionLastActivityDetails: Record<string, unknown> | undefined;
  let turnAttemptLastProgressAt = Date.now();
  let turnAttemptLastProgressReason = "startup";
  let turnAttemptLastProgressDetails: Record<string, unknown> | undefined;
  let nativeHookRelayLastRenewedAt = 0;
  let activeAppServerTurnRequests = 0;
  const pendingOpenClawDynamicToolCompletionIds = new Set<string>();
  const activeTurnItemIds = new Set<string>();
  let turnCrossedToolHandoff = false;

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

  const clearTurnAssistantCompletionIdleTimer = () => {
    if (turnAssistantCompletionIdleTimer) {
      clearTimeout(turnAssistantCompletionIdleTimer);
      turnAssistantCompletionIdleTimer = undefined;
    }
  };

  const clearTurnAttemptIdleTimer = () => {
    if (turnAttemptIdleTimer) {
      clearTimeout(turnAttemptIdleTimer);
      turnAttemptIdleTimer = undefined;
    }
  };

  const fireTurnAssistantCompletionIdleRelease = () => {
    if (completed || runAbortController.signal.aborted || !turnAssistantCompletionIdleWatchArmed) {
      return;
    }
    if (activeAppServerTurnRequests > 0 || activeTurnItemIds.size > 0) {
      scheduleTurnAssistantCompletionIdleWatch();
      return;
    }
    const idleMs = Math.max(0, Date.now() - turnAssistantCompletionLastActivityAt);
    if (idleMs < turnAssistantCompletionIdleTimeoutMs) {
      scheduleTurnAssistantCompletionIdleWatch();
      return;
    }
    turnAssistantCompletionIdleWatchArmed = false;
    clearTurnCompletionIdleTimer();
    clearTurnTerminalIdleTimer();
    trajectoryRecorder?.recordEvent("turn.assistant_completion_idle_release", {
      threadId: thread.threadId,
      turnId,
      idleMs,
      timeoutMs: turnAssistantCompletionIdleTimeoutMs,
      ...turnAssistantCompletionLastActivityDetails,
    });
    embeddedAgentLog.warn(
      "codex app-server turn released after completed assistant item without terminal event",
      {
        threadId: thread.threadId,
        turnId,
        idleMs,
        timeoutMs: turnAssistantCompletionIdleTimeoutMs,
        ...turnAssistantCompletionLastActivityDetails,
      },
    );
    if (turnId) {
      interruptCodexTurnBestEffort(client, {
        threadId: thread.threadId,
        turnId,
        timeoutMs: CODEX_APP_SERVER_INTERRUPT_TIMEOUT_MS,
      });
    }
    completed = true;
    resolveCompletion?.();
  };

  const fireTurnAttemptIdleTimeout = () => {
    if (completed || runAbortController.signal.aborted || !turnAttemptIdleWatchArmed) {
      return;
    }
    const idleMs = Math.max(0, Date.now() - turnAttemptLastProgressAt);
    if (idleMs < turnAttemptIdleTimeoutMs) {
      scheduleTurnAttemptIdleWatch();
      return;
    }
    timedOut = true;
    turnCompletionIdleTimedOut = true;
    turnCompletionIdleTimeoutMessage =
      "codex app-server turn idle timed out waiting for turn/completed";
    projector?.markTimedOut();
    trajectoryRecorder?.recordEvent("turn.progress_idle_timeout", {
      threadId: thread.threadId,
      turnId,
      idleMs,
      timeoutMs: turnAttemptIdleTimeoutMs,
      lastActivityReason: turnAttemptLastProgressReason,
      ...turnAttemptLastProgressDetails,
    });
    embeddedAgentLog.warn("codex app-server turn idle timed out waiting for progress", {
      threadId: thread.threadId,
      turnId,
      idleMs,
      timeoutMs: turnAttemptIdleTimeoutMs,
      lastActivityReason: turnAttemptLastProgressReason,
      ...turnAttemptLastProgressDetails,
    });
    runAbortController.abort("turn_progress_idle_timeout");
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
    const timeoutMs = turnCompletionIdleTimeoutOverrideMs ?? turnCompletionIdleTimeoutMs;
    const idleMs = Math.max(0, Date.now() - turnCompletionLastActivityAt);
    if (idleMs < timeoutMs) {
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
      timeoutMs,
      lastActivityReason: turnCompletionLastActivityReason,
      ...turnCompletionLastActivityDetails,
    });
    embeddedAgentLog.warn("codex app-server turn idle timed out waiting for completion", {
      threadId: thread.threadId,
      turnId,
      idleMs,
      timeoutMs,
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
    const timeoutMs = turnCompletionIdleTimeoutOverrideMs ?? turnCompletionIdleTimeoutMs;
    const delayMs = Math.max(1, timeoutMs - elapsedMs);
    turnCompletionIdleTimer = setTimeout(fireTurnCompletionIdleTimeout, delayMs);
    turnCompletionIdleTimer.unref?.();
  }

  function scheduleTurnAssistantCompletionIdleWatch() {
    clearTurnAssistantCompletionIdleTimer();
    if (completed || runAbortController.signal.aborted || !turnAssistantCompletionIdleWatchArmed) {
      return;
    }
    const elapsedMs = Math.max(0, Date.now() - turnAssistantCompletionLastActivityAt);
    const delayMs = Math.max(1, turnAssistantCompletionIdleTimeoutMs - elapsedMs);
    turnAssistantCompletionIdleTimer = setTimeout(fireTurnAssistantCompletionIdleRelease, delayMs);
    turnAssistantCompletionIdleTimer.unref?.();
  }

  function scheduleTurnAttemptIdleWatch() {
    clearTurnAttemptIdleTimer();
    if (completed || runAbortController.signal.aborted || !turnAttemptIdleWatchArmed) {
      return;
    }
    const elapsedMs = Math.max(0, Date.now() - turnAttemptLastProgressAt);
    const delayMs = Math.max(1, turnAttemptIdleTimeoutMs - elapsedMs);
    turnAttemptIdleTimer = setTimeout(fireTurnAttemptIdleTimeout, delayMs);
    turnAttemptIdleTimer.unref?.();
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

  function scheduleTurnProgressWatches() {
    scheduleTurnAttemptIdleWatch();
    scheduleTurnCompletionIdleWatch();
    scheduleTurnTerminalIdleWatch();
  }

  const renewNativeHookRelayForTurnProgress = () => {
    if (!nativeHookRelay || options.nativeHookRelay?.ttlMs !== undefined) {
      return;
    }
    const now = Date.now();
    const renewsRecently =
      now - nativeHookRelayLastRenewedAt < CODEX_NATIVE_HOOK_RELAY_RENEW_INTERVAL_MS;
    const expiresSoon = now >= nativeHookRelay.expiresAtMs - CODEX_NATIVE_HOOK_RELAY_TTL_GRACE_MS;
    if (renewsRecently && !expiresSoon) {
      return;
    }
    nativeHookRelayLastRenewedAt = now;
    nativeHookRelay.renew(
      resolveCodexNativeHookRelayTtlMs({
        explicitTtlMs: undefined,
        attemptTimeoutMs: turnAttemptIdleTimeoutMs,
        startupTimeoutMs,
        turnStartTimeoutMs: params.timeoutMs,
      }),
    );
  };

  const touchTurnCompletionActivity = (
    reason: string,
    options?: { arm?: boolean; details?: Record<string, unknown>; attemptProgress?: boolean },
  ) => {
    turnCompletionLastActivityAt = Date.now();
    turnCompletionLastActivityReason = reason;
    turnCompletionLastActivityDetails = options?.details;
    turnCompletionIdleTimeoutOverrideMs = undefined;
    if (options?.attemptProgress) {
      turnAttemptLastProgressAt = turnCompletionLastActivityAt;
      turnAttemptLastProgressReason = reason;
      turnAttemptLastProgressDetails = options.details;
      renewNativeHookRelayForTurnProgress();
      params.onRunProgress?.({
        reason,
        provider: params.provider,
        model: params.modelId,
        backend: "codex-app-server",
      });
    }
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
    scheduleTurnProgressWatches();
  };

  const disarmTurnCompletionIdleWatch = () => {
    turnCompletionIdleWatchArmed = false;
    turnCompletionIdleWatchPinnedByTerminalError = false;
    turnCompletionIdleTimeoutOverrideMs = undefined;
    clearTurnCompletionIdleTimer();
  };

  const disarmTurnAssistantCompletionIdleWatch = () => {
    turnAssistantCompletionIdleWatchArmed = false;
    turnAssistantCompletionLastActivityDetails = undefined;
    clearTurnAssistantCompletionIdleTimer();
  };

  const armTurnAssistantCompletionIdleWatch = (details?: Record<string, unknown>) => {
    turnAssistantCompletionIdleWatchArmed = true;
    turnAssistantCompletionLastActivityAt = Date.now();
    turnAssistantCompletionLastActivityDetails = details;
    scheduleTurnAssistantCompletionIdleWatch();
  };

  const armTurnCompletionIdleWatch = (options?: {
    pinnedByTerminalError?: boolean;
    timeoutMs?: number;
  }) => {
    turnCompletionIdleWatchArmed = true;
    turnCompletionIdleWatchPinnedByTerminalError = options?.pinnedByTerminalError === true;
    turnCompletionIdleTimeoutOverrideMs =
      options?.timeoutMs !== undefined ? Math.max(1, Math.floor(options.timeoutMs)) : undefined;
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

  const executionPhaseKeys = new Set<string>();
  const emitExecutionPhaseOnce = (
    key: string,
    info: Parameters<NonNullable<EmbeddedRunAttemptParams["onExecutionPhase"]>>[0],
  ) => {
    if (executionPhaseKeys.has(key)) {
      return;
    }
    executionPhaseKeys.add(key);
    params.onExecutionPhase?.({
      provider: params.provider,
      model: params.modelId,
      backend: "codex-app-server",
      ...info,
    });
  };
  const reportCodexExecutionNotification = (notification: CodexServerNotification) => {
    if (notification.method === "turn/started") {
      emitExecutionPhaseOnce("turn_accepted", { phase: "turn_accepted" });
      return;
    }
    if (notification.method === "item/agentMessage/delta") {
      emitExecutionPhaseOnce("assistant_output_started", { phase: "assistant_output_started" });
      return;
    }
    if (notification.method !== "item/started") {
      return;
    }
    const item = readCodexNotificationItem(notification.params);
    const tool = item ? codexExecutionToolName(item) : undefined;
    if (!item || !tool) {
      return;
    }
    emitExecutionPhaseOnce(`tool:${item.id}`, {
      phase: "tool_execution_started",
      tool,
      itemId: item.id,
    });
  };

  const isTerminalTurnNotificationForTurn = (
    notification: CodexServerNotification,
    notificationTurnId: string,
  ): boolean => {
    if (!isTurnNotification(notification.params, thread.threadId, notificationTurnId)) {
      return false;
    }
    return (
      notification.method === "turn/completed" ||
      isCodexTurnAbortMarkerNotification(notification, {
        currentPromptTexts: [codexTurnPromptText],
      })
    );
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
    const isTurnCompletion = notification.method === "turn/completed" && isCurrentTurnNotification;
    if (isCurrentTurnNotification) {
      touchTurnCompletionActivity(`notification:${notification.method}`, {
        details: describeNotificationActivity(notification),
        attemptProgress: true,
      });
      reportCodexExecutionNotification(notification);
    }
    if (isCurrentTurnNotification) {
      updateActiveTurnItemIds(notification, activeTurnItemIds);
    }
    const unblockedAssistantCompletionRelease =
      isCurrentTurnNotification &&
      turnAssistantCompletionIdleWatchArmed &&
      notification.method === "item/completed" &&
      activeTurnItemIds.size === 0;
    const trackedDynamicToolCompletion = isPendingOpenClawDynamicToolCompletionNotification(
      notification,
      pendingOpenClawDynamicToolCompletionIds,
    );
    const rawToolOutputCompletion = isRawToolOutputCompletionNotification(notification);
    if (
      isCurrentTurnNotification &&
      (rawToolOutputCompletion || isNativeToolProgressNotification(notification))
    ) {
      turnCrossedToolHandoff = true;
    }
    const assistantCompletionCanRelease = isAssistantCompletionReleaseNotification(
      notification,
      turnCrossedToolHandoff,
    );
    const postToolRawAssistantCompletionNeedsTerminalGuard =
      isCurrentTurnNotification &&
      turnCrossedToolHandoff &&
      isRawAssistantCompletionNotification(notification) &&
      activeTurnItemIds.size === 0;
    const shouldRearmCompletionIdleWatchAfterLastCurrentTurnItem =
      isCurrentTurnNotification &&
      notification.method === "item/completed" &&
      activeTurnItemIds.size === 0 &&
      !trackedDynamicToolCompletion &&
      !assistantCompletionCanRelease;
    if (isCurrentTurnNotification && notification.method === "error") {
      if (isRetryableErrorNotification(notification.params)) {
        disarmTurnCompletionIdleWatch();
      } else {
        armTurnCompletionIdleWatch({ pinnedByTerminalError: true });
      }
      disarmTurnAssistantCompletionIdleWatch();
    } else if (isTurnCompletion) {
      disarmTurnAssistantCompletionIdleWatch();
    } else if (isCurrentTurnNotification && assistantCompletionCanRelease) {
      armTurnAssistantCompletionIdleWatch(describeNotificationActivity(notification));
    } else if (postToolRawAssistantCompletionNeedsTerminalGuard) {
      armTurnCompletionIdleWatch({ timeoutMs: turnAssistantCompletionIdleTimeoutMs });
    } else if (unblockedAssistantCompletionRelease) {
      armTurnAssistantCompletionIdleWatch(describeNotificationActivity(notification));
    } else if (shouldRearmCompletionIdleWatchAfterLastCurrentTurnItem) {
      // If a non-assistant current-turn item is the last active item and the
      // bridge then goes quiet, reset the short completion-idle guard from that
      // final completion so the remaining silent-turn gap fails fast.
      armTurnCompletionIdleWatch();
    } else if (isCurrentTurnNotification && rawToolOutputCompletion) {
      // Raw OpenAI response streams can report the tool-output handoff without
      // a matching app-server `item/completed`; keep the post-tool guard alive.
      armTurnCompletionIdleWatch();
    } else if (
      isCurrentTurnNotification &&
      shouldDisarmAssistantCompletionIdleWatch(notification)
    ) {
      disarmTurnAssistantCompletionIdleWatch();
    }
    if (
      turnCompletionIdleWatchArmed &&
      !turnCompletionIdleWatchPinnedByTerminalError &&
      notification.method !== "turn/completed" &&
      isCurrentTurnNotification &&
      !trackedDynamicToolCompletion &&
      !rawToolOutputCompletion &&
      !postToolRawAssistantCompletionNeedsTerminalGuard &&
      !shouldRearmCompletionIdleWatchAfterLastCurrentTurnItem
    ) {
      // The short completion-idle watchdog guards blind gaps after Codex
      // accepts a turn or after OpenClaw hands a turn-scoped request result
      // back to Codex. Bookkeeping that closes the just-served OpenClaw
      // dynamic tool item is still part of that handoff, so keep the short
      // watchdog armed for that notification.
      disarmTurnCompletionIdleWatch();
    }
    if (trackedDynamicToolCompletion) {
      const itemId = readNotificationItemId(notification);
      if (itemId) {
        pendingOpenClawDynamicToolCompletionIds.delete(itemId);
      }
    }
    // Determine terminal-turn status before invoking the projector so a throw
    // inside projector.handleNotification still releases the session lane.
    // See openclaw/openclaw#67996.
    const isTurnAbortMarker =
      isCurrentTurnNotification &&
      isCodexTurnAbortMarkerNotification(notification, {
        currentPromptTexts: [codexTurnPromptText],
      });
    const isTurnTerminal = isTerminalTurnNotificationForTurn(notification, turnId);
    if (isTurnTerminal) {
      terminalTurnNotificationQueued = true;
    }
    try {
      await waitForCodexNotificationDispatchTurn();
      await projector.handleNotification(notification);
    } catch (error) {
      embeddedAgentLog.debug("codex app-server projector notification threw", {
        method: notification.method,
        error,
      });
    } finally {
      if (isTurnTerminal) {
        if (isTurnAbortMarker) {
          projector.markAborted();
        }
        if (!timedOut && !runAbortController.signal.aborted) {
          await steeringQueue?.flushPending();
        }
        completed = true;
        clearTurnCompletionIdleTimer();
        clearTurnAssistantCompletionIdleTimer();
        clearTurnTerminalIdleTimer();
        resolveCompletion?.();
      }
    }
  };
  const enqueueNotification = (notification: CodexServerNotification): Promise<void> => {
    if (!projector || !turnId) {
      userInputBridge?.handleNotification(notification);
      pendingNotifications.push(notification);
      return Promise.resolve();
    }
    if (isTerminalTurnNotificationForTurn(notification, turnId)) {
      terminalTurnNotificationQueued = true;
    }
    notificationQueue = notificationQueue.then(
      () => handleNotification(notification),
      () => handleNotification(notification),
    );
    return notificationQueue;
  };

  const notificationCleanup = client.addNotificationHandler(enqueueNotification);
  const requestCleanup = client.addRequestHandler(async (request) => {
    let armCompletionWatchOnResponse = false;
    let requestCountsAsTurnActivity = false;
    const markCurrentTurnRequestProgress = () => {
      activeAppServerTurnRequests += 1;
      clearTurnCompletionIdleTimer();
      disarmTurnAssistantCompletionIdleWatch();
      requestCountsAsTurnActivity = true;
      touchTurnCompletionActivity(`request:${request.method}:start`, {
        attemptProgress: true,
      });
    };
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
        if (isCurrentThreadOptionalTurnRequestParams(request.params, thread.threadId, turnId)) {
          armCompletionWatchOnResponse = true;
          markCurrentTurnRequestProgress();
        }
        return handleCodexAppServerElicitationRequest({
          requestParams: request.params,
          paramsForRun: params,
          threadId: thread.threadId,
          turnId,
          pluginAppPolicyContext: thread.pluginAppPolicyContext,
          ...(computerUseConfig.enabled
            ? { computerUseMcpServerName: computerUseConfig.mcpServerName }
            : {}),
          signal: runAbortController.signal,
        });
      }
      if (request.method === "item/tool/requestUserInput") {
        if (isCurrentThreadTurnRequestParams(request.params, thread.threadId, turnId)) {
          armCompletionWatchOnResponse = true;
          markCurrentTurnRequestProgress();
        }
        return userInputBridge?.handleRequest({
          id: request.id,
          params: request.params,
        });
      }
      if (request.method !== "item/tool/call") {
        if (isCodexAppServerApprovalRequest(request.method)) {
          if (isCurrentApprovalTurnRequestParams(request.params, thread.threadId, turnId)) {
            armCompletionWatchOnResponse = true;
            markCurrentTurnRequestProgress();
          }
          return handleApprovalRequest({
            method: request.method,
            params: request.params,
            paramsForRun: params,
            threadId: thread.threadId,
            turnId,
            nativeHookRelay,
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
      markCurrentTurnRequestProgress();
      turnCrossedToolHandoff = true;
      pendingOpenClawDynamicToolCompletionIds.add(call.callId);
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
      emitExecutionPhaseOnce(`tool:${call.callId}`, {
        phase: "tool_execution_started",
        tool: call.tool,
        toolCallId: call.callId,
      });
      emitDynamicToolStartedDiagnostic({
        call,
        runId: params.runId,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
      });
      const toolProgressDetailMode = resolveCodexToolProgressDetailMode(params.toolProgressDetail);
      const toolMeta = inferCodexDynamicToolMeta(call, toolProgressDetailMode);
      const toolArgs = sanitizeCodexToolArguments(call.arguments);
      const shouldEmitDynamicToolProgress = shouldEmitTranscriptToolProgress(call.tool, toolArgs);
      if (shouldEmitDynamicToolProgress) {
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
      }
      const dynamicToolTimeoutMs = resolveDynamicToolCallTimeoutMs({
        call,
        config: params.config,
      });
      const toolStartedAt = Date.now();
      let terminalDiagnosticObserved = false;
      const unsubscribeToolDiagnosticObserver = onInternalDiagnosticEvent((event) => {
        if (isDynamicToolTerminalDiagnosticEvent(event)) {
          if (
            isMatchingDynamicToolTerminalDiagnostic({
              event,
              call,
              runId: params.runId,
              sessionId: params.sessionId,
              sessionKey: params.sessionKey,
            })
          ) {
            terminalDiagnosticObserved = true;
          }
        }
      });
      try {
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
        const protocolResponse = toCodexDynamicToolProtocolResponse(response);
        trajectoryRecorder?.recordEvent("tool.result", {
          threadId: call.threadId,
          turnId: call.turnId,
          toolCallId: call.callId,
          name: call.tool,
          success: protocolResponse.success,
          contentItems: protocolResponse.contentItems,
        });
        projector?.recordDynamicToolResult({
          callId: call.callId,
          tool: call.tool,
          success: protocolResponse.success,
          contentItems: protocolResponse.contentItems,
        });
        if (shouldEmitDynamicToolProgress) {
          emitCodexAppServerEvent(params, {
            stream: "tool",
            data: {
              phase: "result",
              name: call.tool,
              toolCallId: call.callId,
              ...(toolMeta ? { meta: toolMeta } : {}),
              isError: !protocolResponse.success,
              result: sanitizeCodexToolResponse(protocolResponse),
            },
          });
        }
        if (
          !terminalDiagnosticObserved &&
          !hasPendingDynamicToolTerminalDiagnostic({
            call,
            runId: params.runId,
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
          })
        ) {
          emitDynamicToolTerminalDiagnostic({
            response,
            call,
            runId: params.runId,
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
            durationMs: Math.max(0, Date.now() - toolStartedAt),
          });
        }
        return protocolResponse as JsonValue;
      } catch (error) {
        if (
          !terminalDiagnosticObserved &&
          !hasPendingDynamicToolTerminalDiagnostic({
            call,
            runId: params.runId,
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
          })
        ) {
          emitDynamicToolErrorDiagnostic({
            call,
            runId: params.runId,
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
            durationMs: Math.max(0, Date.now() - toolStartedAt),
          });
        }
        throw error;
      } finally {
        unsubscribeToolDiagnosticObserver();
      }
    } finally {
      if (requestCountsAsTurnActivity) {
        activeAppServerTurnRequests = Math.max(0, activeAppServerTurnRequests - 1);
        touchTurnCompletionActivity(`request:${request.method}:response`, {
          arm: armCompletionWatchOnResponse,
          attemptProgress: true,
        });
      } else {
        scheduleTurnProgressWatches();
      }
    }
  });
  let closeCleanup: (() => void) | undefined;

  const forceContextEngineCompactionForCodexOverflow = async (error: unknown): Promise<boolean> => {
    if (!activeContextEngine?.info.ownsCompaction) {
      return false;
    }
    embeddedAgentLog.warn(
      "codex app-server context-engine turn overflowed; forcing context-engine compaction",
      {
        sessionId: activeSessionId,
        sessionKey: sandboxSessionKey,
        threadId: thread.threadId,
        engineId: activeContextEngine.info.id,
        tokenBudget: params.contextTokenBudget,
        error: formatErrorMessage(error),
      },
    );
    try {
      const runtimeContext = buildActiveContextEngineRuntimeContext();
      const overflowTokenCount = params.contextTokenBudget ?? params.contextWindowInfo?.tokens;
      // Bound the plugin-owned compaction with the same finite safety timeout
      // that protects native runtime compaction, and thread the run-level
      // abort signal through, so a slow/hung plugin compact() cannot stall
      // Codex overflow recovery indefinitely. A timeout/abort surfaces as a
      // thrown error handled by the catch below.
      const compactResult = await compactContextEngineWithSafetyTimeout(
        activeContextEngine,
        {
          sessionId: activeSessionId,
          sessionKey: sandboxSessionKey,
          sessionFile: activeSessionFile,
          tokenBudget: params.contextTokenBudget,
          force: true,
          ...(overflowTokenCount ? { currentTokenCount: overflowTokenCount } : {}),
          compactionTarget: "threshold",
          runtimeContext: overflowTokenCount
            ? {
                ...runtimeContext,
                currentTokenCount: overflowTokenCount,
              }
            : runtimeContext,
        },
        resolveCompactionTimeoutMs(params.config),
        runAbortController.signal,
      );
      embeddedAgentLog.info("codex app-server context-engine forced compaction result", {
        sessionId: activeSessionId,
        sessionKey: sandboxSessionKey,
        engineId: activeContextEngine.info.id,
        ok: compactResult.ok,
        compacted: compactResult.compacted,
        reason: compactResult.reason,
        tokensBefore: compactResult.result?.tokensBefore,
        tokensAfter: compactResult.result?.tokensAfter,
      });
      if (!compactResult.ok || !compactResult.compacted) {
        return false;
      }
      adoptContextEngineCompactionTranscript(compactResult);
      const maintenanceRuntimeContext = buildActiveContextEngineRuntimeContext();
      await runHarnessContextEngineMaintenance({
        contextEngine: activeContextEngine,
        sessionId: activeSessionId,
        sessionKey: sandboxSessionKey,
        sessionFile: activeSessionFile,
        reason: "compaction",
        runtimeContext: maintenanceRuntimeContext,
        config: params.config,
      });
      return true;
    } catch (compactErr) {
      embeddedAgentLog.warn("codex app-server context-engine forced compaction failed", {
        sessionId: params.sessionId,
        sessionKey: sandboxSessionKey,
        engineId: activeContextEngine.info.id,
        error: formatErrorMessage(compactErr),
      });
      return false;
    }
  };
  const rebuildPromptAfterContextEngineCompaction = async () => {
    historyMessages =
      (await readMirroredSessionHistoryMessages(activeSessionFile)) ?? historyMessages;
    resetCodexPromptInputs();
    try {
      await applyActiveContextEngineProjection(undefined);
    } catch (assembleErr) {
      embeddedAgentLog.warn(
        "context engine assemble failed after forced compaction; using Codex baseline prompt",
        {
          error: formatErrorMessage(assembleErr),
        },
      );
    }
    promptBuild = await buildPromptFromCurrentInputs();
    refreshCodexTurnPromptText();
  };
  const buildLlmInputEvent = () => ({
    runId: params.runId,
    sessionId: params.sessionId,
    provider: params.provider,
    model: params.modelId,
    systemPrompt: promptBuild.developerInstructions,
    prompt: codexTurnPromptText,
    historyMessages,
    imagesCount: params.images?.length ?? 0,
  });
  const buildTurnStartFailureMessages = () => [
    ...historyMessages,
    buildCodexUserPromptMessage({ ...params, prompt: codexTurnPromptText }),
  ];

  let turn: CodexTurnStartResponse | undefined;
  const startCodexTurn = async (): Promise<CodexTurnStartResponse> =>
    assertCodexTurnStartResponse(
      await client.request(
        "turn/start",
        buildTurnStartParams(params, {
          threadId: thread.threadId,
          cwd: effectiveWorkspace,
          appServer: pluginAppServer,
          promptText: codexTurnPromptText,
          sandboxPolicy: codexSandboxPolicy,
          heartbeatCollaborationInstructions:
            workspaceBootstrapContext.heartbeatCollaborationInstructions,
        }),
        { timeoutMs: params.timeoutMs, signal: runAbortController.signal },
      ),
    );
  try {
    runAgentHarnessLlmInputHook({
      event: buildLlmInputEvent(),
      ctx: hookContext,
    });
    emitCodexAppServerEvent(params, {
      stream: "codex_app_server.lifecycle",
      data: { phase: "turn_starting", threadId: thread.threadId },
    });
    turn = await startCodexTurn();
  } catch (error) {
    let turnStartError = error;
    if (
      shouldRetryContextEngineTurnOnFreshCodexThread({
        error: turnStartError,
        contextEngineActive: Boolean(activeContextEngine),
        thread,
      }) &&
      restartContextEngineCodexThread
    ) {
      embeddedAgentLog.warn(
        "codex app-server context-engine turn overflowed on resume; retrying with fresh thread",
        {
          threadId: thread.threadId,
          error: formatErrorMessage(turnStartError),
        },
      );
      const preRetrySessionFile = activeSessionFile;
      const compactedForRetry = await forceContextEngineCompactionForCodexOverflow(turnStartError);
      await clearCodexAppServerBinding(preRetrySessionFile);
      if (activeSessionFile !== preRetrySessionFile) {
        await clearCodexAppServerBinding(activeSessionFile);
      }
      if (compactedForRetry) {
        await rebuildPromptAfterContextEngineCompaction();
      }
      thread = await restartContextEngineCodexThread();
      emitCodexAppServerEvent(params, {
        stream: "codex_app_server.lifecycle",
        data: { phase: "thread_ready_retry", threadId: thread.threadId },
      });
      try {
        turn = await startCodexTurn();
      } catch (retryError) {
        turnStartError = retryError;
      }
    }
    if (turn === undefined) {
      const usageLimitError = await formatCodexTurnStartUsageLimitError({
        client,
        error: turnStartError,
        pendingNotifications,
        timeoutMs: appServer.requestTimeoutMs,
        signal: runAbortController.signal,
      });
      const turnStartErrorMessage = usageLimitError?.message ?? formatErrorMessage(turnStartError);
      if (isInvalidCodexImagePayloadError(turnStartErrorMessage)) {
        await clearCodexBindingAfterInvalidImagePayload(activeSessionFile, {
          phase: "turn_start",
          threadId: thread.threadId,
          error: turnStartErrorMessage,
        });
      }
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
          ...hookContextWindowFields,
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
          messages: buildTurnStartFailureMessages(),
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
        await markCodexAuthProfileBlockedFromRateLimits({
          params,
          authProfileId: startupAuthProfileId,
          rateLimits: usageLimitError.rateLimitsForProfile,
        });
        return buildCodexTurnStartFailureResult({
          params,
          message: usageLimitError.message,
          messagesSnapshot: buildTurnStartFailureMessages(),
          systemPromptReport,
        });
      }
      throw turnStartError;
    }
  }
  if (!turn) {
    throw new Error("codex app-server turn/start failed without an error");
  }
  turnId = turn.turn.id;
  const activeTurnId = turn.turn.id;
  emitExecutionPhaseOnce("turn_accepted", { phase: "turn_accepted" });
  userInputBridge = createCodexUserInputBridge({
    paramsForRun: params,
    threadId: thread.threadId,
    turnId: activeTurnId,
    signal: runAbortController.signal,
  });
  trajectoryRecorder?.recordEvent("prompt.submitted", {
    threadId: thread.threadId,
    turnId: activeTurnId,
    prompt: codexTurnPromptText,
    imagesCount: params.images?.length ?? 0,
  });
  projector = new CodexAppServerEventProjector(params, thread.threadId, activeTurnId, {
    nativePostToolUseRelayEnabled:
      nativeHookRelay?.allowedEvents.includes("post_tool_use") === true &&
      nativeHookRelay.shouldRelayEvent("post_tool_use"),
    trajectoryRecorder,
  });
  if (
    isTerminalTurnStatus(turn.turn.status) ||
    pendingNotifications.some((notification) =>
      isTerminalTurnNotificationForTurn(notification, activeTurnId),
    )
  ) {
    terminalTurnNotificationQueued = true;
  }
  closeCleanup = (
    client as {
      addCloseHandler?: (handler: (client: CodexAppServerClient) => void) => () => void;
    }
  ).addCloseHandler?.(() => {
    if (completed || terminalTurnNotificationQueued || runAbortController.signal.aborted) {
      return;
    }
    clientClosedPromptError = "codex app-server client closed before turn completed";
    trajectoryRecorder?.recordEvent("turn.client_closed", {
      threadId: thread.threadId,
      turnId: activeTurnId,
    });
    embeddedAgentLog.warn("codex app-server client closed before turn completed", {
      threadId: thread.threadId,
      turnId: activeTurnId,
    });
    clientClosedAbort = true;
    runAbortController.abort("client_closed");
    completed = true;
    clearTurnAttemptIdleTimer();
    clearTurnCompletionIdleTimer();
    clearTurnAssistantCompletionIdleTimer();
    clearTurnTerminalIdleTimer();
    resolveCompletion?.();
  });
  emitLifecycleStart();
  const activeProjector = projector;
  turnTerminalIdleWatchArmed = true;
  touchTurnCompletionActivity("turn:start", { arm: true });
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
  turnAttemptIdleWatchArmed = true;
  turnTerminalIdleWatchArmed = true;
  touchTurnCompletionActivity("turn:start", { attemptProgress: true });

  const abortListener = () => {
    const shouldRetireClient = timedOut;
    interruptCodexTurnBestEffort(client, {
      threadId: thread.threadId,
      turnId: activeTurnId,
      timeoutMs: shouldRetireClient ? CODEX_APP_SERVER_INTERRUPT_TIMEOUT_MS : undefined,
    });
    if (shouldRetireClient) {
      retireCodexAppServerClientAfterTimedOutTurn(client, {
        threadId: thread.threadId,
        turnId: activeTurnId,
        reason: String(runAbortController.signal.reason ?? "timeout"),
      });
    }
    resolveCompletion?.();
  };
  runAbortController.signal.addEventListener("abort", abortListener, { once: true });
  if (runAbortController.signal.aborted) {
    abortListener();
  }

  try {
    await completion;
    const result = activeProjector.buildResult(toolBridge.telemetry, { yieldDetected });
    const finalAborted =
      result.aborted || (runAbortController.signal.aborted && !clientClosedAbort);
    let finalPromptError =
      clientClosedPromptError ??
      (turnCompletionIdleTimedOut
        ? turnCompletionIdleTimeoutMessage
        : timedOut
          ? "codex app-server attempt timed out"
          : result.promptError);
    const finalPromptErrorMessage =
      typeof finalPromptError === "string"
        ? finalPromptError
        : finalPromptError
          ? formatErrorMessage(finalPromptError)
          : undefined;
    if (isInvalidCodexImagePayloadError(finalPromptErrorMessage)) {
      await clearCodexBindingAfterInvalidImagePayload(activeSessionFile, {
        phase: "turn_completed",
        threadId: thread.threadId,
        turnId: activeTurnId,
        error: finalPromptErrorMessage,
      });
    }
    if (shouldRefreshCodexRateLimitsForUsageLimitMessage(finalPromptErrorMessage)) {
      finalPromptError = await refreshCodexUsageLimitErrorMessage({
        client,
        source: {
          message: finalPromptErrorMessage,
          codexErrorInfo: "usageLimitExceeded",
          rateLimits: readRecentCodexRateLimits(),
        },
        timeoutMs: appServer.requestTimeoutMs,
        signal: runAbortController.signal,
      });
    }
    const finalPromptErrorSource =
      timedOut || clientClosedPromptError ? "prompt" : result.promptErrorSource;
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
      const activeContextEnginePluginId = resolveContextEngineOwnerPluginId(activeContextEngine);
      const finalMessages =
        (await readMirroredSessionHistoryMessages(activeSessionFile)) ??
        historyMessages.concat(result.messagesSnapshot);
      await finalizeHarnessContextEngineTurn({
        contextEngine: activeContextEngine,
        promptError: Boolean(finalPromptError),
        aborted: finalAborted,
        yieldAborted: Boolean(result.yieldDetected),
        sessionIdUsed: activeSessionId,
        sessionKey: sandboxSessionKey,
        sessionFile: activeSessionFile,
        messagesSnapshot: finalMessages,
        prePromptMessageCount,
        tokenBudget: params.contextTokenBudget,
        runtimeContext: buildHarnessContextEngineRuntimeContextFromUsage({
          attempt: buildActiveRunAttemptParams(),
          workspaceDir: effectiveWorkspace,
          agentDir,
          activeAgentId: sessionAgentId,
          contextEnginePluginId: activeContextEnginePluginId,
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
        ...hookContextWindowFields,
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
      systemPromptReport,
    };
  } finally {
    emitLifecycleTerminal({
      phase: "error",
      error: "codex app-server run completed without lifecycle terminal event",
    });
    if (trajectoryRecorder && !trajectoryEndRecorded) {
      trajectoryRecorder.recordEvent("session.ended", {
        status:
          timedOut || (runAbortController.signal.aborted && !clientClosedAbort)
            ? "interrupted"
            : "cleanup",
        threadId: thread.threadId,
        turnId: activeTurnId,
        timedOut,
        aborted: runAbortController.signal.aborted && !clientClosedAbort,
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
    clearTurnAttemptIdleTimer();
    clearTurnCompletionIdleTimer();
    clearTurnAssistantCompletionIdleTimer();
    clearTurnTerminalIdleTimer();
    notificationCleanup();
    requestCleanup();
    closeCleanup?.();
    nativeHookRelay?.unregister();
    runAbortController.signal.removeEventListener("abort", abortListener);
    params.abortSignal?.removeEventListener("abort", abortFromUpstream);
    steeringQueue?.cancel();
    clearActiveEmbeddedRun(params.sessionId, handle, params.sessionKey);
  }
}

async function markCodexAuthProfileBlockedFromRateLimits(params: {
  params: EmbeddedRunAttemptParams;
  authProfileId?: string;
  rateLimits?: JsonValue;
}): Promise<void> {
  const authProfileId = params.authProfileId?.trim();
  if (!authProfileId || !params.params.authProfileStore) {
    return;
  }
  const blockedUntil = resolveCodexUsageLimitResetAtMs(params.rateLimits);
  if (!blockedUntil) {
    return;
  }
  try {
    await markAuthProfileBlockedUntil({
      store: params.params.authProfileStore,
      profileId: authProfileId,
      blockedUntil,
      source: "codex_rate_limits",
      agentDir: params.params.agentDir,
      runId: params.params.runId,
      modelId: params.params.modelId,
    });
  } catch (error) {
    embeddedAgentLog.debug("failed to mark Codex auth profile blocked from app-server limits", {
      authProfileId,
      error: formatErrorMessage(error),
    });
  }
}

function buildCodexTurnStartFailureResult(params: {
  params: EmbeddedRunAttemptParams;
  message: string;
  messagesSnapshot: AgentMessage[];
  systemPromptReport: ReturnType<typeof buildCodexSystemPromptReport>;
}): EmbeddedRunAttemptResult {
  return {
    aborted: false,
    externalAbort: false,
    timedOut: false,
    idleTimedOut: false,
    timedOutDuringCompaction: false,
    timedOutDuringToolExecution: false,
    promptError: params.message,
    promptErrorSource: "prompt",
    sessionIdUsed: params.params.sessionId,
    messagesSnapshot: params.messagesSnapshot,
    assistantTexts: [],
    toolMetas: [],
    lastAssistant: undefined,
    didSendViaMessagingTool: false,
    messagingToolSentTexts: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    messagingToolSourceReplyPayloads: [],
    cloudCodeAssistFormatError: false,
    replayMetadata: {
      hadPotentialSideEffects: false,
      replaySafe: true,
    },
    itemLifecycle: {
      startedCount: 0,
      completedCount: 0,
      activeCount: 0,
    },
    systemPromptReport: params.systemPromptReport,
  };
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
  const response: CodexDynamicToolCallResponse = {
    contentItems: [{ type: "inputText", text: message }],
    success: false,
  };
  Object.defineProperty(response, "diagnosticTerminalType", {
    configurable: true,
    enumerable: false,
    value: "error",
  });
  return response;
}

function toCodexDynamicToolProtocolResponse(
  response: CodexDynamicToolCallResponse,
): CodexDynamicToolCallResponse {
  return {
    contentItems: response.contentItems,
    success: response.success,
  };
}

type TerminalToolExecutionDiagnostic = Extract<
  DiagnosticEventPayload,
  { type: "tool.execution.blocked" | "tool.execution.completed" | "tool.execution.error" }
>;

function isDynamicToolTerminalDiagnosticEvent(
  event: DiagnosticEventPayload,
): event is TerminalToolExecutionDiagnostic {
  return (
    event.type === "tool.execution.completed" ||
    event.type === "tool.execution.error" ||
    event.type === "tool.execution.blocked"
  );
}

function isMatchingDynamicToolTerminalDiagnostic(params: {
  event: TerminalToolExecutionDiagnostic;
  call: CodexDynamicToolCallParams;
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
}): boolean {
  if (
    params.event.toolCallId !== params.call.callId ||
    params.event.toolName !== params.call.tool
  ) {
    return false;
  }
  if (params.runId !== undefined) {
    return params.event.runId === params.runId;
  }
  if (params.sessionId !== undefined) {
    return params.event.sessionId === params.sessionId;
  }
  if (params.sessionKey !== undefined) {
    return params.event.sessionKey === params.sessionKey;
  }
  return (
    params.event.runId === undefined &&
    params.event.sessionId === undefined &&
    params.event.sessionKey === undefined
  );
}

function hasPendingDynamicToolTerminalDiagnostic(params: {
  call: CodexDynamicToolCallParams;
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
}): boolean {
  return hasPendingInternalDiagnosticEvent((event) => {
    if (!isDynamicToolTerminalDiagnosticEvent(event)) {
      return false;
    }
    return isMatchingDynamicToolTerminalDiagnostic({
      event,
      call: params.call,
      runId: params.runId,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
    });
  });
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
      return CODEX_DYNAMIC_IMAGE_GENERATION_TOOL_TIMEOUT_MS;
    }
    return (
      readPositiveFiniteTimeoutMs(imageGenerationModel.timeoutMs) ??
      CODEX_DYNAMIC_IMAGE_GENERATION_TOOL_TIMEOUT_MS
    );
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
  channelId?: string;
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
    ...(params.channelId ? { channelId: params.channelId } : {}),
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

function fingerprintCodexLogValue(namespace: string, value: string): string {
  const hash = createHash("sha256");
  hash.update(namespace);
  hash.update("\0");
  hash.update(value);
  return `sha256:${hash.digest("hex").slice(0, 16)}`;
}

function buildCodexPluginThreadConfigEligibilityLogData(params: {
  sessionId: string;
  sessionKey: string;
  pluginThreadConfigRequired: boolean;
  resolvedPluginPolicy: ReturnType<typeof resolveCodexPluginsPolicy> | undefined;
  enabledPluginConfigKeys: string[] | undefined;
  pluginAppCacheKey: string;
  startupAuthProfileId: string | undefined;
  appServer: CodexAppServerRuntimeOptions;
}): Record<string, unknown> {
  return {
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    enabled: params.pluginThreadConfigRequired,
    policyConfigured: params.resolvedPluginPolicy?.configured === true,
    policyEnabled: params.resolvedPluginPolicy?.enabled === true,
    pluginConfigKeys: params.resolvedPluginPolicy?.pluginPolicies
      .map((plugin) => plugin.configKey)
      .toSorted(),
    enabledPluginConfigKeys: params.enabledPluginConfigKeys,
    appCacheKeyFingerprint: fingerprintCodexLogValue(
      "openclaw:codex:plugin-app-cache-key:v1",
      params.pluginAppCacheKey,
    ),
    authProfileId: params.startupAuthProfileId,
    appServerTransport: params.appServer.start.transport,
    appServerCommandSource: params.appServer.start.commandSource,
  };
}

function interruptCodexTurnBestEffort(
  client: CodexAppServerClient,
  params: {
    threadId: string;
    turnId: string;
    timeoutMs?: number;
  },
): void {
  const requestOptions =
    params.timeoutMs && Number.isFinite(params.timeoutMs) && params.timeoutMs > 0
      ? { timeoutMs: params.timeoutMs }
      : undefined;
  const requestParams = { threadId: params.threadId, turnId: params.turnId };
  try {
    const interrupt = requestOptions
      ? client.request("turn/interrupt", requestParams, requestOptions)
      : client.request("turn/interrupt", requestParams);
    void Promise.resolve(interrupt).catch((error: unknown) => {
      embeddedAgentLog.debug("codex app-server turn interrupt failed during abort", { error });
    });
  } catch (error) {
    embeddedAgentLog.debug("codex app-server turn interrupt failed during abort", { error });
  }
}

function retireCodexAppServerClientAfterTimedOutTurn(
  client: CodexAppServerClient,
  params: {
    threadId: string;
    turnId: string;
    reason: string;
  },
): void {
  const clearedSharedClient = clearSharedCodexAppServerClientIfCurrent(client);
  if (!clearedSharedClient) {
    const close = (client as { close?: () => void }).close;
    if (typeof close === "function") {
      close.call(client);
    }
  }
  embeddedAgentLog.warn("codex app-server client retired after timed-out turn", {
    threadId: params.threadId,
    turnId: params.turnId,
    reason: params.reason,
    clearedSharedClient,
  });
}

type DynamicToolBuildParams = {
  params: EmbeddedRunAttemptParams;
  resolvedWorkspace: string;
  effectiveWorkspace: string;
  sandboxSessionKey: string;
  sandbox: Awaited<ReturnType<typeof resolveSandboxContext>>;
  nativeToolSurfaceEnabled?: boolean;
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

function resolveCodexAppServerHookChannelId(
  params: EmbeddedRunAttemptParams,
  sandboxSessionKey: string,
): string | undefined {
  return buildAgentHookContextChannelFields({
    sessionKey: sandboxSessionKey,
    messageChannel: params.messageChannel,
    messageProvider: params.messageProvider,
    currentChannelId: params.currentChannelId,
    messageTo: params.messageTo,
  }).channelId;
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
    allowGatewaySubagentBinding:
      params.allowGatewaySubagentBinding || isForcedPrivateQaCodexRuntime(),
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
    authProfileStore: params.toolAuthProfileStore ?? params.authProfileStore,
    abortSignal: input.runAbortController.signal,
    emitBeforeToolCallDiagnostics: false,
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
    hookChannelId: resolveCodexAppServerHookChannelId(params, input.sandboxSessionKey),
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
  const codexFilteredTools = addSandboxShellDynamicToolsIfAvailable(
    filterCodexDynamicTools(allTools, input.pluginConfig),
    allTools,
    input,
  );
  const visionFilteredTools = filterToolsForVisionInputs(codexFilteredTools, {
    modelHasVision,
    hasInboundImages: (params.images?.length ?? 0) > 0,
  });
  const toolsAllow = includeForcedMessageToolAllow(params.toolsAllow, params);
  const filteredTools = filterCodexDynamicToolsForAllowlist(visionFilteredTools, toolsAllow);
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

function includeForcedMessageToolAllow(
  toolsAllow: string[] | undefined,
  params: EmbeddedRunAttemptParams,
): string[] | undefined {
  if (
    !shouldForceMessageTool(params) ||
    toolsAllow === undefined ||
    hasWildcardCodexToolsAllow(toolsAllow)
  ) {
    return toolsAllow;
  }
  if (toolsAllow.length === 0) {
    return ["message"];
  }
  const normalized = new Set(toolsAllow.map((name) => normalizeCodexDynamicToolName(name)));
  return normalized.has("message") ? toolsAllow : [...toolsAllow, "message"];
}

function shouldEnableCodexAppServerNativeToolSurface(
  params: EmbeddedRunAttemptParams,
  sandbox?: OpenClawSandboxContext,
): boolean {
  const toolsAllow = includeForcedMessageToolAllow(params.toolsAllow, params);
  if (toolsAllow === undefined) {
    return canCodexAppServerNativeToolSurfaceHonorSandbox(sandbox);
  }
  // Codex native code mode exposes its shell/file surface as one app-server
  // capability, so narrow OpenClaw allowlists must fail closed rather than
  // widening `message` or `web_search` into shell access.
  return (
    hasWildcardCodexToolsAllow(toolsAllow) &&
    canCodexAppServerNativeToolSurfaceHonorSandbox(sandbox)
  );
}

function canCodexAppServerNativeToolSurfaceHonorSandbox(
  sandbox: OpenClawSandboxContext | undefined,
): boolean {
  if (!sandbox?.enabled || sandbox.backendId !== "docker") {
    return true;
  }
  return (
    !hasSandboxBindContainerPathAliases(sandbox.docker.binds) &&
    !hasSandboxBindReadonlyHostShadows(sandbox.docker.binds)
  );
}

function disableCodexPluginThreadConfig(pluginConfig?: unknown): CodexPluginConfig {
  const config = readCodexPluginConfig(pluginConfig);
  return {
    ...config,
    codexPlugins: {
      ...config.codexPlugins,
      enabled: false,
    },
  };
}

function addSandboxShellDynamicToolsIfAvailable(
  filteredTools: OpenClawDynamicTool[],
  allTools: OpenClawDynamicTool[],
  input: DynamicToolBuildParams,
): OpenClawDynamicTool[] {
  if (
    !shouldExposeSandboxExecDynamicTool(input) ||
    isSandboxShellDynamicToolExcluded(input.pluginConfig)
  ) {
    return filteredTools;
  }
  const execTool = allTools.find((tool) => normalizeCodexDynamicToolName(tool.name) === "exec");
  const processTool = allTools.find(
    (tool) => normalizeCodexDynamicToolName(tool.name) === "process",
  );
  if (!execTool || !processTool) {
    return filteredTools;
  }
  const sandboxExecTool: OpenClawDynamicTool = {
    ...execTool,
    name: "sandbox_exec",
    description:
      "Run a shell command through OpenClaw's configured sandbox backend for this session. Use only when the command must execute in the OpenClaw sandbox backend, such as an SSH-backed sandbox or Docker container-path bind layout that Codex's native shell cannot represent. Use Codex's native shell for normal local workspace commands.",
    execute: async (toolCallId, args, signal, onUpdate) => {
      const result = await execTool.execute(toolCallId, args, signal, onUpdate);
      return {
        ...result,
        content: result.content.map((item) =>
          item.type === "text"
            ? Object.assign({}, item, {
                text: item.text.replace(
                  "Use process (list/poll/log/write/send-keys/submit/paste/kill/clear/remove) for follow-up.",
                  "Use sandbox_process (list/poll/log/write/send-keys/submit/paste/kill/clear/remove) for follow-up.",
                ),
              })
            : item,
        ),
      };
    },
  };
  const sandboxProcessTool: OpenClawDynamicTool = {
    ...processTool,
    name: "sandbox_process",
    description:
      "Manage sandbox_exec sessions that were started through OpenClaw's configured sandbox backend for this session: list, poll, log, write, send-keys, submit, paste, kill, clear, or remove. Use only for sandbox_exec follow-up; use Codex's native shell session handling for normal native shell commands.",
  };
  return [...filteredTools, sandboxExecTool, sandboxProcessTool];
}

function shouldExposeSandboxExecDynamicTool(input: DynamicToolBuildParams): boolean {
  const backendId = input.sandbox?.enabled ? input.sandbox.backendId.trim().toLowerCase() : "";
  return Boolean(backendId && (backendId !== "docker" || input.nativeToolSurfaceEnabled === false));
}

function isSandboxShellDynamicToolExcluded(config: CodexPluginConfig): boolean {
  return (config.codexDynamicToolsExclude ?? []).some((name) => {
    const normalized = normalizeCodexDynamicToolName(name);
    return (
      normalized === "exec" ||
      normalized === "sandbox_exec" ||
      normalized === "process" ||
      normalized === "sandbox_process"
    );
  });
}

function filterCodexDynamicToolsForAllowlist<T extends { name: string }>(
  tools: T[],
  toolsAllow?: string[],
): T[] {
  if (!toolsAllow) {
    return tools;
  }
  if (toolsAllow.length === 0) {
    return [];
  }
  if (hasWildcardCodexToolsAllow(toolsAllow)) {
    return tools;
  }
  const allowSet = new Set(
    toolsAllow.map((name) => normalizeCodexDynamicToolName(name)).filter(Boolean),
  );
  return tools.filter((tool) => {
    const normalized = normalizeCodexDynamicToolName(tool.name);
    return (
      allowSet.has(normalized) ||
      (normalized === "sandbox_exec" && allowSet.has("exec")) ||
      (normalized === "sandbox_process" && (allowSet.has("exec") || allowSet.has("process")))
    );
  });
}

function hasWildcardCodexToolsAllow(toolsAllow: string[]): boolean {
  return toolsAllow.some((name) => normalizeCodexDynamicToolName(name) === "*");
}

function shouldForceMessageTool(params: EmbeddedRunAttemptParams): boolean {
  return (
    params.disableMessageTool !== true && params.sourceReplyDeliveryMode === "message_tool_only"
  );
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

function readContextEngineThreadBootstrapProjection(
  projection: ContextEngineProjection | undefined,
): CodexContextEngineThreadBootstrapProjection | undefined {
  if (projection?.mode !== "thread_bootstrap") {
    return undefined;
  }
  const epoch = projection.epoch?.trim();
  if (!epoch) {
    embeddedAgentLog.warn(
      "context engine requested Codex thread-bootstrap projection without an epoch; using per-turn projection",
    );
    return undefined;
  }
  const fingerprint = projection.fingerprint?.trim();
  return {
    mode: "thread_bootstrap",
    epoch,
    ...(fingerprint ? { fingerprint } : {}),
  };
}

function resolveContextEngineBootstrapProjectionDecision(params: {
  startupBinding: CodexAppServerThreadBinding | undefined;
  expectedBinding: ReturnType<typeof buildContextEngineBinding>;
  projection: CodexContextEngineThreadBootstrapProjection;
  dynamicToolsFingerprint: string;
}): { project: boolean; reason: string } {
  const bindingProjection = params.startupBinding?.contextEngine?.projection;
  if (!params.startupBinding?.threadId || !bindingProjection) {
    return {
      project: true,
      reason: !params.startupBinding?.threadId
        ? "missing-thread-binding"
        : "missing-projection-binding",
    };
  }
  if (
    !params.expectedBinding ||
    !isContextEngineBindingCompatible(params.startupBinding.contextEngine, params.expectedBinding)
  ) {
    return { project: true, reason: "context-engine-binding-mismatch" };
  }
  if (
    !areCodexDynamicToolFingerprintsCompatible({
      previous: params.startupBinding.dynamicToolsFingerprint,
      next: params.dynamicToolsFingerprint,
    })
  ) {
    return { project: true, reason: "dynamic-tools-mismatch" };
  }
  const projectionChanged =
    bindingProjection.mode !== "thread_bootstrap" ||
    bindingProjection.epoch !== params.projection.epoch ||
    bindingProjection.fingerprint !== params.projection.fingerprint;
  return projectionChanged
    ? { project: true, reason: "projection-mismatch" }
    : { project: false, reason: "matching-thread-bootstrap-binding" };
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

function resolveCodexTurnAssistantCompletionIdleTimeoutMs(value: number | undefined): number {
  if (value === undefined) {
    return CODEX_TURN_ASSISTANT_COMPLETION_IDLE_TIMEOUT_MS;
  }
  if (!Number.isFinite(value)) {
    return CODEX_TURN_ASSISTANT_COMPLETION_IDLE_TIMEOUT_MS;
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

type CodexUsageLimitErrorSource = {
  message?: string | null;
  codexErrorInfo?: JsonValue | null;
  rateLimits?: JsonValue;
  rateLimitsTrustedForProfile?: boolean;
};

type CodexUsageLimitErrorResult = {
  message: string;
  rateLimitsForProfile?: JsonValue;
};

async function formatCodexTurnStartUsageLimitError(params: {
  client: CodexAppServerClient;
  error: unknown;
  pendingNotifications: CodexServerNotification[];
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<CodexUsageLimitErrorResult | undefined> {
  return refreshCodexUsageLimitError({
    client: params.client,
    source: readCodexTurnStartUsageLimitErrorSource(params.error, params.pendingNotifications),
    timeoutMs: params.timeoutMs,
    signal: params.signal,
  });
}

async function refreshCodexUsageLimitErrorMessage(params: {
  client: CodexAppServerClient;
  source: CodexUsageLimitErrorSource;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<string | undefined> {
  return (
    await refreshCodexUsageLimitError({
      client: params.client,
      source: params.source,
      timeoutMs: params.timeoutMs,
      signal: params.signal,
    })
  )?.message;
}

async function refreshCodexUsageLimitError(params: {
  client: CodexAppServerClient;
  source: CodexUsageLimitErrorSource;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<CodexUsageLimitErrorResult | undefined> {
  const initialMessage = formatCodexUsageLimitErrorMessage(params.source);
  if (!shouldRefreshCodexRateLimitsForUsageLimitMessage(initialMessage)) {
    return initialMessage
      ? {
          message: initialMessage,
          ...(params.source.rateLimitsTrustedForProfile
            ? { rateLimitsForProfile: params.source.rateLimits }
            : {}),
        }
      : undefined;
  }
  const rateLimits = await readCodexRateLimitsFromAppServerForUsageLimitError({
    client: params.client,
    timeoutMs: params.timeoutMs,
    signal: params.signal,
  });
  if (!rateLimits) {
    return initialMessage
      ? {
          message: initialMessage,
          ...(params.source.rateLimitsTrustedForProfile
            ? { rateLimitsForProfile: params.source.rateLimits }
            : {}),
        }
      : undefined;
  }
  const refreshedMessage = formatCodexUsageLimitErrorMessage({
    message: params.source.message,
    codexErrorInfo: params.source.codexErrorInfo,
    rateLimits,
  });
  const message = refreshedMessage ?? initialMessage;
  return message ? { message, rateLimitsForProfile: rateLimits } : undefined;
}

async function readCodexRateLimitsFromAppServerForUsageLimitError(params: {
  client: CodexAppServerClient;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<JsonValue | undefined> {
  if (params.signal?.aborted) {
    return undefined;
  }
  try {
    const rateLimits = await params.client.request(CODEX_CONTROL_METHODS.rateLimits, undefined, {
      timeoutMs: resolveCodexUsageLimitRateLimitRefreshTimeoutMs(params.timeoutMs),
      signal: params.signal,
    });
    rememberCodexRateLimits(rateLimits);
    return rateLimits;
  } catch (error) {
    embeddedAgentLog.debug("codex app-server rate-limit refresh failed after usage-limit error", {
      error: formatErrorMessage(error),
    });
    return undefined;
  }
}

function resolveCodexUsageLimitRateLimitRefreshTimeoutMs(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return CODEX_USAGE_LIMIT_RATE_LIMIT_REFRESH_TIMEOUT_MS;
  }
  return Math.max(100, Math.min(timeoutMs, CODEX_USAGE_LIMIT_RATE_LIMIT_REFRESH_TIMEOUT_MS));
}

function readCodexTurnStartUsageLimitErrorSource(
  error: unknown,
  pendingNotifications: CodexServerNotification[],
): CodexUsageLimitErrorSource {
  const notificationError = readLatestCodexErrorNotification(pendingNotifications);
  const notificationRateLimits = readLatestRateLimitNotificationPayload(pendingNotifications);
  const errorPayload = readCodexErrorPayload(error);
  const rateLimits =
    notificationRateLimits ?? errorPayload.rateLimits ?? readRecentCodexRateLimits();
  return {
    message: notificationError?.message ?? errorPayload.message ?? formatErrorMessage(error),
    codexErrorInfo: notificationError?.codexErrorInfo ?? errorPayload.codexErrorInfo,
    rateLimits,
    rateLimitsTrustedForProfile:
      notificationRateLimits !== undefined || errorPayload.rateLimits !== undefined,
  };
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
  const rateLimits = nestedError.rateLimits ?? data.rateLimits;
  if (rateLimits !== undefined) {
    rememberCodexRateLimits(rateLimits);
  }
  return {
    message: readString(nestedError, "message") ?? message,
    codexErrorInfo: nestedError.codexErrorInfo,
    rateLimits,
  };
}

function isInvalidCodexImagePayloadError(message: unknown): boolean {
  if (typeof message !== "string" || !message.trim()) {
    return false;
  }
  const normalizedMessage = message.replace(/[_-]+/gu, " ");
  return (
    /\b(?:invalid|malformed)\b[\s\S]{0,120}\b(?:image|image url|base64)\b/iu.test(
      normalizedMessage,
    ) ||
    /\b(?:image|image url|base64)\b[\s\S]{0,120}\b(?:invalid|malformed)\b/iu.test(normalizedMessage)
  );
}

async function clearCodexBindingAfterInvalidImagePayload(
  sessionFile: string,
  fields: { phase: string; threadId?: string; turnId?: string; error?: string },
): Promise<void> {
  const currentBinding = await readCodexAppServerBinding(sessionFile);
  if (fields.threadId && currentBinding && currentBinding.threadId !== fields.threadId) {
    embeddedAgentLog.warn(
      "codex app-server image payload error detected for unbound thread; preserving thread binding",
      { ...fields, boundThreadId: currentBinding.threadId },
    );
    return;
  }
  embeddedAgentLog.warn(
    "codex app-server image payload error detected; clearing thread binding",
    fields,
  );
  await clearCodexAppServerBinding(sessionFile);
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

function updateActiveTurnItemIds(
  notification: CodexServerNotification,
  activeItemIds: Set<string>,
): void {
  if (notification.method !== "item/started" && notification.method !== "item/completed") {
    return;
  }
  const itemId = readNotificationItemId(notification);
  if (!itemId) {
    return;
  }
  if (notification.method === "item/started") {
    activeItemIds.add(itemId);
    return;
  }
  activeItemIds.delete(itemId);
}

function isCompletedAssistantNotification(notification: CodexServerNotification): boolean {
  if (!isJsonObject(notification.params)) {
    return false;
  }
  if (notification.method !== "item/completed") {
    return false;
  }
  const item = isJsonObject(notification.params.item) ? notification.params.item : undefined;
  return Boolean(
    item &&
    readString(item, "type") === "agentMessage" &&
    readString(item, "phase") !== "commentary",
  );
}

function isAssistantCompletionReleaseNotification(
  notification: CodexServerNotification,
  turnCrossedToolHandoff: boolean,
): boolean {
  if (isCompletedAssistantNotification(notification)) {
    return true;
  }
  return !turnCrossedToolHandoff && isRawAssistantCompletionNotification(notification);
}

function shouldDisarmAssistantCompletionIdleWatch(notification: CodexServerNotification): boolean {
  if (!isJsonObject(notification.params)) {
    return false;
  }
  if (notification.method === "item/started") {
    return true;
  }
  if (notification.method === "item/agentMessage/delta") {
    return true;
  }
  return false;
}

function readNotificationItemId(notification: CodexServerNotification): string | undefined {
  if (!isJsonObject(notification.params)) {
    return undefined;
  }
  const item = isJsonObject(notification.params.item) ? notification.params.item : undefined;
  return (
    (item ? readString(item, "id") : undefined) ??
    readString(notification.params, "itemId") ??
    readString(notification.params, "id")
  );
}

function isPendingOpenClawDynamicToolCompletionNotification(
  notification: CodexServerNotification,
  pendingOpenClawDynamicToolCompletionIds: ReadonlySet<string>,
): boolean {
  if (notification.method !== "item/completed" || !isJsonObject(notification.params)) {
    return false;
  }
  const itemId = readNotificationItemId(notification);
  if (!itemId || !pendingOpenClawDynamicToolCompletionIds.has(itemId)) {
    return false;
  }
  const item = isJsonObject(notification.params.item) ? notification.params.item : undefined;
  const itemType = item ? readString(item, "type") : undefined;
  return itemType === undefined || itemType === "dynamicToolCall";
}

function isRawToolOutputCompletionNotification(notification: CodexServerNotification): boolean {
  if (notification.method !== "rawResponseItem/completed" || !isJsonObject(notification.params)) {
    return false;
  }
  const item = isJsonObject(notification.params.item) ? notification.params.item : undefined;
  return item ? readString(item, "type") === "custom_tool_call_output" : false;
}

function isNativeToolProgressNotification(notification: CodexServerNotification): boolean {
  if (
    notification.method !== "item/started" &&
    notification.method !== "item/completed" &&
    notification.method !== "item/updated"
  ) {
    return false;
  }
  if (!isJsonObject(notification.params)) {
    return false;
  }
  const item = isJsonObject(notification.params.item) ? notification.params.item : undefined;
  switch (item ? readString(item, "type") : undefined) {
    case "commandExecution":
    case "fileChange":
    case "mcpToolCall":
    case "webSearch":
      return true;
    default:
      return false;
  }
}

function isRawAssistantCompletionNotification(notification: CodexServerNotification): boolean {
  if (notification.method !== "rawResponseItem/completed" || !isJsonObject(notification.params)) {
    return false;
  }
  const item = isJsonObject(notification.params.item) ? notification.params.item : undefined;
  return Boolean(
    item &&
    readString(item, "type") === "message" &&
    readString(item, "role") === "assistant" &&
    readString(item, "phase") !== "commentary" &&
    readRawAssistantTextPreview(item),
  );
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

function isCurrentThreadTurnRequestParams(
  value: JsonValue | undefined,
  threadId: string,
  turnId: string,
): boolean {
  if (!isJsonObject(value)) {
    return false;
  }
  return readString(value, "threadId") === threadId && readString(value, "turnId") === turnId;
}

function isCurrentApprovalTurnRequestParams(
  value: JsonValue | undefined,
  threadId: string,
  turnId: string,
): boolean {
  if (!isJsonObject(value)) {
    return false;
  }
  const requestThreadId = readString(value, "threadId") ?? readString(value, "conversationId");
  return requestThreadId === threadId && readString(value, "turnId") === turnId;
}

function isCurrentThreadOptionalTurnRequestParams(
  value: JsonValue | undefined,
  threadId: string,
  turnId: string,
): boolean {
  if (!isJsonObject(value) || readString(value, "threadId") !== threadId) {
    return false;
  }
  const requestTurnId = value.turnId;
  return requestTurnId === null || requestTurnId === undefined || requestTurnId === turnId;
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

const CODEX_TURN_ABORT_MARKER_START = "<turn_aborted>";
const CODEX_TURN_ABORT_MARKER_END = "</turn_aborted>";
const CODEX_INTERRUPTED_USER_GUIDANCE =
  "The user interrupted the previous turn on purpose. Any running unified exec processes may still be running in the background. If any tools/commands were aborted, they may have partially executed.";
const CODEX_INTERRUPTED_DEVELOPER_GUIDANCE =
  "The previous turn was interrupted on purpose. Any running unified exec processes may still be running in the background. If any tools/commands were aborted, they may have partially executed.";

function isCodexTurnAbortMarkerNotification(
  notification: CodexServerNotification,
  options: { currentPromptText?: string; currentPromptTexts?: readonly string[] } = {},
): boolean {
  if (notification.method !== "rawResponseItem/completed" || !isJsonObject(notification.params)) {
    return false;
  }
  const item = notification.params.item;
  const role = isJsonObject(item) ? readString(item, "role") : undefined;
  if (!isJsonObject(item) || (role !== "user" && role !== "developer")) {
    return false;
  }
  const text = extractRawResponseItemText(item).trim();
  const currentPromptTexts = [options.currentPromptText, ...(options.currentPromptTexts ?? [])]
    .filter(isNonEmptyString)
    .map((prompt) => prompt.trim());
  if (role === "user" && currentPromptTexts.includes(text)) {
    return false;
  }
  const markerBody = readCodexTurnAbortMarkerBody(text);
  return (
    markerBody === CODEX_INTERRUPTED_USER_GUIDANCE ||
    markerBody === CODEX_INTERRUPTED_DEVELOPER_GUIDANCE
  );
}

function readCodexTurnAbortMarkerBody(text: string): string | undefined {
  if (
    !text.startsWith(CODEX_TURN_ABORT_MARKER_START) ||
    !text.endsWith(CODEX_TURN_ABORT_MARKER_END)
  ) {
    return undefined;
  }
  return text
    .slice(CODEX_TURN_ABORT_MARKER_START.length, -CODEX_TURN_ABORT_MARKER_END.length)
    .trim();
}

function extractRawResponseItemText(item: JsonObject): string {
  const content = item.content;
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((entry) => {
      if (!isJsonObject(entry)) {
        return [];
      }
      const type = readString(entry, "type");
      if (type !== "input_text" && type !== "text") {
        return [];
      }
      const text = readString(entry, "text");
      return text ? [text] : [];
    })
    .join("");
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

async function buildCodexWorkspaceBootstrapContext(params: {
  params: EmbeddedRunAttemptParams;
  resolvedWorkspace: string;
  effectiveWorkspace: string;
  sessionKey: string;
  sessionAgentId: string;
}): Promise<CodexWorkspaceBootstrapContext> {
  try {
    const bootstrapContext = await resolveBootstrapContextForRun({
      workspaceDir: params.resolvedWorkspace,
      config: params.params.config,
      sessionKey: params.sessionKey,
      sessionId: params.params.sessionId,
      agentId: params.params.agentId ?? params.sessionAgentId,
      warn: (message) => embeddedAgentLog.warn(message),
      contextMode: params.params.bootstrapContextMode,
      runKind: params.params.bootstrapContextRunKind,
    });
    const contextFiles = bootstrapContext.contextFiles.map((file) =>
      remapCodexContextFilePath({
        file,
        sourceWorkspaceDir: params.resolvedWorkspace,
        targetWorkspaceDir: params.effectiveWorkspace,
      }),
    );
    const promptContextFiles = selectCodexWorkspacePromptContextFiles(contextFiles);
    const developerInstructionFiles = shouldInjectCodexOpenClawPromptContext(params.params)
      ? selectCodexWorkspaceDeveloperInstructionFiles(contextFiles)
      : [];
    const heartbeatReferenceFiles = selectCodexWorkspaceHeartbeatReferenceFiles(contextFiles);
    return {
      ...bootstrapContext,
      contextFiles,
      promptContextFiles,
      developerInstructionFiles,
      heartbeatReferenceFiles,
      promptContext: renderCodexWorkspaceBootstrapPromptContext(promptContextFiles),
      developerInstructions: renderCodexWorkspaceDeveloperInstructions(developerInstructionFiles),
      heartbeatCollaborationInstructions:
        renderCodexWorkspaceHeartbeatReference(heartbeatReferenceFiles),
    };
  } catch (error) {
    embeddedAgentLog.warn("failed to load codex workspace bootstrap instructions", { error });
    return { bootstrapFiles: [], contextFiles: [] };
  }
}

function buildCodexSystemPromptReport(params: {
  attempt: EmbeddedRunAttemptParams;
  sessionKey: string;
  workspaceDir: string;
  developerInstructions: string;
  workspaceBootstrapContext: CodexWorkspaceBootstrapContext;
  skillsPrompt: string;
  tools: CodexDynamicToolSpec[];
}): CodexSystemPromptReport {
  const toolEntries = params.tools.map(buildCodexToolReportEntry);
  const schemaChars = toolEntries.reduce((sum, tool) => sum + tool.schemaChars, 0);
  const skillsPrompt = params.skillsPrompt.trim();
  const bootstrapMaxChars = readPositiveNumber(
    params.attempt.config?.agents?.defaults?.bootstrapMaxChars,
  );
  const bootstrapTotalMaxChars = readPositiveNumber(
    params.attempt.config?.agents?.defaults?.bootstrapTotalMaxChars,
  );
  return {
    source: "run",
    generatedAt: Date.now(),
    sessionId: params.attempt.sessionId,
    sessionKey: params.sessionKey,
    provider: params.attempt.provider,
    model: params.attempt.modelId,
    workspaceDir: params.workspaceDir,
    ...(bootstrapMaxChars ? { bootstrapMaxChars } : {}),
    ...(bootstrapTotalMaxChars ? { bootstrapTotalMaxChars } : {}),
    systemPrompt: {
      chars: params.developerInstructions.length,
      projectContextChars: 0,
      nonProjectContextChars: params.developerInstructions.length,
    },
    injectedWorkspaceFiles: buildCodexBootstrapInjectionStats({
      bootstrapFiles: params.workspaceBootstrapContext.bootstrapFiles,
      injectedFiles: params.workspaceBootstrapContext.promptContextFiles ?? [],
      developerInstructionFiles: params.workspaceBootstrapContext.developerInstructionFiles ?? [],
    }),
    skills: {
      promptChars: skillsPrompt.length,
      entries: buildCodexSkillReportEntries(skillsPrompt),
    },
    tools: {
      listChars: 0,
      schemaChars,
      entries: toolEntries,
    },
  };
}

function buildCodexSkillReportEntries(
  skillsPrompt: string,
): CodexSystemPromptReport["skills"]["entries"] {
  if (!skillsPrompt) {
    return [];
  }
  return Array.from(skillsPrompt.matchAll(/<skill>[\s\S]*?<\/skill>/gi))
    .map((match) => match[0] ?? "")
    .map((block) => ({
      name: block.match(/<name>\s*([^<]+?)\s*<\/name>/i)?.[1]?.trim() || "(unknown)",
      blockChars: block.length,
    }))
    .filter((entry) => entry.blockChars > 0);
}

function buildCodexToolReportEntry(tool: CodexDynamicToolSpec): CodexToolReportEntry {
  const summary = tool.description.trim();
  if (tool.deferLoading === true) {
    return {
      name: tool.name,
      summaryChars: summary.length,
      schemaChars: 0,
      propertiesCount: null,
    };
  }
  return {
    name: tool.name,
    summaryChars: summary.length,
    ...buildCodexToolSchemaStats(tool.inputSchema),
  };
}

function buildCodexToolSchemaStats(
  schema: JsonValue,
): Pick<CodexToolReportEntry, "schemaChars" | "propertiesCount"> {
  const schemaChars = (() => {
    try {
      return JSON.stringify(schema).length;
    } catch {
      return 0;
    }
  })();
  const properties =
    isJsonObject(schema) && isJsonObject(schema.properties) ? schema.properties : null;
  return {
    schemaChars,
    propertiesCount: properties ? Object.keys(properties).length : null,
  };
}

function buildCodexBootstrapInjectionStats(params: {
  bootstrapFiles: CodexBootstrapFile[];
  injectedFiles: EmbeddedContextFile[];
  developerInstructionFiles?: EmbeddedContextFile[];
}): CodexSystemPromptReport["injectedWorkspaceFiles"] {
  const injectedIndex = indexCodexContextFileContent(params.injectedFiles);
  const developerInstructionIndex = indexCodexContextFileContent(
    params.developerInstructionFiles ?? [],
  );
  return params.bootstrapFiles.map((file) => {
    const fileName = readNonEmptyString(file.name);
    const pathValue = readNonEmptyString(file.path) ?? fileName ?? "";
    const displayName = (fileName ?? getCodexContextFileDisplayBasename(pathValue)) || pathValue;
    const baseName = getCodexContextFileBasename(pathValue || fileName || "");
    const rawChars = file.missing ? 0 : (file.content ?? "").trimEnd().length;
    const injected =
      readCodexIndexedContextFileContent(injectedIndex, pathValue, fileName) ??
      readCodexIndexedContextFileContent(developerInstructionIndex, pathValue, fileName);
    let injectedChars = injected?.length ?? 0;
    let truncated = !file.missing && injectedChars < rawChars;
    if (injected === undefined) {
      if (CODEX_NATIVE_PROJECT_DOC_BASENAMES.has(baseName)) {
        injectedChars = rawChars;
        truncated = false;
      } else if (baseName === CODEX_HEARTBEAT_CONTEXT_BASENAME) {
        injectedChars = 0;
        truncated = false;
      }
    }
    return {
      name: displayName,
      path: pathValue,
      missing: file.missing,
      rawChars,
      injectedChars,
      truncated,
    };
  });
}

function indexCodexContextFileContent(files: EmbeddedContextFile[]): {
  byPath: Map<string, string>;
  byBaseName: Map<string, string>;
} {
  const byPath = new Map<string, string>();
  const byBaseName = new Map<string, string>();
  for (const file of files) {
    const pathValue = readNonEmptyString(file.path);
    if (!pathValue) {
      continue;
    }
    if (!byPath.has(pathValue)) {
      byPath.set(pathValue, file.content);
    }
    const baseName = getCodexContextFileBasename(pathValue);
    if (baseName && !byBaseName.has(baseName)) {
      byBaseName.set(baseName, file.content);
    }
  }
  return { byPath, byBaseName };
}

function readCodexIndexedContextFileContent(
  index: { byPath: Map<string, string>; byBaseName: Map<string, string> },
  pathValue: string,
  fileName: string | undefined,
): string | undefined {
  const pathContent = index.byPath.get(pathValue);
  if (pathContent !== undefined) {
    return pathContent;
  }
  if (fileName) {
    const nameContent = index.byPath.get(fileName);
    if (nameContent !== undefined) {
      return nameContent;
    }
  }
  const baseName = getCodexContextFileBasename(fileName ?? pathValue);
  return baseName ? index.byBaseName.get(baseName) : undefined;
}

function readPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function buildCodexOpenClawPromptContext(params: {
  params: EmbeddedRunAttemptParams;
  skillsPrompt?: string;
  workspacePromptContext?: string;
}): string | undefined {
  if (!shouldInjectCodexOpenClawPromptContext(params.params)) {
    return undefined;
  }
  const sections = [
    params.skillsPrompt?.trim()
      ? ["## OpenClaw Skills", "", params.skillsPrompt.trim()].join("\n")
      : undefined,
    params.workspacePromptContext?.trim()
      ? ["## OpenClaw Workspace Context", "", params.workspacePromptContext.trim()].join("\n")
      : undefined,
  ].filter(isNonEmptyString);
  if (sections.length === 0) {
    return undefined;
  }
  return [
    "OpenClaw runtime context for this turn:",
    "Treat this OpenClaw-provided context as supporting project/user reference for the current request.",
    "",
    ...sections,
  ].join("\n");
}

function shouldInjectCodexOpenClawPromptContext(params: EmbeddedRunAttemptParams): boolean {
  // Lightweight cron runs are commonly exact commands. Keep the user input byte-for-byte
  // to avoid changing command intent while Codex keeps its native project-doc loader.
  return !(
    params.bootstrapContextMode === "lightweight" && params.bootstrapContextRunKind === "cron"
  );
}

function prependCodexOpenClawPromptContext(prompt: string, context: string | undefined): string {
  if (!context?.trim()) {
    return prompt;
  }
  const promptSection = prompt.startsWith("OpenClaw assembled context for this turn:")
    ? prompt
    : ["Current user request:", prompt].join("\n");
  return [context.trim(), "", promptSection].join("\n");
}

function renderCodexWorkspaceBootstrapPromptContext(
  contextFiles: EmbeddedContextFile[],
): string | undefined {
  const files = selectCodexWorkspacePromptContextFiles(contextFiles);
  if (files.length === 0) {
    return undefined;
  }
  const lines = [
    "OpenClaw loaded these user-editable workspace files for the current turn. Codex loads AGENTS.md natively. SOUL.md, IDENTITY.md, TOOLS.md, and USER.md are provided separately as Codex developer instructions. HEARTBEAT.md is handled by heartbeat collaboration-mode guidance. Those files are not repeated here.",
    "",
    "# Project Context",
    "",
    "The following project context files have been loaded:",
  ];
  lines.push("");
  for (const file of files) {
    lines.push(`## ${file.path}`, "", file.content, "");
  }
  return lines.join("\n").trim();
}

function selectCodexWorkspacePromptContextFiles(
  contextFiles: EmbeddedContextFile[],
): EmbeddedContextFile[] {
  return contextFiles
    .filter((file) => {
      const baseName = getCodexContextFileBasename(file.path);
      return (
        baseName &&
        !CODEX_NATIVE_PROJECT_DOC_BASENAMES.has(baseName) &&
        !CODEX_WORKSPACE_DEVELOPER_CONTEXT_BASENAMES.has(baseName) &&
        baseName !== CODEX_HEARTBEAT_CONTEXT_BASENAME &&
        !isMissingCodexBootstrapContextFile(file)
      );
    })
    .toSorted(compareCodexContextFiles);
}

function selectCodexWorkspaceDeveloperInstructionFiles(
  contextFiles: EmbeddedContextFile[],
): EmbeddedContextFile[] {
  return contextFiles
    .filter((file) => {
      const baseName = getCodexContextFileBasename(file.path);
      return (
        baseName &&
        CODEX_WORKSPACE_DEVELOPER_CONTEXT_BASENAMES.has(baseName) &&
        !isMissingCodexBootstrapContextFile(file) &&
        file.content.trim().length > 0
      );
    })
    .toSorted(compareCodexContextFiles);
}

function renderCodexWorkspaceDeveloperInstructions(
  files: EmbeddedContextFile[],
): string | undefined {
  if (files.length === 0) {
    return undefined;
  }
  const lines = [
    "## OpenClaw Agent Soul",
    "",
    "OpenClaw loaded these workspace instruction files from the active agent workspace. They define who you are, how you work, what tools are available, and the human you work alongside. Internalize and follow them accordingly.",
    "",
  ];
  for (const file of files) {
    lines.push(`### ${file.path}`, "", file.content, "");
  }
  return lines.join("\n").trim();
}

function selectCodexWorkspaceHeartbeatReferenceFiles(
  contextFiles: EmbeddedContextFile[],
): EmbeddedContextFile[] {
  return contextFiles
    .filter((file) => {
      const baseName = getCodexContextFileBasename(file.path);
      return (
        baseName === CODEX_HEARTBEAT_CONTEXT_BASENAME &&
        !isMissingCodexBootstrapContextFile(file) &&
        file.content.trim().length > 0
      );
    })
    .toSorted(compareCodexContextFiles);
}

function renderCodexWorkspaceHeartbeatReference(files: EmbeddedContextFile[]): string | undefined {
  if (files.length === 0) {
    return undefined;
  }
  const lines = [
    "## OpenClaw Heartbeat Workspace",
    "",
    "HEARTBEAT.md exists in the active agent workspace. Read it before proceeding with this heartbeat, then decide what action is appropriate.",
    "",
  ];
  for (const file of files) {
    lines.push(`- ${file.path}`);
  }
  return lines.join("\n").trim();
}

function isMissingCodexBootstrapContextFile(file: EmbeddedContextFile): boolean {
  return file.content.trimStart().startsWith("[MISSING] Expected at:");
}

function remapCodexContextFilePath(params: {
  file: EmbeddedContextFile;
  sourceWorkspaceDir: string;
  targetWorkspaceDir: string;
}): EmbeddedContextFile {
  const relativePath = path.relative(params.sourceWorkspaceDir, params.file.path);
  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
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

function getCodexContextFileDisplayBasename(filePath: string): string {
  return filePath.trim().replaceAll("\\", "/").split("/").pop()?.trim() ?? "";
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

function shouldRetryContextEngineTurnOnFreshCodexThread(params: {
  error: unknown;
  contextEngineActive: boolean;
  thread: CodexAppServerThreadLifecycleBinding;
}): boolean {
  if (!params.contextEngineActive || params.thread.lifecycle.action !== "resumed") {
    return false;
  }
  return isCodexContextWindowError(params.error);
}

function isCodexContextWindowError(error: unknown): boolean {
  const message = formatErrorMessage(error);
  return (
    /ran out of room in the model'?s context window/iu.test(message) ||
    /context window/iu.test(message) ||
    /context length/iu.test(message) ||
    /maximum context/iu.test(message) ||
    /too many tokens/iu.test(message)
  );
}

function readCodexNotificationItem(params: JsonValue | undefined): CodexThreadItem | undefined {
  if (!isJsonObject(params) || !isJsonObject(params.item)) {
    return undefined;
  }
  const item = params.item;
  return typeof item.id === "string" && typeof item.type === "string"
    ? (item as CodexThreadItem)
    : undefined;
}

function codexExecutionToolName(item: CodexThreadItem): string | undefined {
  if (item.type === "dynamicToolCall" && typeof item.tool === "string") {
    return item.tool;
  }
  if (item.type === "mcpToolCall" && typeof item.tool === "string") {
    const server = typeof item.server === "string" && item.server ? item.server : undefined;
    return server ? `${server}.${item.tool}` : item.tool;
  }
  if (item.type === "commandExecution") {
    return "bash";
  }
  if (item.type === "fileChange") {
    return "apply_patch";
  }
  if (item.type === "webSearch") {
    return "web_search";
  }
  return undefined;
}

function joinPresentSections(...sections: Array<string | undefined>): string {
  return sections.filter((section): section is string => Boolean(section?.trim())).join("\n\n");
}

function prependCurrentInboundContext(
  prompt: string,
  context: EmbeddedRunAttemptParams["currentInboundContext"],
): string {
  const text = context?.text.trim();
  return text ? [text, prompt].filter(Boolean).join("\n\n") : prompt;
}

function waitForCodexNotificationDispatchTurn(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

function handleApprovalRequest(params: {
  method: string;
  params: JsonValue | undefined;
  paramsForRun: EmbeddedRunAttemptParams;
  threadId: string;
  turnId: string;
  nativeHookRelay?: NativeHookRelayRegistrationHandle;
  signal?: AbortSignal;
}): Promise<JsonValue | undefined> {
  return handleCodexAppServerApprovalRequest({
    method: params.method,
    requestParams: params.params,
    paramsForRun: params.paramsForRun,
    threadId: params.threadId,
    turnId: params.turnId,
    nativeHookRelay: params.nativeHookRelay,
    signal: params.signal,
  });
}

export const testing = {
  CODEX_DYNAMIC_TOOL_TIMEOUT_MS,
  CODEX_DYNAMIC_TOOL_MAX_TIMEOUT_MS,
  CODEX_DYNAMIC_IMAGE_TOOL_TIMEOUT_MS,
  CODEX_TURN_COMPLETION_IDLE_TIMEOUT_MS,
  CODEX_TURN_TERMINAL_IDLE_TIMEOUT_MS,
  createCodexSteeringQueue,
  buildCodexNativeHookRelayId,
  buildDeveloperInstructions,
  filterCodexDynamicTools,
  buildDynamicTools,
  addSandboxShellDynamicToolsIfAvailable,
  filterCodexDynamicToolsForAllowlist,
  filterToolsForVisionInputs,
  hasWildcardCodexToolsAllow,
  handleDynamicToolCallWithTimeout,
  isInvalidCodexImagePayloadError,
  remapCodexContextFilePath,
  resolveDynamicToolCallTimeoutMs,
  resolveCodexDynamicToolsLoading,
  rotateOversizedCodexAppServerStartupBinding,
  resolveCodexAppServerSandboxPolicyForOpenClawSandbox,
  resolveCodexAppServerForOpenClawToolPolicy,
  resolveOpenClawCodingToolsSessionKeys,
  shouldEnableCodexAppServerNativeToolSurface,
  shouldForceMessageTool,
  buildCodexPluginThreadConfigEligibilityLogData,
  setOpenClawCodingToolsFactoryForTests(factory: OpenClawCodingToolsFactory): void {
    openClawCodingToolsFactoryForTests = factory;
  },
  resetOpenClawCodingToolsFactoryForTests(): void {
    openClawCodingToolsFactoryForTests = undefined;
  },
} as const;
export { testing as __testing };
