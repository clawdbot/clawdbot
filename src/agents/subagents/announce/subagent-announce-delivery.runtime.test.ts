import { describe, expect, it, vi } from "vitest";
import { WRITE_SCOPE } from "../../../gateway/method-scopes.js";
import { createGatewayMethodRegistry } from "../../../gateway/methods/registry.js";
import type {
  GatewayRequestContext,
  GatewayRequestHandlers,
} from "../../../gateway/server-methods/types.js";
import { withPluginRuntimeGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import { dispatchSubagentAnnounceAgent } from "./subagent-announce-delivery.runtime.js";

function createContext(handlers: GatewayRequestHandlers): GatewayRequestContext {
  return {
    deps: {},
    getRuntimeConfig: () => ({}),
    getGatewayMethodRegistry: () => createRegistry(handlers),
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
  it("delivers a detached announce through its explicit instance resolver", async () => {
    const context = createContext({
      agent: ({ respond }) => respond(true, { raw: true }),
    });
    const idempotencyKey = "detached-subagent-announce";
    context.dedupe.set(`agent:${idempotencyKey}`, {
      ts: Date.now(),
      ok: true,
      payload: { runId: "announce-run", status: "ok", summary: "delivered" },
    });

    await expect(
      dispatchSubagentAnnounceAgent(
        {
          message: "Process one completed child result.",
          idempotencyKey,
        },
        {
          expectFinal: true,
          forceSyntheticClient: true,
          resolveGatewayContext: () => context,
        },
      ),
    ).resolves.toEqual({ runId: "announce-run", status: "ok", summary: "delivered" });
  });

  it("delivers through a lifecycle-fenced instance resolver scope", async () => {
    const context = createContext({
      agent: ({ respond }) => respond(true, { raw: true }),
    });
    const idempotencyKey = "scoped-subagent-announce";
    context.dedupe.set(`agent:${idempotencyKey}`, {
      ts: Date.now(),
      ok: true,
      payload: { runId: "scoped-announce-run", status: "ok", summary: "delivered" },
    });

    await expect(
      withPluginRuntimeGatewayContextResolver(
        () => context,
        () =>
          dispatchSubagentAnnounceAgent(
            {
              message: "Process one completed child result.",
              idempotencyKey,
            },
            {
              expectFinal: true,
              forceSyntheticClient: true,
            },
          ),
      ),
    ).resolves.toEqual({
      runId: "scoped-announce-run",
      status: "ok",
      summary: "delivered",
    });
  });
});
