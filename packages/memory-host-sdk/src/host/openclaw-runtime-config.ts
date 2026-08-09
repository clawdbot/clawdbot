// Config-facing runtime facade for memory host packages.
// This keeps memory plugins off broader core config modules and their private helpers.
export {
  getRuntimeConfig,
  hasConfiguredSecretInput,
  loadConfig,
  normalizeResolvedSecretInputString,
  parseDurationMs,
  parseNonNegativeByteSize,
  resolveSessionTranscriptsDirForAgent,
  resolveStateDir,
} from "./openclaw-runtime.js";
export type {
  MemoryCitationsMode,
  MemorySearchConfig,
  OpenClawConfig,
  SecretInput,
} from "./openclaw-runtime.js";
