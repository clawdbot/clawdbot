import { EventEmitter } from "node:events";
import type { GatewayPlugin } from "@buape/carbon/gateway";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { WaitForDiscordGatewayStopParams } from "../monitor.gateway.js";
import type { MutableDiscordGateway } from "./gateway-handle.js";
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

  beforeAll(async () => {
    ({ runDiscordGatewayLifecycle } = await import("./provider.lifecycle.js"));
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
    gateway?: MockGateway;
    isDisallowedIntentsError?: (err: unknown) => boolean;
    pendingGatewayEvents?: DiscordGatewayEvent[];
  }) {
    const gateway =
      params?.gateway ??
      (() => {
        const defaultGateway = createGatewayHarness().gateway;
        defaultGateway.isConnected = true;
        return defaultGateway;
      })();
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
      emitter: gateway.emitter,
    };
    const statusSink = vi.fn();
    const runtime: RuntimeEnv = {
      log: runtimeLog,
      error: runtimeError,
      exit: vi.fn(),
    };
    return {
      threadStop,
      runtimeLog,
      runtimeError,
      gatewaySupervisor,
      statusSink,
      lifecycleParams: {
        accountId: "default",
        gateway: gateway as unknown as MutableDiscordGateway,
        runtime,
        isDisallowedIntentsError: params?.isDisallowedIntentsError ?? (() => false),
        voiceManager: null,
        voiceManagerRef: { current: null },
        threadBindings: { stop: threadStop },
        gatewaySupervisor,
        statusSink,
        abortSignal: undefined as AbortSignal | undefined,
      } satisfies LifecycleParams,
    };
  }

  function expectLifecycleCleanup(params: {
    threadStop: ReturnType<typeof vi.fn>;
    waitCalls: number;
    gatewaySupervisor: { detachLifecycle: ReturnType<typeof vi.fn> };
  }) {
    expect(waitForDiscordGatewayStopMock).toHaveBeenCalledTimes(params.waitCalls);
    expect(unregisterGatewayMock).toHaveBeenCalledWith("default");
    expect(stopGatewayLoggingMock).toHaveBeenCalledTimes(1);
    expect(params.threadStop).toHaveBeenCalledTimes(1);
    expect(params.gatewaySupervisor.detachLifecycle).toHaveBeenCalledTimes(1);
  }

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

    expect(statusSink).toHaveBeenCalledWith(
      expect.objectContaining({
        connected: true,
        lastDisconnect: null,
      }),
    );
  });

  it("restarts the gateway once when startup never reaches READY, then recovers", async () => {
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

      await vi.advanceTimersByTimeAsync(16_500);
      await expect(lifecyclePromise).resolves.toBeUndefined();

      expect(runtimeError).toHaveBeenCalledWith(
        expect.stringContaining("gateway was not ready after 15000ms; restarting gateway"),
      );
      expect(gateway.disconnect).toHaveBeenCalledTimes(1);
      expect(gateway.connect).toHaveBeenCalledTimes(1);
      expect(gateway.connect).toHaveBeenCalledWith(false);
      expect(statusSink).toHaveBeenCalledWith(
        expect.objectContaining({
          connected: true,
          lastDisconnect: null,
          lastError: null,
        }),
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

      await vi.advanceTimersByTimeAsync(1_000);
      await expect(lifecyclePromise).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails when startup still is not ready after a restart", async () => {
    vi.useFakeTimers();
    try {
      const { emitter, gateway } = createGatewayHarness();
      getDiscordGatewayEmitterMock.mockReturnValueOnce(emitter);
      const { lifecycleParams, threadStop, gatewaySupervisor } = createLifecycleHarness({
        gateway,
      });

      const lifecyclePromise = runDiscordGatewayLifecycle(lifecycleParams);
      lifecyclePromise.catch(() => {});
      await vi.advanceTimersByTimeAsync(31_000);

      await expect(lifecyclePromise).rejects.toThrow(
        "discord gateway did not reach READY within 15000ms after restart",
      );
      expect(gateway.disconnect).toHaveBeenCalledTimes(1);
      expect(gateway.connect).toHaveBeenCalledTimes(1);
      expect(gateway.connect).toHaveBeenCalledWith(false);
      expectLifecycleCleanup({
        threadStop,
        waitCalls: 0,
        gatewaySupervisor,
      });
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

    expect(runtimeError).toHaveBeenCalledWith(
      expect.stringContaining("discord: gateway closed with code 4014"),
    );
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

    expect(runtimeError).toHaveBeenCalledWith(
      expect.stringContaining("discord gateway error: Error: transient startup error"),
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
      expect(runtimeError).toHaveBeenCalledWith(
        expect.stringContaining("discord gateway fatal: Error: Fatal Gateway error: 4001"),
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

  it("pushes disconnected status when Carbon closes after startup", async () => {
    const { emitter, gateway } = createGatewayHarness();
    gateway.isConnected = true;
    getDiscordGatewayEmitterMock.mockReturnValueOnce(emitter);
    waitForDiscordGatewayStopMock.mockImplementationOnce(async () => {
      emitter.emit("debug", "Gateway websocket closed: 1006");
    });

    const { lifecycleParams, statusSink } = createLifecycleHarness({ gateway });

    await expect(runDiscordGatewayLifecycle(lifecycleParams)).resolves.toBeUndefined();

    expect(statusSink).toHaveBeenCalledWith(
      expect.objectContaining({
        connected: false,
        lastDisconnect: expect.objectContaining({ status: 1006 }),
      }),
    );
  });

  it("pushes disconnected status when Carbon schedules a reconnect", async () => {
    const { emitter, gateway } = createGatewayHarness();
    gateway.isConnected = true;
    getDiscordGatewayEmitterMock.mockReturnValueOnce(emitter);
    waitForDiscordGatewayStopMock.mockImplementationOnce(async () => {
      emitter.emit("debug", "Gateway reconnect scheduled in 1000ms (zombie, resume=true)");
    });

    const { lifecycleParams, statusSink } = createLifecycleHarness({ gateway });

    await expect(runDiscordGatewayLifecycle(lifecycleParams)).resolves.toBeUndefined();

    expect(statusSink).toHaveBeenCalledWith(
      expect.objectContaining({
        connected: false,
        lastError: "Gateway reconnect scheduled in 1000ms (zombie, resume=true)",
      }),
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

      expect(statusSink).toHaveBeenCalledWith(expect.objectContaining({ connected: false }));
      expect(statusSink).toHaveBeenCalledWith(
        expect.objectContaining({
          connected: true,
          lastDisconnect: null,
        }),
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
      const lifecyclePromise = runDiscordGatewayLifecycle(lifecycleParams);
      lifecyclePromise.catch(() => {});

      await vi.advanceTimersByTimeAsync(30_500);
      await expect(lifecyclePromise).rejects.toThrow(
        "discord gateway opened but did not reach READY within 30000ms",
      );
      expect(runtimeError).toHaveBeenCalledWith(
        expect.stringContaining("did not reach READY within 30000ms"),
      );
      expect(statusSink).toHaveBeenCalledWith(
        expect.objectContaining({
          connected: false,
          lastDisconnect: expect.objectContaining({ error: "runtime-not-ready" }),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
