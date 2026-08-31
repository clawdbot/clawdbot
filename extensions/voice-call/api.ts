// Public voice-call API barrel exposed to plugin-local modules and tests.

export {
  definePluginEntry,
  fetchWithSsrFGuard,
  type GatewayRequestHandlerOptions,
  isBlockedHostnameOrIp,
  isRequestBodyLimitError,
  type OpenClawPluginApi,
  readRequestBodyWithLimit,
  requestBodyErrorToText,
  type SessionEntry,
  sleep,
  TtsAutoSchema,
  TtsConfigSchema,
  TtsModeSchema,
  TtsProviderSchema,
} from "./runtime-api.js";
