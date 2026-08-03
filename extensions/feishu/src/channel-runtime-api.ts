// Feishu API module exposes the plugin public contract.
export type {
  ChannelMessageActionName,
  ChannelMeta,
  ChannelPlugin,
  ClawdbotConfig,
} from "../runtime-api.js";

export { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-resolution";
export { createActionGate } from "openclaw/plugin-sdk/channel-actions";
export {
  buildProbeChannelStatusSummary,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
export { PAIRING_APPROVED_MESSAGE } from "openclaw/plugin-sdk/channel-status";
