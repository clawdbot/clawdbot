import { resolveMatrixAccountConfig } from "./matrix/accounts.js";
import { resolveMatrixRoomConfig } from "./matrix/monitor/rooms.js";
import { normalizeMatrixResolvableTarget } from "./matrix/target-ids.js";
import type { ChannelGroupContext, GroupToolPolicyConfig } from "./runtime-api.js";
import type { CoreConfig } from "./types.js";

function resolveMatrixRoomConfigForGroup(params: ChannelGroupContext) {
  const roomId = normalizeMatrixResolvableTarget(params.groupId?.trim() ?? "");
  const groupChannel = params.groupChannel?.trim() ?? "";
  const aliases = groupChannel ? [normalizeMatrixResolvableTarget(groupChannel)] : [];
  const cfg = params.cfg as CoreConfig;
  const matrixConfig = resolveMatrixAccountConfig({ cfg, accountId: params.accountId });
  return resolveMatrixRoomConfig({
    rooms: matrixConfig.groups ?? matrixConfig.rooms,
    roomId,
    aliases,
  }).config;
}

export function resolveMatrixGroupRequireMention(params: ChannelGroupContext): boolean {
  const resolved = resolveMatrixRoomConfigForGroup(params);
  if (resolved) {
    if (resolved.autoReply === true) {
      return false;
    }
    if (resolved.autoReply === false) {
      return true;
    }
    if (typeof resolved.requireMention === "boolean") {
      return resolved.requireMention;
    }
  }
  return true;
}

export function resolveMatrixGroupToolPolicy(
  params: ChannelGroupContext,
): GroupToolPolicyConfig | undefined {
  const resolved = resolveMatrixRoomConfigForGroup(params);
  return resolved?.tools;
}
