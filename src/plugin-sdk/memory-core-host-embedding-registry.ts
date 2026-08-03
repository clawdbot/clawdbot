/**
 * Public SDK subpath for memory host embedding provider registration and lookup.
 */
export { DEFAULT_LOCAL_MODEL } from "../../packages/memory-host-sdk/src/host/embedding-defaults.js";
export {
  listMemoryEmbeddingProviders,
  listRegisteredMemoryEmbeddingProviderAdapters,
} from "../plugins/memory-embedding-provider-runtime.js";
export type {
  MemoryEmbeddingProviderAdapter,
  MemoryEmbeddingProviderCreateOptions,
  MemoryEmbeddingProviderCreateResult,
} from "../plugins/memory-embedding-providers.js";
