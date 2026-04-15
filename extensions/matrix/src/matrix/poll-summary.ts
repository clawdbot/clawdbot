import type { MatrixMessageSummary } from "./actions/types.js";
import {
  buildPollResultsSummary,
  formatPollAsText,
  formatPollResultsAsText,
  isPollEventType,
  isPollStartType,
  parsePollStartContent,
  resolvePollReferenceEventId,
  type PollStartContent,
} from "./poll-types.js";
import type { MatrixClient, MatrixRawEvent } from "./sdk.js";

export type MatrixPollSnapshot = {
  pollEventId: string;
  triggerEvent: MatrixRawEvent;
  rootEvent: MatrixRawEvent;
  text: string;
};

export function resolveMatrixPollRootEventId(
  event: Pick<MatrixRawEvent, "event_id" | "type" | "content">,
): string | null {
  if (isPollStartType(event.type)) {
    const eventId = event.event_id?.trim();
    return eventId ? eventId : null;
  }
  return resolvePollReferenceEventId(event.content);
}

async function readAllPollRelations(
  client: MatrixClient,
  roomId: string,
  pollEventId: string,
): Promise<MatrixRawEvent[]> {
  const relationEvents: MatrixRawEvent[] = [];
  let nextBatch: string | undefined;
  do {
    const page = await client.getRelations(roomId, pollEventId, "m.reference", undefined, {
      from: nextBatch,
    });
    relationEvents.push(...page.events);
    nextBatch = page.nextBatch ?? undefined;
  } while (nextBatch);
  return relationEvents;
}

export async function fetchMatrixPollSnapshot(
  client: MatrixClient,
  roomId: string,
  event: MatrixRawEvent,
): Promise<MatrixPollSnapshot | null> {
  if (!isPollEventType(event.type)) {
    return null;
  }

  const pollEventId = resolveMatrixPollRootEventId(event);
  if (!pollEventId) {
    return null;
  }

  const rootEvent = isPollStartType(event.type)
    ? event
    : ((await client.getEvent(roomId, pollEventId)) as MatrixRawEvent);
  if (!isPollStartType(rootEvent.type)) {
    return null;
  }

  const pollStartContent = rootEvent.content as PollStartContent;
  const pollSummary = parsePollStartContent(pollStartContent);
  if (!pollSummary) {
    return null;
  }

  const relationEvents = await readAllPollRelations(client, roomId, pollEventId);
  const pollResults = buildPollResultsSummary({
    pollEventId,
    roomId,
    sender: rootEvent.sender,
    senderName: rootEvent.sender,
    content: pollStartContent,
    relationEvents,
  });

  return {
    pollEventId,
    triggerEvent: event,
    rootEvent,
    text: pollResults ? formatPollResultsAsText(pollResults) : formatPollAsText(pollSummary),
  };
}

export async function fetchMatrixPollMessageSummary(
  client: MatrixClient,
  roomId: string,
  event: MatrixRawEvent,
): Promise<MatrixMessageSummary | null> {
  const snapshot = await fetchMatrixPollSnapshot(client, roomId, event);
  if (!snapshot) {
    return null;
  }

  return {
    eventId: snapshot.pollEventId,
    sender: snapshot.rootEvent.sender,
    body: snapshot.text,
    msgtype: "m.text",
    timestamp: snapshot.triggerEvent.origin_server_ts || snapshot.rootEvent.origin_server_ts,
  };
}
