/**
 * Shared display and chunking types for embedded-agent subscription handlers.
 */
import type { BlockReplyChunking } from "./embedded-agent-block-chunker.js";

/** Rendering mode for completed tool results in subscribed replies. */
export type ToolResultFormat = "markdown" | "plain";
/** Detail level for in-flight tool progress messages. */
export type ToolProgressDetailMode = "explain" | "raw";

export type { BlockReplyChunking };
