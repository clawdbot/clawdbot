import { readDiscordComponentSpec } from "../components.js";
import type { OpenClawConfig } from "../runtime-api.js";
import { sendDiscordComponentMessage } from "../send.components.js";
import {
  createThreadDiscord,
  deleteMessageDiscord,
  editMessageDiscord,
  fetchChannelPermissionsDiscord,
  fetchMessageDiscord,
  fetchReactionsDiscord,
  listPinsDiscord,
  listThreadsDiscord,
  pinMessageDiscord,
  reactMessageDiscord,
  readMessagesDiscord,
  removeOwnReactionsDiscord,
  removeReactionDiscord,
  searchMessagesDiscord,
  sendMessageDiscord,
  sendPollDiscord,
  sendStickerDiscord,
  sendVoiceMessageDiscord,
  unpinMessageDiscord,
} from "../send.js";
import { resolveDiscordTargetChannelId } from "../send.shared.js";
import { resolveDiscordChannelId } from "../targets.js";

export const discordMessagingActionRuntime = {
  createThreadDiscord,
  deleteMessageDiscord,
  editMessageDiscord,
  fetchChannelPermissionsDiscord,
  fetchMessageDiscord,
  fetchReactionsDiscord,
  listPinsDiscord,
  listThreadsDiscord,
  pinMessageDiscord,
  reactMessageDiscord,
  readDiscordComponentSpec,
  readMessagesDiscord,
  removeOwnReactionsDiscord,
  removeReactionDiscord,
  resolveDiscordReactionTargetChannelId,
  resolveDiscordChannelId,
  searchMessagesDiscord,
  sendDiscordComponentMessage,
  sendMessageDiscord,
  sendPollDiscord,
  sendStickerDiscord,
  sendVoiceMessageDiscord,
  unpinMessageDiscord,
};

export async function resolveDiscordReactionTargetChannelId(params: {
  target: string;
  cfg: OpenClawConfig;
  accountId?: string;
}): Promise<string> {
  try {
    return resolveDiscordChannelId(params.target);
  } catch {
    return (
      await resolveDiscordTargetChannelId(params.target, {
        cfg: params.cfg,
        accountId: params.accountId,
      })
    ).channelId;
  }
}
