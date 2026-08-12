/** Covers plugin runtime registration API behavior and registry mutation guards. */
import { beforeEach, describe, expect, it } from "vitest";
import { getPluginRunContext, setPluginRunContext } from "./host-hook-runtime.js";
import { isPluginRegistryRetired } from "./registry-lifecycle.js";
import { createEmptyPluginRegistry } from "./registry.js";
import type { PluginHttpRouteRegistration } from "./registry.js";
import {
  captureActivePluginRegistrySnapshot,
  clearActivePluginRegistry,
  commitStagedPluginRegistry,
  finalizeStagedPluginRegistryReplacement,
  getActivePluginRegistry,
  getActivePluginRegistryKey,
  getActivePluginRuntimeSubagentMode,
  listImportedRuntimePluginIds,
  recordImportedPluginId,
  resetPluginRuntimeStateForTest,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
  stageActivePluginRegistry,
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
    let releaseFirstCleanup: (() => void) | undefined;
    let markFirstCleanupStarted: (() => void) | undefined;
    let markSecondCleanupCalled: (() => void) | undefined;
    const firstCleanupStarted = new Promise<void>((resolve) => {
      markFirstCleanupStarted = resolve;
    });
    const secondCleanupCalled = new Promise<void>((resolve) => {
      markSecondCleanupCalled = resolve;
    });
    if (!markFirstCleanupStarted || !markSecondCleanupCalled) {
      throw new Error("Expected cleanup signal callbacks to be initialized");
    }
    const notifyFirstCleanupStarted = markFirstCleanupStarted;
    const notifySecondCleanupCalled = markSecondCleanupCalled;
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
            notifyFirstCleanupStarted();
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
            notifySecondCleanupCalled();
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
    if (!releaseFirstCleanup) {
      throw new Error("Expected first cleanup release callback to be initialized");
    }
    releaseFirstCleanup();

    await waitForCleanupSignal(secondCleanupCalled, "second cleanup");
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

// ClawSweeper cycle 41 (P1): gateway startup keeps its pre-bind registry staged past the
// kernel; the loader then stages+commits the fully loaded registry OVER that still-staged
// attempt (loader-shared's activatePluginRegistry). The nested stage transfers the abort
// marker so the original displaced survivor — not the intermediate attempt registry — is what
// a clear restores and what retirement finally targets, exactly once.
// ClawSweeper cycle 44 (P1): the nested commit is an INSTALL that retains the marker — the
// survivor's destructive retirement defers to finalizeStagedPluginRegistryReplacement on
// complete startup success, so a clear between commit and finalize still aborts to the
// survivor. Direct (non-nested) commits — reload replacements — finalize immediately.
describe("staged plugin registry attempt", () => {
  beforeEach(() => {
    resetPluginRuntimeStateForTest();
  });

  function seedSurvivor() {
    const survivor = createEmptyPluginRegistry();
    setActivePluginRegistry(survivor, "survivor-key", "gateway-bindable");
    return survivor;
  }

  function seedObservableSurvivor() {
    // Retirement observability: the disable-time runtime lifecycle cleanup only fires when
    // the survivor's destructive retirement actually runs, and it must run exactly once.
    let cleanupCount = 0;
    let signalCleanup: (() => void) | undefined;
    const cleanupSignal = new Promise<void>((resolve) => {
      signalCleanup = resolve;
    });
    const survivor = createEmptyPluginRegistry();
    survivor.runtimeLifecycles = [
      {
        pluginId: "survivor-plugin",
        lifecycle: {
          id: "survivor-lifecycle",
          cleanup() {
            cleanupCount += 1;
            signalCleanup?.();
          },
        },
        source: "/virtual/survivor/index.ts",
        rootDir: "/virtual/survivor",
      },
    ];
    setActivePluginRegistry(survivor, "survivor-key", "gateway-bindable");
    return { survivor, cleanupSignal, cleanupCount: () => cleanupCount };
  }

  it("retains the marker at the nested commit and defers the survivor's retirement", async () => {
    const { survivor, cleanupSignal, cleanupCount } = seedObservableSurvivor();
    const preBind = createEmptyPluginRegistry();
    stageActivePluginRegistry(preBind, null, "default");
    const loaderCapture = captureActivePluginRegistrySnapshot();
    const loaded = createEmptyPluginRegistry();
    stageActivePluginRegistry(loaded, "loaded-key", "gateway-bindable");
    expect(isPluginRegistryRetired(survivor)).toBe(false);

    commitStagedPluginRegistry(loaderCapture.activeRegistry, loaded);

    // Install-retaining-handle: the loaded registry owns the slot, the intermediate attempt
    // registry retired, but the displaced survivor stays live until finalize.
    expect(getActivePluginRegistry()).toBe(loaded);
    expect(isPluginRegistryRetired(preBind)).toBe(true);
    expect(isPluginRegistryRetired(survivor)).toBe(false);
    expect(cleanupCount()).toBe(0);

    finalizeStagedPluginRegistryReplacement();

    expect(isPluginRegistryRetired(survivor)).toBe(true);
    await waitForCleanupSignal(cleanupSignal, "survivor retirement cleanup");
    // The marker was consumed: a second finalize (and a later clear) must not retire again.
    finalizeStagedPluginRegistryReplacement();
    await clearActivePluginRegistry();
    expect(getActivePluginRegistry()).toBeNull();
    expect(cleanupCount()).toBe(1);
  });

  it("aborts to the survivor when cleared after the nested commit but before finalize", async () => {
    const { survivor, cleanupCount } = seedObservableSurvivor();
    const preBind = createEmptyPluginRegistry();
    stageActivePluginRegistry(preBind, null, "default");
    const loaded = createEmptyPluginRegistry();
    stageActivePluginRegistry(loaded, "loaded-key", "gateway-bindable");
    commitStagedPluginRegistry(preBind, loaded);

    // Late startup failure: the attempt's LOADED registry is active when the close clears.
    await clearActivePluginRegistry();

    // Attempt teardown first, survivor restore after: the loaded registry retired while the
    // survivor came back live with its slot snapshot — key, mode — and no disable cleanup.
    expect(isPluginRegistryRetired(loaded)).toBe(true);
    expect(getActivePluginRegistry()).toBe(survivor);
    expect(isPluginRegistryRetired(survivor)).toBe(false);
    expect(getActivePluginRegistryKey()).toBe("survivor-key");
    expect(getActivePluginRuntimeSubagentMode()).toBe("gateway-bindable");
    expect(cleanupCount()).toBe(0);
    // A finalize that races the abort (marker already consumed) must not retire the restored
    // survivor.
    finalizeStagedPluginRegistryReplacement();
    expect(isPluginRegistryRetired(survivor)).toBe(false);
  });

  it("retires the displaced registry immediately on a direct stage/commit", () => {
    // The reload replacement path (loader-shared's activatePluginRegistry outside startup):
    // no outer staged attempt, so the marker snapshot IS the previous registry and the
    // commit completes the replacement with no deferred window.
    const survivor = seedSurvivor();
    const capture = captureActivePluginRegistrySnapshot();
    const loaded = createEmptyPluginRegistry();
    stageActivePluginRegistry(loaded, "reload-key", "gateway-bindable");

    commitStagedPluginRegistry(capture.activeRegistry, loaded);

    expect(getActivePluginRegistry()).toBe(loaded);
    expect(isPluginRegistryRetired(survivor)).toBe(true);
    finalizeStagedPluginRegistryReplacement();
    expect(getActivePluginRegistry()).toBe(loaded);
    expect(isPluginRegistryRetired(loaded)).toBe(false);
  });

  it("aborts a nested stage back to the original survivor", async () => {
    const survivor = seedSurvivor();
    stageActivePluginRegistry(createEmptyPluginRegistry(), null, "default");
    stageActivePluginRegistry(createEmptyPluginRegistry(), "loaded-key", "gateway-bindable");

    await clearActivePluginRegistry();

    expect(getActivePluginRegistry()).toBe(survivor);
    expect(isPluginRegistryRetired(survivor)).toBe(false);
    expect(getActivePluginRegistryKey()).toBe("survivor-key");
    expect(getActivePluginRuntimeSubagentMode()).toBe("gateway-bindable");
  });

  it("re-arms the staged abort across a capture/restore round-trip", async () => {
    // The loader's activation failure path: capture the staged pre-bind attempt, stage the
    // loaded registry, roll back to the capture — a later clear must still restore the
    // survivor instead of wiping the slot.
    const survivor = seedSurvivor();
    const preBind = createEmptyPluginRegistry();
    stageActivePluginRegistry(preBind, null, "default");
    const loaderCapture = captureActivePluginRegistrySnapshot();
    stageActivePluginRegistry(createEmptyPluginRegistry(), "loaded-key", "gateway-bindable");

    restoreActivePluginRegistrySnapshot(loaderCapture);
    expect(getActivePluginRegistry()).toBe(preBind);
    await clearActivePluginRegistry();

    expect(getActivePluginRegistry()).toBe(survivor);
    expect(isPluginRegistryRetired(survivor)).toBe(false);
    expect(getActivePluginRegistryKey()).toBe("survivor-key");
    expect(getActivePluginRuntimeSubagentMode()).toBe("gateway-bindable");
  });
});
