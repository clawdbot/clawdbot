import { expectDefined } from "@openclaw/normalization-core";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  formatEmbeddedAgentQueueFailureSummary,
  queueEmbeddedAgentMessageWithOutcomeAsync,
} from "../../agents/embedded-agent-runner/runs.js";
import { isIngressAdoptionLostError } from "../../channels/message/ingress-drain.js";
import { logVerbose } from "../../globals.js";
import {
  scheduleFollowupDrainAfterReplyOperationClear,
  type RunReplyAgentParams,
} from "./agent-runner-core.js";
import {
  admitFollowupRunLifecycle,
  parkSteerCandidate,
  resolveFollowupAbortSignal,
  scheduleFollowupDrain,
  type FollowupRun,
} from "./queue.js";
import type { ReplyOperationRunState } from "./reply-operation-run-state.js";
import { type ReplyOperation, replyRunRegistry } from "./reply-run-registry.js";
import { refreshReplyOperationTyping } from "./reply-run-typing.js";
import { buildChannelSourceTurnId } from "./source-turn-id.js";
import type { TypingSignaler } from "./typing-mode.js";

type ActiveReplySteerParams = {
  followupRun: RunReplyAgentParams["followupRun"];
  opts: RunReplyAgentParams["opts"];
  providedReplyOperation: ReplyOperation | undefined;
  queueKey: string;
  releaseAdmissionTicket: () => void;
  replyOperationRunState: ReplyOperationRunState | undefined;
  resolvedQueue: RunReplyAgentParams["resolvedQueue"];
  restartRecoverySourceTurnId: string | undefined;
  runFollowup: (run: FollowupRun) => Promise<void>;
  sessionCtx: RunReplyAgentParams["sessionCtx"];
  sessionKey: string | undefined;
  touchActiveSessionEntry: () => Promise<void>;
  typing: RunReplyAgentParams["typing"];
  typingSignals: TypingSignaler;
};

function resolveAcceptedSteerRunId(params: ActiveReplySteerParams): string {
  const { followupRun, sessionCtx } = params;
  return expectDefined(
    params.restartRecoverySourceTurnId ??
      buildChannelSourceTurnId({
        provider:
          followupRun.originatingChannel ?? followupRun.run.messageProvider ?? sessionCtx.Provider,
        accountId:
          followupRun.originatingAccountId ??
          followupRun.run.agentAccountId ??
          sessionCtx.AccountId,
        conversationId:
          followupRun.originatingTo ??
          followupRun.originatingChatId ??
          params.sessionKey ??
          followupRun.run.sessionKey,
        messageId: followupRun.messageId ?? sessionCtx.MessageSidFull ?? sessionCtx.MessageSid,
      }) ??
      normalizeOptionalString(params.opts?.runId),
    "steered turn id",
  );
}

async function finalizeAcceptedSteer(params: {
  activeReplyOperation: ReplyOperation | undefined;
  abortKey: string | undefined;
  cleanupTyping: () => void;
  errorMessage: string | undefined;
  onAdopted: (() => void | Promise<void>) | undefined;
  replyOperationRunState: ReplyOperationRunState | undefined;
  steerSessionId: string;
  transcriptCommit: "unconfirmed" | undefined;
}): Promise<"continue" | "stop"> {
  const transcriptCommitUnconfirmed = params.transcriptCommit === "unconfirmed";
  if (params.replyOperationRunState) {
    // Harness acceptance has transferred this turn to the active session.
    // Replay after an uncertain receipt could run the same user side effects twice.
    params.replyOperationRunState.admission = { status: "accepted", mode: "steer" };
  }
  params.activeReplyOperation?.recordActivity();
  const abortActiveRun = () => {
    if (params.abortKey) {
      replyRunRegistry.abort(params.abortKey);
    }
  };
  if (transcriptCommitUnconfirmed) {
    // The runtime accepted this message, but exact cancellation could not find it.
    // Preserve at-most-once delivery: abort the uncertain owner without replaying.
    abortActiveRun();
    logVerbose(
      `queue: active session ${params.steerSessionId} accepted steering without transcript confirmation; aborting active run without ingress replay (${params.errorMessage ?? "unknown receipt failure"})`,
    );
  }
  const adoptionBoundary = transcriptCommitUnconfirmed ? "harness acceptance" : "transcript commit";
  try {
    await params.onAdopted?.();
  } catch (error) {
    if (isIngressAdoptionLostError(error)) {
      abortActiveRun();
      logVerbose(
        `queue: active session ${params.steerSessionId} adoption lost after ${adoptionBoundary} (${error.code}); aborting steered turn without ingress replay`,
      );
      params.cleanupTyping();
      return "stop";
    }
    logVerbose(
      `queue: active session ${params.steerSessionId} adoption finalizer failed after ${adoptionBoundary}: ${String(error)}`,
    );
  }
  if (transcriptCommitUnconfirmed) {
    params.cleanupTyping();
    return "stop";
  }
  return "continue";
}

export async function runActiveReplySteer(params: ActiveReplySteerParams): Promise<"handled"> {
  const {
    followupRun,
    queueKey,
    releaseAdmissionTicket,
    replyOperationRunState,
    resolvedQueue,
    runFollowup,
    sessionKey,
    touchActiveSessionEntry,
    typing,
    typingSignals,
  } = params;
  // Steer against the operation that owns THIS session's run slot. A native
  // command continuation whose slot adoption was skipped (#104844) still
  // carries a source-keyed reservation; steering by its stale sessionId
  // would miss the live target run.
  const registeredReplyOperation = sessionKey ? replyRunRegistry.get(sessionKey) : undefined;
  const activeReplyOperation =
    params.providedReplyOperation?.key === sessionKey
      ? params.providedReplyOperation
      : (registeredReplyOperation ?? params.providedReplyOperation);
  const steerSessionId = activeReplyOperation?.sessionId ?? followupRun.run.sessionId;
  const parked = parkSteerCandidate(queueKey, followupRun, resolvedQueue, runFollowup);
  if (!parked) {
    releaseAdmissionTicket();
    typing.cleanup();
    return "handled";
  }
  const scheduleParkedFallback = () => {
    const owner = replyRunRegistry.get(queueKey);
    if (owner) {
      scheduleFollowupDrainAfterReplyOperationClear({
        operation: owner,
        queueKey,
        runFollowup,
      });
    } else {
      scheduleFollowupDrain(queueKey, runFollowup);
    }
  };
  scheduleParkedFallback();
  releaseAdmissionTicket();
  try {
    const admission = await parked.admit();
    if (admission === "cancelled") {
      parked.consume();
      typing.cleanup();
      return "handled";
    }
    if (admission === "fallback") {
      parked.fallback();
      if (replyOperationRunState) {
        replyOperationRunState.admission = { status: "accepted", mode: "followup" };
      }
      await touchActiveSessionEntry();
      typing.cleanup();
      return "handled";
    }
    // Channel dispatch normally stamps the route-scoped source id. Internal
    // callers can derive the same per-message identity from the prepared turn.
    const steerOutcome = await queueEmbeddedAgentMessageWithOutcomeAsync(
      steerSessionId,
      followupRun.prompt,
      {
        steeringMode: "all",
        isInboundUserMessage: true,
        ...(followupRun.images?.length ? { images: followupRun.images } : {}),
        ...(followupRun.imageOrder?.length ? { imageOrder: followupRun.imageOrder } : {}),
        ...(followupRun.media?.length ? { media: followupRun.media } : {}),
        waitForTranscriptCommit: true,
        queueIdentity: resolveAcceptedSteerRunId(params),
        abortSignal: resolveFollowupAbortSignal(followupRun),
        onQueueAccepted: parked.accepted,
        ...(resolvedQueue.debounceMs !== undefined ? { debounceMs: resolvedQueue.debounceMs } : {}),
        ...(followupRun.run.sourceReplyDeliveryMode
          ? { sourceReplyDeliveryMode: followupRun.run.sourceReplyDeliveryMode }
          : {}),
        taskSuggestionDeliveryMode: followupRun.run.taskSuggestionDeliveryMode,
        ...(followupRun.userTurnTranscriptRecorder
          ? { userTurnTranscriptRecorder: followupRun.userTurnTranscriptRecorder }
          : {}),
      },
    );
    if (!steerOutcome.queued) {
      parked.fallback();
      if (replyOperationRunState) {
        replyOperationRunState.admission = { status: "accepted", mode: "followup" };
      }
      const summary = formatEmbeddedAgentQueueFailureSummary(steerOutcome);
      logVerbose(`queue: active session ${steerSessionId} rejected steering injection: ${summary}`);
      await touchActiveSessionEntry();
      typing.cleanup();
      return "handled";
    }
    const adoptionDisposition = await finalizeAcceptedSteer({
      activeReplyOperation,
      abortKey: sessionKey ?? queueKey,
      cleanupTyping: () => typing.cleanup(),
      errorMessage: steerOutcome.errorMessage,
      onAdopted: () => admitFollowupRunLifecycle(followupRun),
      replyOperationRunState,
      steerSessionId,
      transcriptCommit: steerOutcome.transcriptCommit,
    });
    parked.consume();
    if (adoptionDisposition === "stop") {
      return "handled";
    }
    if (followupRun.currentInboundAudio === true) {
      activeReplyOperation?.markAcceptedSteeredInboundAudio();
    }
    if (activeReplyOperation) {
      await refreshReplyOperationTyping(activeReplyOperation, {
        startIfIdle: typingSignals.shouldStartImmediately,
      });
    }
    await touchActiveSessionEntry();
    typing.cleanup();
    return "handled";
  } catch (error) {
    if (resolveFollowupAbortSignal(followupRun)?.aborted) {
      parked.consume();
    } else {
      parked.fallback();
    }
    throw error;
  } finally {
    if (followupRun.steerPending) {
      if (resolveFollowupAbortSignal(followupRun)?.aborted) {
        parked.consume();
      } else {
        parked.fallback();
      }
    }
  }
}
