// Matrix plugin module implements replies behavior.
import { randomUUID } from "node:crypto";
import {
  createChannelPartialDeliveryError,
  isChannelPartialDeliveryError,
} from "openclaw/plugin-sdk/channel-inbound";
import {
  createMessageReceiptFromOutboundResults,
  listMessageReceiptPlatformIds,
  type MessageReceipt,
} from "openclaw/plugin-sdk/channel-outbound";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { stripReasoningTagsFromText } from "openclaw/plugin-sdk/text-chunking";
import {
  materializeMatrixDirectReplyPayload,
  resolveMatrixDirectReplyExtraContent,
} from "../../outbound.js";
import { getMatrixRuntime } from "../../runtime.js";
import {
  buildMatrixOpenClawPreviewContent,
  MAX_MATRIX_STANDALONE_FINAL_PARTS,
  type MatrixOpenClawPreviewMarker,
} from "../preview-protocol.js";
import type { MatrixClient } from "../sdk.js";
import { chunkMatrixText, sendMessageMatrix } from "../send.js";
import type { MatrixSendResult } from "../send/types.js";
import type { OpenClawConfig, ReplyPayload, RuntimeEnv } from "./runtime-api.js";

export type MatrixReplyDeliveryResult = {
  messageIds?: string[];
  receipt?: MessageReceipt;
  visibleReplySent: boolean;
  content?: string;
  suppression?: { reason: "no_visible_result" };
};

function joinMatrixVisibleContent(contents: readonly (string | undefined)[]): string {
  return contents.filter((content): content is string => Boolean(content)).join("\n");
}

export function mergeMatrixReplyDeliveryResults(
  results: readonly MatrixReplyDeliveryResult[],
): MatrixReplyDeliveryResult {
  const visibleResults = results.filter((result) => result.visibleReplySent);
  if (visibleResults.length === 0) {
    return {
      visibleReplySent: false,
      suppression: { reason: "no_visible_result" },
    };
  }
  const receiptInputs: Array<{ receipt: MessageReceipt } | { messageId: string }> = [];
  for (const result of visibleResults) {
    if (result.receipt) {
      receiptInputs.push({ receipt: result.receipt });
      continue;
    }
    for (const messageId of result.messageIds ?? []) {
      receiptInputs.push({ messageId });
    }
  }
  const receipt =
    receiptInputs.length > 0
      ? createMessageReceiptFromOutboundResults({ results: receiptInputs })
      : undefined;
  return {
    ...(receipt ? { messageIds: listMessageReceiptPlatformIds(receipt), receipt } : {}),
    visibleReplySent: true,
    content: joinMatrixVisibleContent(visibleResults.map((result) => result.content)),
  };
}

export function toMatrixPartialDeliveryError(
  error: unknown,
  settled: readonly MatrixReplyDeliveryResult[],
): unknown {
  const failedPartial = isChannelPartialDeliveryError(error)
    ? (error.deliveryResult as MatrixReplyDeliveryResult)
    : undefined;
  const merged = mergeMatrixReplyDeliveryResults([
    ...settled,
    ...(failedPartial ? [failedPartial] : []),
  ]);
  return merged.visibleReplySent
    ? createChannelPartialDeliveryError(error, { ...merged, visibleReplySent: true })
    : error;
}

function createMatrixReplyDeliveryResult(
  results: readonly MatrixSendResult[],
): MatrixReplyDeliveryResult {
  if (results.length === 0) {
    return mergeMatrixReplyDeliveryResults([]);
  }
  const receipt = createMessageReceiptFromOutboundResults({
    results: results.map((result) => ({ receipt: result.receipt })),
  });
  return {
    messageIds: listMessageReceiptPlatformIds(receipt),
    receipt,
    visibleReplySent: true,
    content: joinMatrixVisibleContent(results.map((result) => result.content)),
  };
}

function resolveVisibleMatrixReplyText(text?: string): string | undefined {
  if (typeof text !== "string") {
    return undefined;
  }
  const trimmedStart = text.trimStart();
  if (!trimmedStart) {
    return text;
  }
  if (normalizeLowercaseStringOrEmpty(trimmedStart).startsWith("reasoning:")) {
    return undefined;
  }
  const visibleText = stripReasoningTagsFromText(text, { mode: "strict", trim: "none" });
  return visibleText.trim() ? visibleText : undefined;
}

export async function deliverMatrixReplies(params: {
  cfg: OpenClawConfig;
  replies: ReplyPayload[];
  roomId: string;
  client: MatrixClient;
  runtime: RuntimeEnv;
  replyToMode: "off" | "first" | "all" | "batched";
  hasRepliedRef?: { value: boolean };
  threadId?: string;
  replyToId?: string;
  accountId?: string;
  mediaLocalRoots?: readonly string[];
  enhancedFinalProtocol?: {
    triggerEventId: string;
    mode?: "final" | "ancillary";
    createResponseId?: () => string;
    onLogicalFinalAccepted?: (update: { responseId: string }) => void;
    onAcceptedPart: (update: {
      sourceEventId: string;
      marker: MatrixOpenClawPreviewMarker;
      body: string;
    }) => Promise<void> | void;
    onAbandoned: (update: {
      responseId: string;
      sourceEventIds: readonly string[];
    }) => Promise<void> | void;
  };
}): Promise<MatrixReplyDeliveryResult> {
  const core = getMatrixRuntime();
  const logVerbose = (message: string) => {
    if (core.logging.shouldLogVerbose()) {
      params.runtime.log?.(message);
    }
  };
  const hasRepliedRef = params.hasRepliedRef ?? { value: false };
  const acceptedResults: MatrixSendResult[] = [];
  const protocolResponseId = params.enhancedFinalProtocol
    ? (params.enhancedFinalProtocol.createResponseId?.() ?? randomUUID())
    : undefined;
  let enhancedLogicalFinalCompleted = false;
  try {
    for (const rawReply of params.replies) {
      const reply = materializeMatrixDirectReplyPayload(rawReply);
      const directReplyExtraContent = resolveMatrixDirectReplyExtraContent(reply);
      let directReplyExtraContentSent = false;
      const visibleText = resolveVisibleMatrixReplyText(reply.text);
      const { hasMedia, hasText, mediaUrls } = resolveSendableOutboundReplyParts(reply);
      if (reply.isReasoning === true || (!hasMedia && reply.text && visibleText === undefined)) {
        logVerbose("matrix reply suppressed as reasoning-only");
        continue;
      }
      if (!hasText && !hasMedia) {
        if (reply?.audioAsVoice) {
          logVerbose("matrix reply has audioAsVoice without media/text; skipping");
          continue;
        }
        params.runtime.error?.("matrix reply missing text/media");
        continue;
      }
      const payloadReplyToId = reply.replyToId?.trim();
      const payloadExplicitReplyToId =
        reply.replyToTag || reply.replyToCurrent || reply.replyToIdSource === "explicit"
          ? payloadReplyToId
          : undefined;
      const replyToIdRaw = payloadReplyToId ?? params.replyToId?.trim();
      const replyToId =
        payloadExplicitReplyToId ??
        (params.threadId || params.replyToMode !== "off" ? replyToIdRaw : undefined);
      const rawText = visibleText ?? "";

      const shouldIncludeReply = (id?: string) =>
        Boolean(id) && (params.threadId || params.replyToMode === "all" || !hasRepliedRef.value);
      const replyToIdForReply = payloadExplicitReplyToId
        ? payloadExplicitReplyToId
        : shouldIncludeReply(replyToId)
          ? replyToId
          : undefined;
      const responseId = protocolResponseId;
      const protocolMode =
        params.enhancedFinalProtocol?.mode === "ancillary" || enhancedLogicalFinalCompleted
          ? "ancillary"
          : "final";
      const acceptedProtocolEventIds: string[] = [];
      let protocolCompleted = false;
      const onDeliveryResult = async (
        result: MatrixSendResult,
        marker?: MatrixOpenClawPreviewMarker,
      ) => {
        // A concrete event consumes the first-reply slot even when a later event fails.
        acceptedResults.push(result);
        if (replyToIdForReply) {
          hasRepliedRef.value = true;
        }
        if (marker && params.enhancedFinalProtocol) {
          acceptedProtocolEventIds.push(result.messageId);
          if (marker.state === "final" && marker.partIndex === marker.partCount! - 1) {
            // Wire acceptance is authoritative. A failing local journal callback
            // must never make the dispatcher retry an already-visible final.
            protocolCompleted = true;
            enhancedLogicalFinalCompleted = true;
            try {
              params.enhancedFinalProtocol.onLogicalFinalAccepted?.({
                responseId: marker.responseId,
              });
            } catch (error) {
              // This callback only mirrors accepted wire state into the parent
              // dispatcher. Never turn callback failure into a duplicate send.
              logVerbose(
                `matrix logical-final acceptance callback failed after accepted send: ${String(error)}`,
              );
            }
          }
          try {
            if (marker.state === "final") {
              await params.enhancedFinalProtocol.onAcceptedPart({
                sourceEventId: result.messageId,
                marker,
                body: result.content,
              });
            }
          } catch (error) {
            // The homeserver already accepted this event. Observation is
            // best-effort and must not cause a duplicate fallback send.
            logVerbose(
              `matrix standalone-final observation failed after accepted send: ${String(error)}`,
            );
          }
        }
      };

      const sendStandaloneText = async (text: string) => {
        if (!params.enhancedFinalProtocol) {
          const includeDirectReplyExtraContent =
            !directReplyExtraContentSent && directReplyExtraContent !== undefined;
          directReplyExtraContentSent ||= includeDirectReplyExtraContent;
          await sendMessageMatrix(params.roomId, text, {
            client: params.client,
            cfg: params.cfg,
            replyToId: replyToIdForReply,
            threadId: params.threadId,
            accountId: params.accountId,
            ...(includeDirectReplyExtraContent ? { extraContent: directReplyExtraContent } : {}),
            onDeliveryResult,
          });
          return;
        }
        const { chunks } = chunkMatrixText(text, {
          cfg: params.cfg,
          accountId: params.accountId,
          preserveWhitespace: true,
        });
        const deliverableChunks = chunks.filter((chunk) => chunk.trim().length > 0);
        if (
          params.enhancedFinalProtocol &&
          protocolMode === "final" &&
          deliverableChunks.length > MAX_MATRIX_STANDALONE_FINAL_PARTS
        ) {
          throw new Error(
            `Matrix enhanced final requires ${deliverableChunks.length} parts; maximum is ${MAX_MATRIX_STANDALONE_FINAL_PARTS}`,
          );
        }
        for (const [partIndex, chunk] of deliverableChunks.entries()) {
          const marker: MatrixOpenClawPreviewMarker | undefined = params.enhancedFinalProtocol
            ? protocolMode === "ancillary"
              ? {
                  v: 1,
                  responseId: responseId!,
                  triggerEventId: params.enhancedFinalProtocol.triggerEventId,
                  state: "ancillary",
                  revision: 0,
                  kind: "progress",
                  ...(params.threadId ? { threadId: params.threadId } : {}),
                  ...(replyToIdForReply ? { replyToId: replyToIdForReply } : {}),
                }
              : {
                  v: 1,
                  responseId: responseId!,
                  triggerEventId: params.enhancedFinalProtocol!.triggerEventId,
                  state: "final",
                  revision: 0,
                  kind: "answer",
                  partIndex,
                  partCount: deliverableChunks.length,
                  ...(params.threadId ? { threadId: params.threadId } : {}),
                  ...(replyToIdForReply ? { replyToId: replyToIdForReply } : {}),
                }
            : undefined;
          const includeDirectReplyExtraContent: boolean =
            partIndex === 0 &&
            !directReplyExtraContentSent &&
            directReplyExtraContent !== undefined;
          const extraContent = {
            ...(includeDirectReplyExtraContent ? directReplyExtraContent : {}),
            ...(marker ? buildMatrixOpenClawPreviewContent(marker) : {}),
          };
          directReplyExtraContentSent ||= includeDirectReplyExtraContent;
          await sendMessageMatrix(params.roomId, chunk, {
            client: params.client,
            cfg: params.cfg,
            replyToId: replyToIdForReply,
            threadId: params.threadId,
            accountId: params.accountId,
            ...(Object.keys(extraContent).length > 0 ? { extraContent } : {}),
            onDeliveryResult: async (result) => {
              await onDeliveryResult(result, marker);
            },
          });
        }
      };

      try {
        if (mediaUrls.length === 0) {
          await sendStandaloneText(rawText);
          continue;
        }

        if (params.enhancedFinalProtocol && rawText.trim()) {
          // Enhanced rooms expose one authenticated logical text final. Media
          // is sent separately as correlated non-triggering ancillary content.
          await sendStandaloneText(rawText);
        }
        let first = true;
        for (const mediaUrl of mediaUrls) {
          const marker: MatrixOpenClawPreviewMarker | undefined = params.enhancedFinalProtocol
            ? protocolMode === "ancillary" || rawText.trim() || !first
              ? {
                  v: 1,
                  responseId: responseId!,
                  triggerEventId: params.enhancedFinalProtocol.triggerEventId,
                  state: "ancillary",
                  revision: 0,
                  kind: "progress",
                  ...(params.threadId ? { threadId: params.threadId } : {}),
                  ...(replyToIdForReply ? { replyToId: replyToIdForReply } : {}),
                }
              : {
                  v: 1,
                  responseId: responseId!,
                  triggerEventId: params.enhancedFinalProtocol.triggerEventId,
                  state: "final",
                  revision: 0,
                  kind: "answer",
                  partIndex: 0,
                  partCount: 1,
                  ...(params.threadId ? { threadId: params.threadId } : {}),
                  ...(replyToIdForReply ? { replyToId: replyToIdForReply } : {}),
                }
            : undefined;
          const caption = params.enhancedFinalProtocol ? "" : first ? rawText : "";
          const includeDirectReplyExtraContent: boolean =
            first && !directReplyExtraContentSent && directReplyExtraContent !== undefined;
          const extraContent = {
            ...(includeDirectReplyExtraContent ? directReplyExtraContent : {}),
            ...(marker ? buildMatrixOpenClawPreviewContent(marker) : {}),
          };
          directReplyExtraContentSent ||= includeDirectReplyExtraContent;
          await sendMessageMatrix(params.roomId, caption, {
            client: params.client,
            cfg: params.cfg,
            mediaUrl,
            mediaLocalRoots: params.mediaLocalRoots,
            replyToId: replyToIdForReply,
            threadId: params.threadId,
            audioAsVoice: reply.audioAsVoice,
            accountId: params.accountId,
            ...(Object.keys(extraContent).length > 0 ? { extraContent } : {}),
            onDeliveryResult: async (result) => {
              await onDeliveryResult(result, marker);
            },
          });
          first = false;
        }
      } catch (error) {
        if (
          params.enhancedFinalProtocol &&
          protocolMode === "final" &&
          responseId &&
          acceptedProtocolEventIds.length > 0 &&
          !protocolCompleted
        ) {
          try {
            await params.enhancedFinalProtocol.onAbandoned({
              responseId,
              sourceEventIds: acceptedProtocolEventIds,
            });
          } catch (observerError) {
            logVerbose(
              `matrix standalone-final abandonment observation failed: ${String(observerError)}`,
            );
          }
          await Promise.allSettled(
            acceptedProtocolEventIds.map((eventId) =>
              params.client.redactEvent(params.roomId, eventId, "Incomplete enhanced final"),
            ),
          );
        }
        throw error;
      }
    }
  } catch (error: unknown) {
    throw toMatrixPartialDeliveryError(error, [createMatrixReplyDeliveryResult(acceptedResults)]);
  }
  return createMatrixReplyDeliveryResult(acceptedResults);
}
