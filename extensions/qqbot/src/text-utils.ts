import { getQQBotRuntime } from "./runtime.js";

/** Maximum text length for a single QQ Bot message. */
export const TEXT_CHUNK_LIMIT = 5000;

/**
 * Markdown-aware text chunking.
 *
 * Delegates to the SDK chunker so code fences and bracket balance stay intact.
 */
export function chunkText(text: string, limit: number): string[] {
  const runtime = getQQBotRuntime();
  return runtime.channel.text.chunkMarkdownText(text, limit);
}
