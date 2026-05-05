import type { Bot } from "grammy";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAutoTopicLabelConfig as resolveAutoTopicLabelConfigRuntime } from "./auto-topic-label-config.js";
import type { TelegramBotDeps } from "./bot-deps.js";
import {
  createSequencedTestDraftStream,
  createTestDraftStream,
} from "./draft-stream.test-helpers.js";
import { renderTelegramHtmlText } from "./format.js";

type DispatchReplyWithBufferedBlockDispatcherArgs = Parameters<
  TelegramBotDeps["dispatchReplyWithBufferedBlockDispatcher"]
>[0];

const createTelegramDraftStream = vi.hoisted(() => vi.fn());
const dispatchReplyWithBufferedBlockDispatcher = vi.hoisted(() =>
  vi.fn<(params: DispatchReplyWithBufferedBlockDispatcherArgs) => Promise<unknown>>(),
);
const deliverReplies = vi.hoisted(() => vi.fn());
const emitInternalMessageSentHook = vi.hoisted(() => vi.fn());
const createForumTopicTelegram = vi.hoisted(() => vi.fn());
const deleteMessageTelegram = vi.hoisted(() => vi.fn());
const editForumTopicTelegram = vi.hoisted(() => vi.fn());
const editMessageTelegram = vi.hoisted(() => vi.fn());
const reactMessageTelegram = vi.hoisted(() => vi.fn());
const sendMessageTelegram = vi.hoisted(() => vi.fn());
const sendPollTelegram = vi.hoisted(() => vi.fn());
const sendStickerTelegram = vi.hoisted(() => vi.fn());
const loadConfig = vi.hoisted(() => vi.fn(() => ({})));
const readChannelAllowFromStore = vi.hoisted(() => vi.fn(async () => []));
const upsertChannelPairingRequest = vi.hoisted(() =>
  vi.fn(async () => ({
    code: "PAIRCODE",
    created: true,
  })),
);
const enqueueSystemEvent = vi.hoisted(() => vi.fn());
const buildModelsProviderData = vi.hoisted(() =>
  vi.fn(async () => ({
    byProvider: new Map<string, Set<string>>(),
    providers: [],
    resolvedDefault: { provider: "openai", model: "gpt-test" },
    modelNames: new Map<string, string>(),
  })),
);
const listSkillCommandsForAgents = vi.hoisted(() => vi.fn(() => []));
const createChannelReplyPipeline = vi.hoisted(() =>
  vi.fn(() => ({
    responsePrefix: undefined,
    responsePrefixContextProvider: () => ({ identityName: undefined }),
    onModelSelected: () => undefined,
  })),
);
const wasSentByBot = vi.hoisted(() => vi.fn(() => false));
const loadSessionStore = vi.hoisted(() => vi.fn());
const resolveStorePath = vi.hoisted(() => vi.fn(() => "/tmp/sessions.json"));
const generateTopicLabel = vi.hoisted(() => vi.fn());
const describeStickerImage = vi.hoisted(() => vi.fn(async () => null));
const loadModelCatalog = vi.hoisted(() => vi.fn(async () => ({})));
const findModelInCatalog = vi.hoisted(() => vi.fn(() => null));
const modelSupportsVision = vi.hoisted(() => vi.fn(() => false));
const resolveAgentDir = vi.hoisted(() => vi.fn(() => "/tmp/agent"));
const resolveDefaultModelForAgent = vi.hoisted(() =>
  vi.fn(() => ({ provider: "openai", model: "gpt-test" })),
);
const getAgentScopedMediaLocalRoots = vi.hoisted(() =>
  vi.fn((_cfg: unknown, agentId: string) => [`/tmp/.openclaw/workspace-${agentId}`]),
);
const resolveChunkMode = vi.hoisted(() => vi.fn(() => undefined));
const resolveMarkdownTableMode = vi.hoisted(() => vi.fn(() => "preserve"));
const resolveSessionStoreEntry = vi.hoisted(() =>
  vi.fn(({ store, sessionKey }: { store: Record<string, unknown>; sessionKey: string }) => ({
    existing: store[sessionKey],
  })),
);

vi.mock("./draft-stream.js", () => ({
  createTelegramDraftStream,
}));

vi.mock("./bot/delivery.js", () => ({
  deliverReplies,
  emitInternalMessageSentHook,
}));

vi.mock("./bot/delivery.replies.js", () => ({
  deliverReplies,
  emitInternalMessageSentHook,
}));

vi.mock("./send.js", () => ({
  createForumTopicTelegram,
  deleteMessageTelegram,
  editForumTopicTelegram,
  editMessageTelegram,
  reactMessageTelegram,
  sendMessageTelegram,
  sendPollTelegram,
  sendStickerTelegram,
}));

vi.mock("./bot-message-dispatch.runtime.js", () => ({
  generateTopicLabel,
  getAgentScopedMediaLocalRoots,
  loadSessionStore,
  resolveAutoTopicLabelConfig: resolveAutoTopicLabelConfigRuntime,
  resolveChunkMode,
  resolveMarkdownTableMode,
  resolveSessionStoreEntry,
  resolveStorePath,
}));

vi.mock("./bot-message-dispatch.agent.runtime.js", () => ({
  findModelInCatalog,
  loadModelCatalog,
  modelSupportsVision,
  resolveAgentDir,
  resolveDefaultModelForAgent,
}));

vi.mock("./sticker-cache.js", () => ({
  cacheSticker: vi.fn(),
  getCachedSticker: () => null,
  getCacheStats: () => ({ count: 0 }),
  searchStickers: () => [],
  getAllCachedStickers: () => [],
  describeStickerImage,
}));

let dispatchTelegramMessage: typeof import("./bot-message-dispatch.js").dispatchTelegramMessage;
let getTelegramReplyFenceSizeForTests: typeof import("./bot-message-dispatch.js").getTelegramReplyFenceSizeForTests;
let resetTelegramReplyFenceForTests: typeof import("./bot-message-dispatch.js").resetTelegramReplyFenceForTests;

const telegramDepsForTest: TelegramBotDeps = {
  getRuntimeConfig: loadConfig as TelegramBotDeps["getRuntimeConfig"],
  resolveStorePath: resolveStorePath as TelegramBotDeps["resolveStorePath"],
  loadSessionStore: loadSessionStore as TelegramBotDeps["loadSessionStore"],
  readChannelAllowFromStore:
    readChannelAllowFromStore as TelegramBotDeps["readChannelAllowFromStore"],
  upsertChannelPairingRequest:
    upsertChannelPairingRequest as TelegramBotDeps["upsertChannelPairingRequest"],
  enqueueSystemEvent: enqueueSystemEvent as TelegramBotDeps["enqueueSystemEvent"],
  dispatchReplyWithBufferedBlockDispatcher:
    dispatchReplyWithBufferedBlockDispatcher as TelegramBotDeps["dispatchReplyWithBufferedBlockDispatcher"],
  buildModelsProviderData: buildModelsProviderData as TelegramBotDeps["buildModelsProviderData"],
  listSkillCommandsForAgents:
    listSkillCommandsForAgents as TelegramBotDeps["listSkillCommandsForAgents"],
  createChannelReplyPipeline:
    createChannelReplyPipeline as TelegramBotDeps["createChannelReplyPipeline"],
  wasSentByBot: wasSentByBot as TelegramBotDeps["wasSentByBot"],
  createTelegramDraftStream:
    createTelegramDraftStream as TelegramBotDeps["createTelegramDraftStream"],
  deliverReplies: deliverReplies as TelegramBotDeps["deliverReplies"],
  emitInternalMessageSentHook:
    emitInternalMessageSentHook as TelegramBotDeps["emitInternalMessageSentHook"],
  editMessageTelegram: editMessageTelegram as TelegramBotDeps["editMessageTelegram"],
};

describe("dispatchTelegramMessage draft streaming", () => {
  type TelegramMessageContext = Parameters<typeof dispatchTelegramMessage>[0]["context"];

  beforeAll(async () => {
    ({
      dispatchTelegramMessage,
      getTelegramReplyFenceSizeForTests,
      resetTelegramReplyFenceForTests,
    } = await import("./bot-message-dispatch.js"));
  });

  beforeEach(() => {
    resetTelegramReplyFenceForTests();
    createTelegramDraftStream.mockReset();
    dispatchReplyWithBufferedBlockDispatcher.mockReset();
    deliverReplies.mockReset();
    emitInternalMessageSentHook.mockReset();
    createForumTopicTelegram.mockReset();
    deleteMessageTelegram.mockReset();
    editForumTopicTelegram.mockReset();
    editMessageTelegram.mockReset();
    reactMessageTelegram.mockReset();
    sendMessageTelegram.mockReset();
    sendPollTelegram.mockReset();
    sendStickerTelegram.mockReset();
    loadConfig.mockReset();
    readChannelAllowFromStore.mockReset();
    upsertChannelPairingRequest.mockReset();
    enqueueSystemEvent.mockReset();
    buildModelsProviderData.mockReset();
    listSkillCommandsForAgents.mockReset();
    createChannelReplyPipeline.mockReset();
    wasSentByBot.mockReset();
    loadSessionStore.mockReset();
    resolveStorePath.mockReset();
    generateTopicLabel.mockReset();
    getAgentScopedMediaLocalRoots.mockClear();
    resolveChunkMode.mockClear();
    resolveMarkdownTableMode.mockClear();
    resolveSessionStoreEntry.mockClear();
    describeStickerImage.mockReset();
    loadModelCatalog.mockReset();
    findModelInCatalog.mockReset();
    modelSupportsVision.mockReset();
    resolveAgentDir.mockReset();
    resolveDefaultModelForAgent.mockReset();
    loadConfig.mockReturnValue({});
    dispatchReplyWithBufferedBlockDispatcher.mockResolvedValue({
      queuedFinal: false,
      counts: { block: 0, final: 0, tool: 0 },
    });
    deliverReplies.mockResolvedValue({ delivered: true });
    emitInternalMessageSentHook.mockResolvedValue(undefined);
    createForumTopicTelegram.mockResolvedValue({ message_thread_id: 777 });
    deleteMessageTelegram.mockResolvedValue(true);
    editForumTopicTelegram.mockResolvedValue(true);
    editMessageTelegram.mockResolvedValue({ ok: true });
    reactMessageTelegram.mockResolvedValue(true);
    sendMessageTelegram.mockResolvedValue({ message_id: 1001 });
    sendPollTelegram.mockResolvedValue({ message_id: 1001 });
    sendStickerTelegram.mockResolvedValue({ message_id: 1001 });
    readChannelAllowFromStore.mockResolvedValue([]);
    upsertChannelPairingRequest.mockResolvedValue({
      code: "PAIRCODE",
      created: true,
    });
    enqueueSystemEvent.mockResolvedValue(undefined);
    buildModelsProviderData.mockResolvedValue({
      byProvider: new Map<string, Set<string>>(),
      providers: [],
      resolvedDefault: { provider: "openai", model: "gpt-test" },
      modelNames: new Map<string, string>(),
    });
    listSkillCommandsForAgents.mockReturnValue([]);
    createChannelReplyPipeline.mockReturnValue({
      responsePrefix: undefined,
      responsePrefixContextProvider: () => ({ identityName: undefined }),
      onModelSelected: () => undefined,
    });
    wasSentByBot.mockReturnValue(false);
    resolveStorePath.mockReturnValue("/tmp/sessions.json");
    loadSessionStore.mockReturnValue({});
    generateTopicLabel.mockResolvedValue("Topic label");
    describeStickerImage.mockResolvedValue(null);
    loadModelCatalog.mockResolvedValue({});
    findModelInCatalog.mockReturnValue(null);
    modelSupportsVision.mockReturnValue(false);
    resolveAgentDir.mockReturnValue("/tmp/agent");
    resolveDefaultModelForAgent.mockReturnValue({
      provider: "openai",
      model: "gpt-test",
    });
  });

  const createDraftStream = (messageId?: number) => createTestDraftStream({ messageId });
  const createSequencedDraftStream = (startMessageId = 1001) =>
    createSequencedTestDraftStream(startMessageId);

  function setupDraftStreams(params?: { answerMessageId?: number; reasoningMessageId?: number }) {
    const answerDraftStream = createDraftStream(params?.answerMessageId);
    const reasoningDraftStream = createDraftStream(params?.reasoningMessageId);
    createTelegramDraftStream
      .mockImplementationOnce(() => answerDraftStream)
      .mockImplementationOnce(() => reasoningDraftStream);
    return { answerDraftStream, reasoningDraftStream };
  }

  function createContext(overrides?: Partial<TelegramMessageContext>): TelegramMessageContext {
    const base = {
      ctxPayload: {},
      primaryCtx: { message: { chat: { id: 123, type: "private" } } },
      msg: {
        chat: { id: 123, type: "private" },
        message_id: 456,
        message_thread_id: 777,
      },
      chatId: 123,
      isGroup: false,
      groupConfig: undefined,
      resolvedThreadId: undefined,
      replyThreadId: 777,
      threadSpec: { id: 777, scope: "dm" },
      historyKey: undefined,
      historyLimit: 0,
      groupHistories: new Map(),
      route: { agentId: "default", accountId: "default" },
      skillFilter: undefined,
      sendTyping: vi.fn(),
      sendRecordVoice: vi.fn(),
      ackReactionPromise: null,
      reactionApi: null,
      removeAckAfterReply: false,
    } as unknown as TelegramMessageContext;
    base.turn = {
      storePath: "/tmp/openclaw/telegram-sessions.json",
      recordInboundSession: vi.fn(async () => undefined),
      record: {
        onRecordError: vi.fn(),
      },
    } as unknown as TelegramMessageContext["turn"];

    return {
      ...base,
      ...overrides,
      // Merge nested fields when overrides provide partial objects.
      primaryCtx: {
        ...(base.primaryCtx as object),
        ...(overrides?.primaryCtx ? (overrides.primaryCtx as object) : null),
      } as TelegramMessageContext["primaryCtx"],
      msg: {
        ...(base.msg as object),
        ...(overrides?.msg ? (overrides.msg as object) : null),
      } as TelegramMessageContext["msg"],
      route: {
        ...(base.route as object),
        ...(overrides?.route ? (overrides.route as object) : null),
      } as TelegramMessageContext["route"],
    };
  }

  function createStatusReactionController() {
    return {
      setQueued: vi.fn(),
      setThinking: vi.fn(async () => {}),
      setTool: vi.fn(async () => {}),
      setCompacting: vi.fn(async () => {}),
      cancelPending: vi.fn(),
      setError: vi.fn(async () => {}),
      setDone: vi.fn(async () => {}),
      restoreInitial: vi.fn(async () => {}),
    };
  }

  function observeDeliveredReply(text: string): Promise<void> {
    return new Promise((resolve) => {
      deliverReplies.mockImplementation(async (params: { replies?: Array<{ text?: string }> }) => {
        if (params.replies?.some((reply) => reply.text === text)) {
          resolve();
        }
        return { delivered: true };
      });
    });
  }

  function createBot(): Bot {
    return {
      api: {
        sendMessage: vi.fn(async (_chatId, _text, params) => ({
          message_id:
            typeof params?.message_thread_id === "number" ? params.message_thread_id : 1001,
        })),
        editMessageText: vi.fn(async () => ({ message_id: 1001 })),
        deleteMessage: vi.fn().mockResolvedValue(true),
        editForumTopic: vi.fn().mockResolvedValue(true),
      },
    } as unknown as Bot;
  }

  function createRuntime(): Parameters<typeof dispatchTelegramMessage>[0]["runtime"] {
    return {
      log: vi.fn(),
      error: vi.fn(),
      exit: () => {
        throw new Error("exit");
      },
    };
  }

  async function dispatchWithContext(params: {
    context: TelegramMessageContext;
    cfg?: Parameters<typeof dispatchTelegramMessage>[0]["cfg"];
    telegramCfg?: Parameters<typeof dispatchTelegramMessage>[0]["telegramCfg"];
    streamMode?: Parameters<typeof dispatchTelegramMessage>[0]["streamMode"];
    telegramDeps?: TelegramBotDeps;
    bot?: Bot;
    replyToMode?: Parameters<typeof dispatchTelegramMessage>[0]["replyToMode"];
    textLimit?: number;
  }) {
    const bot = params.bot ?? createBot();
    await dispatchTelegramMessage({
      context: params.context,
      bot,
      cfg: params.cfg ?? {},
      runtime: createRuntime(),
      replyToMode: params.replyToMode ?? "first",
      streamMode: params.streamMode ?? "partial",
      textLimit: params.textLimit ?? 4096,
      telegramCfg: params.telegramCfg ?? {},
      telegramDeps: params.telegramDeps ?? telegramDepsForTest,
      opts: { token: "token" },
    });
  }

  function createReasoningStreamContext(): TelegramMessageContext {
    loadSessionStore.mockReturnValue({
      s1: { reasoningLevel: "stream" },
    });
    return createContext({
      ctxPayload: { SessionKey: "s1" } as unknown as TelegramMessageContext["ctxPayload"],
    });
  }

  it("streams drafts in private threads and forwards thread id", async () => {
    const draftStream = createDraftStream();
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "Hello" });
        await dispatcherOptions.deliver({ text: "Hello" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });

    const context = createContext({
      route: {
        agentId: "work",
      } as unknown as TelegramMessageContext["route"],
    });
    await dispatchWithContext({ context });

    expect(createTelegramDraftStream).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 123,
        thread: { id: 777, scope: "dm" },
        minInitialChars: 30,
      }),
    );
    expect(draftStream.update).toHaveBeenCalledWith("Hello");
    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        thread: { id: 777, scope: "dm" },
        mediaLocalRoots: expect.arrayContaining([
          expect.stringMatching(/[\\/]\.openclaw[\\/]workspace-work$/u),
        ]),
      }),
    );
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        dispatcherOptions: expect.objectContaining({
          beforeDeliver: expect.any(Function),
        }),
        replyOptions: expect.objectContaining({
          disableBlockStreaming: true,
        }),
      }),
    );
    expect(editMessageTelegram).not.toHaveBeenCalled();
    expect(draftStream.clear).toHaveBeenCalledTimes(1);
  });

  it("skips answer draft preview for same-chat selected quotes", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Hello", replyToId: "1001" }, { kind: "final" });
      return { queuedFinal: true };
    });
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({
      context: createContext({
        msg: {
          message_id: 1001,
        } as unknown as TelegramMessageContext["msg"],
        ctxPayload: {
          MessageSid: "1001",
          ReplyToId: "9001",
          ReplyToBody: "quoted slice",
          ReplyToQuoteText: " quoted slice\n",
          ReplyToIsQuote: true,
        } as unknown as TelegramMessageContext["ctxPayload"],
      }),
    });

    expect(createTelegramDraftStream).not.toHaveBeenCalled();
    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [expect.objectContaining({ replyToId: "9001" })],
        replyQuoteMessageId: 9001,
        replyQuoteText: " quoted slice\n",
      }),
    );
  });

  it("keeps answer draft preview for current message replies with native quote candidates", async () => {
    const draftStream = createDraftStream();
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Hello", replyToId: "1001" }, { kind: "final" });
      return { queuedFinal: true };
    });
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({
      context: createContext({
        msg: {
          message_id: 1001,
          text: "Original current message",
          entities: [{ type: "bold", offset: 0, length: 8 }],
        } as unknown as TelegramMessageContext["msg"],
        ctxPayload: {
          MessageSid: "1001",
        } as unknown as TelegramMessageContext["ctxPayload"],
      }),
    });

    expect(createTelegramDraftStream).toHaveBeenCalledWith(
      expect.objectContaining({
        replyToMessageId: 1001,
      }),
    );
    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [expect.objectContaining({ replyToId: "1001" })],
        replyQuoteByMessageId: {
          "1001": {
            text: "Original current message",
            position: 0,
            entities: [{ type: "bold", offset: 0, length: 8 }],
          },
        },
      }),
    );
  });

  it("passes native quote candidates for explicit reply targets", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Hello", replyToId: "9001" }, { kind: "final" });
      return { queuedFinal: true };
    });
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({
      context: createContext({
        ctxPayload: {
          ReplyToId: "9001",
          ReplyToBody: "trimmed body",
          ReplyToQuoteSourceText: "  exact reply body",
          ReplyToQuoteSourceEntities: [{ type: "italic", offset: 2, length: 5 }],
        } as unknown as TelegramMessageContext["ctxPayload"],
      }),
    });

    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [expect.objectContaining({ replyToId: "9001" })],
        replyQuoteByMessageId: {
          "9001": {
            text: "  exact reply body",
            position: 0,
            entities: [{ type: "italic", offset: 2, length: 5 }],
          },
        },
      }),
    );
  });

  it("does not build native quote candidates when reply mode is off", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Hello", replyToId: "1001" }, { kind: "final" });
      return { queuedFinal: true };
    });
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({
      context: createContext({
        msg: {
          message_id: 1001,
          text: "Original current message",
        } as unknown as TelegramMessageContext["msg"],
        ctxPayload: {
          MessageSid: "1001",
        } as unknown as TelegramMessageContext["ctxPayload"],
      }),
      replyToMode: "off",
    });

    expect(deliverReplies.mock.calls[0]?.[0]).not.toHaveProperty("replyQuoteByMessageId.1001");
  });

  it("keeps answer draft preview for selected quotes when reply mode is off", async () => {
    const draftStream = createDraftStream();
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockResolvedValue({ queuedFinal: true });

    await dispatchWithContext({
      context: createContext({
        msg: {
          message_id: 1001,
        } as unknown as TelegramMessageContext["msg"],
        ctxPayload: {
          MessageSid: "1001",
          ReplyToId: "9001",
          ReplyToBody: "quoted slice",
          ReplyToQuoteText: " quoted slice\n",
          ReplyToIsQuote: true,
        } as unknown as TelegramMessageContext["ctxPayload"],
      }),
      replyToMode: "off",
    });

    expect(createTelegramDraftStream).toHaveBeenCalledWith(
      expect.objectContaining({
        replyToMessageId: undefined,
      }),
    );
  });

  it("passes same-chat quoted reply target id with Telegram quote text", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Hello", replyToId: "1001" }, { kind: "final" });
      return { queuedFinal: true };
    });
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({
      context: createContext({
        ctxPayload: {
          MessageSid: "1001",
          ReplyToId: "9001",
          ReplyToBody: "quoted slice",
          ReplyToQuoteText: " quoted slice\n",
          ReplyToIsQuote: true,
          ReplyToQuotePosition: 12,
          ReplyToQuoteEntities: [{ type: "italic", offset: 0, length: 6 }],
        } as unknown as TelegramMessageContext["ctxPayload"],
      }),
      streamMode: "off",
    });

    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [expect.objectContaining({ replyToId: "9001" })],
        replyQuoteMessageId: 9001,
        replyQuoteText: " quoted slice\n",
        replyQuotePosition: 12,
        replyQuoteEntities: [{ type: "italic", offset: 0, length: 6 }],
      }),
    );
  });

  it("does not pass a native quote target for external replies", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Hello", replyToId: "1001" }, { kind: "final" });
      return { queuedFinal: true };
    });
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({
      context: createContext({
        ctxPayload: {
          MessageSid: "1001",
          ReplyToId: "9001",
          ReplyToBody: "external quoted slice",
          ReplyToQuoteText: " external quoted slice\n",
          ReplyToIsQuote: true,
          ReplyToIsExternal: true,
        } as unknown as TelegramMessageContext["ctxPayload"],
      }),
      streamMode: "off",
    });

    const params = deliverReplies.mock.calls[0]?.[0];
    expect(params).toEqual(
      expect.objectContaining({
        replies: [expect.objectContaining({ replyToId: "1001" })],
        replyQuoteText: " external quoted slice\n",
      }),
    );
    expect(params?.replyQuoteMessageId).toBeUndefined();
  });

  it("does not inject approval buttons in local dispatch once the monitor owns approvals", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        {
          text: "Mode: foreground\nRun: /approve 117ba06d allow-once (or allow-always / deny).",
        },
        { kind: "final" },
      );
      return { queuedFinal: true };
    });
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "off",
      cfg: {
        channels: {
          telegram: {
            execApprovals: {
              enabled: true,
              approvers: ["123"],
              target: "dm",
            },
          },
        },
      },
    });

    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [
          expect.objectContaining({
            text: "Mode: foreground\nRun: /approve 117ba06d allow-once (or allow-always / deny).",
          }),
        ],
      }),
    );
    const deliveredPayload = (deliverReplies.mock.calls[0]?.[0] as { replies?: Array<unknown> })
      ?.replies?.[0] as { channelData?: unknown } | undefined;
    expect(deliveredPayload?.channelData).toBeUndefined();
  });

  it("uses 30-char preview debounce for legacy block stream mode", async () => {
    const draftStream = createDraftStream();
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "Hello" });
        await dispatcherOptions.deliver({ text: "Hello" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({ context: createContext(), streamMode: "block" });

    expect(createTelegramDraftStream).toHaveBeenCalledWith(
      expect.objectContaining({
        minInitialChars: 30,
      }),
    );
  });

  it("keeps canonical block mode on the Telegram draft preview path", async () => {
    const draftStream = createDraftStream();
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "HelloWorld" });
        await dispatcherOptions.deliver({ text: "HelloWorld" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "block",
      telegramCfg: { streaming: { mode: "block" } },
    });

    expect(createTelegramDraftStream).toHaveBeenCalled();
    expect(draftStream.update).toHaveBeenCalledWith("HelloWorld");
  });

  it("does not create a Telegram progress draft for a text-only final", async () => {
    const draftStream = createSequencedDraftStream(2001);
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onReplyStart?.();
        await replyOptions?.onAssistantMessageStart?.();
        await dispatcherOptions.deliver({ text: "Final answer" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context: createContext(),
      streamMode: "progress",
      telegramCfg: { streaming: { mode: "progress", progress: { label: "Shelling" } } },
    });

    expect(draftStream.update).not.toHaveBeenCalled();
    expect(draftStream.forceNewMessage).not.toHaveBeenCalled();
    expect(editMessageTelegram).not.toHaveBeenCalled();
    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [expect.objectContaining({ text: "Final answer" })],
      }),
    );
  });

  it("keeps non-command Telegram progress draft lines across post-tool assistant boundaries", async () => {
    const draftStream = createSequencedDraftStream(2001);
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onReplyStart?.();
        await replyOptions?.onAssistantMessageStart?.();
        await replyOptions?.onItemEvent?.({ kind: "search", progressText: "docs lookup" });
        await replyOptions?.onItemEvent?.({ progressText: "tests passed" });
        await replyOptions?.onAssistantMessageStart?.();
        await dispatcherOptions.deliver({ text: "Final after tool" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context: createContext(),
      streamMode: "progress",
      telegramCfg: { streaming: { mode: "progress", progress: { label: "Shelling" } } },
    });

    expect(draftStream.update).toHaveBeenCalledWith(
      expect.stringMatching(/^Shelling\n`🔎 Web Search: docs lookup`\n• `tests passed`$/),
    );
    expect(draftStream.forceNewMessage).not.toHaveBeenCalled();
    expect(draftStream.materialize).not.toHaveBeenCalled();
    expect(editMessageTelegram).toHaveBeenCalledWith(
      123,
      2001,
      "Final after tool",
      expect.any(Object),
    );
    expect(draftStream.clear).not.toHaveBeenCalled();
  });

  it("cleans up tool-only Telegram previews archived at assistant boundaries", async () => {
    const draftStream = createSequencedDraftStream(2001);
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await replyOptions?.onItemEvent?.({
        kind: "command",
        name: "exec",
        progressText: "exec git status",
      });
      await replyOptions?.onAssistantMessageStart?.();
      return { queuedFinal: false };
    });

    const bot = createBot();
    await dispatchWithContext({
      context: createContext(),
      streamMode: "partial",
      telegramCfg: { streaming: { mode: "partial" } },
      bot,
    });

    expect(draftStream.update).toHaveBeenCalledWith(
      expect.stringMatching(/`🛠️ Exec: exec git status`$/),
    );
    expect(draftStream.materialize).toHaveBeenCalled();
    expect(draftStream.forceNewMessage).toHaveBeenCalled();
    expect(bot.api.deleteMessage).toHaveBeenCalledWith(123, 2001);
  });

  it("streams Telegram command progress text by default when preview streaming is active", async () => {
    const draftStream = createDraftStream();
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await replyOptions?.onItemEvent?.({
        kind: "command",
        name: "exec",
        progressText: "exec ls ~/Desktop",
      });
      return { queuedFinal: false };
    });

    await dispatchWithContext({ context: createContext(), streamMode: "partial" });

    expect(draftStream.update).toHaveBeenCalledWith(
      expect.stringMatching(/\n`🛠️ Exec`\n`🛠️ Exec: exec ls ~\/Desktop`$/),
    );
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        replyOptions: expect.objectContaining({
          suppressDefaultToolProgressMessages: true,
        }),
      }),
    );
  });

  it("can hide Telegram command progress text by config", async () => {
    const draftStream = createDraftStream();
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await replyOptions?.onItemEvent?.({
        kind: "command",
        name: "exec",
        progressText: "exec ls ~/Desktop",
      });
      return { queuedFinal: false };
    });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "partial",
      telegramCfg: { streaming: { mode: "partial", preview: { commandText: "status" } } },
    });

    expect(draftStream.update).toHaveBeenCalledWith(expect.stringMatching(/\n`🛠️ Exec`$/));
    expect(draftStream.update.mock.calls.at(-1)?.[0]).not.toContain("exec ls");
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        replyOptions: expect.objectContaining({
          suppressDefaultToolProgressMessages: true,
        }),
      }),
    );
  });

  it("suppresses Telegram tool progress when explicitly disabled", async () => {
    const draftStream = createDraftStream();
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await replyOptions?.onItemEvent?.({ progressText: "exec ls ~/Desktop" });
      return { queuedFinal: false };
    });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "partial",
      telegramCfg: { streaming: { preview: { toolProgress: false } } },
    });

    expect(draftStream.update).not.toHaveBeenCalled();
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        replyOptions: expect.objectContaining({
          suppressDefaultToolProgressMessages: true,
        }),
      }),
    );
  });

  it("suppresses default tool progress messages when answer preview streaming is off", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await replyOptions?.onItemEvent?.({ progressText: "exec ls ~/Desktop" });
      return { queuedFinal: false };
    });

    await dispatchWithContext({ context: createContext(), streamMode: "off" });

    expect(createTelegramDraftStream).not.toHaveBeenCalled();
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        replyOptions: expect.objectContaining({
          suppressDefaultToolProgressMessages: true,
        }),
      }),
    );
  });

  it("keeps non-command Telegram tool progress links inside code formatting", async () => {
    const draftStream = createDraftStream();
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await replyOptions?.onItemEvent?.({
        kind: "search",
        progressText: "read [label](tg://user?id=123)",
      });
      return { queuedFinal: false };
    });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "partial",
    });

    const lastPreviewText = draftStream.update.mock.calls.at(-1)?.[0];
    expect(lastPreviewText).toMatch(
      /\n`🛠️ Exec`\n`🔎 Web Search: read \[label\]\(tg:\/\/user\?id=123\)`$/,
    );
    expect(renderTelegramHtmlText(lastPreviewText ?? "")).not.toContain("<a ");
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        replyOptions: expect.objectContaining({
          suppressDefaultToolProgressMessages: true,
        }),
      }),
    );
  });

  it("bounds Telegram tool progress markdown preview formatting", async () => {
    const draftStream = createDraftStream();
    createTelegramDraftStream.mockReturnValue(draftStream);
    const longProgress = `${"`".repeat(1000)}${"x".repeat(1000)}[label](tg://user?id=123)`;
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      await replyOptions?.onItemEvent?.({ progressText: longProgress });
      return { queuedFinal: false };
    });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "partial",
      telegramCfg: { streaming: { preview: { toolProgress: true } } },
    });

    const lastPreviewText = draftStream.update.mock.calls.at(-1)?.[0] ?? "";
    const progressLine = lastPreviewText.split("\n").at(1) ?? "";

    expect(lastPreviewText.length).toBeLessThan(340);
    expect(progressLine).toMatch(/^• `.*…`$/);
    expect(progressLine).toContain("…");
    expect(renderTelegramHtmlText(lastPreviewText)).not.toContain("<a ");
  });

  it("does not let Telegram tool progress backticks break out of code formatting", async () => {
    const draftStream = createDraftStream();
    createTelegramDraftStream.mockReturnValue(draftStream);
    const breakoutProgress = `${"`".repeat(10)} [label](tg://user?id=123)`;
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      await replyOptions?.onItemEvent?.({ progressText: breakoutProgress });
      return { queuedFinal: false };
    });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "partial",
      telegramCfg: { streaming: { preview: { toolProgress: true } } },
    });

    const lastPreviewText = draftStream.update.mock.calls.at(-1)?.[0] ?? "";

    expect(lastPreviewText).toContain(`• \`'''''''''' [label](tg://user?id=123)\``);
    expect(renderTelegramHtmlText(lastPreviewText)).not.toContain("<a ");
  });

  it("keeps block streaming enabled when account config enables it", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Hello" }, { kind: "final" });
      return { queuedFinal: true };
    });
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({
      context: createContext(),
      telegramCfg: { streaming: { block: { enabled: true } } },
    });

    expect(createTelegramDraftStream).not.toHaveBeenCalled();
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        replyOptions: expect.objectContaining({
          disableBlockStreaming: false,
          onPartialReply: undefined,
        }),
      }),
    );
  });

  it("sends error replies silently when silentErrorReplies is enabled", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "oops", isError: true }, { kind: "final" });
      return { queuedFinal: true };
    });
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({
      context: createContext(),
      telegramCfg: { silentErrorReplies: true },
    });

    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        silent: true,
        replies: [expect.objectContaining({ isError: true })],
      }),
    );
  });

  it("keeps error replies notifying by default", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "oops", isError: true }, { kind: "final" });
      return { queuedFinal: true };
    });
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({ context: createContext() });

    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        silent: false,
        replies: [expect.objectContaining({ isError: true })],
      }),
    );
  });

  it("keeps fallback replies silent after an error reply is skipped", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      dispatcherOptions.onSkip?.(
        { text: "oops", isError: true },
        { kind: "final", reason: "empty" },
      );
      return { queuedFinal: false };
    });
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({
      context: createContext(),
      telegramCfg: { silentErrorReplies: true },
    });

    expect(deliverReplies).toHaveBeenLastCalledWith(
      expect.objectContaining({
        silent: true,
        replies: [expect.objectContaining({ text: expect.any(String) })],
      }),
    );
  });

  it("keeps block streaming enabled when session reasoning level is on", async () => {
    loadSessionStore.mockReturnValue({
      s1: { reasoningLevel: "on" },
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Reasoning:\n_step_" }, { kind: "block" });
      await dispatcherOptions.deliver({ text: "Hello" }, { kind: "final" });
      return { queuedFinal: true };
    });
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({
      context: createContext({
        ctxPayload: { SessionKey: "s1" } as unknown as TelegramMessageContext["ctxPayload"],
      }),
    });

    expect(createTelegramDraftStream).not.toHaveBeenCalled();
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        replyOptions: expect.objectContaining({
          disableBlockStreaming: false,
        }),
      }),
    );
    expect(loadSessionStore).toHaveBeenCalledWith("/tmp/sessions.json", { skipCache: true });
    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [expect.objectContaining({ text: "Reasoning:\n_step_" })],
      }),
    );
  });

  it("streams reasoning draft updates even when answer stream mode is off", async () => {
    loadSessionStore.mockReturnValue({
      s1: { reasoningLevel: "stream" },
    });
    const reasoningDraftStream = createDraftStream(111);
    createTelegramDraftStream.mockImplementationOnce(() => reasoningDraftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onReasoningStream?.({ text: "Reasoning:\n_step_" });
        await dispatcherOptions.deliver({ text: "Hello" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({
      context: createContext({
        ctxPayload: { SessionKey: "s1" } as unknown as TelegramMessageContext["ctxPayload"],
      }),
      streamMode: "off",
    });

    expect(createTelegramDraftStream).toHaveBeenCalledTimes(1);
    expect(reasoningDraftStream.update).toHaveBeenCalledWith("Reasoning:\n_step_");
    expect(loadSessionStore).toHaveBeenCalledWith("/tmp/sessions.json", { skipCache: true });
  });

  it("does not expose reasoning preview callbacks unless session reasoning is stream", async () => {
    let seenReasoningCallback: unknown;
    const answerDraftStream = createDraftStream(999);
    createTelegramDraftStream.mockImplementationOnce(() => answerDraftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      seenReasoningCallback = replyOptions?.onReasoningStream;
      await replyOptions?.onPartialReply?.({
        text: "<think>internal chain of thought</think>Visible answer",
      });
      return { queuedFinal: false };
    });

    await dispatchWithContext({ context: createContext(), streamMode: "partial" });

    expect(seenReasoningCallback).toBeUndefined();
    expect(createTelegramDraftStream).toHaveBeenCalledTimes(1);
    expect(answerDraftStream.update).toHaveBeenCalledWith("Visible answer");
  });

  it("does not overwrite finalized preview when additional final payloads are sent", async () => {
    const draftStream = createDraftStream(999);
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Primary result" }, { kind: "final" });
      await dispatcherOptions.deliver(
        { text: "⚠️ Recovered tool error details" },
        { kind: "final" },
      );
      return { queuedFinal: true };
    });
    deliverReplies.mockResolvedValue({ delivered: true });
    editMessageTelegram.mockResolvedValue({ ok: true, chatId: "123", messageId: "999" });

    await dispatchWithContext({ context: createContext() });

    expect(editMessageTelegram).toHaveBeenCalledTimes(1);
    expect(editMessageTelegram).toHaveBeenCalledWith(
      123,
      999,
      "Primary result",
      expect.any(Object),
    );
    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [expect.objectContaining({ text: "⚠️ Recovered tool error details" })],
      }),
    );
    expect(draftStream.clear).not.toHaveBeenCalled();
    expect(draftStream.stop).toHaveBeenCalled();
  });

  it("emits only the internal message:sent hook when a final answer stays in preview", async () => {
    const draftStream = createDraftStream(999);
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Primary result" }, { kind: "final" });
      return { queuedFinal: true };
    });

    await dispatchWithContext({
      context: createContext({
        ctxPayload: { SessionKey: "s1" } as unknown as TelegramMessageContext["ctxPayload"],
      }),
    });

    expect(deliverReplies).not.toHaveBeenCalled();
    expect(editMessageTelegram).toHaveBeenCalledWith(
      123,
      999,
      "Primary result",
      expect.any(Object),
    );
    expect(emitInternalMessageSentHook).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKeyForInternalHooks: "s1",
        chatId: "123",
        content: "Primary result",
        success: true,
        messageId: 999,
      }),
    );
  });

  it("keeps streamed preview visible when final text regresses after a tool warning", async () => {
    const draftStream = createDraftStream(999);
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "Recovered final answer." });
        await dispatcherOptions.deliver(
          { text: "⚠️ Recovered tool error details", isError: true },
          { kind: "tool" },
        );
        await dispatcherOptions.deliver({ text: "Recovered final answer" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({ context: createContext(), streamMode: "partial" });

    // Regressive final ("answer." -> "answer") should keep the preview instead
    // of clearing it and leaving only the tool warning visible.
    expect(editMessageTelegram).not.toHaveBeenCalled();
    expect(deliverReplies).toHaveBeenCalledTimes(1);
    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [expect.objectContaining({ text: "⚠️ Recovered tool error details" })],
      }),
    );
    expect(draftStream.clear).not.toHaveBeenCalled();
    expect(draftStream.stop).toHaveBeenCalled();
  });

  it.each([
    { label: "default account config", telegramCfg: {} },
    {
      label: "account blockStreaming override",
      telegramCfg: { streaming: { block: { enabled: true } } },
    },
  ])("disables block streaming when streamMode is off ($label)", async ({ telegramCfg }) => {
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Hello" }, { kind: "final" });
      return { queuedFinal: true };
    });
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "off",
      telegramCfg,
    });

    expect(createTelegramDraftStream).not.toHaveBeenCalled();
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        replyOptions: expect.objectContaining({
          disableBlockStreaming: true,
        }),
      }),
    );
  });

  it("forces new message when assistant message restarts", async () => {
    const draftStream = createDraftStream(999);
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "First response" });
        await replyOptions?.onAssistantMessageStart?.();
        await replyOptions?.onPartialReply?.({ text: "After tool call" });
        await dispatcherOptions.deliver({ text: "After tool call" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({ context: createContext(), streamMode: "partial" });

    expect(draftStream.forceNewMessage).toHaveBeenCalledTimes(1);
  });

  it("materializes boundary preview and keeps it when no matching final arrives", async () => {
    const answerDraftStream = createDraftStream(999);
    answerDraftStream.materialize.mockResolvedValue(4321);
    const reasoningDraftStream = createDraftStream();
    createTelegramDraftStream
      .mockImplementationOnce(() => answerDraftStream)
      .mockImplementationOnce(() => reasoningDraftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      await replyOptions?.onPartialReply?.({ text: "Before tool boundary" });
      await replyOptions?.onAssistantMessageStart?.();
      return { queuedFinal: false };
    });

    const bot = createBot();
    await dispatchWithContext({ context: createContext(), streamMode: "partial", bot });

    expect(answerDraftStream.materialize).toHaveBeenCalledTimes(1);
    expect(answerDraftStream.forceNewMessage).toHaveBeenCalledTimes(1);
    expect(answerDraftStream.clear).toHaveBeenCalledTimes(1);
    const deleteMessageCalls = (
      bot.api as unknown as { deleteMessage: { mock: { calls: unknown[][] } } }
    ).deleteMessage.mock.calls;
    expect(deleteMessageCalls).not.toContainEqual([123, 4321]);
  });

  it("waits for queued boundary rotation before final lane delivery", async () => {
    const answerDraftStream = createSequencedDraftStream(1001);
    let resolveMaterialize: ((value: number | undefined) => void) | undefined;
    const materializePromise = new Promise<number | undefined>((resolve) => {
      resolveMaterialize = resolve;
    });
    answerDraftStream.materialize.mockImplementation(() => materializePromise);
    const reasoningDraftStream = createDraftStream();
    createTelegramDraftStream
      .mockImplementationOnce(() => answerDraftStream)
      .mockImplementationOnce(() => reasoningDraftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "Message A partial" });
        await dispatcherOptions.deliver({ text: "Message A final" }, { kind: "final" });
        const startPromise = replyOptions?.onAssistantMessageStart?.();
        const partialPromise = replyOptions?.onPartialReply?.({ text: "Message B partial" });
        const finalPromise = dispatcherOptions.deliver(
          { text: "Message B final" },
          { kind: "final" },
        );
        resolveMaterialize?.(1001);
        await startPromise;
        await partialPromise;
        await finalPromise;
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });
    editMessageTelegram.mockResolvedValue({ ok: true, chatId: "123", messageId: "1001" });

    await dispatchWithContext({ context: createContext(), streamMode: "partial" });

    expect(answerDraftStream.forceNewMessage).toHaveBeenCalledTimes(1);
    expect(editMessageTelegram).toHaveBeenCalledTimes(2);
    expect(editMessageTelegram).toHaveBeenNthCalledWith(
      2,
      123,
      1002,
      "Message B final",
      expect.any(Object),
    );
  });

  it("preserves pre-rotation skip until queued message-start callbacks flush", async () => {
    const answerDraftStream = createSequencedDraftStream(1001);
    const reasoningDraftStream = createDraftStream();
    createTelegramDraftStream
      .mockImplementationOnce(() => answerDraftStream)
      .mockImplementationOnce(() => reasoningDraftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "Message A partial" });
        await dispatcherOptions.deliver({ text: "Message A final" }, { kind: "final" });
        await replyOptions?.onPartialReply?.({ text: "Message B early" });
        void replyOptions?.onAssistantMessageStart?.();
        await dispatcherOptions.deliver({ text: "Message B final" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });
    editMessageTelegram.mockResolvedValue({ ok: true, chatId: "123", messageId: "1001" });

    await dispatchWithContext({ context: createContext(), streamMode: "partial" });

    expect(answerDraftStream.forceNewMessage).toHaveBeenCalledTimes(1);
    expect(editMessageTelegram).toHaveBeenNthCalledWith(
      1,
      123,
      1001,
      "Message A final",
      expect.any(Object),
    );
    expect(editMessageTelegram).toHaveBeenNthCalledWith(
      2,
      123,
      1002,
      "Message B final",
      expect.any(Object),
    );
  });

  it("does not double-rotate when assistant_message_start arrives after final delivery drains", async () => {
    const answerDraftStream = createSequencedDraftStream(1001);
    const reasoningDraftStream = createDraftStream();
    createTelegramDraftStream
      .mockImplementationOnce(() => answerDraftStream)
      .mockImplementationOnce(() => reasoningDraftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "Message A partial" });
        await dispatcherOptions.deliver({ text: "Message A final" }, { kind: "final" });
        await replyOptions?.onPartialReply?.({ text: "Message B early" });
        await dispatcherOptions.deliver({ text: "Message B final" }, { kind: "final" });
        await replyOptions?.onAssistantMessageStart?.();
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });
    editMessageTelegram.mockResolvedValue({ ok: true, chatId: "123", messageId: "1001" });

    await dispatchWithContext({ context: createContext(), streamMode: "partial" });

    expect(answerDraftStream.forceNewMessage).toHaveBeenCalledTimes(1);
    expect(editMessageTelegram).toHaveBeenNthCalledWith(
      1,
      123,
      1001,
      "Message A final",
      expect.any(Object),
    );
    expect(editMessageTelegram).toHaveBeenNthCalledWith(
      2,
      123,
      1002,
      "Message B final",
      expect.any(Object),
    );
  });

  it("clears active preview even when an unrelated boundary archive exists", async () => {
    const answerDraftStream = createDraftStream(999);
    answerDraftStream.materialize.mockResolvedValue(4321);
    answerDraftStream.forceNewMessage.mockImplementation(() => {
      answerDraftStream.setMessageId(5555);
    });
    const reasoningDraftStream = createDraftStream();
    createTelegramDraftStream
      .mockImplementationOnce(() => answerDraftStream)
      .mockImplementationOnce(() => reasoningDraftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      await replyOptions?.onPartialReply?.({ text: "Before tool boundary" });
      await replyOptions?.onAssistantMessageStart?.();
      await replyOptions?.onPartialReply?.({ text: "Unfinalized next preview" });
      return { queuedFinal: false };
    });

    const bot = createBot();
    await dispatchWithContext({ context: createContext(), streamMode: "partial", bot });

    expect(answerDraftStream.clear).toHaveBeenCalledTimes(1);
    const deleteMessageCalls = (
      bot.api as unknown as { deleteMessage: { mock: { calls: unknown[][] } } }
    ).deleteMessage.mock.calls;
    expect(deleteMessageCalls).not.toContainEqual([123, 4321]);
  });

  it("queues late partials behind async boundary materialization", async () => {
    const answerDraftStream = createDraftStream(999);
    let resolveMaterialize: ((value: number | undefined) => void) | undefined;
    const materializePromise = new Promise<number | undefined>((resolve) => {
      resolveMaterialize = resolve;
    });
    answerDraftStream.materialize.mockImplementation(() => materializePromise);
    const reasoningDraftStream = createDraftStream();
    createTelegramDraftStream
      .mockImplementationOnce(() => answerDraftStream)
      .mockImplementationOnce(() => reasoningDraftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      await replyOptions?.onPartialReply?.({ text: "Message A partial" });

      // Simulate provider fire-and-forget ordering: boundary callback starts
      // and a new partial arrives before boundary materialization resolves.
      const startPromise = replyOptions?.onAssistantMessageStart?.();
      const nextPartialPromise = replyOptions?.onPartialReply?.({ text: "Message B early" });

      expect(answerDraftStream.update).toHaveBeenCalledTimes(1);
      resolveMaterialize?.(4321);

      await startPromise;
      await nextPartialPromise;
      return { queuedFinal: false };
    });

    await dispatchWithContext({ context: createContext(), streamMode: "partial" });

    expect(answerDraftStream.materialize).toHaveBeenCalledTimes(1);
    expect(answerDraftStream.forceNewMessage).toHaveBeenCalledTimes(1);
    expect(answerDraftStream.update).toHaveBeenCalledTimes(2);
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(2, "Message B early");
    const boundaryRotationOrder = answerDraftStream.forceNewMessage.mock.invocationCallOrder[0];
    const secondUpdateOrder = answerDraftStream.update.mock.invocationCallOrder[1];
    expect(boundaryRotationOrder).toBeLessThan(secondUpdateOrder);
  });

  it("sends final-only text without creating a synthetic preview before real partials", async () => {
    const answerDraftStream = createSequencedDraftStream(1001);
    const reasoningDraftStream = createDraftStream();
    createTelegramDraftStream
      .mockImplementationOnce(() => answerDraftStream)
      .mockImplementationOnce(() => reasoningDraftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        // Final-only first response (no streamed partials).
        await dispatcherOptions.deliver({ text: "Message A final" }, { kind: "final" });
        // Simulate provider ordering bug: first chunk arrives before message-start callback.
        await replyOptions?.onPartialReply?.({ text: "Message B early" });
        await replyOptions?.onAssistantMessageStart?.();
        await replyOptions?.onPartialReply?.({ text: "Message B partial" });
        await dispatcherOptions.deliver({ text: "Message B final" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });
    editMessageTelegram.mockResolvedValue({ ok: true, chatId: "123", messageId: "1001" });

    await dispatchWithContext({ context: createContext(), streamMode: "partial" });

    expect(answerDraftStream.forceNewMessage).toHaveBeenCalledTimes(1);
    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [expect.objectContaining({ text: "Message A final" })],
      }),
    );
    expect(editMessageTelegram).toHaveBeenCalledTimes(1);
    expect(editMessageTelegram).toHaveBeenNthCalledWith(
      1,
      123,
      1001,
      "Message B final",
      expect.any(Object),
    );
  });

  it("uses the active preview as the first chunk for long text finals", async () => {
    const answerDraftStream = createSequencedDraftStream(1001);
    const reasoningDraftStream = createDraftStream();
    createTelegramDraftStream
      .mockImplementationOnce(() => answerDraftStream)
      .mockImplementationOnce(() => reasoningDraftStream);
    const finalText = `${"A".repeat(70)}${"B".repeat(70)}`;
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "Working preview" });
        await dispatcherOptions.deliver({ text: finalText, replyToId: "456" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });
    editMessageTelegram.mockResolvedValue({ ok: true, chatId: "123", messageId: "1001" });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "partial",
      textLimit: 80,
    });

    const editedText = editMessageTelegram.mock.calls[0]?.[2] as string;
    const followUpText =
      (deliverReplies.mock.calls[0]?.[0] as { replies?: Array<{ text?: string }> })?.replies?.[0]
        ?.text ?? "";

    expect(editMessageTelegram).toHaveBeenCalledTimes(1);
    expect(editedText.length).toBeLessThanOrEqual(80);
    expect(followUpText.length).toBeGreaterThan(0);
    expect(`${editedText}${followUpText}`).toBe(finalText);
    expect(deliverReplies).toHaveBeenCalledTimes(1);
    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [expect.not.objectContaining({ replyToId: expect.any(String) })],
      }),
    );
    expect(answerDraftStream.clear).not.toHaveBeenCalled();
  });

  it("uses the active preview as the first chunk for three-chunk long text finals", async () => {
    const answerDraftStream = createSequencedDraftStream(1001);
    const reasoningDraftStream = createDraftStream();
    createTelegramDraftStream
      .mockImplementationOnce(() => answerDraftStream)
      .mockImplementationOnce(() => reasoningDraftStream);
    const finalText = `${"A".repeat(70)}${"B".repeat(70)}${"C".repeat(70)}`;
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "Working preview" });
        await dispatcherOptions.deliver({ text: finalText, replyToId: "456" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });
    editMessageTelegram.mockResolvedValue({ ok: true, chatId: "123", messageId: "1001" });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "partial",
      textLimit: 80,
    });

    const editedText = editMessageTelegram.mock.calls[0]?.[2] as string;
    const followUpReplies =
      (deliverReplies.mock.calls[0]?.[0] as { replies?: Array<{ text?: string }> })?.replies ?? [];
    const followUpText = followUpReplies.map((reply) => reply.text ?? "").join("");

    expect(editMessageTelegram).toHaveBeenCalledTimes(1);
    expect(editedText.length).toBeLessThanOrEqual(80);
    expect(followUpReplies).toHaveLength(1);
    expect(followUpText.length).toBeGreaterThan(80);
    expect(`${editedText}${followUpText}`).toBe(finalText);
    expect(deliverReplies).toHaveBeenCalledTimes(1);
    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [expect.not.objectContaining({ replyToId: expect.any(String) })],
      }),
    );
    expect(answerDraftStream.clear).not.toHaveBeenCalled();
  });

  it("does not force new message on first assistant message start", async () => {
    const draftStream = createDraftStream(999);
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        // First assistant message starts (no previous output)
        await replyOptions?.onAssistantMessageStart?.();
        // Partial updates
        await replyOptions?.onPartialReply?.({ text: "Hello" });
        await replyOptions?.onPartialReply?.({ text: "Hello world" });
        await dispatcherOptions.deliver({ text: "Hello world" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({ context: createContext(), streamMode: "block" });

    // First message start shouldn't trigger forceNewMessage (no previous output)
    expect(draftStream.forceNewMessage).not.toHaveBeenCalled();
  });

  it("rotates before a late second-message partial so finalized preview is not overwritten", async () => {
    const answerDraftStream = createSequencedDraftStream(1001);
    const reasoningDraftStream = createDraftStream();
    createTelegramDraftStream
      .mockImplementationOnce(() => answerDraftStream)
      .mockImplementationOnce(() => reasoningDraftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "Message A partial" });
        await dispatcherOptions.deliver({ text: "Message A final" }, { kind: "final" });
        // Simulate provider ordering bug: first chunk arrives before message-start callback.
        await replyOptions?.onPartialReply?.({ text: "Message B early" });
        await replyOptions?.onAssistantMessageStart?.();
        await replyOptions?.onPartialReply?.({ text: "Message B partial" });
        await dispatcherOptions.deliver({ text: "Message B final" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });
    editMessageTelegram.mockResolvedValue({ ok: true, chatId: "123", messageId: "1001" });

    await dispatchWithContext({ context: createContext(), streamMode: "partial" });

    expect(answerDraftStream.forceNewMessage).toHaveBeenCalledTimes(1);
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(2, "Message B early");
    const boundaryRotationOrder = answerDraftStream.forceNewMessage.mock.invocationCallOrder[0];
    const secondUpdateOrder = answerDraftStream.update.mock.invocationCallOrder[1];
    expect(boundaryRotationOrder).toBeLessThan(secondUpdateOrder);
    expect(editMessageTelegram).toHaveBeenNthCalledWith(
      1,
      123,
      1001,
      "Message A final",
      expect.any(Object),
    );
    expect(editMessageTelegram).toHaveBeenNthCalledWith(
      2,
      123,
      1002,
      "Message B final",
      expect.any(Object),
    );
  });

  it("does not skip message-start rotation when pre-rotation did not force a new message", async () => {
    const answerDraftStream = createSequencedDraftStream(1002);
    answerDraftStream.setMessageId(1001);
    const reasoningDraftStream = createDraftStream();
    createTelegramDraftStream
      .mockImplementationOnce(() => answerDraftStream)
      .mockImplementationOnce(() => reasoningDraftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        // First message has only final text (no streamed partials), so answer lane
        // reaches finalized state with hasStreamedMessage still false.
        await dispatcherOptions.deliver({ text: "Message A final" }, { kind: "final" });
        // Provider ordering bug: next message partial arrives before message-start.
        await replyOptions?.onPartialReply?.({ text: "Message B early" });
        await replyOptions?.onAssistantMessageStart?.();
        await replyOptions?.onPartialReply?.({ text: "Message B partial" });
        await dispatcherOptions.deliver({ text: "Message B final" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });
    editMessageTelegram.mockResolvedValue({ ok: true, chatId: "123", messageId: "1001" });
    const bot = createBot();

    await dispatchWithContext({ context: createContext(), streamMode: "partial", bot });

    // Early pre-rotation could not force (no streamed partials yet), so the
    // real assistant message_start must still rotate once.
    expect(answerDraftStream.forceNewMessage).toHaveBeenCalledTimes(1);
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(1, "Message B early");
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(2, "Message B partial");
    const earlyUpdateOrder = answerDraftStream.update.mock.invocationCallOrder[0];
    const boundaryRotationOrder = answerDraftStream.forceNewMessage.mock.invocationCallOrder[0];
    const secondUpdateOrder = answerDraftStream.update.mock.invocationCallOrder[1];
    expect(earlyUpdateOrder).toBeLessThan(boundaryRotationOrder);
    expect(boundaryRotationOrder).toBeLessThan(secondUpdateOrder);
    expect(editMessageTelegram).toHaveBeenNthCalledWith(
      1,
      123,
      1001,
      "Message A final",
      expect.any(Object),
    );
    expect(editMessageTelegram).toHaveBeenNthCalledWith(
      2,
      123,
      1002,
      "Message B final",
      expect.any(Object),
    );
    expect((bot.api.deleteMessage as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it("does not trigger late pre-rotation mid-message after an explicit assistant message start", async () => {
    const answerDraftStream = createDraftStream(1001);
    const reasoningDraftStream = createDraftStream();
    createTelegramDraftStream
      .mockImplementationOnce(() => answerDraftStream)
      .mockImplementationOnce(() => reasoningDraftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        // Message A finalizes without streamed partials.
        await dispatcherOptions.deliver({ text: "Message A final" }, { kind: "final" });
        // Message B starts normally before partials.
        await replyOptions?.onAssistantMessageStart?.();
        await replyOptions?.onPartialReply?.({ text: "Message B first chunk" });
        await replyOptions?.onPartialReply?.({ text: "Message B second chunk" });
        await dispatcherOptions.deliver({ text: "Message B final" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });
    editMessageTelegram.mockResolvedValue({ ok: true, chatId: "123", messageId: "1001" });

    await dispatchWithContext({ context: createContext(), streamMode: "partial" });

    // The explicit message_start boundary must clear finalized state so
    // same-message partials do not force a new preview mid-stream.
    expect(answerDraftStream.forceNewMessage).not.toHaveBeenCalled();
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(1, "Message B first chunk");
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(2, "Message B second chunk");
  });

  it("does not rotate the streamed preview when compaction retries replay the same assistant message", async () => {
    const answerDraftStream = createSequencedDraftStream(1001);
    const reasoningDraftStream = createDraftStream();
    createTelegramDraftStream
      .mockImplementationOnce(() => answerDraftStream)
      .mockImplementationOnce(() => reasoningDraftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "Message A partial" });
        await replyOptions?.onCompactionStart?.();
        await replyOptions?.onCompactionEnd?.();
        await replyOptions?.onAssistantMessageStart?.();
        await replyOptions?.onPartialReply?.({ text: "Message A partial" });
        await replyOptions?.onPartialReply?.({ text: "Message A partial extended" });
        await dispatcherOptions.deliver({ text: "Message A final" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });
    editMessageTelegram.mockResolvedValue({ ok: true, chatId: "123", messageId: "1001" });

    await dispatchWithContext({ context: createContext(), streamMode: "partial" });

    expect(answerDraftStream.forceNewMessage).not.toHaveBeenCalled();
    expect(answerDraftStream.materialize).not.toHaveBeenCalled();
    expect(editMessageTelegram).toHaveBeenCalledTimes(1);
    expect(editMessageTelegram).toHaveBeenCalledWith(
      123,
      1001,
      "Message A final",
      expect.any(Object),
    );
  });

  it("clears the compaction replay skip after the retried message finalizes", async () => {
    const answerDraftStream = createSequencedDraftStream(1001);
    const reasoningDraftStream = createDraftStream();
    createTelegramDraftStream
      .mockImplementationOnce(() => answerDraftStream)
      .mockImplementationOnce(() => reasoningDraftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "Message A partial" });
        await replyOptions?.onCompactionStart?.();
        await replyOptions?.onCompactionEnd?.();
        await replyOptions?.onAssistantMessageStart?.();
        await replyOptions?.onPartialReply?.({ text: "Message A partial extended" });
        await dispatcherOptions.deliver({ text: "Message A final" }, { kind: "final" });
        await replyOptions?.onAssistantMessageStart?.();
        await replyOptions?.onPartialReply?.({ text: "Message B partial" });
        await dispatcherOptions.deliver({ text: "Message B final" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });
    editMessageTelegram.mockResolvedValue({ ok: true, chatId: "123", messageId: "1001" });

    await dispatchWithContext({ context: createContext(), streamMode: "partial" });

    expect(answerDraftStream.forceNewMessage).toHaveBeenCalledTimes(1);
    expect(editMessageTelegram).toHaveBeenNthCalledWith(
      1,
      123,
      1001,
      "Message A final",
      expect.any(Object),
    );
    expect(editMessageTelegram).toHaveBeenNthCalledWith(
      2,
      123,
      1002,
      "Message B final",
      expect.any(Object),
    );
  });

  it("preserves the compaction replay flag until queued retry callbacks flush", async () => {
    const answerDraftStream = createSequencedDraftStream(1001);
    const reasoningDraftStream = createDraftStream();
    createTelegramDraftStream
      .mockImplementationOnce(() => answerDraftStream)
      .mockImplementationOnce(() => reasoningDraftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "Message A partial" });
        await replyOptions?.onCompactionStart?.();
        await replyOptions?.onCompactionEnd?.();
        void replyOptions?.onAssistantMessageStart?.();
        await dispatcherOptions.deliver({ text: "Message A final" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });
    editMessageTelegram.mockResolvedValue({ ok: true, chatId: "123", messageId: "1001" });

    await dispatchWithContext({ context: createContext(), streamMode: "partial" });

    expect(answerDraftStream.forceNewMessage).not.toHaveBeenCalled();
    expect(editMessageTelegram).toHaveBeenCalledTimes(1);
    expect(editMessageTelegram).toHaveBeenCalledWith(
      123,
      1001,
      "Message A final",
      expect.any(Object),
    );
  });

  it("keeps the existing preview when the retried answer only arrives as final text", async () => {
    const answerDraftStream = createSequencedDraftStream(1001);
    const reasoningDraftStream = createDraftStream();
    createTelegramDraftStream
      .mockImplementationOnce(() => answerDraftStream)
      .mockImplementationOnce(() => reasoningDraftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "Message A partial" });
        await replyOptions?.onCompactionStart?.();
        await replyOptions?.onCompactionEnd?.();
        await replyOptions?.onAssistantMessageStart?.();
        await dispatcherOptions.deliver({ text: "Message B final" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });
    editMessageTelegram.mockResolvedValue({ ok: true, chatId: "123", messageId: "1001" });

    await dispatchWithContext({ context: createContext(), streamMode: "partial" });

    expect(answerDraftStream.forceNewMessage).not.toHaveBeenCalled();
    expect(answerDraftStream.materialize).not.toHaveBeenCalled();
    expect(editMessageTelegram).toHaveBeenCalledTimes(1);
    expect(editMessageTelegram).toHaveBeenCalledWith(
      123,
      1001,
      "Message B final",
      expect.any(Object),
    );
  });

  it("keeps the transient preview when a local exec approval prompt is suppressed after compaction", async () => {
    const answerDraftStream = createSequencedDraftStream(1001);
    const reasoningDraftStream = createDraftStream();
    createTelegramDraftStream
      .mockImplementationOnce(() => answerDraftStream)
      .mockImplementationOnce(() => reasoningDraftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "Message A partial" });
        await replyOptions?.onCompactionStart?.();
        await replyOptions?.onCompactionEnd?.();
        await dispatcherOptions.deliver(
          {
            text: "Approval required.\n\n```txt\n/approve 7f423fdc allow-once\n```",
            channelData: {
              execApproval: {
                approvalId: "7f423fdc-1111-2222-3333-444444444444",
                approvalSlug: "7f423fdc",
                allowedDecisions: ["allow-once", "allow-always", "deny"],
              },
            },
          },
          { kind: "tool" },
        );
        await replyOptions?.onAssistantMessageStart?.();
        await replyOptions?.onPartialReply?.({ text: "Message B partial" });
        await dispatcherOptions.deliver({ text: "Message B final" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });
    editMessageTelegram.mockResolvedValue({ ok: true, chatId: "123", messageId: "1001" });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "partial",
      cfg: {
        channels: {
          telegram: {
            execApprovals: {
              enabled: true,
              approvers: ["12345"],
              target: "dm",
            },
          },
        },
      },
    });

    expect(answerDraftStream.forceNewMessage).not.toHaveBeenCalled();
    expect(editMessageTelegram).toHaveBeenCalledTimes(1);
    expect(editMessageTelegram).toHaveBeenCalledWith(
      123,
      1001,
      "Message B final",
      expect.any(Object),
    );
  });

  it("rotates after a visible tool payload lands between compaction and the next assistant message", async () => {
    const answerDraftStream = createSequencedDraftStream(1001);
    const reasoningDraftStream = createDraftStream();
    createTelegramDraftStream
      .mockImplementationOnce(() => answerDraftStream)
      .mockImplementationOnce(() => reasoningDraftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "Message A partial" });
        await replyOptions?.onCompactionStart?.();
        await replyOptions?.onCompactionEnd?.();
        await dispatcherOptions.deliver(
          { mediaUrl: "file:///tmp/tool-result.png" },
          { kind: "tool" },
        );
        await replyOptions?.onAssistantMessageStart?.();
        await replyOptions?.onPartialReply?.({ text: "Message B partial" });
        await dispatcherOptions.deliver({ text: "Message B final" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });
    editMessageTelegram.mockResolvedValue({ ok: true, chatId: "123", messageId: "1001" });

    await dispatchWithContext({ context: createContext(), streamMode: "partial" });

    expect(answerDraftStream.forceNewMessage).toHaveBeenCalledTimes(1);
    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [expect.objectContaining({ mediaUrl: "file:///tmp/tool-result.png" })],
      }),
    );
    expect(editMessageTelegram).toHaveBeenCalledTimes(1);
    expect(editMessageTelegram).toHaveBeenCalledWith(
      123,
      expect.any(Number),
      "Message B final",
      expect.any(Object),
    );
  });

  it("finalizes multi-message assistant stream to matching preview messages in order", async () => {
    const answerDraftStream = createSequencedDraftStream(1001);
    const reasoningDraftStream = createDraftStream();
    createTelegramDraftStream
      .mockImplementationOnce(() => answerDraftStream)
      .mockImplementationOnce(() => reasoningDraftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "Message A partial" });
        await replyOptions?.onAssistantMessageStart?.();
        await replyOptions?.onPartialReply?.({ text: "Message B partial" });
        await replyOptions?.onAssistantMessageStart?.();
        await replyOptions?.onPartialReply?.({ text: "Message C partial" });

        await dispatcherOptions.deliver({ text: "Message A final" }, { kind: "final" });
        await dispatcherOptions.deliver({ text: "Message B final" }, { kind: "final" });
        await dispatcherOptions.deliver({ text: "Message C final" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });
    editMessageTelegram.mockResolvedValue({ ok: true, chatId: "123", messageId: "1001" });

    await dispatchWithContext({ context: createContext(), streamMode: "partial" });

    expect(answerDraftStream.forceNewMessage).toHaveBeenCalledTimes(2);
    expect(editMessageTelegram).toHaveBeenNthCalledWith(
      1,
      123,
      1001,
      "Message A final",
      expect.any(Object),
    );
    expect(editMessageTelegram).toHaveBeenNthCalledWith(
      2,
      123,
      1002,
      "Message B final",
      expect.any(Object),
    );
    expect(editMessageTelegram).toHaveBeenNthCalledWith(
      3,
      123,
      1003,
      "Message C final",
      expect.any(Object),
    );
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("maps finals correctly when first preview id resolves after message boundary", async () => {
    let answerMessageId: number | undefined;
    let answerDraftParams:
      | {
          onSupersededPreview?: (preview: { messageId: number; textSnapshot: string }) => void;
        }
      | undefined;
    const answerDraftStream = {
      update: vi.fn().mockImplementation((text: string) => {
        if (text.includes("Message B")) {
          answerMessageId = 1002;
        }
      }),
      flush: vi.fn().mockResolvedValue(undefined),
      messageId: vi.fn().mockImplementation(() => answerMessageId),
      clear: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      forceNewMessage: vi.fn().mockImplementation(() => {
        answerMessageId = undefined;
      }),
    };
    const reasoningDraftStream = createDraftStream();
    createTelegramDraftStream
      .mockImplementationOnce((params) => {
        answerDraftParams = params as typeof answerDraftParams;
        return answerDraftStream;
      })
      .mockImplementationOnce(() => reasoningDraftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "Message A partial" });
        await replyOptions?.onAssistantMessageStart?.();
        await replyOptions?.onPartialReply?.({ text: "Message B partial" });
        // Simulate late resolution of message A preview ID after boundary rotation.
        answerDraftParams?.onSupersededPreview?.({
          messageId: 1001,
          textSnapshot: "Message A partial",
        });

        await dispatcherOptions.deliver({ text: "Message A final" }, { kind: "final" });
        await dispatcherOptions.deliver({ text: "Message B final" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });
    editMessageTelegram.mockResolvedValue({ ok: true, chatId: "123", messageId: "1001" });

    await dispatchWithContext({ context: createContext(), streamMode: "partial" });

    expect(editMessageTelegram).toHaveBeenNthCalledWith(
      1,
      123,
      1001,
      "Message A final",
      expect.any(Object),
    );
    expect(editMessageTelegram).toHaveBeenNthCalledWith(
      2,
      123,
      1002,
      "Message B final",
      expect.any(Object),
    );
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("keeps the active preview when an archived final edit target is missing", async () => {
    let answerMessageId: number | undefined;
    let answerDraftParams:
      | {
          onSupersededPreview?: (preview: { messageId: number; textSnapshot: string }) => void;
        }
      | undefined;
    const answerDraftStream = {
      update: vi.fn().mockImplementation((text: string) => {
        if (text.includes("Message B")) {
          answerMessageId = 1002;
        }
      }),
      flush: vi.fn().mockResolvedValue(undefined),
      messageId: vi.fn().mockImplementation(() => answerMessageId),
      clear: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      forceNewMessage: vi.fn().mockImplementation(() => {
        answerMessageId = undefined;
      }),
    };
    const reasoningDraftStream = createDraftStream();
    createTelegramDraftStream
      .mockImplementationOnce((params) => {
        answerDraftParams = params as typeof answerDraftParams;
        return answerDraftStream;
      })
      .mockImplementationOnce(() => reasoningDraftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "Message A partial" });
        await replyOptions?.onAssistantMessageStart?.();
        await replyOptions?.onPartialReply?.({ text: "Message B partial" });
        answerDraftParams?.onSupersededPreview?.({
          messageId: 1001,
          textSnapshot: "Message A partial",
        });

        await dispatcherOptions.deliver({ text: "Message A final" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });
    editMessageTelegram.mockRejectedValue(new Error("400: Bad Request: message to edit not found"));

    await dispatchWithContext({ context: createContext(), streamMode: "partial" });

    expect(editMessageTelegram).toHaveBeenCalledWith(
      123,
      1001,
      "Message A final",
      expect.any(Object),
    );
    expect(answerDraftStream.clear).not.toHaveBeenCalled();
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("still finalizes the active preview after an archived final edit is retained", async () => {
    let answerMessageId: number | undefined;
    let answerDraftParams:
      | {
          onSupersededPreview?: (preview: { messageId: number; textSnapshot: string }) => void;
        }
      | undefined;
    const answerDraftStream = {
      update: vi.fn().mockImplementation((text: string) => {
        if (text.includes("Message B")) {
          answerMessageId = 1002;
        }
      }),
      flush: vi.fn().mockResolvedValue(undefined),
      messageId: vi.fn().mockImplementation(() => answerMessageId),
      clear: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      forceNewMessage: vi.fn().mockImplementation(() => {
        answerMessageId = undefined;
      }),
    };
    const reasoningDraftStream = createDraftStream();
    createTelegramDraftStream
      .mockImplementationOnce((params) => {
        answerDraftParams = params as typeof answerDraftParams;
        return answerDraftStream;
      })
      .mockImplementationOnce(() => reasoningDraftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "Message A partial" });
        await replyOptions?.onAssistantMessageStart?.();
        await replyOptions?.onPartialReply?.({ text: "Message B partial" });
        answerDraftParams?.onSupersededPreview?.({
          messageId: 1001,
          textSnapshot: "Message A partial",
        });

        await dispatcherOptions.deliver({ text: "Message A final" }, { kind: "final" });
        await dispatcherOptions.deliver({ text: "Message B final" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });
    editMessageTelegram
      .mockRejectedValueOnce(new Error("400: Bad Request: message to edit not found"))
      .mockResolvedValueOnce({ ok: true, chatId: "123", messageId: "1002" });

    await dispatchWithContext({ context: createContext(), streamMode: "partial" });

    expect(editMessageTelegram).toHaveBeenNthCalledWith(
      1,
      123,
      1001,
      "Message A final",
      expect.any(Object),
    );
    expect(editMessageTelegram).toHaveBeenNthCalledWith(
      2,
      123,
      1002,
      "Message B final",
      expect.any(Object),
    );
    expect(answerDraftStream.clear).not.toHaveBeenCalled();
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("clears the active preview when a later final falls back after archived retain", async () => {
    let answerMessageId: number | undefined;
    let answerDraftParams:
      | {
          onSupersededPreview?: (preview: { messageId: number; textSnapshot: string }) => void;
        }
      | undefined;
    const answerDraftStream = {
      update: vi.fn().mockImplementation((text: string) => {
        if (text.includes("Message B")) {
          answerMessageId = 1002;
        }
      }),
      flush: vi.fn().mockResolvedValue(undefined),
      messageId: vi.fn().mockImplementation(() => answerMessageId),
      clear: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      forceNewMessage: vi.fn().mockImplementation(() => {
        answerMessageId = undefined;
      }),
    };
    const reasoningDraftStream = createDraftStream();
    createTelegramDraftStream
      .mockImplementationOnce((params) => {
        answerDraftParams = params as typeof answerDraftParams;
        return answerDraftStream;
      })
      .mockImplementationOnce(() => reasoningDraftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "Message A partial" });
        await replyOptions?.onAssistantMessageStart?.();
        await replyOptions?.onPartialReply?.({ text: "Message B partial" });
        answerDraftParams?.onSupersededPreview?.({
          messageId: 1001,
          textSnapshot: "Message A partial",
        });

        await dispatcherOptions.deliver({ text: "Message A final" }, { kind: "final" });
        await dispatcherOptions.deliver({ text: "Message B final" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });
    const preConnectErr = new Error("connect ECONNREFUSED 149.154.167.220:443");
    (preConnectErr as NodeJS.ErrnoException).code = "ECONNREFUSED";
    editMessageTelegram
      .mockRejectedValueOnce(new Error("400: Bad Request: message to edit not found"))
      .mockRejectedValueOnce(preConnectErr);

    await dispatchWithContext({ context: createContext(), streamMode: "partial" });

    expect(editMessageTelegram).toHaveBeenNthCalledWith(
      1,
      123,
      1001,
      "Message A final",
      expect.any(Object),
    );
    expect(editMessageTelegram).toHaveBeenNthCalledWith(
      2,
      123,
      1002,
      "Message B final",
      expect.any(Object),
    );
    const finalTextSentViaDeliverReplies = deliverReplies.mock.calls.some((call: unknown[]) =>
      (call[0] as { replies?: Array<{ text?: string }> })?.replies?.some(
        (r: { text?: string }) => r.text === "Message B final",
      ),
    );
    expect(finalTextSentViaDeliverReplies).toBe(true);
    expect(answerDraftStream.clear).toHaveBeenCalledTimes(1);
  });

  it("keeps finalized text preview when the next assistant message is media-only", async () => {
    let answerMessageId: number | undefined = 1001;
    const answerDraftStream = {
      update: vi.fn(),
      flush: vi.fn().mockResolvedValue(undefined),
      messageId: vi.fn().mockImplementation(() => answerMessageId),
      clear: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      forceNewMessage: vi.fn().mockImplementation(() => {
        answerMessageId = undefined;
      }),
    };
    const reasoningDraftStream = createDraftStream();
    createTelegramDraftStream
      .mockImplementationOnce(() => answerDraftStream)
      .mockImplementationOnce(() => reasoningDraftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "First message preview" });
        await dispatcherOptions.deliver({ text: "First message final" }, { kind: "final" });
        await replyOptions?.onAssistantMessageStart?.();
        await dispatcherOptions.deliver({ mediaUrl: "file:///tmp/voice.ogg" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });
    editMessageTelegram.mockResolvedValue({ ok: true, chatId: "123", messageId: "1001" });
    const bot = createBot();

    await dispatchWithContext({ context: createContext(), streamMode: "partial", bot });

    expect(editMessageTelegram).toHaveBeenCalledWith(
      123,
      1001,
      "First message final",
      expect.any(Object),
    );
    const deleteMessageCalls = (
      bot.api as unknown as { deleteMessage: { mock: { calls: unknown[][] } } }
    ).deleteMessage.mock.calls;
    expect(deleteMessageCalls).not.toContainEqual([123, 1001]);
  });

  it("maps finals correctly when archived preview id arrives during final flush", async () => {
    let answerMessageId: number | undefined;
    let answerDraftParams:
      | {
          onSupersededPreview?: (preview: { messageId: number; textSnapshot: string }) => void;
        }
      | undefined;
    let emittedSupersededPreview = false;
    const answerDraftStream = {
      update: vi.fn().mockImplementation((text: string) => {
        if (text.includes("Message B")) {
          answerMessageId = 1002;
        }
      }),
      flush: vi.fn().mockImplementation(async () => {
        if (!emittedSupersededPreview) {
          emittedSupersededPreview = true;
          answerDraftParams?.onSupersededPreview?.({
            messageId: 1001,
            textSnapshot: "Message A partial",
          });
        }
      }),
      messageId: vi.fn().mockImplementation(() => answerMessageId),
      clear: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      forceNewMessage: vi.fn().mockImplementation(() => {
        answerMessageId = undefined;
      }),
    };
    const reasoningDraftStream = createDraftStream();
    createTelegramDraftStream
      .mockImplementationOnce((params) => {
        answerDraftParams = params as typeof answerDraftParams;
        return answerDraftStream;
      })
      .mockImplementationOnce(() => reasoningDraftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "Message A partial" });
        await replyOptions?.onAssistantMessageStart?.();
        await replyOptions?.onPartialReply?.({ text: "Message B partial" });
        await dispatcherOptions.deliver({ text: "Message A final" }, { kind: "final" });
        await dispatcherOptions.deliver({ text: "Message B final" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });
    editMessageTelegram.mockResolvedValue({ ok: true, chatId: "123", messageId: "1001" });

    await dispatchWithContext({ context: createContext(), streamMode: "partial" });

    expect(editMessageTelegram).toHaveBeenNthCalledWith(
      1,
      123,
      1001,
      "Message A final",
      expect.any(Object),
    );
    expect(editMessageTelegram).toHaveBeenNthCalledWith(
      2,
      123,
      1002,
      "Message B final",
      expect.any(Object),
    );
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("splits reasoning lane only when a later reasoning block starts", async () => {
    const { reasoningDraftStream } = setupDraftStreams({
      answerMessageId: 999,
      reasoningMessageId: 111,
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onReasoningStream?.({ text: "Reasoning:\n_first block_" });
        await replyOptions?.onReasoningEnd?.();
        expect(reasoningDraftStream.forceNewMessage).not.toHaveBeenCalled();
        await replyOptions?.onPartialReply?.({ text: "checking files..." });
        await replyOptions?.onReasoningStream?.({ text: "Reasoning:\n_second block_" });
        await dispatcherOptions.deliver({ text: "Done" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });
    editMessageTelegram.mockResolvedValue({ ok: true, chatId: "123", messageId: "999" });

    await dispatchWithContext({ context: createReasoningStreamContext(), streamMode: "partial" });

    expect(reasoningDraftStream.forceNewMessage).toHaveBeenCalledTimes(1);
  });

  it("queues reasoning-end split decisions behind queued reasoning deltas", async () => {
    const { reasoningDraftStream } = setupDraftStreams({
      answerMessageId: 999,
      reasoningMessageId: 111,
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        // Simulate fire-and-forget upstream ordering: reasoning_end arrives
        // before the queued reasoning delta callback has finished.
        const firstReasoningPromise = replyOptions?.onReasoningStream?.({
          text: "Reasoning:\n_first block_",
        });
        await replyOptions?.onReasoningEnd?.();
        await firstReasoningPromise;
        await replyOptions?.onReasoningStream?.({ text: "Reasoning:\n_second block_" });
        await dispatcherOptions.deliver({ text: "Done" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({ context: createReasoningStreamContext(), streamMode: "partial" });

    expect(reasoningDraftStream.forceNewMessage).toHaveBeenCalledTimes(1);
  });

  it("cleans superseded reasoning previews after lane rotation", async () => {
    let reasoningDraftParams:
      | {
          onSupersededPreview?: (preview: { messageId: number; textSnapshot: string }) => void;
        }
      | undefined;
    const answerDraftStream = createDraftStream(999);
    const reasoningDraftStream = createDraftStream(111);
    createTelegramDraftStream
      .mockImplementationOnce(() => answerDraftStream)
      .mockImplementationOnce((params) => {
        reasoningDraftParams = params as typeof reasoningDraftParams;
        return reasoningDraftStream;
      });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onReasoningStream?.({ text: "Reasoning:\n_first block_" });
        await replyOptions?.onReasoningEnd?.();
        await replyOptions?.onReasoningStream?.({ text: "Reasoning:\n_second block_" });
        reasoningDraftParams?.onSupersededPreview?.({
          messageId: 4444,
          textSnapshot: "Reasoning:\n_first block_",
        });
        await dispatcherOptions.deliver({ text: "Done" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });
    editMessageTelegram.mockResolvedValue({ ok: true, chatId: "123", messageId: "999" });

    const bot = createBot();
    await dispatchWithContext({
      context: createReasoningStreamContext(),
      streamMode: "partial",
      bot,
    });

    expect(reasoningDraftParams?.onSupersededPreview).toBeTypeOf("function");
    const deleteMessageCalls = (
      bot.api as unknown as { deleteMessage: { mock: { calls: unknown[][] } } }
    ).deleteMessage.mock.calls;
    expect(deleteMessageCalls).toContainEqual([123, 4444]);
  });

  it("does not split reasoning lane on reasoning end without a later reasoning block", async () => {
    const { reasoningDraftStream } = setupDraftStreams({
      answerMessageId: 999,
      reasoningMessageId: 111,
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onReasoningStream?.({ text: "Reasoning:\n_first block_" });
        await replyOptions?.onReasoningEnd?.();
        await replyOptions?.onPartialReply?.({ text: "Here's the answer" });
        await dispatcherOptions.deliver({ text: "Here's the answer" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({ context: createReasoningStreamContext(), streamMode: "partial" });

    expect(reasoningDraftStream.forceNewMessage).not.toHaveBeenCalled();
  });

  it("suppresses reasoning-only final payloads when reasoning level is off", async () => {
    setupDraftStreams({ answerMessageId: 999 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "Hi, I did what you asked and..." });
        await dispatcherOptions.deliver({ text: "Reasoning:\n_step one_" }, { kind: "final" });
        await dispatcherOptions.deliver(
          { text: "Hi, I did what you asked and..." },
          { kind: "final" },
        );
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });
    editMessageTelegram.mockResolvedValue({ ok: true, chatId: "123", messageId: "999" });

    await dispatchWithContext({ context: createContext(), streamMode: "partial" });

    expect(deliverReplies).not.toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [expect.objectContaining({ text: "Reasoning:\n_step one_" })],
      }),
    );
    expect(editMessageTelegram).toHaveBeenCalledTimes(1);
    expect(editMessageTelegram).toHaveBeenCalledWith(
      123,
      999,
      "Hi, I did what you asked and...",
      expect.any(Object),
    );
  });

  it("does not resend suppressed reasoning-only text through raw fallback", async () => {
    setupDraftStreams({ answerMessageId: 999 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Reasoning:\n_step one_" }, { kind: "final" });
      return { queuedFinal: true };
    });
    deliverReplies.mockResolvedValue({ delivered: true });
    editMessageTelegram.mockResolvedValue({ ok: true, chatId: "123", messageId: "999" });

    await dispatchWithContext({ context: createContext(), streamMode: "partial" });

    expect(deliverReplies).not.toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [expect.objectContaining({ text: "Reasoning:\n_step one_" })],
      }),
    );
    expect(editMessageTelegram).not.toHaveBeenCalled();
  });

  it.each([undefined, null] as const)(
    "skips outbound send when final payload text is %s and has no media",
    async (emptyText) => {
      const { answerDraftStream } = setupDraftStreams({ answerMessageId: 999 });
      dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
        await dispatcherOptions.deliver(
          { text: emptyText as unknown as string },
          { kind: "final" },
        );
        return { queuedFinal: true };
      });
      deliverReplies.mockResolvedValue({ delivered: true });

      await dispatchWithContext({ context: createContext(), streamMode: "partial" });

      expect(deliverReplies).not.toHaveBeenCalled();
      expect(editMessageTelegram).not.toHaveBeenCalled();
      expect(answerDraftStream.clear).toHaveBeenCalledTimes(1);
    },
  );

  it("uses message preview transport for all DM lanes when streaming is active", async () => {
    setupDraftStreams({ answerMessageId: 999, reasoningMessageId: 111 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onReasoningStream?.({ text: "Reasoning:\n_Working on it..._" });
        await replyOptions?.onPartialReply?.({ text: "Checking the directory..." });
        await dispatcherOptions.deliver({ text: "Checking the directory..." }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });
    editMessageTelegram.mockResolvedValue({ ok: true, chatId: "123", messageId: "999" });

    await dispatchWithContext({ context: createReasoningStreamContext(), streamMode: "partial" });

    expect(createTelegramDraftStream).toHaveBeenCalledTimes(2);
    expect(createTelegramDraftStream.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        thread: { id: 777, scope: "dm" },
      }),
    );
    expect(createTelegramDraftStream.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        thread: { id: 777, scope: "dm" },
      }),
    );
  });

  it("finalizes DM answer preview in place without materializing or sending a duplicate", async () => {
    const answerDraftStream = createDraftStream(321);
    const reasoningDraftStream = createDraftStream(111);
    createTelegramDraftStream
      .mockImplementationOnce(() => answerDraftStream)
      .mockImplementationOnce(() => reasoningDraftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "Checking the directory..." });
        await dispatcherOptions.deliver({ text: "Checking the directory..." }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({ context: createContext(), streamMode: "partial" });

    expect(createTelegramDraftStream.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        thread: { id: 777, scope: "dm" },
      }),
    );
    expect(answerDraftStream.materialize).not.toHaveBeenCalled();
    expect(deliverReplies).not.toHaveBeenCalled();
    expect(editMessageTelegram).toHaveBeenCalledWith(
      123,
      321,
      "Checking the directory...",
      expect.any(Object),
    );
  });

  it("keeps reasoning and answer streaming in separate preview lanes", async () => {
    const { answerDraftStream, reasoningDraftStream } = setupDraftStreams({
      answerMessageId: 999,
      reasoningMessageId: 111,
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onReasoningStream?.({ text: "Reasoning:\n_Working on it..._" });
        await replyOptions?.onPartialReply?.({ text: "Checking the directory..." });
        await dispatcherOptions.deliver({ text: "Checking the directory..." }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });
    editMessageTelegram.mockResolvedValue({ ok: true, chatId: "123", messageId: "999" });

    await dispatchWithContext({ context: createReasoningStreamContext(), streamMode: "partial" });

    expect(reasoningDraftStream.update).toHaveBeenCalledWith("Reasoning:\n_Working on it..._");
    expect(answerDraftStream.update).toHaveBeenCalledWith("Checking the directory...");
    expect(answerDraftStream.forceNewMessage).not.toHaveBeenCalled();
    expect(reasoningDraftStream.forceNewMessage).not.toHaveBeenCalled();
  });

  it("does not edit reasoning preview bubble with final answer when no assistant partial arrived yet", async () => {
    setupDraftStreams({ reasoningMessageId: 999 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onReasoningStream?.({ text: "Reasoning:\n_Working on it..._" });
        await dispatcherOptions.deliver({ text: "Here's what I found." }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });
    editMessageTelegram.mockResolvedValue({ ok: true, chatId: "123", messageId: "999" });

    await dispatchWithContext({ context: createReasoningStreamContext(), streamMode: "partial" });

    expect(editMessageTelegram).not.toHaveBeenCalled();
    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [expect.objectContaining({ text: "Here's what I found." })],
      }),
    );
  });

  it("does not duplicate reasoning final after reasoning end", async () => {
    let reasoningMessageId: number | undefined = 111;
    const reasoningDraftStream = {
      update: vi.fn(),
      flush: vi.fn().mockResolvedValue(undefined),
      messageId: vi.fn().mockImplementation(() => reasoningMessageId),
      clear: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      forceNewMessage: vi.fn().mockImplementation(() => {
        reasoningMessageId = undefined;
      }),
    };
    const answerDraftStream = createDraftStream(999);
    createTelegramDraftStream
      .mockImplementationOnce(() => answerDraftStream)
      .mockImplementationOnce(() => reasoningDraftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onReasoningStream?.({ text: "Reasoning:\n_step one_" });
        await replyOptions?.onReasoningEnd?.();
        await dispatcherOptions.deliver(
          { text: "Reasoning:\n_step one expanded_" },
          { kind: "final" },
        );
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });
    editMessageTelegram.mockResolvedValue({ ok: true, chatId: "123", messageId: "111" });

    await dispatchWithContext({ context: createReasoningStreamContext(), streamMode: "partial" });

    expect(reasoningDraftStream.forceNewMessage).not.toHaveBeenCalled();
    expect(editMessageTelegram).toHaveBeenCalledWith(
      123,
      111,
      "Reasoning:\n_step one expanded_",
      expect.any(Object),
    );
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("updates reasoning preview for reasoning block payloads instead of sending duplicates", async () => {
    setupDraftStreams({ answerMessageId: 999, reasoningMessageId: 111 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onReasoningStream?.({
          text: "Reasoning:\nIf I count r in strawberry, I see positions 3, 8, and",
        });
        await replyOptions?.onReasoningEnd?.();
        await replyOptions?.onPartialReply?.({ text: "3" });
        await dispatcherOptions.deliver({ text: "3" }, { kind: "final" });
        await dispatcherOptions.deliver(
          {
            text: "Reasoning:\nIf I count r in strawberry, I see positions 3, 8, and 9. So the total is 3.",
          },
          { kind: "block" },
        );
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });
    editMessageTelegram.mockResolvedValue({ ok: true, chatId: "123", messageId: "999" });

    await dispatchWithContext({ context: createReasoningStreamContext(), streamMode: "partial" });

    expect(editMessageTelegram).toHaveBeenNthCalledWith(1, 123, 999, "3", expect.any(Object));
    expect(editMessageTelegram).toHaveBeenNthCalledWith(
      2,
      123,
      111,
      "Reasoning:\nIf I count r in strawberry, I see positions 3, 8, and 9. So the total is 3.",
      expect.any(Object),
    );
    expect(deliverReplies).not.toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [
          expect.objectContaining({
            text: expect.stringContaining("Reasoning:\nIf I count r in strawberry"),
          }),
        ],
      }),
    );
  });

  it("keeps DM reasoning block updates in preview flow without sending duplicates", async () => {
    const answerDraftStream = createDraftStream(999);
    let previewRevision = 0;
    const reasoningDraftStream = {
      update: vi.fn(),
      flush: vi.fn().mockResolvedValue(true),
      messageId: vi.fn().mockReturnValue(111),
      previewRevision: vi.fn().mockImplementation(() => previewRevision),
      clear: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      forceNewMessage: vi.fn(),
    };
    reasoningDraftStream.update.mockImplementation(() => {
      previewRevision += 1;
    });
    createTelegramDraftStream
      .mockImplementationOnce(() => answerDraftStream)
      .mockImplementationOnce(() => reasoningDraftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onReasoningStream?.({
          text: "Reasoning:\nI am counting letters...",
        });
        await replyOptions?.onReasoningEnd?.();
        await replyOptions?.onPartialReply?.({ text: "3" });
        await dispatcherOptions.deliver({ text: "3" }, { kind: "final" });
        await dispatcherOptions.deliver(
          {
            text: "Reasoning:\nI am counting letters. The total is 3.",
          },
          { kind: "block" },
        );
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });
    editMessageTelegram.mockResolvedValue({ ok: true, chatId: "123", messageId: "999" });

    await dispatchWithContext({ context: createReasoningStreamContext(), streamMode: "partial" });

    expect(editMessageTelegram).toHaveBeenCalledWith(123, 999, "3", expect.any(Object));
    expect(editMessageTelegram).toHaveBeenCalledWith(
      123,
      111,
      "Reasoning:\nI am counting letters. The total is 3.",
      expect.any(Object),
    );
    expect(reasoningDraftStream.update).toHaveBeenCalledWith(
      "Reasoning:\nI am counting letters...",
    );
    expect(reasoningDraftStream.flush).not.toHaveBeenCalled();
    expect(deliverReplies).not.toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [expect.objectContaining({ text: expect.stringContaining("Reasoning:\nI am") })],
      }),
    );
  });

  it("falls back to normal send when DM reasoning preview has no message id", async () => {
    const answerDraftStream = createDraftStream(999);
    const previewRevision = 0;
    const reasoningDraftStream = {
      update: vi.fn(),
      flush: vi.fn().mockResolvedValue(false),
      messageId: vi.fn().mockReturnValue(undefined),
      previewRevision: vi.fn().mockReturnValue(previewRevision),
      clear: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      forceNewMessage: vi.fn(),
    };
    createTelegramDraftStream
      .mockImplementationOnce(() => answerDraftStream)
      .mockImplementationOnce(() => reasoningDraftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onReasoningStream?.({ text: "Reasoning:\n_step one_" });
        await replyOptions?.onReasoningEnd?.();
        await dispatcherOptions.deliver(
          { text: "Reasoning:\n_step one expanded_" },
          { kind: "block" },
        );
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({ context: createReasoningStreamContext(), streamMode: "partial" });

    expect(reasoningDraftStream.flush).not.toHaveBeenCalled();
    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [expect.objectContaining({ text: "Reasoning:\n_step one expanded_" })],
      }),
    );
  });

  it("routes think-tag partials to reasoning lane and keeps answer lane clean", async () => {
    const { answerDraftStream, reasoningDraftStream } = setupDraftStreams({
      answerMessageId: 999,
      reasoningMessageId: 111,
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({
          text: "<think>Counting letters in strawberry</think>3",
        });
        await dispatcherOptions.deliver({ text: "3" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });
    editMessageTelegram.mockResolvedValue({ ok: true, chatId: "123", messageId: "999" });

    await dispatchWithContext({ context: createReasoningStreamContext(), streamMode: "partial" });

    expect(reasoningDraftStream.update).toHaveBeenCalledWith(
      "Reasoning:\n_Counting letters in strawberry_",
    );
    expect(answerDraftStream.update).toHaveBeenCalledWith("3");
    expect(
      answerDraftStream.update.mock.calls.some((call) => (call[0] ?? "").includes("<think>")),
    ).toBe(false);
    expect(editMessageTelegram).toHaveBeenCalledWith(123, 999, "3", expect.any(Object));
  });

  it("routes unmatched think partials to reasoning lane without leaking answer lane", async () => {
    const { answerDraftStream, reasoningDraftStream } = setupDraftStreams({
      answerMessageId: 999,
      reasoningMessageId: 111,
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({
          text: "<think>Counting letters in strawberry",
        });
        await dispatcherOptions.deliver(
          { text: "There are 3 r's in strawberry." },
          { kind: "final" },
        );
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });
    editMessageTelegram.mockResolvedValue({ ok: true, chatId: "123", messageId: "999" });

    await dispatchWithContext({ context: createReasoningStreamContext(), streamMode: "partial" });

    expect(reasoningDraftStream.update).toHaveBeenCalledWith(
      "Reasoning:\n_Counting letters in strawberry_",
    );
    expect(answerDraftStream.update.mock.calls.some((call) => (call[0] ?? "").includes("<"))).toBe(
      false,
    );
    expect(editMessageTelegram).toHaveBeenCalledWith(
      123,
      999,
      "There are 3 r's in strawberry.",
      expect.any(Object),
    );
  });

  it("clears reasoning preview message when reasoning is streamed but final is answer-only", async () => {
    const { reasoningDraftStream } = setupDraftStreams({
      answerMessageId: 999,
      reasoningMessageId: 111,
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({
          text: "<think>Word: strawberry. r appears at 3, 8, 9.</think>",
        });
        await dispatcherOptions.deliver(
          { text: "There are 3 r's in strawberry." },
          { kind: "final" },
        );
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });
    editMessageTelegram.mockResolvedValue({ ok: true, chatId: "123", messageId: "999" });

    await dispatchWithContext({ context: createReasoningStreamContext(), streamMode: "partial" });

    expect(reasoningDraftStream.update).toHaveBeenCalledWith(
      "Reasoning:\n_Word: strawberry. r appears at 3, 8, 9._",
    );
    expect(reasoningDraftStream.clear).toHaveBeenCalledTimes(1);
    expect(editMessageTelegram).toHaveBeenCalledWith(
      123,
      999,
      "There are 3 r's in strawberry.",
      expect.any(Object),
    );
  });

  it("splits think-tag final payload into reasoning and answer lanes", async () => {
    setupDraftStreams({
      answerMessageId: 999,
      reasoningMessageId: 111,
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        {
          text: "<think>Word: strawberry. r appears at 3, 8, 9.</think>There are 3 r's in strawberry.",
        },
        { kind: "final" },
      );
      return { queuedFinal: true };
    });
    deliverReplies.mockResolvedValue({ delivered: true });
    editMessageTelegram.mockResolvedValue({ ok: true, chatId: "123", messageId: "999" });

    await dispatchWithContext({ context: createReasoningStreamContext(), streamMode: "partial" });

    expect(editMessageTelegram).toHaveBeenNthCalledWith(
      1,
      123,
      111,
      "Reasoning:\n_Word: strawberry. r appears at 3, 8, 9._",
      expect.any(Object),
    );
    expect(editMessageTelegram).toHaveBeenNthCalledWith(
      2,
      123,
      999,
      "There are 3 r's in strawberry.",
      expect.any(Object),
    );
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("does not edit preview message when final payload is an error", async () => {
    const draftStream = createDraftStream(999);
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        // Partial text output
        await replyOptions?.onPartialReply?.({ text: "Let me check that file" });
        // Error payload should not edit the preview message
        await dispatcherOptions.deliver(
          { text: "⚠️ 🛠️ Exec: cat /nonexistent failed: No such file", isError: true },
          { kind: "final" },
        );
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({ context: createContext(), streamMode: "block" });

    // Should NOT edit preview message (which would overwrite the partial text)
    expect(editMessageTelegram).not.toHaveBeenCalled();
    // Should deliver via normal path as a new message
    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [expect.objectContaining({ text: expect.stringContaining("⚠️") })],
      }),
    );
  });

  it("finalizes explicit failed-action replies without a standalone warning delivery", async () => {
    const draftStream = createDraftStream(999);
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "Let me update that file." });
        await dispatcherOptions.deliver(
          { text: "I couldn't update the file, so no changes were applied." },
          { kind: "final" },
        );
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({ context: createContext(), streamMode: "block" });

    expect(editMessageTelegram).toHaveBeenCalledWith(
      123,
      999,
      "I couldn't update the file, so no changes were applied.",
      expect.any(Object),
    );
    expect(deliverReplies).not.toHaveBeenCalled();
    expect(draftStream.clear).not.toHaveBeenCalled();
  });

  it("clears preview for error-only finals", async () => {
    const draftStream = createDraftStream(999);
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "tool failed", isError: true }, { kind: "final" });
      await dispatcherOptions.deliver({ text: "another error", isError: true }, { kind: "final" });
      return { queuedFinal: true };
    });
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({ context: createContext() });

    // Error payloads skip preview finalization — preview must be cleaned up
    expect(draftStream.clear).toHaveBeenCalledTimes(1);
  });

  it("clears preview after media final delivery", async () => {
    const draftStream = createDraftStream(999);
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ mediaUrl: "file:///tmp/a.png" }, { kind: "final" });
      return { queuedFinal: true };
    });
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({ context: createContext() });

    expect(draftStream.clear).toHaveBeenCalledTimes(1);
  });

  it("clears stale preview when response is NO_REPLY", async () => {
    const draftStream = createDraftStream(999);
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockResolvedValue({
      queuedFinal: false,
    });

    await dispatchWithContext({ context: createContext() });

    // Preview contains stale partial text — must be cleaned up
    expect(draftStream.clear).toHaveBeenCalledTimes(1);
  });

  it("falls back when all finals are skipped and clears preview", async () => {
    const draftStream = createDraftStream(999);
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      dispatcherOptions.onSkip?.({ text: "" }, { reason: "empty", kind: "final" });
      return { queuedFinal: false };
    });
    deliverReplies.mockResolvedValueOnce({ delivered: true });

    await dispatchWithContext({ context: createContext() });

    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [
          expect.objectContaining({
            text: expect.stringContaining("No response"),
          }),
        ],
      }),
    );
    expect(draftStream.clear).toHaveBeenCalledTimes(1);
  });

  it("rewrites a no-visible-response DM turn through silent-reply fallback", async () => {
    const draftStream = createDraftStream(999);
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockResolvedValue({
      queuedFinal: false,
    });
    deliverReplies.mockResolvedValueOnce({ delivered: true });

    await dispatchWithContext({
      context: createContext({
        ctxPayload: {
          SessionKey: "agent:main:telegram:direct:123",
        } as unknown as TelegramMessageContext["ctxPayload"],
      }),
      cfg: {
        agents: {
          defaults: {
            silentReply: {
              direct: "disallow",
              group: "allow",
              internal: "allow",
            },
            silentReplyRewrite: {
              direct: true,
            },
          },
        },
      } as unknown as OpenClawConfig,
    });

    expect(deliverReplies).toHaveBeenCalledTimes(1);
    const deliveredReplies = deliverReplies.mock.calls[0]?.[0]?.replies;
    expect(Array.isArray(deliveredReplies)).toBe(true);
    expect(deliveredReplies?.[0]?.text).toEqual(expect.any(String));
    expect(deliveredReplies?.[0]?.text?.trim()).not.toBe("NO_REPLY");
  });

  it("does not add silent-reply fallback for message-tool-only turns", async () => {
    const draftStream = createDraftStream(999);
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockResolvedValue({
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
      sourceReplyDeliveryMode: "message_tool_only",
    });

    await dispatchWithContext({
      context: createContext({
        ctxPayload: {
          SessionKey: "agent:main:telegram:direct:123",
        } as unknown as TelegramMessageContext["ctxPayload"],
      }),
      cfg: {
        agents: {
          defaults: {
            silentReply: {
              direct: "disallow",
              group: "allow",
              internal: "allow",
            },
            silentReplyRewrite: {
              direct: true,
            },
          },
        },
      } as unknown as OpenClawConfig,
    });

    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("falls back in forum topics when a queued final was not delivered to Telegram", async () => {
    const draftStream = createDraftStream(999);
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockResolvedValue({
      queuedFinal: true,
      counts: { tool: 0, block: 0, final: 1 },
    });
    deliverReplies.mockResolvedValueOnce({ delivered: true });

    await dispatchWithContext({
      context: createContext({
        isGroup: true,
        chatId: -1003752586071,
        primaryCtx: {
          message: { chat: { id: -1003752586071, type: "supergroup" } },
        } as TelegramMessageContext["primaryCtx"],
        msg: {
          chat: { id: -1003752586071, type: "supergroup" },
          message_id: 3,
          message_thread_id: 2,
          is_topic_message: true,
        } as TelegramMessageContext["msg"],
        threadSpec: { id: 2, scope: "forum" },
        ctxPayload: {
          SessionKey: "agent:main:telegram:group:-1003752586071:topic:2",
          MessageThreadId: 2,
          IsForum: true,
        } as unknown as TelegramMessageContext["ctxPayload"],
      }),
      cfg: {
        agents: {
          defaults: {
            silentReply: {
              direct: "disallow",
              group: "disallow",
              internal: "allow",
            },
            silentReplyRewrite: {
              group: false,
            },
          },
        },
      } as unknown as OpenClawConfig,
    });

    expect(deliverReplies).toHaveBeenCalledTimes(1);
    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: "-1003752586071",
        thread: { id: 2, scope: "forum" },
        replies: [expect.objectContaining({ text: "NO_REPLY" })],
      }),
    );
  });

  it("does not add silent-reply fallback after visible block delivery", async () => {
    const draftStream = createDraftStream(999);
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "visible block" }, { kind: "block" });
      return { queuedFinal: false };
    });
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({
      context: createContext({
        ctxPayload: {
          SessionKey: "agent:main:telegram:direct:123",
        } as unknown as TelegramMessageContext["ctxPayload"],
      }),
      cfg: {
        agents: {
          defaults: {
            silentReply: {
              direct: "disallow",
              group: "allow",
              internal: "allow",
            },
            silentReplyRewrite: {
              direct: true,
            },
          },
        },
      } as unknown as OpenClawConfig,
    });

    expect(deliverReplies).toHaveBeenCalledTimes(1);
    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [expect.objectContaining({ text: "visible block" })],
      }),
    );
  });

  it("keeps no-visible-response group turns silent when policy allows silence", async () => {
    const draftStream = createDraftStream(999);
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockResolvedValue({
      queuedFinal: false,
    });

    await dispatchWithContext({
      context: createContext({
        isGroup: true,
        primaryCtx: {
          message: { chat: { id: 123, type: "supergroup" } },
        } as TelegramMessageContext["primaryCtx"],
        msg: {
          chat: { id: 123, type: "supergroup" },
          message_id: 456,
          message_thread_id: 777,
        } as TelegramMessageContext["msg"],
        threadSpec: { id: 777, scope: "forum" },
        ctxPayload: {
          SessionKey: "agent:main:telegram:group:123",
        } as unknown as TelegramMessageContext["ctxPayload"],
      }),
      cfg: {
        agents: {
          defaults: {
            silentReply: {
              direct: "disallow",
              group: "allow",
              internal: "allow",
            },
            silentReplyRewrite: {
              direct: true,
            },
          },
        },
      } as unknown as OpenClawConfig,
    });

    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("sends fallback and clears preview when deliver throws (dispatcher swallows error)", async () => {
    const draftStream = createDraftStream();
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      try {
        await dispatcherOptions.deliver({ text: "Hello" }, { kind: "final" });
      } catch (err) {
        dispatcherOptions.onError?.(err, { kind: "final" });
      }
      return { queuedFinal: false };
    });
    deliverReplies
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce({ delivered: true });

    await expect(dispatchWithContext({ context: createContext() })).resolves.toBeUndefined();
    // Fallback should be sent because failedDeliveries > 0
    expect(deliverReplies).toHaveBeenCalledTimes(2);
    expect(deliverReplies).toHaveBeenLastCalledWith(
      expect.objectContaining({
        replies: [
          expect.objectContaining({
            text: expect.stringContaining("No response"),
          }),
        ],
      }),
    );
    expect(draftStream.clear).toHaveBeenCalledTimes(1);
  });

  it("sends fallback in off mode when deliver throws", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      try {
        await dispatcherOptions.deliver({ text: "Hello" }, { kind: "final" });
      } catch (err) {
        dispatcherOptions.onError?.(err, { kind: "final" });
      }
      return { queuedFinal: false };
    });
    deliverReplies
      .mockRejectedValueOnce(new Error("403 bot blocked"))
      .mockResolvedValueOnce({ delivered: true });

    await dispatchWithContext({ context: createContext(), streamMode: "off" });

    expect(createTelegramDraftStream).not.toHaveBeenCalled();
    expect(deliverReplies).toHaveBeenCalledTimes(2);
    expect(deliverReplies).toHaveBeenLastCalledWith(
      expect.objectContaining({
        replies: [
          expect.objectContaining({
            text: expect.stringContaining("No response"),
          }),
        ],
      }),
    );
  });

  it("sends a fresh final after a visible error block bubble pushes the preview up", async () => {
    const draftStream = createTestDraftStream({
      messageId: 999,
      visibleSinceMs: Date.now() - 1_000,
    });
    createTelegramDraftStream.mockReturnValue(draftStream);
    editMessageTelegram.mockResolvedValue({ ok: true });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "Processing..." });
        await dispatcherOptions.deliver(
          { text: "⚠️ exec failed", isError: true },
          { kind: "block" },
        );
        await dispatcherOptions.deliver(
          { text: "The command timed out. Here's what I found..." },
          { kind: "final" },
        );
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({ context: createContext() });

    // Error block + fresh final both went through deliverReplies; preview was
    // not edited in place and the stale preview was cleared.
    expect(deliverReplies).toHaveBeenCalledTimes(2);
    expect(editMessageTelegram).not.toHaveBeenCalled();
    expect(deliverReplies).toHaveBeenLastCalledWith(
      expect.objectContaining({
        replies: [
          expect.objectContaining({ text: "The command timed out. Here's what I found..." }),
        ],
      }),
    );
    expect(draftStream.clear).toHaveBeenCalled();
  });

  // #76529: when a visible non-final message is delivered after the answer
  // preview is already on screen, finalizing the preview by edit puts the
  // final answer above the intermediate output. Force a fresh send instead.
  it("sends a fresh final after a visible block bubble pushes the preview up (#76529)", async () => {
    // Preview was already on screen before the block bubble was sent.
    const draftStream = createTestDraftStream({
      messageId: 999,
      visibleSinceMs: Date.now() - 1_000,
    });
    createTelegramDraftStream.mockReturnValue(draftStream);
    editMessageTelegram.mockResolvedValue({ ok: true });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "Checked maxDBdays..." });
        await dispatcherOptions.deliver(
          { text: "Changed maxDBdays from 91 → 14" },
          { kind: "block" },
        );
        await dispatcherOptions.deliver({ text: "Done" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({ context: createContext() });

    // Block + fresh final both went through deliverReplies; preview was not
    // edited in place and the stale preview was cleared.
    expect(deliverReplies).toHaveBeenCalledTimes(2);
    expect(editMessageTelegram).not.toHaveBeenCalled();
    expect(deliverReplies).toHaveBeenLastCalledWith(
      expect.objectContaining({
        replies: [expect.objectContaining({ text: "Done" })],
      }),
    );
    expect(draftStream.clear).toHaveBeenCalled();
  });

  it("cleans up preview even when fallback delivery throws (double failure)", async () => {
    const draftStream = createDraftStream();
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      try {
        await dispatcherOptions.deliver({ text: "Hello" }, { kind: "final" });
      } catch (err) {
        dispatcherOptions.onError?.(err, { kind: "final" });
      }
      return { queuedFinal: false };
    });
    // No preview message id → deliver goes through deliverReplies directly
    // Primary delivery fails
    deliverReplies
      .mockRejectedValueOnce(new Error("network down"))
      // Fallback also fails
      .mockRejectedValueOnce(new Error("still down"));

    // Fallback throws, but cleanup still runs via try/finally.
    await dispatchWithContext({ context: createContext() }).catch(() => {});

    // Verify fallback was attempted and preview still cleaned up
    expect(deliverReplies).toHaveBeenCalledTimes(2);
    expect(draftStream.clear).toHaveBeenCalledTimes(1);
  });

  it("sends error fallback and clears preview when dispatcher throws", async () => {
    const draftStream = createDraftStream(999);
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockRejectedValue(new Error("dispatcher exploded"));
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({ context: createContext() });

    expect(draftStream.stop).toHaveBeenCalledTimes(1);
    expect(draftStream.clear).toHaveBeenCalledTimes(1);
    // Error fallback message should be delivered to the user instead of silent failure
    expect(deliverReplies).toHaveBeenCalledTimes(1);
    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [
          { text: "Something went wrong while processing your request. Please try again." },
        ],
      }),
    );
  });

  it("supports concurrent dispatches with independent previews", async () => {
    const draftA = createDraftStream(11);
    const draftB = createDraftStream(22);
    createTelegramDraftStream.mockReturnValueOnce(draftA).mockReturnValueOnce(draftB);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "partial" });
        await dispatcherOptions.deliver({ mediaUrl: "file:///tmp/a.png" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });

    await Promise.all([
      dispatchWithContext({
        context: createContext({
          chatId: 1,
          msg: { chat: { id: 1, type: "private" }, message_id: 1 } as never,
        }),
      }),
      dispatchWithContext({
        context: createContext({
          chatId: 2,
          msg: { chat: { id: 2, type: "private" }, message_id: 2 } as never,
        }),
      }),
    ]);

    expect(draftA.clear).toHaveBeenCalledTimes(1);
    expect(draftB.clear).toHaveBeenCalledTimes(1);
  });

  it("ignores stale answer finalization after an abort dispatch supersedes the same session", async () => {
    let releaseFirstFinal!: () => void;
    const firstFinalGate = new Promise<void>((resolve) => {
      releaseFirstFinal = resolve;
    });
    let resolvePreviewVisible!: () => void;
    const previewVisible = new Promise<void>((resolve) => {
      resolvePreviewVisible = resolve;
    });

    const firstAnswerDraft = createTestDraftStream({
      messageId: 1001,
      onUpdate: (text) => {
        if (text === "Old reply partial") {
          resolvePreviewVisible();
        }
      },
    });
    const firstReasoningDraft = createDraftStream();
    const abortAnswerDraft = createDraftStream();
    const abortReasoningDraft = createDraftStream();
    createTelegramDraftStream
      .mockImplementationOnce(() => firstAnswerDraft)
      .mockImplementationOnce(() => firstReasoningDraft)
      .mockImplementationOnce(() => abortAnswerDraft)
      .mockImplementationOnce(() => abortReasoningDraft);
    dispatchReplyWithBufferedBlockDispatcher
      .mockImplementationOnce(async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "Old reply partial" });
        await firstFinalGate;
        await dispatcherOptions.deliver({ text: "Old reply final" }, { kind: "final" });
        return { queuedFinal: true };
      })
      .mockImplementationOnce(async ({ dispatcherOptions }) => {
        await dispatcherOptions.deliver({ text: "⚙️ Agent was aborted." }, { kind: "final" });
        return { queuedFinal: true };
      });
    const abortReplyDelivered = observeDeliveredReply("⚙️ Agent was aborted.");
    editMessageTelegram.mockResolvedValue({ ok: true, chatId: "123", messageId: "1001" });

    const firstPromise = dispatchWithContext({
      context: createContext({
        ctxPayload: {
          SessionKey: "s1",
          Body: "earlier request",
          RawBody: "earlier request",
        } as never,
      }),
    });

    await previewVisible;

    const abortPromise = dispatchWithContext({
      context: createContext({
        ctxPayload: {
          SessionKey: "s1",
          Body: "abort",
          RawBody: "abort",
          CommandBody: "abort",
          CommandAuthorized: true,
        } as never,
      }),
    });

    await abortReplyDelivered;

    releaseFirstFinal();
    await Promise.all([firstPromise, abortPromise]);

    expect(editMessageTelegram).not.toHaveBeenCalledWith(
      123,
      1001,
      "Old reply final",
      expect.any(Object),
    );
    expect(firstAnswerDraft.clear).not.toHaveBeenCalled();
  });

  it("ignores stale answer finalization after a newer message supersedes the same session", async () => {
    let releaseFirstFinal!: () => void;
    const firstFinalGate = new Promise<void>((resolve) => {
      releaseFirstFinal = resolve;
    });
    let resolvePreviewVisible!: () => void;
    const previewVisible = new Promise<void>((resolve) => {
      resolvePreviewVisible = resolve;
    });

    const firstAnswerDraft = createTestDraftStream({
      messageId: 1001,
      onUpdate: (text) => {
        if (text === "Old reply partial") {
          resolvePreviewVisible();
        }
      },
    });
    const firstReasoningDraft = createDraftStream();
    const secondAnswerDraft = createDraftStream();
    const secondReasoningDraft = createDraftStream();
    createTelegramDraftStream
      .mockImplementationOnce(() => firstAnswerDraft)
      .mockImplementationOnce(() => firstReasoningDraft)
      .mockImplementationOnce(() => secondAnswerDraft)
      .mockImplementationOnce(() => secondReasoningDraft);
    dispatchReplyWithBufferedBlockDispatcher
      .mockImplementationOnce(async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "Old reply partial" });
        await firstFinalGate;
        await dispatcherOptions.deliver({ text: "Old reply final" }, { kind: "final" });
        return { queuedFinal: true };
      })
      .mockImplementationOnce(async ({ dispatcherOptions }) => {
        await dispatcherOptions.deliver({ text: "New reply final" }, { kind: "final" });
        return { queuedFinal: true };
      });
    const newReplyDelivered = observeDeliveredReply("New reply final");
    editMessageTelegram.mockResolvedValue({ ok: true, chatId: "123", messageId: "1001" });

    const firstPromise = dispatchWithContext({
      context: createContext({
        ctxPayload: {
          SessionKey: "s1",
          Body: "earlier request",
          RawBody: "earlier request",
          MessageSid: "msg-1",
        } as never,
      }),
    });

    await previewVisible;

    const secondPromise = dispatchWithContext({
      context: createContext({
        ctxPayload: {
          SessionKey: "s1",
          Body: "newer request",
          RawBody: "newer request",
          MessageSid: "msg-2",
        } as never,
      }),
    });

    await newReplyDelivered;

    releaseFirstFinal();
    await Promise.all([firstPromise, secondPromise]);

    expect(editMessageTelegram).not.toHaveBeenCalledWith(
      123,
      1001,
      "Old reply final",
      expect.any(Object),
    );
    expect(firstAnswerDraft.clear).not.toHaveBeenCalled();
  });

  it("discards hidden short partials instead of flushing a stale preview after abort", async () => {
    let releaseFirstCleanup!: () => void;
    const firstCleanupGate = new Promise<void>((resolve) => {
      releaseFirstCleanup = resolve;
    });
    let resolveShortPartialQueued!: () => void;
    const shortPartialQueued = new Promise<void>((resolve) => {
      resolveShortPartialQueued = resolve;
    });

    const firstAnswerDraft = createTestDraftStream({
      onUpdate: (text) => {
        if (text === "tiny") {
          resolveShortPartialQueued();
        }
      },
      onStop: () => {
        throw new Error("superseded cleanup should discard instead of stop");
      },
    });
    const firstReasoningDraft = createDraftStream();
    const abortAnswerDraft = createDraftStream();
    const abortReasoningDraft = createDraftStream();
    createTelegramDraftStream
      .mockImplementationOnce(() => firstAnswerDraft)
      .mockImplementationOnce(() => firstReasoningDraft)
      .mockImplementationOnce(() => abortAnswerDraft)
      .mockImplementationOnce(() => abortReasoningDraft);
    dispatchReplyWithBufferedBlockDispatcher
      .mockImplementationOnce(async ({ replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "tiny" });
        await firstCleanupGate;
        return { queuedFinal: false };
      })
      .mockImplementationOnce(async ({ dispatcherOptions }) => {
        await dispatcherOptions.deliver({ text: "⚙️ Agent was aborted." }, { kind: "final" });
        return { queuedFinal: true };
      });
    const abortReplyDelivered = observeDeliveredReply("⚙️ Agent was aborted.");

    const firstPromise = dispatchWithContext({
      context: createContext({
        ctxPayload: {
          SessionKey: "s1",
          Body: "earlier request",
          RawBody: "earlier request",
        } as never,
      }),
    });

    await shortPartialQueued;

    const abortPromise = dispatchWithContext({
      context: createContext({
        ctxPayload: {
          SessionKey: "s1",
          Body: "abort",
          RawBody: "abort",
          CommandBody: "abort",
          CommandAuthorized: true,
        } as never,
      }),
    });

    await abortReplyDelivered;

    releaseFirstCleanup();
    await Promise.all([firstPromise, abortPromise]);

    expect(firstAnswerDraft.discard).toHaveBeenCalledTimes(1);
    expect(firstAnswerDraft.stop).not.toHaveBeenCalled();
    expect(firstAnswerDraft.clear).not.toHaveBeenCalled();
  });

  it("suppresses stale replies when abort lands during async pre-dispatch work", async () => {
    let releaseCatalogLoad!: () => void;
    const catalogLoadGate = new Promise<Record<string, never>>((resolve) => {
      releaseCatalogLoad = () => resolve({});
    });
    let resolveCatalogLoadStarted!: () => void;
    const catalogLoadStarted = new Promise<void>((resolve) => {
      resolveCatalogLoadStarted = resolve;
    });

    loadModelCatalog.mockImplementationOnce(async () => {
      resolveCatalogLoadStarted();
      return await catalogLoadGate;
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ ctx, dispatcherOptions }) => {
        if (ctx.CommandBody === "abort") {
          await dispatcherOptions.deliver({ text: "⚙️ Agent was aborted." }, { kind: "final" });
          return { queuedFinal: true };
        }
        await dispatcherOptions.deliver({ text: "Old reply final" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    const abortReplyDelivered = observeDeliveredReply("⚙️ Agent was aborted.");

    const firstPromise = dispatchWithContext({
      context: createContext({
        ctxPayload: {
          SessionKey: "s1",
          Body: "earlier request",
          RawBody: "earlier request",
          MediaPath: "/tmp/sticker.png",
          Sticker: {
            fileId: "file-id",
            fileUniqueId: "file-unique-id",
          },
        } as never,
      }),
    });

    await catalogLoadStarted;

    const abortPromise = dispatchWithContext({
      context: createContext({
        ctxPayload: {
          SessionKey: "s1",
          Body: "abort",
          RawBody: "abort",
          CommandBody: "abort",
          CommandAuthorized: true,
        } as never,
      }),
    });

    await abortReplyDelivered;

    releaseCatalogLoad();
    await Promise.all([firstPromise, abortPromise]);

    expect(deliverReplies).not.toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [{ text: "Old reply final" }],
      }),
    );
  });

  it("releases the abort fence when pre-dispatch setup throws", async () => {
    describeStickerImage.mockRejectedValueOnce(new Error("sticker setup failed"));

    await expect(
      dispatchWithContext({
        context: createContext({
          ctxPayload: {
            SessionKey: "s1",
            Body: "earlier request",
            RawBody: "earlier request",
            MediaPath: "/tmp/sticker.png",
            Sticker: {
              fileId: "file-id",
              fileUniqueId: "file-unique-id",
            },
          } as never,
        }),
      }),
    ).rejects.toThrow("sticker setup failed");

    expect(getTelegramReplyFenceSizeForTests()).toBe(0);
  });

  it("keeps older answer finalization when abort targets a different session", async () => {
    let releaseFirstFinal!: () => void;
    const firstFinalGate = new Promise<void>((resolve) => {
      releaseFirstFinal = resolve;
    });
    let resolvePreviewVisible!: () => void;
    const previewVisible = new Promise<void>((resolve) => {
      resolvePreviewVisible = resolve;
    });

    const firstAnswerDraft = createTestDraftStream({
      messageId: 1001,
      onUpdate: (text) => {
        if (text === "Old reply partial") {
          resolvePreviewVisible();
        }
      },
    });
    const firstReasoningDraft = createDraftStream();
    const abortAnswerDraft = createDraftStream();
    const abortReasoningDraft = createDraftStream();
    createTelegramDraftStream
      .mockImplementationOnce(() => firstAnswerDraft)
      .mockImplementationOnce(() => firstReasoningDraft)
      .mockImplementationOnce(() => abortAnswerDraft)
      .mockImplementationOnce(() => abortReasoningDraft);
    dispatchReplyWithBufferedBlockDispatcher
      .mockImplementationOnce(async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "Old reply partial" });
        await firstFinalGate;
        await dispatcherOptions.deliver({ text: "Old reply final" }, { kind: "final" });
        return { queuedFinal: true };
      })
      .mockImplementationOnce(async ({ dispatcherOptions }) => {
        await dispatcherOptions.deliver({ text: "⚙️ Agent was aborted." }, { kind: "final" });
        return { queuedFinal: true };
      });
    const abortReplyDelivered = observeDeliveredReply("⚙️ Agent was aborted.");
    editMessageTelegram.mockResolvedValue({ ok: true, chatId: "123", messageId: "1001" });

    const firstPromise = dispatchWithContext({
      context: createContext({
        ctxPayload: {
          SessionKey: "s1",
          Body: "earlier request",
          RawBody: "earlier request",
        } as never,
      }),
    });

    await previewVisible;

    const abortPromise = dispatchWithContext({
      context: createContext({
        ctxPayload: {
          SessionKey: "s2",
          CommandTargetSessionKey: "s2",
          Body: "abort",
          RawBody: "abort",
          CommandBody: "abort",
          CommandAuthorized: true,
        } as never,
      }),
    });

    await abortReplyDelivered;

    releaseFirstFinal();
    await Promise.all([firstPromise, abortPromise]);

    expect(editMessageTelegram).toHaveBeenCalledWith(
      123,
      1001,
      "Old reply final",
      expect.any(Object),
    );
  });

  it("finalizes stale status reactions when an abort supersedes the same session", async () => {
    let releaseFirstFinal!: () => void;
    const firstFinalGate = new Promise<void>((resolve) => {
      releaseFirstFinal = resolve;
    });
    let resolvePreviewVisible!: () => void;
    const previewVisible = new Promise<void>((resolve) => {
      resolvePreviewVisible = resolve;
    });

    const reactionApi = vi.fn(async () => true);
    const statusReactionController = createStatusReactionController();
    const firstAnswerDraft = createTestDraftStream({
      messageId: 1001,
      onUpdate: (text) => {
        if (text === "Old reply partial") {
          resolvePreviewVisible();
        }
      },
    });
    const firstReasoningDraft = createDraftStream();
    const abortAnswerDraft = createDraftStream();
    const abortReasoningDraft = createDraftStream();
    createTelegramDraftStream
      .mockImplementationOnce(() => firstAnswerDraft)
      .mockImplementationOnce(() => firstReasoningDraft)
      .mockImplementationOnce(() => abortAnswerDraft)
      .mockImplementationOnce(() => abortReasoningDraft);
    dispatchReplyWithBufferedBlockDispatcher
      .mockImplementationOnce(async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "Old reply partial" });
        await firstFinalGate;
        await dispatcherOptions.deliver({ text: "Old reply final" }, { kind: "final" });
        return { queuedFinal: true };
      })
      .mockImplementationOnce(async ({ dispatcherOptions }) => {
        await dispatcherOptions.deliver({ text: "⚙️ Agent was aborted." }, { kind: "final" });
        return { queuedFinal: true };
      });
    const abortReplyDelivered = observeDeliveredReply("⚙️ Agent was aborted.");
    editMessageTelegram.mockResolvedValue({ ok: true, chatId: "123", messageId: "1001" });

    const firstPromise = dispatchWithContext({
      context: createContext({
        reactionApi: reactionApi as never,
        removeAckAfterReply: true,
        statusReactionController: statusReactionController as never,
        ctxPayload: {
          SessionKey: "s1",
          Body: "earlier request",
          RawBody: "earlier request",
        } as never,
      }),
      cfg: {
        messages: {
          statusReactions: {
            timing: {
              doneHoldMs: 250,
            },
          },
        },
      },
    });

    await previewVisible;

    const abortPromise = dispatchWithContext({
      context: createContext({
        ctxPayload: {
          SessionKey: "s1",
          Body: "abort",
          RawBody: "abort",
          CommandBody: "abort",
          CommandAuthorized: true,
        } as never,
      }),
    });

    await abortReplyDelivered;

    vi.useFakeTimers();
    try {
      releaseFirstFinal();
      await Promise.all([firstPromise, abortPromise]);

      expect(statusReactionController.setDone).toHaveBeenCalledTimes(1);
      expect(statusReactionController.setError).not.toHaveBeenCalled();
      expect(reactionApi).not.toHaveBeenCalledWith(123, 456, []);

      await vi.advanceTimersByTimeAsync(249);
      expect(reactionApi).not.toHaveBeenCalledWith(123, 456, []);

      await vi.advanceTimersByTimeAsync(1);
      expect(reactionApi).toHaveBeenCalledWith(123, 456, []);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps an existing preview when abort arrives during queued draft-lane cleanup", async () => {
    let releaseMaterialize!: () => void;
    const materializeGate = new Promise<void>((resolve) => {
      releaseMaterialize = resolve;
    });
    let resolveMaterializeStarted!: () => void;
    const materializeStarted = new Promise<void>((resolve) => {
      resolveMaterializeStarted = resolve;
    });
    let resolvePreviewVisible!: () => void;
    const previewVisible = new Promise<void>((resolve) => {
      resolvePreviewVisible = resolve;
    });

    const firstAnswerDraft = createTestDraftStream({
      messageId: 1001,
      clearMessageIdOnForceNew: true,
      onUpdate: (text) => {
        if (text === "Old reply partial") {
          resolvePreviewVisible();
        }
      },
    });
    firstAnswerDraft.materialize.mockImplementation(async () => {
      resolveMaterializeStarted();
      await materializeGate;
      return 1001;
    });
    const firstReasoningDraft = createDraftStream();
    const abortAnswerDraft = createDraftStream();
    const abortReasoningDraft = createDraftStream();
    const bot = createBot();
    createTelegramDraftStream
      .mockImplementationOnce(() => firstAnswerDraft)
      .mockImplementationOnce(() => firstReasoningDraft)
      .mockImplementationOnce(() => abortAnswerDraft)
      .mockImplementationOnce(() => abortReasoningDraft);
    dispatchReplyWithBufferedBlockDispatcher
      .mockImplementationOnce(async ({ replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "Old reply partial" });
        void replyOptions?.onAssistantMessageStart?.();
        return { queuedFinal: false };
      })
      .mockImplementationOnce(async ({ dispatcherOptions }) => {
        await dispatcherOptions.deliver({ text: "⚙️ Agent was aborted." }, { kind: "final" });
        return { queuedFinal: true };
      });
    const abortReplyDelivered = observeDeliveredReply("⚙️ Agent was aborted.");

    const firstPromise = dispatchWithContext({
      context: createContext({
        ctxPayload: {
          SessionKey: "s1",
          Body: "earlier request",
          RawBody: "earlier request",
        } as never,
      }),
      bot,
    });

    await previewVisible;
    await materializeStarted;

    const abortPromise = dispatchWithContext({
      context: createContext({
        ctxPayload: {
          SessionKey: "s1",
          Body: "abort",
          RawBody: "abort",
          CommandBody: "abort",
          CommandAuthorized: true,
        } as never,
      }),
      bot,
    });

    await abortReplyDelivered;

    releaseMaterialize();
    await Promise.all([firstPromise, abortPromise]);

    expect(firstAnswerDraft.clear).not.toHaveBeenCalled();
    expect(bot.api.deleteMessage as ReturnType<typeof vi.fn>).not.toHaveBeenCalledWith(123, 1001);
  });

  it("ignores stale answer finalization when abort targets the session via CommandTargetSessionKey", async () => {
    let releaseFirstFinal!: () => void;
    const firstFinalGate = new Promise<void>((resolve) => {
      releaseFirstFinal = resolve;
    });
    let resolvePreviewVisible!: () => void;
    const previewVisible = new Promise<void>((resolve) => {
      resolvePreviewVisible = resolve;
    });

    const firstAnswerDraft = createTestDraftStream({
      messageId: 1001,
      onUpdate: (text) => {
        if (text === "Old reply partial") {
          resolvePreviewVisible();
        }
      },
    });
    const firstReasoningDraft = createDraftStream();
    const abortAnswerDraft = createDraftStream();
    const abortReasoningDraft = createDraftStream();
    createTelegramDraftStream
      .mockImplementationOnce(() => firstAnswerDraft)
      .mockImplementationOnce(() => firstReasoningDraft)
      .mockImplementationOnce(() => abortAnswerDraft)
      .mockImplementationOnce(() => abortReasoningDraft);
    dispatchReplyWithBufferedBlockDispatcher
      .mockImplementationOnce(async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "Old reply partial" });
        await firstFinalGate;
        await dispatcherOptions.deliver({ text: "Old reply final" }, { kind: "final" });
        return { queuedFinal: true };
      })
      .mockImplementationOnce(async ({ dispatcherOptions }) => {
        await dispatcherOptions.deliver({ text: "⚙️ Agent was aborted." }, { kind: "final" });
        return { queuedFinal: true };
      });
    const abortReplyDelivered = observeDeliveredReply("⚙️ Agent was aborted.");
    editMessageTelegram.mockResolvedValue({ ok: true, chatId: "123", messageId: "1001" });

    const firstPromise = dispatchWithContext({
      context: createContext({
        ctxPayload: {
          SessionKey: "s1",
          Body: "earlier request",
          RawBody: "earlier request",
        } as never,
      }),
    });

    await previewVisible;

    const abortPromise = dispatchWithContext({
      context: createContext({
        ctxPayload: {
          SessionKey: "telegram:123:control",
          CommandTargetSessionKey: "s1",
          Body: "abort",
          RawBody: "abort",
          CommandBody: "abort",
          CommandAuthorized: true,
        } as never,
      }),
    });

    await abortReplyDelivered;

    releaseFirstFinal();
    await Promise.all([firstPromise, abortPromise]);

    expect(editMessageTelegram).not.toHaveBeenCalledWith(
      123,
      1001,
      "Old reply final",
      expect.any(Object),
    );
    expect(firstAnswerDraft.clear).not.toHaveBeenCalled();
  });

  it("swallows post-connect network timeout on preview edit to prevent duplicate messages", async () => {
    const draftStream = createDraftStream(999);
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "Streaming..." });
        await dispatcherOptions.deliver({ text: "Final answer" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });
    // Simulate a post-connect timeout: editMessageTelegram throws a network
    // error even though Telegram's server already processed the edit.
    editMessageTelegram.mockRejectedValue(new Error("timeout: request timed out after 30000ms"));

    await dispatchWithContext({ context: createContext() });

    expect(editMessageTelegram).toHaveBeenCalledTimes(1);
    const deliverCalls = deliverReplies.mock.calls;
    const finalTextSentViaDeliverReplies = deliverCalls.some((call: unknown[]) =>
      (call[0] as { replies?: Array<{ text?: string }> })?.replies?.some(
        (r: { text?: string }) => r.text === "Final answer",
      ),
    );
    expect(finalTextSentViaDeliverReplies).toBe(false);
  });

  it("falls back to sendPayload on pre-connect error during final edit", async () => {
    const draftStream = createDraftStream(999);
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "Streaming..." });
        await dispatcherOptions.deliver({ text: "Final answer" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });
    const preConnectErr = new Error("connect ECONNREFUSED 149.154.167.220:443");
    (preConnectErr as NodeJS.ErrnoException).code = "ECONNREFUSED";
    editMessageTelegram.mockRejectedValue(preConnectErr);

    await dispatchWithContext({ context: createContext() });

    expect(editMessageTelegram).toHaveBeenCalledTimes(1);
    const deliverCalls = deliverReplies.mock.calls;
    const finalTextSentViaDeliverReplies = deliverCalls.some((call: unknown[]) =>
      (call[0] as { replies?: Array<{ text?: string }> })?.replies?.some(
        (r: { text?: string }) => r.text === "Final answer",
      ),
    );
    expect(finalTextSentViaDeliverReplies).toBe(true);
  });

  it("falls back when Telegram reports the current final edit target missing", async () => {
    const draftStream = createDraftStream(999);
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "Streaming..." });
        await dispatcherOptions.deliver({ text: "Final answer" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });
    editMessageTelegram.mockRejectedValue(new Error("400: Bad Request: message to edit not found"));

    await dispatchWithContext({ context: createContext() });

    expect(editMessageTelegram).toHaveBeenCalledTimes(1);
    const deliverCalls = deliverReplies.mock.calls;
    const finalTextSentViaDeliverReplies = deliverCalls.some((call: unknown[]) =>
      (call[0] as { replies?: Array<{ text?: string }> })?.replies?.some(
        (r: { text?: string }) => r.text === "Final answer",
      ),
    );
    expect(finalTextSentViaDeliverReplies).toBe(true);
  });

  it("shows compacting reaction during auto-compaction and resumes thinking", async () => {
    const statusReactionController = {
      setThinking: vi.fn(async () => {}),
      setCompacting: vi.fn(async () => {}),
      setTool: vi.fn(async () => {}),
      setDone: vi.fn(async () => {}),
      setError: vi.fn(async () => {}),
      setQueued: vi.fn(async () => {}),
      cancelPending: vi.fn(() => {}),
      clear: vi.fn(async () => {}),
      restoreInitial: vi.fn(async () => {}),
    };
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      await replyOptions?.onCompactionStart?.();
      await replyOptions?.onCompactionEnd?.();
      return { queuedFinal: true };
    });
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({
      context: createContext({
        statusReactionController: statusReactionController as never,
      }),
      streamMode: "off",
    });

    expect(statusReactionController.setCompacting).toHaveBeenCalledTimes(1);
    expect(statusReactionController.cancelPending).toHaveBeenCalledTimes(1);
    expect(statusReactionController.setThinking).toHaveBeenCalledTimes(2);
    expect(statusReactionController.setCompacting.mock.invocationCallOrder[0]).toBeLessThan(
      statusReactionController.cancelPending.mock.invocationCallOrder[0],
    );
    expect(statusReactionController.cancelPending.mock.invocationCallOrder[0]).toBeLessThan(
      statusReactionController.setThinking.mock.invocationCallOrder[1],
    );
  });

  it("does not supersede the same session for unauthorized abort-looking commands", async () => {
    let releaseFirstFinal!: () => void;
    const firstFinalGate = new Promise<void>((resolve) => {
      releaseFirstFinal = resolve;
    });
    let resolvePreviewVisible!: () => void;
    const previewVisible = new Promise<void>((resolve) => {
      resolvePreviewVisible = resolve;
    });

    const firstAnswerDraft = createTestDraftStream({
      messageId: 1001,
      onUpdate: (text) => {
        if (text === "Old reply partial") {
          resolvePreviewVisible();
        }
      },
    });
    const firstReasoningDraft = createDraftStream();
    const unauthorizedAnswerDraft = createDraftStream();
    const unauthorizedReasoningDraft = createDraftStream();
    createTelegramDraftStream
      .mockImplementationOnce(() => firstAnswerDraft)
      .mockImplementationOnce(() => firstReasoningDraft)
      .mockImplementationOnce(() => unauthorizedAnswerDraft)
      .mockImplementationOnce(() => unauthorizedReasoningDraft);
    dispatchReplyWithBufferedBlockDispatcher
      .mockImplementationOnce(async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "Old reply partial" });
        await firstFinalGate;
        await dispatcherOptions.deliver({ text: "Old reply final" }, { kind: "final" });
        return { queuedFinal: true };
      })
      .mockImplementationOnce(async ({ dispatcherOptions }) => {
        await dispatcherOptions.deliver({ text: "Unauthorized stop" }, { kind: "final" });
        return { queuedFinal: true };
      });
    const unauthorizedReplyDelivered = observeDeliveredReply("Unauthorized stop");
    editMessageTelegram.mockResolvedValue({ ok: true, chatId: "123", messageId: "1001" });

    const firstPromise = dispatchWithContext({
      context: createContext({
        ctxPayload: {
          SessionKey: "s1",
          Body: "earlier request",
          RawBody: "earlier request",
        } as never,
      }),
    });

    await previewVisible;

    const unauthorizedPromise = dispatchWithContext({
      context: createContext({
        ctxPayload: {
          SessionKey: "s1",
          Body: "/stop",
          RawBody: "/stop",
          CommandBody: "/stop",
          CommandAuthorized: false,
        } as never,
      }),
    });

    await unauthorizedReplyDelivered;

    releaseFirstFinal();
    await Promise.all([firstPromise, unauthorizedPromise]);

    expect(editMessageTelegram).toHaveBeenCalledWith(
      123,
      1001,
      "Old reply final",
      expect.any(Object),
    );
  });

  it("uses configured doneHoldMs when clearing Telegram status reactions after reply", async () => {
    vi.useFakeTimers();
    const reactionApi = vi.fn(async () => true);
    const statusReactionController = createStatusReactionController();
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Done" }, { kind: "final" });
      return { queuedFinal: true };
    });
    deliverReplies.mockResolvedValue({ delivered: true });

    try {
      await dispatchWithContext({
        context: createContext({
          reactionApi: reactionApi as never,
          removeAckAfterReply: true,
          statusReactionController: statusReactionController as never,
        }),
        cfg: {
          messages: {
            statusReactions: {
              timing: {
                doneHoldMs: 250,
              },
            },
          },
        },
        streamMode: "off",
      });

      expect(statusReactionController.setDone).toHaveBeenCalledTimes(1);
      expect(statusReactionController.restoreInitial).not.toHaveBeenCalled();
      expect(reactionApi).not.toHaveBeenCalledWith(123, 456, []);

      await vi.advanceTimersByTimeAsync(249);
      expect(reactionApi).not.toHaveBeenCalledWith(123, 456, []);

      await vi.advanceTimersByTimeAsync(1);
      expect(reactionApi).toHaveBeenCalledWith(123, 456, []);
    } finally {
      vi.useRealTimers();
    }
  });

  it("restores the initial Telegram status reaction after reply when removeAckAfterReply is disabled", async () => {
    const reactionApi = vi.fn(async () => true);
    const statusReactionController = createStatusReactionController();
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Done" }, { kind: "final" });
      return { queuedFinal: true };
    });
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({
      context: createContext({
        reactionApi: reactionApi as never,
        removeAckAfterReply: false,
        statusReactionController: statusReactionController as never,
      }),
      streamMode: "off",
    });

    await vi.waitFor(() => {
      expect(statusReactionController.setDone).toHaveBeenCalledTimes(1);
      expect(statusReactionController.restoreInitial).toHaveBeenCalledTimes(1);
    });
    expect(statusReactionController.setError).not.toHaveBeenCalled();
    expect(reactionApi).not.toHaveBeenCalledWith(123, 456, []);
  });

  it("uses configured errorHoldMs to clear Telegram status reactions after an error fallback", async () => {
    vi.useFakeTimers();
    const reactionApi = vi.fn(async () => true);
    const statusReactionController = createStatusReactionController();
    dispatchReplyWithBufferedBlockDispatcher.mockRejectedValue(new Error("dispatcher exploded"));
    deliverReplies.mockResolvedValue({ delivered: true });

    try {
      await dispatchWithContext({
        context: createContext({
          reactionApi: reactionApi as never,
          removeAckAfterReply: true,
          statusReactionController: statusReactionController as never,
        }),
        cfg: {
          messages: {
            statusReactions: {
              timing: {
                errorHoldMs: 320,
              },
            },
          },
        },
        streamMode: "off",
      });

      expect(statusReactionController.setError).toHaveBeenCalledTimes(1);
      expect(statusReactionController.setDone).not.toHaveBeenCalled();
      expect(statusReactionController.restoreInitial).not.toHaveBeenCalled();
      expect(reactionApi).not.toHaveBeenCalledWith(123, 456, []);

      await vi.advanceTimersByTimeAsync(319);
      expect(reactionApi).not.toHaveBeenCalledWith(123, 456, []);

      await vi.advanceTimersByTimeAsync(1);
      expect(reactionApi).toHaveBeenCalledWith(123, 456, []);
    } finally {
      vi.useRealTimers();
    }
  });

  it("restores the initial Telegram status reaction after an error when no final reply is sent", async () => {
    vi.useFakeTimers();
    const reactionApi = vi.fn(async () => true);
    const statusReactionController = createStatusReactionController();
    dispatchReplyWithBufferedBlockDispatcher.mockRejectedValue(new Error("dispatcher exploded"));
    deliverReplies.mockResolvedValue({ delivered: false });

    try {
      await dispatchWithContext({
        context: createContext({
          reactionApi: reactionApi as never,
          removeAckAfterReply: true,
          statusReactionController: statusReactionController as never,
        }),
        cfg: {
          messages: {
            statusReactions: {
              timing: {
                errorHoldMs: 320,
              },
            },
          },
        },
        streamMode: "off",
      });

      expect(statusReactionController.setError).toHaveBeenCalledTimes(1);
      expect(statusReactionController.restoreInitial).not.toHaveBeenCalled();
      expect(reactionApi).not.toHaveBeenCalledWith(123, 456, []);

      await vi.advanceTimersByTimeAsync(319);
      expect(statusReactionController.restoreInitial).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(statusReactionController.restoreInitial).toHaveBeenCalledTimes(1);
      expect(reactionApi).not.toHaveBeenCalledWith(123, 456, []);
    } finally {
      vi.useRealTimers();
    }
  });

  it("restores the initial Telegram status reaction after an error fallback when removeAckAfterReply is disabled", async () => {
    const reactionApi = vi.fn(async () => true);
    const statusReactionController = createStatusReactionController();
    dispatchReplyWithBufferedBlockDispatcher.mockRejectedValue(new Error("dispatcher exploded"));
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({
      context: createContext({
        reactionApi: reactionApi as never,
        removeAckAfterReply: false,
        statusReactionController: statusReactionController as never,
      }),
      streamMode: "off",
    });

    await vi.waitFor(() => {
      expect(statusReactionController.setError).toHaveBeenCalledTimes(1);
      expect(statusReactionController.restoreInitial).toHaveBeenCalledTimes(1);
    });
    expect(statusReactionController.setDone).not.toHaveBeenCalled();
    expect(reactionApi).not.toHaveBeenCalledWith(123, 456, []);
  });

  it("uses resolved DM config for auto-topic-label overrides", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockResolvedValue({ queuedFinal: true });
    loadSessionStore.mockReturnValue({ s1: {} });
    const bot = createBot();

    await dispatchWithContext({
      bot,
      context: createContext({
        ctxPayload: {
          SessionKey: "s1",
          RawBody: "Need help with invoices",
        } as TelegramMessageContext["ctxPayload"],
        groupConfig: {
          autoTopicLabel: false,
        } as TelegramMessageContext["groupConfig"],
      }),
      telegramCfg: { autoTopicLabel: true },
      cfg: {
        channels: {
          telegram: {
            direct: {
              "123": { autoTopicLabel: true },
            },
          },
        },
      },
    });

    expect(generateTopicLabel).not.toHaveBeenCalled();
    expect(bot.api.editForumTopic).not.toHaveBeenCalled();
  });
});
