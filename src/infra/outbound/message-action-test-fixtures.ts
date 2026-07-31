/** Returns a bootstrap registry mock for message-action alias tests. */
export function createPinboardMessageActionBootstrapRegistryMock() {
  const resolveIMessageTarget = ({ args }: { args: Record<string, unknown> }) => {
    if (typeof args.chatGuid === "string") {
      return `chat_guid:${args.chatGuid}`;
    }
    if (typeof args.chatId === "number" || typeof args.chatId === "string") {
      return `chat_id:${args.chatId}`;
    }
    return typeof args.chatIdentifier === "string"
      ? `chat_identifier:${args.chatIdentifier}`
      : undefined;
  };
  return (channel: string) => {
    if (channel === "pinboard") {
      return {
        actions: {
          messageActionTargetAliases: {
            read: { aliases: ["messageId"] },
            pin: { aliases: ["messageId"] },
            unpin: { aliases: ["messageId"] },
            "list-pins": { aliases: ["chatId"] },
            "channel-info": { aliases: ["chatId"] },
          },
        },
      };
    }
    if (channel === "imessage") {
      return {
        actions: {
          messageActionTargetAliases: {
            react: {
              aliases: ["chatGuid", "chatIdentifier", "chatId", "messageId"],
              deliveryTargetAliases: ["chatGuid", "chatIdentifier", "chatId"],
              resolveDeliveryTarget: resolveIMessageTarget,
            },
            edit: {
              aliases: ["chatGuid", "chatIdentifier", "chatId", "messageId"],
              deliveryTargetAliases: ["chatGuid", "chatIdentifier", "chatId"],
              resolveDeliveryTarget: resolveIMessageTarget,
            },
            unsend: {
              aliases: ["chatGuid", "chatIdentifier", "chatId", "messageId"],
              deliveryTargetAliases: ["chatGuid", "chatIdentifier", "chatId"],
              resolveDeliveryTarget: resolveIMessageTarget,
            },
            "upload-file": { aliases: ["chatGuid", "chatIdentifier", "chatId"] },
            poll: {
              aliases: ["chatGuid", "chatIdentifier", "chatId"],
              deliveryTargetAliases: ["chatGuid", "chatIdentifier", "chatId"],
              resolveDeliveryTarget: resolveIMessageTarget,
            },
            "poll-vote": {
              aliases: ["chatGuid", "chatIdentifier", "chatId", "pollId", "messageId"],
              deliveryTargetAliases: ["chatGuid", "chatIdentifier", "chatId"],
              resolveDeliveryTarget: resolveIMessageTarget,
            },
          },
        },
      };
    }
    return undefined;
  };
}
