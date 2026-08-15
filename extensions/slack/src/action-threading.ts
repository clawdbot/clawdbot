// Slack plugin module implements action threading behavior.
import { isSingleUseReplyToMode } from "openclaw/plugin-sdk/reply-reference";
import { slackContextTargetsMatch } from "./targets.js";

export function resolveSlackAutoThreadId(params: {
  to: string;
  toolContext?: {
    currentChannelId?: string;
    currentMessagingTarget?: string;
    currentThreadTs?: string;
    replyToMode?: "off" | "first" | "all" | "batched";
    hasRepliedRef?: { value: boolean };
    sameChannelThreadRequired?: boolean;
  };
}): string | undefined {
  const context = params.toolContext;
  if (!context?.currentChannelId && !context?.currentMessagingTarget) {
    return undefined;
  }
  if (!slackContextTargetsMatch(params.to, context)) {
    return undefined;
  }
  if (!context.currentThreadTs) {
    if (context.sameChannelThreadRequired) {
      throw new Error(
        "Slack thread context is required for same-channel replies from a threaded Slack turn. Set topLevel=true or threadId=null to post at the channel root.",
      );
    }
    return undefined;
  }
  if (context.replyToMode !== "all" && !isSingleUseReplyToMode(context.replyToMode ?? "off")) {
    return undefined;
  }
  if (isSingleUseReplyToMode(context.replyToMode ?? "off") && context.hasRepliedRef?.value) {
    return undefined;
  }
  return context.currentThreadTs;
}
