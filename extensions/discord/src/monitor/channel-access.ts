function readDiscordChannelPropertySafe(channel: unknown, key: string): unknown {
  if (!channel || typeof channel !== "object" || !(key in channel)) {
    return undefined;
  }
  try {
    return (channel as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function resolveDiscordChannelStringPropertySafe(
  channel: unknown,
  key: string,
): string | undefined {
  const value = readDiscordChannelPropertySafe(channel, key);
  return typeof value === "string" ? value : undefined;
}

function resolveDiscordChannelNumberPropertySafe(
  channel: unknown,
  key: string,
): number | undefined {
  const value = readDiscordChannelPropertySafe(channel, key);
  return typeof value === "number" ? value : undefined;
}

export type DiscordChannelInfoSafe = {
  name?: string;
  topic?: string;
  type?: number;
  parentId?: string;
  ownerId?: string;
  parentName?: string;
};

export function resolveDiscordChannelNameSafe(channel: unknown): string | undefined {
  return resolveDiscordChannelStringPropertySafe(channel, "name");
}

export function resolveDiscordChannelTopicSafe(channel: unknown): string | undefined {
  return resolveDiscordChannelStringPropertySafe(channel, "topic");
}

export function resolveDiscordChannelInfoSafe(channel: unknown): DiscordChannelInfoSafe {
  const parent = readDiscordChannelPropertySafe(channel, "parent");
  return {
    name: resolveDiscordChannelNameSafe(channel),
    topic: resolveDiscordChannelTopicSafe(channel),
    type: resolveDiscordChannelNumberPropertySafe(channel, "type"),
    parentId: resolveDiscordChannelStringPropertySafe(channel, "parentId"),
    ownerId: resolveDiscordChannelStringPropertySafe(channel, "ownerId"),
    parentName: resolveDiscordChannelNameSafe(parent),
  };
}
