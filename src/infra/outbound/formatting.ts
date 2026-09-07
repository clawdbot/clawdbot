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
  /**
   * The text is already written in the target channel's own dialect and must
   * skip the markdown pass. `"slack-mrkdwn"`: Slack mrkdwn as authored (one
   * star for bold, `<url|label>` links). Adapters for other channels ignore a
   * hint that is not theirs.
   */
  preRendered?: "slack-mrkdwn";
};
