import { resolveMatrixRoomId } from "../send.js";
import { withResolvedActionClient, withResolvedRoomAction } from "./client.js";
import { EventType, type MatrixActionClientOpts } from "./types.js";

export async function getMatrixMemberInfo(
  userId: string,
  opts: MatrixActionClientOpts & { roomId?: string } = {},
) {
  return await withResolvedActionClient(opts, async (client) => {
    const roomId = opts.roomId ? await resolveMatrixRoomId(client, opts.roomId) : undefined;
    const profile = await client.getUserProfile(userId);
    // Membership and power levels are not included in profile calls; fetch state separately if needed.
    return {
      userId,
      profile: {
        displayName: profile?.displayname ?? null,
        avatarUrl: profile?.avatar_url ?? null,
      },
      membership: null, // Would need separate room state query
      powerLevel: null, // Would need separate power levels state query
      displayName: profile?.displayname ?? null,
      roomId: roomId ?? null,
    };
  });
}

export async function getMatrixRoomInfo(roomId: string, opts: MatrixActionClientOpts = {}) {
  return await withResolvedRoomAction(roomId, opts, async (client, resolvedRoom) => {
    let name: string | null = null;
    let topic: string | null = null;
    let canonicalAlias: string | null = null;
    let memberCount: number | null = null;

    try {
      const nameState = await client.getRoomStateEvent(resolvedRoom, "m.room.name", "");
      name = typeof nameState?.name === "string" ? nameState.name : null;
    } catch {
      // ignore
    }

    try {
      const topicState = await client.getRoomStateEvent(resolvedRoom, EventType.RoomTopic, "");
      topic = typeof topicState?.topic === "string" ? topicState.topic : null;
    } catch {
      // ignore
    }

    try {
      const aliasState = await client.getRoomStateEvent(resolvedRoom, "m.room.canonical_alias", "");
      canonicalAlias = typeof aliasState?.alias === "string" ? aliasState.alias : null;
    } catch {
      // ignore
    }

    try {
      const members = await client.getJoinedRoomMembers(resolvedRoom);
      memberCount = members.length;
    } catch {
      // ignore
    }

    return {
      roomId: resolvedRoom,
      name,
      topic,
      canonicalAlias,
      altAliases: [], // Would need separate query
      memberCount,
    };
  });
}
