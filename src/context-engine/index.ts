export type {
  ContextEngine,
  ContextEngineInfo,
  AssembleResult,
  CompactResult,
  ContextEngineMaintenanceResult,
  ContextEngineRuntimeContext,
  IngestResult,
  TranscriptRewriteReplacement,
  TranscriptRewriteRequest,
  TranscriptRewriteResult,
} from "./types.js";

export {
  registerContextEngine,
  getContextEngineFactory,
  listContextEngineIds,
  resolveContextEngine,
} from "./registry.js";
export type { ContextEngineFactory } from "./registry.js";

export { LegacyContextEngine } from "./legacy.js";
export { registerLegacyContextEngine } from "./legacy.registration.js";
export { delegateCompactionToRuntime } from "./delegate.js";

export { ensureContextEnginesInitialized } from "./init.js";
