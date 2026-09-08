import {
  type CallToolRequest,
  CallToolRequestSchema,
  type ListResourcesRequest,
  ListResourcesRequestSchema,
  type ListResourceTemplatesRequest,
  ListResourceTemplatesRequestSchema,
  type ListToolsRequest,
  ListToolsRequestSchema,
  type ReadResourceRequest,
  ReadResourceRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  completeDeferredSessionMcpRuntimeRetirement,
  peekSessionMcpRuntime,
} from "../agents/agent-bundle-mcp-manager-api.js";
import { getSessionMcpRequestSignal } from "../agents/agent-bundle-mcp-request-context.js";
import type { McpCatalogTool, SessionMcpRuntime } from "../agents/agent-bundle-mcp-types.js";
import {
  acquireMcpAppViewRequest,
  getMcpAppViewLease,
  getMcpAppViewLeaseForSession,
  type McpAppViewLease,
} from "../agents/mcp-ui-resource.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { formatErrorMessage } from "../infra/errors.js";
import { logWarn } from "../logger.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { restoreMcpAppView } from "./mcp-app-reconstruction.js";

export type McpAppActiveView = {
  runtime: SessionMcpRuntime;
  view: McpAppViewLease;
};

export class McpAppViewExpiredError extends Error {
  constructor() {
    super("MCP App view expired or is not authorized for this session");
    this.name = "McpAppViewExpiredError";
  }
}

export type McpAppOperation =
  | Pick<CallToolRequest, "method" | "params">
  | Pick<ListToolsRequest, "method" | "params">
  | Pick<ListResourcesRequest, "method" | "params">
  | Pick<ListResourceTemplatesRequest, "method" | "params">
  | Pick<ReadResourceRequest, "method" | "params">;

function isAppCallableTool(tool: McpCatalogTool): boolean {
  return tool.uiVisibility === undefined || tool.uiVisibility.includes("app");
}

function isAppCallableListedTool(tool: Tool): boolean {
  const { _meta: metadata } = tool;
  const ui =
    metadata?.ui && typeof metadata.ui === "object" && !Array.isArray(metadata.ui)
      ? (metadata.ui as { visibility?: unknown })
      : undefined;
  const visibility = Array.isArray(ui?.visibility)
    ? ui.visibility.filter(
        (entry): entry is "app" | "model" => entry === "app" || entry === "model",
      )
    : undefined;
  return visibility === undefined || visibility.includes("app");
}

function isAllowedByView(view: McpAppViewLease, toolName: string): boolean {
  return view.allowedAppToolNames === undefined || view.allowedAppToolNames.has(toolName);
}

export async function requireMcpAppInteraction(view: McpAppViewLease): Promise<void> {
  if (view.readOnly === true || view.allowedAppToolNames === undefined) {
    throw new Error("MCP App view is read-only");
  }
  if (view.authorizeAppInteraction && !(await view.authorizeAppInteraction())) {
    throw new Error("MCP App widget grant is no longer active");
  }
}

export async function resolveMcpAppAllowedToolNames(active: McpAppActiveView): Promise<string[]> {
  if (active.view.readOnly === true || active.view.allowedAppToolNames === undefined) {
    return [];
  }
  const catalog = await active.runtime.getCatalog();
  return catalog.tools
    .filter(
      (tool) =>
        tool.serverName === active.view.serverName &&
        isAppCallableTool(tool) &&
        isAllowedByView(active.view, tool.toolName),
    )
    .map((tool) => tool.toolName)
    .filter((toolName, index, all) => all.indexOf(toolName) === index)
    .toSorted();
}

async function getRequestCatalog(runtime: SessionMcpRuntime) {
  const signal = getSessionMcpRequestSignal();
  signal?.throwIfAborted();
  // A caller can leave the wait, but the session still owns its shared refresh.
  return racePromiseWithAbortSignal(runtime.getCatalog(), signal);
}

async function requireCallableTool(
  runtime: SessionMcpRuntime,
  view: McpAppViewLease,
  toolName: string,
): Promise<void> {
  await requireMcpAppInteraction(view);
  const catalog = await getRequestCatalog(runtime);
  const tool = catalog.tools.find(
    (entry) => entry.serverName === view.serverName && entry.toolName === toolName,
  );
  if (!tool || !isAppCallableTool(tool) || !isAllowedByView(view, toolName)) {
    throw new Error(`MCP tool "${toolName}" is not app-callable`);
  }
}

export async function resolveMcpAppActiveView(params: {
  sessionKey: string;
  agentId?: string;
  viewId: string;
  cfg?: OpenClawConfig;
}): Promise<McpAppActiveView> {
  if (params.cfg && params.cfg.mcp?.apps?.enabled !== true) {
    throw new Error("MCP App runtime is unavailable");
  }
  const liveView = params.agentId
    ? getMcpAppViewLeaseForSession(params.viewId, params.sessionKey, params.agentId)
    : undefined;
  if (liveView) {
    if (liveView.runtime.mcpAppsEnabled !== true) {
      throw new Error("MCP App runtime is unavailable");
    }
    return { runtime: liveView.runtime, view: liveView };
  }
  // An unscoped runtime key cannot prove its owning agent. Prefer transcript
  // restoration with the prepared owner instead of adopting a sibling runtime.
  const existingRuntime =
    params.agentId && !parseAgentSessionKey(params.sessionKey)
      ? undefined
      : peekSessionMcpRuntime({ sessionKey: params.sessionKey });
  if (existingRuntime && existingRuntime.mcpAppsEnabled !== true) {
    throw new Error("MCP App runtime is unavailable");
  }
  const existingView = existingRuntime
    ? getMcpAppViewLease(params.viewId, existingRuntime)
    : undefined;
  const restored =
    existingRuntime?.mcpAppsEnabled === true && existingView
      ? { runtime: existingRuntime, view: existingView }
      : params.cfg
        ? await restoreMcpAppView({
            cfg: params.cfg,
            agentId: params.agentId,
            sessionKey: params.sessionKey,
            viewId: params.viewId,
          })
        : undefined;
  if (!restored) {
    throw new McpAppViewExpiredError();
  }
  return restored;
}

export async function withMcpAppActiveView<T>(
  active: McpAppActiveView,
  kind: "read" | "tool",
  operation: () => Promise<T> | T,
): Promise<T> {
  active.runtime.markUsed();
  const release = acquireMcpAppViewRequest(active.view, kind);
  const releaseRuntimeLease = active.runtime.acquireLease?.();
  try {
    return await operation();
  } finally {
    release();
    releaseRuntimeLease?.();
    await completeDeferredSessionMcpRuntimeRetirement(active.runtime).catch((error: unknown) => {
      // A completed app tool call may have side effects. Cleanup failure must
      // never turn its successful response into an apparent retryable failure.
      logWarn(`mcp-app: deferred runtime cleanup failed: ${formatErrorMessage(error)}`);
    });
  }
}

async function withMcpAppResourceAuthority<T>(
  active: McpAppActiveView,
  operation: () => Promise<T>,
): Promise<T> {
  return await withMcpAppActiveView(active, "read", async () => {
    await requireMcpAppInteraction(active.view);
    const result = await operation();
    // Resource results may contain protected data. Recheck after upstream work
    // so a grant revoked in flight cannot disclose the completed response.
    await requireMcpAppInteraction(active.view);
    return result;
  });
}

export async function executeMcpAppOperation(
  active: McpAppActiveView,
  operation: McpAppOperation,
): Promise<unknown> {
  const { runtime, view } = active;
  switch (operation.method) {
    case "tools/call":
      return await withMcpAppActiveView(active, "tool", async () => {
        await requireCallableTool(runtime, view, operation.params.name);
        await requireMcpAppInteraction(view);
        return await runtime.callTool(
          view.serverName,
          operation.params.name,
          operation.params.arguments ?? {},
        );
      });
    case "tools/list":
      return await withMcpAppActiveView(active, "read", async () => {
        await requireMcpAppInteraction(view);
        if (!runtime.listTools) {
          throw new Error("MCP tools/list is unavailable");
        }
        const [listed, catalog] = await Promise.all([
          runtime.listTools(
            view.serverName,
            operation.params?.cursor ? { cursor: operation.params.cursor } : undefined,
          ),
          getRequestCatalog(runtime),
        ]);
        const allowed = new Set(
          catalog.tools
            .filter(
              (tool) =>
                tool.serverName === view.serverName &&
                isAppCallableTool(tool) &&
                isAllowedByView(view, tool.toolName),
            )
            .map((tool) => tool.toolName),
        );
        const result = {
          ...listed,
          tools: listed.tools.filter(
            (tool) => allowed.has(tool.name.trim()) && isAppCallableListedTool(tool),
          ),
        };
        await requireMcpAppInteraction(view);
        return result;
      });
    case "resources/list":
      return await withMcpAppResourceAuthority(active, async () => {
        if (!runtime.listResources) {
          throw new Error("MCP resources/list is unavailable");
        }
        // SessionMcpRuntime aggregates every upstream resources/list page, so
        // callers receive the complete list and no nextCursor is exposed.
        const resources = await runtime.listResources(view.serverName);
        return Array.isArray(resources) ? { resources } : resources;
      });
    case "resources/templates/list":
      return await withMcpAppResourceAuthority(active, async () => {
        if (!runtime.listResourceTemplates) {
          throw new Error("MCP resources/templates/list is unavailable");
        }
        return await runtime.listResourceTemplates(
          view.serverName,
          operation.params?.cursor ? { cursor: operation.params.cursor } : undefined,
        );
      });
    case "resources/read":
      return await withMcpAppResourceAuthority(active, async () => {
        if (!runtime.readResource) {
          throw new Error("MCP resources/read is unavailable");
        }
        return await runtime.readResource(view.serverName, operation.params.uri);
      });
    default: {
      const unsupported: never = operation;
      throw new Error(`Unsupported MCP App operation: ${String(unsupported)}`);
    }
  }
}

export function parseMcpAppOperation(value: unknown): McpAppOperation | undefined {
  const method =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as { method?: unknown }).method
      : undefined;
  const schema =
    method === "tools/call"
      ? CallToolRequestSchema
      : method === "tools/list"
        ? ListToolsRequestSchema
        : method === "resources/list"
          ? ListResourcesRequestSchema
          : method === "resources/templates/list"
            ? ListResourceTemplatesRequestSchema
            : method === "resources/read"
              ? ReadResourceRequestSchema
              : undefined;
  if (!schema) {
    return undefined;
  }
  const parsed = schema.safeParse(value);
  return parsed.success ? (parsed.data as McpAppOperation) : undefined;
}
