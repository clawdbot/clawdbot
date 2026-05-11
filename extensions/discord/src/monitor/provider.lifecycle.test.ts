import { EventEmitter } from "node:events";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { GatewayPlugin } from "../internal/gateway.js";
import type { WaitForDiscordGatewayStopParams } from "../monitor.gateway.js";
import {
  DISCORD_GATEWAY_TRANSPORT_ACTIVITY_EVENT,
  type MutableDiscordGateway,
} from "./gateway-handle.js";
import type { DiscordGatewayEvent } from "./gateway-supervisor.js";

type LifecycleParams = Parameters<
  typeof import("./provider.lifecycle.js").runDiscordGatewayLifecycle
>[0];
type MockGateway = {
  isConnected: boolean;
  options: GatewayPlugin["options"];
  disconnect: Mock<() => void>;
  connect: Mock<(resume?: boolean) => void>;
  emitter: EventEmitter;
  ws?: EventEmitter & { terminate?: Mock<() => void> };
};

const {
  attachDiscordGatewayLoggingMock,
  getDiscordGatewayEmitterMock,
  registerGatewayMock,
  stopGatewayLoggingMock,
  unregisterGatewayMock,
  waitForDiscordGatewayStopMock,
} = vi.hoisted(() => {
  const stopGatewayLoggingMock = vi.fn();
  const getDiscordGatewayEmitterMock = vi.fn<() => EventEmitter | undefined>(() => undefined);
  return {
    attachDiscordGatewayLoggingMock: vi.fn(() => stopGatewayLoggingMock),
    getDiscordGatewayEmitterMock,
    waitForDiscordGatewayStopMock: vi.fn((_params: WaitForDiscordGatewayStopParams) =>
      Promise.resolve(),
    ),
    registerGatewayMock: vi.fn(),
    unregisterGatewayMock: vi.fn(),
    stopGatewayLoggingMock,
  };
});

vi.mock("../gateway-logging.js", () => ({
  attachDiscordGatewayLogging: attachDiscordGatewayLoggingMock,
}));

vi.mock("../monitor.gateway.js", () => ({
  getDiscordGatewayEmitter: getDiscordGatewayEmitterMock,
  waitForDiscordGatewayStop: waitForDiscordGatewayStopMock,
}));

vi.mock("./gateway-registry.js", () => ({
  registerGateway: registerGatewayMock,
  unregisterGateway: unregisterGatewayMock,
}));

describe("runDiscordGatewayLifecycle", () => {
  let runDiscordGatewayLifecycle: typeof import("./provider.lifecycle.js").runDiscordGatewayLifecycle;
  let resolveDiscordGatewayReadyTimeoutMs: typeof import("./provider.lifecycle.js").resolveDiscordGatewayReadyTimeoutMs;
  let resolveDiscordGatewayRuntimeReadyTimeoutMs: typeof import("./provider.lifecycle.js").resolveDiscordGatewayRuntimeReadyTimeoutMs;

  beforeAll(async () => {
    ({
      runDiscordGatewayLifecycle,
      resolveDiscordGatewayReadyTimeoutMs,
      resolveDiscordGatewayRuntimeReadyTimeoutMs,
    } = await import("./provider.lifecycle.js"));
  });

  beforeEach(() => {
    attachDiscordGatewayLoggingMock.mockClear();
    getDiscordGatewayEmitterMock.mockClear();
    waitForDiscordGatewayStopMock.mockClear();
    registerGatewayMock.mockClear();
    unregisterGatewayMock.mockClear();
    stopGatewayLoggingMock.mockClear();
  });

  function createGatewayHarness(params?: {
    ws?: EventEmitter & { terminate?: Mock<() => void> };
  }): { emitter: EventEmitter; gateway: MockGateway } {
    const emitter = new EventEmitter();
    return {
      emitter,
      gateway: {
        isConnected: false,
        options: { intents: 0, reconnect: { maxAttempts: 50 } } as GatewayPlugin["options"],
        disconnect: vi.fn(),
        connect: vi.fn(),
        emitter,
        ...(params?.ws ? { ws: params.ws } : {}),
      },
    };
  }

  function createGatewayEvent(
    type: DiscordGatewayEvent["type"],
    message: string,
  ): DiscordGatewayEvent {
    const err = new Error(message);
    return {
      type,
      err,
      message: String(err),
      shouldStopLifecycle: type !== "other",
    };
  }

  function createLifecycleHarness(params?: {
    gateway?: MockGateway | null;
    isDisallowedIntentsError?: (err: unknown) => boolean;
    pendingGatewayEvents?: DiscordGatewayEvent[];
  }) {
    const gateway =
      params && "gateway" in params
        ? params.gateway
        : (() => {
            const defaultGateway = createGatewayHarness().gateway;
            defaultGateway.isConnected = true;
            return defaultGateway;
          })();
    const gatewayEmitter = gateway?.emitter ?? new EventEmitter();
    const threadStop = vi.fn();
    const runtimeLog = vi.fn();
    const runtimeError = vi.fn();
    const pendingGatewayEvents = params?.pendingGatewayEvents ?? [];
    const gatewaySupervisor = {
      attachLifecycle: vi.fn(),
      detachLifecycle: vi.fn(),
      drainPending: vi.fn((handler: (event: DiscordGatewayEvent) => "continue" | "stop") => {
        const queued = [...pendingGatewayEvents];
        pendingGatewayEvents.length = 0;
        for (const event of queued) {
          if (handler(event) === "stop") {
            return "stop";
          }
        }
        return "continue";
      }),
      dispose: vi.fn(),
      emitter: gatewayEmitter,
    };
    const statusSink = vi.fn();
    const runtime: RuntimeEnv = {
      log: runtimeLog,
      error: runtimeError,
      exit: vi.fn(),
    };
    const lifecycleParams: LifecycleParams = {
      accountId: "default",
      gateway: gateway ? (gateway as unknown as MutableDiscordGateway) : undefined,
      runtime,
      isDisallowedIntentsError: params?.isDisallowedIntentsError ?? (() => false),
      voiceManager: null,
      voiceManagerRef: { current: null },
      threadBindings: { stop: threadStop },
      gatewaySupervisor,
      statusSink,
      abortSignal: undefined,
    };
    return {
      threadStop,
      runtimeLog,
      runtimeError,
      gatewaySupervisor,
      statusSink,
      lifecycleParams,
    };
  }

  function expectLifecycleCleanup(params: {
    threadStop: ReturnType<typeof vi.fn>;
    waitCalls: number;
    gatewaySupervisor: { detachLifecycle: ReturnType<typeof vi.fn> };
    detachCalls?: number;
  }) {
    expect(waitForDiscordGatewayStopMock).toHaveBeenCalledTimes(params.waitCalls);
    expect(unregisterGatewayMock).toHaveBeenCalledWith("default");
    expect(stopGatewayLoggingMock).toHaveBeenCalledTimes(1);
    expect(params.threadStop).toHaveBeenCalledTimes(1);
    expect(params.gatewaySupervisor.detachLifecycle).toHaveBeenCalledTimes(params.detachCalls ?? 1);
  }

  function mockMessages(mock: ReturnType<typeof vi.fn>): string[] {
    return mock.mock.calls.map((call) => String(call[0] ?? ""));
  }

  function expectMockMessageContains(mock: ReturnType<typeof vi.fn>, expected: string): void {
    expect(mockMessages(mock).some((message) => message.includes(expected))).toBe(true);
  }

  function expectMockMessageNotContains(mock: ReturnType<typeof vi.fn>, expected: string): void {
    expect(mockMessages(mock).every((message) => !message.includes(expected))).toBe(true);
  }

  type StatusPatch = {
    connected?: boolean;
    lastDisconnect?: null | Record<string, unknown>;
    lastError?: string | null;
  };

  function statusPatches(statusSink: ReturnType<typeof vi.fn>): StatusPatch[] {
    return statusSink.mock.calls.map((call) => call[0] as StatusPatch);
  }

  function expectStatusPatch(
    statusSink: ReturnType<typeof vi.fn>,
    predicate: (patch: StatusPatch) => boolean,
  ): void {
    expect(statusPatches(statusSink).some(predicate)).toBe(true);
  }

  it("resolves gateway READY timeouts from config, env, then defaults", () => {
    expect(resolveDiscordGatewayReadyTimeoutMs({ configuredTimeoutMs: 45_000 })).toBe(45_000);
    expect(
      resolveDiscordGatewayReadyTimeoutMs({
        env: { OPENCLAW_DISCORD_READY_TIMEOUT_MS: "90000" },
      }),
    ).toBe(90_000);
    expect(resolveDiscordGatewayReadyTimeoutMs({ env: {} })).toBe(15_000);

    expect(resolveDiscordGatewayRuntimeReadyTimeoutMs({ configuredTimeoutMs: 60_000 })).toBe(
      60_000,
    );
    expect(
      resolveDiscordGatewayRuntimeReadyTimeoutMs({
        env: { OPENCLAW_DISCORD_RUNTIME_READY_TIMEOUT_MS: "120000" },
      }),
    ).toBe(120_000);
    expect(resolveDiscordGatewayRuntimeReadyTimeoutMs({ env: {} })).toBe(30_000);
  });

  it("cleans up thread bindings when gateway wait fails before READY", async () => {
    waitForDiscordGatewayStopMock.mockRejectedValueOnce(new Error("startup failed"));
    const { lifecycleParams, threadStop, gatewaySupervisor } = createLifecycleHarness();

    await expect(runDiscordGatewayLifecycle(lifecycleParams)).rejects.toThrow("startup failed");

    expectLifecycleCleanup({
      threadStop,
      waitCalls: 1,
      gatewaySupervisor,
    });
  });

  it("cleans up when gateway wait fails after startup", async () => {
    waitForDiscordGatewayStopMock.mockRejectedValueOnce(new Error("gateway wait failed"));
    const { lifecycleParams, threadStop, gatewaySupervisor } = createLifecycleHarness();

    await expect(runDiscordGatewayLifecycle(lifecycleParams)).rejects.toThrow(
      "gateway wait failed",
    );

    expectLifecycleCleanup({
      threadStop,
      waitCalls: 1,
      gatewaySupervisor,
    });
  });

  it("pushes connected status when gateway is already connected at lifecycle start", async () => {
    const { emitter, gateway } = createGatewayHarness();
    gateway.isConnected = true;
    getDiscordGatewayEmitterMock.mockReturnValueOnce(emitter);

    const { lifecycleParams, statusSink } = createLifecycleHarness({ gateway });
    await expect(runDiscordGatewayLifecycle(lifecycleParams)).resolves.toBeUndefined();

    expectStatusPatch(
      statusSink,
      (patch) => patch.connected === true && patch.lastDisconnect === null,
    );
  });

  it("does not treat a missing gateway handle as ready", async () => {
    vi.useFakeTimers();
    try {
      const { lifecycleParams, threadStop, statusSink, gatewaySupervisor } = createLifecycleHarness(
        {
          gateway: null,
        },
      );
      lifecycleParams.gatewayReadyTimeoutMs = 5_000;

      const lifecyclePromise = runDiscordGatewayLifecycle(lifecycleParams);
      lifecyclePromise.catch(() => {});
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(5_500);

      await expect(lifecyclePromise).rejects.toThrow(
        "discord gateway did not reach READY within 5000ms",
      );
      expect(statusPatches(statusSink).every((patch) => patch.connected !== true)).toBe(true);
      expectLifecycleCleanup({
        threadStop,
        waitCalls: 0,
        gatewaySupervisor,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("records throttled gateway socket activity as transport liveness", async () => {
    const { emitter, gateway } = createGatewayHarness();
    gateway.isConnected = true;
    let resolveWait: (() => void) | undefined;
    waitForDiscordGatewayStopMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveWait = resolve;
        }),
    );
    const { lifecycleParams, statusSink } = createLifecycleHarness({ gateway });

    const lifecyclePromise = runDiscordGatewayLifecycle(lifecycleParams);
    await vi.waitFor(() => expect(waitForDiscordGatewayStopMock).toHaveBeenCalledTimes(1));

    const baselinePatchCount = statusSink.mock.calls.length;
    emitter.emit(DISCORD_GATEWAY_TRANSPORT_ACTIVITY_EVENT, { at: 100_000 });
    emitter.emit(DISCORD_GATEWAY_TRANSPORT_ACTIVITY_EVENT, { at: 101_000 });
    emitter.emit(DISCORD_GATEWAY_TRANSPORT_ACTIVITY_EVENT, { at: 131_000 });

    const transportPatches = statusSink.mock.calls
      .slice(baselinePatchCount)
      .map((call) => call[0] as Record<string, unknown>)
      .filter((patch) => typeof patch.lastTransportActivityAt === "number");
    expect(transportPatches).toEqual([
      { lastTransportActivityAt: 100_000 },
      { lastTransportActivityAt: 131_000 },
    ]);
    expect(
      transportPatches.every(
        (patch) => patch.lastEventAt === undefined && patch.connected === undefined,
      ),
    ).toBe(true);

    if (!resolveWait) {
      throw new Error("expected lifecycle wait resolver");
    }
    resolveWait();
    await expect(lifecyclePromise).resolves.toBeUndefined();
  });

  it("removes the gateway socket activity listener during lifecycle cleanup", async () => {
    const { emitter, gateway } = createGatewayHarness();
    gateway.isConnected = true;
    const { lifecycleParams, statusSink } = createLifecycleHarness({ gateway });

    await expect(runDiscordGatewayLifecycle(lifecycleParams)).resolves.toBeUndefined();
    const callCountAfterCleanup = statusSink.mock.calls.length;

    emitter.emit(DISCORD_GATEWAY_TRANSPORT_ACTIVITY_EVENT, { at: Date.now() });

    expect(statusSink).toHaveBeenCalledTimes(callCountAfterCleanup);
  });

  it("reconnects with backoff when startup never reaches READY, then recovers", async () => {
    vi.useFakeTimers();
    try {
      const { emitter, gateway } = createGatewayHarness();
      getDiscordGatewayEmitterMock.mockReturnValueOnce(emitter);
      gateway.connect.mockImplementation(() => {
        setTimeout(() => {
          gateway.isConnected = true;
        }, 1_000);
      });

      const { lifecycleParams, runtimeError, statusSink } = createLifecycleHarness({ gateway });
      const lifecyclePromise = runDiscordGatewayLifecycle(lifecycleParams);

      await vi.advanceTimersByTimeAsync(18_500);
      await expect(lifecyclePromise).resolves.toBeUndefined();

      expectMockMessageContains(runtimeError, "gateway READY wait timed out after 15000ms");
      expectMockMessageNotContains(
        runtimeError,
        "gateway was not ready after 15000ms; restarting gateway",
      );
      expect(gateway.disconnect).toHaveBeenCalledTimes(1);
      expect(gateway.connect).toHaveBeenCalledTimes(1);
      expect(gateway.connect).toHaveBeenCalledWith(false);
      expectStatusPatch(
        statusSink,
        (patch) =>
          patch.connected === true && patch.lastDisconnect === null && patch.lastError === null,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for the stale startup socket to close before reconnecting", async () => {
    vi.useFakeTimers();
    try {
      const socket = new EventEmitter();
      const { emitter, gateway } = createGatewayHarness({ ws: socket });
      getDiscordGatewayEmitterMock.mockReturnValueOnce(emitter);
      gateway.disconnect.mockImplementation(() => {
        setTimeout(() => {
          socket.emit("close", 1000, "Client disconnect");
        }, 1_000);
      });
      gateway.connect.mockImplementation(() => {
        setTimeout(() => {
          gateway.isConnected = true;
        }, 1_000);
      });

      const { lifecycleParams } = createLifecycleHarness({ gateway });
      const lifecyclePromise = runDiscordGatewayLifecycle(lifecycleParams);

      await vi.advanceTimersByTimeAsync(15_100);
      expect(gateway.disconnect).toHaveBeenCalledTimes(1);
      expect(gateway.connect).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1_100);
      expect(gateway.connect).toHaveBeenCalledTimes(1);
      expect(gateway.connect).toHaveBeenCalledWith(false);

      await vi.advanceTimersByTimeAsync(3_000);
      await expect(lifecyclePromise).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps retrying when startup still is not ready after a reconnect", async () => {
    vi.useFakeTimers();
    try {
      const { emitter, gateway } = createGatewayHarness();
      getDiscordGatewayEmitterMock.mockReturnValueOnce(emitter);
      const { lifecycleParams, threadStop, gatewaySupervisor } = createLifecycleHarness({
        gateway,
      });

      const lifecyclePromise = runDiscordGatewayLifecycle(lifecycleParams);
      lifecyclePromise.catch(() => {});
      await vi.advanceTimersByTimeAsync(34_000);

      expect(gateway.disconnect).toHaveBeenCalledTimes(2);
      expect(gateway.connect).toHaveBeenCalledTimes(2);
      expect(gateway.connect).toHaveBeenCalledWith(false);
      expect(waitForDiscordGatewayStopMock).not.toHaveBeenCalled();

      gateway.isConnected = true;
      await vi.advanceTimersByTimeAsync(2_500);
      await expect(lifecyclePromise).resolves.toBeUndefined();
      expectLifecycleCleanup({ threadStop, waitCalls: 1, gatewaySupervisor });
    } finally {
      vi.useRealTimers();
    }
  });

  it("handles queued disallowed intents errors without waiting for gateway events", async () => {
    const { lifecycleParams, threadStop, runtimeError, gatewaySupervisor } = createLifecycleHarness(
      {
        pendingGatewayEvents: [
          createGatewayEvent("disallowed-intents", "Fatal Gateway error: 4014"),
        ],
        isDisallowedIntentsError: (err) => String(err).includes("4014"),
      },
    );

    await expect(runDiscordGatewayLifecycle(lifecycleParams)).resolves.toBeUndefined();

    expectMockMessageContains(runtimeError, "discord: gateway closed with code 4014");
    expectLifecycleCleanup({
      threadStop,
      waitCalls: 0,
      gatewaySupervisor,
    });
  });

  it("logs queued non-fatal startup gateway errors and continues", async () => {
    const { lifecycleParams, threadStop, runtimeError, gatewaySupervisor } = createLifecycleHarness(
      {
        pendingGatewayEvents: [createGatewayEvent("other", "transient startup error")],
      },
    );

    await expect(runDiscordGatewayLifecycle(lifecycleParams)).resolves.toBeUndefined();

    expectMockMessageContains(
      runtimeError,
      "discord gateway error: Error: transient startup error",
    );
    expectLifecycleCleanup({
      threadStop,
      waitCalls: 1,
      gatewaySupervisor,
    });
  });

  it("throws queued fatal startup gateway errors", async () => {
    const { lifecycleParams, threadStop, gatewaySupervisor } = createLifecycleHarness({
      pendingGatewayEvents: [createGatewayEvent("fatal", "Fatal Gateway error: 4000")],
    });

    await expect(runDiscordGatewayLifecycle(lifecycleParams)).rejects.toThrow(
      "discord gateway fatal: Error: Fatal Gateway error: 4000",
    );

    expectLifecycleCleanup({
      threadStop,
      waitCalls: 0,
      gatewaySupervisor,
    });
  });

  it("throws queued reconnect exhaustion errors", async () => {
    const { lifecycleParams, threadStop, gatewaySupervisor } = createLifecycleHarness({
      pendingGatewayEvents: [
        createGatewayEvent(
          "reconnect-exhausted",
          "Max reconnect attempts (50) reached after code 1005",
        ),
      ],
    });

    await expect(runDiscordGatewayLifecycle(lifecycleParams)).rejects.toThrow(
      "discord gateway reconnect-exhausted: Error: Max reconnect attempts (50) reached after code 1005",
    );

    expectLifecycleCleanup({
      threadStop,
      waitCalls: 0,
      gatewaySupervisor,
    });
  });

  it("treats abort-time live reconnect exhaustion as expected shutdown", async () => {
    const abortController = new AbortController();
    let liveGatewayHandler: ((event: DiscordGatewayEvent) => void) | undefined;
    const { lifecycleParams, threadStop, runtimeLog, runtimeError, gatewaySupervisor } =
      createLifecycleHarness();
    lifecycleParams.abortSignal = abortController.signal;
    gatewaySupervisor.attachLifecycle.mockImplementation(
      (handler: (event: DiscordGatewayEvent) => void) => {
        liveGatewayHandler = handler;
      },
    );
    abortController.signal.addEventListener(
      "abort",
      () => {
        if (!liveGatewayHandler) {
          throw new Error("discord gateway lifecycle handler was not attached");
        }
        liveGatewayHandler(
          createGatewayEvent(
            "reconnect-exhausted",
            "Max reconnect attempts (50) reached after close code 1005",
          ),
        );
      },
      { once: true },
    );
    waitForDiscordGatewayStopMock.mockImplementationOnce(async (waitParams) => {
      const actual =
        await vi.importActual<typeof import("../monitor.gateway.js")>("../monitor.gateway.js");
      const waitPromise = actual.waitForDiscordGatewayStop(waitParams);
      abortController.abort(new Error("shutdown"));
      return await waitPromise;
    });

    await expect(runDiscordGatewayLifecycle(lifecycleParams)).resolves.toBeUndefined();

    expect(gatewaySupervisor.attachLifecycle).toHaveBeenCalledTimes(1);
    expectMockMessageContains(
      runtimeLog,
      "treating reconnect-exhausted during expected shutdown as clean",
    );
    expectMockMessageContains(
      runtimeLog,
      "Max reconnect attempts (50) reached after close code 1005",
    );
    expectMockMessageNotContains(runtimeError, "discord gateway reconnect-exhausted");
    expectLifecycleCleanup({
      threadStop,
      waitCalls: 1,
      gatewaySupervisor,
      detachCalls: 2,
    });
  });

  it("surfaces fatal startup gateway errors while waiting for READY", async () => {
    vi.useFakeTimers();
    try {
      const pendingGatewayEvents: DiscordGatewayEvent[] = [];
      const { emitter, gateway } = createGatewayHarness();
      getDiscordGatewayEmitterMock.mockReturnValueOnce(emitter);
      const { lifecycleParams, threadStop, runtimeError, gatewaySupervisor } =
        createLifecycleHarness({
          gateway,
          pendingGatewayEvents,
        });

      setTimeout(() => {
        pendingGatewayEvents.push(createGatewayEvent("fatal", "Fatal Gateway error: 4001"));
      }, 1_000);

      const lifecyclePromise = runDiscordGatewayLifecycle(lifecycleParams);
      lifecyclePromise.catch(() => {});
      await vi.advanceTimersByTimeAsync(1_500);

      await expect(lifecyclePromise).rejects.toThrow(
        "discord gateway fatal: Error: Fatal Gateway error: 4001",
      );
      expectMockMessageContains(
        runtimeError,
        "discord gateway fatal: Error: Fatal Gateway error: 4001",
      );
      expect(gateway.disconnect).not.toHaveBeenCalled();
      expect(gateway.connect).not.toHaveBeenCalled();
      expectLifecycleCleanup({
        threadStop,
        waitCalls: 0,
        gatewaySupervisor,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("pushes disconnected status when the gateway closes after startup", async () => {
    const { emitter, gateway } = createGatewayHarness();
    gateway.isConnected = true;
    getDiscordGatewayEmitterMock.mockReturnValueOnce(emitter);
    waitForDiscordGatewayStopMock.mockImplementationOnce(async () => {
      emitter.emit("debug", "Gateway websocket closed: 1006");
    });

    const { lifecycleParams, statusSink } = createLifecycleHarness({ gateway });

    await expect(runDiscordGatewayLifecycle(lifecycleParams)).resolves.toBeUndefined();

    expectStatusPatch(
      statusSink,
      (patch) =>
        patch.connected === false &&
        patch.lastDisconnect !== null &&
        patch.lastDisconnect?.status === 1006,
    );
  });

  it("pushes disconnected status when the gateway schedules a reconnect", async () => {
    const { emitter, gateway } = createGatewayHarness();
    gateway.isConnected = true;
    getDiscordGatewayEmitterMock.mockReturnValueOnce(emitter);
    waitForDiscordGatewayStopMock.mockImplementationOnce(async () => {
      emitter.emit("debug", "Gateway reconnect scheduled in 1000ms (zombie, resume=true)");
    });

    const { lifecycleParams, statusSink } = createLifecycleHarness({ gateway });

    await expect(runDiscordGatewayLifecycle(lifecycleParams)).resolves.toBeUndefined();

    expectStatusPatch(
      statusSink,
      (patch) =>
        patch.connected === false &&
        patch.lastError === "Gateway reconnect scheduled in 1000ms (zombie, resume=true)",
    );
  });

  it("pushes connected status when a runtime reconnect becomes ready", async () => {
    vi.useFakeTimers();
    try {
      const { emitter, gateway } = createGatewayHarness();
      gateway.isConnected = true;
      getDiscordGatewayEmitterMock.mockReturnValueOnce(emitter);
      waitForDiscordGatewayStopMock.mockImplementationOnce(async () => {
        gateway.isConnected = false;
        emitter.emit("debug", "Gateway websocket opened");
        setTimeout(() => {
          gateway.isConnected = true;
        }, 1_000);
        await vi.advanceTimersByTimeAsync(1_500);
      });

      const { lifecycleParams, statusSink } = createLifecycleHarness({ gateway });

      await expect(runDiscordGatewayLifecycle(lifecycleParams)).resolves.toBeUndefined();

      expectStatusPatch(statusSink, (patch) => patch.connected === false);
      expectStatusPatch(
        statusSink,
        (patch) => patch.connected === true && patch.lastDisconnect === null,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("force-stops when a runtime reconnect opens but never becomes ready", async () => {
    vi.useFakeTimers();
    try {
      const { emitter, gateway } = createGatewayHarness();
      gateway.isConnected = true;
      getDiscordGatewayEmitterMock.mockReturnValueOnce(emitter);
      waitForDiscordGatewayStopMock.mockImplementationOnce(
        (params: WaitForDiscordGatewayStopParams) =>
          new Promise<void>((_resolve, reject) => {
            params.registerForceStop?.((err) => reject(err));
            gateway.isConnected = false;
            emitter.emit("debug", "Gateway websocket opened");
          }),
      );

      const { lifecycleParams, runtimeError, statusSink } = createLifecycleHarness({ gateway });
      lifecycleParams.gatewayRuntimeReadyTimeoutMs = 5_000;
      const lifecyclePromise = runDiscordGatewayLifecycle(lifecycleParams);
      lifecyclePromise.catch(() => {});

      await vi.advanceTimersByTimeAsync(5_500);
      await expect(lifecyclePromise).rejects.toThrow(
        "discord gateway opened but did not reach READY within 5000ms",
      );
      expectMockMessageContains(runtimeError, "did not reach READY within 5000ms");
      expectStatusPatch(
        statusSink,
        (patch) =>
          patch.connected === false &&
          patch.lastDisconnect !== null &&
          patch.lastDisconnect?.error === "runtime-not-ready",
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
