import { afterEach, describe, expect, it, vi } from "vitest";
import { WRITE_SCOPE } from "../../../gateway/method-scopes.js";
import { createGatewayMethodRegistry } from "../../../gateway/methods/registry.js";
import { createGatewayInstanceRuntime } from "../../../gateway/server-instance-runtime.js";
import type {
  GatewayRequestContext,
  GatewayRequestHandlers,
} from "../../../gateway/server-methods/types.js";
import { dispatchSubagentAnnounceAgent } from "./subagent-announce-delivery.runtime.js";

function createContext(): GatewayRequestContext {
  return {
    deps: {},
    getRuntimeConfig: () => ({}),
    logGateway: {
      warn: vi.fn(),
      error: vi.fn(),
    },
    chatAbortControllers: new Map(),
    chatQueuedTurns: new Map(),
    dedupe: new Map(),
  } as unknown as GatewayRequestContext;
}

function createRegistry(handlers: GatewayRequestHandlers) {
  return createGatewayMethodRegistry(
    Object.entries(handlers).map(([name, handler]) => ({
      name,
      handler,
      owner: { kind: "core" as const, area: "test" },
      scope: WRITE_SCOPE,
    })),
  );
}

describe("subagent announce Gateway instance dispatch", () => {
  let closeRuntime: (() => void) | undefined;

  afterEach(() => {
    closeRuntime?.();
    closeRuntime = undefined;
  });

  it("delivers a detached announce after the originating request scope has ended", async () => {
    const context = createContext();
    const idempotencyKey = "detached-subagent-announce";
    context.dedupe.set(`agent:${idempotencyKey}`, {
      ts: Date.now(),
      ok: true,
      payload: { runId: "announce-run", status: "ok", summary: "delivered" },
    });
    const runtime = createGatewayInstanceRuntime({
      getContext: () => context,
      getMethodRegistry: () =>
        createRegistry({
          agent: ({ respond }) => respond(true, { raw: true }),
        }),
      isDispatchAvailable: () => true,
    });
    closeRuntime = runtime.close;

    await expect(
      dispatchSubagentAnnounceAgent(
        {
          message: "Process one completed child result.",
          idempotencyKey,
        },
        { expectFinal: true, forceSyntheticClient: true },
      ),
    ).resolves.toEqual({ runId: "announce-run", status: "ok", summary: "delivered" });
  });
});
