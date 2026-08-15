import {
  cancelPendingAgentQuestionForSession,
  claimPendingAgentQuestionAnswer,
  embeddedAgentLog,
  setActiveEmbeddedRun,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { queueAgentHarnessMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { AttemptTranscriptJournal } from "./attempt-transcript-journal.js";
import type { AttemptParamsLike } from "./attempt-types.js";
import type { attachEventBridge } from "./event-bridge.js";
import type { SessionLike } from "./event-bridge.js";
import type { CopilotUserInputBridge } from "./user-input-bridge.js";

const DEFAULT_STEERING_DELIVERY_TIMEOUT_MS = 120_000;
type CopilotQueueMessageOptions = Parameters<typeof queueAgentHarnessMessage>[2];

export function registerCopilotActiveRun(params: {
  abortActiveSession: () => void;
  bridge: ReturnType<typeof attachEventBridge> | undefined;
  canAcceptSteering: () => boolean;
  input: AttemptParamsLike;
  isAborted: () => boolean;
  isSettled: () => boolean;
  session: SessionLike;
  transcriptJournal: AttemptTranscriptJournal;
  userInputBridge: CopilotUserInputBridge;
}) {
  const cancelPendingUserInput = (resolvedBy: string) =>
    cancelPendingAgentQuestionForSession({
      sessionKey: params.input.sessionKey ?? params.input.sessionId,
      resolvedBy,
    });
  const cancelGatewayQuestionBestEffort = (resolvedBy: string) => {
    void cancelPendingUserInput(resolvedBy).catch((error: unknown) => {
      embeddedAgentLog.warn("failed to cancel copilot gateway question during shutdown", { error });
    });
  };
  const claimPendingUserInputAnswer = async (
    text: string,
    options?: CopilotQueueMessageOptions,
  ) => {
    if (options?.isInboundUserMessage !== true || options.images?.length) {
      return false;
    }
    const claimed = await claimPendingAgentQuestionAnswer({
      sessionKey: params.input.sessionKey ?? params.input.sessionId,
      text,
      persist: options.userTurnTranscriptRecorder
        ? async () => {
            await options.userTurnTranscriptRecorder?.persistApproved();
          }
        : undefined,
    });
    return claimed;
  };
  const queueMessage = async (text: string, options?: CopilotQueueMessageOptions) => {
    let acceptanceReported = false;
    // Acceptance transfers fallback ownership irrevocably. A later transcript
    // receipt failure must remain accepted-unconfirmed instead of reopening it.
    const reportAcceptance = (accepted: boolean) => {
      if (acceptanceReported) {
        return;
      }
      acceptanceReported = true;
      options?.onQueueAccepted?.(accepted);
    };
    let messageId: string;
    try {
      if (await claimPendingUserInputAnswer(text, options)) {
        reportAcceptance(true);
        return undefined;
      }
      if (params.isSettled() || params.isAborted()) {
        throw new Error("Copilot steering is unavailable after the active run ended");
      }
      if (!params.canAcceptSteering()) {
        throw new Error("Copilot steering is unavailable before initial user validation");
      }
      messageId = await params.session.send({ prompt: text });
      reportAcceptance(true);
    } catch (error) {
      reportAcceptance(false);
      throw error;
    }
    if (options?.waitForTranscriptCommit === true) {
      try {
        await waitForPersistenceReceipt(
          params.transcriptJournal.waitForSdkUserPersisted(messageId),
          options.deliveryTimeoutMs,
        );
      } catch (error) {
        return {
          transcriptCommit: "unconfirmed" as const,
          errorMessage:
            error instanceof Error
              ? error.message
              : "Copilot accepted steering but its transcript receipt was not confirmed",
        };
      }
    }
    return undefined;
  };
  const activeRunHandle = {
    kind: "embedded" as const,
    runId: params.input.runId,
    toolAuthorityFingerprint: params.input.toolAuthorityFingerprint,
    claimPendingUserInputAnswer,
    cancelPendingUserInput,
    queueMessage,
    messageInjection: {
      isAvailable: () => params.canAcceptSteering() && !params.isSettled() && !params.isAborted(),
      queueMessage,
    },
    isStreaming: () => params.canAcceptSteering() && !params.isSettled() && !params.isAborted(),
    isAborted: params.isAborted,
    isCompacting: () => params.bridge?.isCompacting() ?? false,
    // session.send resolves with the injected user-message id; the journal
    // receipt resolves only after that exact SDK event reaches canonical history.
    supportsTranscriptCommitWait: true,
    sourceReplyDeliveryMode: params.input.sourceReplyDeliveryMode,
    taskSuggestionDeliveryMode: params.input.taskSuggestionDeliveryMode,
    cancel: () => {
      cancelGatewayQuestionBestEffort("run-cancel");
      params.userInputBridge.cancelPending();
      params.abortActiveSession();
    },
    abort: () => {
      cancelGatewayQuestionBestEffort("run-abort");
      params.userInputBridge.cancelPending();
      params.abortActiveSession();
    },
  };
  setActiveEmbeddedRun(
    params.input.sessionId,
    activeRunHandle,
    params.input.sessionKey,
    params.input.sessionFile,
  );
  params.input.replyOperation?.attachBackend(activeRunHandle);
  return activeRunHandle;
}

async function waitForPersistenceReceipt(
  receipt: Promise<void>,
  requestedTimeoutMs: number | undefined,
): Promise<void> {
  const timeoutMs =
    typeof requestedTimeoutMs === "number" &&
    Number.isFinite(requestedTimeoutMs) &&
    requestedTimeoutMs > 0
      ? requestedTimeoutMs
      : DEFAULT_STEERING_DELIVERY_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      receipt,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Copilot steering transcript receipt timed out")),
          timeoutMs,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
