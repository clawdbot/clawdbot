// Matrix plugin module implements summary behavior.
import { asNullableObjectRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { isMatrixNotFoundError } from "../errors.js";
import {
  resolveBundledMatrixReplacementContent,
  resolveMatrixMessageAttachment,
} from "../media-text.js";
import { fetchMatrixPollMessageSummary } from "../poll-summary.js";
import type { MatrixClient } from "../sdk.js";
import {
  EventType,
  type MatrixMessageSummary,
  type MatrixRawEvent,
  type RoomMessageEventContent,
  type RoomPinnedEventsEventContent,
} from "./types.js";

function parseMatrixRawEvent(value: unknown): MatrixRawEvent | null {
  const event = asNullableObjectRecord(value);
  const content = asNullableObjectRecord(event?.content);
  if (
    !event ||
    typeof event.event_id !== "string" ||
    typeof event.sender !== "string" ||
    typeof event.type !== "string" ||
    typeof event.origin_server_ts !== "number" ||
    !content
  ) {
    return null;
  }
  const unsigned = asNullableObjectRecord(event.unsigned);
  const relations = asNullableObjectRecord(unsigned?.["m.relations"]);
  return {
    event_id: event.event_id,
    sender: event.sender,
    type: event.type,
    origin_server_ts: event.origin_server_ts,
    content,
    ...(unsigned
      ? {
          unsigned: {
            ...(typeof unsigned.age === "number" ? { age: unsigned.age } : {}),
            ...(relations ? { "m.relations": relations } : {}),
            ...(unsigned.redacted_because !== undefined
              ? { redacted_because: unsigned.redacted_because }
              : {}),
          },
        }
      : {}),
    ...(typeof event.state_key === "string" ? { state_key: event.state_key } : {}),
  };
}

export function summarizeMatrixRawEvent(event: MatrixRawEvent): MatrixMessageSummary {
  const content = event.content as RoomMessageEventContent;
  const relates = content["m.relates_to"];
  const displayContent =
    relates?.rel_type === "m.replace"
      ? (content["m.new_content"] ?? content)
      : (resolveBundledMatrixReplacementContent(event) ?? content);
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
  const attachment = resolveMatrixMessageAttachment({
    body: displayContent.body,
    filename: displayContent.filename,
    msgtype: displayContent.msgtype,
  });
  return {
    eventId: event.event_id,
    sender: event.sender,
    body: attachment ? attachment.caption : displayContent.body?.trim() || undefined,
    msgtype: displayContent.msgtype,
    attachment,
    timestamp: event.origin_server_ts,
    relatesTo,
  };
}

export async function readPinnedEvents(client: MatrixClient, roomId: string): Promise<string[]> {
  try {
    const content = (await client.getRoomStateEvent(
      roomId,
      EventType.RoomPinnedEvents,
      "",
    )) as RoomPinnedEventsEventContent;
    const pinned = content.pinned;
    return pinned.filter((id) => id.trim().length > 0);
  } catch (err: unknown) {
    if (isMatrixNotFoundError(err)) {
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
    const raw = parseMatrixRawEvent(await client.getEvent(roomId, eventId));
    if (!raw) {
      return null;
    }
    if (raw.unsigned?.redacted_because) {
      return null;
    }
    const pollSummary = await fetchMatrixPollMessageSummary(client, roomId, raw);
    if (pollSummary) {
      return pollSummary;
    }
    return summarizeMatrixRawEvent(raw);
  } catch {
    // Event not found, redacted, or inaccessible - return null
    return null;
  }
}
