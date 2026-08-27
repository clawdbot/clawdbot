// Matrix plugin module implements replies behavior.
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
import { getMatrixRuntime } from "../../runtime.js";
import type { MatrixClient } from "../sdk.js";
import { chunkMatrixText, sendMessageMatrix } from "../send.js";
import type { MatrixSendResult } from "../send/types.js";
import type { MarkdownTableMode, OpenClawConfig, ReplyPayload, RuntimeEnv } from "./runtime-api.js";

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
  textLimit: number;
  replyToMode: "off" | "first" | "all" | "batched";
  hasRepliedRef?: { value: boolean };
  threadId?: string;
  replyToId?: string;
  accountId?: string;
  mediaLocalRoots?: readonly string[];
  tableMode?: MarkdownTableMode;
}): Promise<MatrixReplyDeliveryResult> {
  const core = getMatrixRuntime();
  const tableMode =
    params.tableMode ??
    core.channel.text.resolveMarkdownTableMode({
      cfg: params.cfg,
      channel: "matrix",
      accountId: params.accountId,
    });
  const logVerbose = (message: string) => {
    if (core.logging.shouldLogVerbose()) {
      params.runtime.log?.(message);
    }
  };
  const hasRepliedRef = params.hasRepliedRef ?? { value: false };
  const acceptedResults: MatrixSendResult[] = [];
  try {
    for (const reply of params.replies) {
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
      const explicitReplyToId =
        reply.replyToTag || reply.replyToCurrent ? reply.replyToId?.trim() : undefined;
      const rawText = visibleText ?? "";

      const replyToIdForReply =
        explicitReplyToId ||
        (params.threadId ||
        (params.replyToMode !== "off" && (params.replyToMode === "all" || !hasRepliedRef.value))
          ? (reply.replyToId ?? params.replyToId)?.trim()
          : undefined);
      const onDeliveryResult = (result: MatrixSendResult) => {
        // A concrete event consumes the first-reply slot even when a later event fails.
        acceptedResults.push(result);
        if (replyToIdForReply) {
          hasRepliedRef.value = true;
        }
      };

      if (mediaUrls.length === 0) {
        const { chunks } = chunkMatrixText(rawText, {
          cfg: params.cfg,
          accountId: params.accountId,
          tableMode,
          preserveWhitespace: true,
        });
        for (const chunk of chunks) {
          if (!chunk.trim()) {
            continue;
          }
          await sendMessageMatrix(params.roomId, chunk, {
            client: params.client,
            cfg: params.cfg,
            replyToId: replyToIdForReply,
            threadId: params.threadId,
            accountId: params.accountId,
            onDeliveryResult,
          });
        }
        continue;
      }

      let first = true;
      for (const mediaUrl of mediaUrls) {
        const caption = first ? rawText : "";
        await sendMessageMatrix(params.roomId, caption, {
          client: params.client,
          cfg: params.cfg,
          mediaUrl,
          mediaLocalRoots: params.mediaLocalRoots,
          replyToId: replyToIdForReply,
          threadId: params.threadId,
          audioAsVoice: reply.audioAsVoice,
          accountId: params.accountId,
          onDeliveryResult,
        });
        first = false;
      }
    }
  } catch (error: unknown) {
    throw toMatrixPartialDeliveryError(error, [createMatrixReplyDeliveryResult(acceptedResults)]);
  }
  return createMatrixReplyDeliveryResult(acceptedResults);
}
