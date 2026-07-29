import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { setGatewayDedupeEntry } from "./agent-job.js";
import { broadcastChatError } from "./chat-broadcast.js";
import type { createChatSendActiveRunOwnership } from "./chat-send-active-run-ownership.js";
import { finalizeChatSendNonAgentReplies } from "./chat-send-nonagent-finalization.js";
import type { createChatSendReplyDispatch } from "./chat-send-reply-dispatch.js";
import type { PreparedChatSendSession } from "./chat-send-session.js";
import { finalizeChatSendSourceReplies } from "./chat-send-source-finalization.js";
import type { GatewayRequestContext } from "./types.js";

type DeliveredReply = ReturnType<typeof createChatSendReplyDispatch>["deliveredReplies"][number];
type ActiveRunOwnership = ReturnType<typeof createChatSendActiveRunOwnership>;

/** Finalize chat.send after inbound dispatch without re-owning steered turns. */
export async function finalizeChatSendPostDispatch(params: {
  accountId: string | undefined;
  activeRunOwnership: ActiveRunOwnership;
  agentId: string | undefined;
  agentRunStarted: boolean;
  clientRunId: string;
  context: GatewayRequestContext;
  deliveredReplies: readonly DeliveredReply[];
  emitFirstAssistantServerTiming: () => void;
  foldCommandBlocks: boolean;
  hasAppendedWebchatAgentMedia: () => boolean;
  persistUserTurnTranscriptBestEffort: () => Promise<void>;
  session: PreparedChatSendSession;
  sessionKey: string;
  userTurnRecorder: Pick<
    UserTurnTranscriptRecorder,
    "hasPersisted" | "hasRuntimePersistencePending" | "isBlocked"
  >;
}): Promise<void> {
  const {
    accountId,
    activeRunOwnership,
    agentId,
    agentRunStarted,
    clientRunId,
    context,
    deliveredReplies,
    emitFirstAssistantServerTiming,
    foldCommandBlocks,
    hasAppendedWebchatAgentMedia,
    persistUserTurnTranscriptBestEffort,
    session,
    sessionKey,
    userTurnRecorder,
  } = params;
  const returnedAgentErrorPayloads = agentRunStarted
    ? deliveredReplies.map((entry) => entry.payload).filter((payload) => payload.isError)
    : [];
  const returnedAgentErrorMessage =
    returnedAgentErrorPayloads
      .map((payload) => payload.text?.trim())
      .filter((text): text is string => Boolean(text))
      .join(" | ") || undefined;
  if (
    agentRunStarted &&
    returnedAgentErrorPayloads.length > 0 &&
    !userTurnRecorder.hasPersisted() &&
    !userTurnRecorder.isBlocked()
  ) {
    await persistUserTurnTranscriptBestEffort();
  }
  if (
    agentRunStarted &&
    returnedAgentErrorPayloads.length === 0 &&
    !userTurnRecorder.hasPersisted() &&
    !userTurnRecorder.isBlocked() &&
    userTurnRecorder.hasRuntimePersistencePending()
  ) {
    await persistUserTurnTranscriptBestEffort();
  }
  let broadcastedSourceReplyFinal = false;
  // Agent runs persist through SessionManager; non-agent turns use gateway fallback.
  // Steered/queued turns already have a runtime owner — do not append again.
  if (activeRunOwnership.shouldFinalizeAsNonAgent(agentRunStarted)) {
    await finalizeChatSendNonAgentReplies({
      accountId,
      context,
      deliveredReplies,
      emitFirstAssistantServerTiming,
      foldCommandBlocks,
      persistUserTurnTranscript: persistUserTurnTranscriptBestEffort,
      session,
      suppressReplies: hasAppendedWebchatAgentMedia(),
    });
  } else {
    broadcastedSourceReplyFinal = await finalizeChatSendSourceReplies({
      accountId,
      context,
      deliveredReplies,
      emitFirstAssistantServerTiming,
      hasReturnedAgentErrorPayloads: returnedAgentErrorPayloads.length > 0,
      session,
    });
  }
  const shouldBroadcastAgentError =
    returnedAgentErrorPayloads.length > 0 && !broadcastedSourceReplyFinal;
  if (shouldBroadcastAgentError) {
    broadcastChatError({
      context,
      runId: clientRunId,
      sessionKey,
      agentId,
      errorMessage: returnedAgentErrorMessage,
    });
  }
  if (!context.chatRunState.hasAbortMarker(clientRunId)) {
    const returnedAgentError = shouldBroadcastAgentError
      ? errorShape(
          ErrorCodes.UNAVAILABLE,
          returnedAgentErrorMessage ?? "agent returned an error payload",
        )
      : undefined;
    setGatewayDedupeEntry({
      dedupe: context.dedupe,
      key: `chat:${clientRunId}`,
      entry: {
        ts: Date.now(),
        ok: !shouldBroadcastAgentError,
        payload: shouldBroadcastAgentError
          ? {
              runId: clientRunId,
              status: "error" as const,
              summary: returnedAgentErrorMessage ?? "agent returned an error payload",
            }
          : { runId: clientRunId, status: "ok" as const },
        ...(returnedAgentError ? { error: returnedAgentError } : {}),
      },
    });
  }
}
