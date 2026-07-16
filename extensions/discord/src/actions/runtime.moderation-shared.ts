import { PermissionFlagsBits } from "discord-api-types/v10";
import { readNumberParam, readStringParam } from "../runtime-api.js";

export type DiscordModerationAction = "timeout" | "kick" | "ban";

export type DiscordModerationCommand = {
  action: DiscordModerationAction;
  guildId: string;
  userId: string;
  durationMinutes?: number;
  until?: string;
  reason?: string;
  deleteMessageDays?: number;
};

const moderationPermissions: Record<DiscordModerationAction, bigint> = {
  timeout: PermissionFlagsBits.ModerateMembers,
  kick: PermissionFlagsBits.KickMembers,
  ban: PermissionFlagsBits.BanMembers,
};

export function isDiscordModerationAction(action: string): action is DiscordModerationAction {
  return action === "timeout" || action === "kick" || action === "ban";
}

export function requiredGuildPermissionForModerationAction(
  action: DiscordModerationAction,
): bigint {
  return moderationPermissions[action];
}

export function readDiscordModerationCommand(
  action: string,
  params: Record<string, unknown>,
): DiscordModerationCommand {
  if (!isDiscordModerationAction(action)) {
    throw new Error(`Unsupported Discord moderation action: ${action}`);
  }
  return {
    action,
    guildId: readStringParam(params, "guildId", { required: true }),
    userId: readStringParam(params, "userId", { required: true }),
    durationMinutes: readNumberParam(params, "durationMinutes", { integer: true }),
    until: readStringParam(params, "until"),
    reason: readStringParam(params, "reason"),
    deleteMessageDays: readNumberParam(params, "deleteMessageDays", { integer: true }),
  };
}
