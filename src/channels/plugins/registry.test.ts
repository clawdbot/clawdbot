import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import type { PluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { getChannelPlugin, listChannelPlugins } from "./registry.js";

vi.mock("./bundled.js", () => ({
  getBundledChannelPlugin: (id: string) =>
    id === "fallback"
      ? {
          id: "fallback",
          meta: { label: "fallback" },
        }
      : undefined,
}));

function withMalformedChannels(registry: PluginRegistry): PluginRegistry {
  const malformed = { ...registry } as PluginRegistry;
  (malformed as { channels?: unknown }).channels = undefined;
  return malformed;
}

afterEach(() => {
  resetPluginRuntimeStateForTest();
});

describe("listChannelPlugins", () => {
  it("returns an empty list when runtime registry has no channels field", () => {
    const malformedRegistry = withMalformedChannels(createEmptyPluginRegistry());
    setActivePluginRegistry(malformedRegistry);

    expect(listChannelPlugins()).toEqual([]);
  });

  it("falls back to bundled channel plugins for direct lookups before registry bootstrap", () => {
    setActivePluginRegistry(createEmptyPluginRegistry());

    expect(getChannelPlugin("fallback")?.meta.label).toBe("fallback");
  });

  it("rebuilds channel lookups when the active registry object changes without a version bump", () => {
    const first = createEmptyPluginRegistry();
    first.channels = [
      {
        pluginId: "alpha",
        plugin: {
          id: "alpha",
          meta: { label: "alpha" },
        } as never,
        source: "test",
      },
    ];
    setActivePluginRegistry(first);

    expect(getChannelPlugin("alpha")?.meta.label).toBe("alpha");
    expect(getChannelPlugin("beta")).toBeUndefined();

    const second = createEmptyPluginRegistry();
    second.channels = [
      {
        pluginId: "beta",
        plugin: {
          id: "beta",
          meta: { label: "beta" },
        } as never,
        source: "test",
      },
    ];
    setActivePluginRegistry(second);

    expect(getChannelPlugin("alpha")).toBeUndefined();
    expect(getChannelPlugin("beta")?.meta.label).toBe("beta");
    expect(listChannelPlugins().map((plugin) => plugin.id)).toEqual(["beta"]);
  });
});
