/** Session-scoped MCP runtime manager, catalog loader, and transport lifecycle. */
import crypto from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ErrorCode, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ServerCapabilities } from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js";
import type {
  JsonSchemaType,
  JsonSchemaValidator,
  jsonSchemaValidator,
} from "@modelcontextprotocol/sdk/validation/types.js";
import { redactSensitiveUrlLikeString } from "@openclaw/net-policy/redact-sensitive-url";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { Compile } from "typebox/compile";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { toErrorObject } from "../infra/errors.js";
import { logWarn } from "../logger.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  findJsonSchemaShapeError,
  normalizeJsonSchemaForTypeBox,
} from "../shared/json-schema-defaults.js";
import { runTasksWithConcurrency } from "../utils/run-with-concurrency.js";
import { matchesMcpToolFilterPattern } from "./agent-bundle-mcp-filter.js";
import { sanitizeServerName } from "./agent-bundle-mcp-names.js";
import type {
  McpCatalogTool,
  McpServerCatalog,
  McpToolCatalog,
  McpToolCatalogDiagnostic,
  SessionMcpRuntime,
  SessionMcpRuntimeManager,
} from "./agent-bundle-mcp-types.js";
import { loadEmbeddedAgentMcpConfig } from "./embedded-agent-mcp.js";
import { isMcpConfigRecord } from "./mcp-config-shared.js";
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

type LoadedMcpConfig = ReturnType<typeof loadEmbeddedAgentMcpConfig>;
type ListedTool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];
type CreateSessionMcpRuntime = (
  params: Parameters<typeof createSessionMcpRuntime>[0] & { configFingerprint?: string },
) => SessionMcpRuntime;

const SESSION_MCP_RUNTIME_MANAGER_KEY = Symbol.for("openclaw.sessionMcpRuntimeManager");
const DRAFT_2020_12_SCHEMA = "https://json-schema.org/draft/2020-12/schema";
const DEFAULT_SESSION_MCP_RUNTIME_IDLE_TTL_MS = 10 * 60 * 1000;
const SESSION_MCP_RUNTIME_SWEEP_INTERVAL_MS = 60 * 1000;
const BUNDLE_MCP_FAILURE_THRESHOLD = 3;
const BUNDLE_MCP_FAILURE_COOLDOWN_MS = 60_000;
const BUNDLE_MCP_CATALOG_LIST_TIMEOUT_MS = 1_500;
const BUNDLE_MCP_DISPOSE_TIMEOUT_MS = 5_000;
const BUNDLE_MCP_CATALOG_CONNECT_CONCURRENCY = 6;
const BUNDLE_MCP_METADATA_TEXT_LIMIT = 1_200;
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

function isDraft202012Schema(schema: JsonSchemaType): boolean {
  return (schema as { $schema?: unknown }).$schema === DRAFT_2020_12_SCHEMA;
}

function formatTypeBoxErrors(errors: Array<{ instancePath?: string; message?: string }>): string {
  return (
    errors
      .map((error) => {
        const message = error.message?.trim() || "schema validation failed";
        return error.instancePath ? `${error.instancePath} ${message}` : message;
      })
      .join(", ") || "schema validation failed"
  );
}

const schemaMapKeywords = new Set([
  "$defs",
  "definitions",
  "dependentSchemas",
  "patternProperties",
  "properties",
]);
const schemaValueKeywords = new Set([
  "additionalItems",
  "additionalProperties",
  "contains",
  "else",
  "if",
  "items",
  "not",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
]);
const schemaArrayKeywords = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);

function stripSchemaMapFormats(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, stripJsonSchemaFormats(entry)]),
  );
}

function expandJsonSchemaTypeArray(schema: Record<string, unknown>): Record<string, unknown> {
  const { type, ...rest } = schema;
  if (!Array.isArray(type)) {
    return schema;
  }
  return {
    anyOf: type.map((entry) => Object.assign({}, rest, { type: entry })),
  };
}

function stripJsonSchemaFormats(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map((entry) => stripJsonSchemaFormats(entry));
  }
  if (!schema || typeof schema !== "object") {
    return schema;
  }
  const normalizedSchema = expandJsonSchemaTypeArray(schema as Record<string, unknown>);
  return Object.fromEntries(
    Object.entries(normalizedSchema)
      .filter(([key]) => key !== "format")
      .map(([key, value]) => {
        if (schemaMapKeywords.has(key)) {
          return [key, stripSchemaMapFormats(value)];
        }
        if (key === "dependencies") {
          return [key, stripSchemaMapFormats(value)];
        }
        if (schemaValueKeywords.has(key) || schemaArrayKeywords.has(key)) {
          return [key, stripJsonSchemaFormats(value)];
        }
        return [key, value];
      }),
  );
}

export function createBundleMcpJsonSchemaValidator(): jsonSchemaValidator {
  const defaultValidator = new AjvJsonSchemaValidator();

  return {
    getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T> {
      if (!isDraft202012Schema(schema)) {
        return defaultValidator.getValidator<T>(schema);
      }
      let validator: ReturnType<typeof Compile>;
      try {
        const schemaError = findJsonSchemaShapeError(schema as never);
        if (schemaError) {
          throw new Error(schemaError);
        }
        validator = Compile(
          normalizeJsonSchemaForTypeBox(stripJsonSchemaFormats(schema) as never) as never,
        );
      } catch (error) {
        const setupError = toErrorObject(error, "schema setup failed");
        throw new Error(`Invalid MCP draft-2020-12 JSON Schema: ${setupError.message}`, {
          cause: error,
        });
      }
      return (input: unknown) => {
        const valid = validator.Check(input);
        if (valid) {
          return {
            valid: true,
            data: input as T,
            errorMessage: undefined,
          };
        }
        return {
          valid: false,
          data: undefined,
          errorMessage: formatTypeBoxErrors([...validator.Errors(input)]),
        };
      };
    },
  };
}

function connectWithTimeout(
  client: Client,
  transport: Transport,
  timeoutMs: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`MCP server connection timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    client.connect(transport).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(toErrorObject(error, "Non-Error rejection"));
      },
    );
  });
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

function sanitizeMcpMetadataText(value: string | undefined): string | undefined {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return undefined;
  }
  const scrubbed = normalized
    .replace(
      /ignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions/gi,
      "[redacted MCP metadata instruction]",
    )
    .replace(
      /disregard\s+(?:all\s+)?(?:previous|prior|above)\s+instructions/gi,
      "[redacted MCP metadata instruction]",
    )
    .replace(/system\s+prompt/gi, "system prompt");
  return scrubbed.length > BUNDLE_MCP_METADATA_TEXT_LIMIT
    ? `${truncateUtf16Safe(scrubbed, BUNDLE_MCP_METADATA_TEXT_LIMIT)}...`
    : scrubbed;
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

function createCatalogFingerprint(servers: Record<string, unknown>): string {
  // Session MCP fingerprints only invalidate in-memory runtime catalogs.
  // Algorithm changes can cause one cache miss, but no persisted state migration.
  return crypto.createHash("sha256").update(JSON.stringify(servers)).digest("hex");
}

function loadSessionMcpConfig(params: {
  workspaceDir: string;
  cfg?: OpenClawConfig;
  logDiagnostics?: boolean;
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
}): {
  loaded: LoadedMcpConfig;
  fingerprint: string;
} {
  const loaded = loadEmbeddedAgentMcpConfig({
    workspaceDir: params.workspaceDir,
    cfg: params.cfg,
    manifestRegistry: params.manifestRegistry,
  });
  if (params.logDiagnostics !== false) {
    for (const diagnostic of loaded.diagnostics) {
      logWarn(`bundle-mcp: ${diagnostic.pluginId}: ${diagnostic.message}`);
    }
  }
  return {
    loaded,
    fingerprint: createCatalogFingerprint(loaded.mcpServers),
  };
}

/**
 * Loads enabled MCP config metadata for a session without creating runtimes,
 * connecting transports, or issuing MCP tools/list requests.
 */
export function resolveSessionMcpConfigSummary(params: {
  workspaceDir: string;
  cfg?: OpenClawConfig;
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
}): { fingerprint: string; serverNames: string[] } {
  const { loaded, fingerprint } = loadSessionMcpConfig({
    workspaceDir: params.workspaceDir,
    cfg: params.cfg,
    logDiagnostics: false,
    manifestRegistry: params.manifestRegistry,
  });
  return {
    fingerprint,
    serverNames: Object.keys(loaded.mcpServers).toSorted((a, b) => a.localeCompare(b)),
  };
}

function createDisposedError(sessionId: string): Error {
  return new Error(`bundle-mcp runtime disposed for session ${sessionId}`);
}

function resolveSessionMcpRuntimeIdleTtlMs(cfg?: OpenClawConfig): number {
  const raw = cfg?.mcp?.sessionIdleTtlMs;
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
    return Math.floor(raw);
  }
  return DEFAULT_SESSION_MCP_RUNTIME_IDLE_TTL_MS;
}

export function createSessionMcpRuntime(params: {
  sessionId: string;
  sessionKey?: string;
  workspaceDir: string;
  cfg?: OpenClawConfig;
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
}): SessionMcpRuntime {
  const { loaded, fingerprint: configFingerprint } = loadSessionMcpConfig({
    workspaceDir: params.workspaceDir,
    cfg: params.cfg,
    logDiagnostics: true,
    manifestRegistry: params.manifestRegistry,
  });
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
  ): Promise<T> => {
    const nowMs = Date.now();
    const backoff = serverBackoff.get(serverName);
    if (backoff?.retryAfterMs && nowMs < backoff.retryAfterMs) {
      throw new Error(
        `bundle-mcp server "${serverName}" is paused after repeated tool failures; retry after ${new Date(backoff.retryAfterMs).toISOString()}`,
      );
    }
    try {
      const result = await request();
      serverBackoff.delete(serverName);
      return result;
    } catch (error) {
      recordServerToolFailure(serverName, nowMs);
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
      const usedServerNames = new Set<string>();

      try {
        // Pre-compute safe server names sequentially (synchronous, fast — no I/O)
        const preparedEntries: Array<{
          serverName: string;
          rawServer: (typeof loaded.mcpServers)[string];
          resolved: NonNullable<ReturnType<typeof resolveMcpTransport>>;
          safeServerName: string;
        }> = [];
        for (const [serverName, rawServer] of Object.entries(loaded.mcpServers)) {
          failIfDisposed();
          const resolved = resolveMcpTransport(serverName, rawServer);
          if (!resolved) {
            continue;
          }
          const safeServerName = sanitizeServerName(serverName, usedServerNames);
          if (safeServerName !== serverName) {
            logWarn(
              `bundle-mcp: server key "${serverName}" registered as "${safeServerName}" for provider-safe tool names.`,
            );
          }
          preparedEntries.push({ serverName, rawServer, resolved, safeServerName });
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
          ({ serverName, rawServer, resolved, safeServerName }) =>
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
                    jsonSchemaValidator: createBundleMcpJsonSchemaValidator(),
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
                  launchSummary: resolved.description,
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
                  toolEntries.push({
                    serverName,
                    safeServerName,
                    toolName,
                    title: tool.title,
                    description: sanitizeMcpMetadataText(tool.description),
                    inputSchema: tool.inputSchema,
                    fallbackDescription: `Provided by bundle MCP server "${serverName}" (${resolved.description}).`,
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
                    `bundle-mcp: failed to ${action} server "${serverName}" (${resolved.description}): ${message}`,
                  );
                }
                const diags: McpToolCatalogDiagnostic[] = [
                  {
                    serverName,
                    safeServerName,
                    launchSummary: resolved.description,
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
    configFingerprint,
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
    async listResources(serverName) {
      failIfDisposed();
      await getCatalog();
      const session = requireConnectedSession(serverName);
      return await runGuardedServerRequest(serverName, async () =>
        listAllResources(session.client, session.requestTimeoutMs),
      );
    },
    async readResource(serverName, uri) {
      failIfDisposed();
      await getCatalog();
      const session = requireConnectedSession(serverName);
      return await runGuardedServerRequest(
        serverName,
        async () =>
          await session.client.readResource({ uri }, { timeout: session.requestTimeoutMs }),
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

function createSessionMcpRuntimeManager(
  opts: {
    createRuntime?: CreateSessionMcpRuntime;
    now?: () => number;
    enableIdleSweepTimer?: boolean;
    idleSweepIntervalMs?: number;
  } = {},
): SessionMcpRuntimeManager {
  const runtimesBySessionId = new Map<string, SessionMcpRuntime>();
  const sessionIdBySessionKey = new Map<string, string>();
  const idleTtlMsBySessionId = new Map<string, number>();
  const createRuntime = opts.createRuntime ?? createSessionMcpRuntime;
  const now = opts.now ?? Date.now;
  const createInFlight = new Map<
    string,
    {
      promise: Promise<SessionMcpRuntime>;
      workspaceDir: string;
      configFingerprint: string;
    }
  >();
  const idleSweepIntervalMs = opts.idleSweepIntervalMs ?? SESSION_MCP_RUNTIME_SWEEP_INTERVAL_MS;
  let idleSweepTimer: ReturnType<typeof setInterval> | undefined;
  let idleSweepInFlight: Promise<void> | undefined;

  const forgetSessionKeysForSessionId = (sessionId: string) => {
    for (const [sessionKey, mappedSessionId] of sessionIdBySessionKey.entries()) {
      if (mappedSessionId === sessionId) {
        sessionIdBySessionKey.delete(sessionKey);
      }
    }
  };

  const sweepIdleRuntimes = async (): Promise<number> => {
    const nowMs = now();
    const expired: SessionMcpRuntime[] = [];
    for (const [sessionId, runtime] of runtimesBySessionId.entries()) {
      const idleTtlMs =
        idleTtlMsBySessionId.get(sessionId) ?? DEFAULT_SESSION_MCP_RUNTIME_IDLE_TTL_MS;
      if (idleTtlMs <= 0 || (runtime.activeLeases ?? 0) > 0) {
        continue;
      }
      if (nowMs - runtime.lastUsedAt < idleTtlMs) {
        continue;
      }
      runtimesBySessionId.delete(sessionId);
      idleTtlMsBySessionId.delete(sessionId);
      forgetSessionKeysForSessionId(sessionId);
      expired.push(runtime);
    }
    await Promise.allSettled(expired.map((runtime) => runtime.dispose()));
    return expired.length;
  };

  const queueIdleSweep = () => {
    if (idleSweepInFlight) {
      return;
    }
    idleSweepInFlight = sweepIdleRuntimes()
      .then(() => undefined)
      .catch((error: unknown) => {
        logWarn(`bundle-mcp: idle runtime sweep failed: ${String(error)}`);
      })
      .finally(() => {
        idleSweepInFlight = undefined;
      });
  };

  const ensureIdleSweepTimer = () => {
    if (opts.enableIdleSweepTimer === false || idleSweepIntervalMs <= 0 || idleSweepTimer) {
      return;
    }
    idleSweepTimer = setInterval(queueIdleSweep, idleSweepIntervalMs);
    idleSweepTimer.unref?.();
  };

  const clearIdleSweepTimer = () => {
    if (!idleSweepTimer) {
      return;
    }
    clearInterval(idleSweepTimer);
    idleSweepTimer = undefined;
  };

  return {
    async getOrCreate(params) {
      const idleTtlMs = resolveSessionMcpRuntimeIdleTtlMs(params.cfg);
      if (runtimesBySessionId.has(params.sessionId)) {
        idleTtlMsBySessionId.set(params.sessionId, idleTtlMs);
      }
      await sweepIdleRuntimes();
      if (idleTtlMs > 0) {
        ensureIdleSweepTimer();
      }
      if (params.sessionKey) {
        sessionIdBySessionKey.set(params.sessionKey, params.sessionId);
      }
      const { fingerprint: nextFingerprint } = loadSessionMcpConfig({
        workspaceDir: params.workspaceDir,
        cfg: params.cfg,
        logDiagnostics: false,
      });
      const existing = runtimesBySessionId.get(params.sessionId);
      if (existing) {
        if (
          existing.workspaceDir !== params.workspaceDir ||
          existing.configFingerprint !== nextFingerprint
        ) {
          runtimesBySessionId.delete(params.sessionId);
          await existing.dispose();
        } else {
          existing.markUsed();
          idleTtlMsBySessionId.set(params.sessionId, idleTtlMs);
          return existing;
        }
      }
      const inFlight = createInFlight.get(params.sessionId);
      if (inFlight) {
        if (
          inFlight.workspaceDir === params.workspaceDir &&
          inFlight.configFingerprint === nextFingerprint
        ) {
          return inFlight.promise;
        }
        createInFlight.delete(params.sessionId);
        const staleRuntime = await inFlight.promise.catch(() => undefined);
        runtimesBySessionId.delete(params.sessionId);
        idleTtlMsBySessionId.delete(params.sessionId);
        await staleRuntime?.dispose();
      }
      const created = Promise.resolve(
        createRuntime({
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          workspaceDir: params.workspaceDir,
          cfg: params.cfg,
          configFingerprint: nextFingerprint,
        }),
      ).then((runtime) => {
        runtime.markUsed();
        runtimesBySessionId.set(params.sessionId, runtime);
        idleTtlMsBySessionId.set(params.sessionId, idleTtlMs);
        return runtime;
      });
      createInFlight.set(params.sessionId, {
        promise: created,
        workspaceDir: params.workspaceDir,
        configFingerprint: nextFingerprint,
      });
      try {
        return await created;
      } finally {
        createInFlight.delete(params.sessionId);
      }
    },
    bindSessionKey(sessionKey, sessionId) {
      sessionIdBySessionKey.set(sessionKey, sessionId);
    },
    resolveSessionId(sessionKey) {
      return sessionIdBySessionKey.get(sessionKey);
    },
    /** Synchronous lookup only; must not create runtimes or connect transports. */
    peekSession(params) {
      const sessionId =
        params.sessionId ??
        (params.sessionKey ? sessionIdBySessionKey.get(params.sessionKey) : undefined);
      return sessionId ? runtimesBySessionId.get(sessionId) : undefined;
    },
    async disposeSession(sessionId) {
      const inFlight = createInFlight.get(sessionId);
      createInFlight.delete(sessionId);
      let runtime = runtimesBySessionId.get(sessionId);
      if (!runtime && inFlight) {
        runtime = await inFlight.promise.catch(() => undefined);
      }
      runtimesBySessionId.delete(sessionId);
      idleTtlMsBySessionId.delete(sessionId);
      if (!runtime) {
        forgetSessionKeysForSessionId(sessionId);
        return;
      }
      forgetSessionKeysForSessionId(sessionId);
      await runtime.dispose();
    },
    async disposeAll() {
      clearIdleSweepTimer();
      const inFlightRuntimes = Array.from(createInFlight.values());
      createInFlight.clear();
      const runtimes = Array.from(runtimesBySessionId.values());
      runtimesBySessionId.clear();
      sessionIdBySessionKey.clear();
      idleTtlMsBySessionId.clear();
      const lateRuntimes = await Promise.all(
        inFlightRuntimes.map(async ({ promise }) => await promise.catch(() => undefined)),
      );
      const allRuntimes = new Set<SessionMcpRuntime>(runtimes);
      for (const runtime of lateRuntimes) {
        if (runtime) {
          allRuntimes.add(runtime);
        }
      }
      await Promise.allSettled(Array.from(allRuntimes, (runtime) => runtime.dispose()));
    },
    sweepIdleRuntimes,
    listSessionIds() {
      return Array.from(runtimesBySessionId.keys());
    },
  };
}

export function getSessionMcpRuntimeManager(): SessionMcpRuntimeManager {
  return resolveGlobalSingleton(SESSION_MCP_RUNTIME_MANAGER_KEY, createSessionMcpRuntimeManager);
}

export async function getOrCreateSessionMcpRuntime(params: {
  sessionId: string;
  sessionKey?: string;
  workspaceDir: string;
  cfg?: OpenClawConfig;
}): Promise<SessionMcpRuntime> {
  return await getSessionMcpRuntimeManager().getOrCreate(params);
}

/** Looks up an existing session MCP runtime without creating it or connecting transports. */
export function peekSessionMcpRuntime(params: {
  sessionId?: string | null;
  sessionKey?: string | null;
}): SessionMcpRuntime | undefined {
  const sessionId = normalizeOptionalString(params.sessionId);
  const sessionKey = normalizeOptionalString(params.sessionKey);
  return getSessionMcpRuntimeManager().peekSession({
    ...(sessionId ? { sessionId } : {}),
    ...(sessionKey ? { sessionKey } : {}),
  });
}

export async function disposeSessionMcpRuntime(sessionId: string): Promise<void> {
  await getSessionMcpRuntimeManager().disposeSession(sessionId);
}

export async function retireSessionMcpRuntime(params: {
  sessionId?: string | null;
  reason: string;
  onError?: (error: unknown, sessionId: string, reason: string) => void;
}): Promise<boolean> {
  const sessionId = normalizeOptionalString(params.sessionId);
  if (!sessionId) {
    return false;
  }
  try {
    await disposeSessionMcpRuntime(sessionId);
    return true;
  } catch (error) {
    params.onError?.(error, sessionId, params.reason);
    return false;
  }
}

export async function retireSessionMcpRuntimeForSessionKey(params: {
  sessionKey?: string | null;
  reason: string;
  onError?: (error: unknown, sessionId: string, reason: string) => void;
}): Promise<boolean> {
  const sessionKey = normalizeOptionalString(params.sessionKey);
  if (!sessionKey) {
    return false;
  }
  const sessionId = getSessionMcpRuntimeManager().resolveSessionId(sessionKey);
  return await retireSessionMcpRuntime({
    sessionId,
    reason: params.reason,
    onError: params.onError,
  });
}

export async function disposeAllSessionMcpRuntimes(): Promise<void> {
  await getSessionMcpRuntimeManager().disposeAll();
}

export const testing = {
  createSessionMcpRuntimeManager,
  async resetSessionMcpRuntimeManager() {
    await disposeAllSessionMcpRuntimes();
    setBundleMcpCatalogListTimeoutMsForTest();
    setBundleMcpDisposeTimeoutMsForTest();
  },
  getCachedSessionIds() {
    return getSessionMcpRuntimeManager().listSessionIds();
  },
  setBundleMcpCatalogListTimeoutMsForTest,
  setBundleMcpDisposeTimeoutMsForTest,
  resolveSessionMcpRuntimeIdleTtlMs,
};
export { testing as __testing };
