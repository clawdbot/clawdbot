import { describe, expect, it } from "vitest";
import { createChannelTestPluginBase, createOutboundTestPlugin } from "./channel-plugins.js";

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
