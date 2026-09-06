/** Session-scoped MCP runtime catalog loader and transport lifecycle. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  ErrorCode,
  ListToolsResultSchema,
  McpError,
  type CallToolResult,
  type ClientCapabilities,
  type ServerCapabilities,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { logWarn } from "../logger.js";
import {
  createCombinedSessionMcpRuntime,
  mergeMcpToolCatalogs,
} from "./agent-bundle-mcp-combined.js";
import {
  disposeAllSessionMcpRuntimes,
  getSessionMcpRuntimeManagerForTesting,
} from "./agent-bundle-mcp-manager-api.js";
import { assignSafeServerNames } from "./agent-bundle-mcp-names.js";
import { getSessionMcpRequestSignal } from "./agent-bundle-mcp-request-context.js";
import { loadSessionMcpConfig } from "./agent-bundle-mcp-runtime-config.js";
import { sessionMcpRuntimeOwners } from "./agent-bundle-mcp-runtime-owner.js";
import type { CreateSessionMcpRuntime } from "./agent-bundle-mcp-runtime-shared.js";
import type {
  McpCatalogTool,
  McpRequestOptions,
  McpServerCatalog,
  McpToolCatalog,
  McpToolCatalogDiagnostic,
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
  resolveProjectedMcpCodexToolApprovalMode,
} from "./mcp-codex-tool-approval.js";
import {
  applyMcpConnectionOverride,
  hashMcpResolvedConnections,
  partitionMcpServersByConnectionScope,
} from "./mcp-connection-resolver.js";
import { redactMcpDiagnosticError } from "./mcp-error.js";
import { createMcpJsonSchemaValidator } from "./mcp-json-schema-validator.js";
import { sanitizeMcpMetadataText } from "./mcp-metadata.js";
import { collectMcpPaginatedItems } from "./mcp-pagination.js";
import { isMcpToolAllowed, normalizeMcpToolFilter } from "./mcp-tool-filter.js";
import { normalizeMcpToolCatalog, type McpToolCatalogMetadata } from "./mcp-tool-metadata.js";
import { resolveMcpTransport } from "./mcp-transport.js";
import { recordAgentCleanupFailure } from "./run-cleanup-timeout.js";

type BundleMcpSession = {
  serverName: string;
  client: Client;
  transport: Transport;
  transportType: "stdio" | "sse" | "streamable-http";
  requestTimeoutMs: number;
  connected: boolean;
  disconnectReason?: string;
  retiring: boolean;
  connectPromise?: Promise<void>;
  disposePromise?: Promise<void>;
  detachStderr?: () => void;
  toolMetadata?: McpToolCatalogMetadata;
};

const MCP_APPS_CLIENT_EXTENSION = "io.modelcontextprotocol/ui";
const MCP_APP_RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";
const BUNDLE_MCP_FAILURE_THRESHOLD = 3;
const BUNDLE_MCP_FAILURE_COOLDOWN_MS = 60_000;
const BUNDLE_MCP_CATALOG_FAILURE_RETRY_MS = 5_000;
const BUNDLE_MCP_CATALOG_LIST_TIMEOUT_MS = 1_500;
const BUNDLE_MCP_DISPOSE_TIMEOUT_MS = 5_000;
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

async function listAllTools(
  client: Client,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<Tool[]> {
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
        const page = await client.request(
          { method: "tools/list", params: cursor === undefined ? undefined : { cursor } },
          ListToolsResultSchema,
          {
            timeout: requestTimeoutMs,
            maxTotalTimeout: requestTimeoutMs,
            signal: requestController.signal,
          },
        );
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

function disposeBundleMcpSession(session: BundleMcpSession): Promise<"closed" | "uncertain"> {
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

type ServerMcpRuntime = SessionMcpRuntime & { readonly pluginOwned: boolean };

export function createSessionMcpRuntime(
  params: Parameters<CreateSessionMcpRuntime>[0],
  previous = new Map<string, ServerMcpRuntime>(),
): SessionMcpRuntime {
  const declared = loadSessionMcpConfig({
    ...params,
    includeServerNames: undefined,
    excludeServerNames: undefined,
    logDiagnostics: true,
  });
  const config = loadSessionMcpConfig({
    ...params,
    loaded: declared.loaded,
    logDiagnostics: false,
  });
  const safeNames =
    params.safeServerNamesByServer ??
    assignSafeServerNames(Object.keys(declared.loaded.mcpServers));
  const configForServer = (serverName: string, nextParams = params, loaded = config.loaded) => {
    const connection = nextParams.connectionOverrides?.get(serverName);
    const serverConfig = loadSessionMcpConfig({
      ...nextParams,
      loaded,
      logDiagnostics: false,
      includeServerNames: new Set([serverName]),
      excludeServerNames: undefined,
      safeServerNamesByServer: new Map([[serverName, safeNames.get(serverName)!]]),
      toolOverrides: {
        ...nextParams.toolOverrides,
        mcpToolsDeny: Object.fromEntries(
          Object.entries(nextParams.toolOverrides?.mcpToolsDeny ?? {}).filter(
            ([name]) => name === serverName,
          ),
        ),
      },
    });
    if (connection) {
      serverConfig.fingerprint += `:${hashMcpResolvedConnections(new Map([[serverName, connection]]))}`;
    }
    return serverConfig;
  };
  const owned = new Map<string, ServerMcpRuntime>();
  for (const serverName of Object.keys(config.loaded.mcpServers)) {
    const serverConfig = configForServer(serverName);
    const fingerprint = serverConfig.fingerprint;
    const existing = previous.get(serverName);
    if (
      existing?.configFingerprint === fingerprint &&
      existing.workspaceDir === params.workspaceDir &&
      existing.agentDir === params.agentDir
    ) {
      owned.set(serverName, existing);
      previous.delete(serverName);
    } else {
      owned.set(
        serverName,
        createServerMcpRuntime({
          ...params,
          serverName,
          serverConfig,
          safeServerNamesByServer: safeNames,
          configFingerprint: fingerprint,
        }),
      );
    }
  }
  const requesterConnect = params.requesterConnect;
  const connectFingerprints = new Map(
    Object.keys(requesterConnect?.catalog.servers ?? {}).map((name) => [
      name,
      configForServer(name, params, declared.loaded).fingerprint,
    ]),
  );
  let invalidated = false;
  let pendingDisposal = Promise.resolve();
  let cleanupFailure: PromiseRejectedResult | undefined;
  const disposeParts = (parts: SessionMcpRuntime[]) => {
    // Replacement must join cleanup already started by config publication.
    pendingDisposal = Promise.allSettled([
      pendingDisposal,
      ...parts.map(async (part) => {
        await part.dispose();
        if (!part.joinCleanup) {
          throw new Error("MCP runtime does not expose cleanup ownership");
        }
        await part.joinCleanup();
      }),
    ]).then((results) => {
      cleanupFailure ??= results.find((result) => result.status === "rejected");
    });
    return pendingDisposal;
  };
  const runtime = createCombinedSessionMcpRuntime({
    ...params,
    parts: [...owned.values()],
    // Admitted views keep routing to transferred servers; ownership alone moves.
    serverOwners: new Map(owned),
  });
  runtime.configFingerprint = params.configFingerprint ?? config.fingerprint;
  runtime.requesterScope = params.requesterScope;
  runtime.requesterConnect = requesterConnect && {
    ...requesterConnect,
    get catalog() {
      const catalog = requesterConnect.catalog;
      return {
        ...catalog,
        servers: Object.fromEntries(
          Object.entries(catalog.servers).filter(([name]) => connectFingerprints.has(name)),
        ),
        tools: catalog.tools.filter((tool) => connectFingerprints.has(tool.serverName)),
      };
    },
    createExecute(serverName) {
      const execute = requesterConnect.createExecute(serverName);
      return (
        execute &&
        (async (...args) => {
          if (!connectFingerprints.has(serverName)) {
            throw createDisposedError(params.sessionId);
          }
          return await execute(...args);
        })
      );
    },
  };
  runtime.mcpAppsEnabled = params.cfg?.mcp?.apps?.enabled === true;
  const joinParts = runtime.joinCleanup;
  runtime.joinCleanup = async () => {
    await pendingDisposal;
    try {
      await joinParts?.();
    } catch (error) {
      cleanupFailure ??= { status: "rejected", reason: error };
    }
    if (cleanupFailure) {
      recordAgentCleanupFailure();
      throw cleanupFailure.reason;
    }
  };
  runtime.dispose = async () => {
    connectFingerprints.clear();
    invalidated = true;
    const retired = [...owned.values()];
    owned.clear();
    sessionMcpRuntimeOwners.delete(runtime);
    await disposeParts(retired);
    if (cleanupFailure) {
      recordAgentCleanupFailure();
    }
  };
  sessionMcpRuntimeOwners.set(runtime, {
    isCurrent: () => !invalidated,
    replace: (nextParams) => createSessionMcpRuntime(nextParams, owned),
    async reload({ cfg, manifestRegistry, reloadPlugins }) {
      const nextParams = { ...params, cfg, manifestRegistry };
      const nextConfig = loadSessionMcpConfig({
        ...nextParams,
        includeServerNames: undefined,
        excludeServerNames: undefined,
        logDiagnostics: false,
      });
      const nextSafeNames = assignSafeServerNames(Object.keys(nextConfig.loaded.mcpServers));
      const { requesterScopedServerNames } = partitionMcpServersByConnectionScope(
        nextConfig.loaded.mcpServers,
      );
      for (const [name, fingerprint] of connectFingerprints) {
        if (
          (reloadPlugins && !Object.hasOwn(params.cfg?.mcp?.servers ?? {}, name)) ||
          cfg.gateway?.publicOrigin !== params.cfg?.gateway?.publicOrigin ||
          configForServer(name, nextParams, nextConfig.loaded).fingerprint !== fingerprint ||
          nextSafeNames.get(name) !== safeNames.get(name)
        ) {
          invalidated = true;
          connectFingerprints.delete(name);
        }
      }
      const retired: SessionMcpRuntime[] = [];
      for (const [serverName, part] of owned) {
        if (
          (reloadPlugins && part.pluginOwned) ||
          !Object.hasOwn(nextConfig.loaded.mcpServers, serverName) ||
          requesterScopedServerNames.includes(serverName) !== Boolean(params.requesterScope) ||
          nextSafeNames.get(serverName) !== safeNames.get(serverName) ||
          configForServer(serverName, nextParams, nextConfig.loaded).fingerprint !==
            part.configFingerprint
        ) {
          invalidated = true;
          owned.delete(serverName);
          retired.push(part);
        }
      }
      // Disposal revokes the changed owner synchronously, before transport cleanup yields.
      await disposeParts(retired);
    },
  });
  return runtime;
}

function createServerMcpRuntime(
  params: Parameters<CreateSessionMcpRuntime>[0] & {
    serverName: string;
    serverConfig: ReturnType<typeof loadSessionMcpConfig>;
  },
): ServerMcpRuntime {
  const { loaded, fingerprint: computedFingerprint } = params.serverConfig;
  const serverName = params.serverName;
  const configFingerprint = params.configFingerprint ?? computedFingerprint;
  const mcpAppsEnabled = params.cfg?.mcp?.apps?.enabled === true;
  const createdAt = Date.now();
  let lastUsedAt = createdAt;
  let activeLeases = 0;
  let retiredCatalog: McpToolCatalog | undefined;
  const lifecycleAbortController = new AbortController();
  let catalog: McpToolCatalog | null = null;
  let catalogRetryAfterMs: number | undefined;
  let catalogInFlight: Promise<McpToolCatalog> | undefined;
  let catalogInvalidationGeneration = 0;
  const invalidateCatalog = () => {
    catalogInvalidationGeneration += 1;
    catalog = null;
    catalogRetryAfterMs = undefined;
  };
  const scheduleCatalogServerRetry = (message: string) => {
    const currentCatalog = catalog;
    const server = currentCatalog?.servers[serverName];
    const existing = currentCatalog?.diagnostics?.[0];
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
      diagnostics: [diagnostic],
    };
    catalogRetryAfterMs = Date.now();
  };
  const catalogRetryIsDue = (): boolean =>
    catalogRetryAfterMs !== undefined && Date.now() >= catalogRetryAfterMs;
  let currentSession: BundleMcpSession | undefined;
  let disposal: Promise<void> | undefined;
  let cleanupFailed = false;
  const pendingDisposals = new Set<Promise<void>>();
  const disposeSession = (session: BundleMcpSession): Promise<void> => {
    if (session.disposePromise) {
      return session.disposePromise;
    }
    const closing = disposeBundleMcpSession(session)
      .then((outcome) => {
        if (outcome === "uncertain") {
          cleanupFailed = true;
          recordAgentCleanupFailure();
        }
      })
      .catch((error: unknown) => {
        cleanupFailed = true;
        recordAgentCleanupFailure();
        throw error;
      })
      .finally(() => pendingDisposals.delete(closing));
    session.disposePromise = closing;
    pendingDisposals.add(closing);
    return closing;
  };

  let serverBackoff: McpServerBackoffState | undefined;
  const recordServerToolFailure = (session: BundleMcpSession, nowMs: number) => {
    if (currentSession !== session || session.retiring) {
      return undefined;
    }
    const previous = serverBackoff;
    const failures = (previous?.session === session ? previous.failures : 0) + 1;
    const nextBackoff: McpServerBackoffState = { session, failures };
    if (failures >= BUNDLE_MCP_FAILURE_THRESHOLD) {
      nextBackoff.retryAfterMs = nowMs + BUNDLE_MCP_FAILURE_COOLDOWN_MS;
    }
    serverBackoff = nextBackoff;
    return failures;
  };
  const failIfDisposed = () => {
    if (retiredCatalog) {
      throw createDisposedError(params.sessionId);
    }
  };
  const requireConnectedSession = (): BundleMcpSession => {
    const session = currentSession;
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
  const retireSessionIfCurrent = async (session: BundleMcpSession): Promise<boolean> => {
    if (currentSession !== session) {
      return false;
    }
    session.retiring = true;
    currentSession = undefined;
    await disposeSession(session);
    return true;
  };
  const localRequestTimeouts = new WeakSet<object>();
  const runMcpRequest = async <T>(
    session: BundleMcpSession,
    request: (signal: AbortSignal) => Promise<T>,
    parentSignal?: AbortSignal,
  ): Promise<T> => {
    const requestSignal = parentSignal ?? getSessionMcpRequestSignal();
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
    session: BundleMcpSession,
    request: () => Promise<T>,
    options?: McpRequestOptions,
  ): Promise<T> => {
    const requestSignal = getSessionMcpRequestSignal();
    const tracksFailureBackoff = options?.failureBackoff !== "ignore";
    const nowMs = Date.now();
    const backoff = serverBackoff;
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
      serverBackoff = undefined;
    }
    try {
      const result = await request();
      if (tracksFailureBackoff && serverBackoff?.session === session) {
        serverBackoff = undefined;
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
        const failures = recordServerToolFailure(session, nowMs);
        const requestTimedOut =
          error !== null && typeof error === "object" && localRequestTimeouts.has(error);
        if (requestTimedOut && failures && failures >= BUNDLE_MCP_FAILURE_THRESHOLD) {
          recycleReason = "repeated request timeouts";
        }
      }
      if (recycleReason) {
        serverBackoff = undefined;
        scheduleCatalogServerRetry(recycleReason);
        const timedOut = recycleReason === "repeated request timeouts";
        logWarn(
          `bundle-mcp: recycling server "${serverName}" after ${timedOut ? "repeated timeouts" : "an expired HTTP session"}`,
        );
        void retireSessionIfCurrent(session).catch((retireError: unknown) => {
          logWarn(
            `bundle-mcp: failed to retire ${timedOut ? "timed-out" : "expired-session"} server "${serverName}": ${redactMcpDiagnosticError(retireError)}`,
          );
        });
      }
      throw error;
    }
  };
  const runGuardedMcpRequest = <T>(
    session: BundleMcpSession,
    request: (signal: AbortSignal) => Promise<T>,
    options?: McpRequestOptions,
  ) => runGuardedServerRequest(session, () => runMcpRequest(session, request), options);
  const collectServerItems = (session: BundleMcpSession, kind: "prompts" | "resources") => {
    const callerSignal = getSessionMcpRequestSignal();
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

  const loadCatalog = async (): Promise<McpToolCatalog> => {
    failIfDisposed();
    if (catalogInFlight) {
      return catalogInFlight;
    }
    const catalogGeneration = catalogInvalidationGeneration;
    const inFlight = (async (): Promise<McpToolCatalog> => {
      const rawServer = loaded.mcpServers[serverName]!;
      const override = params.connectionOverrides?.get(serverName);
      const transportSource = override
        ? applyMcpConnectionOverride(rawServer, override)
        : rawServer;
      const resolved = resolveMcpTransport(serverName, transportSource, {
        cfg: params.cfg,
        agentDir: params.agentDir,
        prepareDataDir: loaded.prepareDataDirsByServer?.[serverName]?.dataDir,
        requesterScope: params.requesterScope,
      });
      if (!resolved) {
        return { version: 1, generatedAt: Date.now(), servers: {}, tools: [] };
      }
      const safeServerName = params.safeServerNamesByServer?.get(serverName) ?? serverName;
      // Resolved requester URLs are credentials and never enter catalog text.
      const launchDescription = override
        ? `${serverName}: requester-scoped connection`
        : resolved.description;
      failIfDisposed();

      let session = currentSession;
      while (session && !session.retiring && !session.connected && !session.connectPromise) {
        // A closed SDK client cannot reconnect cleanly on the same transport.
        await retireSessionIfCurrent(session);
        // Retirement yields while closing. Preserve any replacement that a
        // newer catalog generation installed during that await.
        session = currentSession;
      }
      if (session?.retiring) {
        session = undefined;
      }
      const reusedSession = Boolean(session);
      const schemaValidator = createMcpJsonSchemaValidator();
      if (!session) {
        const client = new Client(
          {
            name: "openclaw-bundle-mcp",
            version: "0.0.0",
          },
          {
            capabilities: buildMcpClientCapabilities(mcpAppsEnabled),
            jsonSchemaValidator: schemaValidator,
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
          connected: false,
          retiring: false,
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
            !retiredCatalog &&
            !createdSession.retiring &&
            currentSession === createdSession
          ) {
            scheduleCatalogServerRetry("mcp transport closed");
            logWarn(`bundle-mcp: server "${serverName}" closed; next request reconnects`);
          }
        };
        session = createdSession;
        currentSession = session;
      }

      try {
        failIfDisposed();
        await ensureSessionConnected(session, resolved.connectionTimeoutMs);
        failIfDisposed();
        const capabilities = summarizeServerCapabilities(session.client.getServerCapabilities());
        let listedTools: Tool[];
        try {
          listedTools = await listAllTools(
            session.client,
            getCatalogListTimeoutMs(rawServer, resolved.requestTimeoutMs),
            lifecycleAbortController.signal,
          );
        } catch (error) {
          if (
            !capabilities.tools &&
            (capabilities.resources || capabilities.prompts) &&
            isMcpMethodNotFoundError(error)
          ) {
            listedTools = [];
          } else {
            throw error;
          }
        }
        failIfDisposed();
        const toolFilter = normalizeMcpToolFilter(
          isRecord(rawServer) ? rawServer.toolFilter : undefined,
        );
        const denialMap = params.toolOverrides?.mcpToolsDeny;
        const deniedToolNames = new Set(
          denialMap && Object.hasOwn(denialMap, serverName) ? denialMap[serverName] : [],
        );
        const normalizedTools = normalizeMcpToolCatalog(
          listedTools,
          schemaValidator,
          (toolName) => {
            if (!isMcpToolAllowed(toolFilter, toolName)) {
              return "exclude";
            }
            return deniedToolNames.has(toolName) ? "denied" : "include";
          },
        );
        session.toolMetadata = normalizedTools.metadata;
        const exposedTools = normalizedTools.tools;
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
          ...(deniedToolNames.size > 0 ? { deniedToolNames: [...deniedToolNames].toSorted() } : {}),
          codexApprovalMode: resolveProjectedMcpCodexToolApprovalMode(serverName, rawServer),
        };
        const toolEntries: McpCatalogTool[] = [];
        const policyToolEntries: McpCatalogTool[] = [];
        for (const [tool, excludedFromOpenClawCatalog, deniedBySession] of [
          ...normalizedTools.tools.map((entry) => [entry, false, false] as const),
          ...normalizedTools.deniedTools.map((entry) => [entry, false, true] as const),
          ...normalizedTools.excludedTools.map(
            (entry) => [entry, true, deniedToolNames.has(entry.name)] as const,
          ),
        ]) {
          const toolName = tool.name;
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
          const entry: McpCatalogTool = {
            serverName,
            safeServerName,
            toolName,
            title: tool.title,
            description: sanitizeMcpMetadataText(tool.description),
            inputSchema: tool.inputSchema,
            fallbackDescription: `Provided by bundle MCP server "${serverName}" (${launchDescription}).`,
            ...(uiResourceUri ? { uiResourceUri } : {}),
            ...(uiVisibility ? { uiVisibility } : {}),
            ...(excludedFromOpenClawCatalog ? { excludedFromOpenClawCatalog: true as const } : {}),
            ...(deniedBySession ? { deniedBySession: true } : {}),
            codexAnnotations: normalizeMcpCodexToolAnnotations(tool.annotations),
          };
          policyToolEntries.push(entry);
          if (!entry.excludedFromOpenClawCatalog) {
            toolEntries.push(entry);
          }
        }
        return {
          version: 1,
          generatedAt: Date.now(),
          servers: { [serverName]: serverEntry },
          tools: toolEntries.filter((tool) => !tool.deniedBySession),
          policyTools: policyToolEntries,
          sessionDeniedTools: toolEntries.filter((tool) => tool.deniedBySession),
        };
      } catch (error) {
        const message = redactMcpDiagnosticError(error);
        if (!retiredCatalog) {
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
        if (!session.connected) {
          // A close is terminal for every catalog generation sharing this
          // session. The identity guard preserves any newer replacement.
          await retireSessionIfCurrent(session);
        } else if (!reusedSession && catalogInvalidationGeneration === catalogGeneration) {
          // An isolated startup failure gets a fresh process on retry. When a
          // notification superseded this list, the queued generation reuses it.
          await retireSessionIfCurrent(session);
        }
        failIfDisposed();
        return { version: 1, generatedAt: Date.now(), servers: {}, tools: [], diagnostics: diags };
      }
    })();
    catalogInFlight = inFlight;
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
      if (catalogInFlight === inFlight) {
        catalogInFlight = undefined;
      }
    }
  };

  const getCatalog = async (): Promise<McpToolCatalog> => {
    failIfDisposed();
    if (catalog && !catalogRetryIsDue()) {
      return catalog;
    }
    if (!catalog) {
      await loadCatalog();
      if (catalog) {
        return catalog;
      }
      // Replay one in-flight invalidation before accepting the latest completed
      // snapshot. A server that invalidates every list must not block its siblings.
      const replayedCatalog = await loadCatalog();
      return catalog ?? replayedCatalog;
    }

    const staleCatalog = catalog;
    catalogRetryAfterMs = undefined;
    void loadCatalog().catch(() => {
      if (!retiredCatalog && catalog === staleCatalog && catalogRetryAfterMs === undefined) {
        catalogRetryAfterMs = Date.now() + BUNDLE_MCP_CATALOG_FAILURE_RETRY_MS;
      }
    });
    return staleCatalog;
  };
  const getActiveSession = async (requestedServer: string) => {
    if (requestedServer !== serverName) {
      throw new Error(`bundle-mcp server "${requestedServer}" is not connected`);
    }
    const signal = getSessionMcpRequestSignal();
    signal?.throwIfAborted();
    await racePromiseWithAbortSignal(getCatalog(), signal);
    return requireConnectedSession();
  };

  const runtime: ServerMcpRuntime = {
    // Provenance travels with the transport; a later explicit definition cannot relabel it.
    pluginOwned:
      !Object.hasOwn(params.cfg?.mcp?.servers ?? {}, serverName) ||
      params.connectionOverrides?.has(serverName) === true,
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
    get retiredCatalog() {
      return retiredCatalog;
    },
    /** Synchronous catalog snapshot only; must not connect transports or issue tools/list. */
    peekCatalog() {
      return catalog;
    },
    /** Session-owned timeout that survives catalog invalidation. */
    getServerRequestTimeoutMs(requestedServer: string) {
      return requestedServer === serverName ? currentSession?.requestTimeoutMs : undefined;
    },
    markUsed() {
      lastUsedAt = Date.now();
    },
    async callTool(requestedServer, toolName, input) {
      const session = await getActiveSession(requestedServer);
      const validateResult = session.toolMetadata?.validatorForCall(toolName);
      const result = (await runGuardedMcpRequest(session, (signal) =>
        session.client.callTool(
          { name: toolName, arguments: isRecord(input) ? input : {} },
          undefined,
          { timeout: session.requestTimeoutMs, signal },
        ),
      )) as CallToolResult;
      validateResult?.(result);
      return result;
    },
    async listTools(requestedServer, requestParams) {
      const session = await getActiveSession(requestedServer);
      return await runGuardedMcpRequest(session, (signal) =>
        session.client.request(
          { method: "tools/list", params: requestParams },
          ListToolsResultSchema,
          { timeout: session.requestTimeoutMs, signal },
        ),
      );
    },
    async listResources(requestedServer, options) {
      const session = await getActiveSession(requestedServer);
      return await runGuardedServerRequest(
        session,
        async () => collectServerItems(session, "resources"),
        options,
      );
    },
    async readResource(requestedServer, uri, options) {
      const session = await getActiveSession(requestedServer);
      return await runGuardedMcpRequest(
        session,
        (signal) =>
          session.client.readResource({ uri }, { timeout: session.requestTimeoutMs, signal }),
        options,
      );
    },
    async listResourceTemplates(requestedServer, requestParams) {
      const session = await getActiveSession(requestedServer);
      return await runGuardedMcpRequest(session, (signal) =>
        session.client.listResourceTemplates(requestParams, {
          timeout: session.requestTimeoutMs,
          signal,
        }),
      );
    },
    async listPrompts(requestedServer) {
      const session = await getActiveSession(requestedServer);
      return await runGuardedServerRequest(session, async () =>
        collectServerItems(session, "prompts"),
      );
    },
    async getPrompt(requestedServer, name, args) {
      const session = await getActiveSession(requestedServer);
      return await runGuardedMcpRequest(session, (signal) =>
        session.client.getPrompt(
          { name, ...(args ? { arguments: args } : {}) },
          { timeout: session.requestTimeoutMs, signal },
        ),
      );
    },
    async joinCleanup() {
      await disposal;
      await Promise.allSettled(pendingDisposals);
      if (cleanupFailed) {
        recordAgentCleanupFailure();
        throw new Error("MCP runtime cleanup could not confirm closure");
      }
    },
    dispose() {
      if (!disposal) {
        retiredCatalog = {
          version: 1,
          generatedAt: Date.now(),
          servers: {},
          tools: [],
          diagnostics: [
            {
              serverName,
              safeServerName: params.safeServerNamesByServer?.get(serverName) ?? serverName,
              launchSummary: serverName,
              message: "MCP server runtime retired; retry discovery on the next turn.",
            },
          ],
        };
        lifecycleAbortController.abort(createDisposedError(params.sessionId));
        catalog = null;
        catalogRetryAfterMs = undefined;
        const pendingCatalog = catalogInFlight;
        catalogInFlight = undefined;
        const session = currentSession;
        currentSession = undefined;
        disposal = (async () => {
          if (session) {
            await disposeSession(session).catch(() => undefined);
          }
          await pendingCatalog?.catch(() => undefined);
          await Promise.allSettled(pendingDisposals);
        })();
      }
      // Physical cleanup is single-flight; uncertainty belongs to every caller.
      void disposal.then(() => {
        if (cleanupFailed) {
          recordAgentCleanupFailure();
        }
      });
      return disposal;
    },
  };
  return runtime;
}

export const testing = {
  buildMcpClientCapabilities,
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
  mergeMcpToolCatalogs,
};
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
