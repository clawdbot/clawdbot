// Telegram tests cover bot message dispatch plugin behavior.
import type { Bot } from "grammy";
import {
  createPluginStateKeyedStoreForTests,
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { setReplyPayloadMetadata } from "openclaw/plugin-sdk/reply-payload-testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAutoTopicLabelConfig as resolveAutoTopicLabelConfigRuntime } from "./auto-topic-label-config.js";
import type { TelegramBotDeps } from "./bot-deps.js";
import {
  createSequencedTestDraftStream,
  createTestDraftStream,
} from "./draft-stream.test-helpers.js";
import { notifyTelegramInboundEventOutboundSuccess } from "./inbound-event-delivery.js";
import {
  buildTelegramConversationContext,
  createTelegramMessageCache,
  resolveTelegramMessageCacheScope,
} from "./message-cache.js";
import {
  recordOutboundMessageForPromptContext as recordOutboundMessageForPromptContextActual,
  registerTelegramOutboundGroupHistoryRecorder,
} from "./outbound-message-context.js";
import { clearTelegramRuntime, setTelegramRuntime } from "./runtime.js";
import type { TelegramRuntime } from "./runtime.types.js";

type DispatchReplyWithBufferedBlockDispatcherArgs = Parameters<
  TelegramBotDeps["dispatchReplyWithBufferedBlockDispatcher"]
>[0];

const createTelegramDraftStream = vi.hoisted(() => vi.fn());
const dispatchReplyWithBufferedBlockDispatcher = vi.hoisted(() =>
  vi.fn<(params: DispatchReplyWithBufferedBlockDispatcherArgs) => Promise<unknown>>(),
);
const deliverReplies = vi.hoisted(() => vi.fn());
const deliverInboundReplyWithMessageSendContext = vi.hoisted(() => vi.fn());
const emitInternalMessageSentHook = vi.hoisted(() => vi.fn());
const recordOutboundMessageForPromptContext = vi.hoisted(() => vi.fn());
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
const createChannelMessageReplyPipeline = vi.hoisted(() =>
  vi.fn(() => ({
    responsePrefix: undefined,
    responsePrefixContextProvider: () => ({ identityName: undefined }),
    resolveResponsePrefix: () => undefined,
    onModelSelected: () => undefined,
  })),
);
const wasSentByBot = vi.hoisted(() => vi.fn(() => false));
const appendAssistantMirrorMessageByIdentity = vi.hoisted(() =>
  vi.fn<
    (
      params?: unknown,
    ) => Promise<
      | { ok: true; sessionFile: string; messageId: string }
      | { ok: false; reason: string; code?: "blocked" | "session-rebound" }
    >
  >(async () => ({
    ok: true,
    sessionFile: "/tmp/sessions/s1.jsonl",
    messageId: "m1",
  })),
);
const getSessionEntry = vi.hoisted(() => vi.fn());
const loadSessionStore = vi.hoisted(() => vi.fn());
const readLatestAssistantTextByIdentity = vi.hoisted(() =>
  vi.fn<() => Promise<{ id?: string; text: string; timestamp?: number } | undefined>>(
    async () => undefined,
  ),
);
const resolveStorePath = vi.hoisted(() => vi.fn(() => "/tmp/sessions.json"));
const generateTopicLabel = vi.hoisted(() => vi.fn());
const describeStickerImage = vi.hoisted(() => vi.fn(async (): Promise<string | null> => null));
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

vi.mock("./draft-stream.js", () => ({
  createTelegramDraftStream,
}));

vi.mock("openclaw/plugin-sdk/channel-outbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-outbound")>();
  return {
    ...actual,
    deliverInboundReplyWithMessageSendContext,
  };
});

vi.mock("openclaw/plugin-sdk/session-transcript-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/session-transcript-runtime")>();
  return {
    ...actual,
    appendAssistantMirrorMessageByIdentity,
    readLatestAssistantTextByIdentity,
  };
});

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
  getSessionEntry,
  getAgentScopedMediaLocalRoots,
  resolveAutoTopicLabelConfig: resolveAutoTopicLabelConfigRuntime,
  resolveChunkMode,
  resolveMarkdownTableMode,
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
let resetTelegramReplyFenceForTests: typeof import("./bot-message-dispatch.js").resetTelegramReplyFenceForTests;

function installTelegramStateRuntimeForTest(): void {
  setTelegramRuntime({
    state: {
      openKeyedStore: ((options) =>
        createPluginStateKeyedStoreForTests(
          "telegram",
          options,
        )) as TelegramRuntime["state"]["openKeyedStore"],
      openSyncKeyedStore: ((options) =>
        createPluginStateSyncKeyedStoreForTests(
          "telegram",
          options,
        )) as TelegramRuntime["state"]["openSyncKeyedStore"],
    },
    channel: {},
  } as TelegramRuntime);
}

const telegramDepsForTest: TelegramBotDeps = {
  getRuntimeConfig: loadConfig as TelegramBotDeps["getRuntimeConfig"],
  resolveStorePath: resolveStorePath as TelegramBotDeps["resolveStorePath"],
  getSessionEntry: getSessionEntry as TelegramBotDeps["getSessionEntry"],
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
  createChannelMessageReplyPipeline:
    createChannelMessageReplyPipeline as TelegramBotDeps["createChannelMessageReplyPipeline"],
  wasSentByBot: wasSentByBot as TelegramBotDeps["wasSentByBot"],
  createTelegramDraftStream:
    createTelegramDraftStream as TelegramBotDeps["createTelegramDraftStream"],
  deliverReplies: deliverReplies as TelegramBotDeps["deliverReplies"],
  deliverInboundReplyWithMessageSendContext:
    deliverInboundReplyWithMessageSendContext as TelegramBotDeps["deliverInboundReplyWithMessageSendContext"],
  emitInternalMessageSentHook:
    emitInternalMessageSentHook as TelegramBotDeps["emitInternalMessageSentHook"],
  editMessageTelegram: editMessageTelegram as TelegramBotDeps["editMessageTelegram"],
  recordOutboundMessageForPromptContext:
    recordOutboundMessageForPromptContext as TelegramBotDeps["recordOutboundMessageForPromptContext"],
};

describe("dispatchTelegramMessage draft streaming", () => {
  type TelegramMessageContext = Parameters<typeof dispatchTelegramMessage>[0]["context"];
  const trailingFinalStatusText = "Post-final plugin status";

  beforeAll(async () => {
    ({ dispatchTelegramMessage, resetTelegramReplyFenceForTests } =
      await import("./bot-message-dispatch.js"));
  });

  beforeEach(() => {
    resetPluginStateStoreForTests({ closeDatabase: false });
    installTelegramStateRuntimeForTest();
    resetTelegramReplyFenceForTests();
    createTelegramDraftStream.mockReset();
    dispatchReplyWithBufferedBlockDispatcher.mockReset();
    deliverReplies.mockReset();
    deliverInboundReplyWithMessageSendContext.mockReset();
    emitInternalMessageSentHook.mockReset();
    recordOutboundMessageForPromptContext.mockReset();
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
    createChannelMessageReplyPipeline.mockReset();
    wasSentByBot.mockReset();
    appendAssistantMirrorMessageByIdentity.mockReset();
    readLatestAssistantTextByIdentity.mockReset();
    getSessionEntry.mockReset();
    loadSessionStore.mockReset();
    resolveStorePath.mockReset();
    generateTopicLabel.mockReset();
    getAgentScopedMediaLocalRoots.mockClear();
    resolveChunkMode.mockClear();
    resolveMarkdownTableMode.mockClear();
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
    deliverInboundReplyWithMessageSendContext.mockResolvedValue({
      status: "unsupported",
      reason: "missing_outbound_handler",
    });
    emitInternalMessageSentHook.mockResolvedValue(undefined);
    recordOutboundMessageForPromptContext.mockResolvedValue(true);
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
    createChannelMessageReplyPipeline.mockReturnValue({
      responsePrefix: undefined,
      responsePrefixContextProvider: () => ({ identityName: undefined }),
      resolveResponsePrefix: () => undefined,
      onModelSelected: () => undefined,
    });
    wasSentByBot.mockReturnValue(false);
    resolveStorePath.mockReturnValue("/tmp/sessions.json");
    readLatestAssistantTextByIdentity.mockResolvedValue(undefined);
    appendAssistantMirrorMessageByIdentity.mockResolvedValue({
      ok: true,
      sessionFile: "/tmp/sessions/s1.jsonl",
      messageId: "m1",
    });
    loadSessionStore.mockReturnValue({});
    getSessionEntry.mockImplementation(
      ({ sessionKey }: { sessionKey: string }) =>
        (loadSessionStore() as Record<string, unknown>)[sessionKey],
    );
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

  afterEach(() => {
    clearTelegramRuntime();
    resetPluginStateStoreForTests();
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

  function mockDefaultSessionEntry(entry: Record<string, unknown> = { sessionId: "s1" }) {
    loadSessionStore.mockReturnValue({
      "agent:default:telegram:direct:123": {
        updatedAt: 1,
        ...entry,
      },
    });
  }

  function expectRecordFields(record: unknown, expected: Record<string, unknown>) {
    if (!record || typeof record !== "object") {
      throw new Error("Expected record");
    }
    const actual = record as Record<string, unknown>;
    for (const [key, value] of Object.entries(expected)) {
      expect(actual[key]).toEqual(value);
    }
    return actual;
  }

  function mockCallArg(mock: ReturnType<typeof vi.fn>, callIndex = 0, argIndex = 0) {
    const call = mock.mock.calls[callIndex];
    if (!call) {
      throw new Error(`Expected mock call ${callIndex}`);
    }
    return call[argIndex];
  }

  function expectDraftStreamParams(expected: Record<string, unknown>) {
    return expectRecordFields(mockCallArg(createTelegramDraftStream), expected);
  }

  function telegramProgressPreview(_plainText: string, html: string) {
    return {
      text: html.replaceAll("\n", "<br>"),
      parseMode: "HTML" as const,
    };
  }

  function expectDeliverRepliesParams(expected: Record<string, unknown>, callIndex = 0) {
    return expectRecordFields(mockCallArg(deliverReplies, callIndex), expected);
  }

  function expectDeliveredReply(index: number, expected: Record<string, unknown>, callIndex = 0) {
    const params = expectDeliverRepliesParams({}, callIndex);
    const replies = params.replies as Array<unknown> | undefined;
    if (!Array.isArray(replies)) {
      throw new Error("Expected delivered replies array");
    }
    return expectRecordFields(replies[index], expected);
  }

  function expectDispatchParams(expected: Record<string, unknown>) {
    return expectRecordFields(mockCallArg(dispatchReplyWithBufferedBlockDispatcher), expected);
  }

  // The collapse bar edits the live window message in place (finalizeToPreview)
  // instead of deleting it and reposting the bar as a new message.
  function expectWindowCollapsedTo(
    stream: { finalizeToPreview: { mock: { calls: unknown[][] } } },
    barText: string,
  ) {
    const calls = stream.finalizeToPreview.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const preview = calls[calls.length - 1][0] as { text?: string };
    expect(preview.text).toBe(barText);
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
      sendChatActionHandler: { sendChatAction: vi.fn(async () => undefined) },
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

  function createDirectSessionPayload(): TelegramMessageContext["ctxPayload"] {
    return {
      SessionKey: "agent:test:telegram:direct:123",
      ChatType: "direct",
    } as TelegramMessageContext["ctxPayload"];
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
    retryDispatchErrors?: boolean;
    suppressFailureFallback?: boolean;
    textLimit?: number;
    onTurnAdopted?: Parameters<typeof dispatchTelegramMessage>[0]["onTurnAdopted"];
    onTurnDeferred?: Parameters<typeof dispatchTelegramMessage>[0]["onTurnDeferred"];
    onTurnAbandoned?: Parameters<typeof dispatchTelegramMessage>[0]["onTurnAbandoned"];
    turnAbortSignal?: Parameters<typeof dispatchTelegramMessage>[0]["turnAbortSignal"];
  }) {
    const bot = params.bot ?? createBot();
    return await dispatchTelegramMessage({
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
      retryDispatchErrors: params.retryDispatchErrors,
      suppressFailureFallback: params.suppressFailureFallback,
      onTurnAdopted: params.onTurnAdopted,
      onTurnDeferred: params.onTurnDeferred,
      onTurnAbandoned: params.onTurnAbandoned,
      turnAbortSignal: params.turnAbortSignal,
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

  function createReasoningDefaultContext(): TelegramMessageContext {
    loadSessionStore.mockReturnValue({
      s1: {},
    });
    return createContext({
      ctxPayload: { SessionKey: "s1" } as unknown as TelegramMessageContext["ctxPayload"],
      route: { agentId: "ops" } as unknown as TelegramMessageContext["route"],
    });
  }

  function createReasoningForumTopicContext(): TelegramMessageContext {
    loadSessionStore.mockReturnValue({
      s1: { reasoningLevel: "stream" },
    });
    return createContext({
      ctxPayload: { SessionKey: "s1" } as unknown as TelegramMessageContext["ctxPayload"],
      msg: {
        chat: { id: -100123, type: "supergroup", is_forum: true },
        message_id: 456,
        message_thread_id: 88,
      } as unknown as TelegramMessageContext["msg"],
      chatId: -100123,
      isGroup: true,
      threadSpec: { id: 88, scope: "forum" },
    });
  }

  it("skips general understanding after describing a first-seen non-vision sticker", async () => {
    describeStickerImage.mockResolvedValueOnce("A curious sticker");
    const ctxPayload = {
      MediaPath: "/tmp/sticker.webp",
      Sticker: {
        fileId: "sticker-file",
        fileUniqueId: "sticker-unique",
      },
      StickerMediaIncluded: true,
    } as TelegramMessageContext["ctxPayload"];

    await dispatchWithContext({
      context: createContext({ ctxPayload }),
    });

    expect(describeStickerImage).toHaveBeenCalledOnce();
    expect(ctxPayload.BodyForAgent).toBe("[Sticker] A curious sticker");
    expect(ctxPayload.SkipStickerMediaUnderstanding).toBe(true);
    expectDispatchParams({
      ctx: expect.objectContaining({
        SkipStickerMediaUnderstanding: true,
      }),
    });
  });

  it("preserves cached sticker descriptions with user text through dispatch", async () => {
    const body = "[Sticker] Cached description\nWhat is this?";
    const ctxPayload = {
      Body: body,
      BodyForAgent: body,
      MediaPath: "/tmp/sticker.webp",
      Sticker: {
        fileId: "sticker-file",
        fileUniqueId: "sticker-unique",
        cachedDescription: "Cached description",
      },
      StickerMediaIncluded: true,
      SkipStickerMediaUnderstanding: true,
    } as TelegramMessageContext["ctxPayload"];

    await dispatchWithContext({
      context: createContext({ ctxPayload }),
    });

    expect(describeStickerImage).not.toHaveBeenCalled();
    expect(ctxPayload.Body).toBe(body);
    expect(ctxPayload.BodyForAgent).toBe(body);
    expectDispatchParams({
      ctx: expect.objectContaining({
        BodyForAgent: body,
        SkipStickerMediaUnderstanding: true,
      }),
    });
  });

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

    expectDraftStreamParams({
      chatId: 123,
      thread: { id: 777, scope: "dm" },
      minInitialChars: 30,
    });
    expect(draftStream.update).toHaveBeenCalledWith("Hello");
    const delivery = expectDeliverRepliesParams({ thread: { id: 777, scope: "dm" } });
    const mediaLocalRoots = delivery.mediaLocalRoots as string[] | undefined;
    expect(mediaLocalRoots?.some((root) => /[\\/]\.openclaw[\\/]workspace-work$/u.test(root))).toBe(
      true,
    );
    const dispatchParams = expectDispatchParams({});
    expect(
      typeof (dispatchParams.dispatcherOptions as { beforeDeliver?: unknown }).beforeDeliver,
    ).toBe("function");
    expectRecordFields(dispatchParams.replyOptions, { disableBlockStreaming: true });
    expect(editMessageTelegram).not.toHaveBeenCalled();
    expect(draftStream.clear).toHaveBeenCalledTimes(1);
  });

  it("renders default draft previews with standard Telegram HTML", async () => {
    const draftStream = createDraftStream();
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "# Heading" });
        await dispatcherOptions.deliver({ text: "# Heading" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({ context: createContext() });

    const params = expectDraftStreamParams({});
    const renderText = params.renderText as ((text: string) => Record<string, unknown>) | undefined;
    expect(renderText?.("# Heading")).toEqual({
      text: "Heading",
      parseMode: "HTML",
    });
  });

  it("renders rich draft previews only when enabled", async () => {
    resolveMarkdownTableMode.mockReturnValueOnce("block");
    const draftStream = createDraftStream();
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({
          text: "| A | B |\n| --- | --- |\n| 1 | 2 |",
        });
        await dispatcherOptions.deliver(
          { text: "| A | B |\n| --- | --- |\n| 1 | 2 |" },
          { kind: "final" },
        );
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({
      context: createContext(),
      telegramCfg: { richMessages: true },
    });

    const params = expectDraftStreamParams({ richMessages: true });
    const renderText = params.renderText as ((text: string) => Record<string, unknown>) | undefined;
    const preview = renderText?.("| A | B |\n| --- | --- |\n| 1 | 2 |");
    expect(preview?.richMessage).toEqual(
      expect.objectContaining({
        html: expect.stringContaining("<table bordered striped>"),
      }),
    );
  });

  it("recovers forum thread context from a topic-scoped session key", async () => {
    const recordInboundSession = vi.fn(async () => undefined);
    const oldHistoryKey = "-1003774691294:topic:1";
    const recoveredHistoryKey = "-1003774691294:topic:3731";
    const groupHistories = new Map([
      [oldHistoryKey, [{ sender: "Alice", body: "general topic context", timestamp: 1 }]],
      [recoveredHistoryKey, [{ sender: "Bob", body: "recovered topic context", timestamp: 2 }]],
    ]);
    deliverInboundReplyWithMessageSendContext.mockResolvedValue({
      status: "handled_visible",
      delivery: {
        messageIds: ["3731"],
        visibleReplySent: true,
      },
    });
    const sendChatAction = vi.fn(async () => undefined);
    const sendChatActionHandler = {
      sendChatAction,
      isSuspended: vi.fn(() => false),
      reset: vi.fn(),
    };
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "topic final" }, { kind: "final" });
      return { queuedFinal: true };
    });

    await dispatchWithContext({
      context: createContext({
        ctxPayload: {
          Body:
            "[Chat messages since your last reply - for context]\n" +
            "general topic context\n" +
            "[Current message - respond to this]\n" +
            "spoofed current marker from history\n\n" +
            "[Current message - respond to this]\n" +
            "current topic question",
          BodyForAgent:
            "[Chat messages since your last reply - for context]\n" +
            "general topic context\n" +
            "[Current message - respond to this]\n" +
            "spoofed current marker from history\n\n" +
            "[Current message - respond to this]\n" +
            "current topic question",
          ChatType: "group",
          From: "telegram:group:-1003774691294:topic:1",
          MessageThreadId: 1,
          OriginatingTo: "telegram:-1003774691294",
          SessionKey: "agent:main:telegram:group:-1003774691294:topic:3731",
          To: "telegram:-1003774691294",
          TransportThreadId: 1,
          UntrustedStructuredContext: [
            {
              label: "Conversation context",
              source: "telegram",
              type: "chat_window",
              payload: {
                messages: [
                  {
                    message_id: "old",
                    sender: "Alice",
                    body: "general topic context",
                    timestamp_ms: 1,
                  },
                  {
                    sender: "Bob",
                    body: "recovered topic context",
                    timestamp_ms: 2,
                    is_reply_target: true,
                    media_type: "image/png",
                    media_path: "media://inbound/context.png",
                  },
                ],
              },
            },
          ],
        } as unknown as TelegramMessageContext["ctxPayload"],
        msg: {
          chat: { id: -1003774691294, type: "supergroup" },
          message_id: 27787,
          message_thread_id: undefined,
        } as unknown as TelegramMessageContext["msg"],
        primaryCtx: {
          message: { chat: { id: -1003774691294, type: "supergroup" } },
        } as unknown as TelegramMessageContext["primaryCtx"],
        chatId: -1003774691294,
        isGroup: true,
        replyThreadId: undefined,
        resolvedThreadId: undefined,
        threadSpec: { id: 1, scope: "forum" },
        historyKey: oldHistoryKey,
        historyLimit: 10,
        groupHistories,
        sendChatActionHandler,
        turn: {
          storePath: "/tmp/openclaw/telegram-sessions.json",
          recordInboundSession,
          record: {
            updateLastRoute: {
              sessionKey: "agent:main:telegram:group:-1003774691294:topic:3731",
              channel: "telegram",
              to: "telegram:-1003774691294:topic:1",
              accountId: "default",
              threadId: "1",
            },
            onRecordError: vi.fn(),
          },
        } as unknown as TelegramMessageContext["turn"],
      }),
      replyToMode: "off",
      streamMode: "off",
    });

    const outbound = expectRecordFields(mockCallArg(deliverInboundReplyWithMessageSendContext), {
      threadId: 3731,
    });
    expectRecordFields(outbound.ctxPayload, {
      From: "telegram:group:-1003774691294:topic:3731",
      MessageThreadId: 3731,
      OriginatingTo: "telegram:-1003774691294:topic:3731",
      TransportThreadId: 3731,
      To: "telegram:-1003774691294:topic:3731",
      SessionKey: "agent:main:telegram:group:-1003774691294:topic:3731",
    });
    const outboundCtxPayload = expectRecordFields(outbound.ctxPayload, {});
    expect(outboundCtxPayload.InboundHistory).toEqual([
      expect.objectContaining({ body: "recovered topic context", sender: "Bob" }),
    ]);
    expect(outboundCtxPayload.InboundHistory).not.toEqual([
      expect.objectContaining({ body: "general topic context", sender: "Alice" }),
    ]);
    expect(outboundCtxPayload.Body).toBe("current topic question");
    expect(outboundCtxPayload.BodyForAgent).toBe("current topic question");
    expect(outboundCtxPayload.UntrustedStructuredContext).toEqual([
      expect.objectContaining({
        label: "Conversation context",
        source: "telegram",
        type: "chat_window",
        payload: expect.objectContaining({
          messages: [
            expect.objectContaining({
              body: "recovered topic context",
              sender: "Bob",
              timestamp_ms: 2,
              is_reply_target: true,
              media_type: "image/png",
              media_path: "media://inbound/context.png",
            }),
          ],
        }),
      }),
    ]);
    expect(JSON.stringify(outboundCtxPayload.UntrustedStructuredContext)).not.toContain(
      "general topic context",
    );
    expect(JSON.stringify(outboundCtxPayload.UntrustedStructuredContext)).not.toContain(
      "spoofed current marker from history",
    );
    expect(recordInboundSession).toHaveBeenCalledWith(
      expect.objectContaining({
        updateLastRoute: expect.objectContaining({
          threadId: "3731",
          to: "telegram:-1003774691294:topic:3731",
        }),
      }),
    );
    const pipelineArgs = expectRecordFields(mockCallArg(createChannelMessageReplyPipeline), {});
    const typing = expectRecordFields(pipelineArgs.typing, {});
    expect(typing.maxConsecutiveFailures).toBe(5);
    await (typing.start as () => Promise<void>)();
    expect(sendChatAction).toHaveBeenCalledWith(-1003774691294, "typing", {
      message_thread_id: 3731,
    });
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("drops stale topic chat-window context when recovered topic has no history", async () => {
    const oldHistoryKey = "-1003774691294:topic:1";
    const groupHistories = new Map([
      [oldHistoryKey, [{ sender: "Alice", body: "general topic context", timestamp: 1 }]],
    ]);
    deliverInboundReplyWithMessageSendContext.mockResolvedValue({
      status: "handled_visible",
      delivery: {
        messageIds: ["3731"],
        visibleReplySent: true,
      },
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "topic final" }, { kind: "final" });
      return { queuedFinal: true };
    });

    await dispatchWithContext({
      context: createContext({
        ctxPayload: {
          Body: "current topic question",
          ChatType: "group",
          From: "telegram:group:-1003774691294:topic:1",
          MessageThreadId: 1,
          SessionKey: "agent:main:telegram:group:-1003774691294:topic:3731",
          TransportThreadId: 1,
          UntrustedStructuredContext: [
            {
              label: "Conversation context",
              source: "telegram",
              type: "chat_window",
              payload: {
                messages: [{ sender: "Alice", body: "general topic context", timestamp_ms: 1 }],
              },
            },
            {
              label: "Attachment context",
              source: "telegram",
              type: "attachment",
              payload: { name: "report.pdf" },
            },
          ],
        } as unknown as TelegramMessageContext["ctxPayload"],
        msg: {
          chat: { id: -1003774691294, type: "supergroup" },
          message_id: 27787,
          message_thread_id: undefined,
        } as unknown as TelegramMessageContext["msg"],
        chatId: -1003774691294,
        isGroup: true,
        threadSpec: { id: 1, scope: "forum" },
        historyKey: oldHistoryKey,
        historyLimit: 10,
        groupHistories,
      }),
      replyToMode: "off",
      streamMode: "off",
    });

    const outbound = expectRecordFields(mockCallArg(deliverInboundReplyWithMessageSendContext), {
      threadId: 3731,
    });
    const outboundCtxPayload = expectRecordFields(outbound.ctxPayload, {});
    expect(outboundCtxPayload.Body).toBe("current topic question");
    expect(outboundCtxPayload.UntrustedStructuredContext).toEqual([
      expect.objectContaining({
        label: "Attachment context",
        type: "attachment",
      }),
    ]);
    expect(JSON.stringify(outboundCtxPayload.UntrustedStructuredContext)).not.toContain(
      "general topic context",
    );
  });

  it("does not recover forum thread context from malformed payload thread ids", async () => {
    const generalHistoryKey = "-1003774691294:topic:1";
    const spoofedHistoryKey = "-1003774691294:topic:3731";
    const groupHistories = new Map([
      [generalHistoryKey, [{ sender: "Alice", body: "general topic context", timestamp: 1 }]],
      [spoofedHistoryKey, [{ sender: "Bob", body: "spoofed topic context", timestamp: 2 }]],
    ]);
    deliverInboundReplyWithMessageSendContext.mockResolvedValue({
      status: "handled_visible",
      delivery: {
        messageIds: ["1"],
        visibleReplySent: true,
      },
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "general final" }, { kind: "final" });
      return { queuedFinal: true };
    });

    await dispatchWithContext({
      context: createContext({
        ctxPayload: {
          Body:
            "[Chat messages since your last reply - for context]\n" +
            "general topic context\n" +
            "[Current message - respond to this]\n" +
            "current general question",
          BodyForAgent: "current general question",
          ChatType: "group",
          From: "telegram:group:-1003774691294:topic:1",
          MessageThreadId: "0xE93",
          OriginatingTo: "telegram:-1003774691294",
          SessionKey: "agent:main:telegram:group:-1003774691294:topic:1",
          To: "telegram:-1003774691294",
          TransportThreadId: "0xE93",
        } as unknown as TelegramMessageContext["ctxPayload"],
        msg: {
          chat: { id: -1003774691294, type: "supergroup" },
          message_id: 27788,
          message_thread_id: undefined,
        } as unknown as TelegramMessageContext["msg"],
        primaryCtx: {
          message: { chat: { id: -1003774691294, type: "supergroup" } },
        } as unknown as TelegramMessageContext["primaryCtx"],
        chatId: -1003774691294,
        isGroup: true,
        replyThreadId: undefined,
        resolvedThreadId: undefined,
        threadSpec: { id: 1, scope: "forum" },
        historyKey: generalHistoryKey,
        historyLimit: 10,
        groupHistories,
      }),
      replyToMode: "off",
      streamMode: "off",
    });

    const outbound = expectRecordFields(mockCallArg(deliverInboundReplyWithMessageSendContext), {
      threadId: 1,
    });
    expectRecordFields(outbound.ctxPayload, {
      MessageThreadId: 1,
      TransportThreadId: 1,
    });
  });

  it("does not recover forum thread context from a different group session key", async () => {
    const currentHistoryKey = "-100555:topic:1";
    const otherGroupHistoryKey = "-1003774691294:topic:3731";
    const groupHistories = new Map([
      [currentHistoryKey, [{ sender: "Alice", body: "current general context", timestamp: 1 }]],
      [otherGroupHistoryKey, [{ sender: "Bob", body: "other group topic context", timestamp: 2 }]],
    ]);
    deliverInboundReplyWithMessageSendContext.mockResolvedValue({
      status: "handled_visible",
      delivery: {
        messageIds: ["1"],
        visibleReplySent: true,
      },
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "current group final" }, { kind: "final" });
      return { queuedFinal: true };
    });

    await dispatchWithContext({
      context: createContext({
        ctxPayload: {
          Body: "current group question",
          ChatType: "group",
          From: "telegram:group:-100555:topic:1",
          MessageThreadId: 1,
          OriginatingTo: "telegram:-100555",
          SessionKey: "agent:main:telegram:group:-1003774691294:topic:3731",
          To: "telegram:-100555",
          TransportThreadId: 1,
        } as unknown as TelegramMessageContext["ctxPayload"],
        msg: {
          chat: { id: -100555, type: "supergroup" },
          message_id: 27788,
          message_thread_id: undefined,
        } as unknown as TelegramMessageContext["msg"],
        primaryCtx: {
          message: { chat: { id: -100555, type: "supergroup" } },
        } as unknown as TelegramMessageContext["primaryCtx"],
        chatId: -100555,
        isGroup: true,
        replyThreadId: undefined,
        resolvedThreadId: undefined,
        threadSpec: { id: 1, scope: "forum" },
        historyKey: currentHistoryKey,
        historyLimit: 10,
        groupHistories,
      }),
      replyToMode: "off",
      streamMode: "off",
    });

    const outbound = expectRecordFields(mockCallArg(deliverInboundReplyWithMessageSendContext), {
      threadId: 1,
      to: "-100555",
    });
    expectRecordFields(outbound.ctxPayload, {
      From: "telegram:group:-100555:topic:1",
      MessageThreadId: 1,
      OriginatingTo: "telegram:-100555",
      TransportThreadId: 1,
      To: "telegram:-100555",
      SessionKey: "agent:main:telegram:group:-1003774691294:topic:3731",
    });
    const outboundCtxPayload = expectRecordFields(outbound.ctxPayload, {});
    expect(outboundCtxPayload.Body).not.toContain("other group topic context");
    expect(groupHistories.get(otherGroupHistoryKey)).toEqual([
      expect.objectContaining({ body: "other group topic context" }),
    ]);
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("moves recovered room-event history out of the original topic", async () => {
    const oldHistoryKey = "-1003774691294:topic:1";
    const recoveredHistoryKey = "-1003774691294:topic:3731";
    const groupHistories = new Map([
      [
        oldHistoryKey,
        [
          { sender: "Alice", body: "general topic context", timestamp: 1 },
          { sender: "Cara", body: "ambient leak", timestamp: 2, messageId: "27787" },
        ],
      ],
      [recoveredHistoryKey, [{ sender: "Bob", body: "recovered topic context", timestamp: 3 }]],
    ]);
    dispatchReplyWithBufferedBlockDispatcher.mockResolvedValue({
      queuedFinal: false,
      counts: { block: 0, final: 0, tool: 0 },
      sourceReplyDeliveryMode: "message_tool_only",
    });

    await dispatchWithContext({
      context: createContext({
        ctxPayload: {
          InboundEventKind: "room_event",
          ChatType: "group",
          From: "telegram:group:-1003774691294:topic:1",
          MessageSid: "27787",
          MessageThreadId: 1,
          RawBody: "ambient leak",
          SessionKey: "agent:main:telegram:group:-1003774691294:topic:3731",
          TransportThreadId: 1,
        } as unknown as TelegramMessageContext["ctxPayload"],
        msg: {
          chat: { id: -1003774691294, type: "supergroup" },
          message_id: 27787,
        } as unknown as TelegramMessageContext["msg"],
        chatId: -1003774691294,
        isGroup: true,
        threadSpec: { id: 1, scope: "forum" },
        historyKey: oldHistoryKey,
        historyLimit: 10,
        groupHistories,
      }),
      replyToMode: "off",
      streamMode: "off",
    });

    expect(groupHistories.get(oldHistoryKey)).toEqual([
      expect.objectContaining({ body: "general topic context" }),
    ]);
    expect(groupHistories.get(recoveredHistoryKey)).toEqual([
      expect.objectContaining({ body: "recovered topic context" }),
      expect.objectContaining({ body: "ambient leak", messageId: "27787" }),
    ]);
  });

  it("omits transcript-owned ambient rows from recovered room-event prompt text", async () => {
    const oldHistoryKey = "-1003774691294:topic:1";
    const recoveredHistoryKey = "-1003774691294:topic:3731";
    const groupHistories = new Map([
      [
        oldHistoryKey,
        [{ sender: "Cara", body: "ambient current", timestamp: 3, messageId: "27787" }],
      ],
      [
        recoveredHistoryKey,
        [
          {
            sender: "Alice",
            body: "persisted recovered ambient one",
            timestamp: 1,
            messageId: "199",
          },
          {
            sender: "Bob",
            body: "persisted recovered ambient two",
            timestamp: 2,
            messageId: "200",
          },
        ],
      ],
    ]);
    dispatchReplyWithBufferedBlockDispatcher.mockResolvedValue({
      queuedFinal: false,
      counts: { block: 0, final: 0, tool: 0 },
      sourceReplyDeliveryMode: "message_tool_only",
    });

    await dispatchWithContext({
      context: createContext({
        ctxPayload: {
          InboundEventKind: "room_event",
          BodyForAgent: "ambient current",
          ChatType: "group",
          From: "telegram:group:-1003774691294:topic:1",
          MessageSid: "27787",
          MessageThreadId: 1,
          RawBody: "ambient current",
          SenderName: "Cara",
          SessionKey: "agent:main:telegram:group:-1003774691294:topic:3731",
          TransportThreadId: 1,
          AmbientTranscriptPreviousMessageId: "200",
          AmbientTranscriptPreviousTimestampMs: 2,
        } as TelegramMessageContext["ctxPayload"],
        msg: {
          chat: { id: -1003774691294, type: "supergroup" },
          message_id: 27787,
        } as TelegramMessageContext["msg"],
        chatId: -1003774691294,
        isGroup: true,
        threadSpec: { id: 1, scope: "forum" },
        historyKey: oldHistoryKey,
        historyLimit: 10,
        groupHistories,
      }),
      replyToMode: "off",
      streamMode: "off",
    });

    const dispatchParams = mockCallArg(
      dispatchReplyWithBufferedBlockDispatcher,
    ) as DispatchReplyWithBufferedBlockDispatcherArgs;
    expect(dispatchParams.ctx).toMatchObject({
      BodyForAgent: "ambient current",
      InboundEventKind: "room_event",
      MessageSid: "27787",
      SenderName: "Cara",
    });
    expect(dispatchParams.ctx.InboundHistory).toBeUndefined();
    expect(dispatchParams.ctx.UntrustedStructuredContext).toBeUndefined();
  });

  it("moves recovered user-request history out of the original topic", async () => {
    const oldHistoryKey = "-1003774691294:topic:1";
    const recoveredHistoryKey = "-1003774691294:topic:3731";
    const groupHistories = new Map([
      [
        oldHistoryKey,
        [
          { sender: "Alice", body: "general topic context", timestamp: 1 },
          { sender: "Cara", body: "topic request", timestamp: 4, messageId: "27789" },
        ],
      ],
      [
        recoveredHistoryKey,
        [
          { sender: "Bob", body: "before self marker", timestamp: 2 },
          { sender: "OpenClaw (you)", body: "self marker", timestamp: 3 },
          { sender: "Dana", body: "after watermark", timestamp: 4 },
        ],
      ],
    ]);
    deliverInboundReplyWithMessageSendContext.mockResolvedValue({
      status: "handled_visible",
      delivery: {
        messageIds: ["3731"],
        visibleReplySent: true,
      },
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "topic final" }, { kind: "final" });
      return { queuedFinal: true };
    });

    await dispatchWithContext({
      context: createContext({
        ctxPayload: {
          InboundEventKind: "user_request",
          BodyForAgent: "current recovered request",
          ChatType: "group",
          From: "telegram:group:-1003774691294:topic:1",
          MessageSid: "27789",
          MessageThreadId: 1,
          RawBody: "topic request",
          SessionKey: "agent:main:telegram:group:-1003774691294:topic:3731",
          TransportThreadId: 1,
        } as unknown as TelegramMessageContext["ctxPayload"],
        msg: {
          chat: { id: -1003774691294, type: "supergroup" },
          message_id: 27789,
        } as unknown as TelegramMessageContext["msg"],
        primaryCtx: {
          message: { chat: { id: -1003774691294, type: "supergroup" } },
        } as unknown as TelegramMessageContext["primaryCtx"],
        chatId: -1003774691294,
        isGroup: true,
        threadSpec: { id: 1, scope: "forum" },
        historyKey: oldHistoryKey,
        historyLimit: 10,
        groupHistories,
      }),
      replyToMode: "off",
      streamMode: "off",
    });

    expect(groupHistories.get(oldHistoryKey)).toEqual([
      expect.objectContaining({ body: "general topic context" }),
    ]);
    expect(groupHistories.get(recoveredHistoryKey)).toEqual([
      expect.objectContaining({ body: "before self marker" }),
      expect.objectContaining({ body: "self marker" }),
      expect.objectContaining({ body: "after watermark" }),
      expect.objectContaining({ body: "topic request", messageId: "27789" }),
    ]);
    const outbound = expectRecordFields(mockCallArg(deliverInboundReplyWithMessageSendContext), {
      threadId: 3731,
    });
    const outboundCtxPayload = expectRecordFields(outbound.ctxPayload, {});
    expect(outboundCtxPayload.InboundHistory).toEqual([
      expect.objectContaining({ body: "after watermark" }),
    ]);
    expect(outboundCtxPayload.Body).toBe("current recovered request");
    expect(outboundCtxPayload.UntrustedStructuredContext).toEqual([
      expect.objectContaining({
        label: "Conversation context",
        source: "telegram",
        type: "chat_window",
        payload: expect.objectContaining({
          messages: [
            expect.objectContaining({
              body: "after watermark",
              sender: "Dana",
              timestamp_ms: 4,
            }),
          ],
        }),
      }),
    ]);
    expect(JSON.stringify(outboundCtxPayload.UntrustedStructuredContext)).not.toContain(
      "before self marker",
    );
    expect(JSON.stringify(outboundCtxPayload.UntrustedStructuredContext)).not.toContain(
      "self marker",
    );
    expect(JSON.stringify(outboundCtxPayload.UntrustedStructuredContext)).not.toContain(
      "topic request",
    );
  });

  it("keeps retained overflow draft previews", async () => {
    const draftStream = createDraftStream();
    const bot = createBot();
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "Hello" });
        await dispatcherOptions.deliver({ text: "Hello" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({ context: createContext(), bot });

    const streamParams = mockCallArg(createTelegramDraftStream) as Parameters<
      NonNullable<TelegramBotDeps["createTelegramDraftStream"]>
    >[0];
    streamParams.onRetainedPage?.({
      messageId: 17,
      textSnapshot: "first page",
    });
    expect(bot.api["deleteMessage"]).not.toHaveBeenCalled();
  });

  it("queues final Telegram replies through outbound delivery when available", async () => {
    deliverInboundReplyWithMessageSendContext.mockResolvedValue({
      status: "handled_visible",
      delivery: {
        messageIds: ["1001"],
        visibleReplySent: true,
      },
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Hello queued" }, { kind: "final" });
      return { queuedFinal: true };
    });

    await dispatchWithContext({
      context: createContext({
        ctxPayload: {
          SessionKey: "s1",
          ChatType: "direct",
          SenderId: "42",
          SenderName: "Alice",
          SenderUsername: "alice",
        } as unknown as TelegramMessageContext["ctxPayload"],
      }),
      streamMode: "off",
      telegramDeps: telegramDepsForTest,
    });

    const outbound = expectRecordFields(mockCallArg(deliverInboundReplyWithMessageSendContext), {
      channel: "telegram",
      to: "123",
      accountId: "default",
      info: { kind: "final" },
      replyToMode: "first",
      threadId: 777,
      agentId: "default",
    });
    expectRecordFields(outbound.payload, { text: "Hello queued" });
    expectRecordFields(outbound.formatting, { textLimit: 4096, tableMode: "preserve" });
    expectRecordFields(outbound.ctxPayload, {
      SessionKey: "s1",
      ChatType: "direct",
      SenderId: "42",
      SenderName: "Alice",
      SenderUsername: "alice",
    });
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("queues media-only final Telegram replies through outbound delivery when available", async () => {
    deliverInboundReplyWithMessageSendContext.mockResolvedValue({
      status: "handled_visible",
      delivery: {
        messageIds: ["1002"],
        visibleReplySent: true,
      },
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ mediaUrl: "file:///tmp/final.png" }, { kind: "final" });
      return { queuedFinal: true };
    });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "off",
      telegramDeps: telegramDepsForTest,
    });

    const outbound = expectRecordFields(mockCallArg(deliverInboundReplyWithMessageSendContext), {
      channel: "telegram",
      info: { kind: "final" },
    });
    expectRecordFields(outbound.payload, { mediaUrl: "file:///tmp/final.png" });
    expectRecordFields(outbound.requiredCapabilities, { media: true, payload: true });
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("suppresses text-only tool output after media-only final Telegram replies", async () => {
    deliverInboundReplyWithMessageSendContext.mockResolvedValue({
      status: "handled_visible",
      delivery: {
        messageIds: ["1002"],
        visibleReplySent: true,
      },
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ mediaUrl: "file:///tmp/final.png" }, { kind: "final" });
      await dispatcherOptions.deliver({ text: "late tool output" }, { kind: "tool" });
      return { queuedFinal: true };
    });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "off",
      telegramDeps: telegramDepsForTest,
    });

    expect(deliverInboundReplyWithMessageSendContext).toHaveBeenCalledTimes(1);
    const outbound = expectRecordFields(mockCallArg(deliverInboundReplyWithMessageSendContext), {
      channel: "telegram",
      info: { kind: "final" },
    });
    expectRecordFields(outbound.payload, { mediaUrl: "file:///tmp/final.png" });
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("skips answer draft stream for same-chat selected quotes", async () => {
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
    const delivery = expectDeliverRepliesParams({
      replyQuoteMessageId: 9001,
      replyQuoteText: " quoted slice\n",
    });
    expectRecordFields((delivery.replies as Array<unknown>)[0], { replyToId: "9001" });
  });

  it("keeps bot-reply answers anchored to the current user message", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Hello", replyToId: "1001" }, { kind: "final" });
      return { queuedFinal: true };
    });
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({
      context: createContext({
        msg: {
          message_id: 1001,
          reply_to_message: {
            message_id: 9001,
            from: { is_bot: true },
          },
        } as unknown as TelegramMessageContext["msg"],
        ctxPayload: {
          MessageSid: "1001",
          ReplyToId: "9001",
          ReplyToBody: "quoted bot reply",
          ReplyToQuoteText: " quoted bot reply\n",
          ReplyToIsQuote: true,
        } as unknown as TelegramMessageContext["ctxPayload"],
      }),
    });

    const delivery = expectDeliverRepliesParams({
      replyQuoteMessageId: 9001,
      replyQuoteText: " quoted bot reply\n",
    });
    expectRecordFields((delivery.replies as Array<unknown>)[0], { replyToId: "1001" });
  });

  it("keeps answer draft stream for current message replies with native quote candidates", async () => {
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

    expectDraftStreamParams({ replyToMessageId: 1001, replyToMode: "first" });
    const delivery = expectDeliverRepliesParams({
      replyQuoteByMessageId: {
        "1001": {
          text: "Original current message",
          position: 0,
          entities: [{ type: "bold", offset: 0, length: 8 }],
        },
      },
    });
    expectRecordFields((delivery.replies as Array<unknown>)[0], { replyToId: "1001" });
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

    const delivery = expectDeliverRepliesParams({
      replyQuoteByMessageId: {
        "9001": {
          text: "  exact reply body",
          position: 0,
          entities: [{ type: "italic", offset: 2, length: 5 }],
        },
      },
    });
    expectRecordFields((delivery.replies as Array<unknown>)[0], { replyToId: "9001" });
  });

  it("replaces a materialized current-message preview when the final quotes another message", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    answerDraftStream.hasConsumedReplyTarget.mockReturnValue(true);
    mockDefaultSessionEntry();
    readLatestAssistantTextByIdentity.mockResolvedValue({
      id: "assistant-native-quote-overflow",
      text: "Quoted final",
      timestamp: Date.now() + 1_000,
    });
    deliverReplies.mockImplementation(async (params: Record<string, unknown>) => {
      const [reply] = params.replies as Array<{ replyToId?: string; text?: string }>;
      const sequence = params.promptContextSequence as
        | { accept(message: { messageId: number; text?: string }): Promise<void> }
        | undefined;
      await sequence?.accept({ messageId: 2002, text: reply?.text });
      return { delivered: true };
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "Working preview" });
        const streamParams = mockCallArg(createTelegramDraftStream) as Parameters<
          NonNullable<TelegramBotDeps["createTelegramDraftStream"]>
        >[0];
        streamParams.onRetainedPage?.({
          messageId: 1999,
          textSnapshot: "Retained preview",
        });
        await dispatcherOptions.deliver(
          { text: "Quoted final", replyToId: "9001" },
          { kind: "final" },
        );
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context: createContext({
        msg: {
          message_id: 1001,
          text: "Current request",
        } as unknown as TelegramMessageContext["msg"],
        ctxPayload: {
          MessageSid: "1001",
          SessionKey: "agent:default:telegram:direct:123",
          ReplyToId: "9001",
          ReplyToBody: "older source",
          ReplyToQuoteSourceText: "Exact older source",
        } as unknown as TelegramMessageContext["ctxPayload"],
      }),
    });

    expect(answerDraftStream.update).toHaveBeenCalledWith("Working preview");
    expect(answerDraftStream.update).not.toHaveBeenCalledWith("Quoted final");
    expect(answerDraftStream.clear).toHaveBeenCalled();
    const delivery = expectDeliverRepliesParams({
      replyQuoteByMessageId: expect.objectContaining({
        "9001": { text: "Exact older source", position: 0 },
      }),
    });
    expectRecordFields((delivery.replies as Array<unknown>)[0], {
      text: "Quoted final",
      replyToId: "9001",
    });
    expect(deliverReplies).toHaveBeenCalledTimes(1);
    expect(recordOutboundMessageForPromptContext).toHaveBeenCalledTimes(2);
    expectRecordFields(mockCallArg(recordOutboundMessageForPromptContext, 0), {
      messageId: 1999,
      text: "Retained preview",
      promptContextProjection: {
        transcriptMessageId: "assistant-native-quote-overflow",
        partIndex: 0,
        finalPart: false,
      },
    });
    expectRecordFields(mockCallArg(recordOutboundMessageForPromptContext, 1), {
      messageId: 2002,
      text: "Quoted final",
      promptContextProjection: {
        transcriptMessageId: "assistant-native-quote-overflow",
        partIndex: 1,
        finalPart: true,
      },
    });
  });

  it.each([
    { replyToMode: "first" as const, expectedFallbackMode: "off", keepsReply: false },
    { replyToMode: "batched" as const, expectedFallbackMode: "off", keepsReply: false },
    { replyToMode: "all" as const, expectedFallbackMode: "all", keepsReply: true },
  ])(
    "uses reply mode $replyToMode after retained pagination falls back to its suffix",
    async ({ replyToMode, expectedFallbackMode, keepsReply }) => {
      const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
      answerDraftStream.remainingFinalContent.mockReturnValue({
        text: "unsent suffix",
        sourceText: "unsent suffix",
        sourceTextMode: "html",
      });
      const finalText = "visible prefixunsent suffix";
      mockDefaultSessionEntry();
      readLatestAssistantTextByIdentity.mockResolvedValue({
        id: `assistant-retained-${replyToMode}`,
        text: finalText,
        timestamp: Date.now() + 1_000,
      });
      deliverReplies.mockImplementation(async (params: Record<string, unknown>) => {
        const [reply] = params.replies as Array<{ text?: string }>;
        const sequence = params.promptContextSequence as
          | { accept(message: { messageId: number; text?: string }): Promise<void> }
          | undefined;
        await sequence?.accept({ messageId: 2002, text: reply?.text });
        return { delivered: true };
      });
      dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
        async ({ dispatcherOptions, replyOptions }) => {
          await replyOptions?.onPartialReply?.({ text: "visible prefix" });
          const streamParams = mockCallArg(createTelegramDraftStream) as Parameters<
            NonNullable<TelegramBotDeps["createTelegramDraftStream"]>
          >[0];
          streamParams.onRetainedPage?.({
            messageId: 1999,
            textSnapshot: "visible prefix",
          });
          await dispatcherOptions.deliver(
            { text: finalText, replyToId: "1001" },
            { kind: "final" },
          );
          return { queuedFinal: true };
        },
      );

      await dispatchWithContext({
        context: createContext({
          msg: {
            message_id: 1001,
            text: "Current request",
          } as unknown as TelegramMessageContext["msg"],
          ctxPayload: {
            MessageSid: "1001",
            SessionKey: "agent:default:telegram:direct:123",
          } as unknown as TelegramMessageContext["ctxPayload"],
        }),
        replyToMode,
      });

      const fallback = expectDeliverRepliesParams({ replyToMode: expectedFallbackMode });
      const [fallbackPayload] = fallback.replies as Array<Record<string, unknown>>;
      expect(fallbackPayload.text).toBe("unsent suffix");
      if (keepsReply) {
        expect(fallbackPayload.replyToId).toBe("1001");
      } else {
        expect(fallbackPayload).not.toHaveProperty("replyToId");
      }
    },
  );

  it.each([
    { replyToMode: "first" as const, expectedFallbackMode: "off", keepsReply: false },
    { replyToMode: "batched" as const, expectedFallbackMode: "off", keepsReply: false },
    { replyToMode: "all" as const, expectedFallbackMode: "all", keepsReply: true },
  ])(
    "uses reply mode $replyToMode when an accepted one-page draft falls back",
    async ({ replyToMode, expectedFallbackMode, keepsReply }) => {
      const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
      answerDraftStream.lastDeliveredText.mockReturnValue("visible preview");
      answerDraftStream.hasConsumedReplyTarget.mockReturnValue(true);
      dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
        async ({ dispatcherOptions, replyOptions }) => {
          await replyOptions?.onPartialReply?.({ text: "visible preview" });
          await dispatcherOptions.deliver(
            { text: "final replacement", replyToId: "1001" },
            { kind: "final" },
          );
          return { queuedFinal: true };
        },
      );

      await dispatchWithContext({
        context: createContext({
          msg: { message_id: 1001, text: "Current request" } as TelegramMessageContext["msg"],
          ctxPayload: { MessageSid: "1001" } as TelegramMessageContext["ctxPayload"],
        }),
        replyToMode,
      });

      expect(answerDraftStream.clear).toHaveBeenCalled();
      const fallback = expectDeliverRepliesParams({ replyToMode: expectedFallbackMode });
      const [fallbackPayload] = fallback.replies as Array<Record<string, unknown>>;
      expect(fallbackPayload.text).toBe("final replacement");
      if (keepsReply) {
        expect(fallbackPayload.replyToId).toBe("1001");
      } else {
        expect(fallbackPayload).not.toHaveProperty("replyToId");
      }
    },
  );

  it.each([
    { replyToMode: "first" as const, expectedMediaMode: "off", keepsReply: false },
    { replyToMode: "batched" as const, expectedMediaMode: "off", keepsReply: false },
    { replyToMode: "all" as const, expectedMediaMode: "all", keepsReply: true },
  ])(
    "uses reply mode $replyToMode for media after an accepted draft",
    async ({ replyToMode, expectedMediaMode, keepsReply }) => {
      setupDraftStreams({ answerMessageId: 2001 });
      dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
        async ({ dispatcherOptions, replyOptions }) => {
          await replyOptions?.onPartialReply?.({ text: "photo" });
          await dispatcherOptions.deliver(
            { text: "photo", mediaUrl: "https://example.com/a.png", replyToId: "1001" },
            { kind: "final" },
          );
          return { queuedFinal: true };
        },
      );

      await dispatchWithContext({
        context: createContext({
          msg: { message_id: 1001, text: "Current request" } as TelegramMessageContext["msg"],
          ctxPayload: { MessageSid: "1001" } as TelegramMessageContext["ctxPayload"],
        }),
        replyToMode,
      });

      const media = expectDeliverRepliesParams({ replyToMode: expectedMediaMode });
      const [mediaPayload] = media.replies as Array<Record<string, unknown>>;
      expect(mediaPayload.mediaUrl).toBe("https://example.com/a.png");
      if (keepsReply) {
        expect(mediaPayload.replyToId).toBe("1001");
      } else {
        expect(mediaPayload).not.toHaveProperty("replyToId");
      }
    },
  );

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

    expect(expectDeliverRepliesParams({})).not.toHaveProperty("replyQuoteByMessageId.1001");
  });

  it("keeps answer draft stream for selected quotes when reply mode is off", async () => {
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

    expectDraftStreamParams({ replyToMessageId: undefined });
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

    const delivery = expectDeliverRepliesParams({
      replyQuoteMessageId: 9001,
      replyQuoteText: " quoted slice\n",
      replyQuotePosition: 12,
      replyQuoteEntities: [{ type: "italic", offset: 0, length: 6 }],
    });
    expectRecordFields((delivery.replies as Array<unknown>)[0], { replyToId: "9001" });
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

    const params = expectDeliverRepliesParams({ replyQuoteText: " external quoted slice\n" });
    expectRecordFields((params.replies as Array<unknown>)[0], { replyToId: "1001" });
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

    const deliveredPayload = expectDeliveredReply(0, {
      text: "Mode: foreground\nRun: /approve 117ba06d allow-once (or allow-always / deny).",
    }) as { channelData?: unknown };
    expect(deliveredPayload.channelData).toBeUndefined();
  });

  it("uses 30-char stream debounce for legacy block stream mode", async () => {
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

    expectDraftStreamParams({ minInitialChars: 30 });
  });

  it("keeps canonical block mode on the Telegram draft stream path", async () => {
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

  it("sizes block-mode preview chunks from streaming.preview.chunk", async () => {
    const draftStream = createDraftStream();
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      await replyOptions?.onPartialReply?.({ text: "Hello" });
      return { queuedFinal: false };
    });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "block",
      cfg: {
        channels: {
          telegram: { streaming: { preview: { chunk: { minChars: 100, maxChars: 600 } } } },
        },
      },
      telegramCfg: { streaming: { mode: "block" } },
    });

    expectDraftStreamParams({ maxChars: 600 });
  });

  it("uses the shared block chunk default when block mode has no chunk config", async () => {
    const draftStream = createDraftStream();
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      await replyOptions?.onPartialReply?.({ text: "Hello" });
      return { queuedFinal: false };
    });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "block",
      telegramCfg: { streaming: { mode: "block" } },
    });

    expectDraftStreamParams({ maxChars: 800 });
  });

  it("marks durable non-preview finals with their transcript source", async () => {
    const transcriptTimestamp = Date.now() + 1_000;
    const context = createContext();
    context.ctxPayload.SessionKey = "agent:default:telegram:direct:123";
    mockDefaultSessionEntry();
    readLatestAssistantTextByIdentity.mockResolvedValue({
      id: "assistant-final-1",
      text: "Final answer",
      timestamp: transcriptTimestamp,
    });
    deliverInboundReplyWithMessageSendContext.mockResolvedValue({
      status: "handled_visible",
      delivery: {
        messageIds: ["2001"],
        visibleReplySent: true,
      },
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Final answer" }, { kind: "final" });
      return { queuedFinal: true };
    });

    await dispatchWithContext({ context, streamMode: "off" });

    const outbound = expectRecordFields(mockCallArg(deliverInboundReplyWithMessageSendContext), {
      payload: expect.objectContaining({ text: "Final answer" }),
    });
    expectRecordFields(expectRecordFields(outbound.payload, {}).channelData, {
      telegram: {
        promptContextSource: {
          transcriptMessageId: "assistant-final-1",
          deliverySignature: '["Final answer",[],false,""]',
        },
      },
    });
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("correlates directive-tagged durable finals without rendering Markdown", async () => {
    const transcriptTimestamp = Date.now() + 1_000;
    const context = createContext();
    context.ctxPayload.SessionKey = "agent:default:telegram:direct:123";
    mockDefaultSessionEntry();
    readLatestAssistantTextByIdentity.mockResolvedValue({
      id: "assistant-final-2",
      text: "[[reply_to_current]]Final answer",
      timestamp: transcriptTimestamp,
    });
    deliverInboundReplyWithMessageSendContext.mockResolvedValue({
      status: "handled_visible",
      delivery: {
        messageIds: ["2001"],
        visibleReplySent: true,
      },
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Final answer" }, { kind: "final" });
      return { queuedFinal: true };
    });

    await dispatchWithContext({ context, streamMode: "off" });

    const outbound = expectRecordFields(mockCallArg(deliverInboundReplyWithMessageSendContext), {
      payload: expect.objectContaining({ text: "Final answer" }),
    });
    expectRecordFields(expectRecordFields(outbound.payload, {}).channelData, {
      telegram: {
        promptContextSource: {
          transcriptMessageId: "assistant-final-2",
          deliverySignature: '["Final answer",[],false,""]',
        },
      },
    });
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("binds identical sequential finals to their fresh transcript identities", async () => {
    const context = createContext();
    context.ctxPayload.SessionKey = "agent:default:telegram:direct:123";
    mockDefaultSessionEntry();
    readLatestAssistantTextByIdentity
      .mockResolvedValueOnce({
        id: "assistant-repeat-a",
        text: "Same answer",
        timestamp: Date.now() + 1_000,
      })
      .mockResolvedValueOnce({
        id: "assistant-repeat-b",
        text: "Same answer",
        timestamp: Date.now() + 2_000,
      });
    let messageId = 2050;
    deliverReplies.mockImplementation(async (params: Record<string, unknown>) => {
      const sequence = params.promptContextSequence as
        | { accept(message: { messageId: number; text: string }): Promise<void> }
        | undefined;
      await sequence?.accept({ messageId, text: "Same answer" });
      messageId += 1;
      return { delivered: true };
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Same answer" }, { kind: "final" });
      await dispatcherOptions.deliver({ text: "Same answer" }, { kind: "final" });
      return { queuedFinal: true };
    });

    await dispatchWithContext({ context, streamMode: "off" });

    expect(readLatestAssistantTextByIdentity).toHaveBeenCalledTimes(2);
    expect(recordOutboundMessageForPromptContext).toHaveBeenCalledTimes(2);
    expectRecordFields(mockCallArg(recordOutboundMessageForPromptContext, 0), {
      promptContextProjection: {
        transcriptMessageId: "assistant-repeat-a",
        partIndex: 0,
        finalPart: true,
      },
    });
    expectRecordFields(mockCallArg(recordOutboundMessageForPromptContext, 1), {
      promptContextProjection: {
        transcriptMessageId: "assistant-repeat-b",
        partIndex: 0,
        finalPart: true,
      },
    });
  });

  it("does not bind a multipart final when its one transcript snapshot misses", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2100 });
    const finalText = `${"A".repeat(3_900)}\n\n${"B".repeat(3_900)}\n\n${"C".repeat(3_900)}`;
    const context = createContext();
    context.ctxPayload.SessionKey = "agent:default:telegram:direct:123";
    mockDefaultSessionEntry();
    readLatestAssistantTextByIdentity.mockResolvedValueOnce(undefined).mockResolvedValue({
      id: "assistant-arrived-too-late",
      text: finalText,
      timestamp: Date.now() + 1_000,
    });
    let nextMessageId = 2101;
    deliverReplies.mockImplementation(async (params: Record<string, unknown>) => {
      const [reply] = params.replies as Array<{ text?: string }>;
      const sequence = params.promptContextSequence as
        | { accept(message: { messageId: number; text?: string }): Promise<void> }
        | undefined;
      await sequence?.accept({ messageId: nextMessageId, text: reply?.text });
      nextMessageId += 1;
      return { delivered: true };
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: finalText }, { kind: "final" });
      return { queuedFinal: true };
    });

    await dispatchWithContext({ context });

    expect(answerDraftStream.update).toHaveBeenCalled();
    expect(readLatestAssistantTextByIdentity).toHaveBeenCalledTimes(1);
    expect(recordOutboundMessageForPromptContext).toHaveBeenCalledTimes(1);
    for (const [record] of recordOutboundMessageForPromptContext.mock.calls) {
      expect(record).not.toHaveProperty("promptContextProjection");
    }
  });

  it("records native-quote direct fallback sends as one complete projection", async () => {
    const transcriptTimestamp = Date.now() + 1_000;
    const context = createContext({
      ctxPayload: {
        MessageSid: "1001",
        SessionKey: "agent:default:telegram:direct:123",
        ReplyToId: "9001",
        ReplyToQuoteText: " quoted slice\n",
        ReplyToIsQuote: true,
      } as unknown as TelegramMessageContext["ctxPayload"],
    });
    mockDefaultSessionEntry();
    readLatestAssistantTextByIdentity.mockResolvedValue({
      id: "assistant-native-quote",
      text: "Final answer",
      timestamp: transcriptTimestamp,
    });
    const groupHistoryRecorder = vi.fn();
    const unregisterGroupHistoryRecorder = registerTelegramOutboundGroupHistoryRecorder({
      accountId: "default",
      recorder: groupHistoryRecorder,
    });
    recordOutboundMessageForPromptContext.mockImplementation(
      recordOutboundMessageForPromptContextActual,
    );
    deliverReplies.mockImplementation(async (params: Record<string, unknown>) => {
      const sequence = params.promptContextSequence as
        | { accept(message: { messageId: number; text: string }): Promise<void> }
        | undefined;
      await sequence?.accept({ messageId: 2001, text: "Final answer" });
      return { delivered: true };
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        { text: "Final answer", replyToId: "1001" },
        { kind: "final" },
      );
      return { queuedFinal: true };
    });

    try {
      await dispatchWithContext({ context, streamMode: "off" });
    } finally {
      unregisterGroupHistoryRecorder();
    }

    expect(deliverInboundReplyWithMessageSendContext).toHaveBeenCalledTimes(1);
    expect(deliverReplies).toHaveBeenCalledTimes(1);
    expect(recordOutboundMessageForPromptContext).toHaveBeenCalledTimes(1);
    expect(groupHistoryRecorder).toHaveBeenCalledTimes(1);
    expectRecordFields(mockCallArg(recordOutboundMessageForPromptContext, 0), {
      messageId: 2001,
      text: "Final answer",
      promptContextProjection: {
        transcriptMessageId: "assistant-native-quote",
        partIndex: 0,
        finalPart: true,
      },
    });
  });

  it.each([
    {
      name: "captioned media",
      transcriptText: "Photo\nMEDIA:/tmp/reply-image.png",
      payload: { text: "Photo", mediaUrl: "/tmp/reply-image.png", replyToId: "1001" },
      deliveredText: "Photo",
    },
    {
      name: "media-only",
      transcriptText: "MEDIA:/tmp/reply-image.png",
      payload: { mediaUrl: "/tmp/reply-image.png", replyToId: "1001" },
      deliveredText: undefined,
    },
  ])("correlates $name after MEDIA directive normalization", async (testCase) => {
    const storePath = `/tmp/openclaw-telegram-direct-media-${process.pid}-${testCase.name}.json`;
    const context = createContext({
      ctxPayload: {
        MessageSid: "1001",
        SessionKey: "agent:default:telegram:direct:123",
        ReplyToId: "9001",
        ReplyToQuoteText: " quoted slice\n",
        ReplyToIsQuote: true,
      } as unknown as TelegramMessageContext["ctxPayload"],
    });
    mockDefaultSessionEntry();
    readLatestAssistantTextByIdentity.mockResolvedValue({
      id: `assistant-${testCase.name}`,
      text: testCase.transcriptText,
      timestamp: Date.now() + 1_000,
    });
    const mediaMessage = {
      message_id: 2002,
      date: 1_779_425_460,
      chat: { id: 123, type: "private" as const },
      from: { id: 999, is_bot: true, first_name: "OpenClaw" },
      photo: [{ file_id: "photo-file", file_unique_id: "photo-unique", width: 10, height: 10 }],
    };
    deliverReplies.mockImplementation(async (params: Record<string, unknown>) => {
      const sequence = params.promptContextSequence as
        | {
            accept(message: {
              messageId: number;
              message: typeof mediaMessage;
              text?: string;
            }): Promise<void>;
          }
        | undefined;
      await sequence?.accept({
        messageId: mediaMessage.message_id,
        message: mediaMessage,
        text: testCase.deliveredText,
      });
      return { delivered: true };
    });
    recordOutboundMessageForPromptContext.mockImplementation(
      recordOutboundMessageForPromptContextActual,
    );
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(testCase.payload, { kind: "final" });
      return { queuedFinal: true };
    });

    await dispatchWithContext({
      context,
      streamMode: "off",
      cfg: { session: { store: storePath } },
    });

    expectRecordFields(mockCallArg(recordOutboundMessageForPromptContext), {
      messageId: 2002,
      message: mediaMessage,
      ...(testCase.deliveredText ? { text: testCase.deliveredText } : {}),
      promptContextProjection: {
        transcriptMessageId: `assistant-${testCase.name}`,
        partIndex: 0,
        finalPart: true,
      },
    });
    const cached = await createTelegramMessageCache({
      scope: resolveTelegramMessageCacheScope(storePath),
    }).get({ accountId: "default", chatId: "123", messageId: "2002" });
    expect(cached).toMatchObject({
      mediaRef: "telegram:file/photo-file",
      mediaType: "image",
      promptContextProjectionMarker: {
        kind: "valid",
        projection: {
          transcriptMessageId: `assistant-${testCase.name}`,
          partIndex: 0,
          finalPart: true,
        },
      },
    });
  });

  it("keeps the Telegram edit cap for non-block previews regardless of chunk config", async () => {
    const draftStream = createDraftStream();
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      await replyOptions?.onPartialReply?.({ text: "Hello" });
      return { queuedFinal: false };
    });

    await dispatchWithContext({
      context: createContext(),
      cfg: {
        channels: {
          telegram: { streaming: { preview: { chunk: { maxChars: 600 } } } },
        },
      },
      telegramCfg: { streaming: { mode: "partial" } },
    });

    expectDraftStreamParams({ maxChars: 4000 });
  });

  it("streams text-only finals into the answer message", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    const transcriptTimestamp = Date.now() + 1_000;
    const context = createContext({
      primaryCtx: {
        me: {
          id: 999,
          is_bot: true,
          first_name: "Telegram Bot Name",
          username: "openclaw_bot",
        },
      } as TelegramMessageContext["primaryCtx"],
    });
    context.ctxPayload.SessionKey = "agent:default:telegram:direct:123";
    mockDefaultSessionEntry();
    readLatestAssistantTextByIdentity.mockResolvedValue({
      id: "assistant-stream-1",
      text: "Final answer",
      timestamp: transcriptTimestamp,
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Final answer" }, { kind: "final" });
      return { queuedFinal: true };
    });

    await dispatchWithContext({ context });

    expect(answerDraftStream.update).toHaveBeenCalledWith("Final answer");
    expect(answerDraftStream.stop).toHaveBeenCalled();
    expect(deliverReplies).not.toHaveBeenCalled();
    expect(editMessageTelegram).not.toHaveBeenCalled();
    expectRecordFields(mockCallArg(emitInternalMessageSentHook), {
      content: "Final answer",
      messageId: 2001,
    });
    expectRecordFields(mockCallArg(recordOutboundMessageForPromptContext), {
      account: {
        accountId: "default",
        bot: {
          id: 999,
          is_bot: true,
          first_name: "Telegram Bot Name",
          username: "openclaw_bot",
        },
      },
      chatId: "123",
      messageId: 2001,
      text: "Final answer",
      messageThreadId: 777,
      promptContextProjection: {
        transcriptMessageId: "assistant-stream-1",
        partIndex: 0,
        finalPart: true,
      },
    });
  });

  it("projects retained draft pages and the active tail as one complete sequence", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2100 });
    answerDraftStream.currentMessageSnapshot.mockReturnValue({
      text: "page 2",
      sourceText: "page 2",
    });
    const finalText = "page 0page 1page 2";
    const context = createContext();
    context.ctxPayload.SessionKey = "agent:default:telegram:direct:123";
    mockDefaultSessionEntry();
    readLatestAssistantTextByIdentity.mockResolvedValue({
      id: "assistant-stream-multipart",
      text: finalText,
      timestamp: Date.now() + 1_000,
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      const streamParams = mockCallArg(createTelegramDraftStream) as Parameters<
        NonNullable<TelegramBotDeps["createTelegramDraftStream"]>
      >[0];
      streamParams.onRetainedPage?.({
        messageId: 2098,
        textSnapshot: "page 0",
      });
      streamParams.onRetainedPage?.({
        messageId: 2099,
        textSnapshot: "page 1",
      });
      await dispatcherOptions.deliver({ text: finalText }, { kind: "final" });
      return { queuedFinal: true };
    });

    await dispatchWithContext({ context });

    expect(answerDraftStream.update).toHaveBeenCalled();
    expect(deliverReplies).not.toHaveBeenCalled();
    const effectiveByMessageId = new Map<
      number,
      {
        text?: string;
        projection: { transcriptMessageId: string; partIndex: number; finalPart: boolean };
      }
    >();
    for (const [rawRecord] of recordOutboundMessageForPromptContext.mock.calls) {
      const record = rawRecord as {
        messageId: number;
        text?: string;
        promptContextProjection?: {
          transcriptMessageId: string;
          partIndex: number;
          finalPart: boolean;
        };
      };
      if (record.promptContextProjection) {
        effectiveByMessageId.set(record.messageId, {
          text: record.text,
          projection: record.promptContextProjection,
        });
      }
    }
    const records = Array.from(effectiveByMessageId.values()).toSorted(
      (left, right) => left.projection.partIndex - right.projection.partIndex,
    );
    expect(records.map((record) => record.text)).toEqual(["page 0", "page 1", "page 2"]);
    const projections = records.map((record) => record.projection);
    expect(projections.map((projection) => projection.partIndex)).toEqual(
      projections.map((_, index) => index),
    );
    expect(projections.map((projection) => projection.finalPart)).toEqual([
      ...Array.from({ length: projections.length - 1 }, () => false),
      true,
    ]);
    expect(
      projections.every(
        (projection) => projection.transcriptMessageId === "assistant-stream-multipart",
      ),
    ).toBe(true);
  });

  it("records streamed final replies into the prompt context cache", async () => {
    const storePath = `/tmp/openclaw-telegram-stream-context-${process.pid}-${Date.now()}.json`;
    const transcriptTimestamp = Date.now() + 1_000;
    const context = createContext({
      primaryCtx: {
        me: {
          id: 999,
          is_bot: true,
          first_name: "Telegram Bot Name",
          username: "openclaw_bot",
        },
      } as TelegramMessageContext["primaryCtx"],
    });
    context.ctxPayload.SessionKey = "agent:default:telegram:direct:123";
    mockDefaultSessionEntry();
    readLatestAssistantTextByIdentity.mockResolvedValue({
      id: "assistant-stream-2",
      text: "Done already: timeoutSeconds is now 7200s.",
      timestamp: transcriptTimestamp,
    });
    setupDraftStreams({ answerMessageId: 1497 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        { text: "Done already: timeoutSeconds is now 7200s." },
        { kind: "final" },
      );
      return { queuedFinal: true };
    });

    await dispatchWithContext({
      context,
      cfg: { session: { store: storePath } },
      telegramCfg: { name: "Configured Agent" },
      telegramDeps: {
        ...telegramDepsForTest,
        recordOutboundMessageForPromptContext: recordOutboundMessageForPromptContextActual,
      },
    });

    const cache = createTelegramMessageCache({
      scope: resolveTelegramMessageCacheScope(storePath),
    });
    await cache.record({
      accountId: "default",
      chatId: "123",
      threadId: 777,
      msg: {
        chat: { id: 123, type: "private", first_name: "Keshav" },
        message_thread_id: 777,
        message_id: 1521,
        date: 1_779_425_460,
        text: "Did all Amazon crons run fine",
        from: { id: 5185575566, is_bot: false, first_name: "Keshav" },
      },
    });

    const conversationContext = await buildTelegramConversationContext({
      cache,
      accountId: "default",
      chatId: "123",
      threadId: 777,
      messageId: "1521",
      replyChainNodes: [],
      recentLimit: 10,
      replyTargetWindowSize: 2,
    });

    const streamedReply = conversationContext.find((entry) => entry.node.messageId === "1497");
    expect(streamedReply?.node).toMatchObject({
      body: "Done already: timeoutSeconds is now 7200s.",
      sender: "Configured Agent (you)",
      senderId: "999",
      sourceMessage: {
        from: {
          id: 999,
          is_bot: true,
          first_name: "Configured Agent (you)",
        },
      },
    });
    expect(streamedReply?.node.timestamp).not.toBe(transcriptTimestamp);
    expect(streamedReply?.node.promptContextProjectionMarker).toEqual({
      kind: "valid",
      projection: {
        transcriptMessageId: "assistant-stream-2",
        partIndex: 0,
        finalPart: true,
      },
    });
  });

  it("suppresses text-only tool payloads delivered after the final answer", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Final answer" }, { kind: "final" });
      await dispatcherOptions.deliver(
        { text: "failed command output", isError: true },
        { kind: "tool" },
      );
      return { queuedFinal: true };
    });

    await dispatchWithContext({ context: createContext() });

    expect(answerDraftStream.update).toHaveBeenCalledTimes(1);
    expect(answerDraftStream.update).toHaveBeenCalledWith("Final answer");
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("materializes chart-only finals into the active answer preview", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        {
          presentation: {
            title: "FY25 outlook",
            blocks: [
              {
                type: "chart",
                chartType: "pie",
                title: "Revenue mix",
                segments: [
                  { label: "Product", value: 60 },
                  { label: "Services", value: 40 },
                ],
              },
            ],
          },
        },
        { kind: "final" },
      );
      return { queuedFinal: true };
    });

    await dispatchWithContext({ context: createContext() });

    expect(answerDraftStream.update).toHaveBeenCalledWith(
      "FY25 outlook\n\nRevenue mix (pie chart)\n- Product: 60\n- Services: 40",
    );
    expect(deliverReplies).not.toHaveBeenCalled();
    expect(deliverInboundReplyWithMessageSendContext).not.toHaveBeenCalled();
  });

  it("appends chart data to final text before active preview finalization", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        {
          text: "Quarterly results",
          presentation: {
            title: "FY25 outlook",
            blocks: [
              { type: "text", text: "Do not duplicate this block" },
              {
                type: "chart",
                chartType: "bar",
                title: "Revenue",
                categories: ["Q1", "Q2"],
                series: [{ name: "USD", values: [12, 18] }],
              },
            ],
          },
        },
        { kind: "final" },
      );
      return { queuedFinal: true };
    });

    await dispatchWithContext({ context: createContext() });

    expect(answerDraftStream.update).toHaveBeenCalledWith(
      "Quarterly results\n\nFY25 outlook\n\nRevenue (bar chart)\n- USD: Q1: 12; Q2: 18",
    );
    expect(answerDraftStream.update).not.toHaveBeenCalledWith(
      expect.stringContaining("Do not duplicate this block"),
    );
    expect(deliverReplies).not.toHaveBeenCalled();
    expect(deliverInboundReplyWithMessageSendContext).not.toHaveBeenCalled();
  });

  it("mirrors preview-finalized finals into the session transcript", async () => {
    setupDraftStreams({ answerMessageId: 2001 });
    const context = createContext();
    context.ctxPayload.SessionKey = "agent:default:telegram:direct:123";
    mockDefaultSessionEntry();
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Final answer" }, { kind: "final" });
      return { queuedFinal: true };
    });

    await dispatchWithContext({ context });

    const mirrorCall = expectRecordFields(mockCallArg(appendAssistantMirrorMessageByIdentity), {
      agentId: "default",
      sessionId: "s1",
      idempotencyKey: expect.stringContaining("telegram-final:agent:default:telegram:direct:123:"),
      sessionKey: "agent:default:telegram:direct:123",
      storePath: "/tmp/sessions.json",
      text: "Final answer",
    });
    expect(mirrorCall.deliveryMirror).toEqual({
      kind: "channel-final",
      sourceMessageId: mirrorCall.idempotencyKey,
    });
  });

  it("keeps same-millisecond transcript mirror keys distinct per inbound message", async () => {
    createTelegramDraftStream.mockImplementation(() => createDraftStream(2001));
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(1234567890);
    const firstContext = createContext({
      ctxPayload: {
        MessageSid: "456",
        SessionKey: "agent:default:telegram:direct:123",
      } as TelegramMessageContext["ctxPayload"],
    });
    const secondContext = createContext({
      ctxPayload: {
        MessageSid: "457",
        SessionKey: "agent:default:telegram:direct:123",
      } as TelegramMessageContext["ctxPayload"],
      msg: { message_id: 457 } as TelegramMessageContext["msg"],
    });
    mockDefaultSessionEntry();
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Final answer" }, { kind: "final" });
      return { queuedFinal: true };
    });

    try {
      await dispatchWithContext({ context: firstContext });
      await dispatchWithContext({ context: secondContext });
    } finally {
      dateNow.mockRestore();
    }

    const firstMirrorCall = expectRecordFields(
      mockCallArg(appendAssistantMirrorMessageByIdentity),
      {
        idempotencyKey: expect.stringContaining(
          "telegram-final:agent:default:telegram:direct:123:123:456:",
        ),
      },
    );
    const secondMirrorCall = expectRecordFields(
      mockCallArg(appendAssistantMirrorMessageByIdentity, 1),
      {
        idempotencyKey: expect.stringContaining(
          "telegram-final:agent:default:telegram:direct:123:123:457:",
        ),
      },
    );
    expect(firstMirrorCall.idempotencyKey).not.toBe(secondMirrorCall.idempotencyKey);
  });

  it("skips transcript mirroring when the scoped session is absent", async () => {
    setupDraftStreams({ answerMessageId: 2001 });
    const context = createContext();
    context.ctxPayload.SessionKey = "agent:default:telegram:direct:123";
    loadSessionStore.mockReturnValue({});
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Final answer" }, { kind: "final" });
      return { queuedFinal: true };
    });

    await dispatchWithContext({ context });

    expect(appendAssistantMirrorMessageByIdentity).not.toHaveBeenCalled();
  });

  it("does not mirror non-final tool progress into the session transcript", async () => {
    const context = createContext();
    context.ctxPayload.SessionKey = "agent:default:telegram:direct:123";
    mockDefaultSessionEntry();
    deliverReplies.mockImplementation(
      async (params: {
        replies?: Array<{ text?: string }>;
        transcriptMirror?: (payload: { text?: string; mediaUrls?: string[] }) => Promise<void>;
      }) => {
        const text = params.replies
          ?.map((reply) => reply.text)
          .filter(Boolean)
          .join("\n\n");
        await params.transcriptMirror?.({ text });
        return { delivered: true };
      },
    );
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "🛠️ tool progress" }, { kind: "tool" });
      await dispatcherOptions.deliver({ text: "Final answer" }, { kind: "final" });
      return { queuedFinal: true };
    });

    await dispatchWithContext({
      context,
      streamMode: "partial",
      cfg: { agents: { defaults: { blockStreamingDefault: "on" } } },
      telegramCfg: { streaming: { mode: "partial", preview: { toolProgress: true } } },
    });

    expect(deliverReplies).toHaveBeenCalledTimes(2);
    expectRecordFields(mockCallArg(deliverReplies, 0), {
      transcriptMirror: undefined,
    });
    expect(typeof mockCallArg(deliverReplies, 1).transcriptMirror).toBe("function");
    expect(appendAssistantMirrorMessageByIdentity).toHaveBeenCalledTimes(1);
    expectRecordFields(mockCallArg(appendAssistantMirrorMessageByIdentity), {
      agentId: "default",
      sessionId: "s1",
      sessionKey: "agent:default:telegram:direct:123",
      storePath: "/tmp/sessions.json",
      text: "Final answer",
    });
  });

  it("mirrors a legitimate repeat after a new user turn instead of skipping it", async () => {
    const repeatedText = "Final answer";
    const context = createContext();
    context.ctxPayload.SessionKey = "agent:default:telegram:direct:123";
    mockDefaultSessionEntry();
    readLatestAssistantTextByIdentity.mockResolvedValue({ text: repeatedText, timestamp: 1 });
    deliverReplies.mockImplementation(
      async (params: {
        replies?: Array<{ text?: string }>;
        transcriptMirror?: (payload: { text?: string; mediaUrls?: string[] }) => Promise<void>;
      }) => {
        const text = params.replies
          ?.map((reply) => reply.text)
          .filter(Boolean)
          .join("\n\n");
        await params.transcriptMirror?.({ text });
        return { delivered: true };
      },
    );
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: repeatedText }, { kind: "final" });
      return { queuedFinal: true };
    });

    await dispatchWithContext({ context });

    expect(appendAssistantMirrorMessageByIdentity).toHaveBeenCalledTimes(1);
    expectRecordFields(mockCallArg(appendAssistantMirrorMessageByIdentity), {
      agentId: "default",
      sessionId: "s1",
      idempotencyKey: expect.stringContaining("telegram-final:agent:default:telegram:direct:123:"),
      sessionKey: "agent:default:telegram:direct:123",
      storePath: "/tmp/sessions.json",
      text: repeatedText,
    });
  });

  it("mirrors the longer streamed preview when final text is truncated", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    const fullAnswer =
      "Ja. Hier nochmal sauber Schritt fuer Schritt. Einen API Key kopiert man aus der Google Cloud Console. Danach pruefst du die Projekt- und API-Einstellungen.";
    const truncatedFinal =
      "Ja. Hier nochmal sauber Schritt fuer Schritt. Einen API Key kopiert man...";
    const context = createContext();
    context.ctxPayload.SessionKey = "agent:default:telegram:direct:123";
    mockDefaultSessionEntry();
    readLatestAssistantTextByIdentity.mockResolvedValue({
      text: fullAnswer,
      timestamp: Date.now() + 1_000,
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: fullAnswer });
        await dispatcherOptions.deliver({ text: truncatedFinal }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({ context });

    expect(answerDraftStream.update).toHaveBeenCalledWith(fullAnswer);
    expect(answerDraftStream.update).not.toHaveBeenCalledWith(truncatedFinal);
    expectRecordFields(mockCallArg(emitInternalMessageSentHook), {
      content: fullAnswer,
      messageId: 2001,
    });
    expectRecordFields(mockCallArg(appendAssistantMirrorMessageByIdentity), {
      agentId: "default",
      sessionId: "s1",
      sessionKey: "agent:default:telegram:direct:123",
      storePath: "/tmp/sessions.json",
      text: fullAnswer,
    });
  });

  it("treats session rebound mirror skips as non-fatal", async () => {
    setupDraftStreams({ answerMessageId: 2001 });
    const context = createContext();
    context.ctxPayload.SessionKey = "agent:default:telegram:direct:123";
    mockDefaultSessionEntry();
    appendAssistantMirrorMessageByIdentity.mockResolvedValueOnce({
      ok: false,
      code: "session-rebound",
      reason: "session rebound for sessionKey: agent:default:telegram:direct:123",
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Final answer" }, { kind: "final" });
      return { queuedFinal: true };
    });

    await dispatchWithContext({ context });

    expectRecordFields(mockCallArg(appendAssistantMirrorMessageByIdentity), {
      agentId: "default",
      sessionId: "s1",
      sessionKey: "agent:default:telegram:direct:123",
      storePath: "/tmp/sessions.json",
      text: "Final answer",
    });
  });

  it("streams block and final text through the same answer message", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "Working" });
        await dispatcherOptions.deliver({ text: "Done" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({ context: createContext() });

    expect(answerDraftStream.update).toHaveBeenNthCalledWith(1, "Working");
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(2, "Done");
    expect(answerDraftStream.stop).toHaveBeenCalled();
    expect(deliverReplies).not.toHaveBeenCalled();
    expect(editMessageTelegram).not.toHaveBeenCalled();
  });

  it("sends trailing verbose status after streamed final answer without replacing the answer draft", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "Normal reply" });
        await dispatcherOptions.deliver({ text: "Normal reply" }, { kind: "final" });
        await dispatcherOptions.deliver({ text: trailingFinalStatusText }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({ context: createContext() });

    expect(answerDraftStream.update.mock.calls).toEqual([
      ["Normal reply"],
      [trailingFinalStatusText],
    ]);
    expect(answerDraftStream.forceNewMessage).toHaveBeenCalledTimes(1);
    expect(answerDraftStream.forceNewMessage.mock.invocationCallOrder[0]).toBeLessThan(
      answerDraftStream.update.mock.invocationCallOrder[1],
    );
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("applies partial deltas while preserving the first-preview debounce", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({
          text: "Streaming ",
          delta: "Streaming ",
        });
        await replyOptions?.onPartialReply?.({
          text: "Streaming previews ",
          delta: "previews ",
        });
        await replyOptions?.onPartialReply?.({
          text: "Streaming previews are useful because they show progress.",
          delta: "are useful because they show progress.",
        });
        await dispatcherOptions.deliver(
          { text: "Streaming previews are useful because they show progress." },
          { kind: "final" },
        );
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context: createContext(),
      streamMode: "partial",
      telegramCfg: { streaming: { mode: "partial" } },
    });

    expectDraftStreamParams({ minInitialChars: 30 });
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(1, "Streaming ");
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(2, "Streaming previews ");
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(
      3,
      "Streaming previews are useful because they show progress.",
    );
    expect(answerDraftStream.update).toHaveBeenLastCalledWith(
      "Streaming previews are useful because they show progress.",
    );
    expect(answerDraftStream.stop).toHaveBeenCalled();
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("replaces non-prefix partial snapshots instead of appending them", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({
          text: "Working...",
          delta: "Working...",
        });
        await replyOptions?.onPartialReply?.({
          text: "Done.",
          delta: "",
          replace: true,
        });
        await dispatcherOptions.deliver({ text: "Done." }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context: createContext(),
      streamMode: "partial",
      telegramCfg: { streaming: { mode: "partial" } },
    });

    expect(answerDraftStream.update).toHaveBeenNthCalledWith(1, "Working...");
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(2, "Done.");
    expect(answerDraftStream.update).toHaveBeenLastCalledWith("Done.");
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("does not coalesce answer partial fragments with tool progress drafts", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        await replyOptions?.onPartialReply?.({ text: "Done ", delta: "Done " });
        await replyOptions?.onPartialReply?.({ text: "Done answer", delta: "answer" });
        await dispatcherOptions.deliver({ text: "Done answer." }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context: createContext(),
      streamMode: "partial",
      telegramCfg: { streaming: { mode: "partial" } },
    });

    expect(mockCallArg(answerDraftStream.updatePreview).text).toContain("Exec");
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(1, "Done ");
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(2, "Done answer");
    expect(answerDraftStream.update).toHaveBeenLastCalledWith("Done answer.");
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("does not hide text-only tool output after answer streaming starts", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "Partial answer" });
        await dispatcherOptions.deliver({ text: "Tool result after partial" }, { kind: "tool" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context: createContext(),
      streamMode: "partial",
      telegramCfg: {
        streaming: { mode: "partial" },
      },
    });

    expect(answerDraftStream.update).toHaveBeenNthCalledWith(1, "Partial answer");
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(2, "Tool result after partial");
  });

  it("rotates the answer stream only after a finalized assistant message", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await dispatcherOptions.deliver({ text: "Message A final" }, { kind: "final" });
        await replyOptions?.onAssistantMessageStart?.();
        await replyOptions?.onPartialReply?.({ text: "Message B partial" });
        await dispatcherOptions.deliver({ text: "Message B final" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({ context: createContext() });

    expect(answerDraftStream.forceNewMessage).toHaveBeenCalledTimes(1);
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(1, "Message A final");
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(2, "Message B partial");
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(3, "Message B final");
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("keeps same-message block chunks in one answer preview until final", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onBlockReplyQueued?.(
          { text: "First chunk. " },
          { assistantMessageIndex: 0 },
        );
        await dispatcherOptions.deliver({ text: "First chunk. " }, { kind: "block" });
        await replyOptions?.onBlockReplyQueued?.(
          { text: "Second chunk." },
          { assistantMessageIndex: 0 },
        );
        await dispatcherOptions.deliver({ text: "Second chunk." }, { kind: "block" });
        await dispatcherOptions.deliver(
          { text: "First chunk. \nSecond chunk." },
          { kind: "final" },
        );
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({ context: createContext() });

    expect(answerDraftStream.update).toHaveBeenNthCalledWith(1, "First chunk.");
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(2, "Second chunk.");
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(3, "First chunk. \nSecond chunk.");
    expect(answerDraftStream.forceNewMessage).not.toHaveBeenCalled();
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("does not leak inline reply directives into block draft previews", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        const payload = { text: "[[reply_to: 123]] Visible chunk." };
        await replyOptions?.onBlockReplyQueued?.(payload, { assistantMessageIndex: 0 });
        await dispatcherOptions.deliver(payload, { kind: "block", assistantMessageIndex: 0 });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({ context: createContext() });

    expect(answerDraftStream.update).toHaveBeenCalledTimes(1);
    expect(answerDraftStream.update).toHaveBeenCalledWith("Visible chunk.");
    expect(answerDraftStream.update).not.toHaveBeenCalledWith("[[reply_to: 123]] Visible chunk.");
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("rotates answer previews when queued block assistant index changes", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onBlockReplyQueued?.(
          { text: "Site A shows X." },
          { assistantMessageIndex: 0 },
        );
        await dispatcherOptions.deliver({ text: "Site A shows X." }, { kind: "block" });
        await replyOptions?.onBlockReplyQueued?.(
          { text: "Site B shows Y." },
          { assistantMessageIndex: 1 },
        );
        await dispatcherOptions.deliver({ text: "Site B shows Y." }, { kind: "block" });
        await dispatcherOptions.deliver({ text: "Final answer" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({ context: createContext() });

    expect(answerDraftStream.update).toHaveBeenNthCalledWith(1, "Site A shows X.");
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(2, "Site B shows Y.");
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(3, "Final answer");
    expect(answerDraftStream.forceNewMessage).toHaveBeenCalledTimes(1);
    const rotationOrder = answerDraftStream.forceNewMessage.mock.invocationCallOrder[0];
    const secondBlockUpdateOrder = answerDraftStream.update.mock.invocationCallOrder[1];
    expect(rotationOrder).toBeLessThan(secondBlockUpdateOrder);
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("falls back to normal delivery before rotating a stale queued block preview", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    let firstBlockPreviewWentStale = false;
    answerDraftStream.lastDeliveredText.mockImplementation(() =>
      firstBlockPreviewWentStale ? "stale draft still visible" : "",
    );
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        const firstPayload = setReplyPayloadMetadata(
          { text: "Site A shows X." },
          { assistantMessageIndex: 0 },
        );
        const secondPayload = setReplyPayloadMetadata(
          { text: "Site B shows Y." },
          { assistantMessageIndex: 1 },
        );
        await replyOptions?.onBlockReplyQueued?.(firstPayload, { assistantMessageIndex: 0 });
        await dispatcherOptions.deliver(firstPayload, { kind: "block" });
        firstBlockPreviewWentStale = true;
        await replyOptions?.onBlockReplyQueued?.(secondPayload, { assistantMessageIndex: 1 });
        await dispatcherOptions.deliver(secondPayload, { kind: "block" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({ context: createContext() });

    expect(answerDraftStream.update).toHaveBeenNthCalledWith(1, "Site A shows X.");
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(2, "Site A shows X.");
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(3, "Site B shows Y.");
    expect(answerDraftStream.clear).toHaveBeenCalled();
    expect(deliverReplies).toHaveBeenCalledTimes(1);
    const fallbackDelivery = mockCallArg(deliverReplies) as {
      replies?: Array<{ text?: string }>;
      transcriptMirror?: unknown;
    };
    expect(fallbackDelivery.replies?.[0]?.text).toBe("Site A shows X.");
    expect(fallbackDelivery.transcriptMirror).toBeUndefined();
    const clearOrder = answerDraftStream.clear.mock.invocationCallOrder[0];
    const fallbackDeliveryOrder = deliverReplies.mock.invocationCallOrder[0];
    const rotationOrder = answerDraftStream.forceNewMessage.mock.invocationCallOrder[0];
    const secondBlockUpdateOrder = answerDraftStream.update.mock.invocationCallOrder[2];
    expect(clearOrder).toBeLessThan(fallbackDeliveryOrder);
    expect(fallbackDeliveryOrder).toBeLessThan(rotationOrder);
    expect(rotationOrder).toBeLessThan(secondBlockUpdateOrder);
  });

  it("does not rotate a partial preview before queued block delivery drains", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "Site A shows X." });
        await replyOptions?.onBlockReplyQueued?.(
          { text: "Site A shows X." },
          { assistantMessageIndex: 0 },
        );
        await replyOptions?.onAssistantMessageStart?.();
        await replyOptions?.onBlockReplyQueued?.(
          { text: "Site B shows Y." },
          { assistantMessageIndex: 1 },
        );
        await dispatcherOptions.deliver({ text: "Site A shows X." }, { kind: "block" });
        await dispatcherOptions.deliver({ text: "Site B shows Y." }, { kind: "block" });
        await dispatcherOptions.deliver({ text: "Final answer" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({ context: createContext() });

    expect(answerDraftStream.update.mock.calls).toEqual([
      ["Site A shows X."],
      ["Site B shows Y."],
      ["Final answer"],
    ]);
    expect(answerDraftStream.forceNewMessage).toHaveBeenCalledTimes(1);
    const firstBlockFlushOrder = answerDraftStream.flush.mock.invocationCallOrder[0];
    const rotationOrder = answerDraftStream.forceNewMessage.mock.invocationCallOrder[0];
    const secondBlockUpdateOrder = answerDraftStream.update.mock.invocationCallOrder[1];
    expect(firstBlockFlushOrder).toBeLessThan(rotationOrder);
    expect(rotationOrder).toBeLessThan(secondBlockUpdateOrder);
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("drains unindexed queued blocks after delivery text rewrites", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "Existing preview" });
        await replyOptions?.onBlockReplyQueued?.({ text: "Original block text" });
        await replyOptions?.onAssistantMessageStart?.();
        await dispatcherOptions.deliver({ text: "PFX Original block text" }, { kind: "block" });
        await dispatcherOptions.deliver({ text: "Final answer" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({ context: createContext() });

    expect(answerDraftStream.update).toHaveBeenNthCalledWith(1, "Existing preview");
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(2, "PFX Original block text");
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(3, "Final answer");
    expect(answerDraftStream.forceNewMessage).toHaveBeenCalledTimes(1);
    const blockUpdateOrder = answerDraftStream.update.mock.invocationCallOrder[1];
    const rotationOrder = answerDraftStream.forceNewMessage.mock.invocationCallOrder[0];
    const finalUpdateOrder = answerDraftStream.update.mock.invocationCallOrder[2];
    expect(blockUpdateOrder).toBeLessThan(rotationOrder);
    expect(rotationOrder).toBeLessThan(finalUpdateOrder);
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("preserves boundary rotation after a queued prior block is canceled", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "Site A partial" });
        const priorPayload = setReplyPayloadMetadata(
          { text: "Site A final" },
          { assistantMessageIndex: 0 },
        );
        await replyOptions?.onBlockReplyQueued?.(priorPayload, { assistantMessageIndex: 0 });
        await replyOptions?.onAssistantMessageStart?.();
        await dispatcherOptions.onBeforeDeliverCancelled?.(priorPayload, { kind: "block" });
        const visiblePayload = setReplyPayloadMetadata(
          { text: "Site B final" },
          { assistantMessageIndex: 1 },
        );
        await replyOptions?.onBlockReplyQueued?.(visiblePayload, { assistantMessageIndex: 1 });
        await dispatcherOptions.deliver(visiblePayload, { kind: "block" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({ context: createContext() });

    expect(answerDraftStream.update).toHaveBeenNthCalledWith(1, "Site A partial");
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(2, "Site B final");
    expect(answerDraftStream.forceNewMessage).toHaveBeenCalledTimes(1);
    const firstPartialUpdateOrder = answerDraftStream.update.mock.invocationCallOrder[0];
    const rotationOrder = answerDraftStream.forceNewMessage.mock.invocationCallOrder[0];
    const visibleBlockUpdateOrder = answerDraftStream.update.mock.invocationCallOrder[1];
    expect(firstPartialUpdateOrder).toBeLessThan(rotationOrder);
    expect(rotationOrder).toBeLessThan(visibleBlockUpdateOrder);
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("expires skipped queued block rotations before later partial previews", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        const payload = setReplyPayloadMetadata({ text: "NO_REPLY" }, { assistantMessageIndex: 0 });
        await replyOptions?.onPartialReply?.({ text: "Site A shows X." });
        await replyOptions?.onBlockReplyQueued?.(payload, { assistantMessageIndex: 0 });
        await replyOptions?.onAssistantMessageStart?.();
        dispatcherOptions.onSkip?.(payload, { kind: "block", reason: "silent" });
        await replyOptions?.onPartialReply?.({ text: "Site B shows Y." });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({ context: createContext() });

    expect(answerDraftStream.update).toHaveBeenNthCalledWith(1, "Site A shows X.");
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(2, "Site B shows Y.");
    expect(answerDraftStream.forceNewMessage).toHaveBeenCalledTimes(1);
    const rotationOrder = answerDraftStream.forceNewMessage.mock.invocationCallOrder[0];
    const secondPartialUpdateOrder = answerDraftStream.update.mock.invocationCallOrder[1];
    expect(rotationOrder).toBeLessThan(secondPartialUpdateOrder);
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("preserves earlier queued rotations when a later block is skipped first", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        const priorPayload = setReplyPayloadMetadata(
          { text: "Site A shows X." },
          { assistantMessageIndex: 0 },
        );
        const skippedPayload = setReplyPayloadMetadata(
          { text: "NO_REPLY" },
          { assistantMessageIndex: 1 },
        );
        const visiblePayload = setReplyPayloadMetadata(
          { text: "Site B shows Y." },
          { assistantMessageIndex: 1 },
        );
        await replyOptions?.onBlockReplyQueued?.(priorPayload, { assistantMessageIndex: 0 });
        await replyOptions?.onBlockReplyQueued?.(skippedPayload, { assistantMessageIndex: 1 });
        dispatcherOptions.onSkip?.(skippedPayload, { kind: "block", reason: "silent" });
        await dispatcherOptions.deliver(priorPayload, { kind: "block" });
        await replyOptions?.onBlockReplyQueued?.(visiblePayload, { assistantMessageIndex: 1 });
        await dispatcherOptions.deliver(visiblePayload, { kind: "block" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({ context: createContext() });

    expect(answerDraftStream.update).toHaveBeenNthCalledWith(1, "Site A shows X.");
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(2, "Site B shows Y.");
    expect(answerDraftStream.forceNewMessage).toHaveBeenCalledTimes(1);
    const rotationOrder = answerDraftStream.forceNewMessage.mock.invocationCallOrder[0];
    const visibleBlockUpdateOrder = answerDraftStream.update.mock.invocationCallOrder[1];
    expect(rotationOrder).toBeLessThan(visibleBlockUpdateOrder);
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("clears queued rotations when block delivery loses answer text", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "Site A partial" });
        const queuedPayload = setReplyPayloadMetadata(
          { text: "Site A final" },
          { assistantMessageIndex: 0 },
        );
        await replyOptions?.onBlockReplyQueued?.(queuedPayload, { assistantMessageIndex: 0 });
        await replyOptions?.onAssistantMessageStart?.();
        await dispatcherOptions.deliver(
          setReplyPayloadMetadata(
            { mediaUrls: ["https://example.test/site-a.png"] },
            { assistantMessageIndex: 0 },
          ),
          { kind: "block", assistantMessageIndex: 0 },
        );
        await replyOptions?.onPartialReply?.({ text: "Site B partial" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({ context: createContext() });

    expect(answerDraftStream.update).toHaveBeenNthCalledWith(1, "Site A partial");
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(2, "Site B partial");
    expect(answerDraftStream.forceNewMessage).toHaveBeenCalledTimes(1);
    const firstPartialUpdateOrder = answerDraftStream.update.mock.invocationCallOrder[0];
    const rotationOrder = answerDraftStream.forceNewMessage.mock.invocationCallOrder[0];
    const nextPartialUpdateOrder = answerDraftStream.update.mock.invocationCallOrder[1];
    expect(firstPartialUpdateOrder).toBeLessThan(rotationOrder);
    expect(rotationOrder).toBeLessThan(nextPartialUpdateOrder);
    expect(deliverReplies).toHaveBeenCalledTimes(1);
  });

  it("sends an error fallback when dispatch fails after only partial output", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "partial answer" }, { kind: "block" });
      throw new Error("dispatch failed after partial output");
    });

    await dispatchWithContext({
      context: createContext({
        ctxPayload: createDirectSessionPayload(),
      }),
      streamMode: "off",
    });

    expect(deliverReplies).toHaveBeenCalledTimes(2);
    expectDeliveredReply(0, { text: "partial answer" });
    expectDeliveredReply(
      0,
      {
        text: "Something went wrong while processing your request. Please try again.",
      },
      1,
    );
  });

  it("returns retryable when dispatch fails after partial output and the fallback is not delivered", async () => {
    deliverReplies.mockResolvedValueOnce({ delivered: true });
    deliverReplies.mockResolvedValueOnce({ delivered: false });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "partial answer" }, { kind: "block" });
      throw new Error("dispatch failed after partial output");
    });

    const result = await dispatchWithContext({
      context: createContext({
        ctxPayload: createDirectSessionPayload(),
      }),
      retryDispatchErrors: true,
      streamMode: "off",
    });

    expect(result).toMatchObject({ kind: "failed-retryable" });
    expect((result as { error?: unknown }).error).toBeInstanceOf(Error);
    expect(deliverReplies).toHaveBeenCalledTimes(2);
    expectDeliveredReply(0, { text: "partial answer" });
    expectDeliveredReply(
      0,
      {
        text: "Something went wrong while processing your request. Please try again.",
      },
      1,
    );
  });

  it("returns retryable when spooled replay suppresses fallback after non-silent delivery skip", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      dispatcherOptions.onSkip?.({ text: "final answer" }, { kind: "final", reason: "empty" });
      return { queuedFinal: false };
    });

    const result = await dispatchWithContext({
      context: createContext(),
      retryDispatchErrors: true,
      suppressFailureFallback: true,
    });

    expect(result).toMatchObject({ kind: "failed-retryable" });
    expect((result as { error?: unknown }).error).toBeInstanceOf(Error);
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("does not return retryable after spooled replay already showed visible output", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "partial answer" }, { kind: "block" });
      dispatcherOptions.onSkip?.({ text: "final answer" }, { kind: "final", reason: "empty" });
      return { queuedFinal: false };
    });

    const result = await dispatchWithContext({
      context: createContext(),
      retryDispatchErrors: true,
      suppressFailureFallback: true,
    });

    expect(result).toEqual({ kind: "completed" });
    expect(answerDraftStream.update).toHaveBeenCalledWith("partial answer");
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("keeps tool progress visible after a partial-streamed intermediate block", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "Site A shows X." });
        await dispatcherOptions.deliver({ text: "Site A shows X." }, { kind: "block" });
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        await dispatcherOptions.deliver({ text: "Final answer" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({ context: createContext() });

    expect(answerDraftStream.update.mock.calls).toEqual([["Site A shows X."], ["Final answer"]]);
    expect(answerDraftStream.updatePreview).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringMatching(/🛠️ Exec<\/b>$/) }),
    );
    // The tool-progress window repositions before the final (deferred delete),
    // never an immediate clear/delete.
    expect(answerDraftStream.rotateToNewMessageDeferringDelete).toHaveBeenCalledTimes(1);
    // The reposition rewinds the stream BEFORE any deliverer cleanup clear(),
    // so that clear finds no live message id and never deletes the window.
    if (answerDraftStream.clear.mock.invocationCallOrder.length > 0) {
      expect(
        answerDraftStream.rotateToNewMessageDeferringDelete.mock.invocationCallOrder[0],
      ).toBeLessThan(answerDraftStream.clear.mock.invocationCallOrder[0]);
    }
    const progressResetOrder = answerDraftStream.forceNewMessage.mock.invocationCallOrder[0];
    const progressUpdateOrder = answerDraftStream.updatePreview.mock.invocationCallOrder[0];
    expect(progressResetOrder).toBeLessThan(progressUpdateOrder);
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("preserves streamed text blocks that follow tool progress before the final answer", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await dispatcherOptions.deliver({ text: "Site A shows X." }, { kind: "block" });
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        await dispatcherOptions.deliver({ text: "Site B shows Y." }, { kind: "block" });
        await dispatcherOptions.deliver({ text: "Final answer" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({ context: createContext() });

    expect(answerDraftStream.update).toHaveBeenNthCalledWith(1, "Site A shows X.");
    expect(answerDraftStream.updatePreview).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringMatching(/🛠️ Exec<\/b>$/) }),
    );
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(2, "Site B shows Y.");
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(3, "Final answer");
    // The tool-progress window repositions (deferred delete) rather than an
    // immediate clear when the following text block takes over the lane.
    expect(answerDraftStream.rotateToNewMessageDeferringDelete).toHaveBeenCalledTimes(1);
    // The reposition rewinds the stream BEFORE any deliverer cleanup clear(),
    // so that clear finds no live message id and never deletes the window.
    if (answerDraftStream.clear.mock.invocationCallOrder.length > 0) {
      expect(
        answerDraftStream.rotateToNewMessageDeferringDelete.mock.invocationCallOrder[0],
      ).toBeLessThan(answerDraftStream.clear.mock.invocationCallOrder[0]);
    }
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("keeps compaction replay on the same answer stream", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "Partial before compaction" });
        await replyOptions?.onCompactionStart?.();
        await replyOptions?.onPartialReply?.({ text: "Partial before compaction" });
        await dispatcherOptions.deliver({ text: "Final after compaction" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({ context: createContext() });

    expect(answerDraftStream.forceNewMessage).not.toHaveBeenCalled();
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(1, "Partial before compaction");
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(2, "Final after compaction");
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("rotates a tool-progress-only answer draft before streaming the final answer", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        await dispatcherOptions.deliver({ text: "Branch is up to date" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({ context: createContext() });

    expect(answerDraftStream.updatePreview).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringMatching(/🛠️ Exec<\/b>$/) }),
    );
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(1, "Branch is up to date");
    // Reposition, not delete-then-repost: the tool-progress window is rewound
    // for a new message and its delete deferred until after the replacement
    // lands. clear() (immediate delete) must NOT run — that scroll-jumps.
    expect(answerDraftStream.rotateToNewMessageDeferringDelete).toHaveBeenCalledTimes(1);
    // The reposition rewinds the stream BEFORE any deliverer cleanup clear(),
    // so that clear finds no live message id and never deletes the window.
    if (answerDraftStream.clear.mock.invocationCallOrder.length > 0) {
      expect(
        answerDraftStream.rotateToNewMessageDeferringDelete.mock.invocationCallOrder[0],
      ).toBeLessThan(answerDraftStream.clear.mock.invocationCallOrder[0]);
    }
    const rotationOrder =
      answerDraftStream.rotateToNewMessageDeferringDelete.mock.invocationCallOrder[0];
    const finalUpdateOrder = answerDraftStream.update.mock.invocationCallOrder[0];
    expect(rotationOrder).toBeLessThan(finalUpdateOrder);
  });

  it("clears a tool-progress-only draft across assistant boundaries before final text", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        await replyOptions?.onAssistantMessageStart?.();
        await dispatcherOptions.deliver({ text: "Branch is up to date" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({ context: createContext() });

    expect(answerDraftStream.updatePreview).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringMatching(/🛠️ Exec<\/b>$/) }),
    );
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(1, "Branch is up to date");
    // Across an assistant boundary the tool-progress window still repositions
    // (new message first, deferred delete) rather than deleting immediately.
    expect(answerDraftStream.rotateToNewMessageDeferringDelete).toHaveBeenCalledTimes(1);
    // The reposition rewinds the stream BEFORE any deliverer cleanup clear(),
    // so that clear finds no live message id and never deletes the window.
    if (answerDraftStream.clear.mock.invocationCallOrder.length > 0) {
      expect(
        answerDraftStream.rotateToNewMessageDeferringDelete.mock.invocationCallOrder[0],
      ).toBeLessThan(answerDraftStream.clear.mock.invocationCallOrder[0]);
    }
    const rotationOrder =
      answerDraftStream.rotateToNewMessageDeferringDelete.mock.invocationCallOrder[0];
    const finalUpdateOrder = answerDraftStream.update.mock.invocationCallOrder[0];
    expect(rotationOrder).toBeLessThan(finalUpdateOrder);
  });

  it("rotates a verbose tool result draft before streaming the final answer", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "🛠️ Exec: pnpm test" }, { kind: "tool" });
      await dispatcherOptions.deliver({ text: "Tests passed" }, { kind: "final" });
      return { queuedFinal: true };
    });

    await dispatchWithContext({ context: createContext() });

    expect(answerDraftStream.update).toHaveBeenNthCalledWith(1, "🛠️ Exec: pnpm test");
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(2, "Tests passed");
    // Verbose tool result window repositions before the final: new message
    // first, superseded delete deferred (no immediate clear/delete).
    expect(answerDraftStream.rotateToNewMessageDeferringDelete).toHaveBeenCalledTimes(1);
    // The reposition rewinds the stream BEFORE any deliverer cleanup clear(),
    // so that clear finds no live message id and never deletes the window.
    if (answerDraftStream.clear.mock.invocationCallOrder.length > 0) {
      expect(
        answerDraftStream.rotateToNewMessageDeferringDelete.mock.invocationCallOrder[0],
      ).toBeLessThan(answerDraftStream.clear.mock.invocationCallOrder[0]);
    }
    const rotationOrder =
      answerDraftStream.rotateToNewMessageDeferringDelete.mock.invocationCallOrder[0];
    const finalUpdateOrder = answerDraftStream.update.mock.invocationCallOrder[1];
    expect(rotationOrder).toBeLessThan(finalUpdateOrder);
  });

  it("keeps progress updates in a draft and sends the final answer normally", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    answerDraftStream.hasConsumedReplyTarget.mockReturnValue(true);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        await replyOptions?.onItemEvent?.({
          kind: "command",
          name: "exec",
          progressText: "git rev-parse --abbrev-ref HEAD",
        });
        await dispatcherOptions.deliver({ text: "Branch is up to date" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context: createContext(),
      streamMode: "progress",
      telegramCfg: { streaming: { mode: "progress" } },
    });

    expect(answerDraftStream.updatePreview).toHaveBeenCalledWith(
      telegramProgressPreview(
        "Cracking\n\n🛠️ Exec\n🛠️ git rev-parse --abbrev-ref HEAD",
        "<b>Cracking</b>\n<b>🛠️ Exec</b>\n<b>🛠️ Exec</b> <code>git rev-parse --abbrev-ref HEAD</code>",
      ),
    );
    expect(answerDraftStream.update).not.toHaveBeenCalledWith("Branch is up to date");
    expect(answerDraftStream.forceNewMessage).toHaveBeenCalledTimes(1);
    // The window collapses IN PLACE into the one-line activity summary (edit,
    // not delete + repost — Discord parity), so clear() is never called on it.
    expect(answerDraftStream.clear).not.toHaveBeenCalled();
    expectWindowCollapsedTo(answerDraftStream, "🛠️ 1 tool call · ⏱️ 1s");
    expectDeliveredReply(0, { text: "Branch is up to date" });
    expectDeliverRepliesParams({ replyToMode: "off" });
    // The final answer is SENT before the window collapses into the bar: sending
    // first keeps the final at the bottom of the anchored viewport, so shrinking
    // the tall window above it never drops the final off screen.
    expect(deliverReplies.mock.invocationCallOrder[0]).toBeLessThan(
      answerDraftStream.finalizeToPreview.mock.invocationCallOrder[0],
    );
    expect(editMessageTelegram).not.toHaveBeenCalled();
  });

  it("delivers a block-only progress turn as the terminal answer", async () => {
    const { answerDraftStream } = setupDraftStreams();
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        { text: "Terminal block answer" },
        { kind: "block", assistantMessageIndex: 0 },
      );
      return { queuedFinal: false, counts: { block: 1, final: 0, tool: 0 } };
    });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "progress",
      telegramCfg: { streaming: { mode: "progress" } },
    });

    expect(answerDraftStream.update).not.toHaveBeenCalledWith("Terminal block answer");
    expect(answerDraftStream.finalizeToPreview).not.toHaveBeenCalled();
    expectDeliveredReply(0, { text: "Terminal block answer" });
  });

  it("uses a block-only terminal answer instead of prior tool-progress text", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        await dispatcherOptions.deliver(
          { text: "Terminal block after tool" },
          { kind: "block", assistantMessageIndex: 0 },
        );
        return { queuedFinal: false, counts: { block: 1, final: 0, tool: 1 } };
      },
    );

    await dispatchWithContext({
      context: createContext(),
      streamMode: "progress",
      telegramCfg: { streaming: { mode: "progress" } },
    });

    expect(answerDraftStream.updatePreview).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("Exec") }),
    );
    expectDeliveredReply(0, { text: "Terminal block after tool" });
    expectWindowCollapsedTo(answerDraftStream, "🛠️ 1 tool call · ⏱️ 1s");
    expect(deliverReplies.mock.invocationCallOrder[0]).toBeLessThan(
      answerDraftStream.finalizeToPreview.mock.invocationCallOrder[0],
    );
  });

  function allDeliveredReplyTexts(): string[] {
    return deliverReplies.mock.calls.flatMap((call: unknown[]) =>
      ((call[0] as { replies?: Array<{ text?: string }> }).replies ?? []).map(
        (reply) => reply.text ?? "",
      ),
    );
  }

  it("sends the final answer before collapsing the window into the bar", async () => {
    // Edit-shrink anchor loss: shrinking the tall window to a one-line bar BEFORE
    // the final is sent breaks the client's at-bottom follow and drops the final
    // off screen. The final must be sent FIRST, then the window edited down.
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        await dispatcherOptions.deliver({ text: "All done" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context: createContext(),
      streamMode: "progress",
      telegramCfg: { streaming: { mode: "progress" } },
    });

    // Final delivered, then the window edited into the bar — final send precedes
    // the collapse edit.
    expectDeliveredReply(0, { text: "All done" });
    expectWindowCollapsedTo(answerDraftStream, "🛠️ 1 tool call · ⏱️ 1s");
    expect(deliverReplies.mock.invocationCallOrder[0]).toBeLessThan(
      answerDraftStream.finalizeToPreview.mock.invocationCallOrder[0],
    );
    // The bar counters are snapshotted before the final send, so the count is
    // stable (one tool call — the final's own delivery does not perturb it).
    expect(answerDraftStream.finalizeToPreview).toHaveBeenCalledTimes(1);
    expect(answerDraftStream.clear).not.toHaveBeenCalled();
  });

  it("still collapses the window when the final answer send is skipped", async () => {
    // Failure path: if the final send skips/fails, the window must not be left
    // stale — it still collapses to the bar (once-guard already consumed).
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    deliverReplies.mockResolvedValue({ delivered: false });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        await dispatcherOptions.deliver({ text: "Answer that fails to send" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context: createContext(),
      streamMode: "progress",
      telegramCfg: { streaming: { mode: "progress" } },
    });

    // The bar still edits the window in place even though the final send failed.
    expectWindowCollapsedTo(answerDraftStream, "🛠️ 1 tool call · ⏱️ 1s");
  });

  it("tallies reasoning bursts and tool calls into the collapse summary", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        // burst 1 → tool → burst 2 → tool, then a trailing burst flushed at the
        // summary: 3 thoughts, 2 tool calls.
        await replyOptions?.onReasoningStream?.({ text: "thinking a" });
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        await replyOptions?.onReasoningStream?.({ text: "thinking b" });
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        await replyOptions?.onReasoningStream?.({ text: "thinking c" });
        await dispatcherOptions.deliver({ text: "Done" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      // Reasoning must resolve to "stream" so thoughts route into the progress
      // window — only window-streamed reasoning feeds the collapse summary.
      context: createReasoningStreamContext(),
      streamMode: "progress",
      telegramCfg: { streaming: { mode: "progress" } },
    });

    expectWindowCollapsedTo(answerDraftStream, "🧠 3 thoughts · 🛠️ 2 tool calls · ⏱️ 1s");
    expectDeliveredReply(0, { text: "Done" });
  });

  it("does not post a collapse summary when no progress draft started", async () => {
    setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      // No tools, thoughts, or notes — nothing collapses; just a final answer.
      await dispatcherOptions.deliver({ text: "Just an answer" }, { kind: "final" });
      return { queuedFinal: true };
    });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "progress",
      telegramCfg: { streaming: { mode: "progress" } },
    });

    const texts = allDeliveredReplyTexts();
    expect(texts.some((text) => text.includes("⏱️"))).toBe(false);
    expect(texts).toContain("Just an answer");
  });

  it("does not post a collapse summary before an error final", async () => {
    setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        await dispatcherOptions.deliver(
          { text: "Something went wrong", isError: true },
          { kind: "final" },
        );
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context: createContext(),
      streamMode: "progress",
      telegramCfg: { streaming: { mode: "progress" } },
    });

    const texts = allDeliveredReplyTexts();
    expect(texts.some((text) => text.includes("tool call · ⏱️"))).toBe(false);
  });

  it("delivers the collapse bar as a real message but never mirrors it into the transcript", async () => {
    // Red-team F1: the bar is a cosmetic activity digest. It must be a durable
    // Telegram message but must NOT enter the session transcript, or the model
    // reads "🛠️ 1 tool call · ⏱️ Ns" back as its own prior turn. The real final
    // still mirrors (Discord parity: its summary bar has no mirror seam either).
    setupDraftStreams(); // no window message id → the bar posts durably (not an in-place edit)
    const context = createContext();
    context.ctxPayload.SessionKey = "agent:default:telegram:direct:123";
    mockDefaultSessionEntry();
    deliverReplies.mockImplementation(
      async (params: {
        replies?: Array<{ text?: string }>;
        transcriptMirror?: (payload: { text?: string; mediaUrls?: string[] }) => Promise<void>;
      }) => {
        const text = params.replies
          ?.map((reply) => reply.text)
          .filter(Boolean)
          .join("\n\n");
        await params.transcriptMirror?.({ text });
        return { delivered: true };
      },
    );
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        await dispatcherOptions.deliver({ text: "Done" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context,
      streamMode: "progress",
      telegramCfg: { streaming: { mode: "progress" } },
    });

    // The final is sent first (call 0, mirrored), then the bar (call 1, not).
    expect(deliverReplies).toHaveBeenCalledTimes(2);
    expectDeliveredReply(0, { text: "Done" });
    expect(typeof mockCallArg(deliverReplies, 0).transcriptMirror).toBe("function");
    const barParams = mockCallArg(deliverReplies, 1) as {
      replies?: Array<{ text?: string }>;
      transcriptMirror?: unknown;
    };
    expect(barParams.replies?.[0]?.text).toContain("🛠️ 1 tool call");
    expect(barParams.transcriptMirror).toBeUndefined();
    // Only the final reached the transcript; the bar line never did.
    expect(appendAssistantMirrorMessageByIdentity).toHaveBeenCalledTimes(1);
    expectRecordFields(mockCallArg(appendAssistantMirrorMessageByIdentity), { text: "Done" });
  });

  it("does not count a start-phase message tool toward the collapse bar", async () => {
    // Red-team F4: progressSummary.noteToolCall() fired for ANY start-phase tool,
    // but the window renders only work tools (isChannelProgressDraftWorkToolName
    // rejects message/reply/react/…). A codex message_tool_only turn thus showed
    // "🛠️ 1 tool call" with no tool line. The count must match the window: one
    // work tool → 1, the message tool → 0.
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        await replyOptions?.onToolStart?.({ name: "message", phase: "start" });
        await dispatcherOptions.deliver({ text: "Done" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context: createContext(),
      streamMode: "progress",
      telegramCfg: { streaming: { mode: "progress" } },
    });

    expectWindowCollapsedTo(answerDraftStream, "🛠️ 1 tool call · ⏱️ 1s");
  });

  it("does not count a work tool toward the collapse bar when toolProgress is off", async () => {
    // Red-team F4: with streaming.progress.toolProgress=false the window renders
    // no tool line, so a work tool must not feed the tally either — only the
    // reasoning that streamed to the window counts.
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onReasoningStream?.({ text: "thinking" });
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        await dispatcherOptions.deliver({ text: "Done" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context: createReasoningStreamContext(),
      streamMode: "progress",
      telegramCfg: { streaming: { mode: "progress", progress: { toolProgress: false } } },
    });

    expectWindowCollapsedTo(answerDraftStream, "🧠 1 thought · ⏱️ 1s");
  });

  it("keeps the turn alive when the cleanup-time collapse bar send throws", async () => {
    // Red-team F3: the cosmetic bar posts from the cleanup fallback AFTER the
    // real (out-of-band) final is already delivered. A flood-wait/network throw
    // from that send must be swallowed, never propagated out of dispatch.
    setupDraftStreams({ answerMessageId: 2001 });
    deliverReplies.mockRejectedValue(new Error("Too Many Requests: retry after 5"));
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      return {
        queuedFinal: true,
        counts: { block: 0, final: 1, tool: 1 },
        sourceReplyDeliveryMode: "message_tool_only",
      };
    });

    let thrown: unknown;
    try {
      await dispatchWithContext({
        context: createContext(),
        streamMode: "progress",
        telegramCfg: { streaming: { mode: "progress" } },
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeUndefined();
    // The bar send was attempted (and swallowed) rather than skipped.
    expect(deliverReplies).toHaveBeenCalled();
  });

  it("keeps the progress window alive under /reasoning on so commentary and tools still stream", async () => {
    // /reasoning on removes only the 🧠 lane from the window; commentary, tool
    // lines, and the collapse bar must still stream (Discord parity). A prior
    // regression forced block streaming in progress mode, killing the window.
    loadSessionStore.mockReturnValue({ s1: { reasoningLevel: "on" } });
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onItemEvent?.({ kind: "preamble", itemId: "c1", progressText: "Note" });
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        await dispatcherOptions.deliver({ text: "Done" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context: createContext({
        ctxPayload: { SessionKey: "s1" } as unknown as TelegramMessageContext["ctxPayload"],
      }),
      streamMode: "progress",
      telegramCfg: { streaming: { mode: "progress" } },
    });

    // The window streamed (a preview was rendered) and collapsed into a bar
    // counting the note + tool — proof the window was not killed.
    expect(answerDraftStream.updatePreview).toHaveBeenCalled();
    expectWindowCollapsedTo(answerDraftStream, "💬 1 note · 🛠️ 1 tool call · ⏱️ 1s");
    expectDeliveredReply(0, { text: "Done" });
  });

  it("collapses a tool-progress-only window without deleting when reasoning is durable and the lane rotated mid-turn (on-off)", async () => {
    // on-off cell: /reasoning on (durable), /verbose off. The window streams
    // tool progress only; a mid-turn assistant boundary/rotation must not leave
    // the collapse to a delete + repost. Every non-error collapse edits in place
    // (or posts the bar durably) — NEVER a bare clear()/deleteMessage — so there
    // is exactly one bar and no Telegram focus-jump.
    loadSessionStore.mockReturnValue({ s1: { reasoningLevel: "on" } });
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        // Durable reasoning + an assistant boundary land between tool progress
        // and the final — the mid-turn churn that dropped the live window id.
        await dispatcherOptions.deliver(
          { text: "<think>hidden</think>", isReasoning: true },
          { kind: "block" },
        );
        await replyOptions?.onAssistantMessageStart?.();
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        await dispatcherOptions.deliver({ text: "Done" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context: createContext({
        ctxPayload: { SessionKey: "s1" } as unknown as TelegramMessageContext["ctxPayload"],
      }),
      streamMode: "progress",
      telegramCfg: { streaming: { mode: "progress" } },
    });

    // Collapse edited the window in place into the bar; the window was NOT
    // deleted (no focus-jump), and exactly one bar exists.
    expectWindowCollapsedTo(answerDraftStream, "🛠️ 2 tool calls · ⏱️ 1s");
    expect(answerDraftStream.clear).not.toHaveBeenCalled();
    const texts = allDeliveredReplyTexts();
    expect(texts.filter((text) => text.includes("⏱️"))).toHaveLength(0); // bar is the in-place edit
    expect(texts).toContain("Done");
  });

  it("keeps a single stationary window when text follows durable reasoning (no mid-turn rotation)", async () => {
    // Single-message model (Discord parity): in progress mode the window is ONE
    // message edited through every lane handover — durable 🧠, interim answer
    // text — and edited into the bar only at collapse. It must NOT reposition or
    // rotate mid-turn (no new bubble, no delete), which is what caused the churn
    // and the on-off jump. Interim answer text does not render into the window.
    loadSessionStore.mockReturnValue({ s1: { reasoningLevel: "on" } });
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        await dispatcherOptions.deliver(
          { text: "<think>hidden</think>", isReasoning: true },
          { kind: "block" },
        );
        // Interim answer text mid-turn: must not spawn a new window bubble.
        await dispatcherOptions.deliver({ text: "Here is the answer" }, { kind: "block" });
        await dispatcherOptions.deliver({ text: "Here is the answer." }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context: createContext({
        ctxPayload: { SessionKey: "s1" } as unknown as TelegramMessageContext["ctxPayload"],
      }),
      streamMode: "progress",
      telegramCfg: { streaming: { mode: "progress" } },
    });

    // The one window message stays put through the whole turn: no mid-turn
    // reposition and no delete — only the collapse edit into the bar at the end.
    // (forceNewMessage fires once at collapse to rewind the stream after the bar
    // edit; that is end-of-turn, not mid-turn churn.)
    expect(answerDraftStream.rotateToNewMessageDeferringDelete).not.toHaveBeenCalled();
    expect(answerDraftStream.clear).not.toHaveBeenCalled();
    expectWindowCollapsedTo(answerDraftStream, "🛠️ 1 tool call · ⏱️ 1s");
    // The bar edit is the only send/edit that finalizes the window (one message).
    expect(answerDraftStream.finalizeToPreview).toHaveBeenCalledTimes(1);
  });

  it("uses one stationary window message across a multi-boundary turn (commentary→tool→commentary→tool→final)", async () => {
    // Single-message model (Discord parity): ONE window message id is created
    // once and edited through every lane handover; it collapses into the bar in
    // place at the end. Zero deletes in the happy path; the final is posted
    // before the bar edit (task-9 order).
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onItemEvent?.({ kind: "preamble", itemId: "c1", progressText: "Look" });
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        await replyOptions?.onItemEvent?.({ kind: "preamble", itemId: "c2", progressText: "Now" });
        await replyOptions?.onToolStart?.({ name: "read", phase: "start" });
        await dispatcherOptions.deliver({ text: "Final answer" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context: createContext(),
      streamMode: "progress",
      telegramCfg: { streaming: { mode: "progress" } },
    });

    // The SAME window message id is used the whole turn — no new bubble.
    const windowMessageIds = new Set(
      answerDraftStream.updatePreview.mock.calls
        .map(() => answerDraftStream.messageId())
        .filter((id) => id != null),
    );
    expect(windowMessageIds).toEqual(new Set([2001]));
    // The window was EDITED many times (once per lane change) ...
    expect(answerDraftStream.updatePreview.mock.calls.length).toBeGreaterThan(1);
    // ... and NEVER rotated/repositioned/deleted mid-turn.
    expect(answerDraftStream.rotateToNewMessageDeferringDelete).not.toHaveBeenCalled();
    expect(answerDraftStream.clear).not.toHaveBeenCalled();
    // The bar edit is the single finalize, and it happens AFTER the final send.
    expect(answerDraftStream.finalizeToPreview).toHaveBeenCalledTimes(1);
    expectWindowCollapsedTo(answerDraftStream, "💬 2 notes · 🛠️ 2 tool calls · ⏱️ 1s");
    expectDeliveredReply(0, { text: "Final answer" });
    expect(deliverReplies.mock.invocationCallOrder[0]).toBeLessThan(
      answerDraftStream.finalizeToPreview.mock.invocationCallOrder[0],
    );
  });

  it("never streams an interim answer block into the progress window (Discord parity)", async () => {
    // Progress mode: the window is a pure activity log. An intermediate assistant
    // answer block (info.kind === "block", before the final) must NOT render into
    // the window; it is buffered and only the final answer is delivered below.
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        // Intermediate assistant answer prose mid-turn.
        await dispatcherOptions.deliver({ text: "Interim answer prose" }, { kind: "block" });
        await dispatcherOptions.deliver({ text: "The real final answer." }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context: createContext(),
      streamMode: "progress",
      telegramCfg: { streaming: { mode: "progress" } },
    });

    // The interim block text never reached the window (neither update nor preview).
    const windowTexts = [
      ...answerDraftStream.update.mock.calls.map((call) => call[0]),
      ...answerDraftStream.updatePreview.mock.calls.map(
        (call) => (call[0] as { text?: string }).text ?? "",
      ),
    ];
    expect(windowTexts.some((text) => text.includes("Interim answer prose"))).toBe(false);
    // The final answer is delivered below the collapsed window.
    const delivered = allDeliveredReplyTexts();
    expect(delivered).toContain("The real final answer.");
    expect(delivered.some((text) => text.includes("Interim answer prose"))).toBe(false);
  });

  it("posts the collapse bar durably with no delete when the window has no live message", async () => {
    // When finalizeToPreview cannot edit in place (no live window message id),
    // the bar is still surfaced — as a durable post — and the window is NOT
    // cleared/deleted (nothing to delete; never a bare clear when a bar exists).
    const answerDraftStream = createTestDraftStream({}); // no messageId -> edit fails
    const reasoningDraftStream = createTestDraftStream({});
    createTelegramDraftStream
      .mockImplementationOnce(() => answerDraftStream)
      .mockImplementationOnce(() => reasoningDraftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        await dispatcherOptions.deliver({ text: "Done" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context: createContext(),
      streamMode: "progress",
      telegramCfg: { streaming: { mode: "progress" } },
    });

    const texts = allDeliveredReplyTexts();
    expect(texts.filter((text) => text.includes("⏱️"))).toEqual(["🛠️ 1 tool call · ⏱️ 1s"]);
    expect(texts).toContain("Done");
    expect(answerDraftStream.clear).not.toHaveBeenCalled();
  });

  it("keeps the turn alive when the no-live-message fallback bar send throws", async () => {
    // Sibling of the F3 cleanup-throw guard: applyProgressCollapseSummary posts
    // the bar durably when finalizeToPreview cannot edit in place. That fallback
    // send is cosmetic and runs AFTER the in-band final, so a flood-wait/network
    // throw must be swallowed (postCosmeticSummaryBar), never failing the turn.
    const answerDraftStream = createTestDraftStream({}); // no messageId -> edit fails -> durable post
    const reasoningDraftStream = createTestDraftStream({});
    createTelegramDraftStream
      .mockImplementationOnce(() => answerDraftStream)
      .mockImplementationOnce(() => reasoningDraftStream);
    // Only the cosmetic bar send throws; the real final "Done" still delivers.
    deliverReplies.mockImplementation(async (params: { replies?: Array<{ text?: string }> }) => {
      if (params.replies?.some((reply) => reply.text?.includes("⏱️"))) {
        throw new Error("Too Many Requests: retry after 5");
      }
      return { delivered: true };
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        await dispatcherOptions.deliver({ text: "Done" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    let thrown: unknown;
    try {
      await dispatchWithContext({
        context: createContext(),
        streamMode: "progress",
        telegramCfg: { streaming: { mode: "progress" } },
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeUndefined();
    // The bar fallback send was attempted (and swallowed); the final survived.
    const texts = allDeliveredReplyTexts();
    expect(texts.some((text) => text.includes("⏱️"))).toBe(true);
    expect(texts).toContain("Done");
  });

  it("does not duplicate tool lines into the window under verbose", async () => {
    // Invariant D2 (persistent XOR window): when the durable verbose lane owns
    // tool messages, the window must render no tool line and must not count it.
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        replyOptions?.onVerboseProgressVisibility?.(() => true);
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        await dispatcherOptions.deliver({ text: "Done" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context: createContext(),
      streamMode: "progress",
      telegramCfg: { streaming: { mode: "progress" } },
    });

    // No tool line ever rendered to the window (verbose owns it durably), so the
    // window never streamed and there is no collapse bar to count it.
    expect(answerDraftStream.updatePreview).not.toHaveBeenCalled();
    expect(answerDraftStream.finalizeToPreview).not.toHaveBeenCalled();
    const texts = allDeliveredReplyTexts();
    expect(texts.some((text) => text.includes("tool call"))).toBe(false);
  });

  it("posts a collapse summary for a message_tool_only final that bypasses the answer path", async () => {
    // Codex-runtime turns deliver the final out-of-band (queuedFinal), so the
    // in-band collapse path never runs. The window still started, so the
    // cleanup-time fallback must emit the bar (Discord parity).
    setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      await replyOptions?.onItemEvent?.({ kind: "preamble", itemId: "c1", progressText: "Note" });
      await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      return {
        queuedFinal: true,
        counts: { block: 0, final: 1, tool: 1 },
        sourceReplyDeliveryMode: "message_tool_only",
      };
    });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "progress",
      telegramCfg: { streaming: { mode: "progress" } },
    });

    const texts = allDeliveredReplyTexts();
    expect(texts).toContain("💬 1 note · 🛠️ 1 tool call · ⏱️ 1s");
  });

  it("replaces Telegram command progress items with matching command output", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      await replyOptions?.onItemEvent?.({
        itemId: "tool:call-1",
        toolCallId: "call-1",
        kind: "command",
        name: "exec",
        progressText: "install dependencies",
      });
      await replyOptions?.onCommandOutput?.({
        itemId: "tool:call-1-output",
        toolCallId: "call-1",
        phase: "end",
        name: "exec",
        exitCode: 0,
      });
      return { queuedFinal: false };
    });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "progress",
      telegramCfg: { streaming: { mode: "progress", progress: { label: "Shelling" } } },
    });

    const lastUpdate = answerDraftStream.updatePreview.mock.calls.at(-1)?.[0];
    expect(lastUpdate?.text).toContain("install dependencies");
    expect(lastUpdate?.text).not.toContain("completed");
    expect(lastUpdate).toEqual(
      telegramProgressPreview(
        "Shelling\n\n🛠️ install dependencies",
        "<b>Shelling</b>\n<b>🛠️ Exec</b> <code>install dependencies</code>",
      ),
    );
  });

  it("sends trailing verbose status after a progress-mode final answer", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        await dispatcherOptions.deliver({ text: "Branch is up to date" }, { kind: "final" });
        await dispatcherOptions.deliver({ text: trailingFinalStatusText }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context: createContext(),
      streamMode: "progress",
      telegramCfg: { streaming: { mode: "progress" } },
    });

    expect(answerDraftStream.updatePreview).toHaveBeenCalledWith(
      telegramProgressPreview("Cracking\n\n🛠️ Exec", "<b>Cracking</b>\n<b>🛠️ Exec</b>"),
    );
    expect(answerDraftStream.update).toHaveBeenCalledTimes(1);
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(1, trailingFinalStatusText);
    expect(answerDraftStream.forceNewMessage).toHaveBeenCalledTimes(2);
    expect(answerDraftStream.forceNewMessage.mock.invocationCallOrder[1]).toBeLessThan(
      answerDraftStream.update.mock.invocationCallOrder[0],
    );
    // Window collapses in place into the summary bar; the final answer posts
    // fresh below it.
    expectWindowCollapsedTo(answerDraftStream, "🛠️ 1 tool call · ⏱️ 1s");
    expectDeliveredReply(0, { text: "Branch is up to date" });
  });

  it("does not stream text-only tool results into progress drafts", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        await dispatcherOptions.deliver(
          { text: "stdout line one\nstdout line two" },
          { kind: "tool" },
        );
        await replyOptions?.onItemEvent?.({ kind: "search", progressText: "docs lookup" });
        return { queuedFinal: false };
      },
    );

    await dispatchWithContext({
      context: createContext(),
      streamMode: "progress",
      telegramCfg: { streaming: { mode: "progress", progress: { label: "Shelling" } } },
    });

    expect(answerDraftStream.updatePreview).not.toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("stdout line one") }),
    );
    expect(answerDraftStream.updatePreview).toHaveBeenLastCalledWith(
      telegramProgressPreview(
        "Shelling\n\n🛠️ Exec\n🔎 Web Search: docs lookup",
        "<b>Shelling</b>\n<b>🛠️ Exec</b>\n<b>🔎 Web Search</b> <code>docs lookup</code>",
      ),
    );
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("renders api progress item edge cases as HTML transport previews", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      await replyOptions?.onItemEvent?.({ kind: "api", progressText: "GET /v1/users" });
      await replyOptions?.onItemEvent?.({
        kind: "api",
        name: "api",
        progressText: "POST /v1/jobs",
      });
      return { queuedFinal: false };
    });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "progress",
      telegramCfg: { streaming: { mode: "progress", progress: { label: "Shelling" } } },
    });

    expect(answerDraftStream.updatePreview).toHaveBeenLastCalledWith(
      telegramProgressPreview(
        "Shelling\n\n🌐 API: GET /v1/users\n🌐 API: POST /v1/jobs",
        "<b>Shelling</b>\n<b>🌐 API</b> <code>GET /v1/users</code>\n<b>🌐 API</b> <code>POST /v1/jobs</code>",
      ),
    );
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("does not restart progress drafts after final answer delivery", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        await dispatcherOptions.deliver({ text: "Branch is up to date" }, { kind: "final" });
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context: createContext(),
      streamMode: "progress",
      telegramCfg: { streaming: { mode: "progress", progress: { label: "Shelling" } } },
    });

    expect(answerDraftStream.updatePreview).toHaveBeenCalledTimes(1);
    expect(answerDraftStream.updatePreview).toHaveBeenCalledWith(
      telegramProgressPreview("Shelling\n\n🛠️ Exec", "<b>Shelling</b>\n<b>🛠️ Exec</b>"),
    );
    expectWindowCollapsedTo(answerDraftStream, "🛠️ 1 tool call · ⏱️ 1s");
    expectDeliveredReply(0, { text: "Branch is up to date" });
  });

  it("does not restart progress drafts for command output after final answer delivery", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        await dispatcherOptions.deliver({ text: "Branch is up to date" }, { kind: "final" });
        await replyOptions?.onCommandOutput?.({
          phase: "end",
          title: "Exec",
          name: "exec",
          status: "failed",
          exitCode: 1,
        });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context: createContext(),
      streamMode: "progress",
      telegramCfg: { streaming: { mode: "progress", progress: { label: "Shelling" } } },
    });

    expect(answerDraftStream.updatePreview).toHaveBeenCalledTimes(1);
    expect(answerDraftStream.updatePreview).toHaveBeenCalledWith(
      telegramProgressPreview("Shelling\n\n🛠️ Exec", "<b>Shelling</b>\n<b>🛠️ Exec</b>"),
    );
    expectWindowCollapsedTo(answerDraftStream, "🛠️ 1 tool call · ⏱️ 1s");
    expectDeliveredReply(0, { text: "Branch is up to date" });
  });

  it("does not restart progress drafts for command output while final answer delivery is pending", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        const finalDelivery = dispatcherOptions.deliver(
          { text: "Branch is up to date" },
          { kind: "final" },
        );
        await replyOptions?.onCommandOutput?.({
          phase: "end",
          title: "Exec",
          name: "exec",
          status: "failed",
          exitCode: 1,
        });
        await finalDelivery;
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context: createContext(),
      streamMode: "progress",
      telegramCfg: { streaming: { mode: "progress", progress: { label: "Shelling" } } },
    });

    expect(answerDraftStream.updatePreview).toHaveBeenCalledTimes(1);
    expect(answerDraftStream.updatePreview).toHaveBeenCalledWith(
      telegramProgressPreview("Shelling\n\n🛠️ Exec", "<b>Shelling</b>\n<b>🛠️ Exec</b>"),
    );
    expectWindowCollapsedTo(answerDraftStream, "🛠️ 1 tool call · ⏱️ 1s");
    expectDeliveredReply(0, { text: "Branch is up to date" });
  });

  it("uses the transcript final when progress-mode final text is truncated", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    const fullAnswer =
      "Ja. Hier nochmal sauber Schritt fuer Schritt. Einen API Key kopiert man aus der Google Cloud Console. Danach pruefst du die Projekt- und API-Einstellungen.";
    const truncatedFinal =
      "Ja. Hier nochmal sauber Schritt fuer Schritt. Einen API Key kopiert man...";
    const context = createContext();
    context.ctxPayload.SessionKey = "agent:default:telegram:direct:123";
    mockDefaultSessionEntry();
    readLatestAssistantTextByIdentity.mockResolvedValue({
      text: fullAnswer,
      timestamp: Date.now() + 1_000,
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        await dispatcherOptions.deliver({ text: truncatedFinal }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context,
      streamMode: "progress",
      telegramCfg: { streaming: { mode: "progress" } },
    });

    expectWindowCollapsedTo(answerDraftStream, "🛠️ 1 tool call · ⏱️ 1s");
    expectDeliveredReply(0, { text: fullAnswer });
  });

  it("hands the complete long final to draft-owned pagination", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    const longText = "one ".repeat(80);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: longText }, { kind: "final" });
      return { queuedFinal: true };
    });

    await dispatchWithContext({ context: createContext(), textLimit: 80 });

    expect(answerDraftStream.update).toHaveBeenLastCalledWith(longText.trimEnd());
    expectRecordFields(mockCallArg(recordOutboundMessageForPromptContext), {
      messageId: 2001,
      text: longText.trimEnd(),
    });
    expect(deliverReplies).not.toHaveBeenCalled();
    expect(editMessageTelegram).not.toHaveBeenCalled();
  });

  it("keeps streamed final text in place when late media arrives", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    const mediaMaxBytes = 50 * 1024 * 1024;
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "Photo" });
        await dispatcherOptions.deliver(
          { text: "Photo", mediaUrl: "https://example.com/a.png" },
          { kind: "final" },
        );
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context: createContext(),
      telegramCfg: { mediaMaxMb: 50 },
    });

    expect(answerDraftStream.clear).not.toHaveBeenCalled();
    expect(answerDraftStream.update).toHaveBeenCalledWith("Photo");
    expectDeliverRepliesParams({ mediaMaxBytes });
    expectDeliveredReply(0, { text: undefined, mediaUrl: "https://example.com/a.png" });
  });

  it("sends standalone MEDIA directive final replies as media", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "MEDIA:/tmp/reply-image.png" }, { kind: "final" });
      return { queuedFinal: true };
    });

    await dispatchWithContext({ context: createContext() });

    expect(answerDraftStream.update).not.toHaveBeenCalledWith("MEDIA:/tmp/reply-image.png");
    expectDeliveredReply(0, {
      text: "",
      mediaUrl: "/tmp/reply-image.png",
      mediaUrls: ["/tmp/reply-image.png"],
    });
  });

  it("attaches interactive buttons to streamed text when late media arrives", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "Photo" });
        await dispatcherOptions.deliver(
          {
            text: "Photo",
            mediaUrl: "https://example.com/a.png",
            interactive: {
              blocks: [{ type: "buttons", buttons: [{ label: "OK", value: "ok" }] }],
            },
          },
          { kind: "final" },
        );
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({ context: createContext() });

    expect(answerDraftStream.update).toHaveBeenCalledWith("Photo");
    expectRecordFields(mockCallArg(editMessageTelegram, 0, 3), {
      buttons: [[{ text: "OK", callback_data: "ok" }]],
    });
    expectDeliveredReply(0, { text: undefined, mediaUrl: "https://example.com/a.png" });
  });

  it("shows Telegram progress drafts immediately for explicit tool starts", async () => {
    const draftStream = createSequencedDraftStream(2001);
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      await replyOptions?.onReplyStart?.();
      await replyOptions?.onAssistantMessageStart?.();
      await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      return { queuedFinal: false };
    });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "progress",
      telegramCfg: { streaming: { mode: "progress", progress: { label: "Shelling" } } },
    });

    expect(draftStream.updatePreview).toHaveBeenCalledWith(
      telegramProgressPreview("Shelling\n\n🛠️ Exec", "<b>Shelling</b>\n<b>🛠️ Exec</b>"),
    );
    expect(draftStream.flush).toHaveBeenCalled();
  });

  it("renders command status without command output in Telegram progress draft previews", async () => {
    const draftStream = createSequencedDraftStream(2001);
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      await replyOptions?.onReplyStart?.();
      await replyOptions?.onAssistantMessageStart?.();
      await replyOptions?.onToolStart?.({
        name: "exec",
        phase: "start",
        toolCallId: "exec-1",
        args: { command: "false" },
      });
      await replyOptions?.onCommandOutput?.({
        phase: "end",
        title: "command false",
        name: "exec",
        toolCallId: "exec-1",
        output: "No such file or directory",
        exitCode: 2,
      });
      return { queuedFinal: false };
    });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "progress",
      telegramCfg: {
        streaming: {
          mode: "progress",
          progress: { label: "Shelling", commandText: "raw" },
        },
      },
    });

    expect(draftStream.updatePreview).toHaveBeenLastCalledWith(
      telegramProgressPreview(
        "Shelling\n\n🛠️ exit 2; command false",
        "<b>Shelling</b>\n<b>🛠️ Exec</b> <code>command false</code> <i>exit 2</i>",
      ),
    );
  });

  it("hides command titles in Telegram status-only progress draft previews", async () => {
    const draftStream = createSequencedDraftStream(2001);
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      await replyOptions?.onReplyStart?.();
      await replyOptions?.onAssistantMessageStart?.();
      await replyOptions?.onToolStart?.({
        name: "exec",
        phase: "start",
        toolCallId: "exec-1",
        args: { command: "curl -H 'Authorization: token' https://example.test" },
      });
      await replyOptions?.onCommandOutput?.({
        phase: "end",
        title: "curl -H 'Authorization: token' https://example.test",
        name: "exec",
        toolCallId: "exec-1",
        output: "secret response",
        exitCode: 2,
      });
      return { queuedFinal: false };
    });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "progress",
      telegramCfg: {
        streaming: {
          mode: "progress",
          progress: { label: "Shelling", commandText: "status" },
        },
      },
    });

    expect(draftStream.updatePreview).toHaveBeenLastCalledWith(
      telegramProgressPreview(
        "Shelling\n\n🛠️ exit 2",
        "<b>Shelling</b>\n<b>🛠️ Exec</b> <code>exit 2</code>",
      ),
    );
  });

  it("composes streamed reasoning with tool progress in Telegram progress drafts", async () => {
    const draftStream = createSequencedDraftStream(2001);
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      await replyOptions?.onReplyStart?.();
      await replyOptions?.onAssistantMessageStart?.();
      await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await replyOptions?.onReasoningStream?.({ text: "<think>Checking files</think>" });
      return { queuedFinal: false };
    });

    await dispatchWithContext({
      context: createReasoningStreamContext(),
      streamMode: "progress",
      telegramCfg: { streaming: { mode: "progress", progress: { label: "Shelling" } } },
    });

    expect(createTelegramDraftStream).toHaveBeenCalledTimes(1);
    expect(draftStream.updatePreview).toHaveBeenCalledWith(
      telegramProgressPreview(
        "Shelling\n\n🛠️ Exec\n🧠 Checking files",
        "<b>Shelling</b>\n<b>🛠️ Exec</b>\n🧠 <i>Checking files</i>",
      ),
    );
  });

  it("renders CLI thinking token progress in the Telegram progress draft", async () => {
    const draftStream = createSequencedDraftStream(2001);
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onReplyStart?.();
        await replyOptions?.onAssistantMessageStart?.();
        await replyOptions?.onReasoningProgress?.({ progressTokens: 50 });
        await replyOptions?.onReasoningProgress?.({ progressTokens: 200 });
        await dispatcherOptions.deliver({ text: "Done" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context: createContext(),
      streamMode: "progress",
      telegramCfg: { streaming: { mode: "progress", progress: { label: "Shelling" } } },
    });

    expect(createTelegramDraftStream).toHaveBeenCalledTimes(1);
    expect(draftStream.updatePreview).toHaveBeenLastCalledWith(
      telegramProgressPreview(
        "Shelling\n\n🧠 Thinking… (~200 tokens)",
        "<b>Shelling</b>\n<b>🧠 Thinking… (~200 tokens)</b>",
      ),
    );
    expectWindowCollapsedTo(draftStream, "🧠 1 thought · ⏱️ 1s");
    expectDeliveredReply(0, { text: "Done" });
  });

  it("renders model markdown in streamed reasoning and commentary lanes", async () => {
    const draftStream = createSequencedDraftStream(2001);
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      await replyOptions?.onReplyStart?.();
      await replyOptions?.onAssistantMessageStart?.();
      await replyOptions?.onReasoningStream?.({ text: "<think>Running `sleep 4`</think>" });
      await replyOptions?.onItemEvent?.({
        kind: "preamble",
        itemId: "c1",
        progressText: "**Reading AGENTS.md**",
      });
      return { queuedFinal: false };
    });

    await dispatchWithContext({
      context: createReasoningStreamContext(),
      streamMode: "progress",
      telegramCfg: {
        streaming: { mode: "progress", progress: { label: "Shelling", commentary: true } },
      },
    });

    const lastPreview = draftStream.updatePreview.mock.calls.at(-1)?.[0];
    expect(lastPreview?.parseMode).toBe("HTML");
    // Reasoning stays 🧠 italic with inline code rendered (not a raw backtick).
    expect(lastPreview?.text).toContain("🧠 <i>Running <code>sleep 4</code></i>");
    // Commentary renders the model's bold (not raw `**`), distinct from reasoning.
    expect(lastPreview?.text).toContain("💬 <b>Reading <code>AGENTS.md</code></b>");
    expect(lastPreview?.text).not.toContain("**");
    expect(lastPreview?.text).not.toContain("`sleep");
  });

  it("keeps clipped long reasoning lines italic behind the 🧠 marker", async () => {
    const draftStream = createSequencedDraftStream(2001);
    createTelegramDraftStream.mockReturnValue(draftStream);
    // Real reasoning routinely exceeds the progress clip limit; truncation must
    // clip inside the `_…_` wrapper, not chop the closing underscore (which
    // silently degrades the lane to plain text with a leaked underscore).
    const longThought = "The user wants me to think carefully and run several steps. ".repeat(8);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      await replyOptions?.onReplyStart?.();
      await replyOptions?.onAssistantMessageStart?.();
      await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await replyOptions?.onReasoningStream?.({ text: `<think>${longThought}</think>` });
      return { queuedFinal: false };
    });

    await dispatchWithContext({
      context: createReasoningStreamContext(),
      streamMode: "progress",
      telegramCfg: {
        streaming: { mode: "progress", progress: { label: "Shelling", maxLineChars: 300 } },
      },
    });

    const lastPreview = draftStream.updatePreview.mock.calls.at(-1)?.[0];
    expect(lastPreview?.parseMode).toBe("HTML");
    expect(lastPreview?.text).toContain("🧠 <i>The user wants me to think carefully");
    expect(lastPreview?.text).toMatch(/…<\/i>/u);
    expect(lastPreview?.text).not.toContain("_");
  });

  it("keeps multi-line commentary markdown parse_mode-safe in progress drafts", async () => {
    const draftStream = createSequencedDraftStream(2001);
    createTelegramDraftStream.mockReturnValue(draftStream);
    // Models separate narration blocks with `\n\n---\n\n`; as block markdown that
    // turns the paragraph above into a setext <h2> heading, which Telegram's
    // parse_mode=HTML rejects — dropping the ENTIRE preview (all lanes) to
    // unformatted plain text. Lane lines must render inline-safe HTML only.
    const commentary =
      "Planning: three sequential steps with a file read in between.\n\n---\n\n**Step 1:** Run `sleep 6 && date`";
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      await replyOptions?.onReplyStart?.();
      await replyOptions?.onAssistantMessageStart?.();
      await replyOptions?.onReasoningStream?.({ text: "<think>Planning the steps</think>" });
      await replyOptions?.onItemEvent?.({
        kind: "preamble",
        itemId: "c1",
        progressText: commentary,
      });
      return { queuedFinal: false };
    });

    await dispatchWithContext({
      context: createReasoningStreamContext(),
      streamMode: "progress",
      telegramCfg: {
        streaming: { mode: "progress", progress: { label: "Shelling", commentary: true } },
      },
    });

    const lastPreview = draftStream.updatePreview.mock.calls.at(-1)?.[0];
    expect(lastPreview?.parseMode).toBe("HTML");
    // Reasoning lane still italic; commentary keeps its line structure (each
    // line converted separately, so the `---` renders as a divider line instead
    // of turning the paragraph above it into a setext <h2>).
    expect(lastPreview?.text).toContain("🧠 <i>Planning the steps</i>");
    expect(lastPreview?.text).toContain(
      "💬 Planning: three sequential steps with a file read in between.<br>───<br><b>Step 1:</b> Run <code>sleep 6 &amp;&amp; date</code>",
    );
    // No rich-only block HTML that Telegram's parse_mode=HTML would reject.
    expect(lastPreview?.text).not.toMatch(/<(h[1-6]|hr|ul|ol|li|p|div)\b/u);
  });

  it("renders configured Telegram commentary progress from preamble item events", async () => {
    const draftStream = createSequencedDraftStream(2001);
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      await replyOptions?.onReplyStart?.();
      await replyOptions?.onItemEvent?.({
        kind: "preamble",
        itemId: "preamble-1",
        progressText: "Checking recent context",
      });
      return { queuedFinal: false };
    });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "progress",
      telegramCfg: {
        streaming: {
          mode: "progress",
          progress: { label: "Shelling", commentary: true },
        },
      },
    });

    expect(draftStream.updatePreview).toHaveBeenCalledWith(
      telegramProgressPreview(
        "Shelling\n\n💬 Checking recent context",
        "<b>Shelling</b>\n💬 Checking recent context",
      ),
    );
  });

  it("suppresses Telegram preamble progress when commentary is disabled", async () => {
    const draftStream = createSequencedDraftStream(2001);
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      await replyOptions?.onReplyStart?.();
      await replyOptions?.onItemEvent?.({
        kind: "preamble",
        itemId: "preamble-1",
        progressText: "Checking recent context",
      });
      return { queuedFinal: false };
    });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "progress",
      telegramCfg: {
        streaming: {
          mode: "progress",
          progress: { label: "Shelling" },
        },
      },
    });

    expect(
      draftStream.updatePreview.mock.calls.every(
        ([preview]) => !preview.text.includes("Checking recent"),
      ),
    ).toBe(true);
  });

  it("keeps the progress draft label when tool progress lines are hidden", async () => {
    const draftStream = createSequencedDraftStream(2001);
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      await replyOptions?.onReplyStart?.();
      await replyOptions?.onAssistantMessageStart?.();
      await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      return { queuedFinal: false };
    });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "progress",
      telegramCfg: {
        streaming: {
          mode: "progress",
          progress: { label: "Shelling", toolProgress: false },
        },
      },
    });

    expect(draftStream.updatePreview).toHaveBeenCalledWith(
      telegramProgressPreview("Shelling", "<b>Shelling</b>"),
    );
    expect(draftStream.flush).toHaveBeenCalled();
  });

  it("keeps streamed reasoning visible when tool progress lines are hidden", async () => {
    const draftStream = createSequencedDraftStream(2001);
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      await replyOptions?.onReplyStart?.();
      await replyOptions?.onAssistantMessageStart?.();
      await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await replyOptions?.onReasoningStream?.({ text: "<think>Checking files</think>" });
      return { queuedFinal: false };
    });

    await dispatchWithContext({
      context: createReasoningStreamContext(),
      streamMode: "progress",
      telegramCfg: {
        streaming: {
          mode: "progress",
          progress: { label: "Shelling", toolProgress: false },
        },
      },
    });

    expect(draftStream.updatePreview).toHaveBeenCalledWith(
      telegramProgressPreview(
        "Shelling\n\n🧠 Checking files",
        "<b>Shelling</b>\n🧠 <i>Checking files</i>",
      ),
    );
  });

  it.each([{ label: false }, { label: "Shelling", maxLines: 1 }] as const)(
    "does not duplicate Telegram progress HTML rows without a visible label",
    async (progress) => {
      const draftStream = createSequencedDraftStream(2001);
      createTelegramDraftStream.mockReturnValue(draftStream);
      dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
        await replyOptions?.onReplyStart?.();
        await replyOptions?.onAssistantMessageStart?.();
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        return { queuedFinal: false };
      });

      await dispatchWithContext({
        context: createContext(),
        streamMode: "progress",
        telegramCfg: {
          streaming: {
            mode: "progress",
            progress,
          },
        },
      });

      expect(draftStream.updatePreview).toHaveBeenCalledWith(
        telegramProgressPreview("🛠️ Exec", "<b>🛠️ Exec</b>"),
      );
    },
  );

  it("keeps progress draft labels static while the draft is active", async () => {
    const draftStream = createSequencedDraftStream(2001);
    createTelegramDraftStream.mockReturnValue(draftStream);
    let finishRun: (() => void) | undefined;
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      await replyOptions?.onReplyStart?.();
      await replyOptions?.onAssistantMessageStart?.();
      await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await new Promise<void>((resolve) => {
        finishRun = resolve;
      });
      return { queuedFinal: false };
    });

    const run = dispatchWithContext({
      context: createContext(),
      streamMode: "progress",
      telegramCfg: {
        streaming: {
          mode: "progress",
          progress: { label: "Working", toolProgress: false },
        },
      },
    });

    await vi.waitFor(() =>
      expect(draftStream.updatePreview).toHaveBeenCalledWith(
        telegramProgressPreview("Working", "<b>Working</b>"),
      ),
    );
    expect(draftStream.updatePreview).not.toHaveBeenCalledWith({ text: "Working." });
    expect(draftStream.updatePreview).not.toHaveBeenCalledWith({ text: "Working.." });
    expect(draftStream.updatePreview).not.toHaveBeenCalledWith({ text: "Working..." });
    finishRun?.();
    await run;
  });

  it("renders Telegram progress drafts before slow status reactions resolve", async () => {
    const draftStream = createSequencedDraftStream(2001);
    createTelegramDraftStream.mockReturnValue(draftStream);
    let releaseSetTool: (() => void) | undefined;
    const statusReactionController = createStatusReactionController();
    statusReactionController.setTool.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseSetTool = resolve;
        }),
    );
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      const pendingToolStart = replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await Promise.resolve();
      await Promise.resolve();
      const updateBeforeStatusReaction = draftStream.updatePreview.mock.calls.at(-1)?.[0]?.text;
      releaseSetTool?.();
      await pendingToolStart;
      expect(updateBeforeStatusReaction).toBe("<b>Shelling</b><br><b>🛠️ Exec</b>");
      return { queuedFinal: false };
    });

    await dispatchWithContext({
      context: createContext({
        statusReactionController: statusReactionController as never,
      }),
      streamMode: "progress",
      telegramCfg: { streaming: { mode: "progress", progress: { label: "Shelling" } } },
    });

    expect(statusReactionController.setTool).toHaveBeenCalledWith("exec");
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

    expect(draftStream.updatePreview).toHaveBeenCalledWith(
      telegramProgressPreview(
        "Shelling\n\n🔎 Web Search: docs lookup\n• tests passed",
        "<b>Shelling</b>\n<b>🔎 Web Search</b> <code>docs lookup</code>\n<b>Update</b> <code>tests passed</code>",
      ),
    );
    // A tool-progress-only window with nothing to summarize is torn down via the
    // deferred-delete reposition (new content first, delete later), not a bare
    // immediate clear/delete or forceNewMessage.
    expect(draftStream.rotateToNewMessageDeferringDelete).toHaveBeenCalledTimes(1);
    expect(draftStream.forceNewMessage).not.toHaveBeenCalled();
    expect(draftStream.clear).not.toHaveBeenCalled();
    expectDeliveredReply(0, { text: "Final after tool" });
    expect(editMessageTelegram).not.toHaveBeenCalled();
  });

  it("falls back to normal send for error payloads and clears the pending stream", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Boom", isError: true }, { kind: "final" });
      return { queuedFinal: true };
    });

    await dispatchWithContext({ context: createContext() });

    expect(answerDraftStream.clear).toHaveBeenCalled();
    expectDeliveredReply(0, { text: "Boom" });
  });

  it("suppresses failed tool payloads after the final reply", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Final answer" }, { kind: "final" });
      await dispatcherOptions.deliver(
        { text: "Tool failed after final", isError: true },
        { kind: "tool" },
      );
      return { queuedFinal: true };
    });

    await dispatchWithContext({ context: createContext(), streamMode: "off" });

    expect(deliverReplies).toHaveBeenCalledTimes(1);
    expectDeliveredReply(0, { text: "Final answer" });
  });

  it("preserves final error warnings after the final reply", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Final answer" }, { kind: "final" });
      await dispatcherOptions.deliver({ text: "Write failed", isError: true }, { kind: "final" });
      return { queuedFinal: true };
    });

    await dispatchWithContext({ context: createContext(), streamMode: "off" });

    expect(deliverReplies).toHaveBeenCalledTimes(2);
    expectDeliveredReply(0, { text: "Final answer" });
    expectDeliveredReply(0, { text: "Write failed", isError: true }, 1);
  });

  it("suppresses non-terminal final error warnings after the final reply", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Final answer" }, { kind: "final" });
      await dispatcherOptions.deliver(
        setReplyPayloadMetadata(
          { text: "Post-processing failed", isError: true },
          { nonTerminalToolErrorWarning: true },
        ),
        { kind: "final" },
      );
      return { queuedFinal: true };
    });

    await dispatchWithContext({ context: createContext(), streamMode: "off" });

    expect(deliverReplies).toHaveBeenCalledTimes(1);
    expectDeliveredReply(0, { text: "Final answer" });
  });

  it("preserves non-terminal final error warnings before any final reply is delivered", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        setReplyPayloadMetadata(
          { text: "Post-processing failed", isError: true },
          { nonTerminalToolErrorWarning: true },
        ),
        { kind: "final" },
      );
      return { queuedFinal: true };
    });

    await dispatchWithContext({ context: createContext(), streamMode: "off" });

    expect(deliverReplies).toHaveBeenCalledTimes(1);
    expectDeliveredReply(0, { text: "Post-processing failed", isError: true });
  });

  it("streams button-bearing text into the same message", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    const buttons = [[{ text: "OK", callback_data: "ok" }]];
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        { text: "Choose", channelData: { telegram: { buttons } } },
        { kind: "final" },
      );
      return { queuedFinal: true };
    });

    await dispatchWithContext({ context: createContext() });

    expect(answerDraftStream.update).toHaveBeenCalledWith("Choose");
    expect(mockCallArg(editMessageTelegram)).toBe(123);
    expect(mockCallArg(editMessageTelegram, 0, 1)).toBe(2001);
    expect(mockCallArg(editMessageTelegram, 0, 2)).toBe("Choose");
    expectRecordFields(mockCallArg(editMessageTelegram, 0, 3), { buttons });
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("streams interactive buttons into the same message", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        {
          text: "Choose",
          interactive: {
            blocks: [{ type: "buttons", buttons: [{ label: "OK", value: "ok" }] }],
          },
        },
        { kind: "final" },
      );
      return { queuedFinal: true };
    });

    await dispatchWithContext({ context: createContext() });

    expect(answerDraftStream.update).toHaveBeenCalledWith("Choose");
    expectRecordFields(mockCallArg(editMessageTelegram, 0, 3), {
      buttons: [[{ text: "OK", callback_data: "ok" }]],
    });
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("streams reasoning and answer text on separate lanes", async () => {
    const { answerDraftStream, reasoningDraftStream } = setupDraftStreams({
      answerMessageId: 2001,
      reasoningMessageId: 3001,
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onReasoningStream?.({ text: "<think>Thinking</think>" });
        await dispatcherOptions.deliver({ text: "Answer" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({ context: createReasoningStreamContext() });

    expect(reasoningDraftStream.update).toHaveBeenCalledWith("🧠 _Thinking_");
    expect(answerDraftStream.update).toHaveBeenCalledWith("Answer");
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("emits final hooks when a buffered answer flushes after reasoning delivery", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    loadSessionStore.mockReturnValue({
      s1: { reasoningLevel: "stream", sessionId: "reasoning-session" },
    });
    readLatestAssistantTextByIdentity.mockResolvedValue({
      id: "assistant-buffered-final",
      text: "Buffered answer",
      timestamp: Date.now() + 1_000,
    });
    deliverReplies
      .mockResolvedValueOnce({ delivered: false })
      .mockResolvedValueOnce({ delivered: true });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        { text: "<think>first attempt</think>", isReasoning: true },
        { kind: "block" },
      );
      await dispatcherOptions.deliver({ text: "Buffered answer" }, { kind: "final" });
      await dispatcherOptions.deliver(
        { text: "<think>second attempt</think>", isReasoning: true },
        { kind: "block" },
      );
      return { queuedFinal: true };
    });

    await dispatchWithContext({
      context: createContext({
        ctxPayload: { SessionKey: "s1" } as unknown as TelegramMessageContext["ctxPayload"],
      }),
    });

    expect(deliverReplies).toHaveBeenCalledTimes(2);
    expect(answerDraftStream.update).toHaveBeenCalledWith("Buffered answer");
    expectRecordFields(mockCallArg(emitInternalMessageSentHook), {
      content: "Buffered answer",
      messageId: 2001,
    });
    expectRecordFields(mockCallArg(recordOutboundMessageForPromptContext), {
      messageId: 2001,
      text: "Buffered answer",
      promptContextProjection: {
        transcriptMessageId: "assistant-buffered-final",
        partIndex: 0,
        finalPart: true,
      },
    });
    await vi.waitFor(() => expect(appendAssistantMirrorMessageByIdentity).toHaveBeenCalledOnce());
  });

  it("preserves forum topic message_thread_id across streamed reasoning and final answer", async () => {
    const { answerDraftStream, reasoningDraftStream } = setupDraftStreams({
      answerMessageId: 2001,
      reasoningMessageId: 3001,
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onReasoningStream?.({ text: "<think>Thinking</think>" });
        await dispatcherOptions.deliver({ text: "Answer" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({ context: createReasoningForumTopicContext() });

    expect(reasoningDraftStream.update).toHaveBeenCalledWith("🧠 _Thinking_");
    expect(answerDraftStream.update).toHaveBeenCalledWith("Answer");
    expect(answerDraftStream.stop).toHaveBeenCalled();
    expect(deliverReplies).not.toHaveBeenCalled();
    expectRecordFields(mockCallArg(emitInternalMessageSentHook), {
      content: "Answer",
      messageId: 2001,
    });
    expectRecordFields(mockCallArg(recordOutboundMessageForPromptContext), {
      chatId: "-100123",
      messageId: 2001,
      text: "Answer",
      messageThreadId: 88,
    });
    expectDraftStreamParams({ thread: { id: 88, scope: "forum" } });
    expectRecordFields(mockCallArg(createTelegramDraftStream, 1), {
      thread: { id: 88, scope: "forum" },
    });
  });

  it("replaces reasoning snapshots on the reasoning lane", async () => {
    const { reasoningDraftStream } = setupDraftStreams({
      answerMessageId: 2001,
      reasoningMessageId: 3001,
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      const onReasoningStream = replyOptions?.onReasoningStream as
        | ((payload: {
            text?: string;
            delta?: string;
            isReasoningSnapshot?: boolean;
          }) => Promise<void> | void)
        | undefined;
      await onReasoningStream?.({
        text: "<think>Checking</think>",
        delta: "Checking",
        isReasoningSnapshot: true,
      });
      await onReasoningStream?.({
        text: "<think>Reading\n\nChecking</think>",
        delta: "Reading\n\nChecking",
        isReasoningSnapshot: true,
      });
      return { queuedFinal: false };
    });

    await dispatchWithContext({ context: createReasoningStreamContext() });

    expect(reasoningDraftStream.update).toHaveBeenLastCalledWith("🧠 _Reading_\n\n_Checking_");
    const updates = reasoningDraftStream.update.mock.calls.map((call) => call[0]);
    expect(updates.join("\n")).not.toContain("CheckingReading");
  });

  it("repositions split reasoning before deleting the prior preview", async () => {
    const answerDraftStream = createDraftStream(2001);
    const reasoningDraftStream = createSequencedDraftStream(3001);
    createTelegramDraftStream
      .mockImplementationOnce(() => answerDraftStream)
      .mockImplementationOnce(() => reasoningDraftStream);
    let replacementMessageId: number | undefined;
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      await replyOptions?.onReasoningStream?.({ text: "<think>First thought</think>" });
      await replyOptions?.onReasoningEnd?.();
      await replyOptions?.onReasoningStream?.({ text: "<think>Second thought</think>" });
      replacementMessageId = reasoningDraftStream.messageId();
      return { queuedFinal: false };
    });

    await dispatchWithContext({ context: createReasoningStreamContext() });

    expect(reasoningDraftStream.update).toHaveBeenNthCalledWith(1, "🧠 _First thought_");
    expect(reasoningDraftStream.update).toHaveBeenNthCalledWith(2, "🧠 _Second thought_");
    expect(reasoningDraftStream.rotateToNewMessageDeferringDelete).toHaveBeenCalledTimes(1);
    expect(reasoningDraftStream.forceNewMessage).not.toHaveBeenCalled();
    expect(reasoningDraftStream.clear).toHaveBeenCalledTimes(1);
    expect(
      reasoningDraftStream.rotateToNewMessageDeferringDelete.mock.invocationCallOrder[0],
    ).toBeLessThan(reasoningDraftStream.update.mock.invocationCallOrder[1]);
    expect(reasoningDraftStream.update.mock.invocationCallOrder[1]).toBeLessThan(
      reasoningDraftStream.clear.mock.invocationCallOrder[0],
    );
    expect(replacementMessageId).toBe(3002);
  });

  it("streams reasoning from configured defaults", async () => {
    const { answerDraftStream, reasoningDraftStream } = setupDraftStreams({
      answerMessageId: 2001,
      reasoningMessageId: 3001,
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onReasoningStream?.({ text: "<think>Thinking</think>" });
        await dispatcherOptions.deliver({ text: "Answer" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context: createReasoningDefaultContext(),
      cfg: {
        agents: {
          defaults: { reasoningDefault: "off" },
          list: [{ id: "Ops", reasoningDefault: "stream" }],
        },
      },
    });

    expect(reasoningDraftStream.update).toHaveBeenCalledWith("🧠 _Thinking_");
    expect(answerDraftStream.update).toHaveBeenCalledWith("Answer");
  });

  it("keeps reasoning draft labels static while the reasoning lane is active", async () => {
    const { reasoningDraftStream } = setupDraftStreams({
      answerMessageId: 2001,
      reasoningMessageId: 3001,
    });
    let finishRun: (() => void) | undefined;
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      await replyOptions?.onReasoningStream?.({ text: "<think>Thinking</think>" });
      await new Promise<void>((resolve) => {
        finishRun = resolve;
      });
      return { queuedFinal: false };
    });

    const run = dispatchWithContext({ context: createReasoningStreamContext() });

    await vi.waitFor(() =>
      expect(reasoningDraftStream.update).toHaveBeenCalledWith("🧠 _Thinking_"),
    );
    // Durable thoughts render behind the 🧠 marker; the literal "Thinking"
    // header (and its streaming dot-variants) must never leak back into a lane.
    expect(reasoningDraftStream.update).not.toHaveBeenCalledWith("Thinking\n\n_Thinking_");
    expect(reasoningDraftStream.update).not.toHaveBeenCalledWith("Thinking.\n\n_Thinking_");
    expect(reasoningDraftStream.update).not.toHaveBeenCalledWith("Thinking...\n\n_Thinking_");
    finishRun?.();
    await run;
  });

  it("keeps shared durable reasoning payloads disabled when reasoning is off", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockResolvedValue({
      queuedFinal: false,
      counts: { block: 0, final: 0, tool: 0 },
    });

    await dispatchWithContext({ context: createContext() });

    const dispatchParams = mockCallArg(dispatchReplyWithBufferedBlockDispatcher) as {
      replyOptions?: { reasoningPayloadsEnabled?: boolean };
    };
    expect(dispatchParams.replyOptions?.reasoningPayloadsEnabled).toBe(false);
  });

  it("opts shared dispatch into durable reasoning payload delivery when reasoning streams", async () => {
    setupDraftStreams({
      answerMessageId: 2001,
      reasoningMessageId: 3001,
    });
    dispatchReplyWithBufferedBlockDispatcher.mockResolvedValue({
      queuedFinal: false,
      counts: { block: 0, final: 0, tool: 0 },
    });

    await dispatchWithContext({ context: createReasoningStreamContext() });

    const dispatchParams = mockCallArg(dispatchReplyWithBufferedBlockDispatcher) as {
      replyOptions?: { reasoningPayloadsEnabled?: boolean };
    };
    expect(dispatchParams.replyOptions?.reasoningPayloadsEnabled).toBe(true);
  });

  it("keeps shared durable reasoning payloads disabled in progress stream mode", async () => {
    setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockResolvedValue({
      queuedFinal: false,
      counts: { block: 0, final: 0, tool: 0 },
    });

    await dispatchWithContext({
      context: createReasoningStreamContext(),
      streamMode: "progress",
    });

    const dispatchParams = mockCallArg(dispatchReplyWithBufferedBlockDispatcher) as {
      replyOptions?: { reasoningPayloadsEnabled?: boolean };
    };
    expect(dispatchParams.replyOptions?.reasoningPayloadsEnabled).toBe(false);
  });

  it("suppresses typed reasoning-only finals without raw text fallback", async () => {
    setupDraftStreams({ answerMessageId: 2001, reasoningMessageId: 3001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        { text: "<think>hidden</think>", isReasoning: true },
        { kind: "final" },
      );
      return { queuedFinal: true };
    });

    await dispatchWithContext({ context: createContext() });

    expect(deliverReplies).not.toHaveBeenCalled();
    expect(editMessageTelegram).not.toHaveBeenCalled();
  });

  it("routes typed reasoning-only finals to the reasoning lane when reasoning streams", async () => {
    const { reasoningDraftStream } = setupDraftStreams({
      answerMessageId: 2001,
      reasoningMessageId: 3001,
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        { text: "<think>hidden</think>", isReasoning: true },
        { kind: "final" },
      );
      return { queuedFinal: true };
    });

    await dispatchWithContext({ context: createReasoningStreamContext() });

    expect(reasoningDraftStream.update).toHaveBeenCalledWith("🧠 _hidden_");
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("routes typed reasoning-only finals to durable delivery when reasoning is persistent", async () => {
    loadSessionStore.mockReturnValue({
      s1: { reasoningLevel: "on" },
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        { text: "<think>hidden</think>", isReasoning: true },
        { kind: "final" },
      );
      return { queuedFinal: true };
    });

    await dispatchWithContext({
      context: createContext({
        ctxPayload: { SessionKey: "s1" } as unknown as TelegramMessageContext["ctxPayload"],
      }),
    });

    const delivered = expectDeliveredReply(0, { text: "🧠 _hidden_" });
    expect(delivered).not.toHaveProperty("isReasoning");
  });

  it("does not persist typed reasoning-only finals in progress stream mode", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        { text: "<think>hidden</think>", isReasoning: true },
        { kind: "final" },
      );
      return { queuedFinal: true };
    });

    await dispatchWithContext({
      context: createReasoningStreamContext(),
      streamMode: "progress",
    });

    expect(deliverReplies).not.toHaveBeenCalled();
    expect(answerDraftStream.update).not.toHaveBeenCalled();
  });

  it("keeps unflagged angle-bracket text visible on the answer lane", async () => {
    const { answerDraftStream } = setupDraftStreams({
      answerMessageId: 2001,
      reasoningMessageId: 3001,
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        { text: "Before <think>literal tag text after" },
        { kind: "final" },
      );
      return { queuedFinal: true };
    });

    await dispatchWithContext({ context: createContext() });

    expect(answerDraftStream.update).toHaveBeenCalledWith("Before <think>literal tag text after");
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("does not add silent fallback when source delivery is message-tool-only", async () => {
    setupDraftStreams({ answerMessageId: 2001, reasoningMessageId: 3001 });
    dispatchReplyWithBufferedBlockDispatcher.mockResolvedValue({
      queuedFinal: false,
      counts: { block: 0, final: 0, tool: 0 },
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
              group: "allow",
              internal: "allow",
            },
          },
        },
      },
    });

    expect(deliverReplies).not.toHaveBeenCalled();
    expect(editMessageTelegram).not.toHaveBeenCalled();
    expect(sendMessageTelegram).not.toHaveBeenCalled();
  });

  it("runs ambient room events as tool-only invisible turns", async () => {
    const historyKey = "telegram:group:-100123";
    const groupHistories = new Map([
      [historyKey, [{ sender: "Alice", body: "side chatter", timestamp: 1 }]],
    ]);
    const statusReactionController = createStatusReactionController();
    loadSessionStore.mockReturnValue({
      "agent:main:telegram:group:-100123": { reasoningLevel: "stream" },
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      await replyOptions?.onReasoningStream?.({ text: "<think>ambient reasoning</think>" });
      await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await replyOptions?.onCompactionStart?.();
      await replyOptions?.onCompactionEnd?.();
      return {
        queuedFinal: false,
        counts: { block: 0, final: 0, tool: 0 },
        sourceReplyDeliveryMode: "message_tool_only",
      };
    });

    await dispatchWithContext({
      context: createContext({
        statusReactionController: statusReactionController as never,
        ctxPayload: {
          InboundEventKind: "room_event",
          SessionKey: "agent:main:telegram:group:-100123",
          ChatType: "group",
          MessageSid: "99",
          RawBody: "ambient",
          BodyForAgent: "ambient",
          CommandBody: "ambient",
        } as unknown as TelegramMessageContext["ctxPayload"],
        msg: {
          chat: { id: -100123, type: "supergroup" },
          message_id: 99,
        } as unknown as TelegramMessageContext["msg"],
        chatId: -100123,
        isGroup: true,
        historyKey,
        historyLimit: 10,
        groupHistories,
        threadSpec: { id: undefined, scope: "none" },
      }),
      streamMode: "partial",
    });

    const dispatchParams = mockCallArg(dispatchReplyWithBufferedBlockDispatcher) as {
      replyOptions?: {
        sourceReplyDeliveryMode?: string;
        suppressTyping?: boolean;
        allowProgressCallbacksWhenSourceDeliverySuppressed?: boolean;
        onReasoningStream?: unknown;
        onCompactionStart?: unknown;
        onCompactionEnd?: unknown;
      };
    };
    expect(dispatchParams.replyOptions?.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(dispatchParams.replyOptions?.suppressTyping).toBe(true);
    expect(dispatchParams.replyOptions?.allowProgressCallbacksWhenSourceDeliverySuppressed).toBe(
      false,
    );
    expect(dispatchParams.replyOptions?.onReasoningStream).toBeUndefined();
    expect(dispatchParams.replyOptions?.onCompactionStart).toBeUndefined();
    expect(dispatchParams.replyOptions?.onCompactionEnd).toBeUndefined();
    expect(createTelegramDraftStream).not.toHaveBeenCalled();
    expect(statusReactionController.setTool).not.toHaveBeenCalled();
    expect(statusReactionController.setCompacting).not.toHaveBeenCalled();
    expect(statusReactionController.setThinking).not.toHaveBeenCalled();
    expect(deliverReplies).not.toHaveBeenCalled();
    expect(groupHistories.get(historyKey)).toHaveLength(1);
  });

  it("keeps room-event history when a newer turn supersedes dispatch", async () => {
    const historyKey = "telegram:group:-100123";
    const groupHistories = new Map([
      [historyKey, [{ sender: "Alice", body: "lunch at two", timestamp: 1 }]],
    ]);
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let secondStarted: (() => void) | undefined;
    const secondStartGate = new Promise<void>((resolve) => {
      secondStarted = resolve;
    });
    dispatchReplyWithBufferedBlockDispatcher
      .mockImplementationOnce(async () => {
        await firstGate;
        return {
          queuedFinal: false,
          counts: { block: 0, final: 0, tool: 0 },
          sourceReplyDeliveryMode: "message_tool_only",
        };
      })
      .mockImplementationOnce(async () => {
        secondStarted?.();
        return {
          queuedFinal: false,
          counts: { block: 0, final: 0, tool: 0 },
          sourceReplyDeliveryMode: "message_tool_only",
        };
      });

    const createRoomContext = (messageId: number, body: string) =>
      createContext({
        ctxPayload: {
          InboundEventKind: "room_event",
          SessionKey: "agent:main:telegram:group:-100123",
          ChatType: "group",
          MessageSid: String(messageId),
          RawBody: body,
          BodyForAgent: body,
          CommandBody: body,
        } as unknown as TelegramMessageContext["ctxPayload"],
        msg: {
          chat: { id: -100123, type: "supergroup" },
          message_id: messageId,
        } as unknown as TelegramMessageContext["msg"],
        chatId: -100123,
        isGroup: true,
        historyKey,
        historyLimit: 10,
        groupHistories,
        threadSpec: { id: undefined, scope: "none" },
      });

    const firstPromise = dispatchWithContext({
      context: createRoomContext(99, "ambient one"),
      streamMode: "partial",
    });
    const secondPromise = dispatchWithContext({
      context: createRoomContext(100, "ambient two"),
      streamMode: "partial",
    });

    await secondStartGate;
    releaseFirst?.();
    await Promise.all([firstPromise, secondPromise]);

    expect(groupHistories.get(historyKey)).toHaveLength(1);
  });

  it("keeps delivered room-event history when a newer turn supersedes dispatch", async () => {
    const historyKey = "telegram:group:-100123";
    const groupHistories = new Map([
      [historyKey, [{ sender: "Alice", body: "lunch at two", timestamp: 1 }]],
    ]);
    let firstStarted: (() => void) | undefined;
    const firstStartGate = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let secondStarted: (() => void) | undefined;
    const secondStartGate = new Promise<void>((resolve) => {
      secondStarted = resolve;
    });
    dispatchReplyWithBufferedBlockDispatcher
      .mockImplementationOnce(async () => {
        firstStarted?.();
        await firstGate;
        return {
          queuedFinal: false,
          counts: { block: 0, final: 0, tool: 0 },
          sourceReplyDeliveryMode: "message_tool_only",
        };
      })
      .mockImplementationOnce(async () => {
        secondStarted?.();
        return {
          queuedFinal: false,
          counts: { block: 0, final: 0, tool: 0 },
          sourceReplyDeliveryMode: "message_tool_only",
        };
      });

    const createRoomContext = (messageId: number, body: string) =>
      createContext({
        ctxPayload: {
          InboundEventKind: "room_event",
          SessionKey: "agent:main:telegram:group:-100123",
          ChatType: "group",
          MessageSid: String(messageId),
          RawBody: body,
          BodyForAgent: body,
          CommandBody: body,
        } as unknown as TelegramMessageContext["ctxPayload"],
        msg: {
          chat: { id: -100123, type: "supergroup" },
          message_id: messageId,
        } as unknown as TelegramMessageContext["msg"],
        chatId: -100123,
        isGroup: true,
        historyKey,
        historyLimit: 10,
        groupHistories,
        threadSpec: { id: undefined, scope: "none" },
      });

    const firstPromise = dispatchWithContext({
      context: createRoomContext(99, "ambient one"),
      streamMode: "partial",
    });
    await firstStartGate;
    notifyTelegramInboundEventOutboundSuccess({
      sessionKey: "agent:main:telegram:group:-100123",
      to: "telegram:-100123",
      inboundEventKind: "room_event",
    });
    const secondPromise = dispatchWithContext({
      context: createRoomContext(100, "ambient two"),
      streamMode: "partial",
    });

    await secondStartGate;
    releaseFirst?.();
    await Promise.all([firstPromise, secondPromise]);

    expect(groupHistories.get(historyKey)).toHaveLength(1);
  });

  it("keeps topic room-event history for a send to another topic", async () => {
    const historyKey = "telegram:group:-100123:topic:77";
    const groupHistories = new Map([
      [historyKey, [{ sender: "Alice", body: "topic 77 context", timestamp: 1 }]],
    ]);
    let firstStarted: (() => void) | undefined;
    const firstStartGate = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let secondStarted: (() => void) | undefined;
    const secondStartGate = new Promise<void>((resolve) => {
      secondStarted = resolve;
    });
    dispatchReplyWithBufferedBlockDispatcher
      .mockImplementationOnce(async () => {
        firstStarted?.();
        await firstGate;
        return {
          queuedFinal: false,
          counts: { block: 0, final: 0, tool: 0 },
          sourceReplyDeliveryMode: "message_tool_only",
        };
      })
      .mockImplementationOnce(async () => {
        secondStarted?.();
        return {
          queuedFinal: false,
          counts: { block: 0, final: 0, tool: 0 },
          sourceReplyDeliveryMode: "message_tool_only",
        };
      });

    const createRoomContext = (messageId: number, body: string) =>
      createContext({
        ctxPayload: {
          InboundEventKind: "room_event",
          SessionKey: "agent:main:telegram:group:-100123",
          ChatType: "group",
          MessageSid: String(messageId),
          RawBody: body,
          BodyForAgent: body,
          CommandBody: body,
        } as unknown as TelegramMessageContext["ctxPayload"],
        msg: {
          chat: { id: -100123, type: "supergroup", is_forum: true },
          message_id: messageId,
          message_thread_id: 77,
        } as unknown as TelegramMessageContext["msg"],
        chatId: -100123,
        isGroup: true,
        historyKey,
        historyLimit: 10,
        groupHistories,
        threadSpec: { id: 77, scope: "forum" },
      });

    const firstPromise = dispatchWithContext({
      context: createRoomContext(99, "ambient one"),
      streamMode: "partial",
    });
    await firstStartGate;
    notifyTelegramInboundEventOutboundSuccess({
      sessionKey: "agent:main:telegram:group:-100123",
      to: "telegram:group:-100123:topic:88",
      inboundEventKind: "room_event",
    });
    const secondPromise = dispatchWithContext({
      context: createRoomContext(100, "ambient two"),
      streamMode: "partial",
    });

    await secondStartGate;
    releaseFirst?.();
    await Promise.all([firstPromise, secondPromise]);

    expect(groupHistories.get(historyKey)).toHaveLength(1);
  });

  it("does not let room events supersede active user-request dispatch", async () => {
    const historyKey = "telegram:group:-100123";
    const groupHistories = new Map([[historyKey, []]]);
    let firstStarted: (() => void) | undefined;
    const firstStartGate = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let roomEventStarted: (() => void) | undefined;
    const roomEventStartGate = new Promise<void>((resolve) => {
      roomEventStarted = resolve;
    });
    dispatchReplyWithBufferedBlockDispatcher
      .mockImplementationOnce(async ({ dispatcherOptions }) => {
        firstStarted?.();
        await firstGate;
        await dispatcherOptions.deliver({ text: "visible request answer" }, { kind: "final" });
        return {
          queuedFinal: true,
          counts: { block: 0, final: 1, tool: 0 },
        };
      })
      .mockImplementationOnce(async () => {
        roomEventStarted?.();
        return {
          queuedFinal: false,
          counts: { block: 0, final: 0, tool: 0 },
          sourceReplyDeliveryMode: "message_tool_only",
        };
      });

    const createGroupContext = (
      kind: "user_request" | "room_event",
      messageId: number,
      body: string,
    ) =>
      createContext({
        ctxPayload: {
          InboundEventKind: kind,
          SessionKey: "agent:main:telegram:group:-100123",
          ChatType: "group",
          MessageSid: String(messageId),
          RawBody: body,
          BodyForAgent: body,
          CommandBody: body,
          CommandAuthorized: true,
        } as unknown as TelegramMessageContext["ctxPayload"],
        msg: {
          chat: { id: -100123, type: "supergroup" },
          message_id: messageId,
        } as unknown as TelegramMessageContext["msg"],
        chatId: -100123,
        isGroup: true,
        historyKey,
        historyLimit: 10,
        groupHistories,
        threadSpec: { id: undefined, scope: "none" },
      });

    const userRequestPromise = dispatchWithContext({
      context: createGroupContext("user_request", 99, "@bot answer this"),
      streamMode: "off",
    });
    await firstStartGate;
    const roomEventPromise = dispatchWithContext({
      context: createGroupContext("room_event", 100, "ambient chatter"),
      streamMode: "off",
    });
    await roomEventStartGate;
    releaseFirst?.();
    await Promise.all([userRequestPromise, roomEventPromise]);

    const deliveredTexts = deliverReplies.mock.calls.flatMap((call) =>
      ((call[0] as { replies?: Array<{ text?: string }> }).replies ?? []).map(
        (reply) => reply.text,
      ),
    );
    expect(deliveredTexts).toContain("visible request answer");
  });

  it("lets user requests supersede active room-event dispatch", async () => {
    const historyKey = "telegram:group:-100123";
    const groupHistories = new Map([[historyKey, []]]);
    let roomEventStarted: (() => void) | undefined;
    const roomEventStartGate = new Promise<void>((resolve) => {
      roomEventStarted = resolve;
    });
    let releaseRoomEvent: (() => void) | undefined;
    const roomEventGate = new Promise<void>((resolve) => {
      releaseRoomEvent = resolve;
    });
    let userRequestStarted: (() => void) | undefined;
    const userRequestStartGate = new Promise<void>((resolve) => {
      userRequestStarted = resolve;
    });
    let roomEventAbortSignal: AbortSignal | undefined;
    dispatchReplyWithBufferedBlockDispatcher
      .mockImplementationOnce(async ({ dispatcherOptions, replyOptions }) => {
        roomEventAbortSignal = replyOptions?.abortSignal;
        roomEventStarted?.();
        await roomEventGate;
        await dispatcherOptions.deliver({ text: "stale ambient answer" }, { kind: "final" });
        return {
          queuedFinal: true,
          counts: { block: 0, final: 1, tool: 0 },
          sourceReplyDeliveryMode: "message_tool_only",
        };
      })
      .mockImplementationOnce(async ({ dispatcherOptions }) => {
        userRequestStarted?.();
        await dispatcherOptions.deliver({ text: "fresh request answer" }, { kind: "final" });
        return {
          queuedFinal: true,
          counts: { block: 0, final: 1, tool: 0 },
        };
      });

    const createGroupContext = (
      kind: "user_request" | "room_event",
      messageId: number,
      body: string,
    ) =>
      createContext({
        ctxPayload: {
          InboundEventKind: kind,
          SessionKey: "agent:main:telegram:group:-100123",
          ChatType: "group",
          MessageSid: String(messageId),
          RawBody: body,
          BodyForAgent: body,
          CommandBody: body,
          CommandAuthorized: true,
        } as unknown as TelegramMessageContext["ctxPayload"],
        msg: {
          chat: { id: -100123, type: "supergroup" },
          message_id: messageId,
        } as unknown as TelegramMessageContext["msg"],
        chatId: -100123,
        isGroup: true,
        historyKey,
        historyLimit: 10,
        groupHistories,
        threadSpec: { id: undefined, scope: "none" },
      });

    const roomEventPromise = dispatchWithContext({
      context: createGroupContext("room_event", 99, "ambient chatter"),
      streamMode: "off",
    });
    await roomEventStartGate;
    const userRequestPromise = dispatchWithContext({
      context: createGroupContext("user_request", 100, "@bot answer now"),
      streamMode: "off",
    });
    await userRequestStartGate;
    expect(roomEventAbortSignal?.aborted).toBe(true);
    releaseRoomEvent?.();
    await Promise.all([roomEventPromise, userRequestPromise]);

    const deliveredTexts = deliverReplies.mock.calls.flatMap((call) =>
      ((call[0] as { replies?: Array<{ text?: string }> }).replies ?? []).map(
        (reply) => reply.text,
      ),
    );
    expect(deliveredTexts).toContain("fresh request answer");
    expect(deliveredTexts).not.toContain("stale ambient answer");
  });

  it("keeps newer group requests from aborting active same-session dispatch", async () => {
    const historyKey = "telegram:group:-100123";
    const groupHistories = new Map([[historyKey, []]]);
    let firstStarted: (() => void) | undefined;
    const firstStartGate = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let secondStarted: (() => void) | undefined;
    const secondStartGate = new Promise<void>((resolve) => {
      secondStarted = resolve;
    });
    let firstAbortSignal: AbortSignal | undefined;
    dispatchReplyWithBufferedBlockDispatcher
      .mockImplementationOnce(async ({ dispatcherOptions, replyOptions }) => {
        firstAbortSignal = replyOptions?.abortSignal;
        firstStarted?.();
        await firstGate;
        await dispatcherOptions.deliver({ text: "earlier group answer" }, { kind: "final" });
        return {
          queuedFinal: true,
          counts: { block: 0, final: 1, tool: 0 },
        };
      })
      .mockImplementationOnce(async ({ dispatcherOptions }) => {
        secondStarted?.();
        await dispatcherOptions.deliver({ text: "fresh group answer" }, { kind: "final" });
        return {
          queuedFinal: true,
          counts: { block: 0, final: 1, tool: 0 },
        };
      });
    deliverReplies.mockResolvedValue({ delivered: true });

    const createGroupContext = (messageId: number, body: string) =>
      createContext({
        ctxPayload: {
          SessionKey: "agent:main:telegram:group:-100123",
          ChatType: "group",
          MessageSid: String(messageId),
          RawBody: body,
          BodyForAgent: body,
          CommandBody: body,
          CommandAuthorized: true,
        } as unknown as TelegramMessageContext["ctxPayload"],
        msg: {
          chat: { id: -100123, type: "supergroup" },
          message_id: messageId,
        } as unknown as TelegramMessageContext["msg"],
        chatId: -100123,
        isGroup: true,
        historyKey,
        historyLimit: 10,
        groupHistories,
        threadSpec: { id: undefined, scope: "none" },
      });

    const firstPromise = dispatchWithContext({
      context: createGroupContext(99, "@bot first request"),
      streamMode: "off",
    });
    await firstStartGate;
    const secondPromise = dispatchWithContext({
      context: createGroupContext(100, "@bot second request"),
      streamMode: "off",
    });
    await secondStartGate;

    expect(firstAbortSignal?.aborted).toBe(false);
    releaseFirst?.();
    await Promise.all([firstPromise, secondPromise]);

    const deliveredTexts = deliverReplies.mock.calls.flatMap((call) =>
      ((call[0] as { replies?: Array<{ text?: string }> }).replies ?? []).map(
        (reply) => reply.text,
      ),
    );
    expect(deliveredTexts).toContain("fresh group answer");
    expect(deliveredTexts).toContain("earlier group answer");
  });

  it("keeps newer DM requests from aborting active same-session dispatch", async () => {
    let firstStarted: (() => void) | undefined;
    const firstStartGate = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let secondStarted: (() => void) | undefined;
    const secondStartGate = new Promise<void>((resolve) => {
      secondStarted = resolve;
    });
    let firstAbortSignal: AbortSignal | undefined;
    dispatchReplyWithBufferedBlockDispatcher
      .mockImplementationOnce(async ({ dispatcherOptions, replyOptions }) => {
        firstAbortSignal = replyOptions?.abortSignal;
        firstStarted?.();
        await firstGate;
        await dispatcherOptions.deliver({ text: "earlier DM answer" }, { kind: "final" });
        return {
          queuedFinal: true,
          counts: { block: 0, final: 1, tool: 0 },
        };
      })
      .mockImplementationOnce(async ({ dispatcherOptions }) => {
        secondStarted?.();
        await dispatcherOptions.deliver({ text: "fresh DM answer" }, { kind: "final" });
        return {
          queuedFinal: true,
          counts: { block: 0, final: 1, tool: 0 },
        };
      });
    deliverReplies.mockResolvedValue({ delivered: true });

    const createDirectContext = (messageId: number, body: string) =>
      createContext({
        ctxPayload: {
          SessionKey: "agent:main:main",
          ChatType: "direct",
          MessageSid: String(messageId),
          RawBody: body,
          BodyForAgent: body,
          CommandBody: body,
          CommandAuthorized: true,
        } as unknown as TelegramMessageContext["ctxPayload"],
        msg: {
          chat: { id: 123, type: "private" },
          message_id: messageId,
        } as unknown as TelegramMessageContext["msg"],
        chatId: 123,
        isGroup: false,
        historyKey: "telegram:123",
        historyLimit: 10,
        groupHistories: new Map(),
        threadSpec: { id: undefined, scope: "none" },
      });

    const firstPromise = dispatchWithContext({
      context: createDirectContext(99, "first request"),
      streamMode: "off",
    });
    await firstStartGate;
    const secondPromise = dispatchWithContext({
      context: createDirectContext(100, "second request"),
      streamMode: "off",
    });
    await secondStartGate;

    expect(firstAbortSignal?.aborted).toBe(false);
    releaseFirst?.();
    await Promise.all([firstPromise, secondPromise]);

    const deliveredTexts = deliverReplies.mock.calls.flatMap((call) =>
      ((call[0] as { replies?: Array<{ text?: string }> }).replies ?? []).map(
        (reply) => reply.text,
      ),
    );
    expect(deliveredTexts).toContain("fresh DM answer");
    expect(deliveredTexts).toContain("earlier DM answer");
  });

  it("keeps /btw side questions from aborting an active same-session dispatch", async () => {
    const historyKey = "telegram:group:-100123";
    const groupHistories = new Map([[historyKey, []]]);
    let firstStarted: (() => void) | undefined;
    const firstStartGate = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let sideStarted: (() => void) | undefined;
    const sideStartGate = new Promise<void>((resolve) => {
      sideStarted = resolve;
    });
    let releaseSide: (() => void) | undefined;
    const sideGate = new Promise<void>((resolve) => {
      releaseSide = resolve;
    });
    let firstAbortSignal: AbortSignal | undefined;
    let sideAbortSignal: AbortSignal | undefined;
    dispatchReplyWithBufferedBlockDispatcher
      .mockImplementationOnce(async ({ replyOptions }) => {
        firstAbortSignal = replyOptions?.abortSignal;
        firstStarted?.();
        await firstGate;
        return {
          queuedFinal: false,
          counts: { block: 0, final: 0, tool: 0 },
        };
      })
      .mockImplementationOnce(async ({ replyOptions }) => {
        sideAbortSignal = replyOptions?.abortSignal;
        sideStarted?.();
        await sideGate;
        return {
          queuedFinal: false,
          counts: { block: 0, final: 0, tool: 0 },
        };
      });

    const createGroupContext = (messageId: number, body: string) =>
      createContext({
        ctxPayload: {
          SessionKey: "agent:main:telegram:group:-100123",
          ChatType: "group",
          MessageSid: String(messageId),
          RawBody: body,
          BodyForAgent: body,
          CommandBody: body,
          CommandAuthorized: true,
        } as unknown as TelegramMessageContext["ctxPayload"],
        msg: {
          chat: { id: -100123, type: "supergroup" },
          message_id: messageId,
          text: body,
        } as unknown as TelegramMessageContext["msg"],
        chatId: -100123,
        isGroup: true,
        historyKey,
        historyLimit: 10,
        groupHistories,
        threadSpec: { id: undefined, scope: "none" },
      });

    const firstPromise = dispatchWithContext({
      context: createGroupContext(99, "@bot first request"),
      streamMode: "off",
    });
    await firstStartGate;
    const sidePromise = dispatchWithContext({
      context: createGroupContext(100, "/btw what changed?"),
      streamMode: "off",
    });
    await sideStartGate;

    expect(firstAbortSignal?.aborted).toBe(false);
    const { buildTelegramReplyFenceLaneKey, supersedeTelegramReplyFenceLane } =
      await import("./telegram-reply-fence.js");
    supersedeTelegramReplyFenceLane(
      buildTelegramReplyFenceLaneKey({
        accountId: "default",
        sequentialKey: "telegram:-100123:btw:100",
      }),
    );
    expect(sideAbortSignal?.aborted).toBe(true);
    expect(firstAbortSignal?.aborted).toBe(false);
    releaseSide?.();
    releaseFirst?.();
    await Promise.all([firstPromise, sidePromise]);
  });

  it("lets authorized /stop abort active non-interrupting side dispatch", async () => {
    const historyKey = "telegram:group:-100123";
    const groupHistories = new Map([[historyKey, []]]);
    let sideStarted: (() => void) | undefined;
    const sideStartGate = new Promise<void>((resolve) => {
      sideStarted = resolve;
    });
    let releaseSide: (() => void) | undefined;
    const sideGate = new Promise<void>((resolve) => {
      releaseSide = resolve;
    });
    let sideAbortSignal: AbortSignal | undefined;
    dispatchReplyWithBufferedBlockDispatcher.mockImplementationOnce(async ({ replyOptions }) => {
      sideAbortSignal = replyOptions?.abortSignal;
      sideStarted?.();
      await sideGate;
      return {
        queuedFinal: false,
        counts: { block: 0, final: 0, tool: 0 },
      };
    });
    deliverReplies.mockResolvedValue({ delivered: true });

    const createGroupContext = (messageId: number, body: string) =>
      createContext({
        ctxPayload: {
          SessionKey: "agent:main:telegram:group:-100123",
          ChatType: "group",
          MessageSid: String(messageId),
          RawBody: body,
          BodyForAgent: body,
          CommandBody: body,
          CommandAuthorized: true,
        } as unknown as TelegramMessageContext["ctxPayload"],
        msg: {
          chat: { id: -100123, type: "supergroup" },
          message_id: messageId,
          text: body,
        } as unknown as TelegramMessageContext["msg"],
        chatId: -100123,
        isGroup: true,
        historyKey,
        historyLimit: 10,
        groupHistories,
        threadSpec: { id: undefined, scope: "none" },
      });

    const sidePromise = dispatchWithContext({
      context: createGroupContext(100, "/btw what changed?"),
      streamMode: "off",
    });
    await sideStartGate;
    expect(sideAbortSignal?.aborted).toBe(false);

    await dispatchWithContext({
      context: createGroupContext(101, "/stop"),
      streamMode: "off",
    });

    expect(sideAbortSignal?.aborted).toBe(true);
    releaseSide?.();
    await sidePromise;
  });

  it("releases fence abort authority at turn adoption", async () => {
    const historyKey = "telegram:group:-100123";
    const groupHistories = new Map([[historyKey, []]]);
    let firstStarted: (() => void) | undefined;
    const firstStartGate = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstAbortSignal: AbortSignal | undefined;
    let adoptTurn: (() => void | Promise<void>) | undefined;
    dispatchReplyWithBufferedBlockDispatcher
      .mockImplementationOnce(async ({ replyOptions }) => {
        firstAbortSignal = replyOptions?.abortSignal;
        adoptTurn = replyOptions?.onTurnAdopted;
        firstStarted?.();
        await firstGate;
        return {
          queuedFinal: false,
          counts: { block: 0, final: 0, tool: 0 },
        };
      })
      .mockImplementationOnce(async () => ({
        queuedFinal: false,
        counts: { block: 0, final: 0, tool: 0 },
      }));

    const createGroupContext = (messageId: number, body: string) =>
      createContext({
        ctxPayload: {
          SessionKey: "agent:main:telegram:group:-100123",
          ChatType: "group",
          MessageSid: String(messageId),
          RawBody: body,
          BodyForAgent: body,
          CommandBody: body,
          CommandAuthorized: true,
        } as unknown as TelegramMessageContext["ctxPayload"],
        msg: {
          chat: { id: -100123, type: "supergroup" },
          message_id: messageId,
          text: body,
        } as unknown as TelegramMessageContext["msg"],
        chatId: -100123,
        isGroup: true,
        historyKey,
        historyLimit: 10,
        groupHistories,
        threadSpec: { id: undefined, scope: "none" },
      });

    const firstPromise = dispatchWithContext({
      context: createGroupContext(99, "@bot long turn"),
      streamMode: "off",
    });
    await firstStartGate;
    expect(firstAbortSignal?.aborted).toBe(false);
    expect(adoptTurn).toEqual(expect.any(Function));

    // Before adoption, fence supersede still aborts the live controller.
    const { beginTelegramReplyFence, endTelegramReplyFence, supersedeTelegramReplyFence } =
      await import("./telegram-reply-fence.js");
    const preAdoptController = new AbortController();
    beginTelegramReplyFence({
      key: "agent:main:telegram:group:pre-adopt",
      supersede: false,
      abortController: preAdoptController,
    });
    expect(supersedeTelegramReplyFence("agent:main:telegram:group:pre-adopt")).toBe(true);
    expect(preAdoptController.signal.aborted).toBe(true);
    endTelegramReplyFence("agent:main:telegram:group:pre-adopt");

    // After adoption, the dispatch controller is released from the fence set so
    // a later superseding peer (authorized explicit command) cannot abort it.
    await adoptTurn?.();
    expect(firstAbortSignal?.aborted).toBe(false);
    expect(supersedeTelegramReplyFence("agent:main:telegram:group:-100123")).toBe(false);

    await dispatchWithContext({
      context: createGroupContext(100, "/export-trajectory bundle"),
      streamMode: "off",
    });
    expect(firstAbortSignal?.aborted).toBe(false);
    releaseFirst?.();
    await firstPromise;
  });

  it("keeps supersession latched when it arrives during adoption", async () => {
    const sessionKey = "agent:main:telegram:direct:adoption-race";
    let adoptionStarted: (() => void) | undefined;
    const adoptionStartGate = new Promise<void>((resolve) => {
      adoptionStarted = resolve;
    });
    let releaseAdoption: (() => void) | undefined;
    const adoptionGate = new Promise<void>((resolve) => {
      releaseAdoption = resolve;
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onTurnAdopted?.();
        await dispatcherOptions.deliver({ text: "stale final" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });

    const dispatchPromise = dispatchWithContext({
      context: createContext({
        ctxPayload: {
          SessionKey: sessionKey,
          ChatType: "direct",
          MessageSid: "101",
          RawBody: "long turn",
          BodyForAgent: "long turn",
          CommandBody: "long turn",
          CommandAuthorized: true,
        } as unknown as TelegramMessageContext["ctxPayload"],
        msg: {
          chat: { id: 123, type: "private" },
          message_id: 101,
          text: "long turn",
        } as unknown as TelegramMessageContext["msg"],
        chatId: 123,
        isGroup: false,
        threadSpec: { id: undefined, scope: "none" },
      }),
      streamMode: "off",
      onTurnAdopted: async () => {
        adoptionStarted?.();
        await adoptionGate;
      },
    });
    await adoptionStartGate;

    const { supersedeTelegramReplyFence } = await import("./telegram-reply-fence.js");
    expect(supersedeTelegramReplyFence(sessionKey)).toBe(true);
    releaseAdoption?.();
    await dispatchPromise;

    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("lets authorized /stop kill an adopted run without the released fence controller", async () => {
    const historyKey = "telegram:group:-100123";
    const groupHistories = new Map([[historyKey, []]]);
    // Core owns post-adoption abort via reply-run registry / handleStopCommand.
    // Pin: after fence release, a core-owned abort still ends the run while the
    // fence controller stays non-aborted.
    const coreRunController = new AbortController();
    let firstStarted: (() => void) | undefined;
    const firstStartGate = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let firstAbortSignal: AbortSignal | undefined;
    let adoptTurn: (() => void | Promise<void>) | undefined;
    let runSettled = false;
    dispatchReplyWithBufferedBlockDispatcher
      .mockImplementationOnce(async ({ replyOptions }) => {
        firstAbortSignal = replyOptions?.abortSignal;
        adoptTurn = replyOptions?.onTurnAdopted;
        firstStarted?.();
        await new Promise<void>((resolve) => {
          const finish = () => {
            if (runSettled) {
              return;
            }
            runSettled = true;
            resolve();
          };
          firstAbortSignal?.addEventListener("abort", finish, { once: true });
          coreRunController.signal.addEventListener("abort", finish, { once: true });
        });
        return {
          queuedFinal: false,
          counts: { block: 0, final: 0, tool: 0 },
        };
      })
      .mockImplementationOnce(async () => {
        // Simulate core handleStopCommand / abortReplyRunBySessionId effect on the
        // adopted registry-owned run (independent of the released fence controller).
        coreRunController.abort();
        return {
          queuedFinal: false,
          counts: { block: 0, final: 0, tool: 0 },
        };
      });

    const createGroupContext = (messageId: number, body: string) =>
      createContext({
        ctxPayload: {
          SessionKey: "agent:main:telegram:group:-100123",
          ChatType: "group",
          MessageSid: String(messageId),
          RawBody: body,
          BodyForAgent: body,
          CommandBody: body,
          CommandAuthorized: true,
        } as unknown as TelegramMessageContext["ctxPayload"],
        msg: {
          chat: { id: -100123, type: "supergroup" },
          message_id: messageId,
          text: body,
        } as unknown as TelegramMessageContext["msg"],
        chatId: -100123,
        isGroup: true,
        historyKey,
        historyLimit: 10,
        groupHistories,
        threadSpec: { id: undefined, scope: "none" },
      });

    const firstPromise = dispatchWithContext({
      context: createGroupContext(99, "@bot long adopted turn"),
      streamMode: "off",
    });
    await firstStartGate;
    await adoptTurn?.();
    expect(firstAbortSignal?.aborted).toBe(false);
    expect(coreRunController.signal.aborted).toBe(false);

    await dispatchWithContext({
      context: createGroupContext(100, "/stop"),
      streamMode: "off",
    });

    await firstPromise;
    expect(firstAbortSignal?.aborted).toBe(false);
    expect(coreRunController.signal.aborted).toBe(true);
  });

  it("keeps overlapping group deliveries non-superseded", async () => {
    const historyKey = "telegram:group:-100123";
    const groupHistories = new Map([[historyKey, []]]);
    let firstStarted: (() => void) | undefined;
    const firstStartGate = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let secondStarted: (() => void) | undefined;
    const secondStartGate = new Promise<void>((resolve) => {
      secondStarted = resolve;
    });
    dispatchReplyWithBufferedBlockDispatcher
      .mockImplementationOnce(async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onTurnAdopted?.();
        firstStarted?.();
        await firstGate;
        await dispatcherOptions.deliver({ text: "earlier group answer" }, { kind: "final" });
        return {
          queuedFinal: true,
          counts: { block: 0, final: 1, tool: 0 },
        };
      })
      .mockImplementationOnce(async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onTurnAdopted?.();
        secondStarted?.();
        await dispatcherOptions.deliver({ text: "fresh group answer" }, { kind: "final" });
        return {
          queuedFinal: true,
          counts: { block: 0, final: 1, tool: 0 },
        };
      });
    deliverReplies.mockResolvedValue({ delivered: true });

    const createGroupContext = (messageId: number, body: string) =>
      createContext({
        ctxPayload: {
          SessionKey: "agent:main:telegram:group:-100123",
          ChatType: "group",
          MessageSid: String(messageId),
          RawBody: body,
          BodyForAgent: body,
          CommandBody: body,
          CommandAuthorized: true,
        } as unknown as TelegramMessageContext["ctxPayload"],
        msg: {
          chat: { id: -100123, type: "supergroup" },
          message_id: messageId,
        } as unknown as TelegramMessageContext["msg"],
        chatId: -100123,
        isGroup: true,
        historyKey,
        historyLimit: 10,
        groupHistories,
        threadSpec: { id: undefined, scope: "none" },
      });

    const firstPromise = dispatchWithContext({
      context: createGroupContext(99, "@bot first request"),
      streamMode: "off",
    });
    await firstStartGate;
    const secondPromise = dispatchWithContext({
      context: createGroupContext(100, "@bot second request"),
      streamMode: "off",
    });
    await secondStartGate;
    releaseFirst?.();
    await Promise.all([firstPromise, secondPromise]);

    const deliveredTexts = deliverReplies.mock.calls.flatMap((call) =>
      ((call[0] as { replies?: Array<{ text?: string }> }).replies ?? []).map(
        (reply) => reply.text,
      ),
    );
    expect(deliveredTexts).toContain("earlier group answer");
    expect(deliveredTexts).toContain("fresh group answer");
  });

  it("does not drop any long-final text after a generic lane rotation", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        await dispatcherOptions.deliver(
          { text: "A".repeat(4000) + "B".repeat(4000) },
          { kind: "final" },
        );
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context: createContext(),
      textLimit: 4000,
    });

    expect(answerDraftStream.update).toHaveBeenCalledWith("A".repeat(4000) + "B".repeat(4000));
  });

  it("does not suppress text-only blocks as delivered when answer draft is inactive", async () => {
    setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "forced block" }, { kind: "block" });
      await dispatcherOptions.deliver({ text: "final text" }, { kind: "final" });
      return { queuedFinal: true };
    });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "partial",
      telegramCfg: {
        streaming: { mode: "partial", block: { enabled: true } },
      } satisfies Parameters<typeof dispatchTelegramMessage>[0]["telegramCfg"],
    });

    const deliveredTexts = deliverReplies.mock.calls.flatMap((call) =>
      ((call[0] as { replies?: Array<{ text?: string }> }).replies ?? []).map(
        (reply) => reply.text,
      ),
    );
    expect(deliveredTexts).toContain("forced block");
  });

  it("does not suppress text-only blocks after a tool-progress draft", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        await dispatcherOptions.deliver({ text: "block after progress" }, { kind: "block" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context: createContext(),
      streamMode: "partial",
      telegramCfg: { streaming: { mode: "partial" } },
    });

    expect(mockCallArg(answerDraftStream.updatePreview).text).toContain("Exec");
    expect(answerDraftStream.update).toHaveBeenLastCalledWith("block after progress");
  });

  it("does not suppress button-bearing blocks after answer streaming starts", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    const buttons = [[{ text: "OK", callback_data: "ok" }]];
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "partial answer" });
        await dispatcherOptions.deliver(
          { text: "choose now", channelData: { telegram: { buttons } } },
          { kind: "block" },
        );
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context: createContext(),
      streamMode: "partial",
      telegramCfg: { streaming: { mode: "partial" } },
    });

    expect(answerDraftStream.update).toHaveBeenLastCalledWith("choose now");
    expectRecordFields(mockCallArg(editMessageTelegram, 0, 3), { buttons });
  });

  it("finalizes an ordinary block-only draft when no final follows", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        { text: "block-only answer" },
        { kind: "block", assistantMessageIndex: 0 },
      );
      return { queuedFinal: false, counts: { block: 1, final: 0, tool: 0 } };
    });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "partial",
      telegramCfg: { streaming: { mode: "partial" } },
    });

    expect(answerDraftStream.update).toHaveBeenCalledTimes(1);
    expect(answerDraftStream.update).toHaveBeenCalledWith("block-only answer");
    expect(answerDraftStream.stop).toHaveBeenCalled();
    expect(answerDraftStream.clear).not.toHaveBeenCalled();
    expect(deliverReplies).not.toHaveBeenCalled();
    expectRecordFields(mockCallArg(emitInternalMessageSentHook), {
      content: "block-only answer",
      messageId: 2001,
    });
  });

  it("delivers a block-only answer when a native quote disables the draft stream", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        { text: "quoted block-only answer", replyToId: "9001" },
        { kind: "block", assistantMessageIndex: 0 },
      );
      return { queuedFinal: false, counts: { block: 1, final: 0, tool: 0 } };
    });

    await dispatchWithContext({
      context: createContext({
        ctxPayload: {
          ReplyToIsQuote: true,
          ReplyToId: "9001",
          ReplyToQuoteText: "quoted source",
        } as TelegramMessageContext["ctxPayload"],
      }),
      streamMode: "progress",
      telegramCfg: { streaming: { mode: "progress" } },
    });

    expect(createTelegramDraftStream).not.toHaveBeenCalled();
    const delivery = expectDeliverRepliesParams({});
    expectRecordFields((delivery.replies as Array<unknown>)[0], {
      text: "quoted block-only answer",
      replyToId: "9001",
    });
  });

  it("cleans up the draft after terminal block delivery throws", async () => {
    const { answerDraftStream } = setupDraftStreams();
    deliverReplies.mockRejectedValueOnce(new Error("terminal send failed"));
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        { text: "block-only answer" },
        { kind: "block", assistantMessageIndex: 0 },
      );
      return { queuedFinal: false, counts: { block: 1, final: 0, tool: 0 } };
    });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "partial",
      telegramCfg: { streaming: { mode: "partial" } },
    });

    expect(answerDraftStream.clear).toHaveBeenCalled();
    expect(deliverReplies).toHaveBeenCalledTimes(2);
  });

  it("finalizes a duplicate text-only block when no final follows", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    const context = createContext();
    context.ctxPayload.SessionKey = "agent:default:telegram:direct:123";
    mockDefaultSessionEntry();
    readLatestAssistantTextByIdentity.mockResolvedValue({
      id: "assistant-block-only",
      text: "partial answer",
      timestamp: Date.now() + 1_000,
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "partial answer" });
        await dispatcherOptions.deliver(
          { text: "partial answer" },
          { kind: "block", assistantMessageIndex: 0 },
        );
        return { queuedFinal: false };
      },
    );

    await dispatchWithContext({
      context,
      streamMode: "partial",
      telegramCfg: { streaming: { mode: "partial" } },
    });

    expect(answerDraftStream.stop).toHaveBeenCalled();
    expect(answerDraftStream.clear).not.toHaveBeenCalled();
    expectRecordFields(mockCallArg(emitInternalMessageSentHook), {
      content: "partial answer",
      messageId: 2001,
    });
    expectRecordFields(mockCallArg(recordOutboundMessageForPromptContext), {
      text: "partial answer",
      messageId: 2001,
      promptContextProjection: {
        transcriptMessageId: "assistant-block-only",
        partIndex: 0,
        finalPart: true,
      },
    });
  });

  it("keeps a delayed earlier identical block markerless when a later block rotates it", async () => {
    const answerDraftStream = createSequencedDraftStream(2001);
    createTelegramDraftStream
      .mockImplementationOnce(() => answerDraftStream)
      .mockImplementationOnce(() => createDraftStream());
    const context = createContext();
    context.ctxPayload.SessionKey = "agent:default:telegram:direct:123";
    mockDefaultSessionEntry();
    readLatestAssistantTextByIdentity.mockResolvedValue({
      id: "assistant-identical-second",
      text: "OK",
      timestamp: Date.now() + 2_000,
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onBlockReplyQueued?.({ text: "OK" }, { assistantMessageIndex: 0 });
        await replyOptions?.onBlockReplyQueued?.({ text: "OK" }, { assistantMessageIndex: 1 });
        await dispatcherOptions.deliver(
          { text: "OK" },
          { kind: "block", assistantMessageIndex: 0 },
        );
        await dispatcherOptions.deliver(
          { text: "OK" },
          { kind: "block", assistantMessageIndex: 1 },
        );
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({ context, streamMode: "partial" });

    expect(readLatestAssistantTextByIdentity).not.toHaveBeenCalled();
    expect(recordOutboundMessageForPromptContext).toHaveBeenCalledTimes(1);
    const firstBlockRecord = mockCallArg(recordOutboundMessageForPromptContext);
    expectRecordFields(firstBlockRecord, { text: "OK", messageId: 2001 });
    expect(firstBlockRecord).not.toHaveProperty("promptContextProjection");
  });

  it("materializes a pending duplicate text-only block before finalizing it", async () => {
    const { answerDraftStream } = setupDraftStreams();
    answerDraftStream.stop.mockImplementation(async () => {
      answerDraftStream.setMessageId(2001);
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "pending answer" });
        await dispatcherOptions.deliver({ text: "pending answer" }, { kind: "block" });
        return { queuedFinal: false };
      },
    );

    await dispatchWithContext({
      context: createContext(),
      streamMode: "partial",
      telegramCfg: { streaming: { mode: "partial" } },
    });

    expect(answerDraftStream.stop).toHaveBeenCalled();
    expect(answerDraftStream.clear).not.toHaveBeenCalled();
    expectRecordFields(mockCallArg(emitInternalMessageSentHook), {
      content: "pending answer",
      messageId: 2001,
    });
  });

  it("keeps queued room events abortable after their source dispatch returns", async () => {
    const historyKey = "telegram:group:-100123";
    const groupHistories = new Map([[historyKey, []]]);
    let roomEventAbortSignal: AbortSignal | undefined;
    let queuedLifecycle:
      | {
          onEnqueued?: () => void;
          onAdmitted?: () => Promise<void> | void;
          onComplete?: () => void;
        }
      | undefined;
    let deliverQueuedRoomEvent:
      | DispatchReplyWithBufferedBlockDispatcherArgs["dispatcherOptions"]["deliver"]
      | undefined;
    let adoptionStarted: (() => void) | undefined;
    const adoptionStartGate = new Promise<void>((resolve) => {
      adoptionStarted = resolve;
    });
    let releaseAdoption: (() => void) | undefined;
    const adoptionGate = new Promise<void>((resolve) => {
      releaseAdoption = resolve;
    });
    dispatchReplyWithBufferedBlockDispatcher
      .mockImplementationOnce(async ({ dispatcherOptions, replyOptions }) => {
        roomEventAbortSignal = replyOptions?.abortSignal;
        queuedLifecycle = replyOptions?.queuedFollowupLifecycle;
        deliverQueuedRoomEvent = dispatcherOptions.deliver;
        queuedLifecycle?.onEnqueued?.();
        return {
          queuedFinal: false,
          counts: { block: 0, final: 0, tool: 0 },
          sourceReplyDeliveryMode: "message_tool_only",
        };
      })
      .mockImplementationOnce(async ({ dispatcherOptions }) => {
        await dispatcherOptions.deliver({ text: "fresh request answer" }, { kind: "final" });
        return {
          queuedFinal: true,
          counts: { block: 0, final: 1, tool: 0 },
        };
      });

    const createGroupContext = (
      kind: "user_request" | "room_event",
      messageId: number,
      body: string,
    ) =>
      createContext({
        ctxPayload: {
          InboundEventKind: kind,
          SessionKey: "agent:main:telegram:group:-100123",
          ChatType: "group",
          MessageSid: String(messageId),
          RawBody: body,
          BodyForAgent: body,
          CommandBody: body,
          CommandAuthorized: true,
        } as unknown as TelegramMessageContext["ctxPayload"],
        msg: {
          chat: { id: -100123, type: "supergroup" },
          message_id: messageId,
        } as unknown as TelegramMessageContext["msg"],
        chatId: -100123,
        isGroup: true,
        historyKey,
        historyLimit: 10,
        groupHistories,
        threadSpec: { id: undefined, scope: "none" },
      });

    await dispatchWithContext({
      context: createGroupContext("room_event", 99, "ambient chatter"),
      streamMode: "off",
      onTurnAdopted: async () => {
        adoptionStarted?.();
        await adoptionGate;
      },
    });
    expect(roomEventAbortSignal?.aborted).toBe(false);

    const admissionPromise = queuedLifecycle?.onAdmitted?.();
    await adoptionStartGate;

    await dispatchWithContext({
      context: createGroupContext("user_request", 100, "@bot answer now"),
      streamMode: "off",
    });

    expect(roomEventAbortSignal?.aborted).toBe(true);
    releaseAdoption?.();
    await admissionPromise;
    await deliverQueuedRoomEvent?.({ text: "stale ambient answer" }, { kind: "final" });
    expect(deliverReplies).toHaveBeenCalledTimes(1);
    queuedLifecycle?.onComplete?.();
  });

  it("holds queued request fence authority until admission", async () => {
    type QueuedLifecycle = {
      onEnqueued?: () => void;
      onAdmitted?: () => Promise<void> | void;
      onComplete?: () => void;
    };
    const captures: Array<{ abortSignal?: AbortSignal; lifecycle?: QueuedLifecycle }> = [];
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      const capture = {
        abortSignal: replyOptions?.abortSignal,
        lifecycle: replyOptions?.queuedFollowupLifecycle,
      };
      captures.push(capture);
      capture.lifecycle?.onEnqueued?.();
      return {
        queuedFinal: false,
        counts: { block: 0, final: 0, tool: 0 },
      };
    });
    const createQueuedContext = (sessionKey: string, messageId: number) =>
      createContext({
        ctxPayload: {
          SessionKey: sessionKey,
          ChatType: "direct",
          MessageSid: String(messageId),
          RawBody: "queued request",
          BodyForAgent: "queued request",
          CommandBody: "queued request",
          CommandAuthorized: true,
        } as unknown as TelegramMessageContext["ctxPayload"],
        msg: {
          chat: { id: 123, type: "private" },
          message_id: messageId,
          text: "queued request",
        } as unknown as TelegramMessageContext["msg"],
        chatId: 123,
        isGroup: false,
        threadSpec: { id: undefined, scope: "none" },
      });
    const { supersedeTelegramReplyFence } = await import("./telegram-reply-fence.js");

    await dispatchWithContext({
      context: createQueuedContext("agent:main:telegram:direct:pre-adopt", 101),
      streamMode: "off",
      onTurnDeferred: vi.fn(),
      onTurnAbandoned: vi.fn(),
    });
    expect(captures[0]?.abortSignal?.aborted).toBe(false);
    expect(supersedeTelegramReplyFence("agent:main:telegram:direct:pre-adopt")).toBe(true);
    expect(captures[0]?.abortSignal?.aborted).toBe(true);
    captures[0]?.lifecycle?.onComplete?.();

    const onTurnAdopted = vi.fn();
    await dispatchWithContext({
      context: createQueuedContext("agent:main:telegram:direct:adopted", 102),
      streamMode: "off",
      onTurnAdopted,
      onTurnDeferred: vi.fn(),
      onTurnAbandoned: vi.fn(),
    });
    await captures[1]?.lifecycle?.onAdmitted?.();
    expect(onTurnAdopted).toHaveBeenCalledTimes(1);
    expect(supersedeTelegramReplyFence("agent:main:telegram:direct:adopted")).toBe(false);
    expect(captures[1]?.abortSignal?.aborted).toBe(false);
    captures[1]?.lifecycle?.onComplete?.();

    const rejectedKey = "agent:main:telegram:direct:rejected-adoption";
    const onRejectedTurnAbandoned = vi.fn();
    await dispatchWithContext({
      context: createQueuedContext(rejectedKey, 103),
      streamMode: "off",
      onTurnAdopted: vi.fn(async () => {
        throw new Error("durable adoption failed");
      }),
      onTurnDeferred: vi.fn(),
      onTurnAbandoned: onRejectedTurnAbandoned,
    });
    await expect(captures[2]?.lifecycle?.onAdmitted?.()).rejects.toThrow("durable adoption failed");
    expect(supersedeTelegramReplyFence(rejectedKey)).toBe(true);
    expect(captures[2]?.abortSignal?.aborted).toBe(true);
    captures[2]?.lifecycle?.onComplete?.();
    expect(onRejectedTurnAbandoned).toHaveBeenCalledTimes(1);
    expect(supersedeTelegramReplyFence(rejectedKey)).toBe(false);
  });

  it("does not send visible error fallbacks for room events", async () => {
    const historyKey = "telegram:group:-100123";
    const groupHistories = new Map([
      [historyKey, [{ sender: "Alice", body: "quiet failure", timestamp: 1 }]],
    ]);
    dispatchReplyWithBufferedBlockDispatcher.mockRejectedValue(new Error("provider down"));

    await dispatchWithContext({
      context: createContext({
        ctxPayload: {
          InboundEventKind: "room_event",
          SessionKey: "agent:main:telegram:group:-100123",
          ChatType: "group",
          MessageSid: "101",
          RawBody: "ambient failure",
          BodyForAgent: "ambient failure",
          CommandBody: "ambient failure",
        } as unknown as TelegramMessageContext["ctxPayload"],
        msg: {
          chat: { id: -100123, type: "supergroup" },
          message_id: 101,
        } as unknown as TelegramMessageContext["msg"],
        chatId: -100123,
        isGroup: true,
        historyKey,
        historyLimit: 10,
        groupHistories,
        threadSpec: { id: undefined, scope: "none" },
      }),
      streamMode: "partial",
    });

    expect(deliverReplies).not.toHaveBeenCalled();
    expect(groupHistories.get(historyKey)).toHaveLength(1);
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
    let releaseFirstFinal: (() => void) | undefined;
    const firstFinalGate = new Promise<void>((resolve) => {
      releaseFirstFinal = resolve;
    });
    let resolveStreamVisible: (() => void) | undefined;
    const streamVisible = new Promise<void>((resolve) => {
      resolveStreamVisible = resolve;
    });

    const firstAnswerDraft = createTestDraftStream({
      messageId: 1001,
      onUpdate: (text) => {
        if (text === "Old reply partial") {
          if (!resolveStreamVisible) {
            throw new Error("Expected Telegram stream-visible resolver to be initialized");
          }
          resolveStreamVisible();
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
    const firstPromise = dispatchWithContext({
      context: createContext({
        ctxPayload: {
          SessionKey: "s1",
          Body: "earlier request",
          RawBody: "earlier request",
        } as never,
      }),
    });

    await streamVisible;

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

    if (!releaseFirstFinal) {
      throw new Error("Expected first Telegram final release callback to be initialized");
    }
    releaseFirstFinal();
    await Promise.all([firstPromise, unauthorizedPromise]);

    expect(firstAnswerDraft.update).toHaveBeenCalledWith("Old reply final");
    expect(editMessageTelegram).not.toHaveBeenCalled();
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
    expect(bot.api["editForumTopic"]).not.toHaveBeenCalled();
  });

  it("truncates DM topic auto-rename input on UTF-16 boundaries", async () => {
    const sessionKey = "agent:default:telegram:direct:123";
    loadSessionStore.mockReturnValue({
      [sessionKey]: { sessionId: "s1", updatedAt: 1 },
    });
    dispatchReplyWithBufferedBlockDispatcher.mockResolvedValue({ queuedFinal: true });
    const bot = createBot();
    const base = "a".repeat(499);
    const rawBody = `${base}😀tail`;

    await dispatchWithContext({
      bot,
      context: createContext({
        ctxPayload: {
          SessionKey: sessionKey,
          RawBody: rawBody,
        } as TelegramMessageContext["ctxPayload"],
      }),
      telegramCfg: { autoTopicLabel: true },
    });

    await vi.waitFor(() => {
      expect(generateTopicLabel).toHaveBeenCalled();
    });
    const call = generateTopicLabel.mock.calls[0]?.[0] as { userMessage: string };
    expect(call.userMessage).toBe(base);
  });

  it("does not emit a silent-reply fallback when the dispatcher reports a queued final reply", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockResolvedValue({
      queuedFinal: true,
      counts: { block: 0, final: 1, tool: 0 },
    });

    await dispatchWithContext({
      context: createContext({
        ctxPayload: createDirectSessionPayload(),
      }),
      streamMode: "off",
    });

    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("does not emit a silent-reply fallback for no-response DM turns", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockResolvedValue({
      queuedFinal: false,
      counts: { block: 0, final: 0, tool: 0 },
    });

    await dispatchWithContext({
      context: createContext({
        ctxPayload: createDirectSessionPayload(),
      }),
      streamMode: "off",
    });

    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("does not emit an empty-response fallback for internal artifact skips", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      dispatcherOptions.onSkip?.({ text: "<channel|>" }, { kind: "final", reason: "silent" });
      return { queuedFinal: false, counts: { block: 0, final: 0, tool: 0 } };
    });

    await dispatchWithContext({
      context: createContext({
        ctxPayload: createDirectSessionPayload(),
      }),
      streamMode: "off",
    });

    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("does not emit a silent-reply fallback for no-response group turns", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockResolvedValue({
      queuedFinal: false,
      counts: { block: 0, final: 0, tool: 0 },
    });

    await dispatchWithContext({
      context: createContext({
        chatId: -1001234,
        isGroup: true,
        ctxPayload: {
          SessionKey: "agent:test:telegram:group:-1001234",
          ChatType: "group",
        } as TelegramMessageContext["ctxPayload"],
        primaryCtx: {
          message: { chat: { id: -1001234, type: "supergroup" } },
        } as TelegramMessageContext["primaryCtx"],
        msg: {
          chat: { id: -1001234, type: "supergroup" },
          message_id: 456,
        } as TelegramMessageContext["msg"],
        threadSpec: { id: undefined, scope: "none" },
        replyThreadId: undefined,
      }),
      cfg: {
        agents: {
          defaults: {
            silentReply: {
              group: "disallow",
              internal: "allow",
            },
          },
        },
      } as Parameters<typeof dispatchTelegramMessage>[0]["cfg"],
      streamMode: "off",
    });

    expect(deliverReplies).not.toHaveBeenCalled();
  });

  describe("non-streaming media dedup", () => {
    const finalDeliveryPayload = () => {
      for (const [params] of deliverInboundReplyWithMessageSendContext.mock.calls) {
        if (params.info.kind === "final") {
          return params.payload;
        }
      }
      throw new Error("missing final delivery");
    };

    it("deduplicates block-sent media from final reply", async () => {
      deliverReplies.mockResolvedValue({ delivered: true });
      deliverInboundReplyWithMessageSendContext.mockResolvedValue({
        status: "handled_visible",
        delivery: { messageIds: ["101"], visibleReplySent: true },
      });
      dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
        await dispatcherOptions.deliver({ mediaUrls: ["/tmp/cat.jpg"] }, { kind: "block" });
        await dispatcherOptions.deliver(
          { text: "Here is the image", mediaUrls: ["/tmp/cat.jpg"] },
          { kind: "final" },
        );
        return { queuedFinal: true };
      });

      await dispatchWithContext({
        context: createContext(),
        streamMode: "off",
        telegramDeps: telegramDepsForTest,
      });

      expect(finalDeliveryPayload().mediaUrls).toEqual([]);
    });

    it("preserves final media when block delivery reports no visible send", async () => {
      deliverReplies.mockResolvedValueOnce({ delivered: false });
      deliverReplies.mockResolvedValue({ delivered: true });
      deliverInboundReplyWithMessageSendContext.mockResolvedValue({
        status: "handled_visible",
        delivery: { messageIds: ["101"], visibleReplySent: true },
      });
      dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
        await dispatcherOptions.deliver({ mediaUrls: ["/tmp/cat.jpg"] }, { kind: "block" });
        await dispatcherOptions.deliver(
          { text: "Here is the image", mediaUrls: ["/tmp/cat.jpg"] },
          { kind: "final" },
        );
        return { queuedFinal: true };
      });

      await dispatchWithContext({
        context: createContext(),
        streamMode: "off",
        telegramDeps: telegramDepsForTest,
      });

      expect(finalDeliveryPayload().mediaUrls).toEqual(["/tmp/cat.jpg"]);
    });

    it("preserves final media when block delivery fails", async () => {
      deliverReplies.mockRejectedValueOnce(new Error("Telegram API error"));
      deliverReplies.mockResolvedValue({ delivered: true });
      deliverInboundReplyWithMessageSendContext.mockResolvedValue({
        status: "handled_visible",
        delivery: { messageIds: ["101"], visibleReplySent: true },
      });
      dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
        try {
          await dispatcherOptions.deliver({ mediaUrls: ["/tmp/cat.jpg"] }, { kind: "block" });
        } catch {}
        await dispatcherOptions.deliver(
          { text: "Here is the image", mediaUrls: ["/tmp/cat.jpg"] },
          { kind: "final" },
        );
        return { queuedFinal: true };
      });

      await dispatchWithContext({
        context: createContext(),
        streamMode: "off",
        telegramDeps: telegramDepsForTest,
      });

      expect(finalDeliveryPayload().mediaUrls).toEqual(["/tmp/cat.jpg"]);
    });
  });
});
