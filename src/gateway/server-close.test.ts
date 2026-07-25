/**
 * Gateway server close lifecycle tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isAgentRunRestartAbortReason } from "../agents/run-termination.js";
import type { InternalHookEvent } from "../hooks/internal-hooks.js";

type TriggerInternalHookMock = (event: InternalHookEvent) => Promise<void>;

const mocks = vi.hoisted(() => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  listChannelPlugins: vi.fn((): Array<{ id: "telegram" | "discord" }> => []),
  disposeAgentHarnesses: vi.fn(async () => undefined),
  disposeAllSessionMcpRuntimes: vi.fn(async () => undefined),
  triggerInternalHook: vi.fn<TriggerInternalHookMock>(async (_eventValue) => undefined),
  disposeAllBundleLspRuntimes: vi.fn(async () => undefined),
  clearSessionSuspensionTimers: vi.fn(() => 0),
}));
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

vi.mock("../agents/agent-bundle-mcp-tools.js", async () => ({
  ...(await vi.importActual<typeof import("../agents/agent-bundle-mcp-tools.js")>(
    "../agents/agent-bundle-mcp-tools.js",
  )),
  disposeAllSessionMcpRuntimes: mocks.disposeAllSessionMcpRuntimes,
}));

vi.mock("../agents/agent-bundle-lsp-runtime.js", async () => ({
  ...(await vi.importActual<typeof import("../agents/agent-bundle-lsp-runtime.js")>(
    "../agents/agent-bundle-lsp-runtime.js",
  )),
  disposeAllBundleLspRuntimes: mocks.disposeAllBundleLspRuntimes,
}));

vi.mock("../agents/session-suspension.js", () => ({
  clearSessionSuspensionTimers: mocks.clearSessionSuspensionTimers,
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: mocks.logInfo,
    warn: mocks.logWarn,
  })),
}));

const { createGatewayCloseHandler } = await import("./server-close.js");
const { createChatRunState, isChatAbortMarkerCurrent } = await import("./server-chat-state.js");
const { finishGatewayRestartTrace, recordGatewayRestartTraceSpan, startGatewayRestartTrace } =
  await import("./restart-trace.js");
type GatewayCloseHandlerParams = Parameters<typeof createGatewayCloseHandler>[0];
type GatewayCloseClient = GatewayCloseHandlerParams["clients"] extends Set<infer T> ? T : never;
type MarkMainSessionsAbortedForRestart = NonNullable<
  GatewayCloseHandlerParams["markMainSessionsAbortedForRestart"]
>;
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
    worktreeCleanup: null,
    skillCuratorCleanup: vi.fn(),
    agentUnsub: null,
    taskUnsub: null,
    heartbeatUnsub: null,
    transcriptUnsub: null,
    lifecycleUnsub: null,
    chatRunState: createTestChatRunState(),
    chatAbortControllers: new Map(),
    chatQueuedTurns: new Map(),
    restartRecoveryCandidates: new Map(),
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
    mocks.clearSessionSuspensionTimers.mockReset();
    mocks.clearSessionSuspensionTimers.mockReturnValue(0);
  });

  afterEach(() => {
    vi.useRealTimers();
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

  it("joins an in-flight config reload before mutable runtime teardown", async () => {
    const events: string[] = [];
    mocks.clearSessionSuspensionTimers.mockImplementation(() => {
      events.push("session-suspension-timers");
      return 1;
    });
    let releaseReload!: () => void;
    const reloadStopped = new Promise<void>((resolve) => {
      releaseReload = resolve;
    });
    const configReloader = {
      stop: vi.fn(async () => {
        events.push("reload:stopping");
        await reloadStopped;
        events.push("reload:stopped");
      }),
    };
    const postReadySidecar = {
      stop: vi.fn(async () => {
        events.push("sidecar:stopped");
      }),
    };
    const pluginServices = {
      stop: vi.fn(async () => {
        events.push("plugins:stopped");
      }),
    };
    const stopChannel = vi.fn(async () => {
      events.push("channel:stopped");
    });
    const close = createGatewayCloseHandler(
      createGatewayCloseTestDeps({
        channelIds: ["discord"],
        configReloader,
        postReadySidecars: [postReadySidecar],
        pluginServices: pluginServices as never,
        stopChannel,
      }),
    );

    const closePromise = close({ reason: "test" });
    await vi.waitFor(() => {
      expect(events).toEqual(["session-suspension-timers", "reload:stopping"]);
    });
    expect(postReadySidecar.stop).not.toHaveBeenCalled();
    expect(pluginServices.stop).not.toHaveBeenCalled();
    expect(stopChannel).not.toHaveBeenCalled();

    releaseReload();
    await closePromise;

    expect(events).toEqual([
      "session-suspension-timers",
      "reload:stopping",
      "reload:stopped",
      "sidecar:stopped",
      "plugins:stopped",
      "channel:stopped",
    ]);
  });

  it("stops plugin services before channel runtimes", async () => {
    const events: string[] = [];
    const pluginServices = {
      stop: vi.fn(async () => {
        events.push("plugin-services");
      }),
    };
    const stopChannel = vi.fn(async (channelId: string) => {
      events.push(`channel:${channelId}`);
    });
    const close = createGatewayCloseHandler(
      createGatewayCloseTestDeps({
        channelIds: ["discord"],
        pluginServices: pluginServices as never,
        stopChannel,
      }),
    );

    await close({ reason: "test" });

    expect(events).toEqual(["plugin-services", "channel:discord"]);
    expect(pluginServices.stop).toHaveBeenCalledTimes(1);
    expect(stopChannel).toHaveBeenCalledWith("discord");
  });

  it("awaits post-ready sidecars before plugin services and channels", async () => {
    const events: string[] = [];
    let releaseSidecar!: () => void;
    const sidecarReleased = new Promise<void>((resolve) => {
      releaseSidecar = resolve;
    });
    const postReadySidecar = {
      stop: vi.fn(async () => {
        events.push("sidecar:start");
        await sidecarReleased;
        events.push("sidecar:end");
      }),
    };
    const pluginServices = {
      stop: vi.fn(async () => {
        events.push("plugin-services");
      }),
    };
    const stopChannel = vi.fn(async (channelId: string) => {
      events.push(`channel:${channelId}`);
    });
    const close = createGatewayCloseHandler(
      createGatewayCloseTestDeps({
        channelIds: ["discord"],
        postReadySidecars: [postReadySidecar],
        pluginServices: pluginServices as never,
        stopChannel,
      }),
    );

    const closePromise = close({ reason: "test" });
    await vi.waitFor(() => {
      expect(events).toEqual(["sidecar:start"]);
    });
    releaseSidecar();
    await closePromise;

    expect(events).toEqual(["sidecar:start", "sidecar:end", "plugin-services", "channel:discord"]);
    expect(postReadySidecar.stop).toHaveBeenCalledTimes(1);
  });

  it("clears session suspension timers before sidecars, plugin services, and channels stop", async () => {
    const events: string[] = [];
    mocks.clearSessionSuspensionTimers.mockImplementation(() => {
      events.push("session-suspension-timers");
      return 1;
    });
    const postReadySidecar = {
      stop: vi.fn(async () => {
        events.push("sidecar");
      }),
    };
    const pluginServices = {
      stop: vi.fn(async () => {
        events.push("plugin-services");
      }),
    };
    const stopChannel = vi.fn(async (channelId: string) => {
      events.push(`channel:${channelId}`);
    });
    const close = createGatewayCloseHandler(
      createGatewayCloseTestDeps({
        channelIds: ["discord"],
        postReadySidecars: [postReadySidecar],
        pluginServices: pluginServices as never,
        stopChannel,
      }),
    );

    await close({ reason: "test shutdown" });

    expect(mocks.clearSessionSuspensionTimers).toHaveBeenCalledOnce();
    expect(events).toEqual([
      "session-suspension-timers",
      "sidecar",
      "plugin-services",
      "channel:discord",
    ]);
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
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    recordGatewayRestartTraceSpan("restart.ready.runtime.post-attach", 12, 40, [
      ["eventLoopMax", "1.0ms"],
    ]);
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
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
        return new Promise<void>(() => {});
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

  it("aborts active runs when restart reply drain times out", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const agentController = new AbortController();
    const chatRunState = createChatRunState();
    const run = chatRunState.getOrCreate("run-1");
    run.buffer = "partial reply";
    run.deltaSentAt = Date.now();
    run.deltaLastBroadcastLen = 3;
    run.deltaLastBroadcastText = "par";
    run.agentText = {
      assistant: {
        lastSentAt: Date.now(),
        bufferedEvent: { sessionKey: "session-1", payload: {} as never },
      },
    };
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
        removeChatRun: vi.fn(() => ({
          sessionKey: "session-1",
          clientRunId: "run-1",
          registeredAtMs: 1_000,
          registeredSequence: 1,
        })),
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
    expect(agentController.signal.aborted).toBe(true);
    expect(chatAbortControllers.has("run-1")).toBe(false);
    expect(chatAbortControllers.has("agent-run-1")).toBe(false);
    expect(chatRunState.runs.get("run-1")?.buffer).toBeUndefined();
    expect(chatRunState.runs.get("run-1")?.deltaSentAt).toBeUndefined();
    expect(chatRunState.runs.get("run-1")?.deltaLastBroadcastLen).toBeUndefined();
    expect(chatRunState.runs.get("run-1")?.deltaLastBroadcastText).toBeUndefined();
    expect(chatRunState.runs.get("run-1")?.agentText).toBeUndefined();
    expect(
      mocks.logWarn.mock.calls.some(([message]) =>
        String(message).includes(
          "restart reply drain timed out after 100ms with 2 active run(s) still active",
        ),
      ),
    ).toBe(true);
    expect(
      mocks.logWarn.mock.calls.some(([message]) =>
        String(message).includes("aborted 2 active run(s) during restart shutdown"),
      ),
    ).toBe(true);
    expect(broadcast).toHaveBeenCalledWith(
      "chat",
      expect.objectContaining({ runId: "run-1", state: "aborted", stopReason: "restart" }),
      { sessionKeys: ["session-1"] },
    );
    expect(nodeSendToSession).toHaveBeenCalledWith(
      "session-1",
      "chat",
      expect.objectContaining({ runId: "run-1", state: "aborted", stopReason: "restart" }),
    );
    expect(broadcast).toHaveBeenCalledWith(
      "chat",
      expect.objectContaining({
        runId: "agent-run-1",
        state: "aborted",
        stopReason: "restart",
      }),
      { sessionKeys: ["session-1"] },
    );
    expect(nodeSendToSession).toHaveBeenCalledWith(
      "session-1",
      "chat",
      expect.objectContaining({
        runId: "agent-run-1",
        state: "aborted",
        stopReason: "restart",
      }),
    );
  });

  it("aborts queued turns before restart shutdown continues", async () => {
    const controller = new AbortController();
    const chatQueuedTurns = new Map([
      [
        "queued-1",
        {
          controller,
          sessionId: "session-1",
          sessionKey: "session-1",
        },
      ],
    ]);
    const close = createGatewayCloseHandler(
      createGatewayCloseTestDeps({
        chatQueuedTurns,
      }),
    );

    const result = await close({
      reason: "gateway restarting",
      restartExpectedMs: 123,
      drainTimeoutMs: 0,
    });

    expect(result.warnings).toContain("restart-reply-drain");
    expect(controller.signal.aborted).toBe(true);
    expect(chatQueuedTurns.size).toBe(0);
    expect(
      mocks.logWarn.mock.calls.some(([message]) =>
        String(message).includes("aborted 1 queued turn(s) during restart shutdown"),
      ),
    ).toBe(true);
  });

  it("does not drain or abort active runs for normal shutdown", async () => {
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

  it("aborts active runs immediately when restart drain budget is exhausted", async () => {
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
    expect(isAgentRunRestartAbortReason(controller.signal.reason)).toBe(true);
    expect(chatAbortControllers.size).toBe(0);
    expect(
      mocks.logWarn.mock.calls.some(([message]) =>
        String(message).includes("restart reply drain timed out after 0ms"),
      ),
    ).toBe(true);
  });

  it("does not abort a finalizing completed run when restart drain expires", async () => {
    const controller = new AbortController();
    const chatAbortControllers = new Map([
      [
        "run-finalizing",
        {
          controller,
          sessionId: "run-finalizing",
          sessionKey: "session-finalizing",
          projectSessionActive: false,
          isAbortable: () => false,
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
    expect(controller.signal.aborted).toBe(false);
    expect(chatAbortControllers.has("run-finalizing")).toBe(true);
  });

  it("marks active main sessions for restart recovery before aborting restart-drained runs", async () => {
    const events: string[] = [];
    const controller = new AbortController();
    const agentController = new AbortController();
    const completedController = new AbortController();
    const hiddenController = new AbortController();
    const alreadyAbortedController = new AbortController();
    alreadyAbortedController.abort();
    const chatAbortControllers = new Map([
      [
        "run-1",
        {
          controller,
          sessionId: "session-id-1",
          sessionKey: "agent:main:main",
          lifecycleGeneration: "generation-1",
          startedAtMs: Date.now(),
          expiresAtMs: Date.now() + 60_000,
        },
      ],
      [
        "agent-run-1",
        {
          controller: agentController,
          sessionId: "session-id-2",
          sessionKey: "agent:main:test:direct:source",
          lifecycleGeneration: "generation-1",
          startedAtMs: Date.now(),
          expiresAtMs: Date.now() + 60_000,
          kind: "agent" as const,
        },
      ],
      [
        "completed-run",
        {
          controller: completedController,
          sessionId: "completed-session-id",
          sessionKey: "agent:main:completed",
          lifecycleGeneration: "generation-1",
          projectSessionActive: false,
          projectSessionTerminalPersisted: true,
          registrationCleanupRequested: true,
          startedAtMs: Date.now(),
          expiresAtMs: Date.now() + 60_000,
        },
      ],
      [
        "stale-run",
        {
          controller: alreadyAbortedController,
          sessionId: "stale-session-id",
          sessionKey: "agent:main:stale",
          lifecycleGeneration: "generation-1",
          startedAtMs: Date.now(),
          expiresAtMs: Date.now() + 60_000,
        },
      ],
      [
        "hidden-run",
        {
          controller: hiddenController,
          sessionId: "hidden-session-id",
          sessionKey: "agent:main:hidden",
          lifecycleGeneration: "generation-1",
          controlUiVisible: false,
          startedAtMs: Date.now(),
          expiresAtMs: Date.now() + 60_000,
          kind: "agent" as const,
        },
      ],
    ]);
    const chatRunState = createTestChatRunState();
    const completedRun = chatRunState.getOrCreate("completed-run");
    const markMainSessionsAbortedForRestart = vi.fn<MarkMainSessionsAbortedForRestart>(async () => {
      events.push("marker");
    });
    const removeChatRun = vi.fn(() => {
      events.push("abort");
      return {
        sessionKey: "agent:main:main",
        clientRunId: "run-1",
        registeredAtMs: 1_000,
        registeredSequence: 1,
      };
    });
    const close = createGatewayCloseHandler(
      createGatewayCloseTestDeps({
        chatAbortControllers,
        chatRunState,
        markMainSessionsAbortedForRestart,
        removeChatRun,
        resolveActiveSessionIdForKey: (sessionKey) => {
          if (sessionKey === "agent:main:main") {
            return "current-session-id-1";
          }
          if (sessionKey === "agent:main:test:direct:source") {
            return "stale-agent-registry-id";
          }
          return undefined;
        },
      }),
    );

    const result = await close({
      reason: "gateway restarting",
      restartExpectedMs: 123,
      drainTimeoutMs: 0,
    });

    expect(result.warnings).toContain("restart-reply-drain");
    expect(markMainSessionsAbortedForRestart).toHaveBeenCalledTimes(1);
    expect(events[0]).toBe("marker");
    const markerCall = firstMockCall(markMainSessionsAbortedForRestart);
    expect(markerCall?.[0]?.reason).toBe("gateway restart shutdown");
    expect(markerCall?.[0]?.sessionKeys).toStrictEqual(
      new Set(["agent:main:main", "agent:main:test:direct:source"]),
    );
    expect(markerCall?.[0]?.sessionIds).toStrictEqual(
      new Set(["current-session-id-1", "session-id-2"]),
    );
    expect(markerCall?.[0]?.activeRuns).toEqual([
      {
        runId: "run-1",
        lifecycleGeneration: "generation-1",
        sessionKey: "agent:main:main",
        sessionId: "current-session-id-1",
        observedAt: expect.any(Number),
      },
      {
        runId: "agent-run-1",
        lifecycleGeneration: "generation-1",
        sessionKey: "agent:main:test:direct:source",
        sessionId: "session-id-2",
        observedAt: expect.any(Number),
      },
    ]);
    expect(controller.signal.aborted).toBe(true);
    expect(agentController.signal.aborted).toBe(true);
    expect(completedController.signal.aborted).toBe(true);
    expect(hiddenController.signal.aborted).toBe(true);
    const completedMarker = completedRun.abortMarker;
    expect(completedMarker).toEqual({
      abortedAtMs: expect.any(Number),
      sequence: expect.any(Number),
    });
    chatRunState.registry.add("completed-run", {
      sessionKey: "agent:main:fresh",
      clientRunId: "completed-run",
    });
    expect(
      isChatAbortMarkerCurrent(completedMarker, chatRunState.registry.peek("completed-run")),
    ).toBe(false);
  });

  it("keeps post-terminal caller work in restart drain and recovery", async () => {
    const controller = new AbortController();
    const markMainSessionsAbortedForRestart = vi.fn<MarkMainSessionsAbortedForRestart>();
    const chatAbortControllers = new Map([
      [
        "post-terminal-run",
        {
          controller,
          sessionId: "post-terminal-session-id",
          sessionKey: "agent:main:post-terminal",
          lifecycleGeneration: "generation-1",
          projectSessionActive: false,
          projectSessionTerminalPersisted: true,
          startedAtMs: Date.now(),
          expiresAtMs: Date.now() + 60_000,
        },
      ],
    ]);
    const close = createGatewayCloseHandler(
      createGatewayCloseTestDeps({
        chatAbortControllers,
        markMainSessionsAbortedForRestart,
      }),
    );

    const result = await close({
      reason: "gateway restarting",
      restartExpectedMs: 123,
      drainTimeoutMs: 0,
    });

    expect(result.warnings).toContain("restart-reply-drain");
    expect(markMainSessionsAbortedForRestart).toHaveBeenCalledWith(
      expect.objectContaining({
        activeRuns: [
          {
            runId: "post-terminal-run",
            lifecycleGeneration: "generation-1",
            sessionKey: "agent:main:post-terminal",
            sessionId: "post-terminal-session-id",
            observedAt: expect.any(Number),
          },
        ],
      }),
    );
    expect(controller.signal.aborted).toBe(true);
  });

  it("marks and quietly cancels terminal runs before persistence settles", async () => {
    const controller = new AbortController();
    const broadcast = vi.fn();
    const markMainSessionsAbortedForRestart = vi.fn<MarkMainSessionsAbortedForRestart>();
    const nodeSendToSession = vi.fn();
    const chatAbortControllers = new Map([
      [
        "completed-run",
        {
          controller,
          sessionId: "completed-session-id",
          sessionKey: "agent:main:completed",
          lifecycleGeneration: "generation-1",
          projectSessionActive: false,
          projectSessionTerminalPersisted: false,
          registrationCleanupRequested: true,
          startedAtMs: Date.now(),
          expiresAtMs: Date.now() + 60_000,
        },
      ],
    ]);
    const close = createGatewayCloseHandler(
      createGatewayCloseTestDeps({
        broadcast,
        chatAbortControllers,
        getPendingReplyCount: vi.fn().mockReturnValueOnce(1).mockReturnValue(0),
        markMainSessionsAbortedForRestart,
        nodeSendToSession,
      }),
    );

    await close({
      reason: "gateway restarting",
      restartExpectedMs: 123,
      drainTimeoutMs: 0,
    });

    expect(controller.signal.aborted).toBe(true);
    expect(chatAbortControllers.size).toBe(0);
    expect(markMainSessionsAbortedForRestart).toHaveBeenCalledWith(
      expect.objectContaining({
        activeRuns: [
          {
            runId: "completed-run",
            lifecycleGeneration: "generation-1",
            sessionKey: "agent:main:completed",
            sessionId: "completed-session-id",
            observedAt: expect.any(Number),
          },
        ],
      }),
    );
    expect(broadcast.mock.calls.some(([event]) => event === "chat")).toBe(false);
    expect(nodeSendToSession).not.toHaveBeenCalled();
  });

  it("awaits terminal persistence before deciding restart recovery", async () => {
    const controller = new AbortController();
    const markMainSessionsAbortedForRestart = vi.fn<MarkMainSessionsAbortedForRestart>();
    const chatAbortControllers = new Map([
      [
        "completed-run",
        {
          controller,
          sessionId: "completed-session-id",
          sessionKey: "agent:main:completed",
          lifecycleGeneration: "generation-1",
          projectSessionActive: false,
          projectSessionTerminalPersisted: false,
          projectSessionTerminalPersistence: Promise.resolve(),
          registrationCleanupRequested: true,
          startedAtMs: Date.now(),
          expiresAtMs: Date.now() + 60_000,
        },
      ],
    ]);
    const close = createGatewayCloseHandler(
      createGatewayCloseTestDeps({
        chatAbortControllers,
        getPendingReplyCount: vi.fn().mockReturnValueOnce(1).mockReturnValue(0),
        markMainSessionsAbortedForRestart,
      }),
    );

    await close({
      reason: "gateway restarting",
      restartExpectedMs: 123,
      drainTimeoutMs: 0,
    });

    expect(markMainSessionsAbortedForRestart).not.toHaveBeenCalled();
    expect(controller.signal.aborted).toBe(true);
    expect(chatAbortControllers.size).toBe(0);
  });

  it("bounds terminal persistence waiting and preserves recovery", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const markMainSessionsAbortedForRestart = vi.fn<MarkMainSessionsAbortedForRestart>();
    const getPendingReplyCount = vi.fn().mockReturnValueOnce(1).mockReturnValue(0);
    const chatAbortControllers = new Map([
      [
        "persisting-run",
        {
          controller,
          sessionId: "persisting-session-id",
          sessionKey: "agent:main:persisting",
          lifecycleGeneration: "generation-1",
          projectSessionActive: false,
          projectSessionTerminalPersisted: false,
          projectSessionTerminalPersistence: new Promise<void>(() => {}),
          registrationCleanupRequested: true,
          startedAtMs: Date.now(),
          expiresAtMs: Date.now() + 60_000,
        },
      ],
    ]);
    const close = createGatewayCloseHandler(
      createGatewayCloseTestDeps({
        chatAbortControllers,
        getPendingReplyCount,
        markMainSessionsAbortedForRestart,
      }),
    );

    const closePromise = close({
      reason: "gateway restarting",
      restartExpectedMs: 123,
      drainTimeoutMs: 0,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await closePromise;

    expect(markMainSessionsAbortedForRestart).toHaveBeenCalledTimes(1);
    expect(controller.signal.aborted).toBe(true);
  });

  it("warns on slow restart marker persistence and waits before cleanup", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const getPendingReplyCount = vi.fn().mockReturnValueOnce(1).mockReturnValue(0);
    let finishMarker: (() => void) | undefined;
    const markerPending = new Promise<void>((resolve) => {
      finishMarker = resolve;
    });
    const chatAbortControllers = new Map([
      [
        "active-run",
        {
          controller,
          sessionId: "active-session-id",
          sessionKey: "agent:main:active",
          lifecycleGeneration: "generation-1",
          startedAtMs: Date.now(),
          expiresAtMs: Date.now() + 60_000,
        },
      ],
    ]);
    const close = createGatewayCloseHandler(
      createGatewayCloseTestDeps({
        chatAbortControllers,
        getPendingReplyCount,
        markMainSessionsAbortedForRestart: () => markerPending,
      }),
    );

    let closeSettled = false;
    const closePromise = close({
      reason: "gateway restarting",
      restartExpectedMs: 123,
      drainTimeoutMs: 0,
    });
    void closePromise.finally(() => {
      closeSettled = true;
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(closeSettled).toBe(false);
    expect(controller.signal.aborted).toBe(false);
    finishMarker?.();
    const result = await closePromise;

    expect(result.warnings).toContain("restart-main-session-marker");
    expect(controller.signal.aborted).toBe(true);
  });

  it("marks failed terminal persistence after the run guard is gone", async () => {
    let activeDuringMark = false;
    const markMainSessionsAbortedForRestart = vi.fn<MarkMainSessionsAbortedForRestart>(
      async (params) => {
        const run = params.activeRuns[0];
        activeDuringMark = run ? params.isActiveRun(run) : false;
      },
    );
    const restartRecoveryCandidates = new Map([
      [
        "failed-persistence-run",
        {
          runId: "failed-persistence-run",
          lifecycleGeneration: "generation-1",
          sessionKey: "agent:main:failed-persistence",
          sessionId: "failed-persistence-session",
        },
      ],
    ]);
    const close = createGatewayCloseHandler(
      createGatewayCloseTestDeps({
        markMainSessionsAbortedForRestart,
        restartRecoveryCandidates,
        resolveActiveSessionIdForKey: () => "rotated-persistence-session",
      }),
    );

    await close({
      reason: "gateway restarting",
      restartExpectedMs: 123,
      drainTimeoutMs: 0,
    });

    const markerCall = firstMockCall(markMainSessionsAbortedForRestart);
    expect(markerCall?.[0]?.activeRuns).toEqual([
      {
        runId: "failed-persistence-run",
        lifecycleGeneration: "generation-1",
        sessionKey: "agent:main:failed-persistence",
        sessionId: "rotated-persistence-session",
        observedAt: expect.any(Number),
      },
    ]);
    expect(activeDuringMark).toBe(true);
    expect(restartRecoveryCandidates.size).toBe(0);
  });

  it("continues restart shutdown when marking active main sessions fails", async () => {
    const controller = new AbortController();
    const chatAbortControllers = new Map([
      [
        "run-1",
        {
          controller,
          sessionId: "session-id-1",
          sessionKey: "agent:main:main",
          startedAtMs: Date.now(),
          expiresAtMs: Date.now() + 60_000,
        },
      ],
    ]);
    const close = createGatewayCloseHandler(
      createGatewayCloseTestDeps({
        chatAbortControllers,
        markMainSessionsAbortedForRestart: vi.fn(async () => {
          throw new Error("marker unavailable");
        }),
      }),
    );

    const result = await close({
      reason: "gateway restarting",
      restartExpectedMs: 123,
      drainTimeoutMs: 0,
    });

    expect(result.warnings).toContain("restart-main-session-marker");
    expect(controller.signal.aborted).toBe(true);
    expect(chatAbortControllers.size).toBe(0);
    expect(
      mocks.logWarn.mock.calls.some(([message]) =>
        String(message).includes(
          "failed to mark active main session(s) for restart recovery: Error: marker unavailable",
        ),
      ),
    ).toBe(true);
  });

  it("continues restart shutdown and records a warning when gateway pre-restart hook stalls", async () => {
    vi.useFakeTimers();
    mocks.triggerInternalHook.mockImplementation((event: InternalHookEvent) => {
      if (event.action === "pre-restart") {
        return new Promise<void>(() => {});
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
    const taskUnsub = vi.fn();
    const transcriptUnsub = vi.fn();
    const stopTaskRegistryMaintenance = vi.fn();
    const close = createGatewayCloseHandler(
      createGatewayCloseTestDeps({
        stopTaskRegistryMaintenance,
        lifecycleUnsub,
        taskUnsub,
        transcriptUnsub,
      }),
    );

    await close({ reason: "test shutdown" });

    expect(lifecycleUnsub).toHaveBeenCalledTimes(1);
    expect(taskUnsub).toHaveBeenCalledTimes(1);
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
    mocks.disposeAllSessionMcpRuntimes.mockReturnValue(new Promise(() => {}));
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
    mocks.disposeAllBundleLspRuntimes.mockReturnValue(new Promise(() => {}));
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

    const closeAllConnections = vi.fn();
    const close = createGatewayCloseHandler(
      createGatewayCloseTestDeps({
        httpServer: {
          close: () => undefined,
          closeAllConnections,
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

    expect(closeAllConnections).toHaveBeenCalledTimes(1);
    expect(
      mocks.logWarn.mock.calls.some(([message]) =>
        String(message).includes("http-server close exceeded 1000ms"),
      ),
    ).toBe(true);
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
