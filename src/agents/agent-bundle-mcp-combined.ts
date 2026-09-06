/** Combined session MCP runtime facade for server and requester partitions. */
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { runTasksWithConcurrency } from "../utils/run-with-concurrency.js";
import { getSessionMcpRequestSignal } from "./agent-bundle-mcp-request-context.js";
import type {
  McpCatalogTool,
  McpServerCatalog,
  McpToolCatalog,
  McpToolCatalogDiagnostic,
  SessionMcpRuntime,
} from "./agent-bundle-mcp-types.js";
import { recordAgentCleanupFailure } from "./run-cleanup-timeout.js";

function compareCatalogTools(left: McpCatalogTool, right: McpCatalogTool): number {
  return (
    left.safeServerName.localeCompare(right.safeServerName) ||
    left.toolName.localeCompare(right.toolName) ||
    left.serverName.localeCompare(right.serverName)
  );
}

async function loadCurrentCatalog(part: SessionMcpRuntime): Promise<McpToolCatalog> {
  if (part.retiredCatalog) {
    return part.retiredCatalog;
  }
  try {
    const catalog = await part.getCatalog();
    return part.retiredCatalog ?? catalog;
  } catch (error) {
    // Revocation can close a transport while discovery awaits it. Preserve the
    // owner's recorded outcome without suppressing failures from live siblings.
    if (part.retiredCatalog) {
      return part.retiredCatalog;
    }
    throw error;
  }
}

/**
 * Merge catalogs from static + requester partitions.
 * Safe names are precomputed from the full declared set, so no re-suffix is needed.
 */
export function mergeMcpToolCatalogs(catalogs: readonly McpToolCatalog[]): McpToolCatalog {
  const servers: Record<string, McpServerCatalog> = {};
  const tools: McpCatalogTool[] = [];
  const policyTools: McpCatalogTool[] = [];
  const sessionDeniedTools: McpCatalogTool[] = [];
  const diagnostics: McpToolCatalogDiagnostic[] = [];

  for (const catalog of catalogs) {
    for (const [serverName, server] of Object.entries(catalog.servers).toSorted(([a], [b]) =>
      a.localeCompare(b),
    )) {
      servers[serverName] = server;
    }
    tools.push(...catalog.tools);
    policyTools.push(
      ...(catalog.policyTools ?? [...catalog.tools, ...(catalog.sessionDeniedTools ?? [])]),
    );
    if (catalog.sessionDeniedTools) {
      sessionDeniedTools.push(...catalog.sessionDeniedTools);
    }
    if (catalog.diagnostics) {
      diagnostics.push(...catalog.diagnostics);
    }
  }
  tools.sort(compareCatalogTools);
  policyTools.sort(compareCatalogTools);
  sessionDeniedTools.sort(compareCatalogTools);
  return {
    version: 1,
    generatedAt: Math.max(0, ...catalogs.map((catalog) => catalog.generatedAt)),
    servers,
    tools,
    ...(policyTools.length > 0 ? { policyTools } : {}),
    ...(sessionDeniedTools.length > 0 ? { sessionDeniedTools } : {}),
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
  };
}

export function createCombinedSessionMcpRuntime(params: {
  sessionId: string;
  sessionKey?: string;
  workspaceDir: string;
  agentDir?: string;
  parts: readonly SessionMcpRuntime[];
  serverOwners?: Map<string, SessionMcpRuntime>;
}): SessionMcpRuntime {
  if (params.parts.length === 1 && !params.serverOwners) {
    return params.parts[0]!;
  }
  const parts = params.parts;
  // Empty partitions still own run/view leases; populated ones carry reused server leases.
  let activeLeases = 0;
  let disposal: Promise<void> | undefined;
  let cleanupFailure: PromiseRejectedResult | undefined;
  let lastUsedAt = Math.max(Date.now(), ...parts.map((part) => part.lastUsedAt));
  let cachedCatalog: McpToolCatalog | null = null;
  let mergedSourceCatalogs: ReadonlyArray<McpToolCatalog> | null = null;
  let catalogInFlight: Promise<McpToolCatalog> | undefined;
  const serverOwner = params.serverOwners ?? new Map<string, SessionMcpRuntime>();
  const requesterConnect = parts.find((part) => part.requesterConnect)?.requesterConnect;

  const rememberServerOwners = (catalog: McpToolCatalog, owner: SessionMcpRuntime) => {
    for (const serverName of Object.keys(catalog.servers)) {
      serverOwner.set(serverName, owner);
    }
  };

  // Parts invalidate their own catalogs on tools/list_changed by replacing or
  // clearing the cached object. Identity-compare against what was merged so the
  // facade re-merges instead of serving a stale combined catalog.
  const cachedCatalogIsCurrent = (): boolean =>
    cachedCatalog !== null &&
    mergedSourceCatalogs !== null &&
    parts.every(
      (part, index) =>
        (part.retiredCatalog ?? part.peekCatalog()) === mergedSourceCatalogs?.[index],
    );

  const loadCatalog = async (): Promise<McpToolCatalog> => {
    if (cachedCatalog && !cachedCatalog.diagnostics?.length && cachedCatalogIsCurrent()) {
      return cachedCatalog;
    }
    if (catalogInFlight) {
      return catalogInFlight;
    }
    const inFlight = (async () => {
      let loaded: Array<{ catalog: McpToolCatalog; cached: boolean } | undefined> = [];
      // Replay once when a completed catalog invalidates while siblings await I/O.
      // A child returning an uncached result already exhausted its own replay budget.
      for (let attempt = 0; attempt < 2; attempt++) {
        const { results, firstError, hasError } = await runTasksWithConcurrency({
          tasks: parts.map((part, index) => async () => {
            const previous = loaded[index];
            if (previous && (!previous.cached || part.retiredCatalog || part.peekCatalog())) {
              return previous;
            }
            const catalog = await loadCurrentCatalog(part);
            return { catalog, cached: part.peekCatalog() !== null };
          }),
          limit: 6,
          errorMode: "continue",
        });
        if (hasError) {
          throw firstError;
        }
        loaded = results;
      }
      // An owner can retire after its discovery finishes while a sibling still awaits I/O.
      const catalogs = parts.map(
        (part, index) => part.retiredCatalog ?? part.peekCatalog() ?? loaded[index]!.catalog,
      );
      if (
        cachedCatalog &&
        mergedSourceCatalogs?.every((source, index) => source === catalogs[index])
      ) {
        return cachedCatalog;
      }
      if (!params.serverOwners) {
        serverOwner.clear();
        for (let index = 0; index < parts.length; index += 1) {
          rememberServerOwners(catalogs[index]!, parts[index]!);
        }
      }
      mergedSourceCatalogs = catalogs;
      cachedCatalog = mergeMcpToolCatalogs(catalogs);
      return cachedCatalog;
    })();
    catalogInFlight = inFlight;
    try {
      return await inFlight;
    } finally {
      if (catalogInFlight === inFlight) {
        catalogInFlight = undefined;
      }
    }
  };

  // Fresh combined facades have an empty owner map until the catalog is loaded.
  // Share one in-flight getCatalog so concurrent tool/resource calls do not fan out.
  const ownerForServer = async (serverName: string): Promise<SessionMcpRuntime> => {
    const signal = getSessionMcpRequestSignal();
    signal?.throwIfAborted();
    if (serverOwner.size === 0) {
      await racePromiseWithAbortSignal(loadCatalog(), signal);
    }
    const owner = serverOwner.get(serverName);
    if (owner) {
      return owner;
    }
    throw new Error(`bundle-mcp server "${serverName}" is not connected`);
  };

  return {
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    workspaceDir: params.workspaceDir,
    agentDir: params.agentDir,
    configFingerprint: parts.map((part) => part.configFingerprint).join(":"),
    ...(requesterConnect ? { requesterConnect } : {}),
    isRequesterScopedServer(serverName) {
      // Owner map is populated by the catalog load that exposed the tool.
      return serverOwner.get(serverName)?.requesterScope !== undefined;
    },
    mcpAppsEnabled: parts.some((part) => part.mcpAppsEnabled === true),
    createdAt: Math.min(Date.now(), ...parts.map((part) => part.createdAt)),
    get lastUsedAt() {
      return lastUsedAt;
    },
    get activeLeases() {
      return Math.max(
        activeLeases,
        parts.reduce((sum, part) => sum + (part.activeLeases ?? 0), 0),
      );
    },
    acquireLease() {
      activeLeases += 1;
      const releases = parts.map((part) => part.acquireLease?.());
      let released = false;
      return () => {
        if (released) {
          return;
        }
        released = true;
        activeLeases -= 1;
        for (const release of releases) {
          release?.();
        }
      };
    },
    getCatalog: loadCatalog,
    peekCatalog() {
      if (cachedCatalog && cachedCatalogIsCurrent()) {
        return cachedCatalog;
      }
      const peeked = parts.map((part) => part.retiredCatalog ?? part.peekCatalog());
      if (peeked.some((catalog) => catalog === null)) {
        return null;
      }
      return mergeMcpToolCatalogs(peeked as McpToolCatalog[]);
    },
    getServerRequestTimeoutMs(serverName) {
      return serverOwner.get(serverName)?.getServerRequestTimeoutMs?.(serverName);
    },
    markUsed() {
      lastUsedAt = Date.now();
      for (const part of parts) {
        part.markUsed();
      }
    },
    async callTool(serverName, toolName, input) {
      return await (await ownerForServer(serverName)).callTool(serverName, toolName, input);
    },
    async listTools(serverName, requestParams) {
      const owner = await ownerForServer(serverName);
      if (!owner.listTools) {
        throw new Error(`bundle-mcp server "${serverName}" does not support listTools`);
      }
      return await owner.listTools(serverName, requestParams);
    },
    async listResources(serverName, options) {
      const owner = await ownerForServer(serverName);
      if (!owner.listResources) {
        throw new Error(`bundle-mcp server "${serverName}" does not support listResources`);
      }
      return await owner.listResources(serverName, options);
    },
    async readResource(serverName, uri, options) {
      const owner = await ownerForServer(serverName);
      if (!owner.readResource) {
        throw new Error(`bundle-mcp server "${serverName}" does not support readResource`);
      }
      return await owner.readResource(serverName, uri, options);
    },
    async listResourceTemplates(serverName, requestParams) {
      const owner = await ownerForServer(serverName);
      if (!owner.listResourceTemplates) {
        throw new Error(`bundle-mcp server "${serverName}" does not support listResourceTemplates`);
      }
      return await owner.listResourceTemplates(serverName, requestParams);
    },
    async listPrompts(serverName) {
      const owner = await ownerForServer(serverName);
      if (!owner.listPrompts) {
        throw new Error(`bundle-mcp server "${serverName}" does not support listPrompts`);
      }
      return await owner.listPrompts(serverName);
    },
    async getPrompt(serverName, name, args) {
      const owner = await ownerForServer(serverName);
      if (!owner.getPrompt) {
        throw new Error(`bundle-mcp server "${serverName}" does not support getPrompt`);
      }
      return await owner.getPrompt(serverName, name, args);
    },
    async joinCleanup() {
      await disposal;
      const outcomes = await Promise.allSettled(
        parts.map(async (part) => {
          if (!part.joinCleanup) {
            throw new Error("MCP runtime does not expose cleanup ownership");
          }
          await part.joinCleanup();
        }),
      );
      cleanupFailure ??= outcomes.find((outcome) => outcome.status === "rejected");
      if (cleanupFailure) {
        recordAgentCleanupFailure();
        throw cleanupFailure.reason;
      }
    },
    async dispose() {
      // SDK parts may throw without retaining their own failure. The facade owns
      // that result across callers while Gateway disposal stays best effort.
      disposal ??= Promise.allSettled(parts.map(async (part) => await part.dispose())).then(
        (outcomes) => {
          cleanupFailure ??= outcomes.find((outcome) => outcome.status === "rejected");
        },
      );
      await disposal;
      if (cleanupFailure) {
        recordAgentCleanupFailure();
      }
    },
  };
}
