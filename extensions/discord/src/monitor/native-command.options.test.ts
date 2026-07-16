// Discord tests cover native command.options plugin behavior.
import { ApplicationCommandType, ChannelType, InteractionContextType } from "discord-api-types/v10";
import type { ChatCommandDefinition } from "openclaw/plugin-sdk/command-auth-native";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { nativeCommandRuntime } from "./native-command.runtime.js";

const { loadModelCatalogMock, logVerboseMock } = vi.hoisted(() => ({
  loadModelCatalogMock: vi.fn(),
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
  loadModelCatalog: loadModelCatalogMock,
  resolveHumanDelayConfig: () => undefined,
}));

let listNativeCommandSpecs: typeof import("openclaw/plugin-sdk/command-auth-native").listNativeCommandSpecs;
let createDiscordNativeCommand: typeof import("./native-command.js").createDiscordNativeCommand;
let buildDiscordCommandOptions: typeof import("./native-command.options.js").buildDiscordCommandOptions;
let resolveDiscordNativeAutocompleteAuthorized: typeof import("./native-command-auth.js").resolveDiscordNativeAutocompleteAuthorized;
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

function createAllowedGuildAutocompleteConfig(
  commands: NonNullable<OpenClawConfig["commands"]>,
): OpenClawConfig {
  return {
    commands,
    channels: {
      discord: {
        groupPolicy: "allowlist",
        guilds: {
          "guild-1": {
            channels: {
              "channel-1": {
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

async function resolveAutocompleteAuthorized(params: {
  cfg: OpenClawConfig;
  userId: string;
  username?: string;
  globalName?: string;
}) {
  return await resolveDiscordNativeAutocompleteAuthorized({
    cfg: params.cfg,
    discordConfig: params.cfg.channels?.discord ?? {},
    accountId: "default",
    interaction: {
      user: {
        id: params.userId,
        username: params.username ?? params.userId,
        globalName: params.globalName ?? params.userId,
      },
      channel: {
        type: ChannelType.GuildText,
        id: "channel-1",
        name: "general",
      },
      guild: { id: "guild-1" },
      rawData: {
        member: { roles: [] },
      },
      client: {},
    } as never,
  });
}

describe("createDiscordNativeCommand option wiring", () => {
  beforeAll(async () => {
    ({ listNativeCommandSpecs } = await import("openclaw/plugin-sdk/command-auth-native"));
    ({ createDiscordNativeCommand } = await import("./native-command.js"));
    ({ buildDiscordCommandOptions } = await import("./native-command.options.js"));
    ({ resolveDiscordNativeAutocompleteAuthorized } = await import("./native-command-auth.js"));
    ({ createNoopThreadBindingManager } = await import("./thread-bindings.js"));
  });

  beforeEach(() => {
    clearRuntimeConfigSnapshot();
    loadModelCatalogMock.mockReset().mockResolvedValue([]);
    logVerboseMock.mockReset();
    loggerWarnMock.mockReset();
  });

  afterEach(() => {
    clearRuntimeConfigSnapshot();
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

  it("uses the provider-startup catalog snapshot for /think autocomplete", async () => {
    const cfg = {
      channels: {
        discord: {
          dm: { enabled: true, policy: "open", allowFrom: ["*"] },
        },
      },
    } as OpenClawConfig;
    const command = createNativeCommand("think", { cfg });
    const level = requireOption(command, "level");
    const autocomplete = requireAutocomplete(level, "think level option did not wire autocomplete");

    await runAutocomplete(autocomplete, {
      userId: "owner",
      channelType: ChannelType.DM,
      channelId: "dm-1",
      channelName: "dm-1",
      focusedValue: "",
    });

    expect(loadModelCatalogMock).toHaveBeenCalledWith({ cacheOnly: true });
    expect(loadModelCatalogMock).toHaveBeenCalledWith({ config: cfg });
  });

  it("passes the effective agent runtime into dynamic /think choices", async () => {
    let agentRuntime = "codex";
    const command: ChatCommandDefinition = {
      key: "think",
      nativeName: "think",
      description: "Set thinking level",
      textAliases: ["/think"],
      acceptsArgs: true,
      args: [
        {
          name: "level",
          description: "Thinking level",
          type: "string",
          choices: ({ agentRuntime: selectedRuntime }) => [
            "max",
            ...(selectedRuntime === "openclaw" ? ["ultra"] : []),
          ],
        },
      ],
      argsParsing: "positional",
      argsMenu: "auto",
      scope: "both",
    };
    const options = buildDiscordCommandOptions({
      command,
      cfg: {},
      authorizeChoiceContext: async () => true,
      resolveChoiceContext: async () => ({
        provider: "openai",
        model: "gpt-5.6-luna",
        agentRuntime,
      }),
    });
    const level = options?.find((option) => option.name === "level");
    if (!level) {
      throw new Error("missing runtime-aware thinking option");
    }
    const autocomplete = requireAutocomplete(level, "think level option did not wire autocomplete");
    const params = {
      userId: "owner",
      channelType: ChannelType.DM,
      channelId: "dm-1",
      channelName: "dm-1",
      focusedValue: "",
    } as const;

    const codexRespond = await runAutocomplete(autocomplete, params);
    expect(codexRespond).toHaveBeenCalledWith([{ name: "max", value: "max" }]);

    agentRuntime = "openclaw";
    const openclawRespond = await runAutocomplete(autocomplete, params);
    expect(openclawRespond).toHaveBeenCalledWith([
      { name: "max", value: "max" },
      { name: "ultra", value: "ultra" },
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

  it("rejects autocomplete when commands.ownerAllowFrom rejects the sender", async () => {
    await expect(
      resolveAutocompleteAuthorized({
        cfg: createAllowedGuildAutocompleteConfig({
          ownerAllowFrom: ["user:owner-user"],
        }),
        userId: "blocked-user",
        username: "blocked",
        globalName: "Blocked",
      }),
    ).resolves.toBe(false);
  });

  it("authorizes autocomplete for commands.allowFrom users when commands.ownerAllowFrom is configured", async () => {
    await expect(
      resolveAutocompleteAuthorized({
        cfg: createAllowedGuildAutocompleteConfig({
          ownerAllowFrom: ["user:owner-user"],
          allowFrom: {
            discord: ["user:allowed-user"],
          },
        }),
        userId: "blocked-user",
        username: "blocked",
        globalName: "Blocked",
      }),
    ).resolves.toBe(false);
    await expect(
      resolveAutocompleteAuthorized({
        cfg: createAllowedGuildAutocompleteConfig({
          ownerAllowFrom: ["user:owner-user"],
          allowFrom: {
            discord: ["user:allowed-user"],
          },
        }),
        userId: "allowed-user",
        username: "allowed",
        globalName: "Allowed",
      }),
    ).resolves.toBe(true);
  });

  it("keeps plugin command autocomplete aligned with dispatch owner checks", async () => {
    const restoreMatchPluginCommand = nativeCommandRuntime.matchPluginCommand;
    nativeCommandRuntime.matchPluginCommand = (prompt) =>
      prompt === "/pair" ? ({ command: { name: "pair" }, args: "" } as never) : null;
    try {
      const command = createDiscordNativeCommand({
        command: {
          name: "pair",
          description: "Pair",
          acceptsArgs: true,
          args: [
            {
              name: "mode",
              description: "Pairing mode",
              type: "string",
              preferAutocomplete: true,
              choices: () => [
                { label: "fast", value: "fast" },
                { label: "secure", value: "secure" },
              ],
            },
          ],
        },
        cfg: createAllowedGuildAutocompleteConfig({
          ownerAllowFrom: ["user:owner-user"],
        }),
        discordConfig: {
          groupPolicy: "allowlist",
          guilds: {
            "guild-1": {
              channels: {
                "channel-1": {
                  enabled: true,
                  requireMention: false,
                },
              },
            },
          },
        },
        accountId: "default",
        sessionPrefix: "discord:slash",
        ephemeralDefault: true,
        threadBindings: createNoopThreadBindingManager("default"),
      });
      const mode = requireOption(command, "mode");
      const autocomplete = requireAutocomplete(
        mode,
        "plugin mode option did not wire autocomplete",
      );
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

      expect(respond).toHaveBeenCalledWith([
        { name: "fast", value: "fast" },
        { name: "secure", value: "secure" },
      ]);
    } finally {
      nativeCommandRuntime.matchPluginCommand = restoreMatchPluginCommand;
    }
  });

  it("refreshes autocomplete authorization and dynamic choices between invocations", async () => {
    const restoreMatchPluginCommand = nativeCommandRuntime.matchPluginCommand;
    nativeCommandRuntime.matchPluginCommand = (prompt) =>
      prompt === "/scope" ? ({ command: { name: "scope" }, args: "" } as never) : null;
    const sourceCfg = {
      session: { dmScope: "main" },
      channels: {
        discord: {
          dm: { enabled: true, policy: "disabled" },
        },
      },
    } as OpenClawConfig;
    const runtimeCfg = {
      session: { dmScope: "per-channel-peer" },
      channels: {
        discord: {
          dm: { enabled: true, policy: "open", allowFrom: ["*"] },
        },
      },
    } as OpenClawConfig;
    try {
      const command = createDiscordNativeCommand({
        command: {
          name: "scope",
          description: "Scope",
          acceptsArgs: true,
          args: [
            {
              name: "value",
              description: "Scope value",
              type: "string",
              preferAutocomplete: true,
              choices: ({ cfg }) => {
                const dmScope = cfg?.session?.dmScope ?? "missing";
                return [{ label: dmScope, value: dmScope }];
              },
            },
          ],
        },
        cfg: sourceCfg,
        discordConfig: sourceCfg.channels?.discord ?? {},
        accountId: "default",
        sessionPrefix: "discord:slash",
        ephemeralDefault: true,
        threadBindings: createNoopThreadBindingManager("default"),
      });
      const value = requireOption(command, "value");
      const autocomplete = requireAutocomplete(
        value,
        "scope value option did not wire autocomplete",
      );
      const autocompleteParams = {
        userId: "owner",
        channelType: ChannelType.DM,
        channelId: "dm-1",
        channelName: "dm-1",
        focusedValue: "",
      } as const;

      const blockedRespond = await runAutocomplete(autocomplete, autocompleteParams);
      expect(blockedRespond).toHaveBeenCalledWith([]);

      setRuntimeConfigSnapshot(runtimeCfg, runtimeCfg);
      const refreshedRespond = await runAutocomplete(autocomplete, autocompleteParams);
      expect(refreshedRespond).toHaveBeenCalledWith([
        { name: "per-channel-peer", value: "per-channel-peer" },
      ]);
    } finally {
      nativeCommandRuntime.matchPluginCommand = restoreMatchPluginCommand;
    }
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

  it("truncates Discord command and option descriptions on a UTF-16 boundary", () => {
    const longDescription = `${"x".repeat(99)}😀 trailing`;
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

    expect(command.description).toBe("x".repeat(99));
    expect(requireOption(command, "input").description).toBe("x".repeat(99));
  });

  it("serializes localized command descriptions on a UTF-16 boundary", () => {
    const longDescription = `${"k".repeat(99)}😀 trailing`;
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
      "en-GB": "k".repeat(99),
    });
    expect(command.serialize()).toEqual({
      name: "localized",
      description: "Default description",
      description_localizations: {
        ko: "현지화된 설명",
        "en-GB": "k".repeat(99),
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
