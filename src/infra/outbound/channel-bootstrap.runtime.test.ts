// Covers lazy outbound channel bootstrap, retry guards, auto-enable config, and
// send-capable active registry short-circuiting.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";

const loaderMocks = vi.hoisted(() => ({
  loadPluginRegistryHandle: vi.fn(),
  resolveDiscoverableScopedChannelPluginIds: vi.fn(() => ["discord"]),
}));

vi.mock("../../plugins/channel-plugin-ids.js", () => ({
  resolveDiscoverableScopedChannelPluginIds: loaderMocks.resolveDiscoverableScopedChannelPluginIds,
}));

vi.mock("../../plugins/loader.js", () => ({
  loadPluginRegistryHandle: loaderMocks.loadPluginRegistryHandle,
}));

const { bootstrapOutboundChannelPlugin, resetOutboundChannelBootstrapStateForTests } =
  await import("./channel-bootstrap.runtime.js");
const { resolveOutboundDurableFinalDeliverySupport } = await import("./deliver-channel.js");

const discordConfig = {
  channels: {
    discord: {},
  },
} satisfies OpenClawConfig;

const updatedDiscordConfig = {
  channels: {
    discord: { enabled: true },
  },
} satisfies OpenClawConfig;

function installDiscordSetupShell(): void {
  const registry = createEmptyPluginRegistry();
  registry.channels = [
    {
      pluginId: "discord",
      plugin: { id: "discord", meta: {} },
      source: "setup",
    },
  ] as never;
  setActivePluginRegistry(registry);
}

describe("bootstrapOutboundChannelPlugin", () => {
  afterEach(() => {
    loaderMocks.loadPluginRegistryHandle.mockReset();
    loaderMocks.resolveDiscoverableScopedChannelPluginIds.mockClear();
    resetOutboundChannelBootstrapStateForTests();
    resetPluginRuntimeStateForTest();
  });

  it("bootstraps when the selected channel registry has only a setup shell", () => {
    installDiscordSetupShell();

    bootstrapOutboundChannelPlugin({
      channel: "discord",
      cfg: discordConfig,
    });

    expect(loaderMocks.loadPluginRegistryHandle).toHaveBeenCalledTimes(1);
  });

  it("skips bootstrap when the selected channel entry can already send", () => {
    const registry = createEmptyPluginRegistry();
    registry.channels = [
      {
        pluginId: "discord",
        plugin: {
          id: "discord",
          meta: {},
          outbound: { sendText: async () => ({ messageId: "1" }) },
        },
        source: "runtime",
      },
    ] as never;
    setActivePluginRegistry(registry);

    bootstrapOutboundChannelPlugin({
      channel: "discord",
      cfg: discordConfig,
    });

    expect(loaderMocks.loadPluginRegistryHandle).not.toHaveBeenCalled();
  });

  it("returns a scoped handle without replacing the process root", () => {
    installDiscordSetupShell();
    const root = getActivePluginRegistry();
    const handle = createEmptyPluginRegistry();
    handle.channels = [
      {
        pluginId: "discord",
        plugin: {
          id: "discord",
          meta: {},
          outbound: { sendText: async () => ({ messageId: "1" }) },
        },
        source: "runtime",
      },
    ] as never;
    loaderMocks.loadPluginRegistryHandle.mockReturnValue(handle);

    expect(bootstrapOutboundChannelPlugin({ channel: "discord", cfg: discordConfig })).toBe(handle);
    expect(getActivePluginRegistry()).toBe(root);
    expect(loaderMocks.loadPluginRegistryHandle).toHaveBeenCalledWith(
      expect.objectContaining({ onlyPluginIds: ["discord"] }),
    );
  });

  it("resolves durable message capabilities inside the scoped handle", async () => {
    installDiscordSetupShell();
    const handle = createEmptyPluginRegistry();
    handle.channels = [
      {
        pluginId: "discord",
        plugin: {
          id: "discord",
          meta: {},
          message: {
            durableFinal: { capabilities: { text: true, silent: true } },
            send: { text: async () => ({ messageId: "1" }) },
          },
        },
        source: "runtime",
      },
    ] as never;
    loaderMocks.loadPluginRegistryHandle.mockReturnValue(handle);

    await expect(
      resolveOutboundDurableFinalDeliverySupport({
        channel: "discord",
        cfg: discordConfig,
        requirements: { text: true, silent: true },
      }),
    ).resolves.toEqual({ ok: true, automaticUnknownSendReconciliation: false });
  });

  it("does not retry an unusable handle in the same generation", () => {
    installDiscordSetupShell();
    loaderMocks.loadPluginRegistryHandle.mockReturnValue(createEmptyPluginRegistry());

    expect(
      bootstrapOutboundChannelPlugin({ channel: "discord", cfg: discordConfig }),
    ).toBeUndefined();
    expect(
      bootstrapOutboundChannelPlugin({ channel: "discord", cfg: discordConfig }),
    ).toBeUndefined();

    expect(loaderMocks.loadPluginRegistryHandle).toHaveBeenCalledTimes(1);
  });

  it("does not retry a thrown bootstrap in the same generation", () => {
    installDiscordSetupShell();
    loaderMocks.loadPluginRegistryHandle.mockImplementation(() => {
      throw new Error("load failed");
    });

    bootstrapOutboundChannelPlugin({ channel: "discord", cfg: discordConfig });
    bootstrapOutboundChannelPlugin({ channel: "discord", cfg: discordConfig });

    expect(loaderMocks.loadPluginRegistryHandle).toHaveBeenCalledTimes(1);
  });

  it("retries after the runtime config changes", () => {
    installDiscordSetupShell();
    bootstrapOutboundChannelPlugin({ channel: "discord", cfg: discordConfig });
    bootstrapOutboundChannelPlugin({ channel: "discord", cfg: updatedDiscordConfig });

    expect(loaderMocks.loadPluginRegistryHandle).toHaveBeenCalledTimes(2);
  });

  it("retains failed attempts when distinct runtime configs interleave", () => {
    installDiscordSetupShell();
    loaderMocks.loadPluginRegistryHandle.mockReturnValue(createEmptyPluginRegistry());

    bootstrapOutboundChannelPlugin({ channel: "discord", cfg: discordConfig });
    bootstrapOutboundChannelPlugin({ channel: "discord", cfg: updatedDiscordConfig });
    bootstrapOutboundChannelPlugin({ channel: "discord", cfg: discordConfig });

    expect(loaderMocks.loadPluginRegistryHandle).toHaveBeenCalledTimes(2);
  });
});
