import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerChatAbortController } from "../chat-abort.js";
import { createChatRunState } from "../server-chat-state.js";
import type { GatewayRequestContext } from "../server-methods/types.js";
import { createSyntheticPluginRuntimeClient } from "../server-plugin-runtime-client.js";
import { createInternalAgentTurnFacade } from "./internal-facade.js";

const startTurn = vi.hoisted(() => vi.fn());

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
    waitForTurn: vi.fn(),
  }),
}));

function createContext() {
  return Object.assign({} as GatewayRequestContext, {
    agentRunSeq: new Map(),
    broadcast: vi.fn(),
    chatAbortControllers: new Map(),
    chatRunState: createChatRunState(),
    dedupe: new Map(),
    getRuntimeConfig: () => ({}),
    logGateway: { error: vi.fn(), warn: vi.fn() },
    nodeSendToSession: vi.fn(),
    removeChatRun: vi.fn(() => undefined),
  });
}

function createFacade(context = createContext()) {
  return createInternalAgentTurnFacade({
    client: createSyntheticPluginRuntimeClient(),
    getContext: () => context,
  });
}

describe("createInternalAgentTurnFacade", () => {
  beforeEach(() => {
    startTurn.mockReset();
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

  it("cancels only the accepted run when its opted-in dispatch deadline expires", async () => {
    vi.useFakeTimers();
    const context = createContext();
    const unrelated = registerChatAbortController({
      chatAbortControllers: context.chatAbortControllers,
      runId: "unrelated-run",
      sessionId: "unrelated-session",
      sessionKey: "agent:main:unrelated",
      timeoutMs: 60_000,
      kind: "agent",
    });
    let accepted: ReturnType<typeof registerChatAbortController> | undefined;
    startTurn.mockImplementation(async ({ io }) => {
      const registration = registerChatAbortController({
        chatAbortControllers: context.chatAbortControllers,
        runId: "deadline-run",
        sessionId: "deadline-session",
        sessionKey: "agent:main:deadline",
        timeoutMs: 60_000,
        kind: "agent",
      });
      accepted = registration;
      io.emitAcceptance([true, { runId: "deadline-run", status: "accepted" }, undefined], {
        runId: "deadline-run",
      });
      await new Promise<void>((_resolve, reject) => {
        registration.controller.signal.addEventListener(
          "abort",
          () => reject(new Error("deadline run aborted")),
          { once: true },
        );
      });
    });

    try {
      const result = createFacade(context).dispatchRaw(
        {
          message: "settle requester",
          sessionKey: "agent:main:deadline",
          idempotencyKey: "deadline-run",
        },
        { cancelOnDeadline: true, expectFinal: true, timeoutMs: 20 },
      );
      const outcome = expect(result).rejects.toThrow("gateway request timeout for agent");
      await vi.advanceTimersByTimeAsync(20);

      await outcome;
      expect(accepted?.controller.signal.aborted).toBe(true);
      expect(unrelated.controller.signal.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a run accepted after its opted-in dispatch deadline", async () => {
    vi.useFakeTimers();
    const context = createContext();
    let accept!: () => void;
    const acceptanceGate = new Promise<void>((resolve) => {
      accept = resolve;
    });
    let accepted: ReturnType<typeof registerChatAbortController> | undefined;
    startTurn.mockImplementation(async ({ io }) => {
      await acceptanceGate;
      accepted = registerChatAbortController({
        chatAbortControllers: context.chatAbortControllers,
        runId: "late-run",
        sessionId: "late-session",
        sessionKey: "agent:main:late",
        timeoutMs: 60_000,
        kind: "agent",
      });
      io.emitAcceptance([true, { runId: "late-run", status: "accepted" }, undefined], {
        runId: "late-run",
      });
    });

    try {
      const result = createFacade(context).dispatchRaw(
        {
          message: "settle requester",
          sessionKey: "agent:main:late",
          idempotencyKey: "late-run",
        },
        { cancelOnDeadline: true, expectFinal: true, timeoutMs: 20 },
      );
      const outcome = expect(result).rejects.toThrow("gateway request timeout for agent");
      await vi.advanceTimersByTimeAsync(20);
      await outcome;

      accept();
      await vi.advanceTimersByTimeAsync(0);
      expect(accepted?.controller.signal.aborted).toBe(true);
    } finally {
      accept();
      vi.useRealTimers();
    }
  });
});
