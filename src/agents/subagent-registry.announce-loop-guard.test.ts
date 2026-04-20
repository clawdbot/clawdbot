import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Regression test for #18264: Gateway announcement delivery loop.
 *
 * When `runSubagentAnnounceFlow` repeatedly returns `false` (deferred),
 * `finalizeSubagentCleanup` must eventually give up rather than retrying
 * forever via the max-retry and expiration guards.
 */

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({
    session: { store: "/tmp/test-store", mainKey: "main" },
    agents: {},
  })),
  updateSessionStore: vi.fn(),
  callGateway: vi.fn().mockResolvedValue({ status: "ok" }),
  onAgentEventStop: vi.fn(),
  onAgentEvent: vi.fn(),
  runSubagentAnnounceFlow: vi.fn().mockResolvedValue(false),
  captureSubagentCompletionReply: vi.fn(),
  loadSubagentRegistryFromDisk: vi.fn(() => new Map()),
  saveSubagentRegistryToDisk: vi.fn(),
  resetAnnounceQueuesForTests: vi.fn(),
  resolveAgentTimeoutMs: vi.fn(() => 60_000),
  scheduleOrphanRecovery: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  loadConfig: mocks.loadConfig,
}));

vi.mock("../config/sessions.js", () => ({
  loadSessionStore: () => ({
    "agent:main:subagent:child-1": { sessionId: "sess-child-1", updatedAt: 1 },
    "agent:main:subagent:expired-child": { sessionId: "sess-expired", updatedAt: 1 },
    "agent:main:subagent:retry-budget": { sessionId: "sess-retry", updatedAt: 1 },
  }),
  resolveAgentIdFromSessionKey: (key: string) => {
    const match = key.match(/^agent:([^:]+)/);
    return match?.[1] ?? "main";
  },
  resolveMainSessionKey: () => "agent:main:main",
  resolveStorePath: () => "/tmp/test-store",
  updateSessionStore: mocks.updateSessionStore,
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: mocks.callGateway,
}));

vi.mock("../infra/agent-events.js", () => ({
  onAgentEvent: mocks.onAgentEvent,
}));

vi.mock("./subagent-registry.store.js", () => ({
  loadSubagentRegistryFromDisk: mocks.loadSubagentRegistryFromDisk,
  saveSubagentRegistryToDisk: mocks.saveSubagentRegistryToDisk,
}));

vi.mock("./subagent-announce-queue.js", () => ({
  resetAnnounceQueuesForTests: mocks.resetAnnounceQueuesForTests,
}));

vi.mock("./timeout.js", () => ({
  resolveAgentTimeoutMs: mocks.resolveAgentTimeoutMs,
}));

vi.mock("./subagent-orphan-recovery.js", () => ({
  scheduleOrphanRecovery: mocks.scheduleOrphanRecovery,
}));

describe("announce loop guard (#18264)", () => {
  let registry: typeof import("./subagent-registry.js");

  beforeAll(async () => {
    vi.resetModules();
    registry = await import("./subagent-registry.js");
  });

  beforeEach(() => {
    vi.useFakeTimers();
    mocks.callGateway.mockClear();
    mocks.captureSubagentCompletionReply.mockClear();
    mocks.loadConfig.mockClear();
    mocks.loadSubagentRegistryFromDisk.mockReset();
    mocks.loadSubagentRegistryFromDisk.mockReturnValue(new Map());
    mocks.onAgentEventStop.mockClear();
    mocks.onAgentEvent.mockReset();
    mocks.onAgentEvent.mockReturnValue(mocks.onAgentEventStop);
    mocks.resetAnnounceQueuesForTests.mockClear();
    mocks.resolveAgentTimeoutMs.mockClear();
    mocks.runSubagentAnnounceFlow.mockReset();
    mocks.runSubagentAnnounceFlow.mockResolvedValue(false);
    mocks.scheduleOrphanRecovery.mockClear();
    mocks.saveSubagentRegistryToDisk.mockClear();
    mocks.updateSessionStore.mockClear();
    registry.resetSubagentRegistryForTests({ persist: false });
    registry.__testing.setDepsForTest({
      captureSubagentCompletionReply: mocks.captureSubagentCompletionReply,
      cleanupBrowserSessionsForLifecycleEnd: async () => {},
      runSubagentAnnounceFlow: mocks.runSubagentAnnounceFlow,
    });
  });

  afterEach(() => {
    registry.resetSubagentRegistryForTests({ persist: false });
    registry.__testing.setDepsForTest();
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
      startedAt: now - 55_000,
      endedAt: now - 50_000,
      announceRetryCount: 3,
      lastAnnounceRetryAt: now - 10_000,
    });

    const runs = registry.listSubagentRunsForRequester("agent:main:main");
    const entry = runs.find((r) => r.runId === "test-loop-guard");
    expect(entry).toBeDefined();
    expect(entry!.announceRetryCount).toBe(3);
    expect(entry!.lastAnnounceRetryAt).toBeDefined();
  });

  test.each([
    {
      name: "expired entries with high retry count are skipped by resumeSubagentRun",
      createEntry: (now: number) => ({
        // Ended 10 minutes ago (well past ANNOUNCE_EXPIRY_MS of 5 min).
        runId: "test-expired-loop",
        childSessionKey: "agent:main:subagent:expired-child",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "agent:main:main",
        task: "expired test task",
        cleanup: "keep" as const,
        createdAt: now - 15 * 60_000,
        startedAt: now - 14 * 60_000,
        endedAt: now - 10 * 60_000,
        cleanupCompletedAt: undefined,
        announceRetryCount: 3,
        lastAnnounceRetryAt: now - 9 * 60_000,
      }),
    },
    {
      name: "entries over retry budget are marked completed without announcing",
      createEntry: (now: number) => ({
        runId: "test-retry-budget",
        childSessionKey: "agent:main:subagent:retry-budget",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "agent:main:main",
        task: "retry budget test",
        cleanup: "keep" as const,
        createdAt: now - 2 * 60_000,
        startedAt: now - 90_000,
        endedAt: now - 60_000,
        cleanupCompletedAt: undefined,
        announceRetryCount: 3,
        lastAnnounceRetryAt: now - 30_000,
      }),
    },
  ])("$name", async ({ createEntry }) => {
    mocks.runSubagentAnnounceFlow.mockClear();
    registry.resetSubagentRegistryForTests();

    const entry = createEntry(Date.now());
    mocks.loadSubagentRegistryFromDisk.mockReturnValue(new Map([[entry.runId, entry]]));

    // Initialization attempts resume once, then gives up for exhausted entries.
    registry.initSubagentRegistry();
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
    expect(entry.cleanupCompletedAt).toBeDefined();
  });

  test("expired completion-message entries are still resumed for announce", async () => {
    mocks.runSubagentAnnounceFlow.mockReset();
    mocks.runSubagentAnnounceFlow.mockResolvedValueOnce(true);
    registry.resetSubagentRegistryForTests();

    const now = Date.now();
    const runId = "test-expired-completion-message";
    mocks.loadSubagentRegistryFromDisk.mockReturnValue(
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
            startedAt: now - 19 * 60_000,
            endedAt: now - 10 * 60_000,
            cleanupHandled: false,
            expectsCompletionMessage: true,
          },
        ],
      ]),
    );

    registry.initSubagentRegistry();
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
  });

  test("announce rejection resets cleanupHandled so retries can resume", async () => {
    mocks.runSubagentAnnounceFlow.mockReset();
    mocks.runSubagentAnnounceFlow.mockRejectedValueOnce(new Error("announce failed"));
    registry.resetSubagentRegistryForTests();

    const now = Date.now();
    const runId = "test-announce-rejection";
    mocks.loadSubagentRegistryFromDisk.mockReturnValue(
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
            startedAt: now - 20_000,
            endedAt: now - 10_000,
            cleanupHandled: false,
          },
        ],
      ]),
    );

    registry.initSubagentRegistry();
    await Promise.resolve();
    await Promise.resolve();

    const runs = registry.listSubagentRunsForRequester("agent:main:main");
    const stored = runs.find((run) => run.runId === runId);
    expect(stored?.cleanupHandled).toBe(false);
    expect(stored?.cleanupCompletedAt).toBeUndefined();
    expect(stored?.announceRetryCount).toBe(1);
    expect(stored?.lastAnnounceRetryAt).toBeTypeOf("number");
  });
});
