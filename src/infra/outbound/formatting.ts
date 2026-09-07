// Formatting options carried through outbound planning control text chunking,
// table rendering, markdown handling, and parse mode.
import type { ChunkMode } from "../../auto-reply/chunk.js";
import type { MarkdownTableMode } from "../../config/types.js";

/**
 * Formatting and chunking hints carried through outbound delivery planning.
 */
export type OutboundDeliveryFormattingOptions = {
  textLimit?: number;
  maxLinesPerMessage?: number;
  tableMode?: MarkdownTableMode;
  chunkMode?: ChunkMode;
  parseMode?: "HTML";
};
