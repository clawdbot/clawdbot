// Matrix plugin module implements direct room behavior.
import { normalizeNullableString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { MatrixClient } from "./sdk.js";

function normalizeJoinedMatrixMembers(joinedMembers: unknown): string[] {
  if (!Array.isArray(joinedMembers)) {
    return [];
  }
  return joinedMembers
    .map((entry) => normalizeNullableString(entry))
    .filter((entry): entry is string => Boolean(entry));
}

export function isStrictDirectMembership(params: {
  selfUserId?: string | null;
  remoteUserId?: string | null;
  joinedMembers?: readonly string[] | null;
}): boolean {
  const selfUserId = normalizeNullableString(params.selfUserId);
  const remoteUserId = normalizeNullableString(params.remoteUserId);
  const joinedMembers = params.joinedMembers ?? [];
  return Boolean(
    selfUserId &&
    remoteUserId &&
    joinedMembers.length === 2 &&
    joinedMembers.includes(selfUserId) &&
    joinedMembers.includes(remoteUserId),
  );
}

export async function readJoinedMatrixMembers(
  client: MatrixClient,
  roomId: string,
): Promise<string[] | null> {
  try {
    return normalizeJoinedMatrixMembers(await client.getJoinedRoomMembers(roomId));
  } catch {
    return null;
  }
}

export async function hasDirectMatrixMemberFlag(
  client: MatrixClient,
  roomId: string,
  userId?: string | null,
): Promise<boolean | null> {
  const normalizedUserId = normalizeNullableString(userId);
  if (!normalizedUserId) {
    return null;
  }
  try {
    const state = await client.getRoomStateEvent(roomId, "m.room.member", normalizedUserId);
    // Return true if is_direct is explicitly true, false if explicitly false, null if absent
    if (state?.is_direct === true) {
      return true;
    }
    if (state?.is_direct === false) {
      return false;
    }
    // is_direct field is absent from the membership event
    return null;
  } catch {
    // API/network error - treat as unavailable
    return null;
  }
}

type MatrixDirectRoomEvidence = {
  joinedMembers: string[] | null;
  strict: boolean;
  viaMemberState: boolean;
  memberStateFlag: boolean | null;
};

export async function inspectMatrixDirectRoomEvidence(params: {
  client: MatrixClient;
  roomId: string;
  remoteUserId: string;
  selfUserId?: string | null;
}): Promise<MatrixDirectRoomEvidence> {
  const selfUserId =
    params.selfUserId !== undefined
      ? normalizeNullableString(params.selfUserId)
      : normalizeNullableString(await params.client.getUserId().catch(() => null));
  const joinedMembers = await readJoinedMatrixMembers(params.client, params.roomId);
  const strict = isStrictDirectMembership({
    selfUserId,
    remoteUserId: params.remoteUserId,
    joinedMembers,
  });
  if (!strict) {
    return {
      joinedMembers,
      strict: false,
      viaMemberState: false,
      memberStateFlag: null,
    };
  }
  const memberStateFlag = await hasDirectMatrixMemberFlag(params.client, params.roomId, selfUserId);
  return {
    joinedMembers,
    strict,
    viaMemberState: memberStateFlag === true,
    memberStateFlag,
  };
}

export async function isStrictDirectRoom(params: {
  client: MatrixClient;
  roomId: string;
  remoteUserId: string;
  selfUserId?: string | null;
}): Promise<boolean> {
  return (
    await inspectMatrixDirectRoomEvidence({
      client: params.client,
      roomId: params.roomId,
      remoteUserId: params.remoteUserId,
      selfUserId: params.selfUserId,
    })
  ).strict;
}
