import crypto from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js";
import type {
  JsonSchemaType,
  JsonSchemaValidator,
  jsonSchemaValidator,
} from "@modelcontextprotocol/sdk/validation/types.js";
import { Compile } from "typebox/compile";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { logWarn } from "../logger.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  findJsonSchemaShapeError,
  normalizeJsonSchemaForTypeBox,
} from "../shared/json-schema-defaults.js";
import { redactSensitiveUrlLikeString } from "../shared/net/redact-sensitive-url.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { loadEmbeddedPiMcpConfig } from "./embedded-pi-mcp.js";
import { isMcpConfigRecord } from "./mcp-config-shared.js";
import { resolveMcpTransport } from "./mcp-transport.js";
import { sanitizeServerName } from "./pi-bundle-mcp-names.js";
import type {
  McpCatalogTool,
  McpServerCatalog,
  McpToolCatalog,
  SessionMcpRuntime,
  SessionMcpRuntimeManager,
} from "./pi-bundle-mcp-types.js";

type BundleMcpSession = {
  serverName: string;
  client: Client;
  transport: Transport;
  transportType: "stdio" | "sse" | "streamable-http";
  detachStderr?: () => void;
};

type LoadedMcpConfig = ReturnType<typeof loadEmbeddedPiMcpConfig>;
type ListedTool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];
type CreateSessionMcpRuntime = (
  params: Parameters<typeof createSessionMcpRuntime>[0] & { configFingerprint?: string },
) => SessionMcpRuntime;

const SESSION_MCP_RUNTIME_MANAGER_KEY = Symbol.for("openclaw.sessionMcpRuntimeManager");
const DRAFT_2020_12_SCHEMA = "https://json-schema.org/draft/2020-12/schema";
const DEFAULT_SESSION_MCP_RUNTIME_IDLE_TTL_MS = 10 * 60 * 1000;
const SESSION_MCP_RUNTIME_SWEEP_INTERVAL_MS = 60 * 1000;
const BUNDLE_MCP_CATALOG_LIST_TIMEOUT_MS = 1_500;

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
      const schemaError = findJsonSchemaShapeError(schema as never);
      if (schemaError) {
        throw new Error(`Invalid MCP draft-2020-12 JSON Schema: ${schemaError}`);
      }
      const validator = Compile(
        normalizeJsonSchemaForTypeBox(stripJsonSchemaFormats(schema) as never) as never,
      );
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
      (error) => {
        clearTimeout(timer);
        reject(error);
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

async function disposeSession(session: BundleMcpSession) {
  session.detachStderr?.();
  if (session.transportType === "streamable-http") {
    await (session.transport as StreamableHTTPClientTransport).terminateSession().catch(() => {});
  }
  await session.transport.close().catch(() => {});
  await session.client.close().catch(() => {});
}

function createCatalogFingerprint(servers: Record<string, unknown>): string {
  return crypto.createHash("sha1").update(JSON.stringify(servers)).digest("hex");
}

function loadSessionMcpConfig(params: {
  workspaceDir: string;
  cfg?: OpenClawConfig;
  logDiagnostics?: boolean;
}): {
  loaded: LoadedMcpConfig;
  fingerprint: string;
} {
  const loaded = loadEmbeddedPiMcpConfig({
    workspaceDir: params.workspaceDir,
    cfg: params.cfg,
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
}): SessionMcpRuntime {
  const { loaded, fingerprint: configFingerprint } = loadSessionMcpConfig({
    workspaceDir: params.workspaceDir,
    cfg: params.cfg,
    logDiagnostics: true,
  });
  const createdAt = Date.now();
  let lastUsedAt = createdAt;
  let activeLeases = 0;
  let disposed = false;
  let catalog: McpToolCatalog | null = null;
  let catalogInFlight: Promise<McpToolCatalog> | undefined;
  const sessions = new Map<string, BundleMcpSession>();
  const failIfDisposed = () => {
    if (disposed) {
      throw createDisposedError(params.sessionId);
    }
  };

  const getCatalog = async (): Promise<McpToolCatalog> => {
    failIfDisposed();
    if (catalog) {
      return catalog;
    }
    if (catalogInFlight) {
      return catalogInFlight;
    }
    catalogInFlight = (async () => {
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
      const usedServerNames = new Set<string>();

      try {
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

          const client = new Client(
            {
              name: "openclaw-bundle-mcp",
              version: "0.0.0",
            },
            {
              jsonSchemaValidator: createBundleMcpJsonSchemaValidator(),
            },
          );
          const session: BundleMcpSession = {
            serverName,
            client,
            transport: resolved.transport,
            transportType: resolved.transportType,
            detachStderr: resolved.detachStderr,
          };
          sessions.set(serverName, session);

          try {
            failIfDisposed();
            await connectWithTimeout(client, resolved.transport, resolved.connectionTimeoutMs);
            failIfDisposed();
            const listedTools = await listAllTools(client, BUNDLE_MCP_CATALOG_LIST_TIMEOUT_MS);
            failIfDisposed();
            servers[serverName] = {
              serverName,
              launchSummary: resolved.description,
              toolCount: listedTools.length,
            };
            for (const tool of listedTools) {
              const toolName = tool.name.trim();
              if (!toolName) {
                continue;
              }
              tools.push({
                serverName,
                safeServerName,
                toolName,
                title: tool.title,
                description: normalizeOptionalString(tool.description),
                inputSchema: tool.inputSchema,
                fallbackDescription: `Provided by bundle MCP server "${serverName}" (${resolved.description}).`,
              });
            }
          } catch (error) {
            if (!disposed) {
              logWarn(
                `bundle-mcp: failed to start server "${serverName}" (${resolved.description}): ${redactErrorUrls(error)}`,
              );
            }
            await disposeSession(session);
            sessions.delete(serverName);
            failIfDisposed();
          }
        }

        failIfDisposed();
        return {
          version: 1,
          generatedAt: Date.now(),
          servers,
          tools,
        };
      } catch (error) {
        await Promise.allSettled(
          Array.from(sessions.values(), (session) => disposeSession(session)),
        );
        sessions.clear();
        throw error;
      }
    })();

    try {
      const nextCatalog = await catalogInFlight;
      failIfDisposed();
      catalog = nextCatalog;
      return nextCatalog;
    } finally {
      catalogInFlight = undefined;
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
        lastUsedAt = Date.now();
      };
    },
    getCatalog,
    markUsed() {
      lastUsedAt = Date.now();
    },
    async callTool(serverName, toolName, input) {
      failIfDisposed();
      await getCatalog();
      const session = sessions.get(serverName);
      if (!session) {
        throw new Error(`bundle-mcp server "${serverName}" is not connected`);
      }
      return (await session.client.callTool({
        name: toolName,
        arguments: isMcpConfigRecord(input) ? input : {},
      })) as CallToolResult;
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
  },
  getCachedSessionIds() {
    return getSessionMcpRuntimeManager().listSessionIds();
  },
  resolveSessionMcpRuntimeIdleTtlMs,
};
export { testing as __testing };
