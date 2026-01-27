import type { GatewayPresenceUpdate } from "discord-api-types/v10";

/**
 * In-memory cache of Discord user presence data.
 * Populated by PRESENCE_UPDATE gateway events when the GuildPresences intent is enabled.
 */
const presenceCache = new Map<string, Map<string, GatewayPresenceUpdate>>();

function resolveAccountKey(accountId?: string): string {
  return accountId ?? "default";
}

/** Update cached presence for a user. */
export function setPresence(
  accountId: string | undefined,
  userId: string,
  data: GatewayPresenceUpdate,
): void {
  const accountKey = resolveAccountKey(accountId);
  let accountCache = presenceCache.get(accountKey);
  if (!accountCache) {
    accountCache = new Map();
    presenceCache.set(accountKey, accountCache);
  }
  accountCache.set(userId, data);
}

/** Get cached presence for a user. Returns undefined if not cached. */
export function getPresence(
  accountId: string | undefined,
  userId: string,
): GatewayPresenceUpdate | undefined {
  return presenceCache.get(resolveAccountKey(accountId))?.get(userId);
}

/** Clear cached presence data. */
export function clearPresences(accountId?: string): void {
  if (accountId) {
    presenceCache.delete(resolveAccountKey(accountId));
    return;
  }
  presenceCache.clear();
}

/** Get the number of cached presence entries. */
export function presenceCacheSize(): number {
  let total = 0;
  for (const accountCache of presenceCache.values()) {
    total += accountCache.size;
  }
  return total;
}
