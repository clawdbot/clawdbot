// Stable public facade for config loading, snapshots, recovery, and writes.
export { createConfigIO } from "./io.factory.js";
export {
  parseConfigJson5,
  resolveConfigSnapshotHash,
  restoreEnvChangesIfUnchanged,
} from "./io.read-helpers.js";
export {
  clearConfigCache,
  getRuntimeConfig,
  loadConfig,
  promoteConfigSnapshotToLastKnownGood,
  readBestEffortConfig,
  readBestEffortConfigSnapshot,
  readConfigFileSnapshot,
  readConfigFileSnapshotForRuntimeTransaction,
  readConfigFileSnapshotForWrite,
  readConfigFileSnapshotWithPluginMetadata,
  readSourceConfigBestEffort,
  readSourceConfigSnapshot,
  readSourceConfigSnapshotForWrite,
  recoverConfigFromJsonRootSuffix,
  recoverConfigFromLastKnownGood,
  registerConfigWriteListener,
  writeConfigFile,
} from "./io.runtime.js";
export {
  ConfigRuntimeRefreshError,
  type BestEffortConfigSnapshot,
  type ConfigIoDeps,
  type ConfigSnapshotReadMeasure,
  type ConfigSnapshotReadOptions,
  type ConfigWriteNotification,
  type ConfigWriteOptions,
  type ConfigWriteResult,
  type ParseConfigJson5Result,
  type ReadConfigFileSnapshotForWriteResult,
  type ReadConfigFileSnapshotWithPluginMetadataResult,
} from "./io.types.js";
export { projectConfigOntoRuntimeSourceSnapshot } from "./runtime-source-projection.js";
export {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
  getRuntimeConfigSnapshotMetadata,
  getRuntimeConfigSourceSnapshot,
  registerManagedRuntimeConfigWriteOwner,
  resetConfigRuntimeState,
  resolveRuntimeConfigCacheKey,
  selectApplicableRuntimeConfig,
  setAppliedRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
  setRuntimeConfigSnapshotRefreshHandler,
} from "./runtime-snapshot.js";
export { CircularIncludeError, ConfigIncludeError } from "./includes.js";
export { MissingEnvVarError } from "./env-substitution.js";
export { resolveShellEnvExpectedKeys } from "./shell-env-expected-keys.js";
