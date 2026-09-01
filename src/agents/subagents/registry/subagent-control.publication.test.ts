/** A cancellation result cannot publish a predecessor's task outcome after admitted reactivation. */
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { getRuntimeConfig } from "../../../config/config.js";
import { loadExactSessionEntryReadOnly } from "../../../config/sessions/session-accessor.js";
import { reactivateCompletedSubagentSession } from "../../../gateway/session-subagent-reactivation.js";
import {
  beginSessionWorkAdmission,
  getActiveSessionLifecycleMutationCount,
  getActiveSessionWorkAdmissionCount,
} from "../../../sessions/session-lifecycle-admission.js";
import { SUBAGENT_KILL_TASK_ERROR } from "../../../tasks/detached-task-runtime-contract.js";
import { runTaskInFlowForOwner } from "../../../tasks/task-executor.js";
import { createManagedTaskFlow } from "../../../tasks/task-flow-runtime-internal.js";
import * as taskControlRuntime from "../../../tasks/task-registry-control.runtime.js";
import { updateTask } from "../../../tasks/task-registry-mutation.js";
import { cancelTaskById, findTaskByRunId, getTaskById } from "../../../tasks/task-registry.js";
import { getTaskRegistryStore } from "../../../tasks/task-registry.store.js";
import {
  resetTaskRegistryControlRuntimeForTests,
  setTaskRegistryControlRuntimeForTests,
} from "../../../tasks/task-registry.test-support.js";
import type { AgentWaitResult } from "../../run-wait.js";
import * as killRuntime from "./subagent-control-kill-runtime.js";
import { killSubagentRunAdmin } from "./subagent-control.js";
import { useSubagentControlFixture } from "./subagent-control.test-support.js";
import { subagentRegistryDeps } from "./subagent-registry-deps.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { persistSubagentRunsToDiskOrThrow } from "./subagent-registry-state.js";
import {
  markSubagentRunTerminated,
  registerSubagentRun,
  replaceSubagentRunAfterSteerCore,
} from "./subagent-registry.js";
import { writeSubagentSessionEntry } from "./subagent-registry.persistence.test-support.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry.store.sqlite.js";
import { testing } from "./subagent-registry.test-helpers.js";

const fixture = useSubagentControlFixture();
const rootKey = "agent:main:subagent:publication-root";
const childKey = "agent:main:subagent:publication-drain";

it.each(["canonical", "managed"] as const)(
  "publishes same-owner completion when the selected %s task write lags",
  async (selectedKind) => {
    const capture = createDeferred<string>();
    const captureEntered = createDeferred();
    const wait = createDeferred<AgentWaitResult>();
    testing.setDepsForTest({
      ...subagentRegistryDeps,
      cleanupBrowserSessionsForLifecycleEnd: async () => {},
      runSubagentAnnounceFlow: async () => "delivered",
      captureSubagentCompletionReply: () => {
        captureEntered.resolve();
        return capture.promise;
      },
    });
    vi.spyOn(subagentRegistryDeps, "callGateway").mockImplementation(async (request) => {
      expect(request.method).toBe("agent.wait");
      return await wait.promise;
    });
    await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey: rootKey,
      defaultSessionId: "publication-same-owner-session",
    });
    registerSubagentRun({
      runId: "publication-same-owner",
      childSessionKey: rootKey,
      requesterSessionKey: "agent:main:main",
      requesterAgentId: "main",
      requesterDisplayKey: "main",
      task: "same-owner completion",
      cleanup: "keep",
    });
    const owner = subagentRuns.get("publication-same-owner")!;
    const generation = owner.generation;
    const canonical = findTaskByRunId(owner.runId)!;
    const flow = createManagedTaskFlow({
      ownerKey: "agent:main:main",
      controllerId: "tests/publication",
      goal: "observe the native run",
    });
    expect(flow).not.toBeNull();
    const projected = runTaskInFlowForOwner({
      flowId: flow!.flowId,
      callerOwnerKey: "agent:main:main",
      runtime: "subagent",
      childSessionKey: rootKey,
      runId: owner.runId,
      task: "managed native projection",
      status: "running",
    });
    expect(projected.created, projected.reason).toBe(true);
    const managed = projected.task!;
    expect(managed.taskId).not.toBe(canonical.taskId);
    expect(managed.detail).toMatchObject({ taskId: canonical.taskId, generation });
    const selected = selectedKind === "canonical" ? canonical : managed;
    const peer = selectedKind === "canonical" ? managed : canonical;
    expect(markSubagentRunTerminated({ runId: owner.runId, reason: "killed" })).toBe(1);
    for (const task of [selected, peer]) {
      expect(getTaskById(task.taskId)).toMatchObject({
        status: "cancelled",
        error: SUBAGENT_KILL_TASK_ERROR,
      });
    }
    wait.resolve({ status: "ok", endedAt: Date.now() });
    await captureEntered.promise;
    expect(owner.killReconciliation).toBeDefined();
    const order: string[] = [];
    const store = getTaskRegistryStore();
    const upsert = store.upsertTaskWithDeliveryState!;
    let faults = 0;
    vi.spyOn(store, "upsertTaskWithDeliveryState").mockImplementation((params) => {
      if (
        params.task.taskId === selected.taskId &&
        params.task.status === "succeeded" &&
        faults === 0
      ) {
        faults += 1;
        order.push("selected write refused");
        throw new Error("one-shot selected task completion write failure");
      }
      upsert(params);
      if (
        params.task.taskId === selected.taskId &&
        params.task.error === "Cancelled by operator."
      ) {
        order.push("operator cancellation write");
      }
    });
    fixture.persist.mockImplementation((...runIds) => {
      persistSubagentRunsToDiskOrThrow(...runIds);
      if (
        owner.execution.outcome?.status === "ok" &&
        !order.includes("canonical completion committed")
      ) {
        order.push("canonical completion committed");
        expect(subagentRuns.get(owner.runId)).toBe(owner);
        expect(owner.generation).toBe(generation);
        expect(store.loadSnapshot().tasks.get(peer.taskId)?.status).toBe("succeeded");
      }
    });
    const resolveTargetState = killRuntime.resolveSubagentKillTargetState;
    const releaseCaptureAfterHandoff = (remaining: number): void => {
      if (remaining === 0) {
        order.push("capture released");
        capture.resolve("completed native reply");
      } else {
        queueMicrotask(() => releaseCaptureAfterHandoff(remaining - 1));
      }
    };
    const killRun = killRuntime.killSubagentRun;
    vi.spyOn(killRuntime, "killSubagentRun").mockImplementation((params) => {
      const pending = killRun(params);
      if (params.entry === owner) {
        // Let capture finish as the real kill promises unwind; assertions below
        // require the observed snapshot -> commit -> publication ordering.
        releaseCaptureAfterHandoff(5);
      }
      return pending;
    });
    vi.spyOn(killRuntime, "resolveSubagentKillTargetState").mockImplementation((entry) => {
      const result = resolveTargetState(entry);
      if (entry === owner) {
        order.push(`snapshot ${result?.state === "terminal" ? result.task.status : result?.state}`);
      }
      return result;
    });
    const admin = vi.fn(killSubagentRunAdmin);
    setTaskRegistryControlRuntimeForTests({ ...taskControlRuntime, killSubagentRunAdmin: admin });
    try {
      const result = await cancelTaskById({ cfg: getRuntimeConfig(), taskId: selected.taskId });
      order.push("caller result");
      expect(order, JSON.stringify(order)).toContain("canonical completion committed");
      expect(order).toContain("snapshot cancelled");
      expect(order.indexOf("snapshot cancelled")).toBeLessThan(
        order.indexOf("canonical completion committed"),
      );
      const published = await admin.mock.results[0]!.value;
      expect.soft(order, JSON.stringify(order)).not.toContain("operator cancellation write");
      expect.soft(result.cancelled, JSON.stringify(order)).toBe(false);
      expect.soft(published, JSON.stringify(order)).toMatchObject({
        found: true,
        killed: false,
        cascadeKilled: 0,
        targetState: { state: "terminal", task: { status: "succeeded" } },
      });
      expect(faults, JSON.stringify(order)).toBe(1);
      expect.soft(getTaskById(selected.taskId)?.status).toBe("succeeded");
      expect.soft(store.loadSnapshot().tasks.get(selected.taskId)?.status).toBe("succeeded");
      expect(owner.execution.outcome?.status).toBe("ok");
    } finally {
      capture.resolve("completed native reply");
      resetTaskRegistryControlRuntimeForTests();
    }
  },
);

it.each([
  {
    replace: true,
    priorChildKill: false,
    completeDuringDrain: false,
    handoff: false,
    provisional: false,
  },
  {
    replace: true,
    priorChildKill: true,
    completeDuringDrain: false,
    handoff: false,
    provisional: false,
  },
  {
    replace: false,
    priorChildKill: false,
    completeDuringDrain: false,
    handoff: false,
    provisional: false,
  },
  {
    replace: false,
    priorChildKill: false,
    completeDuringDrain: true,
    handoff: false,
    provisional: false,
  },
  {
    replace: true,
    priorChildKill: false,
    completeDuringDrain: true,
    handoff: false,
    provisional: false,
  },
  {
    replace: true,
    priorChildKill: false,
    completeDuringDrain: false,
    handoff: true,
    provisional: false,
  },
  {
    replace: true,
    priorChildKill: true,
    completeDuringDrain: false,
    handoff: true,
    provisional: false,
  },
  {
    replace: true,
    priorChildKill: true,
    completeDuringDrain: false,
    handoff: true,
    provisional: true,
  },
])(
  "fences task publication (replace=$replace, priorChildKill=$priorChildKill, completeDuringDrain=$completeDuringDrain, handoff=$handoff, provisional=$provisional)",
  async ({ replace, priorChildKill, completeDuringDrain, handoff, provisional }) => {
    testing.setDepsForTest({
      ...subagentRegistryDeps,
      cleanupBrowserSessionsForLifecycleEnd: async () => {},
      runSubagentAnnounceFlow: async () => "delivered",
    });
    const previousWait = createDeferred<AgentWaitResult>();
    const nextWait = createDeferred<AgentWaitResult>();
    vi.spyOn(subagentRegistryDeps, "callGateway").mockImplementation(async (request) => {
      expect(request.method).toBe("agent.wait");
      const runId = (request.params as { runId: string }).runId;
      expect(["publication-b0", "publication-b1"]).toContain(runId);
      return await (runId === "publication-b0" ? previousWait : nextWait).promise;
    });
    const storePath = await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey: rootKey,
      defaultSessionId: "publication-root-session",
      lifecycleRevision: "publication-root-revision",
    });
    registerSubagentRun({
      runId: "publication-b0",
      childSessionKey: rootKey,
      requesterSessionKey: "agent:main:main",
      requesterAgentId: "main",
      requesterDisplayKey: "main",
      task: "original task",
      cleanup: "keep",
      expectsCompletionMessage: true,
    });
    const b0 = subagentRuns.get("publication-b0")!;
    const task = findTaskByRunId(b0.runId)!;
    expect(b0.collect).not.toBe(true);
    expect(task.status).toBe("running");
    const taskStore = getTaskRegistryStore();
    const upsert = taskStore.upsertTaskWithDeliveryState;
    if (!upsert) {
      throw new Error("Expected the real SQLite composite task upsert");
    }
    const failedWrite = createDeferred();
    const successorCompleted = createDeferred();
    const originalCompleted = createDeferred();
    fixture.persist.mockImplementation((...runIds) => {
      persistSubagentRunsToDiskOrThrow(...runIds);
      if (b0.execution.outcome?.status === "ok") {
        originalCompleted.resolve();
      }
      if (subagentRuns.get("publication-b1")?.execution.outcome?.status === "ok") {
        successorCompleted.resolve();
      }
    });
    const handoffOrder: string[] = [];
    let failures = 0;
    let registryCommittedBeforeFailure = false;
    vi.spyOn(taskStore, "upsertTaskWithDeliveryState").mockImplementation((params) => {
      if (params.task.taskId === task.taskId && params.task.status === "failed" && failures === 0) {
        registryCommittedBeforeFailure =
          loadSubagentRegistryFromSqlite().get(b0.runId)?.execution.status === "terminal";
        failures += 1;
        failedWrite.resolve();
        throw new Error("one-shot terminal task persistence failure");
      }
      if (handoff && handoffOrder.includes("replacement") && params.task.status !== "running") {
        handoffOrder.push("task write");
      }
      upsert(params);
    });
    if (!completeDuringDrain && !provisional) {
      previousWait.resolve({ status: "error", error: "original run failed", endedAt: Date.now() });
      await failedWrite.promise;
      expect(registryCommittedBeforeFailure).toBe(true);
      expect(b0.execution.status).toBe("terminal");
      expect(b0.execution.outcome?.status).toBe("error");
      expect(getTaskById(task.taskId)?.status).toBe("running");
      expect(taskStore.loadSnapshot().tasks.get(task.taskId)?.status).toBe("running");
    }

    const children: Array<readonly [string, string]> = [
      ...(priorChildKill
        ? [["publication-first", "agent:main:subagent:publication-first"] as const]
        : []),
      ["publication-child", childKey],
    ];
    for (const [runId, sessionKey] of children) {
      await writeSubagentSessionEntry({
        stateDir: fixture.stateDir,
        agentId: "main",
        sessionKey,
        defaultSessionId: `${runId}-session`,
      });
      registerSubagentRun({
        runId,
        childSessionKey: sessionKey,
        requesterSessionKey: rootKey,
        requesterAgentId: "main",
        requesterDisplayKey: "main",
        task: runId,
        cleanup: "keep",
        collect: true,
        queued: true,
        expectsCompletionMessage: false,
      });
    }
    const entered = createDeferred();
    const childAdmission = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [childKey, "publication-child-session"],
      assertAllowed: () => {},
      onInterrupt: () => entered.resolve(),
    });
    const markerCleared = createDeferred();
    const releaseMarker = createDeferred();
    let markerWaits = 0;
    let followup: Awaited<ReturnType<typeof beginSessionWorkAdmission>> | undefined;
    const handoffComplete = createDeferred();
    const resolveTargetState = killRuntime.resolveSubagentKillTargetState;
    let observedTarget = false;
    vi.spyOn(killRuntime, "resolveSubagentKillTargetState").mockImplementation((entry) => {
      const result = resolveTargetState(entry);
      if (handoff && entry === b0 && !observedTarget) {
        observedTarget = true;
        expect(subagentRuns.get(b0.runId)).toBe(b0);
        handoffOrder.push("captured outcome");
        // Replace during the real awaited scope handoff, before synchronous publication.
        queueMicrotask(() => {
          if (!followup) {
            handoffComplete.reject(new Error("missing admitted follow-up"));
            return;
          }
          void followup
            .run(async () => {
              // This is the synchronous owner used by the lazy reactivation facade.
              expect(
                replaceSubagentRunAfterSteerCore({
                  previousRunId: b0.runId,
                  nextRunId: "publication-b1",
                  fallback: b0,
                  runTimeoutSeconds: b0.runTimeoutSeconds ?? 0,
                  task: "admitted follow-up task",
                }),
              ).toBe(true);
              handoffOrder.push("replacement");
              expect(subagentRuns.get("publication-b1")?.generation).not.toBe(b0.generation);
            })
            .then(handoffComplete.resolve, handoffComplete.reject);
        });
      }
      return result;
    });
    const persistMarker = killRuntime.persistSubagentAbortedLastRun;
    vi.spyOn(killRuntime, "persistSubagentAbortedLastRun").mockImplementation(async (params) => {
      const result = await persistMarker(params);
      if (
        completeDuringDrain &&
        replace &&
        params.childSessionKey === rootKey &&
        !params.abortedLastRun
      ) {
        markerWaits += 1;
        markerCleared.resolve();
        await releaseMarker.promise;
      }
      return result;
    });
    const admin = vi.fn(killSubagentRunAdmin);
    setTaskRegistryControlRuntimeForTests({ ...taskControlRuntime, killSubagentRunAdmin: admin });
    const pending = cancelTaskById({ cfg: getRuntimeConfig(), taskId: task.taskId });
    const followupInterrupted = vi.fn();
    try {
      await Promise.race([
        entered.promise,
        pending.then((result) => {
          throw new Error(`Cancellation never entered descendant drain: ${JSON.stringify(result)}`);
        }),
      ]);
      expect(getTaskById(task.taskId)?.status).toBe(
        completeDuringDrain || provisional ? "cancelled" : "running",
      );
      if (completeDuringDrain) {
        previousWait.resolve({
          status: "ok",
          endedAt: Date.now(),
          terminalReply: { disposition: "visible", text: "original completed during cancellation" },
        });
        await originalCompleted.promise;
        expect(getTaskById(task.taskId)?.status).toBe("succeeded");
        expect(b0.killReconciliation).toBeUndefined();
        childAdmission.release();
        if (replace) {
          await Promise.race([
            markerCleared.promise,
            pending.then((result) => {
              throw new Error(
                `Cancellation never reached marker cleanup: ${JSON.stringify(result)}`,
              );
            }),
          ]);
          expect(
            loadExactSessionEntryReadOnly({ storePath, sessionKey: rootKey })?.entry.abortedLastRun,
          ).toBe(false);
        }
      }
      if (priorChildKill) {
        expect(findTaskByRunId("publication-first")?.status).toBe("cancelled");
      }
      if (replace) {
        // The root lifecycle lock and any marker write have finished before follow-up admission.
        followup = await beginSessionWorkAdmission({
          scope: storePath,
          identities: [rootKey, "publication-root-session"],
          assertAllowed: () => {},
          onInterrupt: followupInterrupted,
        });
        if (!handoff) {
          expect(
            await followup.run(() =>
              reactivateCompletedSubagentSession({
                sessionKey: rootKey,
                runId: "publication-b1",
                task: "admitted follow-up task",
              }),
            ),
          ).toBe(true);
          const b1 = subagentRuns.get("publication-b1")!;
          expect(subagentRuns.has(b0.runId)).toBe(false);
          expect(b1).toMatchObject({ taskRunId: b0.taskRunId, execution: { status: "running" } });
          if (typeof b0.generation !== "number") {
            throw new Error("Registration did not mint a run generation");
          }
          expect(b1.generation).toBeGreaterThan(b0.generation);
          expect(getTaskById(task.taskId)).toMatchObject({
            runId: b0.taskRunId,
            status: completeDuringDrain ? "succeeded" : provisional ? "cancelled" : "running",
            detail: {
              kind: "task_backing_instance",
              runtime: "subagent",
              generation: b1.generation,
            },
          });
          expect(taskStore.loadSnapshot().tasks.get(task.taskId)?.detail).toEqual(
            getTaskById(task.taskId)?.detail,
          );
        }
      }
      if (!replace && !completeDuringDrain) {
        const beforeProgress = getTaskById(task.taskId)!;
        expect(
          updateTask(task.taskId, { progressSummary: "same owner made progress" }),
        ).toMatchObject({
          status: "running",
          progressSummary: "same owner made progress",
          detail: beforeProgress.detail,
        });
      }
      childAdmission.release();
      releaseMarker.resolve();
      const result = await pending;
      if (handoff) {
        expect(observedTarget, "admin resolved its root outcome").toBe(true);
        expect(handoffOrder, "admin captured its owner outcome").not.toEqual([]);
        await handoffComplete.promise;
        expect(handoffOrder.slice(0, 2)).toEqual(["captured outcome", "replacement"]);
        expect(getTaskById(task.taskId)?.detail).toMatchObject({
          generation: subagentRuns.get("publication-b1")?.generation,
        });
      }
      const published = await admin.mock.results[0]!.value;
      expect.soft(result.cancelled).toBe(false);
      expect(failures).toBe(completeDuringDrain || provisional ? 0 : 1);
      expect(markerWaits).toBe(completeDuringDrain && replace ? 1 : 0);
      if (!replace) {
        expect(result.task?.status).toBe(completeDuringDrain ? "succeeded" : "failed");
        expect(published).toMatchObject({
          found: true,
          targetState: {
            state: "terminal",
            task: { status: completeDuringDrain ? "succeeded" : "failed" },
          },
        });
        return;
      }
      if (!handoff) {
        expect.soft(published).not.toHaveProperty("targetState");
        expect.soft(published).toHaveProperty("error", expect.any(String));
      }
      expect.soft(handoffOrder).not.toContain("task write");
      expect
        .soft(result.task?.status)
        .toBe(completeDuringDrain ? "succeeded" : provisional ? "cancelled" : "running");
      expect
        .soft(getTaskById(task.taskId)?.status)
        .toBe(completeDuringDrain ? "succeeded" : provisional ? "cancelled" : "running");
      if (provisional) {
        expect.soft(getTaskById(task.taskId)?.error).toBe(SUBAGENT_KILL_TASK_ERROR);
      }
      expect(subagentRuns.get("publication-b1")?.execution.status).toBe("running");
      expect(followupInterrupted).not.toHaveBeenCalled();
      expect(published).toMatchObject({
        found: true,
        killed: priorChildKill || completeDuringDrain || handoff,
        cascadeKilled: Number(priorChildKill) + Number(completeDuringDrain || handoff),
      });
      nextWait.resolve({
        status: "ok",
        endedAt: Date.now(),
        terminalReply: { disposition: "visible", text: "follow-up completed" },
      });
      await successorCompleted.promise;
      expect(subagentRuns.get("publication-b1")?.execution.status).toBe("terminal");
      expect.soft(getTaskById(task.taskId)?.status).toBe("succeeded");
    } finally {
      releaseMarker.resolve();
      childAdmission.release();
      followup?.release();
      await pending;
      resetTaskRegistryControlRuntimeForTests();
      expect(getActiveSessionWorkAdmissionCount()).toBe(0);
      expect(getActiveSessionLifecycleMutationCount()).toBe(0);
    }
  },
);
