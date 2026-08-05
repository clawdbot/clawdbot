import { isRecord } from "openclaw/plugin-sdk/channel-secret-basic-runtime";
import type { SignalTransportConfig } from "./account-types.js";
import {
  isValidSignalManagedNativePort,
  inferLegacyManagedNativePortFromConnectionUrl,
} from "./transport-policy.js";
import { buildSignalTransportHttpUrl, normalizeSignalTransportUrl } from "./transport-url.js";

export function isSignalTransportConfig(value: unknown): value is SignalTransportConfig {
  if (!isRecord(value)) {
    return false;
  }
  if (value.kind === "managed-native") {
    if (value.httpPort !== undefined && !isValidSignalManagedNativePort(value.httpPort)) {
      return false;
    }
    if (value.url === undefined) {
      return true;
    }
    if (typeof value.url !== "string") {
      return false;
    }
    try {
      normalizeSignalTransportUrl(value.url);
      return true;
    } catch {
      return false;
    }
  }
  if (
    (value.kind !== "external-native" && value.kind !== "container") ||
    typeof value.url !== "string"
  ) {
    return false;
  }
  try {
    normalizeSignalTransportUrl(value.url);
    return true;
  } catch {
    return false;
  }
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function inherited(
  entry: Record<string, unknown>,
  parent: Record<string, unknown>,
  key: string,
) {
  return Object.hasOwn(entry, key) ? entry[key] : parent[key];
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

export function requiresDetection(
  entry: Record<string, unknown>,
  parent: Record<string, unknown>,
  apiMode: unknown,
): boolean {
  if (apiMode !== undefined && apiMode !== "auto") {
    return false;
  }
  return (
    Boolean(optionalString(inherited(entry, parent, "httpUrl"))) ||
    !resolveLegacyAutoStart(entry, parent)
  );
}

export function resolveLegacyAutoStart(
  entry: Record<string, unknown>,
  parent: Record<string, unknown>,
): boolean {
  const autoStart = inherited(entry, parent, "autoStart");
  if (typeof autoStart === "boolean") {
    return autoStart;
  }
  return !optionalString(inherited(entry, parent, "httpUrl"));
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
  const rawBindPort = inherited(entry, parent, "httpPort");
  const bindPort = typeof rawBindPort === "number" ? rawBindPort : 8080;
  const endpointHost = endpoint.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const endpointPort = endpoint.port
    ? Number.parseInt(endpoint.port, 10)
    : endpoint.protocol === "https:"
      ? 443
      : 80;
  const matchesBindEndpoint =
    endpoint.protocol === "http:" && endpointHost === bindHost && endpointPort === bindPort;
  // An explicit legacy httpPort owns the daemon bind, even when httpUrl carries a proxy path.
  // Drop the same-port URL during migration so account resolution does not reject a self-collision.
  if (matchesBindEndpoint && rawBindPort !== undefined) {
    return undefined;
  }
  if (matchesBindEndpoint && endpoint.pathname === "/") {
    return undefined;
  }
  return normalizedUrl;
}

export function buildManagedNativeTransport(
  entry: Record<string, unknown>,
  parent: Record<string, unknown>,
): SignalTransportConfig {
  const value = (key: string) => inherited(entry, parent, key);
  const configPath = optionalString(value("configPath"));
  const cliPath = optionalString(value("cliPath"));
  const sourceUrl = optionalString(value("httpUrl"));
  const url = resolveManagedConnectionUrl(entry, parent);
  const httpHost = optionalString(value("httpHost"));
  const rawHttpPort = value("httpPort");
  const inferredHttpPort =
    typeof rawHttpPort !== "number"
      ? inferLegacyManagedNativePortFromConnectionUrl(
          {
            kind: "managed-native",
            ...(url ? { url } : {}),
            ...(httpHost ? { httpHost } : {}),
          },
          sourceUrl,
        )
      : undefined;
  const httpPort = typeof rawHttpPort === "number" ? rawHttpPort : inferredHttpPort;
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
