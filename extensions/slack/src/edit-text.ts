// Slack plugin module implements edit text behavior.
import type { Block, KnownBlock } from "@slack/web-api";
import {
  appendSlackBlocksAccessibleFallbackText,
  buildSlackBlocksAccessibleFallbackText,
} from "./blocks-fallback.js";

export function buildSlackEditTextPayload(
  content: string,
  blocks?: (Block | KnownBlock)[],
): string {
  const trimmedContent = content.trim();
  if (blocks?.length) {
    return (
      appendSlackBlocksAccessibleFallbackText(trimmedContent, blocks) ||
      buildSlackBlocksAccessibleFallbackText(blocks)
    );
  }
  return trimmedContent || " ";
}
