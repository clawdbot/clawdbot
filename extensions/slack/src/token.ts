// Slack plugin module implements token behavior.
import type { AuthTestResponse } from "@slack/web-api";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";

export function formatSlackBotTokenIdentityWarning(params: {
  auth: Pick<AuthTestResponse, "bot_id" | "user_id">;
  accountId?: string | null;
}): string | undefined {
  const userId = params.auth.user_id?.trim();
  const botId = params.auth.bot_id?.trim();
  // Slack documents bot_id only for bot-token auth.test responses. Use response identity,
  // not token prefixes, so rotated bot and user tokens stay supported.
  if (!userId || botId) {
    return undefined;
  }
  const accountId = params.accountId?.trim() || "default";
  const tokenPath =
    accountId === "default"
      ? "channels.slack.botToken, channels.slack.accounts.default.botToken, or SLACK_BOT_TOKEN"
      : `channels.slack.accounts.${accountId}.botToken`;
  return `Slack auth.test identified account "${accountId}" as user ${userId} without bot_id. ${tokenPath} appears to contain a user token; replace it with a Bot User OAuth Token. Until replaced, explicit bot-mention detection is disabled and required-mention channels fail closed.`;
}

export function resolveSlackBotToken(
  raw?: unknown,
  path = "channels.slack.botToken",
): string | undefined {
  return normalizeResolvedSecretInputString({ value: raw, path });
}

export function resolveSlackAppToken(
  raw?: unknown,
  path = "channels.slack.appToken",
): string | undefined {
  return normalizeResolvedSecretInputString({ value: raw, path });
}

export function resolveSlackUserToken(
  raw?: unknown,
  path = "channels.slack.userToken",
): string | undefined {
  return normalizeResolvedSecretInputString({ value: raw, path });
}
