import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setActivePluginRegistry } from "../../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createOutboundTestPlugin,
  createTestRegistry,
} from "../../../test-utils/channel-plugins.js";
import { loadChannelOutboundAdapter } from "../outbound/load.js";
import { createChannelRegistryLoader } from "../registry-loader.js";
import type { ChannelOutboundAdapter, ChannelPlugin } from "../types.js";

const loadChannelPlugin = createChannelRegistryLoader<ChannelPlugin>((entry) => entry.plugin);

const emptyRegistry = createTestRegistry([]);

const demoOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  sendText: async () => ({ channel: "demo-loader", messageId: "m1" }),
  sendMedia: async () => ({ channel: "demo-loader", messageId: "m2" }),
};

const demoLoaderPlugin: ChannelPlugin = {
  ...createChannelTestPluginBase({
    id: "demo-loader",
    label: "Demo Loader",
    config: { listAccountIds: () => [], resolveAccount: () => ({}) },
  }),
  outbound: demoOutbound,
};

const registryWithDemoLoader = createTestRegistry([
  { pluginId: "demo-loader", plugin: demoLoaderPlugin, source: "test" },
]);

const demoOutboundV2: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  sendText: async () => ({ channel: "demo-loader", messageId: "m3" }),
  sendMedia: async () => ({ channel: "demo-loader", messageId: "m4" }),
};

const demoLoaderPluginV2 = createOutboundTestPlugin({
  id: "demo-loader",
  label: "Demo Loader",
  outbound: demoOutboundV2,
});

const registryWithDemoLoaderV2 = createTestRegistry([
  { pluginId: "demo-loader", plugin: demoLoaderPluginV2, source: "test-v2" },
]);

const demoNoOutboundPlugin = createChannelTestPluginBase({
  id: "demo-loader",
  label: "Demo Loader",
});

const registryWithDemoLoaderNoOutbound = createTestRegistry([
  { pluginId: "demo-loader", plugin: demoNoOutboundPlugin, source: "test-no-outbound" },
]);

describe("channel plugin loader", () => {
  async function expectLoadedPluginCase(params: {
    registry: Parameters<typeof setActivePluginRegistry>[0];
    expectedPlugin: ChannelPlugin;
  }) {
    setActivePluginRegistry(params.registry);
    expect(await loadChannelPlugin("demo-loader")).toBe(params.expectedPlugin);
  }

  async function expectLoadedOutboundCase(params: {
    registry: Parameters<typeof setActivePluginRegistry>[0];
    expectedOutbound: ChannelOutboundAdapter | undefined;
  }) {
    setActivePluginRegistry(params.registry);
    expect(await loadChannelOutboundAdapter("demo-loader")).toBe(params.expectedOutbound);
  }

  async function expectReloadedLoaderCase(params: {
    load: typeof loadChannelPlugin | typeof loadChannelOutboundAdapter;
    firstRegistry: Parameters<typeof setActivePluginRegistry>[0];
    secondRegistry: Parameters<typeof setActivePluginRegistry>[0];
    firstExpected: ChannelPlugin | ChannelOutboundAdapter | undefined;
    secondExpected: ChannelPlugin | ChannelOutboundAdapter | undefined;
  }) {
    setActivePluginRegistry(params.firstRegistry);
    expect(await params.load("demo-loader")).toBe(params.firstExpected);
    setActivePluginRegistry(params.secondRegistry);
    expect(await params.load("demo-loader")).toBe(params.secondExpected);
  }

  async function expectOutboundAdapterMissingCase(
    registry: Parameters<typeof setActivePluginRegistry>[0],
  ) {
    setActivePluginRegistry(registry);
    expect(await loadChannelOutboundAdapter("demo-loader")).toBeUndefined();
  }

  beforeEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });

  afterEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });

  it.each([
    {
      name: "loads channel plugins from the active registry",
      kind: "plugin" as const,
      registry: registryWithDemoLoader,
      expectedPlugin: demoLoaderPlugin,
    },
    {
      name: "loads outbound adapters from registered plugins",
      kind: "outbound" as const,
      registry: registryWithDemoLoader,
      expectedOutbound: demoOutbound,
    },
    {
      name: "reads updated plugin values when registry changes",
      kind: "reload-plugin" as const,
      firstRegistry: registryWithDemoLoader,
      secondRegistry: registryWithDemoLoaderV2,
      firstExpected: demoLoaderPlugin,
      secondExpected: demoLoaderPluginV2,
    },
    {
      name: "reads updated outbound values when registry changes",
      kind: "reload-outbound" as const,
      firstRegistry: registryWithDemoLoader,
      secondRegistry: registryWithDemoLoaderV2,
      firstExpected: demoOutbound,
      secondExpected: demoOutboundV2,
    },
    {
      name: "returns undefined when plugin has no outbound adapter",
      kind: "missing-outbound" as const,
      registry: registryWithDemoLoaderNoOutbound,
    },
  ] as const)("$name", async (testCase) => {
    switch (testCase.kind) {
      case "plugin":
        await expectLoadedPluginCase({
          registry: testCase.registry,
          expectedPlugin: testCase.expectedPlugin,
        });
        return;
      case "outbound":
        await expectLoadedOutboundCase({
          registry: testCase.registry,
          expectedOutbound: testCase.expectedOutbound,
        });
        return;
      case "reload-plugin":
        await expectReloadedLoaderCase({
          load: loadChannelPlugin,
          firstRegistry: testCase.firstRegistry,
          secondRegistry: testCase.secondRegistry,
          firstExpected: testCase.firstExpected,
          secondExpected: testCase.secondExpected,
        });
        return;
      case "reload-outbound":
        await expectReloadedLoaderCase({
          load: loadChannelOutboundAdapter,
          firstRegistry: testCase.firstRegistry,
          secondRegistry: testCase.secondRegistry,
          firstExpected: testCase.firstExpected,
          secondExpected: testCase.secondExpected,
        });
        return;
      case "missing-outbound":
        await expectOutboundAdapterMissingCase(testCase.registry);
        return;
    }
  });
});
