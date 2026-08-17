import type {
  EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
  McpToolCatalog,
  SessionMcpRuntime,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  asOptionalRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { Type } from "typebox";
import {
  getCodexAppServerClientInstanceId,
  isCodexAppServerIndeterminateRequestCancellationError,
  isCodexAppServerIndeterminateTransportError,
  type CodexAppServerClient,
} from "./client.js";
import type { CodexMcpServerStatus, JsonValue } from "./protocol.js";
import {
  fenceSharedCodexAppServerClientToolCalls,
  isSharedCodexAppServerClientToolCallFenced,
  retainLiveSharedCodexAppServerClient,
  retireSharedCodexAppServerClientIfCurrent,
} from "./shared-client.js";

type NativeCallToolResult = Awaited<ReturnType<SessionMcpRuntime["callTool"]>>;
type NativeListedTool = Awaited<
  ReturnType<NonNullable<SessionMcpRuntime["listTools"]>>
>["tools"][number];
type NativeResourceTemplate = Awaited<
  ReturnType<NonNullable<SessionMcpRuntime["listResourceTemplates"]>>
>["resourceTemplates"][number];

function isNativeListedTool(value: unknown): value is NativeListedTool {
  const tool = asOptionalRecord(value);
  return Boolean(normalizeOptionalString(tool?.name) && asOptionalRecord(tool?.inputSchema));
}

function statusTools(status: CodexMcpServerStatus): NativeListedTool[] {
  return Object.entries(status.tools)
    .map(([name, value]) => {
      const tool = asOptionalRecord(value) ?? {};
      return {
        ...tool,
        name,
        inputSchema: asOptionalRecord(tool.inputSchema) ?? { type: "object" },
      };
    })
    .filter(isNativeListedTool);
}

function isNativeMcpContentBlock(value: unknown): boolean {
  const block = asOptionalRecord(value);
  switch (block?.type) {
    case "text":
      return typeof block.text === "string";
    case "image":
    case "audio":
      return typeof block.data === "string" && typeof block.mimeType === "string";
    case "resource_link":
      return typeof block.name === "string" && typeof block.uri === "string";
    case "resource": {
      const resource = asOptionalRecord(block.resource);
      return (
        typeof resource?.uri === "string" &&
        (typeof resource.text === "string" || typeof resource.blob === "string")
      );
    }
    default:
      return false;
  }
}

function isNativeCallToolResult(value: unknown): value is NativeCallToolResult {
  const result = asOptionalRecord(value);
  return Boolean(
    result &&
    Array.isArray(result.content) &&
    result.content.every(isNativeMcpContentBlock) &&
    (result.structuredContent === undefined || asOptionalRecord(result.structuredContent)) &&
    (result.isError === undefined || typeof result.isError === "boolean") &&
    (result["_meta"] === undefined || asOptionalRecord(result["_meta"])),
  );
}

function normalizeNativeCallToolResult(value: unknown): NativeCallToolResult | undefined {
  if (isNativeCallToolResult(value)) {
    return value;
  }
  const result = asOptionalRecord(value);
  // Codex serializes absent MCP metadata as null; the MCP SDK permits only an
  // object when `_meta` is present, so normalize the dependency boundary here.
  if (result?.["_meta"] !== null) {
    return undefined;
  }
  const normalized = { ...result };
  delete normalized["_meta"];
  return isNativeCallToolResult(normalized) ? normalized : undefined;
}

function isNativeResourceTemplate(value: unknown): value is NativeResourceTemplate {
  const template = asOptionalRecord(value);
  return Boolean(
    normalizeOptionalString(template?.name) && normalizeOptionalString(template?.uriTemplate),
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
          toolName: tool.name,
          inputSchema: Type.Unsafe(tool.inputSchema),
          fallbackDescription: normalizeOptionalString(tool.description) ?? tool.name,
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
      const requestArguments = asOptionalRecord(input) ?? {};
      try {
        const result = await request(
          "mcpServer/tool/call",
          {
            threadId: params.threadId,
            server: serverName,
            tool: toolName,
            arguments: requestArguments,
          },
          options?.signal,
        );
        const normalizedResult = normalizeNativeCallToolResult(result);
        if (!normalizedResult) {
          throw new Error("Codex native MCP tool call returned an invalid result");
        }
        return normalizedResult;
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
      return { tools: status ? statusTools(status) : [] };
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
      return {
        resourceTemplates: (status?.resourceTemplates ?? []).filter(isNativeResourceTemplate),
      };
    },
    dispose: async () => {},
  };
  return runtime;
}
