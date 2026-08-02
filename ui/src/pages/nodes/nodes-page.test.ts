/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { PresenceEntry } from "../../api/types.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import {
  approveNodePairingRequest,
  createInitialNodesState,
  loadNodes,
  rejectNodePairingRequest,
  removeInventoryEntry,
  removeStaleInventoryEntries,
  type InventoryRemovalRequest,
  type NodesPageDataState,
} from "../../lib/nodes/index.ts";
import type { NodesRouteData } from "./nodes-page.ts";
import "./nodes-page.ts";
import type { InventoryRemovalPrompt } from "./view.types.ts";

type TestNodesPage = HTMLElement &
  NodesPageDataState & {
    context: ApplicationContext;
    client: GatewayBrowserClient | null;
    presence: PresenceEntry[];
    chatError: string | null;
    inventoryRemovalPrompt: InventoryRemovalPrompt | null;
    routeData?: NodesRouteData;
    subscriptions: {
      hostConnected: () => void;
      hostUpdate: () => void;
      hostDisconnected: () => void;
    };
    disconnectedCallback: () => void;
    willUpdate: (changed: Map<PropertyKey, unknown>) => void;
    applyGatewaySnapshot: (
      snapshot: ApplicationGatewaySnapshot,
      forceReset: boolean,
      initialBind?: boolean,
    ) => void;
    ensureInitialData: () => void;
    updateComplete: Promise<boolean>;
  };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
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

function connectedGateway(client: GatewayBrowserClient): ApplicationContext["gateway"] {
  return {
    snapshot: gatewaySnapshot(client, true),
    connection: { gatewayUrl: "ws://gateway.test" },
    subscribe: vi.fn(() => () => undefined),
    subscribeEvents: vi.fn(() => () => undefined),
  } as unknown as ApplicationContext["gateway"];
}

async function mountNodesPage(client: GatewayBrowserClient): Promise<TestNodesPage> {
  const page = document.createElement("openclaw-nodes-page") as TestNodesPage;
  page.context = {
    gateway: connectedGateway(client),
    runtimeConfig: {
      state: {
        configSnapshot: { config: {} },
        configForm: null,
        configLoading: false,
        configSaving: false,
        configFormDirty: false,
        configFormMode: "form",
      },
      subscribe: vi.fn(() => () => undefined),
    },
    overlays: { openDevicePairSetup: vi.fn() },
  } as unknown as ApplicationContext;
  document.body.append(page);
  await page.updateComplete;
  return page;
}

async function replaceGateway(page: TestNodesPage, client: GatewayBrowserClient) {
  page.context = { ...page.context, gateway: connectedGateway(client) };
  page.subscriptions.hostUpdate();
  await page.updateComplete;
}

const removableDevice = (id: string): InventoryRemovalRequest => ({
  id,
  name: id,
  removeNode: false,
  removeDevice: true,
});

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

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
        ...createInitialNodesState({
          client: currentGateway.snapshot.client,
          connected: currentGateway.snapshot.phase === "connected",
        }),
        nodes: preloadedNodes,
      },
    };
    page.context = { gateway: currentGateway } as unknown as ApplicationContext;
    page.willUpdate(new Map([["routeData", undefined]]));

    page.subscriptions.hostConnected();
    expect(page.client).toBeNull();
    expect(page.nodes).toBe(preloadedNodes);

    page.context = { gateway: gateway(client) } as unknown as ApplicationContext;
    page.presence = [{ instanceId: "stale" }];
    page.subscriptions.hostUpdate();
    expect(page.nodes).toEqual([]);
    expect(page.presence).toEqual([]);
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
        ...createInitialNodesState({ client, connected: true }),
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

  it("retires an in-flight load when its gateway provider changes without a client change", async () => {
    const first = deferred<{ nodes: Array<Record<string, unknown>> }>();
    const second = deferred<{ nodes: Array<Record<string, unknown>> }>();
    const request = vi
      .fn<(method: string, params?: unknown) => Promise<unknown>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const client = { request } as unknown as GatewayBrowserClient;
    const snapshot = gatewaySnapshot(client, true);
    const page = document.createElement("openclaw-nodes-page") as TestNodesPage;
    page.context = {
      runtimeConfig: { state: { configSnapshot: null, configLoading: false } },
    } as unknown as ApplicationContext;
    page.applyGatewaySnapshot(snapshot, false);

    const staleLoad = loadNodes(page);
    const previousGeneration = page.requestGeneration;
    page.applyGatewaySnapshot(snapshot, true);
    const currentLoad = loadNodes(page);

    expect(page.requestGeneration).toBeGreaterThan(previousGeneration);
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

  it("restores request ownership when a disconnected page reconnects", async () => {
    const first = deferred<{ nodes: Array<Record<string, unknown>> }>();
    const second = deferred<{ nodes: Array<Record<string, unknown>> }>();
    const request = vi
      .fn<(method: string, params?: unknown) => Promise<unknown>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const client = { request } as unknown as GatewayBrowserClient;
    const snapshot = gatewaySnapshot(client, true);
    const page = document.createElement("openclaw-nodes-page") as TestNodesPage;
    page.context = {
      runtimeConfig: { state: { configSnapshot: null, configLoading: false } },
    } as unknown as ApplicationContext;
    page.applyGatewaySnapshot(snapshot, false);

    const staleLoad = loadNodes(page);
    page.disconnectedCallback();
    page.applyGatewaySnapshot(snapshot, false);
    const currentLoad = loadNodes(page);

    first.resolve({ nodes: [{ id: "old" }] });
    await staleLoad;
    expect(page.nodes).toEqual([]);
    expect(page.nodesLoading).toBe(true);

    second.resolve({ nodes: [{ id: "new" }] });
    await currentLoad;
    expect(page.nodes).toEqual([{ id: "new" }]);

    page.applyGatewaySnapshot(gatewaySnapshot(client, false), false);
  });

  it("drops a pending removal prompt when the connection resets", () => {
    const client = { request: vi.fn() } as unknown as GatewayBrowserClient;
    const page = document.createElement("openclaw-nodes-page") as TestNodesPage;
    page.client = client;
    page.connected = true;
    page.context = {
      runtimeConfig: { state: { configSnapshot: null, configLoading: false } },
    } as unknown as ApplicationContext;
    page.inventoryRemovalPrompt = {
      kind: "entry",
      entry: { id: "device-1", name: "Browser", removeNode: false, removeDevice: true },
    };

    // Disconnect resets server state; the confirm must not survive onto a
    // different gateway that reuses the same device ids.
    page.applyGatewaySnapshot(gatewaySnapshot(client, false), false);

    expect(page.inventoryRemovalPrompt).toBeNull();
  });

  const mutations = [
    {
      name: "approval",
      method: "node.pair.approve",
      start: (page: TestNodesPage) => approveNodePairingRequest(page, "request-1"),
    },
    {
      name: "rejection",
      method: "node.pair.reject",
      start: (page: TestNodesPage) => rejectNodePairingRequest(page, "request-1"),
    },
    {
      name: "removal",
      method: "device.pair.remove",
      start: (page: TestNodesPage) => removeInventoryEntry(page, removableDevice("device-1")),
    },
    {
      name: "batch removal",
      method: "device.pair.remove",
      start: (page: TestNodesPage) =>
        removeStaleInventoryEntries(page, [removableDevice("device-1")]),
    },
  ] as const;

  it.each(mutations)(
    "does not reload a replacement gateway after stale $name",
    async (mutation) => {
      vi.spyOn(window, "confirm").mockReturnValue(true);
      const pending = deferred<unknown>();
      const previousRequest = vi.fn().mockReturnValue(pending.promise);
      const nextRequest = vi.fn();
      const previousClient = { request: previousRequest } as unknown as GatewayBrowserClient;
      const nextClient = { request: nextRequest } as unknown as GatewayBrowserClient;
      const page = await mountNodesPage(previousClient);

      const operation = mutation.start(page);
      expect(previousRequest).toHaveBeenCalledWith(mutation.method, expect.any(Object));

      await replaceGateway(page, nextClient);
      pending.resolve({});
      await operation;

      expect(nextRequest).not.toHaveBeenCalled();
      expect(page.devicesError).toBeNull();
    },
  );

  it.each(mutations)(
    "does not leak stale $name failures into a replacement gateway",
    async (mutation) => {
      vi.spyOn(window, "confirm").mockReturnValue(true);
      const pending = deferred<unknown>();
      const previousRequest = vi.fn().mockReturnValue(pending.promise);
      const nextRequest = vi.fn();
      const previousClient = { request: previousRequest } as unknown as GatewayBrowserClient;
      const nextClient = { request: nextRequest } as unknown as GatewayBrowserClient;
      const page = await mountNodesPage(previousClient);

      const operation = mutation.start(page);
      await replaceGateway(page, nextClient);
      pending.reject(new Error("old gateway rejected the request"));
      await operation;

      expect(nextRequest).not.toHaveBeenCalled();
      expect(page.devicesError).toBeNull();
    },
  );

  it.each(mutations)(
    "retires $name when a replacement gateway reuses its client",
    async (mutation) => {
      vi.spyOn(window, "confirm").mockReturnValue(true);
      const pending = deferred<unknown>();
      const request = vi.fn().mockReturnValue(pending.promise);
      const client = { request } as unknown as GatewayBrowserClient;
      const page = await mountNodesPage(client);

      const operation = mutation.start(page);
      await replaceGateway(page, client);
      pending.resolve({});
      await operation;

      expect(request).toHaveBeenCalledOnce();
      expect(page.devicesError).toBeNull();
    },
  );

  it.each(mutations)(
    "preserves current-gateway $name and refreshes both inventories",
    async (mutation) => {
      vi.spyOn(window, "confirm").mockReturnValue(true);
      const request = vi.fn().mockResolvedValue({ pending: [], paired: [], nodes: [] });
      const page = await mountNodesPage({ request } as unknown as GatewayBrowserClient);

      await mutation.start(page);

      expect(request).toHaveBeenCalledWith(mutation.method, expect.any(Object));
      expect(request).toHaveBeenCalledWith("device.pair.list", {});
      expect(request).toHaveBeenCalledWith("node.list", {});
      expect(page.devicesError).toBeNull();
    },
  );

  it.each(mutations)(
    "preserves current-gateway $name failures after refreshing",
    async (mutation) => {
      vi.spyOn(window, "confirm").mockReturnValue(true);
      const request = vi.fn((method: string) =>
        method === mutation.method
          ? Promise.reject(new Error("current gateway rejected the request"))
          : Promise.resolve({ pending: [], paired: [], nodes: [] }),
      );
      const page = await mountNodesPage({ request } as unknown as GatewayBrowserClient);

      await mutation.start(page);

      expect(request).toHaveBeenCalledWith("device.pair.list", {});
      expect(request).toHaveBeenCalledWith("node.list", {});
      expect(page.devicesError).toContain("current gateway rejected the request");
    },
  );

  it("does not restore an old failure after a pending inventory refresh changes gateways", async () => {
    const devices = deferred<unknown>();
    const nodes = deferred<unknown>();
    const previousRequest = vi.fn((method: string) => {
      if (method === "node.pair.approve") {
        return Promise.reject(new Error("old gateway rejected the request"));
      }
      return method === "device.pair.list" ? devices.promise : nodes.promise;
    });
    const nextRequest = vi.fn();
    const page = await mountNodesPage({
      request: previousRequest,
    } as unknown as GatewayBrowserClient);

    const operation = approveNodePairingRequest(page, "request-1");
    await vi.waitFor(() => expect(previousRequest).toHaveBeenCalledTimes(3));
    await replaceGateway(page, { request: nextRequest } as unknown as GatewayBrowserClient);
    devices.resolve({ pending: [], paired: [] });
    nodes.resolve({ nodes: [] });
    await operation;

    expect(nextRequest).not.toHaveBeenCalled();
    expect(page.devicesError).toBeNull();
  });

  it("stops destructive batch removal after the gateway changes", async () => {
    const pending = deferred<unknown>();
    const previousRequest = vi.fn().mockReturnValue(pending.promise);
    const nextRequest = vi.fn();
    const page = await mountNodesPage({
      request: previousRequest,
    } as unknown as GatewayBrowserClient);

    const operation = removeStaleInventoryEntries(page, [
      removableDevice("device-1"),
      removableDevice("device-2"),
    ]);
    await replaceGateway(page, { request: nextRequest } as unknown as GatewayBrowserClient);
    pending.resolve({});
    await operation;

    expect(previousRequest).toHaveBeenCalledTimes(1);
    expect(previousRequest).toHaveBeenCalledWith("device.pair.remove", { deviceId: "device-1" });
    expect(nextRequest).not.toHaveBeenCalled();
  });

  it("does not remove a mixed-role device after its node removal outlives the gateway", async () => {
    const pending = deferred<unknown>();
    const previousRequest = vi.fn().mockReturnValue(pending.promise);
    const nextRequest = vi.fn();
    const page = await mountNodesPage({
      request: previousRequest,
    } as unknown as GatewayBrowserClient);

    const operation = removeInventoryEntry(page, {
      id: "shared-1",
      name: "Shared device",
      removeNode: true,
      removeDevice: true,
    });
    await replaceGateway(page, { request: nextRequest } as unknown as GatewayBrowserClient);
    pending.resolve({});
    await operation;

    expect(previousRequest).toHaveBeenCalledTimes(1);
    expect(previousRequest).toHaveBeenCalledWith("node.pair.remove", { nodeId: "shared-1" });
    expect(nextRequest).not.toHaveBeenCalled();
  });
});
