import { beforeEach, describe, expect, it, vi } from "vitest";
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

function createFacade() {
  return createInternalAgentTurnFacade({
    client: createSyntheticPluginRuntimeClient(),
    getContext: () =>
      ({
        dedupe: new Map(),
        getRuntimeConfig: () => ({}),
        logGateway: { error: vi.fn(), warn: vi.fn() },
      }) as unknown as GatewayRequestContext,
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
});
