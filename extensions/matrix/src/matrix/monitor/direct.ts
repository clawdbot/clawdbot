import type {
  AccountDataEvents,
  MatrixClient,
  MatrixEvent,
  Room,
  RoomMember,
} from "matrix-js-sdk";
import { ClientEvent, EventType } from "matrix-js-sdk";

function hasDirectFlag(member?: RoomMember | null): boolean {
  if (!member?.events.member) return false;
  const content = member.events.member.getContent() as { is_direct?: boolean } | undefined;
  if (content?.is_direct === true) return true;
  const prev = member.events.member.getPrevContent() as { is_direct?: boolean } | undefined;
  return prev?.is_direct === true;
}

export function isLikelyDirectRoom(params: {
  room: Room;
  senderId: string;
  selfId?: string | null;
}): boolean {
  if (!params.selfId) return false;
  const memberCount = params.room.getJoinedMemberCount?.();
  if (typeof memberCount !== "number" || memberCount !== 2) return false;
  return true;
}

export function isDirectRoomByFlag(params: {
  room: Room;
  senderId: string;
  selfId?: string | null;
}): boolean {
  if (!params.selfId) return false;
  const selfMember = params.room.getMember(params.selfId);
  const senderMember = params.room.getMember(params.senderId);
  if (hasDirectFlag(selfMember) || hasDirectFlag(senderMember)) return true;
  const inviter = selfMember?.getDMInviter() ?? senderMember?.getDMInviter();
  return Boolean(inviter);
}

type MatrixDirectAccountData = AccountDataEvents[EventType.Direct];

export function createDirectRoomTracker(client: MatrixClient) {
  const directMap = new Map<string, Set<string>>();

  const updateDirectMap = (content: MatrixDirectAccountData) => {
    directMap.clear();
    for (const [userId, rooms] of Object.entries(content)) {
      if (!Array.isArray(rooms)) continue;
      const ids = rooms.map((roomId) => String(roomId).trim()).filter(Boolean);
      if (ids.length === 0) continue;
      directMap.set(userId, new Set(ids));
    }
  };

  const initialDirect = client.getAccountData(EventType.Direct);
  if (initialDirect) {
    updateDirectMap(initialDirect.getContent<MatrixDirectAccountData>() ?? {});
  }

  client.on(ClientEvent.AccountData, (event: MatrixEvent) => {
    if (event.getType() !== EventType.Direct) return;
    updateDirectMap(event.getContent<MatrixDirectAccountData>() ?? {});
  });

  return {
    isDirectMessage: (room: Room, senderId: string) => {
      const roomId = room.roomId;
      const directRooms = directMap.get(senderId);
      const selfId = client.getUserId();
      const isDirectByFlag = isDirectRoomByFlag({ room, senderId, selfId });
      return (
        Boolean(directRooms?.has(roomId)) ||
        isDirectByFlag ||
        isLikelyDirectRoom({ room, senderId, selfId })
      );
    },
  };
}
