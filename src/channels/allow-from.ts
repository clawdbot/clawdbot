/**
 * Channel allowFrom policy helpers.
 *
 * Merges DM/group allowlists and checks normalized sender entries.
 */
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";

/**
 * Prefix that marks an allowFrom entry as an access-group reference instead of a sender id.
 */
export const ACCESS_GROUP_ALLOW_FROM_PREFIX = "accessGroup:";

/**
 * Parses an access-group allowFrom entry and returns the referenced group name.
 */
export function parseAccessGroupAllowFromEntry(entry: string): string | null {
  const trimmed = entry.trim();
  if (!trimmed.startsWith(ACCESS_GROUP_ALLOW_FROM_PREFIX)) {
    return null;
  }
  const name = trimmed.slice(ACCESS_GROUP_ALLOW_FROM_PREFIX.length).trim();
  return name.length > 0 ? name : null;
}

/**
 * Merges configured DM allowFrom entries with pairing-store sender ids when policy allows it.
 */
export function mergeDmAllowFromSources(params: {
  allowFrom?: Array<string | number>;
  storeAllowFrom?: Array<string | number>;
  dmPolicy?: string;
}): string[] {
  const storeEntries =
    params.dmPolicy === "allowlist" || params.dmPolicy === "open"
      ? []
      : (params.storeAllowFrom ?? []);
  return normalizeStringEntries([...(params.allowFrom ?? []), ...storeEntries]);
}

/**
 * Resolves the allowFrom entries used for group chats, optionally falling back to DM policy.
 */
export function resolveGroupAllowFromSources(params: {
  allowFrom?: Array<string | number>;
  groupAllowFrom?: Array<string | number>;
  fallbackToAllowFrom?: boolean;
}): string[] {
  const explicitGroupAllowFrom =
    Array.isArray(params.groupAllowFrom) && params.groupAllowFrom.length > 0
      ? params.groupAllowFrom
      : undefined;
  const scoped = explicitGroupAllowFrom
    ? explicitGroupAllowFrom
    : params.fallbackToAllowFrom === false
      ? []
      : (params.allowFrom ?? []);
  return normalizeStringEntries(scoped);
}

/**
 * Returns the first value that is present, preserving falsy values such as false, 0, and "".
 */
export function firstDefined<T>(...values: Array<T | undefined>) {
  for (const value of values) {
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

/**
 * Checks a normalized sender allowlist with wildcard and empty-list policy handling.
 */
export function isSenderIdAllowed(
  allow: { entries: string[]; hasWildcard: boolean; hasEntries: boolean },
  senderId: string | undefined,
  allowWhenEmpty: boolean,
): boolean {
  if (!allow.hasEntries) {
    return allowWhenEmpty;
  }
  if (allow.hasWildcard) {
    return true;
  }
  // A non-empty allowlist without wildcard needs a concrete sender id match.
  if (!senderId) {
    return false;
  }
  return allow.entries.includes(senderId);
}
