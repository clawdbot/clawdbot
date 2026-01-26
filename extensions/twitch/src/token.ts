/**
 * Twitch access token resolution with environment variable support.
 *
 * Supports reading Twitch OAuth access tokens from config or environment variable.
 * The CLAWDBOT_TWITCH_ACCESS_TOKEN env var is only used for the default account.
 *
 * Token resolution priority:
 * 1. Account access token from merged config (accounts.{id} or base-level for default)
 * 2. Environment variable: CLAWDBOT_TWITCH_ACCESS_TOKEN (default account only)
 */

import type { ClawdbotConfig } from "../../../src/config/config.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../../src/routing/session-key.js";

export type TwitchTokenSource = "env" | "config" | "none";

export type TwitchTokenResolution = {
  token: string;
  source: TwitchTokenSource;
};

/**
 * Normalize a Twitch OAuth token - ensure it has the oauth: prefix
 */
function normalizeTwitchToken(raw?: string | null): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  // Twitch tokens should have oauth: prefix
  return trimmed.startsWith("oauth:") ? trimmed : `oauth:${trimmed}`;
}

/**
 * Resolve Twitch access token from config or environment variable.
 *
 * Priority:
 * 1. Account access token (from merged config - base-level for default, or accounts.{accountId})
 * 2. Environment variable: CLAWDBOT_TWITCH_ACCESS_TOKEN (default account only)
 *
 * The getAccountConfig function handles merging base-level config with accounts.default,
 * so this logic works for both simplified and multi-account patterns.
 *
 * @param cfg - Clawdbot config
 * @param opts - Options including accountId and optional envToken override
 * @returns Token resolution with source
 */
export function resolveTwitchToken(
  cfg?: ClawdbotConfig,
  opts: { accountId?: string | null; envToken?: string | null } = {},
): TwitchTokenResolution {
  const accountId = normalizeAccountId(opts.accountId);

  // Get merged account config (handles both simplified and multi-account patterns)
  const twitchCfg = cfg?.channels?.twitch;
  const accountCfg =
    accountId === DEFAULT_ACCOUNT_ID
      ? (twitchCfg?.accounts?.[DEFAULT_ACCOUNT_ID] as Record<string, unknown> | undefined)
      : (twitchCfg?.accounts?.[accountId as string] as Record<string, unknown> | undefined);

  // For default account, also check base-level config
  let token: string | undefined;
  if (accountId === DEFAULT_ACCOUNT_ID) {
    // Base-level config takes precedence
    token = normalizeTwitchToken(
      (typeof twitchCfg?.accessToken === "string" ? twitchCfg.accessToken : undefined) ||
        (accountCfg?.accessToken as string | undefined),
    );
  } else {
    // Non-default accounts only use accounts object
    token = normalizeTwitchToken(accountCfg?.accessToken as string | undefined);
  }

  if (token) {
    return { token, source: "config" };
  }

  // Environment variable (default account only)
  const allowEnv = accountId === DEFAULT_ACCOUNT_ID;
  const envToken = allowEnv
    ? normalizeTwitchToken(opts.envToken ?? process.env.CLAWDBOT_TWITCH_ACCESS_TOKEN)
    : undefined;
  if (envToken) {
    return { token: envToken, source: "env" };
  }

  return { token: "", source: "none" };
}
