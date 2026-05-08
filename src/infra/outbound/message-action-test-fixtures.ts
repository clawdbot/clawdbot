export function createPinboardMessageActionBootstrapRegistryMock() {
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
            "upload-file": { aliases: ["chatGuid", "chatIdentifier", "chatId"] },
          },
        },
      };
    }
    return undefined;
  };
}
