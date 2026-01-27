import type { MatrixClient } from "@vector-im/matrix-bot-sdk";

import {
  EventType,
  type MatrixMessageSummary,
  type MatrixRawEvent,
  type RoomMessageEventContent,
  type RoomPinnedEventsEventContent,
} from "./types.js";

export function summarizeMatrixRawEvent(event: MatrixRawEvent): MatrixMessageSummary {
  const content = event.content as RoomMessageEventContent;
  const relates = content["m.relates_to"];
  let relType: string | undefined;
  let eventId: string | undefined;
  if (relates) {
    if ("rel_type" in relates) {
      relType = relates.rel_type;
      eventId = relates.event_id;
    } else if ("m.in_reply_to" in relates) {
      eventId = relates["m.in_reply_to"]?.event_id;
    }
  }
  const relatesTo =
    relType || eventId
      ? {
          relType,
          eventId,
        }
      : undefined;
  return {
    eventId: event.event_id,
    sender: event.sender,
    body: content.body,
    msgtype: content.msgtype,
    timestamp: event.origin_server_ts,
    relatesTo,
  };
}

export async function readPinnedEvents(
  client: MatrixClient,
  roomId: string,
): Promise<string[]> {
  try {
    const content = (await client.getRoomStateEvent(
      roomId,
      EventType.RoomPinnedEvents,
      "",
    )) as RoomPinnedEventsEventContent;
    const pinned = content.pinned;
    return pinned.filter((id) => id.trim().length > 0);
  } catch (err: unknown) {
    const errObj = err as { statusCode?: number; body?: { errcode?: string } };
    const httpStatus = errObj.statusCode;
    const errcode = errObj.body?.errcode;
    if (httpStatus === 404 || errcode === "M_NOT_FOUND") {
      return [];
    }
    throw err;
  }
}

export async function fetchEventSummary(
  client: MatrixClient,
  roomId: string,
  eventId: string,
): Promise<MatrixMessageSummary | null> {
  try {
    const raw = (await client.getEvent(roomId, eventId)) as MatrixRawEvent;
    if (raw.unsigned?.redacted_because) return null;
    return summarizeMatrixRawEvent(raw);
  } catch {
    // Event not found, redacted, or inaccessible - return null
    return null;
  }
}
