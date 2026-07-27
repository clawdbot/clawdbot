import type { MediaFact } from "../../media/media-facts.js";

/** Normalized history message used when building reply context. */
export type HistoryEntry = {
  sender: string;
  body: string;
  timestamp?: number;
  messageId?: string;
  media?: HistoryMediaEntry[];
};

/** Media metadata attached to a normalized history message. */
export type HistoryMediaEntry = Pick<
  MediaFact,
  "contentType" | "kind" | "messageId" | "path" | "url"
>;
