// @vitest-environment node
import { createRouter, type RouteLoaderOptions } from "@openclaw/uirouter";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createAgentSelectionCapability } from "../../app/agent-selection.ts";
import type { ApplicationContext } from "../../app/context.ts";
import {
  createGatewayStoreTestStore,
  GATEWAY_STORE_TEST_HELLO,
  stubGatewayStoreTestGlobals,
} from "../../app/gateway-store.test-support.ts";
import { setAvatarGatewayOrigin } from "../../lib/identity-avatar-context.ts";
import { page } from "./route.ts";
import type { UsageRouteData } from "./usage-page.ts";

const usageMethods = ["sessions.usage", "usage.cost", "usage.status"];
const payload = { sessions: [], daily: [], providers: [] };
const cleanups: Array<() => void> = [];
const loaderOptions: RouteLoaderOptions = {
  signal: new AbortController().signal,
  shouldRun: () => true,
  revalidating: false,
  location: { pathname: "/usage", search: "", hash: "" },
  deps: "",
  cause: "navigation",
};

function createUsageRouter() {
  const store = createGatewayStoreTestStore();
  store.gateway.start();
  const request = vi.spyOn(store.gateway.snapshot.client!, "request").mockResolvedValue(payload);
  store.current().opts.onHello?.({ ...GATEWAY_STORE_TEST_HELLO });
  const selection = createAgentSelectionCapability(store.gateway, {
    state: { agentsList: null },
    subscribe: () => () => {},
  });
  selection.set("main");
  const context = { gateway: store.gateway, agentSelection: selection } as ApplicationContext;
  const router = createRouter<"usage" | "other", ApplicationContext, null, UsageRouteData>({
    routes: [
      { ...page, component: () => null },
      { id: "other", path: "/other", component: () => null },
    ],
  });
  cleanups.push(() => {
    router.stop();
    store.gateway.stop();
  });
  return {
    ...store,
    context,
    selection,
    router,
    request,
    usageCalls: () => request.mock.calls.filter(([method]) => usageMethods.includes(method)),
  };
}

describe("usage route", () => {
  beforeEach(stubGatewayStoreTestGlobals);

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
    setAvatarGatewayOrigin(null);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each(["navigation", "disconnect", "reconnect", "client", "set", "setScope"] as const)(
    "retires the lazy load after %s and loads the current route",
    async (change) => {
      const { router, context, gateway, current, selection, usageCalls } = createUsageRouter();
      const admitted = gateway.snapshot;
      const loading = router.navigate("usage", context);
      // These real producers run while the loader is suspended at import(), even when cached.
      if (change === "navigation") {
        await router.navigate("other", context);
      } else if (change === "disconnect" || change === "reconnect") {
        current().opts.onClose?.({ code: 1012, reason: "restart", willRetry: true });
        if (change === "reconnect") {
          current().opts.onHello?.({ ...GATEWAY_STORE_TEST_HELLO });
          expect(gateway.snapshot.client).toBe(admitted.client);
          expect(gateway.snapshot.hello).not.toBe(admitted.hello);
        }
      } else if (change === "client") {
        gateway.connect();
        current().request.mockResolvedValue(payload);
        current().opts.onHello?.({ ...GATEWAY_STORE_TEST_HELLO });
      } else if (change === "set") {
        selection.set("research");
      } else {
        selection.setScope(null);
      }
      await loading;
      expect(usageCalls()).toEqual([]);

      if (gateway.snapshot.phase !== "connected") {
        current().opts.onHello?.({ ...GATEWAY_STORE_TEST_HELLO });
      }
      await router.revalidate(context, "usage");
      const active = router.getState().matches[0];
      expect(active?.status).toBe("success");
      expect(active?.data).toMatchObject({
        gateway,
        gatewaySnapshot: gateway.snapshot,
        query: { agentId: selection.state.scopeId },
        result: payload,
        error: null,
      });
      expect(active?.data?.loadedAtMs).toEqual(expect.any(Number));
    },
  );

  it.each(["navigation", "preload"] as const)(
    "preserves query and %s cancellation ownership for all aggregate requests",
    async (kind) => {
      const { router, context, request, usageCalls } = createUsageRouter();
      const started = createDeferred();
      const response = createDeferred<typeof payload>();
      let requests = 0;
      request.mockImplementation(async (method) => {
        if (!usageMethods.includes(method)) {
          return {};
        }
        if (++requests === 3) {
          started.resolve();
        }
        return response.promise;
      });
      const loading =
        kind === "navigation"
          ? router.navigate("usage", context)
          : router.preloadRoute("usage", context);
      await started.promise;
      const state = router.getState();
      const match = [...state.matches, ...state.pendingMatches, ...state.cachedMatches].find(
        (entry) => entry.routeId === "usage",
      )!;
      const calls = usageCalls();
      await router.navigate("other", context);
      response.resolve(payload);
      await loading;

      expect(calls.map(([method]) => method).toSorted()).toEqual(usageMethods.toSorted());
      for (const call of calls) {
        expect(call[2]?.signal).toBe(match.abortController.signal);
        expect(call[2]?.signal?.aborted).toBe(kind === "navigation");
      }
      await router.navigate("usage", context);
      const data = router.getState().matches[0]?.data;
      expect(data?.result).toEqual(payload);
      expect(data?.query).toEqual({
        startDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        endDate: data?.query.startDate,
        scope: "family",
        timeZone: "local",
        agentId: "main",
      });
      expect(calls.find(([method]) => method === "sessions.usage")?.[1]).toMatchObject({
        startDate: data?.query.startDate,
        endDate: data?.query.endDate,
        agentId: "main",
        groupBy: "family",
        mode: "specific",
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        includeContextWeight: false,
      });
      expect(data?.error).toBeNull();
    },
  );

  it("records a provider usage request failure separately from an empty response", async () => {
    const request = vi.fn(async (method: string) => {
      switch (method) {
        case "sessions.usage":
          return { sessions: [], totals: null };
        case "usage.cost":
          return { daily: [] };
        case "usage.status":
          throw new Error("gateway transport unavailable");
        default:
          return {};
      }
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const gateway = { snapshot: { phase: "connected", client } };
    const context = {
      gateway,
      agentSelection: { state: { scopeId: "main" } },
    } as unknown as ApplicationContext;

    const result = (await page.loader?.(context, loaderOptions)) as UsageRouteData;

    expect(result.error).toBeNull();
    expect(result.providerUsage).toEqual({
      state: "settled",
      result: { ok: false, error: { kind: "request-failed" } },
    });
  });

  it("redacts secrets in displayed loader failures", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.usage") {
        throw new Error("OPENAI_API_KEY=sk-1234567890abcdef");
      }
      return {};
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const gateway = { snapshot: { phase: "connected", client } };
    const context = {
      gateway,
      agentSelection: { state: { scopeId: "main" } },
    } as unknown as ApplicationContext;
    const options = {
      signal: new AbortController().signal,
      shouldRun: () => true,
      revalidating: false,
      location: { pathname: "/usage", search: "", hash: "" },
      deps: "",
      cause: "navigation",
    } satisfies RouteLoaderOptions;

    const result = (await page.loader?.(context, options)) as UsageRouteData;

    expect(result.error).toBe("OPENAI_API_KEY=sk-123...cdef");
  });
});
