/**
 * Public auth-profile barrel for agent/provider auth code.
 * Keep external callers on these exported contracts instead of deep
 * auth-profile implementation files.
 */
export type { AuthCredentialReasonCode } from "./auth-profiles/credential-state.js";
export type { AuthProfileEligibilityReasonCode } from "./auth-profiles/order.js";
export { resolveAuthProfileDisplayLabel } from "./auth-profiles/display.js";
export { resolveAuthProfileMetadata } from "./auth-profiles/identity.js";
export {
  externalCliDiscoveryForConfigStatus,
  externalCliDiscoveryForProviderAuth,
  externalCliDiscoveryForProviders,
  externalCliDiscoveryScoped,
} from "./auth-profiles/external-cli-discovery.js";
export {
  refreshOAuthCredentialForRuntime,
  resolveApiKeyForProfile,
} from "./auth-profiles/oauth.js";
export {
  isConfiguredAwsSdkAuthProfileForProvider,
  resolveAuthProfileEligibility,
  resolveExplicitAuthOrderSelection,
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
  removeProviderAuthProfilesWithLock,
  resolveSubscriptionAuthModeForProfiles,
  setAuthProfileOrder,
  upsertAuthProfile,
  upsertAuthProfileWithLock,
} from "./auth-profiles/profiles.js";
export { persistAuthProfileBatch } from "./auth-profiles/upsert-with-lock.js";
export { buildPortableAuthProfileStoreForAgentCopy } from "./auth-profiles/portability.js";
export {
  clearRuntimeAuthProfileStoreSnapshot,
  getPreparedRuntimeAuthProfileStoreSnapshot,
  getRuntimeAuthProfileStoreSnapshot,
  getRuntimeAuthProfileStoreSnapshotRevision,
  hasAuthProfileStoreSourceForProvider,
  hasAnyAuthProfileStoreSource,
  hasLocalAuthProfileStoreSource,
  findPersistedAuthProfileCredential,
  resolvePersistedAuthProfileOwnerAgentDir,
  withEnvOnlyAuthProfileStore,
  withAuthProfileStoreAgentDir,
} from "./auth-profiles/store.js";
export {
  ensureAuthProfileStore,
  ensureAuthProfileStoreWithoutExternalProfiles,
  loadAuthProfileStoreForSecretsRuntime,
  loadAuthProfileStoreWithoutExternalProfiles,
  loadAuthProfileStoreForRuntime,
  saveAuthProfileStore,
} from "./auth-profiles/store-runtime.js";
export {
  clearRuntimeAuthProfileStoreSnapshots,
  replaceRuntimeAuthProfileStoreSnapshots,
} from "./auth-profiles/runtime-snapshots.js";
export type {
  AuthProfileCredential,
  AuthProfileFailureReason,
  AuthProfileStore,
  OAuthCredential,
  ProfileUsageStats,
  RuntimeAuthProfileStore,
} from "./auth-profiles/types.js";
export {
  clearExpiredCooldowns,
  isProfileInCooldown,
  markAuthProfileBlockedUntil,
  markAuthProfileFailure,
  markInlineProviderApiKeyFailure,
  resolveInlineProviderApiKeyUsageId,
  resolveProfilesUnavailableReason,
  resolveProfileUnusableUntilForDisplay,
} from "./auth-profiles/usage.js";
