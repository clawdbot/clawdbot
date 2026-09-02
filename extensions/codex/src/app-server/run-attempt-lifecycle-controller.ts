import {
  embeddedAgentLog,
  FAST_MODE_AUTO_PROGRESS_KIND,
  formatErrorMessage,
  formatFastModeAutoProgressText,
  resolveAgentRunAbortLifecycleFields,
  resolveFastModeForElapsed,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { reportCodexExecutionNotification } from "./attempt-notification-state.js";
import { CODEX_TERMINAL_RELEASE_COMPLETION_DEADLINE_MS } from "./attempt-timeouts.js";
import {
  resolveTerminalDynamicToolBatchAction,
  shouldReleaseTurnAfterTerminalDynamicTool,
} from "./dynamic-tool-execution.js";
import type { CodexDynamicToolRuntimeResponse } from "./dynamic-tool-response-state.js";
import type { CodexDynamicToolCallParams, CodexServerNotification } from "./protocol.js";
import { buildCodexLifecycleTerminalMeta } from "./run-attempt-lifecycle-terminal.js";
import { emitCodexAppServerEvent } from "./run-attempt-lifecycle.js";
import type { CodexAttemptResources } from "./run-attempt-resources.js";
import type { CodexServerRequestAdmission } from "./run-attempt-server-request-admission.js";
import type { CodexAttemptTurnState } from "./run-attempt-turn-state.js";

export function createCodexAttemptLifecycleController(
  resources: CodexAttemptResources,
  turnRuntime: CodexAttemptTurnState,
) {
  const { prompt, trajectoryRecorder } = resources;
  const { connection } = prompt.context.runtime;
  const {
    params,
    attemptStartedAt,
    runAbortController,
    fastModeAutoStartedAtMs,
    fastModeAutoProgressState,
  } = connection;
  const { state, activeTurnItemIds, pendingOpenClawDynamicToolCompletionIds } = turnRuntime;
  const commitFinalSourceReplyDelivery = (value: {
    call: CodexDynamicToolCallParams;
    durationMs: number;
    requestAdmission?: CodexServerRequestAdmission;
  }) => {
    if (state.finalSourceReplyCommit) {
      return;
    }
    const committedAtMs = Date.now();
    state.finalSourceReplyCommit = { call: value.call, committedAtMs };
    turnRuntime.serverRequestAdmission.seal(value.requestAdmission);
    state.pendingTerminalDynamicToolRelease = undefined;
    state.currentTurnHadNonTerminalDynamicToolResult = false;
    turnRuntime.steeringQueueRef.current?.sealAdmission();
    // Final delivery ends execution ownership even while native Codex gets a
    // bounded opportunity to publish its clean turn/completed receipt.
    turnRuntime.deadlines.beginSettlement(committedAtMs);
    turnRuntime.armTerminalReleaseDeadline(
      committedAtMs + CODEX_TERMINAL_RELEASE_COMPLETION_DEADLINE_MS,
      () => interruptTurnForTerminalRelease("completion_deadline"),
    );
    trajectoryRecorder?.recordEvent("turn.dynamic_tool_terminal_release", {
      threadId: value.call.threadId,
      turnId: value.call.turnId,
      toolCallId: value.call.callId,
      name: value.call.tool,
      durationMs: value.durationMs,
      committedAtMs,
      mode: "await_turn_completed",
    });
    embeddedAgentLog.info(
      "codex app-server turn awaiting natural completion after final source reply",
      {
        threadId: value.call.threadId,
        turnId: value.call.turnId,
        toolCallId: value.call.callId,
        tool: value.call.tool,
        durationMs: value.durationMs,
      },
    );
  };
  const commitFinalSourceReply = (value: {
    call: CodexDynamicToolCallParams;
    response: CodexDynamicToolRuntimeResponse;
    durationMs: number;
    requestAdmission?: CodexServerRequestAdmission;
  }) => {
    if (value.response.success && value.response.finalCurrentSourceReply === true) {
      commitFinalSourceReplyDelivery(value);
    }
  };
  const releaseTurnAfterTerminalDynamicTool = (value: {
    call: CodexDynamicToolCallParams;
    response: CodexDynamicToolRuntimeResponse;
    durationMs: number;
  }) => {
    if (state.finalSourceReplyCommit) {
      state.pendingTerminalDynamicToolRelease = undefined;
      state.currentTurnHadNonTerminalDynamicToolResult = false;
      return;
    }
    if (
      !shouldReleaseTurnAfterTerminalDynamicTool({
        completed: state.completed,
        aborted: runAbortController.signal.aborted,
        responseSuccess: value.response.success,
        currentTurnHadNonTerminalDynamicToolResult:
          state.currentTurnHadNonTerminalDynamicToolResult,
        activeAppServerTurnRequests: state.activeAppServerTurnRequests,
        activeTurnItemIdsCount: activeTurnItemIds.size,
        pendingOpenClawDynamicToolCompletionIdsCount: pendingOpenClawDynamicToolCompletionIds.size,
      })
    ) {
      return;
    }
    state.pendingTerminalDynamicToolRelease = undefined;
    trajectoryRecorder?.recordEvent("turn.dynamic_tool_terminal_release", {
      threadId: value.call.threadId,
      turnId: value.call.turnId,
      toolCallId: value.call.callId,
      name: value.call.tool,
      durationMs: value.durationMs,
      mode: "interrupt_and_complete_locally",
    });
    embeddedAgentLog.info("codex app-server turn released after terminal dynamic tool result", {
      threadId: value.call.threadId,
      turnId: value.call.turnId,
      toolCallId: value.call.callId,
      tool: value.call.tool,
      durationMs: value.durationMs,
    });
    // Interrupt drops accepted pending input. Reject unconsumed steering first so
    // completion delivery can use its fallback path instead of reporting success.
    turnRuntime.steeringQueueRef.current?.cancel();
    void turnRuntime.interruptTurn(value.call.turnId, { locallyCompleted: true });
    turnRuntime.completeTurn();
  };
  const interruptTurnForTerminalRelease = (
    cause: "completion_deadline" | "new_inbound_message",
  ) => {
    const pending = state.finalSourceReplyCommit?.call;
    if (
      !pending ||
      state.localCompletionRequested ||
      state.completed ||
      runAbortController.signal.aborted
    ) {
      return;
    }
    turnRuntime.clearTerminalReleaseDeadline();
    trajectoryRecorder?.recordEvent("turn.terminal_release_interrupt", {
      threadId: pending.threadId,
      turnId: pending.turnId,
      toolCallId: pending.callId,
      name: pending.tool,
      cause,
      deadlineMs: CODEX_TERMINAL_RELEASE_COMPLETION_DEADLINE_MS,
    });
    embeddedAgentLog.warn("codex app-server final source reply grace expired; interrupting", {
      threadId: pending.threadId,
      turnId: pending.turnId,
      toolCallId: pending.callId,
      tool: pending.tool,
      cause,
    });
    turnRuntime.steeringQueueRef.current?.cancel();
    void (async () => {
      try {
        await turnRuntime.interruptTurn(pending.turnId, { locallyCompleted: true });
      } catch (error) {
        embeddedAgentLog.warn("codex app-server terminal-release interrupt failed", {
          threadId: pending.threadId,
          turnId: pending.turnId,
          toolCallId: pending.callId,
          error: formatErrorMessage(error),
        });
      } finally {
        // The source reply is already delivered. Cleanup failure must not wedge
        // the local attempt or demote that committed result.
        turnRuntime.completeTurn();
      }
    })();
  };
  const scheduleTerminalDynamicToolReleaseCheck = () => {
    if (
      state.terminalDynamicToolReleaseCheckScheduled ||
      (!state.pendingTerminalDynamicToolRelease &&
        !state.currentTurnHadNonTerminalDynamicToolResult)
    ) {
      return;
    }
    // The JSON-RPC response must flush before the terminal tool interrupts its turn.
    state.terminalDynamicToolReleaseCheckScheduled = true;
    const immediate = setImmediate(() => {
      state.terminalDynamicToolReleaseCheckScheduled = false;
      if (state.finalSourceReplyCommit) {
        state.pendingTerminalDynamicToolRelease = undefined;
        state.currentTurnHadNonTerminalDynamicToolResult = false;
        return;
      }
      if (
        state.pendingTerminalDynamicToolRelease?.response.success === true &&
        !state.currentTurnHadNonTerminalDynamicToolResult &&
        state.activeAppServerTurnRequests === 0 &&
        pendingOpenClawDynamicToolCompletionIds.size === 0
      ) {
        // Tool response flush plus sibling classification commits terminal release.
        // Fence steering now; active Codex items may delay the actual interrupt.
        turnRuntime.steeringQueueRef.current?.cancel();
      }
      const action = resolveTerminalDynamicToolBatchAction({
        activeAppServerTurnRequests: state.activeAppServerTurnRequests,
        activeTurnItemIdsCount: activeTurnItemIds.size,
        pendingOpenClawDynamicToolCompletionIdsCount: pendingOpenClawDynamicToolCompletionIds.size,
        currentTurnHadNonTerminalDynamicToolResult:
          state.currentTurnHadNonTerminalDynamicToolResult,
        hasPendingTerminalDynamicToolRelease: state.pendingTerminalDynamicToolRelease !== undefined,
      });
      if (action === "release-pending-terminal" && state.pendingTerminalDynamicToolRelease) {
        releaseTurnAfterTerminalDynamicTool(state.pendingTerminalDynamicToolRelease);
      } else if (action === "clear-nonterminal-batch") {
        state.pendingTerminalDynamicToolRelease = undefined;
        state.currentTurnHadNonTerminalDynamicToolResult = false;
      }
    });
    immediate.unref?.();
  };
  const scheduleTurnReleaseAfterTerminalDynamicTool = (value: {
    call: CodexDynamicToolCallParams;
    response: CodexDynamicToolRuntimeResponse;
    durationMs: number;
  }) => {
    state.pendingTerminalDynamicToolRelease = value;
    scheduleTerminalDynamicToolReleaseCheck();
  };
  const emitLifecycleStart = () => {
    void emitCodexAppServerEvent(params, {
      stream: "lifecycle",
      data: { phase: "start", startedAt: attemptStartedAt },
    });
    state.lifecycleStarted = true;
  };
  const emitLifecycleTerminal = (data: Record<string, unknown> & { phase: "end" | "error" }) => {
    if (
      !state.lifecycleStarted ||
      state.lifecycleTerminalEmitted ||
      state.permissionChangeRestart
    ) {
      return;
    }
    void emitCodexAppServerEvent(params, {
      stream: "lifecycle",
      data: {
        startedAt: attemptStartedAt,
        endedAt: Date.now(),
        ...data,
        ...(params.deferTerminalLifecycle ? { phase: "finishing" } : {}),
      },
    });
    state.lifecycleTerminalEmitted = true;
  };
  const buildLifecycleTerminalMeta = (input: {
    aborted: boolean;
    timedOut: boolean;
    yielded?: boolean;
  }) => {
    const abortFields = input.aborted
      ? resolveAgentRunAbortLifecycleFields(runAbortController.signal)
      : undefined;
    return buildCodexLifecycleTerminalMeta({
      ...input,
      abortStopReason: abortFields?.stopReason,
    });
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
  const reportExecutionNotification = (notification: CodexServerNotification) => {
    reportCodexExecutionNotification({ notification, emitExecutionPhaseOnce });
  };
  const emitFastModeAutoProgress = async (payload: {
    enabled: boolean;
    elapsedSeconds: number;
    fastAutoOnSeconds?: number;
  }) => {
    const summary = formatFastModeAutoProgressText(payload);
    await emitCodexAppServerEvent(params, {
      stream: "item",
      data: { kind: "status", title: "Fast", phase: "update", summary },
    });
    try {
      await params.onToolResult?.({
        text: summary,
        channelData: { openclawProgressKind: FAST_MODE_AUTO_PROGRESS_KIND },
      });
    } catch (error) {
      embeddedAgentLog.debug("codex app-server fast mode auto progress delivery failed", { error });
    }
  };
  const maybeAnnounceFastModeAutoOff = async () => {
    if (
      params.fastModeAuto !== true ||
      fastModeAutoStartedAtMs === undefined ||
      fastModeAutoProgressState.offAnnounced
    ) {
      return;
    }
    const next = resolveFastModeForElapsed({
      mode: "auto",
      startedAtMs: fastModeAutoStartedAtMs,
      fastAutoOnSeconds: params.fastModeAutoOnSeconds,
    });
    if (next.enabled) {
      return;
    }
    fastModeAutoProgressState.offAnnounced = true;
    await emitFastModeAutoProgress(next);
  };
  const maybeEmitFastModeAutoReset = async () => {
    if (
      params.fastModeAuto !== true ||
      !fastModeAutoProgressState.offAnnounced ||
      fastModeAutoProgressState.resetAnnounced
    ) {
      return;
    }
    fastModeAutoProgressState.resetAnnounced = true;
    await emitFastModeAutoProgress({
      enabled: true,
      elapsedSeconds: 0,
      fastAutoOnSeconds: params.fastModeAutoOnSeconds,
    });
  };
  const maybeEmitFastModeAutoResetBestEffort = async () => {
    try {
      await maybeEmitFastModeAutoReset();
    } catch (error) {
      embeddedAgentLog.warn(
        `codex app-server fast mode auto reset progress failed: ${formatErrorMessage(error)}`,
      );
    }
  };
  return {
    commitFinalSourceReplyDelivery,
    commitFinalSourceReply,
    scheduleTerminalDynamicToolReleaseCheck,
    scheduleTurnReleaseAfterTerminalDynamicTool,
    interruptTurnForTerminalRelease,
    emitLifecycleStart,
    emitLifecycleTerminal,
    buildLifecycleTerminalMeta,
    emitExecutionPhaseOnce,
    reportExecutionNotification,
    maybeAnnounceFastModeAutoOff,
    maybeEmitFastModeAutoResetBestEffort,
  };
}

export type CodexAttemptLifecycleController = ReturnType<
  typeof createCodexAttemptLifecycleController
>;
