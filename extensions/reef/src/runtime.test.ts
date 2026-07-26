import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it } from "vitest";

const reefRuntimeSlot = createPluginRuntimeStore<PluginRuntime>({
  pluginId: "reef",
  errorMessage: "test",
});
const activeReefSlot = createPluginRuntimeStore<unknown>({
  key: "plugin-runtime:reef:active",
  errorMessage: "test",
});

afterEach(() => {
  reefRuntimeSlot.clearRuntime();
  activeReefSlot.clearRuntime();
});

describe("Reef runtime state", () => {
  it("shares the core runtime and active channel across duplicate module instances", async () => {
    const first = await importFreshModule<typeof import("./runtime.js")>(
      import.meta.url,
      "./runtime.js?reef-runtime-first",
    );
    const second = await importFreshModule<typeof import("./runtime.js")>(
      import.meta.url,
      "./runtime.js?reef-runtime-second",
    );
    const runtime = { state: {} } as PluginRuntime;
    const active = { flow: {}, friends: {}, reviews: {} } as never;

    first.setReefRuntime(runtime);
    first.setActiveReef(active);

    expect(second.getReefRuntime()).toBe(runtime);
    expect(second.getActiveReef()).toBe(active);
  });
});
