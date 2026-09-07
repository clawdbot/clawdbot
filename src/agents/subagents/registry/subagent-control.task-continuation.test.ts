/** Stable task cancellation must target its current, still-owned execution generation. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getRuntimeConfig } from "../../../config/config.js";
import { runTaskInFlowForOwner } from "../../../tasks/task-executor.js";
import {
  createManagedTaskFlow,
  getTaskFlowById,
} from "../../../tasks/task-flow-runtime-internal.js";
import * as taskControlRuntime from "../../../tasks/task-registry-control.runtime.js";
import { cancelTaskById, findTaskByRunId, getTaskById } from "../../../tasks/task-registry.js";
import {
  resetTaskRegistryControlRuntimeForTests,
  setTaskRegistryControlRuntimeForTests,
} from "../../../tasks/task-registry.test-support.js";
import { useSubagentControlFixture } from "./subagent-control.test-support.js";
import { subagentRegistryDeps } from "./subagent-registry-deps.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { markSubagentRunPausedAfterYield } from "./subagent-registry-run-manager.js";
import { persistSubagentRunsToDiskOrThrow } from "./subagent-registry-state.js";
import { registerSubagentRun, replaceSubagentRunAfterSteerCore } from "./subagent-registry.js";
import { writeSubagentSessionEntry } from "./subagent-registry.persistence.test-support.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry.store.sqlite.js";

const fixture = useSubagentControlFixture();
beforeEach(() => setTaskRegistryControlRuntimeForTests(taskControlRuntime));
afterEach(() => resetTaskRegistryControlRuntimeForTests());

it.each(["canonical", "managed"] as const)(
  "cancels a resumed yielded subagent through its %s task without changing task identity",
  async (selectedKind) => {
    vi.spyOn(subagentRegistryDeps, "runSubagentAnnounceFlow").mockResolvedValue("delivered");
    const childSessionKey = "agent:main:subagent:task-continuation";
    const requesterSessionKey = "agent:main:main";
    await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey: childSessionKey,
      defaultSessionId: "task-continuation-session",
    });
    registerSubagentRun({
      runId: "original-task-run",
      childSessionKey,
      requesterSessionKey,
      requesterAgentId: "main",
      requesterDisplayKey: "main",
      task: "Continue work after yielding",
      cleanup: "keep",
      expectsCompletionMessage: true,
    });
    const original = subagentRuns.get("original-task-run")!;
    const originalTask = findTaskByRunId(original.runId)!;
    expect(markSubagentRunPausedAfterYield({ entry: original })).toBe(true);
    persistSubagentRunsToDiskOrThrow(subagentRuns, [original.runId]);
    expect(
      replaceSubagentRunAfterSteerCore({
        previousRunId: original.runId,
        nextRunId: "resumed-execution-run",
        expected: original,
        allowEndedSource: true,
        persistenceFailure: "throw",
      }),
    ).toBe(true);
    const resumed = subagentRuns.get("resumed-execution-run")!;
    expect(markSubagentRunPausedAfterYield({ entry: resumed })).toBe(true);
    persistSubagentRunsToDiskOrThrow(subagentRuns, [resumed.runId]);
    expect(resumed).toMatchObject({ taskRunId: original.runId, generation: 2 });
    const canonical = getTaskById(originalTask.taskId)!;
    expect(canonical).toMatchObject({ runId: original.runId, status: "running" });
    const flow = createManagedTaskFlow({
      ownerKey: requesterSessionKey,
      controllerId: "tests/task-continuation",
      goal: "Observe resumed work",
    })!;
    const projected = runTaskInFlowForOwner({
      flowId: flow.flowId,
      callerOwnerKey: requesterSessionKey,
      runtime: "subagent",
      childSessionKey,
      runId: original.runId,
      task: "Managed resumed work",
      status: "running",
    });
    expect(projected.created, projected.reason).toBe(true);
    const managed = projected.task!;
    expect(managed.detail).toMatchObject({ taskId: canonical.taskId, generation: 2 });
    const selected = selectedKind === "canonical" ? canonical : managed;

    const result = await cancelTaskById({ cfg: getRuntimeConfig(), taskId: selected.taskId });

    expect(result, result.reason).toMatchObject({ found: true, cancelled: true });
    for (const task of [canonical, managed]) {
      expect(getTaskById(task.taskId)).toMatchObject({
        runId: original.runId,
        status: "cancelled",
        error: "Cancelled by operator.",
      });
    }
    expect(getTaskFlowById(canonical.parentFlowId!)?.status).toBe("cancelled");
    expect(loadSubagentRegistryFromSqlite().get(resumed.runId)).toMatchObject({
      taskRunId: original.runId,
      generation: 2,
      endedReason: "subagent-killed",
    });
  },
);
