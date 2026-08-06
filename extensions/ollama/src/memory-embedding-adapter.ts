// Ollama plugin module implements memory embedding adapter behavior.
import { createHash } from "node:crypto";
import {
  sanitizeEmbeddingCacheHeaders,
  type MemoryEmbeddingProviderAdapter,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { OLLAMA_DEFAULT_BASE_URL } from "./defaults.js";
import {
  DEFAULT_OLLAMA_EMBEDDING_MODEL,
  createOllamaEmbeddingProvider,
} from "./embedding-provider.js";

const OLLAMA_EMBEDDING_CACHE_EXCLUDED_HEADERS = ["authorization", "content-type", "x-api-key"];

function hashEmbeddingCacheHeaders(headers: Array<[string, string]>): string | undefined {
  return headers.length > 0
    ? createHash("sha256").update(JSON.stringify(headers)).digest("hex")
    : undefined;
}

export const ollamaMemoryEmbeddingProviderAdapter: MemoryEmbeddingProviderAdapter = {
  id: "ollama",
  defaultModel: DEFAULT_OLLAMA_EMBEDDING_MODEL,
  transport: "remote",
  authProviderId: "ollama",
  create: async (options) => {
    const providerId = options.provider?.trim() || "ollama";
    const { provider, client } = await createOllamaEmbeddingProvider({
      ...options,
      provider: providerId,
      fallback: "none",
    });
    const identityHeaders = sanitizeEmbeddingCacheHeaders(
      client.headers,
      OLLAMA_EMBEDDING_CACHE_EXCLUDED_HEADERS,
    );
    const headersHash = hashEmbeddingCacheHeaders(identityHeaders);
    // The shipped default identity already names this exact endpoint. Preserve it so ordinary
    // local installs do not rebuild; explicit/custom routes need endpoint-scoped identity.
    const usesLegacyDefaultIdentity =
      providerId === "ollama" &&
      client.baseUrl === OLLAMA_DEFAULT_BASE_URL &&
      headersHash === undefined;
    return {
      provider,
      runtime: {
        id: "ollama",
        inlineBatchTimeoutMs: 10 * 60_000,
        cacheKeyData: {
          provider: providerId,
          ...(usesLegacyDefaultIdentity ? {} : { baseUrl: client.baseUrl }),
          model: client.model,
          outputDimensionality: client.outputDimensionality,
          ...(headersHash ? { headersHash } : {}),
        },
      },
    };
  },
};
