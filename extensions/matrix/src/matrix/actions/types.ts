import type { CoreConfig } from "../../types.js";
import {
  MATRIX_ANNOTATION_RELATION_TYPE,
  MATRIX_REACTION_EVENT_TYPE,
  type MatrixReactionEventContent,
} from "../reaction-common.js";
import type { MatrixClient, MessageEventContent } from "../sdk.js";
export type { MatrixRawEvent } from "../sdk.js";
export type { MatrixReactionSummary } from "../reaction-common.js";

export const MsgType = {
  Text: "m.text",
} as const;

export const RelationType = {
  Replace: "m.replace",
  Annotation: MATRIX_ANNOTATION_RELATION_TYPE,
} as const;

export const EventType = {
  RoomMessage: "m.room.message",
  RoomPinnedEvents: "m.room.pinned_events",
  RoomTopic: "m.room.topic",
  Reaction: MATRIX_REACTION_EVENT_TYPE,
} as const;

export type RoomMessageEventContent = MessageEventContent & {
  msgtype: string;
  body: string;
  "m.new_content"?: RoomMessageEventContent;
  "m.relates_to"?: {
    rel_type?: string;
    event_id?: string;
    "m.in_reply_to"?: { event_id?: string };
  };
};

export type ReactionEventContent = MatrixReactionEventContent;

export type RoomPinnedEventsEventContent = {
  pinned: string[];
};

export type RoomTopicEventContent = {
  topic?: string;
};

export type MatrixActionClientOpts = {
  client?: MatrixClient;
  cfg?: CoreConfig;
  mediaLocalRoots?: readonly string[];
  timeoutMs?: number;
  accountId?: string | null;
  readiness?: "none" | "prepared" | "started";
};

export type MatrixMessageSummary = {
  eventId?: string;
  sender?: string;
  body?: string;
  msgtype?: string;
  attachment?: MatrixMessageAttachmentSummary;
  timestamp?: number;
  relatesTo?: {
    relType?: string;
    eventId?: string;
    key?: string;
  };
};

export type MatrixMessageAttachmentKind = "audio" | "file" | "image" | "sticker" | "video";

export type MatrixMessageAttachmentSummary = {
  kind: MatrixMessageAttachmentKind;
  caption?: string;
  filename?: string;
};

export type MatrixActionClient = {
  client: MatrixClient;
  stopOnDone: boolean;
};
