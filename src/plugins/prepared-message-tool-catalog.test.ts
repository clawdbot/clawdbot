import { afterEach, describe, expect, it } from "vitest";
import { resolveCurrentChannelMessageToolDiscoveryAdapter } from "../channels/plugins/message-action-discovery.js";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  getPreparedMessageToolCatalog,
  getPreparedMessageToolCatalogForRegistry,
  settlePreparedMessageToolCatalog,
} from "./prepared-message-tool-catalog.js";
import {
  pinActivePluginChannelRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "./runtime.js";

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

  it("settles the exact runtime registry while another channel registry is pinned", () => {
    const pinned = createTestRegistry([
      { pluginId: "alpha", source: "test", plugin: channel("alpha") },
    ]);
    const runtime = createTestRegistry([
      { pluginId: "beta", source: "test", plugin: channel("beta") },
    ]);
    setActivePluginRegistry(pinned);
    pinActivePluginChannelRegistry(pinned);
    setActivePluginRegistry(runtime);

    expect(getPreparedMessageToolCatalog()?.channels.map((entry) => entry.id)).toEqual(["alpha"]);
    expect(
      getPreparedMessageToolCatalogForRegistry(runtime)?.channels.map((entry) => entry.id),
    ).toEqual(["beta"]);
  });
});
