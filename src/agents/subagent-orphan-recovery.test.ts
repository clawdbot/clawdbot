// Subagent orphan-recovery tests cover restart recovery for child sessions whose
// embedded run was interrupted while the registry still considers them active.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as config from "../config/config.js";
import * as sessions from "../config/sessions.js";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import type { GatewayRecoveryRuntime } from "../gateway/server-instance-runtime.types.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
import { resolveInternalSessionEffectsTarget } from "./internal-session-effects.js";
import * as announceDelivery from "./subagent-announce-delivery.js";
import {
  recoverOrphanedSubagentSessions as recoverOrphanedSubagentSessionsWithRuntime,
  scheduleOrphanRecovery as scheduleOrphanRecoveryWithRuntime,
} from "./subagent-orphan-recovery.js";
import * as subagentRegistrySteerRuntime from "./subagent-registry-steer-runtime.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const loggerMocks = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
}));

const dispatchAgent = vi.fn(async (_payload: Record<string, unknown>, _timeoutMs?: number) => ({
  runId: "test-run-id",
}));
const readSessionMessages = vi.fn(async () => [] as unknown[]);
const gatewayRuntime: GatewayRecoveryRuntime = {
  dispatchAgent: dispatchAgent as GatewayRecoveryRuntime["dispatchAgent"],
  waitForAgent: vi.fn(),
  sendRecoveryNotice: vi.fn(),
};

function recoverOrphanedSubagentSessions(
  params: Omit<
    Parameters<typeof recoverOrphanedSubagentSessionsWithRuntime>[0],
    "gatewayRuntime" | "readSessionMessages"
  >,
) {
  return recoverOrphanedSubagentSessionsWithRuntime({
    ...params,
    gatewayRuntime,
    readSessionMessages,
  });
}

function scheduleOrphanRecovery(
  params: Omit<
    Parameters<typeof scheduleOrphanRecoveryWithRuntime>[0],
    "getGatewayRuntime" | "readSessionMessages"
  >,
) {
  return scheduleOrphanRecoveryWithRuntime({
    ...params,
    getGatewayRuntime: () => gatewayRuntime,
    readSessionMessages,
  });
}

// Mocks are installed before importing the recovery module so registry/runtime
// helpers resolve to deterministic restart fixtures.
const sessionMocks = vi.hoisted(() => {
  type MockSessionEntry = Record<string, unknown>;
  type MockSessionStore = Record<string, MockSessionEntry>;
  const loadSessionStore = vi.fn(
    (_storePath?: string, _options?: { clone?: boolean }): MockSessionStore => ({}),
  );
  return {
    loadSessionStore,
    resolveAgentIdFromSessionKey: vi.fn(() => "main"),
    resolveStorePath: vi.fn(() => "/tmp/test-sessions.json"),
    loadSessionEntry: vi.fn(
      (scope: { storePath?: string; sessionKey: string }) =>
        loadSessionStore(scope.storePath, {
          clone: false,
        })[scope.sessionKey],
    ),
    patchSessionEntry: vi.fn(
      async (
        scope: { storePath?: string; sessionKey: string },
        update: (
          entry: MockSessionEntry,
        ) =>
          | MockSessionEntry
          | Partial<MockSessionEntry>
          | null
          | Promise<MockSessionEntry | Partial<MockSessionEntry> | null>,
        options: { replaceEntry?: boolean } = {},
      ) => {
        const store = loadSessionStore(scope.storePath, {
          clone: false,
        });
        const current = store[scope.sessionKey];
        if (!current) {
          return null;
        }
        const patch = await update({ ...current });
        if (!patch) {
          return current;
        }
        const next = options.replaceEntry ? patch : { ...current, ...patch };
        store[scope.sessionKey] = next;
        return next;
      },
    ),
  };
});

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: vi.fn(() => ({
    session: { store: undefined },
  })),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => loggerMocks,
}));

vi.mock("../config/sessions.js", () => ({
  loadSessionStore: sessionMocks.loadSessionStore,
  resolveAgentIdFromSessionKey: sessionMocks.resolveAgentIdFromSessionKey,
  resolveStorePath: sessionMocks.resolveStorePath,
}));

vi.mock("../config/sessions/session-accessor.js", () => ({
  loadSessionEntry: sessionMocks.loadSessionEntry,
  patchSessionEntry: sessionMocks.patchSessionEntry,
}));

vi.mock("./subagent-announce-delivery.js", () => ({
  deliverSubagentAnnouncement: vi.fn(async () => ({ delivered: true, path: "direct" })),
  isInternalAnnounceRequesterSession: vi.fn(() => false),
  loadRequesterSessionEntry: vi.fn(() => ({ entry: {} })),
}));

vi.mock("./subagent-announce-origin.js", () => ({
  resolveAnnounceOrigin: vi.fn((entry, requesterOrigin) => requesterOrigin),
}));

vi.mock("./subagent-registry-steer-runtime.js", () => ({
  replaceSubagentRunAfterSteer: vi.fn(() => true),
  finalizeInterruptedSubagentRun: vi.fn(async () => 1),
  reserveSwarmCollectorLaunch: vi.fn(() => true),
}));

function createTestRunRecord(overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  return {
    runId: "run-1",
    childSessionKey: "agent:main:subagent:test-session-1",
    requesterSessionKey: "agent:main:quietchat:direct:+1234567890",
    requesterDisplayKey: "main",
    task: "Test task: implement feature X",
    cleanup: "delete",
    createdAt: Date.now() - 60_000,
    startedAt: Date.now() - 55_000,
    ...overrides,
  };
}

function createActiveRuns(...runs: SubagentRunRecord[]) {
  return new Map(runs.map((run) => [run.runId, run] satisfies [string, SubagentRunRecord]));
}

function mockSingleAbortedSession(
  overrides: Partial<NonNullable<ReturnType<typeof sessions.loadSessionStore>[string]>> = {},
) {
  const store = {
    "agent:main:subagent:test-session-1": {
      sessionId: "session-abc",
      updatedAt: Date.now(),
      abortedLastRun: true,
      ...overrides,
    },
  };
  vi.mocked(sessions.loadSessionStore).mockReturnValue(store);
  return store;
}

async function expectSkippedRecovery(store: ReturnType<typeof sessions.loadSessionStore>) {
  vi.mocked(sessions.loadSessionStore).mockReturnValue(store);

  const result = await recoverOrphanedSubagentSessions({
    getActiveRuns: () => createActiveRuns(createTestRunRecord()),
  });

  expect(result.recovered).toBe(0);
  expect(result.skipped).toBe(1);
  expect(dispatchAgent).not.toHaveBeenCalled();
}

function getResumeMessage() {
  const params = requireRecord(
    firstCallParam(dispatchAgent.mock.calls, "resume gateway"),
    "resume gateway params",
  );
  return params.message as string;
}

function firstCallParam(calls: ReadonlyArray<readonly unknown[]>, label: string) {
  const call = calls[0];
  if (call === undefined) {
    throw new Error(`expected ${label} call`);
  }
  return call[0];
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected ${label} to be a record`);
  }
  return value as Record<string, unknown>;
}

describe("subagent-orphan-recovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    resetGatewayWorkAdmission();
    dispatchAgent.mockReset();
    dispatchAgent.mockResolvedValue({ runId: "test-run-id" });
    readSessionMessages.mockReset();
    readSessionMessages.mockResolvedValue([]);
    vi.mocked(subagentRegistrySteerRuntime.finalizeInterruptedSubagentRun)
      .mockReset()
      .mockResolvedValue(1);
  });

  afterEach(() => {
    resetGatewayWorkAdmission();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("recovers orphaned collectors with their non-interactive output contract", async () => {
    const sessionEntry = {
      sessionId: "session-abc",
      updatedAt: Date.now(),
      abortedLastRun: true,
    };

    vi.mocked(sessions.loadSessionStore).mockReturnValue({
      "agent:main:subagent:test-session-1": sessionEntry,
    });

    const run = createTestRunRecord({
      collect: true,
      outputSchema: { type: "object", required: ["answer"] },
    });
    const activeRuns = new Map<string, SubagentRunRecord>();
    activeRuns.set("run-1", run);

    const result = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => activeRuns,
    });

    expect(result.recovered).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(0);

    // Recovery resumes through the instance runtime and records the new run id so the
    // registry follows the resumed transcript instead of the idempotency key.
    expect(dispatchAgent).toHaveBeenCalledOnce();
    const opts = requireRecord(
      firstCallParam(dispatchAgent.mock.calls, "gateway resume"),
      "gateway resume params",
    );
    expect(opts.sessionKey).toBe("agent:main:subagent:test-session-1");
    expect(opts.message).toContain("gateway reload");
    expect(opts.message).toContain("Test task: implement feature X");
    expect(opts.swarmCollector).toBe(true);
    expect(opts.swarmOutputSchema).toEqual({ type: "object", required: ["answer"] });
    expect(subagentRegistrySteerRuntime.reserveSwarmCollectorLaunch).toHaveBeenCalledWith(
      "run-1",
      opts.idempotencyKey,
    );
    expect(dispatchAgent.mock.calls[0]?.[1]).toBe(10_000);
    expect(subagentRegistrySteerRuntime.replaceSubagentRunAfterSteer).toHaveBeenCalledOnce();
    const replaceParams = requireRecord(
      firstCallParam(
        vi.mocked(subagentRegistrySteerRuntime.replaceSubagentRunAfterSteer).mock.calls,
        "run replacement",
      ),
      "run replacement params",
    );
    expect(replaceParams.previousRunId).toBe("run-1");
    expect(replaceParams.nextRunId).toBe("test-run-id");
    expect(replaceParams.fallback).toBe(run);
    expect(replaceParams.transcriptTarget).toEqual(
      resolveInternalSessionEffectsTarget({
        agentId: "main",
        runId: "test-run-id",
        storePath: "/tmp/test-sessions.json",
      }),
    );
    expect(replaceParams.transcriptTarget).not.toEqual(
      resolveInternalSessionEffectsTarget({
        agentId: "main",
        runId: opts.idempotencyKey as string,
        storePath: "/tmp/test-sessions.json",
      }),
    );
  });

  it("skips sessions that are not aborted", async () => {
    await expectSkippedRecovery({
      "agent:main:subagent:test-session-1": {
        sessionId: "session-abc",
        updatedAt: Date.now(),
        abortedLastRun: false,
      },
    });
  });

  it("finalizes stale aborted runs instead of resuming them", async () => {
    mockSingleAbortedSession();
    const now = Date.now();
    const staleSessionStartedAt = now - 3 * 60 * 60 * 1_000;
    const activeRuns = createActiveRuns(
      createTestRunRecord({
        createdAt: staleSessionStartedAt,
        startedAt: now - 60_000,
        sessionStartedAt: staleSessionStartedAt,
      }),
    );

    const result = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => activeRuns,
    });

    expect(result.recovered).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(1);
    expect(dispatchAgent).not.toHaveBeenCalled();
    expect(subagentRegistrySteerRuntime.finalizeInterruptedSubagentRun).toHaveBeenCalledOnce();
    const finalizeParams = requireRecord(
      firstCallParam(
        vi.mocked(subagentRegistrySteerRuntime.finalizeInterruptedSubagentRun).mock.calls,
        "stale finalize",
      ),
      "stale finalize params",
    );
    expect(finalizeParams).toEqual({
      runId: "run-1",
      error: "stale aborted subagent run not resumed (10800s old, exceeds stale-run window)",
    });
  });

  it("reports stale finalization failures for scheduler retry", async () => {
    mockSingleAbortedSession();
    vi.mocked(subagentRegistrySteerRuntime.finalizeInterruptedSubagentRun).mockResolvedValueOnce(0);
    const staleStartedAt = Date.now() - 3 * 60 * 60 * 1_000;
    const activeRuns = createActiveRuns(
      createTestRunRecord({
        createdAt: staleStartedAt,
        startedAt: staleStartedAt,
      }),
    );

    const result = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => activeRuns,
    });

    expect(result.recovered).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.failedRuns).toEqual([
      {
        runId: "run-1",
        childSessionKey: "agent:main:subagent:test-session-1",
        error: expect.stringContaining("stale aborted subagent run not resumed"),
      },
    ]);
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it("retries a stale predecessor after its same-session successor resumes", async () => {
    const now = Date.now();
    const staleStartedAt = now - 3 * 60 * 60 * 1_000;
    const childSessionKey = "agent:main:subagent:test-session-1";
    const store = {
      [childSessionKey]: {
        sessionId: "session-abc",
        updatedAt: now,
        abortedLastRun: true,
      },
    };
    vi.mocked(sessions.loadSessionStore).mockReturnValue(store);
    const activeRuns = createActiveRuns(
      createTestRunRecord({
        runId: "fresh-run",
        childSessionKey,
        createdAt: now - 60_000,
        startedAt: now - 55_000,
        sessionStartedAt: now - 2 * 60 * 60 * 1_000 + 60_000,
      }),
      createTestRunRecord({
        runId: "stale-run",
        childSessionKey,
        createdAt: staleStartedAt,
        startedAt: staleStartedAt,
      }),
    );
    vi.mocked(subagentRegistrySteerRuntime.finalizeInterruptedSubagentRun)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(1);
    vi.mocked(subagentRegistrySteerRuntime.replaceSubagentRunAfterSteer).mockImplementation(
      ({ previousRunId, nextRunId, fallback }) => {
        const previous = activeRuns.get(previousRunId) ?? fallback;
        if (!previous) {
          return false;
        }
        activeRuns.delete(previousRunId);
        activeRuns.set(nextRunId, { ...previous, runId: nextRunId });
        return true;
      },
    );
    const resumedSessionKeys = new Set<string>();
    const pendingStaleFinalizations = new Map<string, string>();

    const first = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => activeRuns,
      resumedSessionKeys,
      pendingStaleFinalizations,
    });
    expect(first).toMatchObject({ recovered: 1, failed: 1, skipped: 0 });
    expect(store[childSessionKey].abortedLastRun).toBe(false);
    Reflect.deleteProperty(store, childSessionKey);
    vi.setSystemTime(now + 2 * 60_000);

    const second = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => activeRuns,
      resumedSessionKeys,
      pendingStaleFinalizations,
    });

    expect(second).toMatchObject({ recovered: 0, failed: 0, skipped: 2 });
    expect(dispatchAgent).toHaveBeenCalledOnce();
    expect(subagentRegistrySteerRuntime.finalizeInterruptedSubagentRun).toHaveBeenCalledTimes(2);
    expect(subagentRegistrySteerRuntime.finalizeInterruptedSubagentRun).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ runId: "stale-run" }),
    );
    expect(subagentRegistrySteerRuntime.finalizeInterruptedSubagentRun).not.toHaveBeenCalledWith(
      expect.objectContaining({ runId: "test-run-id" }),
    );
  });

  it("skips runs that have already ended", async () => {
    const activeRuns = new Map<string, SubagentRunRecord>();
    activeRuns.set(
      "run-1",
      createTestRunRecord({
        endedAt: Date.now() - 1000,
      }),
    );

    const result = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => activeRuns,
    });

    expect(result.recovered).toBe(0);
    expect(result.skipped).toBe(1);
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it("recovers restart-aborted timeout runs even when the registry marked them ended", async () => {
    vi.mocked(sessions.loadSessionStore).mockReturnValue({
      "agent:main:subagent:test-session-1": {
        sessionId: "session-abc",
        updatedAt: Date.now(),
        abortedLastRun: true,
      },
    });

    const legacyTimeout = createTestRunRecord({
      endedAt: Date.now() - 1_000,
      endedReason: "subagent-complete",
      outcome: {
        status: "timeout",
      },
      terminalOwner: "interrupted-recovery",
    });
    const activeRuns = createActiveRuns(legacyTimeout);

    const result = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => activeRuns,
    });

    expect(result.recovered).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(0);
    expect(dispatchAgent).toHaveBeenCalledOnce();
    expect(legacyTimeout.terminalOwner).toBeUndefined();
  });

  it("replays interrupted terminal ownership before config or session lookup", async () => {
    const run = createTestRunRecord({
      endedAt: 2_000,
      endedReason: "subagent-error",
      outcome: { status: "error", error: "restart interrupted run" },
      terminalOwner: "interrupted-recovery",
      completion: { required: false, resultText: null, capturedAt: 2_000 },
    });
    const activeRuns = createActiveRuns(run);
    const resumedSessionKeys = new Set([run.childSessionKey]);

    const first = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => activeRuns,
      resumedSessionKeys,
    });
    const second = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => activeRuns,
      resumedSessionKeys,
    });

    expect(first).toMatchObject({ recovered: 0, failed: 0, skipped: 1 });
    expect(second).toMatchObject({ recovered: 0, failed: 0, skipped: 1 });
    expect(subagentRegistrySteerRuntime.finalizeInterruptedSubagentRun).toHaveBeenCalledTimes(2);
    expect(subagentRegistrySteerRuntime.finalizeInterruptedSubagentRun).toHaveBeenNthCalledWith(1, {
      runId: "run-1",
      error: "restart interrupted run",
      endedAt: 2_000,
    });
    expect(config.getRuntimeConfig).not.toHaveBeenCalled();
    expect(sessions.loadSessionStore).not.toHaveBeenCalled();
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it("handles multiple orphaned sessions", async () => {
    vi.mocked(sessions.loadSessionStore).mockReturnValue({
      "agent:main:subagent:session-a": {
        sessionId: "id-a",
        updatedAt: Date.now(),
        abortedLastRun: true,
      },
      "agent:main:subagent:session-b": {
        sessionId: "id-b",
        updatedAt: Date.now(),
        abortedLastRun: true,
      },
      "agent:main:subagent:session-c": {
        sessionId: "id-c",
        updatedAt: Date.now(),
        abortedLastRun: false,
      },
    });

    const activeRuns = new Map<string, SubagentRunRecord>();
    activeRuns.set(
      "run-a",
      createTestRunRecord({
        runId: "run-a",
        childSessionKey: "agent:main:subagent:session-a",
        task: "Task A",
      }),
    );
    activeRuns.set(
      "run-b",
      createTestRunRecord({
        runId: "run-b",
        childSessionKey: "agent:main:subagent:session-b",
        task: "Task B",
      }),
    );
    activeRuns.set(
      "run-c",
      createTestRunRecord({
        runId: "run-c",
        childSessionKey: "agent:main:subagent:session-c",
        task: "Task C",
      }),
    );

    const result = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => activeRuns,
    });

    expect(result.recovered).toBe(2);
    expect(result.skipped).toBe(1);
    expect(dispatchAgent).toHaveBeenCalledTimes(2);
  });

  it("handles instance dispatch failure gracefully and preserves abortedLastRun flag", async () => {
    vi.mocked(sessions.loadSessionStore).mockReturnValue({
      "agent:main:subagent:test-session-1": {
        sessionId: "session-abc",
        updatedAt: Date.now(),
        abortedLastRun: true,
      },
    });

    dispatchAgent.mockRejectedValue(new Error("gateway unavailable"));

    const activeRuns = new Map<string, SubagentRunRecord>();
    activeRuns.set("run-1", createTestRunRecord());

    const result = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => activeRuns,
    });

    expect(result.recovered).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.failedRuns).toHaveLength(1);
    const failedRun = requireRecord(result.failedRuns[0], "failed run");
    expect(failedRun.runId).toBe("run-1");
    expect(failedRun.childSessionKey).toBe("agent:main:subagent:test-session-1");
    expect(failedRun.error).toBe("gateway unavailable");

    // abortedLastRun flag should NOT be cleared on failure, so the next
    // restart can retry recovery through the canonical session accessor.
    expect(sessionAccessor.patchSessionEntry).not.toHaveBeenCalled();
  });

  it("returns empty results when no active runs exist", async () => {
    const result = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => new Map(),
    });

    expect(result.recovered).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(0);
  });

  it("skips sessions with missing session entry in store", async () => {
    await expectSkippedRecovery({});
  });

  it("clears abortedLastRun flag after successful resume", async () => {
    // Ensure instance dispatch succeeds for this test
    dispatchAgent.mockResolvedValue({ runId: "resumed-run" } as never);

    const store = {
      "agent:main:subagent:test-session-1": {
        sessionId: "session-abc",
        updatedAt: Date.now(),
        abortedLastRun: true,
      },
    };
    vi.mocked(sessions.loadSessionStore).mockReturnValue(store);

    const activeRuns = new Map<string, SubagentRunRecord>();
    activeRuns.set("run-1", createTestRunRecord());

    await recoverOrphanedSubagentSessions({
      getActiveRuns: () => activeRuns,
    });

    expect(sessionAccessor.patchSessionEntry).toHaveBeenCalledOnce();
    expect(sessionAccessor.patchSessionEntry).toHaveBeenCalledWith(
      {
        storePath: "/tmp/test-sessions.json",
        sessionKey: "agent:main:subagent:test-session-1",
      },
      expect.any(Function),
      {
        replaceEntry: true,
        skipMaintenance: true,
      },
    );
    expect(store["agent:main:subagent:test-session-1"]?.abortedLastRun).toBe(false);
  });

  it("persists accepted recovery attempts after successful resume", async () => {
    dispatchAgent.mockResolvedValue({ runId: "resumed-run" } as never);
    const store = mockSingleAbortedSession();

    await recoverOrphanedSubagentSessions({
      getActiveRuns: () => createActiveRuns(createTestRunRecord()),
    });

    expect(sessionAccessor.patchSessionEntry).toHaveBeenCalledOnce();
    const sessionEntry = requireRecord(
      store["agent:main:subagent:test-session-1"],
      "updated session entry",
    );
    expect(sessionEntry.abortedLastRun).toBe(false);
    const recovery = requireRecord(sessionEntry.subagentRecovery, "subagent recovery");
    expect(recovery.automaticAttempts).toBe(1);
    expect(recovery.lastRunId).toBe("run-1");
    expect(recovery.lastAttemptAt).toBeTypeOf("number");
  });

  it("tombstones rapid repeated accepted recovery before resuming again", async () => {
    const now = Date.now();
    const store = mockSingleAbortedSession({
      subagentRecovery: {
        automaticAttempts: 2,
        lastAttemptAt: now - 2 * 60_000,
        lastRunId: "previous-run",
      },
    });

    const result = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => createActiveRuns(createTestRunRecord()),
    });

    expect(result.recovered).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.failedRuns).toHaveLength(1);
    const blockedRun = requireRecord(result.failedRuns[0], "blocked run");
    expect(blockedRun.runId).toBe("run-1");
    expect(blockedRun.childSessionKey).toBe("agent:main:subagent:test-session-1");
    expect(blockedRun.error).toContain("recovery blocked after 2 rapid accepted resume attempts");
    expect(dispatchAgent).not.toHaveBeenCalled();
    expect(sessionAccessor.patchSessionEntry).toHaveBeenCalledOnce();

    const sessionEntry = requireRecord(
      store["agent:main:subagent:test-session-1"],
      "wedged session entry",
    );
    expect(sessionEntry.abortedLastRun).toBe(false);
    const recovery = requireRecord(sessionEntry.subagentRecovery, "wedged recovery");
    expect(recovery.automaticAttempts).toBe(2);
    expect(recovery.lastRunId).toBe("run-1");
    expect(recovery.wedgedAt).toBeTypeOf("number");
    expect(recovery.wedgedReason).toContain("recovery blocked");
  });

  it("starts a new attempt burst after the two-minute re-wedge window", async () => {
    const now = Date.now();
    const expiredRecovery = {
      automaticAttempts: 2,
      lastAttemptAt: now - 2 * 60_000 - 1,
      lastRunId: "previous-run",
    };
    const store = mockSingleAbortedSession({ subagentRecovery: expiredRecovery });

    const result = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => createActiveRuns(createTestRunRecord()),
    });

    expect(result.recovered).toBe(1);
    expect(dispatchAgent).toHaveBeenCalledOnce();
    expect(sessionAccessor.patchSessionEntry).toHaveBeenCalledOnce();
    const sessionEntry = requireRecord(
      store["agent:main:subagent:test-session-1"],
      "updated session entry",
    );
    const recovery = requireRecord(sessionEntry.subagentRecovery, "subagent recovery");
    expect(recovery.automaticAttempts).toBe(1);
    expect(recovery.lastRunId).toBe("run-1");
  });

  it("skips already tombstoned wedged sessions without rewriting them", async () => {
    mockSingleAbortedSession({
      subagentRecovery: {
        automaticAttempts: 2,
        lastAttemptAt: Date.now() - 20_000,
        lastRunId: "previous-run",
        wedgedAt: Date.now() - 10_000,
        wedgedReason: "subagent orphan recovery blocked after 2 rapid accepted resume attempts",
      },
    });

    const result = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => createActiveRuns(createTestRunRecord()),
    });

    expect(result.recovered).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.failedRuns).toHaveLength(1);
    expect(dispatchAgent).not.toHaveBeenCalled();
    expect(sessionAccessor.patchSessionEntry).not.toHaveBeenCalled();
  });

  it("truncates long task descriptions in resume message", async () => {
    mockSingleAbortedSession();

    const taskPrefix = "x".repeat(1999);
    const longTask = `${taskPrefix}🚀 omitted tail`;
    const activeRuns = createActiveRuns(createTestRunRecord({ task: longTask }));

    await recoverOrphanedSubagentSessions({
      getActiveRuns: () => activeRuns,
    });

    const message = getResumeMessage();
    expect(message).toContain(`Your original task was:\n\n${taskPrefix}...\n\n`);
    expect(message).not.toContain("🚀");
  });

  it("includes last human message in resume when available", async () => {
    mockSingleAbortedSession({ sessionFile: "session-abc.jsonl" });

    readSessionMessages.mockResolvedValue([
      { role: "user", content: [{ type: "text", text: "Please build feature Y" }] },
      { role: "assistant", content: [{ type: "text", text: "Working on it..." }] },
      { role: "user", content: [{ type: "text", text: "Also add tests for it" }] },
      { role: "assistant", content: [{ type: "text", text: "Sure, adding tests now." }] },
    ]);

    const activeRuns = createActiveRuns(createTestRunRecord());

    await recoverOrphanedSubagentSessions({ getActiveRuns: () => activeRuns });

    const message = getResumeMessage();
    expect(message).toContain("Also add tests for it");
    expect(message).toContain("last message from the user");
  });

  it("adds config change hint when assistant messages reference config modifications", async () => {
    mockSingleAbortedSession();

    readSessionMessages.mockResolvedValue([
      { role: "user", content: "Update the config" },
      { role: "assistant", content: "I've modified openclaw.json to add the new setting." },
    ]);

    const activeRuns = createActiveRuns(createTestRunRecord());

    await recoverOrphanedSubagentSessions({ getActiveRuns: () => activeRuns });

    const message = getResumeMessage();
    expect(message).toContain("config changes from your previous run were already applied");
  });

  it("does not send parent-visible recovery-progress announcements on retry", async () => {
    mockSingleAbortedSession();

    const activeRuns = createActiveRuns(createTestRunRecord());

    await recoverOrphanedSubagentSessions({
      getActiveRuns: () => activeRuns,
    });

    expect(announceDelivery.deliverSubagentAnnouncement).not.toHaveBeenCalled();

    await recoverOrphanedSubagentSessions({
      getActiveRuns: () => activeRuns,
    });

    expect(announceDelivery.deliverSubagentAnnouncement).not.toHaveBeenCalled();
  });

  it("prevents duplicate resume when the session accessor write fails", async () => {
    dispatchAgent.mockResolvedValue({ runId: "new-run" } as never);
    vi.mocked(sessionAccessor.patchSessionEntry).mockRejectedValueOnce(new Error("write failed"));

    vi.mocked(sessions.loadSessionStore).mockReturnValue({
      "agent:main:subagent:test-session-1": {
        sessionId: "session-abc",
        updatedAt: Date.now(),
        abortedLastRun: true,
      },
    });

    const activeRuns = new Map<string, SubagentRunRecord>();
    activeRuns.set("run-1", createTestRunRecord());
    activeRuns.set(
      "run-2",
      createTestRunRecord({
        runId: "run-2",
      }),
    );

    const result = await recoverOrphanedSubagentSessions({ getActiveRuns: () => activeRuns });

    expect(result.recovered).toBe(1);
    expect(result.skipped).toBe(1);
    expect(dispatchAgent).toHaveBeenCalledOnce();
    expect(sessionAccessor.patchSessionEntry).toHaveBeenCalledOnce();
  });

  it("does not retry a session after the gateway accepted resume but run remap failed", async () => {
    dispatchAgent.mockResolvedValue({ runId: "new-run" } as never);
    vi.mocked(subagentRegistrySteerRuntime.replaceSubagentRunAfterSteer).mockReturnValue(false);

    vi.mocked(sessions.loadSessionStore).mockReturnValue({
      "agent:main:subagent:test-session-1": {
        sessionId: "session-abc",
        updatedAt: Date.now(),
        abortedLastRun: true,
      },
    });

    const activeRuns = new Map<string, SubagentRunRecord>();
    activeRuns.set("run-1", createTestRunRecord());
    const resumedSessionKeys = new Set<string>();

    const first = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => activeRuns,
      resumedSessionKeys,
    });
    const second = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => activeRuns,
      resumedSessionKeys,
    });

    expect(first.recovered).toBe(1);
    expect(first.failed).toBe(0);
    expect(second.recovered).toBe(0);
    expect(second.skipped).toBe(1);
    expect(dispatchAgent).toHaveBeenCalledOnce();
    expect(sessionAccessor.patchSessionEntry).toHaveBeenCalledOnce();
  });

  it("finalizes interrupted runs with a readable failure after recovery retries are exhausted", async () => {
    vi.mocked(sessions.loadSessionStore).mockReturnValue({
      "agent:main:subagent:test-session-1": {
        sessionId: "session-abc",
        updatedAt: Date.now(),
        abortedLastRun: true,
      },
    });
    const admittedRootCounts: number[] = [];
    dispatchAgent.mockImplementation(async () => {
      admittedRootCounts.push(getActiveGatewayRootWorkCount());
      throw new Error("service restart");
    });
    vi.mocked(subagentRegistrySteerRuntime.finalizeInterruptedSubagentRun).mockImplementation(
      async () => {
        admittedRootCounts.push(getActiveGatewayRootWorkCount());
        return 1;
      },
    );

    const activeRuns = createActiveRuns(createTestRunRecord());

    scheduleOrphanRecovery({
      getActiveRuns: () => activeRuns,
      delayMs: 1,
      maxRetries: 1,
    });

    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();
    expect(getActiveGatewayRootWorkCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(2);
    await Promise.resolve();

    expect(subagentRegistrySteerRuntime.finalizeInterruptedSubagentRun).toHaveBeenCalledOnce();
    expect(admittedRootCounts).toEqual([1, 1, 1]);
    expect(getActiveGatewayRootWorkCount()).toBe(0);
    const finalizeParams = requireRecord(
      firstCallParam(
        vi.mocked(subagentRegistrySteerRuntime.finalizeInterruptedSubagentRun).mock.calls,
        "interrupted run finalization",
      ),
      "interrupted run finalization params",
    );
    expect(finalizeParams).toEqual({
      runId: "run-1",
      error:
        "Subagent run was interrupted by a gateway restart or connection loss. Automatic recovery failed after 2 attempts. Please retry. (service restart)",
    });
  });

  it("uses the replacement Gateway runtime when the instance changes before recovery", async () => {
    mockSingleAbortedSession();
    const replacementDispatch = vi.fn(async () => ({ runId: "replacement-run" }));
    const replacementRuntime: GatewayRecoveryRuntime = {
      dispatchAgent: replacementDispatch as GatewayRecoveryRuntime["dispatchAgent"],
      waitForAgent: vi.fn(),
      sendRecoveryNotice: vi.fn(),
    };
    let currentRuntime: GatewayRecoveryRuntime | undefined = gatewayRuntime;

    scheduleOrphanRecoveryWithRuntime({
      getGatewayRuntime: () => currentRuntime,
      getActiveRuns: () => createActiveRuns(createTestRunRecord()),
      readSessionMessages,
      delayMs: 1,
      maxRetries: 0,
    });
    currentRuntime = replacementRuntime;

    await vi.advanceTimersByTimeAsync(1);

    expect(dispatchAgent).not.toHaveBeenCalled();
    expect(replacementDispatch).toHaveBeenCalledOnce();
  });

  it("waits for suspension to reopen before mutating an orphaned session", async () => {
    mockSingleAbortedSession();
    dispatchAgent.mockResolvedValue({ runId: "resumed-run" });
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension?.commit()).toBe(true);

    scheduleOrphanRecovery({
      getActiveRuns: () => createActiveRuns(createTestRunRecord()),
      delayMs: 1,
      maxRetries: 0,
    });

    await vi.advanceTimersByTimeAsync(1);
    expect(dispatchAgent).not.toHaveBeenCalled();
    expect(sessionAccessor.patchSessionEntry).not.toHaveBeenCalled();
    expect(getActiveGatewayRootWorkCount()).toBe(0);

    expect(suspension?.release()).toBe(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(dispatchAgent).toHaveBeenCalledOnce();
    expect(sessionAccessor.patchSessionEntry).toHaveBeenCalledOnce();
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });

  it.each(["returns zero", "rejects"])(
    "retries the exact interrupted terminal when finalization first %s",
    async (mode) => {
      mockSingleAbortedSession();
      dispatchAgent.mockRejectedValueOnce(new Error("service restart"));
      if (mode === "returns zero") {
        vi.mocked(
          subagentRegistrySteerRuntime.finalizeInterruptedSubagentRun,
        ).mockResolvedValueOnce(0);
      } else {
        vi.mocked(
          subagentRegistrySteerRuntime.finalizeInterruptedSubagentRun,
        ).mockRejectedValueOnce(new Error("registry unavailable"));
      }

      scheduleOrphanRecovery({
        getActiveRuns: () => createActiveRuns(createTestRunRecord()),
        delayMs: 1,
        maxRetries: 0,
      });

      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(1);
      await Promise.resolve();
      await Promise.resolve();

      const finalize = vi.mocked(subagentRegistrySteerRuntime.finalizeInterruptedSubagentRun);
      expect(finalize).toHaveBeenCalledTimes(2);
      expect(finalize.mock.calls[1]).toEqual(finalize.mock.calls[0]);
      expect(loggerMocks.warn).not.toHaveBeenCalledWith(
        expect.stringContaining("interrupted terminal projection(s) incomplete"),
        expect.anything(),
      );
    },
  );

  it("logs an incomplete interrupted terminal after its retry budget is exhausted", async () => {
    mockSingleAbortedSession();
    dispatchAgent.mockRejectedValueOnce(new Error("service restart"));
    vi.mocked(subagentRegistrySteerRuntime.finalizeInterruptedSubagentRun).mockResolvedValue(0);

    scheduleOrphanRecovery({
      getActiveRuns: () => createActiveRuns(createTestRunRecord()),
      delayMs: 1,
      maxRetries: 0,
    });

    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(3);
    await Promise.resolve();
    await Promise.resolve();

    expect(subagentRegistrySteerRuntime.finalizeInterruptedSubagentRun).toHaveBeenCalledTimes(3);
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      "orphan recovery exhausted with 1 interrupted terminal projection(s) incomplete",
      { runIds: ["run-1"] },
    );
  });
});
