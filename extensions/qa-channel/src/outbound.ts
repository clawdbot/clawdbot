// Qa Channel plugin module implements outbound behavior.
import { resolveQaChannelAccount } from "./accounts.js";
import { buildQaTarget, resolveQaTargetThread, sendQaBusMessage } from "./bus-client.js";
import type { CoreConfig } from "./types.js";

export async function sendQaChannelText(params: {
  cfg: CoreConfig;
  accountId?: string | null;
  to: string;
  text: string;
  threadId?: string | number | null;
  replyToId?: string | number | null;
}) {
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
    senderId: account.botUserId,
    senderName: account.botDisplayName,
    threadId: resolved.threadId,
    replyToId: params.replyToId == null ? undefined : String(params.replyToId),
  });
  return {
    to: params.to,
    messageId: message.id,
  };
}
