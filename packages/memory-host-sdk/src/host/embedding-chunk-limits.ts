// Memory Host SDK module implements embedding chunk limits behavior.
import { estimateUtf8Bytes, splitTextToUtf8ByteLimit } from "./embedding-input-limits.js";
import { hasNonTextEmbeddingParts } from "./embedding-inputs.js";
import { resolveEmbeddingMaxInputTokens } from "./embedding-model-limits.js";
import type { EmbeddingProvider } from "./embeddings.js";
import { hashText } from "./hash.js";
import type { MemoryChunk } from "./internal.js";

// Enforces provider byte budgets before chunks reach embedding workers.

/**
 * Split text-only chunks to the provider's effective input limit.
 *
 * Structured multimodal chunks are preserved because only the provider can decide how to count
 * non-text parts.
 */
export function enforceEmbeddingMaxInputTokens(
  provider: EmbeddingProvider,
  chunks: MemoryChunk[],
  hardMaxInputTokens?: number,
): MemoryChunk[] {
  const providerMaxInputTokens = resolveEmbeddingMaxInputTokens(provider);
  const maxInputTokens =
    typeof hardMaxInputTokens === "number" && hardMaxInputTokens > 0
      ? Math.min(providerMaxInputTokens, hardMaxInputTokens)
      : providerMaxInputTokens;
  const out: MemoryChunk[] = [];

  for (const chunk of chunks) {
    if (hasNonTextEmbeddingParts(chunk.embeddingInput)) {
      out.push(chunk);
      continue;
    }
    if (estimateUtf8Bytes(chunk.text) <= maxInputTokens) {
      out.push(chunk);
      continue;
    }

    for (const text of splitTextToUtf8ByteLimit(chunk.text, maxInputTokens)) {
      out.push({
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        text,
        hash: hashText(text),
        embeddingInput: { text },
      });
    }
  }

  return out;
}
