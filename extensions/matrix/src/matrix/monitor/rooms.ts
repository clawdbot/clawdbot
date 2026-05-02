import type { MatrixRoomConfig } from "../../types.js";
import { buildChannelKeyCandidates, resolveChannelEntryMatch } from "./runtime-api.js";

type MatrixRoomConfigResolved = {
  allowed: boolean;
  allowlistConfigured: boolean;
  config?: MatrixRoomConfig;
  matchKey?: string;
  matchSource?: "direct" | "wildcard";
};

function readLegacyRoomAllowAlias(room: MatrixRoomConfig | undefined): boolean | undefined {
  const rawRoom = room as Record<string, unknown> | undefined;
  return typeof rawRoom?.allow === "boolean" ? rawRoom.allow : undefined;
}

export function resolveMatrixRoomConfig(params: {
  rooms?: Record<string, MatrixRoomConfig>;
  roomId: string;
  aliases: string[];
}): MatrixRoomConfigResolved {
  const rooms = params.rooms ?? {};
  const keys = Object.keys(rooms);
  const allowlistConfigured = keys.length > 0;
  const candidates = buildChannelKeyCandidates(
    params.roomId,
    `room:${params.roomId}`,
    ...params.aliases,
  );
  const {
    entry: matched,
    key: matchedKey,
    wildcardEntry,
    wildcardKey,
  } = resolveChannelEntryMatch({
    entries: rooms,
    keys: candidates,
    wildcardKey: "*",
  });
  const resolved = matched ?? wildcardEntry;
  const legacyAllow = readLegacyRoomAllowAlias(resolved);
  const allowed = resolved ? resolved.enabled !== false && legacyAllow !== false : false;
  const matchKey = matchedKey ?? wildcardKey;
  const matchSource = matched ? "direct" : wildcardEntry ? "wildcard" : undefined;
  return {
    allowed,
    allowlistConfigured,
    config: resolved,
    matchKey,
    matchSource,
  };
}
