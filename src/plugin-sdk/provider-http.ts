// Shared provider-facing HTTP helpers. Keep generic transport utilities here so
// capability SDKs do not depend on each other.

export {
  assertOkOrThrowHttpError,
  createProviderOperationDeadline,
  fetchWithTimeout,
  fetchWithTimeoutGuarded,
  normalizeBaseUrl,
  postJsonRequest,
  postTranscriptionRequest,
  resolveProviderOperationTimeoutMs,
  resolveProviderHttpRequestConfig,
  requireTranscriptionText,
  waitProviderOperationPollInterval,
} from "../media-understanding/shared.js";
export type { ProviderOperationDeadline } from "../media-understanding/shared.js";
export type {
  ProviderAttributionPolicy,
  ProviderRequestCapabilities,
  ProviderRequestCapabilitiesInput,
  ProviderRequestCompatibilityFamily,
  ProviderEndpointClass,
  ProviderEndpointResolution,
  ProviderRequestCapability,
  ProviderRequestPolicyInput,
  ProviderRequestPolicyResolution,
  ProviderRequestTransport,
} from "../agents/provider-attribution.js";
export type {
  ProviderRequestAuthOverride,
  ProviderRequestProxyOverride,
  ProviderRequestTlsOverride,
  ProviderRequestTransportOverrides,
} from "../agents/provider-request-config.js";
export {
  resolveProviderEndpoint,
  resolveProviderRequestCapabilities,
  resolveProviderRequestPolicy,
} from "../agents/provider-attribution.js";
