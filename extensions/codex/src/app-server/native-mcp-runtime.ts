import type {
  EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
  McpToolCatalog,
  SessionMcpRuntime,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  asOptionalRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  getCodexAppServerClientInstanceId,
  isCodexAppServerIndeterminateRequestCancellationError,
  isCodexAppServerIndeterminateTransportError,
  type CodexAppServerClient,
} from "./client.js";
import type { CodexMcpServerStatus, JsonObject, JsonValue } from "./protocol.js";
import {
  fenceSharedCodexAppServerClientToolCalls,
  isSharedCodexAppServerClientToolCallFenced,
  retainLiveSharedCodexAppServerClient,
  retireSharedCodexAppServerClientIfCurrent,
} from "./shared-client.js";

function statusTools(status: CodexMcpServerStatus): Array<Record<string, unknown>> {
  return Object.entries(status.tools).map(([name, value]) =>
    Object.assign({}, asOptionalRecord(value) ?? {}, { name }),
  );
}

export function createCodexNativeMcpRuntime(params: {
  client: CodexAppServerClient;
  threadId: string;
  attempt: EmbeddedRunAttemptParams;
}): SessionMcpRuntime {
  // App interactions must stay on the thread-owned Codex MCP connection; opening
  // a second client here would lose server-local state between render and click.
  let catalog: McpToolCatalog | null = null;
  let statuses: CodexMcpServerStatus[] | undefined;
  const createdAt = Date.now();
  const request = <T = JsonValue | undefined>(
    method: string,
    requestParams: unknown,
    signal?: AbortSignal,
  ): Promise<T> =>
    signal
      ? params.client.request<T>(method, requestParams, { signal })
      : params.client.request<T>(method, requestParams);
  const loadStatuses = async (signal?: AbortSignal) => {
    signal?.throwIfAborted();
    if (statuses) {
      return statuses;
    }
    const response = await request<{ data: CodexMcpServerStatus[] }>(
      "mcpServerStatus/list",
      {
        threadId: params.threadId,
        detail: "full",
      },
      signal,
    );
    statuses = response.data;
    return statuses;
  };
  const getCatalog: SessionMcpRuntime["getCatalog"] = async (options) => {
    options?.signal?.throwIfAborted();
    if (catalog) {
      return catalog;
    }
    const loaded = await loadStatuses(options?.signal);
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
    acquireLease: () => retainLiveSharedCodexAppServerClient(params.client) ?? (() => {}),
    getCatalog,
    peekCatalog: () => catalog,
    markUsed: () => {
      runtime.lastUsedAt = Date.now();
    },
    callTool: async (serverName, toolName, input, options) => {
      if (isSharedCodexAppServerClientToolCallFenced(params.client)) {
        throw new Error(
          "Codex native MCP tool calls are unavailable after an indeterminate cancellation",
        );
      }
      try {
        return (await request(
          "mcpServer/tool/call",
          {
            threadId: params.threadId,
            server: serverName,
            tool: toolName,
            arguments: (asOptionalRecord(input) ?? {}) as JsonObject,
          },
          options?.signal,
        )) as never;
      } catch (error) {
        if (
          isCodexAppServerIndeterminateRequestCancellationError(error) ||
          isCodexAppServerIndeterminateTransportError(error)
        ) {
          fenceSharedCodexAppServerClientToolCalls(params.client);
          retireSharedCodexAppServerClientIfCurrent(params.client);
        }
        throw error;
      }
    },
    listTools: async (serverName, _requestParams, options) => {
      const status = (await loadStatuses(options?.signal)).find(
        (entry) => entry.name === serverName,
      );
      return { tools: status ? statusTools(status) : [] } as never;
    },
    readResource: async (serverName, uri, options) =>
      await request(
        "mcpServer/resource/read",
        {
          threadId: params.threadId,
          server: serverName,
          uri,
        },
        options?.signal,
      ),
    listResources: async (serverName, options) => {
      const status = (await loadStatuses(options?.signal)).find(
        (entry) => entry.name === serverName,
      );
      return { resources: status?.resources ?? [] };
    },
    listResourceTemplates: async (serverName, _requestParams, options) => {
      const status = (await loadStatuses(options?.signal)).find(
        (entry) => entry.name === serverName,
      );
      return { resourceTemplates: status?.resourceTemplates ?? [] } as never;
    },
    dispose: async () => {},
  };
  return runtime;
}
