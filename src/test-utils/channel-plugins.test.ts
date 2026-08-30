// Tests channel plugin test registry helpers.
import { describe, expect, it } from "vitest";
import { getLoadedChannelPluginById } from "../channels/plugins/registry-loaded.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import {
  activateTestChannelRegistry,
  createChannelTestPluginBase,
  createOutboundTestPlugin,
  createTestRegistry,
} from "./channel-plugins.js";

describe("activateTestChannelRegistry", () => {
  it("publishes channels after a cached lookup while retaining the Gateway registry and host settings", async () => {
    const previous = captureActivePluginRegistrySnapshot();
    const existing = createChannelTestPluginBase({ id: "existing" });
    const added = createChannelTestPluginBase({ id: "fixture" });
    const registry = createTestRegistry([
      { pluginId: "existing", plugin: existing, source: "test" },
    ]);
    try {
      setActivePluginRegistry(registry, "gateway-cache", "gateway-bindable", "/gateway-workspace");
      const gateway = captureActivePluginRegistrySnapshot();
      expect(getLoadedChannelPluginById("existing")).toBe(existing);
      expect(getLoadedChannelPluginById("fixture")).toBeUndefined();

      await activateTestChannelRegistry(
        createTestRegistry([{ pluginId: "fixture", plugin: added, source: "test" }]),
      );

      expect(getLoadedChannelPluginById("fixture")).toBe(added);
      expect(getLoadedChannelPluginById("existing")).toBe(existing);
      expect(captureActivePluginRegistrySnapshot()).toEqual(gateway);
      expect(captureActivePluginRegistrySnapshot().activeRegistry).toBe(registry);
      expect(registry.channelSetups.map((entry) => entry.plugin)).toEqual([existing, added]);
    } finally {
      restoreActivePluginRegistrySnapshot(previous);
    }
  });
});

describe("createChannelTestPluginBase", () => {
  it("builds a plugin base with defaults", () => {
    const cfg = {} as never;
    const base = createChannelTestPluginBase({ id: "demo-channel", label: "Demo Channel" });
    expect(base.id).toBe("demo-channel");
    expect(base.meta.label).toBe("Demo Channel");
    expect(base.meta.selectionLabel).toBe("Demo Channel");
    expect(base.meta.docsPath).toBe("/channels/demo-channel");
    expect(base.capabilities.chatTypes).toEqual(["direct"]);
    expect(base.config.listAccountIds(cfg)).toEqual(["default"]);
    expect(base.config.resolveAccount(cfg)).toStrictEqual({});
  });

  it("honors config and metadata overrides", async () => {
    const cfg = {} as never;
    const base = createChannelTestPluginBase({
      id: "demo-chat",
      label: "Demo Chat",
      docsPath: "/custom/demo-chat",
      capabilities: { chatTypes: ["group"] },
      config: {
        listAccountIds: () => ["acct-1"],
        isConfigured: async () => true,
      },
    });
    expect(base.meta.docsPath).toBe("/custom/demo-chat");
    expect(base.capabilities.chatTypes).toEqual(["group"]);
    expect(base.config.listAccountIds(cfg)).toEqual(["acct-1"]);
    const account = base.config.resolveAccount(cfg);
    await expect(base.config.isConfigured?.(account, cfg)).resolves.toBe(true);
  });
});

describe("createOutboundTestPlugin", () => {
  it("keeps outbound test plugin account list behavior", () => {
    const cfg = {} as never;
    const plugin = createOutboundTestPlugin({
      id: "demo-outbound",
      outbound: {
        deliveryMode: "direct",
        resolveTarget: () => ({ ok: true, to: "target" }),
        sendText: async () => ({ channel: "demo-outbound", messageId: "m1" }),
      },
    });
    expect(plugin.config.listAccountIds(cfg)).toStrictEqual([]);
  });
});
