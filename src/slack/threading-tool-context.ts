import type {
  ChannelThreadingContext,
  ChannelThreadingToolContext,
} from "../channels/plugins/types.js";
import type { MoltbotConfig } from "../config/config.js";
import { resolveSlackAccount, resolveSlackReplyToMode } from "./accounts.js";

export function buildSlackThreadingToolContext(params: {
  cfg: MoltbotConfig;
  accountId?: string | null;
  context: ChannelThreadingContext;
  hasRepliedRef?: { value: boolean };
}): ChannelThreadingToolContext {
  const account = resolveSlackAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  const configuredReplyToMode = resolveSlackReplyToMode(account, params.context.ChatType);
  const effectiveReplyToMode = params.context.ThreadLabel ? "all" : configuredReplyToMode;
  const threadId = params.context.MessageThreadId ?? params.context.ReplyToId;
  return {
    currentChannelId: params.context.To?.startsWith("channel:")
      ? params.context.To.slice("channel:".length)
      : undefined,
    currentThreadTs: threadId != null ? String(threadId) : undefined,
    replyToMode: effectiveReplyToMode,
    hasRepliedRef: params.hasRepliedRef,
  };
}
