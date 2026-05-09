import { afterEach, describe, expect, it, vi } from "vitest";
import type { HealthSummary } from "../commands/health.js";
import type { ChatAbortControllerEntry } from "./chat-abort.js";
import { DEDUPE_MAX, DEDUPE_TTL_MS } from "./server-constants.js";

const cleanOldMediaMock = vi.fn(async () => {});

vi.mock("../media/store.js", async () => {
  const actual = await vi.importActual<typeof import("../media/store.js")>("../media/store.js");
  return {
    ...actual,
    cleanOldMedia: cleanOldMediaMock,
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
    broadcast: () => {},
    nodeSendToAllSubscribed: () => {},
    getPresenceVersion: () => 1,
    getHealthVersion: () => 1,
    refreshGatewayHealthSnapshot: async () => ({ ok: true }) as HealthSummary,
    logHealth: { error: () => {} },
    dedupe: new Map(),
    chatAbortControllers: new Map(),
    chatRunState: { abortedRuns: new Map() },
    chatRunBuffers: new Map(),
    chatDeltaSentAt: new Map(),
    chatDeltaLastBroadcastLen: new Map(),
    removeChatRun: () => undefined,
    agentRunSeq: new Map(),
    nodeSendToSession: () => {},
  };
}

function stopMaintenanceTimers(timers: {
  tickInterval: NodeJS.Timeout;
  healthInterval: NodeJS.Timeout;
  dedupeCleanup: NodeJS.Timeout;
  mediaCleanup: NodeJS.Timeout | null;
}) {
  clearInterval(timers.tickInterval);
  clearInterval(timers.healthInterval);
  clearInterval(timers.dedupeCleanup);
  if (timers.mediaCleanup) {
    clearInterval(timers.mediaCleanup);
  }
}

describe("startGatewayMaintenanceTimers", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("does not schedule recursive media cleanup unless ttl is configured", async () => {
    vi.useFakeTimers();
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");

    const timers = startGatewayMaintenanceTimers({
      ...createMaintenanceTimerDeps(),
    });

    expect(cleanOldMediaMock).not.toHaveBeenCalled();
    expect(timers.mediaCleanup).toBeNull();

    stopMaintenanceTimers(timers);
  });

  it("runs startup media cleanup and repeats it hourly", async () => {
    vi.useFakeTimers();
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");

    const timers = startGatewayMaintenanceTimers({
      ...createMaintenanceTimerDeps(),
      mediaCleanupTtlMs: MEDIA_CLEANUP_TTL_MS,
    });

    expect(cleanOldMediaMock).toHaveBeenCalledWith(MEDIA_CLEANUP_TTL_MS, {
      recursive: true,
      pruneEmptyDirs: true,
    });

    cleanOldMediaMock.mockClear();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(cleanOldMediaMock).toHaveBeenCalledWith(MEDIA_CLEANUP_TTL_MS, {
      recursive: true,
      pruneEmptyDirs: true,
    });

    stopMaintenanceTimers(timers);
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

    stopMaintenanceTimers(timers);
  });

  it("skips overlapping media cleanup runs", async () => {
    vi.useFakeTimers();
    let resolveCleanup = () => {};
    let cleanupReady = false;
    cleanOldMediaMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveCleanup = resolve;
          cleanupReady = true;
        }),
    );
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");

    const timers = startGatewayMaintenanceTimers({
      ...createMaintenanceTimerDeps(),
      mediaCleanupTtlMs: MEDIA_CLEANUP_TTL_MS,
    });

    expect(cleanOldMediaMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(cleanOldMediaMock).toHaveBeenCalledTimes(1);

    if (cleanupReady) {
      resolveCleanup();
    }
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(cleanOldMediaMock).toHaveBeenCalledTimes(2);

    stopMaintenanceTimers(timers);
  });

  it("keeps stale buffers for active runs that still have abort controllers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-22T00:00:00Z"));
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
    const deps = createMaintenanceTimerDeps();
    const runId = "run-active";
    deps.chatAbortControllers.set(runId, createActiveRun("main"));
    deps.chatRunBuffers.set(runId, "buffer");
    deps.chatDeltaSentAt.set(runId, Date.now() - ABORTED_RUN_TTL_MS - 1);
    deps.chatDeltaLastBroadcastLen.set(runId, 6);

    const timers = startGatewayMaintenanceTimers(deps);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(deps.chatRunBuffers.get(runId)).toBe("buffer");
    expect(deps.chatDeltaSentAt.has(runId)).toBe(true);
    expect(deps.chatDeltaLastBroadcastLen.get(runId)).toBe(6);

    stopMaintenanceTimers(timers);
  });

  it("sweeps orphaned stale buffers once the abort controller is gone", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-22T00:00:00Z"));
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
    const deps = createMaintenanceTimerDeps();
    const runId = "run-orphaned";
    deps.chatRunBuffers.set(runId, "buffer");
    deps.chatDeltaSentAt.set(runId, Date.now() - ABORTED_RUN_TTL_MS - 1);
    deps.chatDeltaLastBroadcastLen.set(runId, 6);

    const timers = startGatewayMaintenanceTimers(deps);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(deps.chatRunBuffers.has(runId)).toBe(false);
    expect(deps.chatDeltaSentAt.has(runId)).toBe(false);
    expect(deps.chatDeltaLastBroadcastLen.has(runId)).toBe(false);

    stopMaintenanceTimers(timers);
  });

  it("clears deltaLastBroadcastLen when aborted runs age out", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-22T00:00:00Z"));
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
    const deps = createMaintenanceTimerDeps();
    const runId = "run-aborted";
    deps.chatRunState.abortedRuns.set(runId, Date.now() - ABORTED_RUN_TTL_MS - 1);
    deps.chatRunBuffers.set(runId, "buffer");
    deps.chatDeltaSentAt.set(runId, Date.now() - ABORTED_RUN_TTL_MS - 1);
    deps.chatDeltaLastBroadcastLen.set(runId, 6);

    const timers = startGatewayMaintenanceTimers(deps);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(deps.chatRunState.abortedRuns.has(runId)).toBe(false);
    expect(deps.chatRunBuffers.has(runId)).toBe(false);
    expect(deps.chatDeltaSentAt.has(runId)).toBe(false);
    expect(deps.chatDeltaLastBroadcastLen.has(runId)).toBe(false);

    stopMaintenanceTimers(timers);
  });

  it("keeps active agent dedupe entries past the normal ttl", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-22T00:00:00Z"));
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
    const deps = createMaintenanceTimerDeps();
    const now = Date.now();
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

    stopMaintenanceTimers(timers);
  });

  it("evicts dedupe overflow by oldest timestamp even after reinsertion", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-22T00:00:00Z"));
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
    const deps = createMaintenanceTimerDeps();
    const now = Date.now();

    for (let index = 0; index < DEDUPE_MAX; index += 1) {
      deps.dedupe.set(`stable-${index}`, { ts: now - 1_000 + index, ok: true });
    }

    deps.dedupe.delete("stable-10");
    deps.dedupe.set("stable-10", { ts: now - 2_000, ok: true });
    deps.dedupe.set("overflow-newest", { ts: now - 100, ok: true });

    const timers = startGatewayMaintenanceTimers(deps);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(deps.dedupe.size).toBe(DEDUPE_MAX);
    expect(deps.dedupe.has("stable-10")).toBe(false);
    expect(deps.dedupe.has("stable-0")).toBe(true);
    expect(deps.dedupe.has("overflow-newest")).toBe(true);

    stopMaintenanceTimers(timers);
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

    stopMaintenanceTimers(timers);
  });

  it("does not evict active agent dedupe entries while trimming overflow", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-22T00:00:00Z"));
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
    const deps = createMaintenanceTimerDeps();
    const now = Date.now();

    for (let index = 0; index < DEDUPE_MAX; index += 1) {
      deps.dedupe.set(`stable-${index}`, { ts: now - 1_000 + index, ok: true });
    }
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

    stopMaintenanceTimers(timers);
  });
});
