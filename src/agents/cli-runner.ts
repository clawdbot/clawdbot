/**
 * Top-level CLI-backed agent runner orchestration.
 */
import { setReplyPayloadMetadata, type ReplyPayload } from "../auto-reply/reply-payload.js";
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import { appendExactAssistantMessageToSessionTranscript } from "../config/sessions/transcript.js";
import { buildGenericCliContextEngineHostSupport } from "../context-engine/host-compat.js";
import {
  assertAgentRunLifecycleGenerationCurrent,
  captureAgentRunLifecycleGeneration,
  withAgentRunLifecycleGeneration,
} from "../infra/agent-events.js";
import { hasInternalDiagnosticEventListeners } from "../infra/diagnostic-event-listener-presence.js";
import { areDiagnosticsEnabledForProcess } from "../infra/diagnostic-events.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  buildHandledBeforeAgentReplyPayloads,
  runBeforeAgentReplyForTurn,
} from "../plugins/before-agent-reply.js";
import {
  buildAgentHookContextChannelFields,
  buildAgentHookContextIdentityFields,
} from "../plugins/hook-agent-context.js";
import { resolveBlockMessage } from "../plugins/hook-decision-types.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { isHeartbeatLifecycleRunKind } from "./bootstrap-mode.js";
import {
  resolveCliRuntimeArtifactFingerprint,
  resolveCliRuntimeOwnerFingerprint,
} from "./cli-auth-epoch.js";
import { resolveCliBackendConfig } from "./cli-backends.js";
import type { CliOutput } from "./cli-output.js";
import { shouldUseClaudeLiveSession } from "./cli-runner/claude-live-session.js";
import {
  attachCliMessagingDeliveryEvidence,
  getCliMessagingDeliveryEvidence,
} from "./cli-runner/delivery-evidence.js";
import { cliBackendLog, formatCliBackendOutputDigest } from "./cli-runner/log.js";
import { hashCliReseedPrompt } from "./cli-runner/reseed-envelope.js";
import {
  runClaudeCliAgentTurnWithDiagnostics,
  type ClaudeCliRunDiagnosticLifecycle,
} from "./cli-runner/run-diagnostics.js";
import {
  loadCliSessionContextEngineMessages,
  loadCliSessionHistoryMessages,
} from "./cli-runner/session-history.js";
import type {
  CliReusableSession,
  PreparedCliRunContext,
  RunCliAgentParams,
} from "./cli-runner/types.js";
import { claudeCliSessionTranscriptHasContent as claudeCliSessionTranscriptHasContentImpl } from "./command/attempt-execution.helpers.js";
import { classifyFailoverReason, isFailoverErrorMessage } from "./embedded-agent-helpers.js";
import type { EmbeddedAgentRunResult } from "./embedded-agent-runner.js";
import { waitForDeferredTurnMaintenanceForSession } from "./embedded-agent-runner/context-engine-maintenance.js";
import { buildEmbeddedRunPayloads } from "./embedded-agent-runner/run/payloads.js";
import { FailoverError, isFailoverError, resolveFailoverStatus } from "./failover-error.js";
import {
  awaitAgentEndSideEffects,
  runAgentEndSideEffects,
} from "./harness/agent-end-side-effects.js";
import {
  bootstrapHarnessContextEngine,
  finalizeHarnessContextEngineTurn,
  runHarnessContextEngineMaintenance,
} from "./harness/context-engine-lifecycle.js";
import { buildAgentHookContext } from "./harness/hook-context.js";
import { runAgentHarnessBeforeMessageWriteHook } from "./harness/hook-helpers.js";
import { buildAgentHookConversationMessages } from "./harness/hook-history.js";
import {
  runAgentHarnessLlmInputHook,
  runAgentHarnessLlmOutputHook,
} from "./harness/lifecycle-hook-helpers.js";
import type { AgentMessage } from "./runtime/index.js";
import { SessionManager } from "./sessions/session-manager.js";
import { buildAssistantMessage, buildUsageWithNoCost } from "./stream-message-shared.js";

const log = createSubsystemLogger("agents/cli-runner");

const cliRunnerDeps = {
  claudeCliSessionTranscriptHasContent: claudeCliSessionTranscriptHasContentImpl,
  delay: async (delayMs: number) => {
    await new Promise((resolve) => {
      setTimeout(resolve, delayMs);
    });
  },
};

/** Overrides top-level CLI runner dependencies for tests. */
export function setCliRunnerTestDeps(overrides: Partial<typeof cliRunnerDeps>): void {
  Object.assign(cliRunnerDeps, overrides);
}

/** Restores default top-level CLI runner dependencies after tests. */
export function restoreCliRunnerTestDeps(): void {
  cliRunnerDeps.claudeCliSessionTranscriptHasContent = claudeCliSessionTranscriptHasContentImpl;
  cliRunnerDeps.delay = async (delayMs: number) => {
    await new Promise((resolve) => {
      setTimeout(resolve, delayMs);
    });
  };
}

function isClaudeCliProvider(provider: string): boolean {
  return provider.trim().toLowerCase() === "claude-cli";
}

function resolveReusableCliSessionId(reusableCliSession: CliReusableSession): string | undefined {
  return reusableCliSession.mode === "reuse" || reusableCliSession.mode === "reuse-with-drift"
    ? reusableCliSession.sessionId
    : undefined;
}

function shouldRetryFreshCliSessionAfterFailover(params: {
  error: FailoverError;
  hasHistoryPrompt: boolean;
}): boolean {
  if (!params.hasHistoryPrompt) {
    return false;
  }
  switch (params.error.reason) {
    case "session_expired":
      return true;
    case "unknown":
      return params.error.code === "cli_unknown_empty_failure";
    case "empty_response":
      return params.error.code === "cli_unknown_empty_failure";
    case "timeout":
      return params.error.code === "cli_no_output_timeout";
    case "context_overflow":
      return params.error.code === "cli_context_overflow";
    default:
      return false;
  }
}

function formatCliEmptyOutputDiagnostics(output: CliOutput): string | undefined {
  const process = output.diagnostics?.process;
  if (!process) {
    return undefined;
  }
  return [
    `backend=${process.backendId}`,
    `reason=${process.processReason}`,
    `exitCode=${process.exitCode ?? "null"}`,
    `exitSignal=${process.exitSignal ?? "null"}`,
    `durationMs=${process.durationMs}`,
    `stdoutBytes=${process.stdoutBytes}`,
    `stdoutHash=${process.stdoutHash}`,
    `stderrBytes=${process.stderrBytes}`,
    `stderrHash=${process.stderrHash}`,
    `useResume=${process.useResume ? "true" : "false"}`,
  ].join(" ");
}

/** Checks whether a Claude CLI session binding has reached its transcript file. */
export async function isCliBindingFlushed(
  sessionId: string | undefined,
  provider: string | undefined,
  workspaceDir?: string,
  options?: { skipTranscriptProbe?: boolean },
): Promise<boolean> {
  if (!provider || !isClaudeCliProvider(provider)) {
    return true;
  }
  if (!sessionId) {
    return false;
  }
  // Warm-stdin sessions keep continuity in the managed stdio child and do not
  // write native transcripts. Probing them would always clear a valid binding.
  if (options?.skipTranscriptProbe) {
    return true;
  }
  for (const delayMs of [0, 50, 150]) {
    if (delayMs > 0) {
      await cliRunnerDeps.delay(delayMs);
    }
    if (await cliRunnerDeps.claudeCliSessionTranscriptHasContent({ sessionId, workspaceDir })) {
      return true;
    }
  }
  return false;
}

function flushSessionManagerTranscript(sessionManager: SessionManager): void {
  (
    sessionManager as unknown as {
      replacePersistedTranscript?: () => void;
    }
  ).replacePersistedTranscript?.();
}

async function assertSuccessfulCliRuntimeBindingCurrent(
  context: PreparedCliRunContext,
): Promise<void> {
  if (!context.runtimeArtifactFingerprint) {
    return;
  }
  const currentArtifact = await resolveCliRuntimeArtifactFingerprint({
    provider: context.params.provider,
    config: context.params.config ?? context.contextEngineConfig,
    agentId: context.params.agentId,
    runtimeArtifactId: context.backendResolved.id,
  });
  if (currentArtifact !== context.runtimeArtifactFingerprint) {
    throw new Error("CLI executable/package artifact changed during successful inference");
  }
  if (!context.runtimeOwnerFingerprint) {
    return;
  }
  const currentOwner = await resolveCliRuntimeOwnerFingerprint({
    provider: context.params.provider,
    config: context.params.config ?? context.contextEngineConfig,
    ...(context.agentDir ? { agentDir: context.agentDir } : {}),
    agentId: context.params.agentId,
    runtimeOwnerId: context.backendResolved.id,
    ...(context.effectiveAuthProfileId ? { authProfileId: context.effectiveAuthProfileId } : {}),
    ...(context.authBindingSkipsLocalCredential ? { skipLocalCredential: true } : {}),
    runtimeArtifactFingerprint: currentArtifact,
  });
  if (currentOwner !== context.runtimeOwnerFingerprint) {
    throw new Error("CLI runtime owner changed during successful inference");
  }
}

function buildCliHookUserMessage(prompt: string): unknown {
  return {
    role: "user",
    content: prompt,
    timestamp: Date.now(),
  };
}

function buildCliHookAssistantMessage(params: {
  text: string;
  provider: string;
  model: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
}): unknown {
  return {
    role: "assistant",
    content: [{ type: "text", text: params.text }],
    api: "responses",
    provider: params.provider,
    model: params.model,
    ...(params.usage ? { usage: params.usage } : {}),
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function isAgentMessage(value: unknown): value is AgentMessage {
  return Boolean(value && typeof value === "object" && "role" in value);
}

function buildCliContextEngineUserMessage(prompt: string): AgentMessage {
  return {
    role: "user",
    content: prompt,
    timestamp: Date.now(),
  } as AgentMessage;
}

function buildCliContextEngineAssistantMessage(params: {
  text: string;
  provider: string;
  model: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
}): AgentMessage {
  return buildCliHookAssistantMessage(params) as AgentMessage;
}

type CliAgentEndHookParams = Parameters<typeof runAgentEndSideEffects>[0];

function shouldAwaitCliAgentEndHook(params: RunCliAgentParams): boolean {
  return !params.messageChannel && !params.messageProvider;
}

async function runCliAgentEndHook(
  params: RunCliAgentParams,
  hookParams: CliAgentEndHookParams,
): Promise<void> {
  if (shouldAwaitCliAgentEndHook(params)) {
    await awaitAgentEndSideEffects(hookParams);
    return;
  }
  runAgentEndSideEffects(hookParams);
}

async function persistApprovedCliUserTurnTranscript(params: RunCliAgentParams): Promise<boolean> {
  const recorder = params.userTurnTranscriptRecorder;
  const reusingPersistedTurn = params.suppressNextUserMessagePersistence === true;
  if (!recorder || (reusingPersistedTurn && !recorder.hasPersisted())) {
    return recorder?.isBlocked() === true;
  }

  const persisted = await recorder.persistApproved({
    cwd: params.cwd ?? params.workspaceDir,
  });
  if (!persisted && !recorder.hasPersisted() && (await recorder.resolveMessage())) {
    // A prepared user row can be rejected by before_message_write. Preserve
    // that terminal decision so outer transcript mirrors do not retry it.
    recorder.markBlocked();
  }
  if (persisted && !reusingPersistedTurn) {
    try {
      const notification = params.onUserMessagePersisted?.(persisted.message);
      if (notification) {
        void Promise.resolve(notification).catch((error: unknown) => {
          log.warn(`CLI user turn persistence notification failed: ${formatErrorMessage(error)}`);
        });
      }
    } catch (error) {
      log.warn(`CLI user turn persistence notification failed: ${formatErrorMessage(error)}`);
    }
  }
  return persisted !== undefined || recorder.hasPersisted() || recorder.isBlocked();
}

async function persistCliAssistantTranscript(params: {
  runParams: RunCliAgentParams;
  text: string;
  modelId: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
}): Promise<boolean> {
  const { runParams } = params;
  if (!runParams.persistAssistantTranscript || !runParams.sessionKey || !params.text) {
    return false;
  }
  if (runParams.currentInboundEventKind === "room_event") {
    return true;
  }
  try {
    const result = await appendExactAssistantMessageToSessionTranscript({
      sessionKey: runParams.sessionKey,
      agentId: runParams.agentId,
      expectedSessionId: runParams.sessionId,
      storePath: runParams.storePath,
      idempotencyKey: `cli-assistant:${runParams.runId}`,
      config: runParams.config,
      beforeMessageWrite: runAgentHarnessBeforeMessageWriteHook,
      message: buildAssistantMessage({
        model: {
          api: "cli",
          provider: runParams.provider,
          id: params.modelId,
        },
        content: [{ type: "text", text: params.text }],
        stopReason: "stop",
        usage: buildUsageWithNoCost({
          input: params.usage?.input,
          output: params.usage?.output,
          cacheRead: params.usage?.cacheRead,
          cacheWrite: params.usage?.cacheWrite,
          totalTokens: params.usage?.total,
        }),
      }),
    });
    if (!result.ok) {
      log.warn(`CLI assistant transcript persistence skipped: ${result.reason}`);
      return result.code === "blocked" || result.code === "session-rebound";
    }
    return true;
  } catch (error) {
    log.warn(`CLI assistant transcript persistence failed: ${formatErrorMessage(error)}`);
    return false;
  }
}

async function notifyCliUserMessagePersisted(
  params: RunCliAgentParams,
  message: Extract<AgentMessage, { role: "user" }>,
  context: string,
): Promise<void> {
  try {
    await Promise.resolve(params.onUserMessagePersisted?.(message));
  } catch (err) {
    log.warn(`${context} notification failed: ${formatErrorMessage(err)}`);
  }
}

async function finalizeCliContextEngineTurn(params: {
  context: PreparedCliRunContext;
  historyMessages: unknown[];
  assistantText: string;
  output: Awaited<
    ReturnType<typeof import("./cli-runner/execute.runtime.js").executePreparedCliRun>
  >;
}): Promise<void> {
  const { context } = params;
  if (!context.contextEngine) {
    return;
  }

  const { params: runParams } = context;
  const prePromptMessages = params.historyMessages.filter(isAgentMessage);
  const turnMessages: AgentMessage[] = [];
  if (context.contextEngineTurnPrompt) {
    turnMessages.push(buildCliContextEngineUserMessage(context.contextEngineTurnPrompt));
  }
  if (params.assistantText) {
    turnMessages.push(
      buildCliContextEngineAssistantMessage({
        text: params.assistantText,
        provider: runParams.provider,
        model: context.modelId,
        usage: params.output.usage,
      }),
    );
  }

  let deferredTurnMaintenance: Promise<void> | undefined;
  const contextEngineHostSupport = buildGenericCliContextEngineHostSupport({
    backendId: context.backendResolved.id,
  });
  const result = await finalizeHarnessContextEngineTurn({
    contextEngine: context.contextEngine,
    promptError: false,
    aborted: runParams.abortSignal?.aborted === true,
    yieldAborted: false,
    sessionIdUsed: runParams.sessionId,
    sessionKey: runParams.sessionKey,
    sessionFile: runParams.sessionFile,
    isHeartbeat: isHeartbeatLifecycleRunKind(runParams.bootstrapContextRunKind),
    messagesSnapshot: [...prePromptMessages, ...turnMessages],
    prePromptMessageCount: prePromptMessages.length,
    config: context.contextEngineConfig,
    contextEngineHostSupport,
    providerId: runParams.provider,
    modelId: context.modelId,
    runMaintenance: async (maintenanceParams) =>
      await runHarnessContextEngineMaintenance({
        ...maintenanceParams,
        onDeferredMaintenance: (promise) => {
          deferredTurnMaintenance = promise;
        },
      }),
    warn: (message) => log.warn(message),
  });
  if (result.postTurnFinalizationSucceeded && deferredTurnMaintenance) {
    context.contextEngineDeferredTurnMaintenance = deferredTurnMaintenance;
  }
}

/** Prepares and runs one CLI-backed agent turn. */
export function runCliAgent(paramsInput: RunCliAgentParams): Promise<EmbeddedAgentRunResult> {
  const lifecycleGeneration =
    paramsInput.lifecycleGeneration ?? captureAgentRunLifecycleGeneration(paramsInput.runId);
  const params = {
    ...paramsInput,
    lifecycleGeneration,
  };
  // Observability services register before turns and keep subscriptions process-stable.
  // Snapshot listener presence here so disabled installs pay no synthetic trace cost.
  return withAgentRunLifecycleGeneration(lifecycleGeneration, () =>
    isClaudeCliProvider(params.provider) &&
    areDiagnosticsEnabledForProcess() &&
    hasInternalDiagnosticEventListeners()
      ? runClaudeCliAgentTurnWithDiagnostics(params, (diagnosticLifecycle) =>
          runCliAgentInternal(params, diagnosticLifecycle),
        )
      : runCliAgentInternal(params),
  );
}

async function runCliAgentInternal(
  params: RunCliAgentParams,
  diagnosticLifecycle?: ClaudeCliRunDiagnosticLifecycle,
): Promise<EmbeddedAgentRunResult> {
  assertAgentRunLifecycleGenerationCurrent(params.lifecycleGeneration!);
  // The hook gate must fire before prepareCliRunContext — that call allocates
  // backend resources released only by runPreparedCliAgent's try…finally.
  params.onExecutionStarted?.();
  const hookStartedAt = Date.now();
  const hookResult = await runBeforeAgentReplyForTurn({
    runId: params.runId,
    trigger: params.trigger,
    event: { cleanedBody: params.prompt },
    context: {
      runId: params.runId,
      jobId: params.jobId,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      workspaceDir: params.workspaceDir,
      trigger: params.trigger,
      ...buildAgentHookContextChannelFields(params),
      ...buildAgentHookContextIdentityFields({
        trigger: params.trigger,
        senderId: params.senderId,
        chatId: params.chatId,
        channelContext: params.channelContext,
      }),
    },
    onDispatch: () =>
      params.onExecutionPhase?.({
        phase: "before_agent_reply",
        provider: params.provider,
        model: params.model ?? "",
      }),
    onDeclined: () =>
      params.onExecutionPhase?.({
        phase: "runtime_plugins",
        provider: params.provider,
        model: params.model ?? "",
      }),
  });
  if (hookResult?.handled) {
    const finalText = hookResult.reply?.text ?? SILENT_REPLY_TOKEN;
    const syntheticBackend = resolveCliBackendConfig(params.provider, params.config, {
      agentId: params.agentId,
    });
    const sessionBindingDisabled = syntheticBackend?.config.sessionMode === "none";
    cliBackendLog.info(
      `cli synthetic turn: provider=${params.provider} model=<synthetic> requestedModel=${params.model ?? ""} durationMs=${Date.now() - hookStartedAt} ${formatCliBackendOutputDigest(finalText)}`,
    );
    return {
      payloads: buildHandledBeforeAgentReplyPayloads(hookResult.reply),
      meta: {
        durationMs: Date.now() - hookStartedAt,
        agentMeta: {
          sessionId: "",
          provider: params.provider,
          model: params.model ?? "",
          ...(sessionBindingDisabled ? { clearCliSessionBinding: true } : {}),
        },
        finalAssistantVisibleText: finalText,
        finalAssistantRawText: finalText,
      },
    };
  }
  const { prepareCliRunContext } = await import("./cli-runner/prepare.runtime.js");
  const context = await prepareCliRunContext(params);
  let result: EmbeddedAgentRunResult | undefined;
  let runError: unknown;
  try {
    result = await runPreparedCliAgent(context, diagnosticLifecycle);
  } catch (error) {
    runError = error;
  }
  let cleanupError: unknown;
  const recordCleanupError = (error: unknown) => {
    cleanupError ??= error;
  };
  if (params.cleanupCliLiveSessionOnRunEnd === true) {
    try {
      const { closeClaudeLiveSessionForContext } =
        await import("./cli-runner/claude-live-session.js");
      await closeClaudeLiveSessionForContext(context);
    } catch (error) {
      recordCleanupError(error);
    }
  }
  if (params.cleanupBundleMcpOnRunEnd === true) {
    try {
      const { closeMcpLoopbackServer } = await import("../gateway/mcp-http.js");
      await closeMcpLoopbackServer();
    } catch (error) {
      recordCleanupError(error);
    }
  }
  if (cleanupError) {
    if (runError || result?.didSendViaMessagingTool === true) {
      log.warn(`cli run cleanup failed after completion: ${formatErrorMessage(cleanupError)}`);
    } else {
      diagnosticLifecycle?.setPhase("cleanup");
      runError =
        cleanupError instanceof Error ? cleanupError : new Error(formatErrorMessage(cleanupError));
    }
  }
  if (runError) {
    throw runError instanceof Error ? runError : new Error(formatErrorMessage(runError));
  }
  return result as EmbeddedAgentRunResult;
}

/** Runs an already-prepared CLI agent context through hooks and execution. */
export async function runPreparedCliAgent(
  context: PreparedCliRunContext,
  diagnosticLifecycle?: ClaudeCliRunDiagnosticLifecycle,
): Promise<EmbeddedAgentRunResult> {
  const { executePreparedCliRun } = await import("./cli-runner/execute.runtime.js");
  const { params } = context;
  const sessionBindingDisabled = context.preparedBackend.backend.sessionMode === "none";
  const preparedContextAgentMeta =
    isClaudeCliProvider(params.provider) && context.contextWindowInfo
      ? { contextTokens: context.contextWindowInfo.tokens }
      : {};
  const hookRunner = getGlobalHookRunner();
  const hasLlmInputHooks = hookRunner?.hasHooks("llm_input") === true;
  const hasLlmOutputHooks = hookRunner?.hasHooks("llm_output") === true;
  const hasAgentEndHooks = hookRunner?.hasHooks("agent_end") === true;
  const hasBeforeAgentRunHooks = hookRunner?.hasHooks("before_agent_run") === true;
  const needsHookHistory = hasLlmInputHooks || hasAgentEndHooks || hasBeforeAgentRunHooks;
  // Prior turn maintenance can rewrite transcript entries after finalization.
  // Reads for the next same-session inference must observe that rewrite.
  await waitForDeferredTurnMaintenanceForSession(params.sessionKey ?? params.sessionId);
  const historyMessages = needsHookHistory
    ? await loadCliSessionHistoryMessages({
        sessionId: params.sessionId,
        sessionFile: params.sessionFile,
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        config: params.config,
      })
    : [];
  const llmInputEvent = {
    runId: params.runId,
    sessionId: params.sessionId,
    provider: params.provider,
    model: context.modelId,
    systemPrompt: context.systemPrompt,
    prompt: params.prompt,
    historyMessages,
    imagesCount: params.images?.length ?? 0,
  } as const;
  const hookContext = {
    runId: params.runId,
    jobId: params.jobId,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    workspaceDir: params.workspaceDir,
    trigger: params.trigger,
    ...(params.config ? { config: params.config } : {}),
    ...(context.contextWindowInfo?.tokens
      ? { contextTokenBudget: context.contextWindowInfo.tokens }
      : {}),
    ...(context.contextWindowInfo?.source
      ? { contextWindowSource: context.contextWindowInfo.source }
      : {}),
    ...(context.contextWindowInfo?.referenceTokens
      ? { contextWindowReferenceTokens: context.contextWindowInfo.referenceTokens }
      : {}),
    ...buildAgentHookContextChannelFields(params),
    ...buildAgentHookContextIdentityFields({
      trigger: params.trigger,
      senderId: params.senderId,
      chatId: params.chatId,
      channelContext: params.channelContext,
    }),
  } as const;

  const buildAgentEndMessages = (lastAssistant?: unknown): unknown[] => [
    ...buildAgentHookConversationMessages({
      historyMessages,
      currentTurnMessages: [
        buildCliHookUserMessage(params.prompt),
        ...(lastAssistant ? [lastAssistant] : []),
      ],
    }),
  ];

  const buildFailedAgentEndEvent = (error: string) => ({
    messages: buildAgentEndMessages(),
    success: false,
    error,
    durationMs: Date.now() - context.started,
  });

  const buildBlockedAgentEndEvent = (message: string) => ({
    messages: buildAgentHookConversationMessages({
      historyMessages,
      currentTurnMessages: [buildCliHookUserMessage(message)],
    }),
    success: false,
    error: message,
    durationMs: Date.now() - context.started,
  });

  const buildBlockedBeforeAgentRunResult = (message: string): EmbeddedAgentRunResult => ({
    payloads: [{ text: message, isError: true }],
    meta: {
      durationMs: Date.now() - context.started,
      finalAssistantVisibleText: message,
      finalAssistantRawText: message,
      livenessState: "blocked",
      error: {
        kind: "hook_block",
        message,
      },
      systemPromptReport: context.systemPromptReport,
      executionTrace: {
        winnerProvider: params.provider,
        winnerModel: context.modelId,
        attempts: [
          {
            provider: params.provider,
            model: context.modelId,
            result: "error",
            reason: "before_agent_run blocked the run",
          },
        ],
        fallbackUsed: false,
        runner: "cli",
      },
      requestShaping: {
        ...(params.thinkLevel ? { thinking: params.thinkLevel } : {}),
        ...(context.effectiveAuthProfileId ? { authMode: "auth-profile" } : {}),
      },
      completion: {
        finishReason: "blocked",
        stopReason: "blocked",
        refusal: true,
      },
      agentMeta: {
        sessionId: params.sessionId ?? "",
        provider: params.provider,
        model: context.modelId,
        ...preparedContextAgentMeta,
        ...(sessionBindingDisabled ? { clearCliSessionBinding: true } : {}),
      },
    },
  });

  let deliveredMessagingSideEffect = false;
  let userTurnHandled = false;
  const buildCliSourceReplyMirrorPayloads = (
    evidence: Pick<
      CliOutput,
      | "didSendViaMessagingTool"
      | "didDeliverSourceReplyViaMessageTool"
      | "messagingToolSourceReplyPayloads"
    >,
  ): ReplyPayload[] => {
    return buildEmbeddedRunPayloads({
      assistantTexts: [],
      toolMetas: [],
      lastAssistant: undefined,
      inlineToolResultsAllowed: false,
      sessionKey: params.sessionKey ?? "",
      provider: params.provider,
      model: context.modelId,
      didSendViaMessagingTool: evidence.didSendViaMessagingTool,
      didDeliverSourceReplyViaMessageTool: evidence.didDeliverSourceReplyViaMessageTool,
      messagingToolSourceReplyPayloads: evidence.messagingToolSourceReplyPayloads,
      sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
      agentId: params.agentId,
      runId: params.runId,
    });
  };

  const resolveCliSourceReplyMirror = (
    evidence: Pick<
      CliOutput,
      | "didSendViaMessagingTool"
      | "didDeliverSourceReplyViaMessageTool"
      | "messagingToolSourceReplyPayloads"
    >,
  ) => {
    const payloads = buildCliSourceReplyMirrorPayloads(evidence);
    const delivered =
      payloads.length > 0 ||
      (params.sourceReplyDeliveryMode === "message_tool_only" &&
        evidence.didDeliverSourceReplyViaMessageTool === true);
    const visibleText =
      payloads
        .map((payload) => payload.text?.trim() ?? "")
        .filter(Boolean)
        .join("\n\n") || undefined;
    return { payloads, delivered, visibleText };
  };

  const buildDeliveredFailureResult = (
    error: unknown,
    evidence: NonNullable<ReturnType<typeof getCliMessagingDeliveryEvidence>>,
  ): EmbeddedAgentRunResult => {
    const message = formatErrorMessage(error);
    const { payloads } = resolveCliSourceReplyMirror(evidence);
    deliveredMessagingSideEffect = true;
    return {
      ...(payloads.length > 0 ? { payloads } : {}),
      meta: {
        durationMs: Date.now() - context.started,
        systemPromptReport: context.systemPromptReport,
        stopReason: "error",
        executionTrace: {
          winnerProvider: params.provider,
          winnerModel: context.modelId,
          attempts: [
            {
              provider: params.provider,
              model: context.modelId,
              result: "error",
              reason: message,
            },
          ],
          fallbackUsed: false,
          runner: "cli",
        },
        requestShaping: {
          ...(params.thinkLevel ? { thinking: params.thinkLevel } : {}),
          ...(context.effectiveAuthProfileId ? { authMode: "auth-profile" } : {}),
        },
        completion: {
          finishReason: "error",
          stopReason: "error",
          refusal: false,
        },
        agentMeta: {
          sessionId: "",
          provider: params.provider,
          model: context.modelId,
          ...preparedContextAgentMeta,
          ...(sessionBindingDisabled || resolveReusableCliSessionId(context.reusableCliSession)
            ? { clearCliSessionBinding: true }
            : {}),
        },
      },
      didSendViaMessagingTool: true,
      ...(evidence.didDeliverSourceReplyViaMessageTool
        ? { didDeliverSourceReplyViaMessageTool: true }
        : {}),
      ...(evidence.messagingToolSentTexts?.length
        ? { messagingToolSentTexts: evidence.messagingToolSentTexts }
        : {}),
      ...(evidence.messagingToolSentMediaUrls?.length
        ? { messagingToolSentMediaUrls: evidence.messagingToolSentMediaUrls }
        : {}),
      ...(evidence.messagingToolSentTargets?.length
        ? { messagingToolSentTargets: evidence.messagingToolSentTargets }
        : {}),
      ...(evidence.messagingToolSourceReplyPayloads?.length
        ? { messagingToolSourceReplyPayloads: evidence.messagingToolSourceReplyPayloads }
        : {}),
    };
  };

  const persistBlockedBeforeAgentRun = async (block: {
    message: string;
    pluginId: string;
  }): Promise<void> => {
    const nowMs = Date.now();
    const redactedUserMessage = {
      role: "user" as const,
      content: [{ type: "text" as const, text: block.message }],
      timestamp: nowMs,
      idempotencyKey: `hook-block:before_agent_run:user:${params.runId}`,
      __openclaw: {
        beforeAgentRunBlocked: {
          blockedBy: block.pluginId,
          blockedAt: nowMs,
        },
      },
    };
    try {
      const persisted =
        await params.userTurnTranscriptRecorder?.persistBlocked(redactedUserMessage);
      if (persisted) {
        await notifyCliUserMessagePersisted(
          params,
          persisted.message,
          "before_agent_run block user-turn persistence",
        );
        return;
      }
    } catch (err) {
      log.warn(
        `before_agent_run block: failed to persist canonical CLI user message: ${formatErrorMessage(
          err,
        )}`,
      );
    }

    try {
      const sessionManager = SessionManager.open(params.sessionFile);
      sessionManager.appendMessage(
        redactedUserMessage as Parameters<typeof sessionManager.appendMessage>[0],
      );
      flushSessionManagerTranscript(sessionManager);
    } catch (err) {
      log.warn(
        `before_agent_run block: failed to persist redacted CLI user message: ${formatErrorMessage(
          err,
        )}`,
      );
    }
  };

  const toCliRunFailure = (error: unknown): never => {
    if (isFailoverError(error)) {
      throw error;
    }
    const message = formatErrorMessage(error);
    if (isFailoverErrorMessage(message, { provider: params.provider })) {
      const reason = classifyFailoverReason(message, { provider: params.provider }) ?? "unknown";
      const status = resolveFailoverStatus(reason);
      throw new FailoverError(message, {
        reason,
        provider: params.provider,
        model: context.modelId,
        sessionId: params.sessionId,
        lane: params.lane,
        status,
      });
    }
    throw error;
  };

  const executeCliAttempt = async (cliSessionIdToUse?: string, timeoutMs = params.timeoutMs) => {
    const attemptContext =
      timeoutMs === params.timeoutMs
        ? context
        : {
            ...context,
            params: {
              ...context.params,
              timeoutMs,
            },
          };
    diagnosticLifecycle?.setPhase("send");
    const output = await executePreparedCliRun(
      attemptContext,
      cliSessionIdToUse,
      diagnosticLifecycle ? { onPhase: diagnosticLifecycle.setPhase } : undefined,
    );
    // Test facades and non-instrumented executors may not signal the boundary.
    diagnosticLifecycle?.setPhase("resolve");
    const sourceReplyMirror = resolveCliSourceReplyMirror(output);
    const assistantText = sourceReplyMirror.delivered
      ? (sourceReplyMirror.visibleText ?? "")
      : output.text.trim();
    if (
      !assistantText &&
      !output.didSendViaMessagingTool &&
      params.allowEmptyAssistantReplyAsSilent !== true
    ) {
      const emptyOutputDiagnostics = formatCliEmptyOutputDiagnostics(output);
      if (emptyOutputDiagnostics) {
        cliBackendLog.warn(`cli empty response diagnostics: ${emptyOutputDiagnostics}`);
      }
      throw attachCliMessagingDeliveryEvidence(
        new FailoverError("CLI backend returned an empty response.", {
          reason: "empty_response",
          provider: params.provider,
          model: context.modelId,
          sessionId: params.sessionId,
          lane: params.lane,
        }),
        output,
      );
    }
    const assistantTexts = assistantText ? [assistantText] : [];
    const lastAssistant =
      assistantText.length > 0
        ? buildCliHookAssistantMessage({
            text: assistantText,
            provider: params.provider,
            model: context.modelId,
            usage: output.usage,
          })
        : undefined;
    if (assistantText.length > 0 && hasLlmOutputHooks) {
      runAgentHarnessLlmOutputHook({
        event: {
          runId: params.runId,
          sessionId: params.sessionId,
          provider: params.provider,
          model: context.modelId,
          ...(context.contextWindowInfo?.tokens
            ? { contextTokenBudget: context.contextWindowInfo.tokens }
            : {}),
          ...(context.contextWindowInfo?.source
            ? { contextWindowSource: context.contextWindowInfo.source }
            : {}),
          ...(context.contextWindowInfo?.referenceTokens
            ? { contextWindowReferenceTokens: context.contextWindowInfo.referenceTokens }
            : {}),
          resolvedRef: `${params.provider}/${context.modelId}`,
          assistantTexts,
          ...(lastAssistant ? { lastAssistant } : {}),
          ...(output.usage ? { usage: output.usage } : {}),
        },
        ctx: hookContext,
        hookRunner,
      });
    }
    return {
      output,
      assistantText,
      lastAssistant,
      sourceReplyWasDelivered: sourceReplyMirror.delivered,
      usedHistoryPrompt:
        cliSessionIdToUse === undefined && context.openClawHistoryPrompt !== undefined,
    };
  };

  const buildCliRunResult = (resultParams: {
    output: Awaited<ReturnType<typeof executePreparedCliRun>>;
    effectiveCliSessionId?: string;
    bindingFlushOk?: boolean;
    assistantTranscriptOwned?: boolean;
    usedHistoryPrompt: boolean;
  }): EmbeddedAgentRunResult => {
    const text = resultParams.output.text?.trim();
    const rawText = resultParams.output.rawText?.trim();
    const sourceReplyMirror = resolveCliSourceReplyMirror(resultParams.output);
    const finalAssistantVisibleText = sourceReplyMirror.delivered
      ? sourceReplyMirror.visibleText
      : text;
    const payloads =
      sourceReplyMirror.payloads.length > 0
        ? sourceReplyMirror.payloads
        : sourceReplyMirror.delivered
          ? undefined
          : text
            ? [
                resultParams.assistantTranscriptOwned
                  ? setReplyPayloadMetadata({ text }, { assistantTranscriptOwned: true })
                  : { text },
              ]
            : params.allowEmptyAssistantReplyAsSilent === true
              ? [{ text: SILENT_REPLY_TOKEN }]
              : undefined;
    if (resultParams.output.didSendViaMessagingTool) {
      deliveredMessagingSideEffect = true;
    }
    const unflushedCliSessionId =
      !sessionBindingDisabled &&
      resultParams.effectiveCliSessionId &&
      resultParams.bindingFlushOk === false
        ? resultParams.effectiveCliSessionId
        : undefined;
    const persistedCliSessionId = sessionBindingDisabled
      ? undefined
      : unflushedCliSessionId
        ? undefined
        : resultParams.effectiveCliSessionId;
    const createdReseedReceipt =
      persistedCliSessionId &&
      resultParams.usedHistoryPrompt &&
      isClaudeCliProvider(params.provider) &&
      resultParams.output.finalPromptText !== undefined &&
      userTurnHandled &&
      params.sessionId
        ? {
            version: 1 as const,
            promptHash: hashCliReseedPrompt(resultParams.output.finalPromptText),
            localSessionId: params.sessionId,
            userTurnDisposition: params.userTurnTranscriptRecorder?.hasPersisted()
              ? ("persisted" as const)
              : ("omitted" as const),
          }
        : undefined;
    const preservedReseedReceipt =
      params.cliSessionBinding && persistedCliSessionId === params.cliSessionBinding.sessionId
        ? params.cliSessionBinding.reseedReceipt
        : undefined;
    const reseedReceipt = createdReseedReceipt ?? preservedReseedReceipt;
    const agentSessionId = sessionBindingDisabled
      ? (params.sessionId ?? "")
      : unflushedCliSessionId
        ? ""
        : (resultParams.effectiveCliSessionId ?? params.sessionId ?? "");
    const yielded = resultParams.output.yielded === true;
    const stopReason = yielded ? "end_turn" : "completed";

    params.onSuccessfulAuthBinding?.({
      ...(context.effectiveAuthProfileId ? { authProfileId: context.effectiveAuthProfileId } : {}),
      ...(context.authBindingFingerprint
        ? { authFingerprint: context.authBindingFingerprint }
        : {}),
      ...(!context.authBindingFingerprint && context.runtimeOwnerFingerprint
        ? {
            runtimeOwnerFingerprint: context.runtimeOwnerFingerprint,
            runtimeOwnerKind: "cli-runtime" as const,
            runtimeOwnerId: context.backendResolved.id,
          }
        : {}),
      ...(context.runtimeArtifactFingerprint
        ? {
            runtimeArtifactFingerprint: context.runtimeArtifactFingerprint,
            runtimeArtifactId: context.backendResolved.id,
          }
        : {}),
      ...(context.authBindingSkipsLocalCredential ? { skipLocalCredential: true } : {}),
    });

    return {
      payloads,
      meta: {
        durationMs: Date.now() - context.started,
        ...(resultParams.output.finalPromptText
          ? { finalPromptText: resultParams.output.finalPromptText }
          : {}),
        ...(finalAssistantVisibleText || rawText
          ? {
              ...(finalAssistantVisibleText ? { finalAssistantVisibleText } : {}),
              ...(rawText ? { finalAssistantRawText: rawText } : {}),
            }
          : {}),
        systemPromptReport: context.systemPromptReport,
        ...(yielded ? { yielded: true, livenessState: "paused" as const, stopReason } : {}),
        executionTrace: {
          winnerProvider: params.provider,
          winnerModel: context.modelId,
          attempts: [
            {
              provider: params.provider,
              model: context.modelId,
              result: "success",
            },
          ],
          fallbackUsed: false,
          runner: "cli",
        },
        requestShaping: {
          ...(params.thinkLevel ? { thinking: params.thinkLevel } : {}),
          ...(context.effectiveAuthProfileId ? { authMode: "auth-profile" } : {}),
        },
        completion: {
          finishReason: yielded ? "end_turn" : "stop",
          stopReason,
          refusal: false,
        },
        agentMeta: {
          sessionId: agentSessionId,
          provider: params.provider,
          model: context.modelId,
          ...preparedContextAgentMeta,
          usage: resultParams.output.usage,
          ...(resultParams.output.usage ? { lastCallUsage: resultParams.output.usage } : {}),
          ...(persistedCliSessionId
            ? {
                cliSessionBinding: {
                  sessionId: persistedCliSessionId,
                  ...(context.effectiveAuthProfileId
                    ? { authProfileId: context.effectiveAuthProfileId }
                    : {}),
                  ...(context.authEpoch ? { authEpoch: context.authEpoch } : {}),
                  authEpochVersion: context.authEpochVersion,
                  ...(context.extraSystemPromptHash
                    ? { extraSystemPromptHash: context.extraSystemPromptHash }
                    : {}),
                  ...(context.messageToolPolicyHash
                    ? { messageToolPolicyHash: context.messageToolPolicyHash }
                    : {}),
                  ...(context.promptToolNamesHash
                    ? { promptToolNamesHash: context.promptToolNamesHash }
                    : {}),
                  ...(context.cwdHash ? { cwdHash: context.cwdHash } : {}),
                  ...(context.preparedBackend.mcpConfigHash
                    ? { mcpConfigHash: context.preparedBackend.mcpConfigHash }
                    : {}),
                  ...(context.preparedBackend.mcpResumeHash
                    ? { mcpResumeHash: context.preparedBackend.mcpResumeHash }
                    : {}),
                  ...(reseedReceipt ? { reseedReceipt } : {}),
                },
              }
            : {}),
          ...(sessionBindingDisabled || unflushedCliSessionId
            ? { clearCliSessionBinding: true }
            : {}),
        },
      },
      ...(resultParams.output.didSendViaMessagingTool ? { didSendViaMessagingTool: true } : {}),
      ...(resultParams.output.didDeliverSourceReplyViaMessageTool
        ? { didDeliverSourceReplyViaMessageTool: true }
        : {}),
      ...(resultParams.output.messagingToolSentTexts?.length
        ? { messagingToolSentTexts: resultParams.output.messagingToolSentTexts }
        : {}),
      ...(resultParams.output.messagingToolSentMediaUrls?.length
        ? { messagingToolSentMediaUrls: resultParams.output.messagingToolSentMediaUrls }
        : {}),
      ...(resultParams.output.messagingToolSentTargets?.length
        ? { messagingToolSentTargets: resultParams.output.messagingToolSentTargets }
        : {}),
      ...(resultParams.output.messagingToolSourceReplyPayloads?.length
        ? { messagingToolSourceReplyPayloads: resultParams.output.messagingToolSourceReplyPayloads }
        : {}),
    };
  };

  const executeRun = async (): Promise<EmbeddedAgentRunResult> => {
    await bootstrapHarnessContextEngine({
      hadSessionFile: context.hadSessionFile,
      contextEngine: context.contextEngine,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      sessionFile: params.sessionFile,
      config: context.contextEngineConfig,
      contextEngineHostSupport: buildGenericCliContextEngineHostSupport({
        backendId: context.backendResolved.id,
      }),
      providerId: params.provider,
      modelId: context.modelId,
      warn: (message) => log.warn(message),
    });
    const contextEngineHistoryMessages = context.contextEngine
      ? await loadCliSessionContextEngineMessages({
          sessionId: params.sessionId,
          sessionFile: params.sessionFile,
          sessionKey: params.sessionKey,
          agentId: params.agentId,
          config: params.config,
        })
      : [];
    const finishCliAttempt = async (
      result: Awaited<ReturnType<typeof executeCliAttempt>>,
      fallbackCliSessionId?: string,
    ) => {
      const { output, assistantText, lastAssistant, sourceReplyWasDelivered, usedHistoryPrompt } =
        result;
      try {
        await assertSuccessfulCliRuntimeBindingCurrent(context);
        const effectiveCliSessionId = output.sessionId ?? fallbackCliSessionId;
        await finalizeCliContextEngineTurn({
          context,
          historyMessages: context.contextEngine ? contextEngineHistoryMessages : historyMessages,
          assistantText,
          output,
        });
        const assistantTranscriptOwned = await persistCliAssistantTranscript({
          runParams: params,
          // Dispatch owns source-reply transcript mirrors and their idempotency keys.
          // Persisting them here would duplicate the same visible assistant reply.
          text: sourceReplyWasDelivered ? "" : assistantText,
          modelId: context.modelId,
          usage: output.usage,
        });
        // A stateless backend may emit an id, but it never becomes continuity.
        // Managed stdio sessions own continuity in-process and write no native transcript.
        const bindingFlushOk = sessionBindingDisabled
          ? true
          : await isCliBindingFlushed(
              effectiveCliSessionId,
              params.provider,
              context.cwd ?? context.workspaceDir,
              { skipTranscriptProbe: shouldUseClaudeLiveSession(context) },
            );
        await runCliAgentEndHook(params, {
          event: {
            messages: buildAgentEndMessages(lastAssistant),
            success: true,
            durationMs: Date.now() - context.started,
          },
          ctx: hookContext,
          hookRunner,
        });
        return buildCliRunResult({
          output,
          effectiveCliSessionId,
          bindingFlushOk,
          assistantTranscriptOwned,
          usedHistoryPrompt,
        });
      } catch (error) {
        throw attachCliMessagingDeliveryEvidence(error, output);
      }
    };

    const finishDeliveredFailure = async (
      error: unknown,
    ): Promise<EmbeddedAgentRunResult | undefined> => {
      const evidence = getCliMessagingDeliveryEvidence(error);
      if (!evidence) {
        return undefined;
      }
      await runCliAgentEndHook(params, {
        event: buildFailedAgentEndEvent(formatErrorMessage(error)),
        ctx: hookContext,
        hookRunner,
      });
      return buildDeliveredFailureResult(error, evidence);
    };

    if (hasBeforeAgentRunHooks && hookRunner) {
      let beforeRunResult:
        | Awaited<ReturnType<NonNullable<typeof hookRunner>["runBeforeAgentRun"]>>
        | undefined;
      try {
        beforeRunResult = await hookRunner.runBeforeAgentRun(
          {
            prompt: params.prompt,
            systemPrompt: context.systemPrompt,
            messages: buildAgentHookConversationMessages({
              historyMessages,
              currentTurnMessages: [],
            }),
            channelId: hookContext.channelId,
            accountId: params.agentAccountId,
            senderId: params.senderId ?? undefined,
            senderIsOwner: params.senderIsOwner ?? undefined,
          },
          buildAgentHookContext(hookContext),
        );
      } catch {
        const blockMessage = resolveBlockMessage(
          { outcome: "block", reason: "before_agent_run hook failed" },
          { blockedBy: "before_agent_run" },
        );
        await persistBlockedBeforeAgentRun({
          message: blockMessage,
          pluginId: "before_agent_run",
        });
        await runCliAgentEndHook(params, {
          event: buildBlockedAgentEndEvent(blockMessage),
          ctx: hookContext,
          hookRunner,
        });
        return buildBlockedBeforeAgentRunResult(blockMessage);
      }

      const beforeRunDecision = beforeRunResult?.decision;
      if (beforeRunDecision?.outcome === "block") {
        const blockMessage = resolveBlockMessage(beforeRunDecision, {
          blockedBy: beforeRunResult?.pluginId ?? "unknown",
        });
        await persistBlockedBeforeAgentRun({
          message: blockMessage,
          pluginId: beforeRunResult?.pluginId ?? "unknown",
        });
        await runCliAgentEndHook(params, {
          event: buildBlockedAgentEndEvent(blockMessage),
          ctx: hookContext,
          hookRunner,
        });
        return buildBlockedBeforeAgentRunResult(blockMessage);
      }
    }

    userTurnHandled = await persistApprovedCliUserTurnTranscript(params);
    runAgentHarnessLlmInputHook({
      event: llmInputEvent,
      ctx: hookContext,
      hookRunner,
    });
    const reusableCliSessionId = resolveReusableCliSessionId(context.reusableCliSession);
    try {
      return await finishCliAttempt(
        await executeCliAttempt(reusableCliSessionId),
        reusableCliSessionId,
      );
    } catch (err) {
      const deliveredFailure = await finishDeliveredFailure(err);
      if (deliveredFailure) {
        return deliveredFailure;
      }
      if (isFailoverError(err)) {
        const retryableSessionId = reusableCliSessionId;
        if (
          shouldRetryFreshCliSessionAfterFailover({
            error: err,
            hasHistoryPrompt: Boolean(context.openClawHistoryPrompt),
          }) &&
          retryableSessionId &&
          params.sessionKey
        ) {
          try {
            const retryTimeoutMs = params.timeoutMs - (Date.now() - context.started);
            if (retryTimeoutMs <= 0) {
              throw err;
            }
            if (params.onBeforeFreshCliSessionRetry) {
              const clearedStaleBinding = await params.onBeforeFreshCliSessionRetry({
                provider: params.provider,
                reason: err.reason,
                sessionId: retryableSessionId,
              });
              if (!clearedStaleBinding) {
                throw err;
              }
            }
            cliBackendLog.warn(
              `cli session recovery retry: provider=${params.provider} reason=${err.reason} sessionKey=${params.sessionKey}`,
            );
            return await finishCliAttempt(await executeCliAttempt(undefined, retryTimeoutMs));
          } catch (retryErr) {
            const deliveredRetryFailure = await finishDeliveredFailure(retryErr);
            if (deliveredRetryFailure) {
              return deliveredRetryFailure;
            }
            const retryMessage = formatErrorMessage(retryErr);
            await runCliAgentEndHook(params, {
              event: buildFailedAgentEndEvent(retryMessage),
              ctx: hookContext,
              hookRunner,
            });
            return toCliRunFailure(retryErr);
          }
        }
        await runCliAgentEndHook(params, {
          event: buildFailedAgentEndEvent(formatErrorMessage(err)),
          ctx: hookContext,
          hookRunner,
        });
        throw err;
      }
      const message = formatErrorMessage(err);
      await runCliAgentEndHook(params, {
        event: buildFailedAgentEndEvent(message),
        ctx: hookContext,
        hookRunner,
      });
      return toCliRunFailure(err);
    }
  };

  let runResult: EmbeddedAgentRunResult | undefined;
  let runError: unknown;
  let runFailed = false;
  try {
    runResult = await executeRun();
  } catch (error) {
    runFailed = true;
    runError = error;
  }
  try {
    await context.preparedBackend.cleanup?.();
  } catch (cleanupError) {
    if (!deliveredMessagingSideEffect) {
      if (runFailed) {
        cliBackendLog.warn(
          `CLI run also failed before backend cleanup: ${formatErrorMessage(runError)}`,
        );
      }
      diagnosticLifecycle?.setPhase("cleanup");
      throw cleanupError;
    }
    cliBackendLog.warn(
      `CLI backend cleanup failed after confirmed message delivery: ${formatErrorMessage(cleanupError)}`,
    );
  }
  if (runFailed) {
    throw runError;
  }
  if (!runResult) {
    throw new Error("CLI run completed without a result");
  }
  return runResult;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
