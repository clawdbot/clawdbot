function readDiscordChannelPropertySafe(channel: unknown, key: string): unknown {
  if (!channel || typeof channel !== "object") {
    return undefined;
  }
  try {
    if (!(key in channel)) {
      return undefined;
    }
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

const DISCORD_CHANNEL_SNAKE_CASE_ALIASES: Record<string, string> = {
  ownerId: "owner_id",
  parentId: "parent_id",
};

function resolveDiscordChannelStringWithAliasSafe(
  channel: unknown,
  camelKey: string,
): string | undefined {
  const camelValue = resolveDiscordChannelStringPropertySafe(channel, camelKey);
  if (camelValue !== undefined) {
    return camelValue;
  }

  const snakeKey = DISCORD_CHANNEL_SNAKE_CASE_ALIASES[camelKey];
  if (!snakeKey) {
    return undefined;
  }

  const directSnakeValue = resolveDiscordChannelStringPropertySafe(channel, snakeKey);
  if (directSnakeValue !== undefined) {
    return directSnakeValue;
  }

  const rawData = readDiscordChannelPropertySafe(channel, "rawData");
  return resolveDiscordChannelStringPropertySafe(rawData, snakeKey);
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

export function resolveDiscordChannelIdSafe(channel: unknown): string | undefined {
  return resolveDiscordChannelStringPropertySafe(channel, "id");
}

export function resolveDiscordChannelTopicSafe(channel: unknown): string | undefined {
  return resolveDiscordChannelStringPropertySafe(channel, "topic");
}

export function resolveDiscordChannelParentIdSafe(channel: unknown): string | undefined {
  return resolveDiscordChannelStringWithAliasSafe(channel, "parentId");
}

export function resolveDiscordChannelOwnerIdSafe(channel: unknown): string | undefined {
  return resolveDiscordChannelStringWithAliasSafe(channel, "ownerId");
}

export function resolveDiscordChannelParentSafe(channel: unknown): unknown {
  return readDiscordChannelPropertySafe(channel, "parent");
}

export function resolveDiscordChannelInfoSafe(channel: unknown): DiscordChannelInfoSafe {
  const parent = resolveDiscordChannelParentSafe(channel);
  return {
    name: resolveDiscordChannelNameSafe(channel),
    topic: resolveDiscordChannelTopicSafe(channel),
    type: resolveDiscordChannelNumberPropertySafe(channel, "type"),
    parentId: resolveDiscordChannelParentIdSafe(channel),
    ownerId: resolveDiscordChannelOwnerIdSafe(channel),
    parentName: resolveDiscordChannelNameSafe(parent),
  };
}
