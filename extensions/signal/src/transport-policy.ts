// Signal transport policy centralizes local endpoint collision handling.
import type { SignalTransportConfig } from "./account-types.js";
import { normalizeSignalTransportUrl } from "./transport-url.js";

type SignalManagedNativeTransport = Extract<SignalTransportConfig, { kind: "managed-native" }>;

export const DEFAULT_SIGNAL_MANAGED_NATIVE_PORT = 8080;
export const DEFAULT_SIGNAL_MANAGED_NATIVE_HOST = "127.0.0.1";
const SIGNAL_LOOPBACK_HOST_ALIASES = new Set(["localhost", "127.0.0.1", "::1"]);

function normalizeSignalEndpointHost(hostname: string): string {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized.endsWith(".") ? normalized.slice(0, -1) : normalized;
}

function isSignalLocalEndpointHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "::1" ||
    hostname === "::" ||
    hostname === "0.0.0.0" ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname) ||
    /^::ffff:(?:127(?:\.\d{1,3}){3}|7f[0-9a-f]{2}:[0-9a-f]{1,4})$/.test(hostname)
  );
}

export function isValidSignalManagedNativePort(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 65_535;
}

export function allocateSignalManagedNativePort(params: {
  reservedPorts: ReadonlySet<number>;
  preferredPort?: number;
}): number {
  if (params.preferredPort !== undefined) {
    if (!isValidSignalManagedNativePort(params.preferredPort)) {
      throw new Error("Signal managed native port must be an integer between 1 and 65535.");
    }
    if (!params.reservedPorts.has(params.preferredPort)) {
      return params.preferredPort;
    }
  }
  let port = DEFAULT_SIGNAL_MANAGED_NATIVE_PORT;
  while (port <= 65_535 && params.reservedPorts.has(port)) {
    port += 1;
  }
  if (port > 65_535) {
    throw new Error("No available Signal managed native port remains.");
  }
  return port;
}

export function resolveLocalSignalTransportPort(baseUrl: string): number | undefined {
  try {
    const parsed = new URL(baseUrl);
    const hostname = normalizeSignalEndpointHost(parsed.hostname);
    if (!isSignalLocalEndpointHost(hostname)) {
      return undefined;
    }
    if (parsed.port) {
      return Number.parseInt(parsed.port, 10);
    }
    return parsed.protocol === "https:" ? 443 : 80;
  } catch {
    return undefined;
  }
}

/**
 * When managed-native has a local connection URL but no explicit httpPort, prefer
 * binding the daemon to that URL's port so client and autoStart daemon agree.
 * Returns undefined when the URL is an independent endpoint (different host/family
 * or non-local), so multi-account allocation can still reassign binds.
 */
export function preferredManagedNativePortFromConnectionUrl(
  transport: SignalTransportConfig,
): number | undefined {
  if (transport.kind !== "managed-native" || transport.httpPort !== undefined || !transport.url) {
    return undefined;
  }
  const localPort = resolveLocalSignalTransportPort(transport.url);
  if (localPort === undefined || !isValidSignalManagedNativePort(localPort)) {
    return undefined;
  }
  const candidate: SignalManagedNativeTransport = { ...transport, httpPort: localPort };
  if (!isSignalManagedNativeConnectionUrlForBind(candidate)) {
    return undefined;
  }
  return localPort;
}

export function isSignalManagedNativeConnectionUrlForBind(
  transport: SignalTransportConfig,
): boolean {
  if (transport.kind !== "managed-native" || !transport.url) {
    return false;
  }
  const connectionUrl = new URL(transport.url);
  // signal-cli's daemon bind is plain HTTP. A local HTTPS URL is an independent proxy endpoint,
  // even when its host and port happen to match the configured daemon bind.
  if (connectionUrl.protocol !== "http:") {
    return false;
  }
  const connectionPort = connectionUrl.port ? Number.parseInt(connectionUrl.port, 10) : 80;
  const bindPort = transport.httpPort ?? DEFAULT_SIGNAL_MANAGED_NATIVE_PORT;
  if (connectionPort !== bindPort) {
    return false;
  }
  const connectionHost = normalizeSignalEndpointHost(connectionUrl.hostname);
  const bindHost = normalizeSignalEndpointHost(
    transport.httpHost ?? DEFAULT_SIGNAL_MANAGED_NATIVE_HOST,
  );
  if (connectionHost === bindHost) {
    return true;
  }
  if (bindHost === "0.0.0.0") {
    return connectionHost === "localhost" || /^127(?:\.\d{1,3}){3}$/.test(connectionHost);
  }
  if (bindHost === "::") {
    return connectionHost === "localhost" || connectionHost === "::1";
  }
  // Only the ambiguous "localhost" name bridges address families. An exact
  // cross-family pair (127.0.0.1 bind vs ::1 URL) is a different socket — e.g.
  // an IPv6 proxy — and its URL must not be rewritten on bind-port changes.
  return (
    (bindHost === "localhost" && SIGNAL_LOOPBACK_HOST_ALIASES.has(connectionHost)) ||
    (connectionHost === "localhost" && SIGNAL_LOOPBACK_HOST_ALIASES.has(bindHost))
  );
}

export function assignSignalManagedNativePort(
  transport: SignalManagedNativeTransport,
  httpPort: number,
): SignalManagedNativeTransport {
  if (!isValidSignalManagedNativePort(httpPort)) {
    throw new Error("Signal managed native port must be an integer between 1 and 65535.");
  }
  const connectionUrlValue = transport.url;
  // When httpPort is omitted but the connection URL is a bind-aligned local
  // endpoint, treat the URL port as the provisional bind for alignment. That
  // way fallback allocation (preferred port already reserved) still rewrites
  // the probe URL to the allocated port instead of leaving bind and URL
  // divergent (see vincentkoc review on #116176).
  const preferredUrlPort = preferredManagedNativePortFromConnectionUrl(transport);
  const alignmentProbe: SignalManagedNativeTransport =
    preferredUrlPort === undefined ? transport : { ...transport, httpPort: preferredUrlPort };
  if (!connectionUrlValue || !isSignalManagedNativeConnectionUrlForBind(alignmentProbe)) {
    return { ...transport, httpPort };
  }
  const connectionUrl = new URL(connectionUrlValue);
  connectionUrl.port = String(httpPort);
  return {
    ...transport,
    url: normalizeSignalTransportUrl(connectionUrl.toString()),
    httpPort,
  };
}
