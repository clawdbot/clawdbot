import { vi } from "vitest";
import type { BoardStore } from "../../boards/board-store.js";
import { createTestBoardStore } from "../../boards/board-store.test-support.js";
import { createBoardHandlers } from "./board.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

type BoardHandlerDependencies = NonNullable<Parameters<typeof createBoardHandlers>[3]>;
type BoardMcpAppDependencies = {
  resolveActiveView: NonNullable<BoardHandlerDependencies["resolveActiveView"]>;
  resolveAllowedToolNames: NonNullable<BoardHandlerDependencies["resolveAllowedToolNames"]>;
  mintFromTranscript: NonNullable<BoardHandlerDependencies["mintFromTranscript"]>;
};

const boardWidgetPermissionCases = [
  { permissionMode: "full", grantState: "granted" },
  { permissionMode: "workspace", reviewDecision: "allow-once", grantState: "granted" },
  {
    permissionMode: "workspace",
    reviewDecision: "allow-once",
    reviewRisk: "high",
    grantState: "rejected",
  },
  { permissionMode: "workspace", reviewDecision: "ask", grantState: "rejected" },
  { permissionMode: "workspace", reviewFailure: true, grantState: "rejected" },
  { permissionMode: "guarded", grantState: "pending" },
  { permissionMode: "read-only", grantState: "rejected" },
  { mode: "full", grantState: "granted" },
  { mode: "auto", reviewDecision: "allow-once", grantState: "granted" },
  { mode: "auto", reviewDecision: "ask", grantState: "rejected" },
  { mode: "ask", grantState: "pending" },
  { mode: "allowlist", grantState: "rejected" },
  { mode: "deny", grantState: "rejected" },
  { grantState: "granted" },
] as const;

export const boardWidgetContentPermissionCases = boardWidgetPermissionCases.flatMap((permission) =>
  (["html", "mcp-app"] as const).map((contentKind) => Object.assign({ contentKind }, permission)),
);

export function createMcpAppDependencies(): BoardMcpAppDependencies {
  let lease = 0;
  const runtime = { getCatalog: vi.fn() };
  return {
    resolveActiveView: vi.fn(async ({ viewId }: { viewId: string }) => ({
      runtime,
      view: {
        viewId,
        serverName: "server",
        toolName: "tool",
        uiResourceUri: "ui://resource",
        toolCallId: "call",
        allowedAppToolNames: new Set(["server.refresh", "server.search"]),
      },
    })),
    resolveAllowedToolNames: vi.fn(async () => ["server.refresh", "server.search"]),
    mintFromTranscript: vi.fn(async ({ readOnly }: { readOnly: boolean }) => {
      lease += 1;
      return {
        runtime,
        view: {
          viewId: `mcp-app-board-${lease}`,
          expiresAtMs: 10_000 + lease,
          ...(readOnly ? { readOnly: true as const } : {}),
        },
      };
    }),
  } as unknown as BoardMcpAppDependencies;
}

export function createBoardHarness(
  readCanvasHtml?: Parameters<typeof createBoardHandlers>[2],
  dependencies: BoardHandlerDependencies = {},
  store: BoardStore = createTestBoardStore(),
  contextOverrides: Partial<GatewayRequestContext> = {},
  client: GatewayClient | null = null,
) {
  const defaults = createMcpAppDependencies();
  const mcpApp: BoardHandlerDependencies & BoardMcpAppDependencies = {
    ...dependencies,
    resolveActiveView: dependencies.resolveActiveView ?? defaults.resolveActiveView,
    resolveAllowedToolNames:
      dependencies.resolveAllowedToolNames ?? defaults.resolveAllowedToolNames,
    mintFromTranscript: dependencies.mintFromTranscript ?? defaults.mintFromTranscript,
  };
  const broadcast = vi.fn();
  const handlers = createBoardHandlers(store, undefined, readCanvasHtml, mcpApp);
  const context = {
    broadcast,
    getMcpAppSandboxPort: () => 18790,
    getSessionEventSubscriberConnIds: () => [],
    getRuntimeConfig: () => ({
      agents: { list: [{ id: "main" }] },
      mcp: { apps: { enabled: true } },
      tools: { exec: { mode: "ask" } },
    }),
    ...contextOverrides,
  } as unknown as GatewayRequestContext;
  context.resolveGatewayContext ??= () => context;
  const invoke = async (method: string, params: Record<string, unknown>) => {
    const respond = vi.fn<RespondFn>();
    await handlers[method]!({
      req: { type: "req", id: "test", method, params },
      params,
      client,
      isWebchatConnect: () => false,
      respond,
      context,
    });
    return respond;
  };
  return { store, broadcast, context, handlers, invoke, mcpApp };
}
