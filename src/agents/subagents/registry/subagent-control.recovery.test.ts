/** Recovery accepted during an earlier sibling's drain stays in the captured kill tree. */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
  getRuntimeConfig,
} from "../../../config/config.js";
import { loadSessionEntry } from "../../../config/sessions/session-accessor.js";
import { registerChatAbortController } from "../../../gateway/chat-abort.js";
import type { GatewayRecoveryRuntime } from "../../../gateway/server-instance-runtime.types.js";
import { registerPluginSubagentRunFromGateway } from "../../../gateway/server-methods/agent-task-tracking.js";
import { handleChatAbortRequest } from "../../../gateway/server-methods/chat-abort-handler.js";
import {
  createChatAbortContext,
  invokeChatAbortHandler,
} from "../../../gateway/server-methods/chat.abort.test-helpers.js";
import { sessionMutationHandlers } from "../../../gateway/server-methods/sessions-mutations.js";
import {
  registerAgentRunContext,
  clearAgentRunContext,
} from "../../../infra/agent-run-registry.js";
import * as sessionLifecycle from "../../../sessions/session-lifecycle-admission.js";
import { SUBAGENT_KILL_TASK_ERROR } from "../../../tasks/detached-task-runtime-contract.js";
import { getDetachedTaskLifecycleRuntime } from "../../../tasks/detached-task-runtime.js";
import { setDetachedTaskLifecycleRuntime } from "../../../tasks/detached-task-runtime.test-support.js";
import * as taskControlRuntime from "../../../tasks/task-registry-control.runtime.js";
import { cancelTaskById, findTaskByRunId, getTaskById } from "../../../tasks/task-registry.js";
import {
  resetTaskRegistryControlRuntimeForTests,
  setTaskRegistryControlRuntimeForTests,
} from "../../../tasks/task-registry.test-support.js";
import { clearActiveEmbeddedRun, setActiveEmbeddedRun } from "../../embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../../embedded-agent-runner/runs.test-support.js";
import type { AgentWaitResult } from "../../run-wait.js";
import { resolveStoredSubagentCapabilities } from "../spawn/subagent-capabilities.js";
import { enqueueSwarmRun, releaseSwarmRun } from "../swarm/swarm-scheduler.js";
import { killAllControlledSubagentRuns, killSubagentRunAdmin } from "./subagent-control.js";
import { useSubagentControlFixture } from "./subagent-control.test-support.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "./subagent-lifecycle-events.js";
import { subagentRegistryDeps } from "./subagent-registry-deps.js";
import { PROVISIONAL_KILL_RECONCILIATION_MS } from "./subagent-registry-helpers.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { getLatestLiveSubagentRunByChildSessionKey } from "./subagent-registry-read.js";
import { persistSubagentRunsToDiskOrThrow } from "./subagent-registry-state.js";
import {
  activateSubagentRegistry,
  markSubagentRunTerminated,
  registerSubagentRun,
  replaceSubagentRunAfterSteerCore,
} from "./subagent-registry.js";
import { writeSubagentSessionEntry } from "./subagent-registry.persistence.test-support.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry.store.sqlite.js";
import { releaseSubagentRun, testing } from "./subagent-registry.test-helpers.js";

const fixture = useSubagentControlFixture();

it("does not promote a provisional task when replacement wins before admin admission", async () => {
  testing.setDepsForTest({
    ...subagentRegistryDeps,
    cleanupBrowserSessionsForLifecycleEnd: async () => {},
    runSubagentAnnounceFlow: async () => "delivered",
  });
  const nextWait = createDeferred<AgentWaitResult>();
  vi.spyOn(subagentRegistryDeps, "callGateway").mockImplementation(async (request) => {
    expect(request.method).toBe("agent.wait");
    return (request.params as { runId: string }).runId === "admission-b1"
      ? await nextWait.promise
      : await new Promise<never>(() => {});
  });
  const sessionKey = "agent:main:subagent:publication-admission";
  const storePath = await writeSubagentSessionEntry({
    stateDir: fixture.stateDir,
    agentId: "main",
    sessionKey,
    defaultSessionId: "publication-admission-session",
  });
  registerSubagentRun({
    runId: "admission-b0",
    childSessionKey: sessionKey,
    requesterSessionKey: "agent:main:main",
    requesterAgentId: "main",
    requesterDisplayKey: "main",
    task: "original task",
    cleanup: "keep",
    expectsCompletionMessage: true,
  });
  const b0 = subagentRuns.get("admission-b0")!;
  const task = findTaskByRunId(b0.runId)!;
  expect(markSubagentRunTerminated({ runId: b0.runId, reason: "killed" })).toBe(1);
  expect(getTaskById(task.taskId)).toMatchObject({
    status: "cancelled",
    error: SUBAGENT_KILL_TASK_ERROR,
  });
  const completed = createDeferred();
  fixture.persist.mockImplementation((...runIds) => {
    persistSubagentRunsToDiskOrThrow(...runIds);
    if (subagentRuns.get("admission-b1")?.execution.outcome?.status === "ok") {
      completed.resolve();
    }
  });
  const followup = await sessionLifecycle.beginSessionWorkAdmission({
    scope: storePath,
    identities: [sessionKey, "publication-admission-session"],
    assertAllowed: () => {},
    onInterrupt: () => {},
  });
  const admin = vi.fn(killSubagentRunAdmin);
  setTaskRegistryControlRuntimeForTests({ ...taskControlRuntime, killSubagentRunAdmin: admin });
  const pending = cancelTaskById({ cfg: getRuntimeConfig(), taskId: task.taskId });
  try {
    expect(admin).not.toHaveBeenCalled();
    // The existing lazy-runtime await leaves admission open before admin captures a run.
    await followup.run(async () => {
      expect(
        replaceSubagentRunAfterSteerCore({
          previousRunId: b0.runId,
          nextRunId: "admission-b1",
          fallback: b0,
          runTimeoutSeconds: 0,
          task: "admitted follow-up",
        }),
      ).toBe(true);
      expect(admin).not.toHaveBeenCalled();
      expect(getTaskById(task.taskId)?.detail).toMatchObject({
        generation: subagentRuns.get("admission-b1")?.generation,
      });
    });
    const result = await pending;
    expect(await admin.mock.results[0]!.value).toEqual({ found: false, killed: false });
    expect.soft(result.cancelled).toBe(false);
    expect.soft(getTaskById(task.taskId)?.error).toBe(SUBAGENT_KILL_TASK_ERROR);
    nextWait.resolve({
      status: "ok",
      endedAt: Date.now(),
      terminalReply: { disposition: "visible", text: "follow-up completed" },
    });
    await completed.promise;
    expect.soft(getTaskById(task.taskId)?.status).toBe("succeeded");
  } finally {
    followup.release();
    await pending;
    resetTaskRegistryControlRuntimeForTests();
  }
});

it.each(
  (["bulk", "admin"] as const).flatMap((boundary) =>
    (
      [
        "recovery",
        "recovery aborted",
        "recovery retired",
        "replacement",
        "replacement retired",
        "replacement released",
        "registration rollback",
        "required-task rollback",
        "reset",
      ] as const
    )
      .filter((scenario) => scenario !== "recovery retired" || boundary === "bulk")
      .map((scenario) => ({ boundary, scenario })),
  ),
)(
  "$boundary resolves accepted recovery after an earlier sibling drains (scenario=$scenario)",
  async ({ boundary, scenario }) => {
    await writeFile(
      path.join(fixture.stateDir, "openclaw.json"),
      JSON.stringify({
        agents: { defaults: { workspace: fixture.stateDir, subagents: { maxSpawnDepth: 3 } } },
        tools: { swarm: { enabled: true } },
      }),
    );
    clearConfigCache();
    clearRuntimeConfigSnapshot();
    const retiredRecovery = scenario === "recovery retired";
    const abortedRecovery = retiredRecovery || scenario === "recovery aborted";
    const controllerSessionKey = retiredRecovery
      ? "agent:main:cron:recovery-owner:run:scheduled-turn"
      : "agent:main:main";
    const parentKey = "agent:main:subagent:parent";
    const aKey = "agent:main:subagent:earlier";
    const bKey = "agent:main:subagent:recovering";
    const childKey = "agent:main:subagent:queued-descendant";
    const owner = boundary === "bulk" ? controllerSessionKey : parentKey;
    const ordinaryFollowup =
      scenario === "replacement retired" || scenario === "replacement released";
    let storePath = "";
    for (const [runId, childSessionKey, requesterSessionKey, collect, queued] of [
      ["parent", parentKey, controllerSessionKey, false, false],
      ["a", aKey, owner, false, false],
      // Ordinary Gateway follow-ups do not target reserved collector sessions.
      ["b", bKey, owner, !ordinaryFollowup && !abortedRecovery, false],
      ["child", childKey, bKey, true, true],
    ] as const) {
      storePath = await writeSubagentSessionEntry({
        stateDir: fixture.stateDir,
        agentId: "main",
        sessionKey: childSessionKey,
        defaultSessionId: `${runId}-session`,
        lifecycleRevision: `${runId}-revision`,
        // An unended row with no active context and an abort marker is a real
        // sweeper recovery source; the producer must mint/consume its own receipt.
        abortedLastRun: runId === "b",
      });
      registerSubagentRun({
        runId,
        childSessionKey,
        requesterSessionKey,
        controllerSessionKey: requesterSessionKey,
        requesterAgentId: "main",
        requesterDisplayKey: requesterSessionKey,
        task: runId,
        cleanup: "keep",
        expectsCompletionMessage: false,
        collect,
        queued,
      });
    }
    const a = subagentRuns.get("a")!;
    const b = subagentRuns.get("b")!;
    const parent = subagentRuns.get("parent")!;
    const child = subagentRuns.get("child")!;
    registerAgentRunContext("a", { sessionKey: aKey, sessionId: "a-session" });
    registerAgentRunContext("parent", { sessionKey: parentKey, sessionId: "parent-session" });
    const entered = createDeferred();
    const resume = createDeferred();
    const admission = await sessionLifecycle.beginSessionWorkAdmission({
      scope: storePath,
      identities: [aKey, "a-session"],
      assertAllowed: () => {},
      onInterrupt: () => admission.release(),
    });
    const interruptAdmissions = sessionLifecycle.interruptSessionWorkAdmissions;
    const drain = vi
      .spyOn(sessionLifecycle, "interruptSessionWorkAdmissions")
      .mockImplementation(async (params) => {
        const released = await interruptAdmissions(params);
        if (params.scope === storePath && Array.from(params.identities).includes(aKey)) {
          expect(released).toBe(true);
          // Recovery/reset runs after the real drain but before cancellation
          // effects, without holding an admission across its bounded deadline.
          entered.resolve();
          await resume.promise;
        }
        return released;
      });
    const dispatchChild = vi.fn(async () => {});
    enqueueSwarmRun({
      groupId: "recovery-lane",
      runId: "child",
      maxConcurrent: 1,
      activeRunIds: ["a"],
      start: dispatchChild,
      onStartFailure: () => true,
    });
    const abortA = vi.fn(() => {
      expect(releaseSwarmRun("a")).toBe(!abortedRecovery);
    });
    const handleA = createEmbeddedRunHandle({ runId: "a", abort: abortA });
    setActiveEmbeddedRun("a-session", handleA, aKey);
    const controller = {
      controllerSessionKey,
      controllerAgentId: "main",
      callerSessionKey: controllerSessionKey,
      callerIsSubagent: false,
      controlScope: "children" as const,
    };
    const cfg = getRuntimeConfig();
    const pending =
      boundary === "bulk"
        ? killAllControlledSubagentRuns({ cfg, controller, runs: [a, b] })
        : killSubagentRunAdmin({
            cfg,
            sessionKey: parentKey,
            expectedRunId: parent.runId,
            expectedGeneration: parent.generation,
            expectedOwnerKey: controllerSessionKey,
          });
    let acceptedRunId: string | undefined;
    const interruptedFresh = vi.fn();
    const abortFresh = vi.fn();
    const freshHandle = createEmbeddedRunHandle({ runId: "fresh-turn", abort: abortFresh });
    const dispatchFresh = vi.fn(async () => {});
    let freshAdmission:
      | Awaited<ReturnType<typeof sessionLifecycle.beginSessionWorkAdmission>>
      | undefined;
    try {
      await Promise.race([
        entered.promise,
        pending.then((result) => {
          throw new Error(
            `Stop completed before the sibling admission drain: ${JSON.stringify(result)}`,
          );
        }),
      ]);
      expect(sessionLifecycle.isSessionWorkAdmissionActive(storePath, [aKey])).toBe(false);
      expect(a.killIntent).toBeUndefined();
      expect(b.killIntent).toBeUndefined();
      const dispatchRecovery = vi.fn(
        async (payload: Parameters<GatewayRecoveryRuntime["dispatchAgent"]>[0]) => {
          expect(payload.sessionKey).toBe(bKey);
          const lease = sessionLifecycle.consumeSessionWorkAdmissionHandoff({
            handoffId: String(payload.internalRuntimeHandoffId),
            scope: storePath,
            identities: [bKey, "b-session"],
            onInterrupt: () => {},
          });
          expect(lease, "actual recovery admission consumed").toBeDefined();
          try {
            acceptedRunId = payload.idempotencyKey;
            registerAgentRunContext(acceptedRunId, { sessionKey: bKey, sessionId: "b-session" });
            return { runId: payload.idempotencyKey, status: "accepted" };
          } finally {
            lease?.release();
          }
        },
      );
      const recoveryRuntime: GatewayRecoveryRuntime = {
        dispatchAgent: dispatchRecovery as GatewayRecoveryRuntime["dispatchAgent"],
        waitForAgent: async () => await new Promise<never>(() => {}),
        abortAgent: async () => {
          throw new Error("unexpected recovery abort");
        },
        sendRecoveryNotice: async () => {
          throw new Error("unexpected recovery notice");
        },
      };
      activateSubagentRegistry(() => ({ recoveryRuntime }) as never);
      await testing.sweepOnceForTests();
      expect(dispatchRecovery).toHaveBeenCalledOnce();
      const receipt = b.execution.restartRecovery!;
      expect(receipt).toMatchObject({ phase: "accepted", sessionId: "b-session" });
      const successor = subagentRuns.get(receipt.idempotencyKey)!;
      expect(successor).toBeDefined();
      expect(successor).not.toBe(b);
      expect(subagentRuns.has("b")).toBe(false);
      expect(
        successor.execution.restartRecovery,
        "settled successor retires receipt",
      ).toBeUndefined();
      expect(loadSubagentRegistryFromSqlite().get(successor.runId)).toMatchObject({
        generation: successor.generation,
        execution: { status: "running" },
      });
      expect(loadSessionEntry({ storePath, sessionKey: bKey })).toMatchObject({
        sessionId: "b-session",
        lifecycleRevision: "b-revision",
        abortedLastRun: false,
        subagentRecovery: { lastRunId: successor.runId, automaticAttempts: 1 },
      });
      const successorTask = findTaskByRunId(successor.taskRunId ?? successor.runId)!;
      expect(successorTask?.status).toBe("running");
      if (abortedRecovery) {
        // Free capacity while the original Stop owns C's reservation, before B1 ends.
        expect(releaseSwarmRun("a")).toBe(true);
        await Promise.resolve();
        expect(dispatchChild).not.toHaveBeenCalled();
        const context = createChatAbortContext({ getRuntimeConfig });
        const registration = registerChatAbortController({
          chatAbortControllers: context.chatAbortControllers,
          runId: successor.runId,
          sessionId: "b-session",
          sessionKey: bKey,
          timeoutMs: 30_000,
        });
        try {
          const response = await invokeChatAbortHandler({
            handler: handleChatAbortRequest,
            context,
            request: { sessionKey: bKey },
            client: { connect: { scopes: ["operator.admin"] } },
          });
          expect(response).toHaveBeenCalledWith(true, {
            ok: true,
            aborted: true,
            runIds: [successor.runId],
          });
          expect(registration.controller.signal.aborted).toBe(true);
          await vi.waitFor(() => {
            expect(successor.killReconciliation).toBeDefined();
            expect(getTaskById(successorTask.taskId)?.status).toBe("cancelled");
          });
          const clock = vi
            .spyOn(Date, "now")
            .mockReturnValue(
              successor.killReconciliation!.killedAt + PROVISIONAL_KILL_RECONCILIATION_MS,
            );
          try {
            await testing.sweepOnceForTests();
            await vi.waitFor(() => {
              expect(successor.killReconciliation).toBeUndefined();
              if (retiredRecovery) {
                expect(subagentRuns.has(successor.runId)).toBe(false);
              } else {
                expect(successor.requesterSettleWake?.retireAfterSettle).toBe(true);
              }
            });
          } finally {
            clock.mockRestore();
          }
          expect(loadSubagentRegistryFromSqlite().has(successor.runId)).toBe(!retiredRecovery);
          expect(loadSessionEntry({ storePath, sessionKey: bKey })).toMatchObject({
            sessionId: "b-session",
            lifecycleRevision: "b-revision",
          });
          expect(child.killIntent).toBeUndefined();
          expect(findTaskByRunId("child")?.status).toBe("queued");
          expect(dispatchChild).not.toHaveBeenCalled();
        } finally {
          registration.cleanup();
        }
      }
      const displaced = scenario.startsWith("replacement");
      if (displaced || scenario.endsWith("rollback")) {
        const taskRuntime = getDetachedTaskLifecycleRuntime();
        if (scenario === "registration rollback") {
          fixture.persist.mockImplementation((runs, ids) => {
            if (runs.has("unrelated")) {
              throw new Error("registration write rejected");
            }
            persistSubagentRunsToDiskOrThrow(runs, ids);
          });
        } else if (scenario === "required-task rollback") {
          setDetachedTaskLifecycleRuntime({
            ...taskRuntime,
            createQueuedTaskRun: () => {
              expect(loadSubagentRegistryFromSqlite().has("unrelated")).toBe(true);
              throw new Error("required task rejected");
            },
          });
        }
        const register = () =>
          registerSubagentRun({
            runId: "unrelated",
            childSessionKey: bKey,
            requesterSessionKey: owner,
            controllerSessionKey: owner,
            requesterAgentId: "main",
            requesterDisplayKey: owner,
            task: "new independent owner",
            cleanup: "keep",
            expectsCompletionMessage: false,
            collect: scenario === "replacement",
            queued: true,
            taskRowOwnership: "required",
          });
        try {
          if (displaced) {
            if (ordinaryFollowup) {
              await registerPluginSubagentRunFromGateway({
                cfg,
                runId: "unrelated",
                childSessionKey: bKey,
                task: "new independent owner",
              });
              expect(findTaskByRunId("unrelated")?.status).toBe("running");
            } else {
              register();
            }
            expect(getLatestLiveSubagentRunByChildSessionKey(bKey)).toBe(
              subagentRuns.get("unrelated"),
            );
            expect(loadSubagentRegistryFromSqlite().has("unrelated")).toBe(true);
          } else {
            expect(register).toThrow(/rejected/);
          }
        } finally {
          fixture.persist.mockImplementation(persistSubagentRunsToDiskOrThrow);
          setDetachedTaskLifecycleRuntime(taskRuntime);
        }
        if (scenario === "replacement retired") {
          expect(
            markSubagentRunTerminated({ runId: "unrelated", suppressTaskDelivery: true }),
          ).toBe(1);
          const killedAt = subagentRuns.get("unrelated")!.killReconciliation!.killedAt;
          const clock = vi
            .spyOn(Date, "now")
            .mockReturnValue(killedAt + PROVISIONAL_KILL_RECONCILIATION_MS);
          try {
            await testing.sweepOnceForTests();
            await vi.waitFor(() => expect(subagentRuns.has("unrelated")).toBe(false));
          } finally {
            clock.mockRestore();
          }
        } else if (scenario === "replacement released") {
          releaseSubagentRun("unrelated");
        }
        if (scenario !== "replacement") {
          expect(subagentRuns.has("unrelated")).toBe(false);
          expect(loadSubagentRegistryFromSqlite().has("unrelated")).toBe(false);
          expect(getLatestLiveSubagentRunByChildSessionKey(bKey)).toBe(successor);
        }
        expect(subagentRuns.get(successor.runId)).toBe(successor);
        expect(successor.execution.endedAt).toBeUndefined();
        expect(child.killIntent).toBeUndefined();
        expect(findTaskByRunId("child")?.status).toBe("queued");
        expect(loadSessionEntry({ storePath, sessionKey: bKey })).toMatchObject({
          sessionId: "b-session",
          lifecycleRevision: "b-revision",
        });
      }
      if (scenario === "reset") {
        const respond = vi.fn();
        await sessionMutationHandlers["sessions.reset"]!({
          params: { key: bKey },
          context: createChatAbortContext({
            getRuntimeConfig,
            getSessionEventSubscriberConnIds: () => new Set(),
          }) as never,
          respond,
          client: { connect: { scopes: ["operator.admin"] } } as never,
          req: { type: "req", id: "reset", method: "sessions.reset" } as never,
          isWebchatConnect: () => false,
        });
        expect(respond).toHaveBeenCalledWith(
          true,
          expect.objectContaining({ ok: true }),
          undefined,
        );
        const reset = loadSessionEntry({ storePath, sessionKey: bKey });
        expect(reset?.sessionId).toBe("b-session");
        expect(reset?.lifecycleRevision).toBeDefined();
        expect(reset?.lifecycleRevision).not.toBe("b-revision");
        expect(subagentRuns.get(successor.runId)).toBe(successor);
        expect(successor.execution.status).toBe("running");
        // Reset stops the old child itself. New work starts only after that real boundary.
        expect(findTaskByRunId("child")?.status).toBe("cancelled");
        expect(resolveStoredSubagentCapabilities(bKey, { cfg }).canSpawn).toBe(true);
        freshAdmission = await sessionLifecycle.beginSessionWorkAdmission({
          scope: storePath,
          identities: [bKey, "b-session"],
          assertAllowed: () => {},
          onInterrupt: () => {
            interruptedFresh();
            freshAdmission?.release();
          },
        });
        setActiveEmbeddedRun("b-session", freshHandle, bKey);
        await freshAdmission.run(async () => {
          registerSubagentRun({
            runId: "fresh-child",
            childSessionKey: "agent:main:subagent:fresh-child",
            requesterSessionKey: bKey,
            requesterAgentId: "main",
            requesterDisplayKey: bKey,
            requesterTurnRunId: "fresh-turn",
            task: "new incarnation child",
            cleanup: "keep",
            collect: true,
            queued: true,
            expectsCompletionMessage: false,
          });
          enqueueSwarmRun({
            groupId: "fresh-lane",
            runId: "fresh-child",
            maxConcurrent: 1,
            activeRunIds: ["fresh-capacity"],
            start: dispatchFresh,
            onStartFailure: () => true,
          });
        });
      }
      expect(dispatchChild).not.toHaveBeenCalled();
      resume.resolve();
      const result = await pending;
      expect(abortA, JSON.stringify(result)).toHaveBeenCalledOnce();
      expect(a.endedReason, JSON.stringify(result)).toBe(SUBAGENT_ENDED_REASON_KILLED);
      if (displaced) {
        expect.soft(successor.killIntent).toBeUndefined();
        expect.soft(successor.execution.endedAt).toBeUndefined();
        expect.soft(successor.collectorCompletion).toBeUndefined();
        expect.soft(getTaskById(successorTask.taskId)?.status).toBe("running");
        if (scenario === "replacement") {
          expect(subagentRuns.get("unrelated")?.execution.status).toBe("queued");
        }
        expect.soft(child.killIntent).toBeUndefined();
        expect.soft(findTaskByRunId("child")?.status).toBe("queued");
        await expect
          .soft(
            vi.waitFor(() => {
              expect(dispatchChild).toHaveBeenCalledOnce();
            }),
          )
          .resolves.toBeUndefined();
        expect
          .soft(result)
          .toMatchObject(
            boundary === "bulk"
              ? { status: "ok", killed: 1 }
              : { found: true, killed: true, cascadeKilled: 1 },
          );
      } else if (scenario === "reset") {
        expect.soft(interruptedFresh, JSON.stringify(result)).not.toHaveBeenCalled();
        expect.soft(abortFresh).not.toHaveBeenCalled();
        expect.soft(successor.killIntent).toBeUndefined();
        expect.soft(successor.execution.status).toBe("running");
        expect.soft(findTaskByRunId("fresh-child")?.status).toBe("queued");
        expect.soft(subagentRuns.get("fresh-child")?.killIntent).toBeUndefined();
        releaseSwarmRun("fresh-capacity");
        await vi.waitFor(() => expect(dispatchFresh).toHaveBeenCalledOnce());
      } else {
        expect
          .soft(successor.endedReason, JSON.stringify(result))
          .toBe(SUBAGENT_ENDED_REASON_KILLED);
        expect.soft(child.collectorCompletion?.status).toBe("killed");
        expect.soft(findTaskByRunId("child")?.status).toBe("cancelled");
        expect.soft(dispatchChild).not.toHaveBeenCalled();
        expect
          .soft(result)
          .toMatchObject(
            boundary === "bulk"
              ? { status: "ok", killed: abortedRecovery ? 2 : 3 }
              : { found: true, killed: true, cascadeKilled: abortedRecovery ? 2 : 3 },
          );
      }
    } finally {
      freshAdmission?.release();
      resume.resolve();
      admission.release();
      try {
        await pending;
      } finally {
        drain.mockRestore();
        releaseSwarmRun("a");
        releaseSwarmRun("child");
        releaseSwarmRun("fresh-capacity");
        releaseSwarmRun("fresh-child");
        clearActiveEmbeddedRun("b-session", freshHandle, bKey);
        clearActiveEmbeddedRun("a-session", handleA, aKey);
        clearAgentRunContext("a");
        clearAgentRunContext("parent");
        if (acceptedRunId) {
          clearAgentRunContext(acceptedRunId);
        }
      }
    }
  },
);
