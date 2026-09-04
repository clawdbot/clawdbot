import { EventEmitter } from "node:events";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getFreePort } from "../test-utils/ports.js";
import { createInternalAgentTurnFacade } from "./agent-turn/internal-facade.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import { NodeRegistry } from "./node-registry.js";
import { dispatchGatewayRequestInProcessRaw } from "./server-in-process-dispatch.js";
import { createGatewayKernel } from "./server-kernel.js";
import { createLazyCoreHandlers } from "./server-methods/lazy-core-handlers.js";
import type { GatewayRequestHandler } from "./server-methods/types.js";
import {
  createDispatchTestHarness,
  createOperatorWsClient,
} from "./server/ws-connection/authenticated-request-dispatch.test-support.js";

const boundaries = vi.hoisted(() => ({
  router: vi.fn<() => Promise<void>>(),
  start: vi.fn<() => Promise<void>>(),
}));

vi.mock(
  "./server/ws-connection/authenticated-request-dispatch.server-methods.runtime.js",
  async () => {
    await boundaries.router();
    return await import("./server-methods.js");
  },
);
vi.mock("./server/ws-connection/request-start.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./server/ws-connection/request-start.js")>();
  return {
    ...actual,
    scheduleGatewayRequestStart: (bytes: number) => {
      const started = actual.scheduleGatewayRequestStart(bytes);
      return started?.then(() => boundaries.start()) ?? null;
    },
  };
});

describe.sequential("Gateway request entry lifetime", () => {
  let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
  let kernel: Awaited<ReturnType<typeof createGatewayKernel>>;
  let port: number;

  beforeAll(async () => {
    state = await createOpenClawTestState({
      label: "gateway-request-entry",
      layout: "home",
      env: {
        OPENCLAW_GATEWAY_PASSWORD: undefined,
        OPENCLAW_GATEWAY_TOKEN: undefined,
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
        VITEST: "1",
      },
    });
    port = await getFreePort();
    await state.writeConfig({
      gateway: {
        auth: { mode: "token", token: "request-entry-test" },
        controlUi: { enabled: false },
        port,
      },
    });
    state.applyEnv();
  });
  beforeEach(async () => {
    boundaries.router.mockReset();
    boundaries.start.mockReset();
    kernel = await createGatewayKernel(port, {
      auth: { mode: "token", token: "request-entry-test" },
      bind: "loopback",
      controlUiEnabled: false,
      sidecarStartup: "defer",
    });
    kernel.kernel.setDispatchReady(true);
  });
  afterEach(async () => {
    await kernel?.closeOnStartupFailure();
  });
  afterAll(async () => {
    await state?.cleanup();
  });

  it.each(["router", "start", "profile", "family", "family rejection", "nested family"] as const)(
    "joins %s preparation and rejects handler entry before close returns",
    async (boundary) => {
      const held = createDeferredCore();
      const reached = createDeferredCore();
      const pause = async () => {
        reached.resolve();
        await held.promise;
      };
      const handler = vi.fn<GatewayRequestHandler>(({ respond }) =>
        respond(true, { entered: true }),
      );
      const client = createOperatorWsClient();
      const lazy = createLazyCoreHandlers({
        methods: ["test.entry"],
        loadHandlers: async () => {
          if (boundary === "nested family") {
            return createLazyCoreHandlers({
              methods: ["test.entry"],
              loadHandlers: async () => {
                await pause();
                return { "test.entry": handler };
              },
            });
          }
          if (boundary.startsWith("family")) {
            await pause();
          }
          if (boundary === "family rejection") {
            throw new Error("expected family preparation failure");
          }
          return { "test.entry": handler };
        },
      });
      if (boundary === "router" || boundary === "start") {
        boundaries[boundary].mockImplementation(pause);
      } else if (boundary === "profile") {
        client.authenticatedGitHubIdentitySync = async () => {
          await pause();
          client.authenticatedUserProfile = {
            profileId: "entry-profile",
            displayName: "Entry",
            avatarRevision: "entry-avatar",
            hasAvatar: false,
            updatedAt: 1,
          };
          return { profileId: "entry-profile", updatedAt: 1 };
        };
      }
      const harness = createDispatchTestHarness({
        buildRequestContext: () => kernel.gatewayRequestContext,
        extraHandlers: lazy,
      });
      let closeSettled = false;
      let closing: Promise<void> | undefined;
      const lateResponses: unknown[] = [];
      harness.send.mockImplementation((frame) => {
        if (closeSettled) {
          lateResponses.push(frame);
        }
        return { kind: "sent" };
      });
      const lateErrors: string[] = [];
      harness.logGateway.error.mockImplementation((message) => {
        if (closeSettled) {
          lateErrors.push(message);
        }
      });
      try {
        await harness.dispatcher.dispatch(
          { type: "req", id: "held", method: "test.entry", params: {} },
          client,
        );
        await reached.promise;
        closing = kernel.beginClosePrelude().then(() => {
          closeSettled = true;
        });
        await nextTurn();
        expect.soft(closeSettled).toBe(false);
        held.resolve();
        await harness.awaitResponseFrame("held");
        await closing;
        expect.soft(handler).not.toHaveBeenCalled();
        expect.soft(lateResponses).toEqual([]);
        expect.soft(lateErrors).toEqual([]);
      } finally {
        held.resolve();
        await harness.awaitResponseFrame("held");
        await closing;
      }
    },
  );

  it.each(["test.entry", "device.token.rotate"])(
    "refuses credential-barrier waiter %s before joining close without draining its predecessor",
    async (method) => {
      const held = createDeferredCore();
      const reached = createDeferredCore();
      const finished = createDeferredCore();
      let mutationFinished = false;
      const mutation = vi.fn<GatewayRequestHandler>(async ({ respond }) => {
        reached.resolve();
        try {
          await held.promise;
          respond(true, { mutated: true });
        } finally {
          mutationFinished = true;
          finished.resolve();
        }
      });
      const waiter = vi.fn<GatewayRequestHandler>(({ respond }) => respond(true));
      const client = createOperatorWsClient();
      const harness = createDispatchTestHarness({
        buildRequestContext: () => kernel.gatewayRequestContext,
        extraHandlers: { "device.token.revoke": mutation, [method]: waiter },
      });
      const events: string[] = [];
      harness.send.mockImplementation(() => {
        events.push("response");
        return { kind: "sent" };
      });
      let queued: Promise<void> | undefined;
      let closing: Promise<void> | undefined;
      try {
        await harness.dispatcher.dispatch(
          { type: "req", id: "mutation", method: "device.token.revoke", params: {} },
          client,
        );
        await reached.promise;
        queued = harness.dispatcher.dispatch({ type: "req", id: "waiting", method }, client);
        await nextTurn();
        expect(waiter).not.toHaveBeenCalled();
        expect(harness.send).not.toHaveBeenCalled();
        closing = kernel.beginClosePrelude().then(() => {
          events.push("closed");
        });
        await vi.waitFor(() => expect(events).toContain("closed"));
        expect.soft(events).toEqual(["response", "closed"]);
        expect(harness.send).toHaveBeenCalledWith(
          expect.objectContaining({
            id: "waiting",
            ok: false,
            error: expect.objectContaining({ code: "UNAVAILABLE", retryable: true }),
          }),
        );
        expect(harness.close).not.toHaveBeenCalled();
        expect(waiter).not.toHaveBeenCalled();
        expect(mutationFinished).toBe(false);
        expect(mutation.mock.calls[0]?.[0].signal).toBeUndefined();
      } finally {
        held.resolve();
        await finished.promise;
        await queued;
        await closing;
        await harness.awaitResponseFrame("mutation");
        await nextTurn();
      }
    },
  );

  it("permits ordinary entry after disconnect while its Gateway is live", async () => {
    const held = createDeferredCore();
    const reached = createDeferredCore();
    boundaries.start.mockImplementation(async () => {
      reached.resolve();
      await held.promise;
    });
    const socket = new EventEmitter();
    const client = createOperatorWsClient({ socket });
    let disconnected = false;
    const handler = vi.fn<GatewayRequestHandler>(({ respond }) => respond(true, { entered: true }));
    const harness = createDispatchTestHarness({
      buildRequestContext: () => kernel.gatewayRequestContext,
      extraHandlers: { "test.entry": handler },
      isClosed: () => disconnected,
    });
    try {
      await harness.dispatcher.dispatch(
        { type: "req", id: "disconnected", method: "test.entry" },
        client,
      );
      await reached.promise;
      disconnected = true;
      socket.emit("close");
      held.resolve();
      expect(await harness.awaitResponseFrame("disconnected")).toMatchObject({ ok: true });
      expect(handler).toHaveBeenCalledOnce();
    } finally {
      held.resolve();
      await harness.awaitResponseFrame("disconnected");
    }
  });

  it("hands execution off before a handler initiates close", async () => {
    const result = await dispatchGatewayRequestInProcessRaw(
      "test.close",
      {},
      {
        context: kernel.gatewayRequestContext,
        client: createOperatorWsClient(),
        methodRegistry: createGatewayMethodRegistry([
          {
            name: "test.close",
            owner: { kind: "aux", area: "entry-test" },
            scope: "operator.admin",
            handler: async ({ respond }: Parameters<GatewayRequestHandler>[0]) => {
              await kernel.beginClosePrelude();
              respond(true, { closed: true });
            },
          },
        ]),
      },
    );
    expect(result).toMatchObject({ ok: true, payload: { closed: true } });
  });

  it("admits exact pending node cleanup replies while close drains", async () => {
    const node = createOperatorWsClient({ socket: { readyState: 1, send: vi.fn() } });
    node.connect.role = "node";
    node.connect.client.id = "node-host";
    node.connect.client.mode = "node";
    node.connect.device = {
      id: "entry-node",
      publicKey: "key",
      signature: "sig",
      signedAt: 1,
      nonce: "nonce",
    };
    node.connect.commands = ["debug.ping"];
    const registry = new NodeRegistry({
      resolveCurrentPairingState: async () => ({ identity: "paired", generation: "current" }),
    });
    registry.register(node, { pairingIdentity: "paired", pairingGeneration: "current" });
    const context = { ...kernel.gatewayRequestContext, nodeRegistry: registry };
    const ready = createDeferredCore<string>();
    await kernel.beginClosePrelude();
    markGatewayRestartDraining();
    const invoked = registry.invokeLifecycle({
      nodeId: "entry-node",
      command: "debug.ping",
      timeoutMs: 10_000,
      isDispatchAuthorized: () => true,
      onDispatchReady: ready.resolve,
    });
    const settled = invoked.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    try {
      const id = await Promise.race([
        ready.promise,
        settled.then(() => {
          throw new Error("invoke did not dispatch");
        }),
      ]);
      const response = await dispatchGatewayRequestInProcessRaw(
        "node.invoke.result",
        { id, nodeId: "entry-node", ok: true },
        { context, client: node },
      );
      expect(response).toMatchObject({ ok: true });
      expect(await settled).toMatchObject({ value: { ok: true } });
    } finally {
      registry.unregister(node.connId);
      await settled;
      resetGatewayWorkAdmission();
    }
  });

  it("keeps a retired context closed when a replacement Gateway starts", async () => {
    const retired = kernel.gatewayRequestContext;
    await kernel.closeOnStartupFailure();
    kernel = await createGatewayKernel(port, {
      auth: { mode: "token", token: "request-entry-test" },
      bind: "loopback",
      controlUiEnabled: false,
      sidecarStartup: "defer",
    });
    const handler = vi.fn<GatewayRequestHandler>(({ respond }) => respond(true, { entered: true }));
    const methodRegistry = createGatewayMethodRegistry([
      {
        name: "test.entry",
        owner: { kind: "aux", area: "entry-test" },
        scope: "operator.admin",
        handler,
      },
    ]);
    const options = { client: createOperatorWsClient(), methodRegistry };
    await expect(
      dispatchGatewayRequestInProcessRaw("test.entry", {}, { ...options, context: retired }),
    ).rejects.toThrow(/closed|closing/);
    expect(handler).not.toHaveBeenCalled();
    await expect(
      dispatchGatewayRequestInProcessRaw(
        "test.entry",
        {},
        { ...options, context: kernel.gatewayRequestContext },
      ),
    ).resolves.toMatchObject({ ok: true });
  });

  it("joins typed authorization before allowing its service to start", async () => {
    const held = createDeferredCore();
    const reached = createDeferredCore();
    const client = createOperatorWsClient();
    client.authenticatedGitHubIdentitySync = async () => {
      reached.resolve();
      await held.promise;
      client.authenticatedUserProfile = {
        profileId: "typed-profile",
        displayName: "Typed",
        avatarRevision: "typed-avatar",
        hasAvatar: false,
        updatedAt: 1,
      };
      return { profileId: "typed-profile", updatedAt: 1 };
    };
    const facade = createInternalAgentTurnFacade({
      client,
      getContext: () => kernel.gatewayRequestContext,
    });
    kernel.dedupe.set("agent:entry-typed", { ts: Date.now(), ok: true, payload: { cached: true } });
    const result = facade.dispatchRaw({ message: "cached", idempotencyKey: "entry-typed" });
    const settled = result.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    let closeSettled = false;
    let closing: Promise<void> | undefined;
    try {
      await reached.promise;
      closing = kernel.beginClosePrelude().then(() => {
        closeSettled = true;
      });
      await nextTurn();
      expect.soft(closeSettled).toBe(false);
      held.resolve();
      expect(await settled).toMatchObject({
        error: expect.objectContaining({ message: expect.stringMatching(/closed|closing/) }),
      });
      await closing;
    } finally {
      held.resolve();
      await settled;
      await closing;
    }
  });
});
