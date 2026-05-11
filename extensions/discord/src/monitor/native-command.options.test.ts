import { ApplicationCommandType, ChannelType, InteractionContextType } from "discord-api-types/v10";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { logVerboseMock } = vi.hoisted(() => ({
  logVerboseMock: vi.fn(),
}));
const { loggerWarnMock } = vi.hoisted(() => ({
  loggerWarnMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/runtime-env", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/runtime-env")>(
    "openclaw/plugin-sdk/runtime-env",
  );
  return {
    ...actual,
    createSubsystemLogger: () => ({
      child: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      warn: loggerWarnMock,
      debug: vi.fn(),
    }),
    logVerbose: logVerboseMock,
  };
});

vi.mock("openclaw/plugin-sdk/agent-runtime", () => ({
  resolveHumanDelayConfig: () => undefined,
}));

let listNativeCommandSpecs: typeof import("openclaw/plugin-sdk/command-auth").listNativeCommandSpecs;
let createDiscordNativeCommand: typeof import("./native-command.js").createDiscordNativeCommand;
let createNoopThreadBindingManager: typeof import("./thread-bindings.js").createNoopThreadBindingManager;

function createNativeCommand(
  name: string,
  opts?: {
    cfg?: OpenClawConfig;
    discordConfig?: NonNullable<OpenClawConfig["channels"]>["discord"];
  },
): ReturnType<typeof import("./native-command.js").createDiscordNativeCommand> {
  const command = listNativeCommandSpecs({ provider: "discord" }).find(
    (entry) => entry.name === name,
  );
  if (!command) {
    throw new Error(`missing native command: ${name}`);
  }
  const baseCfg: OpenClawConfig = opts?.cfg ?? {};
  const discordConfig: NonNullable<OpenClawConfig["channels"]>["discord"] =
    opts?.discordConfig ?? baseCfg.channels?.discord ?? {};
  const cfg =
    opts?.discordConfig === undefined
      ? baseCfg
      : {
          ...baseCfg,
          channels: {
            ...baseCfg.channels,
            discord: discordConfig,
          },
        };
  return createDiscordNativeCommand({
    command,
    cfg,
    discordConfig,
    accountId: "default",
    sessionPrefix: "discord:slash",
    ephemeralDefault: true,
    threadBindings: createNoopThreadBindingManager("default"),
  });
}

type CommandOption = NonNullable<
  ReturnType<typeof import("./native-command.js").createDiscordNativeCommand>["options"]
>[number];

function findOption(
  command: ReturnType<typeof import("./native-command.js").createDiscordNativeCommand>,
  name: string,
): CommandOption | undefined {
  return command.options?.find((entry) => entry.name === name);
}

function requireOption(
  command: ReturnType<typeof import("./native-command.js").createDiscordNativeCommand>,
  name: string,
): CommandOption {
  const option = findOption(command, name);
  if (!option) {
    throw new Error(`missing command option: ${name}`);
  }
  return option;
}

function readAutocomplete(option: CommandOption | undefined): unknown {
  if (!option || typeof option !== "object") {
    return undefined;
  }
  return (option as { autocomplete?: unknown }).autocomplete;
}

function readChoices(option: CommandOption | undefined): unknown[] | undefined {
  if (!option || typeof option !== "object") {
    return undefined;
  }
  const value = (option as { choices?: unknown }).choices;
  return Array.isArray(value) ? value : undefined;
}

function requireAutocomplete(option: CommandOption, errorMessage: string) {
  const autocomplete = readAutocomplete(option);
  if (typeof autocomplete !== "function") {
    throw new Error(errorMessage);
  }
  return autocomplete as (interaction: unknown) => Promise<unknown>;
}

async function runAutocomplete(
  autocomplete: (interaction: unknown) => Promise<unknown>,
  params: {
    userId: string;
    username?: string;
    globalName?: string;
    channelType: ChannelType;
    channelId: string;
    channelName: string;
    guildId?: string;
    focusedValue: string;
  },
) {
  const respond = vi.fn(async (_choices: unknown[]) => undefined);

  await autocomplete({
    user: {
      id: params.userId,
      username: params.username ?? params.userId,
      globalName: params.globalName ?? params.userId,
    },
    channel: {
      type: params.channelType,
      id: params.channelId,
      name: params.channelName,
    },
    guild: params.guildId ? { id: params.guildId } : undefined,
    rawData: {
      member: { roles: [] },
    },
    options: {
      getFocused: () => ({ value: params.focusedValue }),
    },
    respond,
    client: {},
  } as never);

  return respond;
}

describe("createDiscordNativeCommand option wiring", () => {
  beforeAll(async () => {
    ({ listNativeCommandSpecs } = await import("openclaw/plugin-sdk/command-auth"));
    ({ createDiscordNativeCommand } = await import("./native-command.js"));
    ({ createNoopThreadBindingManager } = await import("./thread-bindings.js"));
  });

  beforeEach(() => {
    logVerboseMock.mockReset();
    loggerWarnMock.mockReset();
  });

  it("uses autocomplete for /acp action so inline action values are accepted", async () => {
    const command = createNativeCommand("acp");
    const action = requireOption(command, "action");
    const autocomplete = requireAutocomplete(action, "acp action option did not wire autocomplete");

    expect(readChoices(action)).toBeUndefined();
    const respond = await runAutocomplete(autocomplete, {
      userId: "owner",
      username: "tester",
      globalName: "Tester",
      channelType: ChannelType.DM,
      channelId: "dm-1",
      channelName: "dm-1",
      focusedValue: "st",
    });
    expect(respond).toHaveBeenCalledWith([
      { name: "steer", value: "steer" },
      { name: "status", value: "status" },
      { name: "install", value: "install" },
    ]);
  });

  it("keeps static choices for non-acp string action arguments", () => {
    const command = createNativeCommand("config");
    const action = requireOption(command, "action");
    const choices = readChoices(action);

    expect(readAutocomplete(action)).toBeUndefined();
    expect(choices).toEqual([
      { name: "show", value: "show" },
      { name: "get", value: "get" },
      { name: "set", value: "set" },
      { name: "unset", value: "unset" },
    ]);
  });

  it("returns no autocomplete choices for unauthorized users", async () => {
    const command = createNativeCommand("think", {
      cfg: {
        commands: {
          allowFrom: {
            discord: ["user:allowed-user"],
          },
        },
      } as OpenClawConfig,
    });
    const level = requireOption(command, "level");
    const autocomplete = requireAutocomplete(level, "think level option did not wire autocomplete");
    const respond = await runAutocomplete(autocomplete, {
      userId: "blocked-user",
      username: "blocked",
      globalName: "Blocked",
      channelType: ChannelType.GuildText,
      channelId: "channel-1",
      channelName: "general",
      guildId: "guild-1",
      focusedValue: "",
    });

    expect(respond).toHaveBeenCalledWith([]);
  });

  it("returns no autocomplete choices outside the Discord allowlist when commands.useAccessGroups is false and commands.allowFrom is not configured", async () => {
    const command = createNativeCommand("think", {
      cfg: {
        commands: {
          useAccessGroups: false,
        },
        channels: {
          discord: {
            groupPolicy: "allowlist",
            guilds: {
              "other-guild": {
                channels: {
                  "other-channel": {
                    enabled: true,
                    requireMention: false,
                  },
                },
              },
            },
          },
        },
      } as OpenClawConfig,
    });
    const level = requireOption(command, "level");
    const autocomplete = requireAutocomplete(level, "think level option did not wire autocomplete");
    const respond = await runAutocomplete(autocomplete, {
      userId: "allowed-user",
      username: "allowed",
      globalName: "Allowed",
      channelType: ChannelType.GuildText,
      channelId: "channel-1",
      channelName: "general",
      guildId: "guild-1",
      focusedValue: "xh",
    });

    expect(respond).toHaveBeenCalledWith([]);
  });

  it("returns no autocomplete choices for group DMs outside dm.groupChannels", async () => {
    const discordConfig = {
      dm: {
        enabled: true,
        policy: "open",
        groupEnabled: true,
        groupChannels: ["allowed-group"],
      },
    } satisfies NonNullable<OpenClawConfig["channels"]>["discord"];
    const command = createNativeCommand("think", {
      cfg: {
        commands: {
          allowFrom: {
            discord: ["user:allowed-user"],
          },
        },
      } as OpenClawConfig,
      discordConfig,
    });
    const level = requireOption(command, "level");
    const autocomplete = requireAutocomplete(level, "think level option did not wire autocomplete");
    const respond = await runAutocomplete(autocomplete, {
      userId: "allowed-user",
      username: "allowed",
      globalName: "Allowed",
      channelType: ChannelType.GroupDM,
      channelId: "blocked-group",
      channelName: "Blocked Group",
      focusedValue: "xh",
    });

    expect(respond).toHaveBeenCalledWith([]);
  });

  it("truncates Discord command and option descriptions to Discord's limit", () => {
    const longDescription = "x".repeat(140);
    const cfg = {} as OpenClawConfig;
    const discordConfig = {} as NonNullable<OpenClawConfig["channels"]>["discord"];
    const command = createDiscordNativeCommand({
      command: {
        name: "longdesc",
        description: longDescription,
        acceptsArgs: true,
        args: [
          {
            name: "input",
            description: longDescription,
            type: "string",
            required: false,
          },
        ],
      },
      cfg,
      discordConfig,
      accountId: "default",
      sessionPrefix: "discord:slash",
      ephemeralDefault: true,
      threadBindings: createNoopThreadBindingManager("default"),
    });

    expect(command.description).toHaveLength(100);
    expect(command.description).toBe("x".repeat(100));
    expect(requireOption(command, "input").description).toHaveLength(100);
    expect(requireOption(command, "input").description).toBe("x".repeat(100));
  });

  it("serializes localized command descriptions", () => {
    const longDescription = "k".repeat(140);
    const command = createDiscordNativeCommand({
      command: {
        name: "localized",
        description: "Default description",
        descriptionLocalizations: {
          ko: "현지화된 설명",
          "en-GB": longDescription,
        },
        acceptsArgs: false,
      },
      cfg: {} as OpenClawConfig,
      discordConfig: {},
      accountId: "default",
      sessionPrefix: "discord:slash",
      ephemeralDefault: true,
      threadBindings: createNoopThreadBindingManager("default"),
    });

    expect(command.descriptionLocalizations).toEqual({
      ko: "현지화된 설명",
      "en-GB": "k".repeat(100),
    });
    expect(command.serialize()).toEqual({
      name: "localized",
      description: "Default description",
      description_localizations: {
        ko: "현지화된 설명",
        "en-GB": "k".repeat(100),
      },
      type: ApplicationCommandType.ChatInput,
      integration_types: [0, 1],
      contexts: [
        InteractionContextType.Guild,
        InteractionContextType.BotDM,
        InteractionContextType.PrivateChannel,
      ],
      default_member_permissions: null,
    });
  });
});
