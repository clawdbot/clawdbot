import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InternalHookEvent } from "../hooks/internal-hooks.js";

type TriggerInternalHookMock = (event: InternalHookEvent) => Promise<void>;

const mocks = {
  logWarn: vi.fn(),
  disposeAgentHarnesses: vi.fn(async () => undefined),
  disposeAllSessionMcpRuntimes: vi.fn(async () => undefined),
  triggerInternalHook: vi.fn<TriggerInternalHookMock>(async (_event) => undefined),
  disposeAllBundleLspRuntimes: vi.fn(async () => undefined),
};
const WEBSOCKET_CLOSE_GRACE_MS = 1_000;
const WEBSOCKET_CLOSE_FORCE_CONTINUE_MS = 250;
const HTTP_CLOSE_GRACE_MS = 1_000;
const HTTP_CLOSE_FORCE_WAIT_MS = 5_000;
const GATEWAY_LIFECYCLE_HOOK_TIMEOUT_MS = 1_000;

vi.mock("../channels/plugins/index.js", async () => ({
  ...(await vi.importActual<typeof import("../channels/plugins/index.js")>(
    "../channels/plugins/index.js",
  )),
  listChannelPlugins: () => [],
}));

vi.mock("../hooks/gmail-watcher.js", () => ({
  stopGmailWatcher: vi.fn(async () => undefined),
}));

vi.mock("../hooks/internal-hooks.js", async () => {
  const actual = await vi.importActual<typeof import("../hooks/internal-hooks.js")>(
    "../hooks/internal-hooks.js",
  );
  return {
    ...actual,
    triggerInternalHook: mocks.triggerInternalHook,
  };
});

vi.mock("../agents/harness/registry.js", () => ({
  disposeRegisteredAgentHarnesses: mocks.disposeAgentHarnesses,
}));

vi.mock("../agents/pi-bundle-mcp-tools.js", async () => ({
  ...(await vi.importActual<typeof import("../agents/pi-bundle-mcp-tools.js")>(
    "../agents/pi-bundle-mcp-tools.js",
  )),
  disposeAllSessionMcpRuntimes: mocks.disposeAllSessionMcpRuntimes,
}));

vi.mock("../agents/pi-bundle-lsp-runtime.js", async () => ({
  ...(await vi.importActual<typeof import("../agents/pi-bundle-lsp-runtime.js")>(
    "../agents/pi-bundle-lsp-runtime.js",
  )),
  disposeAllBundleLspRuntimes: mocks.disposeAllBundleLspRuntimes,
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: vi.fn(() => ({
    warn: mocks.logWarn,
  })),
}));

const { createGatewayCloseHandler } = await import("./server-close.js");
type GatewayCloseHandlerParams = Parameters<typeof createGatewayCloseHandler>[0];
type GatewayCloseClient = GatewayCloseHandlerParams["clients"] extends Set<infer T> ? T : never;

function createGatewayCloseTestDeps(
  overrides: Partial<GatewayCloseHandlerParams> = {},
): GatewayCloseHandlerParams {
  return {
    bonjourStop: null,
    tailscaleCleanup: null,
    canvasHost: null,
    canvasHostServer: null,
    stopChannel: vi.fn(async () => undefined),
    pluginServices: null,
    cron: { stop: vi.fn() },
    heartbeatRunner: { stop: vi.fn() } as never,
    updateCheckStop: null,
    stopTaskRegistryMaintenance: null,
    nodePresenceTimers: new Map(),
    broadcast: vi.fn(),
    tickInterval: setInterval(() => undefined, 60_000),
    healthInterval: setInterval(() => undefined, 60_000),
    dedupeCleanup: setInterval(() => undefined, 60_000),
    mediaCleanup: null,
    agentUnsub: null,
    heartbeatUnsub: null,
    transcriptUnsub: null,
    lifecycleUnsub: null,
    chatRunState: { clear: vi.fn() },
    clients: new Set<GatewayCloseClient>(),
    configReloader: { stop: vi.fn(async () => undefined) },
    wss: {
      clients: new Set(),
      close: (cb: () => void) => cb(),
    } as never,
    httpServer: {
      close: (cb: (err?: Error | null) => void) => cb(null),
      closeIdleConnections: vi.fn(),
    } as never,
    ...overrides,
  };
}

describe("createGatewayCloseHandler", () => {
  beforeEach(() => {
    vi.useRealTimers();
    mocks.logWarn.mockClear();
    mocks.disposeAgentHarnesses.mockClear();
    mocks.disposeAllSessionMcpRuntimes.mockClear();
    mocks.disposeAllSessionMcpRuntimes.mockResolvedValue(undefined);
    mocks.triggerInternalHook.mockReset();
    mocks.triggerInternalHook.mockResolvedValue(undefined);
    mocks.disposeAllBundleLspRuntimes.mockClear();
    mocks.disposeAllBundleLspRuntimes.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits gateway shutdown and pre-restart hooks", async () => {
    const close = createGatewayCloseHandler(createGatewayCloseTestDeps());

    await close({ reason: "gateway restarting", restartExpectedMs: 123 });

    const hookCalls = mocks.triggerInternalHook.mock.calls as unknown as Array<
      [{ type?: string; action?: string; context?: Record<string, unknown> }]
    >;
    const shutdownEvent = hookCalls.find(
      ([event]) => event?.type === "gateway" && event?.action === "shutdown",
    )?.[0];
    const preRestartEvent = hookCalls.find(
      ([event]) => event?.type === "gateway" && event?.action === "pre-restart",
    )?.[0];

    expect(shutdownEvent?.context).toMatchObject({
      reason: "gateway restarting",
      restartExpectedMs: 123,
    });
    expect(preRestartEvent?.context).toMatchObject({
      reason: "gateway restarting",
      restartExpectedMs: 123,
    });
  });

  it("continues shutdown when gateway shutdown hook stalls", async () => {
    vi.useFakeTimers();
    mocks.triggerInternalHook.mockImplementation((event: InternalHookEvent) => {
      if (event.action === "shutdown") {
        return new Promise<void>(() => undefined);
      }
      return Promise.resolve(undefined);
    });
    const stopTaskRegistryMaintenance = vi.fn();
    const close = createGatewayCloseHandler(
      createGatewayCloseTestDeps({ stopTaskRegistryMaintenance }),
    );

    const closePromise = close({ reason: "test shutdown" });
    await vi.advanceTimersByTimeAsync(GATEWAY_LIFECYCLE_HOOK_TIMEOUT_MS);
    await closePromise;

    expect(stopTaskRegistryMaintenance).toHaveBeenCalledTimes(1);
    expect(
      mocks.logWarn.mock.calls.some(([message]) =>
        String(message).includes("gateway:shutdown hook timed out after 1000ms"),
      ),
    ).toBe(true);
  });

  it("continues restart shutdown when gateway pre-restart hook stalls", async () => {
    vi.useFakeTimers();
    mocks.triggerInternalHook.mockImplementation((event: InternalHookEvent) => {
      if (event.action === "pre-restart") {
        return new Promise<void>(() => undefined);
      }
      return Promise.resolve(undefined);
    });
    const stopTaskRegistryMaintenance = vi.fn();
    const close = createGatewayCloseHandler(
      createGatewayCloseTestDeps({ stopTaskRegistryMaintenance }),
    );

    const closePromise = close({
      reason: "test restart",
      restartExpectedMs: 123,
    });
    await vi.advanceTimersByTimeAsync(GATEWAY_LIFECYCLE_HOOK_TIMEOUT_MS);
    await closePromise;

    expect(stopTaskRegistryMaintenance).toHaveBeenCalledTimes(1);
    expect(mocks.triggerInternalHook).toHaveBeenCalledTimes(2);
    expect(
      mocks.logWarn.mock.calls.some(([message]) =>
        String(message).includes("gateway:pre-restart hook timed out after 1000ms"),
      ),
    ).toBe(true);
  });

  it("unsubscribes lifecycle listeners during shutdown", async () => {
    const lifecycleUnsub = vi.fn();
    const stopTaskRegistryMaintenance = vi.fn();
    const close = createGatewayCloseHandler(
      createGatewayCloseTestDeps({
        stopTaskRegistryMaintenance,
        lifecycleUnsub,
      }),
    );

    await close({ reason: "test shutdown" });

    expect(lifecycleUnsub).toHaveBeenCalledTimes(1);
    expect(stopTaskRegistryMaintenance).toHaveBeenCalledTimes(1);
    expect(mocks.disposeAgentHarnesses).toHaveBeenCalledTimes(1);
    expect(mocks.disposeAllSessionMcpRuntimes).toHaveBeenCalledTimes(1);
    expect(mocks.disposeAllBundleLspRuntimes).toHaveBeenCalledTimes(1);
  });

  it("starts bundle MCP and LSP runtime disposal concurrently", async () => {
    const disposalOrder: string[] = [];
    let releaseMcp: (() => void) | undefined;
    const mcpBlocked = new Promise<void>((resolve) => {
      releaseMcp = resolve;
    });
    mocks.disposeAllSessionMcpRuntimes.mockImplementation(async () => {
      disposalOrder.push("mcp-start");
      await mcpBlocked;
      disposalOrder.push("mcp-end");
    });
    mocks.disposeAllBundleLspRuntimes.mockImplementation(async () => {
      disposalOrder.push("lsp-start");
    });
    const close = createGatewayCloseHandler(createGatewayCloseTestDeps());

    const closePromise = close({ reason: "test shutdown" });
    try {
      await vi.waitFor(() => {
        expect(disposalOrder).toContain("lsp-start");
      });
      expect(disposalOrder).toEqual(["mcp-start", "lsp-start"]);
    } finally {
      releaseMcp?.();
      await closePromise;
    }
  });

  it("continues shutdown when bundle MCP runtime disposal hangs", async () => {
    vi.useFakeTimers();
    mocks.disposeAllSessionMcpRuntimes.mockReturnValue(new Promise(() => undefined));
    const close = createGatewayCloseHandler(createGatewayCloseTestDeps());

    const closePromise = close({ reason: "test shutdown" });
    await vi.advanceTimersByTimeAsync(5_000);
    await closePromise;

    expect(
      mocks.logWarn.mock.calls.some(([message]) =>
        String(message).includes("bundle-mcp runtime disposal exceeded 5000ms"),
      ),
    ).toBe(true);
  });

  it("continues shutdown when bundle LSP runtime disposal hangs", async () => {
    vi.useFakeTimers();
    mocks.disposeAllBundleLspRuntimes.mockReturnValue(new Promise(() => undefined));
    const close = createGatewayCloseHandler(createGatewayCloseTestDeps());

    const closePromise = close({ reason: "test shutdown" });
    await vi.advanceTimersByTimeAsync(5_000);
    await closePromise;

    expect(
      mocks.logWarn.mock.calls.some(([message]) =>
        String(message).includes("bundle-lsp runtime disposal exceeded 5000ms"),
      ),
    ).toBe(true);
  });

  it("terminates lingering websocket clients when websocket close exceeds the grace window", async () => {
    vi.useFakeTimers();

    let closeCallback: (() => void) | null = null;
    const terminate = vi.fn(() => {
      closeCallback?.();
    });
    const close = createGatewayCloseHandler(
      createGatewayCloseTestDeps({
        wss: {
          clients: new Set([{ terminate }]),
          close: (cb: () => void) => {
            closeCallback = cb;
          },
        } as never,
      }),
    );

    const closePromise = close({ reason: "test shutdown" });
    await vi.advanceTimersByTimeAsync(WEBSOCKET_CLOSE_GRACE_MS);
    await closePromise;

    expect(terminate).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(
      mocks.logWarn.mock.calls.some(([message]) =>
        String(message).includes("websocket server close exceeded 1000ms"),
      ),
    ).toBe(true);
  });

  it("continues shutdown when websocket close hangs without tracked clients", async () => {
    vi.useFakeTimers();

    const close = createGatewayCloseHandler(
      createGatewayCloseTestDeps({
        wss: {
          clients: new Set(),
          close: () => undefined,
        } as never,
      }),
    );

    const closePromise = close({ reason: "test shutdown" });
    await vi.advanceTimersByTimeAsync(WEBSOCKET_CLOSE_GRACE_MS + WEBSOCKET_CLOSE_FORCE_CONTINUE_MS);
    await closePromise;

    expect(vi.getTimerCount()).toBe(0);
    expect(
      mocks.logWarn.mock.calls.some(([message]) =>
        String(message).includes("websocket server close still pending after 250ms force window"),
      ),
    ).toBe(true);
  });

  it("forces lingering HTTP connections closed when server close exceeds the grace window", async () => {
    vi.useFakeTimers();

    let closeCallback: ((err?: Error | null) => void) | null = null;
    const closeAllConnections = vi.fn(() => {
      closeCallback?.(null);
    });
    const close = createGatewayCloseHandler(
      createGatewayCloseTestDeps({
        httpServer: {
          close: (cb: (err?: Error | null) => void) => {
            closeCallback = cb;
          },
          closeAllConnections,
          closeIdleConnections: vi.fn(),
        } as never,
      }),
    );

    const closePromise = close({ reason: "test shutdown" });
    await vi.advanceTimersByTimeAsync(HTTP_CLOSE_GRACE_MS);
    await closePromise;

    expect(closeAllConnections).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(
      mocks.logWarn.mock.calls.some(([message]) =>
        String(message).includes("http server close exceeded 1000ms"),
      ),
    ).toBe(true);
  });

  it("fails shutdown when http server close still hangs after force close", async () => {
    vi.useFakeTimers();

    const close = createGatewayCloseHandler(
      createGatewayCloseTestDeps({
        httpServer: {
          close: () => undefined,
          closeAllConnections: vi.fn(),
          closeIdleConnections: vi.fn(),
        } as never,
      }),
    );

    const closePromise = close({ reason: "test shutdown" });
    const closeExpectation = expect(closePromise).rejects.toThrow(
      "http server close still pending after forced connection shutdown (5000ms)",
    );
    await vi.advanceTimersByTimeAsync(HTTP_CLOSE_GRACE_MS + HTTP_CLOSE_FORCE_WAIT_MS);
    await closeExpectation;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores unbound http servers during shutdown", async () => {
    const close = createGatewayCloseHandler({
      bonjourStop: null,
      tailscaleCleanup: null,
      canvasHost: null,
      canvasHostServer: null,
      stopChannel: vi.fn(async () => undefined),
      pluginServices: null,
      cron: { stop: vi.fn() },
      heartbeatRunner: { stop: vi.fn() } as never,
      updateCheckStop: null,
      nodePresenceTimers: new Map(),
      broadcast: vi.fn(),
      tickInterval: setInterval(() => undefined, 60_000),
      healthInterval: setInterval(() => undefined, 60_000),
      dedupeCleanup: setInterval(() => undefined, 60_000),
      mediaCleanup: null,
      agentUnsub: null,
      heartbeatUnsub: null,
      transcriptUnsub: null,
      lifecycleUnsub: null,
      chatRunState: { clear: vi.fn() },
      clients: new Set(),
      configReloader: { stop: vi.fn(async () => undefined) },
      wss: { close: (cb: () => void) => cb() } as never,
      httpServer: {
        close: (cb: (err?: NodeJS.ErrnoException | null) => void) =>
          cb(
            Object.assign(new Error("Server is not running."), { code: "ERR_SERVER_NOT_RUNNING" }),
          ),
        closeIdleConnections: vi.fn(),
      } as never,
    });

    await expect(close({ reason: "startup failed before bind" })).resolves.toBeUndefined();
  });
});
