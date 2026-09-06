// Descriptor construction and synchronous selection must not load the embedding engine.
export {
  isMissingEmbeddingApiKeyError,
  mapBatchEmbeddingsByIndex,
  sanitizeEmbeddingCacheHeaders,
} from "../../packages/memory-host-sdk/src/host/embedding-provider-adapter-utils.js";
export type { MemoryEmbeddingProviderAdapter } from "../plugins/memory-embedding-providers.js";
