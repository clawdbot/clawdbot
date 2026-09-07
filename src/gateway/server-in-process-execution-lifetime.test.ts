import { setImmediate as nextTurn } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { AsyncWorkScope, getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getFreePort } from "../test-utils/ports.js";
import { createInternalAgentTurnFacade } from "./agent-turn/internal-facade.js";
import { withLocalGatewayRequestScope } from "./local-request-context.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import { dispatchGatewayRequestInProcessRaw } from "./server-in-process-dispatch.js";
import { createGatewayKernel } from "./server-kernel.js";
import type { GatewayRequestHandler } from "./server-methods/types.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";

describe("in-process Gateway original execution ownership", () => {
  it.for(["raw", "typed"] as const)(
    "rejects %s dispatch when its inherited execution scope is closed",
    async (surface) => {
      const state = await createOpenClawTestState({ label: `closed-local-${surface}-execution` });
      const scope = new AsyncWorkScope();
      const releaseCallback = createDeferred();
      let dispatch: Promise<unknown> | undefined;
      try {
        await scope.track(() => {
          // A callback retained by local work keeps its original async owner after drain.
          dispatch = releaseCallback.promise.then(() =>
            withLocalGatewayRequestScope({ deps: {}, getRuntimeConfig: () => ({}) }, () => {
              const context = getPluginRuntimeGatewayRequestScope()?.context;
              if (!context) {
                throw new Error("local Gateway context was not created");
              }
              const client = createSyntheticPluginRuntimeClient({ scopes: ["operator.admin"] });
              return surface === "raw"
                ? dispatchGatewayRequestInProcessRaw(
                    "agent.identity.get",
                    {},
                    {
                      client,
                      context,
                      timeoutMs: 1_000,
                    },
                  )
                : createInternalAgentTurnFacade({ client, getContext: () => context }).dispatchRaw(
                    { message: "refuse closed local work", idempotencyKey: "closed-local-work" },
                    { timeoutMs: 1_000 },
                  );
            }),
          );
        });
        await scope.drain();
        const rejected = expect(dispatch).rejects.toThrow("Async work scope is closed");
        releaseCallback.resolve();
        await rejected;
      } finally {
        releaseCallback.resolve();
        await Promise.allSettled([dispatch]);
        await scope.drain();
        await state.cleanup();
      }
    },
  );

  it.for(["raw", "typed"] as const)(
    "keeps %s execution alive after acceptance until its Gateway can release dependencies",
    async (surface, { signal }) => {
      const state = await createOpenClawTestState({
        label: `gateway-${surface}-execution`,
        env: {
          OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
          OPENCLAW_SKIP_CANVAS_HOST: "1",
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_SKIP_CRON: "1",
          OPENCLAW_SKIP_GMAIL_WATCHER: "1",
          OPENCLAW_SKIP_PROVIDERS: "1",
          OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
        },
      });
      const release = createDeferred();
      const drainEntered = createDeferred();
      const order: string[] = [];
      const originalCompletion = release.promise.then(() => {
        order.push("execution settled");
      });
      const unblock = () => release.resolve();
      signal.addEventListener("abort", unblock, { once: true });
      let kernel: Awaited<ReturnType<typeof createGatewayKernel>> | undefined;
      let closing: Promise<void> | undefined;
      let request: Promise<unknown> | undefined;
      try {
        const port = await getFreePort();
        const token = "gateway-in-process-execution-token";
        await state.writeConfig({ gateway: { auth: { mode: "token", token }, port } });
        kernel = await createGatewayKernel(port, {
          auth: { mode: "token", token },
          bind: "loopback",
          controlUiEnabled: false,
        });
        kernel.kernel.setDispatchReady(true);
        kernel.kernel.unlockStartupMethods();
        kernel.kernel.markSidecarsReady();
        const client = createSyntheticPluginRuntimeClient({ scopes: ["operator.admin"] });
        const methodRegistry = createGatewayMethodRegistry([
          {
            name: "lifetime.rawTail",
            owner: { kind: "aux", area: "gateway-lifetime-proof" },
            scope: "operator.admin",
            handler: async ({ respond }: Parameters<GatewayRequestHandler>[0]) => {
              respond(true, { status: "accepted", runId: "in-process-tail" });
              await originalCompletion;
            },
          },
        ]);
        const serviceModule = await import("./agent-turn/agent-turn-service.js");
        const createService = serviceModule.createAgentTurnService;
        if (surface === "typed") {
          vi.spyOn(serviceModule, "createAgentTurnService").mockImplementationOnce((...args) => {
            const service = createService(...args);
            vi.spyOn(service, "startTurn").mockImplementationOnce(async ({ io }) => {
              io.emitAcceptance([
                true,
                { status: "accepted", runId: "in-process-tail" },
                undefined,
              ]);
              await originalCompletion;
            });
            return service;
          });
        }
        // These public in-process entry points must acquire their owner without ambient WS work.
        expect(getAsyncWorkSignal()).toBeUndefined();
        request =
          surface === "raw"
            ? dispatchGatewayRequestInProcessRaw(
                "lifetime.rawTail",
                {},
                {
                  client,
                  context: kernel.gatewayRequestContext,
                  methodRegistry,
                },
              )
            : createInternalAgentTurnFacade({
                client,
                getContext: () => kernel!.gatewayRequestContext,
              }).dispatchRaw({
                message: "hold the original turn",
                idempotencyKey: "in-process-tail",
              });
        expect(await request).toMatchObject({
          ok: true,
          payload: { status: "accepted", runId: "in-process-tail" },
        });
        expect(order).toEqual([]);
        kernel.registerGatewayLifetimeSidecars([
          {
            stop: () => {
              order.push("dependencies stopped");
            },
          },
        ]);
        const drain = kernel.connectionWork.drain.bind(kernel.connectionWork);
        vi.spyOn(kernel.connectionWork, "drain").mockImplementationOnce(() => {
          const operation = drain();
          drainEntered.resolve();
          return operation;
        });
        closing = kernel.closeOnStartupFailure();
        await drainEntered.promise;
        await nextTurn();
        const beforeRelease = [...order];
        unblock();
        await originalCompletion;
        await closing;
        expect(beforeRelease).toEqual([]);
        expect(order).toEqual(["execution settled", "dependencies stopped"]);
      } finally {
        unblock();
        try {
          await Promise.allSettled([request, originalCompletion, closing]);
          await kernel?.closeOnStartupFailure();
          await state.cleanup();
        } finally {
          vi.restoreAllMocks();
          signal.removeEventListener("abort", unblock);
        }
      }
    },
  );
});
