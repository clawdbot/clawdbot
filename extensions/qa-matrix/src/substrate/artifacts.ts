import type { MatrixQaObservedEvent } from "./events.js";

export function buildMatrixQaObservedEventsArtifact(params: {
  includeContent: boolean;
  observedEvents: MatrixQaObservedEvent[];
}) {
  return params.observedEvents.map((event) =>
    params.includeContent
      ? event
      : {
          kind: event.kind,
          roomId: event.roomId,
          eventId: event.eventId,
          sender: event.sender,
          stateKey: event.stateKey,
          type: event.type,
          originServerTs: event.originServerTs,
          msgtype: event.msgtype,
          membership: event.membership,
          relatesTo: event.relatesTo,
          mentions: event.mentions,
          reaction: event.reaction,
        },
  );
}
