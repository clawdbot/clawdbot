/**
 * Markdown utilities for Twitch chat
 *
 * Twitch chat doesn't support markdown formatting, so we strip it before sending.
 */
import { stripMarkdown } from "openclaw/plugin-sdk/text-chunking";

/** Strip markdown, then flatten newlines for Twitch's single-line chat. */
export function stripMarkdownForTwitch(markdown: string): string {
  return stripMarkdown(markdown, { linkStyle: "label-and-url" })
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
