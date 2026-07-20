import fs from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  clearPluginInteractiveHandlers,
  registerPluginInteractiveHandler,
} from "openclaw/plugin-sdk/plugin-runtime";
import {
  closeOpenClawStateDatabaseForTest,
  createPluginStateKeyedStoreForTests,
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import { listSessionEntries, upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { mockPinnedHostnameResolution } from "openclaw/plugin-sdk/test-env";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTelegramApprovalCallbackData } from "./approval-callback-data.js";
import {
  resolveTelegramConversationBaseSessionKey,
  resolveTelegramConversationRoute,
} from "./conversation-route.js";
import type {
  TelegramInteractiveHandlerContext,
  TelegramInteractiveHandlerRegistration,
} from "./interactive-dispatch.js";
import {
  resolveTelegramMessageCachePersistentScopeKey,
  resolveTelegramMessageCacheScope,
  TELEGRAM_MESSAGE_CACHE_PERSISTENT_MAX_MESSAGES,
  TELEGRAM_MESSAGE_CACHE_PERSISTENT_NAMESPACE,
} from "./message-cache.js";
import { buildTelegramOpaqueCallbackData } from "./native-command-callback-data.js";
import { setTelegramRuntime } from "./runtime.js";
import { clearTelegramRuntimeForTest as clearTelegramRuntime } from "./runtime.test-support.js";
import type { TelegramRuntime } from "./runtime.types.js";

const questionGatewayHoisted = vi.hoisted(() => ({
  resolveQuestionOverGatewaySpy: vi.fn(async () => ({
    status: "answered" as const,
    questionId: "target",
    optionValue: "Production",
  })),
}));

vi.mock("openclaw/plugin-sdk/question-gateway-runtime", () => ({
  questionGatewayRuntime: {
    resolveOption: questionGatewayHoisted.resolveQuestionOverGatewaySpy,
  },
}));

vi.mock("openclaw/plugin-sdk/channel-inbound", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/channel-inbound")>(
    "openclaw/plugin-sdk/channel-inbound",
  );
  type RunParams = Parameters<typeof actual.runChannelInboundEvent>[0];
  return {
    ...actual,
    runChannelInboundEvent: async (params: RunParams) => {
      // This file's turn tests were authored against the injected harness
      // dispatcher. Assembled turns now dispatch through core's own provider
      // dispatcher, which an extension test cannot intercept; convert each
      // resolved turn to a prepared one that drives the harness dispatcher,
      // while leaving the outer runner as the sole lifecycle owner.
      const harness = await import("./bot.create-telegram-bot.test-harness.js");
      const resolveTurn = params.adapter.resolveTurn;
      return await actual.runChannelInboundEvent({
        ...params,
        adapter: {
          ...params.adapter,
          resolveTurn: async (input, eventClass, preflight) => {
            const resolved = await resolveTurn(input, eventClass, preflight);
            if (!("route" in resolved) || "runDispatch" in resolved) {
              return resolved;
            }
            const plan: import("openclaw/plugin-sdk/channel-inbound").ChannelInboundTurnPlan =
              resolved;
            const prepared: Awaited<ReturnType<typeof resolveTurn>> = {
              ...plan,
              runDispatch: async () =>
                await harness.dispatchReplyWithBufferedBlockDispatcher({
                  ctx: plan.ctxPayload,
                  cfg: plan.cfg,
                  dispatcherOptions: {
                    ...plan.dispatcherOptions,
                    deliver: plan.delivery.deliver,
                    onError: plan.delivery.onError,
                  },
                  toolsAllow: plan.toolsAllow,
                  replyOptions: plan.replyOptions,
                  replyResolver: plan.replyResolver,
                }),
              // Prepared dispatch owns the outer durable-ingress lifecycle. If
              // core suppresses dispatch, release that claim instead of orphaning it.
              runDispatchLifecycle: {
                turnAdoptionLifecycle: params.turnAdoptionLifecycle,
                onDispatchSkipped: () => params.turnAdoptionLifecycle?.onAbandoned?.(),
              },
            };
            return prepared;
          },
        },
      });
    },
  };
});

const {
  answerCallbackQuerySpy,
  commandSpy,
  deleteMessageSpy,
  dispatchReplyWithBufferedBlockDispatcher,
  editMessageReplyMarkupSpy,
  editMessageTextSpy,
  enqueueSystemEventSpy,
  getFileSpy,
  getChatSpy,
  getLoadConfigMock,
  getLoadWebMediaMock,
  getReadChannelAllowFromStoreMock,
  getOnHandler,
  listSkillCommandsForAgents,
  onSpy,
  replySpy,
  resolveExecApprovalSpy,
  sendMessageSpy,
  setMyCommandsSpy,
  telegramBotDepsForTest,
  wasSentByBot,
} = await import("./bot.create-telegram-bot.test-harness.js");
const { recordOutboundMessageForPromptContext } = await import("./outbound-message-context.js");
const { runWithTelegramSpooledReplayUpdate, runWithTelegramUpdateProcessingFrame } =
  await import("./bot-processing-outcome.js");

let createTelegramBotBase: typeof import("./bot-core.js").createTelegramBotCore;
let createTelegramBot: (
  opts: import("./bot.types.js").TelegramBotOptions,
) => ReturnType<typeof import("./bot-core.js").createTelegramBotCore>;

const loadConfig = getLoadConfigMock();
const loadWebMedia = getLoadWebMediaMock();
const readChannelAllowFromStore = getReadChannelAllowFromStoreMock();
const PUZZLE_EMOJI = "\u{1F9E9}";
const INFO_EMOJI = "\u{2139}\u{FE0F}";
const CHECK_MARK_EMOJI = "\u{2705}";
const THUMBS_UP_EMOJI = "\u{1F44D}";
const FIRE_EMOJI = "\u{1F525}";
const PARTY_EMOJI = "\u{1F389}";
const EYES_EMOJI = "\u{1F440}";
const HEART_EMOJI = "\u{2764}\u{FE0F}";

async function withTelegramSpooledReplayUpdate<T>(
  update: object,
  fn: () => Promise<T>,
): Promise<T> {
  return (await runWithTelegramSpooledReplayUpdate(update, fn)).value;
}

function createSignal() {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  if (!resolve) {
    throw new Error("Expected Telegram bot signal resolver to be initialized");
  }
  return { promise, resolve };
}

function waitForReplyCalls(count: number) {
  const done = createSignal();
  let seen = 0;
  replySpy.mockImplementation(async (_ctx, opts) => {
    await opts?.onReplyStart?.();
    seen += 1;
    if (seen >= count) {
      done.resolve();
    }
    return undefined;
  });
  return done.promise;
}

function setTelegramPluginStateRuntimeForTests() {
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

function getTelegramCallbackHandlerForTests() {
  return getOnHandler("callback_query") as (ctx: Record<string, unknown>) => Promise<void>;
}

async function loadEnvelopeTimestampHelpers() {
  return await import("openclaw/plugin-sdk/channel-test-helpers");
}

async function loadInboundContextContract() {
  return await import("./test-support/inbound-context-contract.js");
}

type MockCallSource = {
  mock: {
    calls: ReadonlyArray<ReadonlyArray<unknown>>;
  };
};

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error(`expected ${label}`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): unknown[] {
  expect(Array.isArray(value), label).toBe(true);
  return value as unknown[];
}

function mockArg(source: MockCallSource, callIndex: number, argIndex: number, label: string) {
  const call = source.mock.calls[callIndex];
  if (!call) {
    throw new Error(`expected mock call: ${label}`);
  }
  return call[argIndex];
}

function mockCall(source: MockCallSource, callIndex: number, label: string) {
  const call = source.mock.calls[callIndex];
  if (!call) {
    throw new Error(`expected mock call: ${label}`);
  }
  return call;
}

function firstEditMessageTextArg(argIndex: number) {
  return mockArg(editMessageTextSpy as unknown as MockCallSource, 0, argIndex, "edit message text");
}

function firstSystemEventArg(argIndex: number) {
  return mockArg(enqueueSystemEventSpy as unknown as MockCallSource, 0, argIndex, "system event");
}

function mockMsgContextArg(
  source: MockCallSource,
  callIndex: number,
  argIndex: number,
  label: string,
): MsgContext {
  return mockArg(source, callIndex, argIndex, label) as MsgContext;
}

type DirectTelegramTranscriptTestMessage = {
  id: string;
  role: "assistant" | "user";
  text: string;
  timestamp: number;
};

function readOnlySessionEntry(storePath: string) {
  return listSessionEntries({ storePath })[0]?.entry;
}

async function writeDirectTelegramTranscriptMessages(params: {
  cfg: OpenClawConfig;
  storePath: string;
  chatId: number;
  senderId: number;
  sessionId: string;
  messages: DirectTelegramTranscriptTestMessage[];
}) {
  const route = resolveTelegramConversationRoute({
    cfg: params.cfg,
    accountId: "default",
    chatId: params.chatId,
    isGroup: false,
    senderId: params.senderId,
  }).route;
  const sessionKey = resolveTelegramConversationBaseSessionKey({
    cfg: params.cfg,
    route,
    chatId: params.chatId,
    isGroup: false,
    senderId: params.senderId,
  });
  await upsertSessionEntry({
    storePath: params.storePath,
    sessionKey,
    entry: {
      sessionId: params.sessionId,
      chatType: "direct",
      channel: "telegram",
      updatedAt: 1,
    },
  });
  for (const message of params.messages) {
    await appendSessionTranscriptMessageByIdentity({
      agentId: "main",
      storePath: params.storePath,
      sessionId: params.sessionId,
      sessionKey,
      message: {
        role: message.role,
        content: message.text,
        timestamp: message.timestamp,
      },
      eventId: message.id,
    });
  }
}

async function writeDirectTelegramTranscriptContext(params: {
  cfg: OpenClawConfig;
  storePath: string;
  chatId: number;
  role?: "assistant" | "user";
  senderId: number;
  sessionId: string;
  text: string;
  timestamp: number;
}) {
  const role = params.role ?? "user";
  await writeDirectTelegramTranscriptMessages({
    ...params,
    messages: [
      {
        id: role === "assistant" ? "transcript-assistant-1" : "transcript-user-1",
        role,
        text: params.text,
        timestamp: params.timestamp,
      },
    ],
  });
}

function latestConversationContextMessages(): Record<string, unknown>[] {
  const payload = mockMsgContextArg(
    replySpy as unknown as MockCallSource,
    replySpy.mock.calls.length - 1,
    0,
    "replySpy call",
  );
  const [conversationContext] = requireArray(
    payload.UntrustedStructuredContext,
    "structured context",
  );
  const contextPayload = requireRecord(
    requireRecord(conversationContext, "conversation context").payload,
    "conversation context payload",
  );
  return requireArray(contextPayload.messages, "conversation context messages").map(
    (message, index) => requireRecord(message, `conversation context message ${index + 1}`),
  );
}

async function seedTelegramPromptContextMessages(params: {
  storePath: string;
  chatId: number;
  messages: Array<{
    messageId: number;
    text: string;
    date: number;
    legacyPromptContextTimestampMs?: number;
    projection?: unknown;
    unversioned?: boolean;
  }>;
}) {
  setTelegramPluginStateRuntimeForTests();
  const store = createPluginStateKeyedStoreForTests("telegram", {
    namespace: TELEGRAM_MESSAGE_CACHE_PERSISTENT_NAMESPACE,
    maxEntries: TELEGRAM_MESSAGE_CACHE_PERSISTENT_MAX_MESSAGES,
  });
  const scopeKey = resolveTelegramMessageCachePersistentScopeKey(
    resolveTelegramMessageCacheScope(params.storePath),
  );
  for (const message of params.messages) {
    await store.register(`${scopeKey}:default:${params.chatId}:${message.messageId}`, {
      ...(message.unversioned ? {} : { version: 1 }),
      sourceMessage: {
        chat: { id: params.chatId, type: "private" },
        date: message.date,
        from: { id: message.unversioned ? 0 : 999, is_bot: true, first_name: "OpenClaw" },
        message_id: message.messageId,
        text: message.text,
        ...(message.legacyPromptContextTimestampMs !== undefined
          ? {
              openclaw_prompt_context_timestamp_ms: message.legacyPromptContextTimestampMs,
            }
          : {}),
      },
      ...(message.projection !== undefined ? { promptContextProjection: message.projection } : {}),
    });
  }
}

function execApprovalCall(index = 0) {
  return requireRecord(
    mockArg(resolveExecApprovalSpy as unknown as MockCallSource, index, 0, "exec approval call"),
    "exec approval call",
  );
}

function execApprovalTelegramConfig(call = execApprovalCall()) {
  return requireRecord(
    requireRecord(requireRecord(call.cfg, "approval cfg").channels, "approval channels").telegram,
    "telegram config",
  );
}

function execApprovalTargetConfig(call = execApprovalCall()) {
  return requireRecord(
    requireRecord(requireRecord(call.cfg, "approval cfg").approvals, "approvals").exec,
    "exec approvals target config",
  );
}

function systemEventOptions(index = 0) {
  return requireRecord(
    mockArg(enqueueSystemEventSpy as unknown as MockCallSource, index, 1, "system event options"),
    "system event options",
  );
}

const ORIGINAL_TZ = process.env.TZ;
const ORIGINAL_STATE_DIR = process.env.OPENCLAW_STATE_DIR;
let scopedStateDir: string | undefined;

describe("createTelegramBot", () => {
  beforeAll(async () => {
    ({ createTelegramBotCore: createTelegramBotBase } = await import("./bot-core.js"));
  });
  beforeAll(() => {
    process.env.TZ = "UTC";
    // Isolate persistent state from the operator's real ~/.openclaw: assembled
    // turns resolve session/agent bindings through the state DB, and an ambient
    // Codex session binding fails its generation reclaim, so the embedded agent
    // drops the turn without replying and reply-wait tests hang to timeout.
    closeOpenClawStateDatabaseForTest();
    scopedStateDir = fs.realpathSync(
      fs.mkdtempSync(path.join(resolvePreferredOpenClawTmpDir(), "openclaw-telegram-bot-state-")),
    );
    process.env.OPENCLAW_STATE_DIR = scopedStateDir;
  });
  afterAll(() => {
    if (ORIGINAL_TZ === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = ORIGINAL_TZ;
    }
    closeOpenClawStateDatabaseForTest();
    if (ORIGINAL_STATE_DIR === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = ORIGINAL_STATE_DIR;
    }
    if (scopedStateDir) {
      fs.rmSync(scopedStateDir, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    setMyCommandsSpy.mockClear();
    questionGatewayHoisted.resolveQuestionOverGatewaySpy.mockClear();
    clearPluginInteractiveHandlers();
    loadConfig.mockReturnValue({
      agents: {
        defaults: {
          envelopeTimezone: "utc",
        },
      },
      channels: {
        telegram: { dmPolicy: "open", allowFrom: ["*"] },
      },
    });
    createTelegramBot = (opts) =>
      createTelegramBotBase({
        ...opts,
        telegramDeps: telegramBotDepsForTest,
      });
  });

  it("starts with retired includeGroupHistoryContext still present in raw config", async () => {
    loadConfig.mockReturnValue({
      messages: { groupChat: { unmentionedInbound: "room_event" } },
      channels: {
        telegram: {
          includeGroupHistoryContext: "mention-only",
        },
      },
    } as never);

    createTelegramBot({ token: "tok" });

    expect(getOnHandler("message")).toEqual(expect.any(Function));
  });

  it("dedupes outbound prompt-context sends with ambient group history", async () => {
    onSpy.mockClear();
    replySpy.mockClear();
    const cfg = {
      messages: { groupChat: { unmentionedInbound: "room_event", mentionPatterns: [] } },
      channels: {
        telegram: {
          groupPolicy: "open",
          groups: { "*": { requireMention: false } },
        },
      },
    } satisfies OpenClawConfig;
    loadConfig.mockReturnValue(cfg);
    createTelegramBot({
      token: "tok",
      botInfo: {
        id: 999,
        is_bot: true,
        first_name: "OpenClaw",
        username: "openclaw_bot",
        can_join_groups: true,
        can_read_all_group_messages: false,
        can_manage_bots: false,
        supports_inline_queries: false,
        supports_join_request_queries: false,
        can_connect_to_business: false,
        has_main_web_app: false,
        has_topics_enabled: false,
        allows_users_to_create_topics: false,
      },
    });
    await recordOutboundMessageForPromptContext({
      cfg,
      account: { accountId: "default", name: "OpenClaw" },
      chatId: -42,
      message: {
        chat: { id: -42, type: "group", title: "Ops" },
        date: 1_736_380_700,
        message_id: 700,
        text: "Bot just replied",
      },
      messageId: 700,
      text: "Bot just replied",
    });

    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;
    await handler({
      me: { id: 999, username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
      message: {
        chat: { id: -42, type: "group", title: "Ops" },
        text: "What now?",
        date: 1_736_380_800,
        message_id: 701,
        from: { id: 201, is_bot: false, first_name: "Sam" },
      },
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = mockMsgContextArg(replySpy as unknown as MockCallSource, 0, 0, "replySpy call");
    expect(payload.InboundEventKind).toBe("room_event");
    expect(payload.InboundHistory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ body: "Bot just replied", sender: "OpenClaw (you)" }),
      ]),
    );
    const [conversationContext] = requireArray(
      payload.UntrustedStructuredContext,
      "structured context",
    );
    const contextPayload = requireRecord(
      requireRecord(conversationContext, "conversation context").payload,
      "conversation context payload",
    );
    const messages = requireArray(contextPayload.messages, "conversation context messages").map(
      (message, index) => requireRecord(message, `conversation context message ${index + 1}`),
    );
    expect(messages.filter((message) => message.message_id === "700")).toEqual([
      expect.objectContaining({
        body: "Bot just replied",
        sender: "OpenClaw (you)",
      }),
    ]);
  });

  it.each([
    {
      caseName: "labels a raw bot reply on a cache miss",
      replyFrom: {
        id: 999,
        is_bot: true,
        first_name: "Provisioning",
        last_name: "Placeholder",
        username: "openclaw_bot",
      },
      expectedSender: "Configured Agent (you)",
      omitMe: false,
      senderBusinessBot: undefined,
      chatId: 42,
      replyMessageId: 800,
    },
    {
      caseName: "does not trust a user-controlled self suffix",
      replyFrom: {
        id: 888,
        is_bot: false,
        first_name: "Alex (you)",
        username: "alex",
      },
      expectedSender: "Alex (you) (Telegram sender)",
      omitMe: false,
      senderBusinessBot: undefined,
      chatId: 43,
      replyMessageId: 810,
    },
    {
      caseName: "authenticates the sender bot for a Telegram Business reply",
      replyFrom: {
        id: 777,
        is_bot: false,
        first_name: "Business Account",
        username: "business_account",
      },
      expectedSender: "Configured Agent (you)",
      omitMe: false,
      senderBusinessBot: {
        id: 999,
        is_bot: true,
        first_name: "Telegram Bot Name",
        username: "openclaw_bot",
      },
      chatId: 44,
      replyMessageId: 820,
    },
    {
      caseName: "falls back to startup bot metadata when context metadata is missing",
      replyFrom: {
        id: 999,
        is_bot: true,
        first_name: "Provisioning",
        last_name: "Placeholder",
        username: "openclaw_bot",
      },
      expectedSender: "Configured Agent (you)",
      omitMe: true,
      senderBusinessBot: undefined,
      chatId: 45,
      replyMessageId: 830,
    },
  ])(
    "$caseName",
    async ({ replyFrom, expectedSender, omitMe, senderBusinessBot, chatId, replyMessageId }) => {
      onSpy.mockClear();
      replySpy.mockClear();
      const storePath = `/tmp/openclaw-telegram-self-projection-${process.pid}-${chatId}.json`;
      const cfg = {
        channels: {
          telegram: {
            name: "  Configured Agent  ",
            dmPolicy: "open",
            allowFrom: ["*"],
          },
        },
        session: { store: storePath },
      } satisfies OpenClawConfig;
      loadConfig.mockReturnValue(cfg);
      createTelegramBot({
        token: "tok",
        config: cfg,
        botInfo: {
          id: 999,
          is_bot: true,
          first_name: "Telegram Bot Name",
          username: "openclaw_bot",
          can_join_groups: true,
          can_read_all_group_messages: false,
          can_manage_bots: false,
          supports_inline_queries: false,
          supports_join_request_queries: false,
          can_connect_to_business: false,
          has_main_web_app: false,
          has_topics_enabled: false,
          allows_users_to_create_topics: false,
        },
      });

      try {
        const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;
        await handler({
          ...(omitMe
            ? {}
            : {
                me: {
                  id: 999,
                  is_bot: true,
                  first_name: "Telegram Bot Name",
                  username: "openclaw_bot",
                },
              }),
          getFile: async () => ({ download: async () => new Uint8Array() }),
          message: {
            chat: { id: chatId, type: "private", first_name: "Pat" },
            text: "Following up",
            date: 1_736_380_800,
            message_id: replyMessageId + 1,
            from: { id: 123, is_bot: false, first_name: "Pat" },
            reply_to_message: {
              chat: { id: chatId, type: "private", first_name: "Pat" },
              date: 1_736_380_700,
              from: replyFrom,
              ...(senderBusinessBot ? { sender_business_bot: senderBusinessBot } : {}),
              message_id: replyMessageId,
              text: "Earlier reply",
            },
          },
        });

        expect(replySpy).toHaveBeenCalledTimes(1);
        const payload = mockMsgContextArg(
          replySpy as unknown as MockCallSource,
          0,
          0,
          "replySpy call",
        );
        expect(payload.ReplyChain).toEqual([
          expect.objectContaining({
            messageId: String(replyMessageId),
            sender: expectedSender,
            senderId: String(replyFrom.id),
            senderUsername: replyFrom.username,
          }),
        ]);
        const [conversationContext] = requireArray(
          payload.UntrustedStructuredContext,
          "structured context",
        );
        const messages = requireArray(
          requireRecord(
            requireRecord(conversationContext, "conversation context").payload,
            "conversation context payload",
          ).messages,
          "conversation context messages",
        ).map((message, index) =>
          requireRecord(message, `conversation context message ${index + 1}`),
        );
        expect(
          messages.find((message) => message.message_id === String(replyMessageId)),
        ).toMatchObject({
          sender: expectedSender,
          sender_id: String(replyFrom.id),
          sender_username: replyFrom.username,
        });
        if (replyFrom.id === 999 || senderBusinessBot?.id === 999) {
          const promptJson = JSON.stringify({ replyChain: payload.ReplyChain, messages });
          expect(promptJson).not.toContain("Provisioning");
          expect(promptJson).not.toContain("Placeholder");
        }
      } finally {
        await rm(storePath, { force: true });
        await rm(`${storePath}.telegram-messages.json`, { force: true });
      }
    },
  );

  it("uses the live allowlist when authorizing callbacks", async () => {
    onSpy.mockClear();
    replySpy.mockClear();
    sendMessageSpy.mockClear();
    loadConfig.mockClear();

    const startupConfig = {
      channels: {
        telegram: {
          dmPolicy: "pairing" as const,
          capabilities: { inlineButtons: "allowlist" as const },
          allowFrom: ["9"],
        },
      },
    };
    const liveConfig = {
      channels: {
        telegram: {
          dmPolicy: "pairing" as const,
          capabilities: { inlineButtons: "allowlist" as const },
          allowFrom: [],
        },
      },
    };
    loadConfig.mockReturnValue(liveConfig);
    createTelegramBot({
      token: "tok",
      config: startupConfig,
    });
    const callbackHandler = getOnHandler("callback_query") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    if (!callbackHandler) {
      throw new Error("Expected Telegram callback_query handler");
    }

    await callbackHandler({
      callbackQuery: {
        id: "cbq-2",
        data: "cmd:option_b",
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1736380800,
          message_id: 11,
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).not.toHaveBeenCalled();
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-2");
    expect(loadConfig).toHaveBeenCalledTimes(1);
  });

  it("blocks DM model-selection callbacks for unpaired users when inline buttons are DM-scoped", async () => {
    onSpy.mockClear();
    replySpy.mockClear();
    editMessageTextSpy.mockClear();

    const storePath = `/tmp/openclaw-telegram-callback-authz-${process.pid}-${Date.now()}.json`;

    await rm(storePath, { force: true });
    try {
      const config = {
        agents: {
          defaults: {
            model: "anthropic/claude-opus-4-6",
            models: {
              "anthropic/claude-opus-4-6": {},
              "openai/gpt-5.4": {},
            },
          },
        },
        channels: {
          telegram: {
            dmPolicy: "pairing",
            capabilities: { inlineButtons: "dm" },
          },
        },
        session: {
          store: storePath,
        },
      } satisfies NonNullable<Parameters<typeof createTelegramBot>[0]["config"]>;

      loadConfig.mockReturnValue(config);
      readChannelAllowFromStore.mockResolvedValueOnce([]);

      createTelegramBot({
        token: "tok",
        config,
      });
      const callbackHandler = onSpy.mock.calls.find(
        (call) => call[0] === "callback_query",
      )?.[1] as (ctx: Record<string, unknown>) => Promise<void>;
      if (!callbackHandler) {
        throw new Error("Expected Telegram callback_query handler");
      }

      await callbackHandler({
        callbackQuery: {
          id: "cbq-model-authz-bypass-1",
          data: "mdl_sel_openai/gpt-5.4",
          from: { id: 999, first_name: "Mallory", username: "mallory" },
          message: {
            chat: { id: 1234, type: "private" },
            date: 1736380800,
            message_id: 19,
          },
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ download: async () => new Uint8Array() }),
      });

      expect(replySpy).not.toHaveBeenCalled();
      expect(editMessageTextSpy).not.toHaveBeenCalled();
      expect(listSessionEntries({ storePath })).toStrictEqual([]);
      expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-model-authz-bypass-1");
    } finally {
      await rm(storePath, { force: true });
    }
  });

  it("blocks group model-selection callbacks for senders who are not authorized for /models", async () => {
    onSpy.mockClear();
    replySpy.mockClear();
    editMessageTextSpy.mockClear();

    const storePath = `/tmp/openclaw-telegram-group-model-authz-${process.pid}-${Date.now()}.json`;

    await rm(storePath, { force: true });
    try {
      const config = {
        agents: {
          defaults: {
            model: "anthropic/claude-opus-4-6",
            models: {
              "anthropic/claude-opus-4-6": {},
              "openai/gpt-5.4": {},
            },
          },
        },
        commands: {
          allowFrom: {
            telegram: ["9"],
          },
        },
        channels: {
          telegram: {
            dmPolicy: "open",
            capabilities: { inlineButtons: "group" },
            groupPolicy: "open",
            groups: { "*": { requireMention: false } },
          },
        },
        session: {
          store: storePath,
        },
      } satisfies NonNullable<Parameters<typeof createTelegramBot>[0]["config"]>;

      loadConfig.mockReturnValue(config);
      createTelegramBot({
        token: "tok",
        config,
      });
      const callbackHandler = onSpy.mock.calls.find(
        (call) => call[0] === "callback_query",
      )?.[1] as (ctx: Record<string, unknown>) => Promise<void>;
      if (!callbackHandler) {
        throw new Error("Expected Telegram callback_query handler");
      }

      await callbackHandler({
        callbackQuery: {
          id: "cbq-group-model-authz-1",
          data: "mdl_sel_openai/gpt-5.4",
          from: { id: 999, first_name: "Mallory", username: "mallory" },
          message: {
            chat: { id: -100999, type: "supergroup", title: "Test Group" },
            date: 1736380800,
            message_id: 21,
          },
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ download: async () => new Uint8Array() }),
      });

      expect(replySpy).not.toHaveBeenCalled();
      expect(editMessageTextSpy).not.toHaveBeenCalled();
      expect(listSessionEntries({ storePath })).toStrictEqual([]);
      expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-group-model-authz-1");
    } finally {
      await rm(storePath, { force: true });
    }
  });

  it("recomputes group model-selection callback auth from runtime command config", async () => {
    onSpy.mockClear();
    replySpy.mockClear();
    editMessageTextSpy.mockClear();

    const storePath = `/tmp/openclaw-telegram-group-model-authz-runtime-${process.pid}-${Date.now()}.json`;

    await rm(storePath, { force: true });
    try {
      let currentConfig = {
        agents: {
          defaults: {
            model: "anthropic/claude-opus-4-6",
            models: {
              "anthropic/claude-opus-4-6": {},
              "openai/gpt-5.4": {},
            },
          },
        },
        commands: {
          allowFrom: {
            telegram: ["999"],
          },
        },
        channels: {
          telegram: {
            dmPolicy: "open",
            capabilities: { inlineButtons: "group" },
            groupPolicy: "open",
            groups: { "*": { requireMention: false } },
          },
        },
        session: {
          store: storePath,
        },
      } satisfies NonNullable<Parameters<typeof createTelegramBot>[0]["config"]>;

      loadConfig.mockImplementation(() => currentConfig);
      createTelegramBot({
        token: "tok",
        config: currentConfig,
      });
      const callbackHandler = onSpy.mock.calls.find(
        (call) => call[0] === "callback_query",
      )?.[1] as (ctx: Record<string, unknown>) => Promise<void>;
      if (!callbackHandler) {
        throw new Error("Expected Telegram callback_query handler");
      }

      currentConfig = {
        ...currentConfig,
        commands: {
          allowFrom: {
            telegram: ["9"],
          },
        },
      };

      await callbackHandler({
        callbackQuery: {
          id: "cbq-group-model-authz-runtime-1",
          data: "mdl_sel_openai/gpt-5.4",
          from: { id: 999, first_name: "Mallory", username: "mallory" },
          message: {
            chat: { id: -100999, type: "supergroup", title: "Test Group" },
            date: 1736380800,
            message_id: 22,
          },
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ download: async () => new Uint8Array() }),
      });

      expect(replySpy).not.toHaveBeenCalled();
      expect(editMessageTextSpy).not.toHaveBeenCalled();
      expect(listSessionEntries({ storePath })).toStrictEqual([]);
      expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-group-model-authz-runtime-1");
    } finally {
      loadConfig.mockReset();
      loadConfig.mockReturnValue({
        agents: {
          defaults: {
            envelopeTimezone: "utc",
          },
        },
        channels: {
          telegram: { dmPolicy: "open", allowFrom: ["*"] },
        },
      });
      await rm(storePath, { force: true });
    }
  });

  it("allows callback_query in groups when group policy authorizes the sender", async () => {
    onSpy.mockClear();
    editMessageTextSpy.mockClear();
    listSkillCommandsForAgents.mockClear();

    createTelegramBot({
      token: "tok",
      config: {
        channels: {
          telegram: {
            dmPolicy: "open",
            capabilities: { inlineButtons: "allowlist" },
            allowFrom: [],
            groupPolicy: "open",
            groups: { "*": { requireMention: false } },
          },
        },
      },
    });
    const callbackHandler = getOnHandler("callback_query") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    if (!callbackHandler) {
      throw new Error("Expected Telegram callback_query handler");
    }

    await callbackHandler({
      callbackQuery: {
        id: "cbq-group-1",
        data: "commands_page_2",
        from: { id: 42, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: -100999, type: "supergroup", title: "Test Group" },
          date: 1736380800,
          message_id: 20,
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    // The callback should be processed (not silently blocked)
    expect(editMessageTextSpy).toHaveBeenCalledTimes(1);
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-group-1");
  });

  it("keeps group question callbacks on the configured callback allowlist", async () => {
    onSpy.mockClear();
    answerCallbackQuerySpy.mockClear();

    const config = {
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["9"],
          capabilities: { inlineButtons: "all" },
          groupPolicy: "open",
          groups: { "*": { requireMention: false, allowFrom: ["9"] } },
        },
      },
    } satisfies NonNullable<Parameters<typeof createTelegramBot>[0]["config"]>;
    loadConfig.mockReturnValue(config);
    createTelegramBot({ token: "tok", config });
    const callbackHandler = getTelegramCallbackHandlerForTests();

    await callbackHandler({
      callbackQuery: {
        id: "cbq-question-blocked",
        data: "tgq1:ask_0123456789abcdef0123456789abcdef:1",
        from: { id: 999, first_name: "Mallory", username: "mallory" },
        message: {
          chat: { id: -100999, type: "supergroup", title: "Test Group" },
          date: 1736380800,
          message_id: 21,
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(questionGatewayHoisted.resolveQuestionOverGatewaySpy).not.toHaveBeenCalled();
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-question-blocked");
  });

  it("replaces legacy approval controls with a visible terminal receipt", async () => {
    onSpy.mockClear();
    editMessageReplyMarkupSpy.mockClear();
    editMessageTextSpy.mockClear();
    resolveExecApprovalSpy.mockClear();

    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
          execApprovals: {
            enabled: true,
            approvers: ["9"],
            target: "dm",
          },
        },
      },
    });
    createTelegramBot({ token: "tok" });
    const callbackHandler = getOnHandler("callback_query") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    if (!callbackHandler) {
      throw new Error("Expected Telegram callback_query handler");
    }

    await callbackHandler({
      callbackQuery: {
        id: "cbq-approve-style",
        data: "/approve 138e9b8c allow-once",
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1736380800,
          message_id: 21,
          text: [
            `${PUZZLE_EMOJI} Yep-needs approval again.`,
            "",
            "Run:",
            "/approve 138e9b8c allow-once",
            "",
            "Pending command:",
            "```shell",
            "npm view diver name version description",
            "```",
          ].join("\n"),
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(editMessageTextSpy).toHaveBeenCalledTimes(1);
    const [chatId, messageId, terminalText, editOptions] = mockCall(
      editMessageTextSpy as unknown as MockCallSource,
      0,
      "edit terminal approval message",
    );
    expect(chatId).toBe(1234);
    expect(messageId).toBe(21);
    expect(terminalText).toContain("✅ Approval resolved here");
    expect(terminalText).toContain("Result: Allowed once");
    expect(terminalText).toContain("ID: 138e9b8c");
    expect(editOptions).toEqual({ reply_markup: { inline_keyboard: [] } });
    expect(editMessageReplyMarkupSpy).not.toHaveBeenCalled();
    const approvalCall = execApprovalCall();
    const execApprovals = requireRecord(
      execApprovalTelegramConfig(approvalCall).execApprovals,
      "telegram exec approvals",
    );
    expect(execApprovals.enabled).toBe(true);
    expect(execApprovals.approvers).toEqual(["9"]);
    expect(execApprovals.target).toBe("dm");
    expect(approvalCall.approvalId).toBe("138e9b8c");
    expect(approvalCall.approvalKind).toBe("exec");
    expect(approvalCall.decision).toBe("allow-once");
    expect(approvalCall.senderId).toBe("9");
    expect(replySpy).not.toHaveBeenCalled();
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-approve-style");
  });

  it("allows approval callbacks when exec approvals are enabled even without generic inlineButtons capability", async () => {
    onSpy.mockClear();
    editMessageReplyMarkupSpy.mockClear();
    editMessageTextSpy.mockClear();

    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          botToken: "tok",
          dmPolicy: "open",
          allowFrom: ["*"],
          capabilities: ["vision"],
          execApprovals: {
            enabled: true,
            approvers: ["9"],
            target: "dm",
          },
        },
      },
    });
    createTelegramBot({ token: "tok" });
    const callbackHandler = onSpy.mock.calls.find((call) => call[0] === "callback_query")?.[1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    if (!callbackHandler) {
      throw new Error("Expected Telegram callback_query handler");
    }

    await callbackHandler({
      callbackQuery: {
        id: "cbq-approve-capability-free",
        data: "tgcmd:/approve 138e9b8c allow-once",
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1736380800,
          message_id: 23,
          text: "Approval required.",
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(editMessageTextSpy).toHaveBeenCalledTimes(1);
    expect(editMessageReplyMarkupSpy).not.toHaveBeenCalled();
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-approve-capability-free");
  });

  it("uses explicit ownership and renders canonical truth on a losing typed surface", async () => {
    onSpy.mockClear();
    editMessageReplyMarkupSpy.mockClear();
    editMessageTextSpy.mockClear();
    resolveExecApprovalSpy.mockClear();
    resolveExecApprovalSpy.mockResolvedValueOnce({
      applied: false,
      approval: {
        id: "plugin:id-owned-by-exec",
        urlPath: "/approve/plugin%3Aid-owned-by-exec",
        createdAtMs: 1,
        expiresAtMs: 60_000,
        resolvedAtMs: 2,
        reason: "user",
        status: "allowed",
        decision: "allow-once",
        presentation: {
          kind: "exec",
          commandText: "echo canonical",
          commandPreview: "echo canonical",
          allowedDecisions: ["allow-once", "deny"],
        },
      },
    });

    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
          execApprovals: {
            enabled: true,
            approvers: ["9"],
            target: "dm",
          },
        },
      },
    });
    createTelegramBot({ token: "tok" });
    const callbackHandler = getTelegramCallbackHandlerForTests();
    const callbackData = buildTelegramApprovalCallbackData({
      type: "approval",
      approvalId: "plugin:id-owned-by-exec",
      approvalKind: "exec",
      decision: "deny",
    });
    if (!callbackData) {
      throw new Error("Expected typed approval callback data");
    }

    await callbackHandler({
      callbackQuery: {
        id: "cbq-typed-approval-loser",
        data: callbackData,
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1736380800,
          message_id: 24,
          text: "Approval required.",
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(execApprovalCall()).toMatchObject({
      approvalId: "plugin:id-owned-by-exec",
      approvalKind: "exec",
      decision: "deny",
      senderId: "9",
    });
    expect(editMessageTextSpy).toHaveBeenCalledWith(
      1234,
      24,
      [
        "ℹ️ Approval already resolved",
        "Canonical result: Allowed once",
        "ID: plugin:id-owned-by-exec",
        "",
        "Command:",
        "echo canonical",
      ].join("\n"),
      { reply_markup: { inline_keyboard: [] } },
    );
    expect(editMessageReplyMarkupSpy).not.toHaveBeenCalled();
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-typed-approval-loser");
  });

  it("sends a canonical terminal receipt when the clicked approval message cannot be edited", async () => {
    onSpy.mockClear();
    editMessageReplyMarkupSpy.mockClear();
    editMessageTextSpy.mockClear();
    sendMessageSpy.mockClear();
    resolveExecApprovalSpy.mockClear();
    editMessageTextSpy.mockRejectedValueOnce(new Error("Bad Request: message can't be edited"));
    resolveExecApprovalSpy.mockResolvedValueOnce({
      applied: true,
      approval: {
        id: "fallback-receipt-id",
        urlPath: "/approve/fallback-receipt-id",
        createdAtMs: 1,
        expiresAtMs: 60_000,
        resolvedAtMs: 2,
        reason: "user",
        status: "denied",
        decision: "deny",
        presentation: {
          kind: "exec",
          commandText: "echo denied",
          commandPreview: "echo denied",
          allowedDecisions: ["allow-once", "deny"],
        },
      },
    });

    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
          execApprovals: {
            enabled: true,
            approvers: ["9"],
            target: "dm",
          },
        },
      },
    });
    createTelegramBot({ token: "tok" });
    const callbackData = buildTelegramApprovalCallbackData({
      type: "approval",
      approvalId: "fallback-receipt-id",
      approvalKind: "exec",
      decision: "deny",
    });
    if (!callbackData) {
      throw new Error("Expected typed approval callback data");
    }

    await getTelegramCallbackHandlerForTests()({
      callbackQuery: {
        id: "cbq-terminal-edit-fallback",
        data: callbackData,
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1736380800,
          message_id: 25,
          text: "Approval required.",
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    const terminalText = [
      "✅ Approval resolved here",
      "Canonical result: Denied",
      "ID: fallback-receipt-id",
      "",
      "Command:",
      "echo denied",
    ].join("\n");
    expect(editMessageTextSpy).toHaveBeenCalledWith(1234, 25, terminalText, {
      reply_markup: { inline_keyboard: [] },
    });
    expect(editMessageReplyMarkupSpy).toHaveBeenCalledWith(1234, 25, {
      reply_markup: { inline_keyboard: [] },
    });
    expect(sendMessageSpy).toHaveBeenCalledWith(1234, terminalText, undefined);
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-terminal-edit-fallback");
  });

  it("consumes malformed callbacks in the reserved approval namespace", async () => {
    onSpy.mockClear();
    editMessageReplyMarkupSpy.mockClear();
    editMessageTextSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    replySpy.mockClear();
    resolveExecApprovalSpy.mockClear();
    const pluginHandler = vi.fn(async () => ({ handled: true }));
    registerPluginInteractiveHandler("reserved-approval-test", {
      channel: "telegram",
      namespace: "tga1",
      handler: pluginHandler as never,
    });

    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
          execApprovals: {
            enabled: true,
            approvers: ["9"],
            target: "dm",
          },
        },
      },
    });
    createTelegramBot({ token: "tok" });

    await getTelegramCallbackHandlerForTests()({
      callbackQuery: {
        id: "cbq-malformed-reserved-approval",
        data: "tga1:e:x:req-1",
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1736380800,
          message_id: 26,
          text: "Approval required.",
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(editMessageTextSpy).toHaveBeenCalledWith(
      1234,
      26,
      "ℹ️ Approval action unavailable\nThis button is invalid or no longer actionable.",
      { reply_markup: { inline_keyboard: [] } },
    );
    expect(editMessageReplyMarkupSpy).not.toHaveBeenCalled();
    expect(resolveExecApprovalSpy).not.toHaveBeenCalled();
    expect(pluginHandler).not.toHaveBeenCalled();
    expect(replySpy).not.toHaveBeenCalled();
    expect(enqueueSystemEventSpy).not.toHaveBeenCalled();
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-malformed-reserved-approval");
  });

  it("terminalizes a stale legacy click from the canonical record without retrying owners", async () => {
    onSpy.mockClear();
    editMessageReplyMarkupSpy.mockClear();
    editMessageTextSpy.mockClear();
    resolveExecApprovalSpy.mockClear();
    const alreadyResolved = Object.assign(new Error("approval already resolved"), {
      gatewayCode: "INVALID_REQUEST",
      details: { reason: "APPROVAL_ALREADY_RESOLVED" },
    });
    resolveExecApprovalSpy.mockRejectedValueOnce(alreadyResolved).mockResolvedValueOnce({
      applied: false,
      approval: {
        id: "stale-legacy-id",
        urlPath: "/approve/stale-legacy-id",
        createdAtMs: 1,
        expiresAtMs: 60_000,
        resolvedAtMs: 2,
        reason: "user",
        status: "denied",
        decision: "deny",
        presentation: {
          kind: "exec",
          commandText: "echo denied",
          allowedDecisions: ["allow-once", "deny"],
        },
      },
    });

    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
          execApprovals: {
            enabled: true,
            approvers: ["9"],
            target: "dm",
          },
        },
      },
    });
    createTelegramBot({ token: "tok" });

    await getTelegramCallbackHandlerForTests()({
      callbackQuery: {
        id: "cbq-stale-legacy",
        data: "/approve stale-legacy-id allow-once",
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1736380800,
          message_id: 25,
          text: "Approval required.",
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(resolveExecApprovalSpy).toHaveBeenCalledTimes(2);
    expect(execApprovalCall(0)).toMatchObject({
      approvalId: "stale-legacy-id",
      approvalKind: "exec",
    });
    expect(execApprovalCall(1)).toMatchObject({
      approvalId: "stale-legacy-id",
      approvalKind: "exec",
    });
    expect(editMessageTextSpy).toHaveBeenCalledWith(
      1234,
      25,
      expect.stringContaining("Canonical result: Denied"),
      { reply_markup: { inline_keyboard: [] } },
    );
    expect(editMessageReplyMarkupSpy).not.toHaveBeenCalled();
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-stale-legacy");
  });

  it("renders neutral terminal copy when a stale legacy record cannot be fetched", async () => {
    onSpy.mockClear();
    editMessageReplyMarkupSpy.mockClear();
    editMessageTextSpy.mockClear();
    resolveExecApprovalSpy.mockClear();
    const alreadyResolved = Object.assign(new Error("approval already resolved"), {
      gatewayCode: "INVALID_REQUEST",
      details: { reason: "APPROVAL_ALREADY_RESOLVED" },
    });
    resolveExecApprovalSpy
      .mockRejectedValueOnce(alreadyResolved)
      .mockRejectedValueOnce(new Error("unknown or expired approval id"));

    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
          execApprovals: {
            enabled: true,
            approvers: ["9"],
            target: "dm",
          },
        },
      },
    });
    createTelegramBot({ token: "tok" });

    await getTelegramCallbackHandlerForTests()({
      callbackQuery: {
        id: "cbq-stale-legacy-neutral",
        data: "/approve stale-neutral-id deny",
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1736380800,
          message_id: 26,
          text: "Approval required.",
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(resolveExecApprovalSpy).toHaveBeenCalledTimes(2);
    expect(editMessageTextSpy).toHaveBeenCalledWith(
      1234,
      26,
      expect.stringContaining(
        "It was already resolved or expired; the canonical decision is unavailable here.",
      ),
      { reply_markup: { inline_keyboard: [] } },
    );
    expect(editMessageReplyMarkupSpy).not.toHaveBeenCalled();
  });

  it("retries a stale legacy click when canonical convergence fails transiently", async () => {
    onSpy.mockClear();
    editMessageReplyMarkupSpy.mockClear();
    editMessageTextSpy.mockClear();
    resolveExecApprovalSpy.mockClear();
    const alreadyResolved = Object.assign(new Error("approval already resolved"), {
      gatewayCode: "INVALID_REQUEST",
      details: { reason: "APPROVAL_ALREADY_RESOLVED" },
    });
    resolveExecApprovalSpy
      .mockRejectedValueOnce(alreadyResolved)
      .mockRejectedValueOnce(new Error("gateway unavailable"));

    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
          execApprovals: {
            enabled: true,
            approvers: ["9"],
            target: "dm",
          },
        },
      },
    });
    createTelegramBot({ token: "tok" });

    await expect(
      getTelegramCallbackHandlerForTests()({
        callbackQuery: {
          id: "cbq-stale-legacy-retry",
          data: "/approve stale-retry-id deny",
          from: { id: 9, first_name: "Ada", username: "ada_bot" },
          message: {
            chat: { id: 1234, type: "private" },
            date: 1736380800,
            message_id: 27,
            text: "Approval required.",
          },
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ download: async () => new Uint8Array() }),
      }),
    ).rejects.toThrow("gateway unavailable");

    expect(resolveExecApprovalSpy).toHaveBeenCalledTimes(2);
    expect(editMessageTextSpy).not.toHaveBeenCalled();
    expect(editMessageReplyMarkupSpy).not.toHaveBeenCalled();
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-stale-legacy-retry");
  });

  it("resolves legacy opaque plugin ids without inferring kind from id spelling", async () => {
    onSpy.mockClear();
    editMessageReplyMarkupSpy.mockClear();
    editMessageTextSpy.mockClear();
    resolveExecApprovalSpy.mockClear();
    resolveExecApprovalSpy.mockRejectedValueOnce(new Error("unknown or expired approval id"));

    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
          execApprovals: {
            enabled: true,
            approvers: ["9"],
            target: "dm",
          },
        },
      },
    });
    createTelegramBot({ token: "tok" });
    const callbackHandler = getOnHandler("callback_query") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    if (!callbackHandler) {
      throw new Error("Expected Telegram callback_query handler");
    }

    await callbackHandler({
      callbackQuery: {
        id: "cbq-plugin-approve",
        data: "/approve opaque-plugin-approval-id allow-once",
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1736380800,
          message_id: 24,
          text: "Plugin approval required.",
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    const approvalCall = execApprovalCall();
    const execApprovals = requireRecord(
      execApprovalTelegramConfig(approvalCall).execApprovals,
      "telegram exec approvals",
    );
    expect(execApprovals.enabled).toBe(true);
    expect(execApprovals.approvers).toEqual(["9"]);
    expect(execApprovals.target).toBe("dm");
    expect(approvalCall.approvalId).toBe("opaque-plugin-approval-id");
    expect(approvalCall.approvalKind).toBe("exec");
    expect(approvalCall.decision).toBe("allow-once");
    expect(approvalCall.senderId).toBe("9");
    expect(execApprovalCall(1)).toMatchObject({
      approvalId: "opaque-plugin-approval-id",
      approvalKind: "plugin",
      decision: "allow-once",
      senderId: "9",
    });
    expect(resolveExecApprovalSpy).toHaveBeenCalledTimes(2);
    expect(editMessageTextSpy).toHaveBeenCalledWith(
      1234,
      24,
      expect.stringContaining("✅ Approval resolved here"),
      { reply_markup: { inline_keyboard: [] } },
    );
    expect(editMessageReplyMarkupSpy).not.toHaveBeenCalled();
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-plugin-approve");
  });

  it("does not resolve opaque approval-shaped plugin callbacks", async () => {
    onSpy.mockClear();
    editMessageReplyMarkupSpy.mockClear();
    resolveExecApprovalSpy.mockClear();

    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
          execApprovals: {
            enabled: true,
            approvers: ["9"],
            target: "dm",
          },
        },
      },
    });
    createTelegramBot({ token: "tok" });
    const callbackHandler = onSpy.mock.calls.find((call) => call[0] === "callback_query")?.[1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    if (!callbackHandler) {
      throw new Error("Expected Telegram callback_query handler");
    }

    await callbackHandler({
      callbackQuery: {
        id: "cbq-opaque-plugin-approve",
        data: buildTelegramOpaqueCallbackData("/approve plugin:138e9b8c allow-once"),
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1736380800,
          message_id: 25,
          text: "Plugin callback.",
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(resolveExecApprovalSpy).not.toHaveBeenCalled();
    expect(editMessageReplyMarkupSpy).not.toHaveBeenCalled();
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-opaque-plugin-approve");
  });

  it("blocks approval callbacks from telegram users who are not exec approvers", async () => {
    onSpy.mockClear();
    editMessageReplyMarkupSpy.mockClear();
    editMessageTextSpy.mockClear();
    resolveExecApprovalSpy.mockClear();

    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
          execApprovals: {
            enabled: true,
            approvers: ["999"],
            target: "dm",
          },
        },
      },
    });
    createTelegramBot({ token: "tok" });
    const callbackHandler = onSpy.mock.calls.find((call) => call[0] === "callback_query")?.[1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    if (!callbackHandler) {
      throw new Error("Expected Telegram callback_query handler");
    }

    await callbackHandler({
      callbackQuery: {
        id: "cbq-approve-blocked",
        data: "/approve 138e9b8c allow-once",
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1736380800,
          message_id: 22,
          text: "Run: /approve 138e9b8c allow-once",
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(editMessageReplyMarkupSpy).not.toHaveBeenCalled();
    expect(editMessageTextSpy).not.toHaveBeenCalled();
    expect(resolveExecApprovalSpy).not.toHaveBeenCalled();
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-approve-blocked");
  });

  it("keeps approval callback resolution failures out of Telegram chat before retry", async () => {
    onSpy.mockClear();
    sendMessageSpy.mockClear();
    editMessageReplyMarkupSpy.mockClear();
    resolveExecApprovalSpy.mockClear();
    resolveExecApprovalSpy.mockRejectedValueOnce(new Error("gateway secret detail"));

    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
          execApprovals: {
            enabled: true,
            approvers: ["9"],
            target: "dm",
          },
        },
      },
    });
    createTelegramBot({ token: "tok" });
    const callbackHandler = getOnHandler("callback_query") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await expect(
      callbackHandler({
        callbackQuery: {
          id: "cbq-approve-error",
          data: "/approve 138e9b8c allow-once",
          from: { id: 9, first_name: "Ada", username: "ada_bot" },
          message: {
            chat: { id: 1234, type: "private" },
            date: 1736380800,
            message_id: 25,
            text: "Approval required.",
          },
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ download: async () => new Uint8Array() }),
      }),
    ).rejects.toThrow("gateway secret detail");

    expect(sendMessageSpy).not.toHaveBeenCalled();
    expect(editMessageReplyMarkupSpy).not.toHaveBeenCalled();
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-approve-error");
  });

  it("allows target-only exec resolution despite a misleading plugin id prefix", async () => {
    onSpy.mockClear();
    editMessageReplyMarkupSpy.mockClear();
    editMessageTextSpy.mockClear();
    resolveExecApprovalSpy.mockClear();

    loadConfig.mockReturnValue({
      approvals: {
        exec: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "telegram", to: "9" }],
        },
      },
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
        },
      },
    });
    createTelegramBot({ token: "tok" });
    const callbackHandler = onSpy.mock.calls.find((call) => call[0] === "callback_query")?.[1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    if (!callbackHandler) {
      throw new Error("Expected Telegram callback_query handler");
    }

    await callbackHandler({
      callbackQuery: {
        id: "cbq-approve-target",
        data: "/approve plugin:misleading-exec-id allow-once",
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1736380800,
          message_id: 23,
          text: "Approval required.",
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    const approvalCall = execApprovalCall();
    const execApprovals = execApprovalTargetConfig(approvalCall);
    expect(execApprovals.enabled).toBe(true);
    expect(execApprovals.mode).toBe("targets");
    expect(approvalCall.approvalId).toBe("plugin:misleading-exec-id");
    expect(approvalCall.approvalKind).toBe("exec");
    expect(approvalCall.decision).toBe("allow-once");
    expect(approvalCall.senderId).toBe("9");
    expect(resolveExecApprovalSpy).toHaveBeenCalledTimes(1);
    expect(editMessageTextSpy).toHaveBeenCalledWith(
      1234,
      23,
      expect.stringContaining("✅ Approval resolved here"),
      { reply_markup: { inline_keyboard: [] } },
    );
    expect(editMessageReplyMarkupSpy).not.toHaveBeenCalled();
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-approve-target");
  });

  it("preserves ambiguous target-only stale callbacks for another approver", async () => {
    onSpy.mockClear();
    editMessageReplyMarkupSpy.mockClear();
    editMessageTextSpy.mockClear();
    resolveExecApprovalSpy.mockClear();
    replySpy.mockClear();
    sendMessageSpy.mockClear();
    resolveExecApprovalSpy.mockRejectedValueOnce(new Error("unknown or expired approval id"));

    loadConfig.mockReturnValue({
      approvals: {
        exec: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "telegram", to: "9" }],
        },
      },
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
        },
      },
    });
    createTelegramBot({ token: "tok" });
    const callbackHandler = onSpy.mock.calls.find((call) => call[0] === "callback_query")?.[1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    if (!callbackHandler) {
      throw new Error("Expected Telegram callback_query handler");
    }

    await callbackHandler({
      callbackQuery: {
        id: "cbq-legacy-plugin-fallback-blocked",
        data: "/approve 138e9b8c allow-once",
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1736380800,
          message_id: 25,
          text: "Legacy plugin approval required.",
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    const approvalCall = execApprovalCall();
    const execApprovals = execApprovalTargetConfig(approvalCall);
    expect(execApprovals.enabled).toBe(true);
    expect(execApprovals.mode).toBe("targets");
    expect(approvalCall.approvalId).toBe("138e9b8c");
    expect(approvalCall.approvalKind).toBe("exec");
    expect(approvalCall.decision).toBe("allow-once");
    expect(approvalCall.senderId).toBe("9");
    expect(resolveExecApprovalSpy).toHaveBeenCalledTimes(1);
    expect(editMessageTextSpy).not.toHaveBeenCalled();
    expect(editMessageReplyMarkupSpy).not.toHaveBeenCalled();
    expect(replySpy).not.toHaveBeenCalled();
    expect(sendMessageSpy).not.toHaveBeenCalled();
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-legacy-plugin-fallback-blocked");
  });

  it("renders a terminal no-longer-pending receipt for expired legacy callbacks", async () => {
    onSpy.mockClear();
    editMessageReplyMarkupSpy.mockClear();
    editMessageTextSpy.mockClear();
    resolveExecApprovalSpy.mockClear();
    replySpy.mockClear();
    sendMessageSpy.mockClear();
    resolveExecApprovalSpy
      .mockRejectedValueOnce(new Error("unknown or expired approval id"))
      .mockRejectedValueOnce(new Error("unknown or expired approval id"));

    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
          execApprovals: {
            enabled: true,
            approvers: ["9"],
            target: "dm",
          },
        },
      },
    });
    createTelegramBot({ token: "tok" });
    const callbackHandler = onSpy.mock.calls.find((call) => call[0] === "callback_query")?.[1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    if (!callbackHandler) {
      throw new Error("Expected Telegram callback_query handler");
    }

    await callbackHandler({
      callbackQuery: {
        id: "cbq-expired-approval",
        data: "/approve 138e9b8c allow-once",
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1736380800,
          message_id: 26,
          text: "Approval required.",
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    const approvalCall = execApprovalCall();
    expect(approvalCall.approvalId).toBe("138e9b8c");
    expect(approvalCall.approvalKind).toBe("exec");
    expect(approvalCall.decision).toBe("allow-once");
    expect(approvalCall.senderId).toBe("9");
    expect(resolveExecApprovalSpy).toHaveBeenCalledTimes(2);
    expect(execApprovalCall(1).approvalKind).toBe("plugin");
    expect(editMessageTextSpy).toHaveBeenCalledWith(
      1234,
      26,
      expect.stringContaining("ℹ️ Approval no longer pending"),
      { reply_markup: { inline_keyboard: [] } },
    );
    expect(editMessageReplyMarkupSpy).not.toHaveBeenCalled();
    expect(replySpy).not.toHaveBeenCalled();
    expect(sendMessageSpy).not.toHaveBeenCalled();
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-expired-approval");
  });

  it("does not call canonical resolution with a guessed kind after a legacy miss", async () => {
    onSpy.mockClear();
    editMessageReplyMarkupSpy.mockClear();
    editMessageTextSpy.mockClear();
    resolveExecApprovalSpy.mockClear();
    resolveExecApprovalSpy.mockRejectedValueOnce(new Error("unknown or expired approval id"));

    loadConfig.mockReturnValue({
      approvals: {
        exec: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "telegram", to: "9" }],
        },
      },
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
          capabilities: ["vision"],
        },
      },
    });
    createTelegramBot({ token: "tok" });
    const callbackHandler = onSpy.mock.calls.find((call) => call[0] === "callback_query")?.[1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    if (!callbackHandler) {
      throw new Error("Expected Telegram callback_query handler");
    }

    await callbackHandler({
      callbackQuery: {
        id: "cbq-plugin-approve-blocked",
        data: "/approve plugin:138e9b8c allow-once",
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1736380800,
          message_id: 24,
          text: "Plugin approval required.",
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(execApprovalCall()).toMatchObject({
      approvalId: "plugin:138e9b8c",
      approvalKind: "exec",
      decision: "allow-once",
      senderId: "9",
    });
    expect(resolveExecApprovalSpy).toHaveBeenCalledTimes(1);
    expect(editMessageReplyMarkupSpy).not.toHaveBeenCalled();
    expect(editMessageTextSpy).not.toHaveBeenCalled();
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-plugin-approve-blocked");
  });

  it("edits commands list for pagination callbacks", async () => {
    onSpy.mockClear();
    listSkillCommandsForAgents.mockClear();

    createTelegramBot({ token: "tok" });
    const callbackHandler = onSpy.mock.calls.find((call) => call[0] === "callback_query")?.[1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    if (!callbackHandler) {
      throw new Error("Expected Telegram callback_query handler");
    }

    await callbackHandler({
      callbackQuery: {
        id: "cbq-3",
        data: "commands_page_2:main",
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1736380800,
          message_id: 12,
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    const listCall = requireRecord(
      mockArg(
        listSkillCommandsForAgents as unknown as MockCallSource,
        0,
        0,
        "list skill commands call",
      ),
      "list skill commands call",
    );
    expect(listCall.cfg).toBeTypeOf("object");
    expect(listCall.agentIds).toEqual(["main"]);
    expect(editMessageTextSpy).toHaveBeenCalledTimes(1);
    const [chatId, messageId, text, params] = mockCall(
      editMessageTextSpy as unknown as MockCallSource,
      0,
      "edit message text",
    );
    expect(chatId).toBe(1234);
    expect(messageId).toBe(12);
    expect(String(text)).toContain(`${INFO_EMOJI} Commands (2/`);
    expect(params).toEqual({
      reply_markup: {
        inline_keyboard: [
          [
            { text: "◀ Prev", callback_data: "commands_page_1:main" },
            { text: "2/6", callback_data: "commands_page_noop:main" },
            { text: "Next ▶", callback_data: "commands_page_3:main" },
          ],
        ],
      },
    });
  });

  it("falls back to default agent for pagination callbacks without agent suffix", async () => {
    onSpy.mockClear();
    listSkillCommandsForAgents.mockClear();

    createTelegramBot({ token: "tok" });
    const callbackHandler = onSpy.mock.calls.find((call) => call[0] === "callback_query")?.[1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    if (!callbackHandler) {
      throw new Error("Expected Telegram callback_query handler");
    }

    await callbackHandler({
      callbackQuery: {
        id: "cbq-no-suffix",
        data: "commands_page_2",
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1736380800,
          message_id: 14,
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    const listCall = requireRecord(
      mockArg(
        listSkillCommandsForAgents as unknown as MockCallSource,
        0,
        0,
        "list skill commands call",
      ),
      "list skill commands call",
    );
    expect(listCall.cfg).toBeTypeOf("object");
    expect(listCall.agentIds).toEqual(["main"]);
    expect(editMessageTextSpy).toHaveBeenCalledTimes(1);
  });

  it("ignores unsafe command pagination pages", async () => {
    onSpy.mockClear();
    listSkillCommandsForAgents.mockClear();
    editMessageTextSpy.mockClear();

    createTelegramBot({ token: "tok" });
    const callbackHandler = onSpy.mock.calls.find((call) => call[0] === "callback_query")?.[1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    if (!callbackHandler) {
      throw new Error("Expected Telegram callback_query handler");
    }

    await callbackHandler({
      callbackQuery: {
        id: "cbq-unsafe-page",
        data: "commands_page_9007199254740993:main",
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1736380800,
          message_id: 16,
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(listSkillCommandsForAgents).not.toHaveBeenCalled();
    expect(editMessageTextSpy).not.toHaveBeenCalled();
  });

  it("blocks pagination callbacks when allowlist rejects sender", async () => {
    onSpy.mockClear();
    editMessageTextSpy.mockClear();

    const config = {
      channels: {
        telegram: {
          dmPolicy: "pairing" as const,
          capabilities: { inlineButtons: "allowlist" as const },
          allowFrom: [],
        },
      },
    };
    loadConfig.mockReturnValue(config);
    createTelegramBot({
      token: "tok",
      config,
    });
    const callbackHandler = onSpy.mock.calls.find((call) => call[0] === "callback_query")?.[1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    if (!callbackHandler) {
      throw new Error("Expected Telegram callback_query handler");
    }

    await callbackHandler({
      callbackQuery: {
        id: "cbq-4",
        data: "commands_page_2",
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1736380800,
          message_id: 13,
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(editMessageTextSpy).not.toHaveBeenCalled();
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-4");
  });

  it("routes compact model callbacks against the configured provider", async () => {
    onSpy.mockClear();
    replySpy.mockClear();
    editMessageTextSpy.mockClear();

    const modelId = "us.anthropic.claude-3-5-sonnet-20240620-v1:0";
    const storePath = `/tmp/openclaw-telegram-model-compact-${process.pid}-${Date.now()}.json`;
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          model: `amazon-bedrock/${modelId}`,
        },
      },
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
        },
      },
      session: {
        store: storePath,
      },
    } satisfies NonNullable<Parameters<typeof createTelegramBot>[0]["config"]>;

    await rm(storePath, { force: true });
    try {
      loadConfig.mockReturnValue(config);
      createTelegramBot({
        token: "tok",
        config,
      });
      const callbackHandler = onSpy.mock.calls.find(
        (call) => call[0] === "callback_query",
      )?.[1] as (ctx: Record<string, unknown>) => Promise<void>;
      if (!callbackHandler) {
        throw new Error("Expected Telegram callback_query handler");
      }

      await callbackHandler({
        callbackQuery: {
          id: "cbq-model-compact-1",
          data: `mdl_sel/${modelId}`,
          from: { id: 9, first_name: "Ada", username: "ada_bot" },
          message: {
            chat: { id: 1234, type: "private" },
            date: 1736380800,
            message_id: 14,
          },
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ download: async () => new Uint8Array() }),
      });

      expect(replySpy).not.toHaveBeenCalled();
      expect(editMessageTextSpy).toHaveBeenCalledTimes(1);
      expect(String(firstEditMessageTextArg(2))).toContain(
        `${CHECK_MARK_EMOJI} Model reset to default`,
      );
      expect(String(firstEditMessageTextArg(2))).toContain(
        "Session selection cleared. Runtime unchanged. New replies use the agent's configured default.",
      );

      const entry = readOnlySessionEntry(storePath);
      expect(entry?.providerOverride).toBeUndefined();
      expect(entry?.modelOverride).toBeUndefined();
      expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-model-compact-1");
    } finally {
      await rm(storePath, { force: true });
    }
  });

  it("renders model callback lists with configured display names", async () => {
    onSpy.mockClear();
    replySpy.mockClear();
    editMessageTextSpy.mockClear();

    const storePath = `/tmp/openclaw-telegram-model-display-names-${process.pid}-${Date.now()}.json`;
    const buildModelsProviderDataMock =
      telegramBotDepsForTest.buildModelsProviderData as unknown as ReturnType<typeof vi.fn>;
    buildModelsProviderDataMock.mockResolvedValueOnce({
      byProvider: new Map<string, Set<string>>([["openai", new Set(["gpt-5", "gpt-4.1"])]]),
      providers: ["openai"],
      resolvedDefault: { provider: "openai", model: "gpt-5" },
      modelNames: new Map<string, string>([
        ["openai/gpt-4.1", "GPT 4.1 Bridge"],
        ["openai/gpt-5", "GPT Five Bridge"],
      ]),
    });

    const config = {
      agents: {
        defaults: {
          model: "openai/gpt-5",
        },
      },
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
        },
      },
      session: {
        store: storePath,
      },
    } satisfies NonNullable<Parameters<typeof createTelegramBot>[0]["config"]>;

    await rm(storePath, { force: true });
    try {
      loadConfig.mockReturnValue(config);
      createTelegramBot({
        token: "tok",
        config,
      });
      const callbackHandler = onSpy.mock.calls.find(
        (call) => call[0] === "callback_query",
      )?.[1] as (ctx: Record<string, unknown>) => Promise<void>;
      if (!callbackHandler) {
        throw new Error("Expected Telegram callback_query handler");
      }

      await callbackHandler({
        callbackQuery: {
          id: "cbq-model-display-names-1",
          data: "mdl_list_openai_1",
          from: { id: 9, first_name: "Ada", username: "ada_bot" },
          message: {
            chat: { id: 1234, type: "private" },
            date: 1736380800,
            message_id: 23,
          },
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ download: async () => new Uint8Array() }),
      });

      expect(replySpy).not.toHaveBeenCalled();
      expect(editMessageTextSpy).toHaveBeenCalledTimes(1);
      const params = firstEditMessageTextArg(3);
      const inlineKeyboard = (
        params as {
          reply_markup?: {
            inline_keyboard?: Array<Array<{ text?: string; callback_data?: string }>>;
          };
        }
      ).reply_markup?.inline_keyboard;

      expect(inlineKeyboard).toStrictEqual([
        [{ text: "GPT 4.1 Bridge", callback_data: "mdl_sel_openai/gpt-4.1" }],
        [{ text: "GPT Five Bridge ✓", callback_data: "mdl_sel_openai/gpt-5" }],
        [{ text: "<< Back", callback_data: "mdl_back" }],
      ]);
      expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-model-display-names-1");
    } finally {
      await rm(storePath, { force: true });
    }
  });

  it("resets overrides when selecting the configured default model", async () => {
    onSpy.mockClear();
    replySpy.mockClear();
    editMessageTextSpy.mockClear();

    const storePath = `/tmp/openclaw-telegram-model-default-${process.pid}-${Date.now()}.json`;
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          model: "claude-opus-4-6",
          models: {
            "anthropic/claude-opus-4-6": {},
          },
        },
      },
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
        },
      },
      session: {
        store: storePath,
      },
    };

    await rm(storePath, { force: true });
    try {
      loadConfig.mockReturnValue(config);
      createTelegramBot({
        token: "tok",
        config,
      });
      const callbackHandler = onSpy.mock.calls.find(
        (call) => call[0] === "callback_query",
      )?.[1] as (ctx: Record<string, unknown>) => Promise<void>;
      if (!callbackHandler) {
        throw new Error("Expected Telegram callback_query handler");
      }

      await callbackHandler({
        callbackQuery: {
          id: "cbq-model-default-1",
          data: "mdl_sel_anthropic/claude-opus-4-6",
          from: { id: 9, first_name: "Ada", username: "ada_bot" },
          message: {
            chat: { id: 1234, type: "private" },
            date: 1736380800,
            message_id: 16,
          },
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ download: async () => new Uint8Array() }),
      });

      expect(replySpy).not.toHaveBeenCalled();
      expect(editMessageTextSpy).toHaveBeenCalledTimes(1);
      expect(String(firstEditMessageTextArg(2))).toContain(
        `${CHECK_MARK_EMOJI} Model reset to default`,
      );
      expect(String(firstEditMessageTextArg(2))).toContain(
        "Session selection cleared. Runtime unchanged. New replies use the agent's configured default.",
      );

      const entry = readOnlySessionEntry(storePath);
      expect(entry?.providerOverride).toBeUndefined();
      expect(entry?.modelOverride).toBeUndefined();
      expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-model-default-1");
    } finally {
      await rm(storePath, { force: true });
    }
  });

  it("formats non-default model selection confirmations with Telegram HTML parse mode", async () => {
    onSpy.mockClear();
    replySpy.mockClear();
    editMessageTextSpy.mockClear();

    const storePath = `/tmp/openclaw-telegram-model-html-${process.pid}-${Date.now()}.json`;

    await rm(storePath, { force: true });
    try {
      const config = {
        agents: {
          defaults: {
            model: "anthropic/claude-opus-4-6",
            models: {
              "anthropic/claude-opus-4-6": {},
              "openai/gpt-5.4": {},
            },
          },
        },
        channels: {
          telegram: {
            dmPolicy: "open",
            allowFrom: ["*"],
          },
        },
        session: {
          store: storePath,
        },
      } satisfies NonNullable<Parameters<typeof createTelegramBot>[0]["config"]>;

      loadConfig.mockReturnValue(config);
      createTelegramBot({
        token: "tok",
        config,
      });
      const callbackHandler = onSpy.mock.calls.find(
        (call) => call[0] === "callback_query",
      )?.[1] as (ctx: Record<string, unknown>) => Promise<void>;
      if (!callbackHandler) {
        throw new Error("Expected Telegram callback_query handler");
      }

      await callbackHandler({
        callbackQuery: {
          id: "cbq-model-html-1",
          data: "mdl_sel_openai/gpt-5.4",
          from: { id: 9, first_name: "Ada", username: "ada_bot" },
          message: {
            chat: { id: 1234, type: "private" },
            date: 1736380800,
            message_id: 17,
          },
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ download: async () => new Uint8Array() }),
      });

      expect(replySpy).not.toHaveBeenCalled();
      expect(editMessageTextSpy).toHaveBeenCalledTimes(1);
      const editCall = mockCall(
        editMessageTextSpy as unknown as MockCallSource,
        0,
        "edit message text",
      );
      expect(editCall[0]).toBe(1234);
      expect(editCall[1]).toBe(17);
      expect(editCall[2]).toBe(
        `${CHECK_MARK_EMOJI} Model changed to <b>openai/gpt-5.4</b>\n\nSession-only model selection. Runtime unchanged. Use /model openai/gpt-5.4 --runtime &lt;runtime&gt; to switch harnesses. The agent default in openclaw.json is unchanged; /reset or a new session may return to that default.`,
      );
      expect(requireRecord(editCall[3], "edit params").parse_mode).toBe("HTML");

      const entry = readOnlySessionEntry(storePath);
      expect(entry?.providerOverride).toBe("openai");
      expect(entry?.modelOverride).toBe("gpt-5.4");
      expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-model-html-1");
    } finally {
      await rm(storePath, { force: true });
    }
  });

  it("keeps hot-reloaded model pins on the next assembled turn", async () => {
    // Regression: the callback handler used the startup `cfg` snapshot for
    // store path and default-model resolution.  If the config was reloaded
    // (e.g. default model changed) the override could be written to the wrong
    // store or incorrectly cleared because `isDefaultSelection` was wrong.
    onSpy.mockClear();
    replySpy.mockClear();
    editMessageTextSpy.mockClear();

    const storePath = `/tmp/openclaw-telegram-model-fresh-cfg-${process.pid}-${Date.now()}.json`;
    const debounceMs = 4321;

    await rm(storePath, { force: true });
    try {
      // Startup config: default is openai/gpt-5.4
      const startupConfig = {
        agents: {
          defaults: {
            model: "openai/gpt-5.4",
            models: {
              "openai/gpt-5.4": {},
              "anthropic/claude-opus-4-6": {},
            },
          },
        },
        channels: {
          telegram: {
            dmPolicy: "open",
            allowFrom: ["*"],
          },
        },
        messages: { inbound: { debounceMs } },
        session: {
          store: storePath,
        },
      } satisfies NonNullable<Parameters<typeof createTelegramBot>[0]["config"]>;

      // Fresh config: default changed and GPT-5.6 Luna was added after startup.
      const freshConfig = {
        ...startupConfig,
        agents: {
          defaults: {
            model: "anthropic/claude-opus-4-6",
            models: {
              "openai/gpt-5.4": {},
              "openai/gpt-5.6-luna": {},
              "anthropic/claude-opus-4-6": {},
            },
          },
        },
      };
      const authorizationConfig = { ...freshConfig };

      // Bot created with startup config; loadConfig now returns fresh config
      loadConfig.mockReturnValue(freshConfig);
      createTelegramBot({
        token: "tok",
        config: startupConfig,
      });
      const callbackHandler = onSpy.mock.calls.find(
        (call) => call[0] === "callback_query",
      )?.[1] as (ctx: Record<string, unknown>) => Promise<void>;
      if (!callbackHandler) {
        throw new Error("Expected Telegram callback_query handler");
      }

      // The old startup default is no longer the live default, so selecting it
      // must persist an override instead of being cleared as inherited.
      await callbackHandler({
        callbackQuery: {
          id: "cbq-model-fresh-cfg-1",
          data: "mdl_sel_openai/gpt-5.4",
          from: { id: 9, first_name: "Ada", username: "ada_bot" },
          message: {
            chat: { id: 1234, type: "private" },
            date: 1736380800,
            message_id: 20,
          },
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ download: async () => new Uint8Array() }),
      });

      // Override must be persisted (not cleared) because openai/gpt-5.4 is
      // NOT the default in the fresh config.
      const entry = readOnlySessionEntry(storePath);
      expect(entry?.providerOverride).toBe("openai");
      expect(entry?.modelOverride).toBe("gpt-5.4");
      expect(entry?.modelOverrideSource).toBe("user");

      // A model added after startup must also resolve and become the new user pin.
      await callbackHandler({
        callbackQuery: {
          id: "cbq-model-fresh-cfg-2",
          data: "mdl_sel_openai/gpt-5.6-luna",
          from: { id: 9, first_name: "Ada", username: "ada_bot" },
          message: {
            chat: { id: 1234, type: "private" },
            date: 1736380801,
            message_id: 21,
          },
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ download: async () => new Uint8Array() }),
      });

      const lunaEntry = readOnlySessionEntry(storePath);
      expect(lunaEntry?.providerOverride).toBe("openai");
      expect(lunaEntry?.modelOverride).toBe("gpt-5.6-luna");
      expect(lunaEntry?.modelOverrideSource).toBe("user");

      dispatchReplyWithBufferedBlockDispatcher.mockClear();
      replySpy.mockClear();
      loadConfig.mockClear();
      loadConfig
        .mockImplementationOnce(() => authorizationConfig)
        .mockImplementationOnce(() => freshConfig)
        .mockReturnValue(startupConfig);

      const messageHandler = getOnHandler("message") as (
        ctx: Record<string, unknown>,
      ) => Promise<void>;
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      try {
        const replyDelivered = waitForReplyCalls(1);
        await messageHandler({
          me: { id: 999, username: "openclaw_bot" },
          getFile: async () => ({ download: async () => new Uint8Array() }),
          message: {
            chat: { id: 1234, type: "private" },
            text: "use the selected model",
            date: 1_736_380_802,
            message_id: 22,
            from: { id: 9, is_bot: false, first_name: "Ada", username: "ada_bot" },
          },
        });

        expect(loadConfig).toHaveBeenCalledTimes(1);
        const flushTimerCallIndex = setTimeoutSpy.mock.calls.findLastIndex(
          (call) => call[1] === debounceMs,
        );
        const flushTimer =
          flushTimerCallIndex >= 0
            ? (setTimeoutSpy.mock.calls[flushTimerCallIndex]?.[0] as (() => unknown) | undefined)
            : undefined;
        if (flushTimerCallIndex >= 0) {
          clearTimeout(
            setTimeoutSpy.mock.results[flushTimerCallIndex]?.value as ReturnType<typeof setTimeout>,
          );
        }
        expect(flushTimer).toBeTypeOf("function");
        await flushTimer?.();
        await replyDelivered;
      } finally {
        setTimeoutSpy.mockRestore();
      }

      expect(loadConfig).toHaveBeenCalledTimes(2);
      const dispatchParams = mockArg(
        dispatchReplyWithBufferedBlockDispatcher as unknown as MockCallSource,
        0,
        0,
        "buffered dispatch",
      ) as { cfg?: OpenClawConfig };
      expect(dispatchParams.cfg).toBe(freshConfig);

      const afterTurn = readOnlySessionEntry(storePath);
      expect(afterTurn?.providerOverride).toBe("openai");
      expect(afterTurn?.modelOverride).toBe("gpt-5.6-luna");
      expect(afterTurn?.modelOverrideSource).toBe("user");
    } finally {
      await rm(storePath, { force: true });
    }
  });

  it("rejects ambiguous compact model callbacks and returns provider list", async () => {
    onSpy.mockClear();
    replySpy.mockClear();
    editMessageTextSpy.mockClear();

    createTelegramBot({
      token: "tok",
      config: {
        agents: {
          defaults: {
            model: "anthropic/shared-model",
            models: {
              "anthropic/shared-model": {},
              "openai/shared-model": {},
            },
          },
        },
        channels: {
          telegram: {
            dmPolicy: "open",
            allowFrom: ["*"],
          },
        },
      },
    });
    const callbackHandler = onSpy.mock.calls.find((call) => call[0] === "callback_query")?.[1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    if (!callbackHandler) {
      throw new Error("Expected Telegram callback_query handler");
    }

    await callbackHandler({
      callbackQuery: {
        id: "cbq-model-compact-2",
        data: "mdl_sel/shared-model",
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1736380800,
          message_id: 15,
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).not.toHaveBeenCalled();
    expect(editMessageTextSpy).toHaveBeenCalledTimes(1);
    expect(String(firstEditMessageTextArg(2))).toContain('Could not resolve model "shared-model".');
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-model-compact-2");
  });

  it("includes sender identity in group envelope headers", async () => {
    onSpy.mockClear();
    replySpy.mockClear();

    loadConfig.mockReturnValue({
      agents: {
        defaults: {
          envelopeTimezone: "utc",
        },
      },
      channels: {
        telegram: {
          groupPolicy: "open",
          groups: { "*": { requireMention: false } },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: 42, type: "group", title: "Ops" },
        text: "hello",
        date: 1736380800,
        message_id: 2,
        from: {
          id: 99,
          first_name: "Ada",
          last_name: "Lovelace",
          username: "ada",
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = mockMsgContextArg(replySpy as unknown as MockCallSource, 0, 0, "replySpy call");
    const { expectChannelInboundContextContract: expectInboundContextContract } =
      await loadInboundContextContract();
    const { escapeRegExp, formatEnvelopeTimestamp } = await loadEnvelopeTimestampHelpers();
    expectInboundContextContract(payload);
    const expectedTimestamp = formatEnvelopeTimestamp(new Date("2025-01-09T00:00:00Z"));
    const timestampPattern = escapeRegExp(expectedTimestamp);
    expect(payload.Body).toMatch(
      new RegExp(`^\\[Telegram Ops id:42 (\\+\\d+[smhd] )?${timestampPattern}\\]`),
    );
    expect(payload.SenderName).toBe("Ada Lovelace");
    expect(payload.SenderId).toBe("99");
    expect(payload.SenderUsername).toBe("ada");
  });

  it("adds live chat and reply-target windows for stale group replies", async () => {
    onSpy.mockClear();
    replySpy.mockClear();

    loadConfig.mockReturnValue({
      agents: {
        defaults: {
          envelopeTimezone: "utc",
        },
      },
      channels: {
        telegram: {
          groupPolicy: "open",
          groups: { "*": { requireMention: false } },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;
    const baseCtx = {
      me: { id: 999, username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    };

    await handler({
      ...baseCtx,
      message: {
        chat: { id: 42, type: "group", title: "Ops" },
        text: "Earlier deployment answer",
        date: 1736380200,
        message_id: 100,
        from: { id: 777, is_bot: true, first_name: "Assistant" },
      },
    });
    await handler({
      ...baseCtx,
      message: {
        chat: { id: 42, type: "group", title: "Ops" },
        text: "Lunch after standup?",
        date: 1736380800,
        message_id: 200,
        from: { id: 201, is_bot: false, first_name: "Sam" },
      },
    });
    await handler({
      ...baseCtx,
      message: {
        chat: { id: 42, type: "group", title: "Ops" },
        text: "After the incident review.",
        date: 1736380860,
        message_id: 201,
        from: { id: 202, is_bot: false, first_name: "Riley" },
      },
    });

    replySpy.mockClear();
    await handler({
      ...baseCtx,
      message: {
        chat: { id: 42, type: "group", title: "Ops" },
        text: "@openclaw_bot thoughts?",
        date: 1736380920,
        message_id: 202,
        from: { id: 203, is_bot: false, first_name: "Avery" },
        reply_to_message: {
          chat: { id: 42, type: "group", title: "Ops" },
          text: "Earlier deployment answer",
          date: 1736380200,
          message_id: 100,
          from: { id: 777, is_bot: true, first_name: "Assistant" },
        },
      },
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = mockMsgContextArg(replySpy as unknown as MockCallSource, 0, 0, "replySpy call");
    const [conversationContext] = requireArray(
      payload.UntrustedStructuredContext,
      "structured context",
    );
    const contextRecord = requireRecord(conversationContext, "conversation context");
    expect(contextRecord.label).toBe("Conversation context");
    const contextPayload = requireRecord(contextRecord.payload, "conversation context payload");
    expect(contextPayload.relation).toBe("selected_for_current_message");
    const messages = requireArray(contextPayload.messages, "conversation context messages").map(
      (message, index) => requireRecord(message, `conversation context message ${index + 1}`),
    );
    const messagesById = new Map(messages.map((message) => [message.message_id, message]));
    expect(messagesById.get("100")?.sender).toBe("Assistant");
    expect(messagesById.get("100")?.body).toBe("Earlier deployment answer");
    expect(messagesById.get("100")?.is_reply_target).toBe(true);
    expect(messagesById.get("200")?.sender).toBe("Sam");
    expect(messagesById.get("200")?.body).toBe("Lunch after standup?");
    expect(messagesById.get("201")?.sender).toBe("Riley");
    expect(messagesById.get("201")?.body).toBe("After the incident review.");
  });

  it("keeps skipped group messages in default recent group history context", async () => {
    onSpy.mockClear();
    replySpy.mockClear();

    loadConfig.mockReturnValue({
      agents: {
        defaults: {
          envelopeTimezone: "utc",
        },
      },
      channels: {
        telegram: {
          groupPolicy: "allowlist",
          groupAllowFrom: ["111", "222"],
          groups: { "*": { requireMention: true } },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;
    const baseCtx = {
      me: { id: 999, username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    };

    await handler({
      ...baseCtx,
      message: {
        chat: { id: 42, type: "group", title: "Ops" },
        text: "Please run the maintenance step later.",
        date: 1736380800,
        message_id: 501,
        from: { id: 111, is_bot: false, first_name: "Requester" },
      },
    });
    expect(replySpy).not.toHaveBeenCalled();

    await handler({
      ...baseCtx,
      message: {
        chat: { id: 42, type: "group", title: "Ops" },
        text: "@openclaw_bot Hello",
        date: 1736380860,
        message_id: 502,
        from: { id: 222, is_bot: false, first_name: "Operator" },
        entities: [{ type: "mention", offset: 0, length: 13 }],
      },
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = mockMsgContextArg(replySpy as unknown as MockCallSource, 0, 0, "replySpy call");
    expect(payload.UntrustedStructuredContext).toEqual([
      {
        label: "Conversation context",
        payload: {
          messages: [
            expect.objectContaining({
              body: "Please run the maintenance step later.",
              sender: "Requester",
            }),
          ],
          order: "chronological",
          relation: "selected_for_current_message",
        },
        source: "telegram",
        type: "chat_window",
      },
    ]);
  });

  it("excludes ambient transcript rows from live group conversation context", async () => {
    onSpy.mockClear();
    replySpy.mockClear();

    loadConfig.mockReturnValue({
      agents: {
        defaults: {
          envelopeTimezone: "utc",
        },
      },
      channels: {
        telegram: {
          groupPolicy: "allowlist",
          groupAllowFrom: ["111", "222", "333", "444"],
          groups: { "*": { requireMention: true } },
        },
      },
    });

    const previousReadAmbient = telegramBotDepsForTest.readAmbientTranscriptWatermark;
    const previousResolveAmbientKey = telegramBotDepsForTest.resolveAmbientTranscriptWatermarkKey;
    telegramBotDepsForTest.resolveAmbientTranscriptWatermarkKey = vi.fn(
      () => "telegram:default:42",
    );
    telegramBotDepsForTest.readAmbientTranscriptWatermark = vi.fn(() => ({
      sessionId: "session-current",
      messageId: "502",
      timestampMs: 1_736_380_860_000,
      updatedAt: 1_736_380_900_000,
    }));

    try {
      createTelegramBot({ token: "tok" });
      const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;
      const baseCtx = {
        me: { id: 999, username: "openclaw_bot" },
        getFile: async () => ({ download: async () => new Uint8Array() }),
      };

      for (const message of [
        {
          chat: { id: 42, type: "group", title: "Ops" },
          text: "persisted ambient one",
          date: 1_736_380_800,
          message_id: 501,
          from: { id: 111, is_bot: false, first_name: "Requester" },
        },
        {
          chat: { id: 42, type: "group", title: "Ops" },
          text: "persisted ambient two",
          date: 1_736_380_860,
          message_id: 502,
          from: { id: 222, is_bot: false, first_name: "Operator" },
        },
        {
          chat: { id: 42, type: "group", title: "Ops" },
          text: "unpersisted gap",
          date: 1_736_380_920,
          message_id: 503,
          from: { id: 333, is_bot: false, first_name: "Mira" },
        },
      ]) {
        await handler({ ...baseCtx, message });
      }

      expect(replySpy).not.toHaveBeenCalled();

      await handler({
        ...baseCtx,
        message: {
          chat: { id: 42, type: "group", title: "Ops" },
          text: "@openclaw_bot what changed?",
          date: 1_736_380_980,
          message_id: 504,
          from: { id: 444, is_bot: false, first_name: "Pat" },
          entities: [{ type: "mention", offset: 0, length: 13 }],
        },
      });

      expect(replySpy).toHaveBeenCalledTimes(1);
      const payload = mockMsgContextArg(
        replySpy as unknown as MockCallSource,
        0,
        0,
        "replySpy call",
      );
      const [conversationContext] = requireArray(
        payload.UntrustedStructuredContext,
        "structured context",
      );
      const contextPayload = requireRecord(
        requireRecord(conversationContext, "conversation context").payload,
        "conversation context payload",
      );
      const messages = requireArray(contextPayload.messages, "conversation context messages").map(
        (message, index) => requireRecord(message, `conversation context message ${index + 1}`),
      );
      expect(messages.map((message) => message.body)).toEqual(["unpersisted gap"]);
    } finally {
      telegramBotDepsForTest.readAmbientTranscriptWatermark = previousReadAmbient;
      telegramBotDepsForTest.resolveAmbientTranscriptWatermarkKey = previousResolveAmbientKey;
    }
  });

  it("honors historyLimit zero for group chat-window context", async () => {
    onSpy.mockClear();
    replySpy.mockClear();

    loadConfig.mockReturnValue({
      agents: {
        defaults: {
          envelopeTimezone: "utc",
        },
      },
      channels: {
        telegram: {
          groupPolicy: "allowlist",
          groupAllowFrom: ["111", "222"],
          historyLimit: 0,
          groups: { "*": { requireMention: true } },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;
    const baseCtx = {
      me: { id: 999, username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    };

    await handler({
      ...baseCtx,
      message: {
        chat: { id: 42, type: "group", title: "Ops" },
        text: "Do not include this cached group line.",
        date: 1736380800,
        message_id: 601,
        from: { id: 111, is_bot: false, first_name: "Requester" },
      },
    });
    expect(replySpy).not.toHaveBeenCalled();

    await handler({
      ...baseCtx,
      message: {
        chat: { id: 42, type: "group", title: "Ops" },
        text: "@openclaw_bot Hello",
        date: 1736380860,
        message_id: 602,
        from: { id: 222, is_bot: false, first_name: "Operator" },
        entities: [{ type: "mention", offset: 0, length: 13 }],
      },
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = mockMsgContextArg(replySpy as unknown as MockCallSource, 0, 0, "replySpy call");
    expect(payload.UntrustedStructuredContext).toBeUndefined();
    expect(payload.Body).not.toContain("Do not include this cached group line.");
  });

  it("updates cached bot messages from Telegram edit updates", async () => {
    onSpy.mockClear();
    replySpy.mockClear();

    loadConfig.mockReturnValue({
      agents: {
        defaults: {
          envelopeTimezone: "utc",
        },
      },
      channels: {
        telegram: {
          groupPolicy: "open",
          groups: { "*": { requireMention: false } },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;
    const editedHandler = getOnHandler("edited_message") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    const baseCtx = {
      me: { id: 999, username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    };
    const chat = { id: 42, type: "group", title: "Ops" };
    const question = {
      chat,
      text: "/ask which bikes can reach 383kmph",
      date: 1778474813,
      message_id: 35014,
      from: { id: 201, is_bot: false, first_name: "Kesava" },
    };
    const fullAnswer =
      "Kawasaki Ninja H2R (claimed 400 km/h) and MTT 420RR turbine (claimed up to 439 km/h) exceed 383 km/h. Dodge Tomahawk reaches higher but is a 4-wheeled concept, not a standard bike.";

    await handler({
      ...baseCtx,
      message: question,
    });
    await handler({
      ...baseCtx,
      message: {
        chat,
        text: "K",
        date: 1778474823,
        message_id: 35016,
        from: { id: 777, is_bot: true, first_name: "Super Serious Bot" },
        reply_to_message: question,
      },
    });

    replySpy.mockClear();
    await editedHandler({
      ...baseCtx,
      editedMessage: {
        chat,
        text: fullAnswer,
        date: 1778474823,
        edit_date: 1778474824,
        message_id: 35016,
        from: { id: 777, is_bot: true, first_name: "Super Serious Bot" },
        reply_to_message: question,
      },
    });
    expect(replySpy).not.toHaveBeenCalled();

    await handler({
      ...baseCtx,
      message: {
        chat,
        text: "wtf",
        date: 1778474850,
        message_id: 35018,
        from: { id: 202, is_bot: false, first_name: "Kesava" },
      },
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = mockMsgContextArg(replySpy as unknown as MockCallSource, 0, 0, "replySpy call");
    const [conversationContext] = requireArray(
      payload.UntrustedStructuredContext,
      "structured context",
    );
    const contextRecord = requireRecord(conversationContext, "conversation context");
    const contextPayload = requireRecord(contextRecord.payload, "conversation context payload");
    const messages = requireArray(contextPayload.messages, "conversation context messages").map(
      (message, index) => requireRecord(message, `conversation context message ${index + 1}`),
    );
    const messagesById = new Map(messages.map((message) => [message.message_id, message]));
    expect(messagesById.get("35016")?.sender).toBe("Super Serious Bot");
    expect(messagesById.get("35016")?.body).toBe(fullAnswer);
    expect(messagesById.get("35016")?.body).not.toBe("K");
  });

  it("keeps direct Telegram media context when transcript context exists", async () => {
    onSpy.mockClear();
    replySpy.mockClear();

    const storePath = `/tmp/openclaw-telegram-dm-media-context-${process.pid}-${Date.now()}.json`;
    const config = {
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
        },
      },
      session: {
        store: storePath,
      },
    } satisfies NonNullable<Parameters<typeof createTelegramBot>[0]["config"]>;

    await rm(storePath, { force: true });
    try {
      loadConfig.mockReturnValue(config);
      createTelegramBot({ token: "tok", config });
      const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;
      const baseCtx = {
        me: { id: 999, username: "openclaw_bot" },
        getFile: async () => ({ download: async () => new Uint8Array() }),
      };

      await handler({
        ...baseCtx,
        message: {
          chat: { id: 7771, type: "private" },
          caption: "the reference image",
          date: 1778474800,
          message_id: 100,
          from: { id: 202, is_bot: false, first_name: "Kesava" },
          photo: [{ file_id: "reference-photo-1", width: 1, height: 1 }],
        },
      });

      await writeDirectTelegramTranscriptContext({
        cfg: config,
        storePath,
        chatId: 7771,
        senderId: 202,
        sessionId: "telegram-dm-media-context-session",
        text: "remember the launch checklist",
        timestamp: 1778474700000,
      });

      replySpy.mockClear();
      await handler({
        ...baseCtx,
        message: {
          chat: { id: 7771, type: "private" },
          text: "what about the image above?",
          date: 1778474850,
          message_id: 101,
          from: { id: 202, is_bot: false, first_name: "Kesava" },
        },
      });

      expect(replySpy).toHaveBeenCalledTimes(1);
      const payload = mockMsgContextArg(
        replySpy as unknown as MockCallSource,
        0,
        0,
        "replySpy call",
      );
      const [conversationContext] = requireArray(
        payload.UntrustedStructuredContext,
        "structured context",
      );
      const contextRecord = requireRecord(conversationContext, "conversation context");
      const contextPayload = requireRecord(contextRecord.payload, "conversation context payload");
      const messages = requireArray(contextPayload.messages, "conversation context messages").map(
        (message, index) => requireRecord(message, `conversation context message ${index + 1}`),
      );
      expect(messages.some((message) => message.body === "remember the launch checklist")).toBe(
        true,
      );
      const photoMessage = messages.find((message) => message.message_id === "100");
      expect(photoMessage?.body).toBe("the reference image");
      expect(photoMessage?.media_ref).toBe("telegram:file/reference-photo-1");
    } finally {
      await rm(storePath, { force: true });
    }
  });

  it("dedupes an unversioned outbound row by its explicit legacy prompt timestamp", async () => {
    onSpy.mockClear();
    replySpy.mockClear();

    const storePath = `/tmp/openclaw-telegram-dm-legacy-dedupe-${process.pid}-${Date.now()}.json`;
    const config = {
      channels: { telegram: { dmPolicy: "open", allowFrom: ["*"] } },
      session: { store: storePath },
    } satisfies NonNullable<Parameters<typeof createTelegramBot>[0]["config"]>;
    const chatId = 7772;
    const senderId = 202;
    const transcriptTimestampMs = 1_778_474_700_000;

    await rm(storePath, { force: true });
    try {
      loadConfig.mockReturnValue(config);
      await writeDirectTelegramTranscriptContext({
        cfg: config,
        storePath,
        chatId,
        role: "assistant",
        senderId,
        sessionId: "telegram-legacy-outbound-dedupe",
        text: "Legacy answer",
        timestamp: transcriptTimestampMs,
      });
      await seedTelegramPromptContextMessages({
        storePath,
        chatId,
        messages: [
          {
            messageId: 735,
            text: "Legacy answer",
            date: transcriptTimestampMs / 1000 + 5,
            legacyPromptContextTimestampMs: transcriptTimestampMs,
            unversioned: true,
          },
        ],
      });
      createTelegramBot({ token: "tok", config });

      const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;
      await handler({
        me: { id: 999, username: "openclaw_bot" },
        getFile: async () => ({ download: async () => new Uint8Array() }),
        message: {
          chat: { id: chatId, type: "private" },
          text: "continue",
          date: 1_778_474_850,
          message_id: 740,
          from: { id: senderId, is_bot: false, first_name: "Kesava" },
        },
      });

      const messages = latestConversationContextMessages();
      expect(messages.filter((message) => message.body === "Legacy answer")).toEqual([
        expect.objectContaining({ message_id: "735" }),
      ]);
      expect(messages.some((message) => String(message.message_id).startsWith("session:"))).toBe(
        false,
      );
    } finally {
      clearTelegramRuntime();
      resetPluginStateStoreForTests();
      await rm(storePath, { force: true });
    }
  });

  it("does not infer projection provenance from a current markerless outbound row", async () => {
    onSpy.mockClear();
    replySpy.mockClear();

    const storePath = `/tmp/openclaw-telegram-dm-markerless-assistant-${process.pid}-${Date.now()}.json`;
    const config = {
      channels: { telegram: { dmPolicy: "open", allowFrom: ["*"] } },
      session: { store: storePath },
    } satisfies NonNullable<Parameters<typeof createTelegramBot>[0]["config"]>;
    const chatId = 7771;
    const senderId = 202;
    const transcriptTimestampMs = 1_778_474_700_000;

    await rm(storePath, { force: true });
    try {
      loadConfig.mockReturnValue(config);
      await writeDirectTelegramTranscriptContext({
        cfg: config,
        storePath,
        chatId,
        role: "assistant",
        senderId,
        sessionId: "telegram-markerless-assistant",
        text: "same visible answer",
        timestamp: transcriptTimestampMs,
      });
      await seedTelegramPromptContextMessages({
        storePath,
        chatId,
        messages: [
          {
            messageId: 734,
            text: "same visible answer",
            date: transcriptTimestampMs / 1000,
          },
        ],
      });
      createTelegramBot({ token: "tok", config });

      const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;
      await handler({
        me: { id: 999, username: "openclaw_bot" },
        getFile: async () => ({ download: async () => new Uint8Array() }),
        message: {
          chat: { id: chatId, type: "private" },
          text: "continue",
          date: 1_778_474_850,
          message_id: 739,
          from: { id: senderId, is_bot: false, first_name: "Kesava" },
        },
      });

      const messages = latestConversationContextMessages();
      expect(
        messages
          .filter((message) => message.body === "same visible answer")
          .map((message) => message.message_id),
      ).toEqual(["session:transcript-assistant-1", "734"]);
    } finally {
      clearTelegramRuntime();
      resetPluginStateStoreForTests();
      await rm(storePath, { force: true });
    }
  });

  it("dedupes a Markdown assistant transcript against its complete Telegram projection", async () => {
    onSpy.mockClear();
    replySpy.mockClear();

    const storePath = `/tmp/openclaw-telegram-dm-visible-dedupe-${process.pid}-${Date.now()}.json`;
    const config = {
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
        },
      },
      session: {
        store: storePath,
      },
    } satisfies NonNullable<Parameters<typeof createTelegramBot>[0]["config"]>;

    await rm(storePath, { force: true });
    await rm(`${storePath}.telegram-messages.json`, { force: true });
    try {
      loadConfig.mockReturnValue(config);
      const chatId = 7773;
      const senderId = 202;
      const visibleReply = "Important: use const.";
      const replyTimestampMs = 1_778_474_700_000;
      const telegramReplyDate = Math.floor((replyTimestampMs + 5_000) / 1000);

      await writeDirectTelegramTranscriptContext({
        cfg: config,
        storePath,
        chatId,
        role: "assistant",
        senderId,
        sessionId: "telegram-dm-assistant-visible-dedupe-session",
        text: "[[reply_to_current]]**Important**: use `const`.",
        timestamp: replyTimestampMs,
      });
      await seedTelegramPromptContextMessages({
        storePath,
        chatId,
        messages: [
          {
            messageId: 736,
            text: visibleReply,
            date: telegramReplyDate,
            projection: {
              transcriptMessageId: "transcript-assistant-1",
              partIndex: 0,
              finalPart: true,
            },
          },
        ],
      });
      createTelegramBot({ token: "tok", config });
      const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;
      const baseCtx = {
        me: { id: 999, is_bot: true, first_name: "OpenClaw", username: "openclaw_bot" },
        getFile: async () => ({ download: async () => new Uint8Array() }),
      };
      await handler({
        ...baseCtx,
        message: {
          chat: { id: chatId, type: "private" },
          text: "still there?",
          date: 1_778_474_850,
          message_id: 741,
          from: { id: senderId, is_bot: false, first_name: "Kesava" },
          reply_to_message: {
            chat: { id: chatId, type: "private" },
            date: telegramReplyDate,
            from: { id: 999, is_bot: true, first_name: "OpenClaw" },
            message_id: 736,
            text: visibleReply,
          },
        },
      });

      expect(replySpy).toHaveBeenCalledTimes(1);
      const payload = mockMsgContextArg(
        replySpy as unknown as MockCallSource,
        0,
        0,
        "replySpy call",
      );
      const [conversationContext] = requireArray(
        payload.UntrustedStructuredContext,
        "structured context",
      );
      const contextRecord = requireRecord(conversationContext, "conversation context");
      const contextPayload = requireRecord(contextRecord.payload, "conversation context payload");
      const messages = requireArray(contextPayload.messages, "conversation context messages").map(
        (message, index) => requireRecord(message, `conversation context message ${index + 1}`),
      );

      expect(messages).toEqual([
        expect.objectContaining({
          body: visibleReply,
          is_reply_target: true,
          message_id: "736",
          sender: "OpenClaw (you)",
        }),
      ]);
      expect(messages.filter((message) => message.body === visibleReply)).toHaveLength(1);
      expect(JSON.stringify(messages)).not.toContain("[[reply_to_current]]");
      expect(messages.some((message) => String(message.message_id).startsWith("session:"))).toBe(
        false,
      );
    } finally {
      clearTelegramRuntime();
      resetPluginStateStoreForTests();
      await rm(storePath, { force: true });
      await rm(`${storePath}.telegram-messages.json`, { force: true });
    }
  });

  it.each([
    {
      name: "part zero",
      parts: [{ messageId: 751, text: "gamma", partIndex: 1, finalPart: true }],
    },
    {
      name: "a middle part",
      parts: [
        { messageId: 752, text: "Alpha", partIndex: 0, finalPart: false },
        { messageId: 754, text: "gamma", partIndex: 2, finalPart: true },
      ],
    },
    {
      name: "the final marker",
      parts: [
        { messageId: 755, text: "Alpha", partIndex: 0, finalPart: false },
        { messageId: 756, text: "beta", partIndex: 1, finalPart: false },
      ],
    },
  ])("keeps the full assistant transcript when $name is missing", async ({ parts }) => {
    onSpy.mockClear();
    replySpy.mockClear();

    const storePath = `/tmp/openclaw-telegram-dm-incomplete-projection-${process.pid}-${parts[0]?.messageId}.json`;
    const config = {
      channels: { telegram: { dmPolicy: "open", allowFrom: ["*"] } },
      session: { store: storePath },
    } satisfies NonNullable<Parameters<typeof createTelegramBot>[0]["config"]>;
    const caseId = parts[0]?.messageId ?? 0;
    const chatId = 10_000 + caseId;
    const senderId = 202;
    const transcriptTimestampMs = 1_778_474_700_000;

    await rm(storePath, { force: true });
    await rm(`${storePath}.telegram-messages.json`, { force: true });
    try {
      loadConfig.mockReturnValue(config);
      await writeDirectTelegramTranscriptContext({
        cfg: config,
        storePath,
        chatId,
        role: "assistant",
        senderId,
        sessionId: `telegram-incomplete-${parts[0]?.messageId}`,
        text: "**Alpha** beta gamma",
        timestamp: transcriptTimestampMs,
      });
      await seedTelegramPromptContextMessages({
        storePath,
        chatId,
        messages: parts.map((part) => ({
          messageId: part.messageId,
          text: part.text,
          date: Math.floor(transcriptTimestampMs / 1000) + part.partIndex + 1,
          projection: {
            transcriptMessageId: "transcript-assistant-1",
            partIndex: part.partIndex,
            finalPart: part.finalPart,
          },
        })),
      });
      createTelegramBot({ token: "tok", config });

      const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;
      replySpy.mockClear();
      await handler({
        me: { id: 999, username: "openclaw_bot" },
        getFile: async () => ({ download: async () => new Uint8Array() }),
        message: {
          chat: { id: chatId, type: "private" },
          text: "continue",
          date: 1_778_474_850,
          message_id: caseId + 100,
          from: { id: senderId, is_bot: false, first_name: "Kesava" },
        },
      });

      expect(replySpy).toHaveBeenCalledTimes(1);
      const messages = latestConversationContextMessages();
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            body: "**Alpha** beta gamma",
            message_id: "session:transcript-assistant-1",
          }),
          ...parts.map((part) =>
            expect.objectContaining({ body: part.text, message_id: String(part.messageId) }),
          ),
        ]),
      );
    } finally {
      clearTelegramRuntime();
      resetPluginStateStoreForTests();
      await rm(storePath, { force: true });
      await rm(`${storePath}.telegram-messages.json`, { force: true });
    }
  });

  it("preserves cached multipart provenance on a markerless Telegram reply target", async () => {
    onSpy.mockClear();
    replySpy.mockClear();

    const storePath = `/tmp/openclaw-telegram-dm-complete-multipart-${process.pid}-${Date.now()}.json`;
    const config = {
      channels: { telegram: { dmPolicy: "open", allowFrom: ["*"] } },
      session: { store: storePath },
    } satisfies NonNullable<Parameters<typeof createTelegramBot>[0]["config"]>;
    const chatId = 7783;
    const senderId = 202;
    const transcriptTimestampMs = 1_778_474_700_000;

    await rm(storePath, { force: true });
    await rm(`${storePath}.telegram-messages.json`, { force: true });
    try {
      loadConfig.mockReturnValue(config);
      setTelegramPluginStateRuntimeForTests();
      createTelegramBot({ token: "tok", config });
      await writeDirectTelegramTranscriptContext({
        cfg: config,
        storePath,
        chatId,
        role: "assistant",
        senderId,
        sessionId: "telegram-complete-multipart",
        text: "**Alpha** beta",
        timestamp: transcriptTimestampMs,
      });
      for (const part of [
        { messageId: 781, text: "Alpha", partIndex: 0, finalPart: false },
        { messageId: 782, text: "beta", partIndex: 1, finalPart: true },
      ]) {
        await recordOutboundMessageForPromptContext({
          cfg: config,
          account: { accountId: "default", name: "OpenClaw" },
          chatId,
          message: {
            message_id: part.messageId,
            date: transcriptTimestampMs / 1000 + part.partIndex + 1,
            text: part.text,
          },
          messageId: part.messageId,
          text: part.text,
          promptContextProjection: {
            transcriptMessageId: "transcript-assistant-1",
            partIndex: part.partIndex,
            finalPart: part.finalPart,
          },
        });
      }

      const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;
      replySpy.mockClear();
      await handler({
        me: { id: 999, username: "openclaw_bot" },
        getFile: async () => ({ download: async () => new Uint8Array() }),
        message: {
          chat: { id: chatId, type: "private" },
          text: "continue",
          date: 1_778_474_850,
          message_id: 783,
          from: { id: senderId, is_bot: false, first_name: "Kesava" },
          reply_to_message: {
            chat: { id: chatId, type: "private" },
            date: transcriptTimestampMs / 1000 + 1,
            from: { id: 999, is_bot: true, first_name: "OpenClaw" },
            message_id: 781,
            text: "Alpha",
          },
        },
      });

      const messages = latestConversationContextMessages();
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ body: "Alpha", is_reply_target: true, message_id: "781" }),
          expect.objectContaining({ body: "beta", message_id: "782" }),
        ]),
      );
      expect(messages.filter((message) => message.message_id === "781")).toHaveLength(1);
      expect(messages.filter((message) => message.message_id === "782")).toHaveLength(1);
      expect(messages.some((message) => String(message.message_id).startsWith("session:"))).toBe(
        false,
      );
    } finally {
      clearTelegramRuntime();
      resetPluginStateStoreForTests();
      await rm(storePath, { force: true });
      await rm(`${storePath}.telegram-messages.json`, { force: true });
    }
  });

  it("keeps an assistant transcript when persisted projection metadata is invalid", async () => {
    onSpy.mockClear();
    replySpy.mockClear();

    const storePath = `/tmp/openclaw-telegram-dm-invalid-projection-${process.pid}-${Date.now()}.json`;
    const config = {
      channels: { telegram: { dmPolicy: "open", allowFrom: ["*"] } },
      session: { store: storePath },
    } satisfies NonNullable<Parameters<typeof createTelegramBot>[0]["config"]>;
    const chatId = 7784;
    const senderId = 202;
    const transcriptTimestampMs = 1_778_474_700_000;

    await rm(storePath, { force: true });
    await rm(`${storePath}.telegram-messages.json`, { force: true });
    try {
      loadConfig.mockReturnValue(config);
      await writeDirectTelegramTranscriptContext({
        cfg: config,
        storePath,
        chatId,
        role: "assistant",
        senderId,
        sessionId: "telegram-invalid-projection",
        text: "same visible answer",
        timestamp: transcriptTimestampMs,
      });
      await seedTelegramPromptContextMessages({
        storePath,
        chatId,
        messages: [
          {
            messageId: 790,
            text: "same visible answer",
            date: transcriptTimestampMs / 1000,
            projection: {
              transcriptMessageId: "transcript-assistant-1",
              partIndex: 0,
              finalPart: true,
            },
          },
          {
            messageId: 791,
            text: "cached trailing part",
            date: transcriptTimestampMs / 1000 + 1,
            projection: {
              transcriptMessageId: "transcript-assistant-1",
              partIndex: 1,
              finalPart: "true",
            },
          },
        ],
      });
      createTelegramBot({ token: "tok", config });

      const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;
      replySpy.mockClear();
      await handler({
        me: { id: 999, username: "openclaw_bot" },
        getFile: async () => ({ download: async () => new Uint8Array() }),
        message: {
          chat: { id: chatId, type: "private" },
          text: "continue",
          date: 1_778_474_850,
          message_id: 792,
          from: { id: senderId, is_bot: false, first_name: "Kesava" },
        },
      });

      const messages = latestConversationContextMessages();
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            body: "same visible answer",
            message_id: "session:transcript-assistant-1",
          }),
          expect.objectContaining({ body: "same visible answer", message_id: "790" }),
          expect.objectContaining({ body: "cached trailing part", message_id: "791" }),
        ]),
      );
    } finally {
      clearTelegramRuntime();
      resetPluginStateStoreForTests();
      await rm(storePath, { force: true });
      await rm(`${storePath}.telegram-messages.json`, { force: true });
    }
  });

  it("keeps identical visible replies correlated to distinct transcript identities", async () => {
    onSpy.mockClear();
    replySpy.mockClear();

    const storePath = `/tmp/openclaw-telegram-dm-repeat-projection-${process.pid}-${Date.now()}.json`;
    const config = {
      channels: { telegram: { dmPolicy: "open", allowFrom: ["*"] } },
      session: { store: storePath },
    } satisfies NonNullable<Parameters<typeof createTelegramBot>[0]["config"]>;
    const chatId = 7781;
    const senderId = 202;
    const transcriptTimestampMs = 1_778_474_700_000;

    await rm(storePath, { force: true });
    try {
      loadConfig.mockReturnValue(config);
      await writeDirectTelegramTranscriptMessages({
        cfg: config,
        storePath,
        chatId,
        senderId,
        sessionId: "telegram-repeat-projection",
        messages: [
          {
            id: "assistant-repeat-1",
            role: "assistant",
            text: "**same answer**",
            timestamp: transcriptTimestampMs,
          },
          {
            id: "assistant-repeat-2",
            role: "assistant",
            text: "_same answer_",
            timestamp: transcriptTimestampMs,
          },
        ],
      });
      await seedTelegramPromptContextMessages({
        storePath,
        chatId,
        messages: [
          {
            messageId: 761,
            text: "same answer",
            date: transcriptTimestampMs / 1000 + 1,
            projection: {
              transcriptMessageId: "assistant-repeat-1",
              partIndex: 0,
              finalPart: true,
            },
          },
          {
            messageId: 762,
            text: "same answer",
            date: transcriptTimestampMs / 1000 + 2,
            projection: {
              transcriptMessageId: "assistant-repeat-2",
              partIndex: 0,
              finalPart: true,
            },
          },
        ],
      });
      createTelegramBot({ token: "tok", config });

      const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;
      replySpy.mockClear();
      await handler({
        me: { id: 999, username: "openclaw_bot" },
        getFile: async () => ({ download: async () => new Uint8Array() }),
        message: {
          chat: { id: chatId, type: "private" },
          text: "continue",
          date: 1_778_474_850,
          message_id: 763,
          from: { id: senderId, is_bot: false, first_name: "Kesava" },
        },
      });

      const messages = latestConversationContextMessages();
      expect(
        messages
          .filter((message) => message.body === "same answer")
          .map((message) => message.message_id),
      ).toEqual(["761", "762"]);
      expect(messages.some((message) => String(message.message_id).startsWith("session:"))).toBe(
        false,
      );
    } finally {
      clearTelegramRuntime();
      resetPluginStateStoreForTests();
      await rm(storePath, { force: true });
      await rm(`${storePath}.telegram-messages.json`, { force: true });
    }
  });

  it("does not collapse literal user Markdown into markerless plain cache text", async () => {
    onSpy.mockClear();
    replySpy.mockClear();

    const storePath = `/tmp/openclaw-telegram-dm-user-markdown-${process.pid}-${Date.now()}.json`;
    const config = {
      channels: { telegram: { dmPolicy: "open", allowFrom: ["*"] } },
      session: { store: storePath },
    } satisfies NonNullable<Parameters<typeof createTelegramBot>[0]["config"]>;
    const chatId = 7782;
    const senderId = 202;
    const timestampMs = 1_778_474_700_000;

    await rm(storePath, { force: true });
    try {
      loadConfig.mockReturnValue(config);
      await writeDirectTelegramTranscriptContext({
        cfg: config,
        storePath,
        chatId,
        senderId,
        sessionId: "telegram-user-markdown",
        text: "**literal user text**",
        timestamp: timestampMs,
      });
      await seedTelegramPromptContextMessages({
        storePath,
        chatId,
        messages: [
          {
            messageId: 771,
            text: "literal user text",
            date: timestampMs / 1000,
          },
        ],
      });
      createTelegramBot({ token: "tok", config });

      const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;
      replySpy.mockClear();
      await handler({
        me: { id: 999, username: "openclaw_bot" },
        getFile: async () => ({ download: async () => new Uint8Array() }),
        message: {
          chat: { id: chatId, type: "private" },
          text: "continue",
          date: 1_778_474_850,
          message_id: 772,
          from: { id: senderId, is_bot: false, first_name: "Kesava" },
        },
      });

      const messages = latestConversationContextMessages();
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            body: "**literal user text**",
            message_id: "session:transcript-user-1",
          }),
          expect.objectContaining({ body: "literal user text", message_id: "771" }),
        ]),
      );
    } finally {
      clearTelegramRuntime();
      resetPluginStateStoreForTests();
      await rm(storePath, { force: true });
      await rm(`${storePath}.telegram-messages.json`, { force: true });
    }
  });

  it("skips direct transcript context for hard reset messages", async () => {
    onSpy.mockClear();
    replySpy.mockClear();

    const storePath = `/tmp/openclaw-telegram-dm-reset-context-${process.pid}-${Date.now()}.json`;
    const config = {
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
        },
      },
      session: {
        store: storePath,
      },
    } satisfies NonNullable<Parameters<typeof createTelegramBot>[0]["config"]>;

    await rm(storePath, { force: true });
    try {
      loadConfig.mockReturnValue(config);
      createTelegramBot({ token: "tok", config });
      await writeDirectTelegramTranscriptContext({
        cfg: config,
        storePath,
        chatId: 7772,
        senderId: 202,
        sessionId: "telegram-dm-reset-context-session",
        text: "old private transcript text",
        timestamp: 1778474700000,
      });

      const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;
      await handler({
        me: { id: 999, username: "openclaw_bot" },
        getFile: async () => ({ download: async () => new Uint8Array() }),
        message: {
          chat: { id: 7772, type: "private" },
          text: "/reset summarize my workspace",
          date: 1778474850,
          message_id: 101,
          from: { id: 202, is_bot: false, first_name: "Kesava" },
        },
      });

      expect(replySpy).toHaveBeenCalledTimes(1);
      const payload = mockMsgContextArg(
        replySpy as unknown as MockCallSource,
        0,
        0,
        "replySpy call",
      );
      expect(JSON.stringify(payload.UntrustedStructuredContext ?? [])).not.toContain(
        "old private transcript text",
      );
    } finally {
      await rm(storePath, { force: true });
    }
  });

  it("uses quote text when a Telegram partial reply is received", async () => {
    onSpy.mockClear();
    sendMessageSpy.mockClear();
    replySpy.mockClear();

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: 7, type: "private" },
        text: "Sure, see below",
        date: 1736380800,
        reply_to_message: {
          message_id: 9001,
          text: "Can you summarize this?",
          from: { first_name: "Ada" },
        },
        quote: {
          text: " summarize this\n",
          position: 8,
          entities: [{ type: "bold", offset: 1, length: 9 }],
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = mockMsgContextArg(replySpy as unknown as MockCallSource, 0, 0, "replySpy call");
    expect(payload.Body).toContain("[Reply chain - nearest first]");
    expect(payload.Body).toContain("[1. Ada id:9001]");
    expect(payload.Body).toContain('"summarize this"');
    expect(payload.ReplyToId).toBe("9001");
    expect(payload.ReplyToBody).toBe("summarize this");
    expect(payload.ReplyToSender).toBe("Ada");
    const telegramPayload = payload as Record<string, unknown>;
    expect(telegramPayload.ReplyToQuoteText).toBe(" summarize this\n");
    expect(telegramPayload.ReplyToQuotePosition).toBe(8);
    expect(telegramPayload.ReplyToQuoteEntities).toEqual([{ type: "bold", offset: 1, length: 9 }]);
    expect(telegramPayload.ReplyToQuoteSourceText).toBe("Can you summarize this?");
  });

  it("keeps reply linkage while omitting filtered binary reply captions", async () => {
    onSpy.mockClear();
    sendMessageSpy.mockClear();
    replySpy.mockClear();

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: 7, type: "private" },
        text: "Sure, see below",
        date: 1736380800,
        reply_to_message: {
          message_id: 9001,
          caption: "PK\x00\x03\x04binary",
          from: { first_name: "Ada" },
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = mockMsgContextArg(replySpy as unknown as MockCallSource, 0, 0, "replySpy call");
    expect(payload.Body).toContain("[Reply chain - nearest first]");
    expect(payload.Body).toContain("[1. Ada id:9001]");
    expect(payload.Body).not.toContain("PK");
    expect(payload.Body).not.toContain("unsafe reply text omitted");
    expect(payload.ReplyToBody).toBeUndefined();
    expect(payload.ReplyToId).toBe("9001");
    expect(payload.ReplyToSender).toBe("Ada");
  });

  it("includes replied image media in inbound context for text replies", async () => {
    onSpy.mockClear();
    replySpy.mockClear();
    getFileSpy.mockClear();
    const botShutdown = new AbortController();
    const mediaAbort = new AbortController();
    let replyGetFileSignal: AbortSignal | undefined;
    loadWebMedia.mockResolvedValueOnce({ path: "/tmp/reply-photo.png", contentType: "image/png" });

    const mediaFetch = vi.fn(
      async () =>
        new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
    );
    const ssrfMock = mockPinnedHostnameResolution();

    try {
      createTelegramBot({
        token: "tok",
        fetchAbortSignal: botShutdown.signal,
        mediaAbortSignal: mediaAbort.signal,
        telegramTransport: {
          fetch: mediaFetch as typeof fetch,
          sourceFetch: mediaFetch as typeof fetch,
          close: async () => {},
        },
      });
      const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

      await handler({
        message: {
          chat: { id: 7, type: "private" },
          text: "what is in this image?",
          date: 1736380800,
          reply_to_message: {
            message_id: 9001,
            photo: [{ file_id: "reply-photo-1" }],
            from: { first_name: "Ada" },
          },
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({}),
      });
      replyGetFileSignal = mockArg(
        getFileSpy as unknown as MockCallSource,
        0,
        1,
        "reply getFile signal",
      ) as AbortSignal;
      expect(replyGetFileSignal.aborted).toBe(false);
    } finally {
      mediaAbort.abort();
      ssrfMock.mockRestore();
    }

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = mockMsgContextArg(
      replySpy as unknown as MockCallSource,
      0,
      0,
      "replySpy call",
    ) as {
      MediaPath?: string;
      MediaPaths?: string[];
      ReplyToBody?: string;
    };
    expect(payload.ReplyToBody).toBe("<media:image>");
    expect(getFileSpy).toHaveBeenCalledWith("reply-photo-1", expect.any(AbortSignal));
    expect(replyGetFileSignal?.aborted).toBe(true);
    expect(botShutdown.signal.aborted).toBe(false);
    botShutdown.abort();
    expect(loadWebMedia).not.toHaveBeenCalled();
    expect(mediaFetch).toHaveBeenCalledTimes(1);
  });

  it("dispatches the current text when best-effort reply media times out", async () => {
    onSpy.mockClear();
    replySpy.mockClear();
    getFileSpy.mockClear();
    const timeout = Object.assign(new Error("media response headers timed out"), {
      name: "TimeoutError",
    });
    const mediaFetch = vi.fn(async () => {
      throw timeout;
    });
    const ssrfMock = mockPinnedHostnameResolution();

    try {
      createTelegramBot({
        token: "tok",
        telegramTransport: {
          fetch: mediaFetch as typeof fetch,
          sourceFetch: mediaFetch as typeof fetch,
          close: async () => {},
        },
      });
      const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

      await handler({
        message: {
          chat: { id: 7, type: "private" },
          text: "continue without the old image",
          date: 1736380800,
          reply_to_message: {
            message_id: 9001,
            photo: [{ file_id: "reply-photo-1" }],
            from: { first_name: "Ada" },
          },
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({}),
      });
    } finally {
      ssrfMock.mockRestore();
    }

    expect(mediaFetch).toHaveBeenCalledTimes(1);
    expect(getFileSpy).toHaveBeenCalledWith("reply-photo-1", expect.any(AbortSignal));
    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = mockMsgContextArg(replySpy as unknown as MockCallSource, 0, 0, "replySpy call");
    expect(payload.Body).toContain("continue without the old image");
  });

  it("dispatches the current text when classic polling aborts reply media", async () => {
    onSpy.mockClear();
    replySpy.mockClear();
    getFileSpy.mockClear();
    const botShutdown = new AbortController();
    getFileSpy.mockImplementationOnce(async () => {
      botShutdown.abort();
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    });

    createTelegramBot({ token: "tok", fetchAbortSignal: botShutdown.signal });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    const { result } = await runWithTelegramUpdateProcessingFrame(() =>
      handler({
        message: {
          chat: { id: 7, type: "private" },
          text: "continue after polling restart",
          date: 1736380800,
          reply_to_message: {
            message_id: 9001,
            photo: [{ file_id: "reply-photo-1" }],
            from: { first_name: "Ada" },
          },
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({}),
      }),
    );

    expect(result).toEqual({ kind: "completed" });
    expect(getFileSpy).toHaveBeenCalledWith("reply-photo-1", expect.any(AbortSignal));
    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = mockMsgContextArg(replySpy as unknown as MockCallSource, 0, 0, "replySpy call");
    expect(payload.Body).toContain("continue after polling restart");
  });

  it("durably retries a spooled reply when shutdown aborts reply media", async () => {
    onSpy.mockClear();
    replySpy.mockClear();
    getFileSpy.mockClear();
    const botShutdown = new AbortController();
    const mediaAbort = new AbortController();
    getFileSpy.mockImplementationOnce(async () => {
      botShutdown.abort();
      throw new Error("Bad Request: file is too big");
    });

    createTelegramBot({
      token: "tok",
      fetchAbortSignal: botShutdown.signal,
      mediaAbortSignal: mediaAbort.signal,
    });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;
    const update = {
      update_id: 98081,
      message: {
        chat: { id: 7, type: "private" },
        text: "keep the old image",
        date: 1736380800,
        reply_to_message: {
          message_id: 9001,
          photo: [{ file_id: "reply-photo-1" }],
          from: { first_name: "Ada" },
        },
      },
    };

    const { result } = await runWithTelegramUpdateProcessingFrame(() =>
      withTelegramSpooledReplayUpdate(update, () =>
        handler({
          update,
          message: update.message,
          me: { username: "openclaw_bot" },
          getFile: async () => ({}),
        }),
      ),
    );

    expect(result).toEqual({ kind: "failed-retryable", error: expect.any(Error) });
    expect(getFileSpy).toHaveBeenCalledWith("reply-photo-1", expect.any(AbortSignal));
    expect(replySpy).not.toHaveBeenCalled();
    expect(mediaAbort.signal.aborted).toBe(false);
  });

  it("hydrates reply chains from cached Telegram messages", async () => {
    onSpy.mockClear();
    replySpy.mockClear();
    getFileSpy.mockClear();

    const mediaFetch = vi.fn(
      async () =>
        new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
    );
    const ssrfMock = mockPinnedHostnameResolution();

    try {
      createTelegramBot({
        token: "tok",
        telegramTransport: {
          fetch: mediaFetch as typeof fetch,
          sourceFetch: mediaFetch as typeof fetch,
          close: async () => {},
        },
      });
      const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

      await handler({
        message: {
          chat: { id: 7, type: "private" },
          message_id: 9000,
          date: 1736380700,
          from: { id: 1, first_name: "Kesava" },
          photo: [{ file_id: "root-photo-1" }],
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ file_path: "media/root.jpg" }),
      });

      await handler({
        message: {
          chat: { id: 7, type: "private" },
          message_id: 9001,
          text: "r u back from hermes",
          date: 1736380750,
          from: { id: 2, first_name: "Ada" },
          reply_to_message: {
            message_id: 9000,
            photo: [{ file_id: "root-photo-1" }],
            from: { id: 1, first_name: "Kesava" },
          },
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ download: async () => new Uint8Array() }),
      });

      replySpy.mockClear();
      getFileSpy.mockClear();
      mediaFetch.mockClear();

      await handler({
        message: {
          chat: { id: 7, type: "private" },
          message_id: 9002,
          text: "why did you reply?",
          date: 1736380800,
          from: { id: 3, first_name: "Grace" },
          reply_to_message: {
            message_id: 9001,
            text: "r u back from hermes",
            from: { id: 2, first_name: "Ada" },
          },
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ download: async () => new Uint8Array() }),
      });
    } finally {
      ssrfMock.mockRestore();
    }

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = mockMsgContextArg(
      replySpy as unknown as MockCallSource,
      0,
      0,
      "replySpy call",
    ) as {
      ReplyChain?: Array<{
        messageId?: string;
        body?: string;
        mediaPath?: string;
        mediaRef?: string;
        replyToId?: string;
      }>;
      UntrustedStructuredContext?: unknown[];
    };
    expect(payload.ReplyChain).toHaveLength(2);
    expect(payload.ReplyChain?.[0]?.messageId).toBe("9001");
    expect(payload.ReplyChain?.[0]?.body).toBe("r u back from hermes");
    expect(payload.ReplyChain?.[0]?.replyToId).toBe("9000");
    expect(payload.ReplyChain?.[1]?.messageId).toBe("9000");
    expect(payload.ReplyChain?.[1]?.mediaPath).toBeTypeOf("string");
    expect(payload.ReplyChain?.[1]?.mediaPath).toContain("/media/inbound/");
    expect(payload.ReplyChain?.[1]?.mediaRef).toBeUndefined();
    const [conversationContext] = requireArray(
      payload.UntrustedStructuredContext,
      "structured context",
    );
    const contextRecord = requireRecord(conversationContext, "conversation context");
    const contextPayload = requireRecord(contextRecord.payload, "conversation context payload");
    const messages = requireArray(contextPayload.messages, "conversation context messages").map(
      (message, index) => requireRecord(message, `conversation context message ${index + 1}`),
    );
    const messagesById = new Map(messages.map((message) => [message.message_id, message]));
    expect(messagesById.get("9000")).toMatchObject({
      sender: "Kesava",
    });
    expect(messagesById.get("9000")?.media_path).toMatch(/^media:\/\/inbound\//);
    expect(messagesById.get("9000")?.media_path).not.toBe(payload.ReplyChain?.[1]?.mediaPath);
    expect(messagesById.get("9000")?.media_ref).toBeUndefined();
    expect(getFileSpy).toHaveBeenCalledWith("root-photo-1", expect.any(AbortSignal));
    expect(mediaFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: "hydrates allowlisted group reply ancestors",
      allowFrom: ["1", "999"],
      expectHydrated: true,
      chatId: 7,
    },
    {
      name: "does not hydrate unallowlisted group reply ancestors through quote override",
      allowFrom: ["1"],
      expectHydrated: false,
      chatId: 8,
    },
  ])("$name", async ({ allowFrom, expectHydrated, chatId }) => {
    onSpy.mockClear();
    replySpy.mockClear();
    getFileSpy.mockClear();
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "open",
          contextVisibility: "allowlist_quote",
          allowFrom,
        },
      },
    });

    const mediaFetch = vi.fn(
      async () =>
        new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
    );
    const ssrfMock = mockPinnedHostnameResolution();

    try {
      createTelegramBot({
        token: "tok",
        telegramTransport: {
          fetch: mediaFetch as typeof fetch,
          sourceFetch: mediaFetch as typeof fetch,
          close: async () => {},
        },
      });
      const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;
      const baseCtx = {
        me: { id: 999, is_bot: true, first_name: "OpenClaw", username: "openclaw_bot" },
        getFile: async () => ({ download: async () => new Uint8Array() }),
      };
      const chat = { id: chatId, type: "group", title: "Ops" };

      await handler({
        ...baseCtx,
        message: {
          chat,
          message_id: 102,
          text: "Why is there a 4th person?",
          date: 1736380750,
          from: { id: 2, is_bot: false, first_name: "UserB" },
          reply_to_message: {
            chat,
            message_id: 101,
            text: "Done, here is the image",
            date: 1736380700,
            from: { id: 999, is_bot: true, first_name: "OpenClaw" },
            photo: [{ file_id: "generated-photo-1" }],
          },
        },
      });

      replySpy.mockClear();
      getFileSpy.mockClear();
      mediaFetch.mockClear();

      await handler({
        ...baseCtx,
        message: {
          chat,
          message_id: 103,
          text: "@openclaw_bot explain what went wrong",
          date: 1736380800,
          from: { id: 1, is_bot: false, first_name: "UserA" },
          reply_to_message: {
            chat,
            message_id: 102,
            text: "Why is there a 4th person?",
            date: 1736380750,
            from: { id: 2, is_bot: false, first_name: "UserB" },
          },
        },
      });
    } finally {
      ssrfMock.mockRestore();
    }

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = mockMsgContextArg(
      replySpy as unknown as MockCallSource,
      0,
      0,
      "replySpy call",
    ) as {
      ReplyChain?: Array<{
        messageId?: string;
        sender?: string;
        body?: string;
        mediaRef?: string;
        mediaPath?: string;
      }>;
      UntrustedStructuredContext?: unknown[];
    };
    expect(payload.ReplyChain?.map((entry) => entry.messageId)).toEqual(["102", "101"]);
    expect(payload.ReplyChain?.[1]).toMatchObject({
      sender: "OpenClaw (you)",
      body: "Done, here is the image",
    });
    if (expectHydrated) {
      expect(payload.ReplyChain?.[1]?.mediaPath).toBeTypeOf("string");
      expect(payload.ReplyChain?.[1]?.mediaPath).toContain("/media/inbound/");
      expect(payload.ReplyChain?.[1]?.mediaRef).toBeUndefined();
    } else {
      expect(payload.ReplyChain?.[1]?.mediaPath).toBeUndefined();
      expect(payload.ReplyChain?.[1]?.mediaRef).toBe("telegram:file/generated-photo-1");
    }
    const [conversationContext] = requireArray(
      payload.UntrustedStructuredContext,
      "structured context",
    );
    const contextRecord = requireRecord(conversationContext, "conversation context");
    const contextPayload = requireRecord(contextRecord.payload, "conversation context payload");
    const messages = requireArray(contextPayload.messages, "conversation context messages").map(
      (message, index) => requireRecord(message, `conversation context message ${index + 1}`),
    );
    const messagesById = new Map(messages.map((message) => [message.message_id, message]));
    expect(messagesById.get("101")).toMatchObject({
      sender: "OpenClaw (you)",
      body: "Done, here is the image",
      is_reply_target: true,
    });
    if (expectHydrated) {
      expect(messagesById.get("101")?.media_path).toMatch(/^media:\/\/inbound\//);
      expect(messagesById.get("101")?.media_ref).toBeUndefined();
    } else {
      expect(messagesById.get("101")?.media_path).toBeUndefined();
      expect(messagesById.get("101")?.media_ref).toBe("telegram:file/generated-photo-1");
    }
    expect(messagesById.get("102")).toMatchObject({
      sender: "UserB",
      body: "Why is there a 4th person?",
      reply_to_id: "101",
      is_reply_target: true,
    });
    if (expectHydrated) {
      expect(getFileSpy).toHaveBeenCalledWith("generated-photo-1", expect.any(AbortSignal));
      expect(mediaFetch).toHaveBeenCalledTimes(1);
    } else {
      expect(getFileSpy).not.toHaveBeenCalled();
      expect(mediaFetch).not.toHaveBeenCalled();
    }
  });

  it("does not hydrate reply media denied by General forum topic visibility", async () => {
    onSpy.mockClear();
    replySpy.mockClear();
    getFileSpy.mockClear();
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "allowlist",
          contextVisibility: "allowlist",
          groups: {
            "-1007": {
              requireMention: false,
              allowFrom: ["1", "2"],
              topics: {
                "1": { allowFrom: ["1"], requireMention: false },
              },
            },
          },
        },
      },
    });

    const mediaFetch = vi.fn(
      async () =>
        new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
    );
    const ssrfMock = mockPinnedHostnameResolution();
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

    try {
      const replyDelivered = waitForReplyCalls(1);
      createTelegramBot({
        token: "tok",
        telegramTransport: {
          fetch: mediaFetch as typeof fetch,
          sourceFetch: mediaFetch as typeof fetch,
          close: async () => {},
        },
      });
      const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;
      const chat = { id: -1007, type: "supergroup", title: "Ops", is_forum: true };

      await handler({
        me: { id: 999, username: "openclaw_bot" },
        getFile: async () => ({ download: async () => new Uint8Array() }),
        message: {
          chat,
          message_id: 103,
          text: "explain this",
          date: 1736380800,
          from: { id: 1, is_bot: false, first_name: "Allowed" },
          reply_to_message: {
            chat,
            message_id: 102,
            caption: "hidden image",
            date: 1736380750,
            from: { id: 2, is_bot: false, first_name: "Hidden" },
            photo: [{ file_id: "hidden-photo-1" }],
          },
        },
      });
      await replyDelivered;
    } finally {
      ssrfMock.mockRestore();
      clearTelegramRuntime();
      resetPluginStateStoreForTests();
    }

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = mockMsgContextArg(
      replySpy as unknown as MockCallSource,
      0,
      0,
      "replySpy call",
    ) as {
      ReplyChain?: unknown[];
      UntrustedStructuredContext?: unknown[];
    };
    expect(payload.ReplyChain).toBeUndefined();
    const [conversationContext] = requireArray(
      payload.UntrustedStructuredContext,
      "structured context",
    );
    const contextRecord = requireRecord(conversationContext, "conversation context");
    const contextPayload = requireRecord(contextRecord.payload, "conversation context payload");
    const messages = requireArray(contextPayload.messages, "conversation context messages").map(
      (message, index) => requireRecord(message, `conversation context message ${index + 1}`),
    );
    const hiddenMessage = messages.find((message) => message.message_id === "102");
    expect(hiddenMessage?.media_ref).toBe("telegram:file/hidden-photo-1");
    expect(hiddenMessage?.media_path).toBeUndefined();
    expect(getFileSpy).not.toHaveBeenCalled();
    expect(mediaFetch).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "hydrates group reply media allowed through an option-level access group",
      chatId: -1008,
      runtimeGroupAllowFrom: undefined,
      startupGroupAllowFrom: undefined,
      optionGroupAllowFrom: ["1", "accessGroup:operators"],
      useAccessGroup: true,
      expectHydrated: true,
    },
    {
      name: "does not hydrate a sender removed from the refreshed runtime allowlist",
      chatId: -1009,
      runtimeGroupAllowFrom: ["1"],
      startupGroupAllowFrom: ["1", "2"],
      optionGroupAllowFrom: undefined,
      useAccessGroup: false,
      expectHydrated: false,
    },
  ])(
    "$name",
    async ({
      chatId,
      runtimeGroupAllowFrom,
      startupGroupAllowFrom,
      optionGroupAllowFrom,
      useAccessGroup,
      expectHydrated,
    }) => {
      onSpy.mockClear();
      replySpy.mockClear();
      getFileSpy.mockClear();
      const runtimeConfig = {
        ...(useAccessGroup
          ? {
              accessGroups: {
                operators: {
                  type: "message.senders" as const,
                  members: { telegram: ["2"] },
                },
              },
            }
          : {}),
        channels: {
          telegram: {
            groupPolicy: "open",
            contextVisibility: "allowlist",
            ...(runtimeGroupAllowFrom ? { groupAllowFrom: runtimeGroupAllowFrom } : {}),
            groups: {
              [String(chatId)]: {
                requireMention: false,
              },
            },
          },
        },
      } satisfies NonNullable<Parameters<typeof createTelegramBot>[0]["config"]>;
      const startupConfig = {
        channels: {
          telegram: {
            groupPolicy: "open",
            ...(startupGroupAllowFrom ? { groupAllowFrom: startupGroupAllowFrom } : {}),
            groups: { [String(chatId)]: { requireMention: false } },
          },
        },
      } satisfies NonNullable<Parameters<typeof createTelegramBot>[0]["config"]>;
      loadConfig.mockReturnValue(runtimeConfig);

      const mediaFetch = vi.fn(
        async () =>
          new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
            status: 200,
            headers: { "content-type": "image/png" },
          }),
      );
      const runtimeLog = vi.fn();
      const runtimeError = vi.fn();
      const runtimeExit = vi.fn();
      const ssrfMock = mockPinnedHostnameResolution();

      try {
        createTelegramBot({
          token: "tok",
          config: startupConfig,
          ...(optionGroupAllowFrom ? { groupAllowFrom: optionGroupAllowFrom } : {}),
          runtime: { log: runtimeLog, error: runtimeError, exit: runtimeExit },
          telegramTransport: {
            fetch: mediaFetch as typeof fetch,
            sourceFetch: mediaFetch as typeof fetch,
            close: async () => {},
          },
        });
        const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;
        const chat = { id: chatId, type: "group", title: "Ops" };

        await handler({
          me: { id: 999, username: "openclaw_bot" },
          getFile: async () => ({ download: async () => new Uint8Array() }),
          message: {
            chat,
            message_id: 103,
            text: "@openclaw_bot explain this",
            date: 1736380800,
            from: { id: 1, is_bot: false, first_name: "Allowed" },
            reply_to_message: {
              chat,
              message_id: 102,
              caption: "allowed image",
              date: 1736380750,
              from: { id: 2, is_bot: false, first_name: "Also allowed" },
              photo: [{ file_id: "allowed-photo-1" }],
            },
          },
        });
      } finally {
        ssrfMock.mockRestore();
      }

      expect(runtimeError).not.toHaveBeenCalled();
      expect(replySpy).toHaveBeenCalledTimes(1);
      const payload = mockMsgContextArg(
        replySpy as unknown as MockCallSource,
        0,
        0,
        "replySpy call",
      ) as {
        UntrustedStructuredContext?: unknown[];
      };
      const [conversationContext] = requireArray(
        payload.UntrustedStructuredContext,
        "structured context",
      );
      const contextRecord = requireRecord(conversationContext, "conversation context");
      const contextPayload = requireRecord(contextRecord.payload, "conversation context payload");
      const messages = requireArray(contextPayload.messages, "conversation context messages").map(
        (message, index) => requireRecord(message, `conversation context message ${index + 1}`),
      );
      const replyMessage = messages.find((message) => message.message_id === "102");
      if (expectHydrated) {
        expect(replyMessage?.media_path).toMatch(/^media:\/\/inbound\//);
        expect(replyMessage?.media_ref).toBeUndefined();
        expect(getFileSpy).toHaveBeenCalledWith("allowed-photo-1", expect.any(AbortSignal));
        expect(mediaFetch).toHaveBeenCalledTimes(1);
      } else {
        expect(replyMessage?.media_path).toBeUndefined();
        expect(replyMessage?.media_ref).toBe("telegram:file/allowed-photo-1");
        expect(getFileSpy).not.toHaveBeenCalled();
        expect(mediaFetch).not.toHaveBeenCalled();
      }
    },
  );

  it("does not fetch reply media for unauthorized DM replies", async () => {
    onSpy.mockClear();
    replySpy.mockClear();
    getFileSpy.mockClear();
    sendMessageSpy.mockClear();
    readChannelAllowFromStore.mockResolvedValue([]);
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          dmPolicy: "pairing",
          allowFrom: [],
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: 7, type: "private" },
        text: "hey",
        date: 1736380800,
        from: { id: 999, first_name: "Eve" },
        reply_to_message: {
          message_id: 9001,
          photo: [{ file_id: "reply-photo-1" }],
          from: { first_name: "Ada" },
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({}),
    });

    expect(getFileSpy).not.toHaveBeenCalled();
    expect(replySpy).not.toHaveBeenCalled();
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
  });

  it("defers reply media download until debounce flush", async () => {
    const DEBOUNCE_MS = 4321;
    onSpy.mockClear();
    replySpy.mockClear();
    getFileSpy.mockClear();
    loadConfig.mockReturnValue({
      agents: {
        defaults: {
          envelopeTimezone: "utc",
        },
      },
      messages: {
        inbound: {
          debounceMs: DEBOUNCE_MS,
        },
      },
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
        },
      },
    });

    const mediaFetch = vi.fn(
      async () =>
        new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
    );
    const ssrfMock = mockPinnedHostnameResolution();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const replyDelivered = waitForReplyCalls(1);
      createTelegramBot({
        token: "tok",
        telegramTransport: {
          fetch: mediaFetch as typeof fetch,
          sourceFetch: mediaFetch as typeof fetch,
          close: async () => {},
        },
      });
      const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

      await handler({
        message: {
          chat: { id: 7, type: "private" },
          text: "first",
          date: 1736380800,
          message_id: 101,
          from: { id: 42, first_name: "Ada" },
          reply_to_message: {
            message_id: 9001,
            photo: [{ file_id: "reply-photo-1" }],
            from: { first_name: "Ada" },
          },
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({}),
      });
      await handler({
        message: {
          chat: { id: 7, type: "private" },
          text: "second",
          date: 1736380801,
          message_id: 102,
          from: { id: 42, first_name: "Ada" },
          reply_to_message: {
            message_id: 9001,
            photo: [{ file_id: "reply-photo-1" }],
            from: { first_name: "Ada" },
          },
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({}),
      });

      expect(replySpy).not.toHaveBeenCalled();
      expect(getFileSpy).not.toHaveBeenCalled();

      const flushTimerCallIndex = setTimeoutSpy.mock.calls.findLastIndex(
        (call) => call[1] === DEBOUNCE_MS,
      );
      const flushTimer =
        flushTimerCallIndex >= 0
          ? (setTimeoutSpy.mock.calls[flushTimerCallIndex]?.[0] as (() => unknown) | undefined)
          : undefined;
      if (flushTimerCallIndex >= 0) {
        clearTimeout(
          setTimeoutSpy.mock.results[flushTimerCallIndex]?.value as ReturnType<typeof setTimeout>,
        );
      }
      expect(flushTimer).toBeTypeOf("function");
      await flushTimer?.();
      await replyDelivered;

      expect(getFileSpy).toHaveBeenCalledWith("reply-photo-1", expect.any(AbortSignal));
      expect(mediaFetch).toHaveBeenCalled();
    } finally {
      setTimeoutSpy.mockRestore();
      ssrfMock.mockRestore();
    }
  });

  it("handles quote-only replies without reply metadata", async () => {
    onSpy.mockClear();
    sendMessageSpy.mockClear();
    replySpy.mockClear();

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: 7, type: "private" },
        text: "Sure, see below",
        date: 1736380800,
        quote: {
          text: "summarize this",
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = mockMsgContextArg(replySpy as unknown as MockCallSource, 0, 0, "replySpy call");
    expect(payload.Body).toContain("[Reply chain - nearest first]");
    expect(payload.Body).toContain("[1. unknown sender");
    expect(payload.Body).toContain('"summarize this"');
    expect(payload.ReplyToId).toBeUndefined();
    expect(payload.ReplyToBody).toBe("summarize this");
    expect(payload.ReplyToSender).toBe("unknown sender");
  });

  it("uses top-level quote text for external partial replies", async () => {
    onSpy.mockClear();
    sendMessageSpy.mockClear();
    replySpy.mockClear();

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: 7, type: "private" },
        text: "Sure, see below",
        date: 1736380800,
        quote: {
          text: "summarize this",
        },
        external_reply: {
          message_id: 9002,
          text: "Can you summarize this?",
          from: { first_name: "Ada" },
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = mockMsgContextArg(replySpy as unknown as MockCallSource, 0, 0, "replySpy call");
    expect(payload.Body).toContain("[Reply chain - nearest first]");
    expect(payload.Body).toContain("[1. Ada id:9002");
    expect(payload.Body).toContain('"summarize this"');
    expect(payload.ReplyToId).toBe("9002");
    expect(payload.ReplyToBody).toBe("summarize this");
    expect(payload.ReplyToSender).toBe("Ada");
    expect((payload as Record<string, unknown>).ReplyToIsExternal).toBe(true);
  });

  it("propagates forwarded origin from external_reply targets", async () => {
    onSpy.mockReset();
    sendMessageSpy.mockReset();
    replySpy.mockReset();

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: 7, type: "private" },
        text: "Thoughts?",
        date: 1736380800,
        external_reply: {
          message_id: 9003,
          text: "forwarded text",
          from: { first_name: "Ada" },
          quote: {
            text: "forwarded snippet",
          },
          forward_origin: {
            type: "user",
            sender_user: {
              id: 999,
              first_name: "Bob",
              last_name: "Smith",
              username: "bobsmith",
              is_bot: false,
            },
            date: 500,
          },
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = mockMsgContextArg(replySpy as unknown as MockCallSource, 0, 0, "replySpy call");
    expect(payload.ReplyToForwardedFrom).toBe("Bob Smith (@bobsmith)");
    expect(payload.ReplyToForwardedFromType).toBe("user");
    expect(payload.ReplyToForwardedFromId).toBe("999");
    expect(payload.ReplyToForwardedFromUsername).toBe("bobsmith");
    expect(payload.ReplyToForwardedFromTitle).toBe("Bob Smith");
    expect(payload.ReplyToForwardedDate).toBe(500000);
    expect(payload.Body).toContain(
      "[Forwarded from Bob Smith (@bobsmith) at 1970-01-01T00:08:20.000Z]",
    );
  });

  it("omits Date-invalid forwarded origin timestamps without dropping forwarded context", async () => {
    onSpy.mockReset();
    sendMessageSpy.mockReset();
    replySpy.mockReset();

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: 7, type: "private" },
        text: "Thoughts?",
        date: 1736380800,
        external_reply: {
          message_id: 9004,
          text: "forwarded text",
          from: { first_name: "Ada" },
          forward_origin: {
            type: "user",
            sender_user: {
              id: 999,
              first_name: "Bob",
              last_name: "Smith",
              username: "bobsmith",
              is_bot: false,
            },
            date: 8_700_000_000_000,
          },
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = mockMsgContextArg(replySpy as unknown as MockCallSource, 0, 0, "replySpy call");
    expect(payload.ReplyToForwardedFrom).toBe("Bob Smith (@bobsmith)");
    expect(payload.Body).toContain("[Forwarded from Bob Smith (@bobsmith)]");
    expect(payload.Body).not.toContain("+275760");
  });

  it("redacts forwarded origin inside reply targets when context visibility is allowlist", async () => {
    onSpy.mockReset();
    sendMessageSpy.mockReset();
    replySpy.mockReset();
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "allowlist",
          contextVisibility: "allowlist",
          groups: {
            "-1007": {
              requireMention: false,
              allowFrom: ["1"],
            },
          },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        message_id: 9004,
        chat: { id: -1007, type: "group", title: "Ops" },
        text: "Thoughts?",
        date: 1736380800,
        from: { id: 1, first_name: "Ada", username: "ada", is_bot: false },
        reply_to_message: {
          message_id: 9003,
          text: "forwarded text",
          from: { id: 1, first_name: "Ada", username: "ada", is_bot: false },
          forward_origin: {
            type: "user",
            sender_user: {
              id: 999,
              first_name: "Bob",
              last_name: "Smith",
              username: "bobsmith",
              is_bot: false,
            },
            date: 500,
          },
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = mockMsgContextArg(replySpy as unknown as MockCallSource, 0, 0, "replySpy call");
    expect(payload.ReplyToId).toBe("9003");
    expect(payload.ReplyToBody).toBe("forwarded text");
    expect(payload.ReplyToSender).toBe("Ada");
    expect(payload.ReplyToForwardedFrom).toBeUndefined();
    expect(payload.ReplyToForwardedFromType).toBeUndefined();
    expect(payload.ReplyToForwardedFromId).toBeUndefined();
    expect(payload.ReplyToForwardedFromUsername).toBeUndefined();
    expect(payload.ReplyToForwardedDate).toBeUndefined();
    expect(payload.Body).not.toContain("[Forwarded from Bob Smith (@bobsmith)");
  });

  it("accepts group replies to the bot without explicit mention when requireMention is enabled", async () => {
    onSpy.mockClear();
    replySpy.mockClear();
    loadConfig.mockReturnValue({
      channels: {
        telegram: { groups: { "*": { requireMention: true } } },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: 456, type: "group", title: "Ops Chat" },
        text: "following up",
        date: 1736380800,
        reply_to_message: {
          message_id: 42,
          text: "original reply",
          from: { id: 999, first_name: "OpenClaw" },
        },
      },
      me: { id: 999, username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = mockMsgContextArg(replySpy as unknown as MockCallSource, 0, 0, "replySpy call");
    expect(payload.WasMentioned).toBe(true);
  });

  it("prefers topic allowFrom over group allowFrom", async () => {
    onSpy.mockClear();
    replySpy.mockClear();
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "allowlist",
          groups: {
            "-1001234567890": {
              allowFrom: ["123456789"],
              topics: {
                "99": { allowFrom: ["999999999"] },
              },
            },
          },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: {
          id: -1001234567890,
          type: "supergroup",
          title: "Forum Group",
          is_forum: true,
        },
        from: { id: 123456789, username: "testuser" },
        text: "hello",
        date: 1736380800,
        message_thread_id: 99,
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(0);
  });

  it("allows group messages for per-group groupPolicy open override (global groupPolicy allowlist)", async () => {
    onSpy.mockClear();
    replySpy.mockClear();
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "allowlist",
          groups: {
            "-100123456789": {
              groupPolicy: "open",
              requireMention: false,
            },
          },
        },
      },
    });
    readChannelAllowFromStore.mockResolvedValueOnce(["123456789"]);

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: -100123456789, type: "group", title: "Test Group" },
        from: { id: 999999, username: "random" },
        text: "hello",
        date: 1736380800,
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
  });

  it("blocks control commands from unauthorized senders in per-group open groups", async () => {
    onSpy.mockClear();
    replySpy.mockClear();
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "allowlist",
          groups: {
            "-100123456789": {
              groupPolicy: "open",
              requireMention: false,
            },
          },
        },
      },
    });
    readChannelAllowFromStore.mockResolvedValueOnce(["123456789"]);

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: -100123456789, type: "group", title: "Test Group" },
        from: { id: 999999, username: "random" },
        text: "/status",
        date: 1736380800,
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).not.toHaveBeenCalled();
  });

  it("routes plugin-owned callback namespaces before synthetic command fallback", async () => {
    onSpy.mockClear();
    replySpy.mockClear();
    editMessageTextSpy.mockClear();
    sendMessageSpy.mockClear();
    registerPluginInteractiveHandler("codex-plugin", {
      channel: "telegram",
      namespace: "codexapp",
      handler: (async ({ respond, callback }: TelegramInteractiveHandlerContext) => {
        await respond.editMessage({
          text: `Handled ${callback.payload}`,
        });
        return { handled: true };
      }) as never,
    });

    createTelegramBot({
      token: "tok",
      config: {
        channels: {
          telegram: {
            dmPolicy: "open",
            allowFrom: ["*"],
          },
        },
      },
    });
    const callbackHandler = getOnHandler("callback_query") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await callbackHandler({
      callbackQuery: {
        id: "cbq-codex-1",
        data: "codexapp:resume:thread-1",
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          business_connection_id: "biz-1",
          chat: { id: 1234, type: "private" },
          date: 1736380800,
          message_id: 11,
          text: "Select a thread",
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(editMessageTextSpy).toHaveBeenCalledWith(1234, 11, "Handled resume:thread-1", {
      business_connection_id: "biz-1",
    });
    expect(replySpy).not.toHaveBeenCalled();
  });

  it("deletes plugin-owned callback messages through the bot API", async () => {
    onSpy.mockClear();
    replySpy.mockClear();
    deleteMessageSpy.mockClear();
    registerPluginInteractiveHandler("codex-plugin", {
      channel: "telegram",
      namespace: "codexapp",
      handler: (async ({ respond }: TelegramInteractiveHandlerContext) => {
        await respond.deleteMessage();
        return { handled: true };
      }) as never,
    });

    createTelegramBot({
      token: "tok",
      config: {
        channels: {
          telegram: {
            dmPolicy: "open",
            allowFrom: ["*"],
          },
        },
      },
    });
    const callbackHandler = getOnHandler("callback_query") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await callbackHandler({
      callbackQuery: {
        id: "cbq-codex-delete",
        data: "codexapp:delete:thread-1",
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1736380800,
          message_id: 11,
          text: "Select a thread",
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(deleteMessageSpy).toHaveBeenCalledWith(1234, 11);
    expect(replySpy).not.toHaveBeenCalled();
  });

  it("routes plugin-owned callback replies with Telegram topic params", async () => {
    onSpy.mockClear();
    replySpy.mockClear();
    sendMessageSpy.mockClear();
    registerPluginInteractiveHandler("codex-plugin", {
      channel: "telegram",
      namespace: "codexapp",
      handler: (async ({ respond }: TelegramInteractiveHandlerContext) => {
        await respond.reply({ text: "Handled in topic" });
        return { handled: true };
      }) as never,
    });

    createTelegramBot({
      token: "tok",
      config: {
        channels: {
          telegram: {
            dmPolicy: "open",
            allowFrom: ["*"],
          },
        },
      },
    });
    const callbackHandler = getOnHandler("callback_query") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await callbackHandler({
      callbackQuery: {
        id: "cbq-codex-topic-reply",
        data: "codexapp:reply:thread-1",
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          business_connection_id: "biz-topic-1",
          chat: { id: -100987654321, type: "supergroup", title: "Forum Group" },
          date: 1736380800,
          is_topic_message: true,
          message_id: 11,
          message_thread_id: 99,
          text: "Select a thread",
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(sendMessageSpy).toHaveBeenCalledWith(-100987654321, "Handled in topic", {
      business_connection_id: "biz-topic-1",
      message_thread_id: 99,
    });

    sendMessageSpy.mockClear();
    await callbackHandler({
      callbackQuery: {
        id: "cbq-codex-general-reply",
        data: "codexapp:reply:thread-1",
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: -100987654322, type: "supergroup", title: "Forum Group" },
          date: 1736380800,
          is_topic_message: true,
          message_id: 12,
          message_thread_id: 1,
          text: "Select a thread",
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(sendMessageSpy).toHaveBeenCalledWith(-100987654322, "Handled in topic", undefined);
    expect(replySpy).not.toHaveBeenCalled();
  });

  it("submits plugin-owned callback text through the Telegram inbound path", async () => {
    onSpy.mockClear();
    replySpy.mockClear();
    editMessageReplyMarkupSpy.mockClear();
    const replyDone = waitForReplyCalls(1);
    registerPluginInteractiveHandler("smart-replies-plugin", {
      channel: "telegram",
      namespace: "openclaw-smart-replies",
      handler: async () => ({ handled: true, submitText: "Fix a broken tool" }),
    } satisfies TelegramInteractiveHandlerRegistration);
    setTelegramPluginStateRuntimeForTests();

    try {
      createTelegramBot({
        token: "tok",
        config: {
          channels: {
            telegram: {
              dmPolicy: "open",
              allowFrom: ["*"],
            },
          },
        },
      });
      const callbackHandler = getTelegramCallbackHandlerForTests();

      await callbackHandler({
        callbackQuery: {
          id: "cbq-smart-reply-submit",
          data: "openclaw-smart-replies:v1:Rm14IGEgYnJva2VuIHRvb2w",
          from: { id: 9, first_name: "Ada", username: "ada_bot" },
          message: {
            chat: { id: 9, type: "private" },
            date: 1736380800,
            message_id: 11,
            text: "What should I help you sharpen next?",
          },
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ download: async () => new Uint8Array() }),
      });
      await replyDone;
    } finally {
      clearTelegramRuntime();
    }

    expect(editMessageReplyMarkupSpy).toHaveBeenCalledWith(9, 11, {
      reply_markup: { inline_keyboard: [] },
    });
    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = mockMsgContextArg(replySpy as unknown as MockCallSource, 0, 0, "replySpy call");
    expect(payload.Body).toContain("Fix a broken tool");
    expect(payload.SenderId).toBe("9");
    expect(payload.SenderUsername).toBe("ada_bot");
  });

  it("does not submit plugin-owned callback text when the handler declines the callback", async () => {
    onSpy.mockClear();
    replySpy.mockClear();
    editMessageReplyMarkupSpy.mockClear();
    const handler = vi.fn(async () => ({ handled: false, submitText: "Ignore this" }));
    registerPluginInteractiveHandler("smart-replies-plugin", {
      channel: "telegram",
      namespace: "openclaw-smart-replies",
      handler,
    } satisfies TelegramInteractiveHandlerRegistration);
    setTelegramPluginStateRuntimeForTests();

    try {
      createTelegramBot({
        token: "tok",
        config: {
          channels: {
            telegram: {
              dmPolicy: "open",
              allowFrom: ["*"],
            },
          },
        },
      });
      const callbackHandler = getTelegramCallbackHandlerForTests();

      await callbackHandler({
        callbackQuery: {
          id: "cbq-smart-reply-declined-submit",
          data: "openclaw-smart-replies:v1:SWdub3JlIHRoaXM",
          from: { id: 9, first_name: "Ada", username: "ada_bot" },
          message: {
            chat: { id: 9, type: "private" },
            date: 1736380800,
            message_id: 11,
            text: "Pick a direction",
          },
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ download: async () => new Uint8Array() }),
      });
    } finally {
      clearTelegramRuntime();
    }

    expect(handler).toHaveBeenCalledTimes(1);
    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = mockMsgContextArg(replySpy as unknown as MockCallSource, 0, 0, "replySpy call");
    expect(payload.Body).toContain("callback_data: openclaw-smart-replies");
    expect(payload.Body).not.toContain("Ignore this");
    expect(editMessageReplyMarkupSpy).not.toHaveBeenCalled();
  });

  it("does not retry plugin-owned callback text skipped by inbound policy", async () => {
    onSpy.mockClear();
    replySpy.mockClear();
    editMessageReplyMarkupSpy.mockClear();
    const handler = vi.fn(async () => {
      // The callback was authorized before this policy change; submitText must
      // still honor the fresh inbound policy without releasing callback dedupe.
      loadConfig.mockReturnValue({
        channels: {
          telegram: {
            dmPolicy: "open",
            allowFrom: ["*"],
            direct: { "9": { requireTopic: true } },
          },
        },
      });
      return { handled: true, submitText: "Do not submit this" };
    });
    registerPluginInteractiveHandler("smart-replies-plugin", {
      channel: "telegram",
      namespace: "openclaw-smart-replies",
      handler,
    } satisfies TelegramInteractiveHandlerRegistration);
    setTelegramPluginStateRuntimeForTests();

    try {
      createTelegramBot({
        token: "tok",
        config: {
          channels: {
            telegram: {
              dmPolicy: "open",
              allowFrom: ["*"],
              capabilities: { inlineButtons: "dm" },
            },
          },
        },
      });
      const callbackHandler = getTelegramCallbackHandlerForTests();

      const callbackContext = {
        callbackQuery: {
          id: "cbq-smart-reply-policy-skip",
          data: "openclaw-smart-replies:v1:RG8gbm90IHN1Ym1pdCB0aGlz",
          from: { id: 9, first_name: "Ada", username: "ada_bot" },
          message: {
            chat: { id: 9, type: "private" },
            date: 1736380800,
            message_id: 11,
            text: "Pick a direction",
          },
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ download: async () => new Uint8Array() }),
      };

      await expect(callbackHandler(callbackContext)).resolves.toBeUndefined();
      await expect(callbackHandler(callbackContext)).resolves.toBeUndefined();

      expect(handler).toHaveBeenCalledOnce();
      expect(replySpy).not.toHaveBeenCalled();
      expect(editMessageReplyMarkupSpy).not.toHaveBeenCalled();
    } finally {
      clearTelegramRuntime();
    }
  });

  it("submits plugin-owned callback text in mention-required group topics", async () => {
    onSpy.mockClear();
    replySpy.mockClear();
    editMessageReplyMarkupSpy.mockClear();
    const replyDone = waitForReplyCalls(1);
    registerPluginInteractiveHandler("smart-replies-plugin", {
      channel: "telegram",
      namespace: "openclaw-smart-replies",
      handler: async () => ({ handled: true, submitText: "Investigate topic callback" }),
    } satisfies TelegramInteractiveHandlerRegistration);
    setTelegramPluginStateRuntimeForTests();

    try {
      createTelegramBot({
        token: "tok",
        config: {
          channels: {
            telegram: {
              dmPolicy: "open",
              allowFrom: ["*"],
              capabilities: { inlineButtons: "group" },
              groupPolicy: "open",
              groups: { "*": { requireMention: true } },
            },
          },
        },
      });
      const callbackHandler = getTelegramCallbackHandlerForTests();

      await callbackHandler({
        callbackQuery: {
          id: "cbq-smart-reply-topic-submit",
          data: "openclaw-smart-replies:v1:SW52ZXN0aWdhdGUgdG9waWMgY2FsbGJhY2s",
          from: { id: 9, first_name: "Ada", username: "ada_bot" },
          message: {
            chat: { id: -100987654321, type: "supergroup", title: "Forum Group", is_forum: true },
            date: 1736380800,
            is_topic_message: true,
            message_id: 11,
            message_thread_id: 99,
            text: "What should I help you sharpen next?",
          },
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ download: async () => new Uint8Array() }),
      });
      await replyDone;
    } finally {
      clearTelegramRuntime();
    }

    expect(editMessageReplyMarkupSpy).toHaveBeenCalledWith(-100987654321, 11, {
      reply_markup: { inline_keyboard: [] },
    });
    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = mockMsgContextArg(replySpy as unknown as MockCallSource, 0, 0, "replySpy call");
    expect(payload.Body).toContain("Investigate topic callback");
    expect(payload.MessageSid).toBe("cbq-smart-reply-topic-submit");
    expect(payload.WasMentioned).toBe(true);
    expect(payload.SenderId).toBe("9");
    expect(payload.SenderUsername).toBe("ada_bot");
  });

  it("settles spooled plugin callback text after a reply-session conflict retry succeeds", async () => {
    onSpy.mockClear();
    replySpy.mockClear();
    editMessageReplyMarkupSpy.mockClear();
    let calls = 0;
    replySpy.mockImplementation(async (_ctx, opts) => {
      calls += 1;
      await opts?.onReplyStart?.();
      if (calls === 1) {
        throw new Error("reply session initialization conflicted for agent:main:telegram:9");
      }
      return undefined;
    });
    registerPluginInteractiveHandler("smart-replies-plugin", {
      channel: "telegram",
      namespace: "openclaw-smart-replies",
      handler: async () => ({ handled: true, submitText: "Make Alice funnier" }),
    } satisfies TelegramInteractiveHandlerRegistration);
    setTelegramPluginStateRuntimeForTests();

    try {
      createTelegramBot({
        token: "tok",
        config: {
          channels: {
            telegram: {
              dmPolicy: "open",
              allowFrom: ["*"],
            },
          },
        },
      });
      const callbackHandler = getTelegramCallbackHandlerForTests();
      const callbackQuery = {
        id: "cbq-smart-reply-submit-retry",
        data: "openclaw-smart-replies:v1:TWFrZSBBbGljZSBmdW5uaWVy",
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: 9, type: "private" },
          date: 1736380800,
          message_id: 11,
          text: "Pick a direction",
        },
      };
      const update = { update_id: 403, callback_query: callbackQuery };
      const callbackContext = {
        update,
        callbackQuery,
        me: { username: "openclaw_bot" },
        getFile: async () => ({ download: async () => new Uint8Array() }),
      };

      const replay = await runWithTelegramSpooledReplayUpdate(update, async () => {
        await callbackHandler(callbackContext);
      });
      expect(replay.deferredWork).toBeDefined();
      await expect(replay.deferredWork?.task).resolves.toEqual({ kind: "completed" });
    } finally {
      clearTelegramRuntime();
    }

    expect(replySpy).toHaveBeenCalledTimes(2);
    expect(editMessageReplyMarkupSpy).toHaveBeenCalledWith(9, 11, {
      reply_markup: { inline_keyboard: [] },
    });
    const payload = mockMsgContextArg(
      replySpy as unknown as MockCallSource,
      1,
      0,
      "replySpy retry call",
    );
    expect(payload.Body).toContain("Make Alice funnier");
  });

  it("releases plugin-owned callback dedupe when submitted text processing fails", async () => {
    onSpy.mockClear();
    replySpy.mockClear();
    editMessageReplyMarkupSpy.mockClear();
    let calls = 0;
    replySpy.mockImplementation(async (_ctx, opts) => {
      calls += 1;
      await opts?.onReplyStart?.();
      if (calls === 1) {
        throw new Error("transient submit failure");
      }
      return undefined;
    });
    const handler = vi.fn(async () => ({ handled: true, submitText: "Try this later" }));
    registerPluginInteractiveHandler("smart-replies-plugin", {
      channel: "telegram",
      namespace: "openclaw-smart-replies",
      handler,
    } satisfies TelegramInteractiveHandlerRegistration);
    setTelegramPluginStateRuntimeForTests();

    try {
      createTelegramBot({
        token: "tok",
        config: {
          channels: {
            telegram: {
              dmPolicy: "open",
              allowFrom: ["*"],
            },
          },
        },
      });
      const callbackHandler = getTelegramCallbackHandlerForTests();
      const createCallbackUpdate = (updateId: number) => ({
        update_id: updateId,
        callbackQuery: {
          id: "cbq-smart-reply-submit-fail",
          data: "openclaw-smart-replies:v1:VHJ5IHRoaXMgbGF0ZXI",
          from: { id: 9, first_name: "Ada", username: "ada_bot" },
          message: {
            chat: { id: 9, type: "private" },
            date: 1736380800,
            message_id: 11,
            text: "Pick a direction",
          },
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ download: async () => new Uint8Array() }),
      });

      await expect(callbackHandler(createCallbackUpdate(401))).rejects.toThrow(
        "transient submit failure",
      );
      expect(editMessageReplyMarkupSpy).not.toHaveBeenCalled();

      await callbackHandler(createCallbackUpdate(402));
    } finally {
      clearTelegramRuntime();
    }

    expect(handler).toHaveBeenCalledTimes(2);
    expect(replySpy).toHaveBeenCalledTimes(2);
    expect(editMessageReplyMarkupSpy).toHaveBeenCalledWith(9, 11, {
      reply_markup: { inline_keyboard: [] },
    });
  });

  it("passes false command auth to Telegram plugin callbacks for non-allowlisted group senders", async () => {
    onSpy.mockClear();
    let observedAuth: TelegramInteractiveHandlerContext["auth"] | undefined;
    const handler = vi.fn(async ({ auth }: TelegramInteractiveHandlerContext) => {
      observedAuth = auth;
      return { handled: true };
    });
    registerPluginInteractiveHandler("codex-plugin", {
      channel: "telegram",
      namespace: "codexapp",
      handler: handler as never,
    });

    const config = {
      commands: {
        allowFrom: {
          telegram: ["111111111"],
        },
      },
      channels: {
        telegram: {
          dmPolicy: "open",
          capabilities: { inlineButtons: "group" },
          groupPolicy: "open",
          groups: { "*": { requireMention: false } },
        },
      },
    } satisfies NonNullable<Parameters<typeof createTelegramBot>[0]["config"]>;
    loadConfig.mockReturnValue(config);

    createTelegramBot({ token: "tok", config });
    const callbackHandler = getOnHandler("callback_query") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await callbackHandler({
      callbackQuery: {
        id: "cbq-plugin-auth-false",
        data: "codexapp:resume:thread-1",
        from: { id: 999999999, first_name: "Mallory", username: "mallory" },
        message: {
          chat: { id: -100999, type: "supergroup", title: "Test Group" },
          date: 1736380800,
          message_id: 22,
          text: "Select a thread",
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(handler).toHaveBeenCalledOnce();
    expect(observedAuth?.isAuthorizedSender).toBe(false);
  });

  it("passes true command auth to Telegram plugin callbacks for allowlisted group senders", async () => {
    onSpy.mockClear();
    let observedAuth: TelegramInteractiveHandlerContext["auth"] | undefined;
    const handler = vi.fn(async ({ auth }: TelegramInteractiveHandlerContext) => {
      observedAuth = auth;
      return { handled: true };
    });
    registerPluginInteractiveHandler("codex-plugin", {
      channel: "telegram",
      namespace: "codexapp",
      handler: handler as never,
    });

    const config = {
      commands: {
        allowFrom: {
          telegram: ["111111111"],
        },
      },
      channels: {
        telegram: {
          dmPolicy: "open",
          capabilities: { inlineButtons: "group" },
          groupPolicy: "open",
          groups: { "*": { requireMention: false } },
        },
      },
    } satisfies NonNullable<Parameters<typeof createTelegramBot>[0]["config"]>;
    loadConfig.mockReturnValue(config);

    createTelegramBot({ token: "tok", config });
    const callbackHandler = getOnHandler("callback_query") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await callbackHandler({
      callbackQuery: {
        id: "cbq-plugin-auth-true",
        data: "codexapp:resume:thread-1",
        from: { id: 111111111, first_name: "Ada", username: "ada" },
        message: {
          chat: { id: -100999, type: "supergroup", title: "Test Group" },
          date: 1736380800,
          message_id: 23,
          text: "Select a thread",
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(handler).toHaveBeenCalledOnce();
    expect(observedAuth?.isAuthorizedSender).toBe(true);
  });

  it("passes true command auth to Telegram plugin callbacks for access-group DM senders", async () => {
    onSpy.mockClear();
    let observedAuth: TelegramInteractiveHandlerContext["auth"] | undefined;
    const handler = vi.fn(async ({ auth }: TelegramInteractiveHandlerContext) => {
      observedAuth = auth;
      return { handled: true };
    });
    registerPluginInteractiveHandler("codex-plugin", {
      channel: "telegram",
      namespace: "codexapp",
      handler: handler as never,
    });

    const config = {
      accessGroups: {
        operators: {
          type: "message.senders",
          members: { telegram: ["123456789"] },
        },
      },
      channels: {
        telegram: {
          dmPolicy: "allowlist",
          allowFrom: ["accessGroup:operators"],
          capabilities: { inlineButtons: "dm" },
        },
      },
    } satisfies NonNullable<Parameters<typeof createTelegramBot>[0]["config"]>;
    loadConfig.mockReturnValue(config);

    createTelegramBot({ token: "tok", config });
    const callbackHandler = getOnHandler("callback_query") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await callbackHandler({
      callbackQuery: {
        id: "cbq-plugin-access-group-auth",
        data: "codexapp:resume:thread-1",
        from: { id: 123456789, first_name: "Ada", username: "ada" },
        message: {
          chat: { id: 123456789, type: "private" },
          date: 1736380800,
          message_id: 24,
          text: "Select a thread",
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(handler).toHaveBeenCalledOnce();
    expect(observedAuth?.isAuthorizedSender).toBe(true);
  });

  it("routes Telegram #General callback payloads as topic 1 when Telegram omits topic metadata", async () => {
    onSpy.mockClear();
    getChatSpy.mockResolvedValue({ id: -100123456789, type: "supergroup", is_forum: true });
    const handler = vi.fn(
      async ({ respond, conversationId, threadId }: TelegramInteractiveHandlerContext) => {
        expect(conversationId).toBe("-100123456789:topic:1");
        expect(threadId).toBe(1);
        await respond.editMessage({
          text: `Handled ${conversationId}`,
        });
        return { handled: true };
      },
    );
    registerPluginInteractiveHandler("codex-plugin", {
      channel: "telegram",
      namespace: "codexapp",
      handler: handler as never,
    });

    createTelegramBot({
      token: "tok",
      config: {
        channels: {
          telegram: {
            dmPolicy: "open",
            allowFrom: ["*"],
          },
        },
      },
    });
    const callbackHandler = getOnHandler("callback_query") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await callbackHandler({
      callbackQuery: {
        id: "cbq-codex-general",
        data: "codexapp:resume:thread-1",
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: -100123456789, type: "supergroup", title: "Forum Group" },
          date: 1736380800,
          message_id: 11,
          text: "Select a thread",
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(getChatSpy).toHaveBeenCalledWith(-100123456789);
    expect(handler).toHaveBeenCalledOnce();
    expect(editMessageTextSpy).toHaveBeenCalledWith(
      -100123456789,
      11,
      "Handled -100123456789:topic:1",
      undefined,
    );
  });
  it("keeps unconfigured dm topic commands on the flat dm session", async () => {
    onSpy.mockClear();
    sendMessageSpy.mockClear();
    commandSpy.mockClear();
    replySpy.mockClear();
    replySpy.mockResolvedValue({ text: "response" });

    loadConfig.mockReturnValue({
      commands: { native: true },
      channels: {
        telegram: {
          dmPolicy: "pairing",
        },
      },
    });
    readChannelAllowFromStore.mockResolvedValueOnce(["12345"]);

    createTelegramBot({ token: "tok" });
    const handler = commandSpy.mock.calls.find((call) => call[0] === "status")?.[1] as
      | ((ctx: Record<string, unknown>) => Promise<void>)
      | undefined;
    if (!handler) {
      throw new Error("status command handler missing");
    }

    await handler({
      message: {
        chat: { id: 12345, type: "private" },
        from: { id: 12345, username: "testuser" },
        text: "/status",
        date: 1736380800,
        message_id: 42,
        message_thread_id: 99,
      },
      match: "",
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = mockMsgContextArg(replySpy as unknown as MockCallSource, 0, 0, "replySpy call");
    expect(payload.CommandTargetSessionKey).toBe("agent:main:main");
  });

  it("uses bot topic capability for native dm topic command target sessions", async () => {
    onSpy.mockClear();
    sendMessageSpy.mockClear();
    commandSpy.mockClear();
    replySpy.mockClear();
    replySpy.mockResolvedValue({ text: "response" });

    loadConfig.mockReturnValue({
      commands: { native: true },
      channels: {
        telegram: {
          dmPolicy: "pairing",
        },
      },
    });
    readChannelAllowFromStore.mockResolvedValueOnce(["12345"]);

    createTelegramBot({ token: "tok" });
    const handler = commandSpy.mock.calls.find((call) => call[0] === "status")?.[1] as
      | ((ctx: Record<string, unknown>) => Promise<void>)
      | undefined;
    if (!handler) {
      throw new Error("status command handler missing");
    }

    await handler({
      message: {
        chat: { id: 12345, type: "private" },
        from: { id: 12345, username: "testuser" },
        text: "/status",
        date: 1736380800,
        message_id: 42,
        message_thread_id: 99,
      },
      me: { has_topics_enabled: true },
      match: "",
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = mockMsgContextArg(replySpy as unknown as MockCallSource, 0, 0, "replySpy call");
    expect(payload.CommandTargetSessionKey).toBe("agent:main:main:thread:12345:99");
  });

  it("allows native DM commands for paired users", async () => {
    onSpy.mockClear();
    sendMessageSpy.mockClear();
    commandSpy.mockClear();
    replySpy.mockClear();
    replySpy.mockResolvedValue({ text: "response" });

    loadConfig.mockReturnValue({
      commands: { native: true },
      channels: {
        telegram: {
          dmPolicy: "pairing",
        },
      },
    });
    readChannelAllowFromStore.mockResolvedValueOnce(["12345"]);

    createTelegramBot({ token: "tok" });
    const handler = commandSpy.mock.calls.find((call) => call[0] === "status")?.[1] as
      | ((ctx: Record<string, unknown>) => Promise<void>)
      | undefined;
    if (!handler) {
      throw new Error("status command handler missing");
    }

    await handler({
      message: {
        chat: { id: 12345, type: "private" },
        from: { id: 12345, username: "testuser" },
        text: "/status",
        date: 1736380800,
        message_id: 42,
      },
      match: "",
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    expect(
      sendMessageSpy.mock.calls.some(
        (call) => call[1] === "You are not authorized to use this command.",
      ),
    ).toBe(false);
  });

  it("keeps native DM commands on the startup-resolved config when fresh reads contain SecretRefs", async () => {
    onSpy.mockClear();
    sendMessageSpy.mockClear();
    commandSpy.mockClear();
    replySpy.mockClear();
    replySpy.mockResolvedValue({ text: "response" });

    const startupConfig = {
      commands: { native: true },
      channels: {
        telegram: {
          dmPolicy: "pairing" as const,
          botToken: "resolved-token",
        },
      },
    };

    createTelegramBot({
      token: "tok",
      config: startupConfig,
    });
    loadConfig.mockReturnValue({
      commands: { native: true },
      channels: {
        telegram: {
          dmPolicy: "pairing",
          botToken: { source: "env", provider: "default", id: "TELEGRAM_BOT_TOKEN" },
        },
      },
    });
    readChannelAllowFromStore.mockResolvedValueOnce(["12345"]);

    const handler = commandSpy.mock.calls.find((call) => call[0] === "status")?.[1] as
      | ((ctx: Record<string, unknown>) => Promise<void>)
      | undefined;
    if (!handler) {
      throw new Error("status command handler missing");
    }

    await handler({
      message: {
        chat: { id: 12345, type: "private" },
        from: { id: 12345, username: "testuser" },
        text: "/status",
        date: 1736380800,
        message_id: 42,
      },
      match: "",
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
  });

  it("blocks native DM commands for unpaired users", async () => {
    onSpy.mockClear();
    sendMessageSpy.mockClear();
    commandSpy.mockClear();
    replySpy.mockClear();

    loadConfig.mockReturnValue({
      commands: { native: true },
      channels: {
        telegram: {
          dmPolicy: "pairing",
        },
      },
    });
    readChannelAllowFromStore.mockResolvedValueOnce([]);

    createTelegramBot({ token: "tok" });
    const handler = commandSpy.mock.calls.find((call) => call[0] === "status")?.[1] as
      | ((ctx: Record<string, unknown>) => Promise<void>)
      | undefined;
    if (!handler) {
      throw new Error("status command handler missing");
    }

    await handler({
      message: {
        chat: { id: 12345, type: "private" },
        from: { id: 12345, username: "testuser" },
        text: "/status",
        date: 1736380800,
        message_id: 42,
      },
      match: "",
    });

    expect(replySpy).not.toHaveBeenCalled();
    expect(sendMessageSpy).toHaveBeenCalledWith(
      12345,
      "You are not authorized to use this command.",
      {},
    );
  });

  it("registers message_reaction handler", () => {
    onSpy.mockClear();
    createTelegramBot({ token: "tok" });
    const reactionHandler = onSpy.mock.calls.find((call) => call[0] === "message_reaction");
    expect(reactionHandler?.[0]).toBe("message_reaction");
    if (typeof reactionHandler?.[1] !== "function") {
      throw new Error("expected message_reaction handler");
    }
  });

  it("enqueues system event for reaction", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", allowFrom: ["*"], reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 500 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 42,
        user: { id: 9, first_name: "Ada", username: "ada_bot" },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: THUMBS_UP_EMOJI }],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(firstSystemEventArg(0)).toBe(
      `Telegram reaction added: ${THUMBS_UP_EMOJI} by Ada (@ada_bot) on msg 42`,
    );
    expect(String(systemEventOptions().contextKey)).toContain("telegram:reaction:add:1234:42:9");
  });

  it.each([
    {
      name: "blocks reaction when dmPolicy is disabled",
      updateId: 510,
      channelConfig: { dmPolicy: "disabled", reactionNotifications: "all" },
      reaction: {
        chat: { id: 1234, type: "private" },
        message_id: 42,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: THUMBS_UP_EMOJI }],
      },
      expectedEnqueueCalls: 0,
    },
    {
      name: "blocks reaction in pairing mode for non-paired sender (default dmPolicy)",
      updateId: 514,
      channelConfig: { dmPolicy: "pairing", reactionNotifications: "all" },
      reaction: {
        chat: { id: 1234, type: "private" },
        message_id: 42,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: THUMBS_UP_EMOJI }],
      },
      expectedEnqueueCalls: 0,
    },
    {
      name: "blocks reaction in allowlist mode for unauthorized direct sender",
      updateId: 511,
      channelConfig: {
        dmPolicy: "allowlist",
        allowFrom: ["12345"],
        reactionNotifications: "all",
      },
      reaction: {
        chat: { id: 1234, type: "private" },
        message_id: 42,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: THUMBS_UP_EMOJI }],
      },
      expectedEnqueueCalls: 0,
    },
    {
      name: "allows reaction in allowlist mode for authorized direct sender",
      updateId: 512,
      channelConfig: { dmPolicy: "allowlist", allowFrom: ["9"], reactionNotifications: "all" },
      reaction: {
        chat: { id: 1234, type: "private" },
        message_id: 42,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: THUMBS_UP_EMOJI }],
      },
      expectedEnqueueCalls: 1,
    },
    {
      name: "blocks reaction in open mode when wildcard access was constrained",
      updateId: 515,
      channelConfig: { dmPolicy: "open", allowFrom: ["12345"], reactionNotifications: "all" },
      reaction: {
        chat: { id: 1234, type: "private" },
        message_id: 42,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: THUMBS_UP_EMOJI }],
      },
      expectedEnqueueCalls: 0,
    },
    {
      name: "allows reaction in open mode with explicit wildcard access",
      updateId: 516,
      channelConfig: { dmPolicy: "open", allowFrom: ["*"], reactionNotifications: "all" },
      reaction: {
        chat: { id: 1234, type: "private" },
        message_id: 42,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: THUMBS_UP_EMOJI }],
      },
      expectedEnqueueCalls: 1,
    },
    {
      name: "blocks reaction in group allowlist mode for unauthorized sender",
      updateId: 513,
      channelConfig: {
        dmPolicy: "open",
        groupPolicy: "allowlist",
        groupAllowFrom: ["12345"],
        reactionNotifications: "all",
      },
      reaction: {
        chat: { id: 9999, type: "supergroup" },
        message_id: 77,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: FIRE_EMOJI }],
      },
      expectedEnqueueCalls: 0,
    },
  ])("$name", async ({ updateId, channelConfig, reaction, expectedEnqueueCalls }) => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();

    loadConfig.mockReturnValue({
      channels: {
        telegram: channelConfig,
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: updateId },
      messageReaction: reaction,
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(expectedEnqueueCalls);
  });

  it("skips reaction when reactionNotifications is off", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(true);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "off" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 501 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 42,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: THUMBS_UP_EMOJI }],
      },
    });

    expect(enqueueSystemEventSpy).not.toHaveBeenCalled();
  });

  it("defaults reactionNotifications to own", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(true);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", allowFrom: ["*"] },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 502 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 43,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: THUMBS_UP_EMOJI }],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
  });

  it("allows reaction in all mode regardless of message sender", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", allowFrom: ["*"], reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 503 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 99,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: PARTY_EMOJI }],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(firstSystemEventArg(0)).toBe(`Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 99`);
    expect(firstSystemEventArg(1)).toBeTypeOf("object");
  });

  it("skips reaction in own mode when message is not sent by bot", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", allowFrom: ["*"], reactionNotifications: "own" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 503 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 99,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: PARTY_EMOJI }],
      },
    });

    expect(enqueueSystemEventSpy).not.toHaveBeenCalled();
  });

  it("allows reaction in own mode when message is sent by bot", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(true);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", allowFrom: ["*"], reactionNotifications: "own" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 503 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 99,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: PARTY_EMOJI }],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
  });

  it("skips reaction from bot users", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(true);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", allowFrom: ["*"], reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 503 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 99,
        user: { id: 9, first_name: "Bot", is_bot: true },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: PARTY_EMOJI }],
      },
    });

    expect(enqueueSystemEventSpy).not.toHaveBeenCalled();
  });

  it("skips reaction removal (only processes added reactions)", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", allowFrom: ["*"], reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 504 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 42,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [{ type: "emoji", emoji: THUMBS_UP_EMOJI }],
        new_reaction: [],
      },
    });

    expect(enqueueSystemEventSpy).not.toHaveBeenCalled();
  });

  it("enqueues one event per added emoji reaction", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", allowFrom: ["*"], reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 505 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 42,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [{ type: "emoji", emoji: THUMBS_UP_EMOJI }],
        new_reaction: [
          { type: "emoji", emoji: THUMBS_UP_EMOJI },
          { type: "emoji", emoji: FIRE_EMOJI },
          { type: "emoji", emoji: PARTY_EMOJI },
        ],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(2);
    expect(enqueueSystemEventSpy.mock.calls.map((call) => call[0])).toEqual([
      `Telegram reaction added: ${FIRE_EMOJI} by Ada on msg 42`,
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 42`,
    ]);
  });

  it("routes forum group reactions to the general topic (thread id not available on reactions)", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    // MessageReactionUpdated does not include message_thread_id in the Bot API,
    // so forum reactions always route to the general topic (1).
    await handler({
      update: { update_id: 505 },
      messageReaction: {
        chat: { id: 5678, type: "supergroup", is_forum: true },
        message_id: 100,
        user: { id: 10, first_name: "Bob", username: "bob_user" },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: FIRE_EMOJI }],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(firstSystemEventArg(0)).toBe(
      `Telegram reaction added: ${FIRE_EMOJI} by Bob (@bob_user) on msg 100`,
    );
    expect(String(systemEventOptions().sessionKey)).toContain("telegram:group:5678:topic:1");
    expect(String(systemEventOptions().contextKey)).toContain("telegram:reaction:add:5678:100:10");
  });

  it("uses correct session key for forum group reactions in general topic", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 506 },
      messageReaction: {
        chat: { id: 5678, type: "supergroup", is_forum: true },
        message_id: 101,
        // No message_thread_id - should default to general topic (1)
        user: { id: 10, first_name: "Bob" },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: EYES_EMOJI }],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(firstSystemEventArg(0)).toBe(`Telegram reaction added: ${EYES_EMOJI} by Bob on msg 101`);
    expect(String(systemEventOptions().sessionKey)).toContain("telegram:group:5678:topic:1");
    expect(String(systemEventOptions().contextKey)).toContain("telegram:reaction:add:5678:101:10");
  });

  it("uses correct session key for regular group reactions without topic", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 507 },
      messageReaction: {
        chat: { id: 9999, type: "group" },
        message_id: 200,
        user: { id: 11, first_name: "Charlie" },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: HEART_EMOJI }],
      },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(firstSystemEventArg(0)).toBe(
      `Telegram reaction added: ${HEART_EMOJI} by Charlie on msg 200`,
    );
    expect(String(systemEventOptions().sessionKey)).toContain("telegram:group:9999");
    expect(String(systemEventOptions().contextKey)).toContain("telegram:reaction:add:9999:200:11");
    // Verify session key does NOT contain :topic:
    const eventOptions = firstSystemEventArg(1) as {
      sessionKey?: string;
    };
    const sessionKey = eventOptions.sessionKey ?? "";
    expect(sessionKey).not.toContain(":topic:");
  });

  it("blocks reaction in own mode when cache is warm and message not sent by bot", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "own" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 601 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 99,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: THUMBS_UP_EMOJI }],
      },
    });

    expect(enqueueSystemEventSpy).not.toHaveBeenCalled();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
