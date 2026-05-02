import type { APIChannel, APIGuild, APIGuildMember, APIRole } from "discord-api-types/v10";
import { ChannelType, PermissionFlagsBits } from "discord-api-types/v10";
import { resolveDiscordRest } from "./client.js";
import {
  getChannel,
  getCurrentUser,
  getGuild,
  getGuildMember,
  type RequestClient,
} from "./internal/discord.js";
import type { DiscordPermissionsSummary, DiscordReactOpts } from "./send.types.js";

const PERMISSION_ENTRIES = Object.entries(PermissionFlagsBits).filter(
  ([, value]) => typeof value === "bigint",
);
const ALL_PERMISSIONS = PERMISSION_ENTRIES.reduce((acc, [, value]) => acc | value, 0n);
const ADMINISTRATOR_BIT = PermissionFlagsBits.Administrator;

function addPermissionBits(base: bigint, add?: string) {
  if (!add) {
    return base;
  }
  return base | BigInt(add);
}

function removePermissionBits(base: bigint, deny?: string) {
  if (!deny) {
    return base;
  }
  return base & ~BigInt(deny);
}

function bitfieldToPermissions(bitfield: bigint) {
  return PERMISSION_ENTRIES.filter(([, value]) => (bitfield & value) === value)
    .map(([name]) => name)
    .toSorted();
}

function hasAdministrator(bitfield: bigint) {
  return (bitfield & ADMINISTRATOR_BIT) === ADMINISTRATOR_BIT;
}

function hasPermissionBit(bitfield: bigint, permission: bigint) {
  return (bitfield & permission) === permission;
}

export function isThreadChannelType(channelType?: number) {
  return (
    channelType === ChannelType.GuildNewsThread ||
    channelType === ChannelType.GuildPublicThread ||
    channelType === ChannelType.GuildPrivateThread
  );
}

async function fetchBotUserId(rest: RequestClient) {
  const me = await getCurrentUser(rest);
  if (!me?.id) {
    throw new Error("Failed to resolve bot user id");
  }
  return me.id;
}

function resolveMemberGuildPermissionBits(params: {
  guild: Pick<APIGuild, "id" | "roles">;
  member: Pick<APIGuildMember, "roles">;
}) {
  const rolesById = new Map<string, APIRole>(
    (params.guild.roles ?? []).map((role) => [role.id, role]),
  );
  const everyoneRole = rolesById.get(params.guild.id);
  let permissions = 0n;
  if (everyoneRole?.permissions) {
    permissions = addPermissionBits(permissions, everyoneRole.permissions);
  }
  for (const roleId of params.member.roles ?? []) {
    const role = rolesById.get(roleId);
    if (role?.permissions) {
      permissions = addPermissionBits(permissions, role.permissions);
    }
  }
  return permissions;
}

function resolveMemberChannelPermissionBits(params: {
  guildId: string;
  userId: string;
  guild: Pick<APIGuild, "id" | "roles">;
  member: Pick<APIGuildMember, "roles">;
  channel: APIChannel;
}) {
  let permissions = resolveMemberGuildPermissionBits({
    guild: params.guild,
    member: params.member,
  });

  if (hasAdministrator(permissions)) {
    return ALL_PERMISSIONS;
  }

  const overwrites =
    "permission_overwrites" in params.channel ? (params.channel.permission_overwrites ?? []) : [];
  for (const overwrite of overwrites) {
    if (overwrite.id === params.guildId) {
      permissions = removePermissionBits(permissions, overwrite.deny ?? "0");
      permissions = addPermissionBits(permissions, overwrite.allow ?? "0");
    }
  }
  let roleDeny = 0n;
  let roleAllow = 0n;
  for (const overwrite of overwrites) {
    if (params.member.roles?.includes(overwrite.id)) {
      roleDeny = addPermissionBits(roleDeny, overwrite.deny ?? "0");
      roleAllow = addPermissionBits(roleAllow, overwrite.allow ?? "0");
    }
  }
  permissions = permissions & ~roleDeny;
  permissions = permissions | roleAllow;
  for (const overwrite of overwrites) {
    if (overwrite.id === params.userId) {
      permissions = removePermissionBits(permissions, overwrite.deny ?? "0");
      permissions = addPermissionBits(permissions, overwrite.allow ?? "0");
    }
  }

  return permissions;
}

/**
 * Fetch guild-level permissions for a user. This does not include channel-specific overwrites.
 */
export async function fetchMemberGuildPermissionsDiscord(
  guildId: string,
  userId: string,
  opts: DiscordReactOpts,
): Promise<bigint | null> {
  const rest = resolveDiscordRest(opts);
  try {
    const [guild, member] = await Promise.all([
      getGuild(rest, guildId),
      getGuildMember(rest, guildId, userId),
    ]);
    return resolveMemberGuildPermissionBits({ guild, member });
  } catch {
    // Not a guild member, guild not found, or API failure.
    return null;
  }
}

export async function canViewDiscordGuildChannel(
  guildId: string,
  channelId: string,
  userId: string,
  opts: DiscordReactOpts,
): Promise<boolean> {
  const rest = resolveDiscordRest(opts);
  try {
    const channel = await getChannel(rest, channelId);
    const channelGuildId = "guild_id" in channel ? channel.guild_id : undefined;
    if (channelGuildId !== guildId) {
      return false;
    }
    const [guild, member] = await Promise.all([
      getGuild(rest, guildId),
      getGuildMember(rest, guildId, userId),
    ]);
    const permissions = resolveMemberChannelPermissionBits({
      guildId,
      userId,
      guild,
      member,
      channel,
    });
    return hasPermissionBit(permissions, PermissionFlagsBits.ViewChannel);
  } catch {
    return false;
  }
}

/**
 * Returns true when the user has ADMINISTRATOR or required permission bits
 * matching the provided predicate.
 */
async function hasGuildPermissionsDiscord(
  guildId: string,
  userId: string,
  requiredPermissions: bigint[],
  check: (permissions: bigint, requiredPermissions: bigint[]) => boolean,
  opts: DiscordReactOpts,
): Promise<boolean> {
  const permissions = await fetchMemberGuildPermissionsDiscord(guildId, userId, opts);
  if (permissions === null) {
    return false;
  }
  if (hasAdministrator(permissions)) {
    return true;
  }
  return check(permissions, requiredPermissions);
}

/**
 * Returns true when the user has ADMINISTRATOR or any required permission bit.
 */
export async function hasAnyGuildPermissionDiscord(
  guildId: string,
  userId: string,
  requiredPermissions: bigint[],
  opts: DiscordReactOpts,
): Promise<boolean> {
  return await hasGuildPermissionsDiscord(
    guildId,
    userId,
    requiredPermissions,
    (permissions, required) =>
      required.some((permission) => hasPermissionBit(permissions, permission)),
    opts,
  );
}

/**
 * Returns true when the user has ADMINISTRATOR or all required permission bits.
 */
export async function hasAllGuildPermissionsDiscord(
  guildId: string,
  userId: string,
  requiredPermissions: bigint[],
  opts: DiscordReactOpts,
): Promise<boolean> {
  return await hasGuildPermissionsDiscord(
    guildId,
    userId,
    requiredPermissions,
    (permissions, required) =>
      required.every((permission) => hasPermissionBit(permissions, permission)),
    opts,
  );
}

/**
 * @deprecated Prefer hasAnyGuildPermissionDiscord or hasAllGuildPermissionsDiscord for clarity.
 */
export const hasGuildPermissionDiscord = hasAnyGuildPermissionDiscord;

export async function fetchChannelPermissionsDiscord(
  channelId: string,
  opts: DiscordReactOpts,
): Promise<DiscordPermissionsSummary> {
  const rest = resolveDiscordRest(opts);
  const channel = await getChannel(rest, channelId);
  const channelType = "type" in channel ? channel.type : undefined;
  const guildId = "guild_id" in channel ? channel.guild_id : undefined;
  if (!guildId) {
    return {
      channelId,
      permissions: [],
      raw: "0",
      isDm: true,
      channelType,
    };
  }

  const botId = await fetchBotUserId(rest);
  const [guild, member] = await Promise.all([
    getGuild(rest, guildId),
    getGuildMember(rest, guildId, botId),
  ]);

  const permissions = resolveMemberChannelPermissionBits({
    guildId,
    userId: botId,
    guild,
    member,
    channel,
  });

  return {
    channelId,
    guildId,
    permissions: bitfieldToPermissions(permissions),
    raw: permissions.toString(),
    isDm: false,
    channelType,
  };
}
