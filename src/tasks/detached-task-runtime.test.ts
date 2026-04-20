import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cancelDetachedTaskRunById,
  completeTaskRunByRunId,
  createQueuedTaskRun,
  createRunningTaskRun,
  failTaskRunByRunId,
  getDetachedTaskLifecycleRuntime,
  getDetachedTaskLifecycleRuntimeRegistration,
  registerDetachedTaskRuntime,
  recordTaskRunProgressByRunId,
  resetDetachedTaskLifecycleRuntimeForTests,
  setDetachedTaskLifecycleRuntime,
  setDetachedTaskDeliveryStatusByRunId,
  startTaskRunByRunId,
} from "./detached-task-runtime.js";
import type { TaskRecord } from "./task-registry.types.js";

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

describe("detached-task-runtime", () => {
  afterEach(() => {
    resetDetachedTaskLifecycleRuntimeForTests();
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

    expect(fakeRuntime.createQueuedTaskRun).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-queued", task: "Queue task" }),
    );
    expect(fakeRuntime.createRunningTaskRun).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-running", task: "Run task" }),
    );
    expect(fakeRuntime.startTaskRunByRunId).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-running", startedAt: 10 }),
    );
    expect(fakeRuntime.recordTaskRunProgressByRunId).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-running", lastEventAt: 20 }),
    );
    expect(fakeRuntime.completeTaskRunByRunId).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-running", endedAt: 30 }),
    );
    expect(fakeRuntime.failTaskRunByRunId).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-running", endedAt: 40 }),
    );
    expect(fakeRuntime.setDetachedTaskDeliveryStatusByRunId).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-running", deliveryStatus: "delivered" }),
    );
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

    expect(getDetachedTaskLifecycleRuntimeRegistration()).toMatchObject({
      pluginId: "tests/detached-runtime",
      runtime,
    });
    expect(getDetachedTaskLifecycleRuntime()).toBe(runtime);
  });
});
