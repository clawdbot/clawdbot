import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeChatType } from "../../../channels/chat-type.js";
import { channelRouteDedupeKey } from "../../../plugin-sdk/channel-route.js";
import { normalizeMessageChannel } from "../../../utils/message-channel.js";
import type { FollowupRun } from "./types.js";

export function resolveFollowupReplyAnchor(run: FollowupRun): string | undefined {
  if (run.originatingReplyToMode === "off") {
    return undefined;
  }
  const replyToId = normalizeOptionalString(run.originatingReplyToId);
  if (replyToId || normalizeMessageChannel(run.originatingChannel) !== "slack") {
    return replyToId;
  }
  const threadId = run.originatingThreadId;
  const hasRoutedThread =
    typeof threadId === "number"
      ? Number.isFinite(threadId)
      : normalizeOptionalString(threadId) !== undefined;
  // Slack standalone turns have no parent reply id, but enabled reply policies
  // still need the message id so collect groups cannot cross independent roots.
  // A routed thread already owns that boundary and remains collectable across turns.
  return hasRoutedThread ? undefined : normalizeOptionalString(run.messageId);
}

/** Canonical identity for fields that can change where or how a queued reply is delivered. */
export function resolveFollowupReplyDeliveryTargetKey(run: FollowupRun): string {
  return JSON.stringify([
    channelRouteDedupeKey({
      channel: run.originatingChannel ?? run.run.messageProvider,
      to: run.originatingTo,
      accountId: run.originatingAccountId ?? run.run.agentAccountId,
      threadId: run.originatingThreadId,
    }),
    normalizeOptionalString(run.originatingChatId) ?? "",
    resolveFollowupReplyAnchor(run) ?? "",
    run.originatingReplyToMode ?? "",
    normalizeChatType(run.originatingChatType ?? run.run.chatType) ?? "",
  ]);
}
