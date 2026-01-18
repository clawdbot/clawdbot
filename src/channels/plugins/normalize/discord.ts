import { parseDiscordTarget } from "../../../discord/targets.js";

export function normalizeDiscordMessagingTarget(raw: string): string | undefined {
  // Default bare IDs to channels so routing is stable across tool actions.
  const target = parseDiscordTarget(raw, { defaultKind: "channel" });
  return target?.normalized;
}

export function looksLikeDiscordTargetId(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  if (/^<@!?\d+>$/.test(trimmed)) return true;
  if (/^(user|channel|discord):/i.test(trimmed)) return true;
  if (/^\d{6,}$/.test(trimmed)) return true;
  return false;
}
