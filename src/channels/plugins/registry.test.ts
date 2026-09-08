// Registry tests cover channel plugin registry installation, lookup, and reset behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { listGatewayMethods } from "../../gateway/server-methods-list.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import type { PluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import {
  getChannelPlugin,
  getLoadedChannelPlugin,
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
  it("appends unique gateway methods from both plugin dialects in channel order", () => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    const coreMethods = listGatewayMethods();
    const alpha = {
      ...createChannelTestPluginBase({ id: "alpha" }),
      gatewayMethods: ["health", "test.alpha", "test.legacy"],
      gatewayMethodDescriptors: [{ name: "test.alpha" }, { name: "test.beta" }],
    };
    const zeta = {
      ...createChannelTestPluginBase({ id: "zeta" }),
      gatewayMethods: ["secrets.resolve", "test.beta"],
      gatewayMethodDescriptors: [{ name: "test.gamma" }, { name: "test.alpha" }],
    };
    setActivePluginRegistry(
      createTestRegistry([
        { pluginId: "zeta", plugin: zeta, source: "test" },
        { pluginId: "alpha", plugin: alpha, source: "test" },
      ]),
    );

    expect(listGatewayMethods()).toEqual([
      ...coreMethods,
      "test.alpha",
      "test.legacy",
      "test.beta",
      "test.gamma",
    ]);
  });

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

  it("keeps the scoped channel implementation and its registration provenance together", () => {
    const root = createChannelTestPluginBase({ id: "fallback", label: "Root" });
    const scoped = createChannelTestPluginBase({ id: "fallback", label: "Scoped" });
    const resolveChannelRuntime = vi.fn();
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "root", plugin: root, origin: "bundled", source: "root" }]),
    );
    const registry = createEmptyPluginRegistry();
    registry.channels = [
      {
        pluginId: "scoped",
        plugin: scoped,
        origin: "config",
        source: "scoped",
        resolveChannelRuntime,
      },
    ];

    withPluginRuntimeRegistryScope(registry, () => {
      expect(resolveChannelPluginRegistration("fallback")).toEqual({
        plugin: scoped,
        origin: "config",
        resolveChannelRuntime,
      });
      expect(getChannelPlugin("fallback")).toBe(scoped);
    });
    expect(getChannelPlugin("fallback")).toBe(root);
  });

  it("preserves unrelated root and bundled addressability inside an empty CLI handle", () => {
    const root = createChannelTestPluginBase({ id: "root-only" });
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "root-only", plugin: root, source: "root" }]),
    );

    withPluginRuntimeRegistryScope(createEmptyPluginRegistry(), () => {
      expect(getChannelPlugin("root-only")).toBe(root);
      expect(resolveChannelPluginRegistration("fallback")?.origin).toBe("bundled");
    });
  });

  it("keeps the first channel implementation and provenance when channel ids collide", () => {
    const registry = createEmptyPluginRegistry();
    const firstPlugin = {
      id: "duplicate",
      meta: { label: "first" },
    };
    const secondPlugin = {
      id: "duplicate",
      meta: { label: "second" },
    };
    registry.channels = [
      {
        pluginId: "first-channel-plugin",
        plugin: firstPlugin as never,
        origin: "config",
        source: "first",
      },
      {
        pluginId: "second-channel-plugin",
        plugin: secondPlugin as never,
        origin: "bundled",
        source: "second",
      },
    ];
    setActivePluginRegistry(registry);

    expect(listChannelPlugins()).toEqual([firstPlugin]);
    expect(getLoadedChannelPlugin("duplicate")).toBe(firstPlugin);
    expect(getChannelPlugin("duplicate")).toBe(firstPlugin);
    expect(resolveChannelPluginRegistration("duplicate")).toEqual({
      plugin: firstPlugin,
      origin: "config",
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
