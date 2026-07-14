import { isAudioFileName } from "@openclaw/media-core/mime";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { getReplyPayloadMetadata, type ReplyPayload } from "../../auto-reply/reply-payload.js";
import { createReplyDispatcher } from "../../auto-reply/reply/reply-dispatcher.js";
import {
  appendLocalMediaParentRoots,
  getAgentScopedMediaLocalRoots,
} from "../../media/local-roots.js";
import { createChannelMessageReplyPipeline } from "../../plugin-sdk/channel-outbound.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import {
  parseInlineDirectives,
  stripInlineDirectiveTagsForDelivery,
  sanitizeReplyDirectiveId,
} from "../../utils/directive-tags.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import { isSuppressedControlReplyText } from "../control-reply-text.js";
import { attachManagedOutgoingImagesToMessage } from "../managed-image-attachments.js";
import { loadSessionEntry } from "../session-utils.js";
import { formatForLog } from "../ws-log.js";
import {
  buildAssistantDisplayContentFromReplyPayloads,
  extractAssistantDisplayTextFromContent,
  hasAssistantDisplayMediaContent,
  isMediaBearingPayload,
  replaceAssistantContentTextBlocks,
} from "./chat-assistant-content.js";
import { isSourceReplyTranscriptMirrorPayload } from "./chat-broadcast.js";
import { normalizeWebchatReplyMediaPathsForDisplay } from "./chat-reply-media.js";
import type { PreparedChatSendSession } from "./chat-send-session.js";
import { appendAssistantTranscriptMessage } from "./chat-transcript-persistence.js";
import {
  buildTtsSupplementTranscriptMarker,
  stripVisibleTextFromTtsSupplement,
} from "./chat-tts-markers.js";
import { buildWebchatAssistantMessageFromReplyPayloads } from "./chat-webchat-media.js";
import type { GatewayRequestContext } from "./types.js";

type DeliveredChatSendReply = {
  payload: ReplyPayload;
  kind: "block" | "final";
};

export function buildTranscriptReplyText(payloads: ReplyPayload[]): string {
  const chunks = payloads
    .map((payload) => {
      if (payload.isReasoning === true) {
        return "";
      }
      const parts = resolveSendableOutboundReplyParts(payload);
      const lines: string[] = [];
      const parsedText = payload.text?.includes("[[")
        ? parseInlineDirectives(payload.text)
        : undefined;
      const replyToId =
        sanitizeReplyDirectiveId(payload.replyToId) ??
        sanitizeReplyDirectiveId(parsedText?.replyToExplicitId);
      if (replyToId) {
        lines.push(`[[reply_to:${replyToId}]]`);
      } else if (payload.replyToCurrent || parsedText?.replyToCurrent) {
        lines.push("[[reply_to_current]]");
      }
      const text = payload.text
        ? stripInlineDirectiveTagsForDelivery(payload.text).text.trim()
        : "";
      if (text && !isSuppressedControlReplyText(text)) {
        lines.push(text);
      }
      for (const mediaUrl of parts.mediaUrls) {
        if (payload.sensitiveMedia === true) {
          continue;
        }
        const trimmed = mediaUrl.trim();
        if (trimmed) {
          lines.push(`Attachment: ${trimmed}`);
        }
      }
      if (
        (payload.audioAsVoice || parsedText?.audioAsVoice) &&
        parts.mediaUrls.some((mediaUrl) => isAudioFileName(mediaUrl))
      ) {
        lines.push("[[audio_as_voice]]");
      }
      return lines.join("\n").trim();
    })
    .filter(Boolean);
  return chunks.join("\n\n").trim();
}

/** Build the live reply dispatcher and capture payloads for post-dispatch projection. */
export function createChatSendReplyDispatch(params: {
  accountId: string | undefined;
  isAgentRunStarted: () => boolean;
  logGateway: GatewayRequestContext["logGateway"];
  session: Pick<
    PreparedChatSendSession,
    "agentId" | "backingSessionId" | "cfg" | "clientRunId" | "sessionKey" | "sessionLoadOptions"
  >;
  userTurnRecorder: Pick<UserTurnTranscriptRecorder, "markBlocked">;
}) {
  const { accountId, isAgentRunStarted, logGateway, session, userTurnRecorder } = params;
  const { agentId, backingSessionId, cfg, clientRunId, sessionKey, sessionLoadOptions } = session;
  const { onModelSelected, ...replyPipeline } = createChannelMessageReplyPipeline({
    cfg,
    agentId,
    channel: INTERNAL_MESSAGE_CHANNEL,
  });
  const deliveredReplies: DeliveredChatSendReply[] = [];
  let appendedWebchatAgentMedia = false;
  const appendWebchatAgentMediaTranscriptIfNeeded = async (payload: ReplyPayload) => {
    if (!isAgentRunStarted() || appendedWebchatAgentMedia || !isMediaBearingPayload(payload)) {
      return;
    }
    if (isSourceReplyTranscriptMirrorPayload(payload)) {
      return;
    }
    const ttsSupplementMarker = buildTtsSupplementTranscriptMarker(payload);
    const [transcriptPayload] = await normalizeWebchatReplyMediaPathsForDisplay({
      cfg,
      sessionKey,
      agentId,
      accountId,
      payloads: [stripVisibleTextFromTtsSupplement(payload)],
    });
    if (!transcriptPayload) {
      return;
    }
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
      payloads: [transcriptPayload],
      managedImageLocalRoots: mediaLocalRoots,
      includeSensitiveMedia: transcriptPayload.sensitiveMedia !== true,
      onLocalAudioAccessDenied: (message) => {
        logGateway.warn(`webchat audio embedding denied local path: ${message}`);
      },
      onManagedImagePrepareError: (message) => {
        logGateway.warn(`webchat image embedding skipped attachment: ${message}`);
      },
    });
    const mediaMessage = await buildWebchatAssistantMessageFromReplyPayloads([transcriptPayload], {
      localRoots: mediaLocalRoots,
      onLocalAudioAccessDenied: (err) => {
        logGateway.warn(`webchat audio embedding denied local path: ${formatForLog(err)}`);
      },
    });
    const persistedAssistantContent = replaceAssistantContentTextBlocks(
      assistantContent,
      mediaMessage,
    );
    const persistedContentForAppend = hasAssistantDisplayMediaContent(persistedAssistantContent)
      ? persistedAssistantContent
      : undefined;
    if (!persistedContentForAppend?.length) {
      return;
    }
    const transcriptReply =
      mediaMessage?.transcriptText ??
      extractAssistantDisplayTextFromContent(assistantContent) ??
      buildTranscriptReplyText([transcriptPayload]);
    if (!transcriptReply && !persistedAssistantContent?.length && !assistantContent?.length) {
      return;
    }
    const appended = await appendAssistantTranscriptMessage({
      sessionKey,
      message: transcriptReply,
      ...(persistedContentForAppend.length ? { content: persistedContentForAppend } : {}),
      sessionId,
      storePath: latestStorePath,
      sessionFile: latestEntry?.sessionFile,
      agentId,
      createIfMissing: true,
      idempotencyKey: `${clientRunId}:assistant-media`,
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
      appendedWebchatAgentMedia = true;
      return;
    }
    logGateway.warn(
      `webchat transcript append failed for media reply: ${appended.error ?? "unknown error"}`,
    );
  };
  const dispatcher = createReplyDispatcher({
    ...replyPipeline,
    onError: (err) => {
      logGateway.warn(`webchat dispatch failed: ${formatForLog(err)}`);
    },
    deliver: async (payload, info) => {
      if (getReplyPayloadMetadata(payload)?.beforeAgentRunBlocked === true) {
        userTurnRecorder.markBlocked();
      }
      switch (info.kind) {
        case "block":
        case "final":
          deliveredReplies.push({ payload, kind: info.kind });
          await appendWebchatAgentMediaTranscriptIfNeeded(payload);
          break;
        case "tool":
          // TTS tool media becomes a final payload so downstream audio extraction sees it.
          if (isMediaBearingPayload(payload)) {
            deliveredReplies.push({
              payload: { ...payload, text: undefined },
              kind: "final",
            });
          }
          break;
      }
    },
  });
  return {
    deliveredReplies,
    dispatcher,
    hasAppendedWebchatAgentMedia: () => appendedWebchatAgentMedia,
    onModelSelected,
  };
}
