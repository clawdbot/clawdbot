import {
  getReplyPayloadMetadata,
  isReplyPayloadStatusNotice,
  type ReplyPayload,
} from "../../auto-reply/reply-payload.js";
import {
  appendLocalMediaParentRoots,
  getAgentScopedMediaLocalRoots,
} from "../../media/local-roots.js";
import { attachManagedOutgoingMediaToMessage } from "../managed-image-attachments.js";
import { loadSessionEntry } from "../session-utils.js";
import { formatForLog } from "../ws-log.js";
import {
  buildAssistantReplyContent,
  extractAssistantDisplayTextFromContent,
  hasAssistantDisplayMediaContent,
  hasManagedOutgoingAssistantContent,
  hasVisibleAssistantFinalMessage,
  stripManagedOutgoingAssistantContentBlocks,
  type AssistantDisplayContentBlock,
} from "./chat-assistant-content.js";
import { broadcastChatFinal, isSourceReplyTranscriptMirrorPayload } from "./chat-broadcast.js";
import { normalizeWebchatReplyMediaPathsForDisplay } from "./chat-reply-media.js";
import { isChatSendReplyDeliveryAuthorized } from "./chat-send-delivery-authority.js";
import { buildTranscriptReplyText } from "./chat-send-reply-dispatch.js";
import type { PreparedChatSendSession } from "./chat-send-session.js";
import {
  assistantTranscriptScope,
  publishAssistantTranscriptRewrite,
  rewriteSourceReplyTranscriptMirrors,
  type SourceReplyContentState,
  type SourceReplyTranscriptMirrorMetadata,
} from "./chat-transcript-persistence.js";
import { buildWebchatAssistantMessageFromReplyPayloads } from "./chat-webchat-media.js";
import type { GatewayRequestContext } from "./types.js";

type DeliveredReply = {
  payload: ReplyPayload;
  kind: "block" | "final";
};

function selectChatSendAgentReplyPayloads(params: {
  deliveredReplies: readonly DeliveredReply[];
  hasReturnedAgentErrorPayloads: boolean;
}): ReplyPayload[] {
  return params.deliveredReplies
    .filter((entry) => {
      const { payload } = entry;
      return getReplyPayloadMetadata(payload)?.sessionWriterDeliveryAuthority ||
        isSourceReplyTranscriptMirrorPayload(payload)
        ? entry.kind === "final" && payload.isError !== true
        : !params.hasReturnedAgentErrorPayloads && isReplyPayloadStatusNotice(payload);
    })
    .map((entry) => entry.payload);
}

type FinalizeChatSendAgentRepliesBase = {
  accountId: string | undefined;
  context: GatewayRequestContext;
  emitFirstAssistantServerTiming: () => void;
  session: Pick<
    PreparedChatSendSession,
    "agentId" | "backingSessionId" | "cfg" | "clientRunId" | "sessionKey" | "sessionLoadOptions"
  >;
};

type ChatSendAgentReplyFinalization =
  | { kind: "delivered"; hasSourceReplyTranscriptMirror: boolean }
  | { kind: "dropped"; reason: "no-visible-content" };

export function createChatSendLateReplyFinalizer(
  params: Omit<FinalizeChatSendAgentRepliesBase, "emitFirstAssistantServerTiming">,
) {
  return async ({ runId, payloads }: { runId: string; payloads: ReplyPayload[] }) =>
    await finalizeChatSendAgentReplyPayloads({
      ...params,
      emitFirstAssistantServerTiming: () => {},
      payloads,
      session: { ...params.session, clientRunId: runId },
    });
}

async function finalizeChatSendAgentReplyPayloads(
  params: FinalizeChatSendAgentRepliesBase & {
    payloads: readonly ReplyPayload[];
    suppressFinal?: boolean;
  },
): Promise<ChatSendAgentReplyFinalization> {
  const { accountId, context, emitFirstAssistantServerTiming, session } = params;
  const { agentId, backingSessionId, cfg, clientRunId, sessionKey, sessionLoadOptions } = session;
  const agentRunReplyPayloads = [...params.payloads];
  if (agentRunReplyPayloads.length === 0) {
    return { kind: "dropped", reason: "no-visible-content" };
  }
  const deliveryAuthorized = () =>
    agentRunReplyPayloads.every((payload) =>
      isChatSendReplyDeliveryAuthorized({ agentId, payload, sessionLoadOptions }),
    );
  if (!deliveryAuthorized()) {
    context.logGateway.warn(
      "webchat settled final reply skipped: session writer changed before finalization",
    );
    return { kind: "dropped", reason: "no-visible-content" };
  }

  const hasSourceReplyTranscriptMirror = agentRunReplyPayloads.some(
    isSourceReplyTranscriptMirrorPayload,
  );
  const finalPayloads = await normalizeWebchatReplyMediaPathsForDisplay({
    cfg,
    sessionKey,
    agentId,
    accountId,
    payloads: agentRunReplyPayloads,
  });
  const { storePath: latestStorePath, entry: latestEntry } = loadSessionEntry(
    sessionKey,
    sessionLoadOptions,
  );
  const sessionId = latestEntry?.sessionId ?? backingSessionId ?? clientRunId;
  const mediaLocalRoots = appendLocalMediaParentRoots(
    getAgentScopedMediaLocalRoots(cfg, agentId),
    latestStorePath ? [latestStorePath] : undefined,
  );
  const buildReplyContent = async (payloads: typeof finalPayloads) => {
    const mediaMessage = await buildWebchatAssistantMessageFromReplyPayloads(payloads, {
      localRoots: mediaLocalRoots,
      onLocalAudioAccessDenied: (err) => {
        context.logGateway.warn(`webchat audio embedding denied local path: ${formatForLog(err)}`);
      },
    });
    const content = await buildAssistantReplyContent({
      sessionKey,
      agentId,
      payloads,
      transcriptMediaMessage: mediaMessage,
      managedMediaLocalRoots: mediaLocalRoots,
      includeSensitiveMedia: false,
      onManagedMediaPrepareError: (message) => {
        context.logGateway.warn(`webchat media embedding skipped attachment: ${message}`);
      },
    });
    return { ...content, mediaMessage };
  };
  const sourceReplyContentStates: SourceReplyContentState[] = [];
  const sourceReplyBroadcastContent: AssistantDisplayContentBlock[] = [];
  for (const [replyIndex] of agentRunReplyPayloads.entries()) {
    const finalPayload = finalPayloads[replyIndex];
    if (!finalPayload) {
      continue;
    }
    const {
      assistantContent: replyAssistantContent,
      persistedAssistantContent: persistedContent,
      mediaMessage: replyMediaMessage,
    } = await buildReplyContent([finalPayload]);
    const replyBroadcastContent = hasAssistantDisplayMediaContent(replyAssistantContent)
      ? replyAssistantContent
      : hasAssistantDisplayMediaContent(replyMediaMessage?.content)
        ? replyMediaMessage?.content
        : replyAssistantContent;
    const state: SourceReplyContentState = {
      broadcastContent: replyBroadcastContent ? [...replyBroadcastContent] : [],
      persistedContent: persistedContent ? [...persistedContent] : [],
      hasManagedOutgoingContent: hasManagedOutgoingAssistantContent(persistedContent),
      backedManagedOutgoingContent: false,
    };
    sourceReplyContentStates[replyIndex] = state;
    if (state.broadcastContent.length > 0) {
      sourceReplyBroadcastContent.push(...state.broadcastContent);
    }
  }

  const displayReply =
    extractAssistantDisplayTextFromContent(sourceReplyBroadcastContent) ??
    buildTranscriptReplyText(finalPayloads);
  if (!sourceReplyBroadcastContent.length && !displayReply) {
    return { kind: "dropped", reason: "no-visible-content" };
  }

  const sourceReplyPersistenceRequests: Array<{
    idempotencyKey: string;
    metadata: SourceReplyTranscriptMirrorMetadata;
    state: SourceReplyContentState;
  }> = [];
  for (const [replyIndex, sourceReplyPayload] of agentRunReplyPayloads.entries()) {
    const state = sourceReplyContentStates[replyIndex];
    if (!state || !hasAssistantDisplayMediaContent(state.persistedContent)) {
      continue;
    }
    const mirrorMetadata = getReplyPayloadMetadata(sourceReplyPayload)?.sourceReplyTranscriptMirror;
    const mirrorIdempotencyKey = mirrorMetadata?.idempotencyKey;
    if (typeof mirrorIdempotencyKey !== "string" || mirrorIdempotencyKey.trim().length === 0) {
      continue;
    }
    if (!state.hasManagedOutgoingContent) {
      state.backedManagedOutgoingContent = true;
    }
    sourceReplyPersistenceRequests.push({
      idempotencyKey: mirrorIdempotencyKey,
      metadata: mirrorMetadata,
      state,
    });
  }
  const sourceReplyMirrorCandidates: Array<{
    idempotencyKey: string;
    metadata: SourceReplyTranscriptMirrorMetadata;
  }> = [];
  for (const [replyIndex, sourceReplyPayload] of agentRunReplyPayloads.entries()) {
    if (!sourceReplyContentStates[replyIndex]) {
      continue;
    }
    const mirrorMetadata = getReplyPayloadMetadata(sourceReplyPayload)?.sourceReplyTranscriptMirror;
    const mirrorIdempotencyKey = mirrorMetadata?.idempotencyKey;
    if (
      typeof mirrorIdempotencyKey !== "string" ||
      mirrorIdempotencyKey.trim().length === 0 ||
      !mirrorMetadata
    ) {
      continue;
    }
    sourceReplyMirrorCandidates.push({
      idempotencyKey: mirrorIdempotencyKey,
      metadata: mirrorMetadata,
    });
  }

  const attachSourceReplyManagedImages = async (attachParams: {
    messageId?: string;
    request: (typeof sourceReplyPersistenceRequests)[number];
  }) => {
    if (!attachParams.request.state.hasManagedOutgoingContent) {
      attachParams.request.state.backedManagedOutgoingContent = true;
      return;
    }
    if (!attachParams.messageId) {
      return;
    }
    attachManagedOutgoingMediaToMessage({
      messageId: attachParams.messageId,
      blocks: attachParams.request.state.persistedContent,
    });
    attachParams.request.state.backedManagedOutgoingContent = true;
  };

  const sourceReplyScope = assistantTranscriptScope({
    sessionId,
    sessionKey,
    storePath: latestStorePath,
    agentId,
  });
  if (!deliveryAuthorized()) {
    context.logGateway.warn(
      "webchat settled final reply skipped: session writer changed before transcript finalization",
    );
    return { kind: "dropped", reason: "no-visible-content" };
  }
  if (sourceReplyScope && sourceReplyPersistenceRequests.length > 0) {
    const rewritten = await rewriteSourceReplyTranscriptMirrors({
      candidates: sourceReplyMirrorCandidates,
      requests: sourceReplyPersistenceRequests,
      scope: sourceReplyScope,
    });
    if (rewritten.length > 0) {
      await publishAssistantTranscriptRewrite({
        scope: sourceReplyScope,
        rewritten,
      });
      for (const target of rewritten) {
        await attachSourceReplyManagedImages({
          messageId: target.messageId,
          request: target.request,
        });
      }
    }
  }
  const sourceReplyContent = sourceReplyContentStates
    .flatMap((state) => {
      if (state.hasManagedOutgoingContent && !state.backedManagedOutgoingContent) {
        const stripped = stripManagedOutgoingAssistantContentBlocks(state.broadcastContent);
        return stripped?.length
          ? stripped
          : [{ type: "text", text: "Media reply could not be displayed." }];
      }
      return state.broadcastContent;
    })
    .filter((block): block is AssistantDisplayContentBlock => Boolean(block));
  const sourceReplyTextFromContent = extractAssistantDisplayTextFromContent(sourceReplyContent);
  const sourceReplyText =
    sourceReplyTextFromContent ?? (sourceReplyContent.length === 0 ? displayReply : undefined);
  const message = {
    role: "assistant",
    ...(sourceReplyContent.length
      ? { content: sourceReplyContent }
      : sourceReplyText
        ? { content: [{ type: "text", text: sourceReplyText }] }
        : {}),
    ...(sourceReplyText ? { text: sourceReplyText } : {}),
    timestamp: Date.now(),
    stopReason: "stop",
    usage: { input: 0, output: 0, totalTokens: 0 },
  };
  // Failed turns retain source media/transcript finalization; chat.error carries no message.
  if (!params.suppressFinal) {
    if (!deliveryAuthorized()) {
      context.logGateway.warn(
        "webchat settled final reply skipped: session writer changed before broadcast",
      );
      return { kind: "dropped", reason: "no-visible-content" };
    }
    if (hasVisibleAssistantFinalMessage(message)) {
      emitFirstAssistantServerTiming();
    }
    broadcastChatFinal({
      context,
      runId: clientRunId,
      sessionKey,
      agentId,
      message,
    });
  }
  return { kind: "delivered", hasSourceReplyTranscriptMirror };
}

/** Persist and broadcast agent-run source/status replies that bypass the normal model turn. */
export async function finalizeChatSendSourceReplies(
  params: FinalizeChatSendAgentRepliesBase & {
    deliveredReplies: readonly DeliveredReply[];
    hasReturnedAgentErrorPayloads: boolean;
    suppressFinal?: boolean;
  },
): Promise<boolean> {
  const result = await finalizeChatSendAgentReplyPayloads({
    accountId: params.accountId,
    context: params.context,
    emitFirstAssistantServerTiming: params.emitFirstAssistantServerTiming,
    payloads: selectChatSendAgentReplyPayloads(params),
    session: params.session,
    suppressFinal: params.suppressFinal,
  });
  return result.kind === "delivered" && result.hasSourceReplyTranscriptMirror;
}
