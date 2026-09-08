import { afterEach, describe, expect, it, vi } from "vitest";
import { rotateAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import { enqueueCommandInLane, resetCommandLane } from "../process/command-queue.js";
import { createDeferredCore } from "../shared/deferred.js";

const settleRequesterAfterSessionSpawns = vi.hoisted(() => vi.fn(() => true));
vi.mock("./subagents/registry/subagent-registry.js", () => ({
  settleRequesterAfterSessionSpawns,
}));

import { createTestAdmittedRunContext } from "./admitted-run-context.test-support.js";
import { resolveSessionLane } from "./embedded-agent-runner/lanes.js";
import {
  captureSessionPlacementCompactionSuccessorAssertion,
  installSessionPlacementAdmissionProvider,
  type LocalTurnPlacementClaim,
  type SessionPlacementAdmissionProvider,
  withLocalSessionPlacementTurnSettlement,
  withSessionPlacementTurnAdmission,
} from "./session-placement-admission.js";

let uninstallProvider: (() => void) | undefined;
const assertCompactionSuccessorAllowed = () => {};
const executeLocalTurn: SessionPlacementAdmissionProvider["executeLocalTurn"] = async (
  _claim,
  runLocal,
) => await runLocal();

afterEach(() => {
  uninstallProvider?.();
  uninstallProvider = undefined;
  settleRequesterAfterSessionSpawns.mockReset();
  settleRequesterAfterSessionSpawns.mockReturnValue(true);
});

describe("captured compaction placement owner", () => {
  const params = {
    currentTarget: {
      agentId: "main",
      sessionId: "before",
      sessionKey: "agent:main:turn",
      storePath: "/tmp/agent.sqlite",
    },
    successorSessionId: "after",
  };
  const install = (
    guard: SessionPlacementAdmissionProvider["assertCompactionSuccessorAllowed"],
  ) => {
    uninstallProvider = installSessionPlacementAdmissionProvider({
      assertCompactionSuccessorAllowed: guard,
      executeLocalTurn,
      executeTurn: async (_claim, _params, runLocal) => await runLocal(),
    });
  };

  it("allows standalone acceptance only while its captured absence is unchanged", async () => {
    const assertion = captureSessionPlacementCompactionSuccessorAssertion();
    await Promise.resolve();
    expect(() => assertion(params)).not.toThrow();
  });

  it.each(["installed", "replaced", "removed"] as const)(
    "rejects a provider %s after capture without delegating to a new owner",
    async (change) => {
      const first = vi.fn();
      const second = vi.fn();
      if (change !== "installed") {
        install(first);
      }
      const assertion = captureSessionPlacementCompactionSuccessorAssertion();
      await Promise.resolve();
      if (change === "removed") {
        uninstallProvider?.();
        uninstallProvider = undefined;
      } else {
        install(second);
      }
      expect(() => assertion(params)).toThrow("session placement owner changed");
      expect(first).not.toHaveBeenCalled();
      expect(second).not.toHaveBeenCalled();
    },
  );

  it("rechecks the captured owner's current placement on every use", async () => {
    const denied = new Error("worker placement cannot rotate its session ID");
    let blocked = false;
    const guard = vi.fn(() => {
      if (blocked) {
        throw denied;
      }
    });
    install(guard);
    const assertion = captureSessionPlacementCompactionSuccessorAssertion();
    assertion(params);
    await Promise.resolve();
    blocked = true;
    expect(() => assertion(params)).toThrow(denied);
    expect(guard).toHaveBeenCalledTimes(2);
    expect(guard).toHaveBeenCalledWith(params);
  });
});

describe("local turn placement admission", () => {
  const turnParams = {
    admittedRunContext: createTestAdmittedRunContext("run-1"),
    sessionId: "session-1",
    sessionFile: "/tmp/session-1.jsonl",
    workspaceDir: "/tmp/workspace",
    prompt: "test",
    timeoutMs: 1_000,
    runId: "run-1",
  };

  it.each(["local CLI", "embedded"])(
    "queues a CLI follow-up until the active %s session turn releases its placement",
    async (runtime) => {
      const activeTurn = createDeferredCore();
      const turnStarted = createDeferredCore();
      const events: string[] = [];
      let active = false;
      const execute: SessionPlacementAdmissionProvider["executeLocalTurn"] = async (
        claim,
        task,
      ) => {
        if (active) {
          throw new Error("session already has an active turn claim");
        }
        active = true;
        events.push(`claim:${claim.runId}`);
        try {
          return await task();
        } finally {
          active = false;
          events.push(`release:${claim.runId}`);
        }
      };
      uninstallProvider = installSessionPlacementAdmissionProvider({
        assertCompactionSuccessorAllowed,
        executeLocalTurn: execute,
        executeTurn: async (claim, _params, task) => execute(claim, task),
      });
      const claim = { sessionId: "busy-session", sessionKey: "agent:main:busy", runId: "parent" };
      const parentTask = async () => {
        turnStarted.resolve();
        await activeTurn.promise;
        return { payloads: [{ text: "parent done" }], meta: { durationMs: 1 } };
      };
      const parent =
        runtime === "local CLI"
          ? withLocalSessionPlacementTurnSettlement(claim, parentTask)
          : enqueueCommandInLane("session:agent:main:busy", () =>
              withSessionPlacementTurnAdmission(claim, turnParams, parentTask),
            );
      await turnStarted.promise;
      const followup = withLocalSessionPlacementTurnSettlement(
        { ...claim, runId: "completion" },
        async () => ({ payloads: [{ text: "completion visible" }], meta: { durationMs: 1 } }),
      );
      const result = followup.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      try {
        activeTurn.resolve();
        await parent;
        expect(await result).toEqual({
          value: {
            payloads: [{ text: "completion visible" }],
            meta: { durationMs: 1 },
          },
        });
        expect(events).toEqual([
          "claim:parent",
          "release:parent",
          "claim:completion",
          "release:completion",
        ]);
      } finally {
        activeTurn.resolve();
        await Promise.allSettled([parent, followup]);
      }
    },
  );

  it.each([
    ["queued", "cancelled"],
    ["queued", "provider replaced"],
    ["queued", "lifecycle retired"],
    ["placement", "cancelled"],
    ["placement", "provider replaced"],
    ["placement", "lifecycle retired"],
  ] as const)("does not execute a %s CLI turn after it is %s", async (stage, change) => {
    const gate = createDeferredCore();
    const started = createDeferredCore();
    const abort = new AbortController();
    const task = vi.fn(async () => ({ meta: { durationMs: 1 } }));
    let claims = 0;
    const provider: SessionPlacementAdmissionProvider = {
      assertCompactionSuccessorAllowed,
      executeLocalTurn: async (_claim, runLocal) => {
        claims += 1;
        if (stage === "placement") {
          started.resolve();
          await gate.promise;
        }
        return runLocal();
      },
      executeTurn: async (_claim, _params, runLocal) => runLocal(),
    };
    uninstallProvider = installSessionPlacementAdmissionProvider(provider);
    const blocker =
      stage === "queued"
        ? enqueueCommandInLane("session:agent:main:fenced", async () => {
            started.resolve();
            await gate.promise;
          })
        : undefined;
    if (blocker) {
      await started.promise;
    }
    const run = withLocalSessionPlacementTurnSettlement(
      { sessionId: "fenced", sessionKey: "agent:main:fenced", runId: "fenced-run" },
      task,
      { abortSignal: abort.signal },
    );
    const result = run.then(
      () => undefined,
      (error: unknown) => error,
    );
    if (stage === "placement") {
      await started.promise;
    }
    if (change === "cancelled") {
      abort.abort(new Error("cancelled before admission"));
    } else if (change === "provider replaced") {
      uninstallProvider = installSessionPlacementAdmissionProvider({ ...provider });
    } else {
      rotateAgentEventLifecycleGeneration();
    }
    try {
      gate.resolve();
      expect(await result).toMatchObject({
        name: change === "cancelled" ? "Error" : "AbortError",
      });
      expect(task).not.toHaveBeenCalled();
      expect(claims).toBe(stage === "queued" ? 0 : 1);
    } finally {
      gate.resolve();
      await Promise.allSettled([blocker, run]);
    }
  });

  it("delegates the final turn decision to the installed provider", async () => {
    const events: string[] = [];
    settleRequesterAfterSessionSpawns.mockImplementation(() => {
      events.push("settle");
      return true;
    });
    uninstallProvider = installSessionPlacementAdmissionProvider({
      assertCompactionSuccessorAllowed,
      executeLocalTurn,
      executeTurn: async (claim, params, runLocal) => {
        events.push("claim");
        expect(claim).toEqual({
          sessionId: "session-1",
          sessionKey: "agent:main:main",
          runId: "run-1",
        });
        expect(params).toBe(turnParams);
        const result = await runLocal();
        events.push("release");
        return result;
      },
    });

    const result = await withSessionPlacementTurnAdmission(
      {
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        runId: "run-1",
      },
      turnParams,
      async () => {
        events.push("turn");
        return {
          acceptedSessionSpawns: [
            {
              runId: "child-run",
              childSessionKey: "agent:main:subagent:child",
              expectsCompletionMessage: true,
            },
          ],
          meta: {
            durationMs: 1,
            yielded: true,
            executionTrace: { runner: "cli", attempts: [], fallbackUsed: false },
          },
        };
      },
      () => events.push("admitted"),
    );

    expect(result.meta.durationMs).toBe(1);
    expect(events).toEqual(["claim", "admitted", "turn", "release", "settle"]);
  });

  it("does not start a local turn when the provider routes remotely", async () => {
    const turn = vi.fn(async () => ({ meta: { durationMs: 1 } }));
    const onAdmitted = vi.fn();
    const executeTurn = vi.fn<SessionPlacementAdmissionProvider["executeTurn"]>(
      async (_claim, _params, _runLocal, admitTurn) => {
        admitTurn?.();
        admitTurn?.();
        return {
          payloads: [{ text: "remote" }],
          meta: { durationMs: 2 },
        };
      },
    );
    uninstallProvider = installSessionPlacementAdmissionProvider({
      assertCompactionSuccessorAllowed,
      executeLocalTurn,
      executeTurn,
    });

    const result = await withSessionPlacementTurnAdmission(
      { sessionId: "session-2", runId: "run-2" },
      { ...turnParams, sessionId: "session-2", runId: "run-2" },
      turn,
      onAdmitted,
    );
    expect(result.payloads).toEqual([{ text: "remote" }]);
    expect(executeTurn).toHaveBeenCalledOnce();
    expect(executeTurn.mock.calls[0]?.[0]).toEqual({ sessionId: "session-2", runId: "run-2" });
    expect(onAdmitted).toHaveBeenCalledOnce();
    expect(turn).not.toHaveBeenCalled();
  });

  it("admits a provider-free local turn exactly once before execution", async () => {
    const events: string[] = [];
    await withSessionPlacementTurnAdmission(
      { sessionId: "session-direct", runId: "run-direct" },
      { ...turnParams, sessionId: "session-direct", runId: "run-direct" },
      async () => {
        events.push("turn");
        return { meta: { durationMs: 1 } };
      },
      () => events.push("admitted"),
    );

    expect(events).toEqual(["admitted", "turn"]);
  });

  it("admits once when a provider signals before calling the local turn", async () => {
    const events: string[] = [];
    uninstallProvider = installSessionPlacementAdmissionProvider({
      assertCompactionSuccessorAllowed,
      executeLocalTurn,
      executeTurn: async (_claim, _params, runLocal, admitTurn) => {
        admitTurn?.();
        return await runLocal();
      },
    });

    await withSessionPlacementTurnAdmission(
      { sessionId: "session-once", runId: "run-once" },
      { ...turnParams, sessionId: "session-once", runId: "run-once" },
      async () => {
        events.push("turn");
        return { meta: { durationMs: 1 } };
      },
      () => events.push("admitted"),
    );

    expect(events).toEqual(["admitted", "turn"]);
  });

  it("does not resurrect a replaced provider during uninstall", async () => {
    const firstClaim = vi.fn(
      async (_claim, _params, runLocal: () => Promise<{ meta: { durationMs: number } }>) =>
        await runLocal(),
    );
    const uninstallFirst = installSessionPlacementAdmissionProvider({
      assertCompactionSuccessorAllowed,
      executeLocalTurn,
      executeTurn: firstClaim,
    });
    const secondClaim = vi.fn(
      async (_claim, _params, runLocal: () => Promise<{ meta: { durationMs: number } }>) =>
        await runLocal(),
    );
    const uninstallSecond = installSessionPlacementAdmissionProvider({
      assertCompactionSuccessorAllowed,
      executeLocalTurn,
      executeTurn: secondClaim,
    });
    uninstallProvider = uninstallSecond;

    uninstallFirst();
    await withSessionPlacementTurnAdmission(
      { sessionId: "session-4", runId: "run-4" },
      { ...turnParams, sessionId: "session-4", runId: "run-4" },
      async () => ({ meta: { durationMs: 1 } }),
    );
    expect(firstClaim).not.toHaveBeenCalled();
    expect(secondClaim).toHaveBeenCalledOnce();

    uninstallSecond();
    uninstallProvider = undefined;
    await withSessionPlacementTurnAdmission(
      { sessionId: "session-5", runId: "run-5" },
      { ...turnParams, sessionId: "session-5", runId: "run-5" },
      async () => ({ meta: { durationMs: 1 } }),
    );
    expect(firstClaim).not.toHaveBeenCalled();
    expect(secondClaim).toHaveBeenCalledOnce();
  });

  it.each([true, false])(
    "acknowledges CLI continuation only after successful settlement (%s)",
    async (settled) => {
      settleRequesterAfterSessionSpawns.mockReturnValueOnce(settled).mockReturnValueOnce(false);
      const claim = {
        sessionId: "continuation",
        sessionKey: "agent:main:continuation",
        runId: "parent",
      };
      const result = await withLocalSessionPlacementTurnSettlement(claim, async () => ({
        acceptedSessionSpawns: [{ runId: "child", childSessionKey: "agent:main:subagent:child" }],
        meta: { durationMs: 1, yielded: true },
      }));
      expect(result.requesterContinuationSettled).toBe(settled ? true : undefined);
      const replay = await withLocalSessionPlacementTurnSettlement(claim, async () => result);
      expect(replay.requesterContinuationSettled).toBe(settled ? true : undefined);
    },
  );

  it("settles CLI child ownership only after local placement releases", async () => {
    const events: string[] = [];
    settleRequesterAfterSessionSpawns.mockImplementation(() => {
      events.push("settle");
      return true;
    });
    uninstallProvider = installSessionPlacementAdmissionProvider({
      assertCompactionSuccessorAllowed,
      async executeLocalTurn<T>(
        _claim: LocalTurnPlacementClaim,
        runLocal: () => Promise<T>,
      ): Promise<T> {
        events.push("claim");
        const result = await runLocal();
        events.push("release");
        return result;
      },
      executeTurn: async (_claim, _params, runLocal) => await runLocal(),
    });

    await withLocalSessionPlacementTurnSettlement(
      {
        sessionId: "session-cli",
        sessionKey: "agent:main:cli",
        agentId: "main",
        runId: "run-cli",
      },
      async () => {
        events.push("turn");
        return {
          acceptedSessionSpawns: [
            {
              runId: "child-run",
              childSessionKey: "agent:main:subagent:child",
              expectsCompletionMessage: true,
            },
          ],
          meta: { durationMs: 1, yielded: true },
        };
      },
    );

    expect(events).toEqual(["claim", "turn", "release", "settle"]);
  });

  it.each(["settled", "reset"] as const)(
    "closes a standalone CLI settlement assertion after its lane task is %s",
    async (ending) => {
      const sessionId = `standalone-${ending}`;
      const started = createDeferredCore();
      const release = createDeferredCore();
      let retained: (() => void) | undefined;
      const running = withLocalSessionPlacementTurnSettlement(
        { sessionId, runId: sessionId },
        async (assertCurrent) => {
          retained = assertCurrent;
          assertCurrent();
          started.resolve();
          await release.promise;
          return { meta: { durationMs: 1 } };
        },
      );
      await started.promise;
      try {
        if (ending === "reset") {
          expect(resetCommandLane(resolveSessionLane(sessionId))).toBe(1);
          await withLocalSessionPlacementTurnSettlement(
            { sessionId, runId: `${sessionId}-replacement` },
            async (assertCurrent) => {
              assertCurrent();
              return { meta: { durationMs: 1 } };
            },
          );
        } else {
          release.resolve();
          await running;
        }
        expect(retained).toBeDefined();
        expect(() => retained?.()).toThrow("settlement is closed");
      } finally {
        release.resolve();
        await running;
      }
    },
  );
});
