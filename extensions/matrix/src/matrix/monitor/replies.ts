import type { MatrixClient } from "matrix-bot-sdk";

import type { MarkdownTableMode, ReplyPayload, RuntimeEnv } from "clawdbot/plugin-sdk";
import { sendMessageMatrix } from "../send.js";
import { getMatrixRuntime } from "../../runtime.js";

export async function deliverMatrixReplies(params: {
  replies: ReplyPayload[];
  roomId: string;
  client: MatrixClient;
  runtime: RuntimeEnv;
  textLimit: number;
  replyToMode: "off" | "first" | "all";
  threadId?: string;
  accountId?: string;
  tableMode?: MarkdownTableMode;
}): Promise<void> {
  const core = getMatrixRuntime();
  const cfg = core.config.loadConfig();
  const tableMode =
    params.tableMode ??
    core.channel.text.resolveMarkdownTableMode({
      cfg,
      channel: "matrix",
      accountId: params.accountId,
    });
  const logVerbose = (message: string) => {
    if (core.logging.shouldLogVerbose()) {
      params.runtime.log?.(message);
    }
  };
  const chunkLimit = Math.min(params.textLimit, 4000);
  const chunkMode = core.channel.text.resolveChunkMode(cfg, "matrix", params.accountId);
  let hasReplied = false;
  for (const reply of params.replies) {
    const hasMedia = Boolean(reply?.mediaUrl) || (reply?.mediaUrls?.length ?? 0) > 0;
    if (!reply?.text && !hasMedia) {
      if (reply?.audioAsVoice) {
        logVerbose("matrix reply has audioAsVoice without media/text; skipping");
        continue;
      }
      params.runtime.error?.("matrix reply missing text/media");
      continue;
    }
    const replyToIdRaw = reply.replyToId?.trim();
    const replyToId = params.threadId || params.replyToMode === "off" ? undefined : replyToIdRaw;
    const rawText = reply.text ?? "";
    const text = core.channel.text.convertMarkdownTables(rawText, tableMode);
    const mediaList = reply.mediaUrls?.length
      ? reply.mediaUrls
      : reply.mediaUrl
        ? [reply.mediaUrl]
        : [];

    const shouldIncludeReply = (id?: string) =>
      Boolean(id) && (params.replyToMode === "all" || !hasReplied);

    if (mediaList.length === 0) {
      for (const chunk of core.channel.text.chunkMarkdownTextWithMode(
        text,
        chunkLimit,
        chunkMode,
      )) {
        const trimmed = chunk.trim();
        if (!trimmed) continue;
        await sendMessageMatrix(params.roomId, trimmed, {
          client: params.client,
          replyToId: shouldIncludeReply(replyToId) ? replyToId : undefined,
          threadId: params.threadId,
          accountId: params.accountId,
        });
        if (shouldIncludeReply(replyToId)) {
          hasReplied = true;
        }
      }
      continue;
    }

    let first = true;
    for (const mediaUrl of mediaList) {
      const caption = first ? text : "";
      await sendMessageMatrix(params.roomId, caption, {
        client: params.client,
        mediaUrl,
        replyToId: shouldIncludeReply(replyToId) ? replyToId : undefined,
        threadId: params.threadId,
        audioAsVoice: reply.audioAsVoice,
        accountId: params.accountId,
      });
      if (shouldIncludeReply(replyToId)) {
        hasReplied = true;
      }
      first = false;
    }
  }
}
