/**
 * @deprecated Public SDK subpath has no bundled extension production imports.
 * Prefer focused channel secret subpaths such as channel-secret-basic-runtime
 * and channel-secret-tts-runtime.
 */

export {
  collectConditionalChannelFieldAssignments,
  collectNestedChannelFieldAssignments,
  collectNestedChannelTtsAssignments,
  collectSimpleChannelFieldAssignments,
  getChannelRecord,
  getChannelSurface,
  hasConfiguredSecretInputValue,
  isBaseFieldActiveForChannelSurface,
  normalizeSecretStringValue,
  resolveChannelAccountSurface,
} from "../secrets/channel-secret-collector-runtime.js";
export type {
  ChannelAccountEntry,
  ChannelAccountPredicate,
  ChannelAccountSurface,
} from "../secrets/channel-secret-collector-runtime.js";
export {
  collectSecretInputAssignment,
  hasOwnProperty,
  isEnabledFlag,
  pushAssignment,
  pushInactiveSurfaceWarning,
  pushWarning,
} from "../secrets/runtime-shared.js";
export type { ResolverContext, SecretDefaults } from "../secrets/runtime-shared.js";
export { isRecord } from "../secrets/shared.js";
export type { SecretTargetRegistryEntry } from "../secrets/target-registry-types.js";
