// Opens APNs HTTP/2 sessions with optional managed proxy tunneling.
import { once } from "node:events";
import http2 from "node:http2";
import tls from "node:tls";
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { openProxyConnectTunnel } from "@openclaw/proxyline";
import { toErrorObject } from "./errors.js";
import {
  getActiveManagedProxyUrl,
  getActiveManagedProxyTlsOptions,
  type ActiveManagedProxyUrl,
} from "./net/proxy/active-proxy-state.js";
import type { ManagedProxyTlsOptions } from "./net/proxy/proxy-tls.js";

const APNS_DEFAULT_PORT = "443";

const APNS_AUTHORITIES = new Set([
  "https://api.push.apple.com",
  "https://api.sandbox.push.apple.com",
]);

type ApnsAuthority = "https://api.push.apple.com" | "https://api.sandbox.push.apple.com";

export const APNS_HTTP2_CANCEL_CODE = http2.constants.NGHTTP2_CANCEL;
const APNS_RESPONSE_BODY_MAX_BYTES = 8192;
const APNS_HTTP2_MIN_TIMEOUT_MS = 1000;

type ApnsResponseBodyCapture = {
  text: string;
  bytes: number;
  truncated: boolean;
};

/** Parameters for opening an APNs HTTP/2 client session. */
type ConnectApnsHttp2SessionParams = {
  authority: string;
  timeoutMs: number;
};

/** Parameters for validating APNs reachability through an explicit proxy. */
type ProbeApnsHttp2ReachabilityViaProxyParams = {
  authority: string;
  proxyUrl: string;
  proxyTls?: ManagedProxyTlsOptions;
  timeoutMs: number;
};

/** APNs probe response used to prove a proxy tunneled to Apple. */
type ProbeApnsHttp2ReachabilityViaProxyResult = {
  status: number;
  body: string;
  /** Raw response headers from APNs. Includes apns-id when the connection was truly tunneled to Apple. */
  responseHeaders: Record<string, string>;
};

function assertApnsAuthority(authority: string): ApnsAuthority {
  let parsed: URL;
  try {
    parsed = new URL(authority);
  } catch {
    throw new Error(`Unsupported APNs authority: ${authority}`);
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`Unsupported APNs authority: ${authority}`);
  }
  const port = parsed.port && parsed.port !== APNS_DEFAULT_PORT ? `:${parsed.port}` : "";
  const normalized = `${parsed.protocol}//${parsed.hostname}${port}`;
  if (!APNS_AUTHORITIES.has(normalized)) {
    throw new Error(`Unsupported APNs authority: ${authority}`);
  }
  // Return a normalized origin only. APNs paths are created by callers and
  // should never be accepted from user/config authority input.
  return normalized as ApnsAuthority;
}

function normalizeConnectProxyUrl(proxyUrl: URL): URL {
  const normalized = new URL(proxyUrl);
  normalized.pathname = "/";
  normalized.search = "";
  normalized.hash = "";
  try {
    // Proxyline decodes auth from its socket callback. Validate first so bad
    // config rejects normally instead of escaping the EventEmitter boundary.
    decodeURIComponent(normalized.username);
    decodeURIComponent(normalized.password);
  } catch (err) {
    throw new Error(
      `Proxy CONNECT failed via ${normalized.origin}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  return normalized;
}

async function openApnsTlsTunnel(params: {
  proxyUrl: URL;
  proxyTls?: ManagedProxyTlsOptions;
  targetHost: string;
  targetPort: number;
  timeoutMs: number;
}): Promise<tls.TLSSocket> {
  // CONNECT ignores URL paths. Strip path metadata before Proxyline sees it so
  // tokens embedded in a configured proxy URL cannot surface in errors.
  const proxyUrl = normalizeConnectProxyUrl(params.proxyUrl);
  const deadline = Date.now() + params.timeoutMs;
  const proxySocket = await openProxyConnectTunnel({
    proxyUrl,
    ...(params.proxyTls ? { proxyTls: params.proxyTls } : {}),
    targetHost: params.targetHost,
    targetPort: params.targetPort,
    timeoutMs: params.timeoutMs,
  });

  const abortController = new AbortController();
  let targetTlsSocket: tls.TLSSocket | undefined;
  let timeout: NodeJS.Timeout | undefined;
  try {
    targetTlsSocket = tls.connect({
      socket: proxySocket,
      servername: params.targetHost,
      ALPNProtocols: ["h2"],
    });
    timeout = setTimeout(
      () => abortController.abort(new Error(`Proxy CONNECT timed out after ${params.timeoutMs}ms`)),
      Math.max(1, deadline - Date.now()),
    );
    timeout.unref?.();
    await Promise.race([
      once(targetTlsSocket, "secureConnect", { signal: abortController.signal }),
      once(targetTlsSocket, "close", { signal: abortController.signal }).then(() => {
        throw new Error("APNs TLS tunnel closed before secureConnect");
      }),
    ]);
    if (targetTlsSocket.alpnProtocol !== "h2") {
      throw new Error(
        `APNs TLS tunnel negotiated ${targetTlsSocket.alpnProtocol || "no ALPN protocol"} instead of h2`,
      );
    }
    return targetTlsSocket;
  } catch (err) {
    targetTlsSocket?.destroy();
    proxySocket.destroy();
    const failure = abortController.signal.aborted ? abortController.signal.reason : err;
    throw new Error(
      `Proxy CONNECT failed via ${proxyUrl.origin}: ${failure instanceof Error ? failure.message : String(failure)}`,
      { cause: err },
    );
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    abortController.abort();
  }
}

async function openProxiedApnsHttp2Session(params: {
  authority: ApnsAuthority;
  proxyUrl: ActiveManagedProxyUrl;
  proxyTls?: ManagedProxyTlsOptions;
  timeoutMs: number;
}): Promise<http2.ClientHttp2Session> {
  const apnsHost = new URL(params.authority).hostname;
  const tlsSocket = await openApnsTlsTunnel({
    proxyUrl: params.proxyUrl,
    ...(params.proxyTls ? { proxyTls: params.proxyTls } : {}),
    targetHost: apnsHost,
    targetPort: 443,
    timeoutMs: params.timeoutMs,
  });

  // The CONNECT helper already completed the target TLS handshake; reuse that
  // socket so the session cannot open a separate direct route.
  return http2.connect(params.authority, {
    createConnection: () => tlsSocket,
  });
}

/** Connects to APNs directly, or through the active managed proxy when present. */
export async function connectApnsHttp2Session(
  params: ConnectApnsHttp2SessionParams,
): Promise<http2.ClientHttp2Session> {
  const authority = assertApnsAuthority(params.authority);
  const timeoutMs = resolveApnsHttp2TimeoutMs(params.timeoutMs);
  const proxyUrl = getActiveManagedProxyUrl();
  if (!proxyUrl) {
    return http2.connect(authority);
  }

  return await openProxiedApnsHttp2Session({
    authority,
    proxyUrl,
    proxyTls: getActiveManagedProxyTlsOptions(),
    timeoutMs,
  });
}

function resolveApnsHttp2TimeoutMs(timeoutMs: number): number {
  return resolveTimerTimeoutMs(timeoutMs, APNS_HTTP2_MIN_TIMEOUT_MS, APNS_HTTP2_MIN_TIMEOUT_MS);
}

export function createApnsResponseBodyCapture(): ApnsResponseBodyCapture {
  return { text: "", bytes: 0, truncated: false };
}

export function appendApnsResponseBodyCapture(
  capture: ApnsResponseBodyCapture,
  chunk: unknown,
  maxBytes = APNS_RESPONSE_BODY_MAX_BYTES,
): void {
  const buffer = Buffer.from(String(chunk));
  capture.bytes += buffer.byteLength;
  const remaining = maxBytes - Buffer.byteLength(capture.text);
  if (remaining <= 0) {
    capture.truncated = capture.truncated || buffer.byteLength > 0;
    return;
  }
  const slice = buffer.byteLength > remaining ? buffer.subarray(0, remaining) : buffer;
  capture.text += slice.toString("utf8");
  if (slice.byteLength < buffer.byteLength) {
    capture.truncated = true;
  }
}

/** Sends an intentionally invalid APNs push through a proxy to prove HTTP/2 reachability. */
export async function probeApnsHttp2ReachabilityViaProxy(
  params: ProbeApnsHttp2ReachabilityViaProxyParams,
): Promise<ProbeApnsHttp2ReachabilityViaProxyResult> {
  const authority = assertApnsAuthority(params.authority);
  const timeoutMs = resolveApnsHttp2TimeoutMs(params.timeoutMs);
  const session = await openProxiedApnsHttp2Session({
    authority,
    proxyUrl: new URL(params.proxyUrl),
    ...(params.proxyTls ? { proxyTls: params.proxyTls } : {}),
    timeoutMs,
  });

  try {
    return await new Promise<ProbeApnsHttp2ReachabilityViaProxyResult>((resolve, reject) => {
      let settled = false;
      const body = createApnsResponseBodyCapture();
      let status: number | undefined;
      let responseHeaders: Record<string, string> = {};
      const timeout = setTimeout(() => {
        fail(new Error(`APNs reachability probe timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timeout.unref?.();

      const cleanup = () => {
        clearTimeout(timeout);
        session.off("error", fail);
      };

      const fail = (err: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        session.destroy(err instanceof Error ? err : new Error(String(err)));
        reject(toErrorObject(err, "Non-Error rejection"));
      };

      const request = session.request({
        ":method": "POST",
        ":path": `/3/device/${"0".repeat(64)}`,
        // APNs should reject this token with InvalidProviderToken. That failure
        // is the success signal that the proxy actually tunneled to Apple.
        authorization: "bearer intentionally.invalid.openclaw.proxy.validation",
        "apns-topic": "ai.openclaw.ios",
        "apns-push-type": "alert",
        "apns-priority": "10",
      });

      session.once("error", fail);
      request.setEncoding("utf8");
      request.on("response", (headers) => {
        const rawStatus = headers[":status"];
        status = typeof rawStatus === "number" ? rawStatus : Number(rawStatus);
        responseHeaders = Object.fromEntries(
          Object.entries(headers)
            .filter(([k]) => !k.startsWith(":"))
            .map(([k, v]) => [k, String(v)]),
        );
      });
      request.on("data", (chunk) => {
        appendApnsResponseBodyCapture(body, chunk);
      });
      request.once("error", fail);
      request.once("end", () => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        if (status === undefined || !Number.isFinite(status)) {
          reject(new Error("APNs reachability probe ended without an HTTP/2 status"));
          return;
        }
        resolve({ status, body: body.text, responseHeaders });
      });
      request.end(JSON.stringify({ aps: { alert: "OpenClaw APNs proxy validation" } }));
    });
  } finally {
    if (!session.closed && !session.destroyed) {
      session.close();
    }
  }
}
