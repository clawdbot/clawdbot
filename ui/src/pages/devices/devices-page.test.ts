/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { PresenceEntry } from "../../api/types.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import {
  createInitialDevicesState,
  loadNodes,
  type InventoryRemovalRequest,
} from "../../lib/nodes/index.ts";
import type { DevicesRouteData } from "./devices-page.ts";
import "./devices-page.ts";

vi.mock("../../components/confirm-dialog.ts", () => ({ showConfirmDialog: vi.fn() }));

type TestDevicesPage = HTMLElement & {
  context: ApplicationContext;
  pageState: ReturnType<typeof createInitialDevicesState>;
  requestGeneration: number;
  presence: PresenceEntry[];
  routeData?: DevicesRouteData;
  subscriptions: {
    hostConnected: () => void;
    hostUpdate: () => void;
    hostDisconnected: () => void;
  };
  disconnectedCallback: () => void;
  willUpdate: (changed: Map<PropertyKey, unknown>) => void;
  gateway: {
    applySnapshot: (
      snapshot: ApplicationGatewaySnapshot,
      binding: { initial: boolean; sourceChanged: boolean },
    ) => void;
  };
  ensureInitialData: () => void;
  confirmInventoryRemoval: (prompt: {
    kind: "entry";
    entry: InventoryRemovalRequest;
  }) => Promise<void>;
};

function applyGatewaySnapshot(
  page: TestDevicesPage,
  snapshot: ApplicationGatewaySnapshot,
  sourceChanged = false,
) {
  page.gateway.applySnapshot(snapshot, { initial: false, sourceChanged });
}

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
    phase: connected ? "connected" : "reconnecting",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
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
    phase: "stopped",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
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

describe("DevicesPage gateway lifecycle", () => {
  it("preserves matching initial route data, then resets it on provider replacement", () => {
    const client = null;
    const currentGateway = gateway(client);
    const preloadedNodes = [{ id: "preloaded" }];
    const page = document.createElement("openclaw-devices-page") as TestDevicesPage;
    page.routeData = {
      gateway: currentGateway,
      gatewaySnapshot: currentGateway.snapshot,
      devices: {
        ...createInitialDevicesState({
          client: currentGateway.snapshot.client,
          connected: currentGateway.snapshot.phase === "connected",
        }),
        nodes: preloadedNodes,
      },
    };
    page.context = { gateway: currentGateway } as unknown as ApplicationContext;
    page.willUpdate(new Map([["routeData", undefined]]));

    page.subscriptions.hostConnected();
    expect(page.pageState.client).toBeNull();
    expect(page.pageState.nodes).toBe(preloadedNodes);

    page.context = { gateway: gateway(client) } as unknown as ApplicationContext;
    page.presence = [{ instanceId: "stale", ts: 1_000 }];
    applyGatewaySnapshot(page, page.context.gateway.snapshot, true);
    expect(page.pageState.nodes).toEqual([]);
    expect(page.presence).toEqual([]);
    expect(page.requestGeneration).toBeGreaterThan(0);

    page.subscriptions.hostDisconnected();
  });

  it("rejects preloaded data after a same-client gateway epoch change", () => {
    const client = {} as GatewayBrowserClient;
    const currentGateway = gateway(client);
    const preloadedNodes = [{ id: "stale" }];
    const page = document.createElement("openclaw-devices-page") as TestDevicesPage;
    page.ensureInitialData = vi.fn();
    page.routeData = {
      gateway: currentGateway,
      gatewaySnapshot: gatewaySnapshot(client, false),
      devices: {
        ...createInitialDevicesState({ client, connected: true }),
        nodes: preloadedNodes,
      },
    };
    page.context = { gateway: currentGateway } as unknown as ApplicationContext;

    page.willUpdate(new Map([["routeData", undefined]]));

    expect(page.pageState.nodes).toEqual([]);
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
    const page = document.createElement("openclaw-devices-page") as TestDevicesPage;
    page.pageState = createInitialDevicesState({ client, connected: true });
    page.context = {
      runtimeConfig: { state: { configSnapshot: null, configLoading: false } },
    } as unknown as ApplicationContext;

    const staleLoad = loadNodes(page.pageState);
    applyGatewaySnapshot(page, gatewaySnapshot(client, false));
    applyGatewaySnapshot(page, gatewaySnapshot(client, true));
    const currentLoad = loadNodes(page.pageState);

    first.resolve({ nodes: [{ id: "old" }] });
    await staleLoad;
    expect(page.pageState.nodes).toEqual([]);
    expect(page.pageState.nodesLoading).toBe(true);

    second.resolve({ nodes: [{ id: "new" }] });
    await currentLoad;
    expect(page.pageState.nodes).toEqual([{ id: "new" }]);
    expect(page.pageState.nodesLoading).toBe(false);

    applyGatewaySnapshot(page, gatewaySnapshot(client, false));
  });

  it("retires an in-flight load when its gateway provider changes without a client change", async () => {
    const first = deferred<{ nodes: Array<Record<string, unknown>> }>();
    const second = deferred<{ nodes: Array<Record<string, unknown>> }>();
    const request = vi
      .fn<(method: string, params?: unknown) => Promise<unknown>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const client = { request } as unknown as GatewayBrowserClient;
    const snapshot = gatewaySnapshot(client, true);
    const page = document.createElement("openclaw-devices-page") as TestDevicesPage;
    page.context = {
      runtimeConfig: { state: { configSnapshot: null, configLoading: false } },
    } as unknown as ApplicationContext;
    applyGatewaySnapshot(page, snapshot);

    const staleLoad = loadNodes(page.pageState);
    const previousGeneration = page.requestGeneration;
    applyGatewaySnapshot(page, snapshot, true);
    const currentLoad = loadNodes(page.pageState);

    expect(page.requestGeneration).toBeGreaterThan(previousGeneration);
    first.resolve({ nodes: [{ id: "old" }] });
    await staleLoad;
    expect(page.pageState.nodes).toEqual([]);
    expect(page.pageState.nodesLoading).toBe(true);

    second.resolve({ nodes: [{ id: "new" }] });
    await currentLoad;
    expect(page.pageState.nodes).toEqual([{ id: "new" }]);
    expect(page.pageState.nodesLoading).toBe(false);

    applyGatewaySnapshot(page, gatewaySnapshot(client, false));
  });

  it("restores request ownership when a disconnected page reconnects", async () => {
    const first = deferred<{ nodes: Array<Record<string, unknown>> }>();
    const second = deferred<{ nodes: Array<Record<string, unknown>> }>();
    const request = vi
      .fn<(method: string, params?: unknown) => Promise<unknown>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const client = { request } as unknown as GatewayBrowserClient;
    const snapshot = gatewaySnapshot(client, true);
    const page = document.createElement("openclaw-devices-page") as TestDevicesPage;
    page.context = {
      runtimeConfig: { state: { configSnapshot: null, configLoading: false } },
    } as unknown as ApplicationContext;
    applyGatewaySnapshot(page, snapshot);

    const staleLoad = loadNodes(page.pageState);
    page.disconnectedCallback();
    applyGatewaySnapshot(page, snapshot, true);
    const currentLoad = loadNodes(page.pageState);

    first.resolve({ nodes: [{ id: "old" }] });
    await staleLoad;
    expect(page.pageState.nodes).toEqual([]);
    expect(page.pageState.nodesLoading).toBe(true);

    second.resolve({ nodes: [{ id: "new" }] });
    await currentLoad;
    expect(page.pageState.nodes).toEqual([{ id: "new" }]);

    applyGatewaySnapshot(page, gatewaySnapshot(client, false));
  });

  it("cancels a pending removal confirmation when the connection resets", async () => {
    const request = vi.fn();
    const client = { request } as unknown as GatewayBrowserClient;
    const confirmation = deferred<boolean>();
    vi.mocked(showConfirmDialog).mockReturnValueOnce(confirmation.promise);
    const page = document.createElement("openclaw-devices-page") as TestDevicesPage;
    page.pageState = createInitialDevicesState({ client, connected: true });
    page.context = {
      runtimeConfig: { state: { configSnapshot: null, configLoading: false } },
    } as unknown as ApplicationContext;
    const pending = page.confirmInventoryRemoval({
      kind: "entry",
      entry: { id: "device-1", name: "Browser", removeNode: false, removeDevice: true },
    });
    await Promise.resolve();
    const signal = vi.mocked(showConfirmDialog).mock.calls[0]?.[0].signal;

    applyGatewaySnapshot(page, gatewaySnapshot(client, false));
    confirmation.resolve(true);
    await pending;

    expect(signal?.aborted).toBe(true);
    expect(request).not.toHaveBeenCalled();
  });
});
