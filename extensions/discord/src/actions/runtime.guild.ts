import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { resolveDefaultDiscordAccountId } from "../accounts.js";
import { getPresence } from "../monitor/presence-cache.js";
import {
  type ActionGate,
  jsonResult,
  readNumberParam,
  readStringArrayParam,
  readStringParam,
  type DiscordActionConfig,
  type OpenClawConfig,
} from "../runtime-api.js";
import {
  addRoleDiscord,
  createChannelDiscord,
  createScheduledEventDiscord,
  deleteChannelDiscord,
  editChannelDiscord,
  fetchChannelInfoDiscord,
  fetchMemberInfoDiscord,
  fetchRoleInfoDiscord,
  fetchVoiceStatusDiscord,
  listGuildChannelsDiscord,
  listGuildEmojisDiscord,
  listScheduledEventsDiscord,
  moveChannelDiscord,
  removeChannelPermissionDiscord,
  removeRoleDiscord,
  setChannelPermissionDiscord,
  uploadEmojiDiscord,
  uploadStickerDiscord,
  resolveEventCoverImage,
} from "../send.js";
import {
  readDiscordChannelCreateParams,
  readDiscordChannelEditParams,
  readDiscordChannelMoveParams,
} from "./runtime.shared.js";

export const discordGuildActionRuntime = {
  addRoleDiscord,
  createChannelDiscord,
  createScheduledEventDiscord,
  resolveEventCoverImage,
  deleteChannelDiscord,
  editChannelDiscord,
  fetchChannelInfoDiscord,
  fetchMemberInfoDiscord,
  fetchRoleInfoDiscord,
  fetchVoiceStatusDiscord,
  listGuildChannelsDiscord,
  listGuildEmojisDiscord,
  listScheduledEventsDiscord,
  moveChannelDiscord,
  removeChannelPermissionDiscord,
  removeRoleDiscord,
  setChannelPermissionDiscord,
  uploadEmojiDiscord,
  uploadStickerDiscord,
};

type DiscordRoleMutationOpts = { cfg: OpenClawConfig; accountId?: string };
type DiscordRoleMutation = (
  params: {
    guildId: string;
    userId: string;
    roleId: string;
  },
  options: DiscordRoleMutationOpts,
) => Promise<unknown>;

async function runRoleMutation(params: {
  cfgOptions: { cfg: OpenClawConfig };
  accountId?: string;
  values: Record<string, unknown>;
  mutate: DiscordRoleMutation;
}) {
  const guildId = readStringParam(params.values, "guildId", { required: true });
  const userId = readStringParam(params.values, "userId", { required: true });
  const roleId = readStringParam(params.values, "roleId", { required: true });
  await params.mutate(
    { guildId, userId, roleId },
    {
      ...params.cfgOptions,
      ...(params.accountId ? { accountId: params.accountId } : {}),
    },
  );
}

function readChannelPermissionTarget(params: Record<string, unknown>) {
  return {
    channelId: readStringParam(params, "channelId", { required: true }),
    targetId: readStringParam(params, "targetId", { required: true }),
  };
}

export async function handleDiscordGuildAction(
  action: string,
  params: Record<string, unknown>,
  isActionEnabled: ActionGate<DiscordActionConfig>,
  cfg: OpenClawConfig,
  options?: { mediaLocalRoots?: readonly string[] },
): Promise<AgentToolResult<unknown>> {
  const accountId = readStringParam(params, "accountId");
  if (!cfg) {
    throw new Error("Discord guild actions require a resolved runtime config.");
  }
  const cfgOptions = { cfg };
  const withOpts = (extra?: Record<string, unknown>) => ({
    ...cfgOptions,
    ...(accountId ? { accountId } : {}),
    ...extra,
  });
  switch (action) {
    case "memberInfo": {
      if (!isActionEnabled("memberInfo")) {
        throw new Error("Discord member info is disabled.");
      }
      const guildId = readStringParam(params, "guildId", {
        required: true,
      });
      const userId = readStringParam(params, "userId", {
        required: true,
      });
      const effectiveAccountId = accountId ?? resolveDefaultDiscordAccountId(cfg);
      const member = effectiveAccountId
        ? await discordGuildActionRuntime.fetchMemberInfoDiscord(guildId, userId, {
            ...cfgOptions,
            accountId: effectiveAccountId,
          })
        : await discordGuildActionRuntime.fetchMemberInfoDiscord(guildId, userId, cfgOptions);
      const presence = getPresence(effectiveAccountId, userId);
      const activities = presence?.activities ?? undefined;
      const status = presence?.status ?? undefined;
      return jsonResult({ ok: true, member, ...(presence ? { status, activities } : {}) });
    }
    case "roleInfo": {
      if (!isActionEnabled("roleInfo")) {
        throw new Error("Discord role info is disabled.");
      }
      const guildId = readStringParam(params, "guildId", {
        required: true,
      });
      const roles = await discordGuildActionRuntime.fetchRoleInfoDiscord(guildId, withOpts());
      return jsonResult({ ok: true, roles });
    }
    case "emojiList": {
      if (!isActionEnabled("reactions")) {
        throw new Error("Discord reactions are disabled.");
      }
      const guildId = readStringParam(params, "guildId", {
        required: true,
      });
      const emojis = await discordGuildActionRuntime.listGuildEmojisDiscord(guildId, withOpts());
      return jsonResult({ ok: true, emojis });
    }
    case "emojiUpload": {
      if (!isActionEnabled("emojiUploads")) {
        throw new Error("Discord emoji uploads are disabled.");
      }
      const guildId = readStringParam(params, "guildId", {
        required: true,
      });
      const name = readStringParam(params, "name", { required: true });
      const mediaUrl = readStringParam(params, "mediaUrl", {
        required: true,
      });
      const roleIds = readStringArrayParam(params, "roleIds");
      const emoji = await discordGuildActionRuntime.uploadEmojiDiscord(
        {
          guildId,
          name,
          mediaUrl,
          roleIds: roleIds?.length ? roleIds : undefined,
        },
        withOpts(),
      );
      return jsonResult({ ok: true, emoji });
    }
    case "stickerUpload": {
      if (!isActionEnabled("stickerUploads")) {
        throw new Error("Discord sticker uploads are disabled.");
      }
      const guildId = readStringParam(params, "guildId", {
        required: true,
      });
      const name = readStringParam(params, "name", { required: true });
      const description = readStringParam(params, "description", {
        required: true,
      });
      const tags = readStringParam(params, "tags", { required: true });
      const mediaUrl = readStringParam(params, "mediaUrl", {
        required: true,
      });
      const sticker = await discordGuildActionRuntime.uploadStickerDiscord(
        {
          guildId,
          name,
          description,
          tags,
          mediaUrl,
        },
        withOpts(),
      );
      return jsonResult({ ok: true, sticker });
    }
    case "roleAdd": {
      if (!isActionEnabled("roles", false)) {
        throw new Error("Discord role changes are disabled.");
      }
      await runRoleMutation({
        cfgOptions,
        accountId,
        values: params,
        mutate: discordGuildActionRuntime.addRoleDiscord,
      });
      return jsonResult({ ok: true });
    }
    case "roleRemove": {
      if (!isActionEnabled("roles", false)) {
        throw new Error("Discord role changes are disabled.");
      }
      await runRoleMutation({
        cfgOptions,
        accountId,
        values: params,
        mutate: discordGuildActionRuntime.removeRoleDiscord,
      });
      return jsonResult({ ok: true });
    }
    case "channelInfo": {
      if (!isActionEnabled("channelInfo")) {
        throw new Error("Discord channel info is disabled.");
      }
      const channelId = readStringParam(params, "channelId", {
        required: true,
      });
      const channel = await discordGuildActionRuntime.fetchChannelInfoDiscord(
        channelId,
        withOpts(),
      );
      return jsonResult({ ok: true, channel });
    }
    case "channelList": {
      if (!isActionEnabled("channelInfo")) {
        throw new Error("Discord channel info is disabled.");
      }
      const guildId = readStringParam(params, "guildId", {
        required: true,
      });
      const channels = await discordGuildActionRuntime.listGuildChannelsDiscord(
        guildId,
        withOpts(),
      );
      return jsonResult({ ok: true, channels });
    }
    case "voiceStatus": {
      if (!isActionEnabled("voiceStatus")) {
        throw new Error("Discord voice status is disabled.");
      }
      const guildId = readStringParam(params, "guildId", {
        required: true,
      });
      const userId = readStringParam(params, "userId", {
        required: true,
      });
      const voice = await discordGuildActionRuntime.fetchVoiceStatusDiscord(
        guildId,
        userId,
        withOpts(),
      );
      return jsonResult({ ok: true, voice });
    }
    case "eventList": {
      if (!isActionEnabled("events")) {
        throw new Error("Discord events are disabled.");
      }
      const guildId = readStringParam(params, "guildId", {
        required: true,
      });
      const events = await discordGuildActionRuntime.listScheduledEventsDiscord(
        guildId,
        withOpts(),
      );
      return jsonResult({ ok: true, events });
    }
    case "eventCreate": {
      if (!isActionEnabled("events")) {
        throw new Error("Discord events are disabled.");
      }
      const guildId = readStringParam(params, "guildId", {
        required: true,
      });
      const name = readStringParam(params, "name", { required: true });
      const startTime = readStringParam(params, "startTime", {
        required: true,
      });
      const endTime = readStringParam(params, "endTime");
      const description = readStringParam(params, "description");
      const channelId = readStringParam(params, "channelId");
      const location = readStringParam(params, "location");
      const imageUrl = readStringParam(params, "image", { trim: false });
      const entityTypeRaw = readStringParam(params, "entityType");
      const entityType = entityTypeRaw === "stage" ? 1 : entityTypeRaw === "external" ? 3 : 2;
      const image = imageUrl
        ? await discordGuildActionRuntime.resolveEventCoverImage(imageUrl, {
            localRoots: options?.mediaLocalRoots,
          })
        : undefined;
      const payload = {
        name,
        description,
        scheduled_start_time: startTime,
        scheduled_end_time: endTime,
        entity_type: entityType,
        channel_id: channelId,
        entity_metadata: entityType === 3 && location ? { location } : undefined,
        image,
        privacy_level: 2,
      };
      const event = await discordGuildActionRuntime.createScheduledEventDiscord(
        guildId,
        payload,
        withOpts(),
      );
      return jsonResult({ ok: true, event });
    }
    case "channelCreate": {
      if (!isActionEnabled("channels")) {
        throw new Error("Discord channel management is disabled.");
      }
      const channel = await discordGuildActionRuntime.createChannelDiscord(
        readDiscordChannelCreateParams(params),
        withOpts(),
      );
      return jsonResult({ ok: true, channel });
    }
    case "channelEdit": {
      if (!isActionEnabled("channels")) {
        throw new Error("Discord channel management is disabled.");
      }
      const channel = await discordGuildActionRuntime.editChannelDiscord(
        readDiscordChannelEditParams(params),
        withOpts(),
      );
      return jsonResult({ ok: true, channel });
    }
    case "channelDelete": {
      if (!isActionEnabled("channels")) {
        throw new Error("Discord channel management is disabled.");
      }
      const channelId = readStringParam(params, "channelId", {
        required: true,
      });
      const result = await discordGuildActionRuntime.deleteChannelDiscord(channelId, withOpts());
      return jsonResult(result);
    }
    case "channelMove": {
      if (!isActionEnabled("channels")) {
        throw new Error("Discord channel management is disabled.");
      }
      await discordGuildActionRuntime.moveChannelDiscord(
        readDiscordChannelMoveParams(params),
        withOpts(),
      );
      return jsonResult({ ok: true });
    }
    case "categoryCreate": {
      if (!isActionEnabled("channels")) {
        throw new Error("Discord channel management is disabled.");
      }
      const guildId = readStringParam(params, "guildId", { required: true });
      const name = readStringParam(params, "name", { required: true });
      const position = readNumberParam(params, "position", { integer: true });
      const channel = await discordGuildActionRuntime.createChannelDiscord(
        {
          guildId,
          name,
          type: 4,
          position: position ?? undefined,
        },
        withOpts(),
      );
      return jsonResult({ ok: true, category: channel });
    }
    case "categoryEdit": {
      if (!isActionEnabled("channels")) {
        throw new Error("Discord channel management is disabled.");
      }
      const categoryId = readStringParam(params, "categoryId", {
        required: true,
      });
      const name = readStringParam(params, "name");
      const position = readNumberParam(params, "position", { integer: true });
      const channel = await discordGuildActionRuntime.editChannelDiscord(
        {
          channelId: categoryId,
          name: name ?? undefined,
          position: position ?? undefined,
        },
        withOpts(),
      );
      return jsonResult({ ok: true, category: channel });
    }
    case "categoryDelete": {
      if (!isActionEnabled("channels")) {
        throw new Error("Discord channel management is disabled.");
      }
      const categoryId = readStringParam(params, "categoryId", {
        required: true,
      });
      const result = await discordGuildActionRuntime.deleteChannelDiscord(categoryId, withOpts());
      return jsonResult(result);
    }
    case "channelPermissionSet": {
      if (!isActionEnabled("channels")) {
        throw new Error("Discord channel management is disabled.");
      }
      const { channelId, targetId } = readChannelPermissionTarget(params);
      const targetTypeRaw = readStringParam(params, "targetType", {
        required: true,
      });
      const targetType = targetTypeRaw === "member" ? 1 : 0;
      const allow = readStringParam(params, "allow");
      const deny = readStringParam(params, "deny");
      await discordGuildActionRuntime.setChannelPermissionDiscord(
        {
          channelId,
          targetId,
          targetType,
          allow: allow ?? undefined,
          deny: deny ?? undefined,
        },
        withOpts(),
      );
      return jsonResult({ ok: true });
    }
    case "channelPermissionRemove": {
      if (!isActionEnabled("channels")) {
        throw new Error("Discord channel management is disabled.");
      }
      const { channelId, targetId } = readChannelPermissionTarget(params);
      await discordGuildActionRuntime.removeChannelPermissionDiscord(
        channelId,
        targetId,
        withOpts(),
      );
      return jsonResult({ ok: true });
    }
    default:
      throw new Error(`Unknown action: ${action}`);
  }
}
