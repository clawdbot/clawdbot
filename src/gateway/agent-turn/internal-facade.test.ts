import { beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchRestartRecoveryUntilStarted } from "../../agents/main-session-recovery/main-session-restart-dispatch-start.js";
import type { GatewayRecoveryRuntime } from "../server-instance-runtime.types.js";
import type { GatewayRequestContext } from "../server-methods/types.js";
import { createSyntheticPluginRuntimeClient } from "../server-plugin-runtime-client.js";
import { createInternalAgentTurnFacade } from "./internal-facade.js";

const { authorizeGatewayRequestPreDispatch, startTurn, waitForAgentTerminalDedupe, waitForTurn } =
  vi.hoisted(() => ({
    authorizeGatewayRequestPreDispatch: vi.fn(),
    startTurn: vi.fn(),
    waitForAgentTerminalDedupe: vi.fn(),
    waitForTurn: vi.fn(),
  }));

vi.mock("./agent-job.js", () => ({
  waitForAgentTerminalDedupe,
}));

vi.mock("../server-methods.js", () => ({
  authorizeGatewayRequestPreDispatch,
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

function createFacade(
  options: {
    assertContextCurrent?: () => void;
    getContext?: () => GatewayRequestContext;
  } = {},
) {
  return createInternalAgentTurnFacade({
    assertContextCurrent: options.assertContextCurrent,
    client: createSyntheticPluginRuntimeClient(),
    getContext:
      options.getContext ??
      (() =>
        ({
          dedupe: new Map(),
          chatAbortControllers: new Map(),
          getRuntimeConfig: () => ({}),
          logGateway: { error: vi.fn(), warn: vi.fn() },
        }) as unknown as GatewayRequestContext),
  });
}

describe("createInternalAgentTurnFacade", () => {
  beforeEach(() => {
    authorizeGatewayRequestPreDispatch.mockReset();
    authorizeGatewayRequestPreDispatch.mockResolvedValue({ error: null });
    startTurn.mockReset();
    waitForAgentTerminalDedupe.mockReset();
    waitForAgentTerminalDedupe.mockResolvedValue({ status: "ok" });
    waitForTurn.mockReset();
  });

  it("rejects agent.wait when authorization retires its captured context", async () => {
    let releaseAuthorization!: (result: { error: null }) => void;
    authorizeGatewayRequestPreDispatch.mockImplementationOnce(
      async () =>
        await new Promise<{ error: null }>((resolve) => {
          releaseAuthorization = resolve;
        }),
    );
    let contextCurrent = true;
    const assertContextCurrent = vi.fn(() => {
      if (!contextCurrent) {
        throw new Error("retired gateway context");
      }
    });
    const result = createFacade({ assertContextCurrent }).wait({
      runId: "run-retired-during-auth",
    });

    await vi.waitFor(() => expect(releaseAuthorization).toBeTypeOf("function"));
    contextCurrent = false;
    releaseAuthorization({ error: null });

    await expect(result).rejects.toThrow("retired gateway context");
    expect(waitForTurn).not.toHaveBeenCalled();
  });

  it.each([
    {
      method: "agent",
      invoke: () =>
        createFacade().dispatchRaw(
          { message: "test", idempotencyKey: "run-authorization-timeout" },
          { timeoutMs: 1_000 },
        ),
      work: startTurn,
    },
    {
      method: "agent.wait",
      invoke: () => createFacade().wait({ runId: "run-wait-authorization-timeout" }, 1_000),
      work: waitForTurn,
    },
  ])("rejects $method before work when authorization exhausts its deadline", async (testCase) => {
    vi.useFakeTimers();
    authorizeGatewayRequestPreDispatch.mockImplementationOnce(
      async () => await new Promise<never>(() => {}),
    );

    try {
      let settled = false;
      const outcome = testCase
        .invoke()
        .then(
          () => ({ status: "resolved" as const }),
          (error: unknown) => ({ error, status: "rejected" as const }),
        )
        .finally(() => {
          settled = true;
        });
      expect(authorizeGatewayRequestPreDispatch).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(1_000);

      expect(settled).toBe(true);
      await expect(outcome).resolves.toMatchObject({
        status: "rejected",
        error: { message: `gateway request timeout for ${testCase.method}` },
      });
      expect(testCase.work).not.toHaveBeenCalled();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it.each([
    {
      method: "agent",
      invoke: () =>
        createFacade().dispatchRaw(
          { message: "test", idempotencyKey: "run-authorization-at-deadline" },
          { timeoutMs: 1_000 },
        ),
      work: startTurn,
    },
    {
      method: "agent.wait",
      invoke: () => createFacade().wait({ runId: "run-wait-authorization-at-deadline" }, 1_000),
      work: waitForTurn,
    },
  ])("rejects $method when authorization resolves at its deadline", async (testCase) => {
    vi.useFakeTimers();
    authorizeGatewayRequestPreDispatch.mockImplementationOnce(
      async () =>
        await new Promise<{ error: null }>((resolve) => {
          setTimeout(() => resolve({ error: null }), 1_000);
        }),
    );

    try {
      const outcome = testCase.invoke().then(
        () => ({ status: "resolved" as const }),
        (error: unknown) => ({ error, status: "rejected" as const }),
      );

      await vi.advanceTimersByTimeAsync(1_000);

      await expect(outcome).resolves.toMatchObject({
        status: "rejected",
        error: { message: `gateway request timeout for ${testCase.method}` },
      });
      expect(testCase.work).not.toHaveBeenCalled();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("rejects agent.wait when its context retires while the wait is pending", async () => {
    let releaseWait!: (result: { runId: string; status: "ok" }) => void;
    waitForTurn.mockImplementationOnce(
      async () =>
        await new Promise<{ runId: string; status: "ok" }>((resolve) => {
          releaseWait = resolve;
        }),
    );
    let contextCurrent = true;
    const assertContextCurrent = vi.fn(() => {
      if (!contextCurrent) {
        throw new Error("retired gateway context");
      }
    });
    const result = createFacade({ assertContextCurrent }).wait({
      runId: "run-retired-during-wait",
    });

    await vi.waitFor(() => expect(waitForTurn).toHaveBeenCalledOnce());
    contextCurrent = false;
    releaseWait({ runId: "run-retired-during-wait", status: "ok" });

    await expect(result).rejects.toThrow("retired gateway context");
    expect(assertContextCurrent).toHaveBeenCalledTimes(2);
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

  it("uses one timeout across acceptance and final response", async () => {
    vi.useFakeTimers();
    startTurn.mockImplementation(
      async ({ io }) =>
        await new Promise<void>((resolve) => {
          setTimeout(() => {
            io.emitAcceptance([true, { runId: "run-deadline", status: "accepted" }, undefined]);
            setTimeout(() => {
              io.emitFinal([true, { runId: "run-deadline", status: "ok" }, undefined]);
              resolve();
            }, 600);
          }, 600);
        }),
    );

    try {
      let settled = false;
      const outcome = createFacade()
        .dispatchRaw(
          { message: "test", idempotencyKey: "run-deadline" },
          { expectFinal: true, timeoutMs: 1_000 },
        )
        .then(
          () => ({ status: "resolved" as const }),
          (error: unknown) => ({ error, status: "rejected" as const }),
        )
        .finally(() => {
          settled = true;
        });

      await vi.advanceTimersByTimeAsync(1_000);

      expect(settled).toBe(true);
      await expect(outcome).resolves.toMatchObject({
        status: "rejected",
        error: { message: "gateway request timeout for agent" },
      });
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
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
    let releaseTerminalDedupe!: (result: { status: "ok" }) => void;
    waitForAgentTerminalDedupe.mockImplementationOnce(
      async () =>
        await new Promise<{ status: "ok" }>((resolve) => {
          releaseTerminalDedupe = resolve;
        }),
    );

    const result = createFacade().dispatchRaw(
      { message: "test", idempotencyKey: "same-request" },
      { expectFinal: true, timeoutMs: 1_000 },
    );
    await vi.waitFor(() => expect(waitForAgentTerminalDedupe).toHaveBeenCalledOnce());
    expect(startTurn).toHaveBeenCalledOnce();
    releaseTerminalDedupe({ status: "ok" });

    await expect(result).resolves.toMatchObject({
      ok: true,
      payload: { runId: "run-replay", status: "ok", result: terminalResult },
    });
    const waitTimeoutMs = waitForTurn.mock.calls[0]?.[0].timeoutMs;
    expect(waitTimeoutMs).toBeGreaterThan(0);
    expect(waitTimeoutMs).toBeLessThanOrEqual(1_000);
    expect(startTurn).toHaveBeenCalledTimes(2);
    expect(startTurn.mock.calls.map(([call]) => call.preflight.request.idempotencyKey)).toEqual([
      "same-request",
      "same-request",
    ]);
  });

  it("keeps terminal dedupe replay within the original timeout", async () => {
    vi.useFakeTimers();
    startTurn
      .mockImplementationOnce(async ({ io }) => {
        io.emitAcceptance([true, { runId: "run-replay", status: "in_flight" }, undefined]);
      })
      .mockImplementationOnce(
        async ({ io }) =>
          await new Promise<void>((resolve) => {
            setTimeout(() => {
              io.emitAcceptance([true, { runId: "run-replay", status: "ok" }, undefined]);
              resolve();
            }, 500);
          }),
      );
    waitForTurn.mockImplementation(
      async () =>
        await new Promise((resolve) => {
          setTimeout(() => resolve({ runId: "run-replay", status: "ok" }), 600);
        }),
    );

    try {
      let settled = false;
      const outcome = createFacade()
        .dispatchRaw(
          { message: "test", idempotencyKey: "same-request" },
          { expectFinal: true, timeoutMs: 1_000 },
        )
        .then(
          () => ({ status: "resolved" as const }),
          (error: unknown) => ({ error, status: "rejected" as const }),
        )
        .finally(() => {
          settled = true;
        });

      await vi.advanceTimersByTimeAsync(1_000);

      expect(settled).toBe(true);
      await expect(outcome).resolves.toMatchObject({
        status: "rejected",
        error: { message: "gateway request timeout for agent" },
      });
      expect(startTurn).toHaveBeenCalledTimes(2);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("rejects when terminal dedupe readiness expires", async () => {
    vi.useFakeTimers();
    startTurn.mockImplementation(async ({ io }) => {
      io.emitAcceptance([true, { runId: "run-readiness-timeout", status: "in_flight" }, undefined]);
    });
    waitForTurn.mockResolvedValue({ runId: "run-readiness-timeout", status: "ok" });
    waitForAgentTerminalDedupe.mockImplementationOnce(
      async ({ timeoutMs }: { timeoutMs: number }) =>
        await new Promise<null>((resolve) => {
          setTimeout(() => resolve(null), timeoutMs);
        }),
    );

    try {
      const outcome = createFacade()
        .dispatchRaw(
          { message: "test", idempotencyKey: "readiness-timeout" },
          { expectFinal: true },
        )
        .then(
          () => ({ status: "resolved" as const }),
          (error: unknown) => ({ error, status: "rejected" as const }),
        );
      await vi.waitFor(() => expect(waitForAgentTerminalDedupe).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(30_000);

      await expect(outcome).resolves.toMatchObject({
        status: "rejected",
        error: { message: "gateway request timeout for agent" },
      });
      expect(startTurn).toHaveBeenCalledOnce();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
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
