export { matrixPlugin } from "./src/channel.js";
export { createMatrixSetupWizardProxy, matrixSetupAdapter } from "./src/setup-core.js";
export { matrixOnboardingAdapter } from "./src/setup-surface.js";
export {
  findMatrixAccountEntry,
  requiresExplicitMatrixDefaultAccount,
  resolveConfiguredMatrixAccountIds,
  resolveMatrixChannelConfig,
  resolveMatrixDefaultOrOnlyAccountId,
} from "./src/account-selection.js";
export {
  getMatrixScopedEnvVarNames,
  listMatrixEnvAccountIds,
  resolveMatrixEnvAccountToken,
} from "./src/env-vars.js";
export {
  hashMatrixAccessToken,
  resolveMatrixAccountStorageRoot,
  resolveMatrixCredentialsDir,
  resolveMatrixCredentialsFilename,
  resolveMatrixCredentialsPath,
  resolveMatrixHomeserverKey,
  resolveMatrixLegacyFlatStoragePaths,
  resolveMatrixLegacyFlatStoreRoot,
  sanitizeMatrixPathSegment,
} from "./src/storage-paths.js";
export {
  createMatrixThreadBindingManager,
  getMatrixThreadBindingManager,
  resetMatrixThreadBindingsForTests,
} from "./src/matrix/thread-bindings.js";
export {
  setMatrixThreadBindingIdleTimeoutBySessionKey,
  setMatrixThreadBindingMaxAgeBySessionKey,
} from "./src/matrix/thread-bindings-shared.js";
export { matrixOnboardingAdapter as matrixSetupWizard } from "./src/onboarding.js";

export const matrixSessionBindingAdapterChannels = ["matrix"] as const;
