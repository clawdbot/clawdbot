import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestAdmittedRunContext } from "./admitted-run-context.test-support.js";
import {
  installSessionPlacementAdmissionProvider,
  type LocalTurnPlacementClaim,
  type SessionPlacementAdmissionProvider,
  withLocalSessionPlacementTurnAdmission,
  withSessionPlacementTurnAdmission,
} from "./session-placement-admission.js";

let uninstallProvider: (() => void) | undefined;
const executeLocalTurn: SessionPlacementAdmissionProvider["executeLocalTurn"] = async (
  _claim,
  runLocal,
) => await runLocal();

afterEach(() => {
  uninstallProvider?.();
  uninstallProvider = undefined;
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
    uninstallProvider = installSessionPlacementAdmissionProvider({
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
        return { meta: { durationMs: 1 } };
      },
      () => events.push("admitted"),
    );

    expect(result.meta.durationMs).toBe(1);
    expect(events).toEqual(["claim", "admitted", "turn", "release"]);
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
      executeLocalTurn,
      executeTurn: firstClaim,
    });
    const secondClaim = vi.fn(
      async (_claim, _params, runLocal: () => Promise<{ meta: { durationMs: number } }>) =>
        await runLocal(),
    );
    const uninstallSecond = installSessionPlacementAdmissionProvider({
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

  it("delegates generic local execution through the placement gate", async () => {
    const events: string[] = [];
    uninstallProvider = installSessionPlacementAdmissionProvider({
      async executeLocalTurn<T>(
        claim: LocalTurnPlacementClaim,
        runLocal: () => Promise<T>,
      ): Promise<T> {
        events.push("claim");
        expect(claim).toEqual({
          sessionId: "session-cli",
          sessionKey: "agent:main:cli",
          agentId: "main",
          runId: "run-cli",
        });
        const result = await runLocal();
        events.push("release");
        return result;
      },
      executeTurn: async (_claim, _params, runLocal) => await runLocal(),
    });

    const result = await withLocalSessionPlacementTurnAdmission(
      {
        sessionId: "session-cli",
        sessionKey: "agent:main:cli",
        agentId: "main",
        runId: "run-cli",
      },
      async () => {
        events.push("turn");
        return { kind: "cli", code: 0 } as const;
      },
    );

    expect(result).toEqual({ kind: "cli", code: 0 });
    expect(events).toEqual(["claim", "turn", "release"]);
  });
});
