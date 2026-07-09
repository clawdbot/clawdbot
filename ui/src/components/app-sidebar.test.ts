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
} from "../app/context.ts";
import type { SessionCapability } from "../lib/sessions/index.ts";
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
  updateComplete: Promise<boolean>;
};

function createGateway(client: GatewayBrowserClient): ApplicationGateway {
  return {
    snapshot: {
      client,
      connected: true,
      reconnecting: false,
      hello: null,
      assistantAgentId: "main",
      sessionKey: "agent:main:main",
      lastError: null,
      lastErrorCode: null,
    },
    subscribe: () => () => undefined,
  } as unknown as ApplicationGateway;
}

function createSessions(agentId: string, keys: string[]): SessionCapability {
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
    state: {
      result,
      agentId,
      modelOverrides: {},
      loading: false,
      error: null,
      deletedSessions: [],
    },
    subscribe: () => () => undefined,
    subscribeCreated: () => () => undefined,
  } as unknown as SessionCapability;
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

afterEach(() => {
  document.body.replaceChildren();
});

describe("AppSidebar session source lifecycle", () => {
  it("resets cached rows and creation order when the sessions source changes", async () => {
    const client = {} as GatewayBrowserClient;
    const gateway = createGateway(client);
    const provider = document.createElement(PROVIDER_ELEMENT_NAME) as AppSidebarContextProvider;
    const sidebar = document.createElement(
      "openclaw-app-sidebar",
    ) as unknown as SidebarLifecycleState;
    provider.setContext(createContext(gateway, createSessions("first", ["first-a", "first-b"])));
    provider.append(sidebar);
    document.body.append(provider);
    await sidebar.updateComplete;

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
  });
});
