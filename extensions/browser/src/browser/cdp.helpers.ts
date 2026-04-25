import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import WebSocket from "ws";
import { isLoopbackHost } from "../gateway/net.js";
import {
  SsrFBlockedError,
  type SsrFPolicy,
  resolvePinnedHostnameWithPolicy,
} from "../infra/net/ssrf.js";
import { redactSensitiveText } from "../logging/redact.js";
import { getDirectAgentForCdp, withNoProxyForCdpUrl } from "./cdp-proxy-bypass.js";
import { CDP_HTTP_REQUEST_TIMEOUT_MS, CDP_WS_HANDSHAKE_TIMEOUT_MS } from "./cdp-timeouts.js";
import { BrowserCdpEndpointBlockedError } from "./errors.js";
import { resolveBrowserRateLimitMessage } from "./rate-limit-message.js";
import { withAllowedHostname } from "./ssrf-policy-helpers.js";

export { isLoopbackHost };

export function parseBrowserHttpUrl(raw: string, label: string) {
  const trimmed = raw.trim();
  const parsed = new URL(trimmed);
  const allowed = ["http:", "https:", "ws:", "wss:"];
  if (!allowed.includes(parsed.protocol)) {
    throw new Error(`${label} must be http(s) or ws(s), got: ${parsed.protocol.replace(":", "")}`);
  }

  const isSecure = parsed.protocol === "https:" || parsed.protocol === "wss:";
  const port =
    parsed.port && Number.parseInt(parsed.port, 10) > 0
      ? Number.parseInt(parsed.port, 10)
      : isSecure
        ? 443
        : 80;

  // WHATWG URL rejects invalid ports (non-numeric, negative, >65535), and
  // the ternary above falls back to 80/443 for empty or zero parsed.port,
  // so this defensive guard is unreachable at runtime. Kept as a
  // belt-and-braces check against parser drift.
  /* c8 ignore next 3 */
  if (Number.isNaN(port) || port <= 0 || port > 65535) {
    throw new Error(`${label} has invalid port: ${parsed.port}`);
  }

  return {
    parsed,
    port,
    normalized: parsed.toString().replace(/\/$/, ""),
  };
}

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

export async function assertCdpEndpointAllowed(
  cdpUrl: string,
  ssrfPolicy?: SsrFPolicy,
): Promise<void> {
  if (!ssrfPolicy) {
    return;
  }
  const parsed = new URL(cdpUrl);
  if (!["http:", "https:", "ws:", "wss:"].includes(parsed.protocol)) {
    throw new Error(`Invalid CDP URL protocol: ${parsed.protocol.replace(":", "")}`);
  }
  try {
    const policy = isLoopbackHost(parsed.hostname)
      ? withAllowedHostname(ssrfPolicy, parsed.hostname)
      : ssrfPolicy;
    await resolvePinnedHostnameWithPolicy(parsed.hostname, {
      policy,
    });
  } catch (error) {
    throw new BrowserCdpEndpointBlockedError({ cause: error });
  }
}

export function redactCdpUrl(cdpUrl: string | null | undefined): string | null | undefined {
  if (typeof cdpUrl !== "string") {
    return cdpUrl;
  }
  const trimmed = cdpUrl.trim();
  if (!trimmed) {
    return trimmed;
  }
  try {
    const parsed = new URL(trimmed);
    parsed.username = "";
    parsed.password = "";
    return redactSensitiveText(parsed.toString().replace(/\/$/, ""));
  } catch {
    return redactSensitiveText(trimmed);
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

function rawCdpMessageToString(data: WebSocket.RawData): string {
  if (typeof data === "string") {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  }
  return Buffer.from(data).toString("utf8");
}

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
      const auth = Buffer.from(`${parsed.username}:${parsed.password}`).toString("base64");
      return { ...mergedHeaders, Authorization: `Basic ${auth}` };
    }
  } catch {
    // ignore
  }
  return mergedHeaders;
}

export function appendCdpPath(cdpUrl: string, path: string): string {
  const url = new URL(cdpUrl);
  const basePath = url.pathname.replace(/\/$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  url.pathname = `${basePath}${suffix}`;
  return url.toString();
}

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

type CdpFetchResult = {
  response: Response;
  release: () => Promise<void>;
};

function createCdpSender(ws: WebSocket, opts?: { commandTimeoutMs?: number }) {
  let nextId = 1;
  const pending = new Map<number, Pending>();
  const commandTimeoutMs =
    typeof opts?.commandTimeoutMs === "number" && Number.isFinite(opts.commandTimeoutMs)
      ? Math.max(1, Math.floor(opts.commandTimeoutMs))
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
    try {
      ws.close();
    } catch {
      // ignore
    }
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
      const parsed = JSON.parse(rawCdpMessageToString(data)) as CdpResponse;
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

export async function fetchJson<T>(
  url: string,
  timeoutMs = CDP_HTTP_REQUEST_TIMEOUT_MS,
  init?: RequestInit,
  ssrfPolicy?: SsrFPolicy,
): Promise<T> {
  const { response, release } = await fetchCdpChecked(url, timeoutMs, init, ssrfPolicy);
  try {
    return (await response.json()) as T;
  } finally {
    await release();
  }
}

export async function fetchCdpChecked(
  url: string,
  timeoutMs = CDP_HTTP_REQUEST_TIMEOUT_MS,
  init?: RequestInit,
  ssrfPolicy?: SsrFPolicy,
): Promise<CdpFetchResult> {
  const ctrl = new AbortController();
  const t = setTimeout(ctrl.abort.bind(ctrl), timeoutMs);
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
    const res = await withNoProxyForCdpUrl(url, async () => {
      const parsedUrl = new URL(url);
      const policy = isLoopbackHost(parsedUrl.hostname)
        ? withAllowedHostname(ssrfPolicy, parsedUrl.hostname)
        : (ssrfPolicy ?? { allowPrivateNetwork: true });
      const guarded = await fetchWithSsrFGuard({
        url,
        init: { ...init, headers },
        signal: ctrl.signal,
        policy,
        auditContext: "browser-cdp",
      });
      guardedRelease = guarded.release;
      return guarded.response;
    });
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

export async function fetchOk(
  url: string,
  timeoutMs = CDP_HTTP_REQUEST_TIMEOUT_MS,
  init?: RequestInit,
  ssrfPolicy?: SsrFPolicy,
): Promise<void> {
  const { release } = await fetchCdpChecked(url, timeoutMs, init, ssrfPolicy);
  await release();
}

export function openCdpWebSocket(
  wsUrl: string,
  opts?: { headers?: Record<string, string>; handshakeTimeoutMs?: number },
): WebSocket {
  const headers = getHeadersWithAuth(wsUrl, opts?.headers ?? {});
  const handshakeTimeoutMs =
    typeof opts?.handshakeTimeoutMs === "number" && Number.isFinite(opts.handshakeTimeoutMs)
      ? Math.max(1, Math.floor(opts.handshakeTimeoutMs))
      : CDP_WS_HANDSHAKE_TIMEOUT_MS;
  const agent = getDirectAgentForCdp(wsUrl);
  return new WebSocket(wsUrl, {
    handshakeTimeout: handshakeTimeoutMs,
    ...(Object.keys(headers).length ? { headers } : {}),
    ...(agent ? { agent } : {}),
  });
}

export async function withCdpSocket<T>(
  wsUrl: string,
  fn: (send: CdpSendFn) => Promise<T>,
  opts?: {
    headers?: Record<string, string>;
    handshakeTimeoutMs?: number;
    commandTimeoutMs?: number;
  },
): Promise<T> {
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
    // openPromise is only rejected via `ws.once('error', err => reject(err))`
    // or the close event's `new Error(...)`; the former always carries an
    // Error from Node's `ws` library, the latter is already an Error. The
    // non-Error wrap is defensive and structurally unreachable.
    /* c8 ignore next */
    closeWithError(err instanceof Error ? err : new Error(String(err)));
    throw err;
  }

  try {
    return await fn(send);
  } catch (err) {
    closeWithError(err instanceof Error ? err : new Error(String(err)));
    throw err;
  } finally {
    try {
      ws.close();
    } catch {
      // ignore
    }
  }
}
