// Matrix plugin module implements test events behavior.
import type { MatrixRawEvent } from "./types.js";

type BundledReplacementEventOptions = {
  content?: Record<string, unknown>;
  replacementContent?: Record<string, unknown>;
  replacement?: Partial<MatrixRawEvent>;
  redacted?: boolean;
  stateKey?: string;
  objectBackedArrays?: boolean;
};

export function createBundledReplacementEvent(
  eventId: string,
  options: BundledReplacementEventOptions = {},
): MatrixRawEvent {
  const replacement: MatrixRawEvent = {
    event_id: "$edit",
    sender: "@alice:example.org",
    type: "m.room.message",
    origin_server_ts: 200,
    content: {
      msgtype: "m.text",
      body: "* edited text",
      "m.new_content": { msgtype: "m.text", body: "edited text" },
      "m.relates_to": options.objectBackedArrays
        ? Object.assign([], { rel_type: "m.replace", event_id: eventId })
        : { rel_type: "m.replace", event_id: eventId },
      ...options.replacementContent,
    },
    ...options.replacement,
  };

  return {
    event_id: eventId,
    sender: "@alice:example.org",
    type: "m.room.message",
    origin_server_ts: 100,
    content: options.content ?? { msgtype: "m.text", body: "original text" },
    ...(options.stateKey === undefined ? {} : { state_key: options.stateKey }),
    unsigned: {
      ...(options.redacted ? { redacted_because: { event_id: "$redaction" } } : {}),
      "m.relations": {
        "m.replace": options.objectBackedArrays ? Object.assign([], replacement) : replacement,
      },
    },
  };
}

export const bundledReplacementContentCases = [
  {
    name: "text",
    options: {},
    expected: "edited text",
  },
  {
    name: "legacy object-backed relation arrays",
    options: { objectBackedArrays: true },
    expected: "edited text",
  },
  {
    name: "media caption",
    options: {
      content: { msgtype: "m.image", body: "before.jpg", filename: "before.jpg" },
      replacementContent: {
        "m.new_content": {
          msgtype: "m.image",
          body: "edited caption",
          filename: "after.jpg",
        },
      },
    },
    expected: "edited caption\n\n[matrix image attachment]",
  },
] satisfies Array<{
  name: string;
  options: BundledReplacementEventOptions;
  expected: string;
}>;

export const invalidBundledReplacementCases = [
  {
    name: "another sender",
    options: { replacement: { sender: "@mallory:example.org" } },
  },
  {
    name: "another target",
    options: {
      replacementContent: {
        "m.relates_to": { rel_type: "m.replace", event_id: "$different" },
      },
    },
  },
  {
    name: "another event type",
    options: { replacement: { type: "m.room.notice" } },
  },
  {
    name: "a state-event original",
    options: { stateKey: "" },
  },
  {
    name: "a state-event replacement",
    options: { replacement: { state_key: "" } },
  },
  {
    name: "a malformed replacement relation",
    options: { replacementContent: { "m.relates_to": undefined } },
  },
  {
    name: "missing replacement content",
    options: { replacement: { content: {} } },
  },
  {
    name: "array replacement content",
    options: { replacementContent: { "m.new_content": [] } },
  },
  {
    name: "a redacted replacement",
    options: {
      replacement: { unsigned: { redacted_because: { event_id: "$redaction" } } },
    },
  },
  {
    name: "an object-backed redacted replacement",
    options: {
      replacement: {
        unsigned: Object.assign([], { redacted_because: { event_id: "$redaction" } }),
      },
    },
  },
] satisfies Array<{ name: string; options: BundledReplacementEventOptions }>;

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
