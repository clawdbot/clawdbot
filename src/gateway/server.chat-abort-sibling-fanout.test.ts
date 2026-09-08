import path from "node:path";
import { expect, test, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import type { AgentCommandOpts } from "../agents/command/types.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { registerSubagentRun } from "../agents/subagents/registry/subagent-registry.js";
import {
  settleSubagentRegistryPersistenceWork,
  writeSubagentSessionEntry,
} from "../agents/subagents/registry/subagent-registry.persistence.test-support.js";
import { loadSubagentRunsForControllerFromSqlite } from "../agents/subagents/registry/subagent-registry.store.sqlite.js";
import { resetSubagentRegistryForTests } from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import {
  activateSwarmRun,
  isSwarmRunActive,
  isSwarmRunWaitingForCapacity,
  ownsSwarmRunReservation,
  releaseSwarmRun,
  removeQueuedSwarmRun,
  reserveSwarmRun,
} from "../agents/subagents/swarm/swarm-scheduler.js";
import { testing as schedulerTesting } from "../agents/subagents/swarm/swarm-scheduler.test-support.js";
import {
  beginSessionWorkAdmission,
  getActiveSessionLifecycleMutationCount,
  getActiveSessionWorkAdmissionCount,
  type SessionWorkAdmissionLease,
} from "../sessions/session-lifecycle-admission.js";
import { SUBAGENT_KILL_TASK_ERROR } from "../tasks/detached-task-runtime-contract.js";
import { loadTaskRegistryStateFromSqliteReadOnlyResult } from "../tasks/task-registry.store.sqlite.js";
import {
  agentCommandMock,
  connectOk,
  createGatewaySuiteHarness,
  installGatewayTestHooks,
  onceMessage,
  rpcReq,
  testState,
  writeSessionStore,
} from "./test-helpers.js";

let gateway: Awaited<ReturnType<typeof createGatewaySuiteHarness>>;
installGatewayTestHooks({
  scope: "suite",
  setup: async () => {
    gateway = await createGatewaySuiteHarness();
  },
  cleanup: async () => {
    await runQaGatewayFixture(
      async () => gateway?.close(),
      async () => {
        await settleSubagentRegistryPersistenceWork();
        resetSubagentRegistryForTests({ persist: false });
        schedulerTesting.reset();
      },
    );
  },
});

await import("./server.js");

test.each([false, true])(
  "chat.abort interrupts all siblings before cleanup and preserves failure accounting (fault=%s)",
  async (fault) => {
    const suffix = fault ? "fault" : "success";
    const parentRunId = `parent-${suffix}`;
    const parentKey = `agent:main:sibling-abort-${suffix}`;
    const groupId = `sibling-abort-${suffix}`;
    const running = Array.from({ length: 8 }, (_, index) => `running-${suffix}-${index}`);
    const queued = [`queued-${suffix}-0`, `queued-${suffix}-1`];
    const selected = [...running, ...queued];
    const failedRunId = fault ? running[3] : undefined;
    const sessionKey = (runId: string) => `agent:main:subagent:${runId}`;
    const stateDir = process.env.OPENCLAW_STATE_DIR!;
    const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    testState.sessionStorePath = storePath;
    await writeSessionStore({
      entries: { [parentKey]: { sessionId: `parent-session-${suffix}`, updatedAt: Date.now() } },
    });

    const socket = await gateway.openWs();
    const parentStarted = createDeferred<AgentCommandOpts>();
    const parentFinish = createDeferred();
    const leases: SessionWorkAdmissionLease[] = [];
    const interrupted: string[] = [];
    const firstInterrupted = createDeferred();
    const slotReleaseResults: boolean[] = [];
    const start = vi.fn(async () => {});
    let parentRequestId: string | undefined;
    let abortResponse: ReturnType<typeof rpcReq> | undefined;
    let abortOutcome:
      | Promise<
          { ok: true; response: Awaited<ReturnType<typeof rpcReq>> } | { ok: false; error: unknown }
        >
      | undefined;
    let responseSettled = false;

    await runQaGatewayFixture(
      async () => {
        await connectOk(socket, {
          scopes: ["operator.read", "operator.write"],
          prePairDevice: true,
        });
        agentCommandMock.mockImplementationOnce(async (input) => {
          const command = input as AgentCommandOpts;
          expect(command.abortSignal).toBeInstanceOf(AbortSignal);
          command.onExecutionStarted?.();
          parentStarted.resolve(command);
          await parentFinish.promise;
          command.abortSignal!.throwIfAborted();
        });
        const accepted = await rpcReq(socket, "agent", {
          sessionKey: parentKey,
          message: "Keep this synthetic parent active until Stop",
          idempotencyKey: parentRunId,
        });
        parentRequestId = accepted.id;
        expect(accepted).toMatchObject({
          ok: true,
          payload: { runId: parentRunId, status: "accepted" },
        });
        await expect.poll(() => agentCommandMock.mock.calls.length, { timeout: 2_000 }).toBe(1);
        const parent = await parentStarted.promise;

        for (const runId of selected) {
          await writeSubagentSessionEntry({
            stateDir,
            agentId: "main",
            sessionKey: sessionKey(runId),
            defaultSessionId: `${runId}-session`,
          });
          if (queued.includes(runId)) {
            expect(
              reserveSwarmRun({ groupId, runId, maxConcurrent: 8, activeRunIds: running }),
            ).toBe(true);
          }
          registerSubagentRun({
            runId,
            childSessionKey: sessionKey(runId),
            requesterSessionKey: parentKey,
            requesterAgentId: "main",
            requesterTurnRunId: parentRunId,
            requesterDisplayKey: parentKey,
            task: runId,
            cleanup: "keep",
            collect: true,
            groupId,
            queued: queued.includes(runId),
            expectsCompletionMessage: false,
            taskRowOwnership: "required",
          });
          if (queued.includes(runId)) {
            activateSwarmRun({ groupId, runId, start, onStartFailure: () => true });
          }
        }
        for (const runId of running) {
          expect(isSwarmRunActive(runId)).toBe(true);
          leases.push(
            await beginSessionWorkAdmission({
              scope: storePath,
              identities: [sessionKey(runId), `${runId}-session`],
              assertAllowed: () => {},
              onInterrupt: () => {
                interrupted.push(runId);
                firstInterrupted.resolve();
                slotReleaseResults.push(releaseSwarmRun(runId));
                if (runId === failedRunId) {
                  throw new Error("synthetic sibling interruption failure");
                }
              },
            }),
          );
        }
        for (const runId of queued) {
          expect(isSwarmRunWaitingForCapacity(runId, subagentRuns.get(runId)!)).toBe(true);
        }
        const activeAdmissionCount = getActiveSessionWorkAdmissionCount();
        expect(activeAdmissionCount).toBeGreaterThanOrEqual(running.length);
        expect(start).not.toHaveBeenCalled();

        abortResponse = rpcReq(socket, "chat.abort", {
          sessionKey: parentKey,
          agentId: "main",
          runId: parentRunId,
        });
        abortOutcome = abortResponse.then(
          (response) => {
            responseSettled = true;
            return { ok: true as const, response };
          },
          (error: unknown) => {
            responseSettled = true;
            return { ok: false as const, error };
          },
        );
        await Promise.race([
          firstInterrupted.promise,
          abortOutcome.then(() => {
            throw new Error("chat.abort completed before interrupting its children");
          }),
        ]);
        // No child may make sibling interruption wait for this fixture-owned cleanup.
        await expect.poll(() => interrupted.toSorted(), { timeout: 2_000 }).toEqual(running);
        expect(parent.abortSignal!.aborted).toBe(true);
        expect(slotReleaseResults).toEqual(running.map(() => true));
        expect(leases.every((lease) => lease.isActive())).toBe(true);
        expect(getActiveSessionWorkAdmissionCount()).toBe(activeAdmissionCount);
        expect(responseSettled).toBe(false);
        expect(start).not.toHaveBeenCalled();
        for (const lease of leases.toReversed()) {
          lease.release();
        }
        const outcome = await abortOutcome;
        if (!outcome.ok) {
          throw outcome.error;
        }
        if (fault) {
          expect(outcome.response).toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
          expect(outcome.response.error?.message).toContain(
            "synthetic sibling interruption failure",
          );
        } else {
          expect(outcome.response).toMatchObject({
            ok: true,
            payload: { ok: true, aborted: true, runIds: [parentRunId] },
          });
        }

        const persistedRuns = new Map(
          loadSubagentRunsForControllerFromSqlite(parentKey).map((run) => [run.runId, run]),
        );
        const persistedTasks = loadTaskRegistryStateFromSqliteReadOnlyResult();
        expect(persistedTasks.state).toBe("ready");
        const tasks = [...persistedTasks.snapshot.tasks.values()].filter((task) =>
          selected.includes(task.runId ?? ""),
        );
        expect(tasks).toHaveLength(selected.length);
        expect(tasks.map((task) => task.runId)).toEqual(expect.arrayContaining(selected));
        expect([...persistedRuns.keys()].toSorted()).toEqual(selected.toSorted());
        for (const runId of selected) {
          const task = tasks.find((candidate) => candidate.runId === runId)!;
          const run = persistedRuns.get(runId)!;
          if (runId === failedRunId) {
            expect(task.status).toBe("running");
            expect(run.execution.status).toBe("running");
            expect(run.execution.endedAt).toBeUndefined();
          } else {
            expect(task).toMatchObject({ status: "cancelled", error: SUBAGENT_KILL_TASK_ERROR });
            expect(run).toMatchObject({
              endedReason: "subagent-killed",
              execution: { status: "terminal" },
            });
          }
          if (queued.includes(runId)) {
            expect(run.execution.startedAt).toBeUndefined();
            expect(ownsSwarmRunReservation(runId, subagentRuns.get(runId)!)).toBe(false);
          }
        }
        expect(start).not.toHaveBeenCalled();
      },
      async () => {
        // Cleanup is unconditional, including the expected pre-fix fanout assertion failure.
        for (const lease of leases) {
          lease.release();
        }
        const outcome = await abortOutcome;
        if (outcome && !outcome.ok) {
          throw outcome.error;
        }
      },
      async () => {
        const terminal = parentRequestId
          ? onceMessage(
              socket,
              (frame) =>
                frame.type === "res" &&
                frame.id === parentRequestId &&
                frame.payload?.status !== "accepted",
            )
          : undefined;
        parentFinish.resolve();
        await terminal;
      },
      () => {
        for (const runId of selected) {
          removeQueuedSwarmRun(runId);
          releaseSwarmRun(runId);
        }
        socket.close();
        expect(getActiveSessionLifecycleMutationCount()).toBe(0);
        expect(getActiveSessionWorkAdmissionCount()).toBe(0);
      },
    );
  },
);
