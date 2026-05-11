import { chunkTextByBreakResolver } from "../shared/text-chunking.js";

/** Chunk outbound text while preferring newline boundaries over spaces. */
export function chunkTextForOutbound(text: string, limit: number): string[] {
  return chunkTextByBreakResolver(text, limit, (window) => {
    const lastNewline = window.lastIndexOf("\n");
    const lastSpace = window.lastIndexOf(" ");
    return lastNewline > 0 ? lastNewline : lastSpace;
  });
}

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
} from "../markdown/ir.js";
export {
  renderMarkdownIRChunksWithinLimit,
  type RenderMarkdownIRChunksWithinLimitOptions,
} from "../markdown/render-aware-chunking.js";
export {
  renderMarkdownWithMarkers,
  type RenderLink,
  type RenderOptions,
  type RenderStyleMap,
  type RenderStyleMarker,
} from "../markdown/render.js";
export { convertMarkdownTables } from "../markdown/tables.js";
export {
  sanitizeAssistantVisibleText,
  sanitizeAssistantVisibleTextWithOptions,
  sanitizeAssistantVisibleTextWithProfile,
  stripAssistantInternalScaffolding,
  stripToolCallXmlTags,
  type AssistantVisibleTextSanitizerProfile,
} from "../shared/text/assistant-visible-text.js";
export {
  FILE_REF_EXTENSIONS_WITH_TLD,
  isAutoLinkedFileRef,
} from "../shared/text/auto-linked-file-ref.js";
export { findCodeRegions, isInsideCode, type CodeRegion } from "../shared/text/code-regions.js";
export {
  stripReasoningTagsFromText,
  type ReasoningTagMode,
  type ReasoningTagTrim,
} from "../shared/text/reasoning-tags.js";
export { stripMarkdown } from "../shared/text/strip-markdown.js";
export { sanitizeTerminalText } from "../terminal/safe-text.js";
export { SYSTEM_MARK, hasSystemMark, prefixSystemMessage } from "../infra/system-message.ts";
export {
  stripInlineDirectiveTagsForDelivery,
  stripInlineDirectiveTagsForDisplay,
  stripInlineDirectiveTagsFromMessageForDisplay,
  type DisplayMessageWithContent,
  type InlineDirectiveParseResult,
} from "../utils/directive-tags.js";
export { chunkItems } from "../utils/chunk-items.js";
