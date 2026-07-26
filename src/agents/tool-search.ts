/** Tool Search catalog compaction for large OpenClaw, MCP, and client tool inventories. */
import { Type } from "typebox";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HookContext } from "./agent-tools.before-tool-call.js";
import type { AgentToolResult, AgentToolUpdateCallback } from "./runtime/index.js";
import type { ToolDefinition } from "./sessions/index.js";
import {
  addClientToolsToToolCatalog,
  applyToolCatalogCompaction,
  reusableCatalogSnapshots,
  sessionCatalogs,
} from "./tool-search-catalog.js";
import {
  appendToolSearchCodeStderrTail,
  readToolSearchCode,
  runCodeMode,
  runCodeModeChild,
} from "./tool-search-code-mode.js";
import {
  isToolSearchCodeModeSupported,
  resolveToolSearchConfig,
  setToolSearchCodeModeSupportedForTest,
  setToolSearchMinCodeTimeoutMsForTest,
} from "./tool-search-config.js";
import { applyToolSchemaDirectoryCatalog } from "./tool-search-directory.js";
import { MAX_TOOL_SCHEMA_DIRECTORY_PROMPT_CHARS } from "./tool-search-directory.js";
import {
  readToolSearchArgs,
  readToolSearchCallArgs,
  readToolSearchId,
  ToolSearchRuntime,
} from "./tool-search-runtime.js";
import {
  TOOL_CALL_RAW_TOOL_NAME,
  TOOL_DESCRIBE_RAW_TOOL_NAME,
  TOOL_SEARCH_CODE_MODE_TOOL_NAME,
  TOOL_SEARCH_CONTROL_TOOL_NAMES,
  TOOL_SEARCH_RAW_TOOL_NAME,
  type ToolSearchCatalogRef,
  type ToolSearchMode,
  type ToolSearchToolContext,
} from "./tool-search-types.js";
import { jsonResult, type AnyAgentTool } from "./tools/common.js";

export {
  addClientToolsToToolCatalog,
  applyToolCatalogCompaction,
  clearToolSearchCatalog,
  collectUniqueCatalogToolNames,
  compactToolSearchCatalogEntry,
  createToolSearchCatalogRef,
  registerHeadlessToolSearchCatalog,
} from "./tool-search-catalog.js";
export { resolveToolSearchConfig } from "./tool-search-config.js";
export {
  buildToolSchemaDirectoryPrompt,
  estimateToolSchemaDirectoryToolNames,
  resolveToolSearchCatalogTool,
} from "./tool-search-directory.js";
export { ToolSearchRuntime } from "./tool-search-runtime.js";
export { projectToolSearchTargetTranscriptMessages } from "./tool-search-transcript.js";
export {
  TOOL_CALL_RAW_TOOL_NAME,
  TOOL_DESCRIBE_RAW_TOOL_NAME,
  TOOL_SEARCH_CODE_MODE_TOOL_NAME,
  TOOL_SEARCH_RAW_TOOL_NAME,
} from "./tool-search-types.js";
export type {
  ToolSearchCatalogEntry,
  ToolSearchCatalogRef,
  ToolSearchCatalogToolExecutor,
  ToolSearchConfig,
  ToolSearchTargetTranscriptProjection,
  ToolSearchToolContext,
} from "./tool-search-types.js";

function shouldExposeControlTool(name: string, mode: ToolSearchMode): boolean {
  if (name === TOOL_SEARCH_CODE_MODE_TOOL_NAME) {
    return mode === "code";
  }
  if (
    name === TOOL_SEARCH_RAW_TOOL_NAME ||
    name === TOOL_DESCRIBE_RAW_TOOL_NAME ||
    name === TOOL_CALL_RAW_TOOL_NAME
  ) {
    return mode === "tools";
  }
  return false;
}

/** Replace visible tools with Tool Search controls and register hidden catalog entries. */
export function applyToolSearchCatalog(params: {
  tools: AnyAgentTool[];
  config?: OpenClawConfig;
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
  runId?: string;
  catalogRef?: ToolSearchCatalogRef;
  toolHookContext?: HookContext;
  shouldCatalogTool?: (tool: AnyAgentTool) => boolean;
}) {
  const config = resolveToolSearchConfig(params.config);
  return applyToolCatalogCompaction({
    ...params,
    enabled: config.enabled,
    isVisibleControlTool: (tool) =>
      TOOL_SEARCH_CONTROL_TOOL_NAMES.has(tool.name) &&
      shouldExposeControlTool(tool.name, config.mode),
  });
}

export { applyToolSchemaDirectoryCatalog };

/** Move client-provided tools into an existing Tool Search catalog. */
export function addClientToolsToToolSearchCatalog(params: {
  tools: ToolDefinition[];
  config?: OpenClawConfig;
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
  runId?: string;
  catalogRef?: ToolSearchCatalogRef;
}): { tools: ToolDefinition[]; compacted: boolean; catalogToolCount: number } {
  const config = resolveToolSearchConfig(params.config);
  if (config.mode === "directory") {
    return { tools: params.tools, compacted: false, catalogToolCount: 0 };
  }
  return addClientToolsToToolCatalog({ ...params, enabled: config.enabled });
}

/** Create Tool Search control tools for the current run/session context. */
export function createToolSearchTools(ctx: ToolSearchToolContext): AnyAgentTool[] {
  const config = resolveToolSearchConfig(ctx.runtimeConfig ?? ctx.config);
  const runtime = new ToolSearchRuntime(ctx, config);
  return [
    {
      name: TOOL_SEARCH_CODE_MODE_TOOL_NAME,
      label: "Tool Search Code",
      description:
        "Run JavaScript in an isolated Node subprocess over a large tool catalog. APIs: `openclaw.tools.search(query: string, options?)`, `openclaw.tools.describe(id: string)`, and `openclaw.tools.call(id: string, args?)`. Search takes a positional query string. Call returns `{ tool, result }`; JSON values normally live in `result.details`.",
      parameters: Type.Object({
        code: Type.String({
          description:
            "JavaScript body for an async function. Use return to return the final value. The openclaw.tools bridge is available.",
        }),
      }),
      execute: async (
        toolCallId: string,
        args: unknown,
        signal?: AbortSignal,
        onUpdate?: AgentToolUpdateCallback,
      ): Promise<AgentToolResult<unknown>> =>
        jsonResult(
          await runCodeMode({
            toolCallId,
            ctx,
            code: readToolSearchCode(args),
            config,
            signal,
            onUpdate,
          }),
        ),
    },
    {
      name: TOOL_SEARCH_RAW_TOOL_NAME,
      label: "Tool Search",
      description:
        "Search the effective Tool Search catalog. Pass an exact result id or name to tool_call; use tool_describe only when you need its input schema.",
      parameters: Type.Object({
        query: Type.String({ description: "Search query." }),
        limit: Type.Optional(
          Type.Integer({ minimum: 1, description: "Maximum number of results." }),
        ),
      }),
      execute: async (_toolCallId: string, args: unknown): Promise<AgentToolResult<unknown>> => {
        const search = readToolSearchArgs(args, config);
        return jsonResult(await runtime.search(search.query, { limit: search.limit }));
      },
    },
    {
      name: TOOL_DESCRIBE_RAW_TOOL_NAME,
      label: "Tool Describe",
      description:
        "Load the full schema and metadata for one search result when its input is not already clear.",
      parameters: Type.Object({
        id: Type.String({ description: "Tool search result id or tool name." }),
      }),
      execute: async (_toolCallId: string, args: unknown): Promise<AgentToolResult<unknown>> =>
        jsonResult(await runtime.describe(readToolSearchId(args))),
    },
    {
      name: TOOL_CALL_RAW_TOOL_NAME,
      label: "Tool Call",
      description: "Call an exact Tool Search result id or name through OpenClaw.",
      parameters: Type.Object({
        id: Type.String({ description: "Tool search result id or tool name." }),
        args: Type.Optional(
          Type.Record(Type.String(), Type.Unknown(), { description: "Tool input." }),
        ),
      }),
      execute: async (
        toolCallId: string,
        args: unknown,
        signal?: AbortSignal,
        onUpdate?: AgentToolUpdateCallback,
      ): Promise<AgentToolResult<unknown>> => {
        const call = readToolSearchCallArgs(args);
        return jsonResult(
          await runtime.call(call.id, call.input, {
            parentToolCallId: toolCallId,
            signal,
            onUpdate,
          }),
        );
      },
    },
  ];
}

const testing = {
  sessionCatalogs,
  reusableCatalogSnapshots,
  maxToolSchemaDirectoryPromptChars: MAX_TOOL_SCHEMA_DIRECTORY_PROMPT_CHARS,
  resolveToolSearchConfig,
  isToolSearchCodeModeSupported,
  setToolSearchCodeModeSupportedForTest,
  setToolSearchMinCodeTimeoutMsForTest,
  applyToolSearchCatalog,
  addClientToolsToToolSearchCatalog,
  appendToolSearchCodeStderrTail,
  runCodeModeChild,
};

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.toolSearchTestApi")] = testing;
}
