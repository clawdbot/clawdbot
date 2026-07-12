/** Shared bundle MCP catalog, runtime, and manager types. */
import type {
  CallToolResult,
  ListResourceTemplatesResult,
  ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { TSchema } from "typebox";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import type { AnyAgentTool } from "./tools/common.js";

/** Materialized MCP tools plus diagnostics and cleanup handle for one run. */
export type BundleMcpToolRuntime = {
  tools: AnyAgentTool[];
  /** All MCP tool-call projections, including App-only tools, for policy evaluation. */
  appTools?: AnyAgentTool[];
  diagnostics?: readonly McpToolCatalogDiagnostic[];
  restrictAppTools?: (tools: readonly AnyAgentTool[]) => void;
  dispose: () => Promise<void>;
};

/** Catalog metadata for one configured MCP server. */
export type McpServerCatalog = {
  serverName: string;
  safeServerName?: string;
  launchSummary: string;
  toolCount: number;
  resources?: {
    listChanged?: boolean;
  };
  prompts?: {
    listChanged?: boolean;
  };
  tools?: {
    listChanged?: boolean;
    filteredCount?: number;
  };
  requestTimeoutMs?: number;
  supportsParallelToolCalls?: boolean;
  toolFilter?: {
    include?: string[];
    exclude?: string[];
  };
};

/** MCP tool entry after server-name sanitization and schema normalization. */
export type McpCatalogTool = {
  serverName: string;
  safeServerName: string;
  toolName: string;
  title?: string;
  description?: string;
  inputSchema: TSchema;
  fallbackDescription: string;
  uiResourceUri?: string;
  uiVisibility?: Array<"app" | "model">;
};

/** Complete tool catalog for a session-scoped MCP runtime. */
export type McpToolCatalog = {
  version: number;
  generatedAt: number;
  servers: Record<string, McpServerCatalog>;
  tools: McpCatalogTool[];
  diagnostics?: readonly McpToolCatalogDiagnostic[];
};

export type McpToolCatalogDiagnostic = {
  serverName: string;
  safeServerName: string;
  launchSummary: string;
  message: string;
};

export type McpRequestOptions = {
  failureBackoff?: "track" | "ignore";
};

/** Live MCP runtime bound to one session/workspace. */
export type SessionMcpRuntime = {
  sessionId: string;
  sessionKey?: string;
  workspaceDir: string;
  agentDir?: string;
  configFingerprint: string;
  mcpAppsEnabled?: boolean;
  createdAt: number;
  lastUsedAt: number;
  activeLeases?: number;
  acquireLease?: () => () => void;
  /** Lists tools if needed and may connect MCP transports. */
  getCatalog: () => Promise<McpToolCatalog>;
  /** Returns the cached catalog only; must not start runtimes, connect transports, or issue tools/list. */
  peekCatalog: () => McpToolCatalog | null;
  markUsed: () => void;
  callTool: (serverName: string, toolName: string, input: unknown) => Promise<CallToolResult>;
  listTools?: (serverName: string, params?: { cursor?: string }) => Promise<ListToolsResult>;
  listResources?: (serverName: string, options?: McpRequestOptions) => Promise<unknown>;
  readResource?: (serverName: string, uri: string, options?: McpRequestOptions) => Promise<unknown>;
  listResourceTemplates?: (
    serverName: string,
    params?: { cursor?: string },
  ) => Promise<ListResourceTemplatesResult>;
  listPrompts?: (serverName: string) => Promise<unknown>;
  getPrompt?: (serverName: string, name: string, args?: Record<string, string>) => Promise<unknown>;
  dispose: () => Promise<void>;
};

/** Manager for session-scoped MCP runtimes and their idle lifecycle. */
export type SessionMcpRuntimeManager = {
  getOrCreate: (params: {
    sessionId: string;
    sessionKey?: string;
    workspaceDir: string;
    agentDir?: string;
    cfg?: OpenClawConfig;
    manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
  }) => Promise<SessionMcpRuntime>;
  bindSessionKey: (sessionKey: string, sessionId: string) => void;
  resolveSessionId: (sessionKey: string) => string | undefined;
  /** Looks up an existing runtime only; must not create runtimes or connect transports. */
  peekSession: (params: {
    sessionId?: string;
    sessionKey?: string;
  }) => SessionMcpRuntime | undefined;
  disposeSession: (sessionId: string) => Promise<void>;
  deferRetirement: (sessionId: string) => boolean;
  completeDeferredRetirement: (sessionId: string, runtime: SessionMcpRuntime) => Promise<boolean>;
  disposeAll: () => Promise<void>;
  sweepIdleRuntimes: () => Promise<number>;
  listSessionIds: () => string[];
};
