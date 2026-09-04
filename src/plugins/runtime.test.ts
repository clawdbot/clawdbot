/** Covers plugin runtime registration API behavior and registry mutation guards. */
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { getPluginRunContext, setPluginRunContext } from "./host-hook-runtime.js";
import { createEmptyPluginRegistry } from "./registry.js";
import type { PluginHttpRouteRegistration } from "./registry.js";
import {
  clearActivePluginRegistry,
  getActivePluginRegistry,
  listImportedRuntimePluginIds,
  recordImportedPluginId,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "./runtime.js";
import { createPluginRecord } from "./status.test-fixtures.js";

async function waitForCleanupSignal(signal: Promise<void>, label: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      signal,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 500);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

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
      refresh: (nextRegistry: ReturnType<typeof createEmptyPluginRegistry>) => {
        setActivePluginRegistry(nextRegistry);
      },
    },
    {
      name: "active registry advances again",
      refresh: () => {
        setActivePluginRegistry(createEmptyPluginRegistry());
      },
    },
  ] as const)("continues cleanup when the $name", async ({ refresh }) => {
    const firstCleanupStarted = createDeferredCore();
    const firstCleanupReleased = createDeferredCore();
    const secondCleanupCalled = createDeferredCore();
    onTestFinished(() => firstCleanupReleased.resolve());
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
            firstCleanupStarted.resolve();
            await firstCleanupReleased.promise;
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
            secondCleanupCalled.resolve();
          },
        },
        source: "/virtual/cleanup-refresh-race/index.ts",
        rootDir: "/virtual/cleanup-refresh-race",
      },
    ];
    const next = createEmptyPluginRegistry();

    setActivePluginRegistry(previous);
    setActivePluginRegistry(next);
    // The race starts inside cleanup; cold lazy imports are not a cleanup deadline.
    await firstCleanupStarted.promise;

    refresh(next);
    firstCleanupReleased.resolve();

    await waitForCleanupSignal(secondCleanupCalled.promise, "second cleanup");
  });

  it("includes plugin ids imported before registration failed", () => {
    recordImportedPluginId("broken-plugin");

    expect(listImportedRuntimePluginIds()).toEqual(["broken-plugin"]);
  });

  it("clears the root only after its host cleanup completes", async () => {
    let cleanupCount = 0;
    const registry = createEmptyPluginRegistry();
    registry.plugins.push(
      createPluginRecord({ id: "cleanup-on-close", name: "Cleanup on close", status: "loaded" }),
    );
    registry.runtimeLifecycles = [
      {
        pluginId: "cleanup-on-close",
        pluginName: "Cleanup on close",
        lifecycle: {
          id: "cleanup-on-close",
          cleanup() {
            cleanupCount += 1;
          },
        },
        source: "/virtual/cleanup-on-close/index.ts",
        rootDir: "/virtual/cleanup-on-close",
      },
    ];
    setActivePluginRegistry(registry);

    await clearActivePluginRegistry();

    expect(getActivePluginRegistry()).toBeNull();
    expect(cleanupCount).toBe(1);
  });

  it("clears plugin host run contexts with the active registry", async () => {
    setPluginRunContext({
      pluginId: "runtime-test",
      patch: { runId: "run-1", namespace: "state", value: { ready: true } },
    });

    await clearActivePluginRegistry();

    expect(
      getPluginRunContext({
        pluginId: "runtime-test",
        get: { runId: "run-1", namespace: "state" },
      }),
    ).toBeUndefined();
  });
});
