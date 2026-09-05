import { randomUUID } from "node:crypto";
/**
 * Prepares stream subscription, tool execution, and the active run queue.
 */
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../../../auto-reply/tokens.js";
import { runWithOwnedSessionTranscriptWrite } from "../../../config/sessions/transcript-write-context.js";
import { captureAgentRunLifecycleGeneration } from "../../../infra/agent-events.js";
import {
  freezeDiagnosticTraceContext,
  type DiagnosticTraceContext,
} from "../../../infra/diagnostic-trace-context.js";
import type { AssistantMessage } from "../../../llm/types.js";
import {
  closeDiagnosticEmbeddedRunOwner,
  type DiagnosticEmbeddedRunOwner,
} from "../../../logging/diagnostic-run-activity.js";
import {
  buildAgentHookContextChannelFields,
  buildAgentHookContextIdentityFields,
} from "../../../plugins/hook-agent-context.js";
import { getGlobalHookRunner } from "../../../plugins/hook-runner-global.js";
import { getModelProviderRuntimePluginHandle } from "../../../plugins/provider-hook-runtime.js";
import {
  createNestedToolActivity,
  readNestedToolActivity,
  projectNestedToolActivityForHooks,
  type NestedToolActivity,
} from "../../../sessions/nested-tool-activity.js";
import { raceWithAbortSignal } from "../../agent-tools.abort.js";
import { recordStructuredReplayTrustForToolCall } from "../../agent-tools.before-tool-call.js";
import { subscribeEmbeddedAgentSession } from "../../embedded-agent-subscribe.js";
import { sanitizeToolResult } from "../../embedded-agent-tool-results.js";
import { cancelPendingAgentQuestionForSession } from "../../harness/gateway-question.js";
import { runAgentHarnessBeforeAgentFinalizeHook } from "../../harness/lifecycle-hook-helpers.js";
import {
  AGENT_RUN_RESTART_ABORT_STOP_REASON,
  createAgentRunRestartAbortError,
  createAgentRunSupersededAbortError,
  isAgentRunRestartAbortReason,
} from "../../run-termination.js";
import type { AgentMessage } from "../../runtime/index.js";
import {
  copyInternalToolResultState,
  getInternalToolExecutionPreparer,
} from "../../runtime/internal-hooks.js";
import type { AgentSession } from "../../sessions/index.js";
import type { ToolSearchCatalogToolExecutor } from "../../tool-search.js";
import { redactTranscriptMessage } from "../../transcript-redact.js";
import { log } from "../logger.js";
import {
  ACTIVE_EMBEDDED_RUN_REGISTRATIONS,
  ACTIVE_EMBEDDED_RUNS,
  ACTIVE_EMBEDDED_RUNS_BY_RUN_ID,
  setActiveEmbeddedRunLifecycleGeneration,
} from "../run-state.js";
import {
  clearActiveEmbeddedRun,
  type EmbeddedAgentQueueHandle,
  type EmbeddedAgentQueueMessageOptions,
  setActiveEmbeddedRun,
} from "../runs.js";
import { recordEmbeddedToolReceipt } from "../tool-send-receipts.js";
import {
  requiresCompletionRequiredAsyncTaskWait,
  type AsyncStartedToolMeta,
} from "./attempt-async-tasks.js";
import {
  claimEmbeddedPendingUserInputAnswer,
  steerActiveSessionWithOptionalDeliveryWait,
} from "./attempt-queue-message.js";
import type { EmbeddedAttemptClientToolCallSlot } from "./attempt-result.js";
import {
  createEmbeddedAttemptDeferredLifecycleOwner,
  type EmbeddedAttemptDeferredLifecycleOwner,
} from "./deferred-lifecycle-owner.js";
import {
  resolveFinalAssistantRawText,
  resolveFinalAssistantVisibleText,
  resolveReportedModelRef,
} from "./helpers.js";
import type { EmbeddedRunAttemptInternalParams } from "./internal-params.js";
import { notifyToolActivity } from "./tool-activity-heartbeat.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type HookRunner = ReturnType<typeof getGlobalHookRunner>;
type StreamRunState = {
  aborted: boolean;
  promptError: unknown;
  timedOut: boolean;
  yieldDetected: boolean;
};

type AttemptStreamQueueHandle = EmbeddedAgentQueueHandle & {
  kind: "embedded";
  cancel: (reason?: "user_abort" | "restart" | "superseded") => void;
};

export function prepareEmbeddedAttemptStream(input: {
  attempt: EmbeddedRunAttemptInternalParams;
  applyPermissionMode?: (
    mode: NonNullable<EmbeddedRunAttemptParams["permissionMode"]> | null,
    revokeApprovals: () => void,
  ) => void;
  activeSession: AgentSession;
  runtimeChannel?: string;
  hookRunner: HookRunner;
  hookAgentId: string;
  diagnosticTrace: DiagnosticTraceContext;
  clientToolCallSlots: readonly EmbeddedAttemptClientToolCallSlot[];
  nestedToolActivities: NestedToolActivity[];
  isReplaySafeTool: (tool: Parameters<ToolSearchCatalogToolExecutor>[0]["tool"]) => boolean;
  runAbortController: AbortController;
  abortRun: (isTimeout?: boolean, reason?: unknown) => void;
  markExternalAbort: () => void;
  getRunState: () => StreamRunState;
  hasDeliveredSourceReply: () => boolean;
  markSourceReplyDelivered: () => void;
  onBlockReply: EmbeddedRunAttemptParams["onBlockReply"];
  onBlockReplyFlush: EmbeddedRunAttemptParams["onBlockReplyFlush"];
  sandboxSessionKey: string;
  builtinToolNames: ReadonlySet<string>;
  coreBuiltinToolNames?: ReadonlySet<string>;
  replaySafeToolNames: ReadonlySet<string>;
  codeModeExecToolNames?: ReadonlySet<string>;
  sideEffectToolOwners?: ReadonlyMap<string, string>;
  diagnosticOwner: DiagnosticEmbeddedRunOwner;
  trajectoryRecorder?: Parameters<
    typeof createEmbeddedAttemptDeferredLifecycleOwner
  >[0]["trajectoryRecorder"];
}) {
  const attempt = input.attempt;
  const activityScope = randomUUID();
  let nestedStartOrder = 0;
  const hookRunner = input.hookRunner;
  let beforeAgentFinalizeRevisionReason: string | undefined;
  let beforeAgentFinalizeRevisionEntryId: string | undefined;
  let acceptingSteerMessages = true;
  let activeQueueAdmissions = 0;
  const shouldRunBeforeAgentFinalize =
    attempt.operation !== "settled-tool-finalization" &&
    hookRunner?.hasHooks("before_agent_finalize");
  const onBeforeTerminalDelivery = shouldRunBeforeAgentFinalize
    ? async (event: {
        messages: AgentMessage[];
        willRetry: boolean;
        assistantEntryId?: string;
        lastAssistant?: AgentMessage;
        assistantTexts: readonly string[];
        hasAssistantVisibleText: boolean;
        isError: boolean;
        incompleteTerminalAssistant: boolean;
        hadDeterministicSideEffect: boolean;
      }): Promise<void | { suppressTerminalDelivery: true }> => {
        if (
          beforeAgentFinalizeRevisionReason ||
          event.willRetry ||
          event.isError ||
          event.incompleteTerminalAssistant ||
          !event.hasAssistantVisibleText
        ) {
          return;
        }
        const lastAssistant = event.lastAssistant as AssistantMessage | undefined;
        const lastAssistantMessage =
          normalizeOptionalString(resolveFinalAssistantVisibleText(lastAssistant)) ??
          normalizeOptionalString(resolveFinalAssistantRawText(lastAssistant)) ??
          normalizeOptionalString(event.assistantTexts.join("\n\n"));
        if (!lastAssistantMessage) {
          return;
        }
        const state = input.getRunState();
        const hasCompletedClientToolCall = input.clientToolCallSlots.some((slot) => slot.completed);
        const silentFinalReply =
          attempt.silentExpected && isSilentReplyText(lastAssistantMessage, SILENT_REPLY_TOKEN);
        if (
          state.aborted ||
          state.promptError ||
          state.timedOut ||
          hasCompletedClientToolCall ||
          state.yieldDetected ||
          silentFinalReply
        ) {
          return;
        }
        const hookMessages = projectNestedToolActivityForHooks(
          input.activeSession.messages,
          input.nestedToolActivities,
        );
        const reportedModelRef = resolveReportedModelRef({
          provider: attempt.provider,
          model: attempt.modelId,
          assistant: lastAssistant,
        });
        const maxRevisionAttempts = attempt.maxBeforeAgentFinalizeRevisions ?? 0;
        if (
          maxRevisionAttempts > 0 &&
          (attempt.beforeAgentFinalizeRevisionAttempts ?? 0) >= maxRevisionAttempts
        ) {
          log.warn(
            `before_agent_finalize revision limit reached; finalizing ` +
              `runId=${attempt.runId} sessionId=${attempt.sessionId} ` +
              `attempts=${attempt.beforeAgentFinalizeRevisionAttempts ?? 0}/${maxRevisionAttempts}`,
          );
          return;
        }
        // A queued user message wins over finalization. Close admission before
        // awaiting the hook so no later steer can become a child of the draft.
        acceptingSteerMessages = false;
        if (
          activeQueueAdmissions > 0 ||
          input.activeSession.pendingMessageCount > 0 ||
          input.activeSession.agent.hasQueuedMessages()
        ) {
          acceptingSteerMessages = true;
          return;
        }
        let keepAdmissionClosed = false;
        try {
          const outcome = await runAgentHarnessBeforeAgentFinalizeHook({
            event: {
              runId: attempt.runId,
              sessionId: attempt.sessionId,
              ...(attempt.sessionKey ? { sessionKey: attempt.sessionKey } : {}),
              provider: reportedModelRef.provider,
              model: reportedModelRef.model,
              ...((attempt.cwd ?? attempt.workspaceDir)
                ? { cwd: attempt.cwd ?? attempt.workspaceDir }
                : {}),
              ...(attempt.sessionFile ? { transcriptPath: attempt.sessionFile } : {}),
              stopHookActive: false,
              lastAssistantMessage,
              messages: hookMessages,
            },
            ctx: {
              runId: attempt.runId,
              trace: freezeDiagnosticTraceContext(input.diagnosticTrace),
              agentId: input.hookAgentId,
              sessionKey: attempt.sessionKey,
              sessionId: attempt.sessionId,
              workspaceDir: attempt.workspaceDir,
              modelProviderId: reportedModelRef.provider,
              modelId: reportedModelRef.model,
              trigger: attempt.trigger,
              ...buildAgentHookContextChannelFields(attempt),
              ...buildAgentHookContextIdentityFields({
                trigger: attempt.trigger,
                senderId: attempt.senderId,
                chatId: attempt.chatId,
                channelContext: attempt.channelContext,
              }),
            },
            hookRunner,
          });
          if (outcome.action !== "revise") {
            return;
          }
          if (event.hadDeterministicSideEffect) {
            log.warn(
              `before_agent_finalize requested revision after potential side effects; finalizing ` +
                `runId=${attempt.runId} sessionId=${attempt.sessionId}`,
            );
            return;
          }
          if (!event.assistantEntryId) {
            log.warn(
              `before_agent_finalize revision lacks a persisted assistant entry; finalizing ` +
                `runId=${attempt.runId} sessionId=${attempt.sessionId}`,
            );
            return;
          }
          keepAdmissionClosed = true;
          beforeAgentFinalizeRevisionEntryId = event.assistantEntryId;
          beforeAgentFinalizeRevisionReason = outcome.reason;
          return { suppressTerminalDelivery: true };
        } finally {
          if (!keepAdmissionClosed) {
            acceptingSteerMessages = true;
          }
        }
      }
    : undefined;

  let toolMetasForTerminal: readonly AsyncStartedToolMeta[] = [];
  // Terminal callbacks run after queue construction; keep the queue in this
  // phase so active-run clearing and subscription teardown share one owner.
  const getQueueHandle = (): AttemptStreamQueueHandle => queueHandle;
  let deferredLifecycleOwner: EmbeddedAttemptDeferredLifecycleOwner | undefined;
  const subscription = subscribeEmbeddedAgentSession({
    session: input.activeSession,
    runId: attempt.runId,
    lifecycleGeneration: attempt.lifecycleGeneration,
    messageChannel: input.runtimeChannel,
    initialReplayState: attempt.initialReplayState,
    hookRunner: getGlobalHookRunner() ?? undefined,
    verboseLevel: attempt.verboseLevel,
    reasoningMode: attempt.reasoningLevel ?? "off",
    thinkingLevel: attempt.thinkLevel,
    toolResultFormat: attempt.toolResultFormat,
    toolProgressDetail: attempt.toolProgressDetail,
    shouldEmitToolResult: attempt.shouldEmitToolResult,
    shouldEmitToolOutput: attempt.shouldEmitToolOutput,
    sourceReplyDeliveryMode: attempt.sourceReplyDeliveryMode,
    hasDeliveredMessageToolOnlySourceReply: input.hasDeliveredSourceReply,
    onDeliveredMessageToolOnlySourceReply: input.markSourceReplyDelivered,
    onAgentToolResult: attempt.onAgentToolResult,
    observeToolTerminal: attempt.observeToolTerminal,
    onToolResult: attempt.onToolResult,
    onReasoningStream: attempt.onReasoningStream,
    streamReasoningInNonStreamModes: attempt.streamReasoningInNonStreamModes,
    onReasoningEnd: attempt.onReasoningEnd,
    onBlockReply: input.onBlockReply,
    onBlockReplyFlush: input.onBlockReplyFlush,
    onBeforeTerminalDelivery,
    blockReplyBreak: attempt.blockReplyBreak,
    blockReplyChunking: attempt.blockReplyChunking,
    onPartialReply: attempt.onPartialReply,
    onAssistantMessageStart: attempt.onAssistantMessageStart,
    onExecutionPhase: attempt.onExecutionPhase,
    onAgentEvent: attempt.onAgentEvent,
    onRunUsageTotals: attempt.onRunUsageTotals,
    terminalLifecyclePhase: attempt.deferTerminalLifecycle ? "finishing" : "end",
    onToolStreamBoundary: attempt.onToolStreamBoundary,
    isTerminalAborted: () => input.getRunState().aborted,
    resolveTerminalStopReason: () =>
      isAgentRunRestartAbortReason(input.runAbortController.signal.reason)
        ? AGENT_RUN_RESTART_ABORT_STOP_REASON
        : undefined,
    onBeforeLifecycleTerminal: () => {
      if (deferredLifecycleOwner) {
        return;
      }
      if (
        requiresCompletionRequiredAsyncTaskWait({
          sessionKey: attempt.sessionKey,
          toolMetas: toolMetasForTerminal,
        })
      ) {
        return;
      }
      // Clear embedded-run activity before emitting terminal lifecycle events so
      // post-completion cleanup does not observe a logically finished run as active.
      clearActiveEmbeddedRun(
        attempt.sessionId,
        getQueueHandle(),
        attempt.sessionKey,
        attempt.sessionFile,
      );
    },
    enforceFinalTag: attempt.enforceFinalTag,
    silentExpected: attempt.silentExpected,
    suppressLiveStreamOutput: attempt.suppressLiveStreamOutput,
    config: attempt.config,
    providerOwner: getModelProviderRuntimePluginHandle(attempt.model)?.plugin,
    compactionCountOwner: attempt.compactionCountOwner,
    onContextAccountingEvent: attempt.onContextAccountingEvent,
    sessionPersistence: attempt.sessionPersistence,
    // Live events belong to the transcript session. The sandbox key is only
    // authority context and may intentionally point at a visible parent.
    sessionKey: attempt.sessionKey,
    currentChannelId: attempt.currentChannelId,
    currentMessagingTarget: attempt.currentMessagingTarget,
    currentAccountId: attempt.agentAccountId,
    currentThreadId: attempt.currentThreadTs,
    currentMessageId: attempt.currentMessageId,
    replyToMode: attempt.replyToMode,
    hasRepliedRef: attempt.hasRepliedRef,
    sessionId: attempt.sessionId,
    agentId: input.hookAgentId,
    builtinToolNames: input.builtinToolNames,
    coreBuiltinToolNames: input.coreBuiltinToolNames,
    replaySafeToolNames: input.replaySafeToolNames,
    ...(input.codeModeExecToolNames ? { codeModeExecToolNames: input.codeModeExecToolNames } : {}),
    ...(input.sideEffectToolOwners ? { sideEffectToolOwners: input.sideEffectToolOwners } : {}),
    internalEvents: attempt.internalEvents,
  });
  toolMetasForTerminal = subscription.toolMetas;

  const toolSearchCatalogExecutor: ToolSearchCatalogToolExecutor = async (toolParams) => {
    const runSignal = input.runAbortController.signal;
    const signal = AbortSignal.any([toolParams.signal ?? runSignal, runSignal]);
    const yieldRunSignal = toolParams.toolName === "sessions_yield" ? runSignal : undefined;
    const startedAt = Date.now();
    const startOrder = nestedStartOrder++;
    const manager = input.activeSession.sessionManager;
    const afterEntryId = manager.getAppendParentId();
    if (toolParams.source === "openclaw" && toolParams.sourceName === "core") {
      recordStructuredReplayTrustForToolCall(
        toolParams.toolCallId,
        toolParams.tool as never,
        attempt.runId,
      );
    }
    return await raceWithAbortSignal(
      subscription.runToolLifecycle({
        toolName: toolParams.toolName,
        toolCallId: toolParams.toolCallId,
        args: toolParams.input,
        replaySafe: toolParams.replaySafe ?? input.isReplaySafeTool(toolParams.tool),
        hideFromChannelProgress:
          "hideFromChannelProgress" in toolParams.tool &&
          toolParams.tool.hideFromChannelProgress === true,
        onTerminal: async (terminal) => {
          const message = {
            ...createNestedToolActivity({
              runId: attempt.runId,
              scopeId: activityScope,
              afterEntryId,
              startOrder,
              parentToolCallId: toolParams.parentToolCallId,
              toolCallId: toolParams.toolCallId,
              toolName: toolParams.toolName,
              input: terminal.executedArguments,
              result: sanitizeToolResult(terminal.result),
              isError: terminal.isError,
              startedAt,
              timestamp: Date.now(),
            }),
            idempotencyKey: `${activityScope}:${toolParams.toolCallId}`,
          };
          await runWithOwnedSessionTranscriptWrite(
            { sessionTarget: manager.getSessionTarget(), sessionKey: attempt.sessionKey },
            () => {
              // Revalidate the exact attempt after awaited acceptance and writer admission.
              if (
                ACTIVE_EMBEDDED_RUNS.get(attempt.sessionId) !== queueHandle ||
                input.getRunState().aborted
              ) {
                return;
              }
              if (isRecord(terminal.result)) {
                copyInternalToolResultState(terminal.result, message);
              }
              manager.appendMessage(message);
              const recorded = readNestedToolActivity(
                redactTranscriptMessage(message, attempt.config),
              );
              if (!recorded) {
                throw new Error("Nested activity became invalid during transcript redaction");
              }
              input.nestedToolActivities.push(recorded);
            },
          );
          notifyToolActivity(attempt.runId);
        },
        execute: async (onImplementationStart) => {
          // Acceptance belongs inside execution: observers must never see a rejected success.
          return await raceWithAbortSignal(
            (async () => {
              signal.throwIfAborted();
              const preparer = getInternalToolExecutionPreparer(toolParams.tool);
              if (!preparer) {
                onImplementationStart();
                return await toolParams.tool.execute(
                  toolParams.toolCallId,
                  toolParams.input,
                  signal,
                  toolParams.onUpdate,
                  undefined as never,
                );
              }
              const prepared = await preparer({
                toolCallId: toolParams.toolCallId,
                args: toolParams.input,
                signal,
                onUpdate: toolParams.onUpdate,
              });
              try {
                if (prepared.kind === "immediate") {
                  if (prepared.outcome.kind === "error") {
                    throw prepared.outcome.error;
                  }
                  return prepared.outcome.result;
                }
                return await prepared.execute(onImplementationStart);
              } finally {
                prepared.dispose();
              }
            })().then((result) => {
              signal.throwIfAborted();
              // Nested tools bypass the session's tool_result middleware hook.
              // Preserve committed delivery before output acceptance can reject it.
              recordEmbeddedToolReceipt(
                manager,
                toolParams.toolCallId,
                result.details,
                toolParams.source === "openclaw" &&
                  toolParams.sourceName === "core" &&
                  toolParams.toolName === "message",
              );
              return toolParams.acceptResultBeforeProjection(result);
            }),
            signal,
            yieldRunSignal,
          );
        },
      }),
      signal,
      yieldRunSignal,
    );
  };

  let externalAbortAccepted = false;
  const abortActiveRunExternally = (reason?: "user_abort" | "restart" | "superseded") => {
    // Reply cancellation can synchronously re-enter through this same backend.
    // Latch before callbacks so the first reason owns every abort side effect.
    if (externalAbortAccepted) {
      return;
    }
    externalAbortAccepted = true;
    input.markExternalAbort();
    attempt.onDeferredLifecycleAbort?.(reason);
    attempt.onAttemptAbort?.();
    const abortReason =
      reason === "restart"
        ? createAgentRunRestartAbortError()
        : reason === "superseded"
          ? createAgentRunSupersededAbortError()
          : undefined;
    input.abortRun(false, abortReason);
  };
  const canInject = () => {
    // The session awaits transcript/question preparation after the global queue
    // check. Revalidate this exact publication and its live scope at the effect.
    registration?.toolAuthority?.assertActive();
    return (
      acceptingSteerMessages &&
      !input.getRunState().aborted &&
      !input.runAbortController.signal.aborted &&
      registration !== undefined &&
      ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(queueHandle) === registration &&
      ACTIVE_EMBEDDED_RUNS.get(attempt.sessionId) === queueHandle &&
      ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.get(attempt.runId) === queueHandle
    );
  };
  type InputAuthority = NonNullable<
    Parameters<typeof cancelPendingAgentQuestionForSession>[0]["authority"]
  >;
  const composeInjectionGuard = (assertCurrent?: () => void) => () => {
    assertCurrent?.();
    return canInject();
  };
  const questionAuthority = (
    assertCurrent: (() => void) | undefined,
    kind: InputAuthority["kind"],
  ): InputAuthority => ({
    kind,
    assertCurrent: () => {
      if (!composeInjectionGuard(assertCurrent)()) {
        throw new Error("active session is finalizing");
      }
    },
  });
  // The shipped V1 entry retains backend-only authority; V2 requires the host assertion.
  const queueMessage = async (
    text: string,
    options?: EmbeddedAgentQueueMessageOptions,
    assertCurrent?: () => void,
    authorityKind: InputAuthority["kind"] = assertCurrent ? "source-bound" : "run",
  ) => {
    const canInjectMessage = composeInjectionGuard(assertCurrent);
    if (!canInjectMessage()) {
      throw new Error("active session is finalizing");
    }
    activeQueueAdmissions++;
    try {
      if (options?.steeringMode) {
        input.activeSession.agent.steeringMode = options.steeringMode;
      }
      return await steerActiveSessionWithOptionalDeliveryWait(
        input.activeSession,
        text,
        options,
        attempt.sessionKey,
        canInjectMessage,
        questionAuthority(assertCurrent, authorityKind),
      );
    } finally {
      activeQueueAdmissions--;
    }
  };
  const claimPendingUserInputAnswer = (
    text: string,
    options?: EmbeddedAgentQueueMessageOptions,
    assertCurrent?: () => void,
    authorityKind: InputAuthority["kind"] = assertCurrent ? "source-bound" : "run",
  ) =>
    claimEmbeddedPendingUserInputAnswer(
      text,
      options,
      attempt.sessionKey,
      composeInjectionGuard(assertCurrent),
      questionAuthority(assertCurrent, authorityKind),
    );
  const cancelPendingUserInput = (
    resolvedBy: string,
    assertCurrent?: () => void,
    authorityKind: InputAuthority["kind"] = assertCurrent ? "source-bound" : "run",
  ) =>
    cancelPendingAgentQuestionForSession({
      sessionKey: attempt.sessionKey,
      resolvedBy,
      authority: questionAuthority(assertCurrent, authorityKind),
    });
  const messageInjection = {
    version: 2 as const,
    isAvailable: () =>
      acceptingSteerMessages &&
      !input.getRunState().aborted &&
      !input.runAbortController.signal.aborted,
    queueMessage,
    claimPendingUserInputAnswer,
    cancelPendingUserInput,
  };
  const heartbeatReplyOperation =
    attempt.replyOperation?.turnKind === "heartbeat" ? attempt.replyOperation : undefined;
  const applyPermissionMode = input.applyPermissionMode;
  const queueHandle: AttemptStreamQueueHandle = {
    kind: "embedded",
    runId: attempt.runId,
    permissionChangeOwner: attempt.permissionChange?.owner,
    diagnosticOwner: input.diagnosticOwner,
    closeDiagnostics: () => closeDiagnosticEmbeddedRunOwner(input.diagnosticOwner),
    startedAtMs: attempt.startedAtMs,
    get toolAuthorityFingerprint() {
      return attempt.toolAuthorityFingerprint;
    },
    applyPermissionMode: applyPermissionMode
      ? async (mode, revokeApprovals) => {
          if (
            !acceptingSteerMessages ||
            input.runAbortController.signal.aborted ||
            ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.get(attempt.runId) !== queueHandle
          ) {
            return false;
          }
          if ((attempt.permissionMode ?? null) === mode) {
            return true;
          }
          try {
            applyPermissionMode(mode, revokeApprovals);
            return true;
          } catch (error) {
            // A partially rebuilt surface must never resume its revoked tools.
            input.abortRun(false, error);
            throw error;
          }
        }
      : undefined,
    claimPendingUserInputAnswer,
    cancelPendingUserInput,
    preemptByVisibleTurn: heartbeatReplyOperation
      ? () => heartbeatReplyOperation.supersede()
      : undefined,
    queueMessage,
    messageInjection,
    messageInjectionV2: messageInjection,
    isStreaming: () => input.activeSession.isStreaming,
    isAborted: () => input.getRunState().aborted,
    isStopped: () =>
      !acceptingSteerMessages ||
      input.getRunState().aborted ||
      input.runAbortController.signal.aborted,
    isCompacting: () => subscription.isCompacting(),
    supportsTranscriptCommitWait: true,
    supportsQueueMessageImages: true,
    sourceReplyDeliveryMode: attempt.sourceReplyDeliveryMode,
    taskSuggestionDeliveryMode: attempt.taskSuggestionDeliveryMode,
    cancel: abortActiveRunExternally,
    abort: (reason) => abortActiveRunExternally(reason),
  };
  attempt.replyOperation?.attachBackend(queueHandle);
  setActiveEmbeddedRunLifecycleGeneration(
    queueHandle,
    attempt.lifecycleGeneration ?? captureAgentRunLifecycleGeneration(attempt.runId),
  );
  setActiveEmbeddedRun(
    attempt.sessionId,
    queueHandle,
    attempt.sessionKey,
    attempt.sessionFile,
    input.hookAgentId,
  );
  const registration = ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(queueHandle);
  if (attempt.deferTerminalLifecycle && attempt.onDeferredLifecycleOwner) {
    deferredLifecycleOwner = createEmbeddedAttemptDeferredLifecycleOwner({
      runId: attempt.runId,
      sessionId: attempt.sessionId,
      trajectoryRecorder: input.trajectoryRecorder ?? null,
      clearActiveRun: () =>
        clearActiveEmbeddedRun(
          attempt.sessionId,
          queueHandle,
          attempt.sessionKey,
          attempt.sessionFile,
        ),
    });
    try {
      attempt.onDeferredLifecycleOwner(deferredLifecycleOwner);
    } catch (error) {
      deferredLifecycleOwner.discard();
      throw error;
    }
  }

  return {
    subscription,
    queueHandle,
    deferredLifecycleOwner,
    toolSearchCatalogExecutor,
    getBeforeAgentFinalizeRevisionReason: () => beforeAgentFinalizeRevisionReason,
    getBeforeAgentFinalizeRevisionEntryId: () => beforeAgentFinalizeRevisionEntryId,
    stopAcceptingSteerMessages: () => {
      acceptingSteerMessages = false;
    },
  };
}
