import { isLoopbackHost } from "./net.js";

type HostSource = string | null | undefined;

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
    const port = portRaw ? Number.parseInt(portRaw, 10) : undefined;
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
  const requestHost = normalizeHost(parsedRequestHost.host, !!override);
  const forwardedHost = normalizeHost(parsedForwardedHost.host, !!override);
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
