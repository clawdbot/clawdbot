// Memory Core API module exposes the plugin public contract.
export { getMemorySearchManager } from "./src/memory/index.js";
export { memoryRuntime } from "./src/runtime-provider.js";
export { createEmbeddingProvider } from "./src/memory/embeddings.js";
export {
  resolveMemoryCacheSummary,
  resolveMemoryFtsState,
  resolveMemoryVectorState,
  type Tone,
} from "openclaw/plugin-sdk/memory-core-host-status";
export { hasConfiguredMemorySecretInput } from "openclaw/plugin-sdk/memory-core-host-secret";
export { auditDreamingArtifacts, repairDreamingArtifacts } from "./src/dreaming-repair.js";
export { configureMemoryCoreDreamingState } from "./src/dreaming-state.js";
export {
  auditShortTermPromotionArtifacts,
  loadShortTermPromotionDreamingStats,
  removeGroundedShortTermCandidates,
  repairShortTermPromotionArtifacts,
} from "./src/short-term-promotion.js";
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
