import type { GatewayPresenceUpdate } from "discord-api-types/v10";

/**
 * In-memory cache of Discord user presence data.
 * Populated by PRESENCE_UPDATE gateway events when the GuildPresences intent is enabled.
 */
const presenceCache = new Map<string, GatewayPresenceUpdate>();

/** Update cached presence for a user. */
export function setPresence(userId: string, data: GatewayPresenceUpdate): void {
  presenceCache.set(userId, data);
}

/** Get cached presence for a user. Returns undefined if not cached. */
export function getPresence(userId: string): GatewayPresenceUpdate | undefined {
  return presenceCache.get(userId);
}

/** Clear all cached presence data. */
export function clearPresences(): void {
  presenceCache.clear();
}

/** Get the number of cached presence entries. */
export function presenceCacheSize(): number {
  return presenceCache.size;
}
