/**
 * Resolves MCP transport command, environment, and timeout configuration.
 */
import {
  clampPositiveTimerTimeoutMs,
  resolvePositiveTimerTimeoutMs,
} from "@openclaw/normalization-core/number-coercion";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import { resolveOpenClawMcpTransportAlias } from "../config/mcp-config-normalize.js";
import { logWarn } from "../logger.js";
import { readTrimmedStringAlias } from "../utils/string-readers.js";
import {
  describeHttpMcpServerLaunchConfig,
  resolveHttpMcpServerLaunchConfig,
  type HttpMcpTransportType,
} from "./mcp-http.js";
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

type ResolvedHttpMcpTransportConfig = ResolvedBaseMcpTransportConfig & {
  kind: "http";
  transportType: HttpMcpTransportType;
  url: string;
  headers?: Record<string, string>;
  auth?: "oauth";
  oauth?: Record<string, unknown>;
  sslVerify?: boolean;
  clientCert?: string;
  clientKey?: string;
};

type ResolvedMcpTransportConfig = ResolvedStdioMcpTransportConfig | ResolvedHttpMcpTransportConfig;

const DEFAULT_CONNECTION_TIMEOUT_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

function getPositiveNumber(rawServer: unknown, keys: readonly string[]): number | undefined {
  if (!rawServer || typeof rawServer !== "object") {
    return undefined;
  }
  const record = rawServer as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
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
): ResolvedHttpMcpTransportConfig | null {
  const launch = resolveHttpMcpServerLaunchConfig(rawServer, {
    transportType,
    onDroppedHeader: (key) => {
      logWarn(
        `bundle-mcp: server "${serverName}": header "${key}" has an unsupported value type and was ignored.`,
      );
    },
    onMalformedHeaders: () => {
      logWarn(
        `bundle-mcp: server "${serverName}": "headers" must be a JSON object; the value was ignored.`,
      );
    },
  });
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
      ? { oauth: (rawServer as { oauth: Record<string, unknown> }).oauth }
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
): ResolvedMcpTransportConfig | null {
  const logServerName = sanitizeForLog(serverName);
  const requestedTransport = getRequestedTransport(rawServer);
  const requestedTransportAlias = requestedTransport ? "" : getRequestedTransportAlias(rawServer);
  const effectiveTransport = requestedTransport || requestedTransportAlias;
  const stdioLaunch = resolveStdioMcpServerLaunchConfig(rawServer, {
    onDroppedEnv: (key) => {
      logWarn(
        `bundle-mcp: server "${logServerName}": env "${sanitizeForLog(key)}" is blocked for stdio startup safety and was ignored.`,
      );
    },
  });
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
    logWarn(
      `bundle-mcp: skipped server "${logServerName}" because transport "${sanitizeForLog(effectiveTransport)}" is not supported.`,
    );
    return null;
  }

  if (effectiveTransport === "streamable-http") {
    const httpTransport = resolveHttpTransportConfig(serverName, rawServer, "streamable-http");
    if (httpTransport) {
      return httpTransport;
    }
  }

  const sseTransport = resolveHttpTransportConfig(serverName, rawServer, "sse");
  if (sseTransport) {
    return sseTransport;
  }

  const httpLaunch = resolveHttpMcpServerLaunchConfig(rawServer);
  const httpReason = httpLaunch.ok ? "not an HTTP MCP server" : httpLaunch.reason;
  logWarn(
    `bundle-mcp: skipped server "${logServerName}" because ${stdioLaunch.reason} and ${httpReason}.`,
  );
  return null;
}
