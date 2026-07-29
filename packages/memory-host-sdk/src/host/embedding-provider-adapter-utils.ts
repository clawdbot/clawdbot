// Memory Host SDK helper module supports embedding provider adapter utils behavior.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

// Adapter helpers shared by remote embedding provider implementations.

/** Detect missing API key errors from provider auth resolution. */
export function isMissingEmbeddingApiKeyError(err: unknown): boolean {
  return err instanceof Error && err.message.includes("No API key found for provider");
}

/** Return stable cache headers after removing adapter-declared secret headers. */
export function sanitizeEmbeddingCacheHeaders(
  headers: Record<string, string>,
  excludedHeaderNames: string[],
): Array<[string, string]> {
  const excluded = new Set(
    excludedHeaderNames.map((name) => normalizeLowercaseStringOrEmpty(name)),
  );
  return Object.entries(headers)
    .filter(([key]) => !excluded.has(normalizeLowercaseStringOrEmpty(key)))
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => [key, value]);
}

/** Convert custom-id keyed batch embeddings back to request-index order. */
export function mapBatchEmbeddingsByIndex(
  byCustomId: Map<string, number[]>,
  count: number,
): number[][] {
  const embeddings: number[][] = [];
  for (let index = 0; index < count; index += 1) {
    embeddings.push(byCustomId.get(String(index)) ?? []);
  }
  return embeddings;
}
