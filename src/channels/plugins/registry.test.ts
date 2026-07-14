// Registry tests cover channel plugin registry installation, lookup, and reset behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import type { PluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  getChannelPlugin,
  listChannelPlugins,
  resolveChannelPluginRegistration,
} from "./registry.js";

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

    expect(listChannelPlugins()).toStrictEqual([]);
  });

  it("falls back to bundled channel plugins for direct lookups before registry bootstrap", () => {
    setActivePluginRegistry(createEmptyPluginRegistry());

    expect(getChannelPlugin("fallback")?.meta.label).toBe("fallback");
    expect(resolveChannelPluginRegistration("fallback")).toMatchObject({
      origin: "bundled",
      plugin: {
        id: "fallback",
      },
    });
  });

  it("does not let a loaded external override inherit bundled fallback provenance", () => {
    const registry = createEmptyPluginRegistry();
    registry.channels = [
      {
        pluginId: "external-fallback",
        plugin: {
          id: "fallback",
          meta: { label: "external fallback" },
        } as never,
        origin: "config",
        source: "test",
      },
    ];
    setActivePluginRegistry(registry);

    expect(resolveChannelPluginRegistration("fallback")).toMatchObject({
      origin: "config",
      plugin: {
        meta: {
          label: "external fallback",
        },
      },
    });
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

  it("builds the loaded channel view once per registry version", () => {
    const registry = createEmptyPluginRegistry();
    let buildCount = 0;
    registry.channels = new Proxy(
      [
        {
          pluginId: "zeta",
          plugin: { id: "zeta", meta: { label: "zeta" } } as never,
          source: "test",
        },
        {
          pluginId: "alpha",
          plugin: { id: "alpha", meta: { label: "alpha" } } as never,
          source: "test",
        },
      ],
      {
        get(target, property, receiver) {
          if (property === Symbol.iterator) {
            buildCount += 1;
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );
    setActivePluginRegistry(registry);

    expect(getChannelPlugin("alpha")?.meta.label).toBe("alpha");
    expect(resolveChannelPluginRegistration("zeta")?.plugin.meta.label).toBe("zeta");
    expect(listChannelPlugins().map((plugin) => plugin.id)).toEqual(["alpha", "zeta"]);
    expect(buildCount).toBe(1);

    setActivePluginRegistry(registry);

    expect(getChannelPlugin("alpha")?.meta.label).toBe("alpha");
    expect(listChannelPlugins().map((plugin) => plugin.id)).toEqual(["alpha", "zeta"]);
    expect(buildCount).toBe(2);
  });
});
