import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { DiscordActionConfig } from "../../config/config.js";
import { getPresence } from "../../discord/monitor/presence-cache.js";
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
} from "../../discord/send.js";
import {
  type ActionGate,
  jsonResult,
  readNumberParam,
  readStringArrayParam,
  readStringParam,
} from "./common.js";

function readParentIdParam(params: Record<string, unknown>): string | null | undefined {
  if (params.clearParent === true) return null;
  if (params.parentId === null) return null;
  return readStringParam(params, "parentId");
}

export async function handleDiscordGuildAction(
  action: string,
  params: Record<string, unknown>,
  isActionEnabled: ActionGate<DiscordActionConfig>,
): Promise<AgentToolResult<unknown>> {
  const accountId = readStringParam(params, "accountId");
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
      const member = accountId
        ? await fetchMemberInfoDiscord(guildId, userId, { accountId })
        : await fetchMemberInfoDiscord(guildId, userId);
      const presence = getPresence(accountId, userId);
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
      const roles = accountId
        ? await fetchRoleInfoDiscord(guildId, { accountId })
        : await fetchRoleInfoDiscord(guildId);
      return jsonResult({ ok: true, roles });
    }
    case "emojiList": {
      if (!isActionEnabled("reactions")) {
        throw new Error("Discord reactions are disabled.");
      }
      const guildId = readStringParam(params, "guildId", {
        required: true,
      });
      const emojis = accountId
        ? await listGuildEmojisDiscord(guildId, { accountId })
        : await listGuildEmojisDiscord(guildId);
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
      const emoji = accountId
        ? await uploadEmojiDiscord(
            {
              guildId,
              name,
              mediaUrl,
              roleIds: roleIds?.length ? roleIds : undefined,
            },
            { accountId },
          )
        : await uploadEmojiDiscord({
            guildId,
            name,
            mediaUrl,
            roleIds: roleIds?.length ? roleIds : undefined,
          });
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
      const sticker = accountId
        ? await uploadStickerDiscord(
            {
              guildId,
              name,
              description,
              tags,
              mediaUrl,
            },
            { accountId },
          )
        : await uploadStickerDiscord({
            guildId,
            name,
            description,
            tags,
            mediaUrl,
          });
      return jsonResult({ ok: true, sticker });
    }
    case "roleAdd": {
      if (!isActionEnabled("roles", false)) {
        throw new Error("Discord role changes are disabled.");
      }
      const guildId = readStringParam(params, "guildId", {
        required: true,
      });
      const userId = readStringParam(params, "userId", {
        required: true,
      });
      const roleId = readStringParam(params, "roleId", { required: true });
      if (accountId) {
        await addRoleDiscord({ guildId, userId, roleId }, { accountId });
      } else {
        await addRoleDiscord({ guildId, userId, roleId });
      }
      return jsonResult({ ok: true });
    }
    case "roleRemove": {
      if (!isActionEnabled("roles", false)) {
        throw new Error("Discord role changes are disabled.");
      }
      const guildId = readStringParam(params, "guildId", {
        required: true,
      });
      const userId = readStringParam(params, "userId", {
        required: true,
      });
      const roleId = readStringParam(params, "roleId", { required: true });
      if (accountId) {
        await removeRoleDiscord({ guildId, userId, roleId }, { accountId });
      } else {
        await removeRoleDiscord({ guildId, userId, roleId });
      }
      return jsonResult({ ok: true });
    }
    case "channelInfo": {
      if (!isActionEnabled("channelInfo")) {
        throw new Error("Discord channel info is disabled.");
      }
      const channelId = readStringParam(params, "channelId", {
        required: true,
      });
      const channel = accountId
        ? await fetchChannelInfoDiscord(channelId, { accountId })
        : await fetchChannelInfoDiscord(channelId);
      return jsonResult({ ok: true, channel });
    }
    case "channelList": {
      if (!isActionEnabled("channelInfo")) {
        throw new Error("Discord channel info is disabled.");
      }
      const guildId = readStringParam(params, "guildId", {
        required: true,
      });
      const channels = accountId
        ? await listGuildChannelsDiscord(guildId, { accountId })
        : await listGuildChannelsDiscord(guildId);
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
      const voice = accountId
        ? await fetchVoiceStatusDiscord(guildId, userId, { accountId })
        : await fetchVoiceStatusDiscord(guildId, userId);
      return jsonResult({ ok: true, voice });
    }
    case "eventList": {
      if (!isActionEnabled("events")) {
        throw new Error("Discord events are disabled.");
      }
      const guildId = readStringParam(params, "guildId", {
        required: true,
      });
      const events = accountId
        ? await listScheduledEventsDiscord(guildId, { accountId })
        : await listScheduledEventsDiscord(guildId);
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
      const entityTypeRaw = readStringParam(params, "entityType");
      const entityType = entityTypeRaw === "stage" ? 1 : entityTypeRaw === "external" ? 3 : 2;
      const payload = {
        name,
        description,
        scheduled_start_time: startTime,
        scheduled_end_time: endTime,
        entity_type: entityType,
        channel_id: channelId,
        entity_metadata: entityType === 3 && location ? { location } : undefined,
        privacy_level: 2,
      };
      const event = accountId
        ? await createScheduledEventDiscord(guildId, payload, { accountId })
        : await createScheduledEventDiscord(guildId, payload);
      return jsonResult({ ok: true, event });
    }
    case "channelCreate": {
      if (!isActionEnabled("channels")) {
        throw new Error("Discord channel management is disabled.");
      }
      const guildId = readStringParam(params, "guildId", { required: true });
      const name = readStringParam(params, "name", { required: true });
      const type = readNumberParam(params, "type", { integer: true });
      const parentId = readParentIdParam(params);
      const topic = readStringParam(params, "topic");
      const position = readNumberParam(params, "position", { integer: true });
      const nsfw = params.nsfw as boolean | undefined;
      const channel = accountId
        ? await createChannelDiscord(
            {
              guildId,
              name,
              type: type ?? undefined,
              parentId: parentId ?? undefined,
              topic: topic ?? undefined,
              position: position ?? undefined,
              nsfw,
            },
            { accountId },
          )
        : await createChannelDiscord({
            guildId,
            name,
            type: type ?? undefined,
            parentId: parentId ?? undefined,
            topic: topic ?? undefined,
            position: position ?? undefined,
            nsfw,
          });
      return jsonResult({ ok: true, channel });
    }
    case "channelEdit": {
      if (!isActionEnabled("channels")) {
        throw new Error("Discord channel management is disabled.");
      }
      const channelId = readStringParam(params, "channelId", {
        required: true,
      });
      const name = readStringParam(params, "name");
      const topic = readStringParam(params, "topic");
      const position = readNumberParam(params, "position", { integer: true });
      const parentId = readParentIdParam(params);
      const nsfw = params.nsfw as boolean | undefined;
      const rateLimitPerUser = readNumberParam(params, "rateLimitPerUser", {
        integer: true,
      });
      const channel = accountId
        ? await editChannelDiscord(
            {
              channelId,
              name: name ?? undefined,
              topic: topic ?? undefined,
              position: position ?? undefined,
              parentId,
              nsfw,
              rateLimitPerUser: rateLimitPerUser ?? undefined,
            },
            { accountId },
          )
        : await editChannelDiscord({
            channelId,
            name: name ?? undefined,
            topic: topic ?? undefined,
            position: position ?? undefined,
            parentId,
            nsfw,
            rateLimitPerUser: rateLimitPerUser ?? undefined,
          });
      return jsonResult({ ok: true, channel });
    }
    case "channelDelete": {
      if (!isActionEnabled("channels")) {
        throw new Error("Discord channel management is disabled.");
      }
      const channelId = readStringParam(params, "channelId", {
        required: true,
      });
      const result = accountId
        ? await deleteChannelDiscord(channelId, { accountId })
        : await deleteChannelDiscord(channelId);
      return jsonResult(result);
    }
    case "channelMove": {
      if (!isActionEnabled("channels")) {
        throw new Error("Discord channel management is disabled.");
      }
      const guildId = readStringParam(params, "guildId", { required: true });
      const channelId = readStringParam(params, "channelId", {
        required: true,
      });
      const parentId = readParentIdParam(params);
      const position = readNumberParam(params, "position", { integer: true });
      if (accountId) {
        await moveChannelDiscord(
          {
            guildId,
            channelId,
            parentId,
            position: position ?? undefined,
          },
          { accountId },
        );
      } else {
        await moveChannelDiscord({
          guildId,
          channelId,
          parentId,
          position: position ?? undefined,
        });
      }
      return jsonResult({ ok: true });
    }
    case "categoryCreate": {
      if (!isActionEnabled("channels")) {
        throw new Error("Discord channel management is disabled.");
      }
      const guildId = readStringParam(params, "guildId", { required: true });
      const name = readStringParam(params, "name", { required: true });
      const position = readNumberParam(params, "position", { integer: true });
      const channel = accountId
        ? await createChannelDiscord(
            {
              guildId,
              name,
              type: 4,
              position: position ?? undefined,
            },
            { accountId },
          )
        : await createChannelDiscord({
            guildId,
            name,
            type: 4,
            position: position ?? undefined,
          });
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
      const channel = accountId
        ? await editChannelDiscord(
            {
              channelId: categoryId,
              name: name ?? undefined,
              position: position ?? undefined,
            },
            { accountId },
          )
        : await editChannelDiscord({
            channelId: categoryId,
            name: name ?? undefined,
            position: position ?? undefined,
          });
      return jsonResult({ ok: true, category: channel });
    }
    case "categoryDelete": {
      if (!isActionEnabled("channels")) {
        throw new Error("Discord channel management is disabled.");
      }
      const categoryId = readStringParam(params, "categoryId", {
        required: true,
      });
      const result = accountId
        ? await deleteChannelDiscord(categoryId, { accountId })
        : await deleteChannelDiscord(categoryId);
      return jsonResult(result);
    }
    case "channelPermissionSet": {
      if (!isActionEnabled("channels")) {
        throw new Error("Discord channel management is disabled.");
      }
      const channelId = readStringParam(params, "channelId", {
        required: true,
      });
      const targetId = readStringParam(params, "targetId", { required: true });
      const targetTypeRaw = readStringParam(params, "targetType", {
        required: true,
      });
      const targetType = targetTypeRaw === "member" ? 1 : 0;
      const allow = readStringParam(params, "allow");
      const deny = readStringParam(params, "deny");
      if (accountId) {
        await setChannelPermissionDiscord(
          {
            channelId,
            targetId,
            targetType,
            allow: allow ?? undefined,
            deny: deny ?? undefined,
          },
          { accountId },
        );
      } else {
        await setChannelPermissionDiscord({
          channelId,
          targetId,
          targetType,
          allow: allow ?? undefined,
          deny: deny ?? undefined,
        });
      }
      return jsonResult({ ok: true });
    }
    case "channelPermissionRemove": {
      if (!isActionEnabled("channels")) {
        throw new Error("Discord channel management is disabled.");
      }
      const channelId = readStringParam(params, "channelId", {
        required: true,
      });
      const targetId = readStringParam(params, "targetId", { required: true });
      if (accountId) {
        await removeChannelPermissionDiscord(channelId, targetId, { accountId });
      } else {
        await removeChannelPermissionDiscord(channelId, targetId);
      }
      return jsonResult({ ok: true });
    }
    default:
      throw new Error(`Unknown action: ${action}`);
  }
}
