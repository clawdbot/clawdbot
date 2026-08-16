/** Process-lifetime MCP clients owned by the headless node host. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ErrorCode, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { redactSensitiveUrlLikeString } from "@openclaw/net-policy/redact-sensitive-url";
import { clampPositiveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { NodePluginToolDescriptor } from "../../packages/gateway-protocol/src/schema/nodes.js";
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

type NodeHostMcpClient = {
  onclose?: () => void;
  connect(transport: Transport): Promise<void>;
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
  connectionTimeoutMs: number;
  requestTimeoutMs: number;
  detachStderr?: () => void;
};

type NodeHostMcpSession = {
  client: NodeHostMcpClient;
  connected: boolean;
  toolCallTimeoutMs: number;
  detachStderr?: () => void;
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
  createClient?: (serverName: string) => NodeHostMcpClient;
  resolveTransport?: (serverName: string, config: McpServerConfig) => NodeHostMcpTransport | null;
  onDescriptorsChanged?: () => void;
  warn?: (message: string) => void;
  signal?: AbortSignal;
};

type ListedNodeMcpTool = {
  serverName: string;
  tool: Tool;
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
  listedTools: readonly ListedNodeMcpTool[],
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

async function connectWithTimeout(
  client: NodeHostMcpClient,
  transport: Transport,
  timeoutMs: number,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      client.connect(transport),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`MCP server connection timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function withAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) {
    return await promise;
  }
  if (signal.aborted) {
    throw new Error("MCP startup aborted");
  }
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("MCP startup aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
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

/** Starts configured MCP servers once for the lifetime of the node host. */
export async function startNodeHostMcpManager(
  servers: Record<string, McpServerConfig> | undefined,
  deps: NodeHostMcpManagerDeps = {},
): Promise<NodeHostMcpManager> {
  const warn = deps.warn ?? defaultWarn;
  const createClient =
    deps.createClient ??
    (() =>
      new Client(
        { name: "openclaw-node-host", version: VERSION },
        { jsonSchemaValidator: createMcpJsonSchemaValidator() },
      ) as NodeHostMcpClient);
  const resolveTransport = deps.resolveTransport ?? resolveMcpTransport;
  const sessions = new Map<string, NodeHostMcpSession>();
  const listedTools: ListedNodeMcpTool[] = [];
  const descriptors: NodePluginToolDescriptor[] = [];

  await Promise.all(
    listEnabledNodeHostMcpServers(servers).map(async ([serverName, config]) => {
      if (config.auth === "oauth" || config.oauth) {
        warn(`node host MCP server "${serverName}" skipped: OAuth is not supported`);
        return;
      }
      let client: NodeHostMcpClient | undefined;
      let resolved: NodeHostMcpTransport | null | undefined;
      let session: NodeHostMcpSession | undefined;
      try {
        resolved = resolveTransport(serverName, config);
        if (!resolved) {
          warn(`node host MCP server "${serverName}" skipped: invalid or unsupported transport`);
          return;
        }
        client = createClient(serverName);
        session = {
          client,
          connected: false,
          toolCallTimeoutMs: resolveMcpRequestTimeoutMs(config, NODE_MCP_TOOL_CALL_TIMEOUT_MS),
          detachStderr: resolved.detachStderr,
        };
        // MCP Client exposes callback properties rather than an EventTarget surface.
        // oxlint-disable-next-line unicorn/prefer-add-event-listener
        client.onclose = () => {
          if (!session?.connected) {
            return;
          }
          session.connected = false;
          descriptors.splice(
            0,
            descriptors.length,
            ...descriptors.filter((descriptor) => descriptor.mcp?.server !== serverName),
          );
          deps.onDescriptorsChanged?.();
        };
        await withAbort(
          connectWithTimeout(client, resolved.transport, resolved.connectionTimeoutMs),
          deps.signal,
        );
        session.connected = true;
        const tools = await listAllTools(
          client,
          resolved.requestTimeoutMs,
          (toolName) => isMcpToolAllowed(config.toolFilter, toolName),
          deps.signal,
        );
        if (session.connected) {
          sessions.set(serverName, session);
          listedTools.push(...tools.map((tool) => ({ serverName, tool })));
        }
      } catch (error) {
        if (session) {
          session.connected = false;
        }
        resolved?.detachStderr?.();
        if (client) {
          await Promise.allSettled([client.close()]);
        }
        if (!deps.signal?.aborted) {
          warn(`node host MCP server "${serverName}" failed: ${formatMcpError(error)}`);
        }
      }
    }),
  );

  const publishableTools = listedTools.filter(
    ({ serverName }) => sessions.get(serverName)?.connected,
  );
  descriptors.push(...buildNodeMcpToolDescriptors(publishableTools));
  if (descriptors.length < publishableTools.length) {
    warn(
      `node host MCP catalog bounded: published ${descriptors.length} of ${publishableTools.length} tools`,
    );
  }
  let closed = false;
  return {
    descriptors,
    async callMcpTool(params) {
      const session = sessions.get(params.server);
      if (!session?.connected) {
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
        if (!session.connected) {
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
      for (const session of sessions.values()) {
        session.connected = false;
        session.detachStderr?.();
      }
      await Promise.allSettled(Array.from(sessions.values(), (session) => session.client.close()));
      sessions.clear();
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
