// Legacy Signal transport field → managed-native conversion helpers (#116165).
import type { SignalTransportConfig } from "./account-types.js";
import {
  DEFAULT_SIGNAL_MANAGED_NATIVE_PORT,
  isValidSignalManagedNativePort,
  resolveLocalSignalTransportPort,
} from "./transport-policy.js";
import { buildSignalTransportHttpUrl, normalizeSignalTransportUrl } from "./transport-url.js";

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function inherited(entry: Record<string, unknown>, parent: Record<string, unknown>, key: string) {
  return Object.hasOwn(entry, key) ? entry[key] : parent[key];
}

function resolveLegacyManagedBindPort(
  entry: Record<string, unknown>,
  parent: Record<string, unknown>,
): number {
  const rawBindPort = inherited(entry, parent, "httpPort");
  if (typeof rawBindPort === "number" && isValidSignalManagedNativePort(rawBindPort)) {
    return rawBindPort;
  }
  // Infer from loopback httpUrl so autoStart daemon bind matches client probe (#116165).
  const httpUrl = optionalString(inherited(entry, parent, "httpUrl"));
  if (httpUrl) {
    try {
      const localPort = resolveLocalSignalTransportPort(normalizeSignalTransportUrl(httpUrl));
      if (localPort !== undefined && isValidSignalManagedNativePort(localPort)) {
        return localPort;
      }
    } catch {
      // fall through to default
    }
  }
  return DEFAULT_SIGNAL_MANAGED_NATIVE_PORT;
}

function resolveManagedConnectionUrl(
  entry: Record<string, unknown>,
  parent: Record<string, unknown>,
): string | undefined {
  const httpUrl = optionalString(inherited(entry, parent, "httpUrl"));
  if (!httpUrl) {
    return undefined;
  }
  const normalizedUrl = normalizeSignalTransportUrl(httpUrl);
  const endpoint = new URL(normalizedUrl);
  const bindHost = (optionalString(inherited(entry, parent, "httpHost")) ?? "127.0.0.1")
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  const bindPort = resolveLegacyManagedBindPort(entry, parent);
  const endpointHost = endpoint.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const endpointPort = endpoint.port
    ? Number.parseInt(endpoint.port, 10)
    : endpoint.protocol === "https:"
      ? 443
      : 80;
  const matchesBindEndpoint =
    endpoint.protocol === "http:" && endpointHost === bindHost && endpointPort === bindPort;
  return matchesBindEndpoint ? undefined : normalizedUrl;
}

export function buildManagedNativeTransport(
  entry: Record<string, unknown>,
  parent: Record<string, unknown>,
): SignalTransportConfig {
  const value = (key: string) => inherited(entry, parent, key);
  const configPath = optionalString(value("configPath"));
  const cliPath = optionalString(value("cliPath"));
  const url = resolveManagedConnectionUrl(entry, parent);
  const httpHost = optionalString(value("httpHost"));
  const rawHttpPort = value("httpPort");
  const httpPort =
    typeof rawHttpPort === "number" ? rawHttpPort : resolveLegacyManagedBindPort(entry, parent);
  const startupTimeoutMs = value("startupTimeoutMs");
  const receiveMode = value("receiveMode");
  const ignoreStories = value("ignoreStories");
  return {
    kind: "managed-native",
    ...(configPath ? { configPath } : {}),
    ...(cliPath ? { cliPath } : {}),
    ...(url ? { url } : {}),
    ...(httpHost ? { httpHost } : {}),
    ...(typeof httpPort === "number" ? { httpPort } : {}),
    ...(typeof startupTimeoutMs === "number" ? { startupTimeoutMs } : {}),
    ...(receiveMode === "on-start" || receiveMode === "manual" ? { receiveMode } : {}),
    ...(typeof ignoreStories === "boolean" ? { ignoreStories } : {}),
  };
}

export function legacyBaseUrl(
  entry: Record<string, unknown>,
  parent: Record<string, unknown>,
): string {
  const url = optionalString(inherited(entry, parent, "httpUrl"));
  if (url) {
    return normalizeSignalTransportUrl(url);
  }
  const host = optionalString(inherited(entry, parent, "httpHost")) ?? "127.0.0.1";
  const rawPort = inherited(entry, parent, "httpPort");
  const port = typeof rawPort === "number" ? rawPort : 8080;
  return buildSignalTransportHttpUrl(host, port);
}
