// Subagent orphan-recovery tests cover restart recovery for child sessions whose
// embedded run was interrupted while the registry still considers them active.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as config from "../config/config.js";
import * as sessions from "../config/sessions.js";
import * as gateway from "../gateway/call.js";
import * as sessionUtils from "../gateway/session-transcript-readers.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
import { resolveInternalSessionEffectsTranscriptPath } from "./internal-session-effects.js";
import * as announceDelivery from "./subagent-announce-delivery.js";
import {
  recoverOrphanedSubagentSessions,
  scheduleOrphanRecovery,
} from "./subagent-orphan-recovery.js";
import * as subagentRegistrySteerRuntime from "./subagent-registry-steer-runtime.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const loggerMocks = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
}));

// Mocks are installed before importing the recovery module so registry/runtime
// helpers resolve to deterministic restart fixtures.
vi.mock("../config/config.js", () => ({
  getRuntimeConfig: vi.fn(() => ({
    session: { store: undefined },
  })),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => loggerMocks,
}));

vi.mock("../config/sessions.js", () => ({
  loadSessionStore: vi.fn(() => ({})),
  resolveAgentIdFromSessionKey: vi.fn(() => "main"),
  resolveStorePath: vi.fn(() => "/tmp/test-sessions.json"),
  updateSessionStore: vi.fn(async () => {}),
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(async () => ({ runId: "test-run-id" })),
}));

vi.mock("../gateway/session-transcript-readers.js", () => ({
  readSessionMessagesAsync: vi.fn(async () => []),
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
  vi.mocked(sessions.loadSessionStore).mockReturnValue({
    "agent:main:subagent:test-session-1": {
      sessionId: "session-abc",
      updatedAt: Date.now(),
      abortedLastRun: true,
      ...overrides,
    },
  });
}

async function expectSkippedRecovery(store: ReturnType<typeof sessions.loadSessionStore>) {
  vi.mocked(sessions.loadSessionStore).mockReturnValue(store);

  const result = await recoverOrphanedSubagentSessions({
    getActiveRuns: () => createActiveRuns(createTestRunRecord()),
  });

  expect(result.recovered).toBe(0);
  expect(result.skipped).toBe(1);
  expect(gateway.callGateway).not.toHaveBeenCalled();
}

function getResumeMessage() {
  const call = requireRecord(
    firstCallParam(vi.mocked(gateway.callGateway).mock.calls, "resume gateway"),
    "resume gateway params",
  );
  const params = call.params as Record<string, unknown>;
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

function requireFirstUpdateSessionStoreCall() {
  const call = vi.mocked(sessions.updateSessionStore).mock.calls[0];
  if (call === undefined) {
    throw new Error("expected update session store call");
  }
  return call;
}

describe("subagent-orphan-recovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    resetGatewayWorkAdmission();
    vi.mocked(subagentRegistrySteerRuntime.finalizeInterruptedSubagentRun)
      .mockReset()
      .mockResolvedValue(1);
  });

  afterEach(() => {
    resetGatewayWorkAdmission();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("recovers orphaned sessions with abortedLastRun=true", async () => {
    const sessionEntry = {
      sessionId: "session-abc",
      updatedAt: Date.now(),
      abortedLastRun: true,
    };

    vi.mocked(sessions.loadSessionStore).mockReturnValue({
      "agent:main:subagent:test-session-1": sessionEntry,
    });

    const run = createTestRunRecord();
    const activeRuns = new Map<string, SubagentRunRecord>();
    activeRuns.set("run-1", run);

    const result = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => activeRuns,
    });

    expect(result.recovered).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(0);

    // Recovery resumes through the gateway and records the new run id so the
    // registry follows the resumed transcript instead of the idempotency key.
    expect(gateway.callGateway).toHaveBeenCalledOnce();
    const opts = requireRecord(
      firstCallParam(vi.mocked(gateway.callGateway).mock.calls, "gateway resume"),
      "gateway resume params",
    );
    expect(opts.method).toBe("agent");
    const params = opts.params as Record<string, unknown>;
    expect(params.sessionKey).toBe("agent:main:subagent:test-session-1");
    expect(params.message).toContain("gateway reload");
    expect(params.message).toContain("Test task: implement feature X");
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
    expect(replaceParams.transcriptFile).toBe(
      resolveInternalSessionEffectsTranscriptPath("test-run-id"),
    );
    expect(replaceParams.transcriptFile).not.toBe(
      resolveInternalSessionEffectsTranscriptPath(params.idempotencyKey as string),
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
    expect(gateway.callGateway).not.toHaveBeenCalled();
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
    expect(gateway.callGateway).not.toHaveBeenCalled();
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
    vi.mocked(sessions.updateSessionStore).mockImplementation(async (_storePath, update) => {
      update(store);
    });
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
    expect(gateway.callGateway).toHaveBeenCalledOnce();
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
    expect(gateway.callGateway).not.toHaveBeenCalled();
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
    expect(gateway.callGateway).toHaveBeenCalledOnce();
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
    expect(gateway.callGateway).not.toHaveBeenCalled();
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
    expect(gateway.callGateway).toHaveBeenCalledTimes(2);
  });

  it("handles callGateway failure gracefully and preserves abortedLastRun flag", async () => {
    vi.mocked(sessions.loadSessionStore).mockReturnValue({
      "agent:main:subagent:test-session-1": {
        sessionId: "session-abc",
        updatedAt: Date.now(),
        abortedLastRun: true,
      },
    });

    vi.mocked(gateway.callGateway).mockRejectedValue(new Error("gateway unavailable"));

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

    // abortedLastRun flag should NOT be cleared on failure,
    // so the next restart can retry the recovery
    expect(sessions.updateSessionStore).not.toHaveBeenCalled();
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
    // Ensure callGateway succeeds for this test
    vi.mocked(gateway.callGateway).mockResolvedValue({ runId: "resumed-run" } as never);

    vi.mocked(sessions.loadSessionStore).mockReturnValue({
      "agent:main:subagent:test-session-1": {
        sessionId: "session-abc",
        updatedAt: Date.now(),
        abortedLastRun: true,
      },
    });

    const activeRuns = new Map<string, SubagentRunRecord>();
    activeRuns.set("run-1", createTestRunRecord());

    await recoverOrphanedSubagentSessions({
      getActiveRuns: () => activeRuns,
    });

    // updateSessionStore should have been called AFTER successful resume to clear the flag
    expect(sessions.updateSessionStore).toHaveBeenCalledOnce();
    const calls = vi.mocked(sessions.updateSessionStore).mock.calls;
    const [storePath, updater] = calls[0];
    expect(storePath).toBe("/tmp/test-sessions.json");

    // Simulate the updater to verify it clears abortedLastRun
    const mockStore: Record<string, { abortedLastRun?: boolean; updatedAt?: number }> = {
      "agent:main:subagent:test-session-1": {
        abortedLastRun: true,
        updatedAt: 0,
      },
    };
    (updater as (store: Record<string, unknown>) => void)(mockStore);
    expect(mockStore["agent:main:subagent:test-session-1"]?.abortedLastRun).toBe(false);
  });

  it("persists accepted recovery attempts after successful resume", async () => {
    vi.mocked(gateway.callGateway).mockResolvedValue({ runId: "resumed-run" } as never);
    mockSingleAbortedSession();

    await recoverOrphanedSubagentSessions({
      getActiveRuns: () => createActiveRuns(createTestRunRecord()),
    });

    const updateCall = requireFirstUpdateSessionStoreCall();
    const updater = updateCall[1];
    if (typeof updater !== "function") {
      throw new Error("expected update session store callback");
    }
    const mockStore: ReturnType<typeof sessions.loadSessionStore> = {
      "agent:main:subagent:test-session-1": {
        sessionId: "session-abc",
        updatedAt: 0,
        abortedLastRun: true,
      },
    };
    await updater(mockStore);
    const sessionEntry = requireRecord(
      mockStore["agent:main:subagent:test-session-1"],
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
    mockSingleAbortedSession({
      subagentRecovery: {
        automaticAttempts: 2,
        lastAttemptAt: now - 30_000,
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
    expect(gateway.callGateway).not.toHaveBeenCalled();
    expect(sessions.updateSessionStore).toHaveBeenCalledOnce();

    const updateCall = requireFirstUpdateSessionStoreCall();
    const updater = updateCall[1];
    if (typeof updater !== "function") {
      throw new Error("expected update session store callback");
    }
    const mockStore: ReturnType<typeof sessions.loadSessionStore> = {
      "agent:main:subagent:test-session-1": {
        sessionId: "session-abc",
        updatedAt: 0,
        abortedLastRun: true,
        subagentRecovery: {
          automaticAttempts: 2,
          lastAttemptAt: now - 30_000,
          lastRunId: "previous-run",
        },
      },
    };
    await updater(mockStore);
    const sessionEntry = requireRecord(
      mockStore["agent:main:subagent:test-session-1"],
      "wedged session entry",
    );
    expect(sessionEntry.abortedLastRun).toBe(false);
    const recovery = requireRecord(sessionEntry.subagentRecovery, "wedged recovery");
    expect(recovery.automaticAttempts).toBe(2);
    expect(recovery.lastRunId).toBe("run-1");
    expect(recovery.wedgedAt).toBeTypeOf("number");
    expect(recovery.wedgedReason).toContain("recovery blocked");
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
    expect(gateway.callGateway).not.toHaveBeenCalled();
    expect(sessions.updateSessionStore).not.toHaveBeenCalled();
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

    vi.mocked(sessionUtils.readSessionMessagesAsync).mockResolvedValue([
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

    vi.mocked(sessionUtils.readSessionMessagesAsync).mockResolvedValue([
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

  it("prevents duplicate resume when updateSessionStore fails", async () => {
    vi.mocked(gateway.callGateway).mockResolvedValue({ runId: "new-run" } as never);
    vi.mocked(sessions.updateSessionStore).mockRejectedValue(new Error("write failed"));

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
    expect(gateway.callGateway).toHaveBeenCalledOnce();
  });

  it("does not retry a session after the gateway accepted resume but run remap failed", async () => {
    vi.mocked(gateway.callGateway).mockResolvedValue({ runId: "new-run" } as never);
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
    expect(gateway.callGateway).toHaveBeenCalledOnce();
    expect(sessions.updateSessionStore).toHaveBeenCalledOnce();
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
    vi.mocked(gateway.callGateway).mockImplementation(async () => {
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
  it("waits for suspension to reopen before mutating an orphaned session", async () => {
    mockSingleAbortedSession();
    vi.mocked(gateway.callGateway).mockResolvedValue({ runId: "resumed-run" });
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension?.commit()).toBe(true);

    scheduleOrphanRecovery({
      getActiveRuns: () => createActiveRuns(createTestRunRecord()),
      delayMs: 1,
      maxRetries: 0,
    });

    await vi.advanceTimersByTimeAsync(1);
    expect(gateway.callGateway).not.toHaveBeenCalled();
    expect(sessions.updateSessionStore).not.toHaveBeenCalled();
    expect(getActiveGatewayRootWorkCount()).toBe(0);

    expect(suspension?.release()).toBe(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(gateway.callGateway).toHaveBeenCalledOnce();
    expect(sessions.updateSessionStore).toHaveBeenCalledOnce();
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });

  it.each(["returns zero", "rejects"])(
    "retries the exact interrupted terminal when finalization first %s",
    async (mode) => {
      mockSingleAbortedSession();
      vi.mocked(gateway.callGateway).mockRejectedValueOnce(new Error("service restart"));
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
    vi.mocked(gateway.callGateway).mockRejectedValueOnce(new Error("service restart"));
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
