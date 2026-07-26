import { expectDefined } from "@openclaw/normalization-core";
import { getReplyPayloadMetadata, type ReplyPayload } from "../../auto-reply/reply-payload.js";
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

type TranscriptMirrorOwner = {
  agentId?: string;
  expectedSessionId?: string;
  sessionKey: string;
};

type TranscriptMirrorResolution =
  | { kind: "none" }
  | { kind: "invalid" }
  | { kind: "blocked"; owner: TranscriptMirrorOwner }
  | { kind: "owner"; owner: TranscriptMirrorOwner };

function resolveTranscriptMirrorOwner(
  payloads: readonly ReplyPayload[],
): TranscriptMirrorResolution {
  if (payloads.length === 0) {
    return { kind: "none" };
  }
  const owners = payloads.map(
    (payload) => getReplyPayloadMetadata(payload)?.sourceReplyTranscriptMirror,
  );
  // Older source-reply mirrors have neither field and keep their existing source-session
  // behavior. Either field opts the batch into binding-owned transcript handling.
  if (
    owners.every(
      (owner) => owner?.expectedSessionId === undefined && !owner?.transcriptWriteBlocked,
    )
  ) {
    return { kind: "none" };
  }
  const first = owners[0];
  if (!first) {
    return { kind: "invalid" };
  }
  const sessionKey = first.sessionKey.trim();
  const expectedSessionId = first.expectedSessionId?.trim();
  if (first.transcriptWriteBlocked) {
    if (
      !sessionKey ||
      owners.some(
        (owner) =>
          !owner?.transcriptWriteBlocked ||
          owner.sessionKey.trim() !== sessionKey ||
          owner.expectedSessionId?.trim() !== expectedSessionId ||
          owner.agentId !== first.agentId,
      )
    ) {
      return { kind: "invalid" };
    }
    return {
      kind: "blocked",
      owner: {
        sessionKey,
        ...(expectedSessionId ? { expectedSessionId } : {}),
        ...(first.agentId ? { agentId: first.agentId } : {}),
      },
    };
  }
  if (
    !sessionKey ||
    !expectedSessionId ||
    owners.some(
      (owner) =>
        owner?.sessionKey.trim() !== sessionKey ||
        owner.expectedSessionId?.trim() !== expectedSessionId ||
        owner.agentId !== first.agentId ||
        owner.transcriptWriteBlocked === true,
    )
  ) {
    return { kind: "invalid" };
  }
  return {
    kind: "owner",
    owner: {
      sessionKey,
      expectedSessionId,
      ...(first.agentId ? { agentId: first.agentId } : {}),
    },
  };
}

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
  const transcriptMirrorResolution = resolveTranscriptMirrorOwner(rawFinalPayloads);
  const transcriptMirrorOwner =
    transcriptMirrorResolution.kind === "owner" || transcriptMirrorResolution.kind === "blocked"
      ? transcriptMirrorResolution.owner
      : undefined;
  const finalPayloads = await normalizeWebchatReplyMediaPathsForDisplay({
    cfg,
    sessionKey,
    agentId,
    accountId,
    payloads: rawFinalPayloads,
  });
  const requestedTranscriptSession = transcriptMirrorOwner
    ? loadSessionEntry(transcriptMirrorOwner.sessionKey, {
        ...sessionLoadOptions,
        ...(transcriptMirrorOwner.agentId ? { agentId: transcriptMirrorOwner.agentId } : {}),
      })
    : undefined;
  // Binding-owned payloads already retargeted the user turn. Keep the assistant
  // beside it only when that durable target still exists. Never fall back to the
  // source transcript after ownership metadata appears on any final payload.
  const useTranscriptMirrorOwner = Boolean(
    transcriptMirrorResolution.kind === "owner" &&
    transcriptMirrorOwner &&
    requestedTranscriptSession?.entry?.sessionId === transcriptMirrorOwner.expectedSessionId,
  );
  if (transcriptMirrorResolution.kind === "owner" && !useTranscriptMirrorOwner) {
    context.logGateway.warn(
      `webchat transcript append skipped: binding-owned session changed before finalization`,
    );
  }
  if (transcriptMirrorResolution.kind === "invalid") {
    context.logGateway.warn(
      `webchat transcript append skipped: inconsistent binding-owned transcript metadata`,
    );
  }
  if (transcriptMirrorResolution.kind === "blocked") {
    context.logGateway.warn(
      `webchat transcript append skipped: binding-owned user turn was not persisted`,
    );
  }
  const canAppendAssistantTranscript =
    transcriptMirrorResolution.kind === "none" || useTranscriptMirrorOwner;
  const transcriptSessionKey =
    useTranscriptMirrorOwner && transcriptMirrorOwner
      ? transcriptMirrorOwner.sessionKey
      : sessionKey;
  const transcriptAgentId =
    useTranscriptMirrorOwner && transcriptMirrorOwner
      ? (transcriptMirrorOwner.agentId ?? agentId)
      : agentId;
  const resolvedTranscriptSession =
    useTranscriptMirrorOwner && requestedTranscriptSession
      ? requestedTranscriptSession
      : loadSessionEntry(sessionKey, sessionLoadOptions);
  const { storePath: latestStorePath, entry: latestEntry } = resolvedTranscriptSession;
  const sessionId = latestEntry?.sessionId ?? backingSessionId ?? clientRunId;
  const mediaLocalRoots = appendLocalMediaParentRoots(
    getAgentScopedMediaLocalRoots(cfg, transcriptAgentId),
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
    canAppendAssistantTranscript && (transcriptReply || persistedContentForAppend?.length),
  );
  await persistUserTurnTranscript();
  if (shouldAppendAssistantTranscript) {
    const appended = await appendAssistantTranscriptMessage({
      sessionKey: transcriptSessionKey,
      message: transcriptReply,
      ...(persistedContentForAppend?.length ? { content: persistedContentForAppend } : {}),
      sessionId,
      storePath: latestStorePath,
      sessionFile: latestEntry?.sessionFile,
      agentId: transcriptAgentId,
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
