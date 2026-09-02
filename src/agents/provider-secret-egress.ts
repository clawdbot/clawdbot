import {
  looksLikeSecretSentinel,
  mintSecretSentinel,
  swapSecretSentinelsInText,
} from "../secrets/sentinel.js";
import { isNonSecretApiKeyMarker } from "./model-auth-markers.js";
import {
  attachModelProviderRequestTransport,
  getModelProviderRequestTransport,
  type ModelProviderRequestTransportOverrides,
} from "./provider-request-config.js";

type PreparedProviderRuntimeAuth = {
  apiKey: string;
  baseUrl?: string;
  request?: ModelProviderRequestTransportOverrides;
  expiresAt?: number;
};

function protectRuntimeAuthValue(params: {
  value: string;
  provider: string;
  label: string;
}): string {
  if (!params.value) {
    return params.value;
  }
  return looksLikeSecretSentinel(params.value)
    ? params.value
    : mintSecretSentinel(params.value, {
        label: `model-auth:${params.provider}:${params.label}`,
      });
}

/** Re-sentinels credentials returned by a provider auth exchange. */
export function protectPreparedProviderRuntimeAuth(params: {
  provider: string;
  preparedAuth: PreparedProviderRuntimeAuth | null | undefined;
}): PreparedProviderRuntimeAuth | undefined {
  const { preparedAuth } = params;
  if (!preparedAuth) {
    return undefined;
  }
  const protect = (value: string, label: string): string =>
    !value || isNonSecretApiKeyMarker(value)
      ? value
      : protectRuntimeAuthValue({ value, provider: params.provider, label });
  const request = preparedAuth.request;
  const headers = request?.headers
    ? Object.fromEntries(
        Object.entries(request.headers).map(([name, value]) => [
          name,
          protect(value, `runtime-header:${name.toLowerCase()}`),
        ]),
      )
    : undefined;
  const auth = request?.auth;
  const protectedAuth =
    auth?.mode === "authorization-bearer"
      ? { ...auth, token: protect(auth.token, "runtime-bearer") }
      : auth?.mode === "header"
        ? {
            ...auth,
            value: protect(auth.value, `runtime-auth-header:${auth.headerName.toLowerCase()}`),
          }
        : auth;
  return {
    ...preparedAuth,
    apiKey: protect(preparedAuth.apiKey, "runtime-api-key"),
    ...(request
      ? {
          request: {
            ...request,
            ...(headers ? { headers } : {}),
            ...(protectedAuth ? { auth: protectedAuth } : {}),
          },
        }
      : {}),
  };
}

export function unwrapSecretSentinelsForProviderEgress(value: string, boundary: string): string {
  const swapped = swapSecretSentinelsInText(value);
  const unknown = swapped.unknown[0];
  if (unknown) {
    throw new Error(
      `Secret sentinel ${unknown} is not registered in this process; refusing ${boundary}`,
    );
  }
  return swapped.text;
}

export function unwrapHeaderSentinelsForProviderEgress<T extends Record<string, unknown>>(
  input: T,
  boundary: string,
): T {
  let headers: Record<string, unknown> | undefined;
  for (const [name, value] of Object.entries(input)) {
    if (typeof value !== "string") {
      continue;
    }
    const resolved = unwrapSecretSentinelsForProviderEgress(value, boundary);
    if (resolved !== value) {
      headers ??= { ...input };
      headers[name] = resolved;
    }
  }
  return headers ? (headers as T) : input;
}

export function unwrapHeadersInitSentinelsForProviderEgress(
  input: HeadersInit | undefined,
  boundary: string,
): HeadersInit | undefined {
  if (!input) {
    return input;
  }
  const headers = new Headers(input);
  let changed = false;
  for (const [name, value] of headers) {
    const resolved = unwrapSecretSentinelsForProviderEgress(value, boundary);
    if (resolved !== value) {
      headers.set(name, resolved);
      changed = true;
    }
  }
  return changed ? headers : input;
}

function unwrapRequestTransportSentinelsForProviderEgress(
  request: ModelProviderRequestTransportOverrides | undefined,
  boundary: string,
): ModelProviderRequestTransportOverrides | undefined {
  if (!request) {
    return request;
  }
  const headers = request.headers
    ? unwrapHeaderSentinelsForProviderEgress(request.headers, boundary)
    : request.headers;
  let auth = request.auth;
  if (auth?.mode === "authorization-bearer") {
    const token = unwrapSecretSentinelsForProviderEgress(auth.token, boundary);
    if (token !== auth.token) {
      auth = { ...auth, token };
    }
  } else if (auth?.mode === "header") {
    const value = unwrapSecretSentinelsForProviderEgress(auth.value, boundary);
    if (value !== auth.value) {
      auth = { ...auth, value };
    }
  }
  if (headers === request.headers && auth === request.auth) {
    return request;
  }
  return {
    ...request,
    ...(headers ? { headers } : {}),
    ...(auth ? { auth } : {}),
  };
}

export function unwrapModelHeaderSentinelsForProviderEgress<
  T extends { headers?: Record<string, unknown> },
>(model: T, boundary: string): T {
  // Plugin transports read both visible headers and the symbol-attached request
  // overrides; both can carry sentinels minted by protectPreparedProviderRuntimeAuth.
  const headers = model.headers
    ? unwrapHeaderSentinelsForProviderEgress(model.headers, boundary)
    : model.headers;
  const request = getModelProviderRequestTransport(model);
  const unwrappedRequest = unwrapRequestTransportSentinelsForProviderEgress(request, boundary);
  if (headers === model.headers && unwrappedRequest === request) {
    return model;
  }
  const next = headers === model.headers ? ({ ...model } as T) : ({ ...model, headers } as T);
  return unwrappedRequest === request
    ? next
    : attachModelProviderRequestTransport(next, unwrappedRequest);
}
