import { vi } from "vitest";
import { InMemoryBoardStore } from "../../boards/board-store.js";
import { createBoardHandlers } from "./board.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

type BoardHandlerDependencies = NonNullable<Parameters<typeof createBoardHandlers>[3]>;
type BoardMcpAppDependencies = {
  resolveActiveView: NonNullable<BoardHandlerDependencies["resolveActiveView"]>;
  resolveAllowedToolNames: NonNullable<BoardHandlerDependencies["resolveAllowedToolNames"]>;
  mintFromTranscript: NonNullable<BoardHandlerDependencies["mintFromTranscript"]>;
};

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
  store: InMemoryBoardStore = new InMemoryBoardStore(),
  contextOverrides: Partial<GatewayRequestContext> = {},
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
  const invoke = async (method: string, params: Record<string, unknown>) => {
    const respond = vi.fn<RespondFn>();
    await handlers[method]!({
      req: { type: "req", id: "test", method, params },
      params,
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: {
        broadcast,
        getMcpAppSandboxPort: () => 18790,
        getRuntimeConfig: () => ({ mcp: { apps: { enabled: true } } }),
        ...contextOverrides,
      } as unknown as GatewayRequestContext,
    });
    return respond;
  };
  return { store, broadcast, invoke, mcpApp };
}
