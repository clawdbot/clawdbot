import { promoteMatrixDirectRoomCandidate } from "../direct-management.js";
import {
  hasDirectMatrixMemberFlag,
  isStrictDirectMembership,
  readJoinedMatrixMembers,
} from "../direct-room.js";
import type { MatrixClient } from "../sdk.js";

type DirectMessageCheck = {
  roomId: string;
  senderId?: string;
  selfUserId?: string;
};

type DirectRoomTrackerOptions = {
  log?: (message: string) => void;
  canPromoteRecentInvite?: (roomId: string) => boolean | Promise<boolean>;
  canPromoteUnmappedStrictRoom?: (roomId: string) => boolean | Promise<boolean>;
  shouldKeepLocallyPromotedDirectRoom?:
    | ((roomId: string) => boolean | undefined | Promise<boolean | undefined>)
    | undefined;
};

const DM_CACHE_TTL_MS = 30_000;
const RECENT_INVITE_TTL_MS = 30_000;
const MAX_TRACKED_DM_ROOMS = 1024;
const MAX_TRACKED_DM_MEMBER_FLAGS = 2048;

function rememberBounded<T>(
  map: Map<string, T>,
  key: string,
  value: T,
  maxSize = MAX_TRACKED_DM_ROOMS,
): void {
  map.set(key, value);
  if (map.size > maxSize) {
    const oldest = map.keys().next().value;
    if (typeof oldest === "string") {
      map.delete(oldest);
    }
  }
}

export function createDirectRoomTracker(client: MatrixClient, opts: DirectRoomTrackerOptions = {}) {
  const log = opts.log ?? (() => {});
  let lastDmUpdateMs = 0;
  // Once m.direct has seeded successfully, prefer the explicit cache over
  // re-enabling the broad 2-person fallback after a later transient failure.
  let hasSeededDmCache = false;
  let cachedSelfUserId: string | null = null;
  const joinedMembersCache = new Map<string, { members: string[]; ts: number }>();
  const directMemberFlagCache = new Map<string, { isDirect: boolean | null; ts: number }>();
  const recentInviteCandidates = new Map<string, { remoteUserId: string; ts: number }>();
  const locallyPromotedDirectRooms = new Map<string, { remoteUserId: string }>();

  const ensureSelfUserId = async (): Promise<string | null> => {
    if (cachedSelfUserId) {
      return cachedSelfUserId;
    }
    try {
      cachedSelfUserId = await client.getUserId();
    } catch {
      cachedSelfUserId = null;
    }
    return cachedSelfUserId;
  };

  const refreshDmCache = async (): Promise<void> => {
    const now = Date.now();
    if (now - lastDmUpdateMs < DM_CACHE_TTL_MS) {
      return;
    }
    lastDmUpdateMs = now;
    hasSeededDmCache = (await client.dms.update()) || hasSeededDmCache;
  };

  const resolveJoinedMembers = async (roomId: string): Promise<string[] | null> => {
    const cached = joinedMembersCache.get(roomId);
    const now = Date.now();
    if (cached && now - cached.ts < DM_CACHE_TTL_MS) {
      return cached.members;
    }
    try {
      const normalized = await readJoinedMatrixMembers(client, roomId);
      if (!normalized) {
        throw new Error("membership unavailable");
      }
      rememberBounded(joinedMembersCache, roomId, { members: normalized, ts: now });
      return normalized;
    } catch (err) {
      log(`matrix: dm member lookup failed room=${roomId} (${String(err)})`);
      return null;
    }
  };

  const resolveDirectMemberFlag = async (
    roomId: string,
    userId?: string | null,
  ): Promise<boolean | null> => {
    const normalizedUserId = userId?.trim();
    if (!normalizedUserId) {
      return null;
    }
    const cacheKey = `${roomId}\n${normalizedUserId}`;
    const cached = directMemberFlagCache.get(cacheKey);
    const now = Date.now();
    if (cached && now - cached.ts < DM_CACHE_TTL_MS) {
      return cached.isDirect;
    }
    const isDirect = await hasDirectMatrixMemberFlag(client, roomId, normalizedUserId);
    rememberBounded(
      directMemberFlagCache,
      cacheKey,
      { isDirect, ts: now },
      MAX_TRACKED_DM_MEMBER_FLAGS,
    );
    return isDirect;
  };

  const hasRecentInviteCandidate = (roomId: string, remoteUserId?: string | null): boolean => {
    const normalizedRemoteUserId = remoteUserId?.trim();
    if (!normalizedRemoteUserId) {
      return false;
    }
    const cached = recentInviteCandidates.get(roomId);
    if (!cached) {
      return false;
    }
    if (Date.now() - cached.ts >= RECENT_INVITE_TTL_MS) {
      recentInviteCandidates.delete(roomId);
      return false;
    }
    return cached.remoteUserId === normalizedRemoteUserId;
  };

  const canPromoteRecentInvite = async (roomId: string): Promise<boolean> => {
    try {
      return (await opts.canPromoteRecentInvite?.(roomId)) ?? true;
    } catch (err) {
      log(`matrix: recent invite promotion veto failed room=${roomId} (${String(err)})`);
      return false;
    }
  };

  const canPromoteUnmappedStrictRoom = async (roomId: string): Promise<boolean> => {
    try {
      return (await opts.canPromoteUnmappedStrictRoom?.(roomId)) ?? false;
    } catch (err) {
      log(`matrix: unmapped strict room promotion veto failed room=${roomId} (${String(err)})`);
      return false;
    }
  };

  const shouldKeepLocallyPromotedDirectRoom = async (
    roomId: string,
  ): Promise<boolean | undefined> => {
    try {
      return await opts.shouldKeepLocallyPromotedDirectRoom?.(roomId);
    } catch (err) {
      log(`matrix: local promotion keep-check failed room=${roomId} (${String(err)})`);
      return undefined;
    }
  };

  const hasLocallyPromotedDirectRoom = (roomId: string, remoteUserId?: string | null): boolean => {
    const normalizedRemoteUserId = remoteUserId?.trim();
    if (!normalizedRemoteUserId) {
      return false;
    }
    return locallyPromotedDirectRooms.get(roomId)?.remoteUserId === normalizedRemoteUserId;
  };

  const rememberLocallyPromotedDirectRoom = (roomId: string, remoteUserId: string): void => {
    const normalizedRemoteUserId = remoteUserId.trim();
    if (!normalizedRemoteUserId) {
      return;
    }
    rememberBounded(locallyPromotedDirectRooms, roomId, {
      remoteUserId: normalizedRemoteUserId,
    });
  };

  return {
    invalidateRoom: (roomId: string): void => {
      joinedMembersCache.delete(roomId);
      for (const key of directMemberFlagCache.keys()) {
        if (key.startsWith(`${roomId}\n`)) {
          directMemberFlagCache.delete(key);
        }
      }
      lastDmUpdateMs = 0;
      log(`matrix: invalidated dm cache room=${roomId}`);
    },
    rememberInvite: (roomId: string, remoteUserId: string): void => {
      const normalizedRemoteUserId = remoteUserId.trim();
      if (!normalizedRemoteUserId) {
        return;
      }
      rememberBounded(recentInviteCandidates, roomId, {
        remoteUserId: normalizedRemoteUserId,
        ts: Date.now(),
      });
      log(`matrix: remembered invite candidate room=${roomId} sender=${normalizedRemoteUserId}`);
    },
    isDirectMessage: async (params: DirectMessageCheck): Promise<boolean> => {
      const { roomId, senderId } = params;
      const selfUserId = params.selfUserId ?? (await ensureSelfUserId());
      const joinedMembers = await resolveJoinedMembers(roomId);
      const strictDirectMembership = isStrictDirectMembership({
        selfUserId,
        remoteUserId: senderId,
        joinedMembers,
      });

      try {
        await refreshDmCache();
      } catch (err) {
        log(`matrix: dm cache refresh failed (${String(err)})`);
      }

      if (client.dms.isDm(roomId)) {
        if (strictDirectMembership) {
          log(`matrix: dm detected via m.direct room=${roomId}`);
          return true;
        }
        log(`matrix: ignoring stale m.direct classification room=${roomId}`);
      }

      if (strictDirectMembership) {
        const directViaSelf = await resolveDirectMemberFlag(roomId, selfUserId);
        if (directViaSelf === true) {
          log(`matrix: dm detected via member state room=${roomId}`);
          return true;
        }
        if (directViaSelf === false) {
          log(`matrix: dm rejected via member state room=${roomId}`);
          return false;
        }

        if (!hasSeededDmCache) {
          log(
            `matrix: dm detected via exact 2-member fallback before dm cache seed room=${roomId}`,
          );
          return true;
        }

        if (hasLocallyPromotedDirectRoom(roomId, senderId)) {
          const shouldKeep = await shouldKeepLocallyPromotedDirectRoom(roomId);
          if (shouldKeep !== false) {
            log(`matrix: dm detected via local promotion room=${roomId}`);
            return true;
          }
          locallyPromotedDirectRooms.delete(roomId);
          log(`matrix: local promotion cleared room=${roomId}`);
        }

        if (hasRecentInviteCandidate(roomId, senderId) && (await canPromoteRecentInvite(roomId))) {
          const promotion = await promoteMatrixDirectRoomCandidate({
            client,
            remoteUserId: senderId ?? "",
            roomId,
            selfUserId,
          });
          if (promotion.classifyAsDirect) {
            rememberLocallyPromotedDirectRoom(roomId, senderId ?? "");
            log(
              `matrix: dm detected via recent invite room=${roomId} reason=${promotion.reason} repaired=${String(promotion.repaired)}`,
            );
            return true;
          }
        }

        if (await canPromoteUnmappedStrictRoom(roomId)) {
          const promotion = await promoteMatrixDirectRoomCandidate({
            client,
            remoteUserId: senderId ?? "",
            roomId,
            selfUserId,
          });
          if (promotion.classifyAsDirect) {
            rememberLocallyPromotedDirectRoom(roomId, senderId ?? "");
            log(
              `matrix: dm detected via per-room strict fallback room=${roomId} reason=${promotion.reason} repaired=${String(promotion.repaired)}`,
            );
            return true;
          }
        }
      }

      log(
        `matrix: dm check room=${roomId} result=group members=${joinedMembers?.length ?? "unknown"}`,
      );
      return false;
    },
  };
}
