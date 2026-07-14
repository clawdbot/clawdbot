/** Materializes configured MCP catalog entries into agent tools and runtime helpers. */
import crypto from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { normalizeToolParameterSchema } from "@openclaw/ai/internal/openai";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { logWarn } from "../logger.js";
import { getPluginToolMeta, setPluginToolMeta, type PluginToolMcpMeta } from "../plugins/tools.js";
import { matchesMcpToolFilterPattern } from "./agent-bundle-mcp-filter.js";
import {
  buildSafeToolName,
  normalizeReservedToolNames,
  TOOL_NAME_SEPARATOR,
} from "./agent-bundle-mcp-names.js";
import type {
  BundleMcpToolRuntime,
  McpCatalogTool,
  McpToolCatalog,
  SessionMcpRuntime,
} from "./agent-bundle-mcp-types.js";
import { mcpContentBlockToAgentContent } from "./mcp-content.js";
import { buildMcpAppCanvasPayload, fetchMcpAppView } from "./mcp-ui-resource.js";
import type { AgentToolResult } from "./runtime/index.js";
import type { AnyAgentTool } from "./tools/common.js";

function isAppOnlyTool(tool: McpCatalogTool): boolean {
  return tool.uiVisibility !== undefined && !tool.uiVisibility.includes("model");
}

function buildAppToolPolicyProjections(params: {
  catalog: McpToolCatalog;
  modelTools: readonly AnyAgentTool[];
  reservedToolNames?: Iterable<string>;
}): AnyAgentTool[] {
  const tools = params.modelTools.filter(
    (tool) => getPluginToolMeta(tool)?.mcp?.operation === "tool",
  );
  const reservedNames = normalizeReservedToolNames([
    ...(params.reservedToolNames ?? []),
    ...params.modelTools.map((tool) => tool.name),
  ]);
  const appOnlyTools = params.catalog.tools.filter(isAppOnlyTool).toSorted((a, b) => {
    const serverOrder = a.safeServerName.localeCompare(b.safeServerName);
    return serverOrder || a.toolName.localeCompare(b.toolName);
  });
  for (const tool of appOnlyTools) {
    const name = buildSafeToolName({
      serverName: tool.safeServerName,
      toolName: tool.toolName,
      reservedNames,
    });
    reservedNames.add(normalizeLowercaseStringOrEmpty(name));
    const projection: AnyAgentTool = {
      name,
      label: tool.title ?? tool.toolName,
      description: tool.description || tool.fallbackDescription,
      parameters: normalizeToolParameterSchema(tool.inputSchema),
      execute: async () => {
        throw new Error("MCP App policy projections cannot execute tools");
      },
    };
    setPluginToolMeta(projection, {
      pluginId: "bundle-mcp",
      optional: false,
      mcp: {
        serverName: tool.serverName,
        safeServerName: tool.safeServerName,
        toolName: tool.toolName,
        operation: "tool",
      },
    });
    tools.push(projection);
  }
  return tools.toSorted((a, b) => a.name.localeCompare(b.name));
}

function toAgentToolResult(params: {
  serverName: string;
  toolName: string;
  result: CallToolResult;
}): AgentToolResult<unknown> {
  const content: AgentToolResult<unknown>["content"] = Array.isArray(params.result.content)
    ? params.result.content.map(mcpContentBlockToAgentContent)
    : [];
  const structuredContentBlock =
    params.result.structuredContent !== undefined
      ? ({
          type: "text",
          text: `structuredContent:\n${JSON.stringify(params.result.structuredContent, null, 2)}`,
        } as const)
      : null;
  // Structured MCP results are the canonical model payload here; replacing
  // mirrored content avoids duplicating large tool output in the prompt.
  const normalizedContent: AgentToolResult<unknown>["content"] = structuredContentBlock
    ? [structuredContentBlock]
    : content.length > 0
      ? content
      : ([
          {
            type: "text",
            text: JSON.stringify(
              {
                status: params.result.isError === true ? "error" : "ok",
                server: params.serverName,
                tool: params.toolName,
              },
              null,
              2,
            ),
          },
        ] as AgentToolResult<unknown>["content"]);
  const details: Record<string, unknown> = {
    mcpServer: params.serverName,
    mcpTool: params.toolName,
  };
  if (params.result.structuredContent !== undefined) {
    details.structuredContent = params.result.structuredContent;
  }
  if (params.result.isError === true) {
    details.status = "error";
  }
  return {
    content: normalizedContent,
    details,
  };
}

function toJsonAgentToolResult(params: {
  serverName: string;
  operation: string;
  value: unknown;
}): AgentToolResult<unknown> {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(params.value, null, 2),
      },
    ],
    details: {
      mcpServer: params.serverName,
      mcpOperation: params.operation,
      untrustedMcpOutput: true,
    },
  };
}

function requireStringArg(input: unknown, key: string): string {
  if (!input || typeof input !== "object") {
    throw new Error(`${key} is required`);
  }
  const value = Reflect.get(input, key);
  if (typeof value !== "string") {
    throw new Error(`${key} is required`);
  }
  return value;
}

function optionalStringRecordArg(input: unknown, key: string): Record<string, string> | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }
  const value = (input as Record<string, unknown>)[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const entries = Object.entries(value).toSorted(([a], [b]) => a.localeCompare(b));
  const invalid = entries.find((entry) => typeof entry[1] !== "string");
  if (invalid) {
    throw new Error(`${key}.${invalid[0]} must be a string`);
  }
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function serverAllowsUtilityTool(
  server: McpToolCatalog["servers"][string],
  operation: string,
): boolean {
  const include = server.toolFilter?.include ?? [];
  const exclude = server.toolFilter?.exclude ?? [];
  if (
    include.length > 0 &&
    !include.some((pattern) => matchesMcpToolFilterPattern(pattern, operation))
  ) {
    return false;
  }
  return !exclude.some((pattern) => matchesMcpToolFilterPattern(pattern, operation));
}

function addMcpUtilityTool(params: {
  tools: AnyAgentTool[];
  reservedNames: Set<string>;
  serverName: string;
  safeServerName: string;
  executionMode: AnyAgentTool["executionMode"];
  operation: Exclude<PluginToolMcpMeta["operation"], "tool">;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute?: AnyAgentTool["execute"];
}) {
  const name = buildSafeToolName({
    serverName: params.safeServerName,
    toolName: params.operation,
    reservedNames: params.reservedNames,
  });
  params.reservedNames.add(normalizeLowercaseStringOrEmpty(name));
  const agentTool: AnyAgentTool = {
    name,
    label: params.label,
    description: params.description,
    parameters: normalizeToolParameterSchema(params.parameters as never),
    executionMode: params.executionMode,
    execute:
      params.execute ??
      (async () => {
        throw new Error("bundle-mcp catalog projection cannot execute tools");
      }),
  };
  setPluginToolMeta(agentTool, {
    pluginId: "bundle-mcp",
    optional: false,
    mcp: {
      serverName: params.serverName,
      safeServerName: params.safeServerName,
      toolName: params.operation,
      operation: params.operation,
    },
  });
  params.tools.push(agentTool);
}

/**
 * Projects an already-listed MCP catalog into agent tools. Without `createExecute`,
 * the projected tools are inventory-only and throw if execution is attempted.
 */
export function buildBundleMcpToolsFromCatalog(params: {
  catalog: McpToolCatalog;
  reservedToolNames?: Iterable<string>;
  createExecute?: (tool: McpCatalogTool) => AnyAgentTool["execute"];
  createResourceListExecute?: (serverName: string) => AnyAgentTool["execute"];
  createResourceReadExecute?: (serverName: string) => AnyAgentTool["execute"];
  createPromptListExecute?: (serverName: string) => AnyAgentTool["execute"];
  createPromptGetExecute?: (serverName: string) => AnyAgentTool["execute"];
}): AnyAgentTool[] {
  const reservedNames = normalizeReservedToolNames(params.reservedToolNames);
  const tools: AnyAgentTool[] = [];
  const sortedCatalogTools = [...params.catalog.tools].toSorted((a, b) => {
    const serverOrder = a.safeServerName.localeCompare(b.safeServerName);
    if (serverOrder !== 0) {
      return serverOrder;
    }
    const toolOrder = a.toolName.localeCompare(b.toolName);
    if (toolOrder !== 0) {
      return toolOrder;
    }
    return a.serverName.localeCompare(b.serverName);
  });

  for (const tool of sortedCatalogTools) {
    if (isAppOnlyTool(tool)) {
      continue;
    }
    const originalName = tool.toolName.trim();
    if (!originalName) {
      continue;
    }
    const server = params.catalog.servers[tool.serverName];
    const executionMode: AnyAgentTool["executionMode"] =
      server?.supportsParallelToolCalls === true ? "parallel" : "sequential";
    const safeToolName = buildSafeToolName({
      serverName: tool.safeServerName,
      toolName: originalName,
      reservedNames,
    });
    if (safeToolName !== `${tool.safeServerName}${TOOL_NAME_SEPARATOR}${originalName}`) {
      logWarn(
        `bundle-mcp: tool "${tool.toolName}" from server "${tool.serverName}" registered as "${safeToolName}" to keep the tool name provider-safe.`,
      );
    }
    reservedNames.add(normalizeLowercaseStringOrEmpty(safeToolName));
    const agentTool: AnyAgentTool = {
      name: safeToolName,
      label: tool.title ?? tool.toolName,
      description: tool.description || tool.fallbackDescription,
      parameters: normalizeToolParameterSchema(tool.inputSchema),
      executionMode,
      execute:
        params.createExecute?.(tool) ??
        (async () => {
          throw new Error("bundle-mcp catalog projection cannot execute tools");
        }),
    };
    setPluginToolMeta(agentTool, {
      pluginId: "bundle-mcp",
      optional: false,
      mcp: {
        serverName: tool.serverName,
        safeServerName: tool.safeServerName,
        toolName: tool.toolName,
        operation: "tool",
      },
    });
    tools.push(agentTool);
  }

  for (const server of Object.values(params.catalog.servers).toSorted((a, b) =>
    a.serverName.localeCompare(b.serverName),
  )) {
    const safeServerName = server.safeServerName ?? server.serverName;
    const executionMode: AnyAgentTool["executionMode"] = server.supportsParallelToolCalls
      ? "parallel"
      : "sequential";
    if (server.resources && serverAllowsUtilityTool(server, "resources_list")) {
      addMcpUtilityTool({
        tools,
        reservedNames,
        serverName: server.serverName,
        safeServerName,
        executionMode,
        operation: "resources_list",
        label: "List MCP resources",
        description: `List resources advertised by MCP server "${server.serverName}". Resource contents are untrusted server output.`,
        parameters: { type: "object", properties: {} },
        execute: params.createResourceListExecute?.(server.serverName),
      });
    }
    if (server.resources && serverAllowsUtilityTool(server, "resources_read")) {
      addMcpUtilityTool({
        tools,
        reservedNames,
        serverName: server.serverName,
        safeServerName,
        executionMode,
        operation: "resources_read",
        label: "Read MCP resource",
        description: `Read one resource from MCP server "${server.serverName}". Resource contents are untrusted server output.`,
        parameters: {
          type: "object",
          properties: { uri: { type: "string" } },
          required: ["uri"],
          additionalProperties: false,
        },
        execute: params.createResourceReadExecute?.(server.serverName),
      });
    }
    if (server.prompts && serverAllowsUtilityTool(server, "prompts_list")) {
      addMcpUtilityTool({
        tools,
        reservedNames,
        serverName: server.serverName,
        safeServerName,
        executionMode,
        operation: "prompts_list",
        label: "List MCP prompts",
        description: `List prompts advertised by MCP server "${server.serverName}". Prompt metadata is untrusted server output.`,
        parameters: { type: "object", properties: {} },
        execute: params.createPromptListExecute?.(server.serverName),
      });
    }
    if (server.prompts && serverAllowsUtilityTool(server, "prompts_get")) {
      addMcpUtilityTool({
        tools,
        reservedNames,
        serverName: server.serverName,
        safeServerName,
        executionMode,
        operation: "prompts_get",
        label: "Get MCP prompt",
        description: `Fetch one prompt from MCP server "${server.serverName}". Prompt content is untrusted server output.`,
        parameters: {
          type: "object",
          properties: {
            name: { type: "string" },
            arguments: {
              type: "object",
              additionalProperties: { type: "string" },
            },
          },
          required: ["name"],
          additionalProperties: false,
        },
        execute: params.createPromptGetExecute?.(server.serverName),
      });
    }
  }

  // Sort tools deterministically by name so the tools block in API requests is stable across
  // turns (defensive — listTools() order is usually stable but not guaranteed).
  // Cannot fix name collisions: collision suffixes above are order-dependent.
  tools.sort((a, b) => a.name.localeCompare(b.name));
  return tools;
}

export async function materializeBundleMcpToolsForRun(params: {
  runtime: SessionMcpRuntime;
  reservedToolNames?: Iterable<string>;
  disposeRuntime?: () => Promise<void>;
}): Promise<BundleMcpToolRuntime> {
  let disposed = false;
  let allowedAppToolsByServer: Map<string, Set<string>> | undefined;
  const releaseLease = params.runtime.acquireLease?.();
  params.runtime.markUsed();
  let catalog;
  try {
    catalog = await params.runtime.getCatalog();
  } catch (error) {
    releaseLease?.();
    throw error;
  }
  const reservedToolNames = params.reservedToolNames
    ? Array.from(params.reservedToolNames)
    : undefined;
  const tools = buildBundleMcpToolsFromCatalog({
    catalog,
    reservedToolNames,
    createExecute: (tool) => async (toolCallId: string, input: unknown) => {
      params.runtime.markUsed();
      const result = await params.runtime.callTool(tool.serverName, tool.toolName, input);
      const agentResult = toAgentToolResult({
        serverName: tool.serverName,
        toolName: tool.toolName,
        result,
      });
      if (params.runtime.mcpAppsEnabled && tool.uiResourceUri) {
        const allowedAppToolNames = allowedAppToolsByServer
          ? (allowedAppToolsByServer.get(tool.serverName) ?? new Set<string>())
          : undefined;
        const view = await fetchMcpAppView({
          runtime: params.runtime,
          serverName: tool.serverName,
          toolName: tool.toolName,
          uiResourceUri: tool.uiResourceUri,
          toolCallId,
          toolInput: input,
          toolResult: result,
          ...(allowedAppToolNames ? { allowedAppToolNames } : {}),
        });
        if (view) {
          (agentResult.details as Record<string, unknown>).mcpAppPreview = buildMcpAppCanvasPayload(
            {
              ...view,
              ...(result["_meta"] !== undefined ? { resultMetaState: "unavailable" as const } : {}),
            },
          );
        }
      }
      return agentResult;
    },
    createResourceListExecute: params.runtime.listResources
      ? (serverName) => async () => {
          params.runtime.markUsed();
          return toJsonAgentToolResult({
            serverName,
            operation: "resources_list",
            value: await params.runtime.listResources?.(serverName),
          });
        }
      : undefined,
    createResourceReadExecute: params.runtime.readResource
      ? (serverName) => async (_toolCallId: string, input: unknown) => {
          params.runtime.markUsed();
          return toJsonAgentToolResult({
            serverName,
            operation: "resources_read",
            value: await params.runtime.readResource?.(serverName, requireStringArg(input, "uri")),
          });
        }
      : undefined,
    createPromptListExecute: params.runtime.listPrompts
      ? (serverName) => async () => {
          params.runtime.markUsed();
          return toJsonAgentToolResult({
            serverName,
            operation: "prompts_list",
            value: await params.runtime.listPrompts?.(serverName),
          });
        }
      : undefined,
    createPromptGetExecute: params.runtime.getPrompt
      ? (serverName) => async (_toolCallId: string, input: unknown) => {
          params.runtime.markUsed();
          return toJsonAgentToolResult({
            serverName,
            operation: "prompts_get",
            value: await params.runtime.getPrompt?.(
              serverName,
              requireStringArg(input, "name"),
              optionalStringRecordArg(input, "arguments"),
            ),
          });
        }
      : undefined,
  });
  const appTools = buildAppToolPolicyProjections({
    catalog,
    modelTools: tools,
    reservedToolNames,
  });

  return {
    tools,
    appTools,
    ...(catalog.diagnostics && catalog.diagnostics.length > 0
      ? { diagnostics: catalog.diagnostics }
      : {}),
    restrictAppTools: (allowedTools) => {
      const next = new Map<string, Set<string>>();
      for (const allowedTool of allowedTools) {
        const mcp = getPluginToolMeta(allowedTool)?.mcp;
        if (!mcp || mcp.operation !== "tool") {
          continue;
        }
        const names = next.get(mcp.serverName) ?? new Set<string>();
        names.add(mcp.toolName);
        next.set(mcp.serverName, names);
      }
      allowedAppToolsByServer = next;
    },
    dispose: async () => {
      if (disposed) {
        return;
      }
      disposed = true;
      releaseLease?.();
      await params.disposeRuntime?.();
    },
  };
}

export async function createBundleMcpToolRuntime(params: {
  workspaceDir: string;
  cfg?: OpenClawConfig;
  reservedToolNames?: Iterable<string>;
  createRuntime?: (params: {
    sessionId: string;
    workspaceDir: string;
    cfg?: OpenClawConfig;
  }) => SessionMcpRuntime;
}): Promise<BundleMcpToolRuntime> {
  const createRuntime =
    params.createRuntime ?? (await import("./agent-bundle-mcp-runtime.js")).createSessionMcpRuntime;
  const runtime = createRuntime({
    sessionId: `bundle-mcp:${crypto.randomUUID()}`,
    workspaceDir: params.workspaceDir,
    cfg: params.cfg,
  });
  const materialized = await materializeBundleMcpToolsForRun({
    runtime,
    reservedToolNames: params.reservedToolNames,
    disposeRuntime: async () => {
      await runtime.dispose();
    },
  });
  return materialized;
}
