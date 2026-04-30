import { parseAvailableTags, readNumberParam, readStringParam } from "../runtime-api.js";
import type { OpenClawConfig } from "../runtime-api.js";
import type {
  DiscordChannelCreate,
  DiscordChannelEdit,
  DiscordChannelMove,
} from "../send.types.js";

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
    type: readNumberParam(params, "type", { integer: true }) ?? undefined,
    parentId: parentId ?? undefined,
    topic: readStringParam(params, "topic") ?? undefined,
    position: readNumberParam(params, "position", { integer: true }) ?? undefined,
    nsfw: readDiscordBooleanParam(params, "nsfw"),
  };
}

export function readDiscordChannelEditParams(params: Record<string, unknown>): DiscordChannelEdit {
  const parentId = readDiscordParentIdParam(params);
  return {
    channelId: readStringParam(params, "channelId", { required: true }),
    name: readStringParam(params, "name") ?? undefined,
    topic: readStringParam(params, "topic") ?? undefined,
    position: readNumberParam(params, "position", { integer: true }) ?? undefined,
    parentId: parentId === undefined ? undefined : parentId,
    nsfw: readDiscordBooleanParam(params, "nsfw"),
    rateLimitPerUser: readNumberParam(params, "rateLimitPerUser", { integer: true }) ?? undefined,
    archived: readDiscordBooleanParam(params, "archived"),
    locked: readDiscordBooleanParam(params, "locked"),
    autoArchiveDuration:
      readNumberParam(params, "autoArchiveDuration", { integer: true }) ?? undefined,
    availableTags: parseAvailableTags(params.availableTags),
  };
}

export function readDiscordChannelMoveParams(params: Record<string, unknown>): DiscordChannelMove {
  const parentId = readDiscordParentIdParam(params);
  return {
    guildId: readStringParam(params, "guildId", { required: true }),
    channelId: readStringParam(params, "channelId", { required: true }),
    parentId: parentId === undefined ? undefined : parentId,
    position: readNumberParam(params, "position", { integer: true }) ?? undefined,
  };
}
