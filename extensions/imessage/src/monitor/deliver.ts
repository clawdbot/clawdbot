// Imessage plugin module implements deliver behavior.
import {
  createChannelPartialDeliveryError,
  isChannelPartialDeliveryError,
} from "openclaw/plugin-sdk/channel-inbound";
import {
  createMessageReceiptFromOutboundResults,
  listMessageReceiptPlatformIds,
} from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  deliverTextOrMediaReply,
  resolveSendableOutboundReplyParts,
} from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { sendMessageIMessage } from "../send.js";
import {
  chunkTextWithMode,
  convertMarkdownTables,
  resolveChunkMode,
  resolveMarkdownTableMode,
} from "./deliver.runtime.js";
import type { SentMessageCache } from "./echo-cache.js";
import { sanitizeOutboundText } from "./sanitize-outbound.js";

export async function deliverIMessageReply(params: {
  cfg: OpenClawConfig;
  payload: ReplyPayload;
  target: string;
  accountId?: string;
  runtime: RuntimeEnv;
  maxBytes: number;
  textLimit: number;
  sentMessageCache?: Pick<SentMessageCache, "remember">;
}) {
  const { payload, target, runtime, maxBytes, textLimit, accountId, sentMessageCache } = params;
  const scope = `${accountId ?? ""}:${target}`;
  const { cfg } = params;
  const tableMode = resolveMarkdownTableMode({
    cfg,
    channel: "imessage",
    accountId,
  });
  const chunkMode = resolveChunkMode(cfg, "imessage", accountId);
  const rawText = sanitizeOutboundText(payload.text ?? "");
  const reply = resolveSendableOutboundReplyParts(payload, {
    text: convertMarkdownTables(rawText, tableMode),
  });
  const accepted: Awaited<ReturnType<typeof sendMessageIMessage>>[] = [];
  const sendAccepted = async (text: string, mediaUrl?: string) => {
    const sent = await sendMessageIMessage(target, text, {
      config: cfg,
      ...(mediaUrl ? { mediaUrl, ...(payload.audioAsVoice ? { audioAsVoice: true } : {}) } : {}),
      maxBytes,
      accountId,
      replyToId: payload.replyToId,
    });
    accepted.push(sent);
    const echoText = sent.echoText ?? (sent.sentText || undefined);
    sentMessageCache?.remember(scope, {
      ...(echoText ? { text: echoText } : {}),
      ...(sent.echoMedia ? { media: sent.echoMedia } : {}),
      messageId: sent.messageId,
    });
  };
  let delivered: Awaited<ReturnType<typeof deliverTextOrMediaReply>>;
  try {
    delivered = await deliverTextOrMediaReply({
      payload,
      text: reply.text,
      chunkText: (value) => chunkTextWithMode(value, textLimit, chunkMode),
      sendText: sendAccepted,
      sendMedia: ({ mediaUrl, caption }) => sendAccepted(caption ?? "", mediaUrl),
    });
  } catch (error: unknown) {
    const partial = isChannelPartialDeliveryError(error) ? error.deliveryResult : undefined;
    if (accepted.length === 0 && partial?.visibleReplySent !== true) {
      throw error;
    }
    // A native attachment can settle before its caption rejects; preserve every
    // previously accepted receipt plus that nested provider-visible subset.
    const receipt = createMessageReceiptFromOutboundResults({
      results: [
        ...accepted.map((result) => ({ receipt: result.receipt })),
        ...(partial?.receipt
          ? [{ receipt: partial.receipt }]
          : (partial?.messageIds ?? []).map((messageId) => ({ messageId }))),
      ],
      kind: reply.mediaUrls.length > 0 ? "media" : "text",
    });
    throw createChannelPartialDeliveryError(error, {
      messageIds: listMessageReceiptPlatformIds(receipt),
      receipt,
      visibleReplySent: true,
      content: [...accepted.map((result) => result.sentText), partial?.content]
        .filter(Boolean)
        .join("\n"),
    });
  }
  if (delivered === "empty") {
    return {
      visibleReplySent: false as const,
      suppression: { reason: "no_visible_result" as const },
    };
  }
  const receipt = createMessageReceiptFromOutboundResults({
    results: accepted.map((result) => ({ receipt: result.receipt })),
    kind: delivered,
  });
  runtime.log?.(`imessage: delivered reply to ${target}`);
  return {
    messageIds: listMessageReceiptPlatformIds(receipt),
    receipt,
    visibleReplySent: true as const,
    content: accepted
      .map((result) => result.sentText)
      .filter(Boolean)
      .join("\n"),
  };
}

export function createIMessageEchoCachingSend(params: {
  accountId?: string;
  sentMessageCache?: Pick<SentMessageCache, "remember">;
}): typeof sendMessageIMessage {
  return async (target, text, opts) => {
    const sanitizedText = sanitizeOutboundText(text);
    const sent = await sendMessageIMessage(target, sanitizedText, opts);
    const scope = `${params.accountId ?? opts.accountId ?? ""}:${target}`;
    const echoText = sent.echoText ?? (sent.sentText || undefined);
    params.sentMessageCache?.remember(scope, {
      ...(echoText ? { text: echoText } : {}),
      ...(sent.echoMedia ? { media: sent.echoMedia } : {}),
      messageId: sent.messageId,
    });
    return sent;
  };
}
