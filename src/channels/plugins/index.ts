export {
  getChannelPlugin,
  getLoadedChannelPlugin,
  listChannelPlugins,
  normalizeChannelId,
} from "./registry.js";
export {
  applyChannelMatchMeta,
  buildChannelKeyCandidates,
  normalizeChannelSlug,
  resolveChannelEntryMatch,
  resolveChannelEntryMatchWithFallback,
  resolveChannelMatchConfig,
  resolveNestedAllowlistDecision,
  type ChannelEntryMatch,
  type ChannelMatchSource,
} from "./channel-config.js";
export {
  formatAllowlistMatchMeta,
  type AllowlistMatch,
  type AllowlistMatchSource,
} from "./allowlist-match.js";
export type { ChannelId } from "./types.public.js";
export type { ChannelPlugin } from "./types.plugin.js";
export { resolveChannelApprovalAdapter, resolveChannelApprovalCapability } from "./approvals.js";
