// Subagent registry archive tests cover keep/delete cleanup modes, retryable
// session deletion, and context-engine lifecycle callbacks.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { callGateway } from "../gateway/call.js";
import { getAgentRunContext } from "../infra/agent-run-registry.js";
import { SUBAGENT_KILL_TASK_ERROR } from "../tasks/detached-task-runtime-contract.js";
import { resetDetachedTaskLifecycleRuntimeForTests } from "../tasks/task-runtime.test-helpers.js";

const taskRuntimeMocks = vi.hoisted(() => ({
  finalizeTaskRunByRunId: vi.fn<(_params: unknown) => unknown[]>(() => [{}]),
}));
const taskStatusMocks = vi.hoisted(() => ({
  findTaskByRunIdForStatus: vi.fn(),
  listTasksForSessionKeyForStatus: vi.fn(() => [] as never[]),
}));
const hasLiveOrRecentlyDispatchedContinuationWorkMock = vi.hoisted(() =>
  vi.fn<(_sessionKey: string) => boolean>(() => false),
);
const sessionAccessorMocks = vi.hoisted(() => ({
  listSessionEntriesReadOnly: vi.fn(() => [] as Array<{ sessionKey: string; entry: unknown }>),
}));

const noop = () => {};
const currentConfig = {
  agents: { defaults: { subagents: { archiveAfterMinutes: 60 } } },
};
const loadConfigMock = vi.fn(() => currentConfig);
const flushSweepMicrotasks = async () => {
  // Archive sweeps schedule follow-up work through microtasks; drain them before
  // asserting registry and context-engine side effects.
  await Promise.resolve();
  await Promise.resolve();
};

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(async (request: unknown) => {
    const method = (request as { method?: string }).method;
    if (method === "agent.wait") {
      // Keep lifecycle unsettled so register/replace assertions can inspect stored state.
      return { status: "pending" };
    }
    return {};
  }),
}));

vi.mock("../tasks/detached-task-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tasks/detached-task-runtime.js")>();
  return {
    ...actual,
    finalizeTaskRunByRunId: taskRuntimeMocks.finalizeTaskRunByRunId,
  };
});

vi.mock("../tasks/task-status-access.js", () => ({
  findTaskByRunIdForStatus: taskStatusMocks.findTaskByRunIdForStatus,
  listTasksForSessionKeyForStatus: taskStatusMocks.listTasksForSessionKeyForStatus,
}));

vi.mock("../config/sessions/session-accessor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/sessions/session-accessor.js")>();
  return {
    ...actual,
    listSessionEntriesReadOnly: sessionAccessorMocks.listSessionEntriesReadOnly,
  };
});

vi.mock("../infra/agent-events.js", () => ({
  getAgentEventLifecycleGeneration: () => "test-generation",
  isAgentEventLifecycleGenerationCurrent: (generation: string) => generation === "test-generation",
  onAgentEvent: vi.fn((_handler: unknown) => noop),
  registerAgentEventLifecycleRotationHandler: vi.fn(),
}));
vi.mock("../infra/agent-run-registry.js", () => ({
  getAgentRunContext: vi.fn(() => undefined),
}));

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    getRuntimeConfig: loadConfigMock,
  };
});

vi.mock("../auto-reply/continuation/work-store.js", () => ({
  hasLiveOrRecentlyDispatchedContinuationWork: hasLiveOrRecentlyDispatchedContinuationWorkMock,
}));

vi.mock("./subagents/announce/subagent-announce.js", () => ({
  runSubagentAnnounceFlow: vi.fn(async () => true),
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => null),
}));

// Continuation-specific archive-eviction guards, split out of
// subagent-registry.archive.e2e.test.ts: the back-merge kept both our tests and
// upstream's, which pushed that file past the 1000-line lint budget. Splitting
// keeps every assertion rather than suppressing the rule.
describe("subagent registry archive behavior (continuation work)", () => {
  let mod: typeof import("./subagents/registry/subagent-registry.test-helpers.js");
  let createCanonicalSubagentRunFixture: typeof import("./subagents/registry/subagent-registry.persistence.test-support.js").createCanonicalSubagentRunFixture;
  let createSubagentRunRecord: typeof import("./subagent-test-fixtures.test-helpers.js").createSubagentRunRecord;

  beforeAll(async () => {
    ({ createCanonicalSubagentRunFixture } =
      await import("./subagents/registry/subagent-registry.persistence.test-support.js"));
    ({ createSubagentRunRecord } = await import("./subagent-test-fixtures.test-helpers.js"));
    mod = await import("./subagents/registry/subagent-registry.test-helpers.js");
  });

  const setRegistryTestDeps = (
    overrides: NonNullable<Parameters<typeof mod.testing.setDepsForTest>[0]> = {},
  ) => {
    mod.testing.setDepsForTest({
      callGateway,
      getRuntimeConfig: loadConfigMock as typeof import("../config/config.js").getRuntimeConfig,
      loadAgentRuntimePluginRegistryHandle: vi.fn(),
      maybeWakeRequesterAfterAllChildrenSettled: vi.fn(async (params) => {
        params.completeBatch([params.settledEntry.runId]);
        return false;
      }),
      ...overrides,
    });
  };

  const addCanonicalSubagentRunForTests = (
    entry: Parameters<typeof mod.addSubagentRunForTests>[0],
  ) => {
    mod.addSubagentRunForTests(createCanonicalSubagentRunFixture(createSubagentRunRecord(entry)));
  };

  const waitForNoRequesterRuns = async () => {
    await vi.waitFor(() => {
      expect(mod.listSubagentRunsForRequester("agent:main:main")).toHaveLength(0);
    });
  };

  beforeEach(() => {
    resetDetachedTaskLifecycleRuntimeForTests();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    vi.mocked(callGateway).mockReset();
    vi.mocked(callGateway).mockImplementation(async (request: unknown) => {
      const method = (request as { method?: string }).method;
      if (method === "agent.wait") {
        // Keep lifecycle unsettled so register/replace assertions can inspect stored state.
        return { status: "pending" };
      }
      return {};
    });
    loadConfigMock.mockClear();
    hasLiveOrRecentlyDispatchedContinuationWorkMock.mockReset().mockReturnValue(false);
    vi.mocked(getAgentRunContext).mockReset().mockReturnValue(undefined);
    taskRuntimeMocks.finalizeTaskRunByRunId.mockClear();
    taskStatusMocks.findTaskByRunIdForStatus.mockReset();
    taskStatusMocks.listTasksForSessionKeyForStatus.mockReset();
    taskStatusMocks.listTasksForSessionKeyForStatus.mockReturnValue([]);
    sessionAccessorMocks.listSessionEntriesReadOnly.mockReset();
    sessionAccessorMocks.listSessionEntriesReadOnly.mockReturnValue([]);
    taskStatusMocks.findTaskByRunIdForStatus.mockImplementation((runId: string) => {
      const entry = mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((candidate) => candidate.runId === runId);
      return entry
        ? ({
            taskId: `task-${runId}`,
            runId,
            runtime: "subagent",
            childSessionKey: entry.childSessionKey,
            createdAt: entry.createdAt,
            status: "cancelled",
            error: SUBAGENT_KILL_TASK_ERROR,
          } as never)
        : undefined;
    });
    setRegistryTestDeps();
    mod.resetSubagentRegistryForTests({ persist: false });
  });

  afterEach(() => {
    resetDetachedTaskLifecycleRuntimeForTests();
    mod.testing.setDepsForTest();
    mod.resetSubagentRegistryForTests({ persist: false });
    vi.useRealTimers();
  });

  it("defers archive eviction without session identity while continuation work is live", async () => {
    const childSessionKey = "agent:main:subagent:delete-work-live";
    mod.addSubagentRunForTests({
      runId: "run-delete-work-live",
      childSessionKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "guard archived delete until continuation drains",
      cleanup: "delete",
      createdAt: Date.now() - 60_000,
      endedAt: Date.now() - 1,
      archiveAtMs: Date.now(),
    });
    hasLiveOrRecentlyDispatchedContinuationWorkMock
      .mockReturnValueOnce(true)
      .mockReturnValue(false);

    await mod.testing.sweepOnceForTests();

    expect(hasLiveOrRecentlyDispatchedContinuationWorkMock).toHaveBeenCalledWith(childSessionKey);
    expect(mod.listSubagentRunsForRequester("agent:main:main")).toEqual([
      expect.objectContaining({ runId: "run-delete-work-live" }),
    ]);
    expect(
      vi
        .mocked(callGateway)
        .mock.calls.some(
          ([request]) => (request as { method?: string } | undefined)?.method === "sessions.delete",
        ),
    ).toBe(false);

    await mod.testing.sweepOnceForTests();
    await flushSweepMicrotasks();

    await waitForNoRequesterRuns();
    expect(
      vi
        .mocked(callGateway)
        .mock.calls.filter(
          ([request]) => (request as { method?: string } | undefined)?.method === "sessions.delete",
        ),
    ).toHaveLength(0);
  });

  it("defers collector-group archive eviction while continuation work is live", async () => {
    const now = Date.now();
    const groupId = "collector-work-live";
    for (const suffix of ["one", "two"]) {
      addCanonicalSubagentRunForTests({
        runId: `run-collector-work-live-${suffix}`,
        childSessionKey: `agent:main:subagent:collector-work-live-${suffix}`,
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: `guard collector ${suffix} until continuation drains`,
        cleanup: "delete",
        collect: true,
        groupId,
        collectorCompletion: { status: "done" },
        createdAt: now - 60_000,
        endedAt: now - 1,
        archiveAtMs: now,
      });
    }
    hasLiveOrRecentlyDispatchedContinuationWorkMock.mockImplementation((sessionKey: string) =>
      sessionKey.endsWith("-one"),
    );

    await mod.testing.sweepOnceForTests();

    expect(mod.listSubagentRunsForRequester("agent:main:main")).toHaveLength(2);
    expect(
      vi
        .mocked(callGateway)
        .mock.calls.some(
          ([request]) => (request as { method?: string } | undefined)?.method === "sessions.delete",
        ),
    ).toBe(false);

    hasLiveOrRecentlyDispatchedContinuationWorkMock.mockReturnValue(false);
    await mod.testing.sweepOnceForTests();
    await flushSweepMicrotasks();

    await waitForNoRequesterRuns();
    expect(
      vi
        .mocked(callGateway)
        .mock.calls.filter(
          ([request]) => (request as { method?: string } | undefined)?.method === "sessions.delete",
        ),
    ).toHaveLength(0);
  });
});
