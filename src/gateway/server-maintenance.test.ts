// Gateway maintenance tests cover periodic cleanup for media, dedupe records,
// stale chat buffers, expired runs, health summaries, and timer disposal.
import { afterEach, describe, expect, it, vi } from "vitest";
import { managedWorktrees } from "../agents/worktrees/service.js";
import type { HealthSummary } from "./health/types.js";
const CURATOR_INITIAL_DELAY_MS = 5 * 60_000;
const CURATOR_SWEEP_INTERVAL_MS = 24 * 60 * 60_000;
import type { ChatAbortControllerEntry } from "./chat-abort.js";
import { DEDUPE_MAX, DEDUPE_TTL_MS } from "./server-constants.js";
import { pendingChatSendDedupeKey } from "./server-shared.js";
import { createGatewayMaintenanceStateForTest } from "./test-helpers.maintenance-state.js";

const cleanOldMediaMock = vi.fn(async () => {});
const prunePlaybackTranscodeCacheMock = vi.fn(async () => {});
const cleanupManagedOutgoingMediaRecordsMock = vi.fn(async () => ({
  deletedRecordCount: 0,
  deletedFileCount: 0,
  retainedCount: 0,
}));

vi.mock("../media/store.js", async () => {
  const actual = await vi.importActual<typeof import("../media/store.js")>("../media/store.js");
  return {
    ...actual,
    cleanOldMedia: cleanOldMediaMock,
    prunePlaybackTranscodeCache: prunePlaybackTranscodeCacheMock,
  };
});

const MEDIA_CLEANUP_TTL_MS = 24 * 60 * 60_000;
const ABORTED_RUN_TTL_MS = 60 * 60_000;

function createActiveRun(
  sessionKey: string,
  kind?: ChatAbortControllerEntry["kind"],
): ChatAbortControllerEntry {
  const now = Date.now();
  return {
    controller: new AbortController(),
    sessionId: "sess-1",
    sessionKey,
    startedAtMs: now,
    expiresAtMs: now + ABORTED_RUN_TTL_MS,
    kind,
  };
}

function createMaintenanceTimerDeps() {
  return {
    ...createGatewayMaintenanceStateForTest(),
    logHealth: { error: vi.fn() },
    runWorktreeGc: vi.fn(async () => undefined),
    runDeliveryQueueMediaGc: vi.fn(async () => undefined),
    runManagedOutgoingMediaGc: cleanupManagedOutgoingMediaRecordsMock,
  };
}

type MaintenanceTimerDeps = ReturnType<typeof createMaintenanceTimerDeps>;

function staleRunTimestamp(): number {
  return Date.now() - ABORTED_RUN_TTL_MS - 1;
}

function seedStaleRunBuffers(deps: MaintenanceTimerDeps, runId: string): void {
  Object.assign(deps.chatRunState.getOrCreate(runId), {
    buffer: "buffer",
    rawBuffer: "raw buffer",
    bufferUpdatedAt: staleRunTimestamp(),
    deltaSentAt: staleRunTimestamp(),
    deltaLastBroadcastLen: 6,
    deltaLastBroadcastText: "buffer",
  });
}

function expectStaleRunBuffersPresent(deps: MaintenanceTimerDeps, runId: string): void {
  expect(deps.chatRunState.runs.get(runId)).toMatchObject({
    buffer: "buffer",
    rawBuffer: "raw buffer",
    bufferUpdatedAt: expect.any(Number),
    deltaSentAt: expect.any(Number),
    deltaLastBroadcastLen: 6,
    deltaLastBroadcastText: "buffer",
  });
}

function expectStaleRunBuffersSwept(deps: MaintenanceTimerDeps, runId: string): void {
  const run = deps.chatRunState.runs.get(runId);
  expect(run?.buffer).toBeUndefined();
  expect(run?.rawBuffer).toBeUndefined();
  expect(run?.bufferUpdatedAt).toBeUndefined();
  expect(run?.deltaSentAt).toBeUndefined();
  expect(run?.deltaLastBroadcastLen).toBeUndefined();
  expect(run?.deltaLastBroadcastText).toBeUndefined();
}

function seedBufferedAgentEvent(deps: MaintenanceTimerDeps, runId: string): void {
  deps.chatRunState.getOrCreate(runId).agentText = {
    assistant: {
      bufferedEvent: {
        payload: {
          runId,
          seq: 1,
          stream: "assistant",
          ts: Date.now(),
          data: { text: "buffer", delta: "buffer" },
        },
      },
    },
  };
}

function seedStableDedupeEntries(deps: MaintenanceTimerDeps, now: number): void {
  for (let index = 0; index < DEDUPE_MAX; index += 1) {
    deps.dedupe.set(`stable-${index}`, { ts: now - 1_000 + index, ok: true });
  }
}

async function createTimedMaintenanceScenario() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-03-22T00:00:00Z"));
  const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
  const deps = createMaintenanceTimerDeps();
  return { startGatewayMaintenanceTimers, deps, now: Date.now() };
}

async function stopMaintenanceTimers(timers: {
  tickInterval: NodeJS.Timeout;
  healthInterval: NodeJS.Timeout;
  dedupeCleanup: NodeJS.Timeout;
  startMediaCleanup: () => void;
  stopMediaCleanup: () => Promise<"drained" | "timed-out">;
  worktreeCleanup: NodeJS.Timeout;
  skillCuratorCleanup: () => void;
}) {
  clearInterval(timers.tickInterval);
  clearInterval(timers.healthInterval);
  clearInterval(timers.dedupeCleanup);
  clearInterval(timers.worktreeCleanup);
  await timers.stopMediaCleanup();
  timers.skillCuratorCleanup();
}

describe("startGatewayMaintenanceTimers", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    cleanOldMediaMock.mockReset().mockResolvedValue(undefined);
    prunePlaybackTranscodeCacheMock.mockReset().mockResolvedValue(undefined);
    cleanupManagedOutgoingMediaRecordsMock.mockReset().mockResolvedValue({
      deletedRecordCount: 0,
      deletedFileCount: 0,
      retainedCount: 0,
    });
  });

  it("does not run media cleanup before the lifecycle owner activates it", async () => {
    vi.useFakeTimers();
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
    const timers = startGatewayMaintenanceTimers({
      ...createMaintenanceTimerDeps(),
      mediaCleanupTtlMs: MEDIA_CLEANUP_TTL_MS,
    });

    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(prunePlaybackTranscodeCacheMock).not.toHaveBeenCalled();
    expect(cleanupManagedOutgoingMediaRecordsMock).not.toHaveBeenCalled();
    expect(cleanOldMediaMock).not.toHaveBeenCalled();

    await timers.stopMediaCleanup();
    timers.startMediaCleanup();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(prunePlaybackTranscodeCacheMock).not.toHaveBeenCalled();
    expect(cleanupManagedOutgoingMediaRecordsMock).not.toHaveBeenCalled();
    expect(cleanOldMediaMock).not.toHaveBeenCalled();
    await stopMaintenanceTimers(timers);
  });

  it("runs playback cache cleanup at startup and hourly without an attachment ttl", async () => {
    vi.useFakeTimers();
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");

    const timers = startGatewayMaintenanceTimers(createMaintenanceTimerDeps());
    timers.startMediaCleanup();

    await vi.advanceTimersByTimeAsync(0);
    expect(prunePlaybackTranscodeCacheMock).toHaveBeenCalledTimes(1);
    expect(cleanOldMediaMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(prunePlaybackTranscodeCacheMock).toHaveBeenCalledTimes(2);
    expect(cleanOldMediaMock).not.toHaveBeenCalled();

    await stopMaintenanceTimers(timers);
  });

  it("runs managed outgoing cleanup without enabling the general media ttl", async () => {
    vi.useFakeTimers();
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");

    const timers = startGatewayMaintenanceTimers(createMaintenanceTimerDeps());
    timers.startMediaCleanup();

    await vi.waitFor(() => {
      expect(cleanupManagedOutgoingMediaRecordsMock).toHaveBeenCalledTimes(1);
    });
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    await vi.waitFor(() => {
      expect(cleanupManagedOutgoingMediaRecordsMock).toHaveBeenCalledTimes(2);
    });

    await stopMaintenanceTimers(timers);
  });

  it("runs managed worktree cleanup at startup and hourly", async () => {
    vi.useFakeTimers();
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
    const deps = createMaintenanceTimerDeps();
    const timers = startGatewayMaintenanceTimers(deps);

    await Promise.resolve();
    expect(deps.runWorktreeGc).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(deps.runWorktreeGc).toHaveBeenCalledTimes(2);

    await stopMaintenanceTimers(timers);
  });

  it("runs queue media cleanup at startup and hourly", async () => {
    vi.useFakeTimers();
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
    const deps = createMaintenanceTimerDeps();
    const timers = startGatewayMaintenanceTimers(deps);

    await vi.advanceTimersByTimeAsync(0);
    expect(deps.runDeliveryQueueMediaGc).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(deps.runDeliveryQueueMediaGc).toHaveBeenCalledTimes(2);

    await stopMaintenanceTimers(timers);
  });

  it("delays collection review and does not overlap runs", async () => {
    vi.useFakeTimers();
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
    let resolveSweep = () => {};
    const sweep = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSweep = resolve;
        }),
    );
    const timers = startGatewayMaintenanceTimers({
      ...createMaintenanceTimerDeps(),
      enableSkillCurator: true,
      runSkillCollectionReconcile: sweep,
    });

    await vi.advanceTimersByTimeAsync(CURATOR_INITIAL_DELAY_MS - 1);
    expect(sweep).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(sweep).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(CURATOR_SWEEP_INTERVAL_MS);
    expect(sweep).toHaveBeenCalledTimes(1);

    resolveSweep();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(CURATOR_SWEEP_INTERVAL_MS);
    expect(sweep).toHaveBeenCalledTimes(2);
    resolveSweep();
    await vi.advanceTimersByTimeAsync(0);

    await stopMaintenanceTimers(timers);
  });

  it("passes owner activity to default managed worktree cleanup", async () => {
    vi.useFakeTimers();
    const gc = vi.spyOn(managedWorktrees, "gc").mockResolvedValue({
      removed: [],
      orphansDeleted: 0,
      snapshotsPruned: 0,
    });
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
    const { runWorktreeGc: _runWorktreeGc, ...deps } = createMaintenanceTimerDeps();

    const timers = startGatewayMaintenanceTimers(deps);
    await Promise.resolve();

    expect(gc).toHaveBeenCalledWith({ shouldProtectOwner: expect.any(Function), limits: {} });
    await stopMaintenanceTimers(timers);
  });

  it("adds configured attachment cleanup to playback maintenance", async () => {
    vi.useFakeTimers();
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");

    const timers = startGatewayMaintenanceTimers({
      ...createMaintenanceTimerDeps(),
      mediaCleanupTtlMs: MEDIA_CLEANUP_TTL_MS,
    });
    timers.startMediaCleanup();

    await vi.advanceTimersByTimeAsync(0);
    expect(prunePlaybackTranscodeCacheMock).toHaveBeenCalledTimes(1);
    expect(cleanOldMediaMock).toHaveBeenCalledWith(MEDIA_CLEANUP_TTL_MS, {
      recursive: true,
      pruneEmptyDirs: true,
    });

    await vi.waitFor(() => {
      expect(cleanupManagedOutgoingMediaRecordsMock).toHaveBeenCalled();
    });
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(prunePlaybackTranscodeCacheMock).toHaveBeenCalledTimes(2);
    expect(cleanOldMediaMock).toHaveBeenCalledTimes(2);
    expect(cleanOldMediaMock).toHaveBeenLastCalledWith(MEDIA_CLEANUP_TTL_MS, {
      recursive: true,
      pruneEmptyDirs: true,
    });

    await stopMaintenanceTimers(timers);
  });

  it("keeps playback cleanup independent of attachment cleanup failures", async () => {
    vi.useFakeTimers();
    cleanOldMediaMock.mockRejectedValueOnce(new Error("synthetic attachment cleanup failure"));
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
    const deps = {
      ...createMaintenanceTimerDeps(),
      logHealth: { error: vi.fn() },
    };

    const timers = startGatewayMaintenanceTimers({
      ...deps,
      mediaCleanupTtlMs: MEDIA_CLEANUP_TTL_MS,
    });
    timers.startMediaCleanup();

    await vi.waitFor(() => {
      expect(deps.logHealth.error).toHaveBeenCalledWith(
        expect.stringContaining("synthetic attachment cleanup failure"),
      );
    });
    expect(prunePlaybackTranscodeCacheMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(prunePlaybackTranscodeCacheMock).toHaveBeenCalledTimes(2);
    expect(cleanOldMediaMock).toHaveBeenCalledTimes(2);

    await stopMaintenanceTimers(timers);
  });

  it("runs managed outgoing cleanup when the general media sweep fails", async () => {
    vi.useFakeTimers();
    cleanOldMediaMock.mockRejectedValueOnce(new Error("synthetic media sweep failure"));
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
    const deps = createMaintenanceTimerDeps();

    const timers = startGatewayMaintenanceTimers({
      ...deps,
      mediaCleanupTtlMs: MEDIA_CLEANUP_TTL_MS,
    });
    timers.startMediaCleanup();

    await vi.waitFor(() => {
      expect(cleanupManagedOutgoingMediaRecordsMock).toHaveBeenCalledTimes(1);
      expect(deps.logHealth.error).toHaveBeenCalledWith(
        expect.stringContaining("synthetic media sweep failure"),
      );
    });

    await vi.advanceTimersByTimeAsync(60 * 60_000);
    await vi.waitFor(() => {
      expect(cleanOldMediaMock).toHaveBeenCalledTimes(2);
      expect(cleanupManagedOutgoingMediaRecordsMock).toHaveBeenCalledTimes(2);
    });

    await stopMaintenanceTimers(timers);
  });

  it("broadcasts tick keepalives without dropIfSlow", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-12T00:00:00Z"));
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
    const broadcast = vi.fn();

    const timers = startGatewayMaintenanceTimers({
      ...createMaintenanceTimerDeps(),
      broadcast,
    });

    broadcast.mockClear();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(broadcast).toHaveBeenCalledWith("tick", { ts: Date.now() });

    await stopMaintenanceTimers(timers);
  });

  it("refreshes automatic health snapshots without live channel probes", async () => {
    vi.useFakeTimers();
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
    const deps = createMaintenanceTimerDeps();
    deps.refreshGatewayHealthSnapshot = vi.fn(async () => ({ ok: true }) as HealthSummary);

    const timers = startGatewayMaintenanceTimers(deps);

    expect(deps.refreshGatewayHealthSnapshot).toHaveBeenCalledWith({ probe: false });

    await vi.advanceTimersByTimeAsync(60_000);

    expect(deps.refreshGatewayHealthSnapshot).toHaveBeenCalledTimes(2);
    expect(deps.refreshGatewayHealthSnapshot).toHaveBeenLastCalledWith({ probe: false });

    await stopMaintenanceTimers(timers);
  });

  it("keeps managed outgoing cleanup independent of a hung general media sweep", async () => {
    vi.useFakeTimers();
    let resolveCleanup = () => {};
    cleanOldMediaMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveCleanup = resolve;
        }),
    );
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");

    const timers = startGatewayMaintenanceTimers({
      ...createMaintenanceTimerDeps(),
      mediaCleanupTtlMs: MEDIA_CLEANUP_TTL_MS,
    });
    timers.startMediaCleanup();

    await vi.waitFor(() => {
      expect(cleanupManagedOutgoingMediaRecordsMock).toHaveBeenCalledTimes(1);
    });
    expect(cleanOldMediaMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(cleanOldMediaMock).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(cleanupManagedOutgoingMediaRecordsMock).toHaveBeenCalledTimes(2);
    });

    resolveCleanup();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(cleanOldMediaMock).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => {
      expect(cleanupManagedOutgoingMediaRecordsMock).toHaveBeenCalledTimes(3);
    });

    resolveCleanup();
    await vi.advanceTimersByTimeAsync(0);
    await stopMaintenanceTimers(timers);
  });

  it("skips overlapping playback cache cleanup runs", async () => {
    vi.useFakeTimers();
    let resolveCleanup = () => {};
    prunePlaybackTranscodeCacheMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveCleanup = resolve;
        }),
    );
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");

    const timers = startGatewayMaintenanceTimers(createMaintenanceTimerDeps());
    timers.startMediaCleanup();

    await vi.advanceTimersByTimeAsync(0);
    expect(prunePlaybackTranscodeCacheMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(prunePlaybackTranscodeCacheMock).toHaveBeenCalledTimes(1);

    resolveCleanup();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(prunePlaybackTranscodeCacheMock).toHaveBeenCalledTimes(2);

    resolveCleanup();
    await vi.advanceTimersByTimeAsync(0);
    await stopMaintenanceTimers(timers);
  });

  it("skips overlapping managed outgoing cleanup runs", async () => {
    vi.useFakeTimers();
    let resolveCleanup = () => {};
    cleanupManagedOutgoingMediaRecordsMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCleanup = () =>
            resolve({ deletedRecordCount: 0, deletedFileCount: 0, retainedCount: 0 });
        }),
    );
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");

    const timers = startGatewayMaintenanceTimers(createMaintenanceTimerDeps());
    timers.startMediaCleanup();

    await vi.waitFor(() => {
      expect(cleanupManagedOutgoingMediaRecordsMock).toHaveBeenCalledTimes(1);
    });
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(cleanupManagedOutgoingMediaRecordsMock).toHaveBeenCalledTimes(1);

    resolveCleanup();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(cleanupManagedOutgoingMediaRecordsMock).toHaveBeenCalledTimes(2);

    resolveCleanup();
    await stopMaintenanceTimers(timers);
  });

  it("waits for active media cleanup before stopping its lifecycle", async () => {
    vi.useFakeTimers();
    let resolvePlaybackCleanup = () => {};
    let resolveManagedCleanup = () => {};
    let resolveGeneralCleanup = () => {};
    prunePlaybackTranscodeCacheMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolvePlaybackCleanup = resolve;
        }),
    );
    cleanupManagedOutgoingMediaRecordsMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveManagedCleanup = () =>
            resolve({ deletedRecordCount: 0, deletedFileCount: 0, retainedCount: 0 });
        }),
    );
    cleanOldMediaMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveGeneralCleanup = resolve;
        }),
    );
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
    const timers = startGatewayMaintenanceTimers({
      ...createMaintenanceTimerDeps(),
      mediaCleanupTtlMs: MEDIA_CLEANUP_TTL_MS,
    });
    timers.startMediaCleanup();
    await vi.waitFor(() => {
      expect(prunePlaybackTranscodeCacheMock).toHaveBeenCalledTimes(1);
      expect(cleanupManagedOutgoingMediaRecordsMock).toHaveBeenCalledTimes(1);
      expect(cleanOldMediaMock).toHaveBeenCalledTimes(1);
    });

    let stopped = false;
    let stopResult: "drained" | "timed-out" | undefined;
    const stopping = timers.stopMediaCleanup().then((result) => {
      stopResult = result;
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);

    resolvePlaybackCleanup();
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    resolveManagedCleanup();
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    resolveGeneralCleanup();
    await stopping;
    expect(stopResult).toBe("drained");

    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(prunePlaybackTranscodeCacheMock).toHaveBeenCalledTimes(1);
    expect(cleanupManagedOutgoingMediaRecordsMock).toHaveBeenCalledTimes(1);
    expect(cleanOldMediaMock).toHaveBeenCalledTimes(1);
    await stopMaintenanceTimers(timers);
  });

  it("bounds shutdown when active media cleanup never settles", async () => {
    vi.useFakeTimers();
    let resolveCleanup = () => {};
    cleanupManagedOutgoingMediaRecordsMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCleanup = () =>
            resolve({ deletedRecordCount: 0, deletedFileCount: 0, retainedCount: 0 });
        }),
    );
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
    const deps = createMaintenanceTimerDeps();
    const timers = startGatewayMaintenanceTimers(deps);
    timers.startMediaCleanup();
    await vi.waitFor(() => {
      expect(cleanupManagedOutgoingMediaRecordsMock).toHaveBeenCalledTimes(1);
    });

    let stopped = false;
    let stopResult: "drained" | "timed-out" | undefined;
    const stopping = timers.stopMediaCleanup().then((result) => {
      stopResult = result;
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await stopping;

    expect(stopped).toBe(true);
    expect(stopResult).toBe("timed-out");
    expect(deps.logHealth.error).toHaveBeenCalledWith(
      "media cleanup drain exceeded 5000ms; retaining shared state until cleanup settles",
    );
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(cleanupManagedOutgoingMediaRecordsMock).toHaveBeenCalledTimes(1);
    resolveCleanup();
    await vi.advanceTimersByTimeAsync(0);
    await stopMaintenanceTimers(timers);
  });

  it("retains the timeout fence across gateway generations", async () => {
    vi.useFakeTimers();
    let resolveOldCleanup = () => {};
    cleanupManagedOutgoingMediaRecordsMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOldCleanup = () =>
            resolve({ deletedRecordCount: 0, deletedFileCount: 0, retainedCount: 0 });
        }),
    );
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
    const oldTimers = startGatewayMaintenanceTimers(createMaintenanceTimerDeps());
    oldTimers.startMediaCleanup();
    await vi.waitFor(() => {
      expect(cleanupManagedOutgoingMediaRecordsMock).toHaveBeenCalledTimes(1);
    });
    const oldStopping = oldTimers.stopMediaCleanup();
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(oldStopping).resolves.toBe("timed-out");

    const restartedTimers = startGatewayMaintenanceTimers(createMaintenanceTimerDeps());
    restartedTimers.startMediaCleanup();
    await vi.advanceTimersByTimeAsync(0);
    expect(cleanupManagedOutgoingMediaRecordsMock).toHaveBeenCalledTimes(1);

    resolveOldCleanup();
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => {
      expect(cleanupManagedOutgoingMediaRecordsMock).toHaveBeenCalledTimes(2);
    });
    await expect(restartedTimers.stopMediaCleanup()).resolves.toBe("drained");
    const settledTimers = startGatewayMaintenanceTimers(createMaintenanceTimerDeps());
    await expect(settledTimers.stopMediaCleanup()).resolves.toBe("drained");
    await stopMaintenanceTimers(oldTimers);
    await stopMaintenanceTimers(restartedTimers);
    await stopMaintenanceTimers(settledTimers);
  });

  it("keeps stale buffers for active runs that still have abort controllers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-22T00:00:00Z"));
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
    const deps = createMaintenanceTimerDeps();
    const runId = "run-active";
    deps.chatAbortControllers.set(runId, createActiveRun("main"));
    seedStaleRunBuffers(deps, runId);

    const timers = startGatewayMaintenanceTimers(deps);

    await vi.advanceTimersByTimeAsync(60_000);

    expectStaleRunBuffersPresent(deps, runId);

    await stopMaintenanceTimers(timers);
  });

  it("sweeps orphaned stale buffers once the abort controller is gone", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-22T00:00:00Z"));
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
    const deps = createMaintenanceTimerDeps();
    const runId = "run-orphaned";
    seedStaleRunBuffers(deps, runId);

    const timers = startGatewayMaintenanceTimers(deps);

    await vi.advanceTimersByTimeAsync(60_000);

    expectStaleRunBuffersSwept(deps, runId);

    await stopMaintenanceTimers(timers);
  });

  it("sweeps orphaned stale agent throttle state once the abort controller is gone", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-22T00:00:00Z"));
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
    const deps = createMaintenanceTimerDeps();
    const runId = "run-agent-orphaned";
    seedBufferedAgentEvent(deps, runId);
    const agentText = deps.chatRunState.getOrCreate(runId).agentText?.assistant;
    expect(agentText).toBeDefined();
    if (agentText) {
      agentText.lastSentAt = staleRunTimestamp();
    }

    const timers = startGatewayMaintenanceTimers(deps);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(deps.chatRunState.runs.get(runId)?.agentText).toBeUndefined();

    await stopMaintenanceTimers(timers);
  });

  it("clears deltaLastBroadcastLen when aborted runs age out", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-22T00:00:00Z"));
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
    const deps = createMaintenanceTimerDeps();
    const runId = "run-aborted";
    deps.chatRunState.getOrCreate(runId).abortMarker = staleRunTimestamp();
    seedStaleRunBuffers(deps, runId);
    seedBufferedAgentEvent(deps, runId);
    const agentText = deps.chatRunState.getOrCreate(runId).agentText?.assistant;
    expect(agentText).toBeDefined();
    if (agentText) {
      agentText.lastSentAt = staleRunTimestamp();
    }

    const timers = startGatewayMaintenanceTimers(deps);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(deps.chatRunState.runs.get(runId)?.abortMarker).toBeUndefined();
    expectStaleRunBuffersSwept(deps, runId);
    expect(deps.chatRunState.runs.get(runId)?.agentText).toBeUndefined();

    await stopMaintenanceTimers(timers);
  });

  it("sweeps orphaned raw buffers that never emitted a delta", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-22T00:00:00Z"));
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
    const deps = createMaintenanceTimerDeps();
    const runId = "run-raw-only";
    Object.assign(deps.chatRunState.getOrCreate(runId), {
      rawBuffer: "suppressed raw buffer",
      bufferUpdatedAt: staleRunTimestamp(),
      deltaLastBroadcastText: "suppressed raw buffer",
    });

    const timers = startGatewayMaintenanceTimers(deps);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(deps.chatRunState.runs.has(runId)).toBe(false);

    await stopMaintenanceTimers(timers);
  });

  it("keeps active agent dedupe entries past the normal ttl", async () => {
    const { startGatewayMaintenanceTimers, deps, now } = await createTimedMaintenanceScenario();
    deps.chatAbortControllers.set("active-agent", createActiveRun("agent:main:main", "agent"));
    deps.dedupe.set("agent:active-agent", {
      ts: now - DEDUPE_TTL_MS - 1,
      ok: true,
      payload: { runId: "active-agent", status: "accepted" },
    });
    deps.dedupe.set("agent:stale-agent", {
      ts: now - DEDUPE_TTL_MS - 1,
      ok: true,
      payload: { runId: "stale-agent", status: "accepted" },
    });

    const timers = startGatewayMaintenanceTimers(deps);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(deps.dedupe.has("agent:active-agent")).toBe(true);
    expect(deps.dedupe.has("agent:stale-agent")).toBe(false);

    await stopMaintenanceTimers(timers);
  });

  it("keeps pending accepted agent dedupe entries until their run expiry", async () => {
    const { startGatewayMaintenanceTimers, deps, now } = await createTimedMaintenanceScenario();
    deps.dedupe.set("agent:pending-agent", {
      ts: now - DEDUPE_TTL_MS - 1,
      ok: true,
      payload: {
        runId: "pending-agent",
        sessionKey: "agent:main:main",
        status: "accepted",
        expiresAtMs: now + 120_000,
      },
    });
    deps.dedupe.set("agent:expired-pending-agent", {
      ts: now - DEDUPE_TTL_MS - 1,
      ok: true,
      payload: {
        runId: "expired-pending-agent",
        sessionKey: "agent:main:main",
        status: "accepted",
        expiresAtMs: now - 1,
      },
    });

    const timers = startGatewayMaintenanceTimers(deps);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(deps.dedupe.has("agent:pending-agent")).toBe(true);
    expect(deps.dedupe.has("agent:expired-pending-agent")).toBe(false);

    await stopMaintenanceTimers(timers);
  });

  it("keeps pending chat sends through ttl and overflow until their run expiry", async () => {
    const { startGatewayMaintenanceTimers, deps, now } = await createTimedMaintenanceScenario();
    seedStableDedupeEntries(deps, now);
    deps.dedupe.set(pendingChatSendDedupeKey("pending-chat"), {
      ts: now - DEDUPE_TTL_MS - 1,
      ok: true,
      payload: {
        runId: "pending-chat",
        sessionKey: "agent:main:main",
        status: "accepted",
        expiresAtMs: now + 120_000,
      },
    });
    deps.dedupe.set(pendingChatSendDedupeKey("expired-chat"), {
      ts: now - DEDUPE_TTL_MS - 1,
      ok: true,
      payload: {
        runId: "expired-chat",
        sessionKey: "agent:main:main",
        status: "accepted",
        expiresAtMs: now - 1,
      },
    });
    const timers = startGatewayMaintenanceTimers(deps);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(deps.dedupe.has(pendingChatSendDedupeKey("pending-chat"))).toBe(true);
    expect(deps.dedupe.has(pendingChatSendDedupeKey("expired-chat"))).toBe(false);
    expect(deps.dedupe.size).toBe(DEDUPE_MAX);

    await stopMaintenanceTimers(timers);
  });

  it("evicts pending accepted agent dedupe entries with invalid run expiry", async () => {
    const { startGatewayMaintenanceTimers, deps, now } = await createTimedMaintenanceScenario();
    deps.dedupe.set("agent:invalid-expiry-pending-agent", {
      ts: now - DEDUPE_TTL_MS - 1,
      ok: true,
      payload: {
        runId: "invalid-expiry-pending-agent",
        sessionKey: "agent:main:main",
        status: "accepted",
        expiresAtMs: Number.POSITIVE_INFINITY,
      },
    });

    const timers = startGatewayMaintenanceTimers(deps);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(deps.dedupe.has("agent:invalid-expiry-pending-agent")).toBe(false);

    await stopMaintenanceTimers(timers);
  });

  it("aborts active runs with invalid expiry timestamps", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-22T00:00:00Z"));
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
    const deps = createMaintenanceTimerDeps();
    const runId = "run-invalid-expiry";
    const activeRun = createActiveRun("main");
    activeRun.expiresAtMs = Number.POSITIVE_INFINITY;
    deps.chatAbortControllers.set(runId, activeRun);

    const timers = startGatewayMaintenanceTimers(deps);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(activeRun.controller.signal.aborted).toBe(true);
    expect(deps.chatAbortControllers.has(runId)).toBe(false);

    await stopMaintenanceTimers(timers);
  });

  it("converts expired stalled terminal persistence into a recovery candidate", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-22T00:00:00Z"));
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
    const deps = createMaintenanceTimerDeps();
    const runId = "run-terminal-persistence";
    const terminalRun = createActiveRun("main");
    terminalRun.expiresAtMs = Date.now() - 1;
    terminalRun.projectSessionActive = false;
    terminalRun.lifecycleGeneration = "generation-1";
    terminalRun.projectSessionTerminalObservedAt = Date.now() - 500;
    terminalRun.projectSessionTerminalPersistence = new Promise<void>(() => {});
    deps.chatAbortControllers.set(runId, terminalRun);

    const timers = startGatewayMaintenanceTimers(deps);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(terminalRun.controller.signal.aborted).toBe(false);
    expect(deps.chatAbortControllers.has(runId)).toBe(false);
    expect(deps.restartRecoveryCandidates.get(runId)).toEqual({
      runId,
      lifecycleGeneration: "generation-1",
      sessionKey: "main",
      sessionId: "sess-1",
      observedAt: Date.now() - 60_500,
    });
    await stopMaintenanceTimers(timers);
  });

  it("reaps expired inactive registrations without emitting a timeout abort", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-22T00:00:00Z"));
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
    const deps = createMaintenanceTimerDeps();
    const runId = "run-terminal-persisted";
    const terminalRun = createActiveRun("main");
    terminalRun.expiresAtMs = Date.now() - 1;
    terminalRun.projectSessionActive = false;
    terminalRun.projectSessionTerminalPersisted = true;
    deps.chatAbortControllers.set(runId, terminalRun);

    const timers = startGatewayMaintenanceTimers(deps);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(terminalRun.controller.signal.aborted).toBe(false);
    expect(deps.chatAbortControllers.has(runId)).toBe(false);
    await stopMaintenanceTimers(timers);
  });

  it("keeps active exec approval dedupe aliases past the normal ttl", async () => {
    const { startGatewayMaintenanceTimers, deps, now } = await createTimedMaintenanceScenario();
    const runId = "exec-approval-followup:req-active:nonce:retry-1";
    deps.chatAbortControllers.set(runId, createActiveRun("agent:main:main", "agent"));
    deps.dedupe.set("agent:exec-approval-followup:req-active", {
      ts: now - DEDUPE_TTL_MS - 1,
      ok: true,
      payload: { runId, status: "accepted" },
    });
    deps.dedupe.set("agent:exec-approval-followup:req-stale", {
      ts: now - DEDUPE_TTL_MS - 1,
      ok: true,
      payload: { runId: "exec-approval-followup:req-stale:nonce:retry-1", status: "accepted" },
    });

    const timers = startGatewayMaintenanceTimers(deps);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(deps.dedupe.has("agent:exec-approval-followup:req-active")).toBe(true);
    expect(deps.dedupe.has("agent:exec-approval-followup:req-stale")).toBe(false);

    await stopMaintenanceTimers(timers);
  });

  it("keeps queued chat dedupe entries past the normal ttl", async () => {
    const { startGatewayMaintenanceTimers, deps, now } = await createTimedMaintenanceScenario();
    const runId = "queued-chat";
    deps.chatQueuedTurns.set(runId, {
      controller: new AbortController(),
      sessionId: "session-main",
      sessionKey: "agent:main:main",
    });
    deps.dedupe.set(`chat:${runId}`, {
      ts: now - DEDUPE_TTL_MS - 1,
      ok: true,
      payload: { runId, status: "ok" },
    });

    const timers = startGatewayMaintenanceTimers(deps);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(deps.dedupe.has(`chat:${runId}`)).toBe(true);
    await stopMaintenanceTimers(timers);
  });

  it("keeps queued chat dedupe entries while trimming overflow", async () => {
    const { startGatewayMaintenanceTimers, deps, now } = await createTimedMaintenanceScenario();
    const runId = "queued-oldest";
    seedStableDedupeEntries(deps, now);
    deps.chatQueuedTurns.set(runId, {
      controller: new AbortController(),
      sessionId: "session-main",
      sessionKey: "agent:main:main",
    });
    deps.dedupe.set(`chat:${runId}`, {
      ts: now - 10_000,
      ok: true,
      payload: { runId, status: "ok" },
    });
    deps.dedupe.set("overflow-newest", { ts: now, ok: true });

    const timers = startGatewayMaintenanceTimers(deps);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(deps.dedupe.size).toBe(DEDUPE_MAX);
    expect(deps.dedupe.has(`chat:${runId}`)).toBe(true);
    expect(deps.dedupe.has("stable-0")).toBe(false);
    await stopMaintenanceTimers(timers);
  });

  it("evicts dedupe overflow by oldest timestamp even after reinsertion", async () => {
    const { startGatewayMaintenanceTimers, deps, now } = await createTimedMaintenanceScenario();

    seedStableDedupeEntries(deps, now);

    deps.dedupe.delete("stable-10");
    deps.dedupe.set("stable-10", { ts: now - 2_000, ok: true });
    deps.dedupe.set("overflow-newest", { ts: now - 100, ok: true });

    const timers = startGatewayMaintenanceTimers(deps);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(deps.dedupe.size).toBe(DEDUPE_MAX);
    expect(deps.dedupe.has("stable-10")).toBe(false);
    expect(deps.dedupe.has("stable-0")).toBe(true);
    expect(deps.dedupe.has("overflow-newest")).toBe(true);

    await stopMaintenanceTimers(timers);
  });

  it("evicts multiple dedupe overflows by oldest timestamp with interleaved reinsertions", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-22T00:00:00Z"));
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
    const deps = createMaintenanceTimerDeps();
    const now = Date.now();

    // Fill to max with sequential timestamps
    for (let index = 0; index < DEDUPE_MAX; index += 1) {
      deps.dedupe.set(`item-${index}`, { ts: now - 10_000 + index, ok: true });
    }

    // Interleave updates and overflows:
    // 1. Move item-0 to be the newest (was oldest)
    deps.dedupe.delete("item-0");
    deps.dedupe.set("item-0", { ts: now, ok: true });

    // 2. Add multiple overflows
    deps.dedupe.set("overflow-1", { ts: now - 5_000, ok: true }); // Should survive (middle age)
    deps.dedupe.set("overflow-2", { ts: now - 20_000, ok: true }); // Should be evicted (oldest)

    // 3. Move item-500 to be very old
    deps.dedupe.delete("item-500");
    deps.dedupe.set("item-500", { ts: now - 30_000, ok: true }); // Should be evicted (new oldest)

    const timers = startGatewayMaintenanceTimers(deps);

    // Initial size is DEDUPE_MAX + 2 (item-0 and item-500 were re-added, overflow-1 and overflow-2 added)
    // Actually:
    // item-1 to item-499 (499)
    // item-501 to item-999 (499)
    // item-0 (1)
    // item-500 (1)
    // overflow-1 (1)
    // overflow-2 (1)
    // Total: 499 + 499 + 1 + 1 + 1 + 1 = 1002
    expect(deps.dedupe.size).toBe(DEDUPE_MAX + 2);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(deps.dedupe.size).toBe(DEDUPE_MAX);

    // item-500 (now - 30k) and overflow-2 (now - 20k) should be gone
    expect(deps.dedupe.has("item-500")).toBe(false);
    expect(deps.dedupe.has("overflow-2")).toBe(false);

    // item-0 (now) and overflow-1 (now - 5k) should remain
    expect(deps.dedupe.has("item-0")).toBe(true);
    expect(deps.dedupe.has("overflow-1")).toBe(true);

    // item-1 (now - 10k + 1) should remain as it is now one of the oldest but not evicted
    expect(deps.dedupe.has("item-1")).toBe(true);

    await stopMaintenanceTimers(timers);
  });

  it("does not evict active agent dedupe entries while trimming overflow", async () => {
    const { startGatewayMaintenanceTimers, deps, now } = await createTimedMaintenanceScenario();

    seedStableDedupeEntries(deps, now);
    deps.chatAbortControllers.set("active-oldest", createActiveRun("agent:main:main", "agent"));
    deps.dedupe.set("agent:active-oldest", {
      ts: now - 10_000,
      ok: true,
      payload: { runId: "active-oldest", status: "accepted" },
    });
    deps.dedupe.set("overflow-newest", { ts: now, ok: true });

    const timers = startGatewayMaintenanceTimers(deps);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(deps.dedupe.size).toBe(DEDUPE_MAX);
    expect(deps.dedupe.has("agent:active-oldest")).toBe(true);
    expect(deps.dedupe.has("stable-0")).toBe(false);
    expect(deps.dedupe.has("stable-1")).toBe(false);
    expect(deps.dedupe.has("overflow-newest")).toBe(true);

    await stopMaintenanceTimers(timers);
  });
});
