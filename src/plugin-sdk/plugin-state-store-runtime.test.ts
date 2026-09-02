import { describe, expectTypeOf, it } from "vitest";
import type { PluginStateKeyedStore, PluginStateSyncKeyedStore } from "./plugin-state-runtime.js";
import type { createPluginStateSyncKeyedStore } from "./plugin-state-store-runtime.js";

describe("plugin state store type contracts", () => {
  it("guarantees atomic capabilities from the concrete SDK factory", () => {
    expectTypeOf<
      ReturnType<typeof createPluginStateSyncKeyedStore<{ count: number }>>
    >().toEqualTypeOf<Required<PluginStateSyncKeyedStore<{ count: number }>>>();
  });

  it("allows general stores without atomic capabilities", () => {
    expectTypeOf<Omit<PluginStateKeyedStore<{ count: number }>, "update" | "deleteIf">>().toExtend<
      PluginStateKeyedStore<{ count: number }>
    >();
    expectTypeOf<
      Omit<PluginStateSyncKeyedStore<{ count: number }>, "update" | "deleteIf">
    >().toExtend<PluginStateSyncKeyedStore<{ count: number }>>();
  });
});
