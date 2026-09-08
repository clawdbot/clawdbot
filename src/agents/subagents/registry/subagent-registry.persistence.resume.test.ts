import { setImmediate as nextTask } from "node:timers/promises";
// Subagent registry persistence-resume tests cover restoring SQLite-backed child runs.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { isPathInside } from "../../../infra/path-guards.js";
import {
  bindGatewayContextResolver,
  getGatewayContextResolver,
} from "../../../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { listOpenClawAgentDatabasesForTest as listSeedAgentDatabases } from "../../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest as closeSeedStateDatabase } from "../../../state/openclaw-state-db.js";
import "./subagent-registry.mocks.shared.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import {
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../tools/gateway-caller-context.js";
import type { SubagentRegistryDeps } from "./subagent-registry-deps.js";
import {
  createSubagentRegistryTestDeps,
  gateSubagentRequesterSettlement,
  settleSubagentRegistryPersistenceWork,
  withSubagentRegistryPersistenceState,
  createDeliveredWake,
  createOrphanedRequiredDelivery,
  writeChildSession,
} from "./subagent-registry.persistence.test-support.js";
import {
  loadSubagentRegistryFromSqlite,
  saveSubagentRegistryToSqlite,
} from "./subagent-registry.store.sqlite.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

type WakeRequester = SubagentRegistryDeps["maybeWakeRequesterAfterAllChildrenSettled"];
type WakeParams = Parameters<WakeRequester>[0];

const { announceSpy } = vi.hoisted(() => ({
  announceSpy: vi.fn(async () => "delivered" as const),
}));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
vi.mock("../announce/subagent-announce.js", () => ({
  runSubagentAnnounceFlow: announceSpy,
}));
let mod: typeof import("./subagent-registry.test-helpers.js");
let callGatewayModule: typeof import("../../../gateway/call.js");
let agentEventsModule: typeof import("../../../infra/agent-events.js");
let registryDepsModule: typeof import("./subagent-registry-deps.js");
let registrySessionCleanupModule: typeof import("../../../test-utils/session-state-cleanup.js");
let registryAgentDbModule: typeof import("../../../state/openclaw-agent-db.js");
let registryStateDbModule: typeof import("../../../state/openclaw-state-db.js");

function listFixtureAgentDatabases(listDatabases: typeof listSeedAgentDatabases, stateDir: string) {
  return listDatabases().filter((database) => isPathInside(stateDir, database.path));
}

function setRegistryDeps(extra: Partial<SubagentRegistryDeps> = {}) {
  mod.testing.setDepsForTest(
    createSubagentRegistryTestDeps({
      callGateway: vi.mocked(callGatewayModule.callGateway),
      ...extra,
    }),
  );
}

const readPersistedRun = (runId: string) => loadSubagentRegistryFromSqlite().get(runId);

function activateRegistry() {
  const recoveryRuntime = {
    dispatchAgent: (params: Record<string, unknown>, timeoutMs?: number) =>
      callGatewayModule.callGateway({ method: "agent", params, timeoutMs }),
    waitForAgent: (params: Record<string, unknown>, timeoutMs?: number) =>
      callGatewayModule.callGateway({ method: "agent.wait", params, timeoutMs }),
    sendRecoveryNotice: vi.fn(),
  };
  mod.activateSubagentRegistry(
    () => ({ resolveGatewayContext: () => ({ recoveryRuntime }) }) as never,
  );
}

describe("subagent registry persistence resume", () => {
  beforeAll(async () => {
    vi.resetModules();
    mod = await import("./subagent-registry.test-helpers.js");
    callGatewayModule = await import("../../../gateway/call.js");
    agentEventsModule = await import("../../../infra/agent-events.js");
    registryStateDbModule = await import("../../../state/openclaw-state-db.js");
    registryDepsModule = await import("./subagent-registry-deps.js");
    registryAgentDbModule = await import("../../../state/openclaw-agent-db.js");
    registrySessionCleanupModule = await import("../../../test-utils/session-state-cleanup.js");
  });

  beforeEach(() => {
    announceSpy.mockClear();
    vi.mocked(callGatewayModule.callGateway).mockReset().mockResolvedValue({
      status: "ok",
      startedAt: 111,
      endedAt: 222,
    });
    setRegistryDeps();
    mod.resetSubagentRegistryForTests({ persist: false });
    vi.mocked(agentEventsModule.onAgentEvent)
      .mockReset()
      .mockReturnValue(() => undefined);
  });

  const withRegistryState = <T>(run: (stateDir: string) => Promise<T>) => {
    const stateDir = tempDirs.make("openclaw-subagent-");
    return withSubagentRegistryPersistenceState(
      {
        stateDir,
        resetRegistry: () => mod.resetSubagentRegistryForTests({ persist: false }),
        resetDeps: () => mod.testing.setDepsForTest(),
        closeDatabases: async () => {
          // The resumed registry owns a separate agent-DB cache after resetModules.
          // Agent cleanup releases leases through state DB writes, so close state DBs last.
          await registrySessionCleanupModule.cleanupSessionStateForTest({ stateDir });
          for (const [label, listDatabases] of [
            ["seed", listSeedAgentDatabases],
            ["post-reset", registryAgentDbModule.listOpenClawAgentDatabasesForTest],
          ] as const) {
            expect(
              listFixtureAgentDatabases(listDatabases, stateDir),
              `${label} agent handles closed before fixture removal`,
            ).toEqual([]);
          }
          closeSeedStateDatabase();
          registryStateDbModule.closeOpenClawStateDatabaseForTest();
        },
      },
      () => run(stateDir),
    );
  };

  it.each([
    { name: "announcing", expectsCompletionMessage: true },
    { name: "nonannouncing", expectsCompletionMessage: false },
    { name: "unspecified completion" },
    { name: "collector", expectsCompletionMessage: false, collect: true },
  ])("preserves the registered parent turn through SQLite reopen: $name", async (options) => {
    await withRegistryState(async () => {
      vi.mocked(callGatewayModule.callGateway).mockImplementation(() => new Promise(() => {}));
      const { name, ...registration } = options;
      const childSessionKey = "agent:main:subagent:parent-association";
      mod.registerSubagentRun({
        runId: "child-parent-association",
        childSessionKey,
        requesterSessionKey: "agent:main:main",
        requesterTurnRunId: "  parent-turn  ",
        requesterDisplayKey: "main",
        task: name,
        cleanup: "keep",
        ...registration,
      });
      const expected = {
        requesterTurnRunId: "parent-turn",
        completion: { required: registration.expectsCompletionMessage === true },
        delivery: {
          status: registration.expectsCompletionMessage === false ? "not_required" : "pending",
        },
      };
      const registered = mod.getSubagentRunByChildSessionKey(childSessionKey);
      expect(registered).toMatchObject(expected);
      expect(registered?.expectsCompletionMessage).toBe(registration.expectsCompletionMessage);
      registryStateDbModule.closeOpenClawStateDatabaseForTest();
      const restored = readPersistedRun("child-parent-association");
      expect(restored).toMatchObject(expected);
      expect(restored?.expectsCompletionMessage).toBe(registration.expectsCompletionMessage);
    });
  });

  it("resumes a persisted run from canonical SQLite state", async () => {
    await withRegistryState(async (stateDir) => {
      const run = createSubagentRunRecord({
        runId: "run-1",
        childSessionKey: "agent:main:subagent:test",
        requesterOrigin: { channel: "whatsapp", accountId: "acct-main" },
        task: "do the thing",
        execution: { status: "running" },
        completion: { required: false },
        delivery: { status: "not_required" },
      });
      saveSubagentRegistryToSqlite(new Map([[run.runId, run]]));
      await writeChildSession(stateDir, run.childSessionKey, "sess-test");

      mod.initSubagentRegistry();
      activateRegistry();

      await vi.waitFor(() => expect(announceSpy).toHaveBeenCalled(), {
        timeout: 1_000,
        interval: 10,
      });
      const announce = (announceSpy.mock.calls as unknown as Array<[unknown]>).at(-1)?.[0] as
        | {
            childRunId?: string;
            requesterOrigin?: { channel?: string; accountId?: string };
            outcome?: { status?: string };
          }
        | undefined;
      expect(announce).toMatchObject({
        childRunId: "run-1",
        requesterOrigin: { channel: "whatsapp", accountId: "acct-main" },
        outcome: { status: "ok" },
      });
      expect(mod.listSubagentRunsForRequester("agent:main:main")[0]).toMatchObject({
        childSessionKey: run.childSessionKey,
        requesterOrigin: { channel: "whatsapp", accountId: "acct-main" },
      });
      await settleSubagentRegistryPersistenceWork();
      expect(
        listFixtureAgentDatabases(listSeedAgentDatabases, stateDir),
        "seed session write acquired an agent handle",
      ).toHaveLength(1);
      expect(
        listFixtureAgentDatabases(
          registryAgentDbModule.listOpenClawAgentDatabasesForTest,
          stateDir,
        ),
        "resumed completion timing acquired a post-reset agent handle",
      ).toHaveLength(1);
    });
  });

  it.each([
    { label: "successful", status: "ok" as const },
    { label: "timed-out", status: "timeout" as const },
  ])("retries pending $label child delivery after restart", async ({ label, status }) => {
    await withRegistryState(async (stateDir) => {
      const runId = `run-pending-${label}-delivery`;
      const childSessionKey = `agent:main:subagent:pending-${label}-delivery`;
      const run = createSubagentRunRecord({
        runId,
        requesterTurnRunId: "run-requester",
        childSessionKey,
        task: "deliver before waking requester",
        createdAt: 100,
        endedReason: "subagent-complete",
        startedAt: 110,
        endedAt: 200,
        outcome: { status },
        expectsCompletionMessage: true,
        completion: { required: true, resultText: "done", capturedAt: 200 },
        delivery: {
          status: "pending",
          payload: {
            requesterSessionKey: "agent:main:main",
            requesterDisplayKey: "main",
            childSessionKey,
            childRunId: runId,
            task: "deliver before waking requester",
            startedAt: 110,
            endedAt: 200,
            outcome: { status },
            expectsCompletionMessage: true,
          },
        },
        cleanupHandled: false,
      });
      saveSubagentRegistryToSqlite(new Map([[run.runId, run]]));
      await writeChildSession(stateDir, run.childSessionKey, `sess-pending-${label}-delivery`);

      mod.initSubagentRegistry();
      activateRegistry();

      await vi.waitFor(() => expect(announceSpy).toHaveBeenCalled(), {
        timeout: 1_000,
        interval: 10,
      });
      expect(announceSpy).toHaveBeenCalledWith(
        expect.objectContaining({ childRunId: runId, outcome: { status } }),
      );
      expect(mod.getSubagentRunByRunId(runId)?.execution.outcome).toEqual({ status });
    });
  });

  it("replays one required completion after restart without the child session", async () => {
    await withRegistryState(async () => {
      const run = createOrphanedRequiredDelivery("pending");
      saveSubagentRegistryToSqlite(new Map([[run.runId, run]]));
      const settlement = gateSubagentRequesterSettlement(
        registryDepsModule.subagentRegistryDeps.maybeWakeRequesterAfterAllChildrenSettled,
      );
      mod.testing.setDepsForTest({
        ...registryDepsModule.subagentRegistryDeps,
        maybeWakeRequesterAfterAllChildrenSettled: settlement.run,
      });
      try {
        mod.initSubagentRegistry();
        activateRegistry();
        await vi.waitFor(
          () =>
            expect(settlement.run, "replay reached requester settlement").toHaveBeenCalledOnce(),
          {
            timeout: 5_000,
            interval: 10,
          },
        );
        expect(announceSpy, "replayed announcement delivered").toHaveBeenCalledOnce();
        expect(readPersistedRun(run.runId), "delivered row awaits real settlement").toMatchObject({
          delivery: { status: "delivered" },
          requesterSettleWake: { retireAfterSettle: true },
        });
        expect(announceSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            childSessionKey: run.childSessionKey,
            childRunId: run.runId,
            requesterSessionKey: "agent:main:main",
            roundOneReply: "canonical final reply",
            terminalReply: run.completion?.terminalReply,
            outcome: { status: "ok" },
          }),
        );
        await settlement.release();
        expect(settlement.run).toHaveBeenCalledOnce();
        expect(
          loadSubagentRegistryFromSqlite().has(run.runId),
          "settlement retired delivered row",
        ).toBe(false);
        await settleSubagentRegistryPersistenceWork();

        mod.resetSubagentRegistryForTests({ persist: false });
        mod.initSubagentRegistry();
        activateRegistry();
        await settleSubagentRegistryPersistenceWork();
        expect(announceSpy, "retired completion is not replayed again").toHaveBeenCalledOnce();
      } finally {
        await settlement.release();
      }
    });
  });

  it.each([
    "permanent rejection",
    "inactive drain error",
    "restart admission",
    "restart reactivation",
    "restart before deadline",
    "restart before activation",
    "restart throwing source",
  ] as const)("settles or preserves a delivered wake after %s", async (failure) => {
    const admission = await import("../../../process/gateway-work-admission.js");
    const restarting = failure.startsWith("restart");
    const waitingForActivation = failure === "restart before activation";
    let firstGatewayOpen = true;
    const firstGateway = {
      resolveGatewayContext: () => (firstGatewayOpen ? (firstGateway as never) : undefined),
    };
    const replacementGateway = { resolveGatewayContext: () => replacementGateway as never };
    if (restarting) {
      vi.useFakeTimers();
    }
    try {
      await withRegistryState(async () => {
        const endedAt = Date.now();
        const run = createDeliveredWake("run-rejected-requester-wake", {
          status: restarting && !waitingForActivation ? "dispatching" : "pending",
          attemptCount: waitingForActivation ? 2 : restarting ? 1 : 0,
          ...(restarting ? { replayCount: 1, nextAttemptAt: endedAt + 30_000 } : {}),
          batchRunIds: ["run-rejected-requester-wake"],
          requesterYieldBatch: true,
          afterRequesterYield: true,
          rearmGeneration: 1,
        });
        const wakeRequester = vi.fn<WakeRequester>(async (params) => {
          if (!restarting) {
            throw failure === "inactive drain error"
              ? new admission.GatewayDrainingError()
              : new Error("requester wake rejected before attempt admission");
          }
          expect(getGatewayContextResolver(params.settledEntry!)?.()).toBe(replacementGateway);
          params.completeBatch([params.settledEntry], run.requesterSettleWake?.rearmGeneration, {
            delivered: true,
            path: "direct",
          });
          return true;
        });
        setRegistryDeps({ maybeWakeRequesterAfterAllChildrenSettled: wakeRequester });
        saveSubagentRegistryToSqlite(new Map([[run.runId, run]]));

        mod.initSubagentRegistry();
        if (restarting) {
          mod.activateSubagentRegistry(() => firstGateway as never);
        } else {
          activateRegistry();
        }
        if (failure === "restart throwing source") {
          bindGatewayContextResolver(
            mod.getSubagentRunByRunId(run.runId)!,
            await withGatewayToolCallerIdentity(
              {
                agentId: "main",
                sessionKey: run.requesterSessionKey,
                gatewayContextResolver: () => {
                  if (!firstGatewayOpen) {
                    throw new Error("retired source");
                  }
                  return firstGateway as never;
                },
              },
              () => getGatewayToolCallerIdentity()?.gatewayContextResolver,
            ),
          );
        }

        if (restarting) {
          // The earlier delivery released its root; the real deadline timer must
          // cross fresh admission rather than inheriting live requester authority.
          admission.markGatewayRestartDraining();
          if (failure !== "restart before deadline" && !waitingForActivation) {
            await vi.advanceTimersByTimeAsync(30_000);
          }
          expect(wakeRequester).not.toHaveBeenCalled();
          expect(mod.getSubagentRunByRunId(run.runId)?.requesterSettleWake).toEqual(
            run.requesterSettleWake,
          );
          registryStateDbModule.closeOpenClawStateDatabaseForTest();
          closeSeedStateDatabase();
          const persisted = readPersistedRun(run.runId);
          expect(persisted?.requesterSettleWake).toEqual(run.requesterSettleWake);
          expect(persisted?.requesterTurnRunId).toBeUndefined();

          const retiredRun = mod.getSubagentRunByRunId(run.runId)!;
          const retiredResolver = getGatewayContextResolver(retiredRun);
          firstGatewayOpen = false;
          if (failure === "restart admission") {
            mod.resetSubagentRegistryForTests({ persist: false });
          }
          admission.resetGatewayWorkAdmission();
          if (waitingForActivation) {
            await vi.advanceTimersByTimeAsync(30_000);
            expect(wakeRequester).not.toHaveBeenCalled();
            expect(readPersistedRun(run.runId)?.requesterSettleWake).toEqual(
              run.requesterSettleWake,
            );
          }
          mod.initSubagentRegistry();
          mod.activateSubagentRegistry(() => replacementGateway as never);
          const recoveredRun = mod.getSubagentRunByRunId(run.runId);
          expect(recoveredRun).not.toBe(retiredRun);
          mod.activateSubagentRegistry(() => replacementGateway as never);
          expect(mod.getSubagentRunByRunId(run.runId)).toBe(recoveredRun);
          expect(retiredResolver?.()).toBeUndefined();
          await mod.testing.runSweeperTickForTests();
          await vi.advanceTimersByTimeAsync(failure === "restart before deadline" ? 30_000 : 0);
        }
        await vi.waitFor(() => expect(wakeRequester).toHaveBeenCalledOnce());
        await vi.waitFor(() => {
          const restored = readPersistedRun(run.runId);
          expect(restored?.delivery).toMatchObject({ status: "delivered" });
          expect(restored?.requesterSettleWake).toBeUndefined();
        });
        await mod.testing.sweepOnceForTests();
        expect(wakeRequester).toHaveBeenCalledOnce();
      });
    } finally {
      admission.resetGatewayWorkAdmission();
      vi.useRealTimers();
    }
  });

  it.each([
    { order: "replacement-first", runCount: 1 },
    { order: "old-finally-first", runCount: 1 },
    { order: "before-activation", runCount: 1 },
    { order: "replacement-first", runCount: 3 },
  ] as const)(
    "fences outstanding wake work across forced restart: $order / $runCount rows",
    async ({ order, runCount }) => {
      const admission = await import("../../../process/gateway-work-admission.js");
      const oldDone = createDeferredCore<boolean>();
      const replacementDone = createDeferredCore();
      const oldParams: WakeParams[] = [];
      let oldFinished = 0;
      let firstGatewayOpen = true;
      const firstGateway = {
        resolveGatewayContext: () => (firstGatewayOpen ? (firstGateway as never) : undefined),
      };
      const replacementGateway = { resolveGatewayContext: () => replacementGateway as never };
      vi.useFakeTimers();
      try {
        await withRegistryState(async () => {
          try {
            const runs = Array.from({ length: runCount }, (_, index) => {
              const runId = `run-outstanding-wake-${index}`;
              return {
                ...createDeliveredWake(runId, {
                  status: "pending",
                  attemptCount: 2,
                  batchRunIds: [runId],
                  requesterYieldBatch: true,
                  afterRequesterYield: true,
                  rearmGeneration: 1,
                }),
                requesterSessionKey: `agent:main:requester-${index}`,
              };
            });
            const wakeRequester = vi.fn<WakeRequester>(async (params) => {
              if (getGatewayContextResolver(params.settledEntry!)?.() === firstGateway) {
                oldParams.push(params);
                params.transitionBatch([params.settledEntry], {
                  ...params.settledEntry.requesterSettleWake!,
                  status: "dispatching",
                  attemptCount: 3,
                });
                const result = await oldDone.promise;
                params.completeBatch([params.settledEntry], 1, {
                  delivered: false,
                  path: "direct",
                  disposition: "retryable",
                  error: "completion agent did not produce a visible reply",
                });
                oldFinished++;
                return result;
              }
              await replacementDone.promise;
              expect(getGatewayContextResolver(params.settledEntry!)?.()).toBe(replacementGateway);
              params.completeBatch([params.settledEntry], 1, { delivered: true, path: "direct" });
              return true;
            });
            setRegistryDeps({ maybeWakeRequesterAfterAllChildrenSettled: wakeRequester });
            saveSubagentRegistryToSqlite(new Map(runs.map((run) => [run.runId, run])));
            mod.initSubagentRegistry();
            mod.activateSubagentRegistry(() => firstGateway as never);
            const oldActiveCount = Math.min(runCount, 2);
            await vi.waitFor(() => expect(wakeRequester).toHaveBeenCalledTimes(oldActiveCount));
            const retiredRuns = runs.map((run) => mod.getSubagentRunByRunId(run.runId)!);
            const retiredResolvers = retiredRuns.map(getGatewayContextResolver);
            const expectedWakes = retiredRuns.map((run) =>
              structuredClone(run.requesterSettleWake),
            );

            // A forced restart retires admission before old async chains return.
            admission.markGatewayRestartDraining();
            firstGatewayOpen = false;
            admission.resetGatewayWorkAdmission();
            if (order === "before-activation") {
              oldDone.resolve(false);
              await vi.advanceTimersByTimeAsync(0);
              expect(runs.map((run) => readPersistedRun(run.runId)?.requesterSettleWake)).toEqual(
                expectedWakes,
              );
            }
            mod.activateSubagentRegistry(() => replacementGateway as never);
            const recoveredRuns = runs.map((run) => mod.getSubagentRunByRunId(run.runId)!);
            recoveredRuns.forEach((run, index) => {
              expect(run).not.toBe(retiredRuns[index]);
              expect(retiredResolvers[index]?.()).toBeUndefined();
            });
            oldParams.forEach((params) =>
              params.transitionBatch([params.settledEntry], {
                ...params.settledEntry.requesterSettleWake!,
                attemptCount: 99,
              }),
            );
            expect(recoveredRuns.map((run) => run.requesterSettleWake)).toEqual(expectedWakes);

            await mod.testing.runSweeperTickForTests();
            await vi.waitFor(() => expect(wakeRequester).toHaveBeenCalledTimes(oldActiveCount * 2));
            if (order === "replacement-first") {
              replacementDone.resolve();
              await vi.advanceTimersByTimeAsync(0);
              expect(recoveredRuns.every((run) => run.requesterSettleWake === undefined)).toBe(
                true,
              );
              expect(oldFinished).toBe(0);
            }
            oldDone.resolve(false);
            await vi.advanceTimersByTimeAsync(0);
            await mod.testing.runSweeperTickForTests();
            expect(wakeRequester).toHaveBeenCalledTimes(oldActiveCount + runCount);
            expect(oldParams).toHaveLength(oldActiveCount);
            if (order !== "replacement-first") {
              expect(recoveredRuns.map((run) => run.requesterSettleWake)).toEqual(expectedWakes);
              replacementDone.resolve();
            }
            await vi.advanceTimersByTimeAsync(0);
            for (const run of recoveredRuns) {
              expect(readPersistedRun(run.runId)?.requesterSettleWake).toBeUndefined();
              expect(run.delivery?.status).toBe("delivered");
            }
          } finally {
            oldDone.resolve(false);
            replacementDone.resolve();
            await vi.advanceTimersByTimeAsync(0);
          }
        });
      } finally {
        admission.resetGatewayWorkAdmission();
        vi.useRealTimers();
      }
    },
  );

  it.each([
    "transition",
    "completion",
    "rejection",
    "closed-empty",
    "closed-transition",
    "closed-retryable",
    "closed-permanent",
  ] as const)(
    "rejects the whole stale batch when only a sibling closes or is replaced: %s",
    async (settlement) => {
      const oldDone = createDeferredCore<boolean>();
      let oldParams: WakeParams | undefined;
      let siblingGatewayOpen = true;
      const anchorGateway = { resolveGatewayContext: () => anchorGateway as never };
      const nextGateway = { resolveGatewayContext: () => nextGateway as never };
      vi.useFakeTimers();
      try {
        await withRegistryState(async () => {
          try {
            const batch = ["run-batch-anchor", "run-batch-sibling"].map((runId, index) =>
              createDeliveredWake(runId, {
                status: "pending",
                attemptCount: 0,
                batchRunIds: ["run-batch-anchor", "run-batch-sibling"],
                rearmGeneration: 1,
                ...(index === 1 ? { nextAttemptAt: Date.now() + 30_000 } : {}),
              }),
            );
            const wakeRequester = vi.fn<WakeRequester>((params) => {
              oldParams ??= params;
              return oldDone.promise;
            });
            setRegistryDeps({ maybeWakeRequesterAfterAllChildrenSettled: wakeRequester });
            saveSubagentRegistryToSqlite(new Map(batch.map((entry) => [entry.runId, entry])));
            mod.initSubagentRegistry();
            const anchor = mod.getSubagentRunByRunId("run-batch-anchor")!;
            const sibling = mod.getSubagentRunByRunId("run-batch-sibling")!;
            bindGatewayContextResolver(anchor, () => anchorGateway as never);
            bindGatewayContextResolver(sibling, () =>
              siblingGatewayOpen ? (anchorGateway as never) : undefined,
            );
            mod.activateSubagentRegistry(() => anchorGateway as never);
            await vi.waitFor(() => expect(wakeRequester).toHaveBeenCalledOnce());
            expect(oldParams?.settledEntry).toBe(anchor);

            siblingGatewayOpen = false;
            const beforeActivation = settlement.startsWith("closed-");
            if (!beforeActivation) {
              mod.activateSubagentRegistry(() => nextGateway as never);
            }
            const replacement = mod.getSubagentRunByRunId(sibling.runId)!;
            expect(mod.getSubagentRunByRunId(anchor.runId)).toBe(anchor);
            expect(replacement === sibling).toBe(beforeActivation);
            const expected = [anchor, replacement].map((entry) =>
              structuredClone(entry.requesterSettleWake),
            );
            if (settlement.endsWith("transition")) {
              oldParams!.transitionBatch([anchor, sibling], {
                ...expected[0]!,
                attemptCount: 99,
              });
            } else if (settlement === "rejection") {
              oldDone.reject(new Error("old mixed-owner dispatch failed"));
              await vi.advanceTimersByTimeAsync(0);
            } else {
              oldParams!.completeBatch(
                [anchor, sibling],
                1,
                settlement === "completion" || settlement === "closed-empty"
                  ? undefined
                  : {
                      delivered: false,
                      path: "direct",
                      disposition:
                        settlement === "closed-permanent" ? "permanent_failure" : "retryable",
                    },
              );
            }
            expect([anchor, replacement].map((entry) => entry.requesterSettleWake)).toEqual(
              expected,
            );
            expect(readPersistedRun(sibling.runId)?.requesterSettleWake).toEqual(expected[1]);
          } finally {
            oldDone.resolve(false);
            await vi.advanceTimersByTimeAsync(0);
          }
        });
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each([
    { status: "suspended" as const, disposition: undefined, queueId: undefined },
    { status: "in_progress" as const, disposition: "session_queued" as const, queueId: "queue-1" },
  ])("retains $status required delivery with its owner after restart", async (expected) => {
    await withRegistryState(async () => {
      const run = createOrphanedRequiredDelivery(expected.status);
      saveSubagentRegistryToSqlite(new Map([[run.runId, run]]));

      mod.initSubagentRegistry();
      activateRegistry();
      await nextTask();

      expect(announceSpy).not.toHaveBeenCalled();
      expect(readPersistedRun(run.runId)?.delivery).toMatchObject({
        status: expected.status,
        ...(expected.disposition ? { disposition: expected.disposition } : {}),
        ...(expected.queueId ? { queueId: expected.queueId } : {}),
      });
    });
  });

  it("keeps restored recovery dormant until the Gateway lifecycle activates it", async () => {
    const wakeRequester = vi.fn(async () => false);
    setRegistryDeps({ maybeWakeRequesterAfterAllChildrenSettled: wakeRequester });

    await withRegistryState(async (stateDir) => {
      const endedAt = Date.now();
      const yieldedRun = createDeliveredWake("run-hydrated-yield", undefined, {
        taskRunId: "run-hydrated-yield",
        requesterTurnRunId: "run-requester",
        requesterTurnYielded: true,
        childSessionKey: "agent:main:subagent:hydrated-yield",
        task: "wake only after lifecycle activation",
        createdAt: endedAt - 1_000,
        endedReason: "subagent-complete",
        startedAt: endedAt - 500,
        endedAt,
        cleanupCompletedAt: endedAt,
      });
      const queuedCollector = createSubagentRunRecord({
        runId: "run-hydrated-collector",
        childSessionKey: "agent:main:subagent:hydrated-collector",
        task: "clean only after lifecycle activation",
        createdAt: endedAt - 500,
        collect: true,
        swarmRequesterSessionKey: "agent:main:main",
        groupId: "hydrated-group",
        archiveAtMs: endedAt - 1,
        startedAt: endedAt - 400,
        endedAt,
        outcome: { status: "error", error: "launch failed" },
        completion: { required: true },
        delivery: { status: "pending" },
        collectorCompletion: { status: "failed" },
        collectorLaunchCleanupPending: true,
      });
      const runningRun = createSubagentRunRecord({
        runId: "run-hydrated-running",
        childSessionKey: "agent:main:subagent:hydrated-running",
        task: "wait through the activated instance",
        createdAt: endedAt,
        execution: { status: "running", startedAt: endedAt },
        completion: { required: false },
        delivery: { status: "not_required" },
      });
      saveSubagentRegistryToSqlite(
        new Map([
          [yieldedRun.runId, yieldedRun],
          [queuedCollector.runId, queuedCollector],
          [runningRun.runId, runningRun],
        ]),
      );
      await writeChildSession(stateDir, yieldedRun.childSessionKey, "sess-hydrated-yield");
      await writeChildSession(
        stateDir,
        queuedCollector.childSessionKey,
        "sess-hydrated-collector",
        "revision-hydrated-collector",
      );
      await writeChildSession(stateDir, runningRun.childSessionKey, "sess-hydrated-running");

      mod.initSubagentRegistry();
      await nextTask();

      expect(mod.getSubagentRunByRunId(yieldedRun.runId)).toBeDefined();
      expect(mod.getSubagentRunByRunId(queuedCollector.runId)).toBeDefined();
      expect(mod.getSubagentRunByRunId(runningRun.runId)).toBeDefined();
      expect(wakeRequester).not.toHaveBeenCalled();
      expect(callGatewayModule.callGateway).not.toHaveBeenCalledWith(
        expect.objectContaining({ method: "sessions.delete" }),
      );

      const recoveryRuntime = {
        dispatchAgent: vi.fn(),
        waitForAgent: vi.fn(async () => ({ status: "pending" })),
        sendRecoveryNotice: vi.fn(),
      };
      let firstLifecycleOpen = true;
      const gatewayContext = {
        recoveryRuntime,
        resolveGatewayContext: vi.fn(),
      };
      gatewayContext.resolveGatewayContext.mockImplementation(() =>
        firstLifecycleOpen ? (gatewayContext as never) : undefined,
      );
      const resolveGatewayContext = vi.fn(() => gatewayContext as never);
      mod.activateSubagentRegistry(resolveGatewayContext);
      mod.activateSubagentRegistry(resolveGatewayContext);
      const restoredRun = mod.getSubagentRunByRunId(runningRun.runId);
      expect(restoredRun).toBeDefined();
      const restoredGatewayContextResolver = getGatewayContextResolver(restoredRun!);
      expect(restoredGatewayContextResolver).toBeDefined();
      expect(restoredGatewayContextResolver).not.toBe(resolveGatewayContext);
      expect(restoredGatewayContextResolver?.()).toBe(gatewayContext);

      await vi.waitFor(() => {
        expect(wakeRequester).toHaveBeenCalledOnce();
        expect(recoveryRuntime.waitForAgent).toHaveBeenCalledOnce();
      });
      expect(recoveryRuntime.dispatchAgent).not.toHaveBeenCalled();
      expect(callGatewayModule.callGateway).not.toHaveBeenCalledWith(
        expect.objectContaining({ method: "agent.wait" }),
      );

      firstLifecycleOpen = false;
      expect(resolveGatewayContext()).toBe(gatewayContext);
      expect(gatewayContext.resolveGatewayContext()).toBeUndefined();
      expect(restoredGatewayContextResolver?.()).toBeUndefined();
      const replacementRuntime = {
        dispatchAgent: vi.fn(),
        waitForAgent: vi.fn(async () => ({ status: "pending" })),
        sendRecoveryNotice: vi.fn(),
      };
      const resolveReplacementContext = () =>
        ({ resolveGatewayContext: () => ({ recoveryRuntime: replacementRuntime }) }) as never;
      mod.activateSubagentRegistry(resolveReplacementContext);
      mod.activateSubagentRegistry(resolveReplacementContext);
      expect(getGatewayContextResolver(restoredRun!)).toBe(restoredGatewayContextResolver);
      expect(wakeRequester).toHaveBeenCalledOnce();
      expect(recoveryRuntime.waitForAgent).toHaveBeenCalledOnce();
      expect(replacementRuntime.waitForAgent).not.toHaveBeenCalled();

      await mod.testing.runSweeperTickForTests();
      expect(callGatewayModule.callGateway).toHaveBeenCalledTimes(1);
      expect(callGatewayModule.callGateway).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "sessions.delete",
          params: expect.objectContaining({
            expectedSessionId: "sess-hydrated-collector",
            expectedLifecycleRevision: "revision-hydrated-collector",
          }),
        }),
      );
    });
  });

  it.each([
    "persisted",
    "activation-created normal",
    "activation-created yielded",
    "caller-wrapped",
  ] as const)(
    "bounds restored %s requester-settle wakes after Gateway activation",
    async (mode) => {
      const activationSettlement = mode.startsWith("activation-created");
      const requesterYielded = mode === "activation-created yielded" ? true : undefined;
      let activeWakes = 0;
      let maxActiveWakes = 0;
      const wakeResolvers: Array<() => void> = [];
      const wakeRequester = vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            activeWakes += 1;
            maxActiveWakes = Math.max(maxActiveWakes, activeWakes);
            wakeResolvers.push(() => {
              activeWakes -= 1;
              resolve(false);
            });
          }),
      );
      setRegistryDeps({ maybeWakeRequesterAfterAllChildrenSettled: wakeRequester });

      await withRegistryState(async (stateDir) => {
        const endedAt = Date.now();
        const restoredRuns = Array.from({ length: 3 }, (_, index): SubagentRunRecord => {
          const runId = `run-restored-wake-${index}`;
          return createDeliveredWake(
            runId,
            activationSettlement ? undefined : { status: "pending", attemptCount: 0 },
            {
              childSessionKey: `agent:main:subagent:restored-wake-${index}`,
              requesterSessionKey: `agent:main:requester-${index}`,
              requesterDisplayKey: `requester-${index}`,
              task: "resume a durable requester wake",
              createdAt: endedAt - 1_000,
              endedReason: "subagent-complete",
              startedAt: endedAt - 500,
              endedAt,
              ...(activationSettlement
                ? {
                    requesterTurnRunId: `requester-turn-${index}`,
                    requesterTurnYielded: requesterYielded ?? undefined,
                    taskRunId: runId,
                  }
                : {}),
            },
          );
        });
        saveSubagentRegistryToSqlite(new Map(restoredRuns.map((entry) => [entry.runId, entry])));

        if (activationSettlement) {
          await Promise.all(
            restoredRuns.map((entry, index) =>
              writeChildSession(stateDir, entry.childSessionKey, `sess-restored-wake-${index}`),
            ),
          );
        }

        mod.initSubagentRegistry();
        await nextTask();
        expect(wakeRequester).not.toHaveBeenCalled();

        if (mode === "caller-wrapped") {
          const gateway = { resolveGatewayContext: () => gateway as never };
          for (const run of restoredRuns) {
            bindGatewayContextResolver(
              mod.getSubagentRunByRunId(run.runId)!,
              await withGatewayToolCallerIdentity(
                {
                  agentId: "main",
                  sessionKey: run.requesterSessionKey,
                  gatewayContextResolver: gateway.resolveGatewayContext,
                },
                () => getGatewayToolCallerIdentity()?.gatewayContextResolver,
              ),
            );
          }
          mod.activateSubagentRegistry(() => gateway as never);
        } else {
          activateRegistry();
        }
        try {
          await vi.waitFor(() => expect(wakeRequester).toHaveBeenCalledTimes(2));
          expect(activeWakes).toBe(2);
          expect(maxActiveWakes).toBe(2);

          wakeResolvers.shift()?.();
          await vi.waitFor(() => expect(wakeRequester).toHaveBeenCalledTimes(3));
          expect(maxActiveWakes).toBe(2);
        } finally {
          while (wakeResolvers.length > 0) {
            while (wakeResolvers.length > 0) {
              wakeResolvers.shift()?.();
            }
            await nextTask();
            if (activeWakes === 0) {
              break;
            }
          }
          await vi.waitFor(() => expect(activeWakes).toBe(0));
        }
      });
    },
  );

  it("keeps dismissed terminal delivery dormant and TTL-eligible after restore", async () => {
    await withRegistryState(async () => {
      const now = Date.now();
      const run = createSubagentRunRecord({
        runId: "run-dismissed-delivery",
        childSessionKey: "agent:main:subagent:dismissed-delivery",
        task: "retain no delivery obligation",
        createdAt: now - 10 * 60_000,
        endedReason: "subagent-complete",
        startedAt: now - 9 * 60_000,
        endedAt: now - 8 * 60_000,
        outcome: { status: "ok" },
        expectsCompletionMessage: true,
        completion: { required: true, resultText: "done", capturedAt: now - 8 * 60_000 },
        delivery: {
          status: "discarded",
          disposition: "intentional_non_delivery",
          dismissedAt: now - 6 * 60_000,
        },
        cleanupHandled: true,
        cleanupCompletedAt: now - 6 * 60_000,
      });
      saveSubagentRegistryToSqlite(new Map([[run.runId, run]]));

      mod.initSubagentRegistry();
      await mod.testing.sweepOnceForTests();

      expect(announceSpy).not.toHaveBeenCalled();
      expect(mod.getSubagentRunByRunId(run.runId)).toBeUndefined();
    });
  });

  it.each([false, true])(
    "settles a restored steered requester turn (yielded: %s)",
    async (requesterYielded) => {
      const wakeRequester = vi.fn(async () => false);
      setRegistryDeps({ maybeWakeRequesterAfterAllChildrenSettled: wakeRequester });

      await withRegistryState(async (stateDir) => {
        const endedAt = Date.now();
        const run = createDeliveredWake("run-steered", undefined, {
          taskRunId: "run-original",
          requesterTurnRunId: "run-requester",
          ...(requesterYielded ? { requesterTurnYielded: true } : {}),
          childSessionKey: "agent:main:subagent:steered",
          task: "deliver the steered result",
          createdAt: endedAt - 1_000,
          endedReason: "subagent-complete",
          startedAt: endedAt - 500,
          endedAt,
          cleanupCompletedAt: endedAt,
        });
        const nonannouncing: SubagentRunRecord[] = [];
        for (const collect of [false, true]) {
          nonannouncing.push({
            ...run,
            runId: `run-nonannouncing-${collect}`,
            taskRunId: `run-nonannouncing-${collect}`,
            childSessionKey: `agent:main:subagent:nonannouncing-${collect}`,
            expectsCompletionMessage: false,
            requesterTurnYielded: undefined,
            collect,
            completion: { required: false, resultText: "quiet result", capturedAt: endedAt },
            delivery: { status: "not_required" },
            ...(collect ? { collectorCompletion: { status: "done" } } : {}),
          });
        }
        saveSubagentRegistryToSqlite(
          new Map([run, ...nonannouncing].map((entry) => [entry.runId, entry])),
        );
        for (const entry of [run, ...nonannouncing]) {
          await writeChildSession(stateDir, entry.childSessionKey, `sess-${entry.runId}`);
        }

        mod.initSubagentRegistry();
        activateRegistry();

        const restored = mod.getSubagentRunByRunId(run.runId);
        expect(restored).toMatchObject({ runId: run.runId, taskRunId: run.taskRunId });
        expect(restored?.requesterTurnRunId).toBeUndefined();
        expect(readPersistedRun(run.runId)?.requesterTurnRunId).toBeUndefined();
        for (const sibling of nonannouncing) {
          expect(mod.getSubagentRunByRunId(sibling.runId)).toMatchObject({
            requesterTurnRunId: "run-requester",
            delivery: { status: "not_required" },
          });
          expect(mod.getSubagentRunByRunId(sibling.runId)?.requesterSettleWake).toBeUndefined();
        }

        if (requesterYielded) {
          expect(restored?.requesterSettleWake).toMatchObject({
            batchRunIds: [run.runId],
            requesterYieldBatch: true,
            afterRequesterYield: true,
          });
        } else {
          expect(restored?.requesterSettleWake).toBeUndefined();
        }
        await vi.waitFor(() => expect(wakeRequester).toHaveBeenCalledOnce(), {
          timeout: 1_000,
          interval: 10,
        });
      });
    },
  );
});
