import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import type { MockFn } from "openclaw/plugin-sdk/plugin-test-runtime";
import type { GetReplyOptions, MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import { beforeEach, vi } from "vitest";
import type { TelegramBotDeps } from "./bot-deps.js";

type AnyMock = ReturnType<typeof vi.fn>;
type AnyAsyncMock = ReturnType<typeof vi.fn>;
type GetRuntimeConfigFn =
  typeof import("openclaw/plugin-sdk/runtime-config-snapshot").getRuntimeConfig;
type LoadSessionStoreFn =
  typeof import("openclaw/plugin-sdk/session-store-runtime").loadSessionStore;
type ResolveStorePathFn =
  typeof import("openclaw/plugin-sdk/session-store-runtime").resolveStorePath;
type SessionStore = ReturnType<LoadSessionStoreFn>;
type TelegramBotRuntimeForTest = NonNullable<
  Parameters<typeof import("./bot.js").setTelegramBotRuntimeForTest>[0]
>;
type DispatchReplyWithBufferedBlockDispatcherFn =
  typeof import("openclaw/plugin-sdk/reply-dispatch-runtime").dispatchReplyWithBufferedBlockDispatcher;
type DispatchReplyWithBufferedBlockDispatcherResult = Awaited<
  ReturnType<DispatchReplyWithBufferedBlockDispatcherFn>
>;
type DispatchReplyHarnessParams = Parameters<DispatchReplyWithBufferedBlockDispatcherFn>[0];
type ReplyPayloadLike = {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  replyToId?: string;
};

const { sessionStorePath } = vi.hoisted(() => ({
  sessionStorePath: `/tmp/openclaw-telegram-${process.pid}-${process.env.VITEST_POOL_ID ?? "0"}.json`,
}));

const { loadWebMedia } = vi.hoisted((): { loadWebMedia: AnyMock } => ({
  loadWebMedia: vi.fn(),
}));

export function getLoadWebMediaMock(): AnyMock {
  return loadWebMedia;
}

vi.mock("openclaw/plugin-sdk/web-media", () => ({
  loadWebMedia,
}));

const { getRuntimeConfig, loadSessionStoreMock, resolveStorePathMock, sessionStoreEntries } =
  vi.hoisted(
    (): {
      getRuntimeConfig: MockFn<GetRuntimeConfigFn>;
      loadSessionStoreMock: MockFn<LoadSessionStoreFn>;
      resolveStorePathMock: MockFn<ResolveStorePathFn>;
      sessionStoreEntries: { value: SessionStore };
    } => ({
      getRuntimeConfig: vi.fn<GetRuntimeConfigFn>(() => ({})),
      loadSessionStoreMock: vi.fn<LoadSessionStoreFn>(
        (_storePath, _opts) => sessionStoreEntries.value,
      ),
      resolveStorePathMock: vi.fn<ResolveStorePathFn>(
        (storePath?: string) => storePath ?? sessionStorePath,
      ),
      sessionStoreEntries: { value: {} as SessionStore },
    }),
  );

export function getLoadConfigMock(): AnyMock {
  return getRuntimeConfig;
}

export function getLoadSessionStoreMock(): AnyMock {
  return loadSessionStoreMock;
}

export function setSessionStoreEntriesForTest(entries: SessionStore) {
  sessionStoreEntries.value = structuredClone(entries);
}

const { readChannelAllowFromStore, upsertChannelPairingRequest } = vi.hoisted(
  (): {
    readChannelAllowFromStore: MockFn<TelegramBotDeps["readChannelAllowFromStore"]>;
    upsertChannelPairingRequest: AnyAsyncMock;
  } => ({
    readChannelAllowFromStore: vi.fn(async () => [] as string[]),
    upsertChannelPairingRequest: vi.fn(async () => ({
      code: "PAIRCODE",
      created: true,
    })),
  }),
);

export function getReadChannelAllowFromStoreMock(): AnyAsyncMock {
  return readChannelAllowFromStore;
}

export function getUpsertChannelPairingRequestMock(): AnyAsyncMock {
  return upsertChannelPairingRequest;
}

const skillCommandListHoisted = vi.hoisted(() => ({
  listSkillCommandsForAgents: vi.fn(() => []),
}));
const modelProviderDataHoisted = vi.hoisted(() => ({
  buildModelsProviderData: vi.fn(),
}));
const replySpyHoisted = vi.hoisted(() => ({
  replySpy: vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
    await opts?.onReplyStart?.();
    return undefined;
  }) as MockFn<
    (
      ctx: MsgContext,
      opts?: GetReplyOptions,
      configOverride?: OpenClawConfig,
    ) => Promise<ReplyPayloadLike | ReplyPayloadLike[] | undefined>
  >,
}));

async function dispatchHarnessReplies(
  params: DispatchReplyHarnessParams,
  runReply: (
    params: DispatchReplyHarnessParams,
  ) => Promise<ReplyPayloadLike | ReplyPayloadLike[] | undefined>,
): Promise<DispatchReplyWithBufferedBlockDispatcherResult> {
  await params.dispatcherOptions.typingCallbacks?.onReplyStart?.();
  const reply = await runReply(params);
  const payloads: ReplyPayloadLike[] =
    reply === undefined ? [] : Array.isArray(reply) ? reply : [reply];
  let finalCount = 0;
  for (const payload of payloads) {
    const text =
      typeof payload.text === "string" &&
      params.dispatcherOptions.responsePrefix &&
      !payload.text.startsWith(params.dispatcherOptions.responsePrefix)
        ? `${params.dispatcherOptions.responsePrefix} ${payload.text}`
        : payload.text;
    const finalPayload = text === payload.text ? payload : { ...payload, text };
    try {
      await params.dispatcherOptions.deliver?.(finalPayload, { kind: "final" });
      finalCount += 1;
    } catch (err) {
      params.dispatcherOptions.onError?.(err, { kind: "final" });
    }
  }
  return {
    queuedFinal: finalCount > 0,
    counts: {
      block: 0,
      final: finalCount,
      tool: 0,
    },
  };
}

const dispatchReplyHoisted = vi.hoisted(() => ({
  dispatchReplyWithBufferedBlockDispatcher: vi.fn<DispatchReplyWithBufferedBlockDispatcherFn>(
    async (params: DispatchReplyHarnessParams) =>
      await dispatchHarnessReplies(params, async (dispatchParams) => {
        return await replySpyHoisted.replySpy(dispatchParams.ctx, dispatchParams.replyOptions);
      }),
  ),
}));
export const listSkillCommandsForAgents = skillCommandListHoisted.listSkillCommandsForAgents;
const buildModelsProviderData = modelProviderDataHoisted.buildModelsProviderData;
export const replySpy = replySpyHoisted.replySpy;
export const dispatchReplyWithBufferedBlockDispatcher =
  dispatchReplyHoisted.dispatchReplyWithBufferedBlockDispatcher;
const menuSyncHoisted = vi.hoisted(() => ({
  syncTelegramMenuCommands: vi.fn(async ({ bot, commandsToRegister }) => {
    await bot.api.setMyCommands(commandsToRegister);
  }),
}));
export const syncTelegramMenuCommands = menuSyncHoisted.syncTelegramMenuCommands;

function parseModelRef(raw: string): { provider?: string; model: string } {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { model: "" };
  }
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex > 0 && slashIndex < trimmed.length - 1) {
    return {
      provider: trimmed.slice(0, slashIndex),
      model: trimmed.slice(slashIndex + 1),
    };
  }
  return { model: trimmed };
}

function normalizeLowercaseStringOrEmptyForTest(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function resolveDefaultModelForAgentForTest(params: { cfg: OpenClawConfig }): {
  provider: string;
  model: string;
} {
  const modelConfig = params.cfg.agents?.defaults?.model;
  const rawModel =
    typeof modelConfig === "string" ? modelConfig : (modelConfig?.primary ?? "openai/gpt-5.4");
  const parsed = parseModelRef(rawModel);
  const provider = normalizeLowercaseStringOrEmptyForTest(parsed.provider) || "openai";
  return {
    provider: provider === "bedrock" ? "amazon-bedrock" : provider,
    model: parsed.model || "gpt-5.4",
  };
}

function createModelsProviderDataFromConfig(cfg: OpenClawConfig): {
  byProvider: Map<string, Set<string>>;
  providers: string[];
  resolvedDefault: { provider: string; model: string };
  modelNames: Map<string, string>;
} {
  const byProvider = new Map<string, Set<string>>();
  const add = (providerRaw: string | undefined, modelRaw: string | undefined) => {
    const provider = normalizeLowercaseStringOrEmptyForTest(providerRaw);
    const model = modelRaw?.trim();
    if (!provider || !model) {
      return;
    }
    const existing = byProvider.get(provider) ?? new Set<string>();
    existing.add(model);
    byProvider.set(provider, existing);
  };

  const resolvedDefault = resolveDefaultModelForAgentForTest({ cfg });
  add(resolvedDefault.provider, resolvedDefault.model);

  for (const raw of Object.keys(cfg.agents?.defaults?.models ?? {})) {
    const parsed = parseModelRef(raw);
    add(parsed.provider ?? resolvedDefault.provider, parsed.model);
  }

  const providers = [...byProvider.keys()].toSorted();
  return { byProvider, providers, resolvedDefault, modelNames: new Map<string, string>() };
}

const systemEventsHoisted = vi.hoisted(() => ({
  enqueueSystemEventSpy: vi.fn<TelegramBotDeps["enqueueSystemEvent"]>(() => false),
}));
export const enqueueSystemEventSpy: MockFn<TelegramBotDeps["enqueueSystemEvent"]> =
  systemEventsHoisted.enqueueSystemEventSpy;
const execApprovalHoisted = vi.hoisted(() => ({
  resolveExecApprovalSpy: vi.fn(async () => undefined),
}));
export const resolveExecApprovalSpy = execApprovalHoisted.resolveExecApprovalSpy;

const sentMessageCacheHoisted = vi.hoisted(() => ({
  wasSentByBot: vi.fn(() => false),
}));
export const wasSentByBot = sentMessageCacheHoisted.wasSentByBot;

vi.doMock("./sent-message-cache.js", () => ({
  wasSentByBot: sentMessageCacheHoisted.wasSentByBot,
  recordSentMessage: vi.fn(),
  clearSentMessageCache: vi.fn(),
}));

// All spy variables used inside vi.mock("grammy", ...) must be created via
// vi.hoisted() so they are available when the hoisted factory runs, regardless
// of module evaluation order across different test files.
const grammySpies = vi.hoisted(() => ({
  useSpy: vi.fn() as MockFn<(arg: unknown) => void>,
  middlewareUseSpy: vi.fn(),
  onSpy: vi.fn(),
  stopSpy: vi.fn(),
  commandSpy: vi.fn(),
  botCtorSpy: vi.fn((_: string, __?: { client?: { fetch?: typeof fetch } }) => undefined),
  answerCallbackQuerySpy: vi.fn(async () => undefined) as AnyAsyncMock,
  sendChatActionSpy: vi.fn(),
  editMessageTextSpy: vi.fn(async () => ({ message_id: 88 })) as AnyAsyncMock,
  editMessageReplyMarkupSpy: vi.fn(async () => ({ message_id: 88 })) as AnyAsyncMock,
  setMessageReactionSpy: vi.fn(async () => undefined) as AnyAsyncMock,
  setMyCommandsSpy: vi.fn(async () => undefined) as AnyAsyncMock,
  getMeSpy: vi.fn(async () => ({
    username: "openclaw_bot",
    has_topics_enabled: true,
  })) as AnyAsyncMock,
  getChatSpy: vi.fn(async () => undefined) as AnyAsyncMock,
  sendMessageSpy: vi.fn(async () => ({ message_id: 77 })) as AnyAsyncMock,
  sendAnimationSpy: vi.fn(async () => ({ message_id: 78 })) as AnyAsyncMock,
  sendPhotoSpy: vi.fn(async () => ({ message_id: 79 })) as AnyAsyncMock,
  getFileSpy: vi.fn(async () => ({ file_path: "media/file.jpg" })) as AnyAsyncMock,
}));

export const useSpy: MockFn<(arg: unknown) => void> = grammySpies.useSpy;
export const middlewareUseSpy: AnyMock = grammySpies.middlewareUseSpy;
export const onSpy: AnyMock = grammySpies.onSpy;
export const stopSpy: AnyMock = grammySpies.stopSpy;
export const commandSpy: AnyMock = grammySpies.commandSpy;
export const botCtorSpy: MockFn<
  (token: string, options?: { client?: { fetch?: typeof fetch } }) => void
> = grammySpies.botCtorSpy;
export const answerCallbackQuerySpy: AnyAsyncMock = grammySpies.answerCallbackQuerySpy;
export const sendChatActionSpy: AnyMock = grammySpies.sendChatActionSpy;
export const editMessageTextSpy: AnyAsyncMock = grammySpies.editMessageTextSpy;
export const editMessageReplyMarkupSpy: AnyAsyncMock = grammySpies.editMessageReplyMarkupSpy;
export const setMessageReactionSpy: AnyAsyncMock = grammySpies.setMessageReactionSpy;
export const setMyCommandsSpy: AnyAsyncMock = grammySpies.setMyCommandsSpy;
export const getMeSpy: AnyAsyncMock = grammySpies.getMeSpy;
export const getChatSpy: AnyAsyncMock = grammySpies.getChatSpy;
export const sendMessageSpy: AnyAsyncMock = grammySpies.sendMessageSpy;
export const sendAnimationSpy: AnyAsyncMock = grammySpies.sendAnimationSpy;
export const sendPhotoSpy: AnyAsyncMock = grammySpies.sendPhotoSpy;
export const getFileSpy: AnyAsyncMock = grammySpies.getFileSpy;

const runnerHoisted = vi.hoisted(() => ({
  sequentializeMiddleware: vi.fn(async (_ctx: unknown, next?: () => Promise<void>) => {
    if (typeof next === "function") {
      await next();
    }
  }),
  sequentializeSpy: vi.fn(() => runnerHoisted.sequentializeMiddleware),
  throttlerSpy: vi.fn(() => "throttler"),
}));
export const sequentializeSpy: AnyMock = runnerHoisted.sequentializeSpy;
export let sequentializeKey: ((ctx: unknown) => string) | undefined;
export const throttlerSpy: AnyMock = runnerHoisted.throttlerSpy;
export const telegramBotRuntimeForTest: TelegramBotRuntimeForTest = {
  Bot: class {
    api = {
      config: { use: grammySpies.useSpy },
      answerCallbackQuery: grammySpies.answerCallbackQuerySpy,
      sendChatAction: grammySpies.sendChatActionSpy,
      editMessageText: grammySpies.editMessageTextSpy,
      editMessageReplyMarkup: grammySpies.editMessageReplyMarkupSpy,
      setMessageReaction: grammySpies.setMessageReactionSpy,
      setMyCommands: grammySpies.setMyCommandsSpy,
      getMe: grammySpies.getMeSpy,
      getChat: grammySpies.getChatSpy,
      sendMessage: grammySpies.sendMessageSpy,
      sendAnimation: grammySpies.sendAnimationSpy,
      sendPhoto: grammySpies.sendPhotoSpy,
      getFile: grammySpies.getFileSpy,
    };
    use = grammySpies.middlewareUseSpy;
    on = grammySpies.onSpy;
    stop = grammySpies.stopSpy;
    command = grammySpies.commandSpy;
    catch = vi.fn();
    constructor(
      public token: string,
      public options?: { client?: { fetch?: typeof fetch } },
    ) {
      (grammySpies.botCtorSpy as unknown as (token: string, options?: unknown) => void)(
        token,
        options,
      );
    }
  } as unknown as TelegramBotRuntimeForTest["Bot"],
  sequentialize: ((keyFn: (ctx: unknown) => string) => {
    sequentializeKey = keyFn;
    return (
      runnerHoisted.sequentializeSpy as unknown as () => ReturnType<
        TelegramBotRuntimeForTest["sequentialize"]
      >
    )();
  }) as unknown as TelegramBotRuntimeForTest["sequentialize"],
  apiThrottler: (() =>
    (
      runnerHoisted.throttlerSpy as unknown as () => unknown
    )()) as unknown as TelegramBotRuntimeForTest["apiThrottler"],
};
export const telegramBotDepsForTest: TelegramBotDeps = {
  getRuntimeConfig,
  loadSessionStore: loadSessionStoreMock as TelegramBotDeps["loadSessionStore"],
  resolveStorePath: resolveStorePathMock,
  readChannelAllowFromStore:
    readChannelAllowFromStore as TelegramBotDeps["readChannelAllowFromStore"],
  upsertChannelPairingRequest:
    upsertChannelPairingRequest as TelegramBotDeps["upsertChannelPairingRequest"],
  enqueueSystemEvent: enqueueSystemEventSpy as TelegramBotDeps["enqueueSystemEvent"],
  dispatchReplyWithBufferedBlockDispatcher,
  loadWebMedia: loadWebMedia as TelegramBotDeps["loadWebMedia"],
  buildModelsProviderData: buildModelsProviderData as TelegramBotDeps["buildModelsProviderData"],
  listSkillCommandsForAgents:
    listSkillCommandsForAgents as TelegramBotDeps["listSkillCommandsForAgents"],
  syncTelegramMenuCommands: syncTelegramMenuCommands as TelegramBotDeps["syncTelegramMenuCommands"],
  wasSentByBot: wasSentByBot as TelegramBotDeps["wasSentByBot"],
  resolveExecApproval: resolveExecApprovalSpy as NonNullable<
    TelegramBotDeps["resolveExecApproval"]
  >,
};

vi.doMock("./bot.runtime.js", () => telegramBotRuntimeForTest);

export const getOnHandler = (event: string) => {
  const handler = onSpy.mock.calls.find((call) => call[0] === event)?.[1];
  if (!handler) {
    throw new Error(`Missing handler for event: ${event}`);
  }
  return handler as (ctx: Record<string, unknown>) => Promise<void>;
};

const DEFAULT_TELEGRAM_TEST_CONFIG: OpenClawConfig = {
  agents: {
    defaults: {
      envelopeTimezone: "utc",
    },
  },
  channels: {
    telegram: { dmPolicy: "open", allowFrom: ["*"] },
  },
};

export function makeTelegramMessageCtx(params: {
  chat: {
    id: number;
    type: string;
    title?: string;
    is_forum?: boolean;
  };
  from: { id: number; username?: string };
  text: string;
  date?: number;
  messageId?: number;
  messageThreadId?: number;
}) {
  return {
    message: {
      chat: params.chat,
      from: params.from,
      text: params.text,
      date: params.date ?? 1736380800,
      message_id: params.messageId ?? 42,
      ...(params.messageThreadId === undefined
        ? {}
        : { message_thread_id: params.messageThreadId }),
    },
    me: { username: "openclaw_bot" },
    getFile: async () => ({ download: async () => new Uint8Array() }),
  };
}

export function makeForumGroupMessageCtx(params?: {
  chatId?: number;
  threadId?: number;
  text?: string;
  fromId?: number;
  username?: string;
  title?: string;
}) {
  return makeTelegramMessageCtx({
    chat: {
      id: params?.chatId ?? -1001234567890,
      type: "supergroup",
      title: params?.title ?? "Forum Group",
      is_forum: true,
    },
    from: { id: params?.fromId ?? 12345, username: params?.username ?? "testuser" },
    text: params?.text ?? "hello",
    messageThreadId: params?.threadId,
  });
}

beforeEach(() => {
  getRuntimeConfig.mockReset();
  getRuntimeConfig.mockReturnValue(DEFAULT_TELEGRAM_TEST_CONFIG);
  sessionStoreEntries.value = {};
  loadSessionStoreMock.mockReset();
  loadSessionStoreMock.mockImplementation(() => sessionStoreEntries.value);
  resolveStorePathMock.mockReset();
  resolveStorePathMock.mockImplementation((storePath?: string) => storePath ?? sessionStorePath);
  loadWebMedia.mockReset();
  readChannelAllowFromStore.mockReset();
  readChannelAllowFromStore.mockResolvedValue([]);
  upsertChannelPairingRequest.mockReset();
  upsertChannelPairingRequest.mockResolvedValue({ code: "PAIRCODE", created: true } as const);
  onSpy.mockReset();
  commandSpy.mockReset();
  stopSpy.mockReset();
  useSpy.mockReset();
  replySpy.mockReset();
  replySpy.mockImplementation(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
    await opts?.onReplyStart?.();
    return undefined;
  });
  resolveExecApprovalSpy.mockReset();
  resolveExecApprovalSpy.mockResolvedValue(undefined);
  dispatchReplyWithBufferedBlockDispatcher.mockReset();
  dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
    async (params: DispatchReplyHarnessParams) =>
      await dispatchHarnessReplies(params, async (dispatchParams) => {
        return await replySpy(dispatchParams.ctx, dispatchParams.replyOptions);
      }),
  );
  syncTelegramMenuCommands.mockReset();
  syncTelegramMenuCommands.mockImplementation(async ({ bot, commandsToRegister }) => {
    await bot.api.setMyCommands(commandsToRegister);
  });

  sendAnimationSpy.mockReset();
  sendAnimationSpy.mockResolvedValue({ message_id: 78 });
  sendPhotoSpy.mockReset();
  sendPhotoSpy.mockResolvedValue({ message_id: 79 });
  sendMessageSpy.mockReset();
  sendMessageSpy.mockResolvedValue({ message_id: 77 });
  getFileSpy.mockReset();
  getFileSpy.mockResolvedValue({ file_path: "media/file.jpg" });

  setMessageReactionSpy.mockReset();
  setMessageReactionSpy.mockResolvedValue(undefined);
  answerCallbackQuerySpy.mockReset();
  answerCallbackQuerySpy.mockResolvedValue(undefined);
  sendChatActionSpy.mockReset();
  sendChatActionSpy.mockResolvedValue(undefined);
  setMyCommandsSpy.mockReset();
  setMyCommandsSpy.mockResolvedValue(undefined);
  getChatSpy.mockReset();
  getChatSpy.mockResolvedValue(undefined);
  getMeSpy.mockReset();
  getMeSpy.mockResolvedValue({
    username: "openclaw_bot",
    has_topics_enabled: true,
  });
  editMessageTextSpy.mockReset();
  editMessageTextSpy.mockResolvedValue({ message_id: 88 });
  editMessageReplyMarkupSpy.mockReset();
  editMessageReplyMarkupSpy.mockResolvedValue({ message_id: 88 });
  enqueueSystemEventSpy.mockReset();
  wasSentByBot.mockReset();
  wasSentByBot.mockReturnValue(false);
  listSkillCommandsForAgents.mockReset();
  listSkillCommandsForAgents.mockReturnValue([]);
  buildModelsProviderData.mockReset();
  buildModelsProviderData.mockImplementation(async (cfg: OpenClawConfig) => {
    return createModelsProviderDataFromConfig(cfg);
  });
  middlewareUseSpy.mockReset();
  runnerHoisted.sequentializeMiddleware.mockReset();
  runnerHoisted.sequentializeMiddleware.mockImplementation(async (_ctx, next) => {
    if (typeof next === "function") {
      await next();
    }
  });
  sequentializeSpy.mockReset();
  sequentializeSpy.mockImplementation(() => runnerHoisted.sequentializeMiddleware);
  botCtorSpy.mockReset();
  sequentializeKey = undefined;
});
