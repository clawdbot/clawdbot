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
  const providerPrefixedTarget = parseDiscordProviderPrefixedTarget(trimmed);
  if (providerPrefixedTarget) {
    return providerPrefixedTarget;
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
        `Ambiguous Discord recipient "${trimmed}". For DMs use "user:${trimmed}" or "<@${trimmed}>"; for channels use "channel:${trimmed}".`,
    );
  }
  return buildMessagingTarget("channel", trimmed, trimmed);
}

function parseDiscordProviderPrefixedTarget(raw: string): DiscordTarget | undefined {
  const match = /^discord:(channel|user):(.+)$/i.exec(raw);
  if (!match) {
    return undefined;
  }
  const kind = match[1]?.toLowerCase() as "channel" | "user" | undefined;
  const id = match[2]?.trim();
  if (!kind || !id) {
    return undefined;
  }
  return buildMessagingTarget(kind, id, `${kind}:${id}`);
}

export function resolveDiscordChannelId(raw: string): string {
  const target = parseDiscordTarget(raw, { defaultKind: "channel" });
  return requireTargetKind({ platform: "Discord", target, kind: "channel" });
}
