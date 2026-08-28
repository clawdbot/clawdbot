// Memory Core API module exposes the plugin public contract.
export type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
export type {
  MemoryEmbeddingProbeResult,
  MemoryProviderStatus,
  MemorySyncProgressUpdate,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
export {
  dedupeDreamDiaryEntries,
  removeBackfillDiaryEntries,
  writeBackfillDiaryEntries,
} from "./src/dreaming-narrative.js";
export { previewGroundedRemMarkdown } from "./src/rem-evidence.js";
export { filterRecallEntriesWithinLookback } from "./src/dreaming-phases.js";
export { previewRemHarness } from "./src/rem-harness.js";
export type { PreviewRemHarnessOptions, PreviewRemHarnessResult } from "./src/rem-harness.js";
export { configureMemoryCoreDreamingState } from "./src/dreaming-state.js";
export { filterMemorySearchHitsBySessionVisibility } from "./src/session-search-visibility.js";
export {
  MEMORY_MANAGED_LOCAL_EMBEDDING_SETUP_CHECK_ID,
  pluginStateIsolatedDoctorCheckIds,
  registerMemoryCoreDoctorChecks,
} from "./src/doctor-health.js";
export { MISSING_LOCAL_MEMORY_EMBEDDING_PROVIDER_MESSAGE } from "./src/memory/local-embedding-provider.js";
