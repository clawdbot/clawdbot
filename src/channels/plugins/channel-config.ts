// Compatibility facade for channel config matching helpers used by plugin runtime APIs.
export type { ChannelEntryMatch, ChannelMatchSource } from "../channel-config.js";
export {
  applyChannelMatchMeta,
  buildChannelKeyCandidates,
  normalizeChannelSlug,
  resolveChannelEntryMatch,
  resolveChannelEntryMatchWithFallback,
  resolveChannelMatchConfig,
  resolveNestedAllowlistDecision,
} from "../channel-config.js";
