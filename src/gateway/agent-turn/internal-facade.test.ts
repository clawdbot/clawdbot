import { beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchRestartRecoveryUntilStarted } from "../../agents/main-session-recovery/main-session-restart-dispatch-start.js";
import type { GatewayRecoveryRuntime } from "../server-instance-runtime.types.js";
import type { GatewayRequestContext } from "../server-methods/types.js";
import { createSyntheticPluginRuntimeClient } from "../server-plugin-runtime-client.js";
import { createInternalAgentTurnFacade } from "./internal-facade.js";

const { startTurn, waitForTurn } = vi.hoisted(() => ({
  startTurn: vi.fn(),
  waitForTurn: vi.fn(),
}));

vi.mock("../server-methods.js", () => ({
  authorizeGatewayRequestPreDispatch: async () => ({ error: null }),
  createRequestGatewayMethodRegistry: () => ({
    isControlPlaneWrite: () => false,
  }),
  runWithGatewayRequestEnvelope: async (
    _method: string,
    _client: unknown,
    run: () => Promise<unknown>,
  ) => await run(),
}));

vi.mock("./agent-request-preflight.js", () => ({
  prepareAgentRequestPreflight: ({ request }: { request: unknown }) => ({ request }),
}));

vi.mock("./agent-turn-service.js", () => ({
  createAgentTurnService: () => ({
    startTurn,
    waitForTurn,
  }),
}));

function createFacade() {
  return createInternalAgentTurnFacade({
    client: createSyntheticPluginRuntimeClient(),
    getContext: () =>
      ({
        dedupe: new Map(),
        chatAbortControllers: new Map(),
        getRuntimeConfig: () => ({}),
        logGateway: { error: vi.fn(), warn: vi.fn() },
      }) as unknown as GatewayRequestContext,
  });
}

describe("createInternalAgentTurnFacade", () => {
  beforeEach(() => {
    startTurn.mockReset();
    waitForTurn.mockReset();
  });

  it("preserves accepted/final ordering and acceptance metadata without frames", async () => {
    let emitFinal!: () => void;
    const finalGate = new Promise<void>((resolve) => {
      emitFinal = resolve;
    });
    startTurn.mockImplementation(async ({ io }) => {
      io.emitAcceptance([true, { runId: "run-1", status: "accepted" }, undefined], {
        runId: "run-1",
      });
      await finalGate;
      io.emitFinal([true, { runId: "run-1", status: "ok", summary: "done" }, undefined], {
        runId: "run-1",
        terminal: true,
      });
    });
    const onAccepted = vi.fn();

    const result = createFacade().dispatchRaw(
      { message: "test", idempotencyKey: "run-1" },
      { expectFinal: true, onAccepted },
    );
    await vi.waitFor(() =>
      expect(onAccepted).toHaveBeenCalledWith({
        runId: "run-1",
        status: "accepted",
      }),
    );
    emitFinal();

    await expect(result).resolves.toEqual({
      ok: true,
      payload: { runId: "run-1", status: "ok", summary: "done" },
      error: undefined,
      meta: { runId: "run-1", terminal: true },
    });
  });

  it("preserves post-acceptance Error identity", async () => {
    let rejectTurn!: (error: Error) => void;
    startTurn.mockImplementation(
      ({ io }) =>
        new Promise<void>((_resolve, reject) => {
          io.emitAcceptance([true, { runId: "run-error", status: "accepted" }, undefined]);
          rejectTurn = reject;
        }),
    );
    const dispatchError = Object.assign(new Error("turn failed"), { code: "ETURN" });
    const result = createFacade().dispatchRaw(
      { message: "test", idempotencyKey: "run-error" },
      { expectFinal: true },
    );
    await vi.waitFor(() => expect(rejectTurn).toBeTypeOf("function"));

    rejectTurn(dispatchError);

    await expect(result).rejects.toBe(dispatchError);
  });

  it("returns a single acceptance with its metadata when no final is requested", async () => {
    startTurn.mockImplementation(async ({ io }) => {
      io.emitAcceptance([true, { runId: "run-2", status: "in_flight" }, undefined], {
        cached: true,
        runId: "run-2",
      });
    });

    await expect(
      createFacade().dispatchRaw({ message: "test", idempotencyKey: "run-2" }),
    ).resolves.toEqual({
      ok: true,
      payload: { runId: "run-2", status: "in_flight" },
      error: undefined,
      meta: { cached: true, runId: "run-2" },
    });
  });

  it("reattaches an in-flight replay and returns its full terminal dedupe result", async () => {
    const terminalResult = {
      payloads: [],
      meta: { yielded: true },
      acceptedSessionSpawns: [{ runId: "run-child", childSessionKey: "agent:main:subagent:child" }],
    };
    startTurn
      .mockImplementationOnce(async ({ io }) => {
        io.emitAcceptance([true, { runId: "run-replay", status: "in_flight" }, undefined], {
          cached: true,
          runId: "run-replay",
        });
      })
      .mockImplementationOnce(async ({ io }) => {
        io.emitAcceptance([
          true,
          { runId: "run-replay", status: "ok", result: terminalResult },
          undefined,
        ]);
      });
    waitForTurn.mockResolvedValue({ runId: "run-replay", status: "ok" });

    await expect(
      createFacade().dispatchRaw(
        { message: "test", idempotencyKey: "same-request" },
        { expectFinal: true, timeoutMs: 1_000 },
      ),
    ).resolves.toMatchObject({
      ok: true,
      payload: { runId: "run-replay", status: "ok", result: terminalResult },
    });
    expect(waitForTurn).toHaveBeenCalledWith({ runId: "run-replay", timeoutMs: 1_000 });
    expect(startTurn).toHaveBeenCalledTimes(2);
    expect(startTurn.mock.calls.map(([call]) => call.preflight.request.idempotencyKey)).toEqual([
      "same-request",
      "same-request",
    ]);
  });

  it("keeps a cached replay in flight when the wait reaches a nonterminal timeout", async () => {
    startTurn.mockImplementation(async ({ io }) => {
      io.emitAcceptance([true, { runId: "run-pending", status: "in_flight" }, undefined], {
        cached: true,
        runId: "run-pending",
      });
    });
    waitForTurn.mockResolvedValue({
      runId: "run-pending",
      status: "timeout",
      timeoutPhase: "gateway_draining",
    });
    const onAccepted = vi.fn();

    await expect(
      createFacade().dispatchRaw(
        { message: "test", idempotencyKey: "same-pending-request" },
        { expectFinal: true, onAccepted, timeoutMs: 1_000 },
      ),
    ).resolves.toMatchObject({
      ok: true,
      payload: { runId: "run-pending", status: "in_flight" },
    });
    expect(onAccepted).toHaveBeenCalledWith({ runId: "run-pending", status: "in_flight" });
    expect(startTurn).toHaveBeenCalledOnce();
  });

  it("lets restart recovery abort the exact cached run before reattachment completes", async () => {
    vi.useFakeTimers();
    startTurn.mockImplementation(async ({ io }) => {
      io.emitAcceptance([true, { runId: "recovery-cached", status: "in_flight" }, undefined], {
        cached: true,
        runId: "recovery-cached",
      });
    });
    waitForTurn.mockImplementation(async () => await new Promise<never>(() => {}));
    const facade = createFacade();
    const abortAgent = vi.fn<GatewayRecoveryRuntime["abortAgent"]>(async () => ({
      aborted: true,
    }));
    const gatewayRuntime: GatewayRecoveryRuntime = {
      abortAgent,
      dispatchAgent: async (request, timeoutMs, options) =>
        await facade.dispatch(request, {
          expectFinal: options?.expectFinal,
          onAccepted: options?.onAccepted,
          onExecutionStarted: options?.onExecutionStarted,
          onSignalAbort: options?.onSignalAbort,
          signal: options?.signal,
          timeoutMs,
        }),
      waitForAgent: vi.fn(),
      sendRecoveryNotice: vi.fn(),
    };

    try {
      const outcome = dispatchRestartRecoveryUntilStarted({
        agentId: "main",
        agentParams: {
          agentId: "main",
          idempotencyKey: "recovery-cached",
          message: "resume",
          sessionKey: "agent:main:main",
        },
        gatewayRuntime,
        recoveryRunId: "recovery-cached",
        sessionKey: "agent:main:main",
      });

      await vi.waitFor(() => expect(startTurn).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(10_000);

      await expect(outcome).resolves.toMatchObject({
        kind: "failed",
        observation: {
          dispatchAccepted: true,
          executionStarted: false,
          preStartAbortAttempted: true,
          preStartAbortConfirmed: true,
        },
      });
      expect(abortAgent).toHaveBeenCalledWith(
        {
          agentId: "main",
          runId: "recovery-cached",
          sessionKey: "agent:main:main",
        },
        2_000,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes the exact internal execution-start observer to the turn", async () => {
    const onExecutionStarted = vi.fn();
    startTurn.mockImplementation(async ({ io }) => {
      expect(io.emitExecutionStarted).toBe(onExecutionStarted);
      io.emitAcceptance([true, { runId: "run-started", status: "accepted" }, undefined]);
      io.emitExecutionStarted?.();
    });

    await expect(
      createFacade().dispatchRaw(
        { message: "test", idempotencyKey: "run-started" },
        { onExecutionStarted },
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(onExecutionStarted).toHaveBeenCalledOnce();
  });
});
