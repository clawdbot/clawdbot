import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { listRegisteredPluginAgentPromptGuidance } from "./command-registry-state.js";
import {
  __testing,
  clearPluginCommands,
  executePluginCommand,
  getPluginCommandSpecs,
  listProviderPluginCommandSpecs,
  listPluginCommands,
  matchPluginCommand,
  registerPluginCommand,
} from "./commands.js";
import { createPluginRegistry, type PluginRecord } from "./registry.js";
import { setActivePluginRegistry } from "./runtime.js";
import type { PluginRuntime } from "./runtime/types.js";

type CommandsModule = typeof import("./commands.js");

const commandsModuleUrl = new URL("./commands.ts", import.meta.url).href;

async function importCommandsModule(cacheBust: string): Promise<CommandsModule> {
  return (await import(`${commandsModuleUrl}?t=${cacheBust}`)) as CommandsModule;
}

function createVoiceCommand(overrides: Partial<Parameters<typeof registerPluginCommand>[1]> = {}) {
  return {
    name: "voice",
    description: "Voice command",
    handler: async () => ({ text: "ok" }),
    ...overrides,
  };
}

function createBundledPluginRecord(id: string): PluginRecord {
  return {
    id,
    name: id,
    source: `bundled:${id}`,
    rootDir: `/bundled/${id}`,
    origin: "bundled",
    enabled: true,
    status: "loaded",
    toolNames: [],
    hookNames: [],
    channelIds: [],
    cliBackendIds: [],
    providerIds: [],
    speechProviderIds: [],
    realtimeTranscriptionProviderIds: [],
    realtimeVoiceProviderIds: [],
    mediaUnderstandingProviderIds: [],
    imageGenerationProviderIds: [],
    videoGenerationProviderIds: [],
    musicGenerationProviderIds: [],
    webFetchProviderIds: [],
    webSearchProviderIds: [],
    migrationProviderIds: [],
    memoryEmbeddingProviderIds: [],
    agentHarnessIds: [],
    gatewayMethods: [],
    cliCommands: [],
    services: [],
    gatewayDiscoveryServiceIds: [],
    commands: [],
    httpRoutes: 0,
    hookCount: 0,
    configSchema: false,
  } as PluginRecord;
}

function registerHostTrustedReservedCommandForTest(
  command: Parameters<typeof registerPluginCommand>[1],
) {
  const pluginRegistry = createPluginRegistry({
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    runtime: {} as PluginRuntime,
    activateGlobalSideEffects: true,
  });
  pluginRegistry.registerCommand(createBundledPluginRecord(command.name), command);
}

function registerVoiceCommandForTest(
  overrides: Partial<Parameters<typeof registerPluginCommand>[1]> = {},
) {
  return registerPluginCommand("demo-plugin", createVoiceCommand(overrides));
}

function resolveBindingConversationFromCommand(
  params: Parameters<typeof __testing.resolveBindingConversationFromCommand>[0],
) {
  return __testing.resolveBindingConversationFromCommand(params);
}

function expectCommandMatch(
  commandBody: string,
  params: { name: string; pluginId: string; args: string },
) {
  const match = requirePluginCommandMatch(commandBody);
  expect(match.command.name).toBe(params.name);
  expect(match.command.pluginId).toBe(params.pluginId);
  expect(match.args).toBe(params.args);
}

function requirePluginCommandMatch(commandBody: string) {
  const match = matchPluginCommand(commandBody);
  if (!match) {
    throw new Error(`expected plugin command match for ${commandBody}`);
  }
  return match;
}

function expectProviderCommandSpecs(
  provider: Parameters<typeof getPluginCommandSpecs>[0],
  expectedNames: readonly string[],
) {
  expect(getPluginCommandSpecs(provider)).toEqual(
    expectedNames.map((name) => ({
      name,
      description: "Demo command",
      acceptsArgs: false,
    })),
  );
}

function expectProviderCommandSpecCases(
  cases: ReadonlyArray<{
    provider: Parameters<typeof getPluginCommandSpecs>[0];
    expectedNames: readonly string[];
  }>,
) {
  cases.forEach(({ provider, expectedNames }) => {
    expectProviderCommandSpecs(provider, expectedNames);
  });
}

function expectUnsupportedBindingApiResult(result: { text?: string }) {
  expect(result.text).toBe(
    JSON.stringify({
      requested: {
        status: "error",
        message: "This command cannot bind the current conversation.",
      },
      current: null,
      detached: { removed: false },
    }),
  );
}

function expectBindingConversationCase(
  params: Parameters<typeof resolveBindingConversationFromCommand>[0],
  expected: ReturnType<typeof resolveBindingConversationFromCommand>,
) {
  expect(resolveBindingConversationFromCommand(params)).toEqual(expected);
}

beforeEach(() => {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "telegram",
        source: "test",
        plugin: {
          ...createChannelTestPluginBase({ id: "telegram", label: "Telegram" }),
          commands: {
            nativeCommandsAutoEnabled: true,
          },
          bindings: {
            selfParentConversationByDefault: true,
            resolveCommandConversation: ({
              threadId,
              originatingTo,
              commandTo,
              fallbackTo,
            }: {
              threadId?: string;
              originatingTo?: string;
              commandTo?: string;
              fallbackTo?: string;
            }) => {
              const rawTarget = [commandTo, originatingTo, fallbackTo].find(Boolean)?.trim();
              if (!rawTarget || rawTarget.startsWith("slash:")) {
                return null;
              }
              const normalized = rawTarget.replace(/^telegram:/i, "");
              const topicMatch = /^(.*?):topic:(\d+)$/i.exec(normalized);
              if (topicMatch?.[1]) {
                return {
                  conversationId: `${topicMatch[1]}:topic:${threadId ?? topicMatch[2]}`,
                  parentConversationId: topicMatch[1],
                };
              }
              return { conversationId: normalized };
            },
          },
        },
      },
      {
        pluginId: "discord",
        source: "test",
        plugin: {
          ...createChannelTestPluginBase({ id: "discord", label: "Discord" }),
          commands: {
            nativeCommandsAutoEnabled: true,
          },
          bindings: {
            resolveCommandConversation: ({
              threadId,
              threadParentId,
              originatingTo,
              commandTo,
              fallbackTo,
            }: {
              threadId?: string;
              threadParentId?: string;
              originatingTo?: string;
              commandTo?: string;
              fallbackTo?: string;
            }) => {
              const rawTarget = [originatingTo, commandTo, fallbackTo].find(Boolean)?.trim();
              if (!rawTarget || rawTarget.startsWith("slash:")) {
                return null;
              }
              const normalized = rawTarget.replace(/^discord:/i, "");
              if (/^\d+$/.test(normalized)) {
                return { conversationId: `user:${normalized}` };
              }
              if (threadId) {
                const baseConversationId =
                  originatingTo?.trim()?.replace(/^discord:/i, "") ||
                  commandTo?.trim()?.replace(/^discord:/i, "") ||
                  fallbackTo?.trim()?.replace(/^discord:/i, "");
                return {
                  conversationId: baseConversationId || threadId,
                  ...(threadParentId ? { parentConversationId: threadParentId } : {}),
                };
              }
              if (normalized.startsWith("channel:") || normalized.startsWith("user:")) {
                return { conversationId: normalized };
              }
              return null;
            },
          },
        },
      },
      {
        pluginId: "signal",
        source: "test",
        plugin: {
          ...createChannelTestPluginBase({ id: "signal", label: "Signal" }),
          commands: {
            nativeCommandsAutoEnabled: true,
          },
          bindings: {
            resolveCommandConversation: ({ senderId }: { senderId?: string }) => {
              const normalizedSenderId = senderId?.trim();
              return normalizedSenderId ? { conversationId: `dm:${normalizedSenderId}` } : null;
            },
          },
        },
      },
      {
        pluginId: "slack",
        source: "test",
        plugin: {
          ...createChannelTestPluginBase({
            id: "slack",
            label: "Slack",
            capabilities: { nativeCommands: true, chatTypes: ["direct", "group"] },
          }),
        },
      },
    ]),
  );
});

afterEach(() => {
  clearPluginCommands();
});

describe("registerPluginCommand", () => {
  it.each([
    {
      name: "rejects invalid command names",
      command: {
        // Runtime plugin payloads are untyped; guard at boundary.
        name: undefined as unknown as string,
        description: "Demo",
        handler: async () => ({ text: "ok" }),
      },
      expected: {
        ok: false,
        error: "Command name must be a string",
      },
    },
    {
      name: "rejects invalid command descriptions",
      command: {
        name: "demo",
        description: undefined as unknown as string,
        handler: async () => ({ text: "ok" }),
      },
      expected: {
        ok: false,
        error: "Command description must be a string",
      },
    },
    {
      name: "rejects invalid agent prompt guidance",
      command: {
        name: "demo",
        description: "Demo",
        agentPromptGuidance: "use /demo" as unknown as string[],
        handler: async () => ({ text: "ok" }),
      },
      expected: {
        ok: false,
        error: "Agent prompt guidance must be an array of strings",
      },
    },
    {
      name: "rejects invalid channel scopes",
      command: {
        name: "demo",
        description: "Demo",
        channels: ["telegram", "   "],
        handler: async () => ({ text: "ok" }),
      },
      expected: {
        ok: false,
        error: "Command channel 2 cannot be empty",
      },
    },
  ] as const)("$name", ({ command, expected }) => {
    expect(registerPluginCommand("demo-plugin", command)).toEqual(expected);
  });

  it("normalizes command metadata for downstream consumers", () => {
    const result = registerPluginCommand("demo-plugin", {
      name: "  demo_cmd  ",
      description: "  Demo command  ",
      agentPromptGuidance: ["  Use /demo_cmd for demo routing.  "],
      handler: async () => ({ text: "ok" }),
    });
    expect(result).toEqual({ ok: true });
    expect(listPluginCommands()).toEqual([
      {
        name: "demo_cmd",
        description: "Demo command",
        pluginId: "demo-plugin",
        acceptsArgs: false,
      },
    ]);
    expect(getPluginCommandSpecs()).toEqual([
      {
        name: "demo_cmd",
        description: "Demo command",
        acceptsArgs: false,
      },
    ]);
    expect(listRegisteredPluginAgentPromptGuidance()).toEqual(["Use /demo_cmd for demo routing."]);
  });

  it("matches underscore aliases for hyphenated command names", () => {
    registerPluginCommand("demo-plugin", {
      name: "active-memory",
      description: "Active Memory command",
      acceptsArgs: true,
      handler: async () => ({ text: "ok" }),
    });

    expectCommandMatch("/active_memory status", {
      name: "active-memory",
      pluginId: "demo-plugin",
      args: "status",
    });
  });

  it("supports provider-specific native command aliases", () => {
    const result = registerVoiceCommandForTest({
      nativeNames: {
        default: "talkvoice",
        discord: "discordvoice",
      },
      description: "Demo command",
    });

    expect(result).toEqual({ ok: true });
    expectProviderCommandSpecCases([
      { provider: undefined, expectedNames: ["talkvoice"] },
      { provider: "discord", expectedNames: ["discordvoice"] },
      { provider: "telegram", expectedNames: ["talkvoice"] },
      { provider: "slack", expectedNames: [] },
    ]);
  });

  it("scopes plugin command matches and native specs to configured channels", () => {
    const result = registerVoiceCommandForTest({
      channels: [" Telegram "],
      description: "Demo command",
    });

    expect(result).toEqual({ ok: true });
    const telegramMatch = matchPluginCommand("/voice", { channel: "telegram" });
    expect(telegramMatch?.command.name).toBe("voice");
    expect(telegramMatch?.command.channels).toEqual(["telegram"]);
    expect(matchPluginCommand("/voice", { channel: "discord" })).toBeNull();
    expect(matchPluginCommand("/voice")?.command.name).toBe("voice");
    expectProviderCommandSpecCases([
      { provider: undefined, expectedNames: ["voice"] },
      { provider: "telegram", expectedNames: ["voice"] },
      { provider: "discord", expectedNames: [] },
    ]);
    expect(listProviderPluginCommandSpecs("discord")).toStrictEqual([]);
  });

  it("allows Slack to resolve provider-native plugin specs without changing shared native gating", () => {
    const result = registerVoiceCommandForTest({
      nativeNames: {
        default: "talkvoice",
        discord: "discordvoice",
      },
      description: "Demo command",
    });

    expect(result).toEqual({ ok: true });
    expect(listProviderPluginCommandSpecs("slack")).toEqual([
      {
        name: "talkvoice",
        description: "Demo command",
        acceptsArgs: false,
      },
    ]);
  });

  it("requires config before using read-only manifest command defaults", () => {
    setActivePluginRegistry(createTestRegistry([]));
    registerVoiceCommandForTest({
      nativeNames: {
        discord: "discordvoice",
      },
      description: "Demo command",
    });
    const env = {
      ...process.env,
      OPENCLAW_BUNDLED_PLUGINS_DIR: path.resolve("extensions"),
      OPENCLAW_DISABLE_PERSISTED_PLUGIN_REGISTRY: "1",
    };

    expect(getPluginCommandSpecs("discord", { env })).toStrictEqual([]);
    expect(
      getPluginCommandSpecs("discord", {
        env,
        config: {
          plugins: {
            entries: {
              discord: {
                enabled: true,
              },
            },
          },
        },
      }),
    ).toEqual([
      {
        name: "discordvoice",
        description: "Demo command",
        acceptsArgs: false,
      },
    ]);
  });

  it("accepts native progress metadata on plugin commands", () => {
    const result = registerVoiceCommandForTest({
      nativeProgressMessages: { telegram: "Running voice command..." },
      description: "Demo command",
    });

    expect(result).toEqual({ ok: true });
    expect(matchPluginCommand("/voice")?.command.nativeProgressMessages).toEqual({
      telegram: "Running voice command...",
    });
  });

  it("exposes native description localizations on plugin command specs", () => {
    const result = registerVoiceCommandForTest({
      description: "Demo command",
      descriptionLocalizations: { ko: "데모 명령" },
    });

    expect(result).toEqual({ ok: true });
    expect(listProviderPluginCommandSpecs("discord")).toEqual([
      {
        name: "voice",
        description: "Demo command",
        descriptionLocalizations: { ko: "데모 명령" },
        acceptsArgs: false,
      },
    ]);
  });

  it("rejects empty native description localizations", () => {
    const result = registerVoiceCommandForTest({
      description: "Demo command",
      descriptionLocalizations: { ko: "   " },
    });

    expect(result).toEqual({
      ok: false,
      error: 'Description localization "ko" cannot be empty',
    });
  });

  it("rejects empty native progress metadata", () => {
    const result = registerVoiceCommandForTest({
      nativeProgressMessages: { telegram: "   " },
      description: "Demo command",
    });

    expect(result).toEqual({
      ok: false,
      error: 'Native progress message "telegram" cannot be empty',
    });
  });

  it("keeps reserved command bypass scoped to the primary command name", () => {
    const result = registerPluginCommand(
      "status",
      createVoiceCommand({
        name: "status",
        nativeNames: {
          telegram: "help",
        },
      }),
      { allowReservedCommandNames: true },
    );

    expect(result).toEqual({
      ok: false,
      error:
        'Native command alias "telegram" invalid: Command name "help" is reserved by a built-in command',
    });
  });

  it("reserves the bundled Codex command name", () => {
    const result = registerPluginCommand("demo-plugin", {
      name: "codex",
      description: "Fake Codex command",
      handler: async () => ({ text: "ok" }),
    });

    expect(result).toEqual({
      ok: false,
      error: 'Command name "codex" is reserved by a built-in command',
    });
  });

  it("rejects reserved ownership on non-reserved direct command registrations", () => {
    const result = registerPluginCommand(
      "demo-plugin",
      {
        name: "voice",
        description: "Voice command",
        ownership: "reserved",
        handler: async () => ({ text: "ok" }),
      },
      { allowReservedCommandNames: true },
    );

    expect(result).toEqual({
      ok: false,
      error: "Reserved command ownership is only available to bundled reserved commands",
    });
  });

  it("does not expose owner status to normal plugin commands", async () => {
    let observedOwnerStatus: boolean | undefined;
    registerPluginCommand("demo-plugin", {
      name: "voice",
      description: "Voice command",
      handler: async (ctx) => {
        observedOwnerStatus = ctx.senderIsOwner;
        return { text: "ok" };
      },
    });
    const match = requirePluginCommandMatch("/voice");

    await executePluginCommand({
      command: match.command,
      channel: "telegram",
      isAuthorizedSender: true,
      senderIsOwner: true,
      commandBody: "/voice",
      config: {},
    });

    expect(observedOwnerStatus).toBeUndefined();
  });

  it("allows command owners to run scoped plugin commands without gateway scopes", async () => {
    let observedOwnerStatus: boolean | undefined;
    const handler = vi.fn(async (ctx: { senderIsOwner?: boolean }) => {
      observedOwnerStatus = ctx.senderIsOwner;
      return { text: "ok" };
    });
    registerPluginCommand("demo-plugin", {
      name: "pairlike",
      description: "Scoped command",
      requiredScopes: ["operator.pairing"],
      handler,
    });
    const match = requirePluginCommandMatch("/pairlike");

    const result = await executePluginCommand({
      command: match.command,
      channel: "telegram",
      isAuthorizedSender: true,
      senderIsOwner: true,
      commandBody: "/pairlike",
      config: {},
    });

    expect(result).toEqual({ text: "ok" });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(observedOwnerStatus).toBe(true);
  });

  it("rejects command owners when explicit gateway scopes miss the required scope", async () => {
    const handler = vi.fn(async () => ({ text: "ok" }));
    registerPluginCommand("demo-plugin", {
      name: "pairlike",
      description: "Scoped command",
      requiredScopes: ["operator.pairing"],
      handler,
    });
    const match = requirePluginCommandMatch("/pairlike");

    const result = await executePluginCommand({
      command: match.command,
      channel: "webchat",
      isAuthorizedSender: true,
      senderIsOwner: true,
      commandBody: "/pairlike",
      gatewayClientScopes: ["operator.write"],
      config: {},
    });

    expect(result).toEqual({ text: "⚠️ This command requires gateway scope: operator.pairing." });
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects non-owner scoped plugin commands without gateway scopes", async () => {
    const handler = vi.fn(async () => ({ text: "ok" }));
    registerPluginCommand("demo-plugin", {
      name: "pairlike",
      description: "Scoped command",
      requiredScopes: ["operator.pairing"],
      handler,
    });
    const match = requirePluginCommandMatch("/pairlike");

    const result = await executePluginCommand({
      command: match.command,
      channel: "telegram",
      isAuthorizedSender: true,
      senderIsOwner: false,
      commandBody: "/pairlike",
      config: {},
    });

    expect(result).toEqual({ text: "⚠️ This command requires gateway scope: operator.pairing." });
    expect(handler).not.toHaveBeenCalled();
  });

  it("skips direct plugin command execution on unsupported channels", async () => {
    let handlerCalled = false;
    const handler = async () => {
      handlerCalled = true;
      return { text: "ok" };
    };

    const result = await executePluginCommand({
      command: {
        name: "voice",
        description: "Voice command",
        channels: ["qqbot"],
        handler,
        pluginId: "demo-plugin",
      },
      channel: "discord",
      isAuthorizedSender: true,
      commandBody: "/voice",
      config: {},
    });

    expect(result).toEqual({ continueAgent: true });
    expect(handlerCalled).toBe(false);
  });

  it("does not allow direct reserved command registrations to claim owner status", () => {
    const result = registerPluginCommand(
      "codex",
      {
        name: "codex",
        description: "Codex command",
        ownership: "reserved",
        handler: async () => ({ text: "ok" }),
      },
      { allowReservedCommandNames: true },
    );

    expect(result).toEqual({
      ok: false,
      error: "Reserved command ownership is only available to bundled reserved commands",
    });
    expect(matchPluginCommand("/codex")).toBeNull();
  });

  it("exposes owner status only to host-trusted reserved command owners", async () => {
    let observedOwnerStatus: boolean | undefined;
    registerHostTrustedReservedCommandForTest({
      name: "codex",
      description: "Codex command",
      ownership: "reserved",
      handler: async (ctx) => {
        observedOwnerStatus = ctx.senderIsOwner;
        return { text: "ok" };
      },
    });
    const match = requirePluginCommandMatch("/codex");

    await executePluginCommand({
      command: match.command,
      channel: "telegram",
      isAuthorizedSender: true,
      senderIsOwner: true,
      commandBody: "/codex",
      config: {},
    });

    expect(observedOwnerStatus).toBe(true);
  });

  it("rejects mismatched reserved command owners", () => {
    const pluginRegistry = createPluginRegistry({
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {},
      },
      runtime: {} as PluginRuntime,
      activateGlobalSideEffects: true,
    });
    pluginRegistry.registerCommand(createBundledPluginRecord("bundled-plugin"), {
      name: "codex",
      description: "Codex command",
      ownership: "reserved",
      handler: async () => ({ text: "ok" }),
    });

    const diagnostic = pluginRegistry.registry.diagnostics.find(
      (entry) => entry.pluginId === "bundled-plugin",
    );
    expect(diagnostic?.level).toBe("error");
    expect(diagnostic?.message).toBe(
      'command registration failed: Reserved command ownership requires plugin id "bundled-plugin" to match reserved command name "codex"',
    );
  });

  it("shares plugin commands across duplicate module instances", async () => {
    const first = await importCommandsModule(`first-${Date.now()}`);
    const second = await importCommandsModule(`second-${Date.now()}`);

    first.clearPluginCommands();

    expect(
      first.registerPluginCommand(
        "demo-plugin",
        createVoiceCommand({
          nativeNames: {
            telegram: "voice",
          },
        }),
      ),
    ).toEqual({ ok: true });

    expect(second.getPluginCommandSpecs("telegram")).toEqual([
      {
        name: "voice",
        description: "Voice command",
        acceptsArgs: false,
      },
    ]);
    const secondMatch = second.matchPluginCommand("/voice");
    expect(secondMatch?.command.name).toBe("voice");
    expect(secondMatch?.command.pluginId).toBe("demo-plugin");

    second.clearPluginCommands();
  });

  it.each(["/talkvoice now", "/discordvoice now"] as const)(
    "matches provider-specific native alias %s back to the canonical command",
    (commandBody) => {
      const result = registerVoiceCommandForTest({
        nativeNames: {
          default: "talkvoice",
          discord: "discordvoice",
        },
        description: "Demo command",
        acceptsArgs: true,
      });

      expect(result).toEqual({ ok: true });
      expectCommandMatch(commandBody, {
        name: "voice",
        pluginId: "demo-plugin",
        args: "now",
      });
    },
  );

  it.each([
    {
      name: "rejects provider aliases that collide with another registered command",
      setup: () =>
        registerPluginCommand(
          "demo-plugin",
          createVoiceCommand({
            nativeNames: {
              telegram: "pair_device",
            },
          }),
        ),
      candidate: {
        name: "pair",
        nativeNames: {
          telegram: "pair_device",
        },
        description: "Pair command",
        handler: async () => ({ text: "ok" }),
      },
      expected: {
        ok: false,
        error: 'Command "pair_device" already registered by plugin "demo-plugin"',
      },
    },
    {
      name: "rejects reserved provider aliases",
      candidate: createVoiceCommand({
        nativeNames: {
          telegram: "help",
        },
      }),
      expected: {
        ok: false,
        error:
          'Native command alias "telegram" invalid: Command name "help" is reserved by a built-in command',
      },
    },
  ] as const)("$name", ({ setup, candidate, expected }) => {
    setup?.();
    expect(registerPluginCommand("other-plugin", candidate)).toEqual(expected);
  });

  it.each([
    {
      name: "resolves Discord DM command bindings with the user target prefix intact",
      params: {
        channel: "discord",
        from: "discord:1177378744822943744",
        to: "slash:1177378744822943744",
        accountId: "default",
      },
      expected: {
        channel: "discord",
        accountId: "default",
        conversationId: "user:1177378744822943744",
      },
    },
    {
      name: "resolves Discord guild command bindings with the channel target prefix intact",
      params: {
        channel: "discord",
        from: "discord:channel:1480554272859881494",
        accountId: "default",
      },
      expected: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:1480554272859881494",
      },
    },
    {
      name: "resolves Discord thread command bindings with parent channel context intact",
      params: {
        channel: "discord",
        from: "discord:channel:1480554272859881494",
        accountId: "default",
        messageThreadId: "thread-42",
        threadParentId: "channel-parent-7",
      },
      expected: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:1480554272859881494",
        parentConversationId: "channel-parent-7",
        threadId: "thread-42",
      },
    },
    {
      name: "does not resolve binding conversations for unsupported command channels",
      params: {
        channel: "slack",
        from: "slack:U123",
        to: "C456",
        accountId: "default",
      },
      expected: null,
    },
    {
      name: "resolves sender-keyed command bindings when only senderId is available",
      params: {
        channel: "signal",
        senderId: "signal-user-42",
        accountId: "default",
      },
      expected: {
        channel: "signal",
        accountId: "default",
        conversationId: "dm:signal-user-42",
      },
    },
  ] as const)("$name", ({ params, expected }) => {
    expectBindingConversationCase(params, expected);
  });

  it("does not expose binding APIs to plugin commands on unsupported channels", async () => {
    const handler = async (ctx: {
      requestConversationBinding: (params: { summary: string }) => Promise<unknown>;
      getCurrentConversationBinding: () => Promise<unknown>;
      detachConversationBinding: () => Promise<unknown>;
    }) => {
      const requested = await ctx.requestConversationBinding({
        summary: "Bind this conversation.",
      });
      const current = await ctx.getCurrentConversationBinding();
      const detached = await ctx.detachConversationBinding();
      return {
        text: JSON.stringify({
          requested,
          current,
          detached,
        }),
      };
    };
    registerPluginCommand(
      "demo-plugin",
      {
        name: "bindcheck",
        description: "Demo command",
        acceptsArgs: false,
        handler,
      },
      { pluginRoot: "/plugins/demo-plugin" },
    );

    const result = await executePluginCommand({
      command: {
        name: "bindcheck",
        description: "Demo command",
        acceptsArgs: false,
        handler,
        pluginId: "demo-plugin",
        pluginRoot: "/plugins/demo-plugin",
      },
      channel: "slack",
      senderId: "U123",
      isAuthorizedSender: true,
      commandBody: "/bindcheck",
      config: {} as never,
      from: "slack:U123",
      to: "C456",
      accountId: "default",
    });

    expectUnsupportedBindingApiResult(result);
  });

  it("passes host session identity through to the plugin command context", async () => {
    let receivedCtx:
      | {
          sessionKey?: string;
          sessionId?: string;
        }
      | undefined;
    const handler = async (ctx: { sessionKey?: string; sessionId?: string }) => {
      receivedCtx = ctx;
      return { text: "ok" };
    };

    const result = await executePluginCommand({
      command: {
        name: "sessioncheck",
        description: "Demo command",
        acceptsArgs: false,
        handler,
        pluginId: "demo-plugin",
      },
      channel: "whatsapp",
      senderId: "U123",
      isAuthorizedSender: true,
      sessionKey: "agent:main:whatsapp:direct:123",
      sessionId: "session-123",
      commandBody: "/sessioncheck",
      config: {} as never,
    });

    expect(result).toEqual({ text: "ok" });
    expect(receivedCtx?.sessionKey).toBe("agent:main:whatsapp:direct:123");
    expect(receivedCtx?.sessionId).toBe("session-123");
  });

  it("normalizes undefined plugin command handler results to an empty reply payload", async () => {
    const handler = async () => undefined as never;

    const result = await executePluginCommand({
      command: {
        name: "silentcheck",
        description: "Demo command",
        acceptsArgs: false,
        handler,
        pluginId: "demo-plugin",
      },
      channel: "telegram",
      senderId: "U123",
      isAuthorizedSender: true,
      commandBody: "/silentcheck",
      config: {} as never,
    });

    expect(result).toStrictEqual({});
  });

  it("passes the effective default account to plugin command handlers when accountId is omitted", async () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "line",
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({
              id: "line",
              label: "LINE",
              config: {
                listAccountIds: () => ["default", "work"],
                defaultAccountId: () => "work",
                resolveAccount: (_cfg, accountId) => ({ accountId: accountId ?? "work" }),
              },
            }),
            bindings: {
              resolveCommandConversation: ({
                originatingTo,
                commandTo,
                fallbackTo,
              }: {
                originatingTo?: string;
                commandTo?: string;
                fallbackTo?: string;
              }) => {
                const rawTarget = [originatingTo, commandTo, fallbackTo].find(Boolean)?.trim();
                if (!rawTarget) {
                  return null;
                }
                return {
                  conversationId: rawTarget.replace(/^line:/i, "").replace(/^user:/i, ""),
                };
              },
            },
          },
        },
      ]),
    );

    let receivedCtx:
      | {
          accountId?: string;
        }
      | undefined;
    const handler = async (ctx: { accountId?: string }) => {
      receivedCtx = ctx;
      return { text: "ok" };
    };

    const result = await executePluginCommand({
      command: {
        name: "accountcheck",
        description: "Demo command",
        acceptsArgs: false,
        handler,
        pluginId: "demo-plugin",
      },
      channel: "line",
      senderId: "U123",
      isAuthorizedSender: true,
      commandBody: "/accountcheck",
      config: {} as never,
      from: "line:user:U1234567890abcdef1234567890abcdef",
    });

    expect(result).toEqual({ text: "ok" });
    expect(receivedCtx?.accountId).toBe("work");
  });
});
