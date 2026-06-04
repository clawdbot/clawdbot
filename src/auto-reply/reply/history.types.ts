/** Normalized history message used when building reply context. */
export type HistoryEntry = {
  sender: string;
  body: string;
  timestamp?: number;
  messageId?: string;
  media?: HistoryMediaEntry[];
};

/** Media metadata attached to a normalized history message. */
export type HistoryMediaEntry = {
  path?: string;
  url?: string;
  contentType?: string;
  kind?: "image" | "video" | "audio" | "document" | "unknown";
  messageId?: string;
};
