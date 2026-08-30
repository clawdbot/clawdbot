// Feishu plugin module implements message action contract behavior.
import type { ChannelMessageActionAdapter } from "openclaw/plugin-sdk/channel-contract";

const FEISHU_NATIVE_CHAT_TARGET_ALIASES = ["chatId", "chat_id", "channel_id"];

function createMessageMutationTargetAliases() {
  // The shared cross-context guard only sees plugin-native destinations declared here.
  // Keep every guarded mutation that consumes resolveFeishuChatId on this contract.
  return {
    aliases: ["messageId", ...FEISHU_NATIVE_CHAT_TARGET_ALIASES],
    deliveryTargetAliases: [...FEISHU_NATIVE_CHAT_TARGET_ALIASES],
  };
}

export const messageActionTargetAliases = {
  read: { aliases: ["messageId"] },
  edit: createMessageMutationTargetAliases(),
  pin: createMessageMutationTargetAliases(),
  unpin: createMessageMutationTargetAliases(),
  "list-pins": { aliases: ["chatId"] },
  "channel-info": { aliases: ["chatId"] },
} satisfies NonNullable<ChannelMessageActionAdapter["messageActionTargetAliases"]>;
