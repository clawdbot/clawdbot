import http2 from "node:http2";
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { openHttpConnectTunnel } from "./net/http-connect-tunnel.js";
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
const APNS_HTTP2_MIN_TIMEOUT_MS = 1000;

/** Parameters for opening an APNs HTTP/2 client session. */
export type ConnectApnsHttp2SessionParams = {
  authority: string;
  timeoutMs: number;
};

/** Parameters for validating APNs reachability through an explicit proxy. */
export type ProbeApnsHttp2ReachabilityViaProxyParams = {
  authority: string;
  proxyUrl: string;
  proxyTls?: ManagedProxyTlsOptions;
  timeoutMs: number;
};

/** APNs probe response used to prove a proxy tunneled to Apple. */
export type ProbeApnsHttp2ReachabilityViaProxyResult = {
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

async function openProxiedApnsHttp2Session(params: {
  authority: ApnsAuthority;
  proxyUrl: ActiveManagedProxyUrl;
  proxyTls?: ManagedProxyTlsOptions;
  timeoutMs: number;
}): Promise<http2.ClientHttp2Session> {
  const apnsHost = new URL(params.authority).hostname;
  const tlsSocket = await openHttpConnectTunnel({
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
      let body = "";
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
        reject(toLintErrorObject(err, "Non-Error rejection"));
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
        body += String(chunk);
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
        resolve({ status, body, responseHeaders });
      });
      request.end(JSON.stringify({ aps: { alert: "OpenClaw APNs proxy validation" } }));
    });
  } finally {
    if (!session.closed && !session.destroyed) {
      session.close();
    }
  }
}

function toLintErrorObject(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}
