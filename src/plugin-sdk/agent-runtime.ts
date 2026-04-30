// Public agent/model/runtime helpers for plugins that integrate with core agent flows.

export * from "../agents/agent-scope.js";
export { resolveOpenClawAgentDir } from "../agents/agent-paths.js";
export * from "../agents/current-time.js";
export * from "../agents/date-time.js";
export * from "../agents/defaults.js";
export * from "../agents/identity-avatar.js";
export * from "../agents/identity.js";
export * from "../agents/model-auth-markers.js";
export * from "../agents/model-auth.js";
export * from "../agents/model-catalog.js";
export * from "../agents/model-selection.js";
export * from "../agents/simple-completion-runtime.js";
export * from "../agents/pi-embedded-block-chunker.js";
export * from "../agents/pi-embedded-utils.js";
export * from "../agents/provider-auth-aliases.js";
export * from "../agents/provider-id.js";
export * from "../agents/sandbox-paths.js";
export * from "../agents/schema/typebox.js";
export * from "../agents/tools/common.js";
export * from "../agents/tools/web-guarded-fetch.js";
export * from "../agents/tools/web-shared.js";
export * from "../agents/tools/web-fetch-utils.js";
// Intentional public runtime surface: channel plugins use ingress agent helpers directly.
export * from "../agents/agent-command.js";
export * from "../tts/tts.js";

export {
  CLAUDE_CLI_PROFILE_ID,
  CODEX_CLI_PROFILE_ID,
  dedupeProfileIds,
  listProfilesForProvider,
  markAuthProfileGood,
  setAuthProfileOrder,
  upsertAuthProfile,
  upsertAuthProfileWithLock,
  repairOAuthProfileIdMismatch,
  suggestOAuthProfileIdForLegacyDefault,
  clearRuntimeAuthProfileStoreSnapshots,
  ensureAuthProfileStore,
  loadAuthProfileStoreWithoutExternalProfiles,
  loadAuthProfileStoreForSecretsRuntime,
  loadAuthProfileStoreForRuntime,
  replaceRuntimeAuthProfileStoreSnapshots,
  loadAuthProfileStore,
  saveAuthProfileStore,
  findPersistedAuthProfileCredential,
  resolvePersistedAuthProfileOwnerAgentDir,
  calculateAuthProfileCooldownMs,
  clearAuthProfileCooldown,
  clearExpiredCooldowns,
  getSoonestCooldownExpiry,
  isProfileInCooldown,
  markAuthProfileCooldown,
  markAuthProfileFailure,
  markAuthProfileUsed,
  resolveProfilesUnavailableReason,
  resolveProfileUnusableUntilForDisplay,
  resolveApiKeyForProfile,
  resolveAuthProfileDisplayLabel,
  formatAuthDoctorHint,
  resolveAuthProfileEligibility,
  resolveAuthProfileOrder,
  resolveAuthStorePathForDisplay,
} from "../agents/auth-profiles.js";
export type {
  ApiKeyCredential,
  AuthCredentialReasonCode,
  AuthProfileCredential,
  AuthProfileEligibilityReasonCode,
  AuthProfileFailureReason,
  AuthProfileIdRepairResult,
  AuthProfileStore,
  OAuthCredential,
  ProfileUsageStats,
  TokenCredential,
  TokenExpiryState,
} from "../agents/auth-profiles.js";
