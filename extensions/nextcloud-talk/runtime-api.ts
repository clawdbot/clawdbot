// Private runtime barrel for the bundled Nextcloud Talk extension.
// Keep this barrel thin and aligned with the local extension surface.

export type { AllowlistMatch } from "openclaw/plugin-sdk/allow-from";
export type { ChannelGroupContext } from "openclaw/plugin-sdk/channel-contract";
export { logInboundDrop } from "openclaw/plugin-sdk/channel-logging";
export { createChannelPairingController } from "openclaw/plugin-sdk/channel-pairing";
export {
  readStoreAllowFromForDmPolicy,
  resolveDmGroupAccessWithCommandGate,
} from "openclaw/plugin-sdk/channel-policy";
export type {
  BlockStreamingCoalesceConfig,
  DmConfig,
  DmPolicy,
  GroupPolicy,
  GroupToolPolicyConfig,
  OpenClawConfig,
} from "openclaw/plugin-sdk/config-types";
export {
  GROUP_POLICY_BLOCKED_LABEL,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "openclaw/plugin-sdk/runtime-group-policy";
export { dispatchInboundReplyWithBase } from "openclaw/plugin-sdk/inbound-reply-dispatch";
export type { OutboundReplyPayload } from "openclaw/plugin-sdk/reply-payload";
export { deliverFormattedTextWithAttachments } from "openclaw/plugin-sdk/reply-payload";
export type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
export type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
export type { SecretInput } from "openclaw/plugin-sdk/secret-input";
export { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
export { setNextcloudTalkRuntime } from "./src/runtime.js";
