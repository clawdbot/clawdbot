// Imessage plugin module implements deliver behavior.
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

export async function deliverReplies(params: {
  cfg: OpenClawConfig;
  replies: ReplyPayload[];
  target: string;
  accountId?: string;
  runtime: RuntimeEnv;
  maxBytes: number;
  textLimit: number;
  sentMessageCache?: Pick<SentMessageCache, "remember">;
}) {
  const { replies, target, runtime, maxBytes, textLimit, accountId, sentMessageCache } = params;
  const scope = `${accountId ?? ""}:${target}`;
  const { cfg } = params;
  const tableMode = resolveMarkdownTableMode({
    cfg,
    channel: "imessage",
    accountId,
  });
  const chunkMode = resolveChunkMode(cfg, "imessage", accountId);
  for (const payload of replies) {
    const rawText = sanitizeOutboundText(payload.text ?? "");
    const reply = resolveSendableOutboundReplyParts(payload, {
      text: convertMarkdownTables(rawText, tableMode),
    });
    const delivered = await deliverTextOrMediaReply({
      payload,
      text: reply.text,
      chunkText: (value) => chunkTextWithMode(value, textLimit, chunkMode),
      sendText: async (chunk) => {
        const sent = await sendMessageIMessage(target, chunk, {
          config: params.cfg,
          maxBytes,
          accountId,
          replyToId: payload.replyToId,
        });
        const echoText = sent.echoText ?? sent.sentText;
        sentMessageCache?.remember(scope, {
          ...(echoText ? { text: echoText } : {}),
          ...(sent.echoMedia ? { media: sent.echoMedia } : {}),
          messageId: sent.messageId,
        });
      },
      sendMedia: async ({ mediaUrl, caption }) => {
        const sent = await sendMessageIMessage(target, caption ?? "", {
          config: params.cfg,
          mediaUrl,
          maxBytes,
          accountId,
          replyToId: payload.replyToId,
        });
        const echoText = sent.echoText ?? (sent.sentText || undefined);
        sentMessageCache?.remember(scope, {
          ...(echoText ? { text: echoText } : {}),
          ...(sent.echoMedia ? { media: sent.echoMedia } : {}),
          messageId: sent.messageId,
        });
      },
    });
    if (delivered !== "empty") {
      runtime.log?.(`imessage: delivered reply to ${target}`);
    }
  }
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
