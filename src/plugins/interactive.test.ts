import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import * as conversationBinding from "./conversation-binding.js";
import { createInteractiveConversationBindingHelpers } from "./interactive-binding-helpers.js";
import type {
  DiscordInteractiveHandlerContext,
  DiscordInteractiveHandlerRegistration,
  SlackInteractiveHandlerContext,
  SlackInteractiveHandlerRegistration,
  TelegramInteractiveHandlerContext,
  TelegramInteractiveHandlerRegistration,
} from "./interactive-contract.test-helpers.js";
import {
  clearPluginInteractiveHandlers,
  dispatchPluginInteractiveHandler,
  registerPluginInteractiveHandler,
} from "./interactive.js";

let requestPluginConversationBindingMock: MockInstance<
  typeof conversationBinding.requestPluginConversationBinding
>;
let detachPluginConversationBindingMock: MockInstance<
  typeof conversationBinding.detachPluginConversationBinding
>;
let getCurrentPluginConversationBindingMock: MockInstance<
  typeof conversationBinding.getCurrentPluginConversationBinding
>;

type InteractiveDispatchParams =
  | {
      channel: "telegram";
      data: string;
      dedupeId: string;
      onMatched?: () => Promise<void> | void;
      ctx: Omit<
        TelegramInteractiveHandlerContext,
        | "callback"
        | "respond"
        | "channel"
        | "requestConversationBinding"
        | "detachConversationBinding"
        | "getCurrentConversationBinding"
      > & {
        callbackMessage: {
          messageId: number;
          chatId: string;
          messageText?: string;
        };
      };
      respond: TelegramInteractiveHandlerContext["respond"];
    }
  | {
      channel: "discord";
      data: string;
      dedupeId: string;
      onMatched?: () => Promise<void> | void;
      ctx: Omit<
        DiscordInteractiveHandlerContext,
        | "interaction"
        | "respond"
        | "channel"
        | "requestConversationBinding"
        | "detachConversationBinding"
        | "getCurrentConversationBinding"
      > & {
        interaction: Omit<
          DiscordInteractiveHandlerContext["interaction"],
          "data" | "namespace" | "payload"
        >;
      };
      respond: DiscordInteractiveHandlerContext["respond"];
    }
  | {
      channel: "slack";
      data: string;
      dedupeId: string;
      onMatched?: () => Promise<void> | void;
      ctx: Omit<
        SlackInteractiveHandlerContext,
        | "interaction"
        | "respond"
        | "channel"
        | "requestConversationBinding"
        | "detachConversationBinding"
        | "getCurrentConversationBinding"
      > & {
        interaction: Omit<
          SlackInteractiveHandlerContext["interaction"],
          "data" | "namespace" | "payload"
        >;
      };
      respond: SlackInteractiveHandlerContext["respond"];
    };

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
  return await dispatchInteractiveWith({ dispatchPluginInteractiveHandler }, params);
}

async function dispatchInteractiveWith(
  interactiveModule: Pick<typeof import("./interactive.js"), "dispatchPluginInteractiveHandler">,
  params: InteractiveDispatchParams,
) {
  if (params.channel === "telegram") {
    return await interactiveModule.dispatchPluginInteractiveHandler<TelegramInteractiveHandlerRegistration>(
      {
        channel: "telegram",
        data: params.data,
        dedupeId: params.dedupeId,
        onMatched: params.onMatched,
        invoke: ({ registration, namespace, payload }) => {
          const { callbackMessage, ...handlerContext } = params.ctx;
          return registration.handler({
            ...handlerContext,
            channel: "telegram",
            callback: {
              data: params.data,
              namespace,
              payload,
              messageId: callbackMessage.messageId,
              chatId: callbackMessage.chatId,
              messageText: callbackMessage.messageText,
            },
            respond: params.respond,
            ...createInteractiveConversationBindingHelpers({
              registration,
              senderId: handlerContext.senderId,
              conversation: {
                channel: "telegram",
                accountId: handlerContext.accountId,
                conversationId: handlerContext.conversationId,
                parentConversationId: handlerContext.parentConversationId,
                threadId: handlerContext.threadId,
              },
            }),
          });
        },
      },
    );
  }
  if (params.channel === "discord") {
    return await interactiveModule.dispatchPluginInteractiveHandler<DiscordInteractiveHandlerRegistration>(
      {
        channel: "discord",
        data: params.data,
        dedupeId: params.dedupeId,
        onMatched: params.onMatched,
        invoke: ({ registration, namespace, payload }) =>
          registration.handler({
            ...params.ctx,
            channel: "discord",
            interaction: {
              ...params.ctx.interaction,
              data: params.data,
              namespace,
              payload,
            },
            respond: params.respond,
            ...createInteractiveConversationBindingHelpers({
              registration,
              senderId: params.ctx.senderId,
              conversation: {
                channel: "discord",
                accountId: params.ctx.accountId,
                conversationId: params.ctx.conversationId,
                parentConversationId: params.ctx.parentConversationId,
              },
            }),
          }),
      },
    );
  }
  return await interactiveModule.dispatchPluginInteractiveHandler<SlackInteractiveHandlerRegistration>(
    {
      channel: "slack",
      data: params.data,
      dedupeId: params.dedupeId,
      onMatched: params.onMatched,
      invoke: ({ registration, namespace, payload }) =>
        registration.handler({
          ...params.ctx,
          channel: "slack",
          interaction: {
            ...params.ctx.interaction,
            data: params.data,
            namespace,
            payload,
          },
          respond: params.respond,
          ...createInteractiveConversationBindingHelpers({
            registration,
            senderId: params.ctx.senderId,
            conversation: {
              channel: "slack",
              accountId: params.ctx.accountId,
              conversationId: params.ctx.conversationId,
              parentConversationId: params.ctx.parentConversationId,
              threadId: params.ctx.threadId,
            },
          }),
        }),
    },
  );
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
      expect(hydrated.interactiveHandlers).toBeInstanceOf(Map);
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
