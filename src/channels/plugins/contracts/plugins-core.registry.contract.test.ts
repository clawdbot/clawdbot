import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setActivePluginRegistry } from "../../../plugins/runtime.js";
import { createTestRegistry } from "../../../test-utils/channel-plugins.js";
import { listChannelPlugins } from "../index.js";
import type { ChannelPlugin } from "../types.js";

describe("channel plugin registry", () => {
  const emptyRegistry = createTestRegistry([]);

  const createPlugin = (id: string, order?: number): ChannelPlugin => ({
    id,
    meta: {
      id,
      label: id,
      selectionLabel: id,
      docsPath: `/channels/${id}`,
      blurb: "test",
      ...(order === undefined ? {} : { order }),
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      listAccountIds: () => [],
      resolveAccount: () => ({}),
    },
  });

  beforeEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });

  function expectListedChannelPluginIds(expectedIds: string[]) {
    expect(listChannelPlugins().map((plugin) => plugin.id)).toEqual(expectedIds);
  }

  function expectRegistryActivationCase(run: () => void) {
    run();
  }

  afterEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });

  it.each([
    {
      name: "sorts channel plugins by configured order",
      run: () => {
        const orderedPlugins: Array<[string, number]> = [
          ["demo-middle", 20],
          ["demo-first", 10],
          ["demo-last", 30],
        ];
        const registry = createTestRegistry(
          orderedPlugins.map(([id, order]) => ({
            pluginId: id,
            plugin: createPlugin(id, order),
            source: "test",
          })),
        );
        setActivePluginRegistry(registry);
        expectListedChannelPluginIds(["demo-first", "demo-middle", "demo-last"]);
      },
    },
    {
      name: "refreshes cached channel lookups when the same registry instance is re-activated",
      run: () => {
        const registry = createTestRegistry([
          {
            pluginId: "demo-alpha",
            plugin: createPlugin("demo-alpha"),
            source: "test",
          },
        ]);
        setActivePluginRegistry(registry, "registry-test");
        expectListedChannelPluginIds(["demo-alpha"]);

        registry.channels = [
          {
            pluginId: "demo-beta",
            plugin: createPlugin("demo-beta"),
            source: "test",
          },
        ] as typeof registry.channels;
        setActivePluginRegistry(registry, "registry-test");

        expectListedChannelPluginIds(["demo-beta"]);
      },
    },
  ] as const)("$name", ({ run }) => {
    expectRegistryActivationCase(run);
  });
});
