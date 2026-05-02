const DISCORD_PARTIAL_CHANNEL_RAW_DATA_ERROR =
  "Cannot access rawData on partial Channel. Use fetch() to populate data.";

export function defineThrowingDiscordChannelGetter(
  channel: object,
  key: string,
  message = DISCORD_PARTIAL_CHANNEL_RAW_DATA_ERROR,
) {
  Object.defineProperty(channel, key, {
    configurable: true,
    enumerable: true,
    get() {
      throw new Error(message);
    },
  });
}

export function createPartialDiscordChannelWithThrowingGetters<T extends object>(
  channel: T,
  keys: readonly string[],
): T {
  for (const key of keys) {
    defineThrowingDiscordChannelGetter(channel, key);
  }
  return channel;
}
