/**
 * Text chunking — core/ version.
 *
 * The actual chunking logic is provided by the framework runtime
 * (`runtime.channel.text.chunkMarkdownText`). This module exposes a
 * registerable adapter so core/ modules can call `chunkText()` without
 * importing the plugin-sdk runtime store.
 */

/** Maximum text length for a single QQ Bot message. */
export const TEXT_CHUNK_LIMIT = 5000;

/** Text chunker function signature. */
export type ChunkTextFn = (text: string, limit: number) => string[];

let _chunkText: ChunkTextFn | null = null;

/** Register the text chunker — called by the outer-layer startup. */
export function registerTextChunker(fn: ChunkTextFn): void {
  _chunkText = fn;
}

/**
 * Markdown-aware text chunking.
 *
 * Delegates to the registered chunker (framework runtime).
 * Falls back to a naive split when no chunker is registered.
 */
export function chunkText(text: string, limit: number = TEXT_CHUNK_LIMIT): string[] {
  if (_chunkText) {
    return _chunkText(text, limit);
  }
  // Naive fallback: split by limit without markdown awareness.
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += limit) {
    chunks.push(text.slice(i, i + limit));
  }
  return chunks.length > 0 ? chunks : [text];
}
