// Covers interactive plugin registry entries and lifecycle behavior.
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import * as conversationBinding from "./conversation-binding.js";
import type {
  DiscordInteractiveHandlerContext,
  SlackInteractiveHandlerContext,
  TelegramInteractiveHandlerContext,
} from "./interactive-contract.test-helpers.js";
import { registerRegistryPluginInteractiveHandler } from "./interactive-registry.js";
import {
  clearPluginInteractiveHandlers,
  createChannelInteractiveDispatcher,
  registerPluginInteractiveHandler,
} from "./interactive.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import {
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
  withPluginRegistrationContext,
} from "./runtime.js";

let requestPluginConversationBindingMock: MockInstance<
  typeof conversationBinding.requestPluginConversationBinding
>;
let detachPluginConversationBindingMock: MockInstance<
  typeof conversationBinding.detachPluginConversationBinding
>;
let getCurrentPluginConversationBindingMock: MockInstance<
  typeof conversationBinding.getCurrentPluginConversationBinding
>;

const telegramInteractiveDispatcher = createChannelInteractiveDispatcher<
  "telegram",
  "callback",
  TelegramInteractiveHandlerContext,
  { handled?: boolean } | void,
  "callbackMessage"
>({ channel: "telegram", interactiveKey: "callback", dispatchInteractiveKey: "callbackMessage" });
const discordInteractiveDispatcher = createChannelInteractiveDispatcher<
  "discord",
  "interaction",
  DiscordInteractiveHandlerContext
>({ channel: "discord", interactiveKey: "interaction" });
const slackInteractiveDispatcher = createChannelInteractiveDispatcher<
  "slack",
  "interaction",
  SlackInteractiveHandlerContext
>({ channel: "slack", interactiveKey: "interaction" });

type InteractiveDispatchParams =
  | (Parameters<typeof telegramInteractiveDispatcher>[0] & { channel: "telegram" })
  | (Parameters<typeof discordInteractiveDispatcher>[0] & { channel: "discord" })
  | (Parameters<typeof slackInteractiveDispatcher>[0] & { channel: "slack" });

type InteractiveModule = typeof import("./interactive.js");

const interactiveModuleUrl = new URL("./interactive.ts", import.meta.url).href;

async function importInteractiveModule(cacheBust: string): Promise<InteractiveModule> {
  return (await import(`${interactiveModuleUrl}?t=${cacheBust}`)) as InteractiveModule;
}

function createTelegramDispatchParams(params: {
  data: string;
  callbackId: string;
}): Extract<InteractiveDispatchParams, { channel: "telegram" }> {
  return {
    channel: "telegram",
    data: params.data,
    dedupeId: params.callbackId,
    ctx: {
      accountId: "default",
      callbackId: params.callbackId,
      conversationId: "-10099:topic:77",
      parentConversationId: "-10099",
      senderId: "user-1",
      senderUsername: "ada",
      threadId: 77,
      isGroup: true,
      isForum: true,
      auth: { isAuthorizedSender: true },
      callbackMessage: {
        messageId: 55,
        chatId: "-10099",
        messageText: "Pick a thread",
      },
    },
    respond: {
      reply: vi.fn(async () => {}),
      editMessage: vi.fn(async () => {}),
      editButtons: vi.fn(async () => {}),
      clearButtons: vi.fn(async () => {}),
      deleteMessage: vi.fn(async () => {}),
    },
  };
}

function createDiscordDispatchParams(params: {
  data: string;
  interactionId: string;
  interaction?: Partial<
    Extract<InteractiveDispatchParams, { channel: "discord" }>["ctx"]["interaction"]
  >;
}): Extract<InteractiveDispatchParams, { channel: "discord" }> {
  return {
    channel: "discord",
    data: params.data,
    dedupeId: params.interactionId,
    ctx: {
      accountId: "default",
      interactionId: params.interactionId,
      conversationId: "channel-1",
      parentConversationId: "parent-1",
      guildId: "guild-1",
      senderId: "user-1",
      senderUsername: "ada",
      auth: { isAuthorizedSender: true },
      interaction: {
        kind: "button",
        messageId: "message-1",
        values: ["allow"],
        ...params.interaction,
      },
    },
    respond: {
      acknowledge: vi.fn(async () => {}),
      reply: vi.fn(async () => {}),
      followUp: vi.fn(async () => {}),
      editMessage: vi.fn(async () => {}),
      clearComponents: vi.fn(async () => {}),
    },
  };
}

function createSlackDispatchParams(params: {
  data: string;
  interactionId: string;
  interaction?: Partial<
    Extract<InteractiveDispatchParams, { channel: "slack" }>["ctx"]["interaction"]
  >;
}): Extract<InteractiveDispatchParams, { channel: "slack" }> {
  return {
    channel: "slack",
    data: params.data,
    dedupeId: params.interactionId,
    ctx: {
      accountId: "default",
      interactionId: params.interactionId,
      conversationId: "C123",
      parentConversationId: "C123",
      threadId: "1710000000.000100",
      senderId: "user-1",
      senderUsername: "ada",
      auth: { isAuthorizedSender: true },
      interaction: {
        kind: "button",
        actionId: "codex",
        blockId: "codex_actions",
        messageTs: "1710000000.000200",
        threadTs: "1710000000.000100",
        value: "approve:thread-1",
        selectedValues: ["approve:thread-1"],
        selectedLabels: ["Approve"],
        triggerId: "trigger-1",
        responseUrl: "https://hooks.slack.test/response",
        ...params.interaction,
      },
    },
    respond: {
      acknowledge: vi.fn(async () => {}),
      reply: vi.fn(async () => {}),
      followUp: vi.fn(async () => {}),
      editMessage: vi.fn(async () => {}),
    },
  };
}

async function expectDedupedInteractiveDispatch(params: {
  baseParams: InteractiveDispatchParams;
  handler: ReturnType<typeof vi.fn>;
  expectHandlerContext: (ctx: unknown) => void;
}) {
  const first = await dispatchInteractive(params.baseParams);
  const duplicate = await dispatchInteractive(params.baseParams);

  expect(first).toEqual({ matched: true, handled: true, duplicate: false });
  expect(duplicate).toEqual({ matched: true, handled: true, duplicate: true });
  expect(params.handler).toHaveBeenCalledTimes(1);
  params.expectHandlerContext(requireHandlerCall(params.handler));
}

async function dispatchInteractive(params: InteractiveDispatchParams) {
  if (params.channel === "telegram") {
    return await telegramInteractiveDispatcher(params);
  }
  if (params.channel === "discord") {
    return await discordInteractiveDispatcher(params);
  }
  return await slackInteractiveDispatcher(params);
}

async function dispatchInteractiveWith(
  interactiveModule: Pick<typeof import("./interactive.js"), "createChannelInteractiveDispatcher">,
  params: InteractiveDispatchParams,
) {
  if (params.channel === "telegram") {
    const dispatch = interactiveModule.createChannelInteractiveDispatcher<
      "telegram",
      "callback",
      TelegramInteractiveHandlerContext,
      { handled?: boolean } | void,
      "callbackMessage"
    >({
      channel: "telegram",
      interactiveKey: "callback",
      dispatchInteractiveKey: "callbackMessage",
    });
    return await dispatch(params);
  }
  if (params.channel === "discord") {
    return await interactiveModule.createChannelInteractiveDispatcher<
      "discord",
      "interaction",
      DiscordInteractiveHandlerContext
    >({ channel: "discord", interactiveKey: "interaction" })(params);
  }
  return await interactiveModule.createChannelInteractiveDispatcher<
    "slack",
    "interaction",
    SlackInteractiveHandlerContext
  >({
    channel: "slack",
    interactiveKey: "interaction",
  })(params);
}

function registerInteractiveHandler(params: {
  channel: "telegram" | "discord" | "slack";
  namespace: string;
  handler: ReturnType<typeof vi.fn>;
}) {
  return registerPluginInteractiveHandler("codex-plugin", {
    channel: params.channel,
    namespace: params.namespace,
    handler: params.handler as never,
  });
}

function requireHandlerCall(handler: ReturnType<typeof vi.fn>, index = 0): unknown {
  const call = handler.mock.calls[index] as [unknown] | undefined;
  if (!call) {
    throw new Error(`handler call ${index} missing`);
  }
  return call[0];
}

type BindingHelperCase = {
  name: string;
  registerParams: { channel: "telegram" | "discord" | "slack"; namespace: string };
  dispatchParams: InteractiveDispatchParams;
  requestResult: {
    status: "bound";
    binding: {
      bindingId: string;
      pluginId: string;
      pluginName: string;
      pluginRoot: string;
      channel: string;
      accountId: string;
      conversationId: string;
      parentConversationId?: string;
      threadId?: string | number;
      boundAt: number;
    };
  };
  requestSummary: string;
  expectedConversation: {
    channel: string;
    accountId: string;
    conversationId: string;
    parentConversationId?: string;
    threadId?: string | number;
  };
};

async function expectBindingHelperWiring(params: BindingHelperCase) {
  const currentBinding = {
    ...params.requestResult.binding,
    boundAt: params.requestResult.binding.boundAt + 1,
  };
  requestPluginConversationBindingMock.mockResolvedValueOnce(params.requestResult);
  getCurrentPluginConversationBindingMock.mockResolvedValueOnce(currentBinding);

  const handler = vi.fn(async (ctx) => {
    await expect(
      ctx.requestConversationBinding({ summary: params.requestSummary }),
    ).resolves.toEqual(params.requestResult);
    await expect(ctx.detachConversationBinding()).resolves.toEqual({ removed: true });
    await expect(ctx.getCurrentConversationBinding()).resolves.toEqual(currentBinding);
    return { handled: true };
  });

  expect(
    registerPluginInteractiveHandler(
      "codex-plugin",
      {
        ...params.registerParams,
        handler: handler as never,
      },
      { pluginName: "Codex", pluginRoot: "/plugins/codex" },
    ),
  ).toEqual({ ok: true });

  await expect(dispatchInteractive(params.dispatchParams)).resolves.toEqual({
    matched: true,
    handled: true,
    duplicate: false,
  });

  expect(requestPluginConversationBindingMock).toHaveBeenCalledWith({
    pluginId: "codex-plugin",
    pluginName: "Codex",
    pluginRoot: "/plugins/codex",
    requestedBySenderId: "user-1",
    conversation: params.expectedConversation,
    binding: {
      summary: params.requestSummary,
    },
  });
  expect(detachPluginConversationBindingMock).toHaveBeenCalledWith({
    pluginRoot: "/plugins/codex",
    conversation: params.expectedConversation,
  });
  expect(getCurrentPluginConversationBindingMock).toHaveBeenCalledWith({
    pluginRoot: "/plugins/codex",
    conversation: params.expectedConversation,
  });
}

describe("plugin interactive handlers", () => {
  beforeEach(() => {
    clearPluginInteractiveHandlers();
    requestPluginConversationBindingMock = vi
      .spyOn(conversationBinding, "requestPluginConversationBinding")
      .mockResolvedValue({
        status: "bound",
        binding: {
          bindingId: "binding-1",
          pluginId: "codex-plugin",
          pluginName: "Codex",
          pluginRoot: "/plugins/codex",
          channel: "telegram",
          accountId: "default",
          conversationId: "-10099:topic:77",
          parentConversationId: "-10099",
          threadId: 77,
          boundAt: 1,
        },
      });
    detachPluginConversationBindingMock = vi
      .spyOn(conversationBinding, "detachPluginConversationBinding")
      .mockResolvedValue({ removed: true });
    getCurrentPluginConversationBindingMock = vi
      .spyOn(conversationBinding, "getCurrentPluginConversationBinding")
      .mockResolvedValue({
        bindingId: "binding-1",
        pluginId: "codex-plugin",
        pluginName: "Codex",
        pluginRoot: "/plugins/codex",
        channel: "telegram",
        accountId: "default",
        conversationId: "-10099:topic:77",
        parentConversationId: "-10099",
        threadId: 77,
        boundAt: 1,
      });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetPluginRuntimeStateForTest();
  });

  it("writes direct registrations into the synchronous builder context", () => {
    const active = createEmptyPluginRegistry();
    const building = createEmptyPluginRegistry();
    setActivePluginRegistry(active);

    expect(
      withPluginRegistrationContext(building, "codex-plugin", () =>
        registerPluginInteractiveHandler("spoofed-plugin", {
          channel: "telegram",
          namespace: "builder",
          handler: async () => ({ handled: true }),
        }),
      ),
    ).toEqual({ ok: true });
    expect(active.interactiveHandlers).toStrictEqual([]);
    expect(building.interactiveHandlers.map((entry) => entry.namespace)).toEqual(["builder"]);
    expect(building.interactiveHandlers[0]?.pluginId).toBe("codex-plugin");
  });

  it("hydrates legacy interactive state shapes before clearing handlers", async () => {
    const globalStore = globalThis as Record<PropertyKey, unknown>;
    const stateKey = Symbol.for("openclaw.pluginInteractiveState");
    const originalState = globalStore[stateKey];

    globalStore[stateKey] = {
      interactiveHandlers: new Map(),
    };

    try {
      clearPluginInteractiveHandlers();
      const hydrated = globalStore[stateKey] as {
        interactiveHandlers?: Map<string, unknown>;
        callbackDedupe?: { clear: () => void };
        inflightCallbackDedupe?: Set<string>;
      };
      expect(hydrated.interactiveHandlers).toBeUndefined();
      if (!hydrated.callbackDedupe) {
        throw new Error("expected hydrated callback dedupe");
      }
      hydrated.callbackDedupe.clear();
      expect(hydrated.inflightCallbackDedupe).toBeInstanceOf(Set);

      const handler = vi.fn(async () => ({ handled: true }));
      expect(
        registerPluginInteractiveHandler("codex-plugin", {
          channel: "telegram",
          namespace: "legacy",
          handler,
        }),
      ).toEqual({ ok: true });

      await expect(
        dispatchInteractive(
          createTelegramDispatchParams({
            data: "legacy:resume",
            callbackId: "legacy-state-cb",
          }),
        ),
      ).resolves.toEqual({ matched: true, handled: true, duplicate: false });
      await expect(
        dispatchInteractive(
          createTelegramDispatchParams({
            data: "legacy:resume",
            callbackId: "legacy-state-cb",
          }),
        ),
      ).resolves.toEqual({ matched: true, handled: true, duplicate: true });
    } finally {
      if (originalState === undefined) {
        delete globalStore[stateKey];
      } else {
        globalStore[stateKey] = originalState;
      }
      clearPluginInteractiveHandlers();
    }
  });

  it.each([
    {
      name: "routes Telegram callbacks by namespace and dedupes callback ids",
      channel: "telegram" as const,
      baseParams: createTelegramDispatchParams({
        data: "codex:resume:thread-1",
        callbackId: "cb-1",
      }),
      expectHandlerContext: (ctx: unknown) => {
        const telegramCtx = ctx as TelegramInteractiveHandlerContext;
        expect(telegramCtx.channel).toBe("telegram");
        expect(telegramCtx.conversationId).toBe("-10099:topic:77");
        expect(telegramCtx.callback.namespace).toBe("codex");
        expect(telegramCtx.callback.payload).toBe("resume:thread-1");
        expect(telegramCtx.callback.chatId).toBe("-10099");
        expect(telegramCtx.callback.messageId).toBe(55);
      },
    },
    {
      name: "routes Discord interactions by namespace and dedupes interaction ids",
      channel: "discord" as const,
      baseParams: createDiscordDispatchParams({
        data: "codex:approve:thread-1",
        interactionId: "ix-1",
        interaction: { kind: "button", values: ["allow"] },
      }),
      expectHandlerContext: (ctx: unknown) => {
        const discordCtx = ctx as DiscordInteractiveHandlerContext;
        expect(discordCtx.channel).toBe("discord");
        expect(discordCtx.conversationId).toBe("channel-1");
        expect(discordCtx.interaction.namespace).toBe("codex");
        expect(discordCtx.interaction.payload).toBe("approve:thread-1");
        expect(discordCtx.interaction.messageId).toBe("message-1");
        expect(discordCtx.interaction.values).toEqual(["allow"]);
      },
    },
    {
      name: "routes Slack interactions by namespace and dedupes interaction ids",
      channel: "slack" as const,
      baseParams: createSlackDispatchParams({
        data: "codex:approve:thread-1",
        interactionId: "slack-ix-1",
        interaction: { kind: "button" },
      }),
      expectHandlerContext: (ctx: unknown) => {
        const slackCtx = ctx as SlackInteractiveHandlerContext;
        expect(slackCtx.channel).toBe("slack");
        expect(slackCtx.conversationId).toBe("C123");
        expect(slackCtx.threadId).toBe("1710000000.000100");
        expect(slackCtx.interaction.namespace).toBe("codex");
        expect(slackCtx.interaction.payload).toBe("approve:thread-1");
        expect(slackCtx.interaction.actionId).toBe("codex");
        expect(slackCtx.interaction.messageTs).toBe("1710000000.000200");
      },
    },
  ] as const)("$name", async ({ channel, baseParams, expectHandlerContext }) => {
    const handler = vi.fn(async () => ({ handled: true }));
    expect(registerInteractiveHandler({ channel, namespace: "codex", handler })).toEqual({
      ok: true,
    });

    await expectDedupedInteractiveDispatch({
      baseParams,
      handler,
      expectHandlerContext,
    });
  });

  it("shares interactive handlers across duplicate module instances", async () => {
    const first = await importInteractiveModule(`first-${Date.now()}`);
    const second = await importInteractiveModule(`second-${Date.now()}`);
    const handler = vi.fn(async () => ({ handled: true }));

    first.clearPluginInteractiveHandlers();

    expect(
      first.registerPluginInteractiveHandler("codex-plugin", {
        channel: "telegram",
        namespace: "codexapp",
        handler,
      }),
    ).toEqual({ ok: true });

    await expect(
      dispatchInteractiveWith(
        second,
        createTelegramDispatchParams({
          data: "codexapp:resume:thread-1",
          callbackId: "cb-shared-1",
        }),
      ),
    ).resolves.toEqual({ matched: true, handled: true, duplicate: false });

    expect(handler).toHaveBeenCalledTimes(1);
    const ctx = requireHandlerCall(handler) as TelegramInteractiveHandlerContext;
    expect(ctx.channel).toBe("telegram");
    expect(ctx.callback.namespace).toBe("codexapp");
    expect(ctx.callback.payload).toBe("resume:thread-1");

    second.clearPluginInteractiveHandlers();
  });

  it("resolves active registry handlers without retaining them after retirement", async () => {
    const handler = vi.fn(async () => ({ handled: true }));
    const registry = createEmptyPluginRegistry();
    registry.plugins.push({
      id: "openclaw-code-agent",
      name: "OpenClaw Code Agent",
      status: "loaded",
    } as never);
    registry.interactiveHandlers = [
      {
        channel: "telegram",
        namespace: "code-agent",
        pluginId: "openclaw-code-agent",
        pluginName: "OpenClaw Code Agent",
        pluginRoot: "/plugins/openclaw-code-agent",
        handler: handler as never,
      },
    ];
    expect(
      registerRegistryPluginInteractiveHandler(
        "openclaw-code-agent",
        {
          channel: "telegram",
          namespace: "code-agent",
          handler: handler as never,
        },
        {
          pluginName: "OpenClaw Code Agent",
          pluginRoot: "/plugins/openclaw-code-agent",
        },
      ),
    ).toEqual({ ok: true });
    setActivePluginRegistry(registry);

    await expect(
      dispatchInteractive(
        createTelegramDispatchParams({
          data: "code-agent:7506a349-84c8-4c56-8558-ce315bed2588",
          callbackId: "cb-code-agent-restored",
        }),
      ),
    ).resolves.toEqual({ matched: true, handled: true, duplicate: false });

    expect(handler).toHaveBeenCalledTimes(1);
    const ctx = requireHandlerCall(handler) as TelegramInteractiveHandlerContext;
    expect(ctx.callback.namespace).toBe("code-agent");
    expect(ctx.callback.payload).toBe("7506a349-84c8-4c56-8558-ce315bed2588");

    setActivePluginRegistry(createEmptyPluginRegistry());
    await expect(
      dispatchInteractive(
        createTelegramDispatchParams({
          data: "code-agent:7506a349-84c8-4c56-8558-ce315bed2588",
          callbackId: "cb-code-agent-retired",
        }),
      ),
    ).resolves.toEqual({ matched: false, handled: false, duplicate: false });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("rejects duplicate namespace registrations", () => {
    const first = registerPluginInteractiveHandler("plugin-a", {
      channel: "telegram",
      namespace: "codex",
      handler: async () => ({ handled: true }),
    });
    const second = registerPluginInteractiveHandler("plugin-b", {
      channel: "telegram",
      namespace: "codex",
      handler: async () => ({ handled: true }),
    });

    expect(first).toEqual({ ok: true });
    expect(second).toEqual({
      ok: false,
      error: 'Interactive handler namespace "codex" already registered by plugin "plugin-a"',
    });
  });

  it("preserves arbitrary plugin-owned channel ids", () => {
    const result = registerPluginInteractiveHandler("plugin-a", {
      channel: "msteams",
      namespace: "codex",
      handler: async () => ({ handled: true }),
    });

    expect(result).toEqual({ ok: true });
  });

  it("acknowledges matched Discord interactions before awaiting plugin handlers", async () => {
    const callOrder: string[] = [];
    const handler = vi.fn(async () => {
      callOrder.push("handler");
      expect(callOrder).toEqual(["ack", "handler"]);
      return { handled: true };
    });
    expect(
      registerPluginInteractiveHandler("codex-plugin", {
        channel: "discord",
        namespace: "codex",
        handler,
      }),
    ).toEqual({ ok: true });

    await expect(
      dispatchInteractive({
        ...createDiscordDispatchParams({
          data: "codex:approve:thread-1",
          interactionId: "ix-ack-1",
          interaction: { kind: "button", values: undefined },
        }),
        onMatched: async () => {
          callOrder.push("ack");
        },
      }),
    ).resolves.toEqual({
      matched: true,
      handled: true,
      duplicate: false,
    });
  });

  it.each([
    {
      name: "wires Telegram conversation binding helpers with topic context",
      registerParams: { channel: "telegram", namespace: "codex" },
      dispatchParams: createTelegramDispatchParams({
        data: "codex:bind",
        callbackId: "cb-bind",
      }),
      requestResult: {
        status: "bound" as const,
        binding: {
          bindingId: "binding-telegram",
          pluginId: "codex-plugin",
          pluginName: "Codex",
          pluginRoot: "/plugins/codex",
          channel: "telegram",
          accountId: "default",
          conversationId: "-10099:topic:77",
          parentConversationId: "-10099",
          threadId: 77,
          boundAt: 1,
        },
      },
      requestSummary: "Bind this topic",
      expectedConversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "-10099:topic:77",
        parentConversationId: "-10099",
        threadId: 77,
      },
    },
    {
      name: "wires Discord conversation binding helpers with parent channel context",
      registerParams: { channel: "discord", namespace: "codex" },
      dispatchParams: createDiscordDispatchParams({
        data: "codex:bind",
        interactionId: "ix-bind",
        interaction: { kind: "button", values: ["allow"] },
      }),
      requestResult: {
        status: "bound" as const,
        binding: {
          bindingId: "binding-discord",
          pluginId: "codex-plugin",
          pluginName: "Codex",
          pluginRoot: "/plugins/codex",
          channel: "discord",
          accountId: "default",
          conversationId: "channel-1",
          parentConversationId: "parent-1",
          boundAt: 1,
        },
      },
      requestSummary: "Bind Discord",
      expectedConversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel-1",
        parentConversationId: "parent-1",
      },
    },
    {
      name: "wires Slack conversation binding helpers with thread context",
      registerParams: { channel: "slack", namespace: "codex" },
      dispatchParams: createSlackDispatchParams({
        data: "codex:bind",
        interactionId: "slack-bind",
        interaction: {
          kind: "button",
          value: "bind",
          selectedValues: ["bind"],
          selectedLabels: ["Bind"],
        },
      }),
      requestResult: {
        status: "bound" as const,
        binding: {
          bindingId: "binding-slack",
          pluginId: "codex-plugin",
          pluginName: "Codex",
          pluginRoot: "/plugins/codex",
          channel: "slack",
          accountId: "default",
          conversationId: "C123",
          parentConversationId: "C123",
          threadId: "1710000000.000100",
          boundAt: 1,
        },
      },
      requestSummary: "Bind Slack",
      expectedConversation: {
        channel: "slack",
        accountId: "default",
        conversationId: "C123",
        parentConversationId: "C123",
        threadId: "1710000000.000100",
      },
    },
  ] as const)("$name", async (testCase) => {
    await expectBindingHelperWiring(testCase);
  });

  it.each([
    {
      name: "authorized and bound",
      auth: true,
      senderId: "user-1",
      accountId: "default",
      conversationId: "conversation-1",
      conversation: undefined,
      expectedStatus: "bound",
    },
    {
      name: "unauthorized",
      auth: false,
      senderId: "user-1",
      accountId: "default",
      conversationId: "conversation-1",
      conversation: undefined,
      expectedStatus: "error",
    },
    {
      name: "missing sender",
      auth: true,
      senderId: " ",
      accountId: "default",
      conversationId: "conversation-1",
      conversation: undefined,
      expectedStatus: "error",
    },
    {
      name: "missing account",
      auth: true,
      senderId: "user-1",
      accountId: " ",
      conversationId: "conversation-1",
      conversation: undefined,
      expectedStatus: "error",
    },
    {
      name: "missing base conversation despite an override",
      auth: true,
      senderId: "user-1",
      accountId: "default",
      conversationId: " ",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "override-conversation",
      },
      expectedStatus: "error",
    },
  ] as const)("exposes binding authority only when $name", async (testCase) => {
    let bindingResult: unknown;
    const handler = vi.fn(async (ctx: TelegramInteractiveHandlerContext) => {
      bindingResult = await ctx.requestConversationBinding();
    });
    expect(
      registerPluginInteractiveHandler(
        "codex-plugin",
        { channel: "telegram", namespace: "codex", handler: handler as never },
        { pluginName: "Codex", pluginRoot: "/plugins/codex" },
      ),
    ).toEqual({ ok: true });
    const dispatchParams = createTelegramDispatchParams({
      data: "codex:bind",
      callbackId: `auth-${testCase.name}`,
    });

    await dispatchInteractive({
      ...dispatchParams,
      conversation: testCase.conversation,
      ctx: {
        ...dispatchParams.ctx,
        auth: { isAuthorizedSender: testCase.auth },
        senderId: testCase.senderId,
        accountId: testCase.accountId,
        conversationId: testCase.conversationId,
      },
    });

    expect(bindingResult).toMatchObject({ status: testCase.expectedStatus });
    expect(requestPluginConversationBindingMock).toHaveBeenCalledTimes(
      testCase.expectedStatus === "bound" ? 1 : 0,
    );
  });

  it("does not consume dedupe keys when a handler throws", async () => {
    const handler = vi
      .fn(async () => ({ handled: true }))
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ handled: true });
    expect(
      registerPluginInteractiveHandler("codex-plugin", {
        channel: "telegram",
        namespace: "codex",
        handler,
      }),
    ).toEqual({ ok: true });

    const baseParams = createTelegramDispatchParams({
      data: "codex:resume:thread-1",
      callbackId: "cb-throw",
    });

    await expect(dispatchInteractive(baseParams)).rejects.toThrow("boom");
    await expect(dispatchInteractive(baseParams)).resolves.toEqual({
      matched: true,
      handled: true,
      duplicate: false,
    });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("does not consume dedupe keys when post-handler processing throws", async () => {
    const handler = vi.fn(async () => ({ handled: true }));
    const afterInvoke = vi
      .fn(async () => {})
      .mockRejectedValueOnce(new Error("post-handler failure"))
      .mockResolvedValueOnce(undefined);
    expect(
      registerPluginInteractiveHandler("codex-plugin", {
        channel: "telegram",
        namespace: "codex",
        handler,
      }),
    ).toEqual({ ok: true });

    const baseParams = {
      ...createTelegramDispatchParams({
        data: "codex:resume:thread-1",
        callbackId: "cb-post-handler-failure",
      }),
      afterInvoke,
    };

    await expect(dispatchInteractive(baseParams)).rejects.toThrow("post-handler failure");
    await expect(dispatchInteractive(baseParams)).resolves.toEqual({
      matched: true,
      handled: true,
      duplicate: false,
    });
    expect(handler).toHaveBeenCalledTimes(2);
    expect(afterInvoke).toHaveBeenCalledTimes(2);
    expect(afterInvoke).toHaveBeenLastCalledWith({ handled: true });
  });

  it("dedupes concurrent interactive dispatches while a handler is still running", async () => {
    let releaseHandler: (() => void) | undefined;
    const handlerGate = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    if (!releaseHandler) {
      throw new Error("Expected handler release callback to be initialized");
    }
    const handler = vi.fn(async () => {
      await handlerGate;
      return { handled: true };
    });
    expect(
      registerPluginInteractiveHandler("codex-plugin", {
        channel: "telegram",
        namespace: "codex",
        handler,
      }),
    ).toEqual({ ok: true });

    const baseParams = createTelegramDispatchParams({
      data: "codex:resume:thread-1",
      callbackId: "cb-concurrent",
    });

    const firstDispatch = dispatchInteractive(baseParams);
    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledTimes(1);
    });
    const duplicateDispatch = await dispatchInteractive(baseParams);

    expect(duplicateDispatch).toEqual({
      matched: true,
      handled: true,
      duplicate: true,
    });

    releaseHandler();

    await expect(firstDispatch).resolves.toEqual({
      matched: true,
      handled: true,
      duplicate: false,
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("releases inflight interactive dedupe keys after a handler failure", async () => {
    let rejectHandler: ((error: Error) => void) | undefined;
    const handlerGate = new Promise<never>((_, reject) => {
      rejectHandler = reject;
    });
    if (!rejectHandler) {
      throw new Error("Expected handler reject callback to be initialized");
    }
    const handler = vi
      .fn(async () => ({ handled: true }))
      .mockImplementationOnce(async () => await handlerGate)
      .mockResolvedValueOnce({ handled: true });
    expect(
      registerPluginInteractiveHandler("codex-plugin", {
        channel: "telegram",
        namespace: "codex",
        handler,
      }),
    ).toEqual({ ok: true });

    const baseParams = createTelegramDispatchParams({
      data: "codex:resume:thread-1",
      callbackId: "cb-retry-after-failure",
    });

    const firstDispatch = dispatchInteractive(baseParams);
    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledTimes(1);
    });

    await expect(dispatchInteractive(baseParams)).resolves.toEqual({
      matched: true,
      handled: true,
      duplicate: true,
    });

    rejectHandler(new Error("boom"));
    await expect(firstDispatch).rejects.toThrow("boom");

    await expect(dispatchInteractive(baseParams)).resolves.toEqual({
      matched: true,
      handled: true,
      duplicate: false,
    });
    expect(handler).toHaveBeenCalledTimes(2);
  });
});
