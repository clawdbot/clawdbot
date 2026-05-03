import { ChannelType } from "discord-api-types/v10";
import type { NativeCommandSpec } from "openclaw/plugin-sdk/command-auth";
import { resolveDirectStatusReplyForSession } from "openclaw/plugin-sdk/command-status-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import {
  clearPluginCommands,
  executePluginCommand,
  matchPluginCommand,
  registerPluginCommand,
} from "openclaw/plugin-sdk/plugin-runtime";
import {
  createTestRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { dispatchReplyWithDispatcher } from "openclaw/plugin-sdk/reply-dispatch-runtime";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { defineThrowingDiscordChannelGetter } from "../test-support/partial-channel.js";
import { resolveDiscordNativeInteractionRouteState } from "./native-command-route.js";
import {
  createMockCommandInteraction as createInteraction,
  type MockCommandInteraction,
} from "./native-command.test-helpers.js";
import { createNoopThreadBindingManager } from "./thread-bindings.manager.js";

let createDiscordNativeCommand: typeof import("./native-command.js").createDiscordNativeCommand;
let discordNativeCommandTesting: typeof import("./native-command.js").__testing;
const runtimeModuleMocks = vi.hoisted(() => ({
  matchPluginCommand: vi.fn(),
  executePluginCommand: vi.fn(),
  dispatchReplyWithDispatcher: vi.fn(),
  resolveDirectStatusReplyForSession: vi.fn(),
}));

function createConfig(): OpenClawConfig {
  return {
    channels: {
      discord: {
        dm: { enabled: true, policy: "open", allowFrom: ["*"] },
      },
    },
  } as OpenClawConfig;
}

function createConfiguredAcpBinding(params: {
  channelId: string;
  peerKind: "channel" | "direct";
  agentId?: string;
}) {
  return {
    type: "acp",
    agentId: params.agentId ?? "codex",
    match: {
      channel: "discord",
      accountId: "default",
      peer: { kind: params.peerKind, id: params.channelId },
    },
    acp: {
      mode: "persistent",
    },
  } as const;
}

function createConfiguredAcpCase(params: {
  channelType: ChannelType;
  channelId: string;
  peerKind: "channel" | "direct";
  guildId?: string;
  guildName?: string;
  includeChannelAccess?: boolean;
  agentId?: string;
}) {
  return {
    cfg: {
      commands: {
        useAccessGroups: false,
      },
      ...(params.includeChannelAccess === false
        ? {}
        : params.channelType === ChannelType.DM
          ? {
              channels: {
                discord: {
                  dm: { enabled: true, policy: "open", allowFrom: ["*"] },
                },
              },
            }
          : {
              channels: {
                discord: {
                  guilds: {
                    [params.guildId!]: {
                      channels: {
                        [params.channelId]: { enabled: true, requireMention: false },
                      },
                    },
                  },
                },
              },
            }),
      bindings: [
        createConfiguredAcpBinding({
          channelId: params.channelId,
          peerKind: params.peerKind,
          agentId: params.agentId,
        }),
      ],
    } as OpenClawConfig,
    interaction: createInteraction({
      channelType: params.channelType,
      channelId: params.channelId,
      guildId: params.guildId,
      guildName: params.guildName,
    }),
  };
}

async function createNativeCommand(cfg: OpenClawConfig, commandSpec: NativeCommandSpec) {
  return createDiscordNativeCommand({
    command: commandSpec,
    cfg,
    discordConfig: cfg.channels?.discord ?? {},
    accountId: "default",
    sessionPrefix: "discord:slash",
    ephemeralDefault: true,
    threadBindings: createNoopThreadBindingManager("default"),
  });
}

function createConfiguredRouteState(params: {
  sessionKey: string;
  agentId?: string;
  accountId?: string;
}) {
  return {
    route: {
      agentId: params.agentId ?? "main",
      channel: "discord",
      accountId: params.accountId ?? "default",
      sessionKey: params.sessionKey,
      mainSessionKey: `agent:${params.agentId ?? "main"}:main`,
      lastRoutePolicy: "session",
      matchedBy: "binding.channel",
    },
    effectiveRoute: {
      agentId: params.agentId ?? "main",
      channel: "discord",
      accountId: params.accountId ?? "default",
      sessionKey: params.sessionKey,
      mainSessionKey: `agent:${params.agentId ?? "main"}:main`,
      lastRoutePolicy: "session",
      matchedBy: "binding.channel",
    },
    boundSessionKey: params.sessionKey,
    configuredRoute: null,
    configuredBinding: null,
    bindingReadiness: { ok: true } as const,
  } satisfies Awaited<
    ReturnType<typeof import("./native-command-route.js").resolveDiscordNativeInteractionRouteState>
  >;
}

function createUnboundRouteState(params: {
  sessionKey: string;
  agentId?: string;
  accountId?: string;
}) {
  return {
    route: {
      agentId: params.agentId ?? "main",
      channel: "discord",
      accountId: params.accountId ?? "default",
      sessionKey: params.sessionKey,
      mainSessionKey: `agent:${params.agentId ?? "main"}:main`,
      lastRoutePolicy: "session",
      matchedBy: "default",
    },
    effectiveRoute: {
      agentId: params.agentId ?? "main",
      channel: "discord",
      accountId: params.accountId ?? "default",
      sessionKey: params.sessionKey,
      mainSessionKey: `agent:${params.agentId ?? "main"}:main`,
      lastRoutePolicy: "session",
      matchedBy: "default",
    },
    boundSessionKey: undefined,
    configuredRoute: null,
    configuredBinding: null,
    bindingReadiness: null,
  } satisfies Awaited<
    ReturnType<typeof import("./native-command-route.js").resolveDiscordNativeInteractionRouteState>
  >;
}

async function createPluginCommand(params: { cfg: OpenClawConfig; name: string }) {
  return createDiscordNativeCommand({
    command: {
      name: params.name,
      description: "Pair",
      acceptsArgs: true,
    } satisfies NativeCommandSpec,
    cfg: params.cfg,
    discordConfig: params.cfg.channels?.discord ?? {},
    accountId: "default",
    sessionPrefix: "discord:slash",
    ephemeralDefault: true,
    threadBindings: createNoopThreadBindingManager("default"),
  });
}

function registerPairPlugin(params?: { discordNativeName?: string }) {
  expect(
    registerPluginCommand("demo-plugin", {
      name: "pair",
      ...(params?.discordNativeName
        ? {
            nativeNames: {
              telegram: "pair_device",
              discord: params.discordNativeName,
            },
          }
        : {}),
      description: "Pair device",
      acceptsArgs: true,
      requireAuth: false,
      handler: async ({ args }) => ({ text: `paired:${args ?? ""}` }),
    }),
  ).toEqual({ ok: true });
}

async function expectPairCommandReply(params: {
  cfg: OpenClawConfig;
  commandName: string;
  interaction: MockCommandInteraction;
  expectedRegisteredName?: string;
}) {
  const command = await createPluginCommand({
    cfg: params.cfg,
    name: params.commandName,
  });
  const dispatchSpy = runtimeModuleMocks.dispatchReplyWithDispatcher;
  const executeSpy = runtimeModuleMocks.executePluginCommand.mockResolvedValue({
    text: "paired:now",
  });
  await (command as { run: (interaction: unknown) => Promise<void> }).run(
    Object.assign(params.interaction, {
      options: {
        getString: () => "now",
        getBoolean: () => null,
        getFocused: () => "",
      },
    }) as unknown,
  );

  expect(dispatchSpy).not.toHaveBeenCalled();
  expect(executeSpy).toHaveBeenCalledWith(
    expect.objectContaining({
      command: expect.objectContaining({ name: params.expectedRegisteredName ?? "pair" }),
      args: "now",
    }),
  );
  expect(params.interaction.followUp).toHaveBeenCalledWith(
    expect.objectContaining({ content: "paired:now" }),
  );
  expect(params.interaction.reply).not.toHaveBeenCalled();
}

async function createStatusCommand(cfg: OpenClawConfig) {
  return await createNativeCommand(cfg, {
    name: "status",
    description: "Status",
    acceptsArgs: false,
  });
}

function createDispatchSpy() {
  return runtimeModuleMocks.dispatchReplyWithDispatcher.mockResolvedValue({
    counts: {
      final: 1,
      block: 0,
      tool: 0,
    },
  } as never);
}

async function expectBoundStatusCommandDirectReply(params: {
  cfg: OpenClawConfig;
  interaction: MockCommandInteraction;
  expectedPattern: RegExp;
}) {
  runtimeModuleMocks.matchPluginCommand.mockReturnValue(null);
  const dispatchSpy = runtimeModuleMocks.dispatchReplyWithDispatcher;
  const statusSpy = runtimeModuleMocks.resolveDirectStatusReplyForSession;
  const command = await createStatusCommand(params.cfg);

  await (command as { run: (interaction: unknown) => Promise<void> }).run(
    params.interaction as unknown,
  );

  expect(dispatchSpy).not.toHaveBeenCalled();
  expect(statusSpy).toHaveBeenCalledTimes(1);
  const statusCall = statusSpy.mock.calls[0]?.[0] as { sessionKey?: string };
  expect(statusCall.sessionKey).toMatch(params.expectedPattern);
}

describe("Discord native plugin command dispatch", () => {
  beforeAll(async () => {
    ({ createDiscordNativeCommand, __testing: discordNativeCommandTesting } =
      await import("./native-command.js"));
  });

  afterAll(() => {
    clearPluginCommands();
    setActivePluginRegistry(createTestRegistry());
    discordNativeCommandTesting.setMatchPluginCommand(matchPluginCommand);
    discordNativeCommandTesting.setExecutePluginCommand(executePluginCommand);
    discordNativeCommandTesting.setDispatchReplyWithDispatcher(dispatchReplyWithDispatcher);
    discordNativeCommandTesting.setResolveDirectStatusReplyForSession(
      resolveDirectStatusReplyForSession,
    );
    discordNativeCommandTesting.setResolveDiscordNativeInteractionRouteState(
      resolveDiscordNativeInteractionRouteState,
    );
  });

  beforeEach(() => {
    vi.clearAllMocks();
    clearPluginCommands();
    setActivePluginRegistry(createTestRegistry());
    runtimeModuleMocks.matchPluginCommand.mockReset();
    runtimeModuleMocks.matchPluginCommand.mockImplementation(matchPluginCommand);
    runtimeModuleMocks.executePluginCommand.mockReset();
    runtimeModuleMocks.executePluginCommand.mockImplementation(executePluginCommand);
    runtimeModuleMocks.dispatchReplyWithDispatcher.mockReset();
    runtimeModuleMocks.dispatchReplyWithDispatcher.mockResolvedValue({
      counts: {
        final: 1,
        block: 0,
        tool: 0,
      },
    } as never);
    runtimeModuleMocks.resolveDirectStatusReplyForSession.mockReset();
    runtimeModuleMocks.resolveDirectStatusReplyForSession.mockResolvedValue({
      text: "status reply",
    });
    discordNativeCommandTesting.setMatchPluginCommand(
      runtimeModuleMocks.matchPluginCommand as typeof import("openclaw/plugin-sdk/plugin-runtime").matchPluginCommand,
    );
    discordNativeCommandTesting.setExecutePluginCommand(
      runtimeModuleMocks.executePluginCommand as typeof import("openclaw/plugin-sdk/plugin-runtime").executePluginCommand,
    );
    discordNativeCommandTesting.setDispatchReplyWithDispatcher(
      runtimeModuleMocks.dispatchReplyWithDispatcher as typeof dispatchReplyWithDispatcher,
    );
    discordNativeCommandTesting.setResolveDirectStatusReplyForSession(
      runtimeModuleMocks.resolveDirectStatusReplyForSession as typeof resolveDirectStatusReplyForSession,
    );
    discordNativeCommandTesting.setResolveDiscordNativeInteractionRouteState(async (params) =>
      createUnboundRouteState({
        sessionKey: params.isDirectMessage
          ? `agent:main:discord:dm:${params.directUserId ?? "owner"}`
          : `agent:main:discord:channel:${params.conversationId}`,
        accountId: params.accountId,
      }),
    );
  });

  it("executes plugin commands from the real registry through the native Discord command path", async () => {
    const cfg = createConfig();
    const interaction = createInteraction();

    registerPairPlugin();
    await expectPairCommandReply({
      cfg,
      commandName: "pair",
      interaction,
    });
  });

  it("round-trips Discord native aliases through the real plugin registry", async () => {
    const cfg = createConfig();
    const interaction = createInteraction();

    registerPairPlugin({ discordNativeName: "pairdiscord" });
    await expectPairCommandReply({
      cfg,
      commandName: "pairdiscord",
      interaction,
    });
  });

  it("blocks unauthorized Discord senders before requireAuth:false plugin commands execute", async () => {
    const cfg = {
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
    const commandSpec: NativeCommandSpec = {
      name: "pair",
      description: "Pair",
      acceptsArgs: true,
    };
    const interaction = createInteraction({
      channelType: ChannelType.GuildText,
      channelId: "234567890123456789",
      guildId: "345678901234567890",
      guildName: "Test Guild",
    });
    interaction.user.id = "999999999999999999";
    interaction.options.getString.mockReturnValue("now");

    expect(
      registerPluginCommand("demo-plugin", {
        name: "pair",
        description: "Pair device",
        acceptsArgs: true,
        requireAuth: false,
        handler: async ({ args }) => ({ text: `open:${args ?? ""}` }),
      }),
    ).toEqual({ ok: true });
    const command = await createNativeCommand(cfg, commandSpec);

    const executeSpy = runtimeModuleMocks.executePluginCommand;
    const dispatchSpy = runtimeModuleMocks.dispatchReplyWithDispatcher.mockResolvedValue(
      {} as never,
    );

    await (command as { run: (interaction: unknown) => Promise<void> }).run(interaction as unknown);

    expect(executeSpy).not.toHaveBeenCalled();
    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(interaction.followUp).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "You are not authorized to use this command.",
        ephemeral: true,
      }),
    );
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it("rejects group DM slash commands outside dm.groupChannels before dispatch", async () => {
    const cfg = {
      commands: {
        allowFrom: {
          discord: ["user:owner"],
        },
      },
      channels: {
        discord: {
          dm: {
            enabled: true,
            policy: "open",
            groupEnabled: true,
            groupChannels: ["allowed-group"],
          },
        },
      },
    } as OpenClawConfig;
    const interaction = createInteraction({
      channelType: ChannelType.GroupDM,
      channelId: "blocked-group",
    });
    const dispatchSpy = createDispatchSpy();
    const command = await createStatusCommand(cfg);

    await (command as { run: (interaction: unknown) => Promise<void> }).run(interaction as unknown);

    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(interaction.followUp).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "This group DM is not allowed.",
      }),
    );
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it("executes matched plugin commands directly without invoking the agent dispatcher", async () => {
    const cfg = createConfig();
    const commandSpec: NativeCommandSpec = {
      name: "cron_jobs",
      description: "List cron jobs",
      acceptsArgs: false,
    };
    const interaction = createInteraction();
    const pluginMatch = {
      command: {
        name: "cron_jobs",
        description: "List cron jobs",
        pluginId: "cron-jobs",
        acceptsArgs: false,
        handler: vi.fn().mockResolvedValue({ text: "jobs" }),
      },
      args: undefined,
    };

    runtimeModuleMocks.matchPluginCommand.mockReturnValue(pluginMatch as never);
    const executeSpy = runtimeModuleMocks.executePluginCommand.mockResolvedValue({
      text: "direct plugin output",
    });
    const dispatchSpy = runtimeModuleMocks.dispatchReplyWithDispatcher.mockResolvedValue(
      {} as never,
    );
    const command = await createNativeCommand(cfg, commandSpec);

    await (command as { run: (interaction: unknown) => Promise<void> }).run(interaction as unknown);

    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(interaction.followUp).toHaveBeenCalledWith(
      expect.objectContaining({ content: "direct plugin output" }),
    );
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it("returns an explicit warning instead of success when dispatch produces zero visible replies", async () => {
    const cfg = createConfig();
    const interaction = createInteraction();
    runtimeModuleMocks.matchPluginCommand.mockReturnValue(null);
    runtimeModuleMocks.dispatchReplyWithDispatcher.mockResolvedValue({
      counts: { final: 0, block: 0, tool: 0 },
      queuedFinal: false,
    } as never);
    const command = await createNativeCommand(cfg, {
      name: "new",
      description: "Start a new session.",
      acceptsArgs: true,
    });

    await (command as { run: (interaction: unknown) => Promise<void> }).run(interaction as unknown);

    expect(interaction.followUp).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "⚠️ Command produced no visible reply.",
        ephemeral: true,
      }),
    );
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it("does not warn when dispatch reports a queued final without visible counts", async () => {
    const cfg = createConfig();
    const interaction = createInteraction();
    runtimeModuleMocks.matchPluginCommand.mockReturnValue(null);
    runtimeModuleMocks.dispatchReplyWithDispatcher.mockResolvedValue({
      counts: { final: 0, block: 0, tool: 0 },
      queuedFinal: true,
    } as never);
    const command = await createNativeCommand(cfg, {
      name: "new",
      description: "Start a new session.",
      acceptsArgs: true,
    });

    await (command as { run: (interaction: unknown) => Promise<void> }).run(interaction as unknown);

    expect(interaction.followUp).not.toHaveBeenCalledWith(
      expect.objectContaining({ content: "⚠️ Command produced no visible reply." }),
    );
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it("returns an explicit warning when a direct plugin command has no visible reply", async () => {
    const cfg = createConfig();
    const commandSpec: NativeCommandSpec = {
      name: "cron_jobs",
      description: "List cron jobs",
      acceptsArgs: false,
    };
    const interaction = createInteraction();
    const pluginMatch = {
      command: {
        name: "cron_jobs",
        description: "List cron jobs",
        pluginId: "cron-jobs",
        acceptsArgs: false,
        handler: vi.fn().mockResolvedValue({ text: "" }),
      },
      args: undefined,
    };

    runtimeModuleMocks.matchPluginCommand.mockReturnValue(pluginMatch as never);
    runtimeModuleMocks.executePluginCommand.mockResolvedValue({});
    const dispatchSpy = runtimeModuleMocks.dispatchReplyWithDispatcher.mockResolvedValue(
      {} as never,
    );
    const command = await createNativeCommand(cfg, commandSpec);

    await (command as { run: (interaction: unknown) => Promise<void> }).run(interaction as unknown);

    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(interaction.followUp).toHaveBeenCalledWith(
      expect.objectContaining({ content: "⚠️ Command produced no visible reply." }),
    );
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it("forwards Discord thread metadata into direct plugin command execution", async () => {
    const cfg = {
      commands: {
        useAccessGroups: false,
      },
      channels: {
        discord: {
          groupPolicy: "allowlist",
          guilds: {
            "345678901234567890": {
              channels: {
                "thread-123": {
                  enabled: true,
                  requireMention: false,
                  users: ["user:owner"],
                },
                "parent-456": {
                  enabled: true,
                  requireMention: false,
                  users: ["user:owner"],
                },
              },
            },
          },
        },
      },
    } as OpenClawConfig;
    const commandSpec: NativeCommandSpec = {
      name: "cron_jobs",
      description: "List cron jobs",
      acceptsArgs: false,
    };
    const interaction = createInteraction({
      channelType: ChannelType.PublicThread,
      channelId: "thread-123",
      threadParentId: "parent-456",
      guildId: "345678901234567890",
      guildName: "Test Guild",
    });
    const pluginMatch = {
      command: {
        name: "cron_jobs",
        description: "List cron jobs",
        pluginId: "cron-jobs",
        acceptsArgs: false,
        handler: vi.fn().mockResolvedValue({ text: "jobs" }),
      },
      args: undefined,
    };

    runtimeModuleMocks.matchPluginCommand.mockReturnValue(pluginMatch as never);
    const executeSpy = runtimeModuleMocks.executePluginCommand.mockResolvedValue({
      text: "direct plugin output",
    });
    const command = await createNativeCommand(cfg, commandSpec);

    await (command as { run: (interaction: unknown) => Promise<void> }).run(interaction as unknown);

    expect(executeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "discord",
        from: "discord:channel:thread-123",
        to: "slash:owner",
        sessionKey: "agent:main:discord:channel:thread-123",
        messageThreadId: "thread-123",
        threadParentId: "parent-456",
      }),
    );
  });

  it("preserves fetched thread parent metadata when interaction parentId getter throws", async () => {
    const cfg = {
      commands: {
        useAccessGroups: false,
      },
      channels: {
        discord: {
          groupPolicy: "allowlist",
          guilds: {
            "345678901234567890": {
              channels: {
                "partial-thread-123": {
                  enabled: true,
                  requireMention: false,
                  users: ["user:owner"],
                },
                "partial-parent-456": {
                  enabled: true,
                  requireMention: false,
                  users: ["user:owner"],
                },
              },
            },
          },
        },
      },
    } as OpenClawConfig;
    const commandSpec: NativeCommandSpec = {
      name: "cron_jobs",
      description: "List cron jobs",
      acceptsArgs: false,
    };
    const interaction = createInteraction({
      channelType: ChannelType.PublicThread,
      channelId: "partial-thread-123",
      guildId: "345678901234567890",
      guildName: "Test Guild",
    });
    defineThrowingDiscordChannelGetter(interaction.channel, "parentId");
    (interaction.client as { fetchChannel: ReturnType<typeof vi.fn> }).fetchChannel = vi.fn(
      async (channelId: string) => {
        if (channelId === "partial-thread-123") {
          return {
            id: "partial-thread-123",
            type: ChannelType.PublicThread,
            parentId: "partial-parent-456",
          };
        }
        if (channelId === "partial-parent-456") {
          return { id: "partial-parent-456", type: ChannelType.GuildText, name: "Parent" };
        }
        return null;
      },
    );
    const pluginMatch = {
      command: {
        name: "cron_jobs",
        description: "List cron jobs",
        pluginId: "cron-jobs",
        acceptsArgs: false,
        handler: vi.fn().mockResolvedValue({ text: "jobs" }),
      },
      args: undefined,
    };

    runtimeModuleMocks.matchPluginCommand.mockReturnValue(pluginMatch as never);
    const executeSpy = runtimeModuleMocks.executePluginCommand.mockResolvedValue({
      text: "direct plugin output",
    });
    const command = await createNativeCommand(cfg, commandSpec);

    await (command as { run: (interaction: unknown) => Promise<void> }).run(interaction as unknown);

    expect(executeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "discord",
        from: "discord:channel:partial-thread-123",
        messageThreadId: "partial-thread-123",
        threadParentId: "partial-parent-456",
      }),
    );
  });

  it("routes native slash commands through configured ACP Discord channel bindings", async () => {
    const { cfg, interaction } = createConfiguredAcpCase({
      channelType: ChannelType.GuildText,
      channelId: "1478836151241412759",
      peerKind: "channel",
      guildId: "1459246755253325866",
      guildName: "Ops",
    });
    discordNativeCommandTesting.setResolveDiscordNativeInteractionRouteState(async () =>
      createConfiguredRouteState({
        sessionKey: "agent:codex:acp:binding:discord:default:guild-channel",
        agentId: "codex",
      }),
    );

    await expectBoundStatusCommandDirectReply({
      cfg,
      interaction,
      expectedPattern: /^agent:codex:acp:binding:discord:default:/,
    });
  });

  it("falls back to the routed slash and channel session keys when no bound session exists", async () => {
    const guildId = "1459246755253325866";
    const channelId = "1478836151241412759";
    const cfg = {
      commands: {
        useAccessGroups: false,
      },
      bindings: [
        {
          agentId: "qwen",
          match: {
            channel: "discord",
            accountId: "default",
            peer: { kind: "channel", id: channelId },
            guildId,
          },
        },
      ],
      channels: {
        discord: {
          guilds: {
            [guildId]: {
              channels: {
                [channelId]: { enabled: true, requireMention: false },
              },
            },
          },
        },
      },
    } as OpenClawConfig;
    const interaction = createInteraction({
      channelType: ChannelType.GuildText,
      channelId,
      guildId,
      guildName: "Ops",
    });

    discordNativeCommandTesting.setResolveDiscordNativeInteractionRouteState(async () =>
      createUnboundRouteState({
        sessionKey: `agent:qwen:discord:channel:${channelId}`,
        agentId: "qwen",
      }),
    );
    runtimeModuleMocks.matchPluginCommand.mockReturnValue(null);
    const dispatchSpy = runtimeModuleMocks.dispatchReplyWithDispatcher;
    const statusSpy = runtimeModuleMocks.resolveDirectStatusReplyForSession;
    const command = await createStatusCommand(cfg);
    discordNativeCommandTesting.setResolveDiscordNativeInteractionRouteState(async () => ({
      route: {
        agentId: "qwen",
        channel: "discord",
        accountId: "default",
        sessionKey: "agent:qwen:discord:channel:1478836151241412759",
        mainSessionKey: "agent:qwen:main",
        lastRoutePolicy: "session",
        matchedBy: "binding.channel",
      },
      effectiveRoute: {
        agentId: "qwen",
        channel: "discord",
        accountId: "default",
        sessionKey: "agent:qwen:discord:channel:1478836151241412759",
        mainSessionKey: "agent:qwen:main",
        lastRoutePolicy: "session",
        matchedBy: "binding.channel",
      },
      boundSessionKey: undefined,
      configuredRoute: null,
      configuredBinding: null,
      bindingReadiness: null,
    }));

    await (command as { run: (interaction: unknown) => Promise<void> }).run(interaction as unknown);

    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(statusSpy).toHaveBeenCalledTimes(1);
    const statusCall = statusSpy.mock.calls[0]?.[0] as { sessionKey?: string };
    expect(statusCall.sessionKey).toBe("agent:qwen:discord:channel:1478836151241412759");
  });

  it("routes Discord DM native slash commands through configured ACP bindings", async () => {
    const { cfg, interaction } = createConfiguredAcpCase({
      channelType: ChannelType.DM,
      channelId: "dm-1",
      peerKind: "direct",
    });
    discordNativeCommandTesting.setResolveDiscordNativeInteractionRouteState(async () =>
      createConfiguredRouteState({
        sessionKey: "agent:codex:acp:binding:discord:default:dm",
        agentId: "codex",
      }),
    );

    await expectBoundStatusCommandDirectReply({
      cfg,
      interaction,
      expectedPattern: /^agent:codex:acp:binding:discord:default:/,
    });
  });

  it("does not bypass configured ACP readiness for Discord /new", async () => {
    const { cfg, interaction } = createConfiguredAcpCase({
      channelType: ChannelType.GuildText,
      channelId: "1478844424791396446",
      peerKind: "channel",
      guildId: "1459246755253325866",
      guildName: "Ops",
    });
    const resolveRouteState = vi.fn(async () =>
      createConfiguredRouteState({
        sessionKey: "agent:claude:acp:binding:discord:default:9373ab192b2317f4",
        agentId: "claude",
      }),
    );
    discordNativeCommandTesting.setResolveDiscordNativeInteractionRouteState(resolveRouteState);
    runtimeModuleMocks.matchPluginCommand.mockReturnValue(null);
    const dispatchSpy = createDispatchSpy();
    const command = await createNativeCommand(cfg, {
      name: "new",
      description: "Start a new session.",
      acceptsArgs: true,
    });

    await (command as { run: (interaction: unknown) => Promise<void> }).run(interaction as unknown);

    expect(resolveRouteState).toHaveBeenCalledWith(
      expect.objectContaining({
        enforceConfiguredBindingReadiness: true,
      }),
    );
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
  });

  it("allows recovery commands through configured ACP bindings even when ensure fails", async () => {
    const { cfg, interaction } = createConfiguredAcpCase({
      channelType: ChannelType.GuildText,
      channelId: "1479098716916023408",
      peerKind: "channel",
      guildId: "1459246755253325866",
      guildName: "Ops",
      includeChannelAccess: false,
    });
    discordNativeCommandTesting.setResolveDiscordNativeInteractionRouteState(async () =>
      createConfiguredRouteState({
        sessionKey: "agent:codex:acp:binding:discord:default:recovery",
        agentId: "codex",
      }),
    );
    runtimeModuleMocks.matchPluginCommand.mockReturnValue(null);
    const dispatchSpy = createDispatchSpy();
    const command = await createNativeCommand(cfg, {
      name: "new",
      description: "Start a new session.",
      acceptsArgs: true,
    });

    await (command as { run: (interaction: unknown) => Promise<void> }).run(interaction as unknown);

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    const dispatchCall = dispatchSpy.mock.calls[0]?.[0] as {
      ctx?: { SessionKey?: string; CommandTargetSessionKey?: string };
    };
    expect(dispatchCall.ctx?.SessionKey).toMatch(/^agent:codex:acp:binding:discord:default:/);
    expect(dispatchCall.ctx?.CommandTargetSessionKey).toMatch(
      /^agent:codex:acp:binding:discord:default:/,
    );
    expect(interaction.reply).not.toHaveBeenCalledWith(
      expect.objectContaining({
        content: "Configured ACP binding is unavailable right now. Please try again.",
      }),
    );
  });
});
