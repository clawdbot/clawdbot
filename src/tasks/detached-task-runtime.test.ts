import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskRecord } from "./task-registry.types.js";
import {
  completeTaskRunByRunId,
  createQueuedTaskRun,
  createRunningTaskRun,
  failTaskRunByRunId,
  getDetachedTaskLifecycleRuntime,
  recordTaskRunProgressByRunId,
  resetDetachedTaskLifecycleRuntimeForTests,
  setDetachedTaskLifecycleRuntime,
  setDetachedTaskDeliveryStatusByRunId,
  startTaskRunByRunId,
} from "./detached-task-runtime.js";

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

  it("dispatches lifecycle operations through the installed runtime", () => {
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

    const fakeRuntime = {
      createQueuedTaskRun: vi.fn(() => queuedTask),
      createRunningTaskRun: vi.fn(() => runningTask),
      startTaskRunByRunId: vi.fn(() => undefined),
      recordTaskRunProgressByRunId: vi.fn(() => undefined),
      completeTaskRunByRunId: vi.fn(() => undefined),
      failTaskRunByRunId: vi.fn(() => undefined),
      setDetachedTaskDeliveryStatusByRunId: vi.fn(() => undefined),
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

    resetDetachedTaskLifecycleRuntimeForTests();
    expect(getDetachedTaskLifecycleRuntime()).toBe(defaultRuntime);
  });
});
