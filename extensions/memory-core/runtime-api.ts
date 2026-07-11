// Memory Core API module exposes the plugin public contract.
export { getMemorySearchManager, MemoryIndexManager } from "./src/memory/index.js";
export { memoryRuntime } from "./src/runtime-provider.js";
export {
  DEFAULT_LOCAL_MODEL,
  getBuiltinMemoryEmbeddingProviderDoctorMetadata,
  listBuiltinAutoSelectMemoryEmbeddingProviderDoctorMetadata,
} from "./src/memory/provider-adapters.js";
export { createEmbeddingProvider } from "./src/memory/embeddings.js";
export {
  resolveMemoryCacheSummary,
  resolveMemoryFtsState,
  resolveMemoryVectorState,
  type Tone,
} from "openclaw/plugin-sdk/memory-core-host-status";
export { checkQmdBinaryAvailability } from "openclaw/plugin-sdk/memory-core-host-engine-qmd";
export { hasConfiguredMemorySecretInput } from "openclaw/plugin-sdk/memory-core-host-secret";
export { auditDreamingArtifacts, repairDreamingArtifacts } from "./src/dreaming-repair.js";
export { configureMemoryCoreDreamingState } from "./src/dreaming-state.js";
export { configureMemoryCoreEmbeddingLocalService } from "./src/memory/embedding-local-service.js";
export {
  auditShortTermPromotionArtifacts,
  loadShortTermPromotionDreamingStats,
  removeGroundedShortTermCandidates,
  repairShortTermPromotionArtifacts,
} from "./src/short-term-promotion.js";
export type { BuiltinMemoryEmbeddingProviderDoctorMetadata } from "./src/memory/provider-adapters.js";
export type {
  DreamingArtifactsAuditSummary,
  RepairDreamingArtifactsResult,
} from "./src/dreaming-repair.js";
export type {
  RepairShortTermPromotionArtifactsResult,
  ShortTermDreamingStats,
  ShortTermDreamingStatsEntry,
  ShortTermAuditSummary,
} from "./src/short-term-promotion.js";
