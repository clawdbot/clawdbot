// Dedupe-record maintenance: TTL retention for active runs/queued sends and
// overflow eviction ordering. Split from server-maintenance.test.ts, which
// sits at the max-lines cap; mocks are hoisted per file, so the module-mock
// preamble is repeated while pure fixtures stay local to each block.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatAbortControllerEntry } from "./chat-abort.types.js";
import { DEDUPE_MAX, DEDUPE_TTL_MS } from "./server-constants.js";
import { createGatewayMaintenanceStateForTest } from "./test-helpers.maintenance-state.js";

const cleanupManagedOutgoingMediaRecordsMock = vi.fn(async () => ({
  deletedRecordCount: 0,
  deletedFileCount: 0,
  retainedCount: 0,
}));
const pruneExpiredDevicePairSetupCompletionsMock = vi.fn(async () => 0);

vi.mock("../infra/device-bootstrap.js", () => ({
  pruneExpiredDevicePairSetupCompletions: pruneExpiredDevicePairSetupCompletionsMock,
}));

vi.mock("../infra/delivery-queue-sqlite.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/delivery-queue-sqlite.js")>(
    "../infra/delivery-queue-sqlite.js",
  );
  return { ...actual, pruneExpiredDeliveryQueueTombstones: vi.fn() };
});

vi.mock("../infra/outbound/delivery-queue-media-spool.js", async () => {
  const actual = await vi.importActual<
    typeof import("../infra/outbound/delivery-queue-media-spool.js")
  >("../infra/outbound/delivery-queue-media-spool.js");
  return { ...actual, pruneOrphanedDeliveryQueueMedia: vi.fn(async () => undefined) };
});

vi.mock("../media/store.js", async () => {
  const actual = await vi.importActual<typeof import("../media/store.js")>("../media/store.js");
  return {
    ...actual,
    cleanOldMedia: vi.fn(async () => {}),
    prunePlaybackTranscodeCache: vi.fn(async () => {}),
  };
});

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
    logHealth: { info: vi.fn(), error: vi.fn() },
    runWorktreeGc: vi.fn(async () => undefined),
    runDeliveryQueueMediaGc: vi.fn(async () => undefined),
    runManagedOutgoingMediaGc: cleanupManagedOutgoingMediaRecordsMock,
  };
}

type MaintenanceTimerDeps = ReturnType<typeof createMaintenanceTimerDeps>;

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
}) {
  clearInterval(timers.tickInterval);
  clearInterval(timers.healthInterval);
  clearInterval(timers.dedupeCleanup);
  clearInterval(timers.worktreeCleanup);
  await timers.stopMediaCleanup();
  vi.useRealTimers();
}

describe("gateway dedupe maintenance", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    pruneExpiredDevicePairSetupCompletionsMock.mockReset().mockResolvedValue(0);
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
