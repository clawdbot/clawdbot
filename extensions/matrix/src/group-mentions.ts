import type { ChannelGroupContext } from "../../../src/channels/plugins/types.js";

import { resolveMatrixRoomConfig } from "./matrix/monitor/rooms.js";
import type { CoreConfig } from "./types.js";

export function resolveMatrixGroupRequireMention(params: ChannelGroupContext): boolean {
  const rawGroupId = params.groupId?.trim() ?? "";
  let roomId = rawGroupId;
  const lower = roomId.toLowerCase();
  if (lower.startsWith("matrix:")) {
    roomId = roomId.slice("matrix:".length).trim();
  }
  if (roomId.toLowerCase().startsWith("channel:")) {
    roomId = roomId.slice("channel:".length).trim();
  }
  if (roomId.toLowerCase().startsWith("room:")) {
    roomId = roomId.slice("room:".length).trim();
  }
  const groupRoom = params.groupRoom?.trim() ?? "";
  const aliases = groupRoom ? [groupRoom] : [];
  const cfg = params.cfg as CoreConfig;
  const resolved = resolveMatrixRoomConfig({
    rooms: cfg.channels?.matrix?.rooms,
    roomId,
    aliases,
    name: groupRoom || undefined,
  }).config;
  if (resolved) {
    if (resolved.autoReply === true) return false;
    if (resolved.autoReply === false) return true;
    if (typeof resolved.requireMention === "boolean") return resolved.requireMention;
  }
  return true;
}
