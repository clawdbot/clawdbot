// Text chunking helpers split long outbound text while preserving readable line boundaries.
import { chunkTextByBreakResolver } from "../shared/text-chunking.js";

/**
 * Splits outbound channel text into chunks no longer than the requested limit.
 * Newline boundaries win over spaces; text without usable separators falls back
 * to a hard character split so channel senders always receive bounded strings.
 */
export function chunkTextForOutbound(text: string, limit: number): string[] {
  return chunkTextByBreakResolver(text, limit, (window) => {
    const lastNewline = window.lastIndexOf("\n");
    const lastSpace = window.lastIndexOf(" ");
    return lastNewline > 0 ? lastNewline : lastSpace;
  });
}

/** Markdown IR parsing and slicing primitives for plugin-owned renderers. */
export {
  chunkMarkdownIR,
  markdownToIR,
  markdownToIRWithMeta,
  sliceMarkdownIR,
  type MarkdownIR,
  type MarkdownLinkSpan,
  type MarkdownParseOptions,
  type MarkdownStyle,
  type MarkdownStyleSpan,
  type MarkdownTableMeta,
} from "../../packages/markdown-core/src/ir.js";
/** Render-size-aware Markdown chunking for channel payload limits. */
export {
  renderMarkdownIRChunksWithinLimit,
  type RenderMarkdownIRChunksWithinLimitOptions,
} from "../../packages/markdown-core/src/render-aware-chunking.js";
/** Marker-based Markdown rendering hooks for channel-specific formatting. */
export {
  renderMarkdownWithMarkers,
  type RenderLink,
  type RenderOptions,
  type RenderStyleMap,
  type RenderStyleMarker,
} from "../../packages/markdown-core/src/render.js";
/** Markdown table conversion helper shared by text-only channel renderers. */
export { convertMarkdownTables } from "../../packages/markdown-core/src/tables.js";
/** Assistant-visible text sanitizers for removing internal scaffolding before delivery. */
export {
  sanitizeAssistantVisibleText,
  sanitizeAssistantVisibleTextWithOptions,
  sanitizeAssistantVisibleTextWithProfile,
  stripAssistantInternalScaffolding,
  stripToolCallXmlTags,
  type AssistantVisibleTextSanitizerProfile,
} from "../shared/text/assistant-visible-text.js";
/** File-reference detection helpers for avoiding accidental autolinks. */
export {
  FILE_REF_EXTENSIONS_WITH_TLD,
  isAutoLinkedFileRef,
} from "../shared/text/auto-linked-file-ref.js";
/** Code-region helpers for markdown-aware text transformations. */
export { findCodeRegions, isInsideCode, type CodeRegion } from "../shared/text/code-regions.js";
/** Reasoning-tag stripping helpers for public channel output. */
export {
  stripReasoningTagsFromText,
  type ReasoningTagMode,
  type ReasoningTagTrim,
} from "../shared/text/reasoning-tags.js";
/** Plain-text markdown stripper for transports without markdown support. */
export { stripMarkdown } from "../shared/text/strip-markdown.js";
/** Terminal-safe text sanitizer for CLI-facing plugin output. */
export { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
/** System-message marker helpers for preserving generated status lines. */
export { SYSTEM_MARK, hasSystemMark, prefixSystemMessage } from "../infra/system-message.ts";
/** Inline directive stripping helpers for display and delivery boundaries. */
export {
  stripInlineDirectiveTagsForDelivery,
  stripInlineDirectiveTagsForDisplay,
  stripInlineDirectiveTagsFromMessageForDisplay,
  type DisplayMessageWithContent,
  type InlineDirectiveParseResult,
} from "../utils/directive-tags.js";
/** Generic item chunker for plugin payload planning. */
export { chunkItems } from "../utils/chunk-items.js";
