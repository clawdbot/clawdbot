import type { MatrixClient } from "@vector-im/matrix-bot-sdk";

export const MsgType = {
  Text: "m.text",
} as const;

export const RelationType = {
  Replace: "m.replace",
  Annotation: "m.annotation",
} as const;

export const EventType = {
  RoomMessage: "m.room.message",
  RoomPinnedEvents: "m.room.pinned_events",
  RoomTopic: "m.room.topic",
  Reaction: "m.reaction",
} as const;

export type RoomMessageEventContent = {
  msgtype: string;
  body: string;
  "m.new_content"?: RoomMessageEventContent;
  "m.relates_to"?: {
    rel_type?: string;
    event_id?: string;
    "m.in_reply_to"?: { event_id?: string };
  };
};

export type ReactionEventContent = {
  "m.relates_to": {
    rel_type: string;
    event_id: string;
    key: string;
  };
};

export type RoomPinnedEventsEventContent = {
  pinned: string[];
};

export type RoomTopicEventContent = {
  topic?: string;
};

export type MatrixRawEvent = {
  event_id: string;
  sender: string;
  type: string;
  origin_server_ts: number;
  content: Record<string, unknown>;
  unsigned?: {
    redacted_because?: unknown;
  };
};

export type MatrixActionClientOpts = {
  client?: MatrixClient;
  timeoutMs?: number;
};

export type MatrixMessageSummary = {
  eventId?: string;
  sender?: string;
  body?: string;
  msgtype?: string;
  timestamp?: number;
  relatesTo?: {
    relType?: string;
    eventId?: string;
    key?: string;
  };
};

export type MatrixReactionSummary = {
  key: string;
  count: number;
  users: string[];
};

export type MatrixActionClient = {
  client: MatrixClient;
  stopOnDone: boolean;
};
