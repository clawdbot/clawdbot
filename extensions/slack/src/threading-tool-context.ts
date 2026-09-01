// Slack plugin module implements threading tool context behavior.
import type {
  ChannelThreadingContext,
  ChannelThreadingToolContext,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveSlackAccount, resolveSlackReplyToMode } from "./accounts.js";
import { formatSlackTarget, parseSlackTarget } from "./target-parsing.js";
import { normalizeSlackThreadTsCandidate } from "./thread-ts.js";

export function buildSlackThreadingToolContext(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  context: ChannelThreadingContext;
  hasRepliedRef?: { value: boolean };
}): ChannelThreadingToolContext {
  const account = resolveSlackAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  // Preserve the inbound resolver's exact channel match, including names resolved at startup.
  const configuredReplyToMode =
    params.context.ReplyToMode ?? resolveSlackReplyToMode(account, params.context.ChatType);
  const messageThreadTs = normalizeSlackThreadTsCandidate(params.context.MessageThreadId);
  const transportThreadTs = normalizeSlackThreadTsCandidate(params.context.TransportThreadId);
  const replyToThreadTs = normalizeSlackThreadTsCandidate(params.context.ReplyToId);
  const currentMessageTs = normalizeSlackThreadTsCandidate(params.context.CurrentMessageId);
  const currentThreadTs =
    messageThreadTs ?? transportThreadTs ?? replyToThreadTs ?? currentMessageTs;
  const hasExplicitThreadTarget =
    messageThreadTs != null ||
    transportThreadTs != null ||
    (replyToThreadTs != null && currentMessageTs != null && replyToThreadTs !== currentMessageTs);
  const effectiveReplyToMode = hasExplicitThreadTarget ? "all" : configuredReplyToMode;
  const currentMessagingTarget = normalizeOptionalString(params.context.To);
  const parsedMessagingTarget = currentMessagingTarget
    ? parseSlackTarget(currentMessagingTarget)
    : undefined;
  const nativeChannelId = normalizeOptionalString(params.context.NativeChannelId);
  const currentChannelId =
    parsedMessagingTarget?.teamId && nativeChannelId
      ? formatSlackTarget({
          teamId: parsedMessagingTarget.teamId,
          kind: "channel",
          id: nativeChannelId,
        })
      : parsedMessagingTarget?.teamId
        ? currentMessagingTarget
        : parsedMessagingTarget?.kind === "channel"
          ? parsedMessagingTarget.id
          : (nativeChannelId ?? currentMessagingTarget);
  return {
    currentChannelId,
    currentMessagingTarget,
    currentThreadTs,
    replyToMode: effectiveReplyToMode,
    hasRepliedRef: params.hasRepliedRef,
    sameChannelThreadRequired: hasExplicitThreadTarget,
  };
}
