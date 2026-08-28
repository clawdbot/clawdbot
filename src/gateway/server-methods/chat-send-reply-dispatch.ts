import { isAudioFileName } from "@openclaw/media-core/mime";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import {
  getReplyPayloadMetadata,
  stripReplyMediaFailureFallback,
  type ReplyPayload,
} from "../../auto-reply/reply-payload.js";
import type { ReplyDispatcherOptions } from "../../auto-reply/reply/reply-dispatcher.js";
import { readSessionTranscriptWatermark } from "../../config/sessions/session-accessor.js";
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
import { attachManagedOutgoingMediaToMessage } from "../managed-image-attachments.js";
import { loadSessionEntry } from "../session-utils.js";
import { formatForLog } from "../ws-log.js";
import {
  buildAssistantDisplayContentFromReplyPayloads,
  combineNonStreamingReplyParts,
  extractAssistantDisplayTextFromContent,
  hasAssistantDisplayMediaContent,
  isMediaBearingPayload,
  replaceAssistantContentTextBlocks,
} from "./chat-assistant-content.js";
import { isSourceReplyTranscriptMirrorPayload } from "./chat-broadcast.js";
import { normalizeWebchatReplyMediaPathsForDisplay } from "./chat-reply-media.js";
import type { PreparedChatSendSession } from "./chat-send-session.js";
import {
  appendAssistantTranscriptMessage,
  assistantTranscriptScope,
  publishAssistantTranscriptRewrite,
  rewriteAssistantTranscriptMessageByIdempotencyKey,
  rewriteAssistantTranscriptMessageByTurnIndexAndMedia,
} from "./chat-transcript-persistence.js";
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
      const text = payload.text ? stripInlineDirectiveTagsForDelivery(payload.text).text : "";
      if (text.trim() && !isSuppressedControlReplyText(text)) {
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
      return lines.join("\n");
    })
    .filter(Boolean);
  return combineNonStreamingReplyParts(chunks);
}

/** Build delivery options and capture state for the core-owned webchat dispatcher. */
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
  let assistantTranscriptRewriteState = {
    sessionId: undefined as string | undefined,
    generation: null as string | null,
    afterSeq: 0,
  };
  const captureAgentTranscriptStart = () => {
    const current = loadSessionEntry(sessionKey, sessionLoadOptions);
    const sessionId = current.entry?.sessionId ?? backingSessionId;
    const watermark = sessionId
      ? readSessionTranscriptWatermark({
          agentId,
          sessionId,
          sessionKey,
          storePath: current.storePath,
        })
      : { generation: null, maxSeq: null };
    assistantTranscriptRewriteState = {
      sessionId,
      generation: watermark.generation,
      afterSeq: watermark.maxSeq ?? 0,
    };
    return true;
  };
  const { onModelSelected, ...replyPipeline } = createChannelMessageReplyPipeline({
    cfg,
    agentId,
    channel: INTERNAL_MESSAGE_CHANNEL,
  });
  const deliveredReplies: DeliveredChatSendReply[] = [];
  const finalizedAgentMediaTranscriptKeys = new Set<string>();
  let appendedWebchatAgentMedia = false;
  const needsAgentMediaTranscriptFinalization = (payload: ReplyPayload): boolean =>
    isMediaBearingPayload(payload) ||
    Boolean(getReplyPayloadMetadata(payload)?.assistantMediaFailures?.length);
  const agentMediaTranscriptKey = (payload: ReplyPayload): string => {
    const metadata = getReplyPayloadMetadata(payload);
    const ownedIdempotencyKey =
      metadata?.assistantTranscriptOwned === true
        ? metadata.assistantTranscriptIdempotencyKey?.trim()
        : undefined;
    if (ownedIdempotencyKey) {
      return `owned:${ownedIdempotencyKey}`;
    }
    if (metadata?.assistantMessageIndex !== undefined) {
      return `index:${metadata.assistantMessageIndex}`;
    }
    return "unkeyed";
  };
  const appendWebchatAgentMediaTranscriptIfNeeded = async (payload: ReplyPayload) => {
    if (!isAgentRunStarted() || !needsAgentMediaTranscriptFinalization(payload)) {
      return;
    }
    const finalizationKey = agentMediaTranscriptKey(payload);
    if (finalizedAgentMediaTranscriptKeys.has(finalizationKey)) {
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
      managedMediaLocalRoots: mediaLocalRoots,
      includeSensitiveMedia: transcriptPayload.sensitiveMedia !== true,
      onManagedMediaPrepareError: (message) => {
        logGateway.warn(`webchat media embedding skipped attachment: ${message}`);
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
    const transcriptPayloadMetadata = getReplyPayloadMetadata(transcriptPayload);
    const mediaFailures = transcriptPayloadMetadata?.assistantMediaFailures ?? [];
    const mediaNormalizationFailed = mediaFailures.length > 0;
    const persistedContentForAppend =
      hasAssistantDisplayMediaContent(persistedAssistantContent) || mediaNormalizationFailed
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
    const payloadMetadata = getReplyPayloadMetadata(payload);
    const ownedTranscriptIdempotencyKey =
      payloadMetadata?.assistantTranscriptOwned === true
        ? payloadMetadata.assistantTranscriptIdempotencyKey?.trim()
        : undefined;
    const transcriptScope = assistantTranscriptScope({
      sessionKey,
      sessionId,
      storePath: latestStorePath,
      agentId,
    });
    if (ownedTranscriptIdempotencyKey && transcriptScope) {
      // The harness row is the canonical final assistant. Replace that exact
      // identity so media materialization cannot append a parallel reply.
      const rewritten = await rewriteAssistantTranscriptMessageByIdempotencyKey({
        content: persistedContentForAppend,
        idempotencyKey: ownedTranscriptIdempotencyKey,
        scope: transcriptScope,
      });
      if (rewritten) {
        appendedWebchatAgentMedia = true;
        finalizedAgentMediaTranscriptKeys.add(finalizationKey);
        await publishAssistantTranscriptRewrite({
          scope: transcriptScope,
          rewritten: [rewritten],
        });
        if (assistantContent?.length) {
          attachManagedOutgoingMediaToMessage({
            messageId: rewritten.messageId,
            blocks: assistantContent,
          });
        }
        return;
      }
      logGateway.warn(
        "webchat runtime-owned assistant media rewrite skipped: transcript identity not found",
      );
      return;
    }
    const assistantMessageIndex = payloadMetadata?.assistantMessageIndex;
    if (assistantMessageIndex !== undefined && transcriptScope) {
      // Embedded runtimes identify their owned turn by message index, not a persisted key.
      // Require that exact current-turn row and media set so a sibling reply cannot be rewritten.
      const sourceMediaUrls = Array.from(
        new Set(
          payloadMetadata?.assistantTranscriptMediaUrls?.length
            ? payloadMetadata.assistantTranscriptMediaUrls
            : [
                ...(Array.isArray(payload.mediaUrls) ? payload.mediaUrls : []),
                ...(typeof payload.mediaUrl === "string" ? [payload.mediaUrl] : []),
              ],
        ),
      );
      if (assistantTranscriptRewriteState.sessionId !== sessionId) {
        assistantTranscriptRewriteState = {
          sessionId,
          generation: null,
          afterSeq: 0,
        };
      }
      const rewritten = await rewriteAssistantTranscriptMessageByTurnIndexAndMedia({
        afterSeq: assistantTranscriptRewriteState.afterSeq,
        assistantMessageIndex,
        content: persistedContentForAppend,
        expectedGeneration: assistantTranscriptRewriteState.generation,
        mediaUrls: sourceMediaUrls,
        scope: transcriptScope,
      });
      if (rewritten) {
        assistantTranscriptRewriteState.generation = rewritten.generation;
        appendedWebchatAgentMedia = true;
        finalizedAgentMediaTranscriptKeys.add(finalizationKey);
        await publishAssistantTranscriptRewrite({
          scope: transcriptScope,
          rewritten: [rewritten],
        });
        if (assistantContent?.length) {
          attachManagedOutgoingMediaToMessage({
            messageId: rewritten.messageId,
            blocks: assistantContent,
          });
        }
        return;
      }
    }
    const hasOnlyFailureDisplay =
      persistedContentForAppend.some((block) => block.type === "attachment_error") &&
      persistedContentForAppend.every(
        (block) => block.type === "text" || block.type === "attachment_error",
      );
    const runtimeOwnedText = stripReplyMediaFailureFallback(
      transcriptPayload.text,
      mediaFailures,
    )?.trim();
    if (
      assistantMessageIndex === undefined &&
      mediaNormalizationFailed &&
      hasOnlyFailureDisplay &&
      runtimeOwnedText
    ) {
      // Agent message_end owns the text row. Without its identity, appending a failure card
      // would duplicate that row; the live broadcast still carries the visible failure.
      return;
    }
    const appended = await appendAssistantTranscriptMessage({
      sessionKey,
      message: transcriptReply,
      ...(persistedContentForAppend.length ? { content: persistedContentForAppend } : {}),
      sessionId,
      storePath: latestStorePath,
      agentId,
      createIfMissing: true,
      // Runtime message identity is the dedupe boundary; distinct rows must not collapse
      // onto the single unkeyed media fallback used by tool/audio-only payloads.
      idempotencyKey:
        assistantMessageIndex !== undefined && assistantMessageIndex >= 1
          ? `${clientRunId}:assistant-media:${assistantMessageIndex}`
          : `${clientRunId}:assistant-media`,
      ttsSupplement: ttsSupplementMarker,
      cfg,
    });
    if (appended.ok) {
      if (appended.messageId && assistantContent?.length) {
        attachManagedOutgoingMediaToMessage({
          messageId: appended.messageId,
          blocks: assistantContent,
        });
      }
      appendedWebchatAgentMedia = true;
      finalizedAgentMediaTranscriptKeys.add(finalizationKey);
      return;
    }
    logGateway.warn(
      `webchat transcript append failed for media reply: ${appended.error ?? "unknown error"}`,
    );
  };
  const dispatcherOptions: ReplyDispatcherOptions = {
    ...replyPipeline,
    onError: (err) => {
      logGateway.warn(`webchat dispatch failed: ${formatForLog(err)}`);
    },
    deliver: async (payload, info) => {
      const payloadMetadata = getReplyPayloadMetadata(payload);
      if (
        payloadMetadata?.beforeAgentRunBlocked === true ||
        payloadMetadata?.sourceReplyTranscriptMirror?.transcriptWriteBlocked === true
      ) {
        userTurnRecorder.markBlocked();
      }
      switch (info.kind) {
        case "block":
        case "final":
          deliveredReplies.push({ payload, kind: info.kind });
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
  };
  const finalizeAgentMediaTranscript = async () => {
    const latestPayloadByKey = new Map<string, ReplyPayload>();
    const orderedKeys: string[] = [];
    for (const { payload } of deliveredReplies) {
      if (!needsAgentMediaTranscriptFinalization(payload)) {
        continue;
      }
      const key = agentMediaTranscriptKey(payload);
      if (!latestPayloadByKey.has(key)) {
        orderedKeys.push(key);
      }
      latestPayloadByKey.set(key, payload);
    }
    for (const key of orderedKeys) {
      const payload = latestPayloadByKey.get(key);
      if (payload) {
        try {
          await appendWebchatAgentMediaTranscriptIfNeeded(payload);
        } catch (error) {
          logGateway.warn(`webchat media finalization failed: ${formatForLog(error)}`);
        }
      }
    }
  };
  const runAgentMediaTranscript = async <T>(
    admission: { run: (operation: () => Promise<T>) => Promise<T> },
    operation: () => Promise<T>,
  ): Promise<T> => {
    return await admission.run(async () => {
      try {
        return await operation();
      } finally {
        // Stay inside the session admission after the runtime owner unwinds; callers chain
        // post-dispatch persistence from this Promise, and finalizer errors stay best-effort.
        await finalizeAgentMediaTranscript();
      }
    });
  };
  return {
    captureAgentTranscriptStart,
    deliveredReplies,
    dispatcherOptions,
    hasAppendedWebchatAgentMedia: () => appendedWebchatAgentMedia,
    onModelSelected,
    runAgentMediaTranscript,
  };
}
