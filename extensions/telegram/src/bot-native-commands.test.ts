import {
  createEmptyPluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/channel-test-helpers";
// Telegram tests cover bot native commands plugin behavior.
import type { OpenClawConfig, TelegramAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import { listNativeCommandSpecsForConfig } from "openclaw/plugin-sdk/native-command-registry";
import { clearPluginCommands, registerPluginCommand } from "openclaw/plugin-sdk/plugin-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCommandBot,
  createNativeCommandTestParams,
  createPrivateCommandContext,
  listSkillCommandsForAgents,
  resetNativeCommandMenuMocks,
  waitForRegisteredCommands,
} from "./bot-native-commands.menu-test-support.js";
import { normalizeTelegramCommandName, TELEGRAM_COMMAND_NAME_PATTERN } from "./command-config.js";

type TelegramInlineKeyboardReplyMarkup = {
  inline_keyboard?: Array<Array<{ text?: string; callback_data?: string }>>;
};

const pluginCommandHandler = vi.fn(async (_ctx: Record<string, unknown>) => ({ text: "ok" }));

function registerTestPluginCommand(params: {
  name: string;
  description: string;
  acceptsArgs?: boolean;
  command?: Record<string, unknown>;
  result?: Record<string, unknown>;
}) {
  const result = params.result ?? { text: "ok" };
  expect(
    registerPluginCommand(`test-${params.name}`, {
      name: params.name,
      description: params.description,
      acceptsArgs: params.acceptsArgs,
      requireAuth: false,
      ...params.command,
      handler: async (ctx) => {
        await pluginCommandHandler(ctx as unknown as Record<string, unknown>);
        return result;
      },
    }),
  ).toEqual({ ok: true });
}

function collectCallbackData(replyMarkup: TelegramInlineKeyboardReplyMarkup | undefined): string[] {
  const callbackData: string[] = [];
  for (const row of replyMarkup?.inline_keyboard ?? []) {
    for (const button of row) {
      if (button.callback_data) {
        callbackData.push(button.callback_data);
      }
    }
  }
  return callbackData;
}

function firstCall(mock: { mock: { calls: Array<Array<unknown>> } }) {
  const call = mock.mock.calls.at(0);
  if (!call) {
    throw new Error("expected first mock call");
  }
  return call;
}

resetPluginRuntimeStateForTest();
setActivePluginRegistry(createEmptyPluginRegistry());
const { registerTelegramNativeCommands } = await import("./bot-native-commands.js");
registerTelegramNativeCommands(createNativeCommandTestParams({}));

describe("registerTelegramNativeCommands", () => {
  beforeEach(() => {
    resetNativeCommandMenuMocks();
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
    clearPluginCommands();
    pluginCommandHandler.mockClear();
  });

  it("scopes skill commands when account binding exists", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "main", default: true }, { id: "butler" }],
      },
      bindings: [
        {
          agentId: "butler",
          match: { channel: "telegram", accountId: "bot-a" },
        },
      ],
    };

    registerTelegramNativeCommands(createNativeCommandTestParams(cfg, { accountId: "bot-a" }));

    expect(listSkillCommandsForAgents).toHaveBeenCalledWith({
      cfg,
      agentIds: ["butler"],
    });
  });

  it("scopes skill commands to default agent without a matching binding (#15599)", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "main", default: true }, { id: "butler" }],
      },
    };

    registerTelegramNativeCommands(createNativeCommandTestParams(cfg, { accountId: "bot-a" }));

    expect(listSkillCommandsForAgents).toHaveBeenCalledWith({
      cfg,
      agentIds: ["main"],
    });
  });

  it("passes skill command description localizations into Telegram menu sync", async () => {
    const { bot, setMyCommands } = createCommandBot();
    listSkillCommandsForAgents.mockReturnValue([
      {
        name: "demo_skill",
        skillName: "demo-skill",
        description: "Demo skill",
        descriptionLocalizations: { ko: "데모 스킬" },
      },
    ]);

    registerTelegramNativeCommands(
      createNativeCommandTestParams(
        {
          commands: { native: true, nativeSkills: true },
          agents: { list: [{ id: "main", default: true }] },
        },
        { bot },
      ),
    );

    const registeredCommands = await waitForRegisteredCommands(setMyCommands);
    expect(registeredCommands.find((command) => command.command === "demo_skill")).toMatchObject({
      command: "demo_skill",
      description: "Demo skill",
      descriptionLocalizations: { ko: "데모 스킬" },
    });
  });

  it("builds one canonical no-pressure display order without changing descriptions", async () => {
    const { bot, setMyCommands } = createCommandBot();
    const skillCommands = [
      {
        name: "demo_skill",
        skillName: "demo-skill",
        description: "Demo skill unchanged",
      },
    ];
    const cfg: OpenClawConfig = {
      commands: { native: true, nativeSkills: true },
      agents: { list: [{ id: "main", default: true }] },
    };
    listSkillCommandsForAgents.mockReturnValue(skillCommands);
    registerTestPluginCommand({ name: "zeta", description: "Zeta unchanged" });
    registerTestPluginCommand({ name: "alpha", description: "Alpha unchanged" });

    registerTelegramNativeCommands(
      createNativeCommandTestParams(cfg, {
        bot,
        telegramCfg: {
          customCommands: [
            { command: "custom_two", description: "Custom two unchanged" },
            { command: "custom_one", description: "Custom one unchanged" },
          ],
        },
      }),
    );

    const registered = (await waitForRegisteredCommands(setMyCommands)).map(
      ({ command, description }) => ({ command, description }),
    );
    const native = listNativeCommandSpecsForConfig(cfg, {
      skillCommands,
      provider: "telegram",
      includeBundledChannelFallback: false,
    }).map((command) => ({
      command: normalizeTelegramCommandName(command.name),
      description: command.description,
      isAlias: command.isAlias,
    }));
    expect(registered).toEqual([
      { command: "custom_two", description: "Custom two unchanged" },
      { command: "custom_one", description: "Custom one unchanged" },
      ...native
        .filter((command) => !command.isAlias)
        .map(({ isAlias: _isAlias, ...command }) => command),
      { command: "alpha", description: "Alpha unchanged" },
      { command: "zeta", description: "Zeta unchanged" },
      ...native
        .filter((command) => command.isAlias)
        .map(({ isAlias: _isAlias, ...command }) => command),
    ]);
  });

  it("promotes /skill when direct skills are omitted by local menu pressure", async () => {
    const { bot, commandHandlers, setMyCommands } = createCommandBot();
    const runtimeLog = vi.fn();
    const cfg: OpenClawConfig = {
      commands: { native: true, nativeSkills: true },
      agents: { list: [{ id: "main", default: true }] },
    };
    const directSkills = Array.from({ length: 3 }, (_, index) => ({
      name: `demo_skill_${index}`,
      skillName: `demo-skill-${index}`,
      description: `Demo skill ${index}`,
    }));
    const customCommands = Array.from({ length: 100 }, (_, index) => ({
      command: `custom_${index}`,
      description: `Custom ${index}`,
    }));
    listSkillCommandsForAgents.mockReturnValue(directSkills);

    registerTelegramNativeCommands(
      createNativeCommandTestParams(cfg, {
        bot,
        runtime: { log: runtimeLog } as unknown as RuntimeEnv,
        telegramCfg: {
          customCommands,
        },
      }),
    );

    const registeredCommands = await waitForRegisteredCommands(setMyCommands);
    const registeredNames = registeredCommands.map(({ command }) => command);
    expect(registeredNames).toEqual([
      "skill",
      ...customCommands.slice(0, 99).map((command) => command.command),
    ]);
    expect(registeredCommands.some((entry) => entry.command.startsWith("demo_skill_"))).toBe(false);
    expect(directSkills.every((command) => commandHandlers.has(command.name))).toBe(true);
    expect(runtimeLog).toHaveBeenCalledWith(
      "Telegram menu pressure omitted per-skill commands; removing per-skill commands and keeping /skill.",
    );
    const expectedTotalCommands =
      customCommands.length +
      listNativeCommandSpecsForConfig(cfg, {
        provider: "telegram",
        includeBundledChannelFallback: false,
      }).length;
    expect(runtimeLog).toHaveBeenCalledWith(
      `Telegram limits bots to 100 commands. ${expectedTotalCommands} configured; registering first 100. Use channels.telegram.commands.native: false to disable, or reduce plugin/skill/custom commands.`,
    );
  });

  it("normalizes hyphenated native command names for Telegram registration", async () => {
    const setMyCommands = vi.fn().mockResolvedValue(undefined);
    const command = vi.fn();

    registerTelegramNativeCommands({
      ...createNativeCommandTestParams({}),
      bot: {
        api: {
          setMyCommands,
          sendMessage: vi.fn().mockResolvedValue(undefined),
        },
        command,
      } as unknown as Parameters<typeof registerTelegramNativeCommands>[0]["bot"],
    });

    const registeredCommands = await waitForRegisteredCommands(setMyCommands);
    const registeredCommandNames = registeredCommands.map((entry) => entry.command);
    expect(registeredCommandNames).toContain("export_session");
    expect(registeredCommandNames).not.toContain("export-session");

    const registeredHandlers = command.mock.calls.map(([name]) => name);
    expect(registeredHandlers).toContain("export_session");
    expect(registeredHandlers).not.toContain("export-session");
  });

  it("resolves plugin commands from one registry-bound runtime", () => {
    const cfg: OpenClawConfig = {
      commands: { native: true },
      channels: {
        telegram: {
          dmPolicy: "open",
        },
      },
    };

    registerTestPluginCommand({ name: "plug", description: "Plugin command" });
    const { bot, commandHandlers } = createCommandBot();
    registerTelegramNativeCommands(createNativeCommandTestParams(cfg, { bot }));
    expect(commandHandlers.has("plug")).toBe(true);
  });

  it("registers only Telegram-safe command names across native, custom, and plugin sources", async () => {
    const setMyCommands = vi.fn().mockResolvedValue(undefined);

    registerTestPluginCommand({ name: "plugin-status", description: "Plugin status" });

    registerTelegramNativeCommands({
      ...createNativeCommandTestParams({}),
      bot: {
        api: {
          setMyCommands,
          sendMessage: vi.fn().mockResolvedValue(undefined),
        },
        command: vi.fn(),
      } as unknown as Parameters<typeof registerTelegramNativeCommands>[0]["bot"],
      telegramCfg: {
        customCommands: [
          { command: "custom-backup", description: "Custom backup" },
          { command: "custom!bad", description: "Bad custom command" },
        ],
      } as TelegramAccountConfig,
    });

    const registeredCommands = await waitForRegisteredCommands(setMyCommands);

    expect(registeredCommands.length).toBeGreaterThan(0);
    const registeredCommandNames = registeredCommands.map((entry) => entry.command);
    for (const entry of registeredCommands) {
      expect(entry.command.includes("-")).toBe(false);
      expect(TELEGRAM_COMMAND_NAME_PATTERN.test(entry.command)).toBe(true);
    }

    expect(registeredCommandNames).toContain("export_session");
    expect(registeredCommandNames).toContain("custom_backup");
    expect(registeredCommandNames).toContain("plugin_status");
    expect(registeredCommandNames).not.toContain("plugin-status");
    expect(registeredCommandNames).not.toContain("custom-bad");
  });

  it("prefixes native command menu callback data so callback handlers can preserve native routing", async () => {
    const { bot, commandHandlers, sendMessage } = createCommandBot();
    const cfg = {
      agents: {
        defaults: {
          model: "openai-codex/gpt-5.5",
          models: {
            "openai-codex/gpt-5.5": {
              params: { fastMode: "auto", fastAutoOnSeconds: 30 },
            },
          },
        },
      },
    } as OpenClawConfig;

    registerTelegramNativeCommands({
      ...createNativeCommandTestParams(cfg, { bot, allowFrom: [200] }),
    });

    const handler = commandHandlers.get("fast");
    if (!handler) {
      throw new Error("expected fast command handler to be registered");
    }
    await handler(createPrivateCommandContext());

    const replyMarkup = (firstCall(sendMessage)[2] as { reply_markup?: unknown } | undefined)
      ?.reply_markup as TelegramInlineKeyboardReplyMarkup | undefined;
    expect(firstCall(sendMessage)[1]).toContain(
      "Current fast mode: auto (30 sec) (default: model).\nOptions: on, off, auto (30 sec), default, status.",
    );
    const callbackData = collectCallbackData(replyMarkup);
    const labels = (replyMarkup?.inline_keyboard ?? []).flatMap((row) =>
      row.map((button) => button.text),
    );

    expect(callbackData).toEqual([
      "tgcmd:/fast on",
      "tgcmd:/fast off",
      "tgcmd:/fast auto",
      "tgcmd:/fast default",
      "tgcmd:/fast status",
    ]);
    expect(labels).toEqual(["on", "off", "auto (30 sec)", "default", "status"]);
  });
});
