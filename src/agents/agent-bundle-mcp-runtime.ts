/** Session-scoped MCP runtime catalog loader and transport lifecycle. */
import { Client, type ClientOptions } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  ErrorCode,
  type CallToolResult,
  type ClientCapabilities,
} from "@modelcontextprotocol/sdk/types.js";
import type { ServerCapabilities } from "@modelcontextprotocol/sdk/types.js";
import { redactSensitiveUrlLikeString } from "@openclaw/net-policy/redact-sensitive-url";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { logWarn } from "../logger.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { runTasksWithConcurrency } from "../utils/run-with-concurrency.js";
import { mergeMcpToolCatalogs } from "./agent-bundle-mcp-combined.js";
import { matchesMcpToolFilterPattern } from "./agent-bundle-mcp-filter.js";
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
import {
  loadSessionMcpConfig,
  resolveSessionMcpConfigSummary,
} from "./agent-bundle-mcp-runtime-config.js";
import { resolveSessionMcpRuntimeIdleTtlMs } from "./agent-bundle-mcp-runtime-shared.js";
import type {
  McpCatalogTool,
  McpRequestOptions,
  McpServerCatalog,
  McpToolCatalog,
  McpToolCatalogDiagnostic,
  SessionMcpRequesterScope,
  SessionMcpRuntime,
  SessionMcpRuntimeManager,
} from "./agent-bundle-mcp-types.js";
import { isMcpConfigRecord } from "./mcp-config-shared.js";
import {
  applyMcpConnectionOverride,
  type McpServerConnectionResolved,
} from "./mcp-connection-resolver.js";
import { createMcpJsonSchemaValidator } from "./mcp-json-schema-validator.js";
import { sanitizeMcpMetadataText } from "./mcp-metadata.js";
import { OpenClawStdioClientTransport } from "./mcp-stdio-transport.js";
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
const BUNDLE_MCP_CATALOG_LIST_TIMEOUT_MS = 1_500;
const BUNDLE_MCP_DISPOSE_TIMEOUT_MS = 5_000;
const BUNDLE_MCP_CATALOG_CONNECT_CONCURRENCY = 6;
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

type McpToolSelection = {
  include?: readonly string[];
  exclude?: readonly string[];
};

type McpServerBackoffState = {
  failures: number;
  retryAfterMs?: number;
};

export { createMcpJsonSchemaValidator as createBundleMcpJsonSchemaValidator };

async function connectWithTimeout(
  serverName: string,
  client: Client,
  transport: Transport,
  timeoutMs: number,
): Promise<void> {
  const abortController = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let deadlineExpired = false;
  try {
    // Client.connect() owns both transport startup and the initialize round trip.
    // Give the SDK the deadline so initialize is cancelled, while the outer race
    // also bounds transports whose start() has not reached initialize yet.
    await Promise.race([
      client.connect(transport, {
        signal: abortController.signal,
        timeout: timeoutMs,
        maxTotalTimeout: timeoutMs,
      }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          deadlineExpired = true;
          abortController.abort();
          reject(new Error("MCP connect deadline expired"));
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    if (deadlineExpired || (isMcpConfigRecord(error) && error.code === ErrorCode.RequestTimeout)) {
      if (transport instanceof OpenClawStdioClientTransport) {
        await transport.forceClose();
      }
      // Closing the SDK client settles its pending initialize request. Without
      // this, later runtime disposal waits its full teardown timeout even though
      // the stdio child is already dead.
      await settleWithin(client.close(), Math.min(timeoutMs, 1_000));
      throw new Error(
        `MCP server "${serverName}" timed out: did not complete initialize within ${timeoutMs / 1_000}s`,
        { cause: error },
      );
    }
    throw error;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function redactErrorUrls(error: unknown): string {
  return redactSensitiveUrlLikeString(String(error));
}

async function listAllTools(client: Client, timeoutMs: number) {
  const tools: ListedTool[] = [];
  let cursor: string | undefined;
  do {
    const params = cursor ? { cursor } : undefined;
    const page = await client.listTools(params, { timeout: timeoutMs });
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  return tools;
}

function isMcpMethodNotFoundError(error: unknown): boolean {
  if (isMcpConfigRecord(error) && error.code === ErrorCode.MethodNotFound) {
    return true;
  }
  const message = String(error);
  return message.includes("-32601") || /method not found/i.test(message);
}

async function listAllToolsBestEffort(params: {
  client: Client;
  timeoutMs: number;
  suppressUnsupported: boolean;
}): Promise<ListedTool[]> {
  try {
    return await listAllTools(params.client, params.timeoutMs);
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

async function listAllResources(client: Client, timeoutMs: number) {
  const resources: unknown[] = [];
  let cursor: string | undefined;
  do {
    const params = cursor ? { cursor } : undefined;
    const page = await client.listResources(params, { timeout: timeoutMs });
    resources.push(...page.resources);
    cursor = page.nextCursor;
  } while (cursor);
  return resources;
}

async function listAllPrompts(client: Client, timeoutMs: number) {
  const prompts: unknown[] = [];
  let cursor: string | undefined;
  do {
    const params = cursor ? { cursor } : undefined;
    const page = await client.listPrompts(params, { timeout: timeoutMs });
    prompts.push(...page.prompts);
    cursor = page.nextCursor;
  } while (cursor);
  return prompts;
}

function normalizeStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const entries = value.filter((entry): entry is string => typeof entry === "string");
  return entries.length > 0 ? entries : undefined;
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

function getMcpToolSelection(rawServer: unknown): McpToolSelection {
  if (!isMcpConfigRecord(rawServer) || !isMcpConfigRecord(rawServer.toolFilter)) {
    return {};
  }
  return {
    include: normalizeStringList(rawServer.toolFilter.include),
    exclude: normalizeStringList(rawServer.toolFilter.exclude),
  };
}

function shouldExposeMcpTool(selection: McpToolSelection, toolName: string): boolean {
  const include = selection.include ?? [];
  const exclude = selection.exclude ?? [];
  if (
    include.length > 0 &&
    !include.some((pattern) => matchesMcpToolFilterPattern(pattern, toolName))
  ) {
    return false;
  }
  return !exclude.some((pattern) => matchesMcpToolFilterPattern(pattern, toolName));
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
async function settleWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return await Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        resolve();
      }, timeoutMs);
      timer.unref?.();
    }).then(() => false),
  ]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

async function disposeSession(session: BundleMcpSession) {
  session.detachStderr?.();
  const timeoutMs = getBundleMcpTestState().disposeTimeoutMs ?? BUNDLE_MCP_DISPOSE_TIMEOUT_MS;
  const closed = await settleWithin(
    (async () => {
      if (session.transportType === "streamable-http") {
        await (session.transport as StreamableHTTPClientTransport)
          .terminateSession()
          .catch(() => {});
      }
      await session.transport.close().catch(() => {});
      await session.client.close().catch(() => {});
    })(),
    timeoutMs,
  );
  if (!closed) {
    // Force-close transport and client so a hung terminateSession() DELETE
    // gets its AbortSignal triggered by teardown. Stdio owns a process group,
    // so force it dead before disposal can report completion.
    const transportClose =
      session.transport instanceof OpenClawStdioClientTransport
        ? session.transport.forceClose()
        : session.transport.close();
    await settleWithin(Promise.allSettled([transportClose, session.client.close()]), timeoutMs);
  }
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
  configFingerprint?: string;
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
  });
  const configFingerprint = params.configFingerprint ?? computedFingerprint;
  const mcpAppsEnabled = params.cfg?.mcp?.apps?.enabled === true;
  const createdAt = Date.now();
  let lastUsedAt = createdAt;
  let activeLeases = 0;
  let disposed = false;
  let catalog: McpToolCatalog | null = null;
  let catalogInFlight: Promise<McpToolCatalog> | undefined;
  let catalogInvalidationGeneration = 0;
  const sessions = new Map<string, BundleMcpSession>();
  const serverBackoff = new Map<string, McpServerBackoffState>();
  const recordServerToolFailure = (serverName: string, nowMs: number) => {
    const previous = serverBackoff.get(serverName);
    const failures = (previous?.failures ?? 0) + 1;
    const nextBackoff: McpServerBackoffState = { failures };
    if (failures >= BUNDLE_MCP_FAILURE_THRESHOLD) {
      nextBackoff.retryAfterMs = nowMs + BUNDLE_MCP_FAILURE_COOLDOWN_MS;
    }
    serverBackoff.set(serverName, nextBackoff);
  };
  const runGuardedServerRequest = async <T>(
    serverName: string,
    request: () => Promise<T>,
    options?: McpRequestOptions,
  ): Promise<T> => {
    const tracksFailureBackoff = options?.failureBackoff !== "ignore";
    const nowMs = Date.now();
    const backoff = serverBackoff.get(serverName);
    if (tracksFailureBackoff && backoff?.retryAfterMs && nowMs < backoff.retryAfterMs) {
      throw new Error(
        `bundle-mcp server "${serverName}" is paused after repeated tool failures; retry after ${new Date(backoff.retryAfterMs).toISOString()}`,
      );
    }
    try {
      const result = await request();
      if (tracksFailureBackoff) {
        serverBackoff.delete(serverName);
      }
      return result;
    } catch (error) {
      if (tracksFailureBackoff) {
        recordServerToolFailure(serverName, nowMs);
      }
      throw error;
    }
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
    session.connectPromise ??= connectWithTimeout(
      session.serverName,
      session.client,
      session.transport,
      connectionTimeoutMs,
    )
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
    await disposeSession(session);
    return true;
  };

  const getCatalog = async (): Promise<McpToolCatalog> => {
    failIfDisposed();
    if (catalog) {
      return catalog;
    }
    if (catalogInFlight) {
      return catalogInFlight;
    }
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

      const servers: Record<string, McpServerCatalog> = {};
      const tools: McpCatalogTool[] = [];
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
          const override = params.connectionOverrides?.get(serverName);
          // Overrides supply per-requester transport only; never write them back to config.
          const transportSource = override
            ? applyMcpConnectionOverride(rawServer, override)
            : rawServer;
          const resolved = resolveMcpTransport(serverName, transportSource, {
            cfg: params.cfg,
            agentDir: params.agentDir,
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
                              `bundle-mcp: failed to refresh changed tool list for server "${serverName}": ${redactErrorUrls(error)}`,
                            );
                          }
                          catalogInvalidationGeneration += 1;
                          catalog = null;
                          catalogInFlight = undefined;
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
                  createdSession.connected = false;
                  createdSession.disconnectReason = "mcp transport closed";
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
                  suppressUnsupported: Boolean(
                    !capabilities.tools && (capabilities.resources || capabilities.prompts),
                  ),
                });
                failIfDisposed();
                const selection = getMcpToolSelection(rawServer);
                const exposedTools = listedTools.filter((tool) =>
                  shouldExposeMcpTool(selection, tool.name.trim()),
                );
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
                  ...(selection.include || selection.exclude
                    ? {
                        toolFilter: {
                          ...(selection.include ? { include: [...selection.include] } : {}),
                          ...(selection.exclude ? { exclude: [...selection.exclude] } : {}),
                        },
                      }
                    : {}),
                };
                const toolEntries: McpCatalogTool[] = [];
                for (const tool of exposedTools) {
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
                  });
                }
                return {
                  serverName,
                  serverEntry,
                  toolEntries,
                  diagnostics: [] as McpToolCatalogDiagnostic[],
                };
              } catch (error) {
                const message = redactErrorUrls(error);
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
          tools.push(...toolEntries);
          diagnostics.push(...serverDiags);
        }

        failIfDisposed();
        return {
          version: 1,
          generatedAt: Date.now(),
          servers,
          tools,
          ...(diagnostics.length > 0 ? { diagnostics } : {}),
        };
      } catch (error) {
        await Promise.allSettled(
          Array.from(sessions.values(), (session) => disposeSession(session)),
        );
        sessions.clear();
        throw error;
      }
    })();
    catalogInFlight = inFlight;

    try {
      const nextCatalog = await inFlight;
      failIfDisposed();
      if (catalogInvalidationGeneration === catalogGeneration) {
        catalog = nextCatalog;
      }
      return nextCatalog;
    } finally {
      if (catalogInFlight === inFlight) {
        catalogInFlight = undefined;
      }
    }
  };

  return {
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    workspaceDir: params.workspaceDir,
    agentDir: params.agentDir,
    configFingerprint,
    ...(params.requesterScope ? { requesterScope: params.requesterScope } : {}),
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
    markUsed() {
      lastUsedAt = Date.now();
    },
    async callTool(serverName, toolName, input) {
      failIfDisposed();
      await getCatalog();
      const session = requireConnectedSession(serverName);
      return await runGuardedServerRequest(
        serverName,
        async () =>
          (await session.client.callTool(
            {
              name: toolName,
              arguments: isMcpConfigRecord(input) ? input : {},
            },
            undefined,
            { timeout: session.requestTimeoutMs },
          )) as CallToolResult,
      );
    },
    async listTools(serverName, requestParams) {
      failIfDisposed();
      await getCatalog();
      const session = requireConnectedSession(serverName);
      return await runGuardedServerRequest(serverName, async () =>
        session.client.listTools(requestParams, { timeout: session.requestTimeoutMs }),
      );
    },
    async listResources(serverName, options) {
      failIfDisposed();
      await getCatalog();
      const session = requireConnectedSession(serverName);
      return await runGuardedServerRequest(
        serverName,
        async () => listAllResources(session.client, session.requestTimeoutMs),
        options,
      );
    },
    async readResource(serverName, uri, options) {
      failIfDisposed();
      await getCatalog();
      const session = requireConnectedSession(serverName);
      return await runGuardedServerRequest(
        serverName,
        async () =>
          await session.client.readResource({ uri }, { timeout: session.requestTimeoutMs }),
        options,
      );
    },
    async listResourceTemplates(serverName, requestParams) {
      failIfDisposed();
      await getCatalog();
      const session = requireConnectedSession(serverName);
      return await runGuardedServerRequest(serverName, async () =>
        session.client.listResourceTemplates(requestParams, {
          timeout: session.requestTimeoutMs,
        }),
      );
    },
    async listPrompts(serverName) {
      failIfDisposed();
      await getCatalog();
      const session = requireConnectedSession(serverName);
      return await runGuardedServerRequest(serverName, async () =>
        listAllPrompts(session.client, session.requestTimeoutMs),
      );
    },
    async getPrompt(serverName, name, args) {
      failIfDisposed();
      await getCatalog();
      const session = requireConnectedSession(serverName);
      return await runGuardedServerRequest(
        serverName,
        async () =>
          await session.client.getPrompt(
            { name, ...(args ? { arguments: args } : {}) },
            { timeout: session.requestTimeoutMs },
          ),
      );
    },
    async dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      catalog = null;
      catalogInFlight = undefined;
      const sessionsToClose = Array.from(sessions.values());
      sessions.clear();
      await Promise.allSettled(sessionsToClose.map((session) => disposeSession(session)));
    },
  };
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
