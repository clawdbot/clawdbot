/**
 * Twitch resolver adapter for channel/user name resolution.
 *
 * This module implements the ChannelResolverAdapter interface to resolve
 * Twitch usernames to user IDs via the Twitch Helix API.
 */

import { ApiClient } from "@twurple/api";
import { StaticAuthProvider } from "@twurple/auth";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import type { ChannelResolveKind, ChannelResolveResult } from "./types.js";
import type { ChannelLogSink, TwitchAccountConfig } from "./types.js";
import { normalizeToken } from "./utils/twitch.js";

/**
 * Normalize a Twitch username - strip @ prefix and convert to lowercase
 */
function normalizeUsername(input: string): string {
  const trimmed = input.trim();
  if (trimmed.startsWith("@")) {
    return normalizeLowercaseStringOrEmpty(trimmed.slice(1));
  }
  return normalizeLowercaseStringOrEmpty(trimmed);
}

/**
 * Create a logger that includes the Twitch prefix
 */
function createLogger(logger?: ChannelLogSink): ChannelLogSink {
  return {
    info: (msg: string) => logger?.info(msg),
    warn: (msg: string) => logger?.warn(msg),
    error: (msg: string) => logger?.error(msg),
    debug: (msg: string) => logger?.debug?.(msg) ?? (() => {}),
  };
}

/**
 * Resolve Twitch usernames to user IDs via the Helix API
 *
 * @param inputs - Array of usernames or user IDs to resolve
 * @param account - Twitch account configuration with auth credentials
 * @param kind - Type of target to resolve ("user" or "group")
 * @param logger - Optional logger
 * @returns Promise resolving to array of ChannelResolveResult
 */
export async function resolveTwitchTargets(
  inputs: string[],
  account: TwitchAccountConfig,
  kind: ChannelResolveKind,
  logger?: ChannelLogSink,
): Promise<ChannelResolveResult[]> {
  const log = createLogger(logger);

  if (!account.clientId || !account.accessToken) {
    log.error("Missing Twitch client ID or accessToken");
    return inputs.map((input) => ({
      input,
      resolved: false,
      note: "missing Twitch credentials",
    }));
  }

  const normalizedToken = normalizeToken(account.accessToken);

  const authProvider = new StaticAuthProvider(account.clientId, normalizedToken);
  const apiClient = new ApiClient({ authProvider });

  const results: ChannelResolveResult[] = [];

  for (const input of inputs) {
    const normalized = normalizeUsername(input);

    if (!normalized) {
      results.push({
        input,
        resolved: false,
        note: "empty input",
      });
      continue;
    }

    const looksLikeUserId = /^\d+$/.test(normalized);

    try {
      if (looksLikeUserId) {
        const user = await apiClient.users.getUserById(normalized);

        if (user) {
          results.push({
            input,
            resolved: true,
            id: user.id,
            name: user.name,
          });
          log.debug?.(`Resolved user ID ${normalized} -> ${user.name}`);
        } else {
          results.push({
            input,
            resolved: false,
            note: "user ID not found",
          });
          log.warn(`User ID ${normalized} not found`);
        }
      } else {
        const user = await apiClient.users.getUserByName(normalized);

        if (user) {
          results.push({
            input,
            resolved: true,
            id: user.id,
            name: user.name,
            note: user.displayName !== user.name ? `display: ${user.displayName}` : undefined,
          });
          log.debug?.(`Resolved username ${normalized} -> ${user.id} (${user.name})`);
        } else {
          results.push({
            input,
            resolved: false,
            note: "username not found",
          });
          log.warn(`Username ${normalized} not found`);
        }
      }
    } catch (error) {
      const errorMessage = formatErrorMessage(error);
      results.push({
        input,
        resolved: false,
        note: `API error: ${errorMessage}`,
      });
      log.error(`Failed to resolve ${input}: ${errorMessage}`);
    }
  }

  return results;
}
