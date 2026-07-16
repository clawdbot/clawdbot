import {
  buildMessagingTarget,
  parseMentionPrefixOrAtUserTarget,
  requireTargetKind,
  type MessagingTarget,
  type MessagingTargetKind,
  type MessagingTargetParseOptions,
} from "openclaw/plugin-sdk/messaging-targets";

export type DiscordTargetKind = MessagingTargetKind;

export type DiscordTarget = MessagingTarget;

export type DiscordTargetParseOptions = MessagingTargetParseOptions;

export function parseDiscordTarget(
  raw: string,
  options: DiscordTargetParseOptions = {},
): DiscordTarget | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  const userTarget = parseMentionPrefixOrAtUserTarget({
    raw: trimmed,
    mentionPattern: /^<@!?(\d+)>$/,
    prefixes: [
      { prefix: "user:", kind: "user" },
      { prefix: "channel:", kind: "channel" },
      { prefix: "discord:", kind: "user" },
    ],
    atUserPattern: /^\d+$/,
    atUserErrorMessage: "Discord DMs require a user id (use user:<id> or a <@id> mention)",
  });
  if (userTarget) {
    return userTarget;
  }
  if (/^\d+$/.test(trimmed)) {
    if (options.defaultKind) {
      return buildMessagingTarget(options.defaultKind, trimmed, trimmed);
    }
    throw new Error(
      options.ambiguousMessage ??
        `Ambiguous Discord recipient "${trimmed}". Use "user:${trimmed}" for DMs or "channel:${trimmed}" for channel messages.`,
    );
  }
  return buildMessagingTarget("channel", trimmed, trimmed);
}

export function resolveDiscordChannelId(raw: string): string {
  const target = parseDiscordTarget(raw, { defaultKind: "channel" });
  return requireTargetKind({ platform: "Discord", target, kind: "channel" });
}
