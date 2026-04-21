export function createPinboardMessageActionBootstrapRegistryMock() {
  return (channel: string) =>
    channel === "pinboard"
      ? {
          actions: {
            messageActionTargetAliases: {
              read: { aliases: ["messageId"] },
              pin: { aliases: ["messageId"] },
              unpin: { aliases: ["messageId"] },
              "list-pins": { aliases: ["chatId"] },
              "channel-info": { aliases: ["chatId"] },
            },
          },
        }
      : undefined;
}
