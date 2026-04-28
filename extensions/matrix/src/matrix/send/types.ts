import type { CoreConfig } from "../../types.js";
import {
  MATRIX_ANNOTATION_RELATION_TYPE,
  MATRIX_REACTION_EVENT_TYPE,
  type MatrixReactionEventContent,
} from "../reaction-common.js";
import type {
  DimensionalFileInfo,
  EncryptedFile,
  FileWithThumbnailInfo,
  MessageEventContent,
  TextualMessageEventContent,
  TimedFileInfo,
  VideoFileInfo,
} from "../sdk.js";

// Message types
export const MsgType = {
  Text: "m.text",
  Image: "m.image",
  Audio: "m.audio",
  Video: "m.video",
  File: "m.file",
  Notice: "m.notice",
} as const;

// Relation types
export const RelationType = {
  Annotation: MATRIX_ANNOTATION_RELATION_TYPE,
  Replace: "m.replace",
  Thread: "m.thread",
} as const;

// Event types
export const EventType = {
  Direct: "m.direct",
  Reaction: MATRIX_REACTION_EVENT_TYPE,
  RoomMessage: "m.room.message",
} as const;

export const MATRIX_OPENCLAW_FINALIZED_PREVIEW_KEY = "com.openclaw.finalized_preview" as const;

export type MatrixDirectAccountData = Record<string, string[]>;

export type MatrixReplyRelation = {
  "m.in_reply_to": { event_id: string };
};

export type MatrixThreadRelation = {
  rel_type: typeof RelationType.Thread;
  event_id: string;
  is_falling_back?: boolean;
  "m.in_reply_to"?: { event_id: string };
};

export type MatrixRelation = MatrixReplyRelation | MatrixThreadRelation;

export type MatrixReplyMeta = {
  "m.relates_to"?: MatrixRelation;
};

export type MatrixMediaInfo =
  | FileWithThumbnailInfo
  | DimensionalFileInfo
  | TimedFileInfo
  | VideoFileInfo;

export type MatrixTextContent = TextualMessageEventContent & MatrixReplyMeta;

export type MatrixMediaContent = MessageEventContent &
  MatrixReplyMeta & {
    info?: MatrixMediaInfo;
    url?: string;
    file?: EncryptedFile;
    filename?: string;
    "org.matrix.msc3245.voice"?: Record<string, never>;
    "org.matrix.msc1767.audio"?: { duration: number };
  };

export type MatrixOutboundContent = MatrixTextContent | MatrixMediaContent;

export type ReactionEventContent = MatrixReactionEventContent;

export type MatrixSendResult = {
  messageId: string;
  roomId: string;
  primaryMessageId?: string;
  messageIds?: string[];
};

export type MatrixSendOpts = {
  cfg: CoreConfig;
  client?: import("../sdk.js").MatrixClient;
  mediaUrl?: string;
  mediaAccess?: {
    localRoots?: readonly string[];
    readFile?: (filePath: string) => Promise<Buffer>;
  };
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  accountId?: string;
  replyToId?: string;
  threadId?: string | number | null;
  timeoutMs?: number;
  /** Additional Matrix event content fields to merge into the first sent event. */
  extraContent?: MatrixExtraContentFields;
  /** Send audio as voice message instead of audio file. Defaults to false. */
  audioAsVoice?: boolean;
};

export type MatrixMediaMsgType =
  | typeof MsgType.Image
  | typeof MsgType.Audio
  | typeof MsgType.Video
  | typeof MsgType.File;

export type MatrixTextMsgType = typeof MsgType.Text | typeof MsgType.Notice;

export type MediaKind = "image" | "audio" | "video" | "document" | "unknown";

export type MatrixFormattedContent = MessageEventContent & {
  format?: string;
  formatted_body?: string;
};

export type MatrixExtraContentFields = Record<string, unknown>;

/**
 * MSC4357 live marker key.
 * When present on event content, signals that the message is still being
 * streamed (e.g. an LLM generating a response). Supporting clients render
 * the message with a streaming animation until an edit without this marker
 * arrives, indicating the stream is complete.
 * @see https://github.com/matrix-org/matrix-spec-proposals/pull/4357
 */
export const MSC4357_LIVE_KEY = "org.matrix.msc4357.live" as const;
