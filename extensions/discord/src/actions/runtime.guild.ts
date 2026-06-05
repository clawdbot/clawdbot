// Discord plugin module implements runtime.guild behavior.
import { ChannelType, PermissionFlagsBits } from "discord-api-types/v10";
import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import { resolveDefaultDiscordAccountId } from "../accounts.js";
import { getPresence } from "../monitor/presence-cache.js";
import {
  type ActionGate,
  jsonResult,
  readNonNegativeIntegerParam,
  readStringArrayParam,
  readStringParam,
  type DiscordActionConfig,
  type OpenClawConfig,
} from "../runtime-api.js";
import {
  addRoleDiscord,
  canManageGuildRoleDiscord,
  canManageGuildMemberRoleDiscord,
  createChannelDiscord,
  createScheduledEventDiscord,
  deleteChannelDiscord,
  editChannelDiscord,
  fetchChannelInfoDiscord,
  fetchMemberInfoDiscord,
  hasAnyChannelPermissionDiscord,
  hasAnyGuildPermissionDiscord,
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
  createDiscordActionOptions,
  readDiscordChannelCreateParams,
  readDiscordChannelEditParams,
  readDiscordChannelMoveParams,
} from "./runtime.shared.js";

export const discordGuildActionRuntime = {
  addRoleDiscord,
  canManageGuildRoleDiscord,
  canManageGuildMemberRoleDiscord,
  createChannelDiscord,
  createScheduledEventDiscord,
  resolveEventCoverImage,
  deleteChannelDiscord,
  editChannelDiscord,
  fetchChannelInfoDiscord,
  fetchMemberInfoDiscord,
  hasAnyChannelPermissionDiscord,
  hasAnyGuildPermissionDiscord,
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

type GuildAdminActionGuard = {
  gate: keyof DiscordActionConfig;
  defaultEnabled?: boolean;
  disabledMessage: string;
  permissions: bigint[];
  permissionScope?: "guild" | "channel";
};

const expressionPermissions = [
  PermissionFlagsBits.ManageGuildExpressions,
  PermissionFlagsBits.CreateGuildExpressions,
  PermissionFlagsBits.ManageEmojisAndStickers,
];

const channelGuard = {
  gate: "channels",
  disabledMessage: "Discord channel management is disabled.",
  permissions: [PermissionFlagsBits.ManageChannels],
} satisfies GuildAdminActionGuard;

const existingChannelGuard = {
  ...channelGuard,
  permissionScope: "channel",
} satisfies GuildAdminActionGuard;

const channelPermissionGuard = {
  ...channelGuard,
  permissions: [PermissionFlagsBits.ManageRoles],
  permissionScope: "channel",
} satisfies GuildAdminActionGuard;

const guildAdminActionGuards: Partial<Record<string, GuildAdminActionGuard>> = {
  emojiUpload: {
    gate: "emojiUploads",
    disabledMessage: "Discord emoji uploads are disabled.",
    permissions: expressionPermissions,
  },
  stickerUpload: {
    gate: "stickerUploads",
    disabledMessage: "Discord sticker uploads are disabled.",
    permissions: expressionPermissions,
  },
  roleAdd: {
    gate: "roles",
    defaultEnabled: false,
    disabledMessage: "Discord role changes are disabled.",
    permissions: [PermissionFlagsBits.ManageRoles],
  },
  roleRemove: {
    gate: "roles",
    defaultEnabled: false,
    disabledMessage: "Discord role changes are disabled.",
    permissions: [PermissionFlagsBits.ManageRoles],
  },
  eventCreate: {
    gate: "events",
    disabledMessage: "Discord events are disabled.",
    permissions: [PermissionFlagsBits.ManageEvents, PermissionFlagsBits.CreateEvents],
  },
  channelCreate: channelGuard,
  channelEdit: existingChannelGuard,
  channelDelete: existingChannelGuard,
  channelMove: existingChannelGuard,
  categoryCreate: channelGuard,
  categoryEdit: existingChannelGuard,
  categoryDelete: existingChannelGuard,
  channelPermissionSet: channelPermissionGuard,
  channelPermissionRemove: channelPermissionGuard,
};

function isThreadChannelType(channelType: number | undefined) {
  return (
    channelType === ChannelType.GuildNewsThread ||
    channelType === ChannelType.GuildPublicThread ||
    channelType === ChannelType.GuildPrivateThread
  );
}

function isLockedThreadChannel(channel: unknown) {
  if (!channel || typeof channel !== "object") {
    return false;
  }
  const metadata = (channel as { thread_metadata?: { locked?: unknown } }).thread_metadata;
  return metadata?.locked === true;
}

function assertGuildAdminActionEnabled(
  action: string,
  isActionEnabled: ActionGate<DiscordActionConfig>,
) {
  const guard = guildAdminActionGuards[action];
  if (guard && !isActionEnabled(guard.gate, guard.defaultEnabled)) {
    throw new Error(guard.disabledMessage);
  }
}

async function resolveGuildIdForGuildAdminAction(params: {
  values: Record<string, unknown>;
  accountId?: string;
  cfg: OpenClawConfig;
}): Promise<string | undefined> {
  const guildId = readStringParam(params.values, "guildId");
  if (guildId) {
    return guildId;
  }

  const channelLikeId =
    readStringParam(params.values, "channelId") ?? readStringParam(params.values, "categoryId");
  if (!channelLikeId) {
    return undefined;
  }

  const channel = await discordGuildActionRuntime.fetchChannelInfoDiscord(
    channelLikeId,
    createDiscordActionOptions({ cfg: params.cfg, accountId: params.accountId }),
  );
  return "guild_id" in channel ? (channel.guild_id ?? undefined) : undefined;
}

function readChannelScopedPermissionTargetId(action: string, values: Record<string, unknown>) {
  if (action === "eventCreate") {
    return readStringParam(values, "channelId");
  }
  if (action === "categoryEdit" || action === "categoryDelete") {
    return readStringParam(values, "categoryId");
  }
  return readStringParam(values, "channelId");
}

async function resolveGuildAdminActionPermissions(params: {
  action: string;
  values: Record<string, unknown>;
  accountId?: string;
  cfg: OpenClawConfig;
  guard: GuildAdminActionGuard;
}) {
  if (params.action !== "channelEdit") {
    return params.guard.permissions;
  }

  const channelId = readStringParam(params.values, "channelId");
  if (!channelId) {
    return params.guard.permissions;
  }

  const channel = await discordGuildActionRuntime.fetchChannelInfoDiscord(
    channelId,
    createDiscordActionOptions({ cfg: params.cfg, accountId: params.accountId }),
  );
  const channelType = "type" in channel ? channel.type : undefined;
  if (!isThreadChannelType(channelType)) {
    return params.guard.permissions;
  }

  const onlyReopen =
    params.values.archived === false &&
    !("name" in params.values) &&
    !("topic" in params.values) &&
    !("position" in params.values) &&
    !("parentId" in params.values) &&
    !("clearParent" in params.values) &&
    !("nsfw" in params.values) &&
    !("rateLimitPerUser" in params.values) &&
    !("locked" in params.values) &&
    !("autoArchiveDuration" in params.values) &&
    !isLockedThreadChannel(channel);
  return onlyReopen
    ? [PermissionFlagsBits.ManageThreads, PermissionFlagsBits.SendMessagesInThreads]
    : [PermissionFlagsBits.ManageThreads];
}

async function verifySenderGuildAdminPermission(params: {
  action: string;
  values: Record<string, unknown>;
  accountId?: string;
  cfg: OpenClawConfig;
}) {
  const guard = guildAdminActionGuards[params.action];
  const senderUserId = readStringParam(params.values, "senderUserId");
  if (!guard?.permissions.length || !senderUserId) {
    return;
  }
  const requiredPermissions = await resolveGuildAdminActionPermissions({ ...params, guard });

  const guildId = await resolveGuildIdForGuildAdminAction(params);
  if (!guildId) {
    throw new Error(`Guild id required to authorize Discord guild action: ${params.action}`);
  }

  const actionOptions = createDiscordActionOptions({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  const targetChannelId =
    guard?.permissionScope === "channel" || params.action === "eventCreate"
      ? readChannelScopedPermissionTargetId(params.action, params.values)
      : undefined;
  const hasPermission = targetChannelId
    ? await discordGuildActionRuntime.hasAnyChannelPermissionDiscord(
        guildId,
        targetChannelId,
        senderUserId,
        requiredPermissions,
        actionOptions,
      )
    : await discordGuildActionRuntime.hasAnyGuildPermissionDiscord(
        guildId,
        senderUserId,
        requiredPermissions,
        actionOptions,
      );
  if (!hasPermission) {
    throw new Error("Sender does not have required permissions for this guild action.");
  }

  if (params.action === "roleAdd" || params.action === "roleRemove") {
    const targetUserId = readStringParam(params.values, "userId", { required: true });
    const roleId = readStringParam(params.values, "roleId", { required: true });
    const canManageRole = await discordGuildActionRuntime.canManageGuildMemberRoleDiscord(
      guildId,
      senderUserId,
      targetUserId,
      roleId,
      actionOptions,
      { assignablePermissionCeiling: params.action === "roleAdd" },
    );
    if (!canManageRole) {
      throw new Error("Sender cannot manage the requested role or member.");
    }
  }

  if (params.action === "channelPermissionSet" || params.action === "channelPermissionRemove") {
    const targetType = readStringParam(params.values, "targetType");
    if (targetType === "member") {
      return;
    }
    const targetId = readStringParam(params.values, "targetId", { required: true });
    const canManageRole = await discordGuildActionRuntime.canManageGuildRoleDiscord(
      guildId,
      senderUserId,
      targetId,
      actionOptions,
    );
    if (canManageRole === false || (targetType === "role" && canManageRole === null)) {
      throw new Error("Sender cannot manage the requested role overwrite.");
    }
  }
}

async function runRoleMutation(params: {
  cfg: OpenClawConfig;
  accountId?: string;
  values: Record<string, unknown>;
  mutate: DiscordRoleMutation;
}) {
  const guildId = readStringParam(params.values, "guildId", { required: true });
  const userId = readStringParam(params.values, "userId", { required: true });
  const roleId = readStringParam(params.values, "roleId", { required: true });
  await params.mutate(
    { guildId, userId, roleId },
    createDiscordActionOptions({ cfg: params.cfg, accountId: params.accountId }),
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
  assertGuildAdminActionEnabled(action, isActionEnabled);
  await verifySenderGuildAdminPermission({ action, values: params, accountId, cfg });
  const withOpts = (extra?: Record<string, unknown>) =>
    createDiscordActionOptions({ cfg, accountId, extra });
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
      const member = await discordGuildActionRuntime.fetchMemberInfoDiscord(
        guildId,
        userId,
        createDiscordActionOptions({ cfg, accountId: effectiveAccountId }),
      );
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
        cfg,
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
        cfg,
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
      const position = readNonNegativeIntegerParam(params, "position");
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
      const position = readNonNegativeIntegerParam(params, "position");
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
