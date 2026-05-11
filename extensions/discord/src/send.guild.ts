import type {
  APIGuildMember,
  APIGuildScheduledEvent,
  APIRole,
  APIVoiceState,
  RESTPostAPIGuildScheduledEventJSONBody,
} from "discord-api-types/v10";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { loadWebMediaRaw } from "openclaw/plugin-sdk/web-media";
import {
  addGuildMemberRole,
  createGuildBan,
  createGuildScheduledEvent,
  getChannel,
  getGuildMember,
  getGuildVoiceState,
  listGuildChannels,
  listGuildRoles,
  listGuildScheduledEvents,
  removeGuildMember,
  removeGuildMemberRole,
  timeoutGuildMember,
  type APIChannel,
} from "./internal/discord.js";
import { resolveDiscordRest } from "./send.shared.js";
import type {
  DiscordModerationTarget,
  DiscordReactOpts,
  DiscordRoleChange,
  DiscordTimeoutTarget,
} from "./send.types.js";
import { DISCORD_MAX_EVENT_COVER_BYTES } from "./send.types.js";

export async function fetchMemberInfoDiscord(
  guildId: string,
  userId: string,
  opts: DiscordReactOpts,
): Promise<APIGuildMember> {
  const rest = resolveDiscordRest(opts);
  return await getGuildMember(rest, guildId, userId);
}

export async function fetchRoleInfoDiscord(
  guildId: string,
  opts: DiscordReactOpts,
): Promise<APIRole[]> {
  const rest = resolveDiscordRest(opts);
  return await listGuildRoles(rest, guildId);
}

export async function addRoleDiscord(payload: DiscordRoleChange, opts: DiscordReactOpts) {
  const rest = resolveDiscordRest(opts);
  await addGuildMemberRole(rest, payload.guildId, payload.userId, payload.roleId);
  return { ok: true };
}

export async function removeRoleDiscord(payload: DiscordRoleChange, opts: DiscordReactOpts) {
  const rest = resolveDiscordRest(opts);
  await removeGuildMemberRole(rest, payload.guildId, payload.userId, payload.roleId);
  return { ok: true };
}

export async function fetchChannelInfoDiscord(
  channelId: string,
  opts: DiscordReactOpts,
): Promise<APIChannel> {
  const rest = resolveDiscordRest(opts);
  return await getChannel(rest, channelId);
}

export async function listGuildChannelsDiscord(
  guildId: string,
  opts: DiscordReactOpts,
): Promise<APIChannel[]> {
  const rest = resolveDiscordRest(opts);
  return await listGuildChannels(rest, guildId);
}

export async function fetchVoiceStatusDiscord(
  guildId: string,
  userId: string,
  opts: DiscordReactOpts,
): Promise<APIVoiceState> {
  const rest = resolveDiscordRest(opts);
  return await getGuildVoiceState(rest, guildId, userId);
}

export async function listScheduledEventsDiscord(
  guildId: string,
  opts: DiscordReactOpts,
): Promise<APIGuildScheduledEvent[]> {
  const rest = resolveDiscordRest(opts);
  return await listGuildScheduledEvents(rest, guildId);
}

const ALLOWED_EVENT_COVER_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/gif"]);

// Loads an image from a URL or path and returns a data URI suitable for the Discord API.
export async function resolveEventCoverImage(
  imageUrl: string,
  opts?: { localRoots?: readonly string[] },
): Promise<string> {
  const media = await loadWebMediaRaw(imageUrl, DISCORD_MAX_EVENT_COVER_BYTES, {
    localRoots: opts?.localRoots,
  });
  const contentType = normalizeOptionalLowercaseString(media.contentType);
  if (!contentType || !ALLOWED_EVENT_COVER_TYPES.has(contentType)) {
    throw new Error(
      `Discord event cover images must be PNG, JPG, or GIF (got ${contentType ?? "unknown"})`,
    );
  }
  return `data:${contentType};base64,${media.buffer.toString("base64")}`;
}

export async function createScheduledEventDiscord(
  guildId: string,
  payload: RESTPostAPIGuildScheduledEventJSONBody,
  opts: DiscordReactOpts,
): Promise<APIGuildScheduledEvent> {
  const rest = resolveDiscordRest(opts);
  return await createGuildScheduledEvent(rest, guildId, payload);
}

export async function timeoutMemberDiscord(
  payload: DiscordTimeoutTarget,
  opts: DiscordReactOpts,
): Promise<APIGuildMember> {
  const rest = resolveDiscordRest(opts);
  let until = payload.until;
  if (!until && payload.durationMinutes) {
    const ms = payload.durationMinutes * 60 * 1000;
    until = new Date(Date.now() + ms).toISOString();
  }
  return await timeoutGuildMember(rest, payload.guildId, payload.userId, {
    body: { communication_disabled_until: until ?? null },
    headers: payload.reason
      ? { "X-Audit-Log-Reason": encodeURIComponent(payload.reason) }
      : undefined,
  });
}

export async function kickMemberDiscord(payload: DiscordModerationTarget, opts: DiscordReactOpts) {
  const rest = resolveDiscordRest(opts);
  await removeGuildMember(rest, payload.guildId, payload.userId, {
    headers: payload.reason
      ? { "X-Audit-Log-Reason": encodeURIComponent(payload.reason) }
      : undefined,
  });
  return { ok: true };
}

export async function banMemberDiscord(
  payload: DiscordModerationTarget & { deleteMessageDays?: number },
  opts: DiscordReactOpts,
) {
  const rest = resolveDiscordRest(opts);
  const deleteMessageDays =
    typeof payload.deleteMessageDays === "number" && Number.isFinite(payload.deleteMessageDays)
      ? Math.min(Math.max(Math.floor(payload.deleteMessageDays), 0), 7)
      : undefined;
  await createGuildBan(rest, payload.guildId, payload.userId, {
    body: deleteMessageDays !== undefined ? { delete_message_days: deleteMessageDays } : undefined,
    headers: payload.reason
      ? { "X-Audit-Log-Reason": encodeURIComponent(payload.reason) }
      : undefined,
  });
  return { ok: true };
}

// Channel management functions
