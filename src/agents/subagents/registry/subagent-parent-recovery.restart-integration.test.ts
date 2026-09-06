// Requester continuation and child-batch ownership across Gateway replacement.
import { describe, expect, it, vi } from "vitest";
import { getRuntimeConfig, setRuntimeConfigSnapshot } from "../../../config/config.js";
import {
  loadSessionEntryReadOnly,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import type { GatewayRequestContext } from "../../../gateway/server-methods/types.js";
import { persistGatewaySessionLifecycleEvent } from "../../../gateway/session-lifecycle-state.js";
import {
  getAgentEventLifecycleGeneration,
  rotateAgentEventLifecycleGeneration,
} from "../../../infra/agent-events.js";
import {
  bindGatewayContextResolver,
  getGatewayContextResolver,
  getSharedGatewayContextResolver,
} from "../../../plugins/runtime/gateway-request-scope.js";
import { transitionMainSessionRecovery } from "../../main-session-recovery/main-session-recovery-state.js";
import {
  markRestartAbortedMainSessions,
  markStartupOrphanedMainSessionsForRecovery,
} from "../../main-session-recovery/main-session-restart-recovery-marking.js";
import type { SubagentRegistryDeps } from "./subagent-registry-deps.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { settleRequesterTurnAfterSessionSpawns } from "./subagent-registry-requester-yield.js";
import { persistSubagentRunsToDiskOrThrow } from "./subagent-registry-state.js";
import {
  createSubagentRegistryTestDeps,
  writeSubagentSessionEntry,
} from "./subagent-registry.persistence.test-support.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry.store.sqlite.js";
import {
  addSubagentRunForTests,
  activateSubagentRegistry,
  getSubagentRunByChildSessionKey,
  initSubagentRegistry,
  resetSubagentRegistryForTests,
  testing,
} from "./subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import {
  makeRestartRecoveryRun as makeRunRecord,
  useSubagentRestartRecoveryFixture,
} from "./subagent-restart-recovery.test-support.js";

vi.mock("../../../gateway/session-utils.fs.js", () => ({
  readSessionMessagesAsync: vi.fn(async () => []),
}));

describe("subagent parent recovery — durable yielded continuation", () => {
  const fixture = useSubagentRestartRecoveryFixture();
  const { activateGatewayRuntime, dispatchAgent, gatewayRuntime } = fixture;

  it("hands recovered child completion to the replacement Gateway without reviving its predecessor", async () => {
    const now = Date.now();
    const runId = "warm-restart-child";
    const childSessionKey = "agent:main:subagent:warm-restart-child";
    await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey: childSessionKey,
      defaultSessionId: "warm-restart-child-session",
      updatedAt: now,
      abortedLastRun: true,
    });
    const predecessor = makeRunRecord({
      runId,
      childSessionKey,
      expectsCompletionMessage: true,
      execution: {
        status: "interrupted",
        startedAt: now - 1_000,
        interruptedAt: now,
        interruptionReason: "gateway-restart",
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
      },
      requesterSettleWake: {
        status: "pending",
        attemptCount: 0,
        requesterYieldBatch: true,
        rearmGeneration: 1,
        batchRunIds: [runId],
      },
    });
    let previousOpen = true;
    const previousContext = {
      recoveryRuntime: gatewayRuntime,
      resolveGatewayContext: () => (previousOpen ? previousContext : undefined),
    } as GatewayRequestContext;
    bindGatewayContextResolver(predecessor, previousContext.resolveGatewayContext);
    addSubagentRunForTests(predecessor);
    activateSubagentRegistry(() => previousContext);
    previousOpen = false;
    rotateAgentEventLifecycleGeneration();

    let replacementOpen = true;
    const replacementRuntime = { ...gatewayRuntime };
    const replacementContext = {
      recoveryRuntime: replacementRuntime,
      resolveGatewayContext: () => (replacementOpen ? replacementContext : undefined),
    } as GatewayRequestContext;
    bindGatewayContextResolver(replacementRuntime, replacementContext.resolveGatewayContext);
    activateSubagentRegistry(() => replacementContext);
    await testing.sweepOnceForTests();

    expect(dispatchAgent).toHaveBeenCalledOnce();
    const successor = getSubagentRunByChildSessionKey(childSessionKey);
    expect(successor).toBeDefined();
    expect(successor).not.toBe(predecessor);
    expect(getGatewayContextResolver(predecessor)?.()).toBeUndefined();
    const resolveWakeGateway = getSharedGatewayContextResolver([successor!]);
    expect(resolveWakeGateway?.()).toBe(replacementContext);
    replacementOpen = false;
    expect(resolveWakeGateway?.()).toBeUndefined();
    expect(getGatewayContextResolver(predecessor)?.()).toBeUndefined();
  });

  it.each([
    "waiting",
    "new foreground",
    "already marked",
    "pending final",
    "marked pending final",
    "reserved waiting cycle",
    "settled batch",
    "delivered child awaiting final",
    "unrelated agent",
    "provider timeout",
    "global in second agent store",
  ])("defers a yielded parent only while its continuation remains owned: %s", async (scenario) => {
    const newForeground = scenario === "new foreground";
    const globalParent = scenario === "global in second agent store";
    const parentAgentId = globalParent ? "other" : "main";
    const requesterAgentId = scenario === "unrelated agent" ? "other" : parentAgentId;
    if (globalParent) {
      setRuntimeConfigSnapshot({
        agents: { list: [{ id: "main" }, { id: "other" }] },
        session: { scope: "global" },
      });
    }
    const now = Date.now();
    const parentKey = globalParent ? "global" : "agent:main:yielded-parent-recovery";
    const parentRunId = "yielded-parent-original-run";
    const childKey = "agent:main:subagent:yielded-parent-child";
    const parentStorePath = await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: parentAgentId,
      sessionKey: parentKey,
      defaultSessionId: "yielded-parent-session",
      updatedAt: now - 2_000,
    });
    await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey: childKey,
      defaultSessionId: "yielded-parent-child-session",
      updatedAt: now - 1_000,
    });
    await persistGatewaySessionLifecycleEvent({
      sessionKey: parentKey,
      agentId: parentAgentId,
      event: {
        runId: parentRunId,
        sessionId: "yielded-parent-session",
        ts: now - 2_000,
        data: { phase: "start", startedAt: now - 2_000 },
      },
    });
    const child = makeRunRecord({
      runId: "yielded-parent-child-run",
      childSessionKey: childKey,
      requesterSessionKey: parentKey,
      requesterAgentId,
      requesterTurnRunId: parentRunId,
      requesterTurnYielded: true,
      expectsCompletionMessage: true,
    });
    addSubagentRunForTests(child);
    expect(
      settleRequesterTurnAfterSessionSpawns({
        requesterSessionKey: parentKey,
        requesterAgentId,
        requesterTurnRunId: parentRunId,
        requesterYielded: true,
        acceptedSessionSpawns: [{ runId: child.runId, childSessionKey: childKey }],
        runs: subagentRuns,
        persistOrThrow: (...runIds) => persistSubagentRunsToDiskOrThrow(subagentRuns, runIds),
        schedule: vi.fn(),
      }),
    ).toBe(true);
    await persistGatewaySessionLifecycleEvent({
      sessionKey: parentKey,
      agentId: parentAgentId,
      event: {
        runId: parentRunId,
        sessionId: "yielded-parent-session",
        ts: now - 1_000,
        data: {
          phase: "end",
          yielded: true,
          livenessState: "paused",
          stopReason: "end_turn",
          endedAt: now - 1_000,
        },
      },
    });
    if (newForeground) {
      await persistGatewaySessionLifecycleEvent({
        sessionKey: parentKey,
        event: {
          runId: "new-foreground-run",
          sessionId: "yielded-parent-session",
          ts: now,
          data: { phase: "start", startedAt: now },
        },
      });
    }
    const before = loadSessionEntryReadOnly({ storePath: parentStorePath, sessionKey: parentKey })!;
    expect(before.endedAt).toBe(newForeground ? undefined : now - 1_000);
    if (scenario === "waiting") {
      // The parent may still be registered while its completed turn tears down.
      // Shutdown must not replace the durable batch's continuation with main recovery.
      expect(
        await markRestartAbortedMainSessions({
          cfg: getRuntimeConfig(),
          stateDir: fixture.stateDir,
          resolveGatewayContext: getGatewayContextResolver(gatewayRuntime)!,
          activeRuns: [
            {
              runId: parentRunId,
              sessionKey: parentKey,
              sessionId: before.sessionId,
              lifecycleGeneration: getAgentEventLifecycleGeneration(),
            },
          ],
        }),
      ).toEqual({ marked: 0, skipped: 0 });
    }
    if (["already marked", "marked pending final", "reserved waiting cycle"].includes(scenario)) {
      // Persist the previous shutdown producer's real transition as an upgrade fixture.
      transitionMainSessionRecovery(before, {
        kind: "mark_interrupted",
        cycleId: "previous-gateway-yield-marker",
        now,
        runs: [{ runId: parentRunId, lifecycleGeneration: getAgentEventLifecycleGeneration() }],
      });
    }
    if (scenario === "pending final" || scenario === "marked pending final") {
      before.pendingFinalDelivery = {
        kind: "replayable",
        text: "Waiting for the child result.",
        intentId: "yield-acknowledgment-intent",
        deliveries: [{ id: "not-yet-enqueued-yield-acknowledgment", state: "prepared" }],
        createdAt: now,
      };
    }
    if (scenario === "reserved waiting cycle") {
      const observation = transitionMainSessionRecovery(before, {
        kind: "observe",
        cycleId: "previous-gateway-yield-marker",
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
        sessionKey: parentKey,
      });
      if (observation.kind !== "observed" || observation.view.status !== "recoverable") {
        throw new Error("Expected the persisted recovery cycle to admit its reservation");
      }
      expect(
        transitionMainSessionRecovery(before, {
          kind: "prepare_attempt",
          attempt: observation.view.nextAttempt,
          lifecycleGeneration: getAgentEventLifecycleGeneration(),
          now,
          observation: observation.view.observation,
          runId: "reserved-parent-recovery",
          executionIdentity: { state: "disabled" },
        }).kind,
      ).toBe("reserved");
    }
    if (
      [
        "already marked",
        "pending final",
        "marked pending final",
        "reserved waiting cycle",
      ].includes(scenario)
    ) {
      await replaceSessionEntry({ storePath: parentStorePath, sessionKey: parentKey }, before);
    }
    if (scenario === "settled batch" || scenario === "delivered child awaiting final") {
      child.execution = {
        ...child.execution,
        status: "terminal",
        endedAt: now,
        outcome: { status: "ok" },
      };
      child.delivery = { status: "delivered", disposition: "delivered", deliveredAt: now };
      child.cleanupCompletedAt = now;
      if (scenario === "settled batch") {
        // Settle through the lifecycle's exact batch callback, not by deleting a flag.
        const deliverBatch = vi.fn<
          SubagentRegistryDeps["maybeWakeRequesterAfterAllChildrenSettled"]
        >(async (params) => {
          params.completeBatch(
            [params.settledEntry],
            params.settledEntry.requesterSettleWake?.rearmGeneration,
            { delivered: true, requesterVisibleFinalDelivered: true, path: "direct" },
          );
          return true;
        });
        testing.setDepsForTest({
          ...createSubagentRegistryTestDeps(),
          maybeWakeRequesterAfterAllChildrenSettled: deliverBatch,
        });
        // Activation alone keeps wake admission closed until the registry inventory is hydrated.
        initSubagentRegistry();
        await testing.sweepOnceForTests();
        await vi.waitFor(() => expect(deliverBatch).toHaveBeenCalledOnce());
        expect(child.requesterSettleWake).toBeUndefined();
      }
    }
    if (scenario === "provider timeout") {
      await persistGatewaySessionLifecycleEvent({
        sessionKey: parentKey,
        event: {
          runId: parentRunId,
          sessionId: before.sessionId,
          ts: now,
          data: {
            phase: "error",
            stopReason: "timeout",
            timeoutPhase: "provider",
            endedAt: now,
            error: "provider deadline",
          },
        },
      });
    }
    rotateAgentEventLifecycleGeneration();
    const result = await markStartupOrphanedMainSessionsForRecovery({
      cfg: getRuntimeConfig(),
      stateDir: fixture.stateDir,
      activeSessionIds: [],
      activeSessionKeys: [],
    });
    const shouldMark =
      newForeground ||
      scenario === "pending final" ||
      scenario === "settled batch" ||
      scenario === "unrelated agent";
    expect(result.marked).toBe(shouldMark ? 1 : 0);
    const after = loadSessionEntryReadOnly({ storePath: parentStorePath, sessionKey: parentKey });
    expect(after?.abortedLastRun === true).toBe(
      shouldMark || scenario === "marked pending final" || scenario === "reserved waiting cycle",
    );
    expect(after?.status).toBe(scenario === "provider timeout" ? "timeout" : "running");
    if (scenario === "already marked") {
      expect(after?.mainRestartRecovery).toBeUndefined();
      expect(after?.restartRecoveryRuns).toBeUndefined();
      expect(after?.endedAt).toBe(now - 1_000);
    }
    if (scenario === "pending final" || scenario === "marked pending final") {
      expect(after?.pendingFinalDelivery).toEqual(before.pendingFinalDelivery);
      expect(after?.mainRestartRecovery).toBeDefined();
    }
    if (scenario === "reserved waiting cycle") {
      expect(after?.mainRestartRecovery?.reservation).toEqual(
        before.mainRestartRecovery?.reservation,
      );
    }
    expect(child.requesterTurnRunId).toBeUndefined();
    expect(child.requesterSettleWake?.requesterYieldBatch).toBe(
      scenario === "settled batch" ? undefined : true,
    );
  });

  it.each([
    { childCount: 1, failReplacement: false },
    { childCount: 2, failReplacement: false },
    { childCount: 2, failReplacement: true },
  ])(
    "recovers a yielded requester's $childCount children as one durable batch (write failure: $failReplacement)",
    async ({ childCount, failReplacement }) => {
      const now = Date.now();
      const requesterSessionKey = "agent:main:main";
      const requesterTurnRunId = "yielded-parent-turn";
      const children: SubagentRunRecord[] = [];
      for (let index = 0; index < childCount; index += 1) {
        const child = makeRunRecord({
          runId: `yielded-child-${index}`,
          childSessionKey: `agent:main:subagent:yielded-child-${index}`,
          requesterSessionKey,
          requesterTurnRunId,
          requesterTurnYielded: true,
          expectsCompletionMessage: true,
          createdAt: now - 60_000,
          startedAt: now - 55_000,
        });
        await writeSubagentSessionEntry({
          stateDir: fixture.stateDir,
          agentId: "main",
          sessionKey: child.childSessionKey,
          updatedAt: now,
          abortedLastRun: true,
          defaultSessionId: `yielded-child-session-${index}`,
        });
        addSubagentRunForTests(child);
        children.push(child);
      }
      expect(
        settleRequesterTurnAfterSessionSpawns({
          requesterSessionKey,
          requesterTurnRunId,
          requesterYielded: true,
          acceptedSessionSpawns: children.map((child) => ({
            runId: child.runId,
            childSessionKey: child.childSessionKey,
          })),
          runs: subagentRuns,
          persistOrThrow: (...runIds) => persistSubagentRunsToDiskOrThrow(subagentRuns, runIds),
          schedule: vi.fn(),
        }),
      ).toBe(true);

      resetSubagentRegistryForTests({ persist: false });
      rotateAgentEventLifecycleGeneration();
      initSubagentRegistry();
      activateGatewayRuntime();
      let rejectReplacement = failReplacement;
      if (failReplacement) {
        testing.setDepsForTest({
          ...createSubagentRegistryTestDeps(),
          runSubagentAnnounceFlow: vi.fn(async () => "delivered" as const),
          onAgentEvent: vi.fn(() => () => undefined),
          persistSubagentRunsToDiskOrThrow: (runs, changedRunIds) => {
            if (rejectReplacement && children.some((child) => !runs.has(child.runId))) {
              throw new Error("replacement transaction failed");
            }
            persistSubagentRunsToDiskOrThrow(runs, changedRunIds);
          },
        });
      }
      await testing.sweepOnceForTests();

      expect(dispatchAgent).toHaveBeenCalledTimes(childCount);
      if (failReplacement) {
        const originalRunIds = children.map((child) => child.runId).toSorted();
        const persistedBeforeRetry = loadSubagentRegistryFromSqlite();
        for (const child of children) {
          expect(subagentRuns.get(child.runId)?.requesterSettleWake?.batchRunIds).toEqual(
            originalRunIds,
          );
          expect(persistedBeforeRetry.get(child.runId)?.requesterSettleWake?.batchRunIds).toEqual(
            originalRunIds,
          );
        }
        rejectReplacement = false;
        await testing.sweepOnceForTests();
        expect(dispatchAgent).toHaveBeenCalledTimes(childCount);
      }
      const recoveredRunIds = dispatchAgent.mock.calls
        .map(([payload]) => String(payload.idempotencyKey))
        .toSorted();
      const persisted = loadSubagentRegistryFromSqlite();
      for (const child of children) {
        const successor = getSubagentRunByChildSessionKey(child.childSessionKey);
        expect(successor).toMatchObject({
          execution: { status: "running" },
          requesterSettleWake: {
            requesterYieldBatch: true,
            rearmGeneration: 1,
            batchRunIds: recoveredRunIds,
          },
        });
        expect(persisted.get(successor!.runId)?.requesterSettleWake).toEqual(
          successor!.requesterSettleWake,
        );
        expect(persisted.has(child.runId)).toBe(false);
      }
    },
  );
});
