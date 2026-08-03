// Qqbot plugin module implements channel behavior.
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/core";
import { ChannelApiSchema, executeChannelApi } from "../../engine/tools/channel-api.js";
import type { ChannelApiParams } from "../../engine/tools/channel-api.js";
import { listQQBotAccountIds, resolveQQBotAccount } from "../config.js";

/**
 * Register the QQ channel API proxy tool.
 *
 * The tool acts as an authenticated HTTP proxy for the QQ Open Platform
 * channel APIs. Agents learn endpoint details from the skill docs and
 * send requests through this proxy.
 */
function createChannelTool(
  cfg: NonNullable<OpenClawPluginApi["config"]>,
  context: OpenClawPluginToolContext,
): AnyAgentTool | null {
  // Bind credentials when the per-run tool is built; a process-wide account
  // selection would let one QQBot ingress account exercise another account's API authority.
  const activeConfig = context.runtimeConfig ?? cfg;
  const activeChannel = context.messageChannel ?? context.deliveryContext?.channel;
  const account = resolveQQBotAccount(
    activeConfig,
    activeChannel === "qqbot"
      ? (context.agentAccountId ?? context.deliveryContext?.accountId)
      : undefined,
  );
  if (!account.enabled || !account.appId || !account.clientSecret) {
    return null;
  }

  return {
    name: "qqbot_channel_api",
    label: "QQBot Channel API",
    description:
      "Authenticated HTTP proxy for QQ Open Platform channel APIs. " +
      "Use write and delete endpoints only after explicit user intent; DELETE requires confirmed=true, and bulk deletes require bulkConfirmed=true after confirming the exact target. " +
      "Common endpoints: " +
      "list guilds GET /users/@me/guilds | " +
      "list channels GET /guilds/{guild_id}/channels | " +
      "get channel GET /channels/{channel_id} | " +
      "create channel POST /guilds/{guild_id}/channels | " +
      "list members GET /guilds/{guild_id}/members?after=0&limit=100 | " +
      "get member GET /guilds/{guild_id}/members/{user_id} | " +
      "list threads GET /channels/{channel_id}/threads | " +
      "create thread PUT /channels/{channel_id}/threads | " +
      "create announce POST /guilds/{guild_id}/announces | " +
      "create schedule POST /channels/{channel_id}/schedules. " +
      "See the qqbot-channel skill for full endpoint details.",
    parameters: ChannelApiSchema,
    async execute(_toolCallId, params) {
      const { getAccessToken } = await import("../../engine/messaging/sender.js");
      const accessToken = await getAccessToken(account.appId, account.clientSecret);
      return executeChannelApi(params as ChannelApiParams, {
        accessToken,
        cfg: activeConfig,
        accountId: account.accountId,
      });
    },
  };
}

export function registerChannelTool(api: OpenClawPluginApi): void {
  const cfg = api.config;
  if (!cfg || listQQBotAccountIds(cfg).length === 0) {
    return;
  }

  api.registerTool((context) => createChannelTool(cfg, context), {
    name: "qqbot_channel_api",
  });
}
