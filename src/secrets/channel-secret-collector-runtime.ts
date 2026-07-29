/**
 * Runtime barrel for channel secret collectors used by bundled channel contracts.
 * Keep channel packages on this narrow surface instead of deep runtime modules.
 */
export {
  collectConditionalChannelFieldAssignments,
  collectNestedChannelFieldAssignments,
  collectSimpleChannelFieldAssignments,
  getChannelRecord,
  getChannelSurface,
  hasConfiguredSecretInputValue,
  isBaseFieldActiveForChannelSurface,
  normalizeSecretStringValue,
  resolveChannelAccountSurface,
} from "./channel-secret-basic-runtime.js";
export type {
  ChannelAccountEntry,
  ChannelAccountPredicate,
  ChannelAccountSurface,
} from "./channel-secret-basic-runtime.js";
export { collectNestedChannelTtsAssignments } from "./channel-secret-tts-runtime.js";
