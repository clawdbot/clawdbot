// Matrix tests cover index plugin behavior.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MatrixConfig, MatrixStreamingMode } from "../../types.js";
import {
  getMatrixMonitorIndexTestHarness,
  type DirectRoomTrackerOptions,
} from "./index.test-helpers.js";

const hoisted = getMatrixMonitorIndexTestHarness();

let monitorMatrixProvider: typeof import("./index.js").monitorMatrixProvider;

describe("monitorMatrixProvider", () => {
  beforeAll(async () => {
    ({ monitorMatrixProvider } = await import("./index.js"));
  });

  async function flushUntil(predicate: () => boolean, message: string): Promise<void> {
    for (let i = 0; i < 20; i++) {
      if (predicate()) {
        return;
      }
      await Promise.resolve();
    }
    throw new Error(message);
  }

  async function waitForCallOrderEntry(entry: string): Promise<void> {
    await flushUntil(
      () => hoisted.callOrder.includes(entry),
      `expected call order to include ${entry}`,
    );
  }

  async function startMonitorAndAbortAfterStartup(): Promise<void> {
    const abortController = new AbortController();
    const monitorPromise = monitorMatrixProvider({ abortSignal: abortController.signal });
    await waitForCallOrderEntry("start-client");
    abortController.abort();
    await monitorPromise;
  }

  function registeredRoomMessageHandler() {
    const handler = hoisted.registeredOnRoomMessage;
    if (!handler) {
      throw new Error("expected room message handler to be registered");
    }
    return handler;
  }

  function expectPersistRelease() {
    expect(hoisted.releaseSharedClientInstance).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "persist" }),
    );
  }

  function mockCallArg(mock: { mock: { calls: unknown[][] } }, index = 0, argIndex = 0): unknown {
    const call = mock.mock.calls.at(index);
    if (!call) {
      throw new Error(`expected mock call ${index}`);
    }
    return call[argIndex];
  }

  function directRoomTrackerOptions(): DirectRoomTrackerOptions {
    const opts = mockCallArg(hoisted.createDirectRoomTracker, 0, 1);
    if (!opts || typeof opts !== "object") {
      throw new Error("expected direct room tracker options");
    }
    return opts as DirectRoomTrackerOptions;
  }

  function lastMockCallArg(mock: { mock: { calls: unknown[][] } }, argIndex = 0): unknown {
    const call = mock.mock.calls.at(-1);
    if (!call) {
      throw new Error("expected mock call");
    }
    return call[argIndex];
  }

  function expectStatusCallFields(fields: Record<string, unknown>) {
    const matched = hoisted.setStatus.mock.calls.some(([status]) => {
      const record = status as Record<string, unknown>;
      return Object.entries(fields).every(([key, value]) => record[key] === value);
    });
    expect(matched).toBe(true);
  }

  function expectLastStatusFields(fields: Record<string, unknown>) {
    const status = lastMockCallArg(hoisted.setStatus) as Record<string, unknown>;
    for (const [key, value] of Object.entries(fields)) {
      expect(status[key]).toBe(value);
    }
  }

  beforeEach(() => {
    hoisted.callOrder.length = 0;
    hoisted.state.leaseAbortController = new AbortController();
    hoisted.state.monitorRetirement = null;
    hoisted.state.monitorRetirementPromise = null;
    hoisted.state.startClientError = null;
    hoisted.accountConfig.dm = {};
    delete (hoisted.accountConfig as { streaming?: unknown }).streaming;
    delete (hoisted.accountConfig as { rooms?: Record<string, unknown> }).rooms;
    hoisted.acquireSharedMatrixClient
      .mockReset()
      .mockImplementation(hoisted.acquireSharedMatrixClientImpl);
    hoisted.releaseSharedClientInstance.mockReset().mockImplementation(hoisted.finalReleaseImpl);
    hoisted.registerMonitorRetirement.mockClear();
    hoisted.resolveSharedMatrixClient
      .mockReset()
      .mockImplementation(hoisted.resolveSharedMatrixClientImpl);
    hoisted.createDirectRoomTracker.mockReset().mockReturnValue({
      isDirectMessage: vi.fn(async () => false),
    });
    hoisted.createThreadBindingManager.mockReset().mockImplementation(async () => {
      hoisted.callOrder.push("create-manager");
      return {
        accountId: "default",
        stop: hoisted.stopThreadBindingManager,
      };
    });
    hoisted.getRoomInfo.mockReset().mockResolvedValue({
      altAliases: [],
      nameResolved: true,
      aliasesResolved: true,
    });
    hoisted.getMemberDisplayName.mockReset().mockResolvedValue("Bot");
    hoisted.registeredOnRoomMessage = null;
    hoisted.registeredHealthySyncGetter = undefined;
    hoisted.stopThreadBindingManager.mockReset().mockResolvedValue(undefined);
    hoisted.client.removeAllListeners();
    hoisted.client.hasPersistedSyncState.mockReset().mockReturnValue(false);
    hoisted.client.drainPendingDecryptions.mockReset().mockResolvedValue(undefined);
    hoisted.inboundDeduper.claim
      .mockReset()
      .mockResolvedValue({ kind: "claimed" as const, handle: hoisted.inboundReplayClaim });
    hoisted.inboundReplayClaim.commit.mockReset().mockResolvedValue(true);
    hoisted.inboundReplayClaim.release.mockReset();
    hoisted.createMatrixInboundEventDeduper.mockReset().mockReturnValue(hoisted.inboundDeduper);
    hoisted.backfillMatrixAuthDeviceIdAfterStartup.mockReset().mockResolvedValue(undefined);
    hoisted.registerChannelRuntimeContext.mockReset();
    hoisted.runMatrixStartupMaintenance.mockReset().mockResolvedValue(undefined);
    hoisted.createMatrixRoomMessageHandler.mockReset().mockReturnValue(vi.fn());
    hoisted.disposeAutoJoin.mockClear();
    hoisted.disposeMonitorEvents.mockClear();
    hoisted.registerMatrixAutoJoin.mockClear();
    hoisted.registerMatrixMonitorEvents.mockClear();
    hoisted.setStatus.mockReset();
    Object.values(hoisted.logger).forEach((mock) => mock.mockReset());
  });

  it.each([
    [undefined, "off", false],
    [{}, "off", false],
    [{ mode: "off" }, "off", false],
    [{ mode: "partial" }, "partial", true],
    [{ mode: "quiet" }, "quiet", true],
    [{ mode: "progress" }, "progress", true],
    [{ mode: "partial", preview: { toolProgress: false } }, "partial", false],
    [{ mode: "quiet", preview: { toolProgress: false } }, "quiet", false],
    [{ mode: "partial", progress: { toolProgress: false } }, "partial", true],
    [{ mode: "quiet", progress: { toolProgress: false } }, "quiet", true],
    [{ mode: "progress", progress: { toolProgress: false } }, "progress", false],
    [
      { mode: "progress", progress: { toolProgress: false }, preview: { toolProgress: true } },
      "progress",
      false,
    ],
    [{ mode: "off", preview: { toolProgress: true } }, "off", false],
  ] satisfies Array<[MatrixConfig["streaming"], MatrixStreamingMode, boolean]>)(
    "resolves streaming=%j to mode=%s and toolProgress=%s",
    async (streaming, expectedMode, expectedPreviewToolProgressEnabled) => {
      (hoisted.accountConfig as { streaming?: unknown }).streaming = streaming;

      await startMonitorAndAbortAfterStartup();

      const handlerParams = mockCallArg(hoisted.createMatrixRoomMessageHandler) as {
        streaming?: MatrixStreamingMode;
        previewToolProgressEnabled?: boolean;
      };
      expect(handlerParams.streaming).toBe(expectedMode);
      expect(handlerParams.previewToolProgressEnabled).toBe(expectedPreviewToolProgressEnabled);
    },
  );

  it("returns immediately when the abort signal is already canceled", async () => {
    const abortController = new AbortController();
    abortController.abort();

    await monitorMatrixProvider({ abortSignal: abortController.signal });

    expect(hoisted.callOrder).toStrictEqual([]);
    expect(hoisted.createMatrixRoomMessageHandler).not.toHaveBeenCalled();
    expect(hoisted.acquireSharedMatrixClient).not.toHaveBeenCalled();
  });

  it("publishes disconnected startup status and connected sync status without failing the monitor", async () => {
    const abortController = new AbortController();
    const monitorPromise = monitorMatrixProvider({
      abortSignal: abortController.signal,
      setStatus: hoisted.setStatus,
    });

    await waitForCallOrderEntry("start-client");

    expectStatusCallFields({
      accountId: "default",
      baseUrl: "https://matrix.example.org",
      connected: false,
      healthState: "starting",
    });

    hoisted.client.emit("sync.state", "SYNCING", "RECONNECTING", undefined);

    expectStatusCallFields({
      accountId: "default",
      connected: true,
      healthState: "healthy",
      lastError: null,
    });

    abortController.abort();
    await expect(monitorPromise).resolves.toBeUndefined();
  });

  it("re-arms the healthy-sync milestone across reconnect transitions", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T16:21:00.000Z"));
    const abortController = new AbortController();
    try {
      const monitorPromise = monitorMatrixProvider({
        abortSignal: abortController.signal,
        setStatus: hoisted.setStatus,
      });

      await waitForCallOrderEntry("start-client");

      const getHealthySyncSinceMs = hoisted.registeredHealthySyncGetter;
      if (!getHealthySyncSinceMs) {
        throw new Error("expected healthy sync getter to be registered");
      }

      expect(getHealthySyncSinceMs()).toBeUndefined();

      hoisted.client.emit("sync.state", "SYNCING", "RECONNECTING", undefined);
      const firstHealthySyncSinceMs = Date.now();
      expect(getHealthySyncSinceMs()).toBe(firstHealthySyncSinceMs);

      await vi.advanceTimersByTimeAsync(3_000);
      hoisted.client.emit("sync.state", "CATCHUP", "SYNCING", undefined);
      expect(getHealthySyncSinceMs()).toBe(firstHealthySyncSinceMs);

      await vi.advanceTimersByTimeAsync(2_000);
      hoisted.client.emit("sync.state", "PREPARED", "CATCHUP", undefined);
      expect(getHealthySyncSinceMs()).toBe(firstHealthySyncSinceMs);

      await vi.advanceTimersByTimeAsync(5_000);
      hoisted.client.emit("sync.state", "RECONNECTING", "SYNCING", new Error("network flap"));
      expect(getHealthySyncSinceMs()).toBeUndefined();

      await vi.advanceTimersByTimeAsync(7_000);
      hoisted.client.emit("sync.state", "SYNCING", "RECONNECTING", undefined);
      const rearmedHealthySyncSinceMs = Date.now();
      expect(getHealthySyncSinceMs()).toBe(rearmedHealthySyncSinceMs);

      abortController.abort();
      await expect(monitorPromise).resolves.toBeUndefined();

      hoisted.client.emit("sync.state", "RECONNECTING", "SYNCING", new Error("late noise"));
      expect(getHealthySyncSinceMs()).toBe(rearmedHealthySyncSinceMs);
    } finally {
      vi.useRealTimers();
    }
  });

  it("contains room-message handler rejections inside monitor task tracking", async () => {
    const abortController = new AbortController();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };

    hoisted.createMatrixRoomMessageHandler.mockReturnValue(
      vi.fn(async () => {
        throw new Error("room handler exploded");
      }),
    );

    process.on("unhandledRejection", onUnhandled);
    try {
      const monitorPromise = monitorMatrixProvider({ abortSignal: abortController.signal });
      await waitForCallOrderEntry("start-client");

      const onRoomMessage = registeredRoomMessageHandler();

      await onRoomMessage("!room:example.org", { event_id: "$event" });
      await Promise.resolve();

      expect(unhandled).toHaveLength(0);
      expect(mockCallArg(hoisted.logger.warn, 0, 0)).toBe("matrix background task failed");
      const warningMetadata = mockCallArg(hoisted.logger.warn, 0, 1) as Record<string, unknown>;
      expect(warningMetadata.task).toBe("test room message");
      expect(warningMetadata.error).toBe("Error: room handler exploded");

      abortController.abort();
      await monitorPromise;
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("fails the channel task when Matrix sync emits an unexpected fatal error", async () => {
    const abortController = new AbortController();
    const monitorPromise = monitorMatrixProvider({
      abortSignal: abortController.signal,
      setStatus: hoisted.setStatus,
    });

    await waitForCallOrderEntry("start-client");

    hoisted.client.emit("sync.unexpected_error", new Error("sync exploded"));

    await expect(monitorPromise).rejects.toThrow("sync exploded");
    expectPersistRelease();
    expectStatusCallFields({
      accountId: "default",
      connected: false,
      healthState: "error",
      lastError: "sync exploded",
    });
  });

  it("marks early startup failures as error before the monitor loop starts", async () => {
    hoisted.acquireSharedMatrixClient.mockRejectedValue(new Error("prepare failed"));

    await expect(
      monitorMatrixProvider({
        setStatus: hoisted.setStatus,
      }),
    ).rejects.toThrow("prepare failed");

    expect(hoisted.releaseSharedClientInstance).not.toHaveBeenCalled();
    expectLastStatusFields({
      accountId: "default",
      connected: false,
      healthState: "error",
      lastError: "prepare failed",
    });
  });

  it("releases the prepared client when startup fails before later resources exist", async () => {
    hoisted.createMatrixInboundEventDeduper.mockImplementation(() => {
      throw new Error("deduper failed");
    });

    await expect(
      monitorMatrixProvider({
        setStatus: hoisted.setStatus,
      }),
    ).rejects.toThrow("deduper failed");

    expectPersistRelease();
    expectLastStatusFields({
      accountId: "default",
      connected: false,
      healthState: "error",
      lastError: "deduper failed",
    });
  });

  it("aborts stalled startup promptly and releases the shared client without persist", async () => {
    const abortController = new AbortController();
    hoisted.resolveSharedMatrixClient.mockImplementation(async (abortSignal?: AbortSignal) => {
      hoisted.callOrder.push("start-client");
      return await new Promise<typeof hoisted.client>((_resolve, reject) => {
        abortSignal?.addEventListener(
          "abort",
          () => {
            const error = new Error("Matrix startup aborted");
            error.name = "AbortError";
            reject(error);
          },
          { once: true },
        );
      });
    });

    const monitorPromise = monitorMatrixProvider({ abortSignal: abortController.signal });

    await waitForCallOrderEntry("start-client");

    abortController.abort();

    await expect(monitorPromise).resolves.toBeUndefined();
    expect(hoisted.releaseSharedClientInstance).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "stop" }),
    );
    expect(hoisted.client.drainPendingDecryptions).not.toHaveBeenCalled();
  });

  it("aborts during startup maintenance and releases the shared client without persist", async () => {
    const abortController = new AbortController();
    const handler = vi.fn(async () => {});
    hoisted.createMatrixRoomMessageHandler.mockReturnValue(handler);
    hoisted.runMatrixStartupMaintenance.mockImplementation(
      async (params: { abortSignal?: AbortSignal }) =>
        await new Promise<void>((_resolve, reject) => {
          params.abortSignal?.addEventListener(
            "abort",
            () => {
              const error = new Error("Matrix startup aborted");
              error.name = "AbortError";
              reject(error);
            },
            { once: true },
          );
        }),
    );

    const monitorPromise = monitorMatrixProvider({ abortSignal: abortController.signal });

    await flushUntil(
      () => hoisted.runMatrixStartupMaintenance.mock.calls.length === 1,
      "expected startup maintenance to run",
    );

    abortController.abort();

    await expect(monitorPromise).resolves.toBeUndefined();
    expect(hoisted.releaseSharedClientInstance).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "stop" }),
    );
    expect(hoisted.client.drainPendingDecryptions).not.toHaveBeenCalled();
    await hoisted.registeredOnRoomMessage?.("!room:example.org", { event_id: "$late" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("disposes resources installed after forced retirement wins setup", async () => {
    const stopLateManager = vi.fn();
    let resolveManager: (manager: {
      accountId: string;
      stop: typeof stopLateManager;
    }) => void = () => {};
    const managerReady = new Promise<{
      accountId: string;
      stop: typeof stopLateManager;
    }>((resolve) => {
      resolveManager = resolve;
    });
    hoisted.createThreadBindingManager.mockImplementation(async () => {
      hoisted.callOrder.push("create-manager");
      return await managerReady;
    });

    const monitorPromise = monitorMatrixProvider();
    await waitForCallOrderEntry("create-manager");

    await hoisted.runRegisteredMonitorRetirement();
    expect(hoisted.disposeAutoJoin).toHaveBeenCalledTimes(1);
    expect(hoisted.client.listenerCount("sync.state")).toBe(0);
    expect(hoisted.registerMatrixMonitorEvents).not.toHaveBeenCalled();

    resolveManager({
      accountId: "default",
      stop: stopLateManager,
    });
    await expect(monitorPromise).resolves.toBeUndefined();

    expect(stopLateManager).toHaveBeenCalledTimes(1);
    expect(hoisted.resolveSharedMatrixClient).not.toHaveBeenCalled();
    expect(hoisted.registerMatrixMonitorEvents).not.toHaveBeenCalled();
    expect(hoisted.releaseSharedClientInstance).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "stop" }),
    );
    expect(hoisted.disposeAutoJoin).toHaveBeenCalledTimes(1);
    expect(hoisted.client.listenerCount("sync.state")).toBe(0);
  });

  it("registers Matrix thread bindings before starting the client", async () => {
    await startMonitorAndAbortAfterStartup();

    expect(hoisted.callOrder).toEqual([
      "prepare-client",
      "create-manager",
      "register-events",
      "start-client",
      "dispose-auto-join",
      "dispose-monitor-events",
    ]);
    expect(hoisted.acquireSharedMatrixClient).toHaveBeenCalledWith(
      expect.objectContaining({ startClient: false }),
    );
    expect(hoisted.stopThreadBindingManager).toHaveBeenCalledTimes(1);
  });

  it("starts monitoring without waiting for best-effort deviceId backfill", async () => {
    hoisted.backfillMatrixAuthDeviceIdAfterStartup.mockImplementation(
      () => new Promise<undefined>(() => {}),
    );

    const abortController = new AbortController();
    const monitorPromise = monitorMatrixProvider({ abortSignal: abortController.signal });

    await waitForCallOrderEntry("start-client");
    expect(hoisted.backfillMatrixAuthDeviceIdAfterStartup).toHaveBeenCalledTimes(1);
    const backfillParams = mockCallArg(hoisted.backfillMatrixAuthDeviceIdAfterStartup) as {
      abortSignal?: AbortSignal;
    };
    expect(backfillParams.abortSignal).not.toBe(abortController.signal);
    expect(backfillParams.abortSignal?.aborted).toBe(false);

    abortController.abort();
    expect(backfillParams.abortSignal?.aborted).toBe(true);
    await expect(monitorPromise).resolves.toBeUndefined();
  });

  it("terminates a fully started monitor when forced retirement aborts its lease", async () => {
    const monitorPromise = monitorMatrixProvider();
    await flushUntil(
      () =>
        hoisted.runMatrixStartupMaintenance.mock.calls.length === 1 &&
        hoisted.registerChannelRuntimeContext.mock.calls.length === 1,
      "expected monitor startup consumers to be registered",
    );

    const startSignal = mockCallArg(hoisted.resolveSharedMatrixClient, 0, 0) as AbortSignal;
    const backfillParams = mockCallArg(hoisted.backfillMatrixAuthDeviceIdAfterStartup) as {
      abortSignal?: AbortSignal;
    };
    const runtimeContextParams = mockCallArg(hoisted.registerChannelRuntimeContext) as {
      abortSignal?: AbortSignal;
    };
    const maintenanceParams = mockCallArg(hoisted.runMatrixStartupMaintenance) as {
      abortSignal?: AbortSignal;
    };
    expect(startSignal).toBe(hoisted.state.leaseAbortController.signal);
    expect(backfillParams.abortSignal).toBe(startSignal);
    expect(runtimeContextParams.abortSignal).toBe(startSignal);
    expect(maintenanceParams.abortSignal).toBe(startSignal);
    expect(startSignal.aborted).toBe(false);

    hoisted.state.leaseAbortController.abort();
    await hoisted.runRegisteredMonitorRetirement();
    await expect(monitorPromise).resolves.toBeUndefined();

    expect(startSignal.aborted).toBe(true);
    expect(hoisted.releaseSharedClientInstance).toHaveBeenCalledTimes(1);
    expect(hoisted.stopThreadBindingManager).toHaveBeenCalledTimes(1);
    expect(hoisted.client.listenerCount("sync.state")).toBe(0);
  });

  it("cleans up thread bindings and shared clients when startup fails", async () => {
    hoisted.state.startClientError = new Error("start failed");

    await expect(monitorMatrixProvider()).rejects.toThrow("start failed");

    expect(hoisted.stopThreadBindingManager).toHaveBeenCalledTimes(1);
    expect(hoisted.releaseSharedClientInstance).toHaveBeenCalledTimes(1);
    expectPersistRelease();
  });

  it("disables cold-start backlog dropping only when sync state is cleanly persisted", async () => {
    hoisted.client.hasPersistedSyncState.mockReturnValue(true);
    await startMonitorAndAbortAfterStartup();

    const handlerParams = mockCallArg(hoisted.createMatrixRoomMessageHandler) as {
      dropPreStartupMessages?: unknown;
    };
    expect(handlerParams.dropPreStartupMessages).toBe(false);
  });

  it("detaches listeners, closes admission, waits for handlers, then releases", async () => {
    const abortController = new AbortController();
    const pendingHandlers = new Map<string, () => void>();
    let finishManagerStop: (() => void) | undefined;

    hoisted.createMatrixRoomMessageHandler.mockReturnValue(
      vi.fn((_roomId: string, event: unknown) => {
        const eventId = (event as { event_id: string }).event_id;
        hoisted.callOrder.push(`handler-start:${eventId}`);
        return new Promise<void>((resolve) => {
          pendingHandlers.set(eventId, () => {
            hoisted.callOrder.push(`handler-done:${eventId}`);
            resolve();
          });
        });
      }),
    );
    hoisted.client.drainPendingDecryptions.mockImplementation(async () => {
      hoisted.callOrder.push("drain-decrypts");
    });
    hoisted.stopThreadBindingManager.mockImplementation(async () => {
      hoisted.callOrder.push("stop-manager");
      await new Promise<void>((resolve) => {
        finishManagerStop = () => {
          hoisted.callOrder.push("manager-stopped");
          resolve();
        };
      });
    });
    hoisted.releaseSharedClientInstance.mockImplementation(async () => {
      await hoisted.client.drainPendingDecryptions();
      await hoisted.runRegisteredMonitorRetirement();
      hoisted.callOrder.push("release-client");
    });

    const monitorPromise = monitorMatrixProvider({ abortSignal: abortController.signal });
    await waitForCallOrderEntry("start-client");
    const onRoomMessage = registeredRoomMessageHandler();

    const roomMessagePromise = onRoomMessage("!room:example.org", { event_id: "$event" });
    abortController.abort();
    await waitForCallOrderEntry("dispose-monitor-events");
    expect(hoisted.callOrder).not.toContain("stop-manager");
    expect(hoisted.callOrder).not.toContain("release-client");

    await onRoomMessage("!room:example.org", { event_id: "$late" });
    expect(hoisted.callOrder).not.toContain("handler-start:$late");

    pendingHandlers.get("$event")?.();
    await roomMessagePromise;
    await waitForCallOrderEntry("stop-manager");
    expect(hoisted.callOrder).not.toContain("release-client");

    finishManagerStop?.();
    await monitorPromise;

    expect(hoisted.callOrder.indexOf("drain-decrypts")).toBeLessThan(
      hoisted.callOrder.indexOf("dispose-auto-join"),
    );
    expect(hoisted.callOrder.indexOf("dispose-auto-join")).toBeLessThan(
      hoisted.callOrder.indexOf("handler-done:$event"),
    );
    expect(hoisted.callOrder.indexOf("dispose-monitor-events")).toBeLessThan(
      hoisted.callOrder.indexOf("handler-done:$event"),
    );
    expect(hoisted.callOrder.indexOf("handler-done:$event")).toBeLessThan(
      hoisted.callOrder.indexOf("stop-manager"),
    );
    expect(hoisted.callOrder.indexOf("stop-manager")).toBeLessThan(
      hoisted.callOrder.indexOf("manager-stopped"),
    );
    expect(hoisted.callOrder.indexOf("manager-stopped")).toBeLessThan(
      hoisted.callOrder.indexOf("release-client"),
    );
  });

  it("cleans up local monitor work after a retained shared-client release", async () => {
    const abortController = new AbortController();
    let finishHandler: (() => void) | undefined;
    hoisted.createMatrixRoomMessageHandler.mockReturnValue(
      vi.fn(() => {
        hoisted.callOrder.push("handler-start");
        return new Promise<void>((resolve) => {
          finishHandler = () => {
            hoisted.callOrder.push("handler-done");
            resolve();
          };
        });
      }),
    );
    hoisted.stopThreadBindingManager.mockImplementation(() => {
      hoisted.callOrder.push("stop-manager");
    });
    hoisted.releaseSharedClientInstance.mockImplementation(async () => {
      await hoisted.runRegisteredMonitorRetirement();
      hoisted.callOrder.push("release-retained");
    });

    const monitorPromise = monitorMatrixProvider({ abortSignal: abortController.signal });
    await waitForCallOrderEntry("start-client");
    const onRoomMessage = registeredRoomMessageHandler();

    const roomMessagePromise = onRoomMessage("!room:example.org", { event_id: "$event" });
    await waitForCallOrderEntry("handler-start");
    abortController.abort();
    await waitForCallOrderEntry("dispose-monitor-events");

    expect(hoisted.client.drainPendingDecryptions).not.toHaveBeenCalled();
    expect(hoisted.callOrder).not.toContain("release-retained");

    finishHandler?.();
    await roomMessagePromise;
    await monitorPromise;

    expect(hoisted.callOrder.indexOf("handler-done")).toBeLessThan(
      hoisted.callOrder.indexOf("stop-manager"),
    );
    expect(hoisted.callOrder.indexOf("stop-manager")).toBeLessThan(
      hoisted.callOrder.indexOf("release-retained"),
    );
  });

  it("wires recent-invite promotion to fail closed when room metadata is unresolved", async () => {
    await startMonitorAndAbortAfterStartup();

    const trackerOpts = directRoomTrackerOptions();
    if (!trackerOpts?.canPromoteRecentInvite) {
      throw new Error("recent invite promotion callback was not wired");
    }

    hoisted.getRoomInfo.mockResolvedValueOnce({
      altAliases: [],
      nameResolved: false,
      aliasesResolved: false,
    });

    await expect(trackerOpts.canPromoteRecentInvite("!room:example.org")).resolves.toBe(false);
  });

  it("wires exact room config as a direct-room classifier veto", async () => {
    (hoisted.accountConfig as { rooms?: Record<string, unknown> }).rooms = {
      "!room:example.org": { requireMention: true },
      "*": { requireMention: false },
    };

    await startMonitorAndAbortAfterStartup();

    const trackerOpts = directRoomTrackerOptions();
    if (!trackerOpts?.isExplicitlyConfiguredRoom) {
      throw new Error("explicit room config callback was not wired");
    }

    expect(await trackerOpts.isExplicitlyConfiguredRoom("!room:example.org")).toBe(true);
    expect(await trackerOpts.isExplicitlyConfiguredRoom("!other:example.org")).toBe(false);
    expect(hoisted.getRoomInfo).not.toHaveBeenCalled();
  });

  it("wires alias room config as a direct-room classifier veto", async () => {
    (hoisted.accountConfig as { rooms?: Record<string, unknown> }).rooms = {
      "#ops:example.org": { requireMention: true },
      "*": { requireMention: false },
    };
    const { resolveMatrixTargets } = await import("../../resolve-targets.js");
    vi.mocked(resolveMatrixTargets).mockResolvedValueOnce([
      {
        input: "#ops:example.org",
        resolved: true,
        id: "!room:example.org",
      },
    ]);

    await startMonitorAndAbortAfterStartup();

    const trackerOpts = directRoomTrackerOptions();
    if (!trackerOpts?.isExplicitlyConfiguredRoom) {
      throw new Error("explicit room config callback was not wired");
    }

    hoisted.getRoomInfo.mockResolvedValueOnce({
      canonicalAlias: "#ops:example.org",
      altAliases: [],
      nameResolved: true,
      aliasesResolved: true,
    });

    expect(await trackerOpts.isExplicitlyConfiguredRoom("!room:example.org")).toBe(true);
  });

  it("wires recent-invite promotion to reject named rooms", async () => {
    await startMonitorAndAbortAfterStartup();

    const trackerOpts = directRoomTrackerOptions();
    if (!trackerOpts?.canPromoteRecentInvite) {
      throw new Error("recent invite promotion callback was not wired");
    }

    hoisted.getRoomInfo.mockResolvedValueOnce({
      name: "Ops Room",
      altAliases: [],
      nameResolved: true,
      aliasesResolved: true,
    });

    await expect(trackerOpts.canPromoteRecentInvite("!room:example.org")).resolves.toBe(false);
  });

  it("wires recent-invite promotion to reject wildcard-configured rooms", async () => {
    (hoisted.accountConfig as { rooms?: Record<string, unknown> }).rooms = {
      "*": { enabled: false },
    };

    await startMonitorAndAbortAfterStartup();

    const trackerOpts = directRoomTrackerOptions();
    if (!trackerOpts?.canPromoteRecentInvite) {
      throw new Error("recent invite promotion callback was not wired");
    }

    hoisted.getRoomInfo.mockResolvedValueOnce({
      altAliases: [],
      nameResolved: true,
      aliasesResolved: true,
    });

    await expect(trackerOpts.canPromoteRecentInvite("!room:example.org")).resolves.toBe(false);
  });

  it("does not wire unmapped strict room promotion for per-user DM scope", async () => {
    await startMonitorAndAbortAfterStartup();

    const trackerOpts = directRoomTrackerOptions();

    expect(trackerOpts?.canPromoteUnmappedStrictRoom).toBeUndefined();
  });

  it("wires per-room unmapped strict room promotion through the room metadata gate", async () => {
    hoisted.accountConfig.dm = { sessionScope: "per-room" };

    await startMonitorAndAbortAfterStartup();

    const trackerOpts = directRoomTrackerOptions();
    if (!trackerOpts?.canPromoteUnmappedStrictRoom) {
      throw new Error("per-room strict fallback callback was not wired");
    }

    hoisted.getRoomInfo.mockResolvedValueOnce({
      altAliases: [],
      nameResolved: true,
      aliasesResolved: true,
    });
    await expect(trackerOpts.canPromoteUnmappedStrictRoom("!dm:example.org")).resolves.toBe(true);

    hoisted.getRoomInfo.mockResolvedValueOnce({
      name: "Ops Room",
      altAliases: [],
      nameResolved: true,
      aliasesResolved: true,
    });
    await expect(trackerOpts.canPromoteUnmappedStrictRoom("!ops:example.org")).resolves.toBe(false);
  });

  it("treats unresolved room metadata as indeterminate for local promotion revalidation", async () => {
    await startMonitorAndAbortAfterStartup();

    const trackerOpts = directRoomTrackerOptions();
    if (!trackerOpts?.shouldKeepLocallyPromotedDirectRoom) {
      throw new Error("local promotion revalidation callback was not wired");
    }

    hoisted.getRoomInfo.mockResolvedValueOnce({
      altAliases: [],
      nameResolved: false,
      aliasesResolved: false,
    });

    await expect(
      trackerOpts.shouldKeepLocallyPromotedDirectRoom("!room:example.org"),
    ).resolves.toBeUndefined();
  });
});
