import {
  prepareHarnessNativeMcpAppPreview,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
  type McpToolCatalog,
  type SessionMcpRuntime,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  asOptionalRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { getCodexAppServerClientInstanceId, type CodexAppServerClient } from "./client.js";
import type { ResourceReadResult } from "./protocol-mcp.js";
import type { CodexMcpServerStatus, CodexThreadItem, JsonObject, JsonValue } from "./protocol.js";
import { retainSharedCodexAppServerClientIfCurrent } from "./shared-client.js";

type NativeMcpCallToolResult = {
  content: JsonValue[];
  structuredContent?: JsonValue;
  isError?: boolean;
  _meta?: JsonValue;
};

function readMcpAppResourceUri(item: CodexThreadItem): string | undefined {
  const appContext = asOptionalRecord(item.appContext);
  const uri =
    normalizeOptionalString(appContext?.resourceUri) ??
    normalizeOptionalString(item.mcpAppResourceUri);
  return uri?.startsWith("ui://") ? uri : undefined;
}

function readMcpAppConnectorId(item: CodexThreadItem): string | undefined {
  return normalizeOptionalString(asOptionalRecord(item.appContext)?.connectorId);
}

function readMcpToolResult(item: CodexThreadItem): NativeMcpCallToolResult | undefined {
  const result = asOptionalRecord(item.result);
  if (!result || !Array.isArray(result.content)) {
    return undefined;
  }
  const resultMeta = asOptionalRecord(result["_meta"]);
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
    Object.assign({}, asOptionalRecord(value) ?? {}, { name }),
  );
}

function createNativeMcpRuntime(params: {
  client: CodexAppServerClient;
  threadId: string;
  attempt: EmbeddedRunAttemptParams;
  originCallId: string;
  connectorId?: string;
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
          inputSchema: (asOptionalRecord(tool.inputSchema) ?? { type: "object" }) as never,
          fallbackDescription: normalizeOptionalString(tool.description) ?? String(tool.name),
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
        arguments: (asOptionalRecord(input) ?? {}) as JsonObject,
      })) as never,
    listTools: async (serverName) => {
      const status = (await loadStatuses()).find((entry) => entry.name === serverName);
      return { tools: status ? statusTools(status) : [] } as never;
    },
    readResource: async (serverName, uri) => {
      // Codex scopes and echoes originCallId only for its shared codex_apps server.
      // Ordinary MCP servers intentionally return no origin correlation.
      const isCodexAppsServer = serverName === "codex_apps";
      const response = params.client.request("mcpServer/resource/read", {
        threadId: params.threadId,
        ...(isCodexAppsServer ? { originCallId: params.originCallId } : {}),
        server: serverName,
        uri,
        ...(params.connectorId ? { connectorId: params.connectorId } : {}),
      });
      return isCodexAppsServer
        ? await readCorrelatedMcpResource(params.originCallId, response)
        : await response;
    },
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

async function readCorrelatedMcpResource(
  originCallId: string,
  responsePromise: Promise<ResourceReadResult>,
): Promise<ResourceReadResult> {
  const response = await responsePromise;
  if (response.originCallId !== originCallId) {
    throw new Error(
      `Codex MCP resource response originCallId mismatch: expected ${originCallId}, received ${response.originCallId}`,
    );
  }
  return response;
}

export function createCodexNativeMcpAppResultDetailsPreparer(params: {
  client: CodexAppServerClient;
  threadId: string;
  attempt: EmbeddedRunAttemptParams;
}): ((item: CodexThreadItem) => Promise<unknown>) | undefined {
  if (params.attempt.config?.mcp?.apps?.enabled !== true) {
    return undefined;
  }
  return async (item) => {
    const serverName = normalizeOptionalString(item.server);
    const toolName = normalizeOptionalString(item.tool);
    const uiResourceUri = readMcpAppResourceUri(item);
    const connectorId = readMcpAppConnectorId(item);
    const toolResult = readMcpToolResult(item);
    if (!serverName || !toolName || !uiResourceUri || !toolResult) {
      return undefined;
    }
    const runtime = createNativeMcpRuntime({
      ...params,
      originCallId: item.id,
      ...(connectorId ? { connectorId } : {}),
    });
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
