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
