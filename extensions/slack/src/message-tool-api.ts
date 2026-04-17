import { Type } from "@sinclair/typebox";
import type { ChannelMessageActionAdapter } from "openclaw/plugin-sdk/channel-contract";
import { isSlackInteractiveRepliesEnabled } from "./interactive-replies.js";
import { listSlackMessageActions } from "./message-actions.js";
import { createSlackMessageToolBlocksSchema } from "./message-tool-schema.js";

export function describeSlackMessageTool({
  cfg,
  accountId,
}: Parameters<NonNullable<ChannelMessageActionAdapter["describeMessageTool"]>>[0]) {
  const actions = listSlackMessageActions(cfg, accountId);
  const capabilities = new Set<"blocks" | "interactive">();
  if (actions.includes("send")) {
    capabilities.add("blocks");
  }
  if (isSlackInteractiveRepliesEnabled({ cfg, accountId })) {
    capabilities.add("interactive");
  }
  return {
    actions,
    capabilities: Array.from(capabilities),
    schema: actions.includes("send")
      ? {
          properties: {
            blocks: Type.Optional(createSlackMessageToolBlocksSchema()),
          },
        }
      : null,
  };
}
