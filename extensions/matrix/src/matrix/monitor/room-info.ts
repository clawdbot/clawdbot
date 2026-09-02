// Matrix plugin module implements room info behavior.
import { isMatrixNotFoundError } from "../errors.js";
import type { MatrixClient } from "../sdk.js";
import { setBoundedMap } from "./bounded-cache.js";

export type MatrixRoomInfo = {
  name?: string;
  canonicalAlias?: string;
  altAliases: string[];
  nameResolved: boolean;
  aliasesResolved: boolean;
};

const MAX_ROOM_INFO = 1024;
const MAX_MEMBER_DISPLAY_NAMES = 4096;

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
      setBoundedMap(roomNameCache, roomId, info, MAX_ROOM_INFO);
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
      setBoundedMap(roomAliasCache, roomId, info, MAX_ROOM_INFO);
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
    let memberState: Record<string, unknown>;
    try {
      memberState = await client.getRoomStateEvent(roomId, "m.room.member", userId);
    } catch {
      // A transient homeserver failure is not authoritative room state; retry
      // the next lookup instead of pinning the fallback user ID for the session.
      return userId;
    }
    const displayName =
      memberState && typeof memberState.displayname === "string" ? memberState.displayname : userId;
    setBoundedMap(memberDisplayNameCache, cacheKey, displayName, MAX_MEMBER_DISPLAY_NAMES);
    return displayName;
  };

  const invalidateMemberDisplayName = (roomId: string, userId: string): void => {
    memberDisplayNameCache.delete(`${roomId}:${userId}`);
  };

  return {
    getRoomAliases,
    getRoomInfo,
    getMemberDisplayName,
    invalidateMemberDisplayName,
  };
}
