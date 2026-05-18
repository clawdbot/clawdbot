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
const GATEWAY_SHUTDOWN_HOOK_TIMEOUT_MS = 5_000;
const GATEWAY_PRE_RESTART_HOOK_TIMEOUT_MS = 10_000;

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
const { createChatRunState } = await import("./server-chat-state.js");
const {
  finishGatewayRestartTrace,
  recordGatewayRestartTraceSpan,
  resetGatewayRestartTraceForTest,
  startGatewayRestartTrace,
} = await import("./restart-trace.js");
type GatewayCloseHandlerParams = Parameters<typeof createGatewayCloseHandler>[0];
type GatewayCloseClient = GatewayCloseHandlerParams["clients"] extends Set<infer T> ? T : never;
type DrainActiveSessionsForShutdown = NonNullable<
  GatewayCloseHandlerParams["drainActiveSessionsForShutdown"]
>;
const originalRestartTraceEnv = process.env.OPENCLAW_GATEWAY_RESTART_TRACE;

function firstMockCall<T extends readonly unknown[]>(mock: { mock: { calls: readonly T[] } }) {
  return mock.mock.calls[0];
}

function createTestChatRunState() {
  const state = createChatRunState();
  const clear = state.clear;
  state.clear = vi.fn(() => clear());
  return state;
}

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
    chatRunState: createTestChatRunState(),
    chatAbortControllers: new Map(),
    removeChatRun: vi.fn(),
    agentRunSeq: new Map(),
    nodeSendToSession: vi.fn(),
    getPendingReplyCount: vi.fn(() => 0),
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
    resetGatewayRestartTraceForTest();
    if (originalRestartTraceEnv === undefined) {
      delete process.env.OPENCLAW_GATEWAY_RESTART_TRACE;
    } else {
      process.env.OPENCLAW_GATEWAY_RESTART_TRACE = originalRestartTraceEnv;
    }
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

  it("emits parseable restart close trace spans when enabled", async () => {
    process.env.OPENCLAW_GATEWAY_RESTART_TRACE = "1";
    const drainActiveSessionsForShutdown = vi.fn<DrainActiveSessionsForShutdown>(async () => ({
      emittedSessionIds: [],
      timedOut: false,
    }));
    const pluginServices = {
      stop: vi.fn(async () => undefined),
    };
    const close = createGatewayCloseHandler(
      createGatewayCloseTestDeps({
        channelIds: ["telegram"],
        drainActiveSessionsForShutdown,
        pluginServices: pluginServices as never,
      }),
    );

    startGatewayRestartTrace("restart.signal.received", [["reason", "test restart"]]);
    await close({ reason: "gateway restarting", restartExpectedMs: 123 });

    const messages = mocks.logInfo.mock.calls.map(([message]) => String(message));
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^restart trace: restart\.close\.gateway-shutdown-hook [0-9.]+ms total=[0-9.]+ms reason=gateway_restarting$/u,
        ),
        expect.stringMatching(
          /^restart trace: restart\.close\.gateway-pre-restart-hook [0-9.]+ms total=[0-9.]+ms reason=gateway_restarting$/u,
        ),
        expect.stringMatching(
          /^restart trace: restart\.close\.session-end-drain [0-9.]+ms total=[0-9.]+ms reason=gateway_restarting$/u,
        ),
        expect.stringMatching(
          /^restart trace: restart\.close\.channels [0-9.]+ms total=[0-9.]+ms reason=gateway_restarting$/u,
        ),
        expect.stringMatching(
          /^restart trace: restart\.close\.bundle-runtimes [0-9.]+ms total=[0-9.]+ms reason=gateway_restarting$/u,
        ),
        expect.stringMatching(
          /^restart trace: restart\.close\.plugin-services [0-9.]+ms total=[0-9.]+ms reason=gateway_restarting$/u,
        ),
        expect.stringMatching(
          /^restart trace: restart\.close\.gmail-watcher [0-9.]+ms total=[0-9.]+ms reason=gateway_restarting$/u,
        ),
        expect.stringMatching(
          /^restart trace: restart\.close\.websocket-server [0-9.]+ms total=[0-9.]+ms reason=gateway_restarting$/u,
        ),
        expect.stringMatching(
          /^restart trace: restart\.close\.http-server [0-9.]+ms total=[0-9.]+ms reason=gateway_restarting$/u,
        ),
      ]),
    );
    expect(
      messages.some(
        (message) =>
          /^restart trace: restart\.close\.total [0-9.]+ms total=[0-9.]+ms /u.test(message) &&
          message.includes("restartExpectedMs=123.0") &&
          message.includes("rssMb="),
      ),
    ).toBe(true);
  });

  it("emits restart ready child spans without shortening the parent ready span", async () => {
    process.env.OPENCLAW_GATEWAY_RESTART_TRACE = "1";

    startGatewayRestartTrace("restart.signal.received", [["reason", "test restart"]]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    recordGatewayRestartTraceSpan("restart.ready.runtime.post-attach", 12, 40, [
      ["eventLoopMax", "1.0ms"],
    ]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    finishGatewayRestartTrace("restart.ready");

    const messages = mocks.logInfo.mock.calls.map(([message]) => String(message));
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^restart trace: restart\.ready\.runtime\.post-attach 12\.0ms total=40\.0ms eventLoopMax=1\.0ms$/u,
        ),
      ]),
    );
    const parentReadyLine = messages.find((message) =>
      /^restart trace: restart\.ready [0-9.]+ms total=[0-9.]+ms$/u.test(message),
    );
    expect(parentReadyLine).toBeDefined();
    const parentDuration = Number(
      /^restart trace: restart\.ready ([0-9.]+)ms/u.exec(parentReadyLine ?? "")?.[1],
    );
    expect(parentDuration).toBeGreaterThan(30);
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
    await vi.advanceTimersByTimeAsync(GATEWAY_SHUTDOWN_HOOK_TIMEOUT_MS);
    const result = await closePromise;

    expect(result.warnings).toContain("gateway:shutdown");
    expect(stopTaskRegistryMaintenance).toHaveBeenCalledTimes(1);
    expect(
      mocks.logWarn.mock.calls.some(([message]) =>
        String(message).includes("gateway:shutdown hook timed out after 5000ms"),
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
    expect(firstMockCall(drainActiveSessionsForShutdown)?.[0]?.reason).toBe("shutdown");
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
    expect(firstMockCall(drainActiveSessionsForShutdown)?.[0]?.reason).toBe("restart");
  });

  it("drains pending restart replies before emitting session-end hooks", async () => {
    const order: string[] = [];
    const drainActiveSessionsForShutdown = vi.fn<DrainActiveSessionsForShutdown>(async () => {
      order.push("session-end");
      return {
        emittedSessionIds: ["session-A"],
        timedOut: false,
      };
    });
    const close = createGatewayCloseHandler(
      createGatewayCloseTestDeps({
        drainActiveSessionsForShutdown,
        getPendingReplyCount: () => {
          order.push("reply-drain");
          return 0;
        },
      }),
    );

    await close({ reason: "gateway restarting", restartExpectedMs: 123, drainTimeoutMs: 100 });

    expect(order).toStrictEqual(["reply-drain", "session-end"]);
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

  it("waits for pending replies to settle before restart shutdown", async () => {
    vi.useFakeTimers();
    let pendingReplies = 1;
    const close = createGatewayCloseHandler(
      createGatewayCloseTestDeps({
        getPendingReplyCount: () => pendingReplies,
      }),
    );

    const closePromise = close({
      reason: "gateway restarting",
      restartExpectedMs: 123,
      drainTimeoutMs: 200,
    });
    await vi.advanceTimersByTimeAsync(100);
    pendingReplies = 0;
    await vi.advanceTimersByTimeAsync(100);
    const result = await closePromise;

    expect(result.warnings).not.toContain("restart-reply-drain");
    expect(
      mocks.logInfo.mock.calls.some(([message]) =>
        String(message).includes("waiting for 1 pending reply(ies) before restart shutdown"),
      ),
    ).toBe(true);
    expect(
      mocks.logInfo.mock.calls.some(([message]) =>
        String(message).includes("restart reply drain completed after"),
      ),
    ).toBe(true);
  });

  it("aborts active chat runs when restart reply drain times out", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const agentController = new AbortController();
    const chatRunState = createChatRunState();
    chatRunState.buffers.set("run-1", "partial reply");
    chatRunState.deltaSentAt.set("run-1", Date.now());
    chatRunState.deltaLastBroadcastLen.set("run-1", 3);
    chatRunState.deltaLastBroadcastText.set("run-1", "par");
    chatRunState.agentDeltaSentAt.set("run-1:assistant", Date.now());
    chatRunState.bufferedAgentEvents.set("run-1:assistant", {
      sessionKey: "session-1",
      payload: {} as never,
    });
    const chatAbortControllers = new Map([
      [
        "run-1",
        {
          controller,
          sessionId: "run-1",
          sessionKey: "session-1",
          startedAtMs: Date.now(),
          expiresAtMs: Date.now() + 60_000,
        },
      ],
      [
        "agent-run-1",
        {
          controller: agentController,
          sessionId: "agent-run-1",
          sessionKey: "session-1",
          startedAtMs: Date.now(),
          expiresAtMs: Date.now() + 60_000,
          kind: "agent" as const,
        },
      ],
    ]);
    const broadcast = vi.fn();
    const nodeSendToSession = vi.fn();
    const close = createGatewayCloseHandler(
      createGatewayCloseTestDeps({
        broadcast,
        nodeSendToSession,
        chatRunState,
        chatAbortControllers,
        removeChatRun: vi.fn(() => ({ sessionKey: "session-1", clientRunId: "run-1" })),
      }),
    );

    const closePromise = close({
      reason: "gateway restarting",
      restartExpectedMs: 123,
      drainTimeoutMs: 100,
    });
    await vi.advanceTimersByTimeAsync(100);
    const result = await closePromise;

    expect(result.warnings).toContain("restart-reply-drain");
    expect(controller.signal.aborted).toBe(true);
    expect(agentController.signal.aborted).toBe(false);
    expect(chatAbortControllers.has("run-1")).toBe(false);
    expect(chatAbortControllers.has("agent-run-1")).toBe(true);
    expect(chatRunState.buffers.has("run-1")).toBe(false);
    expect(chatRunState.deltaSentAt.has("run-1")).toBe(false);
    expect(chatRunState.deltaLastBroadcastLen.has("run-1")).toBe(false);
    expect(chatRunState.deltaLastBroadcastText.has("run-1")).toBe(false);
    expect(chatRunState.agentDeltaSentAt.has("run-1:assistant")).toBe(false);
    expect(chatRunState.bufferedAgentEvents.has("run-1:assistant")).toBe(false);
    expect(
      mocks.logWarn.mock.calls.some(([message]) =>
        String(message).includes(
          "restart reply drain timed out after 100ms with 1 active chat run(s) still active",
        ),
      ),
    ).toBe(true);
    expect(
      mocks.logWarn.mock.calls.some(([message]) =>
        String(message).includes("aborted 1 active chat run(s) during restart shutdown"),
      ),
    ).toBe(true);
    expect(broadcast).toHaveBeenCalledWith(
      "chat",
      expect.objectContaining({ runId: "run-1", state: "aborted", stopReason: "restart" }),
    );
    expect(nodeSendToSession).toHaveBeenCalledWith(
      "session-1",
      "chat",
      expect.objectContaining({ runId: "run-1", state: "aborted", stopReason: "restart" }),
    );
  });

  it("does not drain or abort active chat runs for normal shutdown", async () => {
    const controller = new AbortController();
    const chatAbortControllers = new Map([
      [
        "run-1",
        {
          controller,
          sessionId: "run-1",
          sessionKey: "session-1",
          startedAtMs: Date.now(),
          expiresAtMs: Date.now() + 60_000,
        },
      ],
    ]);
    const close = createGatewayCloseHandler(
      createGatewayCloseTestDeps({
        chatAbortControllers,
      }),
    );

    const result = await close({ reason: "SIGTERM", drainTimeoutMs: 0 });

    expect(result.warnings).not.toContain("restart-reply-drain");
    expect(controller.signal.aborted).toBe(false);
    expect(chatAbortControllers.size).toBe(1);
  });

  it("aborts active chat runs immediately when restart drain budget is exhausted", async () => {
    const controller = new AbortController();
    const chatAbortControllers = new Map([
      [
        "run-1",
        {
          controller,
          sessionId: "run-1",
          sessionKey: "session-1",
          startedAtMs: Date.now(),
          expiresAtMs: Date.now() + 60_000,
        },
      ],
    ]);
    const close = createGatewayCloseHandler(
      createGatewayCloseTestDeps({
        chatAbortControllers,
      }),
    );

    const result = await close({
      reason: "gateway restarting",
      restartExpectedMs: 123,
      drainTimeoutMs: 0,
    });

    expect(result.warnings).toContain("restart-reply-drain");
    expect(controller.signal.aborted).toBe(true);
    expect(chatAbortControllers.size).toBe(0);
    expect(
      mocks.logWarn.mock.calls.some(([message]) =>
        String(message).includes("restart reply drain timed out after 0ms"),
      ),
    ).toBe(true);
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
    await vi.advanceTimersByTimeAsync(GATEWAY_PRE_RESTART_HOOK_TIMEOUT_MS);
    const result = await closePromise;

    expect(result.warnings).toContain("gateway:pre-restart");
    expect(mocks.triggerInternalHook).toHaveBeenCalledTimes(2);
    expect(
      mocks.logWarn.mock.calls.some(([message]) =>
        String(message).includes("gateway:pre-restart hook timed out after 10000ms"),
      ),
    ).toBe(true);
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
