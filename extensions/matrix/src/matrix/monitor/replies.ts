import type { MatrixClient } from "matrix-js-sdk";

import { chunkMarkdownText } from "../../../../../src/auto-reply/chunk.js";
import type { ReplyPayload } from "../../../../../src/auto-reply/types.js";
import { danger } from "../../../../../src/globals.js";
import type { RuntimeEnv } from "../../../../../src/runtime.js";
import { sendMessageMatrix } from "../send.js";

export async function deliverMatrixReplies(params: {
  replies: ReplyPayload[];
  roomId: string;
  client: MatrixClient;
  runtime: RuntimeEnv;
  textLimit: number;
  replyToMode: "off" | "first" | "all";
  threadId?: string;
}): Promise<void> {
  const chunkLimit = Math.min(params.textLimit, 4000);
  let hasReplied = false;
  for (const reply of params.replies) {
    if (!reply?.text && !reply?.mediaUrl && !(reply?.mediaUrls?.length ?? 0)) {
      params.runtime.error?.(danger("matrix reply missing text/media"));
      continue;
    }
    const replyToIdRaw = reply.replyToId?.trim();
    const replyToId = params.threadId || params.replyToMode === "off" ? undefined : replyToIdRaw;
    const mediaList = reply.mediaUrls?.length
      ? reply.mediaUrls
      : reply.mediaUrl
        ? [reply.mediaUrl]
        : [];

    const shouldIncludeReply = (id?: string) =>
      Boolean(id) && (params.replyToMode === "all" || !hasReplied);

    if (mediaList.length === 0) {
      for (const chunk of chunkMarkdownText(reply.text ?? "", chunkLimit)) {
        const trimmed = chunk.trim();
        if (!trimmed) continue;
        await sendMessageMatrix(params.roomId, trimmed, {
          client: params.client,
          replyToId: shouldIncludeReply(replyToId) ? replyToId : undefined,
          threadId: params.threadId,
        });
        if (shouldIncludeReply(replyToId)) {
          hasReplied = true;
        }
      }
      continue;
    }

    let first = true;
    for (const mediaUrl of mediaList) {
      const caption = first ? (reply.text ?? "") : "";
      await sendMessageMatrix(params.roomId, caption, {
        client: params.client,
        mediaUrl,
        replyToId: shouldIncludeReply(replyToId) ? replyToId : undefined,
        threadId: params.threadId,
      });
      if (shouldIncludeReply(replyToId)) {
        hasReplied = true;
      }
      first = false;
    }
  }
}
