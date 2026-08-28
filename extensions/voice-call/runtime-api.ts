// Private runtime barrel for the bundled Voice Call extension.
// Keep this barrel thin and aligned with the local extension surface.

export { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
export type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
export type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
export {
  isRequestBodyLimitError,
  requestBodyErrorToText,
} from "openclaw/plugin-sdk/webhook-request-guards";
export { readWebhookBodyForResponse } from "openclaw/plugin-sdk/webhook-request-release";
export { fetchWithSsrFGuard, isBlockedHostnameOrIp } from "openclaw/plugin-sdk/ssrf-runtime";
export type { SessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
export {
  TtsAutoSchema,
  TtsConfigSchema,
  TtsModeSchema,
  TtsProviderSchema,
} from "openclaw/plugin-sdk/tts-runtime";
export { sleep } from "openclaw/plugin-sdk/runtime-env";
