export type HistoryEntry = {
  sender: string;
  body: string;
  timestamp?: number;
  messageId?: string;
  media?: HistoryMediaEntry[];
};

export type HistoryMediaEntry = {
  path?: string;
  url?: string;
  contentType?: string;
  kind?: "image" | "video" | "audio" | "document" | "unknown";
  messageId?: string;
};
