// @vitest-environment node
import type { RouteLoaderOptions } from "@openclaw/uirouter";
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../app/context.ts";
import type { AgentsRouteData } from "./agents/agents-page.ts";
import { page as agentsPage } from "./agents/route.ts";
import type { ModelProvidersRouteData } from "./model-providers/model-providers-page.ts";
import { page as modelProvidersPage } from "./model-providers/route.ts";
import type { NodesRouteData } from "./nodes/nodes-page.ts";
import { page as nodesPage } from "./nodes/route.ts";
import type { PluginsRouteData } from "./plugins/plugins-page.ts";
import { page as pluginsPage } from "./plugins/route.ts";
import { page as sessionsPage } from "./sessions/route.ts";
import type { SessionsRouteData } from "./sessions/sessions-page.ts";
import { page as skillsPage } from "./skills/route.ts";
import type { SkillsRouteData } from "./skills/skills-page.ts";
import { page as usagePage } from "./usage/route.ts";
import type { UsageRouteData } from "./usage/usage-page.ts";

type RouteWithLoader = {
  loader?: (context: ApplicationContext, options: RouteLoaderOptions) => unknown;
};

const loaderOptions: RouteLoaderOptions = {
  signal: new AbortController().signal,
  shouldRun: () => true,
  revalidating: false,
  location: { pathname: "/", search: "", hash: "" },
  deps: "",
  cause: "preload",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function snapshot(
  client: GatewayBrowserClient | null,
  connected: boolean,
): ApplicationGatewaySnapshot {
  return {
    client,
    connected,
    offlineStable: false,
    reconnecting: !connected,
    hello: null,
    assistantAgentId: null,
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
}

function mutableGateway(initialSnapshot: ApplicationGatewaySnapshot) {
  let current = initialSnapshot;
  const gateway = {
    get snapshot() {
      return current;
    },
  } as unknown as ApplicationContext["gateway"];
  return {
    gateway,
    replaceSnapshot(next: ApplicationGatewaySnapshot) {
      current = next;
    },
  };
}

async function loadRoute<T>(route: RouteWithLoader, context: ApplicationContext): Promise<T> {
  if (!route.loader) {
    throw new Error("route has no loader");
  }
  return (await route.loader(context, loaderOptions)) as T;
}

describe("route preload gateway provenance", () => {
  it("records the exact gateway source and snapshot for synchronous route state", async () => {
    const agentsGateway = mutableGateway(snapshot(null, false));
    const agentsData = await loadRoute<AgentsRouteData>(agentsPage, {
      gateway: agentsGateway.gateway,
      agents: {
        state: { agentsList: null, agentsError: null },
        ensureList: vi.fn(async () => null),
      },
    } as unknown as ApplicationContext);
    expect(agentsData.gateway).toBe(agentsGateway.gateway);
    expect(agentsData.gatewaySnapshot).toBe(agentsGateway.gateway.snapshot);

    const nodesGateway = mutableGateway(snapshot(null, false));
    const nodesData = await loadRoute<NodesRouteData>(nodesPage, {
      gateway: nodesGateway.gateway,
    } as unknown as ApplicationContext);
    expect(nodesData.gateway).toBe(nodesGateway.gateway);
    expect(nodesData.gatewaySnapshot).toBe(nodesGateway.gateway.snapshot);
  });

  it("keeps sessions provenance from before its async preload", async () => {
    const client = {} as GatewayBrowserClient;
    const originalSnapshot = snapshot(client, true);
    const mutable = mutableGateway(originalSnapshot);
    const gateway = mutable.gateway;
    const list = deferred<null>();
    const request = loadRoute<SessionsRouteData>(sessionsPage, {
      gateway,
      sessions: { list: vi.fn(() => list.promise) },
      runtimeConfig: { ensureLoaded: vi.fn(async () => undefined) },
      agentSelection: { state: { selectedId: null, scopeId: null } },
    } as unknown as ApplicationContext);

    mutable.replaceSnapshot(snapshot(client, false));
    list.resolve(null);
    const data = await request;

    expect(data.gateway).toBe(gateway);
    expect(data.gatewaySnapshot).toBe(originalSnapshot);
  });

  it("preloads a bounded session roster without an implicit recency filter", async () => {
    const list = vi.fn(async (_options: unknown) => null);
    await loadRoute<SessionsRouteData>(sessionsPage, {
      gateway: mutableGateway(snapshot(null, false)).gateway,
      sessions: { list },
      runtimeConfig: { ensureLoaded: vi.fn(async () => undefined) },
      agentSelection: { state: { selectedId: null, scopeId: null } },
    } as unknown as ApplicationContext);

    expect(list).toHaveBeenCalledWith({
      limit: 50,
      search: undefined,
      includeGlobal: true,
      includeUnknown: false,
      archivedFilter: "active",
    });
    expect(list.mock.calls[0]?.[0]).not.toHaveProperty("activeMinutes");
  });

  it("keeps usage provenance from before its async preload", async () => {
    const client = {
      request: vi.fn(async () => ({})),
    } as unknown as GatewayBrowserClient;
    const originalSnapshot = snapshot(client, true);
    const mutable = mutableGateway(originalSnapshot);
    const gateway = mutable.gateway;
    const request = loadRoute<UsageRouteData>(usagePage, {
      gateway,
      agentSelection: { state: { selectedId: null, scopeId: null } },
    } as unknown as ApplicationContext);

    mutable.replaceSnapshot(snapshot(client, false));
    const data = await request;

    expect(data.gateway).toBe(gateway);
    expect(data.gatewaySnapshot).toBe(originalSnapshot);
  });

  it("keeps model providers provenance from before its lazy module load", async () => {
    const originalRequest = vi.fn(async () => ({}));
    const originalClient = { request: originalRequest } as unknown as GatewayBrowserClient;
    const replacementRequest = vi.fn(async () => ({}));
    const replacementClient = {
      request: replacementRequest,
    } as unknown as GatewayBrowserClient;
    const mutable = mutableGateway(snapshot(originalClient, true));
    const request = loadRoute<ModelProvidersRouteData>(modelProvidersPage, {
      gateway: mutable.gateway,
      agents: {
        state: { agentsList: null },
        ensureList: vi.fn(async () => ({
          defaultId: "main",
          mainKey: "main",
          scope: "project",
          agents: [{ id: "main" }],
        })),
      },
      agentSelection: { state: { selectedId: null, scopeId: null } },
    } as unknown as ApplicationContext);

    mutable.replaceSnapshot(snapshot(replacementClient, true));
    const data = await request;

    expect(data.client).toBe(originalClient);
    expect(originalRequest).toHaveBeenCalled();
    expect(replacementRequest).not.toHaveBeenCalled();
  });

  it("keeps skills provenance from before its async preload", async () => {
    const client = {
      request: vi.fn(async () => ({ skills: [] })),
    } as unknown as GatewayBrowserClient;
    const originalSnapshot = snapshot(client, true);
    const mutable = mutableGateway(originalSnapshot);
    const gateway = mutable.gateway;
    const agentsReady = deferred<null>();
    const agents = {
      ensureList: vi.fn(() => agentsReady.promise),
    } as unknown as ApplicationContext["agents"];
    const request = loadRoute<SkillsRouteData>(skillsPage, {
      gateway,
      agents,
    } as unknown as ApplicationContext);

    mutable.replaceSnapshot(snapshot(client, false));
    agentsReady.resolve(null);
    const data = await request;

    expect(data.gateway).toBe(gateway);
    expect(data.gatewaySnapshot).toBe(originalSnapshot);
    expect(data.agents).toBe(agents);
  });

  it("keeps plugins provenance from before its async preload", async () => {
    const result = { plugins: [], diagnostics: [], mutationAllowed: true };
    const response = deferred<typeof result>();
    const requestMethod = vi.fn(() => response.promise);
    const client = { request: requestMethod } as unknown as GatewayBrowserClient;
    const originalSnapshot = snapshot(client, true);
    const mutable = mutableGateway(originalSnapshot);
    const request = loadRoute<PluginsRouteData>(pluginsPage, {
      gateway: mutable.gateway,
    } as unknown as ApplicationContext);

    mutable.replaceSnapshot(snapshot(client, false));
    response.resolve(result);
    const data = await request;

    expect(requestMethod).toHaveBeenCalledWith("plugins.list", {});
    expect(data.gateway).toBe(mutable.gateway);
    expect(data.gatewaySnapshot).toBe(originalSnapshot);
    expect(data.result).toEqual(result);
  });

  it("does not request plugins while disconnected", async () => {
    const requestMethod = vi.fn();
    const client = { request: requestMethod } as unknown as GatewayBrowserClient;
    const mutable = mutableGateway(snapshot(client, false));

    const data = await loadRoute<PluginsRouteData>(pluginsPage, {
      gateway: mutable.gateway,
    } as unknown as ApplicationContext);

    expect(requestMethod).not.toHaveBeenCalled();
    expect(data.result).toBeNull();
    expect(data.error).toBeNull();
  });
});
