/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { createInitialNodesState, loadNodes } from "../../lib/nodes/index.ts";
import type { NodesRouteData } from "./nodes-page.ts";
import "./nodes-page.ts";

type TestNodesPage = HTMLElement & {
  context: ApplicationContext;
  client: GatewayBrowserClient | null;
  connected: boolean;
  requestGeneration: number;
  nodesLoading: boolean;
  nodes: Array<Record<string, unknown>>;
  lastError: string | null;
  chatError: string | null;
  routeData?: NodesRouteData;
  subscriptions: {
    hostConnected: () => void;
    hostUpdate: () => void;
    hostDisconnected: () => void;
  };
  willUpdate: (changed: Map<PropertyKey, unknown>) => void;
  applyGatewaySnapshot: (
    snapshot: ApplicationGatewaySnapshot,
    forceReset: boolean,
    initialBind?: boolean,
  ) => void;
  ensureInitialData: () => void;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function gatewaySnapshot(
  client: GatewayBrowserClient | null,
  connected: boolean,
): ApplicationGatewaySnapshot {
  return {
    client,
    connected,
    reconnecting: !connected,
    hello: null,
    assistantAgentId: null,
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
}

function gateway(client: GatewayBrowserClient | null): ApplicationContext["gateway"] {
  const snapshot: ApplicationGatewaySnapshot = {
    client,
    connected: false,
    reconnecting: false,
    hello: null,
    assistantAgentId: null,
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
  return {
    snapshot,
    subscribe: vi.fn(() => () => undefined),
    subscribeEvents: vi.fn(() => () => undefined),
  } as unknown as ApplicationContext["gateway"];
}

describe("NodesPage gateway lifecycle", () => {
  it("preserves matching initial route data, then resets it on provider replacement", () => {
    const client = null;
    const currentGateway = gateway(client);
    const preloadedNodes = [{ id: "preloaded" }];
    const page = document.createElement("openclaw-nodes-page") as TestNodesPage;
    page.routeData = {
      gateway: currentGateway,
      gatewaySnapshot: currentGateway.snapshot,
      nodes: {
        ...createInitialNodesState(currentGateway.snapshot),
        nodes: preloadedNodes,
      },
    };
    page.context = { gateway: currentGateway } as unknown as ApplicationContext;
    page.willUpdate(new Map([["routeData", undefined]]));

    page.subscriptions.hostConnected();
    expect(page.client).toBeNull();
    expect(page.nodes).toBe(preloadedNodes);

    page.context = { gateway: gateway(client) } as unknown as ApplicationContext;
    page.subscriptions.hostUpdate();
    expect(page.nodes).toEqual([]);
    expect(page.requestGeneration).toBeGreaterThan(0);

    page.subscriptions.hostDisconnected();
  });

  it("rejects preloaded data after a same-client gateway epoch change", () => {
    const client = {} as GatewayBrowserClient;
    const currentGateway = gateway(client);
    const preloadedNodes = [{ id: "stale" }];
    const page = document.createElement("openclaw-nodes-page") as TestNodesPage;
    page.ensureInitialData = vi.fn();
    page.routeData = {
      gateway: currentGateway,
      gatewaySnapshot: gatewaySnapshot(client, false),
      nodes: {
        ...createInitialNodesState(gatewaySnapshot(client, true)),
        nodes: preloadedNodes,
      },
    };
    page.context = { gateway: currentGateway } as unknown as ApplicationContext;

    page.willUpdate(new Map([["routeData", undefined]]));

    expect(page.nodes).toEqual([]);
    expect(page.ensureInitialData).toHaveBeenCalledOnce();
  });

  it("retries a node load after a same-client disconnect", async () => {
    const first = deferred<{ nodes: Array<Record<string, unknown>> }>();
    const second = deferred<{ nodes: Array<Record<string, unknown>> }>();
    const request = vi
      .fn<(method: string, params?: unknown) => Promise<unknown>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const client = { request } as unknown as GatewayBrowserClient;
    const page = document.createElement("openclaw-nodes-page") as TestNodesPage;
    page.client = client;
    page.connected = true;
    page.context = {
      runtimeConfig: { state: { configSnapshot: null, configLoading: false } },
    } as unknown as ApplicationContext;

    const staleLoad = loadNodes(page);
    page.applyGatewaySnapshot(gatewaySnapshot(client, false), false);
    page.applyGatewaySnapshot(gatewaySnapshot(client, true), false);
    const currentLoad = loadNodes(page);

    first.resolve({ nodes: [{ id: "old" }] });
    await staleLoad;
    expect(page.nodes).toEqual([]);
    expect(page.nodesLoading).toBe(true);

    second.resolve({ nodes: [{ id: "new" }] });
    await currentLoad;
    expect(page.nodes).toEqual([{ id: "new" }]);
    expect(page.nodesLoading).toBe(false);

    page.applyGatewaySnapshot(gatewaySnapshot(client, false), false);
  });
});
