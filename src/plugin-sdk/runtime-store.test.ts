import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, test } from "vitest";
import { createPluginRuntimeStore } from "./runtime-store.js";

describe("createPluginRuntimeStore", () => {
  test("shares runtime slots for the same plugin id", () => {
    const firstStore = createPluginRuntimeStore<{ value: string }>({
      pluginId: "shared-plugin",
      errorMessage: "shared plugin runtime not initialized",
    });
    const secondStore = createPluginRuntimeStore<{ value: string }>({
      pluginId: "shared-plugin",
      errorMessage: "shared plugin runtime not initialized",
    });

    firstStore.clearRuntime();
    firstStore.setRuntime({ value: "ok" });

    expect(secondStore.getRuntime()).toEqual({ value: "ok" });

    secondStore.clearRuntime();
    expect(firstStore.tryGetRuntime()).toBeNull();
  });

  test("keeps different plugin ids isolated", () => {
    const leftStore = createPluginRuntimeStore<{ value: string }>({
      pluginId: "left-plugin",
      errorMessage: "left runtime not initialized",
    });
    const rightStore = createPluginRuntimeStore<{ value: string }>({
      pluginId: "right-plugin",
      errorMessage: "right runtime not initialized",
    });

    leftStore.clearRuntime();
    rightStore.clearRuntime();
    leftStore.setRuntime({ value: "left" });

    expect(leftStore.getRuntime()).toEqual({ value: "left" });
    expect(rightStore.tryGetRuntime()).toBeNull();
  });

  test("keeps legacy string callers isolated per store", () => {
    const firstStore = createPluginRuntimeStore<{ value: string }>(
      "legacy runtime not initialized",
    );
    const secondStore = createPluginRuntimeStore<{ value: string }>(
      "legacy runtime not initialized",
    );

    firstStore.clearRuntime();
    firstStore.setRuntime({ value: "legacy" });

    expect(firstStore.getRuntime()).toEqual({ value: "legacy" });
    expect(secondStore.tryGetRuntime()).toBeNull();
  });

  test("still supports explicit custom store keys", () => {
    const firstStore = createPluginRuntimeStore<{ value: string }>({
      key: "custom-runtime-key",
      errorMessage: "custom runtime not initialized",
    });
    const secondStore = createPluginRuntimeStore<{ value: string }>({
      key: "custom-runtime-key",
      errorMessage: "custom runtime not initialized",
    });

    firstStore.clearRuntime();
    firstStore.setRuntime({ value: "custom" });

    expect(secondStore.getRuntime()).toEqual({ value: "custom" });
  });

  test("rejects empty plugin ids", () => {
    expect(() =>
      createPluginRuntimeStore({
        pluginId: "   ",
        errorMessage: "runtime not initialized",
      }),
    ).toThrow("pluginId must not be empty");
  });

  test("treats falsy runtime values as initialized", () => {
    const store = createPluginRuntimeStore<number>({
      key: "custom-falsy-runtime-key",
      errorMessage: "runtime not initialized",
    });

    store.clearRuntime();
    store.setRuntime(0);

    expect(store.getRuntime()).toBe(0);
  });

  test("shares runtime slots across duplicate module instances when plugin id matches", async () => {
    const firstModule = await importFreshModule<typeof import("./runtime-store.js")>(
      import.meta.url,
      "./runtime-store.js?scope=runtime-store-a",
    );
    const secondModule = await importFreshModule<typeof import("./runtime-store.js")>(
      import.meta.url,
      "./runtime-store.js?scope=runtime-store-b",
    );
    const firstStore = firstModule.createPluginRuntimeStore<{ value: string }>({
      pluginId: "duplicate-module-plugin",
      errorMessage: "duplicate module runtime not initialized",
    });
    const secondStore = secondModule.createPluginRuntimeStore<{ value: string }>({
      pluginId: "duplicate-module-plugin",
      errorMessage: "duplicate module runtime not initialized",
    });

    firstStore.clearRuntime();
    firstStore.setRuntime({ value: "shared" });

    expect(secondStore.getRuntime()).toEqual({ value: "shared" });
  });
});
