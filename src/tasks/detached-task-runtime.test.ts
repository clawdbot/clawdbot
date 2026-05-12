import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cancelDetachedTaskRunById,
  completeTaskRunByRunId,
  createQueuedTaskRun,
  createRunningTaskRun,
  failTaskRunByRunId,
  finalizeTaskRunByRunId,
  getDetachedTaskLifecycleRuntime,
  getDetachedTaskLifecycleRuntimeRegistration,
  registerDetachedTaskRuntime,
  recordTaskRunProgressByRunId,
  resetDetachedTaskLifecycleRuntimeForTests,
  setDetachedTaskLifecycleRuntime,
  setDetachedTaskDeliveryStatusByRunId,
  startTaskRunByRunId,
  tryRecoverTaskBeforeMarkLost,
} from "./detached-task-runtime.js";
import type { TaskRecord } from "./task-registry.types.js";

const { mockLogWarn } = vi.hoisted(() => ({
  mockLogWarn: vi.fn(),
}));
vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    subsystem: "tasks/detached-runtime",
    isEnabled: () => true,
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: mockLogWarn,
    error: vi.fn(),
    fatal: vi.fn(),
    raw: vi.fn(),
    child: vi.fn(),
  }),
}));

function createFakeTaskRecord(overrides?: Partial<TaskRecord>): TaskRecord {
  return {
    taskId: "task-fake",
    runtime: "cli",
    requesterSessionKey: "agent:main:main",
    ownerKey: "agent:main:main",
    scopeKind: "session",
    runId: "run-fake",
    task: "Fake task",
    status: "running",
    deliveryStatus: "pending",
    notifyPolicy: "done_only",
    createdAt: 1,
    ...overrides,
  };
}

function findWarningPayload(message: string): Record<string, unknown> | undefined {
  const payload = mockLogWarn.mock.calls.find(([entry]) => entry === message)?.[1];
  return payload && typeof payload === "object" ? (payload as Record<string, unknown>) : undefined;
}

function requireFirstCallArg(
  mock: { mock: { calls: readonly unknown[][] } },
  label: string,
): Record<string, unknown> {
  const [call] = mock.mock.calls;
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  const [arg] = call;
  if (typeof arg !== "object" || arg === null || Array.isArray(arg)) {
    throw new Error(`expected ${label} params to be an object`);
  }
  return arg as Record<string, unknown>;
}

describe("detached-task-runtime", () => {
  afterEach(() => {
    resetDetachedTaskLifecycleRuntimeForTests();
    mockLogWarn.mockClear();
  });

  it("dispatches lifecycle operations through the installed runtime", async () => {
    const defaultRuntime = getDetachedTaskLifecycleRuntime();
    const queuedTask = createFakeTaskRecord({
      taskId: "task-queued",
      runId: "run-queued",
      status: "queued",
    });
    const runningTask = createFakeTaskRecord({
      taskId: "task-running",
      runId: "run-running",
    });
    const updatedTasks = [runningTask];

    const fakeRuntime: typeof defaultRuntime = {
      createQueuedTaskRun: vi.fn(() => queuedTask),
      createRunningTaskRun: vi.fn(() => runningTask),
      startTaskRunByRunId: vi.fn(() => updatedTasks),
      recordTaskRunProgressByRunId: vi.fn(() => updatedTasks),
      finalizeTaskRunByRunId: vi.fn(() => updatedTasks),
      completeTaskRunByRunId: vi.fn(() => updatedTasks),
      failTaskRunByRunId: vi.fn(() => updatedTasks),
      setDetachedTaskDeliveryStatusByRunId: vi.fn(() => updatedTasks),
      cancelDetachedTaskRunById: vi.fn(async () => ({
        found: true,
        cancelled: true,
        task: runningTask,
      })),
    };

    setDetachedTaskLifecycleRuntime(fakeRuntime);

    expect(
      createQueuedTaskRun({
        runtime: "cli",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        requesterSessionKey: "agent:main:main",
        runId: "run-queued",
        task: "Queue task",
      }),
    ).toBe(queuedTask);
    expect(
      createRunningTaskRun({
        runtime: "cli",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        requesterSessionKey: "agent:main:main",
        runId: "run-running",
        task: "Run task",
      }),
    ).toBe(runningTask);

    startTaskRunByRunId({ runId: "run-running", startedAt: 10 });
    recordTaskRunProgressByRunId({ runId: "run-running", lastEventAt: 20 });
    finalizeTaskRunByRunId({ runId: "run-running", status: "succeeded", endedAt: 25 });
    completeTaskRunByRunId({ runId: "run-running", endedAt: 30 });
    failTaskRunByRunId({ runId: "run-running", endedAt: 40 });
    setDetachedTaskDeliveryStatusByRunId({
      runId: "run-running",
      deliveryStatus: "delivered",
    });
    await cancelDetachedTaskRunById({
      cfg: {} as never,
      taskId: runningTask.taskId,
    });

    const queuedArgs = requireFirstCallArg(vi.mocked(fakeRuntime.createQueuedTaskRun), "queued");
    expect(queuedArgs.runId).toBe("run-queued");
    expect(queuedArgs.task).toBe("Queue task");
    const runningArgs = requireFirstCallArg(vi.mocked(fakeRuntime.createRunningTaskRun), "running");
    expect(runningArgs.runId).toBe("run-running");
    expect(runningArgs.task).toBe("Run task");
    const startArgs = requireFirstCallArg(vi.mocked(fakeRuntime.startTaskRunByRunId), "start");
    expect(startArgs.runId).toBe("run-running");
    expect(startArgs.startedAt).toBe(10);
    const progressArgs = requireFirstCallArg(
      vi.mocked(fakeRuntime.recordTaskRunProgressByRunId),
      "progress",
    );
    expect(progressArgs.runId).toBe("run-running");
    expect(progressArgs.lastEventAt).toBe(20);
    const finalizeMock = fakeRuntime.finalizeTaskRunByRunId;
    if (!finalizeMock) {
      throw new Error("Expected fake runtime finalizer");
    }
    const finalizeArgs = requireFirstCallArg(vi.mocked(finalizeMock), "finalize");
    expect(finalizeArgs.runId).toBe("run-running");
    expect(finalizeArgs.status).toBe("succeeded");
    expect(finalizeArgs.endedAt).toBe(25);
    const completeArgs = requireFirstCallArg(
      vi.mocked(fakeRuntime.completeTaskRunByRunId),
      "complete",
    );
    expect(completeArgs.runId).toBe("run-running");
    expect(completeArgs.endedAt).toBe(30);
    const failArgs = requireFirstCallArg(vi.mocked(fakeRuntime.failTaskRunByRunId), "fail");
    expect(failArgs.runId).toBe("run-running");
    expect(failArgs.endedAt).toBe(40);
    const deliveryArgs = vi.mocked(fakeRuntime.setDetachedTaskDeliveryStatusByRunId).mock
      .calls[0]?.[0];
    expect(deliveryArgs?.runId).toBe("run-running");
    expect(deliveryArgs?.deliveryStatus).toBe("delivered");
    expect(fakeRuntime.cancelDetachedTaskRunById).toHaveBeenCalledWith({
      cfg: {} as never,
      taskId: runningTask.taskId,
    });

    resetDetachedTaskLifecycleRuntimeForTests();
    expect(getDetachedTaskLifecycleRuntime()).toBe(defaultRuntime);
  });

  it("tracks registered detached runtimes by plugin id", () => {
    const runtime = {
      ...getDetachedTaskLifecycleRuntime(),
    };

    registerDetachedTaskRuntime("tests/detached-runtime", runtime);

    const registration = getDetachedTaskLifecycleRuntimeRegistration();
    expect(registration?.pluginId).toBe("tests/detached-runtime");
    expect(registration?.runtime).toBe(runtime);
    expect(getDetachedTaskLifecycleRuntime()).toBe(runtime);
  });

  it("falls back to legacy complete and fail hooks when a runtime has no finalizer", () => {
    const defaultRuntime = getDetachedTaskLifecycleRuntime();
    const completeTaskRunByRunIdSpy = vi.fn(
      (_params: Parameters<typeof completeTaskRunByRunId>[0]) => [],
    );
    const failTaskRunByRunIdSpy = vi.fn((_params: Parameters<typeof failTaskRunByRunId>[0]) => []);
    const legacyRuntime = {
      ...defaultRuntime,
      completeTaskRunByRunId: completeTaskRunByRunIdSpy,
      failTaskRunByRunId: failTaskRunByRunIdSpy,
    };
    delete legacyRuntime.finalizeTaskRunByRunId;

    setDetachedTaskLifecycleRuntime(legacyRuntime);

    finalizeTaskRunByRunId({ runId: "legacy-ok", status: "succeeded", endedAt: 10 });
    finalizeTaskRunByRunId({ runId: "legacy-timeout", status: "timed_out", endedAt: 20 });

    const completeArgs = requireFirstCallArg(completeTaskRunByRunIdSpy, "legacy complete");
    expect(completeArgs.runId).toBe("legacy-ok");
    expect(completeArgs.status).toBe("succeeded");
    expect(completeArgs.endedAt).toBe(10);
    const failArgs = requireFirstCallArg(failTaskRunByRunIdSpy, "legacy fail");
    expect(failArgs.runId).toBe("legacy-timeout");
    expect(failArgs.status).toBe("timed_out");
    expect(failArgs.endedAt).toBe(20);
  });

  describe("tryRecoverTaskBeforeMarkLost", () => {
    it("returns recovered when hook returns recovered true", async () => {
      const task = createFakeTaskRecord({ taskId: "task-recover", runtime: "subagent" });
      setDetachedTaskLifecycleRuntime({
        ...getDetachedTaskLifecycleRuntime(),
        tryRecoverTaskBeforeMarkLost: vi.fn(() => ({ recovered: true })),
      });
      const result = await tryRecoverTaskBeforeMarkLost({
        taskId: task.taskId,
        runtime: task.runtime,
        task,
        now: 123,
      });
      expect(result).toEqual({ recovered: true });
    });

    it("returns not recovered when hook returns recovered false", async () => {
      const task = createFakeTaskRecord({ taskId: "task-no-recover", runtime: "cron" });
      setDetachedTaskLifecycleRuntime({
        ...getDetachedTaskLifecycleRuntime(),
        tryRecoverTaskBeforeMarkLost: vi.fn(() => ({ recovered: false })),
      });
      const result = await tryRecoverTaskBeforeMarkLost({
        taskId: task.taskId,
        runtime: task.runtime,
        task,
        now: 456,
      });
      expect(result).toEqual({ recovered: false });
    });

    it("returns not recovered when hook is not provided", async () => {
      const task = createFakeTaskRecord({ taskId: "task-no-hook", runtime: "cli" });
      const result = await tryRecoverTaskBeforeMarkLost({
        taskId: task.taskId,
        runtime: task.runtime,
        task,
        now: 789,
      });
      expect(result).toEqual({ recovered: false });
    });

    it("returns not recovered and logs warning when hook throws", async () => {
      const task = createFakeTaskRecord({ taskId: "task-throw", runtime: "acp" });
      setDetachedTaskLifecycleRuntime({
        ...getDetachedTaskLifecycleRuntime(),
        tryRecoverTaskBeforeMarkLost: vi.fn(() => {
          throw new Error("plugin crashed");
        }),
      });
      const result = await tryRecoverTaskBeforeMarkLost({
        taskId: task.taskId,
        runtime: task.runtime,
        task,
        now: 1_000,
      });
      expect(result).toEqual({ recovered: false });
      const warningPayload = findWarningPayload(
        "Detached task recovery hook threw, proceeding with markTaskLost",
      );
      expect(warningPayload?.taskId).toBe("task-throw");
      expect(warningPayload?.runtime).toBe("acp");
      expect(typeof warningPayload?.elapsedMs).toBe("number");
      if (typeof warningPayload?.elapsedMs !== "number") {
        throw new Error("Expected detached task recovery warning elapsedMs");
      }
      expect(warningPayload.elapsedMs).toBeGreaterThanOrEqual(0);
    });

    it("returns not recovered and logs warning when hook returns invalid result", async () => {
      const task = createFakeTaskRecord({ taskId: "task-invalid", runtime: "cron" });
      setDetachedTaskLifecycleRuntime({
        ...getDetachedTaskLifecycleRuntime(),
        tryRecoverTaskBeforeMarkLost: vi.fn(() => ({ nope: true }) as never),
      });
      const result = await tryRecoverTaskBeforeMarkLost({
        taskId: task.taskId,
        runtime: task.runtime,
        task,
        now: 2_000,
      });
      expect(result).toEqual({ recovered: false });
      const warningPayload = findWarningPayload(
        "Detached task recovery hook returned invalid result, proceeding with markTaskLost",
      );
      expect(warningPayload?.taskId).toBe("task-invalid");
      expect(warningPayload?.runtime).toBe("cron");
    });

    it("logs when the recovery hook is slow", async () => {
      const task = createFakeTaskRecord({ taskId: "task-slow", runtime: "subagent" });
      const dateNowSpy = vi.spyOn(Date, "now");
      dateNowSpy.mockReturnValueOnce(10_000).mockReturnValueOnce(16_000);
      setDetachedTaskLifecycleRuntime({
        ...getDetachedTaskLifecycleRuntime(),
        tryRecoverTaskBeforeMarkLost: vi.fn(async () => ({ recovered: true })),
      });
      const result = await tryRecoverTaskBeforeMarkLost({
        taskId: task.taskId,
        runtime: task.runtime,
        task,
        now: 3_000,
      });
      expect(result).toEqual({ recovered: true });
      const warningPayload = findWarningPayload("Detached task recovery hook was slow");
      expect(warningPayload?.taskId).toBe("task-slow");
      expect(warningPayload?.runtime).toBe("subagent");
      expect(warningPayload?.elapsedMs).toBe(6_000);
      dateNowSpy.mockRestore();
    });
  });
});
