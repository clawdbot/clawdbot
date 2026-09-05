// Verifies channel guard behavior in plugin registry lookups.
import { describe, expect, it } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createChatChannelPlugin } from "../plugin-sdk/channel-core.js";
import { createPluginRegistry } from "./registry.js";
import type { PluginRuntime } from "./runtime/types.js";
import { createPluginRecord } from "./status.test-fixtures.js";
import type { OpenClawPluginChannelRegistration } from "./types.js";

function createTestRegistry() {
  return createPluginRegistry({
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    runtime: {} as PluginRuntime,
    activateGlobalSideEffects: false,
  });
}

function createChannelPlugin(id: string, label: string): ChannelPlugin {
  return {
    id,
    meta: {
      id,
      label,
      selectionLabel: label,
      docsPath: `/channels/${id}`,
      blurb: `${label} channel`,
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      listAccountIds: () => [],
      resolveAccount: () => undefined,
    },
    outbound: { deliveryMode: "direct" },
  };
}

describe("plugin registry channel guard", () => {
  it.each([undefined, { chatTypes: [] }, { chatTypes: ["forum"] }, { chatTypes: [1] }])(
    "rejects incomplete or invalid channel plugins at the registrar boundary",
    (capabilities) => {
      const pluginRegistry = createTestRegistry();
      const record = createPluginRecord({ id: "incomplete-channel-owner", origin: "global" });
      const plugin = createChannelPlugin("incomplete-channel", "Incomplete Channel");
      plugin.capabilities = capabilities as never;

      pluginRegistry.registry.plugins.push(record);
      pluginRegistry
        .createApi(record, { config: {} as OpenClawConfig, registrationMode: "full" })
        .registerChannel({ plugin });

      expect(pluginRegistry.registry.channelSetups).toHaveLength(0);
      expect(pluginRegistry.registry.channels).toHaveLength(0);
      expect(pluginRegistry.registry.diagnostics.map((diag) => diag.message)).toContain(
        'channel "incomplete-channel" registration missing or invalid required capabilities.chatTypes',
      );
    },
  );

  it("rejects channel registration from disabled workspace plugins", () => {
    const pluginRegistry = createTestRegistry();
    const config = {} as OpenClawConfig;
    const record = createPluginRecord({
      id: "workspace-shadow",
      source: "/plugins/workspace-shadow/index.ts",
      origin: "workspace",
      enabled: false,
    });

    pluginRegistry.registry.plugins.push(record);
    pluginRegistry.createApi(record, { config, registrationMode: "setup-only" }).registerChannel({
      plugin: createChannelPlugin("workspace-shadow", "Workspace Shadow"),
    });

    expect(pluginRegistry.registry.channelSetups).toHaveLength(0);
    expect(pluginRegistry.registry.channels).toHaveLength(0);
    expect(record.channelIds).toEqual([]);
    expect(
      pluginRegistry.registry.diagnostics.some(
        (diag) =>
          diag.level === "warn" &&
          diag.pluginId === "workspace-shadow" &&
          diag.message ===
            "channel registration rejected for disabled workspace plugin: workspace-shadow",
      ),
    ).toBe(true);
  });

  it("rejects disabled workspace registration before reading channel data", () => {
    const pluginRegistry = createTestRegistry();
    const config = {} as OpenClawConfig;
    const record = createPluginRecord({
      id: "workspace-shadow",
      source: "/plugins/workspace-shadow/index.ts",
      origin: "workspace",
      enabled: false,
    });
    let touchedPluginGetter = false;
    const registration = {} as OpenClawPluginChannelRegistration;
    Object.defineProperty(registration, "plugin", {
      enumerable: true,
      get() {
        touchedPluginGetter = true;
        throw new Error("registration plugin getter should not run");
      },
    });

    pluginRegistry.registry.plugins.push(record);
    expect(() =>
      pluginRegistry
        .createApi(record, { config, registrationMode: "setup-only" })
        .registerChannel(registration),
    ).not.toThrow();

    expect(touchedPluginGetter).toBe(false);
    expect(pluginRegistry.registry.channelSetups).toHaveLength(0);
    expect(pluginRegistry.registry.channels).toHaveLength(0);
    expect(record.channelIds).toEqual([]);
    expect(
      pluginRegistry.registry.diagnostics.some(
        (diag) =>
          diag.level === "warn" &&
          diag.pluginId === "workspace-shadow" &&
          diag.message ===
            "channel registration rejected for disabled workspace plugin: workspace-shadow",
      ),
    ).toBe(true);
  });

  it("keeps channel registration available for trusted workspace plugins", () => {
    const pluginRegistry = createTestRegistry();
    const config = {} as OpenClawConfig;
    const record = createPluginRecord({
      id: "trusted-workspace-shadow",
      source: "/plugins/trusted-workspace-shadow/index.ts",
      origin: "workspace",
      enabled: true,
    });
    const plugin = createChannelPlugin("telegram", "Trusted Workspace Telegram");
    plugin.capabilities = undefined as never;

    pluginRegistry.registry.plugins.push(record);
    pluginRegistry.createApi(record, { config, registrationMode: "setup-only" }).registerChannel({
      plugin: createChatChannelPlugin({ base: plugin }),
    });

    expect(pluginRegistry.registry.channelSetups).toHaveLength(1);
    expect(pluginRegistry.registry.channelSetups[0]?.plugin.capabilities.chatTypes).toEqual([
      "direct",
    ]);
    expect(pluginRegistry.registry.channelSetups[0]).toMatchObject({
      pluginId: "trusted-workspace-shadow",
      enabled: true,
      origin: "workspace",
    });
    expect(pluginRegistry.registry.channelSetups[0]?.plugin.id).toBe("telegram");
    expect(pluginRegistry.registry.channels).toHaveLength(0);
    expect(record.channelIds).toEqual(["telegram"]);
  });

  it.each(["bundled", "global", "workspace", "config"] as const)(
    "copies loader-owned %s provenance into channel registrations",
    (origin) => {
      const pluginRegistry = createTestRegistry();
      const record = createPluginRecord({
        id: `${origin}-channel-owner`,
        source: `/plugins/${origin}-channel-owner/index.ts`,
        origin,
        enabled: true,
      });

      pluginRegistry.registry.plugins.push(record);
      pluginRegistry
        .createApi(record, { config: {} as OpenClawConfig, registrationMode: "full" })
        .registerChannel({
          plugin: createChannelPlugin("telegram", `${origin} Telegram`),
        });

      expect(pluginRegistry.registry.channels).toEqual([
        expect.objectContaining({
          pluginId: `${origin}-channel-owner`,
          origin,
        }),
      ]);
      expect(pluginRegistry.registry.channelSetups).toEqual([
        expect.objectContaining({
          pluginId: `${origin}-channel-owner`,
          origin,
        }),
      ]);
    },
  );
});
