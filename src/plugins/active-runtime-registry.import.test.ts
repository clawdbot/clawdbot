import { afterEach, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import {
  clearActivePluginRegistry,
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "./runtime.js";

afterEach(async () => {
  vi.doUnmock("./loader-runtime-load.js");
  await clearActivePluginRegistry();
  resetPluginRuntimeStateForTest();
  vi.resetModules();
});

it("reads loaded registries without evaluating the plugin loader on hits or misses", async () => {
  await clearActivePluginRegistry();
  vi.resetModules();
  vi.doMock("./loader-runtime-load.js", () => {
    throw new Error("loaded-registry lookup must not evaluate loader-runtime-load");
  });

  const { getLoadedRuntimePluginRegistry } = await import("./active-runtime-registry.js");
  expect(getLoadedRuntimePluginRegistry()).toBeUndefined();

  const { resolvePluginLoadCacheContext } = await import("./loader-load-context.js");
  const loadOptions = { config: {}, installRecords: {} };
  const registry = createEmptyPluginRegistry();
  setActivePluginRegistry(registry, resolvePluginLoadCacheContext(loadOptions).cacheKey);

  expect(getLoadedRuntimePluginRegistry()).toBe(registry);
  expect(getLoadedRuntimePluginRegistry({ loadOptions })).toBe(registry);
  expect(
    getLoadedRuntimePluginRegistry({
      loadOptions: { ...loadOptions, workspaceDir: "/different-workspace" },
    }),
  ).toBeUndefined();
  expect(getActivePluginRegistry()).toBe(registry);
});
