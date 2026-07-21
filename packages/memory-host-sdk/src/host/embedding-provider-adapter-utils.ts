// Memory Host SDK helper module supports embedding provider adapter utils behavior.
import { createHash } from "node:crypto";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

// Adapter helpers shared by remote embedding provider implementations.

// Secret or invariant headers must never distinguish or leak into the cache identity.
const EMBEDDING_CACHE_IDENTITY_EXCLUDED_HEADERS = ["authorization", "content-type", "x-api-key"];

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

/**
 * Endpoint-scoped extra cache-identity fields for a remote embedding provider.
 * A custom base URL or custom header identity must not collide with the shipped
 * default's cache entry, else a cached embedding computed against one endpoint is
 * served for another (same provider+model). Returns fields to spread into
 * `cacheKeyData`; empty for the shipped default so ordinary installs keep their
 * existing cache identity and do not rebuild.
 */
export function buildEmbeddingEndpointCacheIdentity(params: {
  baseUrl: string;
  defaultBaseUrl: string;
  headers: Record<string, string>;
}): { baseUrl?: string; headersHash?: string } {
  const identityHeaders = sanitizeEmbeddingCacheHeaders(
    params.headers,
    EMBEDDING_CACHE_IDENTITY_EXCLUDED_HEADERS,
  );
  const headersHash =
    identityHeaders.length > 0
      ? createHash("sha256").update(JSON.stringify(identityHeaders)).digest("hex")
      : undefined;
  const usesShippedDefaultIdentity =
    params.baseUrl === params.defaultBaseUrl && headersHash === undefined;
  return {
    ...(usesShippedDefaultIdentity ? {} : { baseUrl: params.baseUrl }),
    ...(headersHash ? { headersHash } : {}),
  };
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
