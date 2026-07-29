/**
 * Parse the framework `PluginCommandContext.from` string into the QQBot
 * message type and send target.
 *
 * The framework passes `from` in the form `qqbot:<kind>:<id>` (case-insensitive
 * prefix). We split that string once and map `<kind>` into the engine-side
 * `SlashCommandContext.type` enum and the outbound `MediaTargetContext.targetType`
 * enum. Both enums diverge only for guild/channel, so we keep two lookup
 * tables to avoid the nested ternary chain the previous implementation used.
 */

export interface QQBotFromParseResult {
  /** Message type consumed by SlashCommandContext.type. */
  msgType: "c2c" | "guild" | "dm" | "group";
  /** Target type consumed by MediaTargetContext.targetType. */
  targetType: "c2c" | "group" | "channel" | "dm";
  /** Raw target id (everything after the first `:`). */
  targetId: string;
}

type FromKind = "c2c" | "group" | "channel" | "dm";

const MSG_TYPE_MAP: Record<FromKind, QQBotFromParseResult["msgType"]> = {
  c2c: "c2c",
  dm: "dm",
  group: "group",
  channel: "guild",
};

const TARGET_TYPE_MAP: Record<FromKind, QQBotFromParseResult["targetType"]> = {
  c2c: "c2c",
  dm: "dm",
  group: "group",
  channel: "channel",
};

function isFromKind(value: string): value is FromKind {
  return value === "c2c" || value === "dm" || value === "group" || value === "channel";
}

/**
 * Parse `ctx.from` into the structured fields the QQBot bridge expects.
 *
 * Unknown or missing prefixes fall back to c2c. The remainder after the first
 * `:` is returned verbatim as the target id, matching what the previous inline
 * implementation did.
 */
export function parseQQBotFrom(from: string | undefined | null): QQBotFromParseResult {
  const stripped = (from ?? "").replace(/^qqbot:/iu, "");
  const colonIdx = stripped.indexOf(":");
  const rawPrefix = colonIdx === -1 ? stripped : stripped.slice(0, colonIdx);
  const targetId = colonIdx === -1 ? stripped : stripped.slice(colonIdx + 1);
  const kind: FromKind = isFromKind(rawPrefix) ? rawPrefix : "c2c";

  return {
    msgType: MSG_TYPE_MAP[kind],
    targetType: TARGET_TYPE_MAP[kind],
    targetId,
  };
}
