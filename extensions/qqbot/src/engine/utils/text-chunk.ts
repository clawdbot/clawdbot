/**
 * Text chunking constants and fallback.
 *
 * The actual chunking logic is provided by the framework runtime
 * (`runtime.channel.text.chunkMarkdownText`) and injected via the
 * outbound dispatch pipeline — NOT via a global singleton.
 *
 * This module only exports the chunk limit constant and a naive
 * fallback splitter for edge cases outside the pipeline.
 */

/** Maximum text length for a single QQ Bot message. */
export const TEXT_CHUNK_LIMIT = 5000;

/** Text chunker function signature. */
export type ChunkTextFn = (text: string, limit: number) => string[];

/**
 * Naive text chunking fallback.
 *
 * Used only by code outside the outbound pipeline that needs a
 * simple split. The real markdown-aware chunking is always done
 * via `runtime.channel.text.chunkMarkdownText` inside the pipeline.
 */
export function chunkText(text: string, limit: number = TEXT_CHUNK_LIMIT): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += limit) {
    chunks.push(text.slice(i, i + limit));
  }
  return chunks.length > 0 ? chunks : [text];
}
