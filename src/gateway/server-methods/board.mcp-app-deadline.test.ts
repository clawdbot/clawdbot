import { describe, expect, it, vi } from "vitest";
import { withMcpAppActiveView } from "../mcp-app-operations.js";
import { createBoardHarness, createMcpAppDependencies } from "./board.test-support.js";

describe("board MCP App deadlines", () => {
  it("releases view and runtime leases when pin authorization exceeds the deadline", async () => {
    const controller = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const releaseRuntimeLease = vi.fn();
    const activeRuntime = {
      sessionId: "board-deadline",
      markUsed: vi.fn(),
      acquireLease: vi.fn(() => releaseRuntimeLease),
      getCatalog: vi.fn(async () => ({ tools: [] })),
    };
    const authorizeAppInteraction = vi.fn(() => new Promise<boolean>(() => {}));
    const activeView = {
      viewId: "mcp-app-deadline",
      runtime: activeRuntime,
      sessionId: activeRuntime.sessionId,
      serverName: "server",
      toolName: "tool",
      uiResourceUri: "ui://resource",
      toolCallId: "call",
      html: "<p>app</p>",
      allowedAppToolNames: new Set(["server.refresh"]),
      authorizeAppInteraction,
      toolInput: {},
      toolResult: { content: [] },
      operationTimeoutMs: 1_000,
      expiresAtMs: Date.now() + 60_000,
      requestWindowStartedAtMs: Date.now(),
      requestCount: 0,
      toolCallCount: 0,
      activeRequests: 0,
      byteSize: 0,
    };
    const dependencies = createMcpAppDependencies();
    vi.mocked(dependencies.resolveActiveView).mockResolvedValueOnce({
      runtime: activeRuntime,
      view: activeView,
    } as never);
    const { invoke, store } = createBoardHarness(undefined, {
      ...dependencies,
      withActiveView: withMcpAppActiveView,
    });

    try {
      const invocation = invoke("board.widget.put", {
        sessionKey: "agent:main:main",
        name: "deadline-app",
        content: { kind: "mcp-app", viewId: activeView.viewId },
      });
      await vi.waitFor(() => expect(authorizeAppInteraction).toHaveBeenCalledOnce());
      expect(activeView.activeRequests).toBe(1);

      controller.abort(new Error("MCP App operation timed out"));
      await expect(
        Promise.race([
          invocation.then(() => "settled"),
          new Promise<string>((resolve) => {
            setTimeout(() => resolve("pending"), 50);
          }),
        ]),
      ).resolves.toBe("settled");

      const respond = await invocation;
      expect(respond.mock.calls[0]?.[0]).toBe(false);
      expect(activeView.activeRequests).toBe(0);
      expect(releaseRuntimeLease).toHaveBeenCalledOnce();
      expect(store.getSnapshot("agent:main:main").widgets).toEqual([]);
    } finally {
      timeoutSpy.mockRestore();
    }
  });
});
