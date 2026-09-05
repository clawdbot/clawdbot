// Memory-facing runtime facade for plugin registration, embeddings, and prompt artifacts.
// Re-export only stable host seams; plugin implementations should not import core internals.
export {
  getMemoryEmbeddingProvider,
  listMemoryEmbeddingProviders,
  listRegisteredMemoryEmbeddingProviderAdapters,
} from "../../../../src/plugins/memory-embedding-provider-runtime.js";
export type {
  MemoryEmbeddingBatchChunk,
  MemoryEmbeddingBatchOptions,
  MemoryEmbeddingProvider,
  MemoryEmbeddingProviderAdapter,
  MemoryEmbeddingProviderCallOptions,
  MemoryEmbeddingProviderCreateOptions,
  MemoryEmbeddingProviderCreateResult,
  MemoryEmbeddingProviderRuntime,
} from "../../../../src/plugins/memory-embedding-providers.js";
export { emptyPluginConfigSchema } from "../../../../src/plugins/config-schema.js";
export {
  buildMemoryPromptSection as buildActiveMemoryPromptSection,
  getMemoryCapabilityRegistration,
  listActiveMemoryPublicArtifacts,
} from "../../../../src/plugins/memory-state.js";
export type {
  MemoryFlushPlan,
  MemoryFlushPlanResolver,
  MemoryPluginCapability,
  MemoryPluginPublicArtifact,
  MemoryPluginPublicArtifactsProvider,
  MemoryPluginRuntime,
  MemoryPromptSectionBuilder,
} from "../../../../src/plugins/memory-state.js";
export {
  resolveCanonicalRootMemoryFile,
  shouldSkipRootMemoryAuxiliaryPath,
} from "../../../../src/memory/root-memory-files.js";
export type { OpenClawPluginApi } from "../../../../src/plugins/types.js";
