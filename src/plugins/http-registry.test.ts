import { afterEach, describe, expect, it, vi } from "vitest";
import { registerPluginHttpRoute } from "./http-registry.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import {
  pinActivePluginHttpRouteRegistry,
  releasePinnedPluginHttpRouteRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "./runtime.js";

function expectRouteRegistrationDenied(params: {
  replaceExisting: boolean;
  expectedLogFragment: string;
}) {
  const { registry, logs, register } = createLoggedRouteHarness();

  register({
    path: "/plugins/demo",
    auth: "plugin",
    pluginId: "demo-a",
    source: "demo-a-src",
  });

  const unregister = register({
    path: "/plugins/demo",
    auth: "plugin",
    ...(params.replaceExisting ? { replaceExisting: true } : {}),
    pluginId: "demo-b",
    source: "demo-b-src",
  });

  expect(registry.httpRoutes).toHaveLength(1);
  expect(logs.at(-1)).toContain(params.expectedLogFragment);

  unregister();
  expect(registry.httpRoutes).toHaveLength(1);
}

function expectRegisteredRouteShape(
  registry: ReturnType<typeof createEmptyPluginRegistry>,
  params: {
    path: string;
    handler?: unknown;
    auth: "plugin" | "gateway";
    match?: "exact" | "prefix";
    pluginId?: string;
    source?: string;
  },
) {
  expect(registry.httpRoutes).toHaveLength(1);
  expect(registry.httpRoutes[0]).toEqual({
    path: params.path,
    handler: params.handler ?? registry.httpRoutes[0]?.handler,
    auth: params.auth,
    match: params.match ?? "exact",
    pluginId: params.pluginId,
    source: params.source,
  });
}

function createLoggedRouteHarness() {
  const registry = createEmptyPluginRegistry();
  const logs: string[] = [];
  return {
    registry,
    logs,
    register: (
      params: Omit<
        Parameters<typeof registerPluginHttpRoute>[0],
        "registry" | "handler" | "log"
      > & {
        handler?: Parameters<typeof registerPluginHttpRoute>[0]["handler"];
      },
    ) =>
      registerPluginHttpRoute({
        ...params,
        handler: params.handler ?? vi.fn(),
        registry,
        log: (msg) => logs.push(msg),
      }),
  };
}

describe("registerPluginHttpRoute", () => {
  afterEach(() => {
    releasePinnedPluginHttpRouteRegistry();
    resetPluginRuntimeStateForTest();
  });

  it("registers route and unregisters it", () => {
    const registry = createEmptyPluginRegistry();
    const handler = vi.fn();

    const unregister = registerPluginHttpRoute({
      path: "/plugins/demo",
      auth: "plugin",
      handler,
      registry,
    });

    expectRegisteredRouteShape(registry, {
      path: "/plugins/demo",
      handler,
      auth: "plugin",
      match: "exact",
    });

    unregister();
    expect(registry.httpRoutes).toHaveLength(0);
  });

  it("returns noop unregister when path is missing", () => {
    const registry = createEmptyPluginRegistry();
    const logs: string[] = [];
    const unregister = registerPluginHttpRoute({
      path: "",
      auth: "plugin",
      handler: vi.fn(),
      registry,
      accountId: "default",
      log: (msg) => logs.push(msg),
    });

    expect(registry.httpRoutes).toHaveLength(0);
    expect(logs).toEqual(['plugin: webhook path missing for account "default"']);
    unregister();
  });

  it("replaces stale route on same path when replaceExisting=true", () => {
    const { registry, logs, register } = createLoggedRouteHarness();
    const firstHandler = vi.fn();
    const secondHandler = vi.fn();

    const unregisterFirst = register({
      path: "/plugins/synology",
      auth: "plugin",
      handler: firstHandler,
      accountId: "default",
      pluginId: "synology-chat",
    });

    const unregisterSecond = register({
      path: "/plugins/synology",
      auth: "plugin",
      replaceExisting: true,
      handler: secondHandler,
      accountId: "default",
      pluginId: "synology-chat",
    });

    expect(registry.httpRoutes).toHaveLength(1);
    expect(registry.httpRoutes[0]?.handler).toBe(secondHandler);
    expect(logs).toContain(
      'plugin: replacing stale webhook path /plugins/synology (exact) for account "default" (synology-chat)',
    );

    // Old unregister must not remove the replacement route.
    unregisterFirst();
    expect(registry.httpRoutes).toHaveLength(1);
    expect(registry.httpRoutes[0]?.handler).toBe(secondHandler);

    unregisterSecond();
    expect(registry.httpRoutes).toHaveLength(0);
  });

  it.each([
    {
      name: "rejects conflicting route registrations without replaceExisting",
      replaceExisting: false,
      expectedLogFragment: "route conflict",
    },
    {
      name: "rejects route replacement when a different plugin owns the route",
      replaceExisting: true,
      expectedLogFragment: "route replacement denied",
    },
  ] as const)("$name", ({ replaceExisting, expectedLogFragment }) => {
    expectRouteRegistrationDenied({
      replaceExisting,
      expectedLogFragment,
    });
  });

  it("rejects mixed-auth overlapping routes", () => {
    const { registry, logs, register } = createLoggedRouteHarness();

    register({
      path: "/plugin/secure",
      auth: "gateway",
      match: "prefix",
      pluginId: "demo-gateway",
      source: "demo-gateway-src",
    });

    const unregister = register({
      path: "/plugin/secure/report",
      auth: "plugin",
      match: "exact",
      pluginId: "demo-plugin",
      source: "demo-plugin-src",
    });

    expect(registry.httpRoutes).toHaveLength(1);
    expect(logs.at(-1)).toContain("route overlap denied");

    unregister();
    expect(registry.httpRoutes).toHaveLength(1);
  });

  it("uses the pinned route registry when the active registry changes later", () => {
    const startupRegistry = createEmptyPluginRegistry();
    const laterActiveRegistry = createEmptyPluginRegistry();

    setActivePluginRegistry(startupRegistry);
    pinActivePluginHttpRouteRegistry(startupRegistry);
    setActivePluginRegistry(laterActiveRegistry);

    const unregister = registerPluginHttpRoute({
      path: "/imessage-webhook",
      auth: "plugin",
      handler: vi.fn(),
    });

    expectRegisteredRouteShape(startupRegistry, {
      path: "/imessage-webhook",
      auth: "plugin",
    });
    expect(laterActiveRegistry.httpRoutes).toHaveLength(0);

    unregister();
    expect(startupRegistry.httpRoutes).toHaveLength(0);
  });
});
