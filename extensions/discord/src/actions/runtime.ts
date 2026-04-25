import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { createDiscordActionGate } from "../accounts.js";
import { readStringParam, type OpenClawConfig } from "../runtime-api.js";
import { handleDiscordGuildAction } from "./runtime.guild.js";
import { handleDiscordMessagingAction } from "./runtime.messaging.js";
import { handleDiscordModerationAction } from "./runtime.moderation.js";
import { handleDiscordPresenceAction } from "./runtime.presence.js";

const messagingActions = new Set([
  "react",
  "reactions",
  "sticker",
  "poll",
  "permissions",
  "fetchMessage",
  "readMessages",
  "sendMessage",
  "editMessage",
  "deleteMessage",
  "threadCreate",
  "threadList",
  "threadReply",
  "pinMessage",
  "unpinMessage",
  "listPins",
  "searchMessages",
]);

const guildActions = new Set([
  "memberInfo",
  "roleInfo",
  "emojiList",
  "emojiUpload",
  "stickerUpload",
  "roleAdd",
  "roleRemove",
  "channelInfo",
  "channelList",
  "voiceStatus",
  "eventList",
  "eventCreate",
  "channelCreate",
  "channelEdit",
  "channelDelete",
  "channelMove",
  "categoryCreate",
  "categoryEdit",
  "categoryDelete",
  "channelPermissionSet",
  "channelPermissionRemove",
]);

const moderationActions = new Set(["timeout", "kick", "ban"]);

const presenceActions = new Set(["setPresence"]);

export async function handleDiscordAction(
  params: Record<string, unknown>,
  cfg: OpenClawConfig,
  options?: {
    mediaLocalRoots?: readonly string[];
  },
): Promise<AgentToolResult<unknown>> {
  const action = readStringParam(params, "action", { required: true });
  const accountId = readStringParam(params, "accountId");
  const isActionEnabled = createDiscordActionGate({ cfg, accountId });

  if (messagingActions.has(action)) {
    return await handleDiscordMessagingAction(action, params, isActionEnabled, cfg, options);
  }
  if (guildActions.has(action)) {
    return await handleDiscordGuildAction(action, params, isActionEnabled, cfg, options);
  }
  if (moderationActions.has(action)) {
    return await handleDiscordModerationAction(action, params, isActionEnabled, cfg);
  }
  if (presenceActions.has(action)) {
    return await handleDiscordPresenceAction(action, params, isActionEnabled);
  }
  throw new Error(`Unknown action: ${action}`);
}
