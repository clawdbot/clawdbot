// Qa Channel plugin module implements outbound behavior.
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  loadOutboundMediaFromUrl,
  type OutboundMediaLoadOptions,
} from "openclaw/plugin-sdk/outbound-media";
import { resolveQaChannelAccount } from "./accounts.js";
import { buildQaTarget, resolveQaTargetThread, sendQaBusMessage } from "./bus-client.js";
import type { QaBusAttachment, QaBusToolCall } from "./protocol.js";
import type { CoreConfig } from "./types.js";

type QaChannelTextSendParams = {
  cfg: CoreConfig;
  accountId?: string | null;
  to: string;
  text: string;
  isError?: boolean;
  threadId?: string | number | null;
  replyToId?: string | number | null;
  attachments?: QaBusAttachment[];
  toolCalls?: QaBusToolCall[];
};

type QaChannelMediaAccessParams = {
  mediaAccess?: OutboundMediaLoadOptions["mediaAccess"];
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
};

export async function sendQaChannelText(params: QaChannelTextSendParams) {
  const account = resolveQaChannelAccount({ cfg: params.cfg, accountId: params.accountId });
  const resolved = resolveQaTargetThread({ target: params.to, threadId: params.threadId });
  const parsed = resolved.target;
  const { message } = await sendQaBusMessage({
    baseUrl: account.baseUrl,
    accountId: account.accountId,
    to: buildQaTarget({
      chatType: parsed.chatType,
      conversationId: parsed.conversationId,
      threadId: resolved.threadId,
    }),
    text: params.text,
    isError: params.isError,
    senderId: account.botUserId,
    senderName: account.botDisplayName,
    threadId: resolved.threadId,
    replyToId: params.replyToId == null ? undefined : String(params.replyToId),
    ...(params.attachments?.length ? { attachments: params.attachments } : {}),
    ...(params.toolCalls?.length ? { toolCalls: params.toolCalls } : {}),
  });
  return {
    to: params.to,
    messageId: message.id,
  };
}

/** Resolve every attachment first so a failed batch cannot publish a partial reply. */
export async function sendQaChannelMediaBatch(
  params: QaChannelTextSendParams & QaChannelMediaAccessParams & { mediaUrls: readonly string[] },
) {
  if (params.mediaUrls.length === 0) {
    throw new Error("QA channel media batch requires at least one media URL");
  }
  const { mediaMaxBytes: maxBytes } = resolveQaChannelAccount(params);
  const attachments: QaBusAttachment[] = await Promise.all(
    params.mediaUrls.map(async (mediaUrl) => {
      const media = await loadOutboundMediaFromUrl(mediaUrl, {
        maxBytes,
        mediaAccess: params.mediaAccess,
        mediaLocalRoots: params.mediaLocalRoots,
        mediaReadFile: params.mediaReadFile,
        optimizeImages: false,
      });
      const kind =
        media.kind === "image" || media.kind === "video" || media.kind === "audio"
          ? media.kind
          : "file";
      return {
        id: randomUUID(),
        kind,
        mimeType: media.contentType ?? "application/octet-stream",
        fileName: media.fileName ?? path.basename(mediaUrl),
        contentBase64: media.buffer.toString("base64"),
      };
    }),
  );
  return await sendQaChannelText({ ...params, attachments });
}

export async function sendQaChannelMedia(
  params: QaChannelTextSendParams & QaChannelMediaAccessParams & { mediaUrl: string },
) {
  return await sendQaChannelMediaBatch({ ...params, mediaUrls: [params.mediaUrl] });
}
