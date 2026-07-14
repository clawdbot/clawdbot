import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import {
  completeDeferredSessionMcpRuntimeRetirement,
  peekSessionMcpRuntime,
} from "../../agents/agent-bundle-mcp-runtime.js";
import type { McpCatalogTool, SessionMcpRuntime } from "../../agents/agent-bundle-mcp-types.js";
import { buildMcpAppSandboxPath } from "../../agents/mcp-app-sandbox.js";
import {
  acquireMcpAppViewRequest,
  getMcpAppViewLease,
  type McpAppViewLease,
} from "../../agents/mcp-ui-resource.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { logWarn } from "../../logger.js";
import { restoreMcpAppView } from "../mcp-app-reconstruction.js";
import type { GatewayRequestHandlers } from "./types.js";

function requireString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} is required`);
  }
  return value.trim();
}

function optionalCursor(params: Record<string, unknown>): { cursor?: string } | undefined {
  const cursor = params.cursor;
  return typeof cursor === "string" && cursor.trim() ? { cursor: cursor.trim() } : undefined;
}

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

async function requireActiveView(
  params: Record<string, unknown>,
  cfg?: OpenClawConfig,
): Promise<{
  runtime: SessionMcpRuntime;
  view: McpAppViewLease;
}> {
  const sessionKey = requireString(params, "sessionKey");
  const viewId = requireString(params, "viewId");
  const existingRuntime = peekSessionMcpRuntime({ sessionKey });
  if (
    (existingRuntime && existingRuntime.mcpAppsEnabled !== true) ||
    (cfg && cfg.mcp?.apps?.enabled !== true)
  ) {
    throw new Error("MCP App runtime is unavailable");
  }
  const existingView = existingRuntime ? getMcpAppViewLease(viewId, existingRuntime) : undefined;
  const restored =
    existingRuntime?.mcpAppsEnabled === true && existingView
      ? { runtime: existingRuntime, view: existingView }
      : cfg
        ? await restoreMcpAppView({ cfg, sessionKey, viewId })
        : undefined;
  if (!restored) {
    throw new Error("MCP App view expired or is not authorized for this session");
  }
  const { runtime, view } = restored;
  runtime.markUsed();
  return { runtime, view };
}

async function withActiveView<T>(
  params: Record<string, unknown>,
  kind: "read" | "tool",
  operation: (active: { runtime: SessionMcpRuntime; view: McpAppViewLease }) => Promise<T> | T,
  cfg?: OpenClawConfig,
): Promise<T> {
  const active = await requireActiveView(params, cfg);
  const release = acquireMcpAppViewRequest(active.view, kind);
  const releaseRuntimeLease = active.runtime.acquireLease?.();
  try {
    return await operation(active);
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

async function requireCallableTool(
  runtime: SessionMcpRuntime,
  view: McpAppViewLease,
  toolName: string,
): Promise<McpCatalogTool> {
  const catalog = await runtime.getCatalog();
  const tool = catalog.tools.find(
    (entry) => entry.serverName === view.serverName && entry.toolName === toolName,
  );
  if (!tool || !isAppCallableTool(tool) || !isAllowedByView(view, toolName)) {
    throw new Error(`MCP tool "${toolName}" is not app-callable`);
  }
  return tool;
}

async function handle(
  respond: Parameters<GatewayRequestHandlers[string]>[0]["respond"],
  operation: () => Promise<unknown>,
) {
  try {
    respond(true, await operation());
  } catch (error) {
    respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error)));
  }
}

export const mcpAppHandlers: GatewayRequestHandlers = {
  "mcp.app.view": async ({ respond, params, context }) => {
    await handle(
      respond,
      async () =>
        await withActiveView(
          params,
          "read",
          ({ view }) => {
            const sandboxPort = context.getMcpAppSandboxPort?.();
            if (sandboxPort === undefined) {
              throw new Error("MCP App sandbox listener is unavailable; restart the Gateway");
            }
            const configuredOrigin = context.getRuntimeConfig().mcp?.apps?.sandboxOrigin;
            return {
              sandboxUrl: buildMcpAppSandboxPath(view.csp),
              sandboxPort,
              ...(configuredOrigin ? { sandboxOrigin: new URL(configuredOrigin).origin } : {}),
              html: view.html,
              ...(view.csp ? { csp: view.csp } : {}),
              toolInput: view.toolInput,
              toolResult: view.toolResult,
            };
          },
          context.getRuntimeConfig(),
        ),
    );
  },
  "mcp.app.callTool": async ({ respond, params }) => {
    await handle(
      respond,
      async () =>
        await withActiveView(params, "tool", async ({ runtime, view }) => {
          const toolName = requireString(params, "toolName");
          await requireCallableTool(runtime, view, toolName);
          return await runtime.callTool(view.serverName, toolName, params.arguments ?? {});
        }),
    );
  },
  "mcp.app.listTools": async ({ respond, params }) => {
    await handle(
      respond,
      async () =>
        await withActiveView(params, "read", async ({ runtime, view }) => {
          if (!runtime.listTools) {
            throw new Error("MCP tools/list is unavailable");
          }
          const [listed, catalog] = await Promise.all([
            runtime.listTools(view.serverName, optionalCursor(params)),
            runtime.getCatalog(),
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
          return {
            ...listed,
            tools: listed.tools.filter(
              (tool) => allowed.has(tool.name.trim()) && isAppCallableListedTool(tool),
            ),
          };
        }),
    );
  },
  "mcp.app.listResources": async ({ respond, params }) => {
    await handle(
      respond,
      async () =>
        await withActiveView(params, "read", async ({ runtime, view }) => {
          if (!runtime.listResources) {
            throw new Error("MCP resources/list is unavailable");
          }
          const resources = await runtime.listResources(view.serverName);
          return Array.isArray(resources) ? { resources } : resources;
        }),
    );
  },
  "mcp.app.listResourceTemplates": async ({ respond, params }) => {
    await handle(
      respond,
      async () =>
        await withActiveView(params, "read", async ({ runtime, view }) => {
          if (!runtime.listResourceTemplates) {
            throw new Error("MCP resources/templates/list is unavailable");
          }
          return await runtime.listResourceTemplates(view.serverName, optionalCursor(params));
        }),
    );
  },
  "mcp.app.readResource": async ({ respond, params }) => {
    await handle(
      respond,
      async () =>
        await withActiveView(params, "read", async ({ runtime, view }) => {
          if (!runtime.readResource) {
            throw new Error("MCP resources/read is unavailable");
          }
          return await runtime.readResource(view.serverName, requireString(params, "uri"));
        }),
    );
  },
};
