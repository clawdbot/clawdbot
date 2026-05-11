import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
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

function mockCall(mock: { mock: { calls: unknown[][] } }, index: number): unknown[] {
  const call = mock.mock.calls[index];
  if (!call) {
    throw new Error(`expected mock call ${index}`);
  }
  return call;
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
    expectRegisteredCommand(registeredCommands, { command: "pair", description: "Pair device" });

    const handler = requireCommandHandler(commandHandlers, "pair");

    await handler(createPrivateCommandContext({ match: "now" }));

    expectLastDeliveredReplyText("paired:now");
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

    const handler = requireCommandHandler(commandHandlers, "pair");

    await handler(createPrivateCommandContext({ match: "now" }));

    const sendCall = mockCall(sendMessage, 0);
    expect(sendCall[0]).toBe(100);
    expect(sendCall[1]).toContain("Running pair now");
    expect(sendCall[2]).toBeUndefined();
    const editCall = mockCall(editMessageTelegram, 0);
    expect(editCall[0]).toBe(100);
    expect(editCall[1]).toBe(999);
    expect(editCall[2]).toBe("paired:now");
    expect((editCall[3] as { accountId?: string }).accountId).toBe("default");
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
    expectRegisteredCommand(registeredCommands, {
      command: "pair_device",
      description: "Pair device",
    });

    const handler = requireCommandHandler(commandHandlers, "pair_device");

    await handler(createPrivateCommandContext({ match: "now", messageId: 2 }));

    expectLastDeliveredReplyText("paired:now");
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
