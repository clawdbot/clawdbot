import type { MatrixRoomConfig } from "../../types.js";
import type { MatrixRoomInfo } from "./room-info.js";
import { resolveMatrixRoomConfig } from "./rooms.js";

export function shouldPromoteRecentInviteRoom(params: {
  roomId: string;
  roomInfo: Pick<
    MatrixRoomInfo,
    "name" | "canonicalAlias" | "altAliases" | "nameResolved" | "aliasesResolved"
  >;
  rooms?: Record<string, MatrixRoomConfig>;
}): boolean {
  if (!params.roomInfo.nameResolved || !params.roomInfo.aliasesResolved) {
    return false;
  }

  const roomAliases = [params.roomInfo.canonicalAlias ?? "", ...params.roomInfo.altAliases].filter(
    Boolean,
  );
  if ((params.roomInfo.name?.trim() ?? "") || roomAliases.length > 0) {
    return false;
  }

  const roomConfig = resolveMatrixRoomConfig({
    rooms: params.rooms,
    roomId: params.roomId,
    aliases: roomAliases,
  });
  return roomConfig.matchSource === undefined;
}
