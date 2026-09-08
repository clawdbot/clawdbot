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
    const firstAuthority = first.createReefRuntimeAuthority();
    firstAuthority.activate(active);

    expect(second.getReefRuntime()).toBe(runtime);
    expect(second.getActiveReef()).toBe(active);
    expect(firstAuthority.signal.aborted).toBe(false);

    const replacement = { flow: {}, friends: {}, reviews: {} } as never;
    const replacementAuthority = second.createReefRuntimeAuthority();
    replacementAuthority.activate(replacement);
    expect(firstAuthority.signal.aborted).toBe(true);
    expect(replacementAuthority.signal.aborted).toBe(false);

    firstAuthority.release();
    expect(first.getActiveReef()).toBe(replacement);
    expect(replacementAuthority.signal.aborted).toBe(false);

    replacementAuthority.release();
    expect(replacementAuthority.signal.aborted).toBe(true);
    replacementAuthority.release();

    expect(() => first.getActiveReef()).toThrow("Reef channel is not running");
  });
});
