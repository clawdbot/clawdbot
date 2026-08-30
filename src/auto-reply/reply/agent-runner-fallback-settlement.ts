import { isContextOverflowError } from "../../agents/embedded-agent-helpers.js";
import { hasCompletedSourceReplyDeliveryEvidence } from "../../agents/embedded-agent-runner/delivery-evidence.js";
import {
  PROVIDER_CONVERSATION_STATE_ERROR_USER_MESSAGE,
  renderControlUiAgentFailureCopy,
} from "../../agents/failover/user-copy.js";
import {
  createAgentRunRestartAbortError,
  isAgentRunRestartAbortReason,
} from "../../agents/run-termination.js";
import { logVerbose } from "../../globals.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { defaultRuntime } from "../../runtime.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import { buildContextOverflowRecoveryText } from "./agent-runner-context-recovery.js";
import { resolveSourceReplyPolicy } from "./agent-runner-core.js";
import { isContinuationWrappedRunResult } from "./agent-runner-execution.types.js";
import { markAgentRunFailureReplyPayload } from "./agent-runner-failure-reply.js";
import type { AgentFallbackCandidatesResult } from "./agent-runner-fallback-candidate.js";
import type {
  AgentFallbackCycleParams,
  AgentFallbackCycleResult,
} from "./agent-runner-fallback-cycle.types.js";
import { drainPendingToolTasks } from "./pending-tool-task-drain.js";
import { classifyPrivateMessageToolFinal } from "./private-message-tool-final.js";
import {
  isReplyOperationRestartAbort,
  isReplyOperationUserAbort,
} from "./reply-operation-abort.js";

/** Settles abort, lifecycle, and terminal failure state after fallback execution. */
export async function settleAgentFallbackCycle(params: {
  cycle: AgentFallbackCycleParams;
  fallbackResult: AgentFallbackCandidatesResult;
}): Promise<AgentFallbackCycleResult> {
  const { cycle, fallbackResult } = params;
  const turn = cycle.turn;
  const wrappedRunResult = fallbackResult.result;
  const runResult = isContinuationWrappedRunResult(wrappedRunResult)
    ? wrappedRunResult.result
    : wrappedRunResult;
  const continueWorkRequests = isContinuationWrappedRunResult(wrappedRunResult)
    ? (wrappedRunResult.continueWorkRequests ?? [])
    : [];
  const compactionTraceparent = isContinuationWrappedRunResult(wrappedRunResult)
    ? wrappedRunResult.compactionTraceparent
    : undefined;
  const rawContinuationText = isContinuationWrappedRunResult(wrappedRunResult)
    ? wrappedRunResult.rawContinuationText
    : undefined;
  const fallbackProvider = fallbackResult.provider;
  const fallbackModel = fallbackResult.model;
  const fallbackExhausted = fallbackResult.outcome === "exhausted";
  // run-entry owns the canonical reply/receipt facts. Carry them through the
  // fallback backstop so downstream waiters never have to rederive them.
  const terminalMetadata = fallbackResult.terminal.metadata;
  const settledLifecycleTerminal =
    cycle.state.pendingLifecycleTerminal?.provider === fallbackProvider &&
    cycle.state.pendingLifecycleTerminal.model === fallbackModel
      ? cycle.state.pendingLifecycleTerminal.backstop
      : undefined;
  cycle.state.pendingLifecycleTerminal = undefined;
  if (turn.isRestartRecoveryArmed?.()) {
    turn.replyOperation?.abortForRestart();
  }
  if (isReplyOperationRestartAbort(turn.replyOperation)) {
    settledLifecycleTerminal?.emit("end", runResult, terminalMetadata);
    throw isAgentRunRestartAbortReason(cycle.runAbortSignal?.reason)
      ? cycle.runAbortSignal?.reason
      : createAgentRunRestartAbortError();
  }
  if (isReplyOperationUserAbort(turn.replyOperation)) {
    settledLifecycleTerminal?.emit("end", runResult, terminalMetadata);
    await drainPendingToolTasks({ tasks: turn.pendingToolTasks, onTimeout: logVerbose });
    return { kind: "final", payload: { text: SILENT_REPLY_TOKEN } };
  }
  cycle.commitTerminalOutcome();
  const fallbackAttempts = Array.isArray(fallbackResult.attempts)
    ? fallbackResult.attempts.map((attempt) => ({
        provider: attempt.provider,
        model: attempt.model,
        error: attempt.error,
        reason: attempt.reason ?? "unknown",
        status: typeof attempt.status === "number" ? attempt.status : undefined,
        code: attempt.code || undefined,
      }))
    : [];
  if (!fallbackExhausted) {
    await fallbackResult.settleSessionOverride();
  }
  const embeddedError = runResult.meta?.error;
  const deferredLifecycleError = settledLifecycleTerminal?.getDeferredError();
  const userFacingErrorPayload = runResult.payloads?.find(
    (payload) => payload.isError === true && typeof payload.text === "string",
  )?.text;
  const terminalErrorMessage =
    deferredLifecycleError ??
    userFacingErrorPayload ??
    (embeddedError ? "Agent run failed" : undefined);
  const emitSettledLifecycleError = (error: Error, extraData?: Record<string, unknown>) => {
    if (settledLifecycleTerminal) {
      settledLifecycleTerminal.emit("error", error, extraData);
      return;
    }
    emitAgentEvent({
      runId: cycle.runId,
      lifecycleGeneration: cycle.state.lifecycleGeneration,
      ...(turn.sessionKey ? { sessionKey: turn.sessionKey } : {}),
      stream: "lifecycle",
      data: { phase: "error", error: error.message, endedAt: Date.now(), ...extraData },
    });
  };
  if (embeddedError && isContextOverflowError(embeddedError.message)) {
    emitSettledLifecycleError(new Error(terminalErrorMessage ?? "Agent run failed"));
    defaultRuntime.error(
      `Auto-compaction failed (${embeddedError.message}). Preserving existing session mapping for ${turn.sessionKey ?? turn.followupRun.run.sessionId}.`,
    );
    turn.replyOperation?.fail("run_failed", embeddedError);
    return {
      kind: "final",
      payload: markAgentRunFailureReplyPayload({
        text: buildContextOverflowRecoveryText({
          preserveSessionMapping: true,
          cfg: cycle.runtimeConfig,
          agentId: turn.followupRun.run.agentId,
          primaryProvider: turn.followupRun.run.provider,
          primaryModel: turn.followupRun.run.model,
          runtimeProvider: cycle.state.attemptedRuntimeProvider,
          runtimeModel: cycle.state.attemptedRuntimeModel,
          activeSessionEntry: turn.getActiveSessionEntry(),
        }),
      }),
      postCompactionModelFailure: cycle.state.postCompactionModelAttempted || undefined,
    };
  }
  if (embeddedError?.kind === "role_ordering") {
    emitSettledLifecycleError(new Error(terminalErrorMessage ?? "Agent run failed"));
    turn.replyOperation?.fail("run_failed", embeddedError);
    const embeddedErrorText = formatErrorMessage(embeddedError);
    return {
      kind: "final",
      payload: markAgentRunFailureReplyPayload({
        text: cycle.shouldSurfaceToControlUi
          ? renderControlUiAgentFailureCopy(embeddedErrorText)
          : PROVIDER_CONVERSATION_STATE_ERROR_USER_MESSAGE,
      }),
      postCompactionModelFailure: cycle.state.postCompactionModelAttempted || undefined,
    };
  }
  const sourceReplyPolicy = turn.sessionKey
    ? resolveSourceReplyPolicy({
        cfg: cycle.runtimeConfig,
        sessionCtx: turn.sessionCtx,
        sessionEntry: turn.getActiveSessionEntry(),
        sessionKey: turn.sessionKey,
        runtimePolicySessionKey: turn.runtimePolicySessionKey,
        opts: turn.opts,
      })
    : undefined;
  const finalText = runResult.meta?.finalAssistantVisibleText?.trim() ?? "";
  const successfulSourceReplyDelivery = hasCompletedSourceReplyDeliveryEvidence(runResult);
  const hasPendingContinuation =
    runResult.meta?.yielded === true || (runResult.meta?.pendingToolCalls?.length ?? 0) > 0;
  const privateFinalTerminalReply =
    !hasPendingContinuation &&
    classifyPrivateMessageToolFinal({
      sourceReplyDeliveryMode: sourceReplyPolicy?.sourceReplyDeliveryMode,
      sendPolicyDenied: sourceReplyPolicy?.sendPolicyDenied === true,
      successfulSourceReplyDelivery,
      isHeartbeat: turn.isHeartbeat,
      isRoomEvent: turn.sessionCtx.InboundEventKind === "room_event",
      finalText,
    }) === "short"
      ? ({ disposition: "empty", code: "message-tool-not-called" } as const)
      : undefined;
  let terminalRunFailed = false;
  if (fallbackExhausted) {
    const exhaustionError = new Error(
      terminalErrorMessage ?? "All model fallback candidates failed",
    );
    terminalRunFailed = true;
    if (cycle.modelPatch.captureFallbackFailure(fallbackAttempts) === undefined) {
      cycle.modelPatch.captureFailure(embeddedError ?? exhaustionError);
    }
    emitSettledLifecycleError(exhaustionError, {
      ...terminalMetadata,
      fallbackExhaustedFailure: true,
    });
    turn.replyOperation?.retainFailureUntilComplete();
    turn.replyOperation?.fail("run_failed", exhaustionError);
  } else if (deferredLifecycleError || embeddedError) {
    const terminalError = new Error(terminalErrorMessage ?? "Agent run failed");
    terminalRunFailed = true;
    cycle.modelPatch.captureFailure(embeddedError ?? terminalError);
    emitSettledLifecycleError(terminalError, terminalMetadata);
    turn.replyOperation?.retainFailureUntilComplete();
    turn.replyOperation?.fail("run_failed", terminalError);
  } else {
    settledLifecycleTerminal?.emit(
      "end",
      runResult,
      privateFinalTerminalReply
        ? { ...terminalMetadata, terminalReply: privateFinalTerminalReply }
        : terminalMetadata,
    );
  }
  return {
    kind: "completed",
    runResult,
    fallbackProvider,
    fallbackModel,
    fallbackExhausted,
    fallbackAttempts,
    terminalRunFailed,
    continueWorkRequests,
    compactionTraceparent,
    rawContinuationText,
  };
}
