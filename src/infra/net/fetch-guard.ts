// Guarded fetch runtime enforces SSRF checks, DNS pinning, redirect policy, and
// trusted proxy modes around provider/network requests.
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import type { Dispatcher } from "undici";
import { logWarn } from "../../logger.js";
import { buildTimeoutAbortSignal } from "../../utils/fetch-timeout.js";
import {
  normalizeHeadersInitForFetch,
  normalizeRequestInitHeadersForFetch,
} from "../fetch-headers.js";
import { cancelUnreadResponseBody } from "../http-body.js";
import {
  shouldUseConfiguredLocalOriginManagedProxyBypass,
  shouldResolveConfiguredLocalOriginManagedProxyBypass,
  type ConfiguredLocalOriginManagedProxyBypass,
} from "./configured-local-origin-bypass.js";
import { PinnedDispatcherPool, type PinnedDispatcherLease } from "./pinned-dispatcher-pool.js";
import { shouldUseEnvHttpProxyForUrl } from "./proxy-env.js";
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
  matchesHostnameAllowlist,
  resolveSsrFPolicyForUrl,
  resolvePinnedHostnameWithPolicy,
  type LookupFn,
  type PinnedDispatcherPolicy,
  SsrFBlockedError,
  type SsrFPolicy,
} from "./ssrf.js";
import { resolveUndiciAutoSelectFamilyConnectOptions } from "./undici-family-policy.js";
import { globalUndiciStreamTimeoutMs } from "./undici-global-dispatcher.js";
import {
  createHttp1Agent,
  createHttp1EnvHttpProxyAgent,
  createHttp1ProxyAgent,
} from "./undici-runtime.js";

function resolveDispatcherTimeoutMs(fromParams: number | undefined): number | undefined {
  if (fromParams !== undefined) {
    return fromParams;
  }
  // Fall back to module-level bridge set by ensureGlobalUndiciStreamTimeouts
  // (avoids reading Undici's non-public `.options` field)
  if (globalUndiciStreamTimeoutMs !== undefined) {
    return globalUndiciStreamTimeoutMs;
  }
  return undefined;
}

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
  /** Final synchronous check after transport preparation and before each request or redirect. */
  beforeRequest?: () => void | undefined;
  init?: RequestInit;
  capture?:
    | false
    | {
        flowId?: string;
        meta?: Record<string, unknown>;
        sensitiveRequestHeaderNames?: readonly string[];
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
  requireHttps?: boolean;
  policy?: SsrFPolicy;
  lookupFn?: LookupFn;
  dispatcherPolicy?: PinnedDispatcherPolicy;
  /** Resolve a synchronous per-hop override so redirects can change proxy or direct routing. */
  resolveDispatcherPolicy?: (url: URL) => PinnedDispatcherPolicy | undefined;
  retainAuthorizationRedirectHostnameAllowlist?: string[];
  mode?: GuardedFetchMode;
  pinDns?: boolean;
  /** @deprecated use `mode: "trusted_env_proxy"` for trusted/operator-controlled URLs. */
  proxy?: "env";
  /**
   * @deprecated use `mode: "trusted_env_proxy"` instead.
   */
  dangerouslyAllowEnvProxyWithoutPinnedDns?: boolean;
  auditContext?: string;
  /** Internal opt-in for reusing freshly revalidated, direct pinned dispatchers. */
  dispatcherPool?: PinnedDispatcherPool;
};

export type GuardedFetchResult = {
  response: Response;
  finalUrl: string;
  release: () => Promise<void>;
  refreshTimeout?: () => void;
  dispatcherReused?: boolean;
};

export class GuardedFetchRedirectError extends Error {
  readonly status: number;
  readonly maxRedirects: number;

  constructor(params: { status: number; maxRedirects: number }) {
    super(`Too many redirects (limit: ${params.maxRedirects})`);
    this.name = "GuardedFetchRedirectError";
    this.status = params.status;
    this.maxRedirects = params.maxRedirects;
  }
}

type GuardedFetchInternalOptions = GuardedFetchOptions & {
  managedProxyBypass?: ConfiguredLocalOriginManagedProxyBypass;
  /** Preserve ambient Undici env-proxy routing for each eligible URL while keeping strict checks otherwise. */
  useEnvProxyForEligibleUrls?: boolean;
};

type GuardedFetchConfiguredLocalOriginOptions = GuardedFetchOptions & {
  configuredLocalOriginBaseUrl: string;
};

type GuardedFetchPresetOptions = Omit<
  GuardedFetchOptions,
  "mode" | "proxy" | "dangerouslyAllowEnvProxyWithoutPinnedDns"
>;

const DEFAULT_MAX_REDIRECTS = 3;
const OPENCLAW_DEBUG_PROXY_ENABLED = "OPENCLAW_DEBUG_PROXY_ENABLED";

function getRedirectVisitKey(url: string, init: RequestInit | undefined): string {
  return `${init?.method?.toUpperCase() ?? "GET"} ${url}`;
}

function isTruthyEnvValue(value: string | undefined): boolean {
  // This flag relaxes an outbound-network security boundary. Keep exact lowercase
  // tokens so whitespace or case variation cannot accidentally widen access.
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

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
  // Legacy proxy flags map to the explicit trusted env-proxy mode; strict is the
  // default for user-influenced URLs.
  if (params.mode) {
    return params.mode;
  }
  if (params.proxy === "env" && params.dangerouslyAllowEnvProxyWithoutPinnedDns === true) {
    return GUARDED_FETCH_MODE.TRUSTED_ENV_PROXY;
  }
  return GUARDED_FETCH_MODE.STRICT;
}

function isManagedProxyActive(): boolean {
  return process.env["OPENCLAW_PROXY_ACTIVE"] === "1";
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
  timeoutMs?: number,
): Dispatcher | null {
  if (!dispatcherPolicy) {
    return null;
  }

  if (dispatcherPolicy.mode === "direct") {
    return createHttp1Agent(
      dispatcherPolicy.connect ? { connect: { ...dispatcherPolicy.connect } } : undefined,
      timeoutMs,
    );
  }

  if (dispatcherPolicy.mode === "env-proxy") {
    return createHttp1EnvHttpProxyAgent(
      {
        ...(dispatcherPolicy.connect ? { connect: { ...dispatcherPolicy.connect } } : {}),
        ...(dispatcherPolicy.proxyTls ? { proxyTls: { ...dispatcherPolicy.proxyTls } } : {}),
      },
      timeoutMs,
    );
  }

  const proxyUrl = dispatcherPolicy.proxyUrl.trim();
  if (dispatcherPolicy.proxyTls) {
    return createHttp1ProxyAgent(
      { uri: proxyUrl, requestTls: { ...dispatcherPolicy.proxyTls } },
      timeoutMs,
    );
  }
  return createHttp1ProxyAgent({ uri: proxyUrl }, timeoutMs);
}

async function assertExplicitProxyAllowed(
  dispatcherPolicy: PinnedDispatcherPolicy | undefined,
  lookupFn: LookupFn | undefined,
  policy: SsrFPolicy | undefined,
  signal: AbortSignal | undefined,
  trustedProxy: boolean,
): Promise<void> {
  // Explicit proxies are operator-configured, but the proxy host still needs
  // basic URL and private-network validation before target validation proceeds.
  if (!dispatcherPolicy || dispatcherPolicy.mode !== "explicit-proxy") {
    return;
  }
  let parsedProxyUrl: URL;
  try {
    parsedProxyUrl = new URL(dispatcherPolicy.proxyUrl);
  } catch {
    throw new Error("Invalid explicit proxy URL");
  }
  // SOCKS resolves target DNS remotely; only the existing trusted-proxy mode
  // can delegate that check. Strict callers must retain local DNS pinning.
  const trustedSocks = trustedProxy && ["socks:", "socks5:"].includes(parsedProxyUrl.protocol);
  if (!["http:", "https:"].includes(parsedProxyUrl.protocol) && !trustedSocks) {
    throw new Error("Explicit proxy URL must use http or https");
  }
  const proxyPolicy: SsrFPolicy | undefined =
    policy || dispatcherPolicy.allowPrivateProxy === true
      ? {
          ...policy,
          // The proxy hostname is operator-configured, not user input. Target-scoped
          // allowlists must not reject a configured proxy host before the request
          // target gets checked against that same allowlist below.
          hostnameAllowlist: undefined,
          ...(dispatcherPolicy.allowPrivateProxy === true ? { allowPrivateNetwork: true } : {}),
        }
      : undefined;
  await resolvePinnedHostnameWithPolicy(parsedProxyUrl.hostname, {
    lookupFn,
    policy: proxyPolicy,
    signal,
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

async function captureGuardedFetchExchange(params: {
  url: string;
  method: string;
  requestHeaders?: Headers | Record<string, string> | undefined;
  requestBody?: BodyInit | Buffer | string | null;
  response: Response;
  transport?: "http" | "sse";
  capture: GuardedFetchOptions["capture"];
  auditContext?: string;
  capturedByGlobalFetchPatch?: boolean;
}): Promise<void> {
  if (params.capture === false || !isTruthyEnvValue(process.env[OPENCLAW_DEBUG_PROXY_ENABLED])) {
    return;
  }
  const { captureHttpExchange, isDebugProxyGlobalFetchPatchInstalled } =
    await import("../../proxy-capture/runtime.js");
  if (params.capturedByGlobalFetchPatch && isDebugProxyGlobalFetchPatchInstalled()) {
    return;
  }
  captureHttpExchange({
    url: params.url,
    method: params.method,
    requestHeaders: params.requestHeaders,
    requestBody: params.requestBody,
    response: params.response,
    transport: params.transport,
    flowId: params.capture?.flowId,
    meta: {
      captureOrigin: "guarded-fetch",
      ...(params.auditContext ? { auditContext: params.auditContext } : {}),
      ...params.capture?.meta,
      ...(params.capture?.sensitiveRequestHeaderNames
        ? { sensitiveRequestHeaderNames: params.capture.sensitiveRequestHeaderNames }
        : {}),
    },
  });
}

function retainSafeHeadersForCrossOriginRedirect(init?: RequestInit): RequestInit | undefined {
  if (!init?.headers) {
    return init;
  }
  return { ...init, headers: retainSafeRedirectHeaders(init.headers) };
}

function resolveRetainedAuthorizationForRedirect(params: {
  init?: RequestInit;
  nextUrl: URL;
  hostnameAllowlist?: string[];
}): string | undefined {
  const init = params.init;
  if (!init?.headers || !params.hostnameAllowlist?.length) {
    return undefined;
  }
  if (params.nextUrl.protocol !== "https:") {
    return undefined;
  }
  if (
    !params.hostnameAllowlist.includes("*") &&
    !matchesHostnameAllowlist(params.nextUrl.hostname, params.hostnameAllowlist)
  ) {
    return undefined;
  }
  const normalizedInit = normalizeRequestInitHeadersForFetch(init);
  if (!normalizedInit?.headers) {
    return undefined;
  }
  return new Headers(normalizedInit.headers).get("authorization") ?? undefined;
}

function restoreRedirectAuthorization(params: {
  init?: RequestInit;
  authorization?: string;
}): RequestInit | undefined {
  if (!params.authorization) {
    return params.init;
  }
  const headers = new Headers(params.init?.headers);
  headers.set("Authorization", params.authorization);
  return { ...params.init, headers };
}

function dropBodyHeaders(headers?: HeadersInit): HeadersInit | undefined {
  if (!headers) {
    return headers;
  }
  const nextHeaders = new Headers(normalizeHeadersInitForFetch(headers));
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
  const { managedProxyBypass: _ignoredManagedProxyBypass, ...publicParams } =
    params as GuardedFetchOptions & {
      managedProxyBypass?: unknown;
    };
  return await fetchWithSsrFGuardInternal(publicParams);
}

export async function fetchConfiguredLocalOriginWithSsrFGuard({
  configuredLocalOriginBaseUrl,
  ...params
}: GuardedFetchConfiguredLocalOriginOptions): Promise<GuardedFetchResult> {
  return await fetchWithSsrFGuardInternal({
    ...params,
    managedProxyBypass: {
      kind: "configured-local-origin",
      baseUrl: configuredLocalOriginBaseUrl,
    },
  });
}

async function fetchWithSsrFGuardInternal(
  params: GuardedFetchInternalOptions,
): Promise<GuardedFetchResult> {
  const defaultFetch: FetchLike | undefined = params.fetchImpl ?? globalThis.fetch;
  if (!defaultFetch) {
    throw new Error("fetch is not available");
  }
  const isUsingMockedFetch = isMockedFetch(defaultFetch);

  const maxRedirects =
    typeof params.maxRedirects === "number" && Number.isFinite(params.maxRedirects)
      ? Math.max(0, Math.floor(params.maxRedirects))
      : DEFAULT_MAX_REDIRECTS;
  const mode = resolveGuardedFetchMode(params);

  // Compose the caller signal before the deadline can mask init.signal.
  const { signal, cleanup, refresh } = buildTimeoutAbortSignal({
    timeoutMs: params.timeoutMs,
    signal: params.signal ?? params.init?.signal ?? undefined,
    operation: "fetchWithSsrFGuard",
    url: params.url,
  });

  let finished = false;
  const finishRequest = async (releaseDispatcher?: () => Promise<void>) => {
    if (finished) {
      return;
    }
    finished = true;
    cleanup();
    await releaseDispatcher?.();
  };

  let currentUrl = params.url;
  let currentInit = normalizeRequestInitHeadersForFetch(
    params.init ? { ...params.init } : undefined,
  );
  const visited = new Set<string>([getRedirectVisitKey(currentUrl, currentInit)]);
  let redirectCount = 0;

  while (true) {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(currentUrl);
    } catch {
      await finishRequest();
      throw new Error("Invalid URL: must be http or https");
    }
    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      await finishRequest();
      throw new Error("Invalid URL: must be http or https");
    }
    if (params.requireHttps === true && parsedUrl.protocol !== "https:") {
      await finishRequest();
      throw new Error("URL must use https");
    }

    let dispatcher: Dispatcher | null = null;
    let dispatcherLease: PinnedDispatcherLease | undefined;
    let response: Response | undefined;
    const requestController = new AbortController();
    const releaseDispatcher = async () => {
      // Release only this hop's transport, including capture tees, before returning its pool lease.
      requestController.abort();
      await cancelUnreadResponseBody(response);
      await (dispatcherLease ? dispatcherLease.release() : closeDispatcher(dispatcher));
    };
    // Resolve inside the redirect loop so exact-origin trust never carries across origins.
    const policyForUrl = resolveSsrFPolicyForUrl(parsedUrl, params.policy);
    const dispatcherPolicy = params.resolveDispatcherPolicy?.(parsedUrl) ?? params.dispatcherPolicy;
    const resolvePinnedHostname = async () =>
      await resolvePinnedHostnameWithPolicy(parsedUrl.hostname, {
        lookupFn: params.lookupFn,
        policy: policyForUrl,
        signal,
      });
    try {
      const usesTrustedExplicitProxyMode =
        mode === GUARDED_FETCH_MODE.TRUSTED_EXPLICIT_PROXY &&
        dispatcherPolicy?.mode === "explicit-proxy";
      assertExplicitProxySupportsPinnedDns(
        parsedUrl,
        dispatcherPolicy,
        usesTrustedExplicitProxyMode ? false : params.pinDns,
      );
      await assertExplicitProxyAllowed(
        dispatcherPolicy,
        params.lookupFn,
        params.policy,
        signal,
        usesTrustedExplicitProxyMode,
      );
      const isStrictManagedProxyActive =
        mode === GUARDED_FETCH_MODE.STRICT && isManagedProxyActive();
      const shouldCheckManagedProxyBypass =
        isStrictManagedProxyActive &&
        shouldResolveConfiguredLocalOriginManagedProxyBypass({
          url: parsedUrl,
          managedProxyBypass: params.managedProxyBypass,
        });
      const canUseManagedProxy =
        isStrictManagedProxyActive &&
        (shouldUseEnvHttpProxyForUrl(parsedUrl.toString()) || shouldCheckManagedProxyBypass);
      const canUseTrustedEnvProxy =
        (mode === GUARDED_FETCH_MODE.TRUSTED_ENV_PROXY ||
          (params.useEnvProxyForEligibleUrls === true && !canUseManagedProxy)) &&
        !dispatcherPolicy &&
        shouldUseEnvHttpProxyForUrl(parsedUrl.toString());
      const canUseMockedFetchWithoutDns =
        isUsingMockedFetch &&
        params.lookupFn === undefined &&
        !canUseTrustedEnvProxy &&
        !canUseManagedProxy &&
        !usesTrustedExplicitProxyMode &&
        params.pinDns !== false;
      const timeoutMs = resolveDispatcherTimeoutMs(params.timeoutMs);

      // Trusted env-proxy, managed proxy, and pinDns=false can skip local DNS
      // pinning, so keep the pre-DNS hostname/IP policy checks from the pinned path.
      if (canUseTrustedEnvProxy || canUseManagedProxy || params.pinDns === false) {
        assertHostnameAllowedWithPolicy(parsedUrl.hostname, policyForUrl);
      }

      if (canUseTrustedEnvProxy) {
        dispatcher = createHttp1EnvHttpProxyAgent(undefined, timeoutMs);
      } else if (canUseManagedProxy) {
        if (shouldCheckManagedProxyBypass) {
          const pinned = await resolvePinnedHostname();
          dispatcher = shouldUseConfiguredLocalOriginManagedProxyBypass({
            url: parsedUrl,
            managedProxyBypass: params.managedProxyBypass,
            resolvedAddresses: pinned.addresses,
          })
            ? createPinnedDispatcher(pinned, dispatcherPolicy, policyForUrl, timeoutMs)
            : createHttp1EnvHttpProxyAgent(
                {
                  // An explicitly proxied loopback must not inherit Undici's ambient bypass list.
                  noProxy: "",
                  // Target certificate trust belongs to the tunneled endpoint,
                  // never to the separately authenticated managed proxy.
                  ...(dispatcherPolicy?.mode === "direct" && dispatcherPolicy.connect
                    ? { requestTls: { ...dispatcherPolicy.connect } }
                    : {}),
                },
                timeoutMs,
              );
        } else {
          dispatcher = createHttp1EnvHttpProxyAgent(undefined, timeoutMs);
        }
      } else if (usesTrustedExplicitProxyMode) {
        // Explicit proxy targets are still checked against the caller's hostname
        // policy, but the proxy does the DNS resolution for the final target.
        assertHostnameAllowedWithPolicy(parsedUrl.hostname, policyForUrl);
        dispatcher = createPolicyDispatcherWithoutPinnedDns(dispatcherPolicy, timeoutMs);
      } else if (canUseMockedFetchWithoutDns) {
        // Test-installed fetch mocks should stay hermetic. Host/IP policy still runs;
        // real fetches continue through pinned DNS below.
        assertHostnameAllowedWithPolicy(parsedUrl.hostname, policyForUrl);
      } else if (params.pinDns === false) {
        await resolvePinnedHostname();
        dispatcher = createPolicyDispatcherWithoutPinnedDns(dispatcherPolicy, timeoutMs);
      } else {
        const pinned = await resolvePinnedHostname();
        if (
          params.dispatcherPool &&
          mode === GUARDED_FETCH_MODE.STRICT &&
          dispatcherPolicy === undefined
        ) {
          const familyConnect = resolveUndiciAutoSelectFamilyConnectOptions();
          const key = JSON.stringify({
            origin: parsedUrl.origin,
            addresses: [...pinned.addresses].toSorted(),
            timeoutMs: timeoutMs ?? null,
            familyConnect: familyConnect ?? null,
            policy: policyForUrl ?? null,
          });
          dispatcherLease = params.dispatcherPool.acquire({
            key,
            groupKey: parsedUrl.origin,
            createDispatcher: () =>
              createPinnedDispatcher(
                pinned,
                familyConnect ? { mode: "direct", connect: familyConnect } : undefined,
                policyForUrl,
                timeoutMs,
              ),
          });
          dispatcher = dispatcherLease
            ? dispatcherLease.dispatcher
            : createPinnedDispatcher(pinned, undefined, policyForUrl, timeoutMs);
        } else {
          dispatcher = createPinnedDispatcher(pinned, dispatcherPolicy, policyForUrl, timeoutMs);
        }
      }

      const init: DispatcherAwareRequestInit = {
        ...(currentInit ? { ...currentInit } : {}),
        redirect: "manual",
        ...(dispatcher ? { dispatcher } : {}),
        signal: signal
          ? AbortSignal.any([signal, requestController.signal])
          : requestController.signal,
      };

      const supportsDispatcherInit =
        (params.fetchImpl !== undefined &&
          !isAmbientGlobalFetch({
            fetchImpl: params.fetchImpl,
            globalFetch: globalThis.fetch,
          })) ||
        isUsingMockedFetch;
      // Explicit caller stubs and test-installed fetch mocks should win.
      // Otherwise, fall back to undici's fetch whenever we attach a dispatcher,
      // because the default global fetch path will not honor per-request
      // dispatchers.
      const shouldUseRuntimeFetch = Boolean(dispatcher) && !supportsDispatcherInit;
      const beforeRequestResult: unknown = params.beforeRequest?.();
      if (isPromiseLike(beforeRequestResult)) {
        void Promise.resolve(beforeRequestResult).catch(() => undefined);
        throw new TypeError("beforeRequest must be synchronous.");
      }
      response = shouldUseRuntimeFetch
        ? await fetchWithRuntimeDispatcher(parsedUrl.toString(), init)
        : await defaultFetch(parsedUrl.toString(), init);
      const capturedByGlobalFetchPatch =
        !shouldUseRuntimeFetch &&
        isAmbientGlobalFetch({
          fetchImpl: defaultFetch,
          globalFetch: globalThis.fetch,
        });

      await captureGuardedFetchExchange({
        url: parsedUrl.toString(),
        method: currentInit?.method ?? "GET",
        requestHeaders: currentInit?.headers as Headers | Record<string, string> | undefined,
        requestBody:
          (currentInit as (RequestInit & { body?: BodyInit | null }) | undefined)?.body ?? null,
        response,
        transport: "http",
        capture: params.capture,
        auditContext: params.auditContext,
        capturedByGlobalFetchPatch,
      });

      if (isRedirectStatus(response.status)) {
        redirectCount += 1;
        if (redirectCount > maxRedirects) {
          throw new GuardedFetchRedirectError({ status: response.status, maxRedirects });
        }
        const location = response.headers.get("location");
        if (!location) {
          throw new Error(`Redirect missing location header (${response.status})`);
        }
        const nextParsedUrl = new URL(location, parsedUrl);
        const nextUrl = nextParsedUrl.toString();
        const retainedAuthorization = resolveRetainedAuthorizationForRedirect({
          init: currentInit,
          nextUrl: nextParsedUrl,
          hostnameAllowlist: params.retainAuthorizationRedirectHostnameAllowlist,
        });
        currentInit = rewriteRedirectInitForMethod({ init: currentInit, status: response.status });
        if (nextParsedUrl.origin !== parsedUrl.origin) {
          currentInit = rewriteRedirectInitForCrossOrigin({
            init: currentInit,
            allowUnsafeReplay: params.allowCrossOriginUnsafeRedirectReplay === true,
          });
          currentInit = retainSafeHeadersForCrossOriginRedirect(currentInit);
          currentInit = restoreRedirectAuthorization({
            init: currentInit,
            authorization: retainedAuthorization,
          });
        }
        const nextVisitKey = getRedirectVisitKey(nextUrl, currentInit);
        if (visited.has(nextVisitKey)) {
          throw new Error("Redirect loop detected");
        }
        visited.add(nextVisitKey);
        await releaseDispatcher();
        currentUrl = nextUrl;
        continue;
      }

      return {
        response,
        finalUrl: currentUrl,
        release: async () => finishRequest(releaseDispatcher),
        refreshTimeout: refresh,
        dispatcherReused: dispatcherLease?.reused,
      };
    } catch (err) {
      if (err instanceof SsrFBlockedError) {
        const context = params.auditContext ?? "url-fetch";
        logWarn(
          `security: blocked URL fetch (${context}) targetOrigin=${parsedUrl.origin} reason=${err.message}`,
        );
      }
      await finishRequest(releaseDispatcher);
      throw err;
    }
  }
}
