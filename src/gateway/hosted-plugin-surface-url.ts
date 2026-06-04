// Hosted plugin surface URL resolver for gateway-advertised plugin node endpoints.
import { parseStrictPositiveInteger } from "../infra/parse-finite-number.js";
import { isLoopbackHost } from "./net.js";

type HostSource = string | null | undefined;

/** Inputs used to infer the externally reachable plugin surface URL. */
export type HostedPluginSurfaceUrlParams = {
  port?: number;
  hostOverride?: HostSource;
  forwardedHost?: HostSource | HostSource[];
  requestHost?: HostSource;
  forwardedProto?: HostSource | HostSource[];
  localAddress?: HostSource;
  scheme?: "http" | "https";
};

const normalizeHost = (value: HostSource, rejectLoopback: boolean) => {
  if (!value) {
    return "";
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  if (rejectLoopback && isLoopbackHost(trimmed)) {
    return "";
  }
  return trimmed;
};

type ParsedHostHeader = {
  host: string;
  port?: number;
};

const parseHostHeader = (value: HostSource): ParsedHostHeader => {
  if (!value) {
    return { host: "" };
  }
  try {
    const parsed = new URL(`http://${value.trim()}`);
    const portRaw = parsed.port.trim();
    const port = parseStrictPositiveInteger(portRaw);
    return {
      host: parsed.hostname,
      port: Number.isFinite(port) ? port : undefined,
    };
  } catch {
    return { host: "" };
  }
};

const parseForwardedProto = (value: HostSource | HostSource[]) => {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
};

const parseForwardedHost = (value: HostSource | HostSource[]) => {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw?.split(",")[0]?.trim();
};

/** Resolve the URL that plugins should advertise for hosted node surfaces. */
export function resolveHostedPluginSurfaceUrl(params: HostedPluginSurfaceUrlParams) {
  const port = params.port;
  if (!port) {
    return undefined;
  }

  const forwardedScheme = parseForwardedProto(params.forwardedProto)?.trim();
  const scheme = forwardedScheme === "https" ? "https" : (params.scheme ?? "http");

  const override = normalizeHost(params.hostOverride, true);
  const forwardedHostRaw = parseForwardedHost(params.forwardedHost);
  const parsedForwardedHost = parseHostHeader(forwardedHostRaw);
  const parsedRequestHost = parseHostHeader(params.requestHost);
  const requestHost = normalizeHost(parsedRequestHost.host, Boolean(override));
  const forwardedHost = normalizeHost(parsedForwardedHost.host, Boolean(override));
  const advertisedHost = forwardedHost ? parsedForwardedHost : parsedRequestHost;
  const localAddress = normalizeHost(
    params.localAddress,
    Boolean(override || forwardedHost || requestHost),
  );

  const host = override || forwardedHost || requestHost || localAddress;
  if (!host) {
    return undefined;
  }

  let exposedPort = port;
  if (!override && (forwardedHost || requestHost) && port === 18789) {
    // Behind a proxy, expose the public Host header port instead of the gateway's local port.
    if (advertisedHost.port && advertisedHost.port > 0) {
      exposedPort = advertisedHost.port;
    } else if (scheme === "https") {
      exposedPort = 443;
    } else if (scheme === "http") {
      exposedPort = 80;
    }
  }

  const formatted = host.includes(":") ? `[${host}]` : host;
  return `${scheme}://${formatted}:${exposedPort}`;
}
