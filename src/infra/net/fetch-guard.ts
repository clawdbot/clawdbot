import type { Dispatcher } from "undici";
import { logWarn } from "../../logger.js";
import { captureHttpExchange } from "../../proxy-capture/runtime.js";
import { buildTimeoutAbortSignal } from "../../utils/fetch-timeout.js";
import { hasProxyEnvConfigured } from "./proxy-env.js";
import { retainSafeHeadersForCrossOriginRedirect as retainSafeRedirectHeaders } from "./redirect-headers.js";
import {
  fetchWithRuntimeDispatcher,
  isMockedFetch,
  type DispatcherAwareRequestInit,
} from "./runtime-fetch.js";
import {
  assertHostnameAllowedWithPolicy,
  closeDispatcher,
  createPinnedDispatcher,
  resolvePinnedHostnameWithPolicy,
  type LookupFn,
  type PinnedDispatcherPolicy,
  SsrFBlockedError,
  type SsrFPolicy,
} from "./ssrf.js";
import {
  createHttp1Agent,
  createHttp1EnvHttpProxyAgent,
  createHttp1ProxyAgent,
} from "./undici-runtime.js";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export const GUARDED_FETCH_MODE = {
  STRICT: "strict",
  TRUSTED_ENV_PROXY: "trusted_env_proxy",
  TRUSTED_EXPLICIT_PROXY: "trusted_explicit_proxy",
} as const;

export type GuardedFetchMode = (typeof GUARDED_FETCH_MODE)[keyof typeof GUARDED_FETCH_MODE];

export type GuardedFetchOptions = {
  url: string;
  fetchImpl?: FetchLike;
  init?: RequestInit;
  capture?:
    | false
    | {
        flowId?: string;
        meta?: Record<string, unknown>;
      };
  maxRedirects?: number;
  /**
   * Allow replaying unsafe request methods and bodies across cross-origin redirects.
   * Sensitive cross-origin headers (for example Authorization/Cookie) are still stripped.
   * Defaults to false.
   */
  allowCrossOriginUnsafeRedirectReplay?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  policy?: SsrFPolicy;
  lookupFn?: LookupFn;
  dispatcherPolicy?: PinnedDispatcherPolicy;
  mode?: GuardedFetchMode;
  pinDns?: boolean;
  /** @deprecated use `mode: "trusted_env_proxy"` for trusted/operator-controlled URLs. */
  proxy?: "env";
  /**
   * @deprecated use `mode: "trusted_env_proxy"` instead.
   */
  dangerouslyAllowEnvProxyWithoutPinnedDns?: boolean;
  auditContext?: string;
};

export type GuardedFetchResult = {
  response: Response;
  finalUrl: string;
  release: () => Promise<void>;
};

type GuardedFetchPresetOptions = Omit<
  GuardedFetchOptions,
  "mode" | "proxy" | "dangerouslyAllowEnvProxyWithoutPinnedDns"
>;

const DEFAULT_MAX_REDIRECTS = 3;

export function withStrictGuardedFetchMode(params: GuardedFetchPresetOptions): GuardedFetchOptions {
  return { ...params, mode: GUARDED_FETCH_MODE.STRICT };
}

export function withTrustedEnvProxyGuardedFetchMode(
  params: GuardedFetchPresetOptions,
): GuardedFetchOptions {
  return { ...params, mode: GUARDED_FETCH_MODE.TRUSTED_ENV_PROXY };
}

export function withTrustedExplicitProxyGuardedFetchMode(
  params: GuardedFetchPresetOptions,
): GuardedFetchOptions {
  return { ...params, mode: GUARDED_FETCH_MODE.TRUSTED_EXPLICIT_PROXY };
}

function resolveGuardedFetchMode(params: GuardedFetchOptions): GuardedFetchMode {
  if (params.mode) {
    return params.mode;
  }
  if (params.proxy === "env" && params.dangerouslyAllowEnvProxyWithoutPinnedDns === true) {
    return GUARDED_FETCH_MODE.TRUSTED_ENV_PROXY;
  }
  return GUARDED_FETCH_MODE.STRICT;
}

function assertExplicitProxySupportsPinnedDns(
  url: URL,
  dispatcherPolicy?: PinnedDispatcherPolicy,
  pinDns?: boolean,
): void {
  if (
    pinDns !== false &&
    dispatcherPolicy?.mode === "explicit-proxy" &&
    url.protocol !== "https:"
  ) {
    throw new Error(
      "Explicit proxy SSRF pinning requires HTTPS targets; plain HTTP targets are not supported",
    );
  }
}

function createPolicyDispatcherWithoutPinnedDns(
  dispatcherPolicy?: PinnedDispatcherPolicy,
): Dispatcher | null {
  if (!dispatcherPolicy) {
    return null;
  }

  if (dispatcherPolicy.mode === "direct") {
    return createHttp1Agent(
      dispatcherPolicy.connect ? { connect: { ...dispatcherPolicy.connect } } : undefined,
    );
  }

  if (dispatcherPolicy.mode === "env-proxy") {
    return createHttp1EnvHttpProxyAgent({
      ...(dispatcherPolicy.connect ? { connect: { ...dispatcherPolicy.connect } } : {}),
      ...(dispatcherPolicy.proxyTls ? { proxyTls: { ...dispatcherPolicy.proxyTls } } : {}),
    });
  }

  const proxyUrl = dispatcherPolicy.proxyUrl.trim();
  return dispatcherPolicy.proxyTls
    ? createHttp1ProxyAgent({
        uri: proxyUrl,
        requestTls: { ...dispatcherPolicy.proxyTls },
      })
    : createHttp1ProxyAgent({ uri: proxyUrl });
}

async function assertExplicitProxyAllowed(
  dispatcherPolicy: PinnedDispatcherPolicy | undefined,
  lookupFn: LookupFn | undefined,
  policy: SsrFPolicy | undefined,
): Promise<void> {
  if (!dispatcherPolicy || dispatcherPolicy.mode !== "explicit-proxy") {
    return;
  }
  let parsedProxyUrl: URL;
  try {
    parsedProxyUrl = new URL(dispatcherPolicy.proxyUrl);
  } catch {
    throw new Error("Invalid explicit proxy URL");
  }
  if (!["http:", "https:"].includes(parsedProxyUrl.protocol)) {
    throw new Error("Explicit proxy URL must use http or https");
  }
  await resolvePinnedHostnameWithPolicy(parsedProxyUrl.hostname, {
    lookupFn,
    policy:
      dispatcherPolicy.allowPrivateProxy === true
        ? {
            // The proxy hostname is operator-configured, not user input.
            // Clear the target-scoped hostnameAllowlist so configured proxies
            // like localhost or internal hosts aren't rejected by an allowlist
            // that was built for the target URL (e.g. api.telegram.org).
            // Private-network IP checks still apply via allowPrivateNetwork.
            ...policy,
            allowPrivateNetwork: true,
            hostnameAllowlist: undefined,
          }
        : policy,
  });
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function isAmbientGlobalFetch(params: {
  fetchImpl: FetchLike | undefined;
  globalFetch: FetchLike | undefined;
}): boolean {
  return (
    typeof params.fetchImpl === "function" &&
    typeof params.globalFetch === "function" &&
    params.fetchImpl === params.globalFetch
  );
}

export function retainSafeHeadersForCrossOriginRedirectHeaders(
  headers?: HeadersInit,
): Record<string, string> | undefined {
  return retainSafeRedirectHeaders(headers);
}

function retainSafeHeadersForCrossOriginRedirect(init?: RequestInit): RequestInit | undefined {
  if (!init?.headers) {
    return init;
  }
  return { ...init, headers: retainSafeRedirectHeaders(init.headers) };
}

function dropBodyHeaders(headers?: HeadersInit): HeadersInit | undefined {
  if (!headers) {
    return headers;
  }
  const nextHeaders = new Headers(headers);
  nextHeaders.delete("content-encoding");
  nextHeaders.delete("content-language");
  nextHeaders.delete("content-length");
  nextHeaders.delete("content-location");
  nextHeaders.delete("content-type");
  nextHeaders.delete("transfer-encoding");
  return nextHeaders;
}

function rewriteRedirectInitForMethod(params: {
  init?: RequestInit;
  status: number;
}): RequestInit | undefined {
  const { init, status } = params;
  if (!init) {
    return init;
  }

  const currentMethod = init.method?.toUpperCase() ?? "GET";
  const shouldForceGet =
    status === 303
      ? currentMethod !== "GET" && currentMethod !== "HEAD"
      : (status === 301 || status === 302) && currentMethod === "POST";

  if (!shouldForceGet) {
    return init;
  }

  return {
    ...init,
    method: "GET",
    body: undefined,
    headers: dropBodyHeaders(init.headers),
  };
}

function rewriteRedirectInitForCrossOrigin(params: {
  init?: RequestInit;
  allowUnsafeReplay: boolean;
}): RequestInit | undefined {
  const { init, allowUnsafeReplay } = params;
  if (!init || allowUnsafeReplay) {
    return init;
  }

  const currentMethod = init.method?.toUpperCase() ?? "GET";
  if (currentMethod === "GET" || currentMethod === "HEAD") {
    return init;
  }

  return {
    ...init,
    body: undefined,
    headers: dropBodyHeaders(init.headers),
  };
}

export { fetchWithRuntimeDispatcher } from "./runtime-fetch.js";

export async function fetchWithSsrFGuard(params: GuardedFetchOptions): Promise<GuardedFetchResult> {
  const defaultFetch: FetchLike | undefined = params.fetchImpl ?? globalThis.fetch;
  if (!defaultFetch) {
    throw new Error("fetch is not available");
  }

  const maxRedirects =
    typeof params.maxRedirects === "number" && Number.isFinite(params.maxRedirects)
      ? Math.max(0, Math.floor(params.maxRedirects))
      : DEFAULT_MAX_REDIRECTS;
  const mode = resolveGuardedFetchMode(params);

  const { signal, cleanup } = buildTimeoutAbortSignal({
    timeoutMs: params.timeoutMs,
    signal: params.signal,
  });

  let released = false;
  const release = async (dispatcher?: Dispatcher | null) => {
    if (released) {
      return;
    }
    released = true;
    cleanup();
    await closeDispatcher(dispatcher ?? undefined);
  };

  const visited = new Set<string>([params.url]);
  let currentUrl = params.url;
  let currentInit = params.init ? { ...params.init } : undefined;
  let redirectCount = 0;

  while (true) {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(currentUrl);
    } catch {
      await release();
      throw new Error("Invalid URL: must be http or https");
    }
    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      await release();
      throw new Error("Invalid URL: must be http or https");
    }

    let dispatcher: Dispatcher | null = null;
    try {
      const usesTrustedExplicitProxyMode =
        mode === GUARDED_FETCH_MODE.TRUSTED_EXPLICIT_PROXY &&
        params.dispatcherPolicy?.mode === "explicit-proxy";
      assertExplicitProxySupportsPinnedDns(
        parsedUrl,
        params.dispatcherPolicy,
        usesTrustedExplicitProxyMode ? false : params.pinDns,
      );
      await assertExplicitProxyAllowed(params.dispatcherPolicy, params.lookupFn, params.policy);
      const canUseTrustedEnvProxy =
        mode === GUARDED_FETCH_MODE.TRUSTED_ENV_PROXY && hasProxyEnvConfigured();
      if (canUseTrustedEnvProxy) {
        dispatcher = createHttp1EnvHttpProxyAgent();
      } else if (usesTrustedExplicitProxyMode) {
        // Explicit proxy targets are still checked against the caller's hostname
        // policy, but the proxy does the DNS resolution for the final target.
        assertHostnameAllowedWithPolicy(parsedUrl.hostname, params.policy);
        dispatcher = createPolicyDispatcherWithoutPinnedDns(params.dispatcherPolicy);
      } else if (params.pinDns === false) {
        await resolvePinnedHostnameWithPolicy(parsedUrl.hostname, {
          lookupFn: params.lookupFn,
          policy: params.policy,
        });
        dispatcher = createPolicyDispatcherWithoutPinnedDns(params.dispatcherPolicy);
      } else {
        const pinned = await resolvePinnedHostnameWithPolicy(parsedUrl.hostname, {
          lookupFn: params.lookupFn,
          policy: params.policy,
        });
        dispatcher = createPinnedDispatcher(pinned, params.dispatcherPolicy, params.policy);
      }

      const init: DispatcherAwareRequestInit = {
        ...(currentInit ? { ...currentInit } : {}),
        redirect: "manual",
        ...(dispatcher ? { dispatcher } : {}),
        ...(signal ? { signal } : {}),
      };

      const supportsDispatcherInit =
        (params.fetchImpl !== undefined &&
          !isAmbientGlobalFetch({
            fetchImpl: params.fetchImpl,
            globalFetch: globalThis.fetch,
          })) ||
        isMockedFetch(defaultFetch);
      // Explicit caller stubs and test-installed fetch mocks should win.
      // Otherwise, fall back to undici's fetch whenever we attach a dispatcher,
      // because the default global fetch path will not honor per-request
      // dispatchers.
      const shouldUseRuntimeFetch = Boolean(dispatcher) && !supportsDispatcherInit;
      const response = shouldUseRuntimeFetch
        ? await fetchWithRuntimeDispatcher(parsedUrl.toString(), init)
        : await defaultFetch(parsedUrl.toString(), init);

      if (params.capture !== false) {
        captureHttpExchange({
          url: parsedUrl.toString(),
          method: currentInit?.method ?? "GET",
          requestHeaders: currentInit?.headers as Headers | Record<string, string> | undefined,
          requestBody:
            (currentInit as (RequestInit & { body?: BodyInit | null }) | undefined)?.body ?? null,
          response,
          transport: "http",
          flowId: params.capture?.flowId,
          meta: {
            captureOrigin: "guarded-fetch",
            ...(params.auditContext ? { auditContext: params.auditContext } : {}),
            ...params.capture?.meta,
          },
        });
      }

      if (isRedirectStatus(response.status)) {
        const location = response.headers.get("location");
        if (!location) {
          await release(dispatcher);
          throw new Error(`Redirect missing location header (${response.status})`);
        }
        redirectCount += 1;
        if (redirectCount > maxRedirects) {
          await release(dispatcher);
          throw new Error(`Too many redirects (limit: ${maxRedirects})`);
        }
        const nextParsedUrl = new URL(location, parsedUrl);
        const nextUrl = nextParsedUrl.toString();
        if (visited.has(nextUrl)) {
          await release(dispatcher);
          throw new Error("Redirect loop detected");
        }
        currentInit = rewriteRedirectInitForMethod({ init: currentInit, status: response.status });
        if (nextParsedUrl.origin !== parsedUrl.origin) {
          currentInit = rewriteRedirectInitForCrossOrigin({
            init: currentInit,
            allowUnsafeReplay: params.allowCrossOriginUnsafeRedirectReplay === true,
          });
          currentInit = retainSafeHeadersForCrossOriginRedirect(currentInit);
        }
        visited.add(nextUrl);
        void response.body?.cancel();
        await closeDispatcher(dispatcher);
        currentUrl = nextUrl;
        continue;
      }

      return {
        response,
        finalUrl: currentUrl,
        release: async () => release(dispatcher),
      };
    } catch (err) {
      if (err instanceof SsrFBlockedError) {
        const context = params.auditContext ?? "url-fetch";
        logWarn(
          `security: blocked URL fetch (${context}) target=${parsedUrl.origin}${parsedUrl.pathname} reason=${err.message}`,
        );
      }
      await release(dispatcher);
      throw err;
    }
  }
}
