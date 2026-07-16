import { isMatrixNotFoundError } from "../errors.js";
import type { MatrixClient } from "../sdk.js";

export type MatrixRoomInfo = {
  name?: string;
  canonicalAlias?: string;
  altAliases: string[];
  nameResolved: boolean;
  aliasesResolved: boolean;
};

const MAX_TRACKED_ROOM_INFO = 1024;
const MAX_TRACKED_MEMBER_DISPLAY_NAMES = 4096;

function rememberBounded<T>(map: Map<string, T>, key: string, value: T, maxEntries: number): void {
  map.set(key, value);
  if (map.size > maxEntries) {
    const oldest = map.keys().next().value;
    if (typeof oldest === "string") {
      map.delete(oldest);
    }
  }
}

export function createMatrixRoomInfoResolver(client: MatrixClient) {
  const roomNameCache = new Map<string, Pick<MatrixRoomInfo, "name" | "nameResolved">>();
  const roomAliasCache = new Map<
    string,
    Pick<MatrixRoomInfo, "canonicalAlias" | "altAliases" | "aliasesResolved">
  >();
  const memberDisplayNameCache = new Map<string, string>();

  const getRoomName = async (
    roomId: string,
  ): Promise<Pick<MatrixRoomInfo, "name" | "nameResolved">> => {
    if (roomNameCache.has(roomId)) {
      return roomNameCache.get(roomId) ?? { nameResolved: false };
    }
    let name: string | undefined;
    let nameResolved = false;
    try {
      const nameState = await client.getRoomStateEvent(roomId, "m.room.name", "");
      nameResolved = true;
      if (nameState && typeof nameState.name === "string") {
        name = nameState.name;
      }
    } catch (err) {
      if (isMatrixNotFoundError(err)) {
        nameResolved = true;
      }
    }
    const info = { name, nameResolved };
    if (nameResolved) {
      rememberBounded(roomNameCache, roomId, info, MAX_TRACKED_ROOM_INFO);
    }
    return info;
  };

  const getRoomAliases = async (
    roomId: string,
  ): Promise<Pick<MatrixRoomInfo, "canonicalAlias" | "altAliases" | "aliasesResolved">> => {
    const cached = roomAliasCache.get(roomId);
    if (cached) {
      return cached;
    }
    let canonicalAlias: string | undefined;
    let altAliases: string[] = [];
    let aliasesResolved = false;
    try {
      const aliasState = await client.getRoomStateEvent(roomId, "m.room.canonical_alias", "");
      aliasesResolved = true;
      if (aliasState && typeof aliasState.alias === "string") {
        canonicalAlias = aliasState.alias;
      }
      const rawAliases = aliasState?.alt_aliases;
      if (Array.isArray(rawAliases)) {
        altAliases = rawAliases.filter((entry): entry is string => typeof entry === "string");
      }
    } catch (err) {
      if (isMatrixNotFoundError(err)) {
        aliasesResolved = true;
      }
    }
    const info = { canonicalAlias, altAliases, aliasesResolved };
    if (aliasesResolved) {
      rememberBounded(roomAliasCache, roomId, info, MAX_TRACKED_ROOM_INFO);
    }
    return info;
  };

  const getRoomInfo = async (
    roomId: string,
    opts: { includeAliases?: boolean } = {},
  ): Promise<MatrixRoomInfo> => {
    const { name, nameResolved } = await getRoomName(roomId);
    if (!opts.includeAliases) {
      return { name, altAliases: [], nameResolved, aliasesResolved: false };
    }
    const aliases = await getRoomAliases(roomId);
    return { name, nameResolved, ...aliases };
  };

  const getMemberDisplayName = async (roomId: string, userId: string): Promise<string> => {
    const cacheKey = `${roomId}:${userId}`;
    if (memberDisplayNameCache.has(cacheKey)) {
      return memberDisplayNameCache.get(cacheKey) ?? userId;
    }
    const memberState = await client
      .getRoomStateEvent(roomId, "m.room.member", userId)
      .catch(() => null);
    const displayName =
      memberState && typeof memberState.displayname === "string" ? memberState.displayname : userId;
    rememberBounded(
      memberDisplayNameCache,
      cacheKey,
      displayName,
      MAX_TRACKED_MEMBER_DISPLAY_NAMES,
    );
    return displayName;
  };

  return {
    getRoomInfo,
    getMemberDisplayName,
  };
}
