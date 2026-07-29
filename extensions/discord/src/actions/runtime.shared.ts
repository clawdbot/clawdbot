// Discord plugin module implements runtime.shared behavior.
import {
  parseAvailableTags,
  readNonNegativeIntegerParam,
  readPositiveIntegerParam,
  readStringParam,
} from "../runtime-api.js";
import type { OpenClawConfig } from "../runtime-api.js";
import type {
  DiscordChannelCreate,
  DiscordChannelEdit,
  DiscordChannelMove,
} from "../send.types.js";

/** Discord REST auto_archive_duration allowlist (minutes). */
const DISCORD_AUTO_ARCHIVE_MINUTES = new Set([60, 1440, 4320, 10080]);

export function readDiscordParentIdParam(
  params: Record<string, unknown>,
): string | null | undefined {
  if (params.clearParent === true) {
    return null;
  }
  if (params.parentId === null) {
    return null;
  }
  return readStringParam(params, "parentId");
}

/**
 * Reads Discord auto-archive duration minutes and rejects values Discord will
 * not accept, so thread/channel edits fail closed before the REST call.
 */
export function readDiscordAutoArchiveDurationParam(
  params: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = readPositiveIntegerParam(params, key);
  if (value === undefined) {
    return undefined;
  }
  if (!DISCORD_AUTO_ARCHIVE_MINUTES.has(value)) {
    throw new Error(`${key} must be one of 60, 1440, 4320, or 10080 minutes`);
  }
  return value;
}

function readDiscordBooleanParam(
  params: Record<string, unknown>,
  key: string,
): boolean | undefined {
  return typeof params[key] === "boolean" ? params[key] : undefined;
}

export function createDiscordActionOptions<
  T extends Record<string, unknown> = Record<string, never>,
>(params: {
  cfg: OpenClawConfig;
  accountId?: string;
  extra?: T;
}): { cfg: OpenClawConfig; accountId?: string } & T {
  return {
    cfg: params.cfg,
    ...(params.accountId ? { accountId: params.accountId } : {}),
    ...(params.extra ?? ({} as T)),
  };
}

export function readDiscordChannelCreateParams(
  params: Record<string, unknown>,
): DiscordChannelCreate {
  const parentId = readDiscordParentIdParam(params);
  return {
    guildId: readStringParam(params, "guildId", { required: true }),
    name: readStringParam(params, "name", { required: true }),
    type:
      readNonNegativeIntegerParam(params, "channelType") ??
      readNonNegativeIntegerParam(params, "type") ??
      undefined,
    parentId: parentId ?? undefined,
    topic: readStringParam(params, "topic") ?? undefined,
    position: readNonNegativeIntegerParam(params, "position") ?? undefined,
    nsfw: readDiscordBooleanParam(params, "nsfw"),
  };
}

export function readDiscordChannelEditParams(params: Record<string, unknown>): DiscordChannelEdit {
  const parentId = readDiscordParentIdParam(params);
  return {
    channelId: readStringParam(params, "channelId", { required: true }),
    name: readStringParam(params, "name") ?? undefined,
    topic: readStringParam(params, "topic") ?? undefined,
    position: readNonNegativeIntegerParam(params, "position") ?? undefined,
    parentId: parentId === undefined ? undefined : parentId,
    nsfw: readDiscordBooleanParam(params, "nsfw"),
    rateLimitPerUser: readNonNegativeIntegerParam(params, "rateLimitPerUser") ?? undefined,
    archived: readDiscordBooleanParam(params, "archived"),
    locked: readDiscordBooleanParam(params, "locked"),
    autoArchiveDuration: readDiscordAutoArchiveDurationParam(params, "autoArchiveDuration"),
    availableTags: parseAvailableTags(params.availableTags),
  };
}

export function readDiscordChannelMoveParams(params: Record<string, unknown>): DiscordChannelMove {
  const parentId = readDiscordParentIdParam(params);
  return {
    guildId: readStringParam(params, "guildId", { required: true }),
    channelId: readStringParam(params, "channelId", { required: true }),
    parentId: parentId === undefined ? undefined : parentId,
    position: readNonNegativeIntegerParam(params, "position") ?? undefined,
  };
}
