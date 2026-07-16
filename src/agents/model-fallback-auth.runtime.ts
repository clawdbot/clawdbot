/**
 * Runtime auth profile barrel for fallback/provider selection code.
 *
 * These exports keep the hot runtime path on the auth-profile submodules without
 * pulling the broader model config surface into provider fallback logic.
 */
export { resolveAuthProfileOrder } from "./auth-profiles/order.js";
export { ensureAuthProfileStore, loadAuthProfileStoreForRuntime } from "./auth-profiles/store.js";
export {
  getSoonestCooldownExpiry,
  isProfileInCooldown,
  maybeReprobeWhamBlockedProfiles,
  resolveProfilesUnavailableReason,
} from "./auth-profiles/usage.js";
