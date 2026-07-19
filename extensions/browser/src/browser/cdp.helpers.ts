/**
 * Chrome DevTools Protocol URL, fetch, and socket helpers.
 *
 * Handles CDP URL normalization, SSRF-guarded HTTP discovery, credential
 * redaction/headers, and request/response correlation over WebSocket.
 */
import { createHash } from "node:crypto";
import { parseBrowserHttpUrl, redactCdpUrl } from "openclaw/plugin-sdk/browser-config";
import { readProviderJsonResponse } from "openclaw/plugin-sdk/provider-http";
import { sleep } from "openclaw/plugin-sdk/runtime-env";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import WebSocket from "ws";
import { isLoopbackHost } from "../gateway/net.js";
import {
  SsrFBlockedError,
  isPrivateNetworkAllowedByPolicy,
  type SsrFPolicy,
  resolvePinnedHostnameWithPolicy,
} from "../infra/net/ssrf.js";
import { rawDataToString } from "../infra/ws.js";
import { redactToolPayloadText } from "../logging/redact.js";
import {
  getDirectAgentForCdp,
  withManagedProxyForCdpUrl,
  withNoProxyForCdpUrl,
} from "./cdp-proxy-bypass.js";
import { CDP_HTTP_REQUEST_TIMEOUT_MS, CDP_WS_HANDSHAKE_TIMEOUT_MS } from "./cdp-timeouts.js";
import type { BrowserTabOwnership } from "./client.types.js";
import { BrowserCdpEndpointBlockedError } from "./errors.js";
import { resolveBrowserRateLimitMessage } from "./rate-limit-message.js";
import { withExactHostnamePolicy } from "./ssrf-policy-helpers.js";
import { normalizeBrowserTimerDelayMs } from "./timer-delay.js";

const CDP_URL_IN_TEXT_RE = /\b(?:https?|wss?):\/\/[^\s"'<>`]+/gi;

export { isLoopbackHost };
export { parseBrowserHttpUrl, redactCdpUrl };

/**
 * Returns true when the URL uses a WebSocket protocol (ws: or wss:).
 * Used to distinguish direct-WebSocket CDP endpoints
 * from HTTP(S) endpoints that require /json/version discovery.
 */
export function isWebSocketUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "ws:" || parsed.protocol === "wss:";
  } catch {
    return false;
  }
}

/**
 * Returns true when `url` is a ws/wss URL with a `/devtools/<kind>/<id>`
 * path segment — i.e. a handshake-ready per-browser or per-target CDP
 * endpoint that can be opened directly without HTTP discovery.
 *
 * Bare ws roots (`ws://host:port`, `ws://host:port/`) and any other
 * non-`/devtools/...` paths are NOT direct endpoints: Chrome's debug
 * port only accepts WebSocket upgrades on the specific path returned
 * by `GET /json/version`. Callers with a bare ws root must normalise
 * it to http for discovery instead of attempting a root handshake that
 * Chrome will reject with HTTP 400.
 */
export function isDirectCdpWebSocketEndpoint(url: string): boolean {
  if (!isWebSocketUrl(url)) {
    return false;
  }
  try {
    const parsed = new URL(url);
    return /\/devtools\/(?:browser|page|worker|shared_worker|service_worker)\/[^/]/i.test(
      parsed.pathname,
    );
    // isWebSocketUrl above already parsed the same URL successfully, so
    // new URL(url) cannot throw here. Kept for structural symmetry with
    // the other try/catch URL helpers.
    /* c8 ignore start */
  } catch {
    return false;
  }
  /* c8 ignore stop */
}

/** Restricts discovered CDP endpoints to the configured control-plane host. */
export function scopeCdpPolicyToConfiguredEndpoint(
  cdpUrl: string,
  ssrfPolicy?: SsrFPolicy,
): SsrFPolicy | undefined {
  if (!ssrfPolicy) {
    return undefined;
  }
  return withExactHostnamePolicy(ssrfPolicy, new URL(cdpUrl).hostname);
}

type CdpEndpointSource =
  | { source?: "configured" }
  | { source: "discovered"; configuredUrl: string };

function cdpEndpointAuthority(url: string): string {
  const parsed = new URL(url);
  const usesTls = parsed.protocol === "https:" || parsed.protocol === "wss:";
  const port = parsed.port || (usesTls ? "443" : "80");
  return `${usesTls ? "tls" : "plain"}://${parsed.hostname}:${port}`;
}

function assertDiscoveredCdpEndpointMatchesConfigured(
  discoveredUrl: string,
  configuredUrl: string,
  ssrfPolicy?: SsrFPolicy,
): void {
  if (
    !ssrfPolicy ||
    isPrivateNetworkAllowedByPolicy(ssrfPolicy) ||
    cdpEndpointAuthority(discoveredUrl) === cdpEndpointAuthority(configuredUrl)
  ) {
    return;
  }
  throw new BrowserCdpEndpointBlockedError({
    cause: new SsrFBlockedError("discovered CDP endpoint changed configured authority"),
  });
}

export async function assertCdpEndpointAllowed(
  cdpUrl: string,
  ssrfPolicy?: SsrFPolicy,
  options?: CdpEndpointSource,
): Promise<void> {
  if (options?.source === "discovered") {
    assertDiscoveredCdpEndpointMatchesConfigured(cdpUrl, options.configuredUrl, ssrfPolicy);
  }
  if (!ssrfPolicy) {
    return;
  }
  const parsed = new URL(cdpUrl);
  if (!["http:", "https:", "ws:", "wss:"].includes(parsed.protocol)) {
    throw new Error(`Invalid CDP URL protocol: ${parsed.protocol.replace(":", "")}`);
  }
  try {
    // Configured loopback CDP is a local control plane. Discovered endpoints
    // must remain within the caller's selected-host policy and cannot claim a
    // new loopback exception through returned JSON.
    const policy =
      isLoopbackHost(parsed.hostname) && options?.source !== "discovered"
        ? withExactHostnamePolicy(ssrfPolicy, parsed.hostname)
        : ssrfPolicy;
    await resolvePinnedHostnameWithPolicy(parsed.hostname, {
      policy,
    });
  } catch (error) {
    throw new BrowserCdpEndpointBlockedError({ cause: error });
  }
}

type CdpResponse = {
  id: number;
  result?: unknown;
  error?: { message?: string };
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
};

export type CdpSendFn = (
  method: string,
  params?: Record<string, unknown>,
  sessionId?: string,
) => Promise<unknown>;

function decodeUrlUserInfo(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Merge URL basic-auth credentials into headers without overriding explicit auth. */
export function getHeadersWithAuth(url: string, headers: Record<string, string> = {}) {
  const mergedHeaders = { ...headers };
  try {
    const parsed = new URL(url);
    const hasAuthHeader = Object.keys(mergedHeaders).some(
      (key) => key.trim().toLowerCase() === "authorization",
    );
    if (hasAuthHeader) {
      return mergedHeaders;
    }
    if (parsed.username || parsed.password) {
      const username = decodeUrlUserInfo(parsed.username);
      const password = decodeUrlUserInfo(parsed.password);
      const auth = Buffer.from(`${username}:${password}`).toString("base64");
      return { ...mergedHeaders, Authorization: `Basic ${auth}` };
    }
  } catch {
    // ignore
  }
  return mergedHeaders;
}

/** Remove URL userinfo after callers have converted it to an Authorization header. */
export function stripCdpUrlCredentials(url: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.username && !parsed.password) {
      return url;
    }
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

/** Redact CDP URLs and credential-shaped text before dependency errors leave Browser. */
export function redactCdpErrorText(text: string): string {
  const redactedUrls = text.replace(CDP_URL_IN_TEXT_RE, (match) => redactCdpUrl(match) ?? match);
  return redactToolPayloadText(redactedUrls);
}

/** Append a JSON endpoint path to a CDP HTTP base URL. */
export function appendCdpPath(cdpUrl: string, path: string): string {
  const url = new URL(cdpUrl);
  const basePath = url.pathname.replace(/\/$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  url.pathname = `${basePath}${suffix}`;
  return url.toString();
}

/** Normalize ws/wss and direct devtools URLs back to the HTTP JSON endpoint base. */
export function normalizeCdpHttpBaseForJsonEndpoints(cdpUrl: string): string {
  try {
    const url = new URL(cdpUrl);
    if (url.protocol === "ws:") {
      url.protocol = "http:";
    } else if (url.protocol === "wss:") {
      url.protocol = "https:";
    }
    url.pathname = url.pathname.replace(/\/devtools\/browser\/.*$/, "");
    url.pathname = url.pathname.replace(/\/cdp$/, "");
    return url.toString().replace(/\/$/, "");
  } catch {
    // Best-effort fallback for non-URL-ish inputs.
    return cdpUrl
      .replace(/^ws:/, "http:")
      .replace(/^wss:/, "https:")
      .replace(/\/devtools\/browser\/.*$/, "")
      .replace(/\/cdp$/, "")
      .replace(/\/$/, "");
  }
}

function fingerprintCdpIdentity(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonicalCdpAuthority(url: URL, protocol: "http:" | "https:" | "ws:" | "wss:"): string {
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  const port = url.port || (protocol === "https:" || protocol === "wss:" ? "443" : "80");
  return `${protocol}//${hostname}:${port}`;
}

function canonicalCdpProfileIdentity(url: string): string {
  const parsed = new URL(url);
  const protocol =
    parsed.protocol === "ws:" ? "http:" : parsed.protocol === "wss:" ? "https:" : parsed.protocol;
  if (protocol !== "http:" && protocol !== "https:") {
    throw new Error("CDP profile identity requires an HTTP(S) or WebSocket endpoint");
  }
  const standardBrowserPath = /^\/devtools\/browser\/[A-Za-z0-9._-]+$/.test(parsed.pathname);
  const hasTokenShapedSegment =
    !standardBrowserPath && parsed.pathname.split("/").some((segment) => segment.length >= 24);
  if (hasTokenShapedSegment) {
    throw new Error("CDP profile endpoint path may contain credentials");
  }
  return canonicalCdpAuthority(parsed, protocol);
}

function canonicalBrowserWebSocketIdentity(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new Error("Browser websocket identity requires a WebSocket endpoint");
  }
  const pathMatch = parsed.pathname.match(/^\/devtools\/browser\/([A-Za-z0-9._-]+)$/);
  if (!pathMatch?.[1]) {
    // Provider path prefixes can contain bearer material. Only Chrome's
    // standard browser path is safe to persist as an opaque fingerprint input.
    throw new Error("Browser websocket identity path is not credential-free");
  }
  return `${canonicalCdpAuthority(parsed, parsed.protocol)}/devtools/browser/${pathMatch[1]}`;
}

/** Build restart-stable hashes without retaining endpoint credentials. */
function createCdpOwnershipFingerprints(params: {
  profileName: string;
  cdpUrl: string;
  browserWebSocketUrl: string;
}): {
  profileFingerprint: string;
  browserInstanceFingerprint: string;
} {
  return {
    profileFingerprint: fingerprintCdpIdentity(
      JSON.stringify([params.profileName, canonicalCdpProfileIdentity(params.cdpUrl)]),
    ),
    browserInstanceFingerprint: fingerprintCdpIdentity(
      canonicalBrowserWebSocketIdentity(params.browserWebSocketUrl),
    ),
  };
}

type CdpTabOwnershipParams = {
  profileName: string;
  cdpUrl: string;
  nativeTargetId: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  ssrfPolicy?: SsrFPolicy;
};

async function resolveCdpTabOwnershipContext(
  params: CdpTabOwnershipParams,
): Promise<{ ownership: BrowserTabOwnership; browserWebSocketUrl?: string }> {
  params.signal?.throwIfAborted();
  const cdpHttpBase = normalizeCdpHttpBaseForJsonEndpoints(params.cdpUrl);
  let version: { webSocketDebuggerUrl?: unknown };
  try {
    version = await fetchJson<{ webSocketDebuggerUrl?: unknown }>(
      appendCdpPath(cdpHttpBase, "/json/version"),
      params.timeoutMs,
      { signal: params.signal },
      params.ssrfPolicy,
    );
  } catch (error) {
    if (params.signal?.aborted) {
      throw params.signal.reason ?? error;
    }
    if (error instanceof BrowserCdpEndpointBlockedError) {
      throw error;
    }
    return {
      ownership: { status: "non-durable", reason: "browser-identity-lookup-failed" },
    };
  }
  params.signal?.throwIfAborted();
  const browserWebSocketUrl =
    typeof version.webSocketDebuggerUrl === "string" ? version.webSocketDebuggerUrl.trim() : "";
  if (!browserWebSocketUrl) {
    return { ownership: { status: "non-durable", reason: "browser-identity-unavailable" } };
  }
  try {
    await assertCdpEndpointAllowed(browserWebSocketUrl, params.ssrfPolicy, {
      source: "discovered",
      configuredUrl: params.cdpUrl,
    });
    return {
      ownership: {
        status: "durable",
        nativeTargetId: params.nativeTargetId,
        ...createCdpOwnershipFingerprints({
          profileName: params.profileName,
          cdpUrl: params.cdpUrl,
          browserWebSocketUrl,
        }),
      },
      browserWebSocketUrl,
    };
  } catch (error) {
    if (error instanceof BrowserCdpEndpointBlockedError) {
      throw error;
    }
    return { ownership: { status: "non-durable", reason: "browser-identity-unavailable" } };
  }
}

/** Resolve durable ownership for a native target from the browser-level CDP identity. */
export async function resolveCdpTabOwnership(
  params: CdpTabOwnershipParams,
): Promise<BrowserTabOwnership> {
  return (await resolveCdpTabOwnershipContext(params)).ownership;
}

export type CloseTrackedCdpTargetResult =
  | { status: "cancelled" | "closed" | "missing" | "ownership-mismatch" }
  | {
      status: "unavailable";
      reason:
        | Extract<BrowserTabOwnership, { status: "non-durable" }>["reason"]
        | "target-close-failed";
    };

/** Verify ownership and close a tracked target on the same browser-level CDP connection. */
export async function closeTrackedCdpTarget(
  params: CdpTabOwnershipParams & {
    expectedProfileFingerprint: string;
    expectedBrowserInstanceFingerprint: string;
    shouldClose?: () => boolean;
  },
): Promise<CloseTrackedCdpTargetResult> {
  const resolved = await resolveCdpTabOwnershipContext(params);
  if (resolved.ownership.status !== "durable" || !resolved.browserWebSocketUrl) {
    return {
      status: "unavailable",
      reason:
        resolved.ownership.status === "non-durable"
          ? resolved.ownership.reason
          : "browser-identity-unavailable",
    };
  }
  if (
    resolved.ownership.profileFingerprint !== params.expectedProfileFingerprint ||
    resolved.ownership.browserInstanceFingerprint !== params.expectedBrowserInstanceFingerprint
  ) {
    return { status: "ownership-mismatch" };
  }
  params.signal?.throwIfAborted();
  try {
    return await withCdpSocket(
      resolved.browserWebSocketUrl,
      async (send) => {
        params.signal?.throwIfAborted();
        const response = await send("Target.getTargets");
        params.signal?.throwIfAborted();
        const targetInfos =
          response && typeof response === "object"
            ? (response as { targetInfos?: unknown }).targetInfos
            : undefined;
        if (!Array.isArray(targetInfos)) {
          return { status: "unavailable", reason: "target-lookup-failed" } as const;
        }
        const exists = targetInfos.some(
          (target) =>
            target &&
            typeof target === "object" &&
            (target as { targetId?: unknown }).targetId === params.nativeTargetId,
        );
        if (!exists) {
          return { status: "missing" } as const;
        }
        // The SQLite cleanup generation can be revoked while browser identity
        // is being resolved. Recheck on this same socket immediately before
        // the irreversible close so fresh activity cancels an idle sweep.
        if (params.shouldClose && !params.shouldClose()) {
          return { status: "cancelled" } as const;
        }
        try {
          params.signal?.throwIfAborted();
          const closeResponse = await send("Target.closeTarget", {
            targetId: params.nativeTargetId,
          });
          params.signal?.throwIfAborted();
          return closeResponse &&
            typeof closeResponse === "object" &&
            (closeResponse as { success?: unknown }).success === true
            ? ({ status: "closed" } as const)
            : ({ status: "unavailable", reason: "target-close-failed" } as const);
        } catch (error) {
          // Chromium can destroy the page between getTargets and closeTarget.
          // Its protocol implementation uses this exact InvalidParams message.
          if (String(error).includes("No target with given id found")) {
            return { status: "missing" } as const;
          }
          throw error;
        }
      },
      {
        commandTimeoutMs: params.timeoutMs,
        handshakeTimeoutMs: params.timeoutMs,
        handshakeRetries: 0,
      },
    );
  } catch (error) {
    if (params.signal?.aborted) {
      throw params.signal.reason ?? error;
    }
    if (error instanceof BrowserCdpEndpointBlockedError) {
      throw error;
    }
    return { status: "unavailable", reason: "target-lookup-failed" };
  }
}

type CdpFetchResult = {
  response: Response;
  release: () => Promise<void>;
};

function createCdpSender(ws: WebSocket, opts?: { commandTimeoutMs?: number }) {
  let nextId = 1;
  const pending = new Map<number, Pending>();
  const commandTimeoutMs =
    typeof opts?.commandTimeoutMs === "number" && Number.isFinite(opts.commandTimeoutMs)
      ? normalizeBrowserTimerDelayMs(opts.commandTimeoutMs)
      : undefined;

  const clearPendingTimer = (p: Pending) => {
    if (p.timer !== undefined) {
      clearTimeout(p.timer);
    }
  };

  const send: CdpSendFn = (
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ) => {
    const id = nextId++;
    const msg = { id, method, params, sessionId };
    return new Promise<unknown>((resolve, reject) => {
      if (ws.readyState !== WebSocket.OPEN) {
        reject(new Error("CDP socket closed"));
        return;
      }
      const entry: Pending = { resolve, reject };
      if (commandTimeoutMs !== undefined) {
        // A timed-out command closes the whole socket so pending calls do not
        // hang on a connection whose CDP command stream is no longer reliable.
        entry.timer = setTimeout(() => {
          closeWithError(new Error(`CDP command ${method} timed out after ${commandTimeoutMs}ms`));
        }, commandTimeoutMs);
      }
      pending.set(id, entry);
      try {
        ws.send(JSON.stringify(msg));
      } catch (err) {
        pending.delete(id);
        clearPendingTimer(entry);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  };

  const closeWithError = (err: Error) => {
    for (const [, p] of pending) {
      clearPendingTimer(p);
      p.reject(err);
    }
    pending.clear();
    ws.close();
  };

  ws.on("error", (err) => {
    // The `err instanceof Error` guard is defensive: Node's `ws` library
    // always emits Error instances on the 'error' event. Triggering the
    // non-Error branch would require synthetically emitting on the socket,
    // which the library treats as an unhandled error and hangs the test.
    /* c8 ignore next */
    closeWithError(err instanceof Error ? err : new Error(String(err)));
  });

  ws.on("message", (data) => {
    try {
      const parsed = JSON.parse(rawDataToString(data)) as CdpResponse;
      if (typeof parsed.id !== "number") {
        return;
      }
      const p = pending.get(parsed.id);
      if (!p) {
        return;
      }
      pending.delete(parsed.id);
      clearPendingTimer(p);
      if (parsed.error?.message) {
        p.reject(new Error(parsed.error.message));
        return;
      }
      p.resolve(parsed.result);
    } catch {
      // ignore
    }
  });

  ws.on("close", () => {
    closeWithError(new Error("CDP socket closed"));
  });

  return { send, closeWithError };
}

/** Fetch and parse a CDP JSON endpoint through the configured SSRF guard. */
export async function fetchJson<T>(
  url: string,
  timeoutMs = CDP_HTTP_REQUEST_TIMEOUT_MS,
  init?: RequestInit,
  ssrfPolicy?: SsrFPolicy,
): Promise<T> {
  const { response, release } = await fetchCdpChecked(url, timeoutMs, init, ssrfPolicy);
  try {
    return await readProviderJsonResponse<T>(response, "cdp-json");
  } finally {
    await release();
  }
}

/** Fetch a CDP endpoint and return the response with an idempotent release hook. */
export async function fetchCdpChecked(
  url: string,
  timeoutMs = CDP_HTTP_REQUEST_TIMEOUT_MS,
  init?: RequestInit,
  ssrfPolicy?: SsrFPolicy,
): Promise<CdpFetchResult> {
  const ctrl = new AbortController();
  const t = setTimeout(ctrl.abort.bind(ctrl), normalizeBrowserTimerDelayMs(timeoutMs));
  const signal = init?.signal ? AbortSignal.any([ctrl.signal, init.signal]) : ctrl.signal;
  let guardedRelease: (() => Promise<void>) | undefined;
  let released = false;
  const release = async () => {
    if (released) {
      return;
    }
    released = true;
    clearTimeout(t);
    await guardedRelease?.();
  };
  try {
    const headers = getHeadersWithAuth(url, (init?.headers as Record<string, string>) || {});
    const fetchUrl = stripCdpUrlCredentials(url);
    const res = await withManagedProxyForCdpUrl(fetchUrl, () =>
      withNoProxyForCdpUrl(fetchUrl, async () => {
        const parsedUrl = new URL(fetchUrl);
        // Loopback CDP is an OpenClaw control plane, not page navigation. Allow
        // its exact host while preserving the caller's policy for remote hosts.
        const policy = isLoopbackHost(parsedUrl.hostname)
          ? withExactHostnamePolicy(ssrfPolicy, parsedUrl.hostname)
          : (ssrfPolicy ?? { allowPrivateNetwork: true });
        const guarded = await fetchWithSsrFGuard({
          url: fetchUrl,
          init: { ...init, headers },
          signal,
          policy,
          auditContext: "browser-cdp",
        });
        guardedRelease = guarded.release;
        return guarded.response;
      }),
    );
    if (!res.ok) {
      if (res.status === 429) {
        // Do not reflect upstream response text into the error surface (log/agent injection risk)
        throw new Error(`${resolveBrowserRateLimitMessage(url)} Do NOT retry the browser tool.`);
      }
      throw new Error(`HTTP ${res.status}`);
    }
    return { response: res, release };
  } catch (error) {
    await release();
    if (error instanceof SsrFBlockedError) {
      throw new BrowserCdpEndpointBlockedError({ cause: error });
    }
    throw error;
  }
}

/** Probe that a CDP endpoint responds with an OK HTTP status. */
export async function fetchOk(
  url: string,
  timeoutMs = CDP_HTTP_REQUEST_TIMEOUT_MS,
  init?: RequestInit,
  ssrfPolicy?: SsrFPolicy,
): Promise<void> {
  const { release } = await fetchCdpChecked(url, timeoutMs, init, ssrfPolicy);
  await release();
}

/** Open a CDP WebSocket with URL basic-auth and proxy bypass handling. */
export function openCdpWebSocket(
  wsUrl: string,
  opts?: { headers?: Record<string, string>; handshakeTimeoutMs?: number },
): WebSocket {
  const headers = getHeadersWithAuth(wsUrl, opts?.headers ?? {});
  const handshakeTimeoutMs =
    typeof opts?.handshakeTimeoutMs === "number" && Number.isFinite(opts.handshakeTimeoutMs)
      ? Math.max(1, Math.floor(opts.handshakeTimeoutMs))
      : CDP_WS_HANDSHAKE_TIMEOUT_MS;
  const connectionUrl = stripCdpUrlCredentials(wsUrl);
  const agent = getDirectAgentForCdp(connectionUrl);
  return withManagedProxyForCdpUrl(
    connectionUrl,
    () =>
      new WebSocket(connectionUrl, {
        handshakeTimeout: handshakeTimeoutMs,
        ...(Object.keys(headers).length ? { headers } : {}),
        ...(agent ? { agent } : {}),
      }),
  );
}

type CdpSocketOptions = {
  headers?: Record<string, string>;
  handshakeTimeoutMs?: number;
  commandTimeoutMs?: number;
  handshakeRetries?: number;
  handshakeRetryDelayMs?: number;
  handshakeMaxRetryDelayMs?: number;
};

function normalizeRetryCount(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.floor(value));
}

function computeHandshakeRetryDelayMs(attempt: number, opts?: CdpSocketOptions): number {
  const baseDelayMs =
    typeof opts?.handshakeRetryDelayMs === "number" && Number.isFinite(opts.handshakeRetryDelayMs)
      ? Math.max(1, Math.floor(opts.handshakeRetryDelayMs))
      : 200;
  const maxDelayMs =
    typeof opts?.handshakeMaxRetryDelayMs === "number" &&
    Number.isFinite(opts.handshakeMaxRetryDelayMs)
      ? Math.max(baseDelayMs, Math.floor(opts.handshakeMaxRetryDelayMs))
      : 3000;
  const raw = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt - 1));
  // Jitter keeps several browser sessions from retrying handshakes in lockstep
  // after a shared Chrome or network hiccup.
  const jitterScale = 0.8 + Math.random() * 0.4;
  return Math.max(1, Math.floor(raw * jitterScale));
}

function shouldRetryCdpHandshakeError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const msg = err.message.toLowerCase();
  if (!msg) {
    return false;
  }
  if (msg.includes("rate limit")) {
    return false;
  }
  const statusMatch = msg.match(/(?:unexpected server response|response):\s*(\d{3})/);
  if (statusMatch?.[1]) {
    return Number(statusMatch[1]) >= 500;
  }
  return (
    msg.includes("cdp socket closed") ||
    msg.includes("econnreset") ||
    msg.includes("econnrefused") ||
    msg.includes("econnaborted") ||
    msg.includes("ehostunreach") ||
    msg.includes("enetunreach") ||
    msg.includes("etimedout") ||
    msg.includes("socket hang up") ||
    msg.includes("websocket error") ||
    msg.includes("closed before")
  );
}

export async function withCdpSocket<T>(
  wsUrl: string,
  fn: (send: CdpSendFn) => Promise<T>,
  opts?: CdpSocketOptions,
): Promise<T> {
  const maxHandshakeRetries = normalizeRetryCount(opts?.handshakeRetries, 2);
  let lastHandshakeError: unknown;
  for (let attempt = 0; attempt <= maxHandshakeRetries; attempt += 1) {
    const ws = openCdpWebSocket(wsUrl, opts);
    const { send, closeWithError } = createCdpSender(ws, opts);

    const openPromise = new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", (err) => reject(err));
      ws.once("close", () => reject(new Error("CDP socket closed")));
    });

    try {
      await openPromise;
    } catch (err) {
      lastHandshakeError = err;
      // openPromise is only rejected via `ws.once('error', err => reject(err))`
      // or the close event's `new Error(...)`; the former always carries an
      // Error from Node's `ws` library, the latter is already an Error. The
      // non-Error wrap is defensive and structurally unreachable.
      /* c8 ignore next */
      closeWithError(err instanceof Error ? err : new Error(String(err)));
      if (attempt >= maxHandshakeRetries || !shouldRetryCdpHandshakeError(err)) {
        throw err;
      }
      // Retry only handshake failures. Once CDP commands are flowing, callers
      // own retry semantics because commands may already have side effects.
      await sleep(computeHandshakeRetryDelayMs(attempt + 1, opts));
      continue;
    }

    try {
      return await fn(send);
    } catch (err) {
      closeWithError(err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      ws.close();
    }
  }

  if (lastHandshakeError instanceof Error) {
    throw lastHandshakeError;
  }
  throw new Error("CDP socket failed to open");
}
