/** Process-lifetime MCP clients owned by the headless node host. */
import { isDeepStrictEqual } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ErrorCode, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { redactSensitiveUrlLikeString } from "@openclaw/net-policy/redact-sensitive-url";
import { clampPositiveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { NodePluginToolDescriptor } from "../../packages/gateway-protocol/src/schema/nodes.js";
import {
  connectMcpClient,
  disposeMcpClient,
  isStatefulMcpHttpSessionExpired,
} from "../agents/mcp-client-lifecycle.js";
import { createMcpJsonSchemaValidator } from "../agents/mcp-json-schema-validator.js";
import { sanitizeMcpMetadataText } from "../agents/mcp-metadata.js";
import { collectMcpPaginatedItems } from "../agents/mcp-pagination.js";
import { isMcpToolAllowed } from "../agents/mcp-tool-filter.js";
import { resolveMcpRequestTimeoutMs } from "../agents/mcp-transport-config.js";
import { resolveMcpTransport } from "../agents/mcp-transport.js";
import { normalizeConfiguredMcpServers } from "../config/mcp-config-normalize.js";
import type { McpServerConfig } from "../config/types.mcp.js";
import { toErrorObject } from "../infra/errors.js";
import {
  NODE_MCP_TOOL_CALL_TIMEOUT_MS,
  NODE_MCP_TOOLS_CALL_COMMAND,
} from "../infra/node-commands.js";
import { runTasksWithConcurrency } from "../utils/run-with-concurrency.js";
import { VERSION } from "../version.js";

const NODE_MCP_PLUGIN_ID = "node-mcp";
const NODE_MCP_DESCRIPTION_MAX_CHARS = 1_024;
const NODE_MCP_NAME_MAX_CHARS = 64;
const NODE_MCP_SERVER_FRAGMENT_MAX_CHARS = 31;
const NODE_MCP_ERROR_MAX_CHARS = 1_024;
const NODE_MCP_MAX_DESCRIPTORS = 128;
const NODE_MCP_MAX_DESCRIPTOR_BYTES = 1024 * 1024;
const NODE_MCP_MAX_CATALOG_BYTES = 10 * 1024 * 1024;
const NODE_MCP_MAX_LIST_PAGES = NODE_MCP_MAX_DESCRIPTORS;
// The byte cap charges every response; this separately bounds retained tiny-tool object overhead.
const NODE_MCP_MAX_LISTED_TOOLS = NODE_MCP_MAX_DESCRIPTORS * NODE_MCP_MAX_LIST_PAGES;
const NODE_MCP_CONNECT_CONCURRENCY = 6;
const NODE_MCP_RETRY_INITIAL_MS = 250;
const NODE_MCP_RETRY_MAX_MS = 60_000;

type NodeHostMcpClient = {
  onclose?: () => void;
  connect(
    transport: Transport,
    options: { signal: AbortSignal; timeout: number; maxTotalTimeout: number },
  ): Promise<void>;
  listTools(
    params?: { cursor?: string },
    options?: { timeout?: number; maxTotalTimeout?: number; signal?: AbortSignal },
  ): Promise<{ tools: Tool[]; nextCursor?: string }>;
  callTool(
    params: { name: string; arguments?: Record<string, unknown> },
    resultSchema?: undefined,
    options?: { timeout?: number; signal?: AbortSignal },
  ): Promise<CallToolResult>;
  close(): Promise<void>;
};

type NodeHostMcpTransport = {
  transport: Transport;
  transportType: "stdio" | "sse" | "streamable-http";
  connectionTimeoutMs: number;
  requestTimeoutMs: number;
  detachStderr?: () => void;
};

type NodeHostMcpSession = NodeHostMcpTransport & {
  client: NodeHostMcpClient;
  connected: boolean;
  toolCallTimeoutMs: number;
  abortController: AbortController;
};

type NodeHostMcpServerState = {
  serverName: string;
  config: McpServerConfig;
  current?: NodeHostMcpSession;
  listedTools: Tool[];
  work: Promise<void>;
  refreshQueued: boolean;
  retryDelayMs: number;
  retryTimer?: ReturnType<typeof setTimeout>;
};

type NodeHostMcpErrorCode =
  | "MCP_SERVER_UNAVAILABLE"
  | "MCP_TOOL_UNAVAILABLE"
  | "MCP_TOOL_TIMEOUT"
  | "MCP_TOOL_ERROR";

export class NodeHostMcpError extends Error {
  readonly code: NodeHostMcpErrorCode;

  constructor(code: NodeHostMcpErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NodeHostMcpError";
    this.code = code;
  }
}

export type NodeHostMcpManager = {
  descriptors: NodePluginToolDescriptor[];
  callMcpTool(params: {
    server: string;
    tool: string;
    arguments?: Record<string, unknown>;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<CallToolResult>;
  close(): Promise<void>;
};

type NodeHostMcpManagerDeps = {
  createClient?: (serverName: string, options: { onToolsChanged: () => void }) => NodeHostMcpClient;
  resolveTransport?: (serverName: string, config: McpServerConfig) => NodeHostMcpTransport | null;
  onDescriptorsChanged?: () => void;
  warn?: (message: string) => void;
  signal?: AbortSignal;
};

function defaultWarn(message: string): void {
  console.warn(message);
}

function formatMcpError(error: unknown): string {
  return truncateUtf16Safe(
    redactSensitiveUrlLikeString(toErrorObject(error, "MCP request failed").message),
    NODE_MCP_ERROR_MAX_CHARS,
  );
}

function sanitizeDescriptorFragment(raw: string, fallback: string): string {
  const cleaned = raw
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^[_-]+|[_-]+$/g, "");
  const normalized = cleaned || fallback;
  return /^[A-Za-z]/.test(normalized) ? normalized : `${fallback}_${normalized}`;
}

function buildDescriptorBaseName(serverName: string, toolName: string): string {
  const server = sanitizeDescriptorFragment(serverName, "mcp").slice(
    0,
    NODE_MCP_SERVER_FRAGMENT_MAX_CHARS,
  );
  const toolBudget = Math.max(1, NODE_MCP_NAME_MAX_CHARS - server.length - 1);
  const tool = sanitizeDescriptorFragment(toolName, "tool").slice(0, toolBudget);
  return `${server}_${tool}`;
}

function reserveDescriptorName(baseName: string, usedNames: Set<string>): string {
  let index = 1;
  while (true) {
    const suffix = index === 1 ? "" : `_${index}`;
    const candidate = `${baseName.slice(0, NODE_MCP_NAME_MAX_CHARS - suffix.length)}${suffix}`;
    const key = normalizeLowercaseStringOrEmpty(candidate);
    if (!usedNames.has(key)) {
      usedNames.add(key);
      return candidate;
    }
    index += 1;
  }
}

function normalizeInputSchema(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { type: "object", properties: {}, additionalProperties: true };
}

/** Builds provider-safe MCP descriptors in stable server/tool order. */
function buildNodeMcpToolDescriptors(
  listedTools: ReadonlyArray<{ serverName: string; tool: Tool }>,
): NodePluginToolDescriptor[] {
  const usedNames = new Set<string>();
  const descriptors: NodePluginToolDescriptor[] = [];
  let catalogBytes = 0;
  for (const { serverName, tool } of listedTools.toSorted(
    (left, right) =>
      left.serverName.localeCompare(right.serverName) ||
      left.tool.name.localeCompare(right.tool.name),
  )) {
    const toolName = tool.name.trim();
    const descriptor: NodePluginToolDescriptor = {
      pluginId: NODE_MCP_PLUGIN_ID,
      name: reserveDescriptorName(buildDescriptorBaseName(serverName, toolName), usedNames),
      description: truncateUtf16Safe(
        sanitizeMcpMetadataText(tool.description) ||
          sanitizeMcpMetadataText(toolName) ||
          "MCP tool",
        NODE_MCP_DESCRIPTION_MAX_CHARS,
      ),
      parameters: normalizeInputSchema(tool.inputSchema),
      command: NODE_MCP_TOOLS_CALL_COMMAND,
      mcp: { server: serverName, tool: toolName },
    };
    const descriptorBytes = Buffer.byteLength(JSON.stringify(descriptor));
    if (
      descriptorBytes > NODE_MCP_MAX_DESCRIPTOR_BYTES ||
      catalogBytes + descriptorBytes > NODE_MCP_MAX_CATALOG_BYTES
    ) {
      continue;
    }
    descriptors.push(descriptor);
    catalogBytes += descriptorBytes;
    if (descriptors.length >= NODE_MCP_MAX_DESCRIPTORS) {
      break;
    }
  }
  return descriptors;
}

async function listAllTools(
  client: NodeHostMcpClient,
  timeoutMs: number,
  shouldInclude: (toolName: string) => boolean,
  signal?: AbortSignal,
): Promise<Tool[]> {
  return await collectMcpPaginatedItems({
    label: "MCP tool listing",
    itemLabel: "tools",
    timeoutMs,
    maxPages: NODE_MCP_MAX_LIST_PAGES,
    maxItems: NODE_MCP_MAX_LISTED_TOOLS,
    maxBytes: NODE_MCP_MAX_CATALOG_BYTES,
    signal,
    loadPage: async ({ cursor, requestTimeoutMs, signal: requestSignal }) => {
      const page = await client.listTools(cursor === undefined ? undefined : { cursor }, {
        timeout: requestTimeoutMs,
        maxTotalTimeout: requestTimeoutMs,
        signal: requestSignal,
      });
      return { items: page.tools, nextCursor: page.nextCursor, serializedValue: page };
    },
    mapItem: (tool) => {
      const toolName = tool.name.trim();
      if (!toolName || !shouldInclude(toolName)) {
        return undefined;
      }
      return { ...tool, name: toolName };
    },
  });
}

function disposeNodeHostMcpSession(session: NodeHostMcpSession): Promise<void> {
  session.abortController.abort(new Error("node host MCP session retired"));
  return disposeMcpClient(session);
}

/** Starts process-lifetime MCP server state for the node host. */
export async function startNodeHostMcpManager(
  servers: Record<string, McpServerConfig> | undefined,
  deps: NodeHostMcpManagerDeps = {},
): Promise<NodeHostMcpManager> {
  const warn = deps.warn ?? defaultWarn;
  const createClient =
    deps.createClient ??
    ((_serverName, options) =>
      new Client(
        { name: "openclaw-node-host", version: VERSION },
        {
          jsonSchemaValidator: createMcpJsonSchemaValidator(),
          listChanged: {
            tools: {
              autoRefresh: false,
              debounceMs: 0,
              onChanged: () => options.onToolsChanged(),
            },
          },
        },
      ) as NodeHostMcpClient);
  const resolveTransport = deps.resolveTransport ?? resolveMcpTransport;
  const descriptors: NodePluginToolDescriptor[] = [];
  const lifecycleAbortController = new AbortController();
  const lifecycleSignal = deps.signal
    ? AbortSignal.any([deps.signal, lifecycleAbortController.signal])
    : lifecycleAbortController.signal;
  const states = new Map<string, NodeHostMcpServerState>(
    listEnabledNodeHostMcpServers(servers).map(([serverName, config]) => [
      serverName,
      {
        serverName,
        config,
        listedTools: [],
        work: Promise.resolve(),
        refreshQueued: false,
        retryDelayMs: NODE_MCP_RETRY_INITIAL_MS,
      },
    ]),
  );
  let closed = false;
  let startupComplete = false;

  const rebuildDescriptors = () => {
    if (closed) {
      return;
    }
    const listedTools = Array.from(states.values()).flatMap((state) =>
      state.listedTools.map((tool) => ({ serverName: state.serverName, tool })),
    );
    const next = buildNodeMcpToolDescriptors(listedTools);
    if (next.length < listedTools.length) {
      warn(
        `node host MCP catalog bounded: published ${next.length} of ${listedTools.length} tools`,
      );
    }
    if (isDeepStrictEqual(descriptors, next)) {
      return;
    }
    descriptors.splice(0, descriptors.length, ...next);
    if (startupComplete) {
      deps.onDescriptorsChanged?.();
    }
  };

  const invalidateCurrent = (
    state: NodeHostMcpServerState,
    session: NodeHostMcpSession,
  ): boolean => {
    if (state.current !== session) {
      return false;
    }
    state.current = undefined;
    session.abortController.abort(new Error("node host MCP session invalidated"));
    state.listedTools = [];
    rebuildDescriptors();
    return true;
  };

  const enqueueWork = (state: NodeHostMcpServerState, task: () => Promise<void>): void => {
    state.work = state.work.then(task, task).catch(() => {});
  };

  const scheduleRetry = (state: NodeHostMcpServerState): void => {
    if (
      closed ||
      lifecycleSignal.aborted ||
      states.get(state.serverName) !== state ||
      state.retryTimer ||
      state.current
    ) {
      return;
    }
    const delayMs = state.retryDelayMs;
    state.retryDelayMs = Math.min(delayMs * 2, NODE_MCP_RETRY_MAX_MS);
    state.retryTimer = setTimeout(() => {
      state.retryTimer = undefined;
      enqueueWork(state, () => reconnect(state));
    }, delayMs);
    state.retryTimer.unref?.();
  };

  const connectAndList = async (
    state: NodeHostMcpServerState,
    signal: AbortSignal,
  ): Promise<void> => {
    let resolved: NodeHostMcpTransport | null | undefined;
    let session: NodeHostMcpSession | undefined;
    try {
      resolved = resolveTransport(state.serverName, state.config);
      if (!resolved) {
        states.delete(state.serverName);
        throw new Error("invalid or unsupported transport");
      }
      let onToolsChanged = () => {};
      const client = createClient(state.serverName, {
        onToolsChanged: () => onToolsChanged(),
      });
      const createdSession: NodeHostMcpSession = {
        ...resolved,
        client,
        connected: false,
        toolCallTimeoutMs: resolveMcpRequestTimeoutMs(state.config, NODE_MCP_TOOL_CALL_TIMEOUT_MS),
        abortController: new AbortController(),
      };
      onToolsChanged = () => {
        if (state.current === createdSession) {
          requestRefresh(state, createdSession);
        }
      };
      session = createdSession;
      state.current = createdSession;
      // MCP Client exposes callback properties rather than an EventTarget surface.
      // oxlint-disable-next-line unicorn/prefer-add-event-listener
      client.onclose = () => {
        if (createdSession.connected && invalidateCurrent(state, createdSession)) {
          enqueueWork(state, async () => {
            await disposeNodeHostMcpSession(createdSession);
            scheduleRetry(state);
          });
        }
      };
      await connectMcpClient({
        client,
        transport: resolved.transport,
        timeoutMs: resolved.connectionTimeoutMs,
        signal,
      });
      if (closed || signal.aborted || state.current !== session) {
        return;
      }
      session.connected = true;
      const listSignal = AbortSignal.any([signal, session.abortController.signal]);
      const tools = await listAllTools(
        client,
        resolved.requestTimeoutMs,
        (toolName) => isMcpToolAllowed(state.config.toolFilter, toolName),
        listSignal,
      );
      if (closed || state.current !== session) {
        return;
      }
      state.listedTools = tools;
      state.retryDelayMs = NODE_MCP_RETRY_INITIAL_MS;
      rebuildDescriptors();
    } catch (error) {
      const lostOwnership = session !== undefined && state.current !== session;
      if (session && state.current === session) {
        invalidateCurrent(state, session);
        await disposeNodeHostMcpSession(session);
      } else if (!session) {
        resolved?.detachStderr?.();
      }
      if (closed || signal.aborted || lostOwnership) {
        return;
      }
      throw error;
    }
  };

  async function reconnect(state: NodeHostMcpServerState): Promise<void> {
    if (closed || state.current) {
      return;
    }
    try {
      await connectAndList(state, lifecycleSignal);
    } catch (error) {
      if (!closed && !lifecycleSignal.aborted) {
        warn(
          `node host MCP server "${state.serverName}" reconnect failed: ${formatMcpError(error)}`,
        );
        scheduleRetry(state);
      }
    }
  }

  const refresh = async (state: NodeHostMcpServerState, session: NodeHostMcpSession) => {
    if (closed || state.current !== session || !session.connected) {
      return;
    }
    try {
      const tools = await listAllTools(
        session.client,
        session.requestTimeoutMs,
        (toolName) => isMcpToolAllowed(state.config.toolFilter, toolName),
        AbortSignal.any([lifecycleSignal, session.abortController.signal]),
      );
      if (closed || state.current !== session) {
        return;
      }
      state.listedTools = tools;
      rebuildDescriptors();
    } catch (error) {
      if (closed || lifecycleSignal.aborted || state.current !== session) {
        return;
      }
      warn(
        `node host MCP server "${state.serverName}" tool refresh failed: ${formatMcpError(error)}`,
      );
      invalidateCurrent(state, session);
      await disposeNodeHostMcpSession(session);
      scheduleRetry(state);
    }
  };

  function requestRefresh(state: NodeHostMcpServerState, session: NodeHostMcpSession): void {
    if (
      closed ||
      lifecycleSignal.aborted ||
      state.current !== session ||
      !session.connected ||
      state.refreshQueued
    ) {
      return;
    }
    state.refreshQueued = true;
    enqueueWork(state, async () => {
      state.refreshQueued = false;
      await refresh(state, session);
    });
  }

  const tasks = Array.from(states.values(), (state) => async () => {
    if (state.config.auth === "oauth" || state.config.oauth) {
      states.delete(state.serverName);
      warn(`node host MCP server "${state.serverName}" skipped: OAuth is not supported`);
      return;
    }
    try {
      await connectAndList(state, lifecycleSignal);
    } catch (error) {
      if (!lifecycleSignal.aborted) {
        warn(`node host MCP server "${state.serverName}" failed: ${formatMcpError(error)}`);
      }
    }
  });
  await runTasksWithConcurrency({
    tasks,
    limit: NODE_MCP_CONNECT_CONCURRENCY,
    errorMode: "continue",
  });
  startupComplete = true;
  for (const state of states.values()) {
    if (!state.current) {
      scheduleRetry(state);
    }
  }

  return {
    descriptors,
    async callMcpTool(params) {
      const state = states.get(params.server);
      const session = state?.current;
      if (!state || !session?.connected) {
        throw new NodeHostMcpError(
          "MCP_SERVER_UNAVAILABLE",
          `MCP server "${params.server}" is unavailable`,
        );
      }
      const published = descriptors.some(
        (descriptor) =>
          descriptor.mcp?.server === params.server && descriptor.mcp.tool === params.tool,
      );
      if (!published) {
        throw new NodeHostMcpError(
          "MCP_TOOL_UNAVAILABLE",
          `MCP tool "${params.tool}" is unavailable on server "${params.server}"`,
        );
      }
      const requestedTimeoutMs =
        clampPositiveTimerTimeoutMs(params.timeoutMs) ?? NODE_MCP_TOOL_CALL_TIMEOUT_MS;
      try {
        return await session.client.callTool(
          { name: params.tool, arguments: params.arguments ?? {} },
          undefined,
          {
            timeout: Math.min(requestedTimeoutMs, session.toolCallTimeoutMs),
            ...(params.signal ? { signal: params.signal } : {}),
          },
        );
      } catch (error) {
        const sessionExpired = isStatefulMcpHttpSessionExpired(session, error);
        if (sessionExpired && invalidateCurrent(state, session)) {
          enqueueWork(state, async () => {
            await disposeNodeHostMcpSession(session);
            scheduleRetry(state);
          });
        }
        if (!sessionExpired && (!session.connected || state.current !== session)) {
          throw new NodeHostMcpError(
            "MCP_SERVER_UNAVAILABLE",
            `MCP server "${params.server}" disconnected`,
            { cause: error },
          );
        }
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === ErrorCode.RequestTimeout
        ) {
          throw new NodeHostMcpError("MCP_TOOL_TIMEOUT", formatMcpError(error), { cause: error });
        }
        throw new NodeHostMcpError("MCP_TOOL_ERROR", formatMcpError(error), { cause: error });
      }
    },
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      lifecycleAbortController.abort(new Error("node host MCP manager closed"));
      const closing = Array.from(states.values(), async (state) => {
        if (state.retryTimer) {
          clearTimeout(state.retryTimer);
          state.retryTimer = undefined;
        }
        await state.work;
        const session = state.current;
        state.current = undefined;
        state.listedTools = [];
        if (session) {
          await disposeNodeHostMcpSession(session);
        }
      });
      await Promise.allSettled(closing);
    },
  };
}

function listEnabledNodeHostMcpServers(
  servers: Record<string, McpServerConfig> | undefined,
): ReadonlyArray<readonly [string, McpServerConfig]> {
  return Object.entries(normalizeConfiguredMcpServers(servers))
    .filter(
      ([serverName, config]) =>
        serverName.length > 0 && serverName === serverName.trim() && config.enabled !== false,
    )
    .map(([serverName, config]) => [serverName, config as McpServerConfig] as const)
    .toSorted(([left], [right]) => left.localeCompare(right));
}
