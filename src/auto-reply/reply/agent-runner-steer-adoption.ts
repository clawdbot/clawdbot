import { expectDefined } from "@openclaw/normalization-core";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isIngressAdoptionLostError } from "../../channels/message/ingress-drain.js";
import { logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
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
import {
  beginReplyMessageInjectionTarget,
  finalizeReplyMessageInjectionAttempt,
  type ReplyOperation,
  replyRunRegistry,
} from "./reply-run-registry.js";
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
  toolAuthorityFingerprint: string;
  pendingInputAuthorityFingerprint?: string;
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
  // Capture exact injection authority before parking or awaiting admission.
  // A same-key successor must never inherit this turn's steer or abort.
  const injectionTarget = replyRunRegistry.resolveCurrentMessageInjectionTarget(
    activeReplyOperation?.key ?? queueKey,
  );
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
  const fallback = async (reason?: string): Promise<"handled"> => {
    parked.fallback();
    if (replyOperationRunState) {
      replyOperationRunState.admission = { status: "accepted", mode: "followup" };
    }
    if (reason) {
      logVerbose(`queue: active session ${steerSessionId} rejected steering (${reason})`);
    }
    await touchActiveSessionEntry();
    typing.cleanup();
    return "handled";
  };
  try {
    const admission = await parked.admit();
    if (admission === "cancelled") {
      parked.consume();
      typing.cleanup();
      return "handled";
    }
    if (admission === "fallback") {
      return await fallback();
    }
    if (!injectionTarget) {
      return await fallback("no injectable reply operation");
    }
    const injectionAttempt = beginReplyMessageInjectionTarget(injectionTarget, followupRun.prompt, {
      steeringMode: "all",
      isInboundUserMessage: true,
      toolAuthorityFingerprint: params.toolAuthorityFingerprint,
      ...(params.pendingInputAuthorityFingerprint
        ? { pendingInputAuthorityFingerprint: params.pendingInputAuthorityFingerprint }
        : {}),
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
    });
    const finalization = await finalizeReplyMessageInjectionAttempt({
      attempt: injectionAttempt,
      target: injectionTarget,
      inboundAudio: followupRun.currentInboundAudio === true,
      onAccepted: () => {
        if (replyOperationRunState) {
          replyOperationRunState.admission = { status: "accepted", mode: "steer" };
        }
      },
      onAdopted: () => admitFollowupRunLifecycle(followupRun),
      shouldAbortOnAdoptionError: isIngressAdoptionLostError,
    });
    if (finalization.status === "rejected") {
      return await fallback(finalization.outcome.reason);
    }
    parked.consume();
    const transcriptCommitUnconfirmed =
      finalization.outcome.result?.transcriptCommit === "unconfirmed";
    if (finalization.aborted) {
      if (replyOperationRunState) {
        replyOperationRunState.messageInjectionAborted = true;
      }
      const reason = transcriptCommitUnconfirmed
        ? (finalization.outcome.result?.errorMessage ?? "transcript commitment unconfirmed")
        : `adoption lost: ${formatErrorMessage(finalization.adoptionError)}`;
      logVerbose(
        `queue: active session ${steerSessionId} aborted exact steered target without replay (${reason})`,
      );
      typing.cleanup();
      return "handled";
    }
    if (finalization.adoptionError) {
      logVerbose(
        `queue: active session ${steerSessionId} adoption finalizer failed: ${formatErrorMessage(finalization.adoptionError)}`,
      );
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
