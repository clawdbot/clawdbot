/**
 * Plugin-registered MCP connection resolvers: lookup and per-requester resolve.
 * Resolved url/headers are credentials — never log, fingerprint, or persist them.
 */
import crypto from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveOpenClawMcpTransportAlias } from "../config/mcp-config-normalize.js";
import { logWarn } from "../logger.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { collectLivePluginRegistries } from "../plugins/runtime.js";
import type {
  McpServerConnectionResolved,
  McpServerConnectionResolveContext,
  OpenClawPluginMcpServerConnectionResolver,
} from "../plugins/types.js";
import { isMcpConfigRecord } from "./mcp-config-shared.js";

export type { McpServerConnectionResolved };

type McpServerConnectionResolverEntry = OpenClawPluginMcpServerConnectionResolver & {
  pluginId: string;
};

/** Per-server bound on plugin resolve(); stalled providers must not hang getOrCreate. */
const MCP_CONNECTION_RESOLVER_TIMEOUT_MS = 10_000;
/**
 * How long a full-set requester runtime may skip re-resolve while active.
 * Revocation/rotation takes effect within this window even for continuously active requesters.
 */
const MCP_CONNECTION_REVALIDATE_MS = 5 * 60 * 1000;

const MCP_CONNECTION_RESOLVER_TEST_STATE_KEY = Symbol.for(
  "openclaw.mcpServerConnectionResolverTestState",
);

type McpConnectionResolverTestState = {
  resolversByServerName?: Map<string, McpServerConnectionResolverEntry>;
  resolveTimeoutMs?: number;
  revalidateMs?: number;
};

function getTestState(): McpConnectionResolverTestState {
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  const existing = globalStore[MCP_CONNECTION_RESOLVER_TEST_STATE_KEY] as
    | McpConnectionResolverTestState
    | undefined;
  if (existing) {
    return existing;
  }
  const state: McpConnectionResolverTestState = {};
  globalStore[MCP_CONNECTION_RESOLVER_TEST_STATE_KEY] = state;
  return state;
}

function resolveConnectionResolverTimeoutMs(): number {
  const override = getTestState().resolveTimeoutMs;
  if (typeof override === "number" && Number.isFinite(override) && override > 0) {
    return Math.floor(override);
  }
  return MCP_CONNECTION_RESOLVER_TIMEOUT_MS;
}

export function resolveMcpConnectionRevalidateMs(): number {
  const override = getTestState().revalidateMs;
  if (typeof override === "number" && Number.isFinite(override) && override > 0) {
    return Math.floor(override);
  }
  return MCP_CONNECTION_REVALIDATE_MS;
}

/**
 * Ephemeral per-process HMAC key for connection digests. Never exported, logged,
 * or persisted — dies with the process so digests are not offline-guessable.
 */
let connectionDigestKey: Buffer | undefined;

function getConnectionDigestKey(): Buffer {
  connectionDigestKey ??= crypto.randomBytes(32);
  return connectionDigestKey;
}

/**
 * Ephemeral keyed digest of resolved connection material for rotation detection.
 * HMAC-SHA256 with a process-local random key — not a plain hash of credentials.
 * Never log or persist the preimage (urls/headers) or the key.
 */
export function hashMcpResolvedConnections(
  connections: ReadonlyMap<string, McpServerConnectionResolved>,
): string {
  const tuples = [...connections.entries()]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([serverName, connection]) => {
      const headers = connection.headers
        ? Object.entries(connection.headers).toSorted(([a], [b]) => a.localeCompare(b))
        : [];
      return [serverName, connection.url, headers] as const;
    });
  return crypto
    .createHmac("sha256", getConnectionDigestKey())
    .update(JSON.stringify(tuples))
    .digest("hex");
}

class McpResolverTimeoutError extends Error {
  constructor() {
    super("mcp connection resolver timed out");
    this.name = "McpResolverTimeoutError";
  }
}

function raceWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new McpResolverTimeoutError());
    }, timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** Returns registered connection resolvers keyed by server name (deterministic order). */
function listMcpServerConnectionResolversByServerName(): Map<
  string,
  McpServerConnectionResolverEntry
> {
  const testOverrides = getTestState().resolversByServerName;
  if (testOverrides) {
    return new Map([...testOverrides.entries()].toSorted(([a], [b]) => a.localeCompare(b)));
  }
  const byName = new Map<string, McpServerConnectionResolverEntry>();
  for (const registry of collectLivePluginRegistries()) {
    for (const entry of registry.mcpServerConnectionResolvers) {
      const serverName = normalizeOptionalString(entry.resolver.serverName);
      if (!serverName || typeof entry.resolver.resolve !== "function" || byName.has(serverName)) {
        continue;
      }
      byName.set(serverName, {
        pluginId: entry.pluginId,
        serverName,
        resolve: entry.resolver.resolve,
      });
    }
  }
  return new Map([...byName.entries()].toSorted(([a], [b]) => a.localeCompare(b)));
}

/** Partition loaded MCP servers into static vs requester-scoped by registered resolvers. */
export function partitionMcpServersByConnectionScope<T>(mcpServers: Record<string, T>): {
  staticServers: Record<string, T>;
  requesterScopedServerNames: string[];
} {
  const resolvers = listMcpServerConnectionResolversByServerName();
  const staticServers: Record<string, T> = {};
  const requesterScopedServerNames: string[] = [];
  for (const [serverName, rawServer] of Object.entries(mcpServers).toSorted(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (resolvers.has(serverName)) {
      requesterScopedServerNames.push(serverName);
      continue;
    }
    staticServers[serverName] = rawServer;
  }
  return { staticServers, requesterScopedServerNames };
}

/**
 * Debug-proxy capture and log redaction match registered exact values, not
 * header names alone. Resolver output is credential material (auth headers,
 * signed-URL query tokens), so register it before it can reach any transport.
 */
function registerResolvedConnectionSecrets(connection: McpServerConnectionResolved): void {
  for (const value of Object.values(connection.headers ?? {})) {
    registerSecretValueForRedaction(value);
    // Scheme-prefixed values ("Bearer <token>"): the bare token can appear
    // alone in captured payloads, so register it separately.
    const bareToken = value.trim().split(/\s+/).at(-1);
    if (bareToken && bareToken !== value) {
      registerSecretValueForRedaction(bareToken);
    }
  }
  // The full resolved URL is itself credential material (session/signed paths,
  // e.g. /sessions/<token>/mcp): transport connect errors from fetch/undici
  // embed it verbatim, so exact-value registration must cover the whole string.
  registerSecretValueForRedaction(connection.url);
  try {
    const url = new URL(connection.url);
    for (const queryValue of url.searchParams.values()) {
      registerSecretValueForRedaction(queryValue);
    }
    if (url.password) {
      registerSecretValueForRedaction(url.password);
    }
  } catch {
    // Invalid URLs never reach a transport; nothing to redact.
  }
}

/**
 * Resolve requester-scoped server connections. Fail closed without requesterSenderId:
 * returns an empty map (no shared-connection fallback). Per-server resolve errors and
 * timeouts are logged generically and omitted so one plugin cannot block static MCP.
 * Servers resolve concurrently (each individually bounded).
 */
export async function resolveRequesterScopedMcpConnections(params: {
  serverNames: readonly string[];
  requesterSenderId?: string | null;
  agentAccountId?: string | null;
  messageChannel?: string | null;
}): Promise<Map<string, McpServerConnectionResolved>> {
  const requesterSenderId = normalizeOptionalString(params.requesterSenderId);
  const resolved = new Map<string, McpServerConnectionResolved>();
  if (!requesterSenderId || params.serverNames.length === 0) {
    return resolved;
  }
  const resolvers = listMcpServerConnectionResolversByServerName();
  const ctx: McpServerConnectionResolveContext = {
    requesterSenderId,
    ...(normalizeOptionalString(params.agentAccountId)
      ? { agentAccountId: normalizeOptionalString(params.agentAccountId) }
      : {}),
    ...(normalizeOptionalString(params.messageChannel)
      ? { messageChannel: normalizeOptionalString(params.messageChannel) }
      : {}),
  };
  const timeoutMs = resolveConnectionResolverTimeoutMs();
  const sortedNames = [...params.serverNames].toSorted((a, b) => a.localeCompare(b));
  const settled = await Promise.all(
    sortedNames.map(async (serverName) => {
      const entry = resolvers.get(serverName);
      if (!entry) {
        return null;
      }
      try {
        const result = await raceWithTimeout(Promise.resolve(entry.resolve(ctx)), timeoutMs);
        if (!result || typeof result.url !== "string" || result.url.trim().length === 0) {
          return null;
        }
        const headers =
          result.headers && isMcpConfigRecord(result.headers)
            ? Object.fromEntries(
                Object.entries(result.headers)
                  .filter(
                    (headerEntry): headerEntry is [string, string] =>
                      typeof headerEntry[1] === "string",
                  )
                  .toSorted(([a], [b]) => a.localeCompare(b)),
              )
            : undefined;
        const connection = {
          url: result.url.trim(),
          ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
        } satisfies McpServerConnectionResolved;
        registerResolvedConnectionSecrets(connection);
        return { serverName, connection };
      } catch (error) {
        // External plugin boundary: never fail the whole MCP run for one resolver.
        // Fixed classification only — no dynamic error text (plugin-controlled / secret-bearing).
        const kind =
          error instanceof McpResolverTimeoutError ? "resolver timeout" : "resolver error";
        logWarn(
          `bundle-mcp: connection resolver for server "${serverName}" (plugin "${entry.pluginId}") failed with ${kind}`,
        );
        return null;
      }
    }),
  );
  // Assemble in sorted name order for deterministic map iteration.
  for (const entry of settled) {
    if (entry) {
      resolved.set(entry.serverName, entry.connection);
    }
  }
  return resolved;
}

/**
 * Apply resolved connection fields for transport construction only.
 * Does not mutate the original static config object.
 */
export function applyMcpConnectionOverride(
  rawServer: unknown,
  override: McpServerConnectionResolved,
): Record<string, unknown> {
  const base = isMcpConfigRecord(rawServer) ? { ...rawServer } : {};
  base.url = override.url;
  if (override.headers) {
    base.headers = { ...override.headers };
  } else {
    delete base.headers;
  }
  // Resolve effective transport with the same alias mapping as config canonicalize
  // BEFORE stripping `type`, so SSE-only servers keep sse (including case variants).
  const fromTransport =
    typeof base.transport === "string"
      ? resolveOpenClawMcpTransportAlias(base.transport)
      : undefined;
  const fromType = resolveOpenClawMcpTransportAlias(base.type);
  base.transport = fromTransport ?? fromType ?? "streamable-http";
  // Resolver-supplied headers are the auth surface; strip static OAuth so the
  // transport layer does not drop Authorization from overrides.
  delete base.auth;
  delete base.oauth;
  delete base.type;
  delete base.command;
  delete base.args;
  return base;
}

/**
 * Fingerprint shape for requester-scoped servers: identity + filters only.
 * Never includes resolved or static url/headers credentials.
 */
export function redactMcpServersForFingerprint(
  mcpServers: Record<string, unknown>,
  requesterScopedServerNames: ReadonlySet<string>,
): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [serverName, rawServer] of Object.entries(mcpServers).toSorted(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (!requesterScopedServerNames.has(serverName)) {
      redacted[serverName] = rawServer;
      continue;
    }
    if (!isMcpConfigRecord(rawServer)) {
      redacted[serverName] = { connection: "requester-scoped" };
      continue;
    }
    const {
      url: _url,
      headers: _headers,
      command: _command,
      args: _args,
      env: _env,
      ...rest
    } = rawServer;
    redacted[serverName] = {
      ...rest,
      connection: "requester-scoped",
    };
  }
  return redacted;
}

export function buildMcpRequesterRuntimeCacheKey(params: {
  sessionId: string;
  messageChannel?: string | null;
  agentAccountId?: string | null;
  requesterSenderId: string;
}): string {
  // Composite key for requester-scoped runtimes. Static runtimes keep bare sessionId.
  return JSON.stringify({
    sessionId: params.sessionId,
    messageChannel: normalizeOptionalString(params.messageChannel) ?? "",
    agentAccountId: normalizeOptionalString(params.agentAccountId) ?? "",
    requesterSenderId: params.requesterSenderId,
  });
}

export const testing = {
  setMcpServerConnectionResolversForTest(
    resolvers?: Iterable<OpenClawPluginMcpServerConnectionResolver & { pluginId?: string }> | null,
  ): void {
    if (!resolvers) {
      getTestState().resolversByServerName = undefined;
      return;
    }
    const map = new Map<string, McpServerConnectionResolverEntry>();
    for (const resolver of resolvers) {
      const serverName = normalizeOptionalString(resolver.serverName);
      if (!serverName || typeof resolver.resolve !== "function") {
        continue;
      }
      map.set(serverName, {
        pluginId: normalizeOptionalString(resolver.pluginId) ?? "test-plugin",
        serverName,
        resolve: resolver.resolve,
      });
    }
    getTestState().resolversByServerName = map;
  },
  setMcpConnectionResolverTimeoutMsForTest(timeoutMs?: number): void {
    getTestState().resolveTimeoutMs =
      typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
        ? Math.floor(timeoutMs)
        : undefined;
  },
  setMcpConnectionRevalidateMsForTest(revalidateMs?: number): void {
    getTestState().revalidateMs =
      typeof revalidateMs === "number" && Number.isFinite(revalidateMs) && revalidateMs > 0
        ? Math.floor(revalidateMs)
        : undefined;
  },
};
