import {
  ErrorCodes,
  errorShape,
  GatewayErrorDetailCodes,
} from "../../../packages/gateway-protocol/src/index.js";
import { updateMcpAppModelContext } from "../../agents/mcp-app-model-context.js";
import { buildMcpAppSandboxPath } from "../../agents/mcp-app-sandbox.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { logWarn } from "../../logger.js";
import {
  executeMcpAppOperation,
  McpAppViewExpiredError,
  type McpAppOperation,
  requireMcpAppInteraction,
  resolveMcpAppActiveView,
  withMcpAppActiveView,
} from "../mcp-app-operations.js";
import { createMcpAppStandaloneTicket } from "../mcp-app-standalone.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
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

class McpAppRequestError extends Error {
  constructor(readonly shape: ReturnType<typeof errorShape>) {
    super(shape.message);
  }
}

function resolveMcpAppSessionOwner(params: Record<string, unknown>, cfg: OpenClawConfig): string {
  const sessionKey = requireString(params, "sessionKey");
  const explicitAgentId =
    typeof params.agentId === "string" && params.agentId.trim() ? params.agentId.trim() : undefined;
  const owner = resolveRequestedSessionAgentId(cfg, sessionKey, explicitAgentId);
  if (!owner.ok) {
    throw new McpAppRequestError(owner.error);
  }
  return owner.agentId;
}

async function runOperation(
  params: Record<string, unknown>,
  operation: McpAppOperation,
  cfg: OpenClawConfig,
): Promise<unknown> {
  const active = await resolveMcpAppActiveView({
    sessionKey: requireString(params, "sessionKey"),
    agentId: resolveMcpAppSessionOwner(params, cfg),
    viewId: requireString(params, "viewId"),
  });
  return await executeMcpAppOperation(active, operation);
}

async function handle(
  respond: Parameters<GatewayRequestHandlers[string]>[0]["respond"],
  operation: () => Promise<unknown>,
) {
  try {
    respond(true, await operation());
  } catch (error) {
    respond(
      false,
      undefined,
      error instanceof McpAppRequestError
        ? error.shape
        : errorShape(
            ErrorCodes.UNAVAILABLE,
            formatErrorMessage(error),
            error instanceof McpAppViewExpiredError
              ? { details: { code: GatewayErrorDetailCodes.MCP_APP_VIEW_EXPIRED } }
              : undefined,
          ),
    );
  }
}

export const mcpAppHandlers: GatewayRequestHandlers = {
  "mcp.app.view": async ({ respond, params, context }) => {
    await handle(respond, async () => {
      const active = await resolveMcpAppActiveView({
        sessionKey: requireString(params, "sessionKey"),
        agentId: resolveMcpAppSessionOwner(params, context.getRuntimeConfig()),
        viewId: requireString(params, "viewId"),
        cfg: context.getRuntimeConfig(),
      });
      return await withMcpAppActiveView(active, "read", async () => {
        const { view } = active;
        let interactive = false;
        try {
          await requireMcpAppInteraction(view);
          interactive = true;
        } catch {
          // Stale board leases remain renderable but lose every interactive capability.
        }
        const updateModelContextSupported =
          interactive && active.runtime.mcpAppModelContextRevoked !== true;
        const sandboxPort =
          context.getMcpAppSandboxPort?.() ?? (await context.ensureSandboxHostPort?.());
        if (sandboxPort === undefined) {
          throw new Error("MCP App sandbox listener is unavailable; restart the Gateway");
        }
        const configuredOrigin = context.getRuntimeConfig().mcp?.apps?.sandboxOrigin;
        let standalone: ReturnType<typeof createMcpAppStandaloneTicket> = undefined;
        try {
          standalone = createMcpAppStandaloneTicket({
            sessionKey: requireString(params, "sessionKey"),
            view,
          });
        } catch (error) {
          // Standalone links are additive; issuance must never break the
          // existing authenticated Control UI view payload.
          logWarn(`mcp-app: standalone ticket unavailable: ${formatErrorMessage(error)}`);
        }
        return {
          sandboxUrl: buildMcpAppSandboxPath(view.csp),
          sandboxPort,
          ...(configuredOrigin ? { sandboxOrigin: new URL(configuredOrigin).origin } : {}),
          html: view.html,
          ...(view.csp ? { csp: view.csp } : {}),
          toolInput: view.toolInput,
          toolResult: view.toolResult,
          ...(standalone
            ? {
                standaloneUrl: standalone.url,
                standaloneExpiresAtMs: standalone.expiresAtMs,
              }
            : {}),
          // Reconstruction marks views read-only; fresh runs may legitimately grant zero App tools.
          messageSupported: interactive,
          updateModelContextSupported,
        };
      });
    });
  },
  "mcp.app.updateModelContext": async ({ respond, params, context }) => {
    await handle(respond, async () => {
      const active = await resolveMcpAppActiveView({
        sessionKey: requireString(params, "sessionKey"),
        agentId: resolveMcpAppSessionOwner(params, context.getRuntimeConfig()),
        viewId: requireString(params, "viewId"),
      });
      return await withMcpAppActiveView(active, "read", async () => {
        await requireMcpAppInteraction(active.view);
        updateMcpAppModelContext(active.runtime, active.view, params);
        return {};
      });
    });
  },
  "mcp.app.callTool": async ({ respond, params, context }) => {
    await handle(
      respond,
      async () =>
        await runOperation(
          params,
          {
            method: "tools/call",
            params: {
              name: requireString(params, "toolName"),
              arguments: (params.arguments ?? {}) as Record<string, unknown>,
            },
          },
          context.getRuntimeConfig(),
        ),
    );
  },
  "mcp.app.listTools": async ({ respond, params, context }) => {
    await handle(
      respond,
      async () =>
        await runOperation(
          params,
          { method: "tools/list", params: optionalCursor(params) ?? {} },
          context.getRuntimeConfig(),
        ),
    );
  },
  "mcp.app.listResources": async ({ respond, params, context }) => {
    await handle(
      respond,
      async () =>
        await runOperation(
          params,
          {
            method: "resources/list",
            params: optionalCursor(params) ?? {},
          },
          context.getRuntimeConfig(),
        ),
    );
  },
  "mcp.app.listResourceTemplates": async ({ respond, params, context }) => {
    await handle(
      respond,
      async () =>
        await runOperation(
          params,
          {
            method: "resources/templates/list",
            params: optionalCursor(params) ?? {},
          },
          context.getRuntimeConfig(),
        ),
    );
  },
  "mcp.app.readResource": async ({ respond, params, context }) => {
    await handle(
      respond,
      async () =>
        await runOperation(
          params,
          {
            method: "resources/read",
            params: { uri: requireString(params, "uri") },
          },
          context.getRuntimeConfig(),
        ),
    );
  },
};
