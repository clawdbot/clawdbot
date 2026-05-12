import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InternalHookEvent } from "../hooks/internal-hooks.js";

type TriggerInternalHookMock = (event: InternalHookEvent) => Promise<void>;

const mocks = {
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  listChannelPlugins: vi.fn((): Array<{ id: "telegram" | "discord" }> => []),
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
  listChannelPlugins: mocks.listChannelPlugins,
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
    info: mocks.logInfo,
    warn: mocks.logWarn,
  })),
}));

const { createGatewayCloseHandler } = await import("./server-close.js");
type GatewayCloseHandlerParams = Parameters<typeof createGatewayCloseHandler>[0];
type GatewayCloseClient = GatewayCloseHandlerParams["clients"] extends Set<infer T> ? T : never;
type DrainActiveSessionsForShutdown = NonNullable<
  GatewayCloseHandlerParams["drainActiveSessionsForShutdown"]
>;

function createGatewayCloseTestDeps(
  overrides: Partial<GatewayCloseHandlerParams> = {},
): GatewayCloseHandlerParams {
  return {
    bonjourStop: null,
    tailscaleCleanup: null,
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
    mocks.logInfo.mockClear();
    mocks.logWarn.mockClear();
    mocks.listChannelPlugins.mockReset();
    mocks.listChannelPlugins.mockReturnValue([]);
    mocks.disposeAgentHarnesses.mockClear();
    mocks.disposeAgentHarnesses.mockResolvedValue(undefined);
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

  it("completes a clean shutdown with a ShutdownResult", async () => {
    const deps = createGatewayCloseTestDeps();
    const close = createGatewayCloseHandler(deps);

    const result = await close({ reason: "test" });

    expect(result.warnings).toStrictEqual([]);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(deps.cron.stop).toHaveBeenCalledTimes(1);
    expect(deps.heartbeatRunner.stop).toHaveBeenCalledTimes(1);
    expect(deps.chatRunState.clear).toHaveBeenCalledTimes(1);
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

    expect(shutdownEvent?.context?.reason).toBe("gateway restarting");
    expect(shutdownEvent?.context?.restartExpectedMs).toBe(123);
    expect(preRestartEvent?.context?.reason).toBe("gateway restarting");
    expect(preRestartEvent?.context?.restartExpectedMs).toBe(123);
  });

  it("continues shutdown and records a warning when gateway shutdown hook stalls", async () => {
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
    const result = await closePromise;

    expect(result.warnings).toContain("gateway:shutdown");
    expect(stopTaskRegistryMaintenance).toHaveBeenCalledTimes(1);
    expect(
      mocks.logWarn.mock.calls.some(([message]) =>
        String(message).includes("gateway:shutdown hook timed out after 1000ms"),
      ),
    ).toBe(true);
  });

  it("drains the active-session tracker with reason=shutdown on SIGTERM/SIGINT close", async () => {
    const drainActiveSessionsForShutdown = vi.fn<DrainActiveSessionsForShutdown>(async () => ({
      emittedSessionIds: ["session-A", "session-B"],
      timedOut: false,
    }));
    const close = createGatewayCloseHandler(
      createGatewayCloseTestDeps({ drainActiveSessionsForShutdown }),
    );

    await close({ reason: "SIGTERM" });

    expect(drainActiveSessionsForShutdown).toHaveBeenCalledTimes(1);
    expect(drainActiveSessionsForShutdown.mock.calls[0]?.[0]?.reason).toBe("shutdown");
  });

  it("drains the active-session tracker with reason=restart when restartExpectedMs is set", async () => {
    const drainActiveSessionsForShutdown = vi.fn<DrainActiveSessionsForShutdown>(async () => ({
      emittedSessionIds: ["session-A"],
      timedOut: false,
    }));
    const close = createGatewayCloseHandler(
      createGatewayCloseTestDeps({ drainActiveSessionsForShutdown }),
    );

    await close({ reason: "gateway restarting", restartExpectedMs: 1234 });

    expect(drainActiveSessionsForShutdown).toHaveBeenCalledTimes(1);
    expect(drainActiveSessionsForShutdown.mock.calls[0]?.[0]?.reason).toBe("restart");
  });

  it("records a warning and continues shutdown when the session-end drain reports a timeout", async () => {
    const drainActiveSessionsForShutdown = vi.fn<DrainActiveSessionsForShutdown>(async () => ({
      emittedSessionIds: ["session-A"],
      timedOut: true,
    }));
    const close = createGatewayCloseHandler(
      createGatewayCloseTestDeps({ drainActiveSessionsForShutdown }),
    );

    const result = await close({ reason: "SIGTERM" });

    expect(drainActiveSessionsForShutdown).toHaveBeenCalledTimes(1);
    expect(result.warnings).toContain("session-end-drain");
    expect(
      mocks.logWarn.mock.calls.some(([message]) =>
        String(message).includes("session-end-drain timed out"),
      ),
    ).toBe(true);
  });

  it("skips the session-end drain step when no drain helper is provided", async () => {
    const close = createGatewayCloseHandler(createGatewayCloseTestDeps());

    const result = await close({ reason: "SIGTERM" });

    expect(result.warnings).not.toContain("session-end-drain");
  });

  it("continues restart shutdown and records a warning when gateway pre-restart hook stalls", async () => {
    vi.useFakeTimers();
    mocks.triggerInternalHook.mockImplementation((event: InternalHookEvent) => {
      if (event.action === "pre-restart") {
        return new Promise<void>(() => undefined);
      }
      return Promise.resolve(undefined);
    });
    const close = createGatewayCloseHandler(createGatewayCloseTestDeps());

    const closePromise = close({
      reason: "test restart",
      restartExpectedMs: 123,
    });
    await vi.advanceTimersByTimeAsync(GATEWAY_LIFECYCLE_HOOK_TIMEOUT_MS);
    const result = await closePromise;

    expect(result.warnings).toContain("gateway:pre-restart");
    expect(mocks.triggerInternalHook).toHaveBeenCalledTimes(2);
  });

  it("records subsystem shutdown warnings without aborting later cleanup", async () => {
    mocks.listChannelPlugins.mockReturnValue([{ id: "telegram" }, { id: "discord" }]);
    const lifecycleUnsub = vi.fn();
    const stopChannel = vi.fn(async (id: string) => {
      if (id === "telegram") {
        throw new Error("telegram stuck");
      }
    });
    const close = createGatewayCloseHandler(
      createGatewayCloseTestDeps({
        bonjourStop: vi.fn(async () => {
          throw new Error("mdns unavailable");
        }),
        lifecycleUnsub,
        stopChannel,
      }),
    );

    const result = await close({ reason: "test shutdown" });

    expect(result.warnings).toContain("bonjour");
    expect(result.warnings).toContain("channel/telegram");
    expect(result.warnings).not.toContain("channel/discord");
    expect(lifecycleUnsub).toHaveBeenCalledTimes(1);
    expect(stopChannel).toHaveBeenCalledTimes(2);
  });

  it("uses caller-provided channel ids instead of the local channel registry", async () => {
    mocks.listChannelPlugins.mockReturnValue([]);
    const stopChannel = vi.fn(async (_id: string) => undefined);
    const close = createGatewayCloseHandler(
      createGatewayCloseTestDeps({
        channelIds: ["telegram", "discord"],
        stopChannel,
      }),
    );

    await close({ reason: "test shutdown" });

    expect(mocks.listChannelPlugins).not.toHaveBeenCalled();
    expect(stopChannel.mock.calls.map(([id]) => id)).toEqual(["telegram", "discord"]);
  });

  it("unsubscribes lifecycle listeners and disposes bundle runtimes during shutdown", async () => {
    const lifecycleUnsub = vi.fn();
    const transcriptUnsub = vi.fn();
    const stopTaskRegistryMaintenance = vi.fn();
    const close = createGatewayCloseHandler(
      createGatewayCloseTestDeps({
        stopTaskRegistryMaintenance,
        lifecycleUnsub,
        transcriptUnsub,
      }),
    );

    await close({ reason: "test shutdown" });

    expect(lifecycleUnsub).toHaveBeenCalledTimes(1);
    expect(transcriptUnsub).toHaveBeenCalledTimes(1);
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

  it("continues shutdown and records a warning when bundle MCP runtime disposal hangs", async () => {
    vi.useFakeTimers();
    mocks.disposeAllSessionMcpRuntimes.mockReturnValue(new Promise(() => undefined));
    const close = createGatewayCloseHandler(createGatewayCloseTestDeps());

    const closePromise = close({ reason: "test shutdown" });
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await closePromise;

    expect(result.warnings).toContain("bundle-mcp");
    expect(
      mocks.logWarn.mock.calls.some(([message]) =>
        String(message).includes("bundle-mcp runtime disposal exceeded 5000ms"),
      ),
    ).toBe(true);
  });

  it("continues shutdown and records a warning when bundle LSP runtime disposal hangs", async () => {
    vi.useFakeTimers();
    mocks.disposeAllBundleLspRuntimes.mockReturnValue(new Promise(() => undefined));
    const close = createGatewayCloseHandler(createGatewayCloseTestDeps());

    const closePromise = close({ reason: "test shutdown" });
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await closePromise;

    expect(result.warnings).toContain("bundle-lsp");
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
    const result = await closePromise;

    expect(result.warnings).toContain("websocket-server");
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
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
    const result = await closePromise;

    expect(result.warnings).toContain("websocket-server");
    expect(vi.getTimerCount()).toBe(0);
    expect(
      mocks.logWarn.mock.calls.some(([message]) =>
        String(message).includes("websocket server close still pending after 250ms force window"),
      ),
    ).toBe(true);
  });

  it("records a warning when a websocket client close throws", async () => {
    const clients = new Set<GatewayCloseClient>([
      {
        socket: {
          close: vi.fn(() => {
            throw new Error("already closed");
          }),
        },
      },
      { socket: { close: vi.fn() } },
    ]);
    const close = createGatewayCloseHandler(createGatewayCloseTestDeps({ clients }));

    const result = await close({ reason: "test shutdown" });

    expect(result.warnings).toContain("ws-clients");
    expect(clients.size).toBe(0);
  });

  it("records a warning when HTTP server close fails", async () => {
    const close = createGatewayCloseHandler(
      createGatewayCloseTestDeps({
        httpServer: {
          close: (cb: (err?: Error | null) => void) => cb(new Error("EADDRINUSE")),
          closeIdleConnections: vi.fn(),
        } as never,
      }),
    );

    const result = await close({ reason: "test shutdown" });

    expect(result.warnings).toContain("http-server");
  });

  it("forces lingering HTTP connections closed and records a timeout warning", async () => {
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
    const result = await closePromise;

    expect(result.warnings).toContain("http-server");
    expect(closeAllConnections).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(
      mocks.logWarn.mock.calls.some(([message]) =>
        String(message).includes("http-server close exceeded 1000ms"),
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
      "http-server close still pending after forced connection shutdown (5000ms)",
    );
    await vi.advanceTimersByTimeAsync(HTTP_CLOSE_GRACE_MS + HTTP_CLOSE_FORCE_WAIT_MS);
    await closeExpectation;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("labels warnings for multiple HTTP servers with their index", async () => {
    const okServer = {
      close: (cb: (err?: Error | null) => void) => cb(null),
      closeIdleConnections: vi.fn(),
    };
    const failServer = {
      close: (cb: (err?: Error | null) => void) => cb(new Error("port busy")),
      closeIdleConnections: vi.fn(),
    };
    const close = createGatewayCloseHandler(
      createGatewayCloseTestDeps({
        httpServers: [okServer as never, failServer as never],
      }),
    );

    const result = await close({ reason: "test shutdown" });

    expect(result.warnings).toContain("http-server[1]");
    expect(result.warnings).not.toContain("http-server[0]");
  });

  it("ignores unbound http servers during shutdown", async () => {
    const close = createGatewayCloseHandler(
      createGatewayCloseTestDeps({
        httpServer: {
          close: (cb: (err?: NodeJS.ErrnoException | null) => void) =>
            cb(
              Object.assign(new Error("Server is not running."), {
                code: "ERR_SERVER_NOT_RUNNING",
              }),
            ),
          closeIdleConnections: vi.fn(),
        } as never,
      }),
    );

    const result = await close({ reason: "startup failed before bind" });
    expect(result.warnings).toStrictEqual([]);
  });

  it("broadcasts normalized shutdown metadata", async () => {
    const deps = createGatewayCloseTestDeps();
    const close = createGatewayCloseHandler(deps);

    await close({ reason: "  upgrade  ", restartExpectedMs: Number.NaN });

    expect(deps.broadcast).toHaveBeenCalledWith("shutdown", {
      reason: "upgrade",
      restartExpectedMs: null,
    });
  });
});
