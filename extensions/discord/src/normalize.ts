import { parseDiscordTarget } from "./target-parsing.js";

export function normalizeDiscordMessagingTarget(raw: string): string | undefined {
  // Default bare IDs to channels so routing is stable across tool actions.
  const target = parseDiscordTarget(raw, { defaultKind: "channel" });
  return target?.normalized;
}

/**
 * Normalize a Discord outbound target for delivery. Bare numeric IDs are
 * prefixed with "channel:" to avoid the ambiguous-target error in
 * parseDiscordTarget. All other formats pass through unchanged.
 */
export function normalizeDiscordOutboundTarget(
  to?: string,
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
    return { ok: true, to: `channel:${trimmed}` };
  }
  return { ok: true, to: trimmed };
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
