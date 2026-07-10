/* @vitest-environment jsdom */

import { ContextProvider } from "@lit/context";
import { LitElement } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { SessionsListResult } from "../api/types.ts";
import type { RouteId } from "../app-route-paths.ts";
import {
  applicationContext,
  type ApplicationContext,
  type ApplicationGateway,
  type ApplicationGatewaySnapshot,
} from "../app/context.ts";
import type { SessionCapability, SessionState } from "../lib/sessions/index.ts";
import "./app-sidebar.ts";

const PROVIDER_ELEMENT_NAME = "test-app-sidebar-context-provider";

class AppSidebarContextProvider extends LitElement {
  private readonly contextProvider = new ContextProvider(this, {
    context: applicationContext,
  });

  setContext(context: ApplicationContext<RouteId>) {
    this.contextProvider.setValue(context);
  }
}

if (!customElements.get(PROVIDER_ELEMENT_NAME)) {
  customElements.define(PROVIDER_ELEMENT_NAME, AppSidebarContextProvider);
}

type SidebarLifecycleState = HTMLElement & {
  sessionRowsByAgent: Record<string, SessionsListResult["sessions"]>;
  sessionCreatedOrder: Map<string, number>;
  sessionsAgentId: string | null;
  sessionsResult: SessionsListResult | null;
  updateComplete: Promise<boolean>;
};

function createGatewayHarness(client: GatewayBrowserClient) {
  let snapshot: ApplicationGatewaySnapshot = {
    client,
    connected: true,
    reconnecting: false,
    hello: null,
    assistantAgentId: "main",
    sessionKey: "agent:main:main",
    lastError: null,
    lastErrorCode: null,
  };
  const listeners = new Set<(next: ApplicationGatewaySnapshot) => void>();
  const gateway = {
    get snapshot() {
      return snapshot;
    },
    subscribe(listener: (next: ApplicationGatewaySnapshot) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as ApplicationGateway;
  return {
    gateway,
    publish(patch: Partial<ApplicationGatewaySnapshot>) {
      snapshot = { ...snapshot, ...patch };
      for (const listener of listeners) {
        listener(snapshot);
      }
    },
  };
}

function createSessionState(agentId: string, keys: string[]): SessionState {
  const result = {
    ts: 1,
    path: "",
    count: keys.length,
    defaults: {
      modelProvider: null,
      model: null,
      contextTokens: null,
    },
    sessions: keys.map((key, index) => ({
      key,
      kind: "direct" as const,
      updatedAt: index + 1,
    })),
  } satisfies SessionsListResult;
  return {
    result,
    agentId,
    modelOverrides: {},
    loading: false,
    error: null,
    deletedSessions: [],
  };
}

function createSessionsHarness(agentId: string, keys: string[]) {
  let state = createSessionState(agentId, keys);
  let canonicalListRevision = 1;
  const listeners = new Set<(next: SessionState) => void>();
  const sessions = {
    get state() {
      return state;
    },
    get canonicalListRevision() {
      return canonicalListRevision;
    },
    subscribe(listener: (next: SessionState) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeCreated: () => () => undefined,
  } as unknown as SessionCapability;
  const publish = (patch: Partial<SessionState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) {
      listener(state);
    }
  };
  return {
    sessions,
    publish,
    publishList(patch: Partial<SessionState>) {
      canonicalListRevision += 1;
      publish(patch);
    },
  };
}

function createGateway(client: GatewayBrowserClient): ApplicationGateway {
  return createGatewayHarness(client).gateway;
}

function createSessions(agentId: string, keys: string[]): SessionCapability {
  return createSessionsHarness(agentId, keys).sessions;
}

function createContext(
  gateway: ApplicationGateway,
  sessions: SessionCapability,
): ApplicationContext<RouteId> {
  return {
    gateway,
    sessions,
    agents: {
      state: { agentsList: null },
      subscribe: () => () => undefined,
    },
    agentSelection: {
      state: { selectedId: "main" },
      set: () => undefined,
      subscribe: () => () => undefined,
    },
  } as unknown as ApplicationContext<RouteId>;
}

async function mountSidebar(gateway: ApplicationGateway, sessions: SessionCapability) {
  const provider = document.createElement(PROVIDER_ELEMENT_NAME) as AppSidebarContextProvider;
  const sidebar = document.createElement(
    "openclaw-app-sidebar",
  ) as unknown as SidebarLifecycleState;
  provider.setContext(createContext(gateway, sessions));
  provider.append(sidebar);
  document.body.append(provider);
  await sidebar.updateComplete;
  return { provider, sidebar };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("AppSidebar session source lifecycle", () => {
  it("resets cached rows and creation order when the sessions source changes", async () => {
    const client = {} as GatewayBrowserClient;
    const gateway = createGateway(client);
    const { provider, sidebar } = await mountSidebar(
      gateway,
      createSessions("first", ["first-a", "first-b"]),
    );

    expect(Object.keys(sidebar.sessionRowsByAgent)).toEqual(["first"]);
    expect([...sidebar.sessionCreatedOrder]).toEqual([
      ["first-a", 0],
      ["first-b", 1],
    ]);

    // The Gateway and its client stay unchanged while the sessions capability is replaced.
    provider.setContext(createContext(gateway, createSessions("second", ["second-b", "second-a"])));
    await sidebar.updateComplete;

    expect(Object.keys(sidebar.sessionRowsByAgent)).toEqual(["second"]);
    expect([...sidebar.sessionCreatedOrder]).toEqual([
      ["second-b", 0],
      ["second-a", 1],
    ]);
    expect(sidebar.sessionsAgentId).toBe("second");
    expect(sidebar.sessionsResult?.sessions.map((row) => row.key)).toEqual([
      "second-b",
      "second-a",
    ]);
  });

  it("preserves the scoped result through a disconnect on the same Gateway client", async () => {
    const client = {} as GatewayBrowserClient;
    const gateway = createGatewayHarness(client);
    const sessions = createSessionsHarness("main", ["main-a", "main-b"]);
    const { sidebar } = await mountSidebar(gateway.gateway, sessions.sessions);
    const cachedResult = sidebar.sessionsResult;

    gateway.publish({ connected: false, reconnecting: true });
    sessions.publish({ result: null, agentId: null, loading: false });
    await sidebar.updateComplete;

    expect(sidebar.sessionsResult).toBe(cachedResult);
    expect(sidebar.sessionsAgentId).toBe("main");
    expect(Object.keys(sidebar.sessionRowsByAgent)).toEqual(["main"]);
    expect([...sidebar.sessionCreatedOrder.keys()]).toEqual(["main-a", "main-b"]);

    gateway.publish({ connected: true, reconnecting: false });
    const partial = createSessionState("main", ["main-a"]);
    sessions.publish({ result: partial.result, agentId: partial.agentId });
    await sidebar.updateComplete;

    expect(sidebar.sessionsResult).toBe(cachedResult);
    expect(sidebar.sessionsResult?.sessions.map((row) => row.key)).toEqual(["main-a", "main-b"]);
    expect(sidebar.sessionRowsByAgent.main?.map((row) => row.key)).toEqual(["main-a", "main-b"]);

    const refreshed = createSessionState("main", ["main-c"]);
    sessions.publishList({ result: refreshed.result, agentId: refreshed.agentId });
    await sidebar.updateComplete;

    expect(sidebar.sessionsResult?.sessions.map((row) => row.key)).toEqual(["main-c"]);
    expect(sidebar.sessionsAgentId).toBe("main");
  });

  it("clears every cached session view when the Gateway client is replaced", async () => {
    const firstClient = {} as GatewayBrowserClient;
    const gateway = createGatewayHarness(firstClient);
    const sessions = createSessionsHarness("main", ["main-a"]);
    const { sidebar } = await mountSidebar(gateway.gateway, sessions.sessions);

    gateway.publish({
      client: {} as GatewayBrowserClient,
      connected: false,
      reconnecting: true,
    });
    await sidebar.updateComplete;

    expect(sidebar.sessionsResult).toBeNull();
    expect(sidebar.sessionsAgentId).toBeNull();
    expect(sidebar.sessionRowsByAgent).toEqual({});
    expect(sidebar.sessionCreatedOrder.size).toBe(0);
  });

  it("clears every cached session view when the Gateway source is replaced", async () => {
    const client = {} as GatewayBrowserClient;
    const gateway = createGatewayHarness(client);
    const sessions = createSessionsHarness("main", ["main-a"]);
    const { provider, sidebar } = await mountSidebar(gateway.gateway, sessions.sessions);

    const replacementGateway = createGatewayHarness(client);
    provider.setContext(createContext(replacementGateway.gateway, sessions.sessions));
    await sidebar.updateComplete;

    expect(sidebar.sessionsResult).toBeNull();
    expect(sidebar.sessionsAgentId).toBeNull();
    expect(sidebar.sessionRowsByAgent).toEqual({});
    expect(sidebar.sessionCreatedOrder.size).toBe(0);
  });
});
