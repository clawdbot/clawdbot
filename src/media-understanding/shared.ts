// Shared provider HTTP/audio helpers for media-understanding integrations,
// including guarded fetches, deadlines, retries, and multipart upload bodies.
import path from "node:path";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  assertOkOrThrowHttpError,
  createProviderHttpError,
  readProviderJsonObjectResponse,
} from "../agents/provider-http-errors.js";
export {
  assertOkOrThrowHttpError,
  readProviderJsonObjectResponse,
  readProviderJsonResponse,
} from "../agents/provider-http-errors.js";
import {
  resolveDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
  resolveTimerTimeoutMs,
} from "@openclaw/normalization-core/number-coercion";
import type {
  ProviderRequestCapability,
  ProviderRequestTransport,
} from "../agents/provider-attribution.js";
import {
  buildProviderRequestDispatcherPolicy,
  resolveProviderRequestPolicyConfig,
  type ModelProviderRequestTransportOverrides,
  type ResolvedProviderRequestConfig,
} from "../agents/provider-request-config.js";
import type { GuardedFetchMode, GuardedFetchResult } from "../infra/net/fetch-guard.js";
import { fetchWithSsrFGuard, GUARDED_FETCH_MODE } from "../infra/net/fetch-guard.js";
import { shouldUseEnvHttpProxyForUrl } from "../infra/net/proxy-env.js";
import type { LookupFn, PinnedDispatcherPolicy, SsrFPolicy } from "../infra/net/ssrf.js";
import {
  executeProviderOperationWithRetry,
  isTransientProviderHttpStatus,
  type ProviderOperationRetryStage,
  type TransientProviderRetryConfig,
} from "../provider-runtime/operation-retry.js";
import { fetchWithTimeout } from "../utils/fetch-timeout.js";
export { fetchWithTimeout };
export { normalizeBaseUrl } from "../agents/provider-request-config.js";
export { sanitizeConfiguredModelProviderRequest } from "../agents/provider-request-config.js";

const DEFAULT_GUARDED_HTTP_TIMEOUT_MS = 60_000;
const MAX_AUDIT_CONTEXT_CHARS = 80;

/** Resolves the multipart upload filename, mapping AAC inputs to provider-friendly `.m4a`. */
export function resolveAudioTranscriptionUploadFileName(fileName?: string, mime?: string): string {
  // Some providers reject raw `.aac` names even when the bytes are AAC; `.m4a`
  // preserves intent while matching their accepted upload extensions.
  const trimmed = fileName?.trim();
  const baseName = trimmed ? path.basename(trimmed) : "audio";
  const lowerMime = mime?.trim().toLowerCase();

  if (/\.aac$/i.test(baseName)) {
    return `${baseName.slice(0, -4) || "audio"}.m4a`;
  }
  if (!path.extname(baseName) && lowerMime === "audio/aac") {
    return `${baseName || "audio"}.m4a`;
  }
  return baseName;
}

/** Builds provider-compatible multipart form data for audio transcription requests. */
export function buildAudioTranscriptionFormData(params: {
  buffer: Buffer;
  fileName?: string;
  mime?: string;
  fields?: Record<string, string | number | boolean | undefined>;
}): FormData {
  const form = new FormData();
  const bytes = new Uint8Array(params.buffer);
  const blob = new Blob([bytes], {
    type: params.mime ?? "application/octet-stream",
  });
  form.append("file", blob, resolveAudioTranscriptionUploadFileName(params.fileName, params.mime));
  for (const [name, value] of Object.entries(params.fields ?? {})) {
    const text = typeof value === "string" ? value.trim() : value == null ? "" : String(value);
    if (text) {
      form.append(name, text);
    }
  }
  return form;
}

/** Shared absolute deadline state for long-running provider operations and polling loops. */
export type ProviderOperationDeadline = {
  deadlineAtMs?: number;
  label: string;
  timeoutMs?: number;
};

/** Static or per-call timeout resolver used by provider HTTP helpers. */
export type ProviderOperationTimeoutMs = number | (() => number);

type GuardedProviderRequestParams = {
  pinDns?: boolean;
  allowPrivateNetwork?: boolean;
  ssrfPolicy?: SsrFPolicy;
  dispatcherPolicy?: PinnedDispatcherPolicy;
  auditContext?: string;
  /**
   * Override the guarded-fetch mode. Defaults to an auto-upgrade to
   * `TRUSTED_ENV_PROXY` when `HTTP_PROXY`/`HTTPS_PROXY` is configured in the
   * environment; pass `"strict"` to force pinned-DNS even inside a proxy.
   */
  mode?: GuardedFetchMode;
};

/** Creates a timer-safe absolute deadline, resolving a lazy total timeout exactly once. */
export function createProviderOperationDeadline(params: {
  timeoutMs?: ProviderOperationTimeoutMs;
  label: string;
}): ProviderOperationDeadline {
  const timeoutMs = typeof params.timeoutMs === "function" ? params.timeoutMs() : params.timeoutMs;
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return { label: params.label };
  }
  const resolvedTimeoutMs = resolveTimerTimeoutMs(timeoutMs, 1);
  const deadlineAtMs =
    resolveExpiresAtMsFromDurationMs(resolvedTimeoutMs) ?? resolveDateTimestampMs(Date.now());
  return {
    deadlineAtMs,
    label: params.label,
    timeoutMs: resolvedTimeoutMs,
  };
}

/** Resolves a per-request timeout without exceeding the remaining operation deadline. */
export function resolveProviderOperationTimeoutMs(params: {
  deadline: ProviderOperationDeadline;
  defaultTimeoutMs: number;
}): number {
  const defaultTimeoutMs = resolveTimerTimeoutMs(params.defaultTimeoutMs, 1);
  const deadlineAtMs = params.deadline.deadlineAtMs;
  if (typeof deadlineAtMs !== "number") {
    return defaultTimeoutMs;
  }
  const remainingMs = deadlineAtMs - Date.now();
  if (remainingMs <= 0) {
    throw createProviderOperationTimeoutError(params.deadline);
  }
  return Math.max(1, Math.min(defaultTimeoutMs, remainingMs));
}

/** Builds the canonical error for an exhausted provider operation deadline. */
function createProviderOperationTimeoutError(deadline: ProviderOperationDeadline): Error {
  const timeoutLabel =
    typeof deadline.timeoutMs === "number" ? ` after ${deadline.timeoutMs}ms` : "";
  return new Error(`${deadline.label} timed out${timeoutLabel}`);
}

/** Resolves a static or lazy request timeout with a validated fallback. */
function resolveProviderRequestTimeoutMs(params: {
  timeoutMs?: ProviderOperationTimeoutMs;
  defaultTimeoutMs: number;
}): number {
  const resolved = typeof params.timeoutMs === "function" ? params.timeoutMs() : params.timeoutMs;
  const fallback = resolveTimerTimeoutMs(params.defaultTimeoutMs, DEFAULT_GUARDED_HTTP_TIMEOUT_MS);
  if (typeof resolved !== "number" || !Number.isFinite(resolved) || resolved <= 0) {
    return fallback;
  }
  return resolveTimerTimeoutMs(resolved, fallback);
}

/** Returns lazy body-read options tied to the same absolute provider operation deadline. */
function createProviderOperationBodyReadOptions(params: {
  deadline: ProviderOperationDeadline;
  defaultTimeoutMs: number;
}) {
  return {
    timeoutMs: createProviderOperationTimeoutResolver(params),
    onTimeout: () => createProviderOperationTimeoutError(params.deadline),
  };
}

/** Returns a lazy timeout resolver for code paths that retry or poll multiple HTTP calls. */
export function createProviderOperationTimeoutResolver(params: {
  deadline: ProviderOperationDeadline;
  defaultTimeoutMs: number;
}): () => number {
  return () => resolveProviderOperationTimeoutMs(params);
}

/** Waits for the next poll interval while respecting the total provider operation deadline. */
export async function waitProviderOperationPollInterval(params: {
  deadline: ProviderOperationDeadline;
  pollIntervalMs: number;
}): Promise<void> {
  const pollIntervalMs = resolveTimerTimeoutMs(params.pollIntervalMs, 1);
  const deadlineAtMs = params.deadline.deadlineAtMs;
  if (typeof deadlineAtMs !== "number") {
    await new Promise((resolve) => {
      setTimeout(resolve, pollIntervalMs);
    });
    return;
  }
  const remainingMs = deadlineAtMs - Date.now();
  if (remainingMs <= 0) {
    throw createProviderOperationTimeoutError(params.deadline);
  }
  await new Promise((resolve) => {
    setTimeout(resolve, Math.min(pollIntervalMs, remainingMs));
  });
}

export async function pollProviderOperationJson<TPayload>(
  params: {
    url: string;
    headers: Headers | (() => Headers);
    deadline: ProviderOperationDeadline;
    defaultTimeoutMs: number;
    fetchFn: typeof fetch;
    maxAttempts: number;
    pollIntervalMs: number;
    requestFailedMessage: string;
    timeoutMessage: string;
    isComplete: (payload: TPayload) => boolean;
    getFailureMessage?: (payload: TPayload) => string | undefined;
  } & GuardedProviderRequestParams,
): Promise<TPayload> {
  const bodyReadOptions = createProviderOperationBodyReadOptions({
    deadline: params.deadline,
    defaultTimeoutMs: params.defaultTimeoutMs,
  });
  for (let attempt = 0; attempt < params.maxAttempts; attempt += 1) {
    const init = {
      method: "GET",
      headers: typeof params.headers === "function" ? params.headers() : params.headers,
    };
    const timeoutMs = createProviderOperationTimeoutResolver({
      deadline: params.deadline,
      defaultTimeoutMs: params.defaultTimeoutMs,
    });
    const guardedOptions = resolveGuardedRequestOptions(params);
    const payload = guardedOptions
      ? await (async () => {
          const result = await fetchGuardedProviderOperationResponse({
            stage: "poll",
            url: params.url,
            init,
            timeoutMs,
            fetchFn: params.fetchFn,
            requestFailedMessage: params.requestFailedMessage,
            guardedOptions,
          });
          try {
            return (await readProviderJsonObjectResponse(
              result.response,
              params.requestFailedMessage,
              bodyReadOptions,
            )) as TPayload;
          } finally {
            await result.release();
          }
        })()
      : ((await readProviderJsonObjectResponse(
          await fetchProviderOperationResponse({
            stage: "poll",
            url: params.url,
            init,
            timeoutMs,
            fetchFn: params.fetchFn,
            requestFailedMessage: params.requestFailedMessage,
          }),
          params.requestFailedMessage,
          bodyReadOptions,
        )) as TPayload);
    if (params.isComplete(payload)) {
      return payload;
    }
    const failureMessage = params.getFailureMessage?.(payload);
    if (failureMessage) {
      throw new Error(failureMessage);
    }
    await waitProviderOperationPollInterval({
      deadline: params.deadline,
      pollIntervalMs: params.pollIntervalMs,
    });
  }
  throw new Error(params.timeoutMessage);
}

export async function fetchProviderOperationResponse(params: {
  stage: ProviderOperationRetryStage;
  url: string;
  init?: RequestInit;
  timeoutMs?: ProviderOperationTimeoutMs;
  fetchFn: typeof fetch;
  provider?: string;
  requestFailedMessage?: string;
  retry?: TransientProviderRetryConfig;
}): Promise<Response> {
  return await executeProviderOperationWithRetry({
    provider: params.provider ?? "provider-http",
    stage: params.stage,
    retry: params.retry,
    operation: async () => {
      const timeoutMs = resolveProviderRequestTimeoutMs({
        timeoutMs: params.timeoutMs,
        defaultTimeoutMs: DEFAULT_GUARDED_HTTP_TIMEOUT_MS,
      });
      const requestDeadline = createProviderOperationDeadline({
        timeoutMs,
        label: params.requestFailedMessage ?? `${params.provider ?? "provider"} ${params.stage}`,
      });
      const response = await fetchWithTimeout(
        params.url,
        params.init ?? {},
        timeoutMs,
        params.fetchFn,
      );
      if (params.requestFailedMessage) {
        await assertOkOrThrowHttpError(response, params.requestFailedMessage, {
          bodyTimeoutMs: createProviderOperationTimeoutResolver({
            deadline: requestDeadline,
            defaultTimeoutMs: timeoutMs,
          }),
          onBodyTimeout: () => createProviderOperationTimeoutError(requestDeadline),
        });
      }
      return response;
    },
  });
}

/**
 * Fetches generated-asset response headers and bounded error details under an absolute deadline.
 * Successful-body readers must reuse the same deadline so header time cannot reset the budget.
 */
export async function fetchProviderDownloadResponse(params: {
  url: string;
  init?: RequestInit;
  deadline?: ProviderOperationDeadline;
  /** @deprecated Pass `deadline` so successful-body reads can reuse the same total budget. */
  timeoutMs?: ProviderOperationTimeoutMs;
  fetchFn: typeof fetch;
  provider?: string;
  requestFailedMessage: string;
  retry?: TransientProviderRetryConfig;
}): Promise<Response> {
  // timeoutMs is a shipped Plugin SDK contract. Normalize it at this boundary;
  // new callers pass the deadline through to their successful-body reader.
  const deadline =
    params.deadline ??
    createProviderOperationDeadline({
      timeoutMs: params.timeoutMs,
      label: params.requestFailedMessage,
    });
  return await fetchProviderOperationResponse({
    stage: "download",
    url: params.url,
    init: params.init,
    timeoutMs: createProviderOperationTimeoutResolver({
      deadline,
      defaultTimeoutMs: deadline.timeoutMs ?? DEFAULT_GUARDED_HTTP_TIMEOUT_MS,
    }),
    fetchFn: params.fetchFn,
    provider: params.provider,
    requestFailedMessage: params.requestFailedMessage,
    retry: params.retry,
  });
}

function resolveGuardedHttpTimeoutMs(timeoutMs: number | undefined): number {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return DEFAULT_GUARDED_HTTP_TIMEOUT_MS;
  }
  return timeoutMs;
}

function sanitizeAuditContext(auditContext: string | undefined): string | undefined {
  const cleaned = auditContext
    ?.replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) {
    return undefined;
  }
  return truncateUtf16Safe(cleaned, MAX_AUDIT_CONTEXT_CHARS);
}

type ResolvedProviderHttpRequestConfig = {
  baseUrl: string;
  allowPrivateNetwork: boolean;
  headers: Headers;
  dispatcherPolicy?: PinnedDispatcherPolicy;
  requestConfig: ResolvedProviderRequestConfig;
};

type ResolvedProviderHttpRequestConfigWithOriginTrust = ResolvedProviderHttpRequestConfig & {
  trustConfiguredBaseUrlOrigin: boolean;
};

function resolveProviderHttpRequestConfigWithOriginTrustInternal(params: {
  baseUrl?: string;
  defaultBaseUrl: string;
  allowPrivateNetwork?: boolean;
  headers?: HeadersInit;
  defaultHeaders?: Record<string, string>;
  request?: ModelProviderRequestTransportOverrides;
  provider?: string;
  api?: string;
  capability?: ProviderRequestCapability;
  transport?: ProviderRequestTransport;
}): ResolvedProviderHttpRequestConfigWithOriginTrust {
  const requestConfig = resolveProviderRequestPolicyConfig({
    provider: params.provider ?? "",
    baseUrl: params.baseUrl,
    defaultBaseUrl: params.defaultBaseUrl,
    capability: params.capability ?? "other",
    transport: params.transport ?? "http",
    callerHeaders: params.headers
      ? Object.fromEntries(new Headers(params.headers).entries())
      : undefined,
    providerHeaders: params.defaultHeaders,
    precedence: "caller-wins",
    allowPrivateNetwork: params.allowPrivateNetwork,
    api: params.api,
    request: params.request,
  });
  const headers = new Headers(requestConfig.headers);
  if (!requestConfig.baseUrl) {
    throw new Error("Missing baseUrl: provide baseUrl or defaultBaseUrl");
  }

  return {
    baseUrl: requestConfig.baseUrl,
    allowPrivateNetwork: requestConfig.allowPrivateNetwork,
    headers,
    dispatcherPolicy: buildProviderRequestDispatcherPolicy(requestConfig),
    requestConfig,
    trustConfiguredBaseUrlOrigin:
      !requestConfig.privateNetworkExplicitlyDenied &&
      (requestConfig.policy.endpointClass === "custom" ||
        requestConfig.policy.endpointClass === "local"),
  };
}

export function resolveProviderHttpRequestConfig(
  params: Parameters<typeof resolveProviderHttpRequestConfigWithOriginTrustInternal>[0],
): ResolvedProviderHttpRequestConfig {
  const resolved = resolveProviderHttpRequestConfigWithOriginTrustInternal(params);
  return {
    baseUrl: resolved.baseUrl,
    allowPrivateNetwork: resolved.allowPrivateNetwork,
    headers: resolved.headers,
    dispatcherPolicy: resolved.dispatcherPolicy,
    requestConfig: resolved.requestConfig,
  };
}

export function resolveProviderHttpRequestConfigWithOriginTrust(
  params: Parameters<typeof resolveProviderHttpRequestConfigWithOriginTrustInternal>[0],
): ResolvedProviderHttpRequestConfigWithOriginTrust {
  return resolveProviderHttpRequestConfigWithOriginTrustInternal(params);
}

/**
 * Decide whether to auto-upgrade a provider HTTP request into
 * `TRUSTED_ENV_PROXY` mode based on the runtime environment.
 *
 * This is gated conservatively to avoid the SSRF bypasses the initial
 * auto-upgrade path exposed (see openclaw#64974 review threads):
 *
 * 1. If the caller supplied an explicit `dispatcherPolicy` — custom proxy URL,
 *    `proxyTls`, or `connect` options — do NOT override it. Trusted-env mode
 *    builds an `EnvHttpProxyAgent` that would silently drop those overrides,
 *    breaking enterprise proxy/mTLS configs.
 *
 * 2. Only auto-upgrade when `HTTP_PROXY` or `HTTPS_PROXY` (lower- or
 *    upper-case) is configured for the target protocol. `ALL_PROXY` is
 *    explicitly ignored by `EnvHttpProxyAgent`, so counting it would
 *    auto-upgrade requests that then make direct connections while skipping
 *    pinned-DNS/SSRF hostname checks.
 *
 * 3. If `NO_PROXY` would bypass the proxy for this target, do NOT auto-upgrade.
 *    `EnvHttpProxyAgent` makes direct connections for `NO_PROXY` matches, but
 *    in `TRUSTED_ENV_PROXY` mode `fetchWithSsrFGuard` skips
 *    `resolvePinnedHostnameWithPolicy` — so those direct connections would
 *    bypass SSRF protection. Keep strict mode for `NO_PROXY` matches.
 */
function shouldAutoUpgradeToTrustedEnvProxy(params: {
  url: string;
  dispatcherPolicy: PinnedDispatcherPolicy | undefined;
}): boolean {
  if (params.dispatcherPolicy) {
    return false;
  }

  return shouldUseEnvHttpProxyForUrl(params.url);
}

export async function fetchWithTimeoutGuarded(
  url: string,
  init: RequestInit,
  timeoutMs: number | undefined,
  fetchFn: typeof fetch,
  options?: {
    ssrfPolicy?: SsrFPolicy;
    lookupFn?: LookupFn;
    pinDns?: boolean;
    dispatcherPolicy?: PinnedDispatcherPolicy;
    auditContext?: string;
    mode?: GuardedFetchMode;
  },
): Promise<GuardedFetchResult> {
  // Provider HTTP helpers (image/music/video generation, transcription, etc.)
  // call this function from every provider that talks to a remote API. When
  // the host has HTTP_PROXY/HTTPS_PROXY configured, the lower-level strict
  // mode would force Node-level `dns.lookup()` on the target hostname before
  // dialing the proxy — which fails with EAI_AGAIN in proxy-only environments
  // (containers, restricted sandboxes, corporate networks with DNS-over-proxy,
  // Clash TUN fake-IP, etc.). Auto-upgrade to trusted env proxy mode in that
  // case so the request goes through the configured proxy agent instead of
  // doing a local DNS pre-resolution.
  //
  // This does not weaken SSRF protection when the auto-upgrade fires: an HTTP
  // CONNECT proxy on the egress path performs hostname resolution itself and
  // client-side DNS pinning cannot meaningfully constrain the target IP. But
  // the auto-upgrade is gated (see `shouldAutoUpgradeToTrustedEnvProxy`) to
  // avoid three SSRF-bypass edge cases: caller-provided `dispatcherPolicy`,
  // `ALL_PROXY`-only envs, and `NO_PROXY` target matches. Callers that
  // explicitly need strict pinned-DNS can still opt in by passing
  // `mode: GUARDED_FETCH_MODE.STRICT` here or by using `fetchWithSsrFGuard`
  // directly.
  //
  // See openclaw#52162 for the reported failure mode on memory embeddings,
  // which shares this code path with image/music/video/audio generation.
  const resolvedMode =
    options?.mode ??
    (shouldAutoUpgradeToTrustedEnvProxy({
      url,
      dispatcherPolicy: options?.dispatcherPolicy,
    })
      ? GUARDED_FETCH_MODE.TRUSTED_ENV_PROXY
      : undefined);
  return await fetchWithSsrFGuard({
    url,
    fetchImpl: fetchFn,
    init,
    timeoutMs: resolveGuardedHttpTimeoutMs(timeoutMs),
    policy: options?.ssrfPolicy,
    lookupFn: options?.lookupFn,
    pinDns: options?.pinDns,
    dispatcherPolicy: options?.dispatcherPolicy,
    auditContext: sanitizeAuditContext(options?.auditContext),
    ...(resolvedMode ? { mode: resolvedMode } : {}),
  });
}

type GuardedProviderRequestOptions = NonNullable<Parameters<typeof fetchWithTimeoutGuarded>[4]>;

function mergeGuardedRequestSsrfPolicy(params: {
  ssrfPolicy?: SsrFPolicy;
  allowPrivateNetwork?: boolean;
}): SsrFPolicy | undefined {
  if (!params.ssrfPolicy) {
    return params.allowPrivateNetwork ? { allowPrivateNetwork: true } : undefined;
  }
  if (!params.allowPrivateNetwork) {
    return params.ssrfPolicy;
  }
  return { ...params.ssrfPolicy, allowPrivateNetwork: true };
}

function resolveGuardedRequestOptions(
  params: GuardedProviderRequestParams,
): GuardedProviderRequestOptions | undefined {
  if (
    !params.allowPrivateNetwork &&
    !params.ssrfPolicy &&
    !params.dispatcherPolicy &&
    params.pinDns === undefined &&
    !params.auditContext &&
    params.mode === undefined
  ) {
    return undefined;
  }
  const ssrfPolicy = mergeGuardedRequestSsrfPolicy(params);
  return {
    ...(ssrfPolicy ? { ssrfPolicy } : {}),
    ...(params.pinDns !== undefined ? { pinDns: params.pinDns } : {}),
    ...(params.dispatcherPolicy ? { dispatcherPolicy: params.dispatcherPolicy } : {}),
    ...(params.auditContext ? { auditContext: params.auditContext } : {}),
    ...(params.mode !== undefined ? { mode: params.mode } : {}),
  };
}

async function fetchGuardedProviderOperationResponse(params: {
  stage: ProviderOperationRetryStage;
  url: string;
  init: RequestInit;
  timeoutMs?: ProviderOperationTimeoutMs;
  fetchFn: typeof fetch;
  provider?: string;
  requestFailedMessage?: string;
  retry?: TransientProviderRetryConfig;
  guardedOptions: GuardedProviderRequestOptions;
}): Promise<GuardedFetchResult> {
  return await executeProviderOperationWithRetry({
    provider: params.provider ?? "provider-http",
    stage: params.stage,
    retry: params.retry,
    operation: async () => {
      const timeoutMs = resolveProviderRequestTimeoutMs({
        timeoutMs: params.timeoutMs,
        defaultTimeoutMs: DEFAULT_GUARDED_HTTP_TIMEOUT_MS,
      });
      const requestDeadline = createProviderOperationDeadline({
        timeoutMs,
        label: params.requestFailedMessage ?? `${params.provider ?? "provider"} ${params.stage}`,
      });
      const result = await fetchWithTimeoutGuarded(
        params.url,
        params.init,
        timeoutMs,
        params.fetchFn,
        params.guardedOptions,
      );
      try {
        if (params.requestFailedMessage) {
          await assertOkOrThrowHttpError(result.response, params.requestFailedMessage, {
            bodyTimeoutMs: createProviderOperationTimeoutResolver({
              deadline: requestDeadline,
              defaultTimeoutMs: timeoutMs,
            }),
            onBodyTimeout: () => createProviderOperationTimeoutError(requestDeadline),
          });
        }
        return result;
      } catch (error) {
        await result.release();
        throw error;
      }
    },
  });
}

type GuardedPostRequestRetryOptions = {
  /**
   * POST requests default to no retry because many provider endpoints create
   * billable jobs. Pass "read" only for read/analysis POST endpoints.
   */
  retryStage?: ProviderOperationRetryStage;
  retry?: TransientProviderRetryConfig;
};

type GuardedPostRequestParams<TBody> = GuardedProviderRequestParams &
  GuardedPostRequestRetryOptions & {
    url: string;
    headers: Headers;
    body: TBody;
    timeoutMs?: number;
    fetchFn: typeof fetch;
  };

export async function postTranscriptionRequest(params: GuardedPostRequestParams<BodyInit>) {
  return await postGuardedRequest({
    url: params.url,
    init: {
      method: "POST",
      headers: params.headers,
      body: params.body,
    },
    timeoutMs: params.timeoutMs,
    fetchFn: params.fetchFn,
    guardedOptions: resolveGuardedRequestOptions(params),
    retryStage: params.retryStage,
    retry: params.retry,
  });
}

async function postGuardedRequest(params: {
  url: string;
  init: RequestInit;
  timeoutMs?: number;
  fetchFn: typeof fetch;
  guardedOptions?: GuardedProviderRequestOptions;
  retryStage?: ProviderOperationRetryStage;
  retry?: TransientProviderRetryConfig;
}) {
  const operation = async () => {
    const result = await fetchWithTimeoutGuarded(
      params.url,
      params.init,
      params.timeoutMs,
      params.fetchFn,
      params.guardedOptions,
    );
    if (params.retryStage && isTransientProviderHttpStatus(result.response.status)) {
      try {
        throw await createProviderHttpError(result.response, "provider POST request failed", {
          statusPrefix: "HTTP ",
        });
      } finally {
        await result.release();
      }
    }
    return result;
  };
  if (!params.retryStage) {
    return await operation();
  }
  return await executeProviderOperationWithRetry({
    provider: "provider-http",
    stage: params.retryStage,
    retry: params.retry,
    operation,
  });
}

export async function postJsonRequest(params: GuardedPostRequestParams<unknown>) {
  return await postGuardedRequest({
    url: params.url,
    init: {
      method: "POST",
      headers: params.headers,
      body: JSON.stringify(params.body),
    },
    timeoutMs: params.timeoutMs,
    fetchFn: params.fetchFn,
    guardedOptions: resolveGuardedRequestOptions(params),
    retryStage: params.retryStage,
    retry: params.retry,
  });
}

export async function postMultipartRequest(params: GuardedPostRequestParams<BodyInit>) {
  return await postGuardedRequest({
    url: params.url,
    init: {
      method: "POST",
      headers: params.headers,
      body: params.body,
    },
    timeoutMs: params.timeoutMs,
    fetchFn: params.fetchFn,
    guardedOptions: resolveGuardedRequestOptions(params),
    retryStage: params.retryStage,
    retry: params.retry,
  });
}

export function requireTranscriptionText(
  value: string | undefined,
  missingMessage: string,
): string {
  const text = value?.trim();
  if (!text) {
    throw new Error(missingMessage);
  }
  return text;
}
