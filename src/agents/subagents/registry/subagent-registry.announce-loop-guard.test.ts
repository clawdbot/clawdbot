// Announce loop-guard tests prove deferred delivery retries through its time
// window, then gives up instead of looping forever after repeated failures.
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const sessionStore = vi.hoisted(() => ({
  "agent:main:subagent:child-1": { sessionId: "sess-child-1", updatedAt: 1 },
  "agent:main:subagent:expired-child": { sessionId: "sess-expired", updatedAt: 1 },
  "agent:main:subagent:retry-budget": { sessionId: "sess-retry", updatedAt: 1 },
}));

const mocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(() => ({
    session: { store: "/tmp/test-store", mainKey: "main" },
    agents: {},
  })),
  updateSessionStore: vi.fn(),
  callGateway: vi.fn().mockResolvedValue({ status: "ok" }),
  onAgentEventStop: vi.fn(),
  onAgentEvent: vi.fn(),
  runSubagentAnnounceFlow: vi.fn().mockResolvedValue("retryable"),
  captureSubagentCompletionReply: vi.fn(),
  loadSubagentRegistryFromSqlite: vi.fn(() => new Map()),
  saveSubagentRegistryChangesToSqlite: vi.fn(),
  saveSubagentRegistryToSqlite: vi.fn(),
  resolveAgentTimeoutMs: vi.fn(() => 60_000),
}));

vi.mock("../../../config/config.js", () => ({
  getRuntimeConfig: mocks.getRuntimeConfig,
}));

vi.mock("../../../config/sessions.js", () => ({
  loadSessionStore: () => sessionStore,
  resolveAgentIdFromSessionKey: (key: string) => {
    const match = key.match(/^agent:([^:]+)/);
    return match?.[1] ?? "main";
  },
  resolveMainSessionKey: () => "agent:main:main",
  resolveSessionStorePathCore: () => "/tmp/test-store",
  updateSessionStore: mocks.updateSessionStore,
}));

vi.mock("../../../config/sessions/session-accessor.js", () => {
  const listSessionEntriesCore = () =>
    Object.entries(sessionStore).map(([sessionKey, entry]) => ({ sessionKey, entry }));
  const loadSessionEntry = (scope: { sessionKey: keyof typeof sessionStore }) =>
    sessionStore[scope.sessionKey];
  return {
    listSessionEntriesCore,
    listSessionEntriesReadOnly: listSessionEntriesCore,
    loadSessionEntry,
    loadSessionEntryReadOnly: loadSessionEntry,
    patchSessionEntryCore: async () => null,
  };
});

vi.mock("../../../gateway/call.js", () => ({
  callGateway: mocks.callGateway,
}));

vi.mock("../../../infra/agent-events.js", () => ({
  getAgentEventLifecycleGeneration: () => "test-generation",
  isAgentEventLifecycleGenerationCurrent: (generation: string) => generation === "test-generation",
  onAgentEvent: mocks.onAgentEvent,
  registerAgentEventLifecycleRotationHandler: vi.fn(),
}));

vi.mock("./subagent-registry.store.sqlite.js", () => ({
  loadSubagentRegistryFromSqlite: mocks.loadSubagentRegistryFromSqlite,
  saveSubagentRegistryChangesToSqlite: mocks.saveSubagentRegistryChangesToSqlite,
  saveSubagentRegistryToSqlite: mocks.saveSubagentRegistryToSqlite,
}));

vi.mock("../../timeout.js", () => ({
  resolveAgentTimeoutMs: mocks.resolveAgentTimeoutMs,
}));

describe("announce loop guard (#18264)", () => {
  let registry: typeof import("./subagent-registry.test-helpers.js");

  function requireRunById(runs: SubagentRunRecord[], runId: string): SubagentRunRecord {
    const entry = runs.find((run) => run.runId === runId);
    if (!entry) {
      throw new Error(`expected subagent run ${runId}`);
    }
    return entry;
  }

  async function flushAsync() {
    await Promise.resolve();
    await Promise.resolve();
  }

  async function waitForRun(
    runId: string,
    predicate: (run: SubagentRunRecord) => boolean,
  ): Promise<SubagentRunRecord> {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const run = registry
        .listSubagentRunsForRequester("agent:main:main")
        .find((candidate) => candidate.runId === runId);
      if (run && predicate(run)) {
        return run;
      }
      await vi.advanceTimersByTimeAsync(1);
      await flushAsync();
    }
    throw new Error(`subagent run ${runId} did not reach expected state`);
  }

  beforeAll(async () => {
    vi.resetModules();
    registry = await import("./subagent-registry.test-helpers.js");
  });

  beforeEach(() => {
    vi.useFakeTimers();
    mocks.callGateway.mockClear();
    mocks.captureSubagentCompletionReply.mockClear();
    mocks.getRuntimeConfig.mockClear();
    mocks.loadSubagentRegistryFromSqlite.mockReset();
    mocks.loadSubagentRegistryFromSqlite.mockReturnValue(new Map());
    mocks.onAgentEventStop.mockClear();
    mocks.onAgentEvent.mockReset();
    mocks.onAgentEvent.mockReturnValue(mocks.onAgentEventStop);
    mocks.resolveAgentTimeoutMs.mockClear();
    mocks.runSubagentAnnounceFlow.mockReset();
    mocks.runSubagentAnnounceFlow.mockResolvedValue("retryable");
    mocks.saveSubagentRegistryChangesToSqlite.mockClear();
    mocks.saveSubagentRegistryToSqlite.mockClear();
    mocks.updateSessionStore.mockClear();
    registry.resetSubagentRegistryForTests({ persist: false });
    registry.testing.setDepsForTest({
      captureSubagentCompletionReply: mocks.captureSubagentCompletionReply,
      cleanupBrowserSessionsForLifecycleEnd: async () => {},
      runSubagentAnnounceFlow: mocks.runSubagentAnnounceFlow,
    });
  });

  afterEach(() => {
    registry.resetSubagentRegistryForTests({ persist: false });
    registry.testing.setDepsForTest();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  test("SubagentRunRecord has announceRetryCount and lastAnnounceRetryAt fields", () => {
    registry.resetSubagentRegistryForTests();

    const now = Date.now();
    // Add a run that has already ended and exhausted retries
    registry.addSubagentRunForTests({
      runId: "test-loop-guard",
      childSessionKey: "agent:main:subagent:child-1",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "agent:main:main",
      task: "test task",
      cleanup: "keep",
      createdAt: now - 60_000,
      execution: {
        status: "terminal",
        startedAt: now - 55_000,
        endedAt: now - 50_000,
      },
      delivery: { status: "pending", attemptCount: 3, lastAttemptAt: now - 10_000 },
    });

    const runs = registry.listSubagentRunsForRequester("agent:main:main");
    const entry = requireRunById(runs, "test-loop-guard");
    expect(entry.delivery?.attemptCount).toBe(3);
    expect(entry.delivery?.lastAttemptAt).toBe(now - 10_000);
  });

  test("expired entries with high retry count are skipped by resumeSubagentRun", async () => {
    mocks.runSubagentAnnounceFlow.mockClear();
    registry.resetSubagentRegistryForTests();

    const now = Date.now();
    const entry = {
      // Ended 10 minutes ago (well past ANNOUNCE_EXPIRY_MS of 5 min).
      runId: "test-expired-loop",
      childSessionKey: "agent:main:subagent:expired-child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "agent:main:main",
      task: "expired test task",
      cleanup: "keep" as const,
      createdAt: now - 15 * 60_000,
      execution: {
        status: "terminal" as const,
        startedAt: now - 14 * 60_000,
        endedAt: now - 10 * 60_000,
      },
      cleanupCompletedAt: undefined,
      delivery: { status: "pending" as const, attemptCount: 3, lastAttemptAt: now - 9 * 60_000 },
    };
    mocks.loadSubagentRegistryFromSqlite.mockReturnValue(new Map([[entry.runId, entry]]));

    // Initialization finalizes expired pending rows without another recipient-visible attempt.
    const beforeInit = Date.now();
    registry.initSubagentRegistry();
    await flushAsync();

    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
    expect(entry.cleanupCompletedAt).toBeGreaterThanOrEqual(beforeInit);
    expect(mocks.saveSubagentRegistryChangesToSqlite).toHaveBeenCalledWith(expect.any(Map), [
      entry.runId,
    ]);
  });

  test("entries over the former retry budget keep announcing inside the delivery window", async () => {
    mocks.runSubagentAnnounceFlow.mockClear();
    registry.resetSubagentRegistryForTests();

    const now = Date.now();
    const entry: SubagentRunRecord = {
      runId: "test-retry-budget",
      childSessionKey: "agent:main:subagent:retry-budget",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "agent:main:main",
      task: "retry window test",
      cleanup: "keep",
      createdAt: now - 2 * 60_000,
      execution: {
        status: "terminal",
        startedAt: now - 90_000,
        endedAt: now - 60_000,
      },
      expectsCompletionMessage: true,
      delivery: { status: "pending", attemptCount: 3, lastAttemptAt: now - 30_000 },
    };
    mocks.loadSubagentRegistryFromSqlite.mockReturnValue(new Map([[entry.runId, entry]]));

    registry.initSubagentRegistry();
    const resumed = await waitForRun(
      entry.runId,
      (run) => run.delivery?.attemptCount === 4 && typeof run.delivery.nextAttemptAt === "number",
    );

    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
    expect(resumed.cleanupCompletedAt).toBeUndefined();
    expect(resumed.delivery).toMatchObject({
      status: "pending",
      attemptCount: 4,
      windowStartedAt: entry.execution.endedAt,
      deadlineAt: entry.execution.endedAt! + 30 * 60_000,
    });
    expect(resumed.delivery!.nextAttemptAt).toBeGreaterThan(now);
  });

  test("expired completion-message entries are still resumed for announce", async () => {
    mocks.runSubagentAnnounceFlow.mockReset();
    mocks.runSubagentAnnounceFlow.mockResolvedValueOnce("delivered");
    registry.resetSubagentRegistryForTests();

    const now = Date.now();
    const runId = "test-expired-completion-message";
    mocks.loadSubagentRegistryFromSqlite.mockReturnValue(
      new Map([
        [
          runId,
          {
            runId,
            childSessionKey: "agent:main:subagent:child-1",
            requesterSessionKey: "agent:main:main",
            requesterDisplayKey: "agent:main:main",
            task: "completion announce after long descendants",
            cleanup: "keep" as const,
            createdAt: now - 20 * 60_000,
            execution: {
              status: "terminal" as const,
              startedAt: now - 19 * 60_000,
              endedAt: now - 10 * 60_000,
            },
            cleanupHandled: false,
            expectsCompletionMessage: true,
          },
        ],
      ]),
    );

    registry.initSubagentRegistry();
    await flushAsync();

    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
  });

  test("announce rejection resets cleanupHandled so retries can resume", async () => {
    mocks.runSubagentAnnounceFlow.mockReset();
    mocks.runSubagentAnnounceFlow.mockRejectedValueOnce(new Error("announce failed"));
    registry.resetSubagentRegistryForTests();

    const now = Date.now();
    const runId = "test-announce-rejection";
    mocks.loadSubagentRegistryFromSqlite.mockReturnValue(
      new Map([
        [
          runId,
          {
            runId,
            childSessionKey: "agent:main:subagent:child-1",
            requesterSessionKey: "agent:main:main",
            requesterDisplayKey: "agent:main:main",
            task: "rejection test",
            cleanup: "keep" as const,
            createdAt: now - 30_000,
            execution: {
              status: "terminal" as const,
              startedAt: now - 20_000,
              endedAt: now - 10_000,
            },
            cleanupHandled: false,
          },
        ],
      ]),
    );

    registry.initSubagentRegistry();
    await flushAsync();

    const stored = await waitForRun(
      runId,
      (run) => run.cleanupHandled === false && run.delivery?.attemptCount === 1,
    );
    expect(stored.cleanupCompletedAt).toBeUndefined();
    expect(stored.delivery?.lastAttemptAt).toBeTypeOf("number");
  });
});
