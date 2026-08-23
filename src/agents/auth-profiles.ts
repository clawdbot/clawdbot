/**
 * Public auth-profile barrel for agent/provider auth code.
 * Keep external callers on these exported contracts instead of deep
 * auth-profile implementation files.
 */
export { CLAUDE_CLI_PROFILE_ID, CODEX_CLI_PROFILE_ID } from "./auth-profiles/constants.js";
export type {
  AuthCredentialReasonCode,
  TokenExpiryState,
} from "./auth-profiles/credential-state.js";
export type { AuthProfileEligibilityReasonCode } from "./auth-profiles/order.js";
export { resolveAuthProfileDisplayLabel } from "./auth-profiles/display.js";
export { formatAuthDoctorHint } from "./auth-profiles/doctor.js";
export {
  externalCliDiscoveryForConfigStatus,
  externalCliDiscoveryForProviderAuth,
  externalCliDiscoveryForProviders,
  externalCliDiscoveryScoped,
  type ExternalCliAuthDiscovery,
} from "./auth-profiles/external-cli-discovery.js";
export {
  refreshOAuthCredentialForRuntime,
  resolveApiKeyForProfile,
} from "./auth-profiles/oauth.js";
export {
  isConfiguredAwsSdkAuthProfileForProvider,
  isStoredCredentialCompatibleWithAuthProvider,
  resolveAuthProfileEligibility,
  resolveAuthProfileOrder,
} from "./auth-profiles/order.js";
export {
  resolveAuthStatePathForDisplay,
  resolveAuthStorePathForDisplay,
} from "./auth-profiles/paths.js";
export {
  dedupeProfileIds,
  listProfilesForProvider,
  markAuthProfileSuccess,
  removeAuthProfilesAcrossOwnerStores,
  removeAuthProfilesWithLock,
  removeProviderAuthProfilesWithLock,
  resolveSubscriptionAuthModeForProfiles,
  setAuthProfileOrder,
  upsertAuthProfile,
  upsertAuthProfileWithLock,
  upsertAuthProfileWithLockOrThrow,
} from "./auth-profiles/profiles.js";
export { persistAuthProfileBatch } from "./auth-profiles/upsert-with-lock.js";
export {
  repairOAuthProfileIdMismatch,
  suggestOAuthProfileIdForLegacyDefault,
} from "./auth-profiles/repair.js";
export {
  buildPortableAuthProfileStoreForAgentCopy,
  isAuthProfileCredentialPortableForAgentCopy,
  resolveAuthProfilePortability,
  type AuthProfilePortability,
  type AuthProfilePortabilityReason,
} from "./auth-profiles/portability.js";
export {
  clearRuntimeAuthProfileStoreSnapshot,
  ensureAuthProfileStore,
  ensureAuthProfileStoreWithoutExternalProfiles,
  getPreparedRuntimeAuthProfileStoreSnapshot,
  getRuntimeAuthProfileStoreSnapshot,
  getRuntimeAuthProfileStoreSnapshotRevision,
  hasAuthProfileStoreSourceForProvider,
  hasAnyAuthProfileStoreSource,
  hasLocalAuthProfileStoreSource,
  loadAuthProfileStoreForSecretsRuntime,
  loadAuthProfileStoreWithoutExternalProfiles,
  loadAuthProfileStoreForRuntime,
  loadAuthProfileStore,
  saveAuthProfileStore,
  findPersistedAuthProfileCredential,
  resolvePersistedAuthProfileOwnerAgentDir,
  withEnvOnlyAuthProfileStore,
  withAuthProfileStoreAgentDir,
} from "./auth-profiles/store.js";
export {
  clearRuntimeAuthProfileStoreSnapshots,
  replaceRuntimeAuthProfileStoreSnapshots,
} from "./auth-profiles/runtime-snapshots.js";
export type {
  ApiKeyCredential,
  AuthProfileBlockedReason,
  AuthProfileBlockedSource,
  AuthProfileCredential,
  AuthProfileFailureReason,
  AuthProfileIdRepairResult,
  AuthProfileState,
  AuthProfileStore,
  OAuthCredential,
  ProfileUsageStats,
  TokenCredential,
} from "./auth-profiles/types.js";
export {
  calculateAuthProfileCooldownMs,
  clearAuthProfileCooldown,
  clearExpiredCooldowns,
  getSoonestCooldownExpiry,
  isProfileInCooldown,
  markAuthProfileCooldown,
  markAuthProfileBlockedUntil,
  markAuthProfileFailure,
  markInlineProviderApiKeyFailure,
  resolveInlineProviderApiKeyUnusableUntil,
  resolveInlineProviderApiKeyUsageId,
  resolveProfilesUnavailableReason,
  resolveProfileUnusableUntilForDisplay,
  setAuthProfileFailureHook,
} from "./auth-profiles/usage.js";
