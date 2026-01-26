import type { EncryptedFile, MessageEventContent } from "matrix-bot-sdk";

export const EventType = {
  RoomMessage: "m.room.message",
  RoomMessageEncrypted: "m.room.encrypted",
  RoomMember: "m.room.member",
  Location: "m.location",
} as const;

export const RelationType = {
  Replace: "m.replace",
  Thread: "m.thread",
} as const;

export type MatrixRawEvent = {
  event_id: string;
  sender: string;
  type: string;
  origin_server_ts: number;
  content: Record<string, unknown>;
  unsigned?: {
    age?: number;
    redacted_because?: unknown;
  };
};

export type RoomMessageEventContent = MessageEventContent & {
  url?: string;
  file?: EncryptedFile;
  info?: {
    mimetype?: string;
    size?: number;
  };
  "m.relates_to"?: {
    rel_type?: string;
    event_id?: string;
    "m.in_reply_to"?: { event_id?: string };
  };
};
