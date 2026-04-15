import { withResolvedRoomAction } from "./client.js";
import { fetchEventSummary, readPinnedEvents } from "./summary.js";
import {
  EventType,
  type MatrixActionClientOpts,
  type MatrixMessageSummary,
  type RoomPinnedEventsEventContent,
} from "./types.js";

async function updateMatrixPins(
  roomId: string,
  messageId: string,
  opts: MatrixActionClientOpts,
  update: (current: string[]) => string[],
): Promise<{ pinned: string[] }> {
  return await withResolvedRoomAction(roomId, opts, async (client, resolvedRoom) => {
    const current = await readPinnedEvents(client, resolvedRoom);
    const next = update(current);
    const payload: RoomPinnedEventsEventContent = { pinned: next };
    await client.sendStateEvent(resolvedRoom, EventType.RoomPinnedEvents, "", payload);
    return { pinned: next };
  });
}

export async function pinMatrixMessage(
  roomId: string,
  messageId: string,
  opts: MatrixActionClientOpts = {},
): Promise<{ pinned: string[] }> {
  return await updateMatrixPins(roomId, messageId, opts, (current) =>
    current.includes(messageId) ? current : [...current, messageId],
  );
}

export async function unpinMatrixMessage(
  roomId: string,
  messageId: string,
  opts: MatrixActionClientOpts = {},
): Promise<{ pinned: string[] }> {
  return await updateMatrixPins(roomId, messageId, opts, (current) =>
    current.filter((id) => id !== messageId),
  );
}

export async function listMatrixPins(
  roomId: string,
  opts: MatrixActionClientOpts = {},
): Promise<{ pinned: string[]; events: MatrixMessageSummary[] }> {
  return await withResolvedRoomAction(roomId, opts, async (client, resolvedRoom) => {
    const pinned = await readPinnedEvents(client, resolvedRoom);
    const events = (
      await Promise.all(
        pinned.map(async (eventId) => {
          try {
            return await fetchEventSummary(client, resolvedRoom, eventId);
          } catch {
            return null;
          }
        }),
      )
    ).filter((event): event is MatrixMessageSummary => Boolean(event));
    return { pinned, events };
  });
}
