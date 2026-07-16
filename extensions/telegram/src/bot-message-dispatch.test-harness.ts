import { expectDefined } from "@openclaw/normalization-core";
// Telegram tests cover bot message dispatch plugin behavior.
import type { Bot } from "grammy";
import {
  createPluginStateKeyedStoreForTests,
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeAll, beforeEach, describe, expect, vi } from "vitest";
import { resolveAutoTopicLabelConfig as resolveAutoTopicLabelConfigRuntime } from "./auto-topic-label-config.js";
import type { TelegramBotDeps } from "./bot-deps.js";
import {
  createSequencedTestDraftStream,
  createTestDraftStream,
} from "./draft-stream.test-helpers.js";
import { setTelegramRuntime } from "./runtime.js";
import {
  clearTelegramRuntimeForTest as clearTelegramRuntime,
  resetTelegramReplyFenceForTest as resetTelegramReplyFenceForTests,
} from "./runtime.test-support.js";
import type { TelegramRuntime } from "./runtime.types.js";

export type DispatchReplyWithBufferedBlockDispatcherArgs = Parameters<
  TelegramBotDeps["dispatchReplyWithBufferedBlockDispatcher"]
>[0];

export function requireInvocationOrder(
  mock: { mock: { invocationCallOrder: number[] } },
  index: number,
  context: string,
): number {
  return expectDefined(mock.mock.invocationCallOrder[index], context);
}

const createTelegramDraftStreamHoisted = vi.hoisted(() => vi.fn());
const dispatchReplyWithBufferedBlockDispatcherHoisted = vi.hoisted(() =>
  vi.fn<(params: DispatchReplyWithBufferedBlockDispatcherArgs) => Promise<unknown>>(),
);
const deliverRepliesHoisted = vi.hoisted(() => vi.fn());
const deliverInboundReplyWithMessageSendContextHoisted = vi.hoisted(() => vi.fn());
const emitInternalMessageSentHookHoisted = vi.hoisted(() => vi.fn());
const recordOutboundMessageForPromptContextHoisted = vi.hoisted(() => vi.fn());
const createForumTopicTelegramHoisted = vi.hoisted(() => vi.fn());
const deleteMessageTelegramHoisted = vi.hoisted(() => vi.fn());
const editForumTopicTelegramHoisted = vi.hoisted(() => vi.fn());
const editMessageTelegramHoisted = vi.hoisted(() => vi.fn());
const reactMessageTelegramHoisted = vi.hoisted(() => vi.fn());
const sendMessageTelegramHoisted = vi.hoisted(() => vi.fn());
const sendPollTelegramHoisted = vi.hoisted(() => vi.fn());
const sendStickerTelegramHoisted = vi.hoisted(() => vi.fn());
const loadConfigHoisted = vi.hoisted(() => vi.fn(() => ({})));
const readChannelAllowFromStoreHoisted = vi.hoisted(() => vi.fn(async () => []));
const upsertChannelPairingRequestHoisted = vi.hoisted(() =>
  vi.fn(async () => ({
    code: "PAIRCODE",
    created: true,
  })),
);
const enqueueSystemEventHoisted = vi.hoisted(() => vi.fn());
const buildModelsProviderDataHoisted = vi.hoisted(() =>
  vi.fn(async () => ({
    byProvider: new Map<string, Set<string>>(),
    providers: [],
    resolvedDefault: { provider: "openai", model: "gpt-test" },
    modelNames: new Map<string, string>(),
  })),
);
const listSkillCommandsForAgentsHoisted = vi.hoisted(() => vi.fn(() => []));
const createChannelMessageReplyPipelineHoisted = vi.hoisted(() =>
  vi.fn(() => ({
    responsePrefix: undefined,
    responsePrefixContextProvider: () => ({ identityName: undefined }),
    resolveResponsePrefix: () => undefined,
    onModelSelected: () => undefined,
  })),
);
const wasSentByBotHoisted = vi.hoisted(() => vi.fn(() => false));
const appendAssistantMirrorMessageByIdentityHoisted = vi.hoisted(() =>
  vi.fn<
    (
      params?: unknown,
    ) => Promise<
      | { ok: true; messageId: string }
      | { ok: false; reason: string; code?: "blocked" | "session-rebound" }
    >
  >(async () => ({
    ok: true,
    messageId: "m1",
  })),
);
const getSessionEntryHoisted = vi.hoisted(() => vi.fn());
const loadSessionStoreHoisted = vi.hoisted(() => vi.fn());
const readLatestAssistantTextByIdentityHoisted = vi.hoisted(() =>
  vi.fn<() => Promise<{ id?: string; text: string; timestamp?: number } | undefined>>(
    async () => undefined,
  ),
);
const resolveStorePathHoisted = vi.hoisted(() => vi.fn(() => "/tmp/sessions.json"));
const generateTopicLabelHoisted = vi.hoisted(() => vi.fn());
const describeStickerImageHoisted = vi.hoisted(() =>
  vi.fn(async (): Promise<string | null> => null),
);
const loadModelCatalogHoisted = vi.hoisted(() => vi.fn(async () => ({})));
const findModelInCatalogHoisted = vi.hoisted(() => vi.fn(() => null));
const modelSupportsVisionHoisted = vi.hoisted(() => vi.fn(() => false));
const resolveAgentDirHoisted = vi.hoisted(() => vi.fn(() => "/tmp/agent"));
const resolveDefaultModelForAgentHoisted = vi.hoisted(() =>
  vi.fn(() => ({ provider: "openai", model: "gpt-test" })),
);
const getAgentScopedMediaLocalRootsHoisted = vi.hoisted(() =>
  vi.fn((_cfg: unknown, agentId: string) => [`/tmp/.openclaw/workspace-${agentId}`]),
);
const resolveChunkModeHoisted = vi.hoisted(() => vi.fn(() => undefined));
const resolveMarkdownTableModeHoisted = vi.hoisted(() => vi.fn(() => "preserve"));

export const createTelegramDraftStream = createTelegramDraftStreamHoisted;
export const dispatchReplyWithBufferedBlockDispatcher =
  dispatchReplyWithBufferedBlockDispatcherHoisted;
export const deliverReplies = deliverRepliesHoisted;
export const deliverInboundReplyWithMessageSendContext =
  deliverInboundReplyWithMessageSendContextHoisted;
export const emitInternalMessageSentHook = emitInternalMessageSentHookHoisted;
export const recordOutboundMessageForPromptContext = recordOutboundMessageForPromptContextHoisted;
export const createForumTopicTelegram = createForumTopicTelegramHoisted;
export const deleteMessageTelegram = deleteMessageTelegramHoisted;
export const editForumTopicTelegram = editForumTopicTelegramHoisted;
export const editMessageTelegram = editMessageTelegramHoisted;
export const reactMessageTelegram = reactMessageTelegramHoisted;
export const sendMessageTelegram = sendMessageTelegramHoisted;
export const sendPollTelegram = sendPollTelegramHoisted;
export const sendStickerTelegram = sendStickerTelegramHoisted;
export const loadConfig = loadConfigHoisted;
export const readChannelAllowFromStore = readChannelAllowFromStoreHoisted;
export const upsertChannelPairingRequest = upsertChannelPairingRequestHoisted;
export const enqueueSystemEvent = enqueueSystemEventHoisted;
export const buildModelsProviderData = buildModelsProviderDataHoisted;
export const listSkillCommandsForAgents = listSkillCommandsForAgentsHoisted;
export const createChannelMessageReplyPipeline = createChannelMessageReplyPipelineHoisted;
export const wasSentByBot = wasSentByBotHoisted;
export const appendAssistantMirrorMessageByIdentity = appendAssistantMirrorMessageByIdentityHoisted;
export const getSessionEntry = getSessionEntryHoisted;
export const loadSessionStore = loadSessionStoreHoisted;
export const readLatestAssistantTextByIdentity = readLatestAssistantTextByIdentityHoisted;
export const resolveStorePath = resolveStorePathHoisted;
export const generateTopicLabel = generateTopicLabelHoisted;
export const describeStickerImage = describeStickerImageHoisted;
export const loadModelCatalog = loadModelCatalogHoisted;
export const findModelInCatalog = findModelInCatalogHoisted;
export const modelSupportsVision = modelSupportsVisionHoisted;
export const resolveAgentDir = resolveAgentDirHoisted;
export const resolveDefaultModelForAgent = resolveDefaultModelForAgentHoisted;
export const getAgentScopedMediaLocalRoots = getAgentScopedMediaLocalRootsHoisted;
export const resolveChunkMode = resolveChunkModeHoisted;
export const resolveMarkdownTableMode = resolveMarkdownTableModeHoisted;

vi.mock("./draft-stream.js", () => ({
  createTelegramDraftStream: createTelegramDraftStreamHoisted,
}));

vi.mock("openclaw/plugin-sdk/channel-outbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-outbound")>();
  return {
    ...actual,
    deliverInboundReplyWithMessageSendContext: deliverInboundReplyWithMessageSendContextHoisted,
  };
});

vi.mock("openclaw/plugin-sdk/session-transcript-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/session-transcript-runtime")>();
  return {
    ...actual,
    appendAssistantMirrorMessageByIdentity: appendAssistantMirrorMessageByIdentityHoisted,
    readLatestAssistantTextByIdentity: readLatestAssistantTextByIdentityHoisted,
  };
});

vi.mock("./bot/delivery.js", () => ({
  deliverReplies: deliverRepliesHoisted,
  emitInternalMessageSentHook: emitInternalMessageSentHookHoisted,
}));

vi.mock("./bot/delivery.replies.js", () => ({
  deliverReplies: deliverRepliesHoisted,
  emitInternalMessageSentHook: emitInternalMessageSentHookHoisted,
}));

vi.mock("./send.js", () => ({
  createForumTopicTelegram: createForumTopicTelegramHoisted,
  deleteMessageTelegram: deleteMessageTelegramHoisted,
  editForumTopicTelegram: editForumTopicTelegramHoisted,
  editMessageTelegram: editMessageTelegramHoisted,
  reactMessageTelegram: reactMessageTelegramHoisted,
  sendMessageTelegram: sendMessageTelegramHoisted,
  sendPollTelegram: sendPollTelegramHoisted,
  sendStickerTelegram: sendStickerTelegramHoisted,
}));

vi.mock("./bot-message-dispatch.runtime.js", () => ({
  generateTopicLabel: generateTopicLabelHoisted,
  getSessionEntry: getSessionEntryHoisted,
  getAgentScopedMediaLocalRoots: getAgentScopedMediaLocalRootsHoisted,
  resolveAutoTopicLabelConfig: resolveAutoTopicLabelConfigRuntime,
  resolveChunkMode: resolveChunkModeHoisted,
  resolveMarkdownTableMode: resolveMarkdownTableModeHoisted,
  resolveStorePath: resolveStorePathHoisted,
}));

vi.mock("./bot-message-dispatch.agent.runtime.js", () => ({
  findModelInCatalog: findModelInCatalogHoisted,
  loadModelCatalog: loadModelCatalogHoisted,
  modelSupportsVision: modelSupportsVisionHoisted,
  resolveAgentDir: resolveAgentDirHoisted,
  resolveDefaultModelForAgent: resolveDefaultModelForAgentHoisted,
}));

vi.mock("./sticker-cache.js", () => ({
  cacheSticker: vi.fn(),
  getCachedSticker: () => null,
  getCacheStats: () => ({ count: 0 }),
  searchStickers: () => [],
  getAllCachedStickers: () => [],
  describeStickerImage: describeStickerImageHoisted,
}));

export let dispatchTelegramMessage: typeof import("./bot-message-dispatch.js").dispatchTelegramMessage;

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

export const telegramDepsForTest: TelegramBotDeps = {
  getRuntimeConfig: loadConfig as TelegramBotDeps["getRuntimeConfig"],
  resolveStorePath: resolveStorePath as TelegramBotDeps["resolveStorePath"],
  getSessionEntry: getSessionEntry as TelegramBotDeps["getSessionEntry"],
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

export type TelegramMessageContext = Parameters<typeof dispatchTelegramMessage>[0]["context"];
export const trailingFinalStatusText = "Post-final plugin status";

async function loadTelegramDispatchForTests() {
  ({ dispatchTelegramMessage } = await import("./bot-message-dispatch.js"));
}

function resetTelegramDispatchTestState() {
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
}

function cleanupTelegramDispatchTestState() {
  clearTelegramRuntime();
  resetPluginStateStoreForTests();
}

export const createDraftStream = (messageId?: number) => createTestDraftStream({ messageId });
export const createSequencedDraftStream = (startMessageId = 1001) =>
  createSequencedTestDraftStream(startMessageId);

export function setupDraftStreams(params?: {
  answerMessageId?: number;
  reasoningMessageId?: number;
}) {
  const answerDraftStream = createDraftStream(params?.answerMessageId);
  const reasoningDraftStream = createDraftStream(params?.reasoningMessageId);
  createTelegramDraftStream
    .mockImplementationOnce(() => answerDraftStream)
    .mockImplementationOnce(() => reasoningDraftStream);
  return { answerDraftStream, reasoningDraftStream };
}

export function mockDefaultSessionEntry(entry: Record<string, unknown> = { sessionId: "s1" }) {
  loadSessionStore.mockReturnValue({
    "agent:default:telegram:direct:123": {
      updatedAt: 1,
      ...entry,
    },
  });
}

export function expectRecordFields(record: unknown, expected: Record<string, unknown>) {
  if (!record || typeof record !== "object") {
    throw new Error("Expected record");
  }
  const actual = record as Record<string, unknown>;
  for (const [key, value] of Object.entries(expected)) {
    expect(actual[key]).toEqual(value);
  }
  return actual;
}

export function mockCallArg(mock: ReturnType<typeof vi.fn>, callIndex = 0, argIndex = 0) {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected mock call ${callIndex}`);
  }
  return call[argIndex];
}

export function expectDraftStreamParams(expected: Record<string, unknown>) {
  return expectRecordFields(mockCallArg(createTelegramDraftStream), expected);
}

export function telegramProgressPreview(_plainText: string, html: string) {
  return {
    text: html.replaceAll("\n", "<br>"),
    parseMode: "HTML" as const,
  };
}

export function expectDeliverRepliesParams(expected: Record<string, unknown>, callIndex = 0) {
  return expectRecordFields(mockCallArg(deliverReplies, callIndex), expected);
}

export function expectDeliveredReply(
  index: number,
  expected: Record<string, unknown>,
  callIndex = 0,
) {
  const params = expectDeliverRepliesParams({}, callIndex);
  const replies = params.replies as Array<unknown> | undefined;
  if (!Array.isArray(replies)) {
    throw new Error("Expected delivered replies array");
  }
  return expectRecordFields(replies[index], expected);
}

export function allDeliveredReplyTexts(): string[] {
  return deliverReplies.mock.calls.flatMap((call: unknown[]) =>
    ((call[0] as { replies?: Array<{ text?: string }> }).replies ?? []).map(
      (reply) => reply.text ?? "",
    ),
  );
}

export function expectDispatchParams(expected: Record<string, unknown>) {
  return expectRecordFields(mockCallArg(dispatchReplyWithBufferedBlockDispatcher), expected);
}

// The collapse bar edits the live window message in place (finalizeToPreview)
// instead of deleting it and reposting the bar as a new message.
export function expectWindowCollapsedTo(
  stream: { finalizeToPreview: { mock: { calls: unknown[][] } } },
  barText: string,
) {
  const calls = stream.finalizeToPreview.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  const preview = calls.at(-1)?.[0] as { text?: string } | undefined;
  expect(preview?.text).toBe(barText);
}

export function createContext(overrides?: Partial<TelegramMessageContext>): TelegramMessageContext {
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

export function createStatusReactionController() {
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

export function createDirectSessionPayload(): TelegramMessageContext["ctxPayload"] {
  return {
    SessionKey: "agent:test:telegram:direct:123",
    ChatType: "direct",
  } as TelegramMessageContext["ctxPayload"];
}

export function observeDeliveredReply(text: string): Promise<void> {
  return new Promise((resolve) => {
    deliverReplies.mockImplementation(async (params: { replies?: Array<{ text?: string }> }) => {
      if (params.replies?.some((reply) => reply.text === text)) {
        resolve();
      }
      return { delivered: true };
    });
  });
}

export function createBot(): Bot {
  return {
    api: {
      sendMessage: vi.fn(async (_chatId, _text, params) => ({
        message_id: typeof params?.message_thread_id === "number" ? params.message_thread_id : 1001,
      })),
      editMessageText: vi.fn(async () => ({ message_id: 1001 })),
      deleteMessage: vi.fn().mockResolvedValue(true),
      editForumTopic: vi.fn().mockResolvedValue(true),
    },
  } as unknown as Bot;
}

export function createRuntime(): Parameters<typeof dispatchTelegramMessage>[0]["runtime"] {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: () => {
      throw new Error("exit");
    },
  };
}

export async function dispatchWithContext(params: {
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
  runtime?: Parameters<typeof dispatchTelegramMessage>[0]["runtime"];
}) {
  const bot = params.bot ?? createBot();
  return await dispatchTelegramMessage({
    context: params.context,
    bot,
    cfg: params.cfg ?? {},
    runtime: params.runtime ?? createRuntime(),
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

export function createReasoningStreamContext(): TelegramMessageContext {
  loadSessionStore.mockReturnValue({
    s1: { reasoningLevel: "stream" },
  });
  return createContext({
    ctxPayload: { SessionKey: "s1" } as unknown as TelegramMessageContext["ctxPayload"],
  });
}

export function createReasoningDefaultContext(): TelegramMessageContext {
  loadSessionStore.mockReturnValue({
    s1: {},
  });
  return createContext({
    ctxPayload: { SessionKey: "s1" } as unknown as TelegramMessageContext["ctxPayload"],
    route: { agentId: "ops" } as unknown as TelegramMessageContext["route"],
  });
}

export function createReasoningForumTopicContext(): TelegramMessageContext {
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

export function describeTelegramDispatch(name: string, registerTests: () => void): void {
  describe(name, () => {
    beforeAll(loadTelegramDispatchForTests);
    beforeEach(resetTelegramDispatchTestState);
    afterEach(cleanupTelegramDispatchTestState);
    registerTests();
  });
}

export type { Bot, TelegramBotDeps };
