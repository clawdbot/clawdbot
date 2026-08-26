// Feishu plugin module implements sticker send behavior.
// Extracted from send.ts to keep that file under the max-lines budget; sticker
// sending reuses the same reply-or-fallback-direct path as text/card sends.
import type { ClawdbotConfig } from "../runtime-api.js";
import { resolveFeishuSendTarget } from "./send-target.js";
import { sendReplyOrFallbackDirect } from "./send.js";
import type { FeishuSendResult } from "./types.js";

export type SendFeishuStickerParams = {
  cfg: ClawdbotConfig;
  to: string;
  fileToken: string;
  replyToMessageId?: string;
  replyInThread?: boolean;
  allowTopLevelReplyFallback?: boolean;
  accountId?: string;
};

export async function sendStickerFeishu(
  params: SendFeishuStickerParams,
): Promise<FeishuSendResult> {
  const {
    cfg,
    to,
    fileToken,
    replyToMessageId,
    replyInThread,
    allowTopLevelReplyFallback,
    accountId,
  } = params;
  if (!fileToken?.trim()) {
    throw new Error("Feishu sticker requires a file_token.");
  }
  const { client, receiveId, receiveIdType } = resolveFeishuSendTarget({ cfg, to, accountId });
  // Feishu IM sticker messages carry a drive file_token and msg_type "sticker" in content.
  const content = JSON.stringify({ file_token: fileToken.trim() });

  const directParams = { receiveId, receiveIdType, content, msgType: "sticker" };
  return sendReplyOrFallbackDirect(client, {
    replyToMessageId,
    replyInThread,
    allowTopLevelReplyFallback,
    content,
    msgType: "sticker",
    directParams,
    directErrorPrefix: "Feishu sticker send failed",
    replyErrorPrefix: "Feishu sticker reply failed",
  });
}
