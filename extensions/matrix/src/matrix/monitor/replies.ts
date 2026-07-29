// Matrix plugin module implements replies behavior.
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { stripReasoningTagsFromText } from "openclaw/plugin-sdk/text-chunking";
import { getMatrixRuntime } from "../../runtime.js";
import type { MatrixClient } from "../sdk.js";
import { chunkMatrixText, sendMessageMatrix } from "../send.js";
import type { MarkdownTableMode, OpenClawConfig, ReplyPayload, RuntimeEnv } from "./runtime-api.js";

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
  const hasRepliedRef = params.hasRepliedRef ?? { value: false };
  let deliveredAny = false;
  for (const reply of params.replies) {
    const visibleText = resolveVisibleMatrixReplyText(reply.text);
    const hasMedia = Boolean(reply?.mediaUrl) || (reply?.mediaUrls?.length ?? 0) > 0;
    if (reply.isReasoning === true || (!hasMedia && reply.text && visibleText === undefined)) {
      logVerbose("matrix reply suppressed as reasoning-only");
      continue;
    }
    if (!reply?.text && !hasMedia) {
      if (reply?.audioAsVoice) {
        logVerbose("matrix reply has audioAsVoice without media/text; skipping");
        continue;
      }
      params.runtime.error?.("matrix reply missing text/media");
      continue;
    }
    const replyToIdRaw = (reply.replyToId ?? params.replyToId)?.trim();
    const replyToId = params.threadId
      ? replyToIdRaw
      : params.replyToMode === "off"
        ? undefined
        : replyToIdRaw;
    const rawText = visibleText ?? "";
    const mediaList = reply.mediaUrls?.length
      ? reply.mediaUrls
      : reply.mediaUrl
        ? [reply.mediaUrl]
        : [];

    const shouldIncludeReply = (id?: string) =>
      Boolean(id) && (params.threadId || params.replyToMode === "all" || !hasRepliedRef.value);
    const replyToIdForReply = shouldIncludeReply(replyToId) ? replyToId : undefined;

    if (mediaList.length === 0) {
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
        if (replyToIdForReply) {
          hasRepliedRef.value = true;
        }
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
      if (replyToIdForReply) {
        hasRepliedRef.value = true;
      }
      first = false;
    }
  }
  return deliveredAny;
}
