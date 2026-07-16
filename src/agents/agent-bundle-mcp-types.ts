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

/** Trusted requester identity used to scope per-user MCP connections. */
export type SessionMcpRequesterScope = {
  requesterSenderId: string;
  agentAccountId?: string;
  messageChannel?: string;
};

/** Live MCP runtime bound to one session/workspace. */
export type SessionMcpRuntime = {
  sessionId: string;
  sessionKey?: string;
  workspaceDir: string;
  agentDir?: string;
  configFingerprint: string;
  /** Present when this runtime is keyed by requester-scoped connection identity. */
  requesterScope?: SessionMcpRequesterScope;
  /**
   * True when the named server's connection is requester-scoped. App views for
   * such servers stay fail-closed: views outlive the requester-authenticated
   * run and the gateway view boundary carries no requester identity.
   */
  isRequesterScopedServer?: (serverName: string) => boolean;
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
    /** Trusted sender id; required to materialize requester-scoped MCP servers. */
    requesterSenderId?: string | null;
    agentAccountId?: string | null;
    messageChannel?: string | null;
  }) => Promise<SessionMcpRuntime>;
  /**
   * Requester-scoped partition only — never creates static transports.
   * Undefined when no scoped servers, no senderId, or nothing resolves.
   */
  getOrCreateRequesterScoped: (params: {
    sessionId: string;
    sessionKey?: string;
    workspaceDir: string;
    agentDir?: string;
    cfg?: OpenClawConfig;
    manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
    requesterSenderId?: string | null;
    agentAccountId?: string | null;
    messageChannel?: string | null;
  }) => Promise<SessionMcpRuntime | undefined>;
  /**
   * Session-stable advertised catalog for scoped servers. Used by shared-thread
   * harnesses so dynamic tool specs do not rotate per sender.
   */
  rememberAdvertisedScopedCatalog: (sessionId: string, catalog: McpToolCatalog) => void;
  getAdvertisedScopedCatalog: (sessionId: string) => McpToolCatalog | null;
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
  /** All managed cache keys (session ids and requester composite keys). */
  listRuntimeKeys: () => string[];
  /** Sum of active leases across every runtime key for this session. */
  totalActiveLeasesForSession: (sessionId: string) => number;
};
