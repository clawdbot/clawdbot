import { assertOkOrThrowHttpError, normalizeBaseUrl, postJsonRequest } from "../media-understanding/providers/shared.js";

export { assertOkOrThrowHttpError, normalizeBaseUrl, postJsonRequest };

export type ProviderRequestTransportOverrides = {
  headers?: HeadersInit;
  timeoutMs?: number;
};

export function resolveProviderEndpoint(baseUrl?: string): {
  baseUrl: string;
  endpointClass: string;
} {
  const normalized = normalizeBaseUrl(baseUrl);
  let endpointClass = "generic";
  if (normalized.includes("x.ai")) {
    endpointClass = "xai-native";
  } else if (normalized.includes("generativelanguage.googleapis.com")) {
    endpointClass = "google-generative-ai";
  } else if (normalized.includes("openai.com")) {
    endpointClass = "openai";
  }
  return { baseUrl: normalized, endpointClass };
}

export function resolveProviderRequestCapabilities(params: {
  baseUrl?: string;
  api?: string;
}): {
  endpointClass: string;
  api?: string;
} {
  const endpoint = resolveProviderEndpoint(params.baseUrl);
  return { endpointClass: endpoint.endpointClass, api: params.api };
}

export function resolveProviderHttpRequestConfig(params: {
  baseUrl?: string;
  defaultBaseUrl: string;
  allowPrivateNetwork?: boolean;
  headers?: HeadersInit;
  request?: ProviderRequestTransportOverrides;
  defaultHeaders?: HeadersInit;
  provider?: string;
  api?: string;
  capability?: string;
  transport?: string;
}) {
  const baseUrl = normalizeBaseUrl(params.baseUrl ?? params.defaultBaseUrl);
  const headers = new Headers(params.defaultHeaders ?? {});
  if (params.headers) {
    new Headers(params.headers).forEach((value, key) => headers.set(key, value));
  }
  if (params.request?.headers) {
    new Headers(params.request.headers).forEach((value, key) => headers.set(key, value));
  }
  return {
    baseUrl,
    headers,
    allowPrivateNetwork: params.allowPrivateNetwork === true,
    dispatcherPolicy: undefined,
    request: params.request,
    provider: params.provider,
    api: params.api,
    capability: params.capability,
    transport: params.transport,
  };
}
