import {
  createEmptyPluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/channel-test-helpers";
// Telegram tests cover bot native commands.registry plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { clearPluginCommands, registerPluginCommand } from "openclaw/plugin-sdk/plugin-runtime";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let registerTelegramNativeCommands: typeof import("./bot-native-commands.js").registerTelegramNativeCommands;
let createCommandBot: typeof import("./bot-native-commands.menu-test-support.js").createCommandBot;
let createNativeCommandTestParams: typeof import("./bot-native-commands.menu-test-support.js").createNativeCommandTestParams;
let createPrivateCommandContext: typeof import("./bot-native-commands.menu-test-support.js").createPrivateCommandContext;
let deliverReplies: typeof import("./bot-native-commands.menu-test-support.js").deliverReplies;
let resetNativeCommandMenuMocks: typeof import("./bot-native-commands.menu-test-support.js").resetNativeCommandMenuMocks;
let waitForRegisteredCommands: typeof import("./bot-native-commands.menu-test-support.js").waitForRegisteredCommands;

function createTelegramPluginRegistry() {
  const registry = createEmptyPluginRegistry();
  registry.channels.push({
    pluginId: "telegram",
    source: "test",
    plugin: {
      id: "telegram",
      meta: {
        id: "telegram",
        label: "Telegram",
        selectionLabel: "Telegram",
        docsPath: "/channels/telegram",
        blurb: "test stub.",
      },
      capabilities: { chatTypes: ["direct"] },
      config: {
        listAccountIds: () => ["default"],
        resolveAccount: () => ({}),
      },
      commands: {
        nativeCommandsAutoEnabled: true,
      },
    },
  } as never);
  registry.channelSetups.push({
    pluginId: "telegram",
    source: "test",
    enabled: true,
    plugin: {
      id: "telegram",
    },
  } as never);
  return registry;
}

let activePluginRegistry: ReturnType<typeof createTelegramPluginRegistry>;

function registerPairPluginCommand(params?: {
  nativeNames?: { telegram?: string; discord?: string };
}) {
  expect(
    registerPluginCommand("demo-plugin", {
      name: "pair",
      ...(params?.nativeNames ? { nativeNames: params.nativeNames } : {}),
      description: "Pair device",
      acceptsArgs: true,
      requireAuth: false,
      handler: async ({ args }) => ({ text: `paired:${args ?? ""}` }),
    }),
  ).toEqual({ ok: true });
}

async function registerPairMenu(params: {
  bot: ReturnType<typeof createCommandBot>["bot"];
  setMyCommands: ReturnType<typeof createCommandBot>["setMyCommands"];
  nativeNames?: { telegram?: string; discord?: string };
}) {
  registerPairPluginCommand(params.nativeNames ? { nativeNames: params.nativeNames } : {});

  registerTelegramNativeCommands({
    ...createNativeCommandTestParams({}),
    bot: params.bot,
  });

  return await waitForRegisteredCommands(params.setMyCommands);
}

function requireCommandHandler(
  commandHandlers: ReturnType<typeof createCommandBot>["commandHandlers"],
  commandName: string,
) {
  const handler = commandHandlers.get(commandName);
  if (!handler) {
    throw new Error(`expected ${commandName} command handler`);
  }
  return handler;
}

function expectRegisteredCommand(
  commands: Array<{ command: string; description: string }>,
  expected: { command: string; description: string },
): void {
  expect(
    commands.some(
      (command) =>
        command.command === expected.command && command.description === expected.description,
    ),
  ).toBe(true);
}

function expectLastDeliveredReplyText(text: string): void {
  const calls = deliverReplies.mock.calls as unknown[][];
  const payload = calls.at(-1)?.[0] as { replies?: Array<{ text?: string }> } | undefined;
  expect(payload?.replies?.map((reply) => reply.text)).toEqual([text]);
}

describe("registerTelegramNativeCommands real plugin registry", () => {
  beforeAll(async () => {
    resetPluginRuntimeStateForTest();
    activePluginRegistry = createTelegramPluginRegistry();
    setActivePluginRegistry(activePluginRegistry as never);
    ({ registerTelegramNativeCommands } = await import("./bot-native-commands.js"));
    ({
      createCommandBot,
      createNativeCommandTestParams,
      createPrivateCommandContext,
      deliverReplies,
      resetNativeCommandMenuMocks,
      waitForRegisteredCommands,
    } = await import("./bot-native-commands.menu-test-support.js"));
  });

  beforeEach(() => {
    resetPluginRuntimeStateForTest();
    activePluginRegistry = createTelegramPluginRegistry();
    setActivePluginRegistry(activePluginRegistry as never);
    clearPluginCommands();
    resetNativeCommandMenuMocks();
  });

  afterEach(() => {
    clearPluginCommands();
  });

  it("registers and executes plugin commands through the real plugin registry", async () => {
    const { bot, commandHandlers, sendMessage, setMyCommands } = createCommandBot();

    const registeredCommands = await registerPairMenu({ bot, setMyCommands });
    expectRegisteredCommand(registeredCommands, { command: "pair", description: "Pair device" });

    const handler = requireCommandHandler(commandHandlers, "pair");

    await handler(createPrivateCommandContext({ match: "now" }));

    expectLastDeliveredReplyText("paired:now");
    expect(sendMessage).not.toHaveBeenCalledWith(123, "Command not found.");
  });

  it("keeps a custom menu description while registering the same-name plugin handler", async () => {
    const { bot, commandHandlers, sendMessage, setMyCommands } = createCommandBot();
    registerPairPluginCommand();

    registerTelegramNativeCommands({
      ...createNativeCommandTestParams(
        {},
        {
          telegramCfg: {
            customCommands: [{ command: "pair", description: "Configured pair menu" }],
          },
        },
      ),
      bot,
    });

    const registeredCommands = await waitForRegisteredCommands(setMyCommands);
    expect(registeredCommands.filter((command) => command.command === "pair")).toEqual([
      { command: "pair", description: "Configured pair menu" },
    ]);

    await requireCommandHandler(
      commandHandlers,
      "pair",
    )(createPrivateCommandContext({ match: "now" }));

    expectLastDeliveredReplyText("paired:now");
    expect(sendMessage).not.toHaveBeenCalledWith(123, "Command not found.");
  });

  it("round-trips Telegram native aliases through the real plugin registry", async () => {
    const { bot, commandHandlers, sendMessage, setMyCommands } = createCommandBot();

    const registeredCommands = await registerPairMenu({
      bot,
      setMyCommands,
      nativeNames: {
        telegram: "pair_device",
        discord: "pairdiscord",
      },
    });
    expectRegisteredCommand(registeredCommands, {
      command: "pair_device",
      description: "Pair device",
    });

    const handler = requireCommandHandler(commandHandlers, "pair_device");

    await handler(createPrivateCommandContext({ match: "now", messageId: 2 }));

    expectLastDeliveredReplyText("paired:now");
    expect(sendMessage).not.toHaveBeenCalledWith(123, "Command not found.");
  });

  it.each([
    ["transformed-first", ["foo-bar", "foo_bar"]],
    ["exact-first", ["foo_bar", "foo-bar"]],
  ] as const)("executes the exact normalized winner with %s discovery", async (_label, names) => {
    const handlers = new Map<string, ReturnType<typeof vi.fn>>();
    for (const name of names) {
      const handler = vi.fn(async () => ({ text: name }));
      handlers.set(name, handler);
      expect(
        registerPluginCommand(`plugin-${name}`, {
          name,
          description: name,
          channels: ["telegram"],
          requireAuth: false,
          handler,
        }),
      ).toEqual({ ok: true });
    }
    const { bot, commandHandlers, setMyCommands } = createCommandBot();
    registerTelegramNativeCommands({ ...createNativeCommandTestParams({}), bot });
    const registered = await waitForRegisteredCommands(setMyCommands);
    expect(registered.filter((command) => command.command === "foo_bar")).toEqual([
      { command: "foo_bar", description: "foo_bar" },
    ]);

    await requireCommandHandler(commandHandlers, "foo_bar")(createPrivateCommandContext());

    expectLastDeliveredReplyText("foo_bar");
    expect(handlers.get("foo_bar")).toHaveBeenCalledOnce();
    expect(handlers.get("foo-bar")).not.toHaveBeenCalled();
  });

  it.each([
    ["telegram-first", ["foo-bar", "foo_bar"]],
    ["discord-first", ["foo_bar", "foo-bar"]],
  ] as const)("ignores a cross-channel exact shadow with %s discovery", async (_label, names) => {
    const telegramHandler = vi.fn(async () => ({ text: "telegram-owner" }));
    const discordHandler = vi.fn(async () => ({ text: "discord-owner" }));
    for (const name of names) {
      const telegram = name === "foo-bar";
      expect(
        registerPluginCommand(telegram ? "telegram-owner" : "discord-owner", {
          name,
          description: name,
          channels: [telegram ? "telegram" : "discord"],
          requireAuth: false,
          handler: telegram ? telegramHandler : discordHandler,
        }),
      ).toEqual({ ok: true });
    }
    const { bot, commandHandlers, setMyCommands } = createCommandBot();
    registerTelegramNativeCommands({ ...createNativeCommandTestParams({}), bot });
    await waitForRegisteredCommands(setMyCommands);

    await requireCommandHandler(commandHandlers, "foo_bar")(createPrivateCommandContext());

    expectLastDeliveredReplyText("telegram-owner");
    expect(telegramHandler).toHaveBeenCalledOnce();
    expect(discordHandler).not.toHaveBeenCalled();
  });

  it.each([
    { command: "pair", channels: undefined, retained: true },
    { command: "discord-only", channels: ["discord"], retained: false },
  ])(
    "registers only supported plugin handlers when native menu display is disabled: $command",
    ({ command, channels, retained }) => {
      const { bot, commandHandlers, setMyCommands } = createCommandBot();

      expect(
        registerPluginCommand("demo-plugin", {
          name: command,
          description: `${command} command`,
          channels,
          handler: async () => ({ text: "ok" }),
        }),
      ).toEqual({ ok: true });

      registerTelegramNativeCommands({
        ...createNativeCommandTestParams({}, { accountId: "default" }),
        bot,
        nativeEnabled: false,
      });

      expect(setMyCommands).not.toHaveBeenCalled();
      expect(commandHandlers.has(command)).toBe(retained);
    },
  );

  it("allows requireAuth:false plugin commands for unauthorized senders through the real registry", async () => {
    const { bot, commandHandlers, sendMessage, setMyCommands } = createCommandBot();

    registerPairPluginCommand();

    registerTelegramNativeCommands({
      ...createNativeCommandTestParams({
        commands: { allowFrom: { telegram: ["999"] } } as OpenClawConfig["commands"],
      }),
      bot,
      opts: { token: "token", allowFrom: ["999"] },
      nativeEnabled: false,
    });

    expect(setMyCommands).not.toHaveBeenCalled();

    const handler = requireCommandHandler(commandHandlers, "pair");

    await handler(
      createPrivateCommandContext({
        match: "now",
        messageId: 10,
        date: 123456,
        userId: 111,
        username: "nope",
      }),
    );

    expectLastDeliveredReplyText("paired:now");
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
