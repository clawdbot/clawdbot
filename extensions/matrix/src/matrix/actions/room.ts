import { EventType, type MatrixActionClientOpts } from "./types.js";
import { resolveActionClient } from "./client.js";
import { resolveMatrixRoomId } from "../send.js";

export async function getMatrixMemberInfo(
  userId: string,
  opts: MatrixActionClientOpts & { roomId?: string } = {},
) {
  const { client, stopOnDone } = await resolveActionClient(opts);
  try {
    const roomId = opts.roomId ? await resolveMatrixRoomId(client, opts.roomId) : undefined;
    // @vector-im/matrix-bot-sdk uses getUserProfile
    const profile = await client.getUserProfile(userId);
    // Note: @vector-im/matrix-bot-sdk doesn't have getRoom().getMember() like matrix-js-sdk
    // We'd need to fetch room state separately if needed
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
  } finally {
    if (stopOnDone) client.stop();
  }
}

export async function getMatrixRoomInfo(
  roomId: string,
  opts: MatrixActionClientOpts = {},
) {
  const { client, stopOnDone } = await resolveActionClient(opts);
  try {
    const resolvedRoom = await resolveMatrixRoomId(client, roomId);
    // @vector-im/matrix-bot-sdk uses getRoomState for state events
    let name: string | null = null;
    let topic: string | null = null;
    let canonicalAlias: string | null = null;
    let memberCount: number | null = null;

    try {
      const nameState = await client.getRoomStateEvent(resolvedRoom, "m.room.name", "");
      name = nameState?.name ?? null;
    } catch {
      // ignore
    }

    try {
      const topicState = await client.getRoomStateEvent(resolvedRoom, EventType.RoomTopic, "");
      topic = topicState?.topic ?? null;
    } catch {
      // ignore
    }

    try {
      const aliasState = await client.getRoomStateEvent(
        resolvedRoom,
        "m.room.canonical_alias",
        "",
      );
      canonicalAlias = aliasState?.alias ?? null;
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
  } finally {
    if (stopOnDone) client.stop();
  }
}
