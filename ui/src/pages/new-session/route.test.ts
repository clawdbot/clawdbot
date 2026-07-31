import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import type { NewSessionRouteData } from "./location.ts";
import { page } from "./route.ts";

// The loader is exercised through the page contract so route.ts keeps its
// internals unexported; new-session routes never resolve to RouteNotFound.
const loadNewSessionData = (context: ApplicationContext, search: string) =>
  page.loader?.(context, { location: { search } } as never) as Promise<NewSessionRouteData>;

function createContext(params: {
  assistantAgentId: string | null;
  agentsList: ApplicationContext["agents"]["state"]["agentsList"];
  staleRosterClient?: boolean;
}) {
  const request = vi.fn(async (method: string) => {
    if (method !== "sessions.catalog.list") {
      throw new Error(`unexpected request: ${method}`);
    }
    return { catalogs: [] };
  });
  const client = { request } as unknown as GatewayBrowserClient;
  const snapshot: ApplicationGatewaySnapshot = {
    client,
    phase: "connected",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello: {
      type: "hello-ok",
      protocol: 1,
      auth: { role: "operator", scopes: [] },
      features: { methods: ["sessions.catalog.list"] },
    },
    assistantAgentId: params.assistantAgentId,
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
  const ensureList = vi.fn(async () => params.agentsList);
  const agentsState = {
    client: params.staleRosterClient
      ? ({ request: vi.fn() } as unknown as GatewayBrowserClient)
      : client,
    connected: true,
    agentsList: params.agentsList,
  };
  const context = {
    gateway: { snapshot },
    agents: {
      state: agentsState,
      ensureList,
    },
  } as unknown as ApplicationContext;
  return { agentsState, client, context, ensureList, request };
}

describe("new-session route catalog target", () => {
  it("defers an unvalidated route agent before roster hydration", async () => {
    const { context, request } = createContext({
      assistantAgentId: "roboclaw",
      agentsList: null,
    });

    const data = await loadNewSessionData(context, "?agent=main&catalog=claude");

    expect(data.agentId).toBe("");
    expect(request).not.toHaveBeenCalled();
  });

  it("reconciles a retired route agent against the loaded roster", async () => {
    const { context, request } = createContext({
      assistantAgentId: "main",
      agentsList: {
        defaultId: "roboclaw",
        mainKey: "main",
        scope: "agent",
        agents: [{ id: "roboclaw" }],
      },
    });

    const data = await loadNewSessionData(context, "?agent=main&catalog=claude");

    expect(data.agentId).toBe("roboclaw");
    expect(request).toHaveBeenCalledWith("sessions.catalog.list", {
      agentId: "roboclaw",
      catalogId: "claude",
      limitPerHost: 1,
    });
  });

  it("defers catalog retries when neither roster nor hello supplies an agent", async () => {
    const { context, request } = createContext({ assistantAgentId: null, agentsList: null });

    const data = await loadNewSessionData(context, "?agent=main&catalog=claude");

    expect(data.agentId).toBe("");
    expect(request).not.toHaveBeenCalled();
  });

  it("waits for the replacement client's roster before preserving a valid route agent", async () => {
    const { agentsState, client, context, request } = createContext({
      assistantAgentId: "roboclaw",
      agentsList: {
        defaultId: "main",
        mainKey: "main",
        scope: "agent",
        agents: [{ id: "main" }],
      },
      staleRosterClient: true,
    });

    const pending = await loadNewSessionData(context, "?agent=research&catalog=claude");

    expect(pending.agentId).toBe("");
    expect(request).not.toHaveBeenCalled();

    agentsState.client = client;
    agentsState.agentsList = {
      defaultId: "roboclaw",
      mainKey: "main",
      scope: "agent",
      agents: [{ id: "roboclaw" }, { id: "research" }],
    };
    const data = await loadNewSessionData(context, "?agent=research&catalog=claude");

    expect(data.agentId).toBe("research");
    expect(request).toHaveBeenCalledWith("sessions.catalog.list", {
      agentId: "research",
      catalogId: "claude",
      limitPerHost: 1,
    });
  });

  it("reuses the current gateway client across route retries", async () => {
    const { client, context, request } = createContext({
      assistantAgentId: "roboclaw",
      agentsList: null,
    });

    await loadNewSessionData(context, "?catalog=claude");
    await loadNewSessionData(context, "?catalog=claude");

    expect(context.gateway.snapshot.client).toBe(client);
    expect(request).toHaveBeenCalledTimes(2);
  });
});
