import type { Result } from "@openclaw/normalization-core/result";
import type { TSchema } from "typebox";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginToolMcpMeta } from "../plugins/tools.js";
import type { HookContext } from "./agent-tools.before-tool-call.js";
import type { AgentToolResult, AgentToolUpdateCallback } from "./runtime/index.js";
import type { ToolDefinition } from "./sessions/index.js";
import type { AnyAgentTool } from "./tools/common.js";

export const TOOL_SEARCH_CODE_MODE_TOOL_NAME = "tool_search_code";
export const TOOL_SEARCH_RAW_TOOL_NAME = "tool_search";
export const TOOL_DESCRIBE_RAW_TOOL_NAME = "tool_describe";
export const TOOL_CALL_RAW_TOOL_NAME = "tool_call";

export const TOOL_SEARCH_CONTROL_TOOL_NAMES = new Set([
  TOOL_SEARCH_CODE_MODE_TOOL_NAME,
  TOOL_SEARCH_RAW_TOOL_NAME,
  TOOL_DESCRIBE_RAW_TOOL_NAME,
  TOOL_CALL_RAW_TOOL_NAME,
]);

export const TOOL_SCHEMA_DIRECTORY_CONTROL_TOOL_NAMES = new Set([
  TOOL_SEARCH_RAW_TOOL_NAME,
  TOOL_DESCRIBE_RAW_TOOL_NAME,
  TOOL_CALL_RAW_TOOL_NAME,
]);

export type ToolSearchMode = "code" | "tools" | "directory";
export type CatalogSource = "openclaw" | "mcp" | "client";
export type CatalogTool = AnyAgentTool | ToolDefinition;
export type CatalogVisibilityOptions = {
  includeMcp?: boolean;
};
export type UnknownToolRecoverySurface = "raw-tools" | "code-mode" | "tools";
export type UnknownToolErrorOptions = {
  exactIdOnly?: boolean;
  recoverySurface?: UnknownToolRecoverySurface;
};
export type ToolSearchCallOptions = CatalogVisibilityOptions &
  UnknownToolErrorOptions & {
    parentToolCallId?: string;
    signal?: AbortSignal;
    onUpdate?: AgentToolUpdateCallback;
  };

export type ToolSearchCatalogToolExecutor = (params: {
  tool: CatalogTool;
  toolName: string;
  source: CatalogSource;
  sourceName?: string;
  toolCallId: string;
  parentToolCallId?: string;
  input: unknown;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback;
  acceptResultBeforeProjection: (
    result: AgentToolResult<unknown>,
  ) => Promise<AgentToolResult<unknown>>;
}) => Promise<AgentToolResult<unknown>>;

/** Transcript projection for target tool calls made through Tool Search. */
export type ToolSearchTargetTranscriptProjection = {
  parentToolCallId?: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
  result?: unknown;
  isError?: boolean;
  timestamp?: number;
};

/** Resolved Tool Search config after defaults, limits, and runtime support checks. */
export type ToolSearchConfig = {
  enabled: boolean;
  mode: ToolSearchMode;
  codeTimeoutMs: number;
  searchDefaultLimit: number;
  maxSearchLimit: number;
};

/** Per-run/session context used by Tool Search control tools. */
export type ToolSearchToolContext = {
  config?: OpenClawConfig;
  runtimeConfig?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  catalogRef?: ToolSearchCatalogRef;
  abortSignal?: AbortSignal;
  executeTool?: ToolSearchCatalogToolExecutor;
  forceRestartSafeTools?: boolean;
};

/** Catalog entry retained behind compacted Tool Search control tools. */
export type ToolSearchCatalogEntry = {
  id: string;
  source: CatalogSource;
  sourceName?: string;
  mcp?: PluginToolMcpMeta;
  name: string;
  label?: string;
  description: string;
  parameters?: unknown;
  outputSchema?: TSchema;
  tool: CatalogTool;
};

export type ToolSearchCatalogSession = {
  entries: ToolSearchCatalogEntry[];
  searchCount: number;
  describeCount: number;
  callCount: number;
};

export type ToolSearchCatalogRef = {
  current?: ToolSearchCatalogSession;
};

export type CodeModeBridgeMethod = "search" | "describe" | "call";

export type CodeModeChildMessage =
  | { type: "result"; ok: true; value: unknown }
  | { type: "result"; ok: false; error?: string }
  | { type: "log"; items?: unknown[] }
  | { type: "bridge"; id?: unknown; method?: unknown; args?: unknown };

export type CodeModeBridgeResultMessage = { type: "bridge-result"; id: string } & Result<
  unknown,
  string
>;

export type ToolSearchCatalogApplyResult = {
  tools: AnyAgentTool[];
  compacted: boolean;
  catalogToolCount: number;
  catalogRegistered: boolean;
  catalogReused: boolean;
};

export type ToolSearchCatalogCompactionParams = {
  tools: AnyAgentTool[];
  enabled: boolean;
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
  runId?: string;
  catalogRef?: ToolSearchCatalogRef;
  toolHookContext?: HookContext;
  isVisibleControlTool: (tool: AnyAgentTool) => boolean;
  isVisibleCatalogTool?: (tool: AnyAgentTool) => boolean;
  shouldCatalogTool?: (tool: AnyAgentTool) => boolean;
};
