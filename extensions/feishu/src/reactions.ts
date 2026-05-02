import type { ClawdbotConfig } from "../runtime-api.js";
import { resolveFeishuRuntimeAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";

type FeishuReaction = {
  reactionId: string;
  emojiType: string;
  operatorType: "app" | "user";
  operatorId: string;
};

function resolveConfiguredFeishuClient(params: { cfg: ClawdbotConfig; accountId?: string }) {
  const account = resolveFeishuRuntimeAccount(params);
  if (!account.configured) {
    throw new Error(`Feishu account "${account.accountId}" not configured`);
  }
  return createFeishuClient(account);
}

function assertFeishuReactionApiSuccess(response: { code?: number; msg?: string }, action: string) {
  if (response.code !== 0) {
    throw new Error(`Feishu ${action} failed: ${response.msg || `code ${response.code}`}`);
  }
}

/**
 * Add a reaction (emoji) to a message.
 * @param emojiType - Feishu emoji type, e.g., "SMILE", "THUMBSUP", "HEART"
 * @see https://open.feishu.cn/document/server-docs/im-v1/message-reaction/emojis-introduce
 */
export async function addReactionFeishu(params: {
  cfg: ClawdbotConfig;
  messageId: string;
  emojiType: string;
  accountId?: string;
}): Promise<{ reactionId: string }> {
  const { cfg, messageId, emojiType, accountId } = params;
  const client = resolveConfiguredFeishuClient({ cfg, accountId });

  const response = (await client.im.messageReaction.create({
    path: { message_id: messageId },
    data: {
      reaction_type: {
        emoji_type: emojiType,
      },
    },
  })) as {
    code?: number;
    msg?: string;
    data?: { reaction_id?: string };
  };

  assertFeishuReactionApiSuccess(response, "add reaction");

  const reactionId = response.data?.reaction_id;
  if (!reactionId) {
    throw new Error("Feishu add reaction failed: no reaction_id returned");
  }

  return { reactionId };
}

/**
 * Remove a reaction from a message.
 */
export async function removeReactionFeishu(params: {
  cfg: ClawdbotConfig;
  messageId: string;
  reactionId: string;
  accountId?: string;
}): Promise<void> {
  const { cfg, messageId, reactionId, accountId } = params;
  const client = resolveConfiguredFeishuClient({ cfg, accountId });

  const response = (await client.im.messageReaction.delete({
    path: {
      message_id: messageId,
      reaction_id: reactionId,
    },
  })) as { code?: number; msg?: string };

  assertFeishuReactionApiSuccess(response, "remove reaction");
}

/**
 * List all reactions for a message.
 */
export async function listReactionsFeishu(params: {
  cfg: ClawdbotConfig;
  messageId: string;
  emojiType?: string;
  accountId?: string;
}): Promise<FeishuReaction[]> {
  const { cfg, messageId, emojiType, accountId } = params;
  const client = resolveConfiguredFeishuClient({ cfg, accountId });

  const response = (await client.im.messageReaction.list({
    path: { message_id: messageId },
    params: emojiType ? { reaction_type: emojiType } : undefined,
  })) as {
    code?: number;
    msg?: string;
    data?: {
      items?: Array<{
        reaction_id?: string;
        reaction_type?: { emoji_type?: string };
        operator_type?: string;
        operator_id?: { open_id?: string; user_id?: string; union_id?: string };
      }>;
    };
  };

  assertFeishuReactionApiSuccess(response, "list reactions");

  const items = response.data?.items ?? [];
  return items.map((item) => ({
    reactionId: item.reaction_id ?? "",
    emojiType: item.reaction_type?.emoji_type ?? "",
    operatorType: item.operator_type === "app" ? "app" : "user",
    operatorId:
      item.operator_id?.open_id ?? item.operator_id?.user_id ?? item.operator_id?.union_id ?? "",
  }));
}
