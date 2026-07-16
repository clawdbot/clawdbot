import { resolveQaChannelAccount } from "./accounts.js";
import { buildQaTarget, parseQaTarget, sendQaBusMessage } from "./bus-client.js";
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
  const parsed = parseQaTarget(params.to);
  const resolvedThreadId = params.threadId == null ? parsed.threadId : String(params.threadId);
  const { message } = await sendQaBusMessage({
    baseUrl: account.baseUrl,
    accountId: account.accountId,
    to: buildQaTarget({
      chatType: parsed.chatType,
      conversationId: parsed.conversationId,
      threadId: resolvedThreadId,
    }),
    text: params.text,
    senderId: account.botUserId,
    senderName: account.botDisplayName,
    threadId: resolvedThreadId,
    replyToId: params.replyToId == null ? undefined : String(params.replyToId),
  });
  return {
    to: params.to,
    messageId: message.id,
  };
}
