// Matrix plugin module implements rooms behavior.
import type { ScopeNode, ScopePath, ScopeTree } from "openclaw/plugin-sdk/channel-policy";
import type { MatrixRoomConfig } from "../../types.js";
import { buildChannelKeyCandidates } from "./runtime-api.js";

type MatrixRooms = Record<string, MatrixRoomConfig>;
type MatrixRoomLookup = { roomId: string; aliases: string[] };
type MatrixRoomScopeLookup = MatrixRoomLookup & { tree: ScopeTree };
type MatrixRoomConfigLookup = MatrixRoomLookup & { rooms?: MatrixRooms };

function readLegacyRoomAllowAlias(room: MatrixRoomConfig | undefined): boolean | undefined {
  const rawRoom = room as Record<string, unknown> | undefined;
  return typeof rawRoom?.allow === "boolean" ? rawRoom.allow : undefined;
}

export function buildMatrixRoomScopeTree(rooms: MatrixRooms | undefined): ScopeTree {
  // Whole-entry selection keeps "*" matchable; exact rooms hide every wildcard field.
  // Build-time autoReply projection gives resolution one deterministic mention value.
  const scopes: Record<string, ScopeNode> = {};
  for (const [key, room] of Object.entries(rooms ?? {})) {
    const requireMention =
      typeof room.autoReply === "boolean" ? !room.autoReply : room.requireMention;
    scopes[key] = { requireMention, tools: room.tools };
  }
  return { scopes };
}

export function resolveMatrixRoomScopePath(params: MatrixRoomScopeLookup): ScopePath {
  const candidates = buildChannelKeyCandidates(
    params.roomId,
    `room:${params.roomId}`,
    ...params.aliases,
  );
  const key =
    candidates.find((candidate) => Object.hasOwn(params.tree.scopes, candidate)) ??
    (Object.hasOwn(params.tree.scopes, "*") ? "*" : undefined);
  return key ? [key] : [];
}

export function resolveMatrixRoomConfig(params: MatrixRoomConfigLookup) {
  const rooms = params.rooms ?? {};
  const tree: ScopeTree = { scopes: rooms };
  const [matchKey] = resolveMatrixRoomScopePath({ ...params, tree });
  const resolved = matchKey ? rooms[matchKey] : undefined;
  const legacyAllow = readLegacyRoomAllowAlias(resolved);
  return {
    allowed: resolved ? resolved.enabled !== false && legacyAllow !== false : false,
    allowlistConfigured: Object.keys(rooms).length > 0,
    config: resolved,
    matchKey,
    matchSource: resolved ? (matchKey === "*" ? "wildcard" : "direct") : undefined,
  };
}
