/**
 * Resolves MCP transport command, environment, and timeout configuration.
 */
import {
  asPositiveFiniteNumber,
  clampPositiveTimerTimeoutMs,
  resolvePositiveTimerTimeoutMs,
} from "@openclaw/normalization-core/number-coercion";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import { resolveOpenClawMcpTransportAlias } from "../config/mcp-config-normalize.js";
import { createDedupeCache } from "../infra/dedupe.js";
import { logWarn } from "../logger.js";
import { readTrimmedStringAlias } from "../utils/string-readers.js";
import {
  describeHttpMcpServerLaunchConfig,
  resolveHttpMcpServerLaunchConfig,
  type HttpMcpTransportType,
} from "./mcp-http.js";
import type { McpOAuthConfig } from "./mcp-oauth-provider.js";
import {
  describeStdioMcpServerLaunchConfig,
  resolveStdioMcpServerLaunchConfig,
} from "./mcp-stdio.js";

// Resolves raw MCP server config into the transport shape used by bundle MCP
// runtime startup. Stdio is preferred when launch config is valid; otherwise
// HTTP/SSE transports are attempted with normalized timeout fields.
type ResolvedBaseMcpTransportConfig = {
  description: string;
  connectionTimeoutMs: number;
  requestTimeoutMs: number;
  supportsParallelToolCalls: boolean;
};

type ResolvedStdioMcpTransportConfig = ResolvedBaseMcpTransportConfig & {
  kind: "stdio";
  transportType: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
};

type ResolvedMcpOAuthConfig = McpOAuthConfig & {
  identity?: "shared" | "per-requester";
  authProfileId?: unknown;
};

type ResolvedHttpMcpTransportConfig = ResolvedBaseMcpTransportConfig & {
  kind: "http";
  transportType: HttpMcpTransportType;
  url: string;
  headers?: Record<string, string>;
  auth?: "oauth";
  oauth?: ResolvedMcpOAuthConfig;
  sslVerify?: boolean;
  clientCert?: string;
  clientKey?: string;
};

type ResolvedMcpTransportConfig = ResolvedStdioMcpTransportConfig | ResolvedHttpMcpTransportConfig;

const DEFAULT_CONNECTION_TIMEOUT_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const MAX_WARNED_DROPPED_STDIO_ENV_KEYS = 4096;
// Warning state spans repeated MCP transport resolutions in one gateway process;
// bounding it means evicted server/env pairs can re-warn instead of growing unbounded.
const warnedDroppedStdioEnvKeys = createDedupeCache({
  ttlMs: 0,
  maxSize: MAX_WARNED_DROPPED_STDIO_ENV_KEYS,
});

function warnDroppedStdioEnvOnce(serverName: string, key: string): void {
  const logServerName = sanitizeForLog(serverName);
  const logKey = sanitizeForLog(key);
  if (warnedDroppedStdioEnvKeys.check(JSON.stringify([serverName, key]))) {
    return;
  }
  logWarn(
    `bundle-mcp: server "${logServerName}": env "${logKey}" is blocked for stdio startup safety and was ignored.`,
  );
}

function getPositiveNumber(rawServer: unknown, keys: readonly string[]): number | undefined {
  if (!rawServer || typeof rawServer !== "object") {
    return undefined;
  }
  const record = rawServer as Record<string, unknown>;
  for (const key of keys) {
    const value = asPositiveFiniteNumber(record[key]);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function getConnectionTimeoutMs(rawServer: unknown): number {
  const milliseconds = getPositiveNumber(rawServer, ["connectionTimeoutMs"]);
  if (milliseconds) {
    return clampPositiveTimerTimeoutMs(milliseconds) ?? DEFAULT_CONNECTION_TIMEOUT_MS;
  }
  return DEFAULT_CONNECTION_TIMEOUT_MS;
}

export function resolveMcpRequestTimeoutMs(
  rawServer: unknown,
  fallbackMs = DEFAULT_REQUEST_TIMEOUT_MS,
): number {
  const milliseconds = getPositiveNumber(rawServer, ["requestTimeoutMs"]);
  if (milliseconds) {
    return clampPositiveTimerTimeoutMs(milliseconds) ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }
  return resolvePositiveTimerTimeoutMs(fallbackMs, DEFAULT_REQUEST_TIMEOUT_MS);
}

function getBooleanField(rawServer: unknown, keys: readonly string[]): boolean | undefined {
  if (!rawServer || typeof rawServer !== "object") {
    return undefined;
  }
  const record = rawServer as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") {
      return value;
    }
  }
  return undefined;
}

function getStringField(rawServer: unknown, keys: readonly string[]): string | undefined {
  if (!rawServer || typeof rawServer !== "object") {
    return undefined;
  }
  return readTrimmedStringAlias(rawServer as Record<string, unknown>, keys);
}

function getRequestedTransport(rawServer: unknown): string {
  if (
    !rawServer ||
    typeof rawServer !== "object" ||
    typeof (rawServer as { transport?: unknown }).transport !== "string"
  ) {
    return "";
  }
  return normalizeLowercaseStringOrEmpty((rawServer as { transport?: string }).transport);
}

function getRequestedTransportAlias(rawServer: unknown): HttpMcpTransportType | "" {
  if (
    !rawServer ||
    typeof rawServer !== "object" ||
    typeof (rawServer as { type?: unknown }).type !== "string"
  ) {
    return "";
  }
  return resolveOpenClawMcpTransportAlias((rawServer as { type?: string }).type) ?? "";
}

function resolveHttpTransportConfig(
  serverName: string,
  rawServer: unknown,
  transportType: HttpMcpTransportType,
  logWarnings: boolean,
): ResolvedHttpMcpTransportConfig | null {
  const launch = resolveHttpMcpServerLaunchConfig(
    rawServer,
    logWarnings
      ? {
          transportType,
          onDroppedHeader: (key: string) => {
            logWarn(
              `bundle-mcp: server "${serverName}": header "${key}" has an unsupported value type and was ignored.`,
            );
          },
          onMalformedHeaders: () => {
            logWarn(
              `bundle-mcp: server "${serverName}": "headers" must be a JSON object; the value was ignored.`,
            );
          },
        }
      : { transportType },
  );
  if (!launch.ok) {
    return null;
  }
  return {
    kind: "http",
    transportType: launch.config.transportType,
    url: launch.config.url,
    headers: launch.config.headers,
    ...(rawServer &&
    typeof rawServer === "object" &&
    (rawServer as { auth?: unknown }).auth === "oauth"
      ? { auth: "oauth" as const }
      : {}),
    ...(rawServer &&
    typeof rawServer === "object" &&
    (rawServer as { oauth?: unknown }).oauth &&
    typeof (rawServer as { oauth?: unknown }).oauth === "object" &&
    !Array.isArray((rawServer as { oauth?: unknown }).oauth)
      ? { oauth: (rawServer as { oauth: ResolvedMcpOAuthConfig }).oauth }
      : {}),
    ...(getBooleanField(rawServer, ["sslVerify"]) !== undefined
      ? { sslVerify: getBooleanField(rawServer, ["sslVerify"]) }
      : {}),
    ...(getStringField(rawServer, ["clientCert"])
      ? { clientCert: getStringField(rawServer, ["clientCert"]) }
      : {}),
    ...(getStringField(rawServer, ["clientKey"])
      ? { clientKey: getStringField(rawServer, ["clientKey"]) }
      : {}),
    description: describeHttpMcpServerLaunchConfig(launch.config),
    connectionTimeoutMs: getConnectionTimeoutMs(rawServer),
    requestTimeoutMs: resolveMcpRequestTimeoutMs(rawServer),
    supportsParallelToolCalls: getBooleanField(rawServer, ["supportsParallelToolCalls"]) ?? false,
  };
}

/** Resolve one MCP server's launch transport config, or null when unsupported. */
export function resolveMcpTransportConfig(
  serverName: string,
  rawServer: unknown,
  options?: { logWarnings?: boolean },
): ResolvedMcpTransportConfig | null {
  const logWarnings = options?.logWarnings !== false;
  const requestedTransport = getRequestedTransport(rawServer);
  const requestedTransportAlias = requestedTransport ? "" : getRequestedTransportAlias(rawServer);
  const effectiveTransport = requestedTransport || requestedTransportAlias;
  const stdioLaunch = resolveStdioMcpServerLaunchConfig(
    rawServer,
    logWarnings
      ? {
          onDroppedEnv: (key: string) => {
            warnDroppedStdioEnvOnce(serverName, key);
          },
        }
      : undefined,
  );
  if (stdioLaunch.ok) {
    // A command-bearing server is always treated as stdio even when HTTP-ish
    // aliases are present, matching existing MCP config precedence.
    return {
      kind: "stdio",
      transportType: "stdio",
      command: stdioLaunch.config.command,
      args: stdioLaunch.config.args,
      env: stdioLaunch.config.env,
      cwd: stdioLaunch.config.cwd,
      description: describeStdioMcpServerLaunchConfig(stdioLaunch.config),
      connectionTimeoutMs: getConnectionTimeoutMs(rawServer),
      requestTimeoutMs: resolveMcpRequestTimeoutMs(rawServer),
      supportsParallelToolCalls: getBooleanField(rawServer, ["supportsParallelToolCalls"]) ?? false,
    };
  }

  if (
    effectiveTransport &&
    effectiveTransport !== "sse" &&
    effectiveTransport !== "streamable-http"
  ) {
    if (logWarnings) {
      logWarn(
        `bundle-mcp: skipped server "${sanitizeForLog(serverName)}" because transport "${sanitizeForLog(effectiveTransport)}" is not supported.`,
      );
    }
    return null;
  }

  if (effectiveTransport === "streamable-http") {
    const httpTransport = resolveHttpTransportConfig(
      serverName,
      rawServer,
      "streamable-http",
      logWarnings,
    );
    if (httpTransport) {
      return httpTransport;
    }
  }

  const sseTransport = resolveHttpTransportConfig(serverName, rawServer, "sse", logWarnings);
  if (sseTransport) {
    return sseTransport;
  }

  const httpLaunch = resolveHttpMcpServerLaunchConfig(rawServer);
  const httpReason = httpLaunch.ok ? "not an HTTP MCP server" : httpLaunch.reason;
  if (logWarnings) {
    logWarn(
      `bundle-mcp: skipped server "${sanitizeForLog(serverName)}" because ${stdioLaunch.reason} and ${httpReason}.`,
    );
  }
  return null;
}
