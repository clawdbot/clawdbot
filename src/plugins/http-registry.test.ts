/** Verifies plugin HTTP route registration, collision detection, and metadata capture. */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { registerPluginHttpRoute, withPluginHttpRouteRegistry } from "./http-registry.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { createPluginRegistry } from "./registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "./runtime.js";
import type { PluginRuntime } from "./runtime/types.js";
import { createPluginRecord } from "./status.test-fixtures.js";

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

  it("marks gateway method dispatch entitlement only for plugins declaring the contract", () => {
    const pluginRegistry = createPluginRegistry({
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {},
      },
      runtime: {} as PluginRuntime,
      activateGlobalSideEffects: false,
    });
    const config = {} as OpenClawConfig;
    const plainRecord = createPluginRecord({
      id: "plain-http",
      source: "/plugins/plain-http/index.ts",
    });
    const adminRecord = createPluginRecord({
      id: "admin-http",
      source: "/plugins/admin-http/index.ts",
      contracts: { gatewayMethodDispatch: ["authenticated-request"] },
    });

    pluginRegistry.registry.plugins.push(plainRecord, adminRecord);
    pluginRegistry.createApi(plainRecord, { config }).registerHttpRoute({
      path: "/plain",
      auth: "gateway",
      handler: vi.fn(),
    });
    pluginRegistry.createApi(adminRecord, { config }).registerHttpRoute({
      path: "/admin",
      auth: "gateway",
      handler: vi.fn(),
    });

    const plainRoute = pluginRegistry.registry.httpRoutes.find(
      (route) => route.pluginId === "plain-http",
    );
    const adminRoute = pluginRegistry.registry.httpRoutes.find(
      (route) => route.pluginId === "admin-http",
    );

    expect(plainRoute?.gatewayMethodDispatchAllowed).toBeUndefined();
    expect(adminRoute?.gatewayMethodDispatchAllowed).toBe(true);
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

  it("throws when strict lifecycle registration has no path", () => {
    const registry = createEmptyPluginRegistry();
    const logs: string[] = [];

    expect(() =>
      registerPluginHttpRoute({
        path: "",
        auth: "plugin",
        handler: vi.fn(),
        registry,
        accountId: "default",
        throwOnFailure: true,
        log: (msg) => logs.push(msg),
      }),
    ).toThrow('plugin: webhook path missing for account "default"');
    expect(registry.httpRoutes).toHaveLength(0);
    expect(logs).toEqual(['plugin: webhook path missing for account "default"']);
  });

  it("treats canonical exact-path aliases as one route", () => {
    const { registry, logs, register } = createLoggedRouteHarness();
    register({
      path: "/Webhooks//SMS/",
      auth: "plugin",
      pluginId: "sms",
      source: "primary",
    });

    expect(() =>
      register({
        path: "/webhooks/sms",
        auth: "plugin",
        pluginId: "sms",
        source: "alias",
        throwOnFailure: true,
      }),
    ).toThrow("plugin: route conflict at /webhooks/sms (exact)");
    expect(registry.httpRoutes).toHaveLength(1);
    expect(registry.httpRoutes[0]?.source).toBe("primary");
    expect(logs.at(-1)).toContain("route conflict");
  });

  it("replaces a same-plugin canonical exact-path alias when requested", () => {
    const { registry, register } = createLoggedRouteHarness();
    register({
      path: "/Webhooks/SMS/",
      auth: "plugin",
      pluginId: "sms",
      source: "sms-webhook",
    });

    register({
      path: "/webhooks/sms",
      auth: "plugin",
      pluginId: "sms",
      source: "sms-webhook",
      replaceExisting: true,
      throwOnFailure: true,
    });

    expect(registry.httpRoutes).toHaveLength(1);
    expect(registry.httpRoutes[0]).toMatchObject({
      path: "/webhooks/sms",
      pluginId: "sms",
      source: "sms-webhook",
    });
  });

  it("reuses an exact same-owner route without replacing its handler", () => {
    const { registry, logs, register } = createLoggedRouteHarness();
    const firstHandler = vi.fn();
    const secondHandler = vi.fn();
    const unregisterFirst = register({
      path: "/plugins/shared",
      auth: "plugin",
      handler: firstHandler,
      pluginId: "demo",
      source: "shared-route",
    });

    const unregisterSecond = register({
      path: "/PLUGINS//SHARED/",
      auth: "plugin",
      handler: secondHandler,
      pluginId: "demo",
      source: "shared-route",
      reuseExistingSameOwner: true,
      throwOnFailure: true,
    });

    expect(registry.httpRoutes).toHaveLength(1);
    expect(registry.httpRoutes[0]?.handler).toBe(firstHandler);
    expect(logs.at(-1)).toContain("reusing existing webhook path");
    unregisterSecond();
    expect(registry.httpRoutes).toHaveLength(1);
    unregisterFirst();
    expect(registry.httpRoutes).toHaveLength(0);
  });

  it.each([
    { pluginId: "other", source: "shared-route" },
    { pluginId: "demo", source: "other-route" },
  ])("rejects route reuse by $pluginId/$source", ({ pluginId, source }) => {
    const { registry, register } = createLoggedRouteHarness();
    const firstHandler = vi.fn();
    register({
      path: "/plugins/shared",
      auth: "plugin",
      handler: firstHandler,
      pluginId: "demo",
      source: "shared-route",
    });

    expect(() =>
      register({
        path: "/plugins/shared",
        auth: "plugin",
        pluginId,
        source,
        reuseExistingSameOwner: true,
        throwOnFailure: true,
      }),
    ).toThrow("plugin: route reuse denied");
    expect(registry.httpRoutes).toHaveLength(1);
    expect(registry.httpRoutes[0]?.handler).toBe(firstHandler);
  });

  it("finds a canonical exact alias behind an earlier prefix overlap", () => {
    const { registry, register } = createLoggedRouteHarness();
    register({
      path: "/webhooks",
      auth: "plugin",
      match: "prefix",
      pluginId: "sms",
      source: "prefix",
    });
    register({
      path: "/Webhooks/SMS/",
      auth: "plugin",
      pluginId: "sms",
      source: "sms-exact",
    });

    register({
      path: "/webhooks/sms",
      auth: "plugin",
      pluginId: "sms",
      source: "sms-exact",
      replaceExisting: true,
      throwOnFailure: true,
    });

    expect(registry.httpRoutes.map((route) => route.source)).toEqual(["prefix", "sms-exact"]);
  });

  it("replaces a same-plugin canonical prefix alias", () => {
    const { registry, register } = createLoggedRouteHarness();
    register({
      path: "/Webhooks//SMS/",
      auth: "plugin",
      match: "prefix",
      pluginId: "sms",
      source: "sms-webhook",
    });

    register({
      path: "/webhooks/sms",
      auth: "plugin",
      match: "prefix",
      pluginId: "sms",
      source: "sms-webhook",
      replaceExisting: true,
      throwOnFailure: true,
    });

    expect(registry.httpRoutes).toHaveLength(1);
    expect(registry.httpRoutes[0]).toMatchObject({
      path: "/webhooks/sms",
      match: "prefix",
      source: "sms-webhook",
    });
  });

  it("rejects replacement when a distinct route source owns the same plugin path", () => {
    const pluginRegistry = createPluginRegistry({
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {},
      },
      runtime: {} as PluginRuntime,
      activateGlobalSideEffects: false,
    });
    const record = createPluginRecord({
      id: "mattermost",
      source: "/plugins/mattermost/index.js",
    });
    const slashHandler = vi.fn();
    pluginRegistry.registry.plugins.push(record);
    pluginRegistry.createApi(record, { config: {} as OpenClawConfig }).registerHttpRoute({
      path: "/Mattermost//Interactions/default/",
      auth: "plugin",
      handler: slashHandler,
    });

    expect(() =>
      registerPluginHttpRoute({
        path: "/mattermost/interactions/default",
        auth: "plugin",
        handler: vi.fn(),
        registry: pluginRegistry.registry,
        pluginId: "mattermost",
        source: "mattermost-interactions",
        replaceExisting: true,
        throwOnFailure: true,
      }),
    ).toThrow("plugin: route replacement denied");

    expect(pluginRegistry.registry.httpRoutes).toHaveLength(1);
    expect(pluginRegistry.registry.httpRoutes[0]).toMatchObject({
      handler: slashHandler,
      pluginId: "mattermost",
      source: "/plugins/mattermost/index.js",
    });
  });

  it("preserves shipped same-plugin source-less replacement", () => {
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
    expect(registry.httpRoutes[0]?.source).toBeUndefined();
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
      name: "source-aware replacement cannot evict a source-less route",
      existingSource: undefined,
      replacementSource: "demo-webhook",
    },
    {
      name: "source-less replacement cannot evict a source-aware route",
      existingSource: "demo-webhook",
      replacementSource: undefined,
    },
  ])("$name", ({ existingSource, replacementSource }) => {
    const { registry, register } = createLoggedRouteHarness();
    const existingHandler = vi.fn();
    register({
      path: "/plugins/demo",
      auth: "plugin",
      handler: existingHandler,
      pluginId: "demo",
      source: existingSource,
    });

    expect(() =>
      register({
        path: "/plugins/demo",
        auth: "plugin",
        pluginId: "demo",
        source: replacementSource,
        replaceExisting: true,
        throwOnFailure: true,
      }),
    ).toThrow("plugin: route replacement denied");
    expect(registry.httpRoutes).toHaveLength(1);
    expect(registry.httpRoutes[0]?.handler).toBe(existingHandler);
    expect(registry.httpRoutes[0]?.source).toBe(existingSource);
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

  it("throws when strict registration cannot replace another plugin's route", () => {
    const { registry, register } = createLoggedRouteHarness();
    register({
      path: "/plugins/demo",
      auth: "plugin",
      pluginId: "demo-a",
    });

    expect(() =>
      register({
        path: "/plugins/demo",
        auth: "plugin",
        replaceExisting: true,
        throwOnFailure: true,
        pluginId: "demo-b",
      }),
    ).toThrow("plugin: route replacement denied");
    expect(registry.httpRoutes).toHaveLength(1);
    expect(registry.httpRoutes[0]?.pluginId).toBe("demo-a");
  });

  it.each([
    {
      name: "anonymous replacement cannot evict an owned route",
      existingPluginId: "demo-a",
      replacementPluginId: undefined,
    },
    {
      name: "an owned replacement cannot evict an anonymous route",
      existingPluginId: undefined,
      replacementPluginId: "demo-a",
    },
  ])("$name", ({ existingPluginId, replacementPluginId }) => {
    const { registry, register } = createLoggedRouteHarness();
    register({
      path: "/plugins/demo",
      auth: "plugin",
      pluginId: existingPluginId,
    });

    expect(() =>
      register({
        path: "/plugins/demo",
        auth: "plugin",
        replaceExisting: true,
        throwOnFailure: true,
        pluginId: replacementPluginId,
      }),
    ).toThrow("plugin: route replacement denied");
    expect(registry.httpRoutes).toHaveLength(1);
    expect(registry.httpRoutes[0]?.pluginId).toBe(existingPluginId);
  });

  it("preserves shipped anonymous-to-anonymous lifecycle replacement", () => {
    const { registry, register } = createLoggedRouteHarness();
    register({
      path: "/plugins/demo",
      auth: "plugin",
      source: "old-anonymous",
    });

    register({
      path: "/plugins/demo",
      auth: "plugin",
      replaceExisting: true,
      throwOnFailure: true,
      source: "new-anonymous",
    });

    expect(registry.httpRoutes).toHaveLength(1);
    expect(registry.httpRoutes[0]?.source).toBe("new-anonymous");
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

  it("finds a mixed-auth overlap behind an earlier same-auth prefix", () => {
    const { registry, register } = createLoggedRouteHarness();
    register({
      path: "/plugin",
      auth: "plugin",
      match: "prefix",
      pluginId: "demo-plugin",
    });
    registry.httpRoutes.push({
      path: "/plugin/secure/report",
      handler: vi.fn(),
      auth: "gateway",
      match: "exact",
      pluginId: "demo-gateway",
      source: "preloaded-gateway-route",
    });

    expect(() =>
      register({
        path: "/PLUGIN/secure/report/",
        auth: "plugin",
        match: "exact",
        pluginId: "demo-plugin",
        throwOnFailure: true,
      }),
    ).toThrow("plugin: route overlap denied");
    expect(registry.httpRoutes).toHaveLength(2);
  });

  it("prefers the scoped route registry over the process root", () => {
    const scopedRegistry = createEmptyPluginRegistry();
    const pinnedRegistry = createEmptyPluginRegistry();

    setActivePluginRegistry(pinnedRegistry);

    const unregister = withPluginHttpRouteRegistry(scopedRegistry, () =>
      registerPluginHttpRoute({
        path: "/scoped-webhook",
        auth: "plugin",
        handler: vi.fn(),
      }),
    );

    expectRegisteredRouteShape(scopedRegistry, {
      path: "/scoped-webhook",
      auth: "plugin",
    });
    expect(pinnedRegistry.httpRoutes).toHaveLength(0);

    unregister();
    expect(scopedRegistry.httpRoutes).toHaveLength(0);
  });
});
