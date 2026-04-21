import type { MatrixRawEvent } from "./types.js";

export function createPollStartEvent(eventId: string): MatrixRawEvent {
  return {
    event_id: eventId,
    sender: "@alice:example.org",
    type: "m.poll.start",
    origin_server_ts: Date.now(),
    content: {
      "m.poll.start": {
        question: { "m.text": "Lunch?" },
        kind: "m.poll.disclosed",
        max_selections: 1,
        answers: [
          { id: "a1", "m.text": "Pizza" },
          { id: "a2", "m.text": "Sushi" },
        ],
      },
    },
  };
}
