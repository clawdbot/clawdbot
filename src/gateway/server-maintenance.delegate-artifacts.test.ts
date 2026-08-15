import { afterEach, describe, expect, it, vi } from "vitest";
import { createGatewayMaintenanceStateForTest } from "./test-helpers.maintenance-state.js";

function createMaintenanceTimerDeps() {
  return {
    ...createGatewayMaintenanceStateForTest(),
    logHealth: { info: vi.fn(), error: vi.fn() },
    runWorktreeGc: vi.fn(async () => undefined),
    runDeliveryQueueMediaGc: vi.fn(async () => undefined),
    runDelegateArtifactGc: vi.fn(async () => 0),
    runManagedOutgoingMediaGc: vi.fn(async () => ({
      deletedRecordCount: 0,
      deletedFileCount: 0,
      retainedCount: 0,
    })),
  };
}

async function stopMaintenanceTimers(timers: {
  tickInterval: NodeJS.Timeout;
  healthInterval: NodeJS.Timeout;
  dedupeCleanup: NodeJS.Timeout;
  stopMediaCleanup: () => Promise<"drained" | "timed-out">;
  worktreeCleanup: NodeJS.Timeout;
  delegateArtifactCleanup: NodeJS.Timeout;
  skillCuratorCleanup: () => void;
}) {
  clearInterval(timers.tickInterval);
  clearInterval(timers.healthInterval);
  clearInterval(timers.dedupeCleanup);
  clearInterval(timers.worktreeCleanup);
  clearInterval(timers.delegateArtifactCleanup);
  await timers.stopMediaCleanup();
  timers.skillCuratorCleanup();
}

describe("delegate artifact gateway maintenance", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("purges expired artifacts at startup, after restart, and hourly", async () => {
    vi.useFakeTimers();
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
    const deps = createMaintenanceTimerDeps();
    const first = startGatewayMaintenanceTimers(deps);

    await vi.advanceTimersByTimeAsync(0);
    expect(deps.runDelegateArtifactGc).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(deps.runDelegateArtifactGc).toHaveBeenCalledTimes(2);
    await stopMaintenanceTimers(first);

    const restarted = startGatewayMaintenanceTimers(deps);
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.runDelegateArtifactGc).toHaveBeenCalledTimes(3);
    await stopMaintenanceTimers(restarted);
  });

  it("drains expired artifacts in bounded batches", async () => {
    vi.useFakeTimers();
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
    const deps = createMaintenanceTimerDeps();
    deps.runDelegateArtifactGc
      .mockResolvedValueOnce(100)
      .mockResolvedValueOnce(100)
      .mockResolvedValueOnce(12);

    const timers = startGatewayMaintenanceTimers(deps);
    clearInterval(timers.delegateArtifactCleanup);
    for (let index = 0; index < 10; index += 1) {
      await Promise.resolve();
    }

    expect(deps.runDelegateArtifactGc).toHaveBeenCalledTimes(3);
    await stopMaintenanceTimers(timers);
  });

  it("yields during long artifact cleanup drains", async () => {
    vi.useFakeTimers();
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
    const deps = createMaintenanceTimerDeps();
    for (let index = 0; index < 12; index += 1) {
      deps.runDelegateArtifactGc.mockResolvedValueOnce(index < 11 ? 100 : 1);
    }

    const timers = startGatewayMaintenanceTimers(deps);
    clearInterval(timers.delegateArtifactCleanup);
    for (let index = 0; index < 20; index += 1) {
      await Promise.resolve();
    }
    expect(deps.runDelegateArtifactGc).toHaveBeenCalledTimes(10);
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.runDelegateArtifactGc).toHaveBeenCalledTimes(12);
    await stopMaintenanceTimers(timers);
  });

  it("stops artifact cleanup draining during maintenance teardown", async () => {
    vi.useFakeTimers();
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
    const deps = createMaintenanceTimerDeps();
    let releaseBatch: ((purged: number) => void) | undefined;
    deps.runDelegateArtifactGc.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseBatch = resolve;
        }),
    );

    const timers = startGatewayMaintenanceTimers(deps);
    await Promise.resolve();
    await Promise.resolve();
    expect(deps.runDelegateArtifactGc).toHaveBeenCalledTimes(1);
    timers.skillCuratorCleanup();
    releaseBatch?.(100);
    await Promise.resolve();
    await Promise.resolve();

    expect(deps.runDelegateArtifactGc).toHaveBeenCalledTimes(1);
    await stopMaintenanceTimers(timers);
  });
});
