import { ChannelType } from "discord-api-types/v10";
import type { NativeCommandSpec } from "openclaw/plugin-sdk/command-auth";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { DiscordAccountConfig } from "openclaw/plugin-sdk/config-runtime";
import * as pluginCommandsModule from "openclaw/plugin-sdk/plugin-runtime";
import * as dispatcherModule from "openclaw/plugin-sdk/reply-dispatch-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { __testing as nativeCommandTesting, createDiscordNativeCommand } from "./native-command.js";
import {
  createMockCommandInteraction,
  type MockCommandInteraction,
} from "./native-command.test-helpers.js";
import { createNoopThreadBindingManager } from "./thread-bindings.js";

function createInteraction(params?: { userId?: string }): MockCommandInteraction {
  return createMockCommandInteraction({
    userId: params?.userId ?? "123456789012345678",
    username: "discord-user",
    globalName: "Discord User",
    channelType: ChannelType.GuildText,
    channelId: "234567890123456789",
    guildId: "345678901234567890",
    guildName: "Test Guild",
    interactionId: "interaction-1",
  });
}

function createConfig(): OpenClawConfig {
  return {
    commands: {
      allowFrom: {
        discord: ["user:123456789012345678"],
      },
    },
    channels: {
      discord: {
        groupPolicy: "allowlist",
        guilds: {
          "345678901234567890": {
            channels: {
              "234567890123456789": {
                enabled: true,
                requireMention: false,
              },
            },
          },
        },
      },
    },
  } as OpenClawConfig;
}

function createCommand(cfg: OpenClawConfig, discordConfig?: DiscordAccountConfig) {
  const commandSpec: NativeCommandSpec = {
    name: "ping",
    description: "Ping",
    acceptsArgs: false,
  };
  return createDiscordNativeCommand({
    command: commandSpec,
    cfg,
    discordConfig: discordConfig ?? cfg.channels?.discord ?? {},
    accountId: "default",
    sessionPrefix: "discord:slash",
    ephemeralDefault: true,
    threadBindings: createNoopThreadBindingManager("default"),
  });
}

function createDispatchSpy() {
  const dispatchSpy = vi.spyOn(dispatcherModule, "dispatchReplyWithDispatcher").mockResolvedValue({
    counts: {
      final: 1,
      block: 0,
      tool: 0,
    },
  } as never);
  nativeCommandTesting.setDispatchReplyWithDispatcher(dispatcherModule.dispatchReplyWithDispatcher);
  return dispatchSpy;
}

async function runGuildSlashCommand(params?: {
  userId?: string;
  mutateConfig?: (cfg: OpenClawConfig) => void;
  runtimeDiscordConfig?: DiscordAccountConfig;
  mutateInteraction?: (interaction: MockCommandInteraction) => void;
}) {
  const cfg = createConfig();
  params?.mutateConfig?.(cfg);
  const command = createCommand(cfg, params?.runtimeDiscordConfig);
  const interaction = createInteraction({ userId: params?.userId });
  params?.mutateInteraction?.(interaction);
  vi.spyOn(pluginCommandsModule, "matchPluginCommand").mockReturnValue(null);
  const dispatchSpy = createDispatchSpy();
  await (command as { run: (interaction: unknown) => Promise<void> }).run(interaction as unknown);
  return { dispatchSpy, interaction };
}

function expectNotUnauthorizedReply(interaction: MockCommandInteraction) {
  expect(interaction.followUp).not.toHaveBeenCalledWith(
    expect.objectContaining({ content: "You are not authorized to use this command." }),
  );
}

function expectUnauthorizedReply(interaction: MockCommandInteraction) {
  expect(interaction.followUp).toHaveBeenCalledWith(
    expect.objectContaining({
      content: "You are not authorized to use this command.",
      ephemeral: true,
    }),
  );
  expect(interaction.reply).not.toHaveBeenCalled();
}

describe("Discord native slash commands with commands.allowFrom", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    nativeCommandTesting.setDispatchReplyWithDispatcher(
      dispatcherModule.dispatchReplyWithDispatcher,
    );
  });

  it("authorizes guild slash commands when commands.allowFrom.discord matches the sender", async () => {
    const { dispatchSpy, interaction } = await runGuildSlashCommand();
    expect(interaction.defer).toHaveBeenCalledTimes(1);
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expectNotUnauthorizedReply(interaction);
  });

  it("authorizes guild slash commands from the global commands.allowFrom list when provider-specific allowFrom is missing", async () => {
    const { dispatchSpy, interaction } = await runGuildSlashCommand({
      mutateConfig: (cfg) => {
        cfg.commands = {
          allowFrom: {
            "*": ["user:123456789012345678"],
          },
        };
      },
    });
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expectNotUnauthorizedReply(interaction);
  });

  it("authorizes guild slash commands when commands.useAccessGroups is false and commands.allowFrom.discord matches the sender", async () => {
    const { dispatchSpy, interaction } = await runGuildSlashCommand({
      mutateConfig: (cfg) => {
        cfg.commands = {
          ...cfg.commands,
          useAccessGroups: false,
        };
      },
    });
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expectNotUnauthorizedReply(interaction);
  });

  it("tolerates partial guild channels whose name getter throws", async () => {
    const { dispatchSpy, interaction } = await runGuildSlashCommand({
      mutateInteraction: (currentInteraction) => {
        Object.defineProperty(currentInteraction.channel, "name", {
          configurable: true,
          enumerable: true,
          get() {
            throw new Error(
              "Cannot access rawData on partial Channel. Use fetch() to populate data.",
            );
          },
        });
      },
    });
    expect(interaction.defer).toHaveBeenCalledTimes(1);
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expectNotUnauthorizedReply(interaction);
  });

  it("tolerates partial guild channels whose topic getter throws", async () => {
    const { dispatchSpy, interaction } = await runGuildSlashCommand({
      mutateInteraction: (currentInteraction) => {
        Object.defineProperty(currentInteraction.channel, "topic", {
          configurable: true,
          enumerable: true,
          get() {
            throw new Error(
              "Cannot access rawData on partial Channel. Use fetch() to populate data.",
            );
          },
        });
      },
    });
    expect(interaction.defer).toHaveBeenCalledTimes(1);
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expectNotUnauthorizedReply(interaction);
  });

  it("tolerates partial guild thread channels whose parentId getter throws", async () => {
    const { dispatchSpy, interaction } = await runGuildSlashCommand({
      mutateInteraction: (currentInteraction) => {
        currentInteraction.channel = {
          type: ChannelType.PublicThread,
          id: currentInteraction.channel.id,
        } as MockCommandInteraction["channel"];
        Object.defineProperty(currentInteraction.channel, "parentId", {
          configurable: true,
          enumerable: true,
          get() {
            throw new Error(
              "Cannot access rawData on partial Channel. Use fetch() to populate data.",
            );
          },
        });
      },
    });
    expect(interaction.defer).toHaveBeenCalledTimes(1);
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expectNotUnauthorizedReply(interaction);
  });

  it("tolerates guild thread channels exposed through a Proxy whose has trap throws", async () => {
    const { dispatchSpy, interaction } = await runGuildSlashCommand({
      mutateInteraction: (currentInteraction) => {
        const baseChannel = {
          type: ChannelType.PublicThread,
          id: currentInteraction.channel.id,
        };
        currentInteraction.channel = new Proxy(baseChannel, {
          has(target, key) {
            if (key === "parentId") {
              throw new Error("has-trap denied");
            }
            return key in target;
          },
          get(target, key, receiver) {
            return Reflect.get(target, key, receiver);
          },
        }) as MockCommandInteraction["channel"];
      },
    });
    expect(interaction.defer).toHaveBeenCalledTimes(1);
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expectNotUnauthorizedReply(interaction);
  });

  it("authorizes guild slash commands from an allowlisted channel when commands.allowFrom is not configured", async () => {
    const { dispatchSpy, interaction } = await runGuildSlashCommand({
      mutateConfig: (cfg) => {
        cfg.commands = {
          ...cfg.commands,
          allowFrom: undefined,
        };
      },
    });
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expectNotUnauthorizedReply(interaction);
  });

  it("rejects guild slash commands outside the Discord allowlist when commands.useAccessGroups is false and commands.allowFrom is not configured", async () => {
    const { dispatchSpy, interaction } = await runGuildSlashCommand({
      mutateConfig: (cfg) => {
        cfg.commands = {
          ...cfg.commands,
          useAccessGroups: false,
          allowFrom: undefined,
        };
        cfg.channels = {
          ...cfg.channels,
          discord: {
            ...cfg.channels?.discord,
            guilds: {
              "000000000000000000": {
                channels: {
                  "111111111111111111": {
                    enabled: true,
                    requireMention: false,
                  },
                },
              },
            },
          },
        };
      },
    });
    expect(dispatchSpy).not.toHaveBeenCalled();
    expectUnauthorizedReply(interaction);
  });

  it("rejects guild slash commands when commands.allowFrom.discord does not match the sender", async () => {
    const { dispatchSpy, interaction } = await runGuildSlashCommand({
      userId: "999999999999999999",
    });
    expect(dispatchSpy).not.toHaveBeenCalled();
    expectUnauthorizedReply(interaction);
  });

  it("rejects guild slash commands when commands.useAccessGroups is false and commands.allowFrom.discord does not match the sender", async () => {
    const { dispatchSpy, interaction } = await runGuildSlashCommand({
      userId: "999999999999999999",
      mutateConfig: (cfg) => {
        cfg.commands = {
          ...cfg.commands,
          useAccessGroups: false,
        };
      },
    });
    expect(dispatchSpy).not.toHaveBeenCalled();
    expectUnauthorizedReply(interaction);
  });

  it("authorizes guild slash commands when commands.allowFrom.discord contains a matching guild: entry", async () => {
    const { dispatchSpy, interaction } = await runGuildSlashCommand({
      userId: "999999999999999999",
      mutateConfig: (cfg) => {
        cfg.commands = {
          allowFrom: {
            discord: ["guild:345678901234567890"],
          },
        };
      },
    });
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expectNotUnauthorizedReply(interaction);
  });

  it("rejects guild slash commands when commands.allowFrom.discord has a guild: entry that does not match", async () => {
    const { dispatchSpy, interaction } = await runGuildSlashCommand({
      userId: "999999999999999999",
      mutateConfig: (cfg) => {
        cfg.commands = {
          allowFrom: {
            discord: ["guild:000000000000000000"],
          },
        };
      },
    });
    expect(dispatchSpy).not.toHaveBeenCalled();
    expectUnauthorizedReply(interaction);
  });

  it("uses the root discord maxLinesPerMessage when runtime discordConfig omits it", async () => {
    const longReply = Array.from({ length: 20 }, (_value, index) => `Line ${index + 1}`).join("\n");
    const { interaction } = await runGuildSlashCommand({
      mutateConfig: (cfg) => {
        cfg.channels = {
          ...cfg.channels,
          discord: {
            ...cfg.channels?.discord,
            maxLinesPerMessage: 120,
          },
        };
      },
      runtimeDiscordConfig: {
        groupPolicy: "allowlist",
        guilds: {
          "345678901234567890": {
            channels: {
              "234567890123456789": {
                enabled: true,
                requireMention: false,
              },
            },
          },
        },
      },
    });

    const dispatchCall = vi.mocked(dispatcherModule.dispatchReplyWithDispatcher).mock.calls[0]?.[0];
    await dispatchCall?.dispatcherOptions.deliver({ text: longReply }, { kind: "final" });

    expect(interaction.followUp).toHaveBeenCalledWith(
      expect.objectContaining({ content: longReply }),
    );
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it("swallows expired slash interactions before dispatch when defer returns Unknown interaction", async () => {
    const cfg = createConfig();
    const command = createCommand(cfg);
    const interaction = createInteraction();
    interaction.defer.mockRejectedValue({
      status: 404,
      discordCode: 10062,
      rawBody: {
        message: "Unknown interaction",
        code: 10062,
      },
    });
    vi.spyOn(pluginCommandsModule, "matchPluginCommand").mockReturnValue(null);
    const dispatchSpy = createDispatchSpy();

    await expect(
      (command as { run: (interaction: unknown) => Promise<void> }).run(interaction as unknown),
    ).resolves.toBeUndefined();

    expect(interaction.defer).toHaveBeenCalledTimes(1);
    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(interaction.reply).not.toHaveBeenCalled();
    expect(interaction.followUp).not.toHaveBeenCalled();
  });
});
