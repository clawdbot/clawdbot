/**
 * Public SDK subpath for realtime transcription provider types and session helpers.
 */
import {
  acquirePluginCapabilityProvider,
  acquirePluginCapabilityProviders,
} from "../plugins/capability-provider-runtime.js";
import {
  getRealtimeTranscriptionProviderCore as getProviderCore,
  listRealtimeTranscriptionProvidersCore as listProvidersCore,
} from "../realtime-transcription/provider-registry.js";
import { withLegacyPluginSdkResourceScope } from "./legacy-registry-resource-scope.js";
export type { RealtimeTranscriptionProviderPlugin } from "../plugins/types.js";
export type {
  RealtimeTranscriptionProviderConfig,
  RealtimeTranscriptionProviderConfiguredContext,
  RealtimeTranscriptionProviderId,
  RealtimeTranscriptionProviderResolveConfigContext,
  RealtimeTranscriptionSession,
  RealtimeTranscriptionSessionCallbacks,
  RealtimeTranscriptionSessionCreateRequest,
} from "../realtime-transcription/provider-types.js";
export {
  canonicalizeRealtimeTranscriptionProviderId,
  normalizeRealtimeTranscriptionProviderId,
} from "../realtime-transcription/provider-registry.js";
export {
  createRealtimeTranscriptionWebSocketSession,
  type RealtimeTranscriptionWebSocketSessionOptions,
  type RealtimeTranscriptionWebSocketTransport,
} from "./realtime-transcription-session.js";

/** @deprecated Use acquireRealtimeTranscriptionProvider and release after all callbacks finish. */
export function getRealtimeTranscriptionProvider(...args: Parameters<typeof getProviderCore>) {
  return withLegacyPluginSdkResourceScope(() => getProviderCore(...args));
}

/** @deprecated Use acquireRealtimeTranscriptionProviders and release after all callbacks finish. */
export function listRealtimeTranscriptionProviders(...args: Parameters<typeof listProvidersCore>) {
  return withLegacyPluginSdkResourceScope(() => listProvidersCore(...args));
}

export function acquireRealtimeTranscriptionProvider(
  providerId: string,
  cfg?: Parameters<typeof listProvidersCore>[0],
) {
  return acquirePluginCapabilityProvider({
    key: "realtimeTranscriptionProviders",
    providerId,
    cfg,
  });
}

export function acquireRealtimeTranscriptionProviders(
  cfg?: Parameters<typeof listProvidersCore>[0],
  additionalProviderIds?: readonly string[],
) {
  return acquirePluginCapabilityProviders({
    key: "realtimeTranscriptionProviders",
    cfg,
    additionalProviderIds,
  });
}
