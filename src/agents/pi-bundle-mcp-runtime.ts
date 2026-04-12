import crypto from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { logWarn } from "../logger.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
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

const SESSION_MCP_RUNTIME_MANAGER_KEY = Symbol.for("openclaw.sessionMcpRuntimeManager");

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

async function listAllTools(client: Client) {
  const tools: ListedTool[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
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
  await session.client.close().catch(() => {});
  await session.transport.close().catch(() => {});
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
            {},
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
            const listedTools = await listAllTools(client);
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

function createSessionMcpRuntimeManager(): SessionMcpRuntimeManager {
  const runtimesBySessionId = new Map<string, SessionMcpRuntime>();
  const sessionIdBySessionKey = new Map<string, string>();
  const createInFlight = new Map<
    string,
    {
      promise: Promise<SessionMcpRuntime>;
      workspaceDir: string;
      configFingerprint: string;
    }
  >();

  return {
    async getOrCreate(params) {
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
        await staleRuntime?.dispose();
      }
      const created = Promise.resolve(
        createSessionMcpRuntime({
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          workspaceDir: params.workspaceDir,
          cfg: params.cfg,
        }),
      ).then((runtime) => {
        runtime.markUsed();
        runtimesBySessionId.set(params.sessionId, runtime);
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
      if (!runtime) {
        for (const [sessionKey, mappedSessionId] of sessionIdBySessionKey.entries()) {
          if (mappedSessionId === sessionId) {
            sessionIdBySessionKey.delete(sessionKey);
          }
        }
        return;
      }
      for (const [sessionKey, mappedSessionId] of sessionIdBySessionKey.entries()) {
        if (mappedSessionId === sessionId) {
          sessionIdBySessionKey.delete(sessionKey);
        }
      }
      await runtime.dispose();
    },
    async disposeAll() {
      const inFlightRuntimes = Array.from(createInFlight.values());
      createInFlight.clear();
      const runtimes = Array.from(runtimesBySessionId.values());
      runtimesBySessionId.clear();
      sessionIdBySessionKey.clear();
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

export async function disposeAllSessionMcpRuntimes(): Promise<void> {
  await getSessionMcpRuntimeManager().disposeAll();
}

export const __testing = {
  async resetSessionMcpRuntimeManager() {
    await disposeAllSessionMcpRuntimes();
  },
  getCachedSessionIds() {
    return getSessionMcpRuntimeManager().listSessionIds();
  },
};
