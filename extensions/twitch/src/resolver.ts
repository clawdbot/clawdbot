/**
 * Twitch resolver adapter for channel/user name resolution.
 *
 * This module implements the ChannelResolverAdapter interface to resolve
 * Twitch usernames to user IDs via the Twitch Helix API.
 */

import {
  callTwitchApi,
  HttpStatusCodeError,
  type TwitchApiCallFetchOptions,
} from "@twurple/api-call";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { withTimeout } from "openclaw/plugin-sdk/text-utility-runtime";
import type { ChannelResolveKind, ChannelResolveResult } from "./types.js";
import type { ChannelLogSink, TwitchAccountConfig } from "./types.js";
import { normalizeToken } from "./utils/twitch.js";

const TWITCH_HELIX_USER_LOOKUP_TIMEOUT_MS = 10_000;

type TwitchTokenInfo = {
  user_id?: string;
};

type TwitchUser = {
  id: string;
  login: string;
  display_name: string;
};

type TwitchUsersResponse = {
  data: TwitchUser[];
};

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

function createHelixUserResolver(clientId: string, accessToken: string) {
  let tokenValidated = false;

  return async (query: { id: string } | { login: string }): Promise<TwitchUser | null> => {
    const controller = new AbortController();
    // ApiClient retries AbortError past the deadline. This sequential startup
    // resolver uses Twurple's public one-shot call so cancellation stays bounded.
    const fetchOptions = { signal: controller.signal } as TwitchApiCallFetchOptions;
    const request = (async () => {
      if (!tokenValidated) {
        let tokenInfo: TwitchTokenInfo;
        try {
          tokenInfo = await callTwitchApi<TwitchTokenInfo>(
            { type: "auth", url: "validate" },
            clientId,
            accessToken,
            undefined,
            fetchOptions,
          );
        } catch (error) {
          if (error instanceof HttpStatusCodeError && error.statusCode === 401) {
            throw new Error("Invalid token supplied", { cause: error });
          }
          throw error;
        }
        if (!tokenInfo.user_id) {
          throw new Error("Trying to use an app access token as a user access token");
        }
        tokenValidated = true;
      }

      const response = await callTwitchApi<TwitchUsersResponse>(
        { type: "helix", url: "users", query },
        clientId,
        accessToken,
        undefined,
        fetchOptions,
      );
      return response.data[0] ?? null;
    })();

    try {
      return await withTimeout(
        request,
        TWITCH_HELIX_USER_LOOKUP_TIMEOUT_MS,
        "Twitch Helix user lookup",
      );
    } finally {
      controller.abort();
    }
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
  _kind: ChannelResolveKind,
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

  const resolveHelixUser = createHelixUserResolver(account.clientId, normalizedToken);

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
        const user = await resolveHelixUser({ id: normalized });

        if (user) {
          results.push({
            input,
            resolved: true,
            id: user.id,
            name: user.login,
          });
          log.debug?.(`Resolved user ID ${normalized} -> ${user.login}`);
        } else {
          results.push({
            input,
            resolved: false,
            note: "user ID not found",
          });
          log.warn(`User ID ${normalized} not found`);
        }
      } else {
        const user = await resolveHelixUser({ login: normalized });

        if (user) {
          results.push({
            input,
            resolved: true,
            id: user.id,
            name: user.login,
            note: user.display_name !== user.login ? `display: ${user.display_name}` : undefined,
          });
          log.debug?.(`Resolved username ${normalized} -> ${user.id} (${user.login})`);
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
