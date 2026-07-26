import {
  cancelPendingAgentQuestionForSession,
  claimPendingAgentQuestionAnswer,
  embeddedAgentLog,
  setActiveEmbeddedRun,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { AttemptParamsLike } from "./attempt-types.js";
import type { attachEventBridge } from "./event-bridge.js";
import type { CopilotUserInputBridge } from "./user-input-bridge.js";
export function registerCopilotActiveRun(params: {
  abortActiveSession: () => void;
  bridge: ReturnType<typeof attachEventBridge> | undefined;
  input: AttemptParamsLike;
  isAborted: () => boolean;
  isSettled: () => boolean;
  userInputBridge: CopilotUserInputBridge;
}) {
  const cancelGatewayQuestionBestEffort = (resolvedBy: string) => {
    void cancelPendingAgentQuestionForSession({
      sessionKey: params.input.sessionKey ?? params.input.sessionId,
      resolvedBy,
    }).catch((error: unknown) => {
      embeddedAgentLog.warn("failed to cancel copilot gateway question during shutdown", { error });
    });
  };
  const activeRunHandle = {
    kind: "embedded" as const,
    queueMessage: async (text: string, options?: { isInboundUserMessage?: boolean }) => {
      if (
        options?.isInboundUserMessage === true &&
        (await claimPendingAgentQuestionAnswer({
          sessionKey: params.input.sessionKey ?? params.input.sessionId,
          text,
        }))
      ) {
        return;
      }
      throw new Error("Copilot runtime is not waiting for user input.");
    },
    isStreaming: () => !params.isSettled() && !params.isAborted(),
    isAborted: params.isAborted,
    isCompacting: () => params.bridge?.isCompacting() ?? false,
    sourceReplyDeliveryMode: params.input.sourceReplyDeliveryMode,
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
  return activeRunHandle;
}
