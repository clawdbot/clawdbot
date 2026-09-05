import type { ReactiveController, ReactiveControllerHost } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ApplicationGateway, ApplicationGatewaySnapshot } from "../app/context.ts";
import { GatewayPageController } from "./gateway-page-controller.ts";

function snapshot(
  client: GatewayBrowserClient | null,
  phase: ApplicationGatewaySnapshot["phase"],
): ApplicationGatewaySnapshot {
  return {
    client,
    phase,
    offlineStable: false,
    hello: null,
    canvasPluginSurfaceUrl: null,
    assistantAgentId: null,
    sessionKey: "agent:main:main",
    lastError: null,
    lastErrorCode: null,
  };
}

function createGateway(initial: ApplicationGatewaySnapshot) {
  let current = initial;
  const listeners = new Set<(value: ApplicationGatewaySnapshot) => void>();
  const gateway = {
    get snapshot() {
      return current;
    },
    subscribe(listener: (value: ApplicationGatewaySnapshot) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as ApplicationGateway;
  return {
    gateway,
    publish(next: ApplicationGatewaySnapshot) {
      current = next;
      for (const listener of listeners) {
        listener(next);
      }
    },
  };
}

function createHost() {
  const controllers: ReactiveController[] = [];
  const requestUpdate = vi.fn();
  const host = {
    addController(controller: ReactiveController) {
      controllers.push(controller);
    },
    removeController() {},
    requestUpdate,
    updateComplete: Promise.resolve(true),
  } satisfies ReactiveControllerHost;
  return {
    host,
    requestUpdate,
    connect() {
      for (const controller of controllers) {
        controller.hostConnected?.();
      }
    },
    update() {
      for (const controller of controllers) {
        controller.hostUpdate?.();
      }
    },
    disconnect() {
      for (const controller of controllers) {
        controller.hostDisconnected?.();
      }
    },
  };
}

describe("GatewayPageController", () => {
  it("binds the current source and retires work across same-client reconnects", () => {
    const client = {} as GatewayBrowserClient;
    const source = createGateway(snapshot(client, "connected"));
    const host = createHost();
    const identityChanges = vi.fn();
    const invalidations = vi.fn();
    const ensureInitialData = vi.fn();
    const controller = new GatewayPageController(host.host, {
      getGateway: () => source.gateway,
      onIdentityChange: identityChanges,
      invalidateRequests: invalidations,
      ensureInitialData,
    });

    host.connect();
    const first = controller.capture();
    expect(controller.client).toBe(client);
    expect(controller.connected).toBe(true);
    expect(first).not.toBeNull();

    source.publish(snapshot(client, "reconnecting"));
    expect(first && controller.isCurrent(first)).toBe(false);
    expect(controller.capture()).toBeNull();

    source.publish(snapshot(client, "connected"));
    expect(controller.capture()).not.toBeNull();
    expect(identityChanges).not.toHaveBeenCalled();
    expect(invalidations).toHaveBeenCalledTimes(2);
    expect(ensureInitialData).toHaveBeenCalledTimes(2);
  });

  it("treats an equivalent replacement source as a new identity", () => {
    const client = {} as GatewayBrowserClient;
    const first = createGateway(snapshot(client, "connected"));
    const second = createGateway(snapshot(client, "connected"));
    let gateway = first.gateway;
    const host = createHost();
    const identityChanges = vi.fn();
    const controller = new GatewayPageController(host.host, {
      getGateway: () => gateway,
      onIdentityChange: identityChanges,
    });
    host.connect();
    const scope = controller.capture();

    gateway = second.gateway;
    host.update();

    expect(scope && controller.isCurrent(scope)).toBe(false);
    expect(identityChanges).toHaveBeenLastCalledWith(
      expect.objectContaining({ sourceChanged: true, identityChanged: true }),
    );
  });

  it("checks route data by exact source and snapshot identity", () => {
    const current = createGateway(snapshot({} as GatewayBrowserClient, "connected"));
    const host = createHost();
    const controller = new GatewayPageController(host.host, {
      getGateway: () => current.gateway,
    });
    host.connect();

    expect(
      controller.isRouteDataCurrent({
        gateway: current.gateway,
        gatewaySnapshot: current.gateway.snapshot,
      }),
    ).toBe(true);
    expect(
      controller.isRouteDataCurrent({
        gateway: current.gateway,
        gatewaySnapshot: { ...current.gateway.snapshot },
      }),
    ).toBe(false);
  });

  it("keeps route data current through metadata clones within one hello epoch", () => {
    const client = {} as GatewayBrowserClient;
    const hello = {} as NonNullable<ApplicationGatewaySnapshot["hello"]>;
    const firstSnapshot = { ...snapshot(client, "connected"), hello };
    const current = createGateway(firstSnapshot);
    const host = createHost();
    const controller = new GatewayPageController(host.host, {
      getGateway: () => current.gateway,
    });
    host.connect();
    const routeData = {
      gateway: current.gateway,
      gatewaySnapshot: firstSnapshot,
    };

    current.publish({ ...firstSnapshot });
    expect(controller.isRouteDataCurrent(routeData)).toBe(true);

    current.publish({
      ...firstSnapshot,
      hello: {} as NonNullable<ApplicationGatewaySnapshot["hello"]>,
    });
    expect(controller.isRouteDataCurrent(routeData)).toBe(false);
  });

  it("can reconnect after the host detaches", () => {
    const current = createGateway(snapshot({} as GatewayBrowserClient, "connected"));
    const host = createHost();
    const identityChanges = vi.fn();
    const controller = new GatewayPageController(host.host, {
      getGateway: () => current.gateway,
      onIdentityChange: identityChanges,
    });
    host.connect();
    const stale = controller.capture();

    host.disconnect();
    expect(stale && controller.isCurrent(stale)).toBe(false);
    expect(controller.capture()).toBeNull();
    expect(identityChanges).not.toHaveBeenCalled();

    host.connect();
    expect(controller.capture()).not.toBeNull();
    expect(identityChanges).toHaveBeenCalledTimes(1);
  });
});
