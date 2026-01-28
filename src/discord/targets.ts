import {
  buildMessagingTarget,
  ensureTargetId,
  requireTargetKind,
  type MessagingTarget,
  type MessagingTargetKind,
  type MessagingTargetParseOptions,
} from "../channels/targets.js";

import type { DirectoryConfigParams } from "../channels/plugins/directory-config.js";

import { listDiscordDirectoryPeersLive } from "./directory-live.js";

export type DiscordTargetKind = MessagingTargetKind;

export type DiscordTarget = MessagingTarget;

type DiscordTargetParseOptions = MessagingTargetParseOptions;

export function parseDiscordTarget(
  raw: string,
  options: DiscordTargetParseOptions = {},
): DiscordTarget | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const mentionMatch = trimmed.match(/^<@!?(\d+)>$/);
  if (mentionMatch) {
    return buildMessagingTarget("user", mentionMatch[1], trimmed);
  }
  if (trimmed.startsWith("user:")) {
    const id = trimmed.slice("user:".length).trim();
    return id ? buildMessagingTarget("user", id, trimmed) : undefined;
  }
  if (trimmed.startsWith("channel:")) {
    const id = trimmed.slice("channel:".length).trim();
    return id ? buildMessagingTarget("channel", id, trimmed) : undefined;
  }
  if (trimmed.startsWith("discord:")) {
    const id = trimmed.slice("discord:".length).trim();
    return id ? buildMessagingTarget("user", id, trimmed) : undefined;
  }
  if (trimmed.startsWith("@")) {
    const candidate = trimmed.slice(1).trim();
    const id = ensureTargetId({
      candidate,
      pattern: /^\d+$/,
      errorMessage: "Discord DMs require a user id (use user:<id> or a <@id> mention)",
    });
    return buildMessagingTarget("user", id, trimmed);
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

/**
 * Resolve a Discord username to user ID using the directory lookup.
 * This enables sending DMs by username instead of requiring explicit user IDs.
 *
 * @param raw - The username or raw target string (e.g., "john.doe")
 * @param options - Directory configuration params (cfg, accountId, limit)
 * @param parseOptions - Messaging target parsing options (defaults, ambiguity message)
 * @returns Parsed MessagingTarget with user ID, or undefined if not found
 */
export async function resolveDiscordTarget(
  raw: string,
  options: DirectoryConfigParams,
  parseOptions: DiscordTargetParseOptions = {},
): Promise<MessagingTarget | undefined> {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  const likelyUsername = isLikelyUsername(trimmed);
  const shouldLookup = isExplicitUserLookup(trimmed, parseOptions) || likelyUsername;
  const directParse = safeParseDiscordTarget(trimmed, parseOptions);
  if (directParse && directParse.kind !== "channel" && !likelyUsername) {
    return directParse;
  }
  if (!shouldLookup) {
    return directParse ?? parseDiscordTarget(trimmed, parseOptions);
  }

  // Try to resolve as a username via directory lookup
  try {
    const directoryEntries = await listDiscordDirectoryPeersLive({
      ...options,
      query: trimmed,
      limit: 1,
    });

    const match = directoryEntries[0];
    if (match && match.kind === "user") {
      // Extract user ID from the directory entry (format: "user:<id>")
      const userId = match.id.replace(/^user:/, "");
      return buildMessagingTarget("user", userId, trimmed);
    }
  } catch {
    // Directory lookup failed - fall through to parse as-is
    // This preserves existing behavior for channel names
  }

  // Fallback to original parsing (for channels, etc.)
  return parseDiscordTarget(trimmed, parseOptions);
}

function safeParseDiscordTarget(
  input: string,
  options: DiscordTargetParseOptions,
): MessagingTarget | undefined {
  try {
    return parseDiscordTarget(input, options);
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

/**
 * Check if a string looks like a Discord username (not a mention, prefix, or ID).
 * Usernames typically don't start with special characters except underscore.
 */
function isLikelyUsername(input: string): boolean {
  // Skip if it's already a known format
  if (/^(user:|channel:|discord:|@|<@!?)|[\d]+$/.test(input)) {
    return false;
  }
  // Likely a username if it doesn't match known patterns
  return true;
}
