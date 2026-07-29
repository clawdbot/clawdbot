/**
 * QQ Bot target address parser — parse "qqbot:c2c:xxx" style addresses
 * into structured delivery targets.
 *
 * All functions are **pure** (no side effects, no I/O), making them easy
 * to test and safe to share between the built-in and standalone versions.
 */

/** Supported target types. */
type TargetType = "c2c" | "group" | "channel";

/** Parsed delivery target. */
interface ParsedTarget {
  type: TargetType;
  id: string;
}

const TYPED_TARGET_RE = /^(c2c|group|channel):/i;

function parseTypedTarget(value: string): ParsedTarget | undefined {
  const match = TYPED_TARGET_RE.exec(value);
  if (!match?.[1]) {
    return undefined;
  }
  return {
    type: match[1].toLowerCase() as TargetType,
    id: value.slice(match[0].length),
  };
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
  const id = to.replace(/^qqbot:/i, "");
  const typedTarget = parseTypedTarget(id);
  if (typedTarget) {
    if (!typedTarget.id) {
      const idKind = typedTarget.type === "c2c" ? "user" : typedTarget.type;
      throw new Error(`Invalid ${typedTarget.type} target format: ${to} - missing ${idKind} ID`);
    }
    return typedTarget;
  }

  if (!id) {
    throw new Error(`Invalid target format: ${to} - empty ID after removing qqbot: prefix`);
  }

  // Default to C2C when no type prefix is present.
  return { type: "c2c", id };
}

/**
 * Normalize a QQ Bot target string into the canonical `qqbot:...` form.
 *
 * Returns `undefined` when the target does not look like a QQ Bot address.
 */
export function normalizeTarget(target: string): string | undefined {
  const id = target.replace(/^qqbot:/i, "");
  const typedTarget = parseTypedTarget(id);
  if (typedTarget) {
    return `qqbot:${typedTarget.type}:${typedTarget.id}`;
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
  const unqualifiedId = id.replace(/^qqbot:/i, "");
  if (parseTypedTarget(unqualifiedId)) {
    return true;
  }
  if (/^[0-9a-fA-F]{32}$/.test(id)) {
    return true;
  }
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(id);
}
