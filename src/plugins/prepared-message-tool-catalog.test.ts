import { afterEach, describe, expect, it } from "vitest";
import {
  listMessageActionDiscoveryChannels,
  resolveCurrentChannelMessageToolDiscoveryAdapter,
} from "../channels/plugins/message-action-discovery.js";
import { listChannelPlugins } from "../channels/plugins/registry.js";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  getPreparedMessageToolCatalog,
  getPreparedMessageToolCatalogForRegistry,
  settlePreparedMessageToolCatalog,
} from "./prepared-message-tool-catalog.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "./runtime.js";

function channel(id: string, reconcilesUnknownSend = false): ChannelPlugin {
  return {
    ...createChannelTestPluginBase({ id: id as ChannelPlugin["id"] }),
    actions: {
      describeMessageTool: () => ({ actions: ["send"] }),
    },
    message: reconcilesUnknownSend
      ? {
          durableFinal: {
            capabilities: { reconcileUnknownSend: true },
            reconcileUnknownSend: async () => ({ status: "unresolved" }),
          },
        }
      : undefined,
  };
}

describe("prepared message-tool catalog", () => {
  afterEach(() => resetPluginRuntimeStateForTest());

  it("preserves canonical channel ordering and first-wins registration", () => {
    const first = channel("duplicate", true);
    first.meta.order = 5;
    const duplicate = channel("duplicate");
    const prioritized = channel("zeta");
    prioritized.meta.order = 1;
    setActivePluginRegistry(
      createTestRegistry([
        { pluginId: "alpha", source: "test", plugin: channel("alpha") },
        { pluginId: "first", source: "test", plugin: first },
        { pluginId: "duplicate", source: "test", plugin: duplicate },
        { pluginId: "zeta", source: "test", plugin: prioritized },
      ]),
    );

    const prepared = getPreparedMessageToolCatalog();

    expect(prepared?.channels.map((entry) => entry.id)).toEqual(["zeta", "duplicate", "alpha"]);
    expect(prepared?.channels.map((entry) => entry.id)).toEqual(
      listChannelPlugins().map((plugin) => plugin.id),
    );
    expect(prepared?.getChannel("duplicate")?.reconcilesUnknownSend).toBe(true);
  });

  it("settles one versioned catalog per active channel registry generation", () => {
    const first = createTestRegistry([
      { pluginId: "alpha", source: "test", plugin: channel("alpha", true) },
    ]);
    setActivePluginRegistry(first);

    const prepared = getPreparedMessageToolCatalog();
    expect(prepared).toBeDefined();
    expect(settlePreparedMessageToolCatalog()).toBe(prepared);
    expect(prepared?.channels.map((entry) => entry.id)).toEqual(["alpha"]);
    expect(prepared?.getChannel("alpha")?.reconcilesUnknownSend).toBe(true);

    const second = createTestRegistry([
      { pluginId: "beta", source: "test", plugin: channel("beta") },
    ]);
    setActivePluginRegistry(second);

    const replaced = getPreparedMessageToolCatalog();
    expect(replaced).not.toBe(prepared);
    expect(replaced?.version).not.toBe(prepared?.version);
    expect(replaced?.channels.map((entry) => entry.id)).toEqual(["beta"]);
    expect(resolveCurrentChannelMessageToolDiscoveryAdapter("beta", prepared)).toBeNull();
    expect(resolveCurrentChannelMessageToolDiscoveryAdapter("alpha", prepared)?.pluginId).toBe(
      "alpha",
    );
  });

  it("retains catalogs by registry across a root swap", () => {
    const first = createTestRegistry([
      { pluginId: "alpha", source: "test", plugin: channel("alpha") },
    ]);
    const runtime = createTestRegistry([
      { pluginId: "beta", source: "test", plugin: channel("beta") },
    ]);
    setActivePluginRegistry(first);
    const firstCatalog = getPreparedMessageToolCatalog();
    setActivePluginRegistry(runtime);

    const runtimeCatalog = getPreparedMessageToolCatalogForRegistry(runtime);

    expect(firstCatalog?.channels.map((entry) => entry.id)).toEqual(["alpha"]);
    expect(runtimeCatalog?.channels.map((entry) => entry.id)).toEqual(["beta"]);
    expect(listMessageActionDiscoveryChannels().map((entry) => entry.id)).toEqual(["beta"]);
    expect(listMessageActionDiscoveryChannels(runtimeCatalog).map((entry) => entry.id)).toEqual([
      "beta",
    ]);
    expect(resolveCurrentChannelMessageToolDiscoveryAdapter("alpha")).toBeNull();
    expect(resolveCurrentChannelMessageToolDiscoveryAdapter("beta")?.pluginId).toBe("beta");
    expect(resolveCurrentChannelMessageToolDiscoveryAdapter("alpha", firstCatalog)?.pluginId).toBe(
      "alpha",
    );
    expect(resolveCurrentChannelMessageToolDiscoveryAdapter("beta", firstCatalog)).toBeNull();
    expect(resolveCurrentChannelMessageToolDiscoveryAdapter("beta", runtimeCatalog)?.pluginId).toBe(
      "beta",
    );
  });
});
