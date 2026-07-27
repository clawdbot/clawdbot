// Public config facade for IO, mutation, runtime snapshots, paths, and shared config types.
export {
  clearConfigCache,
  ConfigRuntimeRefreshError,
  clearRuntimeConfigSnapshot,
  registerConfigWriteListener,
  createConfigIO,
  getRuntimeConfig,
  getRuntimeConfigSnapshotMetadata,
  getRuntimeConfigSnapshot,
  getRuntimeConfigSourceSnapshot,
  projectConfigOntoRuntimeSourceSnapshot,
  loadConfig,
  readBestEffortConfig,
  readBestEffortConfigSnapshot,
  readSourceConfigBestEffort,
  parseConfigJson5,
  promoteConfigSnapshotToLastKnownGood,
  readConfigFileSnapshot,
  readConfigFileSnapshotWithPluginMetadata,
  readConfigFileSnapshotForWrite,
  readSourceConfigSnapshot,
  readSourceConfigSnapshotForWrite,
  recoverConfigFromLastKnownGood,
  recoverConfigFromJsonRootSuffix,
  resetConfigRuntimeState,
  resolveConfigSnapshotHash,
  resolveRuntimeConfigCacheKey,
  selectApplicableRuntimeConfig,
  setRuntimeConfigSnapshotRefreshHandler,
  setRuntimeConfigSnapshot,
  writeConfigFile,
} from "./io.js";
export {
  getRuntimeConfigAppliedHash,
  hashRuntimeConfigValue,
  resolveConfigWriteAfterWrite,
  resolveConfigWriteFollowUp,
  setAppliedRuntimeConfigSnapshot,
  setRuntimeConfigAppliedHash,
} from "./runtime-snapshot.js";
export type {
  ConfigWriteAfterWrite,
  ConfigWriteFollowUp,
  RuntimeConfigSnapshotMetadata,
} from "./runtime-snapshot.js";
export type {
  BestEffortConfigSnapshot,
  ConfigSnapshotReadOptions,
  ConfigWriteNotification,
  ConfigWriteResult,
  ReadConfigFileSnapshotWithPluginMetadataResult,
} from "./io.js";
export {
  ConfigMutationConflictError,
  mutateConfigFile,
  mutateConfigFileWithRetry,
  replaceConfigFile,
  transformConfigFile,
  transformConfigFileWithRetry,
  withConfigMutationExclusive,
} from "./mutate.js";
export type {
  ConfigMutationCommit,
  ConfigMutationCommitParams,
  ConfigMutationCommitResult,
  ConfigMutationContext,
  ConfigMutationIO,
  ConfigReplaceResult,
  ConfigMutationResult,
  ConfigTransformResult,
  TransformConfigFileParams,
  TransformConfigFileWithRetryParams,
} from "./mutate.js";
export {
  assertConfigWriteAllowedInCurrentMode,
  NixModeConfigMutationError,
} from "./nix-mode-write-guard.js";
export * from "./paths.js";
export * from "./recovery-policy.js";
export * from "./runtime-overrides.js";
export * from "./types.js";
export {
  validateConfigObject,
  validateConfigObjectRaw,
  validateConfigObjectRawWithPlugins,
  validateConfigObjectWithPlugins,
} from "./validation.js";
