/** Materializes configured MCP catalog entries into agent tools and runtime helpers. */
import crypto from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { normalizeToolParameterSchema } from "@openclaw/ai/internal/openai";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { logWarn } from "../logger.js";
import { getPluginToolMeta, setPluginToolMeta, type PluginToolMcpMeta } from "../plugins/tools.js";
import {
  buildSafeToolName,
  normalizeReservedToolNames,
  TOOL_NAME_SEPARATOR,
} from "./agent-bundle-mcp-names.js";
import { runWithSessionMcpRequestSignal } from "./agent-bundle-mcp-request-context.js";
import { mergeMcpConnectCatalog } from "./agent-bundle-mcp-requester-connect.js";
import type {
  BundleMcpToolRuntime,
  McpCatalogTool,
  McpToolCatalog,
  SessionMcpRuntime,
} from "./agent-bundle-mcp-types.js";
import { projectMcpCallToolResult } from "./mcp-content.js";
import { isMcpToolAllowed } from "./mcp-tool-filter.js";
import { buildMcpAppCanvasPayload, fetchMcpAppView } from "./mcp-ui-resource.js";
import type { AgentToolResult } from "./runtime/index.js";
import type { AnyAgentTool } from "./tools/common.js";
function isAppOnlyTool(tool: McpCatalogTool): boolean {
  return tool.uiVisibility !== undefined && !tool.uiVisibility.includes("model");
}

async function releaseRuntimeLease(params: {
  runtime: SessionMcpRuntime;
  releaseLease?: () => void;
}): Promise<void> {
  params.releaseLease?.();
  // Lease retirement is a lifecycle-only edge. Keep the manager graph out of
  // read-only CLI startup paths that load tool materialization metadata.
  const { completeDeferredSessionMcpRuntimeRetirement } =
    await import("./agent-bundle-mcp-manager-api.js");
  await completeDeferredSessionMcpRuntimeRetirement(params.runtime).catch((error: unknown) => {
    logWarn(`bundle-mcp: deferred runtime cleanup failed: ${String(error)}`);
  });
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
    const server = params.catalog.servers[tool.serverName];
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
        codexApproval: {
          mode: server?.codexApprovalMode ?? "auto",
          ...(tool.codexAnnotations ? { annotations: tool.codexAnnotations } : {}),
        },
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
  return projectMcpCallToolResult(params.result, {
    mcpServer: params.serverName,
    mcpTool: params.toolName,
  });
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
  if (!isRecord(input)) {
    throw new Error(`${key} is required`);
  }
  const value = input[key];
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
  sessionDeniedOnly: boolean,
): boolean {
  // Two disjoint passes share this gate: the executable pass (sessionDeniedOnly=false)
  // admits only non-denied utilities; the denied-inventory pass admits only denied ones.
  // Membership must EQUAL the pass selector, hence the != rejection.
  if ((server.deniedToolNames?.includes(operation) === true) !== sessionDeniedOnly) {
    return false;
  }
  return isMcpToolAllowed(server.toolFilter, operation);
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
  deniedBySession?: true;
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
      ...(params.deniedBySession ? { deniedBySession: true } : {}),
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
  includeSessionDenied?: boolean;
}): AnyAgentTool[] {
  const initialReservedNames = normalizeReservedToolNames(params.reservedToolNames);
  const sessionDeniedOnly = params.includeSessionDenied === true;
  // Preserve executable IDs by allocating them before denied-only inventory rows.
  const tools = sessionDeniedOnly
    ? buildBundleMcpToolsFromCatalog({
        ...params,
        reservedToolNames: initialReservedNames,
        includeSessionDenied: false,
      })
    : [];
  const reservedNames = normalizeReservedToolNames([
    ...initialReservedNames,
    ...tools.map((tool) => tool.name),
  ]);
  const catalogTools = sessionDeniedOnly
    ? (params.catalog.sessionDeniedTools ?? [])
    : params.catalog.tools;
  const sortedCatalogTools = [...catalogTools].toSorted((a, b) => {
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
        (!sessionDeniedOnly ? params.createExecute?.(tool) : undefined) ??
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
        ...(tool.deniedBySession ? { deniedBySession: true } : {}),
        codexApproval: {
          mode: server?.codexApprovalMode ?? "auto",
          ...(tool.codexAnnotations ? { annotations: tool.codexAnnotations } : {}),
        },
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
    if (server.resources && serverAllowsUtilityTool(server, "resources_list", sessionDeniedOnly)) {
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
        ...(sessionDeniedOnly ? { deniedBySession: true } : {}),
        execute: !sessionDeniedOnly
          ? params.createResourceListExecute?.(server.serverName)
          : undefined,
      });
    }
    if (server.resources && serverAllowsUtilityTool(server, "resources_read", sessionDeniedOnly)) {
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
        ...(sessionDeniedOnly ? { deniedBySession: true } : {}),
        execute: !sessionDeniedOnly
          ? params.createResourceReadExecute?.(server.serverName)
          : undefined,
      });
    }
    if (server.prompts && serverAllowsUtilityTool(server, "prompts_list", sessionDeniedOnly)) {
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
        ...(sessionDeniedOnly ? { deniedBySession: true } : {}),
        execute: !sessionDeniedOnly
          ? params.createPromptListExecute?.(server.serverName)
          : undefined,
      });
    }
    if (server.prompts && serverAllowsUtilityTool(server, "prompts_get", sessionDeniedOnly)) {
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
        ...(sessionDeniedOnly ? { deniedBySession: true } : {}),
        execute: !sessionDeniedOnly
          ? params.createPromptGetExecute?.(server.serverName)
          : undefined,
      });
    }
  }

  // Sort deterministically by name: keeps the API tools block stable across turns
  // (listTools() order is not guaranteed). Collision suffixes above stay order-dependent.
  tools.sort((a, b) => a.name.localeCompare(b.name));
  return tools;
}

export async function materializeBundleMcpToolsForRun(params: {
  runtime: SessionMcpRuntime;
  agentId?: string;
  reservedToolNames?: Iterable<string>;
  disposeRuntime?: () => Promise<void>;
}): Promise<BundleMcpToolRuntime> {
  const runtime = params.runtime;
  let disposed = false;
  let allowedAppToolsByServer: Map<string, Set<string>> | undefined;
  const releaseLease = runtime.acquireLease?.();
  runtime.markUsed();
  let catalog;
  try {
    catalog = await runtime.getCatalog();
  } catch (error) {
    await releaseRuntimeLease({ runtime, releaseLease });
    throw error;
  }
  const reservedToolNames = params.reservedToolNames
    ? Array.from(params.reservedToolNames)
    : undefined;
  const materializedCatalog = mergeMcpConnectCatalog(catalog, runtime.requesterConnect);
  const tools = buildBundleMcpToolsFromCatalog({
    catalog: materializedCatalog,
    reservedToolNames,
    createExecute: (tool) => (toolCallId: string, input: unknown, signal?: AbortSignal) =>
      runWithSessionMcpRequestSignal(signal, async () => {
        if (!Object.hasOwn(catalog.servers, tool.serverName)) {
          const connect = runtime.requesterConnect?.createExecute(tool.serverName);
          if (connect) {
            return await connect(toolCallId, input);
          }
        }
        runtime.markUsed();
        const { serverName, toolName } = tool;
        const result = await runtime.callTool(serverName, toolName, input);
        const agentResult = toAgentToolResult({
          serverName,
          toolName,
          result,
        });
        // Requester-scoped servers never mint app views (outlive run; no requester id on view boundary).
        const scopedServer = runtime.isRequesterScopedServer?.(serverName) === true;
        if (runtime.mcpAppsEnabled && tool.uiResourceUri && !scopedServer) {
          const allowedAppToolNames = allowedAppToolsByServer
            ? (allowedAppToolsByServer.get(serverName) ?? new Set<string>())
            : undefined;
          const view = await fetchMcpAppView({
            runtime,
            agentId: params.agentId,
            serverName,
            toolName,
            uiResourceUri: tool.uiResourceUri,
            toolCallId,
            toolInput: input,
            toolResult: result,
            ...(allowedAppToolNames ? { allowedAppToolNames } : {}),
          });
          if (view) {
            (agentResult.details as Record<string, unknown>).mcpAppPreview =
              buildMcpAppCanvasPayload({
                ...view,
                ...(runtime.sessionKey ? { originSessionKey: runtime.sessionKey } : {}),
                ...(result["_meta"] !== undefined
                  ? { resultMetaState: "unavailable" as const }
                  : {}),
              });
          }
        }
        return agentResult;
      }),
    createResourceListExecute: runtime.listResources
      ? (serverName) => (_toolCallId, _input, signal) =>
          runWithSessionMcpRequestSignal(signal, async () => {
            runtime.markUsed();
            return toJsonAgentToolResult({
              serverName,
              operation: "resources_list",
              value: await runtime.listResources?.(serverName),
            });
          })
      : undefined,
    createResourceReadExecute: runtime.readResource
      ? (serverName) => (_toolCallId: string, input: unknown, signal?: AbortSignal) =>
          runWithSessionMcpRequestSignal(signal, async () => {
            const uri = requireStringArg(input, "uri");
            runtime.markUsed();
            return toJsonAgentToolResult({
              serverName,
              operation: "resources_read",
              value: await runtime.readResource?.(serverName, uri),
            });
          })
      : undefined,
    createPromptListExecute: runtime.listPrompts
      ? (serverName) => (_toolCallId, _input, signal) =>
          runWithSessionMcpRequestSignal(signal, async () => {
            runtime.markUsed();
            return toJsonAgentToolResult({
              serverName,
              operation: "prompts_list",
              value: await runtime.listPrompts?.(serverName),
            });
          })
      : undefined,
    createPromptGetExecute: runtime.getPrompt
      ? (serverName) => (_toolCallId: string, input: unknown, signal?: AbortSignal) =>
          runWithSessionMcpRequestSignal(signal, async () => {
            runtime.markUsed();
            return toJsonAgentToolResult({
              serverName,
              operation: "prompts_get",
              value: await runtime.getPrompt?.(
                serverName,
                requireStringArg(input, "name"),
                optionalStringRecordArg(input, "arguments"),
              ),
            });
          })
      : undefined,
  });
  const appTools = buildAppToolPolicyProjections({
    catalog: materializedCatalog,
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
      // Reset/delete can request retirement while this run owns the lease.
      // Dispose as soon as the final run, view, or request lease has released.
      await releaseRuntimeLease({ runtime, releaseLease });
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
