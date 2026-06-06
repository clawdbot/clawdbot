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
import { recordOutboundMessageForPromptContext as recordOutboundMessageForPromptContextActual } from "./outbound-message-context.js";
import { clearTelegramRuntime, setTelegramRuntime } from "./runtime.js";
import type { TelegramRuntime } from "./runtime.types.js";

type DispatchReplyWithBufferedBlockDispatcherArgs = Parameters<
  TelegramBotDeps["dispatchReplyWithBufferedBlockDispatcher"]
>[0];

const createTelegramDraftStream = vi.hoisted(() => vi.fn());
const createNativeTelegramToolProgressDraft = vi.hoisted(() => vi.fn());
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
    onModelSelected: () => undefined,
  })),
);
const wasSentByBot = vi.hoisted(() => vi.fn(() => false));
const appendSessionTranscriptMessage = vi.hoisted(() =>
  vi.fn(async ({ message }: { message?: unknown }) => ({
    messageId: "m1",
    message,
    appended: true,
  })),
);
const emitSessionTranscriptUpdate = vi.hoisted(() => vi.fn());
const loadSessionStore = vi.hoisted(() => vi.fn());
const readLatestAssistantTextFromSessionTranscript = vi.hoisted(() => vi.fn());
const resolveStorePath = vi.hoisted(() => vi.fn(() => "/tmp/sessions.json"));
const resolveAndPersistSessionFile = vi.hoisted(() =>
  vi.fn(async () => ({
    sessionFile: "/tmp/session.jsonl",
    sessionEntry: { sessionId: "s1", sessionFile: "/tmp/session.jsonl" },
  })),
);
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
const updateSessionStoreEntry = vi.hoisted(() => vi.fn(async () => null));

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

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/agent-harness-runtime")>();
  return {
    ...actual,
    appendSessionTranscriptMessage,
    emitSessionTranscriptUpdate,
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
  getAgentScopedMediaLocalRoots,
  loadSessionStore,
  readLatestAssistantTextFromSessionTranscript,
  resolveAndPersistSessionFile,
  resolveAutoTopicLabelConfig: resolveAutoTopicLabelConfigRuntime,
  resolveChunkMode,
  resolveMarkdownTableMode,
  resolveSessionStoreEntry,
  resolveStorePath,
  updateSessionStoreEntry,
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
  createNativeTelegramToolProgressDraft:
    createNativeTelegramToolProgressDraft as TelegramBotDeps["createNativeTelegramToolProgressDraft"],
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
    createNativeTelegramToolProgressDraft.mockReset();
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
    appendSessionTranscriptMessage.mockReset();
    emitSessionTranscriptUpdate.mockReset();
    readLatestAssistantTextFromSessionTranscript.mockReset();
    loadSessionStore.mockReset();
    resolveStorePath.mockReset();
    resolveAndPersistSessionFile.mockReset();
    updateSessionStoreEntry.mockReset();
    generateTopicLabel.mockReset();
    getAgentScopedMediaLocalRoots.mockClear();
    resolveChunkMode.mockClear();
    resolveMarkdownTableMode.mockClear();
    resolveSessionStoreEntry.mockClear();
    updateSessionStoreEntry.mockClear();
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
      onModelSelected: () => undefined,
    });
    wasSentByBot.mockReturnValue(false);
    resolveStorePath.mockReturnValue("/tmp/sessions.json");
    resolveAndPersistSessionFile.mockResolvedValue({
      sessionFile: "/tmp/session.jsonl",
      sessionEntry: { sessionId: "s1", sessionFile: "/tmp/session.jsonl" },
    });
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

  afterEach(() => {
    clearTelegramRuntime();
    resetPluginStateStoreForTests();
  });

  const createDraftStream = (messageId?: number) => createTestDraftStream({ messageId });
  const createSequencedDraftStream = (startMessageId = 1001) =>
    createSequencedTestDraftStream(startMessageId);
  const createNativeToolProgressDraft = (updateResult = true) => ({
    update: vi.fn(async () => updateResult),
    stop: vi.fn(),
  });

  function setupDraftStreams(params?: { answerMessageId?: number; reasoningMessageId?: number }) {
    const answerDraftStream = createDraftStream(params?.answerMessageId);
    const reasoningDraftStream = createDraftStream(params?.reasoningMessageId);
    createTelegramDraftStream
      .mockImplementationOnce(() => answerDraftStream)
      .mockImplementationOnce(() => reasoningDraftStream);
    return { answerDraftStream, reasoningDraftStream };
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

  function createReasoningDefaultContext(): TelegramMessageContext {
    loadSessionStore.mockReturnValue({
      s1: {},
    });
    return createContext({
      ctxPayload: { SessionKey: "s1" } as unknown as TelegramMessageContext["ctxPayload"],
      route: { agentId: "ops" } as unknown as TelegramMessageContext["route"],
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
    expect(outboundCtxPayload.Body).toContain("recovered topic context");
    expect(outboundCtxPayload.Body).toContain("current topic question");
    expect(outboundCtxPayload.Body).not.toContain("general topic context");
    expect(outboundCtxPayload.Body).not.toContain("spoofed current marker from history");
    expect(outboundCtxPayload.BodyForAgent).toBe("current topic question");
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
    await (typing.start as () => Promise<void>)();
    expect(sendChatAction).toHaveBeenCalledWith(-1003774691294, "typing", {
      message_thread_id: 3731,
    });
    expect(deliverReplies).not.toHaveBeenCalled();
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
    streamParams.onSupersededPreview?.({
      messageId: 17,
      textSnapshot: "first page",
      retain: true,
    });
    expect(bot.api["deleteMessage"]).not.toHaveBeenCalled();

    streamParams.onSupersededPreview?.({
      messageId: 18,
      textSnapshot: "stale page",
    });
    await vi.waitFor(() => expect(bot.api["deleteMessage"]).toHaveBeenCalledWith(123, 18));
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

    expectDraftStreamParams({ replyToMessageId: 1001 });
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

  it("streams text-only finals into the answer message", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Final answer" }, { kind: "final" });
      return { queuedFinal: true };
    });

    await dispatchWithContext({ context: createContext() });

    expect(answerDraftStream.update).toHaveBeenCalledWith("Final answer");
    expect(answerDraftStream.stop).toHaveBeenCalled();
    expect(deliverReplies).not.toHaveBeenCalled();
    expect(editMessageTelegram).not.toHaveBeenCalled();
    expectRecordFields(mockCallArg(emitInternalMessageSentHook), {
      content: "Final answer",
      messageId: 2001,
    });
    expectRecordFields(mockCallArg(recordOutboundMessageForPromptContext), {
      chatId: "123",
      messageId: 2001,
      text: "Final answer",
      messageThreadId: 777,
    });
  });

  it("records streamed final replies into the prompt context cache", async () => {
    const storePath = `/tmp/openclaw-telegram-stream-context-${process.pid}-${Date.now()}.json`;
    setupDraftStreams({ answerMessageId: 1497 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        { text: "Done already: timeoutSeconds is now 7200s." },
        { kind: "final" },
      );
      return { queuedFinal: true };
    });

    await dispatchWithContext({
      context: createContext(),
      cfg: { session: { store: storePath } },
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

    const context = await buildTelegramConversationContext({
      cache,
      accountId: "default",
      chatId: "123",
      threadId: 777,
      messageId: "1521",
      replyChainNodes: [],
      recentLimit: 10,
      replyTargetWindowSize: 2,
    });

    expect(context.map((entry) => entry.node.messageId)).toContain("1497");
    expect(context.map((entry) => entry.node.body)).toContain(
      "Done already: timeoutSeconds is now 7200s.",
    );
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

  it("mirrors preview-finalized finals into the session transcript", async () => {
    setupDraftStreams({ answerMessageId: 2001 });
    const context = createContext();
    context.ctxPayload.SessionKey = "agent:default:telegram:direct:123";
    loadSessionStore.mockReturnValue({
      "agent:default:telegram:direct:123": { sessionId: "s1" },
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Final answer" }, { kind: "final" });
      return { queuedFinal: true };
    });

    await dispatchWithContext({ context });

    const transcriptCall = expectRecordFields(mockCallArg(appendSessionTranscriptMessage), {
      transcriptPath: "/tmp/session.jsonl",
    });
    expectRecordFields(transcriptCall.message, {
      role: "assistant",
      provider: "openclaw",
      model: "delivery-mirror",
      content: [{ type: "text", text: "Final answer" }],
    });
    expectRecordFields(mockCallArg(emitSessionTranscriptUpdate), {
      sessionFile: "/tmp/session.jsonl",
      sessionKey: "agent:default:telegram:direct:123",
      messageId: "m1",
    });
  });

  it("advances the session marker after mirroring preview-finalized finals", async () => {
    setupDraftStreams({ answerMessageId: 2001 });
    const context = createContext();
    context.ctxPayload.SessionKey = "agent:default:telegram:direct:123";
    loadSessionStore.mockReturnValue({
      "agent:default:telegram:direct:123": { sessionId: "s1" },
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Final answer" }, { kind: "final" });
      return { queuedFinal: true };
    });

    await dispatchWithContext({ context });

    const markerUpdateCall = expectRecordFields(mockCallArg(updateSessionStoreEntry), {
      storePath: "/tmp/sessions.json",
      sessionKey: "agent:default:telegram:direct:123",
    });
    const update = markerUpdateCall.update as (entry: { sessionId?: string }) => unknown;
    expect(update({ sessionId: "s1" })).toEqual({ updatedAt: expect.any(Number) });
    expect(update({ sessionId: "new-session" })).toBeNull();
  });

  it("does not mirror non-final tool progress into the session transcript", async () => {
    const context = createContext();
    context.ctxPayload.SessionKey = "agent:default:telegram:direct:123";
    loadSessionStore.mockReturnValue({
      "agent:default:telegram:direct:123": { sessionId: "s1" },
    });
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
    expect(appendSessionTranscriptMessage).toHaveBeenCalledTimes(1);
    const transcriptCall = expectRecordFields(mockCallArg(appendSessionTranscriptMessage), {
      transcriptPath: "/tmp/session.jsonl",
    });
    expectRecordFields(transcriptCall.message, {
      role: "assistant",
      provider: "openclaw",
      model: "delivery-mirror",
      content: [{ type: "text", text: "Final answer" }],
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
    loadSessionStore.mockReturnValue({
      "agent:default:telegram:direct:123": { sessionId: "s1" },
    });
    readLatestAssistantTextFromSessionTranscript.mockResolvedValue({
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
    const transcriptCall = expectRecordFields(mockCallArg(appendSessionTranscriptMessage), {
      transcriptPath: "/tmp/session.jsonl",
    });
    expectRecordFields(transcriptCall.message, {
      role: "assistant",
      provider: "openclaw",
      model: "delivery-mirror",
      content: [{ type: "text", text: fullAnswer }],
    });
  });

  it("emits the redacted appended message in transcript updates", async () => {
    setupDraftStreams({ answerMessageId: 2001 });
    const context = createContext();
    context.ctxPayload.SessionKey = "agent:default:telegram:direct:123";
    loadSessionStore.mockReturnValue({
      "agent:default:telegram:direct:123": { sessionId: "s1" },
    });
    appendSessionTranscriptMessage.mockImplementationOnce(async ({ message }) => ({
      messageId: "m1",
      appended: true,
      message: {
        ...(message as Record<string, unknown>),
        content: [{ type: "text", text: "Final sk-abc…0xyz" }],
      },
    }));
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Final sk-abcdef1234567890xyz" }, { kind: "final" });
      return { queuedFinal: true };
    });

    await dispatchWithContext({ context });

    expectRecordFields(mockCallArg(emitSessionTranscriptUpdate), {
      sessionFile: "/tmp/session.jsonl",
      sessionKey: "agent:default:telegram:direct:123",
      messageId: "m1",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Final sk-abc…0xyz" }],
        api: "openai-responses",
        provider: "openclaw",
        model: "delivery-mirror",
        usage: {
          input: 0,
          output: 0,
          total: 0,
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
          cache: {
            read: 0,
            write: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
        stopReason: "stop",
        timestamp: expect.any(Number),
      },
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

    expect(answerDraftStream.update).toHaveBeenCalledTimes(3);
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(1, "Normal reply");
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(2, "Normal reply");
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(3, trailingFinalStatusText);
    expect(answerDraftStream.forceNewMessage).toHaveBeenCalledTimes(1);
    expect(answerDraftStream.forceNewMessage.mock.invocationCallOrder[0]).toBeLessThan(
      answerDraftStream.update.mock.invocationCallOrder[2],
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

    expect(mockCallArg(answerDraftStream.update)).toContain("Exec");
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(2, "Done ");
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(3, "Done answer");
    expect(answerDraftStream.update).toHaveBeenLastCalledWith("Done answer.");
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("uses native DM drafts for transient tool progress before answer text", async () => {
    const nativeDraft = createNativeToolProgressDraft();
    createNativeTelegramToolProgressDraft.mockReturnValue(nativeDraft);
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        await replyOptions?.onPartialReply?.({ text: "Done ", delta: "Done " });
        await dispatcherOptions.deliver({ text: "Done answer." }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context: createContext(),
      streamMode: "partial",
      telegramCfg: {
        streaming: {
          mode: "partial",
          preview: { nativeToolProgress: true, nativeToolProgressAllowFrom: ["123"] },
        },
      },
    });

    expect(createNativeTelegramToolProgressDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 123,
        thread: { id: 777, scope: "dm" },
      }),
    );
    expect(nativeDraft.update).toHaveBeenCalledWith(expect.stringContaining("Exec"));
    expect(nativeDraft.update).toHaveBeenCalledWith(expect.not.stringContaining("`"));
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(1, "Done ");
    expect(answerDraftStream.update).toHaveBeenLastCalledWith("Done answer.");
    expect(answerDraftStream.update).not.toHaveBeenCalledWith(expect.stringContaining("Exec"));
    expect(nativeDraft.stop).toHaveBeenCalled();
  });

  it("keeps native DM drafts off by default", async () => {
    const nativeDraft = createNativeToolProgressDraft();
    createNativeTelegramToolProgressDraft.mockReturnValue(nativeDraft);
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        await dispatcherOptions.deliver({ text: "Done answer." }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context: createContext(),
      streamMode: "partial",
      telegramCfg: { streaming: { mode: "partial" } },
    });

    expect(createNativeTelegramToolProgressDraft).not.toHaveBeenCalled();
    expect(nativeDraft.update).not.toHaveBeenCalled();
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(1, expect.stringContaining("Exec"));
    expect(answerDraftStream.update).toHaveBeenLastCalledWith("Done answer.");
  });

  it("honors the native DM draft allowlist", async () => {
    const nativeDraft = createNativeToolProgressDraft();
    createNativeTelegramToolProgressDraft.mockReturnValue(nativeDraft);
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        await dispatcherOptions.deliver({ text: "Done answer." }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context: createContext(),
      streamMode: "partial",
      telegramCfg: {
        streaming: {
          mode: "partial",
          preview: {
            nativeToolProgress: true,
            nativeToolProgressAllowFrom: ["999"],
          },
        },
      },
    });

    expect(createNativeTelegramToolProgressDraft).not.toHaveBeenCalled();
    expect(nativeDraft.update).not.toHaveBeenCalled();
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(1, expect.stringContaining("Exec"));
    expect(answerDraftStream.update).toHaveBeenLastCalledWith("Done answer.");
  });

  it("falls back to edited preview tool progress when native DM draft update fails", async () => {
    const nativeDraft = createNativeToolProgressDraft(false);
    createNativeTelegramToolProgressDraft.mockReturnValue(nativeDraft);
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        await dispatcherOptions.deliver({ text: "Done answer." }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context: createContext(),
      streamMode: "partial",
      telegramCfg: {
        streaming: { mode: "partial", preview: { nativeToolProgress: true } },
      },
    });

    expect(nativeDraft.update).toHaveBeenCalledWith(expect.stringContaining("Exec"));
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(1, expect.stringContaining("Exec"));
    expect(answerDraftStream.update).toHaveBeenLastCalledWith("Done answer.");
  });

  it("does not hide durable tool media in native DM drafts", async () => {
    const nativeDraft = createNativeToolProgressDraft();
    createNativeTelegramToolProgressDraft.mockReturnValue(nativeDraft);
    setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        { text: "Rendered chart", mediaUrl: "/tmp/chart.png" },
        { kind: "tool" },
      );
      return { queuedFinal: true };
    });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "partial",
      telegramCfg: {
        streaming: { mode: "partial", preview: { nativeToolProgress: true } },
      },
    });

    expect(nativeDraft.update).not.toHaveBeenCalled();
    expectDeliveredReply(0, { text: "Rendered chart", mediaUrl: "/tmp/chart.png" });
  });

  it("does not hide durable tool errors in native DM drafts", async () => {
    const nativeDraft = createNativeToolProgressDraft();
    createNativeTelegramToolProgressDraft.mockReturnValue(nativeDraft);
    setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Tool failed", isError: true }, { kind: "tool" });
      return { queuedFinal: true };
    });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "partial",
      telegramCfg: {
        streaming: { mode: "partial", preview: { nativeToolProgress: true } },
      },
    });

    expect(nativeDraft.update).not.toHaveBeenCalled();
    expectDeliveredReply(0, { text: "Tool failed", isError: true });
  });

  it("does not hide exec approval payloads in native DM drafts", async () => {
    const nativeDraft = createNativeToolProgressDraft();
    createNativeTelegramToolProgressDraft.mockReturnValue(nativeDraft);
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    const execApproval = { id: "approval-1", command: "pnpm test" };
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        {
          text: "Approve command?",
          channelData: { execApproval },
        },
        { kind: "tool" },
      );
      return { queuedFinal: true };
    });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "partial",
      telegramCfg: {
        streaming: { mode: "partial", preview: { nativeToolProgress: true } },
      },
    });

    expect(nativeDraft.update).not.toHaveBeenCalled();
    expect(answerDraftStream.update).toHaveBeenCalledWith("Approve command?");
  });

  it("does not use native tool progress drafts in groups", async () => {
    setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        await dispatcherOptions.deliver({ text: "Done answer." }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context: createContext({
        ctxPayload: {
          SessionKey: "agent:main:telegram:group:-100123",
          ChatType: "group",
        } as unknown as TelegramMessageContext["ctxPayload"],
        msg: {
          chat: { id: -100123, type: "supergroup" },
          message_id: 99,
        } as unknown as TelegramMessageContext["msg"],
        chatId: -100123,
        isGroup: true,
        threadSpec: { id: undefined, scope: "none" },
      }),
      streamMode: "partial",
      telegramCfg: {
        streaming: { mode: "partial", preview: { nativeToolProgress: true } },
      },
    });

    expect(createNativeTelegramToolProgressDraft).not.toHaveBeenCalled();
  });

  it("does not hide text-only tool output after answer streaming starts", async () => {
    const nativeDraft = createNativeToolProgressDraft();
    createNativeTelegramToolProgressDraft.mockReturnValue(nativeDraft);
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
        streaming: { mode: "partial", preview: { nativeToolProgress: true } },
      },
    });

    expect(nativeDraft.update).not.toHaveBeenCalledWith(
      expect.stringContaining("Tool result after partial"),
    );
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

    expect(answerDraftStream.update).toHaveBeenNthCalledWith(
      1,
      expect.stringMatching(/`🛠️ Exec`$/),
    );
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(2, "Branch is up to date");
    expect(answerDraftStream.forceNewMessage).toHaveBeenCalledTimes(1);
    expect(answerDraftStream.clear).toHaveBeenCalledTimes(1);
    const clearOrder = answerDraftStream.clear.mock.invocationCallOrder[0];
    const rotationOrder = answerDraftStream.forceNewMessage.mock.invocationCallOrder[0];
    const finalUpdateOrder = answerDraftStream.update.mock.invocationCallOrder[1];
    expect(clearOrder).toBeLessThan(rotationOrder);
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
    expect(answerDraftStream.forceNewMessage).toHaveBeenCalledTimes(1);
    expect(answerDraftStream.clear).toHaveBeenCalledTimes(1);
    const clearOrder = answerDraftStream.clear.mock.invocationCallOrder[0];
    const rotationOrder = answerDraftStream.forceNewMessage.mock.invocationCallOrder[0];
    const finalUpdateOrder = answerDraftStream.update.mock.invocationCallOrder[1];
    expect(clearOrder).toBeLessThan(rotationOrder);
    expect(rotationOrder).toBeLessThan(finalUpdateOrder);
  });

  it("keeps progress updates in a draft and sends the final answer normally", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
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

    expect(answerDraftStream.update).toHaveBeenCalledWith(
      "Cracking\n\n`🛠️ Exec`\n`🛠️ git rev-parse --abbrev-ref HEAD`",
    );
    expect(answerDraftStream.update).not.toHaveBeenCalledWith("Branch is up to date");
    expect(answerDraftStream.forceNewMessage).toHaveBeenCalledTimes(1);
    expect(answerDraftStream.clear).toHaveBeenCalledTimes(1);
    expectDeliveredReply(0, { text: "Branch is up to date" });
    expect(editMessageTelegram).not.toHaveBeenCalled();
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

    expect(answerDraftStream.update).toHaveBeenCalledTimes(2);
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(1, "Cracking\n\n`🛠️ Exec`");
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(2, trailingFinalStatusText);
    expect(answerDraftStream.forceNewMessage).toHaveBeenCalledTimes(2);
    expect(answerDraftStream.forceNewMessage.mock.invocationCallOrder[1]).toBeLessThan(
      answerDraftStream.update.mock.invocationCallOrder[1],
    );
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

    expect(answerDraftStream.update).not.toHaveBeenCalledWith(
      expect.stringContaining("stdout line one"),
    );
    expect(answerDraftStream.update).toHaveBeenLastCalledWith(
      "Shelling\n\n`🛠️ Exec`\n`🔎 Web Search: docs lookup`",
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

    expect(answerDraftStream.update).toHaveBeenCalledTimes(1);
    expect(answerDraftStream.update).toHaveBeenCalledWith("Shelling\n\n`🛠️ Exec`");
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

    expect(answerDraftStream.update).toHaveBeenCalledTimes(1);
    expect(answerDraftStream.update).toHaveBeenCalledWith("Shelling\n\n`🛠️ Exec`");
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

    expect(answerDraftStream.update).toHaveBeenCalledTimes(1);
    expect(answerDraftStream.update).toHaveBeenCalledWith("Shelling\n\n`🛠️ Exec`");
    expectDeliveredReply(0, { text: "Branch is up to date" });
  });

  it("uses the transcript final when progress-mode final text is truncated", async () => {
    setupDraftStreams({ answerMessageId: 2001 });
    const fullAnswer =
      "Ja. Hier nochmal sauber Schritt fuer Schritt. Einen API Key kopiert man aus der Google Cloud Console. Danach pruefst du die Projekt- und API-Einstellungen.";
    const truncatedFinal =
      "Ja. Hier nochmal sauber Schritt fuer Schritt. Einen API Key kopiert man...";
    const context = createContext();
    context.ctxPayload.SessionKey = "agent:default:telegram:direct:123";
    loadSessionStore.mockReturnValue({
      "agent:default:telegram:direct:123": { sessionId: "s1" },
    });
    readLatestAssistantTextFromSessionTranscript.mockResolvedValue({
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

    expectDeliveredReply(0, { text: fullAnswer });
  });

  it("streams the first long final chunk and sends follow-up chunks", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    const longText = "one ".repeat(80);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: longText }, { kind: "final" });
      return { queuedFinal: true };
    });

    await dispatchWithContext({ context: createContext(), textLimit: 80 });

    const firstChunk = answerDraftStream.update.mock.calls.at(-1)?.[0] ?? "";
    expect(firstChunk.length).toBeLessThanOrEqual(80);
    expectRecordFields(mockCallArg(recordOutboundMessageForPromptContext), {
      messageId: 2001,
      text: firstChunk,
    });
    expect(deliverReplies).toHaveBeenCalled();
    const followUpTexts = deliverReplies.mock.calls.flatMap((call: unknown[]) =>
      ((call[0] as { replies?: Array<{ text?: string }> }).replies ?? []).map(
        (reply) => reply.text ?? "",
      ),
    );
    expect(followUpTexts.join("")).toContain("one");
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

    expect(draftStream.update).toHaveBeenCalledWith("Shelling\n\n`🛠️ Exec`");
    expect(draftStream.flush).toHaveBeenCalled();
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
    expect(draftStream.update).toHaveBeenCalledWith("Shelling\n\n`🛠️ Exec`\n• _Checking files_");
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

    expect(draftStream.update).toHaveBeenCalledWith("Shelling\n\n_Checking recent context_");
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

    expect(draftStream.update).not.toHaveBeenCalledWith(expect.stringContaining("Checking recent"));
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

    expect(draftStream.update).toHaveBeenCalledWith("Shelling");
    expect(draftStream.flush).toHaveBeenCalled();
  });

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

    await vi.waitFor(() => expect(draftStream.update).toHaveBeenCalledWith("Working"));
    expect(draftStream.update).not.toHaveBeenCalledWith("Working.");
    expect(draftStream.update).not.toHaveBeenCalledWith("Working..");
    expect(draftStream.update).not.toHaveBeenCalledWith("Working...");
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
      const updateBeforeStatusReaction = draftStream.update.mock.calls.at(-1)?.[0];
      releaseSetTool?.();
      await pendingToolStart;
      expect(updateBeforeStatusReaction).toMatch(/^Shelling\n`🛠️ Exec`$/);
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

    expect(draftStream.update).toHaveBeenCalledWith(
      "Shelling\n\n`🔎 Web Search: docs lookup`\n• `tests passed`",
    );
    expect(draftStream.forceNewMessage).toHaveBeenCalledTimes(1);
    expect(draftStream.materialize).not.toHaveBeenCalled();
    expect(draftStream.clear).toHaveBeenCalledTimes(1);
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

    expect(reasoningDraftStream.update).toHaveBeenCalledWith("Thinking\n\n_Thinking_");
    expect(answerDraftStream.update).toHaveBeenCalledWith("Answer");
    expect(deliverReplies).not.toHaveBeenCalled();
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

    expect(reasoningDraftStream.update).toHaveBeenLastCalledWith(
      "Thinking\n\n_Reading_\n\n_Checking_",
    );
    const updates = reasoningDraftStream.update.mock.calls.map((call) => call[0]);
    expect(updates.join("\n")).not.toContain("CheckingReading");
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

    expect(reasoningDraftStream.update).toHaveBeenCalledWith("Thinking\n\n_Thinking_");
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
      expect(reasoningDraftStream.update).toHaveBeenCalledWith("Thinking\n\n_Thinking_"),
    );
    expect(reasoningDraftStream.update).not.toHaveBeenCalledWith("Thinking.\n\n_Thinking_");
    expect(reasoningDraftStream.update).not.toHaveBeenCalledWith("Thinking..\n\n_Thinking_");
    expect(reasoningDraftStream.update).not.toHaveBeenCalledWith("Thinking...\n\n_Thinking_");
    finishRun?.();
    await run;
  });

  it("suppresses reasoning-only finals without raw text fallback", async () => {
    setupDraftStreams({ answerMessageId: 2001, reasoningMessageId: 3001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "<think>hidden</think>" }, { kind: "final" });
      return { queuedFinal: true };
    });

    await dispatchWithContext({ context: createContext() });

    expect(deliverReplies).not.toHaveBeenCalled();
    expect(editMessageTelegram).not.toHaveBeenCalled();
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

  it("clears delivered room-event history when a newer turn supersedes dispatch", async () => {
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

    expect(groupHistories.get(historyKey)).toHaveLength(0);
  });

  it("does not clear topic room-event history for a send to another topic", async () => {
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

  it("lets newer user requests abort active same-session dispatch", async () => {
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
      .mockImplementationOnce(async ({ replyOptions }) => {
        firstAbortSignal = replyOptions?.abortSignal;
        firstStarted?.();
        await firstGate;
        return {
          queuedFinal: false,
          counts: { block: 0, final: 0, tool: 0 },
        };
      })
      .mockImplementationOnce(async ({ dispatcherOptions }) => {
        secondStarted?.();
        await dispatcherOptions.deliver({ text: "fresh request answer" }, { kind: "final" });
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

    expect(firstAbortSignal?.aborted).toBe(true);
    releaseFirst?.();
    await Promise.all([firstPromise, secondPromise]);

    const deliveredTexts = deliverReplies.mock.calls.flatMap((call) =>
      ((call[0] as { replies?: Array<{ text?: string }> }).replies ?? []).map(
        (reply) => reply.text,
      ),
    );
    expect(deliveredTexts).toContain("fresh request answer");
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

  it("does not drop the first chunk of a long final after a generic lane rotation", async () => {
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

    expect(answerDraftStream.update).toHaveBeenCalledWith("A".repeat(4000));
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

    expect(mockCallArg(answerDraftStream.update)).toContain("Exec");
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

  it("finalizes a duplicate text-only block when no final follows", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "partial answer" });
        await dispatcherOptions.deliver({ text: "partial answer" }, { kind: "block" });
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
      content: "partial answer",
      messageId: 2001,
    });
    expectRecordFields(mockCallArg(recordOutboundMessageForPromptContext), {
      text: "partial answer",
      messageId: 2001,
    });
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
    let queuedLifecycle: { onEnqueued?: () => void; onComplete?: () => void } | undefined;
    dispatchReplyWithBufferedBlockDispatcher
      .mockImplementationOnce(async ({ replyOptions }) => {
        roomEventAbortSignal = replyOptions?.abortSignal;
        queuedLifecycle = replyOptions?.queuedFollowupLifecycle;
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
    });
    expect(roomEventAbortSignal?.aborted).toBe(false);

    await dispatchWithContext({
      context: createGroupContext("user_request", 100, "@bot answer now"),
      streamMode: "off",
    });

    expect(roomEventAbortSignal?.aborted).toBe(true);
    queuedLifecycle?.onComplete?.();
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
