import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const noop = () => {};
const waitForFast = <T>(callback: () => T | Promise<T>) =>
  vi.waitFor(callback, { timeout: 1_000, interval: 1 });

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`expected ${label} to be an object`);
  }
  return value as Record<string, unknown>;
}

function expectRecordFields(
  value: unknown,
  expected: Record<string, unknown>,
  label: string,
): Record<string, unknown> {
  const record = requireRecord(value, label);
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key], `${label}.${key}`).toEqual(expectedValue);
  }
  return record;
}

function getMockCallArg(
  mock: ReturnType<typeof vi.fn>,
  callIndex: number,
  argIndex: number,
  label: string,
): unknown {
  const call = (mock.mock.calls as unknown[][])[callIndex];
  if (!call) {
    throw new Error(`expected ${label} call ${callIndex}`);
  }
  return call[argIndex];
}

function findRecordCallArg(
  mock: ReturnType<typeof vi.fn>,
  argIndex: number,
  label: string,
  predicate: (record: Record<string, unknown>) => boolean,
): Record<string, unknown> {
  for (const call of mock.mock.calls as unknown[][]) {
    const value = call[argIndex];
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      continue;
    }
    const record = value as Record<string, unknown>;
    if (predicate(record)) {
      return record;
    }
  }
  throw new Error(`expected ${label}`);
}

async function expectPathMissing(targetPath: string): Promise<void> {
  try {
    await fs.access(targetPath);
  } catch (error) {
    expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
    return;
  }
  throw new Error(`expected ${targetPath} to be missing`);
}

const mocks = vi.hoisted(() => ({
  callGateway: vi.fn(),
  onAgentEvent: vi.fn(() => noop),
  getAgentRunContext: vi.fn(() => undefined),
  getRuntimeConfig: vi.fn(() => ({
    agents: { defaults: { subagents: { archiveAfterMinutes: 0 } } },
    session: { mainKey: "main", scope: "per-sender" as const },
  })),
  loadSessionStore: vi.fn(() => ({})),
  resolveAgentIdFromSessionKey: vi.fn((sessionKey: string) => {
    return sessionKey.match(/^agent:([^:]+)/)?.[1] ?? "main";
  }),
  resolveStorePath: vi.fn(() => "/tmp/test-session-store.json"),
  updateSessionStore: vi.fn(),
  emitSessionLifecycleEvent: vi.fn(),
  persistSubagentRunsToDisk: vi.fn(),
  persistSubagentRunsToDiskOrThrow: vi.fn(),
  restoreSubagentRunsFromDisk: vi.fn(() => 0),
  getSubagentRunsSnapshotForRead: vi.fn(
    (runs: Map<string, import("./subagent-registry.types.js").SubagentRunRecord>) => new Map(runs),
  ),
  captureSubagentCompletionReply: vi.fn(async () => "final completion reply"),
  cleanupBrowserSessionsForLifecycleEnd: vi.fn(async () => {}),
  runSubagentAnnounceFlow: vi.fn(async () => true),
  getGlobalHookRunner: vi.fn(() => null),
  ensureRuntimePluginsLoaded: vi.fn(),
  ensureContextEnginesInitialized: vi.fn(),
  resolveContextEngine: vi.fn(),
  onSubagentEnded: vi.fn(async () => {}),
  runSubagentEnded: vi.fn(async () => {}),
  resolveAgentTimeoutMs: vi.fn(() => 1_000),
  scheduleOrphanRecovery: vi.fn(),
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: mocks.callGateway,
}));

vi.mock("../infra/agent-events.js", () => ({
  getAgentRunContext: mocks.getAgentRunContext,
  onAgentEvent: mocks.onAgentEvent,
}));

vi.mock("../config/config.js", () => {
  return {
    getRuntimeConfig: mocks.getRuntimeConfig,
  };
});

vi.mock("../config/sessions.js", () => ({
  loadSessionStore: mocks.loadSessionStore,
  resolveAgentIdFromSessionKey: mocks.resolveAgentIdFromSessionKey,
  resolveStorePath: mocks.resolveStorePath,
  updateSessionStore: mocks.updateSessionStore,
}));

vi.mock("../sessions/session-lifecycle-events.js", () => ({
  emitSessionLifecycleEvent: mocks.emitSessionLifecycleEvent,
}));

vi.mock("./subagent-registry-state.js", () => ({
  getSubagentRunsSnapshotForRead: mocks.getSubagentRunsSnapshotForRead,
  persistSubagentRunsToDisk: mocks.persistSubagentRunsToDisk,
  persistSubagentRunsToDiskOrThrow: mocks.persistSubagentRunsToDiskOrThrow,
  restoreSubagentRunsFromDisk: mocks.restoreSubagentRunsFromDisk,
}));

vi.mock("./subagent-announce.js", () => ({
  captureSubagentCompletionReply: mocks.captureSubagentCompletionReply,
  runSubagentAnnounceFlow: mocks.runSubagentAnnounceFlow,
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: mocks.getGlobalHookRunner,
}));

vi.mock("./runtime-plugins.js", () => ({
  ensureRuntimePluginsLoaded: mocks.ensureRuntimePluginsLoaded,
}));

vi.mock("../context-engine/init.js", () => ({
  ensureContextEnginesInitialized: mocks.ensureContextEnginesInitialized,
}));

vi.mock("../context-engine/registry.js", () => ({
  resolveContextEngine: mocks.resolveContextEngine,
}));

vi.mock("./timeout.js", () => ({
  resolveAgentTimeoutMs: mocks.resolveAgentTimeoutMs,
}));

vi.mock("./subagent-orphan-recovery.js", () => ({
  scheduleOrphanRecovery: mocks.scheduleOrphanRecovery,
}));

describe("subagent registry seam flow", () => {
  let mod: typeof import("./subagent-registry.js");

  beforeAll(async () => {
    mod = await import("./subagent-registry.js");
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T12:00:00Z"));
    mocks.onAgentEvent.mockReturnValue(noop);
    mocks.getAgentRunContext.mockReturnValue(undefined);
    mocks.getRuntimeConfig.mockReturnValue({
      agents: { defaults: { subagents: { archiveAfterMinutes: 0 } } },
      session: { mainKey: "main", scope: "per-sender" as const },
    });
    mocks.resolveAgentIdFromSessionKey.mockImplementation((sessionKey: string) => {
      return sessionKey.match(/^agent:([^:]+)/)?.[1] ?? "main";
    });
    mocks.resolveStorePath.mockReturnValue("/tmp/test-session-store.json");
    mocks.loadSessionStore.mockReturnValue({
      "agent:main:subagent:child": {
        sessionId: "sess-child",
        updatedAt: 1,
      },
    });
    mocks.getGlobalHookRunner.mockReturnValue(null);
    mocks.cleanupBrowserSessionsForLifecycleEnd.mockResolvedValue(undefined);
    mocks.resolveContextEngine.mockResolvedValue({
      onSubagentEnded: mocks.onSubagentEnded,
    });
    mocks.scheduleOrphanRecovery.mockReset();
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        return {
          status: "ok",
          startedAt: 111,
          endedAt: 222,
        };
      }
      return {};
    });
    mod.__testing.setDepsForTest({
      callGateway: mocks.callGateway,
      captureSubagentCompletionReply: mocks.captureSubagentCompletionReply,
      cleanupBrowserSessionsForLifecycleEnd: mocks.cleanupBrowserSessionsForLifecycleEnd,
      onAgentEvent: mocks.onAgentEvent,
      persistSubagentRunsToDisk: mocks.persistSubagentRunsToDisk,
      persistSubagentRunsToDiskOrThrow: mocks.persistSubagentRunsToDiskOrThrow,
      resolveAgentTimeoutMs: mocks.resolveAgentTimeoutMs,
      restoreSubagentRunsFromDisk: mocks.restoreSubagentRunsFromDisk,
      runSubagentAnnounceFlow: mocks.runSubagentAnnounceFlow,
      ensureContextEnginesInitialized: mocks.ensureContextEnginesInitialized,
      ensureRuntimePluginsLoaded: mocks.ensureRuntimePluginsLoaded,
      resolveContextEngine: mocks.resolveContextEngine,
    });
    mod.resetSubagentRegistryForTests({ persist: false });
  });

  afterEach(() => {
    mod.__testing.setDepsForTest();
    mod.resetSubagentRegistryForTests({ persist: false });
    vi.useRealTimers();
  });

  it("lists active and pending-delivery child sessions for maintenance preservation", () => {
    const now = Date.now();
    mod.addSubagentRunForTests({
      runId: "run-active",
      childSessionKey: "agent:main:subagent:active",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "active task",
      cleanup: "delete",
      expectsCompletionMessage: true,
      createdAt: now,
    });
    mod.addSubagentRunForTests({
      runId: "run-pending",
      childSessionKey: "agent:main:subagent:pending",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "pending delivery task",
      cleanup: "delete",
      expectsCompletionMessage: true,
      createdAt: now - 2,
      endedAt: now - 1,
      pendingFinalDelivery: true,
      frozenResultText: "child output",
    });
    mod.addSubagentRunForTests({
      runId: "run-complete",
      childSessionKey: "agent:main:subagent:complete",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "already delivered task",
      cleanup: "keep",
      expectsCompletionMessage: true,
      createdAt: now - 4,
      endedAt: now - 3,
      completionAnnouncedAt: now - 2,
      cleanupCompletedAt: now - 1,
    });

    expect(mod.listSessionMaintenanceProtectedSubagentSessionKeys().toSorted()).toEqual([
      "agent:main:subagent:active",
      "agent:main:subagent:pending",
    ]);
  });

  it("uses the disk-aware run snapshot for maintenance preservation", () => {
    const now = Date.now();
    mocks.getSubagentRunsSnapshotForRead.mockReturnValueOnce(
      new Map([
        [
          "run-restored",
          {
            runId: "run-restored",
            childSessionKey: "agent:main:subagent:restored",
            requesterSessionKey: "agent:main:main",
            requesterDisplayKey: "main",
            task: "restored pending task",
            cleanup: "delete",
            expectsCompletionMessage: true,
            createdAt: now,
          },
        ],
      ]),
    );

    expect(mod.listSessionMaintenanceProtectedSubagentSessionKeys()).toEqual([
      "agent:main:subagent:restored",
    ]);
  });

  it("schedules orphan recovery instead of terminally failing on recoverable wait transport errors", async () => {
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        throw new Error("gateway closed (1006): transport close");
      }
      return {};
    });

    mod.registerSubagentRun({
      runId: "run-interrupted-wait",
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "resume after transport close",
      cleanup: "keep",
    });

    await waitForFast(() => {
      expectRecordFields(
        getMockCallArg(mocks.scheduleOrphanRecovery, 0, 0, "orphan recovery"),
        { delayMs: 1_000 },
        "orphan recovery params",
      );
    });
    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
    const run = mod
      .listSubagentRunsForRequester("agent:main:main")
      .find((entry) => entry.runId === "run-interrupted-wait");
    expect(run?.endedAt).toBeUndefined();
    expect(run?.outcome).toBeUndefined();
  });

  it("keeps parent run active when agent.wait times out before child session settles", async () => {
    let waitAttempts = 0;
    let resolveSecondWait: (value: {
      status: "ok";
      startedAt: number;
      endedAt: number;
    }) => void = () => {};
    const secondWait = new Promise<{ status: "ok"; startedAt: number; endedAt: number }>(
      (resolve) => {
        resolveSecondWait = resolve;
      },
    );
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        waitAttempts += 1;
        if (waitAttempts === 1) {
          return { status: "timeout" };
        }
        return secondWait;
      }
      return {};
    });
    mocks.loadSessionStore.mockReturnValue({
      "agent:main:subagent:child": {
        sessionId: "sess-child",
        updatedAt: 1,
        status: "running",
      },
    });

    mod.registerSubagentRun({
      runId: "run-waiter-timeout",
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "eventually complete",
      cleanup: "keep",
    });

    await waitForFast(() => {
      expect(waitAttempts).toBeGreaterThanOrEqual(1);
    });
    await waitForFast(() => {
      expect(waitAttempts).toBeGreaterThanOrEqual(2);
    });
    const activeRun = mod
      .listSubagentRunsForRequester("agent:main:main")
      .find((entry) => entry.runId === "run-waiter-timeout");
    expect(activeRun?.endedAt).toBeUndefined();
    expect(activeRun?.outcome).toBeUndefined();

    resolveSecondWait({
      status: "ok",
      startedAt: 111,
      endedAt: 222,
    });
    await waitForFast(() => {
      const completedRun = mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === "run-waiter-timeout");
      expect(waitAttempts).toBeGreaterThanOrEqual(2);
      expect(completedRun?.endedAt).toBe(222);
      expectRecordFields(completedRun?.outcome, { status: "ok" }, "completed run outcome");
    });
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
  });

  it("records terminal agent.wait timeouts even before session store timing is persisted", async () => {
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        return {
          status: "timeout",
          startedAt: 111,
          endedAt: 222,
          stopReason: "rpc",
        };
      }
      return {};
    });
    mocks.loadSessionStore.mockReturnValue({
      "agent:main:subagent:child": {
        sessionId: "sess-child",
        updatedAt: 1,
        status: "running",
      },
    });

    mod.registerSubagentRun({
      runId: "run-terminal-timeout",
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "time out terminally",
      cleanup: "keep",
    });

    await waitForFast(() => {
      const run = mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === "run-terminal-timeout");
      expect(run?.endedAt).toBe(222);
      expectRecordFields(run?.outcome, { status: "timeout" }, "terminal timeout outcome");
    });
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
  });

  it("ignores stale terminal session-store rows from older child runs", async () => {
    let waitAttempts = 0;
    let resolveSecondWait: (value: {
      status: "ok";
      startedAt: number;
      endedAt: number;
    }) => void = () => {};
    const secondWait = new Promise<{ status: "ok"; startedAt: number; endedAt: number }>(
      (resolve) => {
        resolveSecondWait = resolve;
      },
    );
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        waitAttempts += 1;
        if (waitAttempts === 1) {
          return { status: "timeout" };
        }
        return secondWait;
      }
      return {};
    });
    const staleEndedAt = Date.parse("2026-03-24T11:59:00Z");
    mocks.loadSessionStore.mockReturnValue({
      "agent:main:subagent:child": {
        sessionId: "sess-child",
        updatedAt: staleEndedAt,
        status: "done",
        startedAt: staleEndedAt - 100,
        endedAt: staleEndedAt,
      },
    });

    mod.registerSubagentRun({
      runId: "run-reactivated-timeout",
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "new run after stale terminal row",
      cleanup: "keep",
    });

    await waitForFast(() => {
      expect(waitAttempts).toBeGreaterThanOrEqual(2);
    });
    const activeRun = mod
      .listSubagentRunsForRequester("agent:main:main")
      .find((entry) => entry.runId === "run-reactivated-timeout");
    expect(activeRun?.endedAt).toBeUndefined();
    expect(activeRun?.outcome).toBeUndefined();
    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();

    resolveSecondWait({
      status: "ok",
      startedAt: Date.parse("2026-03-24T12:00:01Z"),
      endedAt: Date.parse("2026-03-24T12:00:02Z"),
    });
    await waitForFast(() => {
      const completedRun = mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === "run-reactivated-timeout");
      expectRecordFields(completedRun?.outcome, { status: "ok" }, "reactivated run outcome");
    });
  });

  it("keeps sessions_yield-ended subagent runs paused instead of announcing no output", async () => {
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        return {
          status: "ok",
          startedAt: 111,
          endedAt: 222,
          stopReason: "end_turn",
          livenessState: "paused",
          yielded: true,
        };
      }
      return {};
    });

    mod.registerSubagentRun({
      runId: "run-yield-paused",
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "wait for child continuation",
      cleanup: "keep",
    });

    await waitForFast(() => {
      const run = mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === "run-yield-paused");
      expect(run?.endedAt).toBe(222);
      expect(run?.pauseReason).toBe("sessions_yield");
    });
    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
    expect(mod.countPendingDescendantRuns("agent:main:main")).toBe(1);

    expect(
      mod.replaceSubagentRunAfterSteer({
        previousRunId: "run-yield-paused",
        nextRunId: "run-yield-continuation",
      }),
    ).toBe(true);
    const replacement = mod
      .listSubagentRunsForRequester("agent:main:main")
      .find((entry) => entry.runId === "run-yield-continuation");
    expect(replacement?.runId).toBe("run-yield-continuation");
    expect(replacement?.pauseReason).toBeUndefined();
    expect(replacement?.endedAt).toBeUndefined();
  });

  it("reconciles stale active runs from persisted terminal session state during sweep", async () => {
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        return { status: "pending" };
      }
      return {};
    });
    const persistedStartedAt = Date.parse("2026-03-24T11:58:00Z");
    const persistedEndedAt = persistedStartedAt + 111;
    mocks.loadSessionStore.mockReturnValue({
      "agent:main:subagent:child": {
        sessionId: "sess-child",
        updatedAt: persistedEndedAt,
        status: "done",
        startedAt: persistedStartedAt,
        endedAt: persistedEndedAt,
        runtimeMs: 111,
      },
    });

    vi.setSystemTime(persistedStartedAt - 1);
    mod.registerSubagentRun({
      runId: "run-stale-terminal",
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "settle from persisted terminal state",
      cleanup: "keep",
    });

    vi.setSystemTime(new Date("2026-03-24T12:02:00Z"));
    await mod.__testing.sweepOnceForTests();

    await waitForFast(() => {
      const announceParams = findRecordCallArg(
        mocks.runSubagentAnnounceFlow,
        0,
        "stale terminal announce",
        (record) => record.childRunId === "run-stale-terminal",
      );
      expectRecordFields(
        announceParams,
        { childRunId: "run-stale-terminal" },
        "stale terminal announce",
      );
      expectRecordFields(
        announceParams.outcome,
        { status: "ok", endedAt: persistedEndedAt },
        "stale terminal announce outcome",
      );
    });

    const run = mod
      .listSubagentRunsForRequester("agent:main:main")
      .find((entry) => entry.runId === "run-stale-terminal");
    expect(run?.endedAt).toBe(persistedEndedAt);
    expectRecordFields(
      run?.outcome,
      {
        status: "ok",
        endedAt: persistedEndedAt,
      },
      "stale terminal run outcome",
    );
    expect(run?.cleanupCompletedAt).toBeTypeOf("number");
  });

  it("requeues orphan recovery instead of keeping restart-aborted stale runs stuck as running", async () => {
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        return { status: "pending" };
      }
      return {};
    });
    mocks.loadSessionStore.mockReturnValue({
      "agent:main:subagent:child": {
        sessionId: "sess-child",
        updatedAt: 333,
        status: "running",
        abortedLastRun: true,
      },
    });

    mod.registerSubagentRun({
      runId: "run-stale-aborted",
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "resume after restart",
      cleanup: "keep",
    });

    vi.setSystemTime(new Date("2026-03-24T12:02:00Z"));
    await mod.__testing.sweepOnceForTests();

    await waitForFast(() => {
      expectRecordFields(
        getMockCallArg(mocks.scheduleOrphanRecovery, 0, 0, "orphan recovery"),
        { delayMs: 1_000 },
        "orphan recovery params",
      );
    });
    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
    const run = mod
      .listSubagentRunsForRequester("agent:main:main")
      .find((entry) => entry.runId === "run-stale-aborted");
    expect(run?.endedAt).toBeUndefined();
    expect(run?.outcome).toBeUndefined();
  });

  it("completes a registered run across timing persistence, lifecycle status, and announce cleanup", async () => {
    mod.registerSubagentRun({
      runId: "run-1",
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:main",
      requesterOrigin: { channel: " quietchat ", accountId: " acct-1 " },
      requesterDisplayKey: "main",
      task: "finish the task",
      cleanup: "delete",
    });

    await waitForFast(() => {
      expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
    });

    expect(mocks.emitSessionLifecycleEvent).toHaveBeenCalledWith({
      sessionKey: "agent:main:subagent:child",
      reason: "subagent-status",
      parentSessionKey: "agent:main:main",
      label: undefined,
    });

    expectRecordFields(
      getMockCallArg(mocks.runSubagentAnnounceFlow, 0, 0, "completion announce"),
      {
        childSessionKey: "agent:main:subagent:child",
        childRunId: "run-1",
        requesterSessionKey: "agent:main:main",
        requesterOrigin: { channel: "quietchat", accountId: "acct-1" },
        task: "finish the task",
        cleanup: "delete",
        roundOneReply: "final completion reply",
        outcome: {
          status: "ok",
          startedAt: 111,
          endedAt: 222,
          elapsedMs: 111,
        },
      },
      "completion announce params",
    );

    expect(mocks.updateSessionStore).toHaveBeenCalledTimes(1);
    expect(getMockCallArg(mocks.updateSessionStore, 0, 0, "session store update")).toBe(
      "/tmp/test-session-store.json",
    );
    expect(getMockCallArg(mocks.updateSessionStore, 0, 1, "session store update")).toBeTypeOf(
      "function",
    );

    const updateStore = mocks.updateSessionStore.mock.calls.at(0)?.[1] as
      | ((store: Record<string, Record<string, unknown>>) => void)
      | undefined;
    expect(updateStore).toBeTypeOf("function");
    const store = {
      "agent:main:subagent:child": {
        sessionId: "sess-child",
      },
    };
    updateStore?.(store);
    expectRecordFields(
      store["agent:main:subagent:child"],
      {
        startedAt: Date.parse("2026-03-24T12:00:00Z"),
        endedAt: 222,
        runtimeMs: 111,
        status: "done",
      },
      "updated child session store entry",
    );

    expect(mocks.persistSubagentRunsToDisk).toHaveBeenCalledTimes(6);
  });

  it("throws and removes the entry when the initial durable registry write fails", () => {
    mocks.persistSubagentRunsToDiskOrThrow.mockImplementationOnce(() => {
      throw new Error("disk full");
    });

    expect(() =>
      mod.registerSubagentRun({
        runId: "run-durability-required",
        childSessionKey: "agent:main:subagent:child",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "must fail closed",
        cleanup: "keep",
      }),
    ).toThrowError("disk full");

    expect(
      mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === "run-durability-required"),
    ).toBeUndefined();
  });

  it("continues completion announce cleanup when lifecycle cleanup fails", async () => {
    mocks.cleanupBrowserSessionsForLifecycleEnd.mockRejectedValueOnce(
      new Error("browser cleanup unavailable"),
    );

    mod.registerSubagentRun({
      runId: "run-cleanup-warning",
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "finish despite cleanup warning",
      cleanup: "keep",
    });

    await waitForFast(() => {
      expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
    });

    expect(mocks.cleanupBrowserSessionsForLifecycleEnd).toHaveBeenCalledTimes(1);
    expectRecordFields(
      getMockCallArg(mocks.runSubagentAnnounceFlow, 0, 0, "completion announce"),
      {
        childSessionKey: "agent:main:subagent:child",
        childRunId: "run-cleanup-warning",
        task: "finish despite cleanup warning",
      },
      "completion announce params",
    );

    const run = mod
      .listSubagentRunsForRequester("agent:main:main")
      .find((entry) => entry.runId === "run-cleanup-warning");
    expect(run?.cleanupCompletedAt).toBeTypeOf("number");
  });

  it("preserves run-mode keep entries past SESSION_RUN_TTL_MS sweep", async () => {
    mod.registerSubagentRun({
      runId: "run-keep-survives-ttl",
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "keep me past the session ttl",
      cleanup: "keep",
      spawnMode: "run",
    });

    await waitForFast(() => {
      const run = mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === "run-keep-survives-ttl");
      expect(run?.cleanupCompletedAt).toBeTypeOf("number");
    });

    vi.setSystemTime(new Date(Date.parse("2026-03-24T12:00:00Z") + 10 * 60_000));
    await mod.__testing.sweepOnceForTests();

    const run = mod
      .listSubagentRunsForRequester("agent:main:main")
      .find((entry) => entry.runId === "run-keep-survives-ttl");
    expect(run?.runId).toBe("run-keep-survives-ttl");
  });

  it("retries completion hooks before resuming ended cleanup", async () => {
    mocks.ensureRuntimePluginsLoaded.mockRejectedValueOnce(new Error("runtime unavailable"));

    mod.registerSubagentRun({
      runId: "run-hook-retry",
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "finish after hook retry",
      cleanup: "keep",
      expectsCompletionMessage: false,
    });

    await waitForFast(() => {
      expect(mocks.ensureRuntimePluginsLoaded).toHaveBeenCalledTimes(2);
      const run = mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === "run-hook-retry");
      expect(run?.cleanupCompletedAt).toBeTypeOf("number");
    });
    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
  });

  it("suppresses stale timeout announces when the same child run later finishes successfully", async () => {
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        return { status: "pending" };
      }
      return {};
    });

    mod.registerSubagentRun({
      runId: "run-timeout-then-ok",
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "timeout retry",
      cleanup: "keep",
      expectsCompletionMessage: true,
    });

    const lastOnAgentEventCall = mocks.onAgentEvent.mock.calls[
      mocks.onAgentEvent.mock.calls.length - 1
    ] as unknown as
      | [(evt: { runId: string; stream: string; data: Record<string, unknown> }) => void]
      | undefined;
    const lifecycleHandler = lastOnAgentEventCall?.[0];
    expect(lifecycleHandler).toBeTypeOf("function");

    lifecycleHandler?.({
      runId: "run-timeout-then-ok",
      stream: "lifecycle",
      data: { phase: "end", endedAt: 1_000, aborted: true },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(14_999);
    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();

    lifecycleHandler?.({
      runId: "run-timeout-then-ok",
      stream: "lifecycle",
      data: { phase: "end", endedAt: 1_250 },
    });

    await waitForFast(() => {
      expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
    });
    const timeoutAnnounce = expectRecordFields(
      getMockCallArg(mocks.runSubagentAnnounceFlow, 0, 0, "timeout retry announce"),
      { childRunId: "run-timeout-then-ok" },
      "timeout retry announce params",
    );
    expectRecordFields(
      timeoutAnnounce.outcome,
      {
        status: "ok",
        endedAt: 1_250,
      },
      "timeout retry announce outcome",
    );

    await vi.advanceTimersByTimeAsync(20_000);
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
  });

  it("deletes delete-mode completion runs when announce cleanup gives up after retry limit", async () => {
    mocks.runSubagentAnnounceFlow.mockResolvedValue(false);
    const endedAt = Date.parse("2026-03-24T12:00:00Z");
    mocks.callGateway.mockResolvedValueOnce({
      status: "ok",
      startedAt: endedAt - 500,
      endedAt,
    });

    mod.registerSubagentRun({
      runId: "run-delete-give-up",
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "completion cleanup retry",
      cleanup: "delete",
      expectsCompletionMessage: true,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
    expectRecordFields(
      mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === "run-delete-give-up"),
      { runId: "run-delete-give-up", cleanup: "delete" },
      "delete give-up run",
    );

    await vi.advanceTimersByTimeAsync(1_000);
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(4_000);
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(3);
    expect(
      mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === "run-delete-give-up"),
    ).toBeUndefined();
  });

  it("finalizes retry-budgeted completion delete runs during resume", async () => {
    const endedHookRunner = {
      hasHooks: (hookName: string) => hookName === "subagent_ended",
      runSubagentEnded: mocks.runSubagentEnded,
    };
    mocks.getGlobalHookRunner.mockReturnValue(endedHookRunner as never);
    mocks.restoreSubagentRunsFromDisk.mockImplementation(((params: {
      runs: Map<string, unknown>;
      mergeOnly?: boolean;
    }) => {
      params.runs.set("run-resume-delete", {
        runId: "run-resume-delete",
        childSessionKey: "agent:main:subagent:child",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "resume delete retry budget",
        cleanup: "delete",
        createdAt: Date.parse("2026-03-24T11:58:00Z"),
        startedAt: Date.parse("2026-03-24T11:59:00Z"),
        endedAt: Date.parse("2026-03-24T11:59:30Z"),
        expectsCompletionMessage: true,
        announceRetryCount: 3,
        lastAnnounceRetryAt: Date.parse("2026-03-24T11:59:40Z"),
      });
      return 1;
    }) as never);

    mod.initSubagentRegistry();
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
    await waitForFast(() => {
      expect(mocks.runSubagentEnded).toHaveBeenCalledTimes(1);
    });
    await waitForFast(() => {
      expect(mocks.onSubagentEnded).toHaveBeenCalledWith({
        childSessionKey: "agent:main:subagent:child",
        reason: "deleted",
        workspaceDir: undefined,
      });
    });
    expect(
      mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === "run-resume-delete"),
    ).toBeUndefined();
  });

  it("suspends retry-budgeted successful keep-mode completion deliveries during resume", async () => {
    mocks.restoreSubagentRunsFromDisk.mockImplementation(((params: {
      runs: Map<string, unknown>;
      mergeOnly?: boolean;
    }) => {
      params.runs.set("run-resume-keep", {
        runId: "run-resume-keep",
        childSessionKey: "agent:main:subagent:child",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "resume keep retry budget",
        cleanup: "keep",
        createdAt: Date.parse("2026-03-24T11:58:00Z"),
        startedAt: Date.parse("2026-03-24T11:59:00Z"),
        endedAt: Date.parse("2026-03-24T11:59:30Z"),
        endedReason: "subagent-complete",
        expectsCompletionMessage: true,
        outcome: { status: "ok" },
        announceRetryCount: 3,
        lastAnnounceRetryAt: Date.parse("2026-03-24T11:59:40Z"),
        lastAnnounceDeliveryError: "gateway request timeout for agent",
        frozenResultText: "child completed successfully",
        pendingFinalDelivery: true,
        pendingFinalDeliveryPayload: {
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          childSessionKey: "agent:main:subagent:child",
          childRunId: "run-resume-keep",
          task: "resume keep retry budget",
          endedAt: Date.parse("2026-03-24T11:59:30Z"),
          outcome: { status: "ok" },
          expectsCompletionMessage: true,
          frozenResultText: "child completed successfully",
        },
      });
      return 1;
    }) as never);

    mod.initSubagentRegistry();
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
    const run = mod
      .listSubagentRunsForRequester("agent:main:main")
      .find((entry) => entry.runId === "run-resume-keep");
    expect(run).toMatchObject({
      pendingFinalDelivery: true,
      deliverySuspendedReason: "retry-limit",
      cleanupHandled: false,
    });
    expect(run?.cleanupCompletedAt).toBeUndefined();
    expect(run?.pendingFinalDeliveryPayload).toMatchObject({
      childRunId: "run-resume-keep",
      frozenResultText: "child completed successfully",
    });
  });

  it("clears suspended final delivery fields when reactivating a subagent run", () => {
    const endedAt = Date.parse("2026-03-24T11:59:30Z");
    mod.addSubagentRunForTests({
      runId: "run-suspended-old",
      childSessionKey: "agent:main:subagent:reactivated",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "reactivate suspended delivery",
      cleanup: "keep",
      expectsCompletionMessage: true,
      createdAt: endedAt - 30_000,
      startedAt: endedAt - 20_000,
      endedAt,
      endedReason: "subagent-complete",
      outcome: { status: "ok" },
      announceRetryCount: 3,
      lastAnnounceRetryAt: endedAt + 1_000,
      lastAnnounceDeliveryError: "gateway request timeout for agent",
      pendingFinalDelivery: true,
      pendingFinalDeliveryCreatedAt: endedAt + 1_000,
      pendingFinalDeliveryLastAttemptAt: endedAt + 2_000,
      pendingFinalDeliveryAttemptCount: 3,
      pendingFinalDeliveryLastError: "gateway request timeout for agent",
      pendingFinalDeliveryPayload: {
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        childSessionKey: "agent:main:subagent:reactivated",
        childRunId: "run-suspended-old",
        task: "reactivate suspended delivery",
        endedAt,
        outcome: { status: "ok" },
        expectsCompletionMessage: true,
        frozenResultText: "child completed successfully",
      },
      deliverySuspendedAt: endedAt + 3_000,
      deliverySuspendedReason: "retry-limit",
    });

    expect(
      mod.replaceSubagentRunAfterSteer({
        previousRunId: "run-suspended-old",
        nextRunId: "run-suspended-new",
      }),
    ).toBe(true);

    const replacement = mod
      .listSubagentRunsForRequester("agent:main:main")
      .find((entry) => entry.runId === "run-suspended-new");
    expect(replacement).toMatchObject({
      runId: "run-suspended-new",
      cleanup: "keep",
      cleanupHandled: false,
    });
    expect(replacement?.endedAt).toBeUndefined();
    expect(replacement?.lastAnnounceDeliveryError).toBeUndefined();
    expect(replacement?.pendingFinalDelivery).toBeUndefined();
    expect(replacement?.pendingFinalDeliveryPayload).toBeUndefined();
    expect(replacement?.deliverySuspendedAt).toBeUndefined();
    expect(replacement?.deliverySuspendedReason).toBeUndefined();
  });

  it("finalizes expired delete-mode parents when descendant cleanup retriggers deferred announce handling", async () => {
    mocks.loadSessionStore.mockReturnValue({
      "agent:main:subagent:parent": {
        sessionId: "sess-parent",
        updatedAt: 1,
      },
      "agent:main:subagent:child": {
        sessionId: "sess-child",
        updatedAt: 1,
      },
    });

    mod.addSubagentRunForTests({
      runId: "run-parent-expired",
      childSessionKey: "agent:main:subagent:parent",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "expired parent cleanup",
      cleanup: "delete",
      createdAt: Date.parse("2026-03-24T11:50:00Z"),
      startedAt: Date.parse("2026-03-24T11:50:30Z"),
      endedAt: Date.parse("2026-03-24T11:51:00Z"),
      cleanupHandled: false,
      cleanupCompletedAt: undefined,
    });

    mod.registerSubagentRun({
      runId: "run-child-finished",
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:subagent:parent",
      requesterDisplayKey: "parent",
      task: "descendant settles",
      cleanup: "keep",
    });

    await waitForFast(() => {
      expect(
        mod
          .listSubagentRunsForRequester("agent:main:main")
          .find((entry) => entry.runId === "run-parent-expired"),
      ).toBeUndefined();
    });

    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
    expectRecordFields(
      getMockCallArg(mocks.runSubagentAnnounceFlow, 0, 0, "child finished announce"),
      { childRunId: "run-child-finished" },
      "child finished announce params",
    );
    await waitForFast(() => {
      expect(mocks.onSubagentEnded).toHaveBeenCalledWith({
        childSessionKey: "agent:main:subagent:parent",
        reason: "deleted",
        workspaceDir: undefined,
      });
    });
  });

  it("loads runtime plugins before emitting killed subagent ended hooks", async () => {
    const endedHookRunner = {
      hasHooks: (hookName: string) => hookName === "subagent_ended",
      runSubagentEnded: mocks.runSubagentEnded,
    };
    mocks.getGlobalHookRunner.mockReturnValue(null);
    mocks.ensureRuntimePluginsLoaded.mockImplementation(() => {
      mocks.getGlobalHookRunner.mockReturnValue(endedHookRunner as never);
    });

    mod.registerSubagentRun({
      runId: "run-killed-init",
      childSessionKey: "agent:main:subagent:killed",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      requesterOrigin: { channel: "quietchat", accountId: "acct-1" },
      task: "kill after init",
      cleanup: "keep",
      workspaceDir: "/tmp/killed-workspace",
    });

    const updated = mod.markSubagentRunTerminated({
      runId: "run-killed-init",
      reason: "manual kill",
    });

    expect(updated).toBe(1);
    const killedRun = mod
      .listSubagentRunsForRequester("agent:main:main")
      .find((entry) => entry.runId === "run-killed-init");
    const killedAt = Date.parse("2026-03-24T12:00:00Z");
    expect(killedRun?.outcome).toEqual({
      status: "error",
      error: "manual kill",
      startedAt: killedAt,
      endedAt: killedAt,
      elapsedMs: 0,
    });
    await waitForFast(() => {
      expect(mocks.ensureRuntimePluginsLoaded).toHaveBeenCalledWith({
        config: {
          agents: { defaults: { subagents: { archiveAfterMinutes: 0 } } },
          session: { mainKey: "main", scope: "per-sender" },
        },
        workspaceDir: "/tmp/killed-workspace",
        allowGatewaySubagentBinding: true,
      });
    });
    expectRecordFields(
      getMockCallArg(mocks.runSubagentEnded, 0, 0, "subagent ended hook"),
      {
        targetSessionKey: "agent:main:subagent:killed",
        reason: "subagent-killed",
        accountId: "acct-1",
        runId: "run-killed-init",
        outcome: "killed",
        error: "manual kill",
      },
      "subagent ended hook params",
    );
    expectRecordFields(
      getMockCallArg(mocks.runSubagentEnded, 0, 1, "subagent ended hook context"),
      {
        runId: "run-killed-init",
        childSessionKey: "agent:main:subagent:killed",
        requesterSessionKey: "agent:main:main",
      },
      "subagent ended hook context",
    );
  });

  it("deletes killed delete-mode runs and notifies deleted cleanup", async () => {
    mod.registerSubagentRun({
      runId: "run-killed-delete",
      childSessionKey: "agent:main:subagent:killed-delete",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "kill and delete",
      cleanup: "delete",
      workspaceDir: "/tmp/killed-delete-workspace",
    });

    const updated = mod.markSubagentRunTerminated({
      runId: "run-killed-delete",
      reason: "manual kill",
    });

    expect(updated).toBe(1);
    expect(
      mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === "run-killed-delete"),
    ).toBeUndefined();
    await waitForFast(() => {
      expect(mocks.onSubagentEnded).toHaveBeenCalledWith({
        childSessionKey: "agent:main:subagent:killed-delete",
        reason: "deleted",
        workspaceDir: "/tmp/killed-delete-workspace",
      });
    });
  });

  it("removes attachments for killed delete-mode runs", async () => {
    const attachmentsRootDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-kill-attachments-"),
    );
    const attachmentsDir = path.join(attachmentsRootDir, "child");
    await fs.mkdir(attachmentsDir, { recursive: true });
    await fs.writeFile(path.join(attachmentsDir, "artifact.txt"), "artifact");

    mod.registerSubagentRun({
      runId: "run-killed-delete-attachments",
      childSessionKey: "agent:main:subagent:killed-delete-attachments",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "kill and delete attachments",
      cleanup: "delete",
      attachmentsDir,
      attachmentsRootDir,
    });

    const updated = mod.markSubagentRunTerminated({
      runId: "run-killed-delete-attachments",
      reason: "manual kill",
    });

    expect(updated).toBe(1);
    await waitForFast(async () => {
      await expectPathMissing(attachmentsDir);
    });
  });

  it("announces readable failure when an interrupted run is finalized", async () => {
    mod.addSubagentRunForTests({
      runId: "run-interrupted",
      childSessionKey: "agent:main:subagent:interrupted",
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterOrigin: { channel: "quietchat", accountId: "acct-interrupted" },
      requesterDisplayKey: "main",
      task: "recover interrupted subagent",
      cleanup: "keep",
      expectsCompletionMessage: true,
      spawnMode: "run",
      createdAt: 1,
      startedAt: 1,
      sessionStartedAt: 1,
      accumulatedRuntimeMs: 0,
      cleanupHandled: false,
    });

    const updated = await mod.finalizeInterruptedSubagentRun({
      runId: "run-interrupted",
      error:
        "Subagent run was interrupted by a gateway restart or connection loss. Automatic recovery failed after 2 attempts. Please retry.",
      endedAt: 2,
    });

    expect(updated).toBe(1);
    await waitForFast(() => {
      const announceParams = findRecordCallArg(
        mocks.runSubagentAnnounceFlow,
        0,
        "interrupted announce",
        (record) => record.childRunId === "run-interrupted",
      );
      expectRecordFields(
        announceParams,
        {
          childRunId: "run-interrupted",
          requesterSessionKey: "agent:main:main",
          requesterOrigin: { channel: "quietchat", accountId: "acct-interrupted" },
        },
        "interrupted announce params",
      );
      const outcome = expectRecordFields(
        announceParams.outcome,
        { status: "error" },
        "interrupted announce outcome",
      );
      expect(String(outcome.error)).toContain("Automatic recovery failed after 2 attempts");
    });
    const run = mod
      .listSubagentRunsForRequester("agent:main:main")
      .find((entry) => entry.runId === "run-interrupted");
    expect(run?.outcome).toEqual({
      status: "error",
      error:
        "Subagent run was interrupted by a gateway restart or connection loss. Automatic recovery failed after 2 attempts. Please retry.",
      startedAt: 1,
      endedAt: 2,
      elapsedMs: 1,
    });
    expect(run?.cleanupCompletedAt).toBeTypeOf("number");
  });

  it("removes attachments for released delete-mode runs", async () => {
    const attachmentsRootDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-release-attachments-"),
    );
    const attachmentsDir = path.join(attachmentsRootDir, "child");
    await fs.mkdir(attachmentsDir, { recursive: true });
    await fs.writeFile(path.join(attachmentsDir, "artifact.txt"), "artifact");

    mod.addSubagentRunForTests({
      runId: "run-release-delete",
      childSessionKey: "agent:main:subagent:release-delete",
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterOrigin: undefined,
      requesterDisplayKey: "main",
      task: "release attachments",
      cleanup: "delete",
      expectsCompletionMessage: undefined,
      spawnMode: "run",
      attachmentsDir,
      attachmentsRootDir,
      createdAt: 1,
      startedAt: 1,
      sessionStartedAt: 1,
      accumulatedRuntimeMs: 0,
      cleanupHandled: false,
    });

    mod.releaseSubagentRun("run-release-delete");

    await waitForFast(async () => {
      await expectPathMissing(attachmentsDir);
    });
    await waitForFast(() => {
      expect(mocks.onSubagentEnded).toHaveBeenCalledWith({
        childSessionKey: "agent:main:subagent:release-delete",
        reason: "released",
        workspaceDir: undefined,
      });
    });
  });

  it("loads plugin and context-engine runtime before released end hooks", async () => {
    mod.addSubagentRunForTests({
      runId: "run-release-context-engine",
      childSessionKey: "agent:main:session:child",
      controllerSessionKey: "agent:main:session:parent",
      requesterSessionKey: "agent:main:session:parent",
      requesterOrigin: undefined,
      requesterDisplayKey: "parent",
      task: "task",
      cleanup: "keep",
      expectsCompletionMessage: undefined,
      spawnMode: "run",
      agentDir: "/tmp/agent-alt",
      workspaceDir: "/tmp/workspace",
      createdAt: 1,
      startedAt: 1,
      sessionStartedAt: 1,
      accumulatedRuntimeMs: 0,
      cleanupHandled: false,
    });

    mod.releaseSubagentRun("run-release-context-engine");

    await waitForFast(() => {
      expect(mocks.onSubagentEnded).toHaveBeenCalledWith({
        agentDir: "/tmp/agent-alt",
        childSessionKey: "agent:main:session:child",
        reason: "released",
        workspaceDir: "/tmp/workspace",
      });
    });
    expect(mocks.ensureRuntimePluginsLoaded).toHaveBeenCalledWith({
      config: {
        agents: { defaults: { subagents: { archiveAfterMinutes: 0 } } },
        session: { mainKey: "main", scope: "per-sender" },
      },
      workspaceDir: "/tmp/workspace",
      allowGatewaySubagentBinding: true,
    });
    expect(mocks.ensureContextEnginesInitialized).toHaveBeenCalledTimes(1);
    expect(mocks.resolveContextEngine).toHaveBeenCalledWith(
      {
        agents: { defaults: { subagents: { archiveAfterMinutes: 0 } } },
        session: { mainKey: "main", scope: "per-sender" },
      },
      {
        agentDir: "/tmp/agent-alt",
        workspaceDir: "/tmp/workspace",
      },
    );
  });

  it("passes stored agentDir through swept context-engine cleanup paths", async () => {
    const now = Date.parse("2026-03-24T12:00:00Z");
    mod.addSubagentRunForTests({
      runId: "run-session-swept-context-engine",
      childSessionKey: "agent:alt:session:child-session",
      controllerSessionKey: "agent:main:session:parent",
      requesterSessionKey: "agent:main:session:parent",
      requesterOrigin: undefined,
      requesterDisplayKey: "parent",
      task: "session cleanup",
      cleanup: "keep",
      expectsCompletionMessage: undefined,
      spawnMode: "session",
      agentDir: "/tmp/agent-session",
      workspaceDir: "/tmp/workspace-session",
      createdAt: now - 20_000,
      startedAt: now - 10_000,
      sessionStartedAt: now - 10_000,
      accumulatedRuntimeMs: 0,
      endedAt: now - 8_000,
      outcome: { status: "ok", startedAt: now - 10_000, endedAt: now - 8_000, elapsedMs: 2_000 },
      cleanupHandled: true,
      cleanupCompletedAt: now - 6 * 60_000,
    });
    mod.addSubagentRunForTests({
      runId: "run-archive-swept-context-engine",
      childSessionKey: "agent:alt:session:child-archive",
      controllerSessionKey: "agent:main:session:parent",
      requesterSessionKey: "agent:main:session:parent",
      requesterOrigin: undefined,
      requesterDisplayKey: "parent",
      task: "archive cleanup",
      cleanup: "delete",
      expectsCompletionMessage: undefined,
      spawnMode: "run",
      agentDir: "/tmp/agent-archive",
      workspaceDir: "/tmp/workspace-archive",
      createdAt: now - 20_000,
      startedAt: now - 10_000,
      sessionStartedAt: now - 10_000,
      accumulatedRuntimeMs: 0,
      endedAt: now - 8_000,
      outcome: { status: "ok", startedAt: now - 10_000, endedAt: now - 8_000, elapsedMs: 2_000 },
      archiveAtMs: now - 1,
      cleanupHandled: true,
    });

    await mod.__testing.sweepOnceForTests();

    await waitForFast(() => {
      findRecordCallArg(
        mocks.resolveContextEngine,
        1,
        "session context engine cleanup",
        (record) =>
          record.agentDir === "/tmp/agent-session" &&
          record.workspaceDir === "/tmp/workspace-session",
      );
      findRecordCallArg(
        mocks.resolveContextEngine,
        1,
        "archive context engine cleanup",
        (record) =>
          record.agentDir === "/tmp/agent-archive" &&
          record.workspaceDir === "/tmp/workspace-archive",
      );
      expect(mocks.resolveContextEngine).toHaveBeenCalledWith(
        {
          agents: { defaults: { subagents: { archiveAfterMinutes: 0 } } },
          session: { mainKey: "main", scope: "per-sender" },
        },
        {
          agentDir: "/tmp/agent-session",
          workspaceDir: "/tmp/workspace-session",
        },
      );
      expect(mocks.resolveContextEngine).toHaveBeenCalledWith(
        {
          agents: { defaults: { subagents: { archiveAfterMinutes: 0 } } },
          session: { mainKey: "main", scope: "per-sender" },
        },
        {
          agentDir: "/tmp/agent-archive",
          workspaceDir: "/tmp/workspace-archive",
        },
      );
    });
  });

  it("expires suspended cron final deliveries into compact tombstones", async () => {
    const now = Date.parse("2026-03-24T12:00:00Z");
    const runId = "run-suspended-cron-expired";
    mod.addSubagentRunForTests({
      runId,
      childSessionKey: "agent:main:subagent:suspended-cron",
      controllerSessionKey: "agent:main:cron:cron-1:run:parent",
      requesterSessionKey: "agent:main:cron:cron-1:run:parent",
      requesterDisplayKey: "cron",
      task: "cron suspended delivery",
      cleanup: "keep",
      expectsCompletionMessage: true,
      spawnMode: "session",
      createdAt: now - 3 * 60 * 60_000,
      startedAt: now - 3 * 60 * 60_000,
      endedAt: now - 3 * 60 * 60_000,
      outcome: { status: "ok" },
      pendingFinalDelivery: true,
      pendingFinalDeliveryCreatedAt: now - 3 * 60 * 60_000,
      pendingFinalDeliveryLastAttemptAt: now - 2 * 60 * 60_000 - 1,
      pendingFinalDeliveryAttemptCount: 3,
      pendingFinalDeliveryLastError: "gateway request timeout for agent",
      pendingFinalDeliveryPayload: {
        requesterSessionKey: "agent:main:cron:cron-1:run:parent",
        requesterDisplayKey: "cron",
        childSessionKey: "agent:main:subagent:suspended-cron",
        childRunId: runId,
        task: "cron suspended delivery",
        endedAt: now - 3 * 60 * 60_000,
        outcome: { status: "ok" },
        expectsCompletionMessage: true,
        frozenResultText: "large final payload",
      },
      deliverySuspendedAt: now - 2 * 60 * 60_000 - 1,
      deliverySuspendedReason: "retry-limit",
      lastAnnounceDeliveryError: "gateway request timeout for agent",
    });

    await mod.__testing.sweepOnceForTests();

    const run = mod.getSubagentRunByChildSessionKey("agent:main:subagent:suspended-cron");
    expect(run).toMatchObject({
      runId,
      pendingFinalDelivery: undefined,
      pendingFinalDeliveryPayload: undefined,
      deliverySuspendedAt: undefined,
      deliverySuspendedReason: undefined,
      deliveryDiscardedAt: now,
      deliveryDiscardReason: "expired",
      cleanupHandled: true,
      cleanupCompletedAt: now,
    });
    expect(run?.deliveryDiscardedPayloadSummary).toEqual({
      requesterSessionKey: "agent:main:cron:cron-1:run:parent",
      childSessionKey: "agent:main:subagent:suspended-cron",
      childRunId: runId,
      endedAt: now - 3 * 60 * 60_000,
      status: "ok",
      lastError: "gateway request timeout for agent",
    });
    await waitForFast(() => {
      expect(mocks.onSubagentEnded).toHaveBeenCalledWith({
        childSessionKey: "agent:main:subagent:suspended-cron",
        reason: "completed",
        workspaceDir: undefined,
      });
    });
    expect(mocks.persistSubagentRunsToDisk).toHaveBeenCalled();
  });

  it("pressure-prunes oldest suspended final deliveries when backlog exceeds hard cap", async () => {
    const now = Date.parse("2026-03-24T12:00:00Z");
    for (let i = 0; i < 51; i += 1) {
      const runId = `run-suspended-pressure-${i}`;
      mod.addSubagentRunForTests({
        runId,
        childSessionKey: `agent:main:subagent:suspended-pressure-${i}`,
        controllerSessionKey: "agent:main:main",
        requesterSessionKey: "agent:main:telegram:direct:418181497",
        requesterDisplayKey: "telegram",
        task: "interactive suspended delivery",
        cleanup: "keep",
        expectsCompletionMessage: true,
        spawnMode: "session",
        createdAt: now - 60_000,
        startedAt: now - 60_000,
        endedAt: now - 60_000,
        outcome: { status: "ok" },
        pendingFinalDelivery: true,
        pendingFinalDeliveryCreatedAt: now - 60_000,
        pendingFinalDeliveryLastAttemptAt: now - 60_000 + i,
        pendingFinalDeliveryAttemptCount: 3,
        pendingFinalDeliveryLastError: "gateway request timeout for agent",
        pendingFinalDeliveryPayload: {
          requesterSessionKey: "agent:main:telegram:direct:418181497",
          requesterDisplayKey: "telegram",
          childSessionKey: `agent:main:subagent:suspended-pressure-${i}`,
          childRunId: runId,
          task: "interactive suspended delivery",
          endedAt: now - 60_000,
          outcome: { status: "ok" },
          expectsCompletionMessage: true,
          frozenResultText: "final payload",
        },
        deliverySuspendedAt: now - 60_000 + i,
        deliverySuspendedReason: "retry-limit",
      });
    }

    await mod.__testing.sweepOnceForTests();

    const runs = Array.from({ length: 51 }, (_, i) =>
      mod.getSubagentRunByChildSessionKey(`agent:main:subagent:suspended-pressure-${i}`),
    );
    const discarded = runs.filter((run) => run?.deliveryDiscardReason === "pressure-pruned");
    const stillSuspended = runs.filter(
      (run) => run?.pendingFinalDelivery === true && typeof run.deliverySuspendedAt === "number",
    );
    expect(discarded).toHaveLength(41);
    expect(stillSuspended).toHaveLength(10);
    expect(discarded[0]?.runId).toBe("run-suspended-pressure-0");
    expect(runs[40]?.deliveryDiscardReason).toBe("pressure-pruned");
    expect(runs[41]?.pendingFinalDelivery).toBe(true);
    expect(mocks.persistSubagentRunsToDisk).toHaveBeenCalled();
  });
});
