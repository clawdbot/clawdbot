/**
 * QQ Bot target address parser — parse "qqbot:c2c:xxx" style addresses
 * into structured delivery targets.
 *
 * All functions are **pure** (no side effects, no I/O), making them easy
 * to test and safe to share between the built-in and standalone versions.
 */

/** Supported target types. */
export type TargetType = "c2c" | "group" | "channel";

/** Parsed delivery target. */
export interface ParsedTarget {
  type: TargetType;
  id: string;
}

/**
 * Parse a qqbot target string into a structured delivery target.
 *
 * Supported formats:
 * - `qqbot:c2c:openid` → C2C direct message
 * - `qqbot:group:groupid` → Group message
 * - `qqbot:channel:channelid` → Channel message
 * - `c2c:openid` → C2C (without qqbot: prefix)
 * - `group:groupid` → Group (without qqbot: prefix)
 * - `channel:channelid` → Channel (without qqbot: prefix)
 * - `openid` → C2C (bare openid, default)
 *
 * @param to - Raw target string.
 * @returns Parsed target with type and id.
 * @throws {Error} When the target format is invalid.
 */
export function parseTarget(to: string): ParsedTarget {
  let id = to.replace(/^qqbot:/i, "");

  if (id.startsWith("c2c:")) {
    const userId = id.slice(4);
    if (!userId) {
      throw new Error(`Invalid c2c target format: ${to} - missing user ID`);
    }
    return { type: "c2c", id: userId };
  }

  if (id.startsWith("group:")) {
    const groupId = id.slice(6);
    if (!groupId) {
      throw new Error(`Invalid group target format: ${to} - missing group ID`);
    }
    return { type: "group", id: groupId };
  }

  if (id.startsWith("channel:")) {
    const channelId = id.slice(8);
    if (!channelId) {
      throw new Error(`Invalid channel target format: ${to} - missing channel ID`);
    }
    return { type: "channel", id: channelId };
  }

  if (!id) {
    throw new Error(`Invalid target format: ${to} - empty ID after removing qqbot: prefix`);
  }

  // Default to C2C when no type prefix is present.
  return { type: "c2c", id };
}

/**
 * Map a parsed target type to a ChatScope for API calls.
 *
 * Channel and DM targets are not C2C/Group scoped and should be handled
 * separately by the caller.
 *
 * @returns `'c2c'` or `'group'`, or `undefined` for channel targets.
 */
export function targetToChatScope(target: ParsedTarget): "c2c" | "group" | undefined {
  if (target.type === "c2c") {
    return "c2c";
  }
  if (target.type === "group") {
    return "group";
  }
  return undefined;
}

/**
 * Normalize a QQ Bot target string into the canonical `qqbot:...` form.
 *
 * Returns `undefined` when the target does not look like a QQ Bot address.
 */
export function normalizeTarget(target: string): string | undefined {
  const id = target.replace(/^qqbot:/i, "");
  if (id.startsWith("c2c:") || id.startsWith("group:") || id.startsWith("channel:")) {
    return `qqbot:${id}`;
  }
  // 32-char hex openid
  if (/^[0-9a-fA-F]{32}$/.test(id)) {
    return `qqbot:c2c:${id}`;
  }
  // UUID-format openid
  if (/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(id)) {
    return `qqbot:c2c:${id}`;
  }
  return undefined;
}

/**
 * Return true when the string looks like a QQ Bot target ID.
 */
export function looksLikeQQBotTarget(id: string): boolean {
  if (/^qqbot:(c2c|group|channel):/i.test(id)) {
    return true;
  }
  if (/^(c2c|group|channel):/i.test(id)) {
    return true;
  }
  if (/^[0-9a-fA-F]{32}$/.test(id)) {
    return true;
  }
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(id);
}
