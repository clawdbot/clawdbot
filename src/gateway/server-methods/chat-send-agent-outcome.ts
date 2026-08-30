import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import type { AgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.js";
import { readToolValidationErrorSummary } from "../../agents/tool-error-summary.js";
import { setGatewayDedupeEntry } from "../agent-turn/agent-job.js";
import { createChatAbortMarker } from "../server-chat-state.js";
import { buildAbortedChatSendPayload } from "./chat-abort-authorization.js";
import { broadcastChatAborted, broadcastChatError, broadcastChatFinal } from "./chat-broadcast.js";
import type { GatewayRequestContext } from "./types.js";

type ChatSendAgentOutcomeContext = Pick<
  GatewayRequestContext,
  "agentRunSeq" | "broadcast" | "chatRunState" | "dedupe" | "getRuntimeConfig" | "nodeSendToSession"
>;

export function finalizeChatSendAgentOutcome(params: {
  context: ChatSendAgentOutcomeContext;
  runId: string;
  sessionKey: string;
  agentId?: string;
  hasReturnedAgentErrorPayloads: boolean;
  broadcastedSourceReplyFinal: boolean;
  successfulFinalOwnedElsewhere?: boolean;
  markTerminalBroadcasted: () => void;
  terminalAlreadyBroadcasted?: boolean;
  returnedAgentErrorMessage?: string;
  runtimeClassification?: "cancellation" | "failure" | "success" | "timeout";
  runtimeOutcome?: Pick<AgentRunTerminalOutcome, "endedAt" | "stopReason">;
  toolErrorSummary?: string;
}): void {
  const alreadyAborted = params.context.chatRunState.hasAbortMarker(params.runId);
  const hasReturnedAgentError =
    params.hasReturnedAgentErrorPayloads && !params.broadcastedSourceReplyFinal;
  const validationAbortErrorMessage = hasReturnedAgentError
    ? readToolValidationErrorSummary(params.toolErrorSummary)
    : undefined;
  const hasUnbroadcastAgentError =
    hasReturnedAgentError && !alreadyAborted && !params.terminalAlreadyBroadcasted;
  const shouldBroadcastValidationAbort =
    hasUnbroadcastAgentError && validationAbortErrorMessage !== undefined;
  const shouldBroadcastAgentError = hasUnbroadcastAgentError && !shouldBroadcastValidationAbort;
  const shouldBroadcastSuccessfulFinal =
    params.context.agentRunSeq.has(params.runId) &&
    !hasReturnedAgentError &&
    !alreadyAborted &&
    !params.terminalAlreadyBroadcasted &&
    !params.successfulFinalOwnedElsewhere;

  if (
    shouldBroadcastValidationAbort ||
    shouldBroadcastAgentError ||
    shouldBroadcastSuccessfulFinal
  ) {
    params.markTerminalBroadcasted();
  }

  // A validated tool summary is already the authoritative safe terminal result.
  // It must win over the generic agent error returned after dispatch.
  if (shouldBroadcastValidationAbort) {
    params.context.chatRunState.getOrCreate(params.runId).abortMarker = createChatAbortMarker();
    broadcastChatAborted({
      context: params.context,
      runId: params.runId,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      errorMessage: validationAbortErrorMessage,
    });
  } else if (shouldBroadcastAgentError) {
    broadcastChatError({
      context: params.context,
      runId: params.runId,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      errorMessage: params.returnedAgentErrorMessage,
    });
  } else if (shouldBroadcastSuccessfulFinal) {
    broadcastChatFinal({
      context: params.context,
      runId: params.runId,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
    });
  }

  if (alreadyAborted) {
    return;
  }

  const terminalErrorMessage = validationAbortErrorMessage ?? params.returnedAgentErrorMessage;
  const returnedAgentError = hasReturnedAgentError
    ? errorShape(ErrorCodes.UNAVAILABLE, terminalErrorMessage ?? "agent returned an error payload")
    : undefined;
  setGatewayDedupeEntry({
    dedupe: params.context.dedupe,
    key: `chat:${params.runId}`,
    entry: {
      ts: Date.now(),
      ok: !hasReturnedAgentError,
      payload: hasReturnedAgentError
        ? {
            runId: params.runId,
            status:
              params.runtimeClassification === "timeout"
                ? ("timeout" as const)
                : ("error" as const),
            summary: terminalErrorMessage ?? "agent returned an error payload",
            ...(params.runtimeOutcome ? { endedAt: params.runtimeOutcome.endedAt } : {}),
            ...(params.runtimeOutcome?.stopReason
              ? { stopReason: params.runtimeOutcome.stopReason }
              : {}),
          }
        : params.runtimeClassification === "cancellation"
          ? buildAbortedChatSendPayload({
              runId: params.runId,
              endedAt: params.runtimeOutcome?.endedAt ?? Date.now(),
              stopReason: params.runtimeOutcome?.stopReason,
            })
          : {
              runId: params.runId,
              status: "ok" as const,
              ...(params.runtimeOutcome?.stopReason
                ? { stopReason: params.runtimeOutcome.stopReason }
                : {}),
            },
      ...(returnedAgentError ? { error: returnedAgentError } : {}),
    },
  });
}
