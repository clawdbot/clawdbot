import type { ChannelMessageActionAdapter } from "openclaw/plugin-sdk/channel-contract";
import { isSlackInteractiveRepliesEnabled } from "./interactive-replies.js";
import { listSlackMessageActions } from "./message-actions.js";

export function describeSlackMessageTool({
  cfg,
  accountId,
}: Parameters<NonNullable<ChannelMessageActionAdapter["describeMessageTool"]>>[0]) {
  const actions = listSlackMessageActions(cfg, accountId);
  const capabilities = new Set<"presentation">();
  if (actions.includes("send")) {
    capabilities.add("presentation");
  }
  if (isSlackInteractiveRepliesEnabled({ cfg, accountId })) {
    capabilities.add("presentation");
  }
  return {
    actions,
    capabilities: Array.from(capabilities),
  };
}
