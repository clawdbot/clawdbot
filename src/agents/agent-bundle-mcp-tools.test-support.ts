/** Synthetic session MCP runtime shared by catalog materialization cases. */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type {
  McpCatalogTool,
  McpToolCatalog,
  McpToolCatalogDiagnostic,
  SessionMcpRuntime,
} from "./agent-bundle-mcp-types.js";

export function makeToolRuntime(
  params: {
    tools?: McpCatalogTool[];
    serverName?: string;
    result?: CallToolResult;
    resultText?: string;
    diagnostics?: readonly McpToolCatalogDiagnostic[];
    supportsParallelToolCalls?: boolean;
  } = {},
): SessionMcpRuntime {
  const serverName = params.serverName ?? "bundleProbe";
  const tools = params.tools ?? [
    {
      serverName,
      safeServerName: serverName,
      toolName: "bundle_probe",
      description: "Bundle probe",
      inputSchema: { type: "object", properties: {} },
      fallbackDescription: "Bundle probe",
    },
  ];
  const peekCatalog = (): McpToolCatalog => ({
    version: 1,
    generatedAt: 0,
    servers: {
      [serverName]: {
        serverName,
        launchSummary: serverName,
        toolCount: tools.length,
        supportsParallelToolCalls: params.supportsParallelToolCalls ?? false,
      },
    },
    tools,
    ...(params.diagnostics ? { diagnostics: params.diagnostics } : {}),
  });
  return {
    sessionId: "session-collision",
    workspaceDir: "/tmp",
    configFingerprint: "fingerprint",
    createdAt: 0,
    lastUsedAt: 0,
    markUsed: () => {},
    getCatalog: async () => peekCatalog(),
    peekCatalog,
    callTool: async () =>
      params.result ?? {
        content: [{ type: "text", text: params.resultText ?? "FROM-BUNDLE" }],
        isError: false,
      },
    joinCleanup: async () => {},
    dispose: async () => {},
  };
}
