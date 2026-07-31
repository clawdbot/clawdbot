/**
 * Markdown utilities for Twitch chat
 *
 * Twitch chat doesn't support markdown formatting, so we strip it before sending.
 */
import { chunkTextForOutbound, stripMarkdown } from "openclaw/plugin-sdk/text-chunking";

/** Strip markdown, then flatten newlines for Twitch's single-line chat. */
export function stripMarkdownForTwitch(markdown: string): string {
  return stripMarkdown(markdown, { linkStyle: "label-and-url" })
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/**
 * Simple word-boundary chunker for Twitch (500 char limit).
 * Strips markdown before chunking to avoid breaking markdown patterns.
 *
 * @param text - The text to chunk
 * @param limit - Maximum characters per chunk (Twitch limit is 500)
 * @returns Array of text chunks
 */
export function chunkTextForTwitch(text: string, limit: number): string[] {
  // First, strip markdown
  const cleaned = stripMarkdownForTwitch(text);
  if (!cleaned) {
    return [];
  }
  return chunkTextForOutbound(cleaned, limit);
}
