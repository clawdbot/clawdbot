// Matrix plugin module implements summary behavior.
import { isMatrixNotFoundError } from "../errors.js";
import { resolveMatrixMessageAttachment, resolveMatrixMessageBody } from "../media-text.js";
import { fetchMatrixPollMessageSummary } from "../poll-summary.js";
import type { MatrixClient } from "../sdk.js";
import {
  EventType,
  type MatrixMessageSummary,
  type MatrixRawEvent,
  type RoomMessageEventContent,
  type RoomPinnedEventsEventContent,
} from "./types.js";

function resolveBundledMatrixReplacementContent(
  event: MatrixRawEvent,
): RoomMessageEventContent | undefined {
  const rawReplacement = event.unsigned?.["m.relations"]?.["m.replace"];
  if (!rawReplacement || typeof rawReplacement !== "object" || event.state_key !== undefined) {
    return undefined;
  }
  const replacement = rawReplacement as Partial<MatrixRawEvent>;
  const content = replacement.content;
  const relation = content?.["m.relates_to"];
  const newContent = content?.["m.new_content"];
  if (
    replacement.sender !== event.sender ||
    replacement.type !== event.type ||
    replacement.state_key !== undefined ||
    replacement.unsigned?.redacted_because ||
    !relation ||
    typeof relation !== "object" ||
    (relation as { rel_type?: unknown }).rel_type !== "m.replace" ||
    (relation as { event_id?: unknown }).event_id !== event.event_id ||
    !newContent ||
    typeof newContent !== "object" ||
    Array.isArray(newContent)
  ) {
    return undefined;
  }
  return newContent as RoomMessageEventContent;
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
  return {
    eventId: event.event_id,
    sender: event.sender,
    body: resolveMatrixMessageBody({
      body: displayContent.body,
      filename: displayContent.filename,
      msgtype: displayContent.msgtype,
    }),
    msgtype: displayContent.msgtype,
    attachment: resolveMatrixMessageAttachment({
      body: displayContent.body,
      filename: displayContent.filename,
      msgtype: displayContent.msgtype,
    }),
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
    const raw = (await client.getEvent(roomId, eventId)) as unknown as MatrixRawEvent;
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
