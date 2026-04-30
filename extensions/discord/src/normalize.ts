import { parseDiscordTarget } from "./target-parsing.js";

export function normalizeDiscordMessagingTarget(raw: string): string | undefined {
  // Default bare IDs to channels so routing is stable across tool actions.
  const target = parseDiscordTarget(raw, { defaultKind: "channel" });
  return target?.normalized;
}

/**
 * Normalize a Discord outbound target for delivery. Bare numeric IDs are
 * prefixed with "channel:" to avoid the ambiguous-target error in
 * parseDiscordTarget, unless the ID is explicitly configured as an allowed DM
 * sender. All other formats pass through unchanged.
 */
export function normalizeDiscordOutboundTarget(
  to?: string,
  allowFrom?: readonly string[],
): { ok: true; to: string } | { ok: false; error: Error } {
  const trimmed = to?.trim();
  if (!trimmed) {
    return {
      ok: false,
      error: new Error(
        'Discord recipient is required. Use "channel:<id>" for channels or "user:<id>" for DMs.',
      ),
    };
  }
  if (/^\d+$/.test(trimmed)) {
    if (allowFromContainsDiscordUserId(allowFrom, trimmed)) {
      return { ok: true, to: `user:${trimmed}` };
    }
    return { ok: true, to: `channel:${trimmed}` };
  }
  return { ok: true, to: trimmed };
}

export function allowFromContainsDiscordUserId(
  allowFrom: readonly string[] | undefined,
  userId: string,
): boolean {
  const normalizedUserId = userId.trim();
  if (!normalizedUserId) {
    return false;
  }
  return (allowFrom ?? []).some(
    (entry) => normalizeAllowFromDiscordUserId(entry) === normalizedUserId,
  );
}

function normalizeAllowFromDiscordUserId(entry: string): string | undefined {
  const trimmed = entry.trim().toLowerCase();
  if (!trimmed || trimmed === "*") {
    return undefined;
  }
  const mentionMatch = /^<@!?(\d+)>$/.exec(trimmed);
  if (mentionMatch) {
    return mentionMatch[1];
  }
  // Accept both current and legacy allowFrom forms for Discord user IDs.
  const prefixedMatch = /^(?:discord:)?user:(\d+)$/.exec(trimmed);
  if (prefixedMatch) {
    return prefixedMatch[1];
  }
  const discordMatch = /^discord:(\d+)$/.exec(trimmed);
  if (discordMatch) {
    return discordMatch[1];
  }
  return /^\d+$/.test(trimmed) ? trimmed : undefined;
}

export function looksLikeDiscordTargetId(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) {
    return false;
  }
  if (/^<@!?\d+>$/.test(trimmed)) {
    return true;
  }
  if (/^(user|channel|discord):/i.test(trimmed)) {
    return true;
  }
  if (/^\d{6,}$/.test(trimmed)) {
    return true;
  }
  return false;
}
