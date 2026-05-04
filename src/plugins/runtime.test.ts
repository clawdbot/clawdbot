import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEmptyPluginRegistry } from "./registry.js";
import type { PluginHttpRouteRegistration } from "./registry.js";
import {
  getActivePluginHttpRouteRegistryVersion,
  getActivePluginRegistryVersion,
  getActivePluginRegistry,
  listImportedRuntimePluginIds,
  pinActivePluginHttpRouteRegistry,
  recordImportedPluginId,
  releasePinnedPluginHttpRouteRegistry,
  resetPluginRuntimeStateForTest,
  resolveActivePluginHttpRouteRegistry,
  setActivePluginRegistry,
} from "./runtime.js";
import { createPluginRecord } from "./status.test-helpers.js";

function createRegistryWithRoute(path: string) {
  const registry = createEmptyPluginRegistry();
  registry.httpRoutes.push({
    path,
    auth: "plugin",
    match: path === "/plugins/diffs" ? "prefix" : "exact",
    handler: () => true,
    pluginId: path === "/plugins/diffs" ? "diffs" : "demo",
    source: "test",
  });
  return registry;
}

function createRuntimeRegistryPair() {
  return {
    startupRegistry: createEmptyPluginRegistry(),
    laterRegistry: createEmptyPluginRegistry(),
  };
}

function expectRegistryVersions(params: { active: number; routes: number }) {
  expect(getActivePluginRegistryVersion()).toBe(params.active);
  expect(getActivePluginHttpRouteRegistryVersion()).toBe(params.routes);
}

function expectActiveRouteRegistryResolution(params: {
  pinnedRegistry: ReturnType<typeof createEmptyPluginRegistry>;
  explicitRegistry: ReturnType<typeof createEmptyPluginRegistry>;
  expectedRegistry: "pinned" | "explicit";
}) {
  setActivePluginRegistry(params.pinnedRegistry);
  pinActivePluginHttpRouteRegistry(params.pinnedRegistry);

  expect(resolveActivePluginHttpRouteRegistry(params.explicitRegistry)).toBe(
    params.expectedRegistry === "pinned" ? params.pinnedRegistry : params.explicitRegistry,
  );
}

function expectPinnedRouteRegistry(
  startupRegistry: ReturnType<typeof createEmptyPluginRegistry>,
  laterRegistry: ReturnType<typeof createEmptyPluginRegistry>,
) {
  setActivePluginRegistry(startupRegistry);
  pinActivePluginHttpRouteRegistry(startupRegistry);
  setActivePluginRegistry(laterRegistry);
  expect(resolveActivePluginHttpRouteRegistry(laterRegistry)).toBe(startupRegistry);
}

function expectRouteRegistryState(params: { setup: () => void; assert: () => void }) {
  params.setup();
  params.assert();
}

async function waitForCleanupSignal(signal: Promise<void>, label: string): Promise<void> {
  await Promise.race([
    signal,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 500);
    }),
  ]);
}

describe("plugin runtime route registry", () => {
  afterEach(() => {
    releasePinnedPluginHttpRouteRegistry();
    resetPluginRuntimeStateForTest();
  });

  it("stays empty until a caller explicitly installs or requires a registry", () => {
    resetPluginRuntimeStateForTest();

    expect(getActivePluginRegistry()).toBeNull();
  });

  it.each([
    {
      name: "keeps the pinned route registry when the active plugin registry changes",
      run: () => {
        const { startupRegistry, laterRegistry } = createRuntimeRegistryPair();
        expectPinnedRouteRegistry(startupRegistry, laterRegistry);
      },
    },
    {
      name: "tracks route registry repins separately from the active registry version",
      run: () => {
        const { startupRegistry, laterRegistry } = createRuntimeRegistryPair();
        const repinnedRegistry = createEmptyPluginRegistry();

        setActivePluginRegistry(startupRegistry);
        pinActivePluginHttpRouteRegistry(laterRegistry);

        const activeVersionBeforeRepin = getActivePluginRegistryVersion();
        const routeVersionBeforeRepin = getActivePluginHttpRouteRegistryVersion();

        pinActivePluginHttpRouteRegistry(repinnedRegistry);

        expectRegistryVersions({
          active: activeVersionBeforeRepin,
          routes: routeVersionBeforeRepin + 1,
        });
      },
    },
  ] as const)("$name", ({ run }) => {
    expectRouteRegistryState({
      setup: () => {},
      assert: run,
    });
  });

  it.each([
    {
      name: "keeps an explicitly pinned empty route registry authoritative",
      pinnedRegistry: createEmptyPluginRegistry(),
      explicitRegistry: createRegistryWithRoute("/demo"),
      expected: "pinned",
    },
    {
      name: "prefers the pinned route registry when it already owns routes",
      pinnedRegistry: createRegistryWithRoute("/bluebubbles-webhook"),
      explicitRegistry: createRegistryWithRoute("/plugins/diffs"),
      expected: "pinned",
    },
  ] as const)("$name", ({ pinnedRegistry, explicitRegistry, expected }) => {
    expectActiveRouteRegistryResolution({
      pinnedRegistry,
      explicitRegistry,
      expectedRegistry: expected,
    });
  });
});

const makeRoute = (path: string): PluginHttpRouteRegistration => ({
  path,
  handler: () => {},
  auth: "gateway",
  match: "exact",
});

describe("setActivePluginRegistry", () => {
  beforeEach(() => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it("does not carry forward httpRoutes when new registry has none", () => {
    const oldRegistry = createEmptyPluginRegistry();
    const fakeRoute = makeRoute("/test");
    oldRegistry.httpRoutes.push(fakeRoute);
    setActivePluginRegistry(oldRegistry);
    expect(getActivePluginRegistry()?.httpRoutes).toHaveLength(1);

    const newRegistry = createEmptyPluginRegistry();
    expect(newRegistry.httpRoutes).toHaveLength(0);
    setActivePluginRegistry(newRegistry);
    expect(getActivePluginRegistry()?.httpRoutes).toHaveLength(0);
  });

  it("does not carry forward when new registry already has routes", () => {
    const oldRegistry = createEmptyPluginRegistry();
    oldRegistry.httpRoutes.push(makeRoute("/old"));
    setActivePluginRegistry(oldRegistry);

    const newRegistry = createEmptyPluginRegistry();
    const newRoute = makeRoute("/new");
    newRegistry.httpRoutes.push(newRoute);
    setActivePluginRegistry(newRegistry);
    expect(getActivePluginRegistry()?.httpRoutes).toHaveLength(1);
    expect(getActivePluginRegistry()?.httpRoutes[0]).toEqual(newRoute);
  });

  it("does not carry forward when same registry is set again", () => {
    const registry = createEmptyPluginRegistry();
    registry.httpRoutes.push(makeRoute("/test"));
    setActivePluginRegistry(registry);
    setActivePluginRegistry(registry);
    expect(getActivePluginRegistry()?.httpRoutes).toHaveLength(1);
  });

  it("does not treat bundle-only loaded entries as imported runtime plugins", () => {
    const registry = createEmptyPluginRegistry();
    registry.plugins.push(
      createPluginRecord({
        id: "bundle-only",
        name: "Bundle Only",
        source: "/tmp/bundle",
        origin: "bundled",
        format: "bundle",
        configSchema: true,
      }),
      createPluginRecord({
        id: "runtime-plugin",
        name: "Runtime Plugin",
        source: "/tmp/runtime",
        format: "openclaw",
        configSchema: true,
      }),
    );

    setActivePluginRegistry(registry);

    expect(listImportedRuntimePluginIds()).toEqual(["runtime-plugin"]);
  });

  it.each([
    {
      name: "same active registry is refreshed",
      refresh(nextRegistry: ReturnType<typeof createEmptyPluginRegistry>) {
        setActivePluginRegistry(nextRegistry);
      },
    },
    {
      name: "active registry advances again",
      refresh() {
        setActivePluginRegistry(createEmptyPluginRegistry());
      },
    },
  ] as const)("continues cleanup when the $name", async ({ refresh }) => {
    let releaseFirstCleanup: (() => void) | undefined;
    let markFirstCleanupStarted!: () => void;
    let markSecondCleanupCalled!: () => void;
    const firstCleanupStarted = new Promise<void>((resolve) => {
      markFirstCleanupStarted = resolve;
    });
    const secondCleanupCalled = new Promise<void>((resolve) => {
      markSecondCleanupCalled = resolve;
    });
    const previous = createEmptyPluginRegistry();
    previous.plugins.push(
      createPluginRecord({
        id: "cleanup-refresh-race",
        name: "Cleanup Refresh Race",
        status: "loaded",
      }),
    );
    previous.runtimeLifecycles = [
      {
        pluginId: "cleanup-refresh-race",
        pluginName: "Cleanup Refresh Race",
        lifecycle: {
          id: "first-cleanup",
          async cleanup() {
            markFirstCleanupStarted();
            await new Promise<void>((resolve) => {
              releaseFirstCleanup = resolve;
            });
          },
        },
        source: "/virtual/cleanup-refresh-race/index.ts",
        rootDir: "/virtual/cleanup-refresh-race",
      },
      {
        pluginId: "cleanup-refresh-race",
        pluginName: "Cleanup Refresh Race",
        lifecycle: {
          id: "second-cleanup",
          cleanup() {
            markSecondCleanupCalled();
          },
        },
        source: "/virtual/cleanup-refresh-race/index.ts",
        rootDir: "/virtual/cleanup-refresh-race",
      },
    ];
    const next = createEmptyPluginRegistry();

    setActivePluginRegistry(previous);
    setActivePluginRegistry(next);
    await waitForCleanupSignal(firstCleanupStarted, "first cleanup start");

    refresh(next);
    releaseFirstCleanup?.();

    await waitForCleanupSignal(secondCleanupCalled, "second cleanup");
  });

  it("includes plugin ids imported before registration failed", () => {
    recordImportedPluginId("broken-plugin");

    expect(listImportedRuntimePluginIds()).toEqual(["broken-plugin"]);
  });
});
