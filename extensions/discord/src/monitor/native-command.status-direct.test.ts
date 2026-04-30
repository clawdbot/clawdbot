import { ChannelType } from "discord-api-types/v10";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockCommandInteraction as createInteraction } from "./native-command.test-helpers.js";
import { createNoopThreadBindingManager } from "./thread-bindings.js";

const runtimeModuleMocks = vi.hoisted(() => ({
  dispatchReplyWithDispatcher: vi.fn(),
  loadWebMedia: vi.fn(),
  resolveDirectStatusReplyForSession: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/reply-dispatch-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/reply-dispatch-runtime")>(
    "openclaw/plugin-sdk/reply-dispatch-runtime",
  );
  return {
    ...actual,
    dispatchReplyWithDispatcher: (...args: unknown[]) =>
      runtimeModuleMocks.dispatchReplyWithDispatcher(...args),
  };
});

vi.mock("openclaw/plugin-sdk/command-status-runtime", () => ({
  resolveDirectStatusReplyForSession: (...args: unknown[]) =>
    runtimeModuleMocks.resolveDirectStatusReplyForSession(...args),
}));

vi.mock("openclaw/plugin-sdk/web-media", () => ({
  loadWebMedia: (...args: unknown[]) => runtimeModuleMocks.loadWebMedia(...args),
}));

let createDiscordNativeCommand: typeof import("./native-command.js").createDiscordNativeCommand;
let discordNativeCommandTesting: typeof import("./native-command.js").__testing;

function createConfig(params?: { requireMention?: boolean }): OpenClawConfig {
  return {
    commands: {
      useAccessGroups: false,
    },
    channels: {
      discord: {
        dm: { enabled: true, policy: "open", allowFrom: ["*"] },
        guilds: {
          guild1: {
            requireMention: true,
            channels: {
              chan1: {
                allow: true,
                requireMention: params?.requireMention ?? true,
              },
            },
          },
        },
      },
    },
  } as OpenClawConfig;
}

async function createStatusCommand(cfg: OpenClawConfig) {
  return createDiscordNativeCommand({
    command: {
      name: "status",
      description: "Status",
      acceptsArgs: false,
    },
    cfg,
    discordConfig: cfg.channels?.discord ?? {},
    accountId: "default",
    sessionPrefix: "discord:slash",
    ephemeralDefault: true,
    threadBindings: createNoopThreadBindingManager("default"),
  });
}

function setDefaultRouteState() {
  discordNativeCommandTesting.setResolveDiscordNativeInteractionRouteState(async (params) => ({
    route: {
      agentId: "main",
      channel: "discord",
      accountId: params.accountId ?? "default",
      sessionKey: "agent:main:main",
      mainSessionKey: "agent:main:main",
      lastRoutePolicy: "session",
      matchedBy: "default",
    },
    effectiveRoute: {
      agentId: "main",
      channel: "discord",
      accountId: params.accountId ?? "default",
      sessionKey: "agent:main:main",
      mainSessionKey: "agent:main:main",
      lastRoutePolicy: "session",
      matchedBy: "default",
    },
    boundSessionKey: undefined,
    configuredRoute: null,
    configuredBinding: null,
    bindingReadiness: null,
  }));
}

function firstStatusCall(): {
  cfg: OpenClawConfig;
  sessionKey: string;
  channel: string;
  isGroup: boolean;
  defaultGroupActivation: () => "always" | "mention";
} {
  const call = runtimeModuleMocks.resolveDirectStatusReplyForSession.mock.calls[0]?.[0];
  if (!call) {
    throw new Error("expected resolveDirectStatusReplyForSession to be called");
  }
  return call as {
    cfg: OpenClawConfig;
    sessionKey: string;
    channel: string;
    isGroup: boolean;
    defaultGroupActivation: () => "always" | "mention";
  };
}

describe("discord native /status", () => {
  beforeAll(async () => {
    ({ createDiscordNativeCommand, __testing: discordNativeCommandTesting } =
      await import("./native-command.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    runtimeModuleMocks.dispatchReplyWithDispatcher.mockResolvedValue({
      counts: {
        final: 0,
        block: 0,
        tool: 0,
      },
      queuedFinal: false,
    } as never);
    runtimeModuleMocks.resolveDirectStatusReplyForSession.mockResolvedValue({
      text: "status reply",
    });
    runtimeModuleMocks.loadWebMedia.mockResolvedValue({
      buffer: Buffer.from("image"),
      fileName: "status.png",
    });
    discordNativeCommandTesting.setDispatchReplyWithDispatcher(
      runtimeModuleMocks.dispatchReplyWithDispatcher as typeof import("openclaw/plugin-sdk/reply-dispatch-runtime").dispatchReplyWithDispatcher,
    );
    discordNativeCommandTesting.setMatchPluginCommand(
      (() => null) as typeof import("openclaw/plugin-sdk/plugin-runtime").matchPluginCommand,
    );
    setDefaultRouteState();
  });

  it("returns a direct status reply without falling through the generic dispatcher", async () => {
    const cfg = createConfig();
    const command = await createStatusCommand(cfg);
    const interaction = createInteraction();

    await (command as { run: (interaction: unknown) => Promise<void> }).run(interaction as unknown);

    expect(runtimeModuleMocks.resolveDirectStatusReplyForSession).toHaveBeenCalledTimes(1);
    expect(runtimeModuleMocks.dispatchReplyWithDispatcher).not.toHaveBeenCalled();
    expect(interaction.followUp).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "status reply",
        ephemeral: true,
      }),
    );
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it("prioritizes direct status replies over matching plugin commands", async () => {
    const executePluginCommand = vi.fn(async () => ({ text: "plugin status" }));
    discordNativeCommandTesting.setMatchPluginCommand((() => ({
      command: {
        name: "status",
        description: "Plugin status",
        pluginId: "status-plugin",
        acceptsArgs: false,
        handler: async () => ({ text: "plugin status" }),
      },
      args: undefined,
    })) as typeof import("openclaw/plugin-sdk/plugin-runtime").matchPluginCommand);
    discordNativeCommandTesting.setExecutePluginCommand(
      executePluginCommand as typeof import("openclaw/plugin-sdk/plugin-runtime").executePluginCommand,
    );
    const cfg = createConfig();
    const command = await createStatusCommand(cfg);
    const interaction = createInteraction();

    await (command as { run: (interaction: unknown) => Promise<void> }).run(interaction as unknown);

    expect(runtimeModuleMocks.resolveDirectStatusReplyForSession).toHaveBeenCalledTimes(1);
    expect(executePluginCommand).not.toHaveBeenCalled();
    expect(interaction.followUp).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "status reply",
        ephemeral: true,
      }),
    );
  });

  it("keeps every direct status chunk ephemeral", async () => {
    runtimeModuleMocks.resolveDirectStatusReplyForSession.mockResolvedValue({
      text: `fallback models\nruntime info\n${"x".repeat(2200)}`,
    });
    const cfg = createConfig();
    const command = await createStatusCommand(cfg);
    const interaction = createInteraction();

    await (command as { run: (interaction: unknown) => Promise<void> }).run(interaction as unknown);

    expect(interaction.followUp.mock.calls.length).toBeGreaterThan(1);
    for (const [payload] of interaction.followUp.mock.calls) {
      expect(payload).toEqual(
        expect.objectContaining({
          ephemeral: true,
        }),
      );
    }
  });

  it("keeps direct status media follow-up chunks ephemeral", async () => {
    runtimeModuleMocks.resolveDirectStatusReplyForSession.mockResolvedValue({
      text: `status image\n${"x".repeat(2200)}`,
      mediaUrls: ["https://example.com/status.png"],
    });
    const cfg = createConfig();
    const command = await createStatusCommand(cfg);
    const interaction = createInteraction();

    await (command as { run: (interaction: unknown) => Promise<void> }).run(interaction as unknown);

    expect(runtimeModuleMocks.loadWebMedia).toHaveBeenCalledWith("https://example.com/status.png", {
      localRoots: expect.any(Array),
    });
    expect(interaction.followUp.mock.calls.length).toBeGreaterThan(1);
    expect(interaction.followUp.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        ephemeral: true,
        files: expect.arrayContaining([expect.objectContaining({ name: "status.png" })]),
      }),
    );
    for (const [payload] of interaction.followUp.mock.calls) {
      expect(payload).toEqual(
        expect.objectContaining({
          ephemeral: true,
        }),
      );
    }
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it("passes through the effective guild activation when requireMention is disabled", async () => {
    const cfg = createConfig({ requireMention: false });
    const command = await createStatusCommand(cfg);
    const interaction = createInteraction({
      channelType: ChannelType.GuildText,
      channelId: "chan1",
      guildId: "guild1",
      guildName: "Guild One",
    });

    await (command as { run: (interaction: unknown) => Promise<void> }).run(interaction as unknown);

    const statusCall = firstStatusCall();
    expect(statusCall.channel).toBe("discord");
    expect(statusCall.isGroup).toBe(true);
    expect(statusCall.defaultGroupActivation()).toBe("always");
  });
});
