// Feishu plugin module implements reactions behavior.
import type { ClawdbotConfig } from "../runtime-api.js";
import { resolveFeishuRuntimeAccount } from "./accounts.js";
import { assertFeishuApiSuccess } from "./api-response.js";
import { createFeishuClient } from "./client.js";

type FeishuReaction = {
  reactionId: string;
  emojiType: string;
  operatorType: "app" | "user" | "unknown";
  operatorId: string;
};

function resolveConfiguredFeishuClient(params: { cfg: ClawdbotConfig; accountId?: string }) {
  const account = resolveFeishuRuntimeAccount(params);
  if (!account.configured) {
    throw new Error(`Feishu account "${account.accountId}" not configured`);
  }
  return createFeishuClient(account);
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

  assertFeishuApiSuccess(response, "Feishu add reaction failed");

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

  assertFeishuApiSuccess(response, "Feishu remove reaction failed");
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
  const reactions: FeishuReaction[] = [];
  const seenPageTokens = new Set<string>();
  let pageToken: string | undefined;

  while (true) {
    const response = (await client.im.messageReaction.list({
      path: { message_id: messageId },
      params:
        emojiType || pageToken
          ? {
              ...(emojiType ? { reaction_type: emojiType } : {}),
              ...(pageToken ? { page_token: pageToken } : {}),
            }
          : undefined,
    })) as {
      code?: number;
      msg?: string;
      data?: {
        items?: Array<{
          reaction_id?: string;
          reaction_type?: { emoji_type?: string };
          operator?: {
            operator_type?: string;
            operator_id?: string;
          };
        }>;
        has_more?: boolean;
        page_token?: string;
      };
    };

    assertFeishuApiSuccess(response, "Feishu list reactions failed");

    for (const item of response.data?.items ?? []) {
      reactions.push({
        reactionId: item.reaction_id ?? "",
        emojiType: item.reaction_type?.emoji_type ?? "",
        operatorType:
          item.operator?.operator_type === "app"
            ? "app"
            : item.operator?.operator_type === "user"
              ? "user"
              : "unknown",
        operatorId: item.operator?.operator_id ?? "",
      });
    }

    if (response.data?.has_more !== true) {
      return reactions;
    }

    const nextPageToken = response.data.page_token?.trim();
    if (!nextPageToken) {
      throw new Error("Feishu reaction pagination is missing its next page token");
    }
    if (seenPageTokens.has(nextPageToken)) {
      throw new Error("Feishu reaction pagination returned a repeated page token");
    }
    seenPageTokens.add(nextPageToken);
    pageToken = nextPageToken;
  }
}
