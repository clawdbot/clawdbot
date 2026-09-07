import type { PluginCapabilityCatalog } from "./capability-catalog.types.js";

/** Host operations stay native; catalog construction must not start sessions or read stores. */
export type PluginCapabilityCatalogContext = {
  isProviderApiKeyConfigured: typeof import("./provider-auth-availability.js").isProviderApiKeyConfigured;
  isProviderAuthProfileConfigured: typeof import("./provider-auth-availability.js").isProviderAuthProfileConfigured;
  resolveAgentDir: typeof import("../agents/agent-scope-config.js").resolveAgentDir;
  createRealtimeTranscriptionWebSocketSession: typeof import("../realtime-transcription/websocket-session.js").createRealtimeTranscriptionWebSocketSession;
  resolveProviderRequestHeaders: typeof import("../agents/provider-request-config.js").resolveProviderRequestHeaders;
  resolveProviderAuthProfileApiKey: typeof import("./provider-auth-availability.js").resolveProviderAuthProfileApiKey;
  resolveApiKeyForProvider: typeof import("./runtime/runtime-model-auth.runtime.js").resolveProviderRuntimeApiKey;
  captureWsEvent: typeof import("../proxy-capture/runtime.js").captureWsEvent;
  createDebugProxyWebSocketAgent: typeof import("../proxy-capture/env.js").createDebugProxyWebSocketAgent;
  resolveDebugProxySettings: typeof import("../proxy-capture/env.js").resolveDebugProxySettings;
  fetchWithSsrFGuard: typeof import("../infra/net/fetch-guard.js").fetchWithSsrFGuard;
  createProviderHttpError: typeof import("../agents/provider-http-errors.js").createProviderHttpError;
  readProviderJsonResponse: typeof import("../agents/provider-http-errors.js").readProviderJsonResponse;
  readProviderTextResponse: typeof import("../agents/provider-http-errors.js").readProviderTextResponse;
  formatErrorMessage: typeof import("../infra/errors.js").formatErrorMessage;
  warn: typeof import("../globals.js").warn;
  redactSensitiveText: typeof import("../logging/redact.js").redactSensitiveText;
};

export type PluginCapabilityCatalogEntry =
  | PluginCapabilityCatalog
  | ((context: PluginCapabilityCatalogContext) => PluginCapabilityCatalog);
