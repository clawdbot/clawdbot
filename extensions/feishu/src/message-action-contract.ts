import type { ChannelMessageActionName } from "openclaw/plugin-sdk/channel-contract";

type MessageActionTargetAliasSpec = {
  aliases: string[];
};

export const messageActionTargetAliases = {
  read: { aliases: ["messageId"] },
  pin: { aliases: ["messageId"] },
  unpin: { aliases: ["messageId"] },
  "list-pins": { aliases: ["chatId"] },
  "channel-info": { aliases: ["chatId"] },
} satisfies Partial<Record<ChannelMessageActionName, MessageActionTargetAliasSpec>>;
