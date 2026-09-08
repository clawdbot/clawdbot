import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createEmbeddedRunLaneController } from "../../agents/embedded-agent-runner/run/lane-controller.js";
import { abortAndDrainEmbeddedAgentRun } from "../../agents/embedded-agent-runner/runs.js";
import {
  installSessionPlacementAdmissionProvider,
  withSessionPlacementTurnAdmission,
  withLocalSessionPlacementTurnSettlement,
  type SessionPlacementTurnParams,
} from "../../agents/session-placement-admission.js";
import { resolveSessionPlacementTurnSettlementAssertion } from "../../agents/session-placement-forced-terminal-settlement.js";
import {
  createReplyOperation,
  forceClearReplyOperation,
} from "../../auto-reply/reply/reply-run-registry.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import {
  SESSION_ID,
  SESSION_KEY,
  cleanupWorkerTurnLauncherTest,
  createWorkerSessionTurnPlacementProvider,
  placements,
  setupWorkerTurnLauncherTest,
  turn,
  unusedEnvironments,
} from "./worker-turn-launcher.test-support.js";

function createLane(initialParams: SessionPlacementTurnParams) {
  let params = initialParams;
  let generation = getAgentEventLifecycleGeneration();
  return createEmbeddedRunLaneController({
    getParams: () => params,
    setParams: (value) => {
      params = value;
    },
    getLifecycleGeneration: () => generation,
    setLifecycleGeneration: (value) => {
      generation = value;
    },
    initialQueuedLifecycleGeneration: generation,
    globalLane: "claim-recovery-global",
    sessionLane: `claim-recovery-session:${params.sessionId}`,
  });
}

describe("local claim recovery before backend registration", () => {
  beforeEach(setupWorkerTurnLauncherTest);
  afterEach(cleanupWorkerTurnLauncherTest);

  it.each(["local", "standalone", "remote"] as const)(
    "admits a queued %s child after its inherited parent claim closes",
    async (execution) => {
      const provider = createWorkerSessionTurnPlacementProvider({
        environments: unusedEnvironments(),
        placements,
      });
      const gate = createDeferred();
      const localTask = vi.fn(async () => {
        if (execution === "local") {
          expect(placements.get(SESSION_ID)?.turnClaim?.runId).toBe("child-run");
        }
        return { meta: { durationMs: 1 } };
      });
      const remoteTask = vi.fn<typeof provider.executeTurn>(
        async (_claim, _params, _runLocal, onAdmitted) => {
          onAdmitted?.();
          return { meta: { durationMs: 2 } };
        },
      );
      let uninstall = installSessionPlacementAdmissionProvider(provider);
      let child: Promise<unknown> | undefined;
      let assertParent: (() => void) | undefined;
      try {
        await provider.executeLocalTurn(
          {
            sessionId: "parent-session",
            sessionKey: "agent:main:parent",
            agentId: "main",
            runId: "parent-run",
          },
          async () => {
            assertParent = resolveSessionPlacementTurnSettlementAssertion();
            const lane = createLane(turn("child-run"));
            child = lane.enqueueSession(async () => {
              await gate.promise;
              lane.throwIfAborted();
              return lane.enqueueGlobal(localTask);
            });
          },
        );
        expect(assertParent).toBeTypeOf("function");
        expect(assertParent).toThrow("settlement is closed");
        if (execution !== "local") {
          uninstall();
          uninstall = () => {};
        }
        if (execution === "remote") {
          uninstall = installSessionPlacementAdmissionProvider({
            assertCompactionSuccessorAllowed: () => {},
            executeLocalTurn: provider.executeLocalTurn,
            executeTurn: remoteTask,
          });
        }
        gate.resolve();
        await expect(child).resolves.toMatchObject({
          meta: { durationMs: execution === "remote" ? 2 : 1 },
        });
        expect(localTask).toHaveBeenCalledTimes(execution === "remote" ? 0 : 1);
        expect(remoteTask).toHaveBeenCalledTimes(execution === "remote" ? 1 : 0);
        expect(placements.get(SESSION_ID)?.turnClaim ?? null).toBeNull();
      } finally {
        gate.resolve();
        await Promise.allSettled([child]);
        uninstall();
      }
    },
  );

  it.each(["embedded", "CLI"] as const)(
    "isolates standalone %s admission from a retired parent settlement",
    async (execution) => {
      const provider = createWorkerSessionTurnPlacementProvider({
        environments: unusedEnvironments(),
        placements,
      });
      const gate = createDeferred();
      const task = vi.fn(async () => ({ meta: { durationMs: 1 } }));
      let child: Promise<unknown> | undefined;
      let assertParent: (() => void) | undefined;
      await provider.executeLocalTurn(
        {
          sessionId: "parent-session",
          sessionKey: "agent:main:parent",
          agentId: "main",
          runId: "parent-run",
        },
        async () => {
          assertParent = resolveSessionPlacementTurnSettlementAssertion();
          child = gate.promise.then(() => {
            const params = turn("standalone-run");
            return execution === "CLI"
              ? withLocalSessionPlacementTurnSettlement(params, task)
              : withSessionPlacementTurnAdmission(params, params, task);
          });
        },
      );
      try {
        expect(assertParent).toThrow("settlement is closed");
        gate.resolve();
        await expect(child).resolves.toMatchObject({ meta: { durationMs: 1 } });
        expect(task).toHaveBeenCalledOnce();
      } finally {
        gate.resolve();
        await Promise.allSettled([child]);
      }
    },
  );

  it.each(["preflight", "attempt admission", "terminal result"])(
    "releases a force-cleared reply before backend registration and fences its late %s",
    async (stage) => {
      const provider = createWorkerSessionTurnPlacementProvider({
        environments: unusedEnvironments(),
        placements,
      });
      const uninstall = installSessionPlacementAdmissionProvider(provider);
      const operation = createReplyOperation({
        sessionKey: SESSION_KEY,
        sessionId: SESSION_ID,
        resetTriggered: false,
      });
      const params = { ...turn("run-preflight"), replyOperation: operation };
      const lane = createLane(params);
      const started = createDeferred();
      const resume = createDeferred();
      const replacementStarted = createDeferred();
      const finishReplacement = createDeferred();
      const modelStart = vi.fn();
      let oldRun: Promise<unknown> | undefined;
      let replacement: Promise<unknown> | undefined;
      try {
        oldRun = lane.enqueueGlobal(async () => {
          const admittedRunContext = await params.preparedRunAdmission.admit("embedded");
          started.resolve();
          await resume.promise;
          if (stage === "preflight") {
            lane.throwIfAborted();
          } else if (stage === "attempt admission") {
            lane.createAttemptControls({ admittedRunContext }).close();
          }
          modelStart();
          return { meta: { durationMs: 1 } };
        });
        // Observe rejection immediately so a failing assertion still cleans up the old turn.
        const oldOutcome = oldRun.then(
          () => undefined,
          (error: unknown) => error,
        );
        await started.promise;
        expect(placements.get(SESSION_ID)?.turnClaim).not.toBeNull();
        await expect(
          abortAndDrainEmbeddedAgentRun({
            sessionId: SESSION_ID,
            sessionKey: SESSION_KEY,
            settleMs: 100,
            forceClear: true,
            reason: "stuck_recovery",
          }),
        ).resolves.toMatchObject({ forceCleared: true });
        expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();

        replacement = provider.executeLocalTurn({ ...params, runId: "replacement" }, async () => {
          replacementStarted.resolve();
          await finishReplacement.promise;
        });
        await replacementStarted.promise;
        const replacementClaim = placements.get(SESSION_ID)?.turnClaim?.claimId;
        resume.resolve();
        expect(await oldOutcome).toMatchObject({
          message: "session placement turn settlement is closed",
        });
        expect(modelStart).toHaveBeenCalledTimes(stage === "terminal result" ? 1 : 0);
        expect(placements.get(SESSION_ID)?.turnClaim?.claimId).toBe(replacementClaim);
      } finally {
        resume.resolve();
        finishReplacement.resolve();
        await Promise.allSettled([oldRun, replacement]);
        operation.complete();
        params.preparedRunAdmission.close();
        uninstall();
      }
    },
  );

  it.each(["before", "during"])(
    "does not start local work for a reply cleared %s admission",
    async (timing) => {
      const provider = createWorkerSessionTurnPlacementProvider({
        environments: unusedEnvironments(),
        placements,
      });
      const uninstall = installSessionPlacementAdmissionProvider(provider);
      const operation = createReplyOperation({
        sessionKey: SESSION_KEY,
        sessionId: SESSION_ID,
        resetTriggered: false,
      });
      const params = { ...turn("run-cleared-before-admission"), replyOperation: operation };
      const run = vi.fn(async () => ({ meta: { durationMs: 1 } }));
      try {
        if (timing === "before") {
          forceClearReplyOperation(operation);
        }
        await expect(
          withSessionPlacementTurnAdmission(params, params, run, () => {
            if (timing === "during") {
              forceClearReplyOperation(operation);
            }
          }),
        ).rejects.toThrow("settlement is closed");
        expect(run).not.toHaveBeenCalled();
        expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();
      } finally {
        operation.complete();
        uninstall();
      }
    },
  );
});
