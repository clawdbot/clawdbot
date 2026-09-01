import { afterEach, describe, expect, it, vi } from "vitest";

const settleRequesterAfterSessionSpawns = vi.hoisted(() => vi.fn(() => true));
vi.mock("./subagents/registry/subagent-registry.js", () => ({
  settleRequesterAfterSessionSpawns,
}));

import { createTestAdmittedRunContext } from "./admitted-run-context.test-support.js";
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
});
