import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import {
  deliverTextOrMediaReply,
  resolveSendableOutboundReplyParts,
} from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import type { createIMessageRpcClient } from "../client.js";
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
  client: Awaited<ReturnType<typeof createIMessageRpcClient>>;
  accountId?: string;
  runtime: RuntimeEnv;
  maxBytes: number;
  textLimit: number;
  sentMessageCache?: Pick<SentMessageCache, "remember">;
}) {
  const { replies, target, client, runtime, maxBytes, textLimit, accountId, sentMessageCache } =
    params;
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
          client,
          accountId,
          replyToId: payload.replyToId,
        });
        // Post-send cache population (#47830): caching happens after each chunk is sent,
        // not before. The window between send completion and cache write is sub-millisecond;
        // the next SQLite inbound poll is 1-2s away, so no echo can arrive before the
        // cache entry exists.
        sentMessageCache?.remember(scope, { text: sent.sentText, messageId: sent.messageId });
      },
      sendMedia: async ({ mediaUrl, caption }) => {
        const sent = await sendMessageIMessage(target, caption ?? "", {
          config: params.cfg,
          mediaUrl,
          maxBytes,
          client,
          accountId,
          replyToId: payload.replyToId,
        });
        sentMessageCache?.remember(scope, {
          text: sent.sentText || undefined,
          messageId: sent.messageId,
        });
      },
    });
    if (delivered !== "empty") {
      runtime.log?.(`imessage: delivered reply to ${target}`);
    }
  }
}
