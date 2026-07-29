import {
  prepareHarnessNativeMcpAppPreview,
  type EmbeddedRunAttemptParams,
  type McpToolCatalog,
  type SessionMcpRuntime,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { getCodexAppServerClientInstanceId, type CodexAppServerClient } from "./client.js";
import type { CodexMcpServerStatus, CodexThreadItem, JsonObject, JsonValue } from "./protocol.js";
import { retainSharedCodexAppServerClientIfCurrent } from "./shared-client.js";

type NativeMcpCallToolResult = {
  content: JsonValue[];
  structuredContent?: JsonValue;
  isError?: boolean;
  _meta?: JsonValue;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readMcpAppResourceUri(item: CodexThreadItem): string | undefined {
  const appContext = asRecord(item.appContext);
  const uri = readString(appContext?.resourceUri) ?? readString(item.mcpAppResourceUri);
  return uri?.startsWith("ui://") ? uri : undefined;
}

function readMcpToolResult(item: CodexThreadItem): NativeMcpCallToolResult | undefined {
  const result = asRecord(item.result);
  if (!result || !Array.isArray(result.content)) {
    return undefined;
  }
  const resultMeta = asRecord(result["_meta"]);
  return {
    content: result.content as JsonValue[],
    ...(result.structuredContent !== undefined
      ? { structuredContent: result.structuredContent as JsonValue }
      : {}),
    ...(result.isError === true ? { isError: true } : {}),
    // Codex serializes absent MCP result metadata as null. The MCP SDK accepts
    // only an object when `_meta` is present, so forwarding null makes Apps
    // discard the complete tool-result notification during schema validation.
    ...(resultMeta ? { _meta: resultMeta as JsonValue } : {}),
  };
}

function statusTools(status: CodexMcpServerStatus): Array<Record<string, unknown>> {
  return Object.entries(status.tools).map(([name, value]) =>
    Object.assign({}, asRecord(value), { name }),
  );
}

function createNativeMcpRuntime(params: {
  client: CodexAppServerClient;
  threadId: string;
  attempt: EmbeddedRunAttemptParams;
}): SessionMcpRuntime {
  // App interactions must stay on the thread-owned Codex MCP connection; opening
  // a second client here would lose server-local state between render and click.
  let catalog: McpToolCatalog | null = null;
  let statuses: CodexMcpServerStatus[] | undefined;
  const createdAt = Date.now();
  const loadStatuses = async () => {
    if (statuses) {
      return statuses;
    }
    const response = await params.client.request("mcpServerStatus/list", {
      threadId: params.threadId,
      detail: "full",
    });
    statuses = response.data;
    return statuses;
  };
  const getCatalog = async (): Promise<McpToolCatalog> => {
    if (catalog) {
      return catalog;
    }
    const loaded = await loadStatuses();
    catalog = {
      version: 1,
      generatedAt: Date.now(),
      servers: Object.fromEntries(
        loaded.map((status) => [
          status.name,
          {
            serverName: status.name,
            launchSummary: "Codex native MCP connection",
            toolCount: Object.keys(status.tools).length,
          },
        ]),
      ),
      tools: loaded.flatMap((status) =>
        statusTools(status).map((tool) => ({
          serverName: status.name,
          safeServerName: status.name,
          toolName: String(tool.name),
          inputSchema: (asRecord(tool.inputSchema) ?? { type: "object" }) as never,
          fallbackDescription: readString(tool.description) ?? String(tool.name),
        })),
      ),
    };
    return catalog;
  };
  const runtime: SessionMcpRuntime = {
    sessionId: params.attempt.sessionId,
    sessionKey: params.attempt.sessionKey,
    workspaceDir: params.attempt.workspaceDir,
    configFingerprint: `${getCodexAppServerClientInstanceId(params.client)}:${params.threadId}`,
    mcpAppsEnabled: true,
    createdAt,
    lastUsedAt: createdAt,
    // Each live view outlives the turn, so retain the shared app-server client
    // until the view store releases its lease.
    acquireLease: () => retainSharedCodexAppServerClientIfCurrent(params.client) ?? (() => {}),
    getCatalog,
    peekCatalog: () => catalog,
    markUsed: () => {
      runtime.lastUsedAt = Date.now();
    },
    callTool: async (serverName, toolName, input) =>
      (await params.client.request("mcpServer/tool/call", {
        threadId: params.threadId,
        server: serverName,
        tool: toolName,
        arguments: (asRecord(input) ?? {}) as JsonObject,
      })) as never,
    listTools: async (serverName) => {
      const status = (await loadStatuses()).find((entry) => entry.name === serverName);
      return { tools: status ? statusTools(status) : [] } as never;
    },
    readResource: async (serverName, uri) =>
      await params.client.request("mcpServer/resource/read", {
        threadId: params.threadId,
        server: serverName,
        uri,
      }),
    listResources: async (serverName) => {
      const status = (await loadStatuses()).find((entry) => entry.name === serverName);
      return { resources: status?.resources ?? [] };
    },
    listResourceTemplates: async (serverName) => {
      const status = (await loadStatuses()).find((entry) => entry.name === serverName);
      return { resourceTemplates: status?.resourceTemplates ?? [] } as never;
    },
    dispose: async () => {},
  };
  return runtime;
}

export function createCodexNativeMcpAppResultDetailsPreparer(params: {
  client: CodexAppServerClient;
  threadId: string;
  attempt: EmbeddedRunAttemptParams;
}): ((item: CodexThreadItem) => Promise<unknown>) | undefined {
  if (params.attempt.config?.mcp?.apps?.enabled !== true) {
    return undefined;
  }
  const runtime = createNativeMcpRuntime(params);
  return async (item) => {
    const serverName = readString(item.server);
    const toolName = readString(item.tool);
    const uiResourceUri = readMcpAppResourceUri(item);
    const toolResult = readMcpToolResult(item);
    if (!serverName || !toolName || !uiResourceUri || !toolResult) {
      return undefined;
    }
    const allowedAppToolNames = new Set(
      (await runtime.getCatalog()).tools
        .filter((tool) => tool.serverName === serverName)
        .map((tool) => tool.toolName),
    );
    if (allowedAppToolNames.size === 0) {
      return undefined;
    }
    return await prepareHarnessNativeMcpAppPreview({
      runtime,
      serverName,
      toolName,
      uiResourceUri,
      toolCallId: item.id,
      toolInput: item.arguments ?? {},
      toolResult: toolResult as never,
      allowedAppToolNames,
      ...(toolResult["_meta"] !== undefined ? { resultMetaState: "unavailable" as const } : {}),
    });
  };
}
