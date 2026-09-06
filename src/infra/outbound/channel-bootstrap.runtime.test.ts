// Covers lazy outbound channel bootstrap, retry guards, auto-enable config, and
// send-capable active registry short-circuiting.
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSelectionRequiredError } from "../../agents/agent-scope-config.js";
import { migratePersistedImplicitMainRoster } from "../../config/legacy.roster.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  requireActivePluginRegistry,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";

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
const {
  createChannelHandler,
  resolveChannelOutboundDirectiveOptions,
  resolveOutboundDurableFinalDeliverySupport,
} = await import("./deliver-channel.js");
const { resolveChannelTargetForDelivery, resolveOutboundSessionRouteForDelivery } =
  await import("../../cron/isolated-agent/delivery-target.runtime.js");

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

const explicitFleetDiscordConfig = {
  agents: {
    ownership: "explicit",
    entries: {
      ops: { workspace: "/tmp/openclaw-ops" },
      research: { workspace: "/tmp/openclaw-research" },
    },
  },
  channels: {
    discord: {},
  },
} satisfies OpenClawConfig;

const systemOwnedFleetDiscordConfig = {
  agents: {
    ownership: "explicit",
    defaults: { systemAgent: { agentId: "ops" } },
    entries: {
      ops: { workspace: "/tmp/openclaw-ops" },
      research: { workspace: "/tmp/openclaw-research" },
    },
  },
  channels: {
    discord: {},
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

  it("uses the admitted agent workspace during outbound preparation", async () => {
    installDiscordSetupShell();
    const handle = createEmptyPluginRegistry();
    handle.channels = [
      {
        pluginId: "discord",
        plugin: {
          id: "discord",
          meta: {},
          outbound: {
            extractMarkdownImages: true,
            sendText: async () => ({ messageId: "1" }),
          },
        },
        source: "runtime",
      },
    ] as never;
    loaderMocks.loadPluginRegistryHandle.mockReturnValue(handle);

    await expect(
      resolveChannelOutboundDirectiveOptions({
        channel: "discord",
        cfg: explicitFleetDiscordConfig,
        agentId: "ops",
      }),
    ).resolves.toEqual({ extractMarkdownImages: true });

    expect(loaderMocks.resolveDiscoverableScopedChannelPluginIds).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceDir: "/tmp/openclaw-ops" }),
    );
  });

  it("bootstraps outbound sends with the retained legacy owner after config load", async () => {
    installDiscordSetupShell();
    const migrated = migratePersistedImplicitMainRoster({
      agents: {
        defaults: { workspace: "/tmp/openclaw-legacy" },
        entries: {
          ops: { default: true },
          research: {},
        },
      },
      channels: { discord: {} },
    }).config as OpenClawConfig;
    const handle = createEmptyPluginRegistry();
    handle.channels = [
      {
        pluginId: "discord",
        plugin: {
          id: "discord",
          meta: {},
          outbound: {
            extractMarkdownImages: true,
            sendText: async () => ({ messageId: "1" }),
          },
        },
        source: "runtime",
      },
    ] as never;
    loaderMocks.loadPluginRegistryHandle.mockReturnValue(handle);

    await expect(
      resolveChannelOutboundDirectiveOptions({
        channel: "discord",
        cfg: migrated,
      }),
    ).resolves.toEqual({ extractMarkdownImages: true });

    expect(migrated.agents?.entries?.ops?.default).toBeUndefined();
    expect(loaderMocks.resolveDiscoverableScopedChannelPluginIds).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceDir: "/tmp/openclaw-legacy" }),
    );
  });

  it("routes agent-less bootstrap through the configured system-agent owner", () => {
    installDiscordSetupShell();
    loaderMocks.loadPluginRegistryHandle.mockReturnValue(createEmptyPluginRegistry());

    bootstrapOutboundChannelPlugin({
      channel: "discord",
      cfg: systemOwnedFleetDiscordConfig,
    });

    expect(loaderMocks.loadPluginRegistryHandle).toHaveBeenCalledTimes(1);
    expect(loaderMocks.resolveDiscoverableScopedChannelPluginIds).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceDir: "/tmp/openclaw-ops" }),
    );
  });

  it("bootstraps ownerless fleets with global discovery instead of throwing", () => {
    installDiscordSetupShell();
    loaderMocks.loadPluginRegistryHandle.mockReturnValue(createEmptyPluginRegistry());

    expect(() =>
      bootstrapOutboundChannelPlugin({
        channel: "discord",
        cfg: explicitFleetDiscordConfig,
      }),
    ).not.toThrow(AgentSelectionRequiredError);

    expect(loaderMocks.loadPluginRegistryHandle).toHaveBeenCalledTimes(1);
    expect(loaderMocks.resolveDiscoverableScopedChannelPluginIds).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceDir: undefined }),
    );
  });

  it("caches bootstrap outcomes per admitted agent", () => {
    installDiscordSetupShell();
    loaderMocks.loadPluginRegistryHandle.mockReturnValue(createEmptyPluginRegistry());

    bootstrapOutboundChannelPlugin({
      channel: "discord",
      cfg: explicitFleetDiscordConfig,
      agentId: "ops",
    });
    bootstrapOutboundChannelPlugin({
      channel: "discord",
      cfg: explicitFleetDiscordConfig,
      agentId: "research",
    });

    expect(loaderMocks.loadPluginRegistryHandle).toHaveBeenCalledTimes(2);
    expect(loaderMocks.resolveDiscoverableScopedChannelPluginIds).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ workspaceDir: "/tmp/openclaw-research" }),
    );
  });

  it("carries the admitted agent runtime into cron target and session resolution", async () => {
    installDiscordSetupShell();
    const resolveTarget = vi.fn(async () => ({
      to: "channel:ops",
      kind: "channel" as const,
      source: "directory" as const,
    }));
    const resolveOutboundSessionRoute = vi.fn(() => ({
      sessionKey: "agent:ops:discord:channel:ops",
      baseSessionKey: "agent:ops:discord:channel:ops",
      recipientSessionExact: true as const,
      peer: { kind: "channel" as const, id: "ops" },
      chatType: "channel" as const,
      from: "discord:channel:ops",
      to: "channel:ops",
    }));
    const handle = createEmptyPluginRegistry();
    handle.channels = [
      {
        pluginId: "discord",
        plugin: {
          id: "discord",
          meta: {},
          outbound: { sendText: async () => ({ messageId: "1" }) },
          messaging: {
            targetResolver: { resolveTarget },
            resolveOutboundSessionRoute,
          },
        },
        source: "runtime",
      },
    ] as never;
    loaderMocks.loadPluginRegistryHandle.mockReturnValue(handle);

    await expect(
      resolveChannelTargetForDelivery({
        cfg: explicitFleetDiscordConfig,
        channel: "discord",
        agentId: "ops",
        input: "ops",
      }),
    ).resolves.toMatchObject({ ok: true, target: { to: "channel:ops" } });
    await expect(
      resolveOutboundSessionRouteForDelivery({
        cfg: explicitFleetDiscordConfig,
        channel: "discord",
        agentId: "ops",
        target: "channel:ops",
      }),
    ).resolves.toMatchObject({ sessionKey: "agent:ops:discord:channel:ops" });

    expect(resolveTarget).toHaveBeenCalledTimes(1);
    expect(resolveOutboundSessionRoute).toHaveBeenCalledTimes(1);
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

  it.each([false, true])(
    "activates the scoped setup shell without borrowing a same-id root sender (cached=%s)",
    (cached) => {
      const base = createChannelTestPluginBase({ id: "discord" });
      const root = {
        ...base,
        ...(!cached ? { outbound: { deliveryMode: "direct" as const, sendText: vi.fn() } } : {}),
      };
      const activated = {
        ...base,
        outbound: { deliveryMode: "direct" as const, sendText: vi.fn() },
      };
      setActivePluginRegistry(
        createTestRegistry([{ pluginId: "root", source: "root", plugin: root }]),
      );
      const setupRegistry = createTestRegistry([
        { pluginId: "selected", source: "setup", plugin: base },
      ]);
      const runtimeRegistry = createTestRegistry([
        { pluginId: "selected", source: "runtime", plugin: activated },
      ]);
      if (cached) {
        const prior = createTestRegistry([
          { pluginId: "root", source: "prior", plugin: activated },
        ]);
        loaderMocks.loadPluginRegistryHandle.mockReturnValue(prior);
        expect(bootstrapOutboundChannelPlugin({ channel: "discord", cfg: discordConfig })).toBe(
          prior,
        );
        loaderMocks.loadPluginRegistryHandle.mockClear();
      }
      loaderMocks.loadPluginRegistryHandle.mockReturnValue(runtimeRegistry);

      expect(
        withPluginRuntimeRegistryScope(setupRegistry, () =>
          bootstrapOutboundChannelPlugin({
            channel: "discord",
            cfg: discordConfig,
          }),
        ),
      ).toBe(runtimeRegistry);
      expect(loaderMocks.loadPluginRegistryHandle).toHaveBeenCalledOnce();
      expect(getActivePluginRegistry()?.channels[0]?.plugin).toBe(root);
    },
  );

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
    expect(bootstrapOutboundChannelPlugin({ channel: "discord", cfg: discordConfig })).toBe(handle);
    expect(getActivePluginRegistry()).toBe(root);
    expect(loaderMocks.loadPluginRegistryHandle).toHaveBeenCalledTimes(1);
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

  it.each(["outbound", "message"] as const)(
    "retains the scoped %s transport and its durable capabilities through delivery",
    async (transport) => {
      const base = createChannelTestPluginBase({ id: "discord" });
      const rootSend = vi.fn(async () => ({ channel: "discord", messageId: "root" }));
      const sendRegistries: ReturnType<typeof requireActivePluginRegistry>[] = [];
      const scopedSend = vi.fn(async () => {
        sendRegistries.push(requireActivePluginRegistry());
        return { channel: "discord", messageId: "scoped" };
      });
      const message = (send: typeof rootSend, id: string) => ({
        send: {
          text: async () => {
            await send();
            return {
              receipt: {
                primaryPlatformMessageId: id,
                platformMessageIds: [id],
                sentAt: 1,
                parts: [{ platformMessageId: id, kind: "text" as const, index: 0 }],
              },
            };
          },
        },
      });
      const root = {
        ...base,
        outbound: { deliveryMode: "direct" as const, sendText: rootSend },
        message: {
          ...message(rootSend, "root"),
          durableFinal: { capabilities: { text: true, silent: true } },
        },
      };
      const scoped = {
        ...base,
        ...(transport === "outbound"
          ? { outbound: { deliveryMode: "direct" as const, sendText: scopedSend } }
          : { message: message(scopedSend, "scoped") }),
      };
      setActivePluginRegistry(
        createTestRegistry([{ pluginId: "root", source: "root", plugin: root }]),
      );
      const registry = createTestRegistry([
        { pluginId: "scoped", source: "scoped", plugin: scoped },
      ]);

      const handler = await withPluginRuntimeRegistryScope(registry, async () => {
        await expect(
          resolveOutboundDurableFinalDeliverySupport({
            cfg: discordConfig,
            channel: "discord",
            requirements: { silent: true },
          }),
        ).resolves.toEqual({ ok: false, reason: "capability_mismatch", capability: "silent" });
        return await createChannelHandler({
          cfg: discordConfig,
          channel: "discord",
          to: "recipient",
        });
      });
      await expect(handler.sendText("hello")).resolves.toMatchObject({ messageId: "scoped" });
      expect(sendRegistries).toEqual([registry]);
      expect(scopedSend).toHaveBeenCalledOnce();
      expect(rootSend).not.toHaveBeenCalled();
      expect(loaderMocks.loadPluginRegistryHandle).not.toHaveBeenCalled();
    },
  );

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

  it("bounds failed channel outcomes and refreshes misses by LRU recency", () => {
    installDiscordSetupShell();
    loaderMocks.loadPluginRegistryHandle.mockReturnValue(createEmptyPluginRegistry());

    for (let index = 0; index < 64; index += 1) {
      bootstrapOutboundChannelPlugin({ channel: `channel-${index}`, cfg: discordConfig });
    }
    bootstrapOutboundChannelPlugin({ channel: "channel-0", cfg: discordConfig });
    bootstrapOutboundChannelPlugin({ channel: "channel-64", cfg: discordConfig });
    bootstrapOutboundChannelPlugin({ channel: "channel-0", cfg: discordConfig });

    expect(loaderMocks.loadPluginRegistryHandle).toHaveBeenCalledTimes(65);

    bootstrapOutboundChannelPlugin({ channel: "channel-1", cfg: discordConfig });

    expect(loaderMocks.loadPluginRegistryHandle).toHaveBeenCalledTimes(66);
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
