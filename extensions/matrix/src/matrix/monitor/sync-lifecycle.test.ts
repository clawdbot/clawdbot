import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createMatrixMonitorStatusController } from "./status.js";
import { createMatrixMonitorSyncLifecycle } from "./sync-lifecycle.js";

function createClientEmitter() {
  return new EventEmitter() as unknown as {
    on: (event: string, listener: (...args: unknown[]) => void) => unknown;
    off: (event: string, listener: (...args: unknown[]) => void) => unknown;
    emit: (event: string, ...args: unknown[]) => boolean;
  };
}

function createSyncLifecycleHarness(options?: { withStopping?: boolean }) {
  const client = createClientEmitter();
  const setStatus = vi.fn();
  let stopping = false;
  const statusController = createMatrixMonitorStatusController({
    accountId: "default",
    statusSink: setStatus,
  });
  const lifecycle = createMatrixMonitorSyncLifecycle({
    client: client as never,
    statusController,
    ...(options?.withStopping ? { isStopping: () => stopping } : {}),
  });

  return {
    client,
    lifecycle,
    setStatus,
    statusController,
    setStopping: (value: boolean) => {
      stopping = value;
    },
  };
}

function statusCalls(setStatus: ReturnType<typeof vi.fn>): Record<string, unknown>[] {
  return setStatus.mock.calls.map(([status]) => status as Record<string, unknown>);
}

function lastStatus(setStatus: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const status = statusCalls(setStatus).at(-1);
  expect(status).toBeDefined();
  return status ?? {};
}

function expectLastStatusFields(
  setStatus: ReturnType<typeof vi.fn>,
  fields: Record<string, unknown>,
): void {
  const status = lastStatus(setStatus);
  for (const [key, value] of Object.entries(fields)) {
    expect(status[key]).toEqual(value);
  }
}

describe("createMatrixMonitorSyncLifecycle", () => {
  it("rejects the channel wait on unexpected sync errors", async () => {
    const { client, lifecycle, setStatus } = createSyncLifecycleHarness();

    const waitPromise = lifecycle.waitForFatalStop();
    client.emit("sync.unexpected_error", new Error("sync exploded"));

    await expect(waitPromise).rejects.toThrow("sync exploded");
    expectLastStatusFields(setStatus, {
      accountId: "default",
      healthState: "error",
      lastError: "sync exploded",
    });
  });

  it("ignores STOPPED emitted during intentional shutdown", async () => {
    const { client, lifecycle, setStatus, setStopping } = createSyncLifecycleHarness({
      withStopping: true,
    });

    const waitPromise = lifecycle.waitForFatalStop();
    setStopping(true);
    client.emit("sync.state", "STOPPED", "SYNCING", undefined);
    lifecycle.dispose();

    await expect(waitPromise).resolves.toBeUndefined();
    expectLastStatusFields(setStatus, {
      accountId: "default",
      healthState: "stopped",
    });
  });

  it("marks unexpected STOPPED sync as an error state", async () => {
    const { client, lifecycle, setStatus } = createSyncLifecycleHarness();

    const waitPromise = lifecycle.waitForFatalStop();
    client.emit("sync.state", "STOPPED", "SYNCING", undefined);

    await expect(waitPromise).rejects.toThrow("Matrix sync stopped unexpectedly");
    expectLastStatusFields(setStatus, {
      accountId: "default",
      healthState: "error",
      lastError: "Matrix sync stopped unexpectedly",
    });
  });

  it("ignores unexpected sync errors emitted during intentional shutdown", async () => {
    const { client, lifecycle, setStatus, setStopping } = createSyncLifecycleHarness({
      withStopping: true,
    });

    const waitPromise = lifecycle.waitForFatalStop();
    setStopping(true);
    client.emit("sync.unexpected_error", new Error("shutdown noise"));
    lifecycle.dispose();

    await expect(waitPromise).resolves.toBeUndefined();
    expect(
      statusCalls(setStatus).some(
        (status) => status.accountId === "default" && status.healthState === "error",
      ),
    ).toBe(false);
  });

  it("ignores non-terminal sync states emitted during intentional shutdown", async () => {
    const { client, lifecycle, setStatus, setStopping, statusController } =
      createSyncLifecycleHarness({
        withStopping: true,
      });

    const waitPromise = lifecycle.waitForFatalStop();
    setStopping(true);
    client.emit("sync.state", "ERROR", "RECONNECTING", new Error("shutdown noise"));
    lifecycle.dispose();
    statusController.markStopped();

    await expect(waitPromise).resolves.toBeUndefined();
    expectLastStatusFields(setStatus, {
      accountId: "default",
      healthState: "stopped",
      lastError: null,
    });
  });

  it("only refreshes transport liveness for successful sync responses", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T16:21:00.000Z"));
    const { client, lifecycle, setStatus } = createSyncLifecycleHarness();
    try {
      setStatus.mockClear();

      client.emit("sync.state", "PREPARED", null, undefined);
      expect(lastStatus(setStatus).lastTransportActivityAt).toBeUndefined();

      await vi.advanceTimersByTimeAsync(2_000);
      client.emit("sync.state", "SYNCING", "PREPARED", undefined);
      const syncAt = Date.now();
      expect(lastStatus(setStatus).lastTransportActivityAt).toBe(syncAt);

      await vi.advanceTimersByTimeAsync(3_000);
      client.emit("sync.state", "CATCHUP", "SYNCING", undefined);
      expect(lastStatus(setStatus).lastTransportActivityAt).toBe(syncAt);
    } finally {
      lifecycle.dispose();
      vi.useRealTimers();
    }
  });

  it("does not downgrade a fatal error to stopped during shutdown", async () => {
    const { client, lifecycle, setStatus, setStopping, statusController } =
      createSyncLifecycleHarness({
        withStopping: true,
      });

    const waitPromise = lifecycle.waitForFatalStop();
    client.emit("sync.unexpected_error", new Error("sync exploded"));
    await expect(waitPromise).rejects.toThrow("sync exploded");

    setStopping(true);
    client.emit("sync.state", "STOPPED", "SYNCING", undefined);
    lifecycle.dispose();
    statusController.markStopped();

    expectLastStatusFields(setStatus, {
      accountId: "default",
      healthState: "error",
      lastError: "sync exploded",
    });
  });

  it("ignores follow-up sync states after a fatal sync error", async () => {
    const { client, lifecycle, setStatus } = createSyncLifecycleHarness();

    const waitPromise = lifecycle.waitForFatalStop();
    client.emit("sync.unexpected_error", new Error("sync exploded"));
    await expect(waitPromise).rejects.toThrow("sync exploded");

    client.emit("sync.state", "RECONNECTING", "SYNCING", new Error("late reconnect"));
    lifecycle.dispose();

    expectLastStatusFields(setStatus, {
      accountId: "default",
      healthState: "error",
      lastError: "sync exploded",
    });
  });

  it("rejects a second concurrent fatal-stop waiter", async () => {
    const { lifecycle } = createSyncLifecycleHarness();

    const firstWait = lifecycle.waitForFatalStop();

    await expect(lifecycle.waitForFatalStop()).rejects.toThrow(
      "Matrix fatal-stop wait already in progress",
    );

    lifecycle.dispose();
    await expect(firstWait).resolves.toBeUndefined();
  });
});
