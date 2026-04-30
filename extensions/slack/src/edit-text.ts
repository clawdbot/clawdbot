import type { Block, KnownBlock } from "@slack/web-api";
import { buildSlackBlocksFallbackText } from "./blocks-fallback.js";
import { SLACK_TEXT_LIMIT } from "./limits.js";
import { truncateSlackText } from "./truncate.js";

export function buildSlackEditTextPayload(
  content: string,
  blocks?: (Block | KnownBlock)[],
): string {
  const trimmedContent = content.trim();
  if (trimmedContent) {
    return trimmedContent;
  }
  if (blocks?.length) {
    return truncateSlackText(buildSlackBlocksFallbackText(blocks), SLACK_TEXT_LIMIT);
  }
  return " ";
}
