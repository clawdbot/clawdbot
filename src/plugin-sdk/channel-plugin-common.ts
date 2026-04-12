// Canonical shared prelude for channel-oriented plugin SDK surfaces.
// Keep `core` and channel-specific SDK entrypoints derived from this module
// so bundled channel entrypoints do not drift across overlapping exports.
export type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
export type { ChannelMessageActionContext } from "../channels/plugins/types.public.js";
export type { PluginRuntime } from "../plugins/runtime/types.js";
export type { OpenClawPluginApi } from "../plugins/types.js";

export { emptyPluginConfigSchema } from "../plugins/config-schema.js";

export { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../routing/session-key.js";

export {
  applyAccountNameToChannelSection,
  migrateBaseNameToDefaultAccount,
} from "../channels/plugins/setup-helpers.js";
export { buildChannelConfigSchema } from "../channels/plugins/config-schema.js";
export {
  deleteAccountFromConfigSection,
  setAccountEnabledInConfigSection,
} from "../channels/plugins/config-helpers.js";
export { formatPairingApproveHint } from "../channels/plugins/helpers.js";
export { PAIRING_APPROVED_MESSAGE } from "../channels/plugins/pairing-message.js";

export { getChatChannelMeta } from "../channels/chat-meta.js";
