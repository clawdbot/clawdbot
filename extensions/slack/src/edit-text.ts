// Slack plugin module implements edit text behavior.
import type { Block, KnownBlock } from "@slack/web-api";
import { buildSlackCompleteBlocksFallbackText } from "./blocks-fallback.js";
import { SLACK_EDIT_TEXT_MAX_BYTES } from "./limits.js";
import { appendSlackNativeDataPlainTextFallback } from "./native-data-blocks.js";
import { truncateSlackTextByUtf8Bytes } from "./truncate.js";

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
    return truncateSlackTextByUtf8Bytes(fallbackText, SLACK_EDIT_TEXT_MAX_BYTES);
  }
  if (blockText) {
    return truncateSlackTextByUtf8Bytes(blockText, SLACK_EDIT_TEXT_MAX_BYTES);
  }
  return " ";
}
