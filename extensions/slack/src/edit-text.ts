// Slack plugin module implements edit text behavior.
import type { Block, KnownBlock } from "@slack/web-api";
import { buildSlackCompleteBlocksFallbackText } from "./blocks-fallback.js";
import { SLACK_EDIT_TEXT_LIMIT } from "./limits.js";
import { appendSlackNativeDataPlainTextFallback } from "./native-data-blocks.js";
import { truncateSlackText } from "./truncate.js";

export function buildSlackEditTextPayload(
  content: string,
  blocks?: (Block | KnownBlock)[],
): string {
  const trimmedContent = content.trim();
  const blockText = blocks?.length ? buildSlackCompleteBlocksFallbackText(blocks).trim() : "";
  if (trimmedContent && !blockText) {
    return trimmedContent;
  }
  if (trimmedContent) {
    const nativePlainText = blocks?.length
      ? appendSlackNativeDataPlainTextFallback("", blocks).trim()
      : "";
    const contentContainsBlockText =
      Boolean(blockText && trimmedContent.includes(blockText)) ||
      Boolean(nativePlainText && trimmedContent.includes(nativePlainText));
    const fallbackText = contentContainsBlockText
      ? trimmedContent
      : blockText && !blockText.includes(trimmedContent)
        ? `${trimmedContent}\n\n${blockText}`
        : blockText || trimmedContent;
    return truncateSlackText(fallbackText, SLACK_EDIT_TEXT_LIMIT);
  }
  if (blockText) {
    return truncateSlackText(blockText, SLACK_EDIT_TEXT_LIMIT);
  }
  return " ";
}
