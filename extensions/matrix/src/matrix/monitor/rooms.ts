import type { MatrixConfig, MatrixRoomConfig } from "../../types.js";

export type MatrixRoomConfigResolved = {
  allowed: boolean;
  allowlistConfigured: boolean;
  config?: MatrixRoomConfig;
};

export function resolveMatrixRoomConfig(params: {
  rooms?: MatrixConfig["rooms"];
  roomId: string;
  aliases: string[];
  name?: string | null;
}): MatrixRoomConfigResolved {
  const rooms = params.rooms ?? {};
  const keys = Object.keys(rooms);
  const allowlistConfigured = keys.length > 0;
  const candidates = [
    params.roomId,
    `room:${params.roomId}`,
    ...params.aliases,
    params.name ?? "",
  ].filter(Boolean);
  let matched: MatrixRoomConfigResolved["config"] | undefined;
  for (const candidate of candidates) {
    if (rooms[candidate]) {
      matched = rooms[candidate];
      break;
    }
  }
  if (!matched && rooms["*"]) {
    matched = rooms["*"];
  }
  const allowed = matched ? matched.enabled !== false && matched.allow !== false : false;
  return { allowed, allowlistConfigured, config: matched };
}
