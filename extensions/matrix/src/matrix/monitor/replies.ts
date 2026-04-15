import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import { getMatrixRuntime } from "../../runtime.js";
import type { MatrixClient } from "../sdk.js";
import { chunkMatrixText, sendMessageMatrix } from "../send.js";
import type { MarkdownTableMode, OpenClawConfig, ReplyPayload, RuntimeEnv } from "./runtime-api.js";

const THINKING_TAG_RE = /<\s*\/?\s*(?:think(?:ing)?|thought|antthinking)\b[^<>]*>/gi;
const THINKING_BLOCK_RE =
  /<\s*(?:think(?:ing)?|thought|antthinking)\b[^<>]*>[\s\S]*?<\s*\/\s*(?:think(?:ing)?|thought|antthinking)\s*>/gi;

function shouldSuppressReasoningReplyText(text?: string): boolean {
  if (typeof text !== "string") {
    return false;
  }
  const trimmedStart = text.trimStart();
  if (!trimmedStart) {
    return false;
  }
  if (normalizeLowercaseStringOrEmpty(trimmedStart).startsWith("reasoning:")) {
    return true;
  }
  THINKING_TAG_RE.lastIndex = 0;
  if (!THINKING_TAG_RE.test(text)) {
    return false;
  }
  THINKING_BLOCK_RE.lastIndex = 0;
  const withoutThinkingBlocks = text.replace(THINKING_BLOCK_RE, "");
  THINKING_TAG_RE.lastIndex = 0;
  return !withoutThinkingBlocks.replace(THINKING_TAG_RE, "").trim();
}

export async function deliverMatrixReplies(params: {
  cfg: OpenClawConfig;
  replies: ReplyPayload[];
  roomId: string;
  client: MatrixClient;
  runtime: RuntimeEnv;
  textLimit: number;
  replyToMode: "off" | "first" | "all" | "batched";
  threadId?: string;
  accountId?: string;
  mediaLocalRoots?: readonly string[];
  tableMode?: MarkdownTableMode;
}): Promise<boolean> {
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
  let hasReplied = false;
  let deliveredAny = false;
  for (const reply of params.replies) {
    if (reply.isReasoning === true || shouldSuppressReasoningReplyText(reply.text)) {
      logVerbose("matrix reply suppressed as reasoning-only");
      continue;
    }
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
    const mediaList = reply.mediaUrls?.length
      ? reply.mediaUrls
      : reply.mediaUrl
        ? [reply.mediaUrl]
        : [];

    const shouldIncludeReply = (id?: string) =>
      Boolean(id) && (params.replyToMode === "all" || !hasReplied);
    const replyToIdForReply = shouldIncludeReply(replyToId) ? replyToId : undefined;

    if (mediaList.length === 0) {
      let sentTextChunk = false;
      const { chunks } = chunkMatrixText(rawText, {
        cfg: params.cfg,
        accountId: params.accountId,
        tableMode,
      });
      for (const chunk of chunks) {
        const trimmed = chunk.trim();
        if (!trimmed) {
          continue;
        }
        await sendMessageMatrix(params.roomId, trimmed, {
          client: params.client,
          cfg: params.cfg,
          replyToId: replyToIdForReply,
          threadId: params.threadId,
          accountId: params.accountId,
        });
        deliveredAny = true;
        sentTextChunk = true;
      }
      if (replyToIdForReply && !hasReplied && sentTextChunk) {
        hasReplied = true;
      }
      continue;
    }

    let first = true;
    for (const mediaUrl of mediaList) {
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
      });
      deliveredAny = true;
      first = false;
    }
    if (replyToIdForReply && !hasReplied) {
      hasReplied = true;
    }
  }
  return deliveredAny;
}
