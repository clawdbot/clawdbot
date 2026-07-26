// Feishu plugin module lists topic-thread history messages.
import type { ClawdbotConfig } from "../runtime-api.js";
import { resolveFeishuRuntimeAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import { type FeishuMessageGetItem, parseFeishuMessageItem } from "./send.js";
import type { FeishuMessageMediaKeys } from "./types.js";

type FeishuThreadMessageInfo = {
  messageId: string;
  senderId?: string;
  senderType?: string;
  content: string;
  contentType: string;
  createTime?: number;
  mediaKeys?: FeishuMessageMediaKeys;
};

/**
 * List messages in a Feishu thread (topic).
 * Uses container_id_type=thread to directly query thread messages,
 * which includes both the root message and all replies (including bot replies).
 */
export async function listFeishuThreadMessages(params: {
  cfg: ClawdbotConfig;
  threadId: string;
  currentMessageId?: string;
  /** Exclude the root message (already provided separately as ThreadStarterBody). */
  rootMessageId?: string;
  limit?: number;
  accountId?: string;
}): Promise<FeishuThreadMessageInfo[]> {
  const { cfg, threadId, currentMessageId, rootMessageId, limit = 20, accountId } = params;
  const account = resolveFeishuRuntimeAccount({ cfg, accountId });
  if (!account.configured) {
    throw new Error(`Feishu account "${account.accountId}" not configured`);
  }

  const client = createFeishuClient(account);

  const response = (await client.im.message.list({
    params: {
      container_id_type: "thread",
      container_id: threadId,
      // Fetch newest messages first so long threads keep the most recent turns.
      // Results are reversed below to restore chronological order.
      sort_type: "ByCreateTimeDesc",
      page_size: Math.min(limit + 1, 50),
      card_msg_content_type: "user_card_content",
    },
  })) as {
    code?: number;
    msg?: string;
    data?: {
      items?: Array<
        {
          message_id?: string;
          root_id?: string;
          parent_id?: string;
        } & FeishuMessageGetItem
      >;
    };
  };

  if (response.code !== 0) {
    throw new Error(
      `Feishu thread list failed: code=${response.code} msg=${response.msg ?? "unknown"}`,
    );
  }

  const items = response.data?.items ?? [];
  const results: FeishuThreadMessageInfo[] = [];

  for (const item of items) {
    if (currentMessageId && item.message_id === currentMessageId) {
      continue;
    }
    if (rootMessageId && item.message_id === rootMessageId) {
      continue;
    }

    const parsed = parseFeishuMessageItem(item);

    results.push({
      messageId: parsed.messageId,
      senderId: parsed.senderId,
      senderType: parsed.senderType,
      content: parsed.content,
      contentType: parsed.contentType,
      createTime: parsed.createTime,
      ...(parsed.mediaKeys ? { mediaKeys: parsed.mediaKeys } : {}),
    });

    if (results.length >= limit) {
      break;
    }
  }

  // Restore chronological order (oldest first) since we fetched newest-first.
  results.reverse();
  return results;
}
