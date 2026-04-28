import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { clearPluginCommands, registerPluginCommand } from "openclaw/plugin-sdk/plugin-runtime";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

let registerTelegramNativeCommands: typeof import("./bot-native-commands.js").registerTelegramNativeCommands;
let setActivePluginRegistry: typeof import("openclaw/plugin-sdk/plugin-test-runtime").setActivePluginRegistry;
let createCommandBot: typeof import("./bot-native-commands.menu-test-support.js").createCommandBot;
let createNativeCommandTestParams: typeof import("./bot-native-commands.menu-test-support.js").createNativeCommandTestParams;
let createPrivateCommandContext: typeof import("./bot-native-commands.menu-test-support.js").createPrivateCommandContext;
let deliverReplies: typeof import("./bot-native-commands.menu-test-support.js").deliverReplies;
let editMessageTelegram: typeof import("./bot-native-commands.menu-test-support.js").editMessageTelegram;
let resetNativeCommandMenuMocks: typeof import("./bot-native-commands.menu-test-support.js").resetNativeCommandMenuMocks;
let waitForRegisteredCommands: typeof import("./bot-native-commands.menu-test-support.js").waitForRegisteredCommands;

function createTelegramPluginRegistry() {
  return {
    plugins: [],
    tools: [],
    hooks: [],
    typedHooks: [],
    channels: [
      {
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
      },
    ],
    channelSetups: [
      {
        pluginId: "telegram",
        source: "test",
        enabled: true,
        plugin: {
          id: "telegram",
        },
      },
    ],
    providers: [],
    speechProviders: [],
    mediaUnderstandingProviders: [],
    imageGenerationProviders: [],
    videoGenerationProviders: [],
    webFetchProviders: [],
    webSearchProviders: [],
    migrationProviders: [],
    gatewayHandlers: {},
    httpRoutes: [],
    cliRegistrars: [],
    services: [],
    commands: [],
    conversationBindingResolvedHandlers: [],
    diagnostics: [],
  };
}

function registerPairPluginCommand(params?: {
  nativeNames?: { telegram?: string; discord?: string };
  nativeProgressMessages?: { telegram?: string; default?: string };
}) {
  expect(
    registerPluginCommand("demo-plugin", {
      name: "pair",
      ...(params?.nativeNames ? { nativeNames: params.nativeNames } : {}),
      ...(params?.nativeProgressMessages
        ? { nativeProgressMessages: params.nativeProgressMessages }
        : {}),
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
  nativeProgressMessages?: { telegram?: string; default?: string };
}) {
  registerPairPluginCommand({
    ...(params.nativeNames ? { nativeNames: params.nativeNames } : {}),
    ...(params.nativeProgressMessages
      ? { nativeProgressMessages: params.nativeProgressMessages }
      : {}),
  });

  registerTelegramNativeCommands({
    ...createNativeCommandTestParams({}),
    bot: params.bot,
  });

  return await waitForRegisteredCommands(params.setMyCommands);
}

describe("registerTelegramNativeCommands real plugin registry", () => {
  beforeAll(async () => {
    ({ setActivePluginRegistry } = await import("openclaw/plugin-sdk/plugin-test-runtime"));
    ({ registerTelegramNativeCommands } = await import("./bot-native-commands.js"));
    ({
      createCommandBot,
      createNativeCommandTestParams,
      createPrivateCommandContext,
      deliverReplies,
      editMessageTelegram,
      resetNativeCommandMenuMocks,
      waitForRegisteredCommands,
    } = await import("./bot-native-commands.menu-test-support.js"));
  });

  beforeEach(() => {
    setActivePluginRegistry(createTelegramPluginRegistry() as never);
    clearPluginCommands();
    resetNativeCommandMenuMocks();
  });

  afterEach(() => {
    clearPluginCommands();
  });

  it("registers and executes plugin commands through the real plugin registry", async () => {
    const { bot, commandHandlers, sendMessage, setMyCommands } = createCommandBot();

    const registeredCommands = await registerPairMenu({ bot, setMyCommands });
    expect(registeredCommands).toEqual(
      expect.arrayContaining([{ command: "pair", description: "Pair device" }]),
    );

    const handler = commandHandlers.get("pair");
    expect(handler).toBeTruthy();

    await handler?.(createPrivateCommandContext({ match: "now" }));

    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [expect.objectContaining({ text: "paired:now" })],
      }),
    );
    expect(sendMessage).not.toHaveBeenCalledWith(123, "Command not found.");
  });

  it("uses plugin command metadata to send and edit a Telegram progress placeholder", async () => {
    const { bot, commandHandlers, setMyCommands, sendMessage } = createCommandBot();

    await registerPairMenu({
      bot,
      setMyCommands,
      nativeProgressMessages: {
        telegram:
          "Running pair now...\n\nI'll edit this message with the final result when it's ready.",
      },
    });

    const handler = commandHandlers.get("pair");
    expect(handler).toBeTruthy();

    await handler?.(createPrivateCommandContext({ match: "now" }));

    expect(sendMessage).toHaveBeenCalledWith(
      100,
      expect.stringContaining("Running pair now"),
      undefined,
    );
    expect(editMessageTelegram).toHaveBeenCalledWith(
      100,
      999,
      "paired:now",
      expect.objectContaining({ accountId: "default" }),
    );
    expect(deliverReplies).not.toHaveBeenCalled();
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
    expect(registeredCommands).toEqual(
      expect.arrayContaining([{ command: "pair_device", description: "Pair device" }]),
    );

    const handler = commandHandlers.get("pair_device");
    expect(handler).toBeTruthy();

    await handler?.(createPrivateCommandContext({ match: "now", messageId: 2 }));

    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [expect.objectContaining({ text: "paired:now" })],
      }),
    );
    expect(sendMessage).not.toHaveBeenCalledWith(123, "Command not found.");
  });

  it("keeps real plugin command handlers available when native menu registration is disabled", () => {
    const { bot, commandHandlers, setMyCommands } = createCommandBot();

    registerPairPluginCommand();

    registerTelegramNativeCommands({
      ...createNativeCommandTestParams({}, { accountId: "default" }),
      bot,
      nativeEnabled: false,
    });

    expect(setMyCommands).not.toHaveBeenCalled();
    expect(commandHandlers.has("pair")).toBe(true);
  });

  it("allows requireAuth:false plugin commands for unauthorized senders through the real registry", async () => {
    const { bot, commandHandlers, sendMessage, setMyCommands } = createCommandBot();

    registerPairPluginCommand();

    registerTelegramNativeCommands({
      ...createNativeCommandTestParams({
        commands: { allowFrom: { telegram: ["999"] } } as OpenClawConfig["commands"],
      }),
      bot,
      allowFrom: ["999"],
      nativeEnabled: false,
    });

    expect(setMyCommands).not.toHaveBeenCalled();

    const handler = commandHandlers.get("pair");
    expect(handler).toBeTruthy();

    await handler?.(
      createPrivateCommandContext({
        match: "now",
        messageId: 10,
        date: 123456,
        userId: 111,
        username: "nope",
      }),
    );

    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [expect.objectContaining({ text: "paired:now" })],
      }),
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
