// @vitest-environment node
import { createRouter } from "@openclaw/uirouter";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { AgentsListResult } from "../../api/types.ts";
import { createAgentSelectionCapability } from "../../app/agent-selection.ts";
import type { ApplicationContext } from "../../app/context.ts";
import {
  createGatewayStoreTestStore,
  GATEWAY_STORE_TEST_HELLO,
  stubGatewayStoreTestGlobals,
} from "../../app/gateway-store.test-support.ts";
import { createAgentCapability } from "../../lib/agents/index.ts";
import { setAvatarGatewayOrigin } from "../../lib/identity-avatar-context.ts";
import { page, type ModelProvidersRouteData } from "./route.ts";

const modelMethods = ["models.authStatus", "models.list", "config.get"];
const roster = {
  defaultId: "main",
  mainKey: "main",
  scope: "per-sender",
  agents: [{ id: "main" }, { id: "research" }],
} satisfies AgentsListResult;
const cleanups: Array<() => void> = [];

function responseFor(method: string): unknown {
  switch (method) {
    case "agents.list":
      return roster;
    case "models.authStatus":
      return { ts: 1, providers: [{ provider: "openai", status: "ok", profiles: [] }] };
    case "models.list":
      return { models: [{ id: "fixture", provider: "openai", name: "Fixture" }] };
    case "config.get":
      return { config: {}, hash: "fixture" };
    default:
      return {};
  }
}

function createModelsRouter(selectedId: string | null = "main") {
  const store = createGatewayStoreTestStore();
  store.gateway.start();
  const request = vi
    .spyOn(store.gateway.snapshot.client!, "request")
    .mockImplementation(async (method) => responseFor(method));
  store.current().opts.onHello?.({ ...GATEWAY_STORE_TEST_HELLO });
  // Match bootstrap's subscription order; the roster publishes before selection reconciles.
  const agents = createAgentCapability(store.gateway);
  const selection = createAgentSelectionCapability(store.gateway, agents);
  selection.set(selectedId);
  const context = Object.freeze({
    gateway: store.gateway,
    agents,
    agentSelection: selection,
  }) as ApplicationContext;
  const router = createRouter<
    "model-providers" | "other",
    ApplicationContext,
    null,
    ModelProvidersRouteData
  >({
    routes: [
      { ...page, component: () => null },
      { id: "other", path: "/other", component: () => null },
    ],
  });
  cleanups.push(() => {
    router.stop();
    agents.dispose();
    store.gateway.stop();
  });
  return {
    ...store,
    context,
    selection,
    router,
    request,
    modelCalls: () =>
      store.clients.flatMap((client) =>
        client.request.mock.calls.filter(([method]) => modelMethods.includes(method)),
      ),
  };
}

type ModelsHarness = ReturnType<typeof createModelsRouter>;
type OwnerChange = "navigation" | "disconnect" | "hello" | "client" | "set";

async function replaceOwner(harness: ModelsHarness, change: OwnerChange) {
  if (change === "navigation") {
    await harness.router.navigate("other", harness.context);
  } else if (change === "disconnect") {
    harness.current().opts.onClose?.({ code: 1012, reason: "restart", willRetry: true });
  } else if (change === "hello") {
    const admitted = harness.gateway.snapshot;
    harness.current().opts.onClose?.({ code: 1012, reason: "restart", willRetry: true });
    harness.current().opts.onHello?.({ ...GATEWAY_STORE_TEST_HELLO });
    expect(harness.gateway.snapshot.client).toBe(admitted.client);
    expect(harness.gateway.snapshot.hello).not.toBe(admitted.hello);
  } else if (change === "client") {
    harness.gateway.connect();
    harness.current().request.mockImplementation(async (method) => responseFor(method));
    harness.current().opts.onHello?.({ ...GATEWAY_STORE_TEST_HELLO });
  } else {
    harness.selection.set("research");
  }
}

describe("Models route admission", () => {
  beforeEach(stubGatewayStoreTestGlobals);
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
    setAvatarGatewayOrigin(null);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([
    ["regular", "?view=connect", false],
    ["first-run", "?view=connect&firstRun=1", true],
  ] as const)(
    "publishes %s connect state without loading Manage data",
    async (_, search, firstRun) => {
      const harness = createModelsRouter();
      await harness.router.navigateLocation(
        { pathname: "/settings/model-providers", search, hash: "" },
        harness.context,
      );

      expect(harness.router.getState().matches[0]?.data).toMatchObject({
        view: "connect",
        firstRun,
        agentId: "main",
        data: { updatedAt: null },
      });
      expect(harness.modelCalls()).toEqual([]);
    },
  );

  it.each(["navigation", "disconnect", "hello", "client", "set"] as const)(
    "does not dispatch after %s during the deferred import; a new load succeeds",
    async (change) => {
      const harness = createModelsRouter();
      const { router, context, gateway, selection, modelCalls } = harness;
      const loading = router.navigate("model-providers", context);
      // import() yields even for a cached module, so these real producers precede requests.
      await replaceOwner(harness, change);
      await loading;
      expect(modelCalls()).toEqual([]);
      if (gateway.snapshot.phase !== "connected") {
        harness.current().opts.onHello?.({ ...GATEWAY_STORE_TEST_HELLO });
      }
      await router.revalidate(context, "model-providers");
      expect(router.getState().matches[0]?.data).toMatchObject({
        gateway,
        gatewaySnapshot: gateway.snapshot,
        client: gateway.snapshot.client,
        agentId: selection.state.selectedId,
        data: {
          authStatus: responseFor("models.authStatus"),
          models: [{ id: "fixture", provider: "openai", name: "Fixture" }],
          error: null,
          updatedAt: expect.any(Number),
        },
      });
    },
  );

  it.each(["navigation", "disconnect", "hello", "client", "set"] as const)(
    "does not dispatch after %s while agent initialization is pending",
    async (change) => {
      const harness = createModelsRouter(null);
      const started = createDeferred();
      const response = createDeferred<typeof roster>();
      harness.request.mockImplementation(async (method) => {
        if (method === "agents.list") {
          started.resolve();
          return response.promise;
        }
        return responseFor(method);
      });
      const loading = harness.router.navigate("model-providers", harness.context);
      await started.promise;
      await replaceOwner(harness, change);
      // A new connection can select its agent before the old roster request settles.
      if (change === "disconnect" || change === "hello" || change === "client") {
        harness.selection.set("main");
      }
      response.resolve(roster);
      await loading;
      expect(harness.modelCalls()).toEqual([]);
    },
  );

  it.each(["import", "roster"] as const)(
    "accepts metadata and scope-only changes during %s",
    async (boundary) => {
      const harness = createModelsRouter(boundary === "roster" ? null : "main");
      const admitted = harness.gateway.snapshot;
      const started = createDeferred();
      const response = createDeferred<typeof roster>();
      harness.request.mockImplementation(async (method) => {
        if (method === "agents.list") {
          started.resolve();
          return response.promise;
        }
        return responseFor(method);
      });
      const loading = harness.router.navigate("model-providers", harness.context);
      if (boundary === "roster") {
        await started.promise;
      }
      harness.current().opts.onRecoveryScopeChange?.();
      harness.selection.setScope(boundary === "import" ? null : "research");
      expect(harness.gateway.snapshot).not.toBe(admitted);
      expect(harness.gateway.snapshot.hello).toBe(admitted.hello);
      response.resolve(roster);
      await loading;
      expect(harness.router.getState().matches[0]?.data?.gatewaySnapshot).toBe(admitted);
      expect(harness.router.getState().matches[0]?.data).toMatchObject({
        gatewaySnapshot: admitted,
        agentId: "main",
        data: { error: null, updatedAt: expect.any(Number) },
      });
      expect(
        harness
          .modelCalls()
          .map(([method]) => method)
          .toSorted(),
      ).toEqual(modelMethods.toSorted());
      expect(harness.context.agentSelection.state.selectedId).toBe("main");
    },
  );

  it("does not initialize agents after navigation cancels the deferred import", async () => {
    const harness = createModelsRouter(null);
    const loading = harness.router.navigate("model-providers", harness.context);
    await harness.router.navigate("other", harness.context);
    await loading;
    expect(harness.request).not.toHaveBeenCalledWith("agents.list", {});
    expect(harness.modelCalls()).toEqual([]);
  });

  it("leaves roster failure to the agent owner without starting Models requests", async () => {
    const harness = createModelsRouter(null);
    harness.request.mockRejectedValue(new Error("roster unavailable"));
    await harness.router.navigate("model-providers", harness.context);
    expect(harness.context.agents.state.agentsError).toBe("roster unavailable");
    expect(harness.modelCalls()).toEqual([]);
    expect(harness.router.getState().matches[0]?.data).toMatchObject({
      client: null,
      agentId: null,
      data: { updatedAt: null },
    });
  });

  it.each(["navigation", "preload"] as const)(
    "keeps %s cancellation ownership through every Models request",
    async (kind) => {
      const harness = createModelsRouter();
      const started = createDeferred();
      const response = createDeferred();
      let requests = 0;
      harness.request.mockImplementation(async (method) => {
        if (modelMethods.includes(method)) {
          if (++requests === modelMethods.length) {
            started.resolve();
          }
          await response.promise;
        }
        return responseFor(method);
      });
      const loading =
        kind === "navigation"
          ? harness.router.navigate("model-providers", harness.context)
          : harness.router.preloadRoute("model-providers", harness.context);
      await started.promise;
      const calls = harness.request.mock.calls.filter(([method]) => modelMethods.includes(method));
      await harness.router.navigate("other", harness.context);
      response.resolve();
      await loading;
      for (const [method, , options] of calls) {
        // Catalog coalescing has its own controller, but must retire with its last subscriber.
        expect(options?.signal, method).toBeDefined();
        expect(options?.signal?.aborted, method).toBe(kind === "navigation");
      }
      if (kind === "preload") {
        await harness.router.navigate("model-providers", harness.context);
        expect(harness.modelCalls()).toHaveLength(modelMethods.length);
        expect(harness.router.getState().matches[0]?.data?.data.authStatus).toEqual(
          responseFor("models.authStatus"),
        );
      }
    },
  );
});
