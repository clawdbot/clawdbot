/** Session-scoped MCP runtime catalog loader and transport lifecycle. */
import { Client, type ClientOptions } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  ErrorCode,
  McpError,
  type CallToolResult,
  type ClientCapabilities,
  type ServerCapabilities,
} from "@modelcontextprotocol/sdk/types.js";
import { redactSensitiveUrlLikeString } from "@openclaw/net-policy/redact-sensitive-url";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { SessionToolOverrides } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { logWarn } from "../logger.js";
import { redactToolPayloadText } from "../logging/redact.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { runTasksWithConcurrency } from "../utils/run-with-concurrency.js";
import { mergeMcpToolCatalogs } from "./agent-bundle-mcp-combined.js";
import {
  completeDeferredSessionMcpRuntimeRetirement,
  disposeAllSessionMcpRuntimes,
  getAdvertisedScopedMcpCatalog,
  getOrCreateRequesterScopedMcpRuntime,
  getOrCreateSessionMcpRuntime,
  getSessionMcpRuntimeManagerForTesting,
  peekSessionMcpRuntime,
  rememberAdvertisedScopedMcpCatalog,
  retireSessionMcpRuntime,
  retireSessionMcpRuntimeForSessionKey,
} from "./agent-bundle-mcp-manager-api.js";
import {
  createSessionMcpRuntimeManager,
  setDefaultCreateSessionMcpRuntime,
} from "./agent-bundle-mcp-manager.js";
import { assignSafeServerNames, sanitizeServerName } from "./agent-bundle-mcp-names.js";
import { getSessionMcpRequestSignal } from "./agent-bundle-mcp-request-context.js";
import {
  loadSessionMcpConfig,
  resolveSessionMcpConfigSummary,
} from "./agent-bundle-mcp-runtime-config.js";
import {
  resolveSessionMcpRuntimeIdleTtlMs,
  waitForSessionMcpRequest,
} from "./agent-bundle-mcp-runtime-shared.js";
import type {
  McpCatalogTool,
  McpRequestOptions,
  McpServerCatalog,
  McpToolCatalog,
  McpToolCatalogDiagnostic,
  RequesterMcpConnect,
  SessionMcpRequesterScope,
  SessionMcpRuntime,
  SessionMcpRuntimeManager,
} from "./agent-bundle-mcp-types.js";
import {
  connectMcpClient,
  disposeMcpClient,
  isStatefulMcpHttpSessionExpired,
  McpClientConnectTimeoutError,
} from "./mcp-client-lifecycle.js";
import {
  normalizeMcpCodexToolAnnotations,
  resolveMcpCodexToolApprovalMode,
} from "./mcp-codex-tool-approval.js";
import {
  applyMcpConnectionOverride,
  type McpServerConnectionResolved,
} from "./mcp-connection-resolver.js";
import { createMcpJsonSchemaValidator } from "./mcp-json-schema-validator.js";
import { sanitizeMcpMetadataText } from "./mcp-metadata.js";
import { collectMcpPaginatedItems } from "./mcp-pagination.js";
import { isMcpToolAllowed, normalizeMcpToolFilter } from "./mcp-tool-filter.js";
import { resolveMcpTransport } from "./mcp-transport.js";

type BundleMcpSession = {
  serverName: string;
  client: Client;
  transport: Transport;
  transportType: "stdio" | "sse" | "streamable-http";
  requestTimeoutMs: number;
  supportsParallelToolCalls: boolean;
  connected: boolean;
  disconnectReason?: string;
  retiring: boolean;
  catalogUseCount: number;
  sharedAcrossCatalogGenerations: boolean;
  connectPromise?: Promise<void>;
  detachStderr?: () => void;
};

type ListedTool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];
const MCP_APPS_CLIENT_EXTENSION = "io.modelcontextprotocol/ui";
const MCP_APP_RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";
const BUNDLE_MCP_FAILURE_THRESHOLD = 3;
const BUNDLE_MCP_FAILURE_COOLDOWN_MS = 60_000;
const BUNDLE_MCP_CATALOG_FAILURE_RETRY_MS = 5_000;
const BUNDLE_MCP_CATALOG_LIST_TIMEOUT_MS = 1_500;
const BUNDLE_MCP_DISPOSE_TIMEOUT_MS = 5_000;
const BUNDLE_MCP_CATALOG_CONNECT_CONCURRENCY = 6;
const BUNDLE_MCP_MAX_LIST_PAGES = 128;
const BUNDLE_MCP_MAX_LIST_ITEMS = 16_384;
const BUNDLE_MCP_MAX_LIST_BYTES = 10 * 1024 * 1024;
let bundleMcpCatalogListTimeoutMs: number | undefined;
const BUNDLE_MCP_TEST_STATE_KEY = Symbol.for("openclaw.bundleMcpTestState");
type BundleMcpTestState = { disposeTimeoutMs?: number };

function getBundleMcpTestState(): BundleMcpTestState {
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  const existing = globalStore[BUNDLE_MCP_TEST_STATE_KEY] as BundleMcpTestState | undefined;
  if (existing) {
    return existing;
  }
  const state: BundleMcpTestState = {};
  globalStore[BUNDLE_MCP_TEST_STATE_KEY] = state;
  return state;
}

type McpServerBackoffState = {
  session: BundleMcpSession;
  failures: number;
  retryAfterMs?: number;
};

export { createMcpJsonSchemaValidator as createBundleMcpJsonSchemaValidator };

function redactMcpDiagnosticError(error: unknown): string {
  return redactToolPayloadText(redactSensitiveUrlLikeString(String(error)));
}

async function listAllTools(client: Client, timeoutMs: number, signal: AbortSignal) {
  return await collectMcpPaginatedItems({
    label: "MCP tool listing",
    itemLabel: "tools",
    timeoutMs,
    maxPages: BUNDLE_MCP_MAX_LIST_PAGES,
    maxItems: BUNDLE_MCP_MAX_LIST_ITEMS,
    maxBytes: BUNDLE_MCP_MAX_LIST_BYTES,
    signal,
    loadPage: async ({ cursor, requestTimeoutMs, signal: requestSignal }) => {
      const requestController = new AbortController();
      const onAbort = () => requestController.abort(requestSignal.reason);
      requestSignal.addEventListener("abort", onAbort, { once: true });
      if (requestSignal.aborted) {
        onAbort();
      }
      try {
        const page = await client.listTools(cursor === undefined ? undefined : { cursor }, {
          timeout: requestTimeoutMs,
          maxTotalTimeout: requestTimeoutMs,
          signal: requestController.signal,
        });
        return { items: page.tools, nextCursor: page.nextCursor, serializedValue: page };
      } finally {
        requestSignal.removeEventListener("abort", onAbort);
      }
    },
  });
}

function isMcpMethodNotFoundError(error: unknown): boolean {
  if (isRecord(error) && error.code === ErrorCode.MethodNotFound) {
    return true;
  }
  const message = String(error);
  return message.includes("-32601") || /\b(?:method not found|unknown method)\b/i.test(message);
}

async function listAllToolsBestEffort(params: {
  client: Client;
  timeoutMs: number;
  signal: AbortSignal;
  suppressUnsupported: boolean;
}): Promise<ListedTool[]> {
  try {
    return await listAllTools(params.client, params.timeoutMs, params.signal);
  } catch (error) {
    if (params.suppressUnsupported && isMcpMethodNotFoundError(error)) {
      return [];
    }
    throw error;
  }
}

function hasConfiguredMcpRequestTimeout(rawServer: unknown): boolean {
  if (!rawServer || typeof rawServer !== "object") {
    return false;
  }
  const record = rawServer as Record<string, unknown>;
  for (const key of ["requestTimeoutMs", "timeout"]) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return true;
    }
  }
  return false;
}

function getCatalogListTimeoutMs(rawServer: unknown, requestTimeoutMs: number): number {
  if (bundleMcpCatalogListTimeoutMs !== undefined) {
    return bundleMcpCatalogListTimeoutMs;
  }
  return hasConfiguredMcpRequestTimeout(rawServer)
    ? requestTimeoutMs
    : BUNDLE_MCP_CATALOG_LIST_TIMEOUT_MS;
}

function setBundleMcpCatalogListTimeoutMsForTest(timeoutMs?: number): void {
  bundleMcpCatalogListTimeoutMs =
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? Math.floor(timeoutMs)
      : undefined;
}

function setBundleMcpDisposeTimeoutMsForTest(timeoutMs?: number): void {
  // Non-isolated test workers can reload this module while a facade still
  // references an older copy. Share the override across those copies.
  getBundleMcpTestState().disposeTimeoutMs =
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? Math.floor(timeoutMs)
      : undefined;
}

function disposeBundleMcpSession(session: BundleMcpSession): Promise<void> {
  return disposeMcpClient(
    session,
    getBundleMcpTestState().disposeTimeoutMs ?? BUNDLE_MCP_DISPOSE_TIMEOUT_MS,
  );
}

function buildMcpClientCapabilities(mcpAppsEnabled: boolean): ClientCapabilities {
  return mcpAppsEnabled
    ? {
        extensions: {
          [MCP_APPS_CLIENT_EXTENSION]: { mimeTypes: [MCP_APP_RESOURCE_MIME_TYPE] },
        },
      }
    : {};
}

function buildMcpClientOptions(mcpAppsEnabled: boolean): ClientOptions {
  return { capabilities: buildMcpClientCapabilities(mcpAppsEnabled) };
}

function normalizeToolUiVisibility(value: unknown): Array<"app" | "model"> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value.filter(
    (entry): entry is "app" | "model" => entry === "app" || entry === "model",
  );
  return [...new Set(normalized)].toSorted();
}

function summarizeServerCapabilities(capabilities: ServerCapabilities | undefined) {
  return {
    resources: capabilities?.resources
      ? { listChanged: capabilities.resources.listChanged === true }
      : undefined,
    prompts: capabilities?.prompts
      ? { listChanged: capabilities.prompts.listChanged === true }
      : undefined,
    tools: capabilities?.tools
      ? { listChanged: capabilities.tools.listChanged === true }
      : undefined,
  };
}
function createDisposedError(sessionId: string): Error {
  return new Error(`bundle-mcp runtime disposed for session ${sessionId}`);
}

export function createSessionMcpRuntime(params: {
  sessionId: string;
  sessionKey?: string;
  workspaceDir: string;
  agentDir?: string;
  cfg?: OpenClawConfig;
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
  includeServerNames?: ReadonlySet<string>;
  excludeServerNames?: ReadonlySet<string>;
  /**
   * Precomputed name→safeName for the full declared server set. Required for
   * stable tool names when this runtime holds only a subset of servers.
   */
  safeServerNamesByServer?: ReadonlyMap<string, string>;
  /** Resolved per-requester url/headers; never logged/persisted as credentials. */
  connectionOverrides?: ReadonlyMap<string, McpServerConnectionResolved>;
  redactConnectionServerNames?: ReadonlySet<string>;
  requesterScope?: SessionMcpRequesterScope;
  requesterConnect?: RequesterMcpConnect;
  configFingerprint?: string;
  toolOverrides?: Pick<SessionToolOverrides, "mcpServers" | "mcpToolsDeny">;
}): SessionMcpRuntime {
  const { loaded, fingerprint: computedFingerprint } = loadSessionMcpConfig({
    workspaceDir: params.workspaceDir,
    cfg: params.cfg,
    logDiagnostics: true,
    manifestRegistry: params.manifestRegistry,
    includeServerNames: params.includeServerNames,
    excludeServerNames: params.excludeServerNames,
    redactConnectionServerNames: params.redactConnectionServerNames,
    safeServerNamesByServer: params.safeServerNamesByServer,
    toolOverrides: params.toolOverrides,
  });
  const configFingerprint = params.configFingerprint ?? computedFingerprint;
  const mcpAppsEnabled = params.cfg?.mcp?.apps?.enabled === true;
  const createdAt = Date.now();
  let lastUsedAt = createdAt;
  let activeLeases = 0;
  let disposed = false;
  const lifecycleAbortController = new AbortController();
  let catalog: McpToolCatalog | null = null;
  let catalogRetryAfterMs: number | undefined;
  let catalogInFlight: Promise<McpToolCatalog> | undefined;
  let catalogInvalidationGeneration = 0;
  const invalidateCatalog = () => {
    catalogInvalidationGeneration += 1;
    catalog = null;
    catalogRetryAfterMs = undefined;
    catalogInFlight = undefined;
  };
  const scheduleCatalogServerRetry = (serverName: string, message: string) => {
    const currentCatalog = catalog;
    const server = currentCatalog?.servers[serverName];
    const existing = currentCatalog?.diagnostics?.find(
      (diagnostic) => diagnostic.serverName === serverName,
    );
    if (!currentCatalog) {
      invalidateCatalog();
      return;
    }
    let diagnostic: McpToolCatalogDiagnostic;
    if (existing) {
      diagnostic = { ...existing, message };
    } else if (server) {
      diagnostic = {
        serverName,
        safeServerName: server.safeServerName ?? serverName,
        launchSummary: server.launchSummary,
        message,
      };
    } else {
      invalidateCatalog();
      return;
    }
    catalogInvalidationGeneration += 1;
    catalog = {
      ...currentCatalog,
      diagnostics: [
        ...(currentCatalog.diagnostics?.filter((entry) => entry.serverName !== serverName) ?? []),
        diagnostic,
      ].toSorted((left, right) => left.serverName.localeCompare(right.serverName)),
    };
    catalogRetryAfterMs = Date.now();
    catalogInFlight = undefined;
  };
  const catalogRetryIsDue = (): boolean =>
    catalogRetryAfterMs !== undefined && Date.now() >= catalogRetryAfterMs;
  const sessions = new Map<string, BundleMcpSession>();
  const serverBackoff = new Map<string, McpServerBackoffState>();
  const recordServerToolFailure = (
    serverName: string,
    session: BundleMcpSession,
    nowMs: number,
  ) => {
    if (sessions.get(serverName) !== session || session.retiring) {
      return undefined;
    }
    const previous = serverBackoff.get(serverName);
    const failures = (previous?.session === session ? previous.failures : 0) + 1;
    const nextBackoff: McpServerBackoffState = { session, failures };
    if (failures >= BUNDLE_MCP_FAILURE_THRESHOLD) {
      nextBackoff.retryAfterMs = nowMs + BUNDLE_MCP_FAILURE_COOLDOWN_MS;
    }
    serverBackoff.set(serverName, nextBackoff);
    return failures;
  };
  const failIfDisposed = () => {
    if (disposed) {
      throw createDisposedError(params.sessionId);
    }
  };
  const requireConnectedSession = (serverName: string): BundleMcpSession => {
    const session = sessions.get(serverName);
    if (!session || !session.connected) {
      throw new Error(
        session?.disconnectReason
          ? `bundle-mcp server "${serverName}" is disconnected: ${session.disconnectReason}`
          : `bundle-mcp server "${serverName}" is not connected`,
      );
    }
    return session;
  };
  const ensureSessionConnected = async (
    session: BundleMcpSession,
    connectionTimeoutMs: number,
  ): Promise<void> => {
    if (session.retiring) {
      throw new Error(`bundle-mcp server "${session.serverName}" is retiring`);
    }
    if (session.connected) {
      return;
    }
    session.connectPromise ??= connectMcpClient({
      client: session.client,
      transport: session.transport,
      timeoutMs: connectionTimeoutMs,
    })
      .catch((error: unknown) => {
        if (error instanceof McpClientConnectTimeoutError) {
          throw new Error(
            `MCP server "${session.serverName}" timed out: did not complete initialize within ${connectionTimeoutMs / 1_000}s`,
            { cause: error },
          );
        }
        throw error;
      })
      .then(() => {
        session.connected = true;
      })
      .finally(() => {
        session.connectPromise = undefined;
      });
    await session.connectPromise;
  };
  const retireSessionIfCurrent = async (
    serverName: string,
    session: BundleMcpSession,
  ): Promise<boolean> => {
    if (sessions.get(serverName) !== session) {
      return false;
    }
    session.retiring = true;
    sessions.delete(serverName);
    await disposeBundleMcpSession(session);
    return true;
  };
  const localRequestTimeouts = new WeakSet<object>();
  const resolveRequestSignal = (explicitSignal?: AbortSignal): AbortSignal | undefined => {
    const contextSignal = getSessionMcpRequestSignal();
    if (!explicitSignal || explicitSignal === contextSignal) {
      return explicitSignal ?? contextSignal;
    }
    return contextSignal ? AbortSignal.any([explicitSignal, contextSignal]) : explicitSignal;
  };
  const runMcpRequest = async <T>(
    session: BundleMcpSession,
    request: (signal: AbortSignal) => Promise<T>,
    parentSignal?: AbortSignal,
  ): Promise<T> => {
    const requestSignal = resolveRequestSignal(parentSignal);
    const abortController = new AbortController();
    const onParentAbort = () => abortController.abort(requestSignal?.reason);
    if (requestSignal?.aborted) {
      onParentAbort();
    } else {
      requestSignal?.addEventListener("abort", onParentAbort, { once: true });
    }
    const timeoutError = new McpError(ErrorCode.RequestTimeout, "Request timed out", {
      timeout: session.requestTimeoutMs,
    });
    const timeout = setTimeout(() => {
      localRequestTimeouts.add(timeoutError);
      abortController.abort(timeoutError);
    }, session.requestTimeoutMs);
    timeout.unref?.();
    try {
      const signal = abortController.signal;
      signal.throwIfAborted();
      const result = await request(signal);
      requestSignal?.throwIfAborted();
      return result;
    } catch (error) {
      requestSignal?.throwIfAborted();
      throw error;
    } finally {
      requestSignal?.removeEventListener("abort", onParentAbort);
      clearTimeout(timeout);
    }
  };
  const runGuardedServerRequest = async <T>(
    serverName: string,
    session: BundleMcpSession,
    request: () => Promise<T>,
    options?: McpRequestOptions,
  ): Promise<T> => {
    const requestSignal = resolveRequestSignal(options?.signal);
    const tracksFailureBackoff = options?.failureBackoff !== "ignore";
    const nowMs = Date.now();
    const backoff = serverBackoff.get(serverName);
    if (
      tracksFailureBackoff &&
      backoff?.session === session &&
      backoff.retryAfterMs &&
      nowMs < backoff.retryAfterMs
    ) {
      throw new Error(
        `bundle-mcp server "${serverName}" is paused after repeated tool failures; retry after ${new Date(backoff.retryAfterMs).toISOString()}`,
      );
    }
    if (backoff && backoff.session !== session) {
      serverBackoff.delete(serverName);
    }
    try {
      const result = await request();
      if (tracksFailureBackoff && serverBackoff.get(serverName)?.session === session) {
        serverBackoff.delete(serverName);
      }
      return result;
    } catch (error) {
      // A stateful server uses HTTP 404 to invalidate an expired MCP session.
      // Reinitialize a fresh client, but never replay a possibly mutating call.
      const sessionExpired = isStatefulMcpHttpSessionExpired(session, error);
      let recycleReason: "expired HTTP session" | "repeated request timeouts" | undefined;
      if (sessionExpired && !requestSignal?.aborted) {
        recycleReason = "expired HTTP session";
      } else if (tracksFailureBackoff && !requestSignal?.aborted) {
        const failures = recordServerToolFailure(serverName, session, nowMs);
        const requestTimedOut =
          error !== null && typeof error === "object" && localRequestTimeouts.has(error);
        if (requestTimedOut && failures && failures >= BUNDLE_MCP_FAILURE_THRESHOLD) {
          recycleReason = "repeated request timeouts";
        }
      }
      if (recycleReason) {
        serverBackoff.delete(serverName);
        scheduleCatalogServerRetry(serverName, recycleReason);
        const timedOut = recycleReason === "repeated request timeouts";
        logWarn(
          `bundle-mcp: recycling server "${serverName}" after ${timedOut ? "repeated timeouts" : "an expired HTTP session"}`,
        );
        void retireSessionIfCurrent(serverName, session).catch((retireError: unknown) => {
          logWarn(
            `bundle-mcp: failed to retire ${timedOut ? "timed-out" : "expired-session"} server "${serverName}": ${redactMcpDiagnosticError(retireError)}`,
          );
        });
      }
      throw error;
    }
  };
  const runGuardedMcpRequest = <T>(
    serverName: string,
    session: BundleMcpSession,
    request: (signal: AbortSignal) => Promise<T>,
    options?: McpRequestOptions,
  ) =>
    runGuardedServerRequest(
      serverName,
      session,
      () => runMcpRequest(session, request, options?.signal),
      options,
    );
  const collectServerItems = (
    session: BundleMcpSession,
    kind: "prompts" | "resources",
    options?: Pick<McpRequestOptions, "signal">,
  ) => {
    const callerSignal = resolveRequestSignal(options?.signal);
    return collectMcpPaginatedItems({
      label: `MCP ${kind === "resources" ? "resource" : "prompt"} listing`,
      itemLabel: kind,
      timeoutMs: session.requestTimeoutMs,
      maxPages: BUNDLE_MCP_MAX_LIST_PAGES,
      maxItems: BUNDLE_MCP_MAX_LIST_ITEMS,
      maxBytes: BUNDLE_MCP_MAX_LIST_BYTES,
      signal: callerSignal
        ? AbortSignal.any([lifecycleAbortController.signal, callerSignal])
        : lifecycleAbortController.signal,
      loadPage: ({ cursor, requestTimeoutMs: timeout, signal }) =>
        runMcpRequest(
          session,
          async (requestSignal) => {
            const requestParams = cursor === undefined ? undefined : { cursor };
            const requestOptions = { timeout, maxTotalTimeout: timeout, signal: requestSignal };
            const page =
              kind === "resources"
                ? await session.client.listResources(requestParams, requestOptions)
                : await session.client.listPrompts(requestParams, requestOptions);
            const items = page[kind] as unknown[];
            return { items, nextCursor: page.nextCursor, serializedValue: page };
          },
          signal,
        ),
    });
  };

  const loadCatalog = async (
    retryBaseCatalog?: McpToolCatalog,
    options?: Pick<McpRequestOptions, "signal">,
  ): Promise<McpToolCatalog> => {
    failIfDisposed();
    options?.signal?.throwIfAborted();
    if (catalogInFlight) {
      return await waitForSessionMcpRequest(catalogInFlight, options?.signal);
    }
    const retryServerNames = retryBaseCatalog
      ? new Set(retryBaseCatalog.diagnostics?.map((diagnostic) => diagnostic.serverName))
      : undefined;
    const catalogGeneration = catalogInvalidationGeneration;
    const inFlight = (async () => {
      if (Object.keys(loaded.mcpServers).length === 0) {
        return {
          version: 1,
          generatedAt: Date.now(),
          servers: {},
          tools: [],
        };
      }

      // A cooldown retry replaces only diagnostic-bearing servers. Healthy clients
      // keep their SDK tool-metadata snapshot and remain callable during recovery.
      const servers: Record<string, McpServerCatalog> = Object.fromEntries(
        Object.entries(retryBaseCatalog?.servers ?? {}).filter(
          ([serverName]) => !retryServerNames?.has(serverName),
        ),
      );
      const tools: McpCatalogTool[] = (retryBaseCatalog?.tools ?? []).filter(
        (tool) => !retryServerNames?.has(tool.serverName),
      );
      const sessionDeniedTools: McpCatalogTool[] = (
        retryBaseCatalog?.sessionDeniedTools ?? []
      ).filter((tool) => !retryServerNames?.has(tool.serverName));
      const diagnostics: McpToolCatalogDiagnostic[] = [];
      // Prefer session-wide precomputed assignments; fall back only for isolated runtimes.
      const safeServerNamesByServer =
        params.safeServerNamesByServer ?? assignSafeServerNames(Object.keys(loaded.mcpServers));
      const usedServerNames = new Set<string>(
        [...safeServerNamesByServer.values()].map((name) => normalizeLowercaseStringOrEmpty(name)),
      );

      try {
        // Safe names come from the full declared set (precomputed), not from who resolved.
        const preparedEntries: Array<{
          serverName: string;
          rawServer: (typeof loaded.mcpServers)[string];
          resolved: NonNullable<ReturnType<typeof resolveMcpTransport>>;
          safeServerName: string;
          launchDescription: string;
        }> = [];
        for (const [serverName, rawServer] of Object.entries(loaded.mcpServers)) {
          failIfDisposed();
          if (retryServerNames && !retryServerNames.has(serverName)) {
            continue;
          }
          const override = params.connectionOverrides?.get(serverName);
          // Overrides supply per-requester transport only; never write them back to config.
          const transportSource = override
            ? applyMcpConnectionOverride(rawServer, override)
            : rawServer;
          const dataDirOwnership = Object.hasOwn(loaded.prepareDataDirsByServer ?? {}, serverName)
            ? loaded.prepareDataDirsByServer?.[serverName]
            : undefined;
          const resolved = resolveMcpTransport(serverName, transportSource, {
            cfg: params.cfg,
            agentDir: params.agentDir,
            prepareDataDir: dataDirOwnership?.dataDir,
            requesterScope: params.requesterScope,
          });
          if (!resolved) {
            continue;
          }
          const safeServerName =
            safeServerNamesByServer.get(serverName) ??
            sanitizeServerName(serverName, usedServerNames);
          if (safeServerName !== serverName) {
            logWarn(
              `bundle-mcp: server key "${serverName}" registered as "${safeServerName}" for provider-safe tool names.`,
            );
          }
          // Never put per-user resolved URLs into catalog/diagnostics/model text.
          const launchDescription = override
            ? `${serverName}: requester-scoped connection`
            : resolved.description;
          preparedEntries.push({
            serverName,
            rawServer,
            resolved,
            safeServerName,
            launchDescription,
          });
        }

        // Bounded fan-out keeps common 4-5 server setups parallel without letting
        // large configs spawn/connect every MCP transport at once.
        type ServerResult = {
          serverName: string;
          serverEntry: McpServerCatalog | null;
          toolEntries: McpCatalogTool[];
          diagnostics: McpToolCatalogDiagnostic[];
        };

        const tasks = preparedEntries.map(
          ({ serverName, rawServer, resolved, safeServerName, launchDescription }) =>
            async (): Promise<ServerResult> => {
              failIfDisposed();

              let session = sessions.get(serverName);
              while (
                session &&
                !session.retiring &&
                !session.connected &&
                !session.connectPromise
              ) {
                // A closed SDK client cannot reconnect cleanly on the same transport.
                await retireSessionIfCurrent(serverName, session);
                // Retirement yields while closing. Preserve any replacement that a
                // newer catalog generation installed during that await.
                session = sessions.get(serverName);
              }
              if (session?.retiring) {
                session = undefined;
              }
              const reusedSession = Boolean(session);
              if (!session) {
                const client = new Client(
                  {
                    name: "openclaw-bundle-mcp",
                    version: "0.0.0",
                  },
                  {
                    ...buildMcpClientOptions(mcpAppsEnabled),
                    jsonSchemaValidator: createMcpJsonSchemaValidator(),
                    listChanged: {
                      tools: {
                        autoRefresh: false,
                        debounceMs: 0,
                        onChanged: (error) => {
                          if (error) {
                            logWarn(
                              `bundle-mcp: failed to refresh changed tool list for server "${serverName}": ${redactMcpDiagnosticError(error)}`,
                            );
                          }
                          invalidateCatalog();
                        },
                      },
                    },
                  },
                );
                const createdSession: BundleMcpSession = {
                  serverName,
                  client,
                  transport: resolved.transport,
                  transportType: resolved.transportType,
                  requestTimeoutMs: resolved.requestTimeoutMs,
                  supportsParallelToolCalls: resolved.supportsParallelToolCalls,
                  connected: false,
                  retiring: false,
                  catalogUseCount: 0,
                  sharedAcrossCatalogGenerations: false,
                  detachStderr: resolved.detachStderr,
                };
                // The SDK exposes lifecycle hooks as callback properties. A close is
                // terminal for this client/transport pair.
                // oxlint-disable-next-line unicorn/prefer-add-event-listener -- MCP Client is not an EventTarget.
                client.onclose = () => {
                  const wasConnected = createdSession.connected;
                  createdSession.connected = false;
                  createdSession.disconnectReason = "mcp transport closed";
                  // Only established current sessions invalidate the catalog. Startup closes
                  // already belong to catalog loading, and retirement must not start a rebuild.
                  if (
                    wasConnected &&
                    !disposed &&
                    !createdSession.retiring &&
                    sessions.get(serverName) === createdSession
                  ) {
                    scheduleCatalogServerRetry(serverName, "mcp transport closed");
                    logWarn(`bundle-mcp: server "${serverName}" closed; next request reconnects`);
                  }
                };
                session = createdSession;
                sessions.set(serverName, session);
              }

              if (session.catalogUseCount === 0) {
                session.sharedAcrossCatalogGenerations = false;
              }
              if (reusedSession && session.catalogUseCount > 0) {
                session.sharedAcrossCatalogGenerations = true;
              }
              session.catalogUseCount += 1;
              try {
                failIfDisposed();
                await ensureSessionConnected(session, resolved.connectionTimeoutMs);
                failIfDisposed();
                const capabilities = summarizeServerCapabilities(
                  session.client.getServerCapabilities(),
                );
                const listedTools = await listAllToolsBestEffort({
                  client: session.client,
                  timeoutMs: getCatalogListTimeoutMs(rawServer, resolved.requestTimeoutMs),
                  signal: lifecycleAbortController.signal,
                  suppressUnsupported: Boolean(
                    !capabilities.tools && (capabilities.resources || capabilities.prompts),
                  ),
                });
                failIfDisposed();
                const toolFilter = normalizeMcpToolFilter(
                  isRecord(rawServer) ? rawServer.toolFilter : undefined,
                );
                const denialMap = params.toolOverrides?.mcpToolsDeny;
                const deniedToolNames = new Set(
                  denialMap && Object.hasOwn(denialMap, serverName) ? denialMap[serverName] : [],
                );
                const policyEligibleTools = listedTools.filter((tool) =>
                  isMcpToolAllowed(toolFilter, tool.name.trim()),
                );
                const exposedTools = policyEligibleTools.filter((tool) => {
                  const toolName = tool.name.trim();
                  return !deniedToolNames.has(toolName);
                });
                const serverEntry: McpServerCatalog = {
                  serverName,
                  safeServerName,
                  launchSummary: launchDescription,
                  toolCount: exposedTools.length,
                  requestTimeoutMs: resolved.requestTimeoutMs,
                  supportsParallelToolCalls: resolved.supportsParallelToolCalls,
                  ...(capabilities.resources ? { resources: capabilities.resources } : {}),
                  ...(capabilities.prompts ? { prompts: capabilities.prompts } : {}),
                  ...(capabilities.tools
                    ? {
                        tools: {
                          ...capabilities.tools,
                          ...(exposedTools.length !== listedTools.length
                            ? { filteredCount: listedTools.length - exposedTools.length }
                            : {}),
                        },
                      }
                    : {}),
                  ...(toolFilter ? { toolFilter } : {}),
                  ...(deniedToolNames.size > 0
                    ? { deniedToolNames: [...deniedToolNames].toSorted() }
                    : {}),
                  codexApprovalMode: resolveMcpCodexToolApprovalMode(serverName, rawServer),
                };
                const toolEntries: McpCatalogTool[] = [];
                for (const tool of policyEligibleTools) {
                  const toolName = tool.name.trim();
                  if (!toolName) {
                    continue;
                  }
                  const { _meta: metadata } = tool;
                  const uiMeta =
                    metadata?.ui && typeof metadata.ui === "object" && !Array.isArray(metadata.ui)
                      ? (metadata.ui as { resourceUri?: unknown; visibility?: unknown })
                      : undefined;
                  const rawResourceUri = uiMeta?.resourceUri ?? metadata?.["ui/resourceUri"];
                  const uiResourceUri =
                    typeof rawResourceUri === "string" && rawResourceUri.startsWith("ui://")
                      ? rawResourceUri
                      : undefined;
                  const uiVisibility = normalizeToolUiVisibility(uiMeta?.visibility);
                  toolEntries.push({
                    serverName,
                    safeServerName,
                    toolName,
                    title: tool.title,
                    description: sanitizeMcpMetadataText(tool.description),
                    inputSchema: tool.inputSchema,
                    fallbackDescription: `Provided by bundle MCP server "${serverName}" (${launchDescription}).`,
                    ...(uiResourceUri ? { uiResourceUri } : {}),
                    ...(uiVisibility ? { uiVisibility } : {}),
                    ...(deniedToolNames.has(toolName) ? { deniedBySession: true } : {}),
                    codexAnnotations: normalizeMcpCodexToolAnnotations(tool.annotations),
                  });
                }
                return {
                  serverName,
                  serverEntry,
                  toolEntries,
                  diagnostics: [] as McpToolCatalogDiagnostic[],
                };
              } catch (error) {
                const message = redactMcpDiagnosticError(error);
                if (!disposed) {
                  const action = reusedSession ? "refresh" : "start";
                  logWarn(
                    `bundle-mcp: failed to ${action} server "${serverName}" (${launchDescription}): ${message}`,
                  );
                }
                const diags: McpToolCatalogDiagnostic[] = [
                  {
                    serverName,
                    safeServerName,
                    launchSummary: launchDescription,
                    message,
                  },
                ];
                const sharedWithNewerGeneration =
                  session.sharedAcrossCatalogGenerations || session.catalogUseCount > 1;
                if (!session.connected) {
                  // A close is terminal for every catalog generation sharing this
                  // session. The identity guard preserves any newer replacement.
                  await retireSessionIfCurrent(serverName, session);
                } else if (!reusedSession && !sharedWithNewerGeneration) {
                  // Catalog invalidation can overlap generations; an older failed
                  // generation must not dispose a session a newer one already reused.
                  await retireSessionIfCurrent(serverName, session);
                }
                failIfDisposed();
                return {
                  serverName,
                  serverEntry: null,
                  toolEntries: [],
                  diagnostics: diags,
                } as ServerResult;
              } finally {
                session.catalogUseCount -= 1;
                if (session.catalogUseCount === 0) {
                  session.sharedAcrossCatalogGenerations = false;
                }
              }
            },
        );
        const { results, firstError, hasError } = await runTasksWithConcurrency({
          tasks,
          limit: BUNDLE_MCP_CATALOG_CONNECT_CONCURRENCY,
          errorMode: "continue",
        });
        if (hasError) {
          throw firstError;
        }

        for (const result of results) {
          if (!result) {
            continue;
          }
          const { serverEntry, toolEntries, diagnostics: serverDiags } = result;
          if (serverEntry) {
            servers[result.serverName] = serverEntry;
          }
          for (const tool of toolEntries) {
            if (tool.deniedBySession) {
              sessionDeniedTools.push(tool);
            } else {
              tools.push(tool);
            }
          }
          diagnostics.push(...serverDiags);
        }

        failIfDisposed();
        return {
          version: 1,
          generatedAt: Date.now(),
          servers,
          tools,
          ...(sessionDeniedTools.length > 0 ? { sessionDeniedTools } : {}),
          ...(diagnostics.length > 0 ? { diagnostics } : {}),
        };
      } catch (error) {
        await Promise.allSettled(
          Array.from(sessions.values(), (session) => disposeBundleMcpSession(session)),
        );
        sessions.clear();
        throw error;
      }
    })();
    let trackedInFlight: Promise<McpToolCatalog>;
    trackedInFlight = (async () => {
      try {
        const nextCatalog = await inFlight;
        failIfDisposed();
        if (catalogInvalidationGeneration === catalogGeneration) {
          catalog = nextCatalog;
          catalogRetryAfterMs = nextCatalog.diagnostics?.length
            ? Date.now() + BUNDLE_MCP_CATALOG_FAILURE_RETRY_MS
            : undefined;
        }
        return nextCatalog;
      } finally {
        if (catalogInFlight === trackedInFlight) {
          catalogInFlight = undefined;
        }
      }
    })();
    catalogInFlight = trackedInFlight;
    return await waitForSessionMcpRequest(trackedInFlight, options?.signal);
  };

  const getCatalog = async (
    options?: Pick<McpRequestOptions, "signal">,
  ): Promise<McpToolCatalog> => {
    failIfDisposed();
    options?.signal?.throwIfAborted();
    if (catalog && !catalogRetryIsDue()) {
      return catalog;
    }
    if (!catalog) {
      return loadCatalog(undefined, options);
    }

    const staleCatalog = catalog;
    catalogRetryAfterMs = undefined;
    void loadCatalog(staleCatalog).catch(() => {
      if (!disposed && catalog === staleCatalog && catalogRetryAfterMs === undefined) {
        catalogRetryAfterMs = Date.now() + BUNDLE_MCP_CATALOG_FAILURE_RETRY_MS;
      }
    });
    return staleCatalog;
  };
  const getActiveSession = async (
    serverName: string,
    options?: Pick<McpRequestOptions, "signal">,
  ) => {
    await getCatalog(options);
    return requireConnectedSession(serverName);
  };

  const runtime: SessionMcpRuntime = {
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    workspaceDir: params.workspaceDir,
    agentDir: params.agentDir,
    configFingerprint,
    ...(params.requesterScope ? { requesterScope: params.requesterScope } : {}),
    ...(params.requesterConnect ? { requesterConnect: params.requesterConnect } : {}),
    // A runtime partition hosts either only static or only requester-scoped servers.
    isRequesterScopedServer: () => params.requesterScope !== undefined,
    mcpAppsEnabled,
    createdAt,
    get lastUsedAt() {
      return lastUsedAt;
    },
    get activeLeases() {
      return activeLeases;
    },
    acquireLease() {
      activeLeases += 1;
      let released = false;
      return () => {
        if (released) {
          return;
        }
        released = true;
        activeLeases = Math.max(0, activeLeases - 1);
        // Release is not use: refreshing lastUsedAt here defeats the idle-sweep TTL.
      };
    },
    getCatalog,
    /** Synchronous catalog snapshot only; must not connect transports or issue tools/list. */
    peekCatalog() {
      return catalog;
    },
    /** Session-owned timeout that survives catalog invalidation. */
    getServerRequestTimeoutMs(serverName: string) {
      return sessions.get(serverName)?.requestTimeoutMs;
    },
    markUsed() {
      lastUsedAt = Date.now();
    },
    async callTool(serverName, toolName, input, options) {
      const session = await getActiveSession(serverName, options);
      return (await runGuardedMcpRequest(
        serverName,
        session,
        (signal) =>
          session.client.callTool(
            { name: toolName, arguments: isRecord(input) ? input : {} },
            undefined,
            { timeout: session.requestTimeoutMs, signal },
          ),
        options,
      )) as CallToolResult;
    },
    async listTools(serverName, requestParams, options) {
      const session = await getActiveSession(serverName, options);
      return await runGuardedMcpRequest(
        serverName,
        session,
        (signal) =>
          session.client.listTools(requestParams, {
            timeout: session.requestTimeoutMs,
            signal,
          }),
        options,
      );
    },
    async listResources(serverName, options) {
      const session = await getActiveSession(serverName, options);
      return await runGuardedServerRequest(
        serverName,
        session,
        async () => collectServerItems(session, "resources", options),
        options,
      );
    },
    async readResource(serverName, uri, options) {
      const session = await getActiveSession(serverName, options);
      return await runGuardedMcpRequest(
        serverName,
        session,
        (signal) =>
          session.client.readResource({ uri }, { timeout: session.requestTimeoutMs, signal }),
        options,
      );
    },
    async listResourceTemplates(serverName, requestParams, options) {
      const session = await getActiveSession(serverName, options);
      return await runGuardedMcpRequest(
        serverName,
        session,
        (signal) =>
          session.client.listResourceTemplates(requestParams, {
            timeout: session.requestTimeoutMs,
            signal,
          }),
        options,
      );
    },
    async listPrompts(serverName) {
      const session = await getActiveSession(serverName);
      return await runGuardedServerRequest(serverName, session, async () =>
        collectServerItems(session, "prompts"),
      );
    },
    async getPrompt(serverName, name, args) {
      const session = await getActiveSession(serverName);
      return await runGuardedMcpRequest(serverName, session, (signal) =>
        session.client.getPrompt(
          { name, ...(args ? { arguments: args } : {}) },
          { timeout: session.requestTimeoutMs, signal },
        ),
      );
    },
    async dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      lifecycleAbortController.abort(createDisposedError(params.sessionId));
      catalog = null;
      catalogRetryAfterMs = undefined;
      catalogInFlight = undefined;
      const sessionsToClose = Array.from(sessions.values());
      sessions.clear();
      await Promise.allSettled(sessionsToClose.map((session) => disposeBundleMcpSession(session)));
    },
  };
  return runtime;
}

setDefaultCreateSessionMcpRuntime(createSessionMcpRuntime);

export {
  completeDeferredSessionMcpRuntimeRetirement,
  disposeAllSessionMcpRuntimes,
  getAdvertisedScopedMcpCatalog,
  getOrCreateRequesterScopedMcpRuntime,
  getOrCreateSessionMcpRuntime,
  peekSessionMcpRuntime,
  rememberAdvertisedScopedMcpCatalog,
  resolveSessionMcpConfigSummary,
  retireSessionMcpRuntime,
  retireSessionMcpRuntimeForSessionKey,
};
export { createSessionMcpRuntimeManager };
export { mergeMcpToolCatalogs };

export const testing = {
  buildMcpClientCapabilities,
  createSessionMcpRuntimeManager,
  async resetSessionMcpRuntimeManager() {
    await disposeAllSessionMcpRuntimes();
    setBundleMcpCatalogListTimeoutMsForTest();
    setBundleMcpDisposeTimeoutMsForTest();
    const { testing: resolverTesting } = await import("./mcp-connection-resolver.js");
    resolverTesting.setMcpServerConnectionResolversForTest();
    resolverTesting.setMcpConnectionResolverTimeoutMsForTest();
    resolverTesting.setMcpConnectionRevalidateMsForTest();
  },
  getCachedSessionIds() {
    return getSessionMcpRuntimeManagerForTesting().listSessionIds();
  },
  getCachedRuntimeKeys() {
    return getSessionMcpRuntimeManagerForTesting().listRuntimeKeys();
  },
  getBookkeepingSizes(manager: SessionMcpRuntimeManager): Record<string, number> {
    const sizes = (
      manager as SessionMcpRuntimeManager & {
        bookkeepingSizesForTest?: () => Record<string, number>;
      }
    ).bookkeepingSizesForTest?.();
    return sizes ?? {};
  },
  setBundleMcpCatalogListTimeoutMsForTest,
  setBundleMcpDisposeTimeoutMsForTest,
  resolveSessionMcpRuntimeIdleTtlMs,
  mergeMcpToolCatalogs,
};
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
