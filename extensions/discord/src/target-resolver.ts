import type { DirectoryConfigParams } from "openclaw/plugin-sdk/directory-runtime";
import { buildMessagingTarget, type MessagingTarget } from "openclaw/plugin-sdk/messaging-targets";
import { resolveDiscordAccount } from "./accounts.js";
import { rememberDiscordDirectoryUser } from "./directory-cache.js";
import { listDiscordDirectoryPeersLive } from "./directory-live.js";
import { parseDiscordSendTarget } from "./send-target-parsing.js";
import { type DiscordTargetParseOptions } from "./target-parsing.js";

/**
 * Resolve a Discord username to user ID using the directory lookup.
 * This enables sending DMs by username instead of requiring explicit user IDs.
 */
export async function resolveDiscordTarget(
  raw: string,
  options: DirectoryConfigParams,
  parseOptions: DiscordTargetParseOptions = {},
): Promise<MessagingTarget | undefined> {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }

  const likelyUsername = isLikelyUsername(trimmed);
  const shouldLookup = isExplicitUserLookup(trimmed, parseOptions) || likelyUsername;

  // Parse directly if it's already a known format. Use a safe parse so ambiguous
  // numeric targets don't throw when we still want to attempt username lookup.
  const directParse = safeParseDiscordTarget(trimmed, parseOptions);
  if (directParse && directParse.kind !== "channel" && !likelyUsername) {
    return directParse;
  }

  if (!shouldLookup) {
    return directParse ?? parseDiscordSendTarget(trimmed, parseOptions);
  }

  try {
    const directoryEntries = await listDiscordDirectoryPeersLive({
      ...options,
      query: trimmed,
      limit: 1,
    });

    const match = directoryEntries[0];
    if (match && match.kind === "user") {
      const userId = match.id.replace(/^user:/, "");
      const resolvedAccountId = resolveDiscordAccount({
        cfg: options.cfg,
        accountId: options.accountId,
      }).accountId;
      rememberDiscordDirectoryUser({
        accountId: resolvedAccountId,
        userId,
        handles: [trimmed, match.name, match.handle],
      });
      return buildMessagingTarget("user", userId, trimmed);
    }
  } catch {
    // Preserve legacy fallback behavior for channel names and direct ids.
  }

  return parseDiscordSendTarget(trimmed, parseOptions);
}

export async function parseAndResolveDiscordTarget(
  raw: string,
  options: DirectoryConfigParams,
  parseOptions: DiscordTargetParseOptions = {},
): Promise<MessagingTarget> {
  const resolved =
    (await resolveDiscordTarget(raw, options, parseOptions)) ??
    parseDiscordSendTarget(raw, parseOptions);
  if (!resolved) {
    throw new Error("Recipient is required for Discord sends");
  }
  return resolved;
}

function safeParseDiscordTarget(
  input: string,
  options: DiscordTargetParseOptions,
): MessagingTarget | undefined {
  try {
    return parseDiscordSendTarget(input, options);
  } catch {
    return undefined;
  }
}

function isExplicitUserLookup(input: string, options: DiscordTargetParseOptions): boolean {
  if (/^<@!?(\d+)>$/.test(input)) {
    return true;
  }
  if (/^(user:|discord:)/.test(input)) {
    return true;
  }
  if (input.startsWith("@")) {
    return true;
  }
  if (/^\d+$/.test(input)) {
    return options.defaultKind === "user";
  }
  return false;
}

function isLikelyUsername(input: string): boolean {
  if (/^(user:|channel:|discord:|@|<@!?)|[\d]+$/.test(input)) {
    return false;
  }
  return true;
}
