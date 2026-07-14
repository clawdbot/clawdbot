import { expectDefined } from "@openclaw/normalization-core";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import {
  appendLocalMediaParentRoots,
  getAgentScopedMediaLocalRoots,
} from "../../media/local-roots.js";
import { stripInlineDirectiveTagsForDisplay } from "../../utils/directive-tags.js";
import { attachManagedOutgoingImagesToMessage } from "../managed-image-attachments.js";
import { loadSessionEntry } from "../session-utils.js";
import { formatForLog } from "../ws-log.js";
import {
  buildAssistantDisplayContentFromReplyPayloads,
  extractAssistantDisplayText,
  extractAssistantDisplayTextFromContent,
  hasAssistantDisplayMediaContent,
  hasSensitiveMediaPayload,
  hasVisibleAssistantFinalMessage,
  replaceAssistantContentTextBlocks,
  stripManagedOutgoingAssistantContentBlocks,
} from "./chat-assistant-content.js";
import { broadcastChatFinal, broadcastSideResult, isBtwReplyPayload } from "./chat-broadcast.js";
import { normalizeWebchatReplyMediaPathsForDisplay } from "./chat-reply-media.js";
import { selectChatSendFinalReplyPayloads } from "./chat-send-command-replies.js";
import { buildTranscriptReplyText } from "./chat-send-reply-dispatch.js";
import type { PreparedChatSendSession } from "./chat-send-session.js";
import type { GatewayInjectedTtsSupplementMarker } from "./chat-transcript-inject.js";
import { appendAssistantTranscriptMessage } from "./chat-transcript-persistence.js";
import { buildMediaOnlyTtsSupplementTranscriptMarker } from "./chat-tts-markers.js";
import { buildWebchatAssistantMessageFromReplyPayloads } from "./chat-webchat-media.js";
import type { GatewayRequestContext } from "./types.js";

type DeliveredReply = {
  payload: ReplyPayload;
  kind: "block" | "final";
};

function buildChatSendBtwSideResult(deliveredReplies: readonly DeliveredReply[]) {
  const replies = deliveredReplies.map((entry) => entry.payload).filter(isBtwReplyPayload);
  const text = replies
    .map((payload) => payload.text.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
  if (replies.length === 0 || !text) {
    return undefined;
  }
  return {
    question: expectDefined(replies[0], "btw replies entry at 0").btw.question.trim(),
    text,
    isError: replies.some((payload) => payload.isError),
  };
}

/** Persist and broadcast replies produced without a runtime-owned agent assistant turn. */
export async function finalizeChatSendNonAgentReplies(params: {
  accountId: string | undefined;
  context: GatewayRequestContext;
  deliveredReplies: readonly DeliveredReply[];
  emitFirstAssistantServerTiming: () => void;
  foldCommandBlocks: boolean;
  persistUserTurnTranscript: () => Promise<void>;
  session: Pick<
    PreparedChatSendSession,
    "agentId" | "backingSessionId" | "cfg" | "clientRunId" | "sessionKey" | "sessionLoadOptions"
  >;
  suppressReplies: boolean;
}): Promise<void> {
  const {
    accountId,
    context,
    deliveredReplies,
    emitFirstAssistantServerTiming,
    foldCommandBlocks,
    persistUserTurnTranscript,
    session,
    suppressReplies,
  } = params;
  const { agentId, backingSessionId, cfg, clientRunId, sessionKey, sessionLoadOptions } = session;
  const btwResult = buildChatSendBtwSideResult(deliveredReplies);
  if (btwResult) {
    broadcastSideResult({
      context,
      payload: {
        kind: "btw",
        runId: clientRunId,
        sessionKey,
        ...(sessionKey === "global" && agentId ? { agentId } : {}),
        ...btwResult,
        ts: Date.now(),
      },
    });
    broadcastChatFinal({
      context,
      runId: clientRunId,
      sessionKey,
      agentId,
    });
    return;
  }

  const rawFinalPayloads = selectChatSendFinalReplyPayloads({
    deliveredReplies,
    foldCommandBlocks,
    suppressReplies,
  });
  const finalPayloads = await normalizeWebchatReplyMediaPathsForDisplay({
    cfg,
    sessionKey,
    agentId,
    accountId,
    payloads: rawFinalPayloads,
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
  const assistantContent = await buildAssistantDisplayContentFromReplyPayloads({
    sessionKey,
    agentId,
    payloads: finalPayloads,
    managedImageLocalRoots: mediaLocalRoots,
    includeSensitiveMedia: false,
    includeSensitiveDisplay: true,
    onLocalAudioAccessDenied: (message) => {
      context.logGateway.warn(`webchat audio embedding denied local path: ${message}`);
    },
    onManagedImagePrepareError: (message) => {
      context.logGateway.warn(`webchat image embedding skipped attachment: ${message}`);
    },
    onSensitiveDisplayPrepareError: (message) => {
      context.logGateway.warn(`webchat sensitive display skipped attachment: ${message}`);
    },
  });
  const mediaMessage = await buildWebchatAssistantMessageFromReplyPayloads(finalPayloads, {
    localRoots: mediaLocalRoots,
    onLocalAudioAccessDenied: (err) => {
      context.logGateway.warn(`webchat audio embedding denied local path: ${formatForLog(err)}`);
    },
  });
  const hasSensitiveMedia = hasSensitiveMediaPayload(finalPayloads);
  const ttsSupplementMarker = finalPayloads
    .map((payload) => buildMediaOnlyTtsSupplementTranscriptMarker(payload))
    .find((marker): marker is GatewayInjectedTtsSupplementMarker => Boolean(marker));
  const persistedAssistantContent = replaceAssistantContentTextBlocks(
    hasSensitiveMedia
      ? await buildAssistantDisplayContentFromReplyPayloads({
          sessionKey,
          agentId,
          payloads: finalPayloads,
          managedImageLocalRoots: mediaLocalRoots,
          includeSensitiveMedia: false,
          onLocalAudioAccessDenied: (message) => {
            context.logGateway.warn(`webchat audio embedding denied local path: ${message}`);
          },
          onManagedImagePrepareError: (message) => {
            context.logGateway.warn(`webchat image embedding skipped attachment: ${message}`);
          },
        })
      : assistantContent,
    mediaMessage,
  );
  const persistedContentForAppend = hasAssistantDisplayMediaContent(persistedAssistantContent)
    ? persistedAssistantContent
    : undefined;
  const broadcastAssistantContent = hasAssistantDisplayMediaContent(assistantContent)
    ? assistantContent
    : hasAssistantDisplayMediaContent(mediaMessage?.content)
      ? mediaMessage?.content
      : assistantContent;
  const displayReply =
    extractAssistantDisplayTextFromContent(assistantContent) ??
    buildTranscriptReplyText(finalPayloads);
  const transcriptDisplayReply = displayReply
    ? stripInlineDirectiveTagsForDisplay(displayReply).text.trim()
    : "";
  const transcriptReply =
    mediaMessage?.transcriptText ||
    buildTranscriptReplyText(finalPayloads) ||
    transcriptDisplayReply;
  let message: Record<string, unknown> | undefined;
  const shouldAppendAssistantTranscript = Boolean(
    transcriptReply || persistedContentForAppend?.length,
  );
  await persistUserTurnTranscript();
  if (shouldAppendAssistantTranscript) {
    const appended = await appendAssistantTranscriptMessage({
      sessionKey,
      message: transcriptReply,
      ...(persistedContentForAppend?.length ? { content: persistedContentForAppend } : {}),
      sessionId,
      storePath: latestStorePath,
      sessionFile: latestEntry?.sessionFile,
      agentId,
      createIfMissing: true,
      idempotencyKey: clientRunId,
      ttsSupplement: ttsSupplementMarker,
      cfg,
    });
    if (appended.ok) {
      if (appended.messageId && assistantContent?.length) {
        await attachManagedOutgoingImagesToMessage({
          messageId: appended.messageId,
          blocks: assistantContent,
        });
      }
      message = broadcastAssistantContent?.length
        ? { ...appended.message, content: broadcastAssistantContent }
        : appended.message;
    } else {
      context.logGateway.warn(
        `webchat transcript append failed: ${appended.error ?? "unknown error"}`,
      );
      const fallbackAssistantContent =
        stripManagedOutgoingAssistantContentBlocks(persistedAssistantContent) ??
        stripManagedOutgoingAssistantContentBlocks(assistantContent);
      const fallbackText = extractAssistantDisplayText(fallbackAssistantContent) ?? displayReply;
      message = {
        role: "assistant",
        ...(fallbackAssistantContent?.length
          ? { content: fallbackAssistantContent }
          : fallbackText
            ? { content: [{ type: "text", text: fallbackText }] }
            : {}),
        ...(fallbackText ? { text: fallbackText } : {}),
        timestamp: Date.now(),
        ...(ttsSupplementMarker ? { openclawTtsSupplement: ttsSupplementMarker } : {}),
        // Keep compatible with runner stopReason enums when transcript persistence fails.
        stopReason: "stop",
        usage: { input: 0, output: 0, totalTokens: 0 },
      };
    }
  } else if (broadcastAssistantContent?.length) {
    message = {
      role: "assistant",
      content: broadcastAssistantContent,
      text: extractAssistantDisplayText(broadcastAssistantContent) ?? "",
      timestamp: Date.now(),
      stopReason: "stop",
      usage: { input: 0, output: 0, totalTokens: 0 },
    };
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
