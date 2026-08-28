import { EventEmitter } from "node:events";
import {
  ClientEvent,
  type MatrixClient as MatrixJsClient,
  type MatrixEvent,
} from "matrix-js-sdk/lib/matrix.js";
import { RoomEvent, type Room } from "matrix-js-sdk/lib/models/room.js";
import type { MatrixSyncState } from "../sync-state.js";
import type { MatrixDecryptBridge } from "./decrypt-bridge.js";
import { matrixEventToRaw } from "./event-helpers.js";
import type { MatrixRawEvent } from "./types.js";

export function registerMatrixClientBridge(params: {
  client: MatrixJsClient;
  decryptBridge: MatrixDecryptBridge<MatrixRawEvent>;
  emitter: EventEmitter;
  emitMembershipForRoom: (room: Room) => void;
  getSelfUserId: () => string;
  setCurrentSyncState: (state: MatrixSyncState, error?: unknown) => void;
}): void {
  let initialSyncComplete = false;
  const joinTransitions = new WeakSet<MatrixEvent>();
  params.client.on(RoomEvent.MyMembership, (room, membership, previousMembership) => {
    // The SDK records transitions before raw events. Missing prev_content alone
    // cannot distinguish a new join from state replay or a profile update.
    if (!initialSyncComplete || membership !== "join" || previousMembership === "join") {
      return;
    }
    const event = room.currentState.getStateEvents("m.room.member", params.getSelfUserId());
    if (event) {
      joinTransitions.add(event);
    }
  });
  params.client.on(ClientEvent.Event, (event: MatrixEvent) => {
    const roomId = event.getRoomId();
    if (!roomId) {
      return;
    }

    const raw = matrixEventToRaw(event, { contentMode: "original" });
    const isEncryptedEvent = raw.type === "m.room.encrypted";
    params.emitter.emit("room.event", roomId, raw);
    if (isEncryptedEvent) {
      params.emitter.emit("room.encrypted_event", roomId, raw);
    } else if (params.decryptBridge.shouldEmitUnencryptedMessage(roomId, raw.event_id)) {
      params.emitter.emit("room.message", roomId, raw);
    }

    const stateKey = raw.state_key ?? "";
    const selfUserId = params.getSelfUserId();
    const membership =
      raw.type === "m.room.member"
        ? (raw.content as { membership?: string }).membership
        : undefined;
    if (stateKey && selfUserId && stateKey === selfUserId) {
      if (membership === "invite") {
        params.emitter.emit("room.invite", roomId, raw);
      } else if (membership === "join") {
        params.emitter.emit("room.join", roomId, {
          ...raw,
          membershipProvenance: joinTransitions.delete(event)
            ? "transition"
            : initialSyncComplete
              ? "update"
              : "snapshot",
        } satisfies MatrixRawEvent);
      }
    }

    if (isEncryptedEvent) {
      params.decryptBridge.attachEncryptedEvent(event, roomId);
    }
  });

  // Some SDK invite transitions are surfaced as room lifecycle events instead of raw timeline events.
  params.client.on(ClientEvent.Room, params.emitMembershipForRoom);
  params.client.on(
    ClientEvent.Sync,
    (state: MatrixSyncState, prevState: string | null, data?: unknown) => {
      // CATCHUP can precede the first successful sync after startup connection errors.
      initialSyncComplete ||= state === "PREPARED" || state === "SYNCING";
      const error =
        data && typeof data === "object" && "error" in data
          ? (data as { error?: unknown }).error
          : undefined;
      params.setCurrentSyncState(state, error);
      params.emitter.emit("sync.state", state, prevState, error);
    },
  );
  params.client.on(ClientEvent.SyncUnexpectedError, (error: Error) => {
    params.emitter.emit("sync.unexpected_error", error);
  });
}

export function emitMatrixMembershipForRoom(params: {
  client: MatrixJsClient;
  emitter: EventEmitter;
  room: Room;
  selfUserId: string;
}): void {
  const roomId = params.room.roomId.trim();
  if (!roomId || !params.selfUserId) {
    return;
  }
  const membership = params.room.getMyMembership();
  const raw: MatrixRawEvent = {
    event_id: `$membership-${roomId}-${Date.now()}`,
    type: "m.room.member",
    sender: params.selfUserId,
    state_key: params.selfUserId,
    content: { membership },
    origin_server_ts: Date.now(),
    unsigned: { age: 0 },
    membershipProvenance: "snapshot",
  };
  if (membership === "invite") {
    params.emitter.emit("room.invite", roomId, raw);
    return;
  }
  if (membership === "join") {
    params.emitter.emit("room.join", roomId, raw);
  }
}

export function refreshMatrixDmRoomIds(
  direct: Record<string, unknown> | undefined,
  dmRoomIds: Set<string>,
): boolean {
  dmRoomIds.clear();
  if (!direct || typeof direct !== "object") {
    return false;
  }
  for (const value of Object.values(direct)) {
    if (!Array.isArray(value)) {
      continue;
    }
    for (const roomId of value) {
      if (typeof roomId === "string" && roomId.trim()) {
        dmRoomIds.add(roomId);
      }
    }
  }
  return true;
}
