import { MessageFlags } from "discord-api-types/v10";
import { DEFAULT_EMOJIS, DEFAULT_TIMING } from "openclaw/plugin-sdk/channel-feedback";
import {
  recordChannelBotPairLoopAndCheckSuppression,
  type ChannelBotLoopProtectionFacts,
} from "openclaw/plugin-sdk/inbound-reply-dispatch";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-dispatch-runtime";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiscordMessagePreflightContext } from "./message-handler.preflight.js";

const sendMocks = vi.hoisted(() => ({
  reactMessageDiscord: vi.fn<
    (channelId: string, messageId: string, emoji: string, opts?: unknown) => Promise<void>
  >(async () => {}),
  removeReactionDiscord: vi.fn<
    (channelId: string, messageId: string, emoji: string, opts?: unknown) => Promise<void>
  >(async () => {}),
}));
function createMockDraftStream() {
  let messageId: string | undefined = "preview-1";
  return {
    update: vi.fn<(text: string) => void>(() => {}),
    flush: vi.fn(async () => {}),
    messageId: vi.fn(() => messageId),
    clear: vi.fn(async () => {
      messageId = undefined;
    }),
    discardPending: vi.fn(async () => {}),
    seal: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    forceNewMessage: vi.fn(() => {}),
  };
}

const deliveryMocks = vi.hoisted(() => ({
  editMessageDiscord: vi.fn<
    (
      channelId: string,
      messageId: string,
      payload: unknown,
      opts?: unknown,
    ) => Promise<import("discord-api-types/v10").APIMessage>
  >(async () => ({ id: "m1" }) as import("discord-api-types/v10").APIMessage),
  deliverDiscordReply: vi.fn<(params: unknown) => Promise<void>>(async () => {}),
  createDiscordDraftStream: vi.fn<(params: unknown) => ReturnType<typeof createMockDraftStream>>(
    () => createMockDraftStream(),
  ),
}));
const editMessageDiscord = deliveryMocks.editMessageDiscord;
const deliverDiscordReply = deliveryMocks.deliverDiscordReply;
const createDiscordDraftStream = deliveryMocks.createDiscordDraftStream;

vi.mock("../send.js", () => ({
  reactMessageDiscord: async (
    channelId: string,
    messageId: string,
    emoji: string,
    opts?: unknown,
  ) => {
    await sendMocks.reactMessageDiscord(channelId, messageId, emoji, opts);
    return { ok: true };
  },
  removeReactionDiscord: async (
    channelId: string,
    messageId: string,
    emoji: string,
    opts?: unknown,
  ) => {
    await sendMocks.removeReactionDiscord(channelId, messageId, emoji, opts);
    return { ok: true };
  },
}));

const discordTargetMocks = vi.hoisted(() => ({
  resolveDiscordTargetChannelId: vi.fn(async (target: string, _opts?: unknown) => ({
    channelId: target === "user:u1" ? "dm-u1" : target,
  })),
}));

vi.mock("../send.shared.js", () => ({
  resolveDiscordTargetChannelId: (target: string, opts: unknown) =>
    discordTargetMocks.resolveDiscordTargetChannelId(target, opts),
}));

vi.mock("../send.messages.js", () => ({
  editMessageDiscord: (channelId: string, messageId: string, payload: unknown, opts?: unknown) =>
    deliveryMocks.editMessageDiscord(channelId, messageId, payload, opts),
}));

vi.mock("../draft-stream.js", () => ({
  createDiscordDraftStream: (params: unknown) => deliveryMocks.createDiscordDraftStream(params),
}));

vi.mock("./reply-delivery.js", () => ({
  deliverDiscordReply: (params: unknown) => deliveryMocks.deliverDiscordReply(params),
}));

type DispatchInboundParams = {
  dispatcher: {
    sendBlockReply: (payload: ReplyPayload) => boolean | Promise<boolean>;
    sendFinalReply: (payload: ReplyPayload) => boolean | Promise<boolean>;
  };
  replyOptions?: {
    onReasoningStream?: (payload?: { text?: string }) => Promise<void> | void;
    onReasoningEnd?: () => Promise<void> | void;
    onToolStart?: (payload: {
      name?: string;
      phase?: string;
      args?: Record<string, unknown>;
      detailMode?: "explain" | "raw";
    }) => Promise<void> | void;
    onItemEvent?: (payload: {
      kind?: string;
      progressText?: string;
      summary?: string;
      title?: string;
      name?: string;
    }) => Promise<void> | void;
    onPlanUpdate?: (payload: {
      phase?: string;
      explanation?: string;
      steps?: string[];
    }) => Promise<void> | void;
    onApprovalEvent?: (payload: { phase?: string; command?: string }) => Promise<void> | void;
    onCommandOutput?: (payload: {
      phase?: string;
      name?: string;
      title?: string;
      exitCode?: number | null;
    }) => Promise<void> | void;
    onPatchSummary?: (payload: {
      phase?: string;
      summary?: string;
      title?: string;
      name?: string;
      added?: string[];
      modified?: string[];
      deleted?: string[];
    }) => Promise<void> | void;
    onReplyStart?: () => Promise<void> | void;
    sourceReplyDeliveryMode?: "automatic" | "message_tool_only";
    disableBlockStreaming?: boolean;
    suppressDefaultToolProgressMessages?: boolean;
    queuedDeliveryCorrelations?: Array<{ begin: () => () => void }>;
    suppressTyping?: boolean;
    onCompactionStart?: () => Promise<void> | void;
    onCompactionEnd?: () => Promise<void> | void;
    onPartialReply?: (payload: { text?: string }) => Promise<void> | void;
    onAssistantMessageStart?: () => Promise<void> | void;
    allowProgressCallbacksWhenSourceDeliverySuppressed?: boolean;
  };
};
const dispatchInboundMessage = vi.hoisted(() =>
  vi.fn<
    (params?: DispatchInboundParams) => Promise<{
      queuedFinal: boolean;
      counts: { final: number; tool: number; block: number };
      failedCounts?: { final?: number; tool?: number; block?: number };
    }>
  >(async (_params?: DispatchInboundParams) => ({
    queuedFinal: false,
    counts: { final: 0, tool: 0, block: 0 },
  })),
);
const recordInboundSession = vi.hoisted(() =>
  vi.fn<(params?: unknown) => Promise<void>>(async () => {}),
);
const configSessionsMocks = vi.hoisted(() => ({
  loadSessionStore: vi.fn<(storePath: string, opts?: unknown) => Record<string, unknown>>(
    () => ({}),
  ),
  readSessionUpdatedAt: vi.fn<(params?: unknown) => number | undefined>(() => undefined),
  readLatestAssistantTextFromSessionTranscript: vi.fn<
    (sessionFile: string) => Promise<{ text: string; timestamp?: number } | undefined>
  >(async () => undefined),
  resolveAndPersistSessionFile: vi.fn<(params?: unknown) => Promise<{ sessionFile: string }>>(
    async () => ({ sessionFile: "/tmp/openclaw-discord-process-test-session.jsonl" }),
  ),
  resolveSessionStoreEntry: vi.fn<
    (params: { store: Record<string, unknown>; sessionKey?: string }) => { existing?: unknown }
  >((params) => ({
    existing: params.sessionKey ? params.store[params.sessionKey] : undefined,
  })),
  resolveStorePath: vi.fn<(path?: unknown, opts?: unknown) => string>(
    () => "/tmp/openclaw-discord-process-test-sessions.json",
  ),
}));
const loadSessionStore = configSessionsMocks.loadSessionStore;
const readSessionUpdatedAt = configSessionsMocks.readSessionUpdatedAt;
const readLatestAssistantTextFromSessionTranscript =
  configSessionsMocks.readLatestAssistantTextFromSessionTranscript;
const resolveAndPersistSessionFile = configSessionsMocks.resolveAndPersistSessionFile;
const resolveSessionStoreEntry = configSessionsMocks.resolveSessionStoreEntry;
const resolveStorePath = configSessionsMocks.resolveStorePath;
const createDiscordRestClientSpy = vi.hoisted(() =>
  vi.fn<
    (params: unknown) => {
      token: string;
      rest: object;
      account: { accountId: string; config: object };
    }
  >(() => ({
    token: "token",
    rest: {},
    account: { accountId: "default", config: {} },
  })),
);
let createBaseDiscordMessageContext: typeof import("./message-handler.test-harness.js").createBaseDiscordMessageContext;
let createDiscordDirectMessageContextOverrides: typeof import("./message-handler.test-harness.js").createDiscordDirectMessageContextOverrides;
let threadBindingTesting: typeof import("./thread-bindings.js").__testing;
let createThreadBindingManager: typeof import("./thread-bindings.js").createThreadBindingManager;
let processDiscordMessage: typeof import("./message-handler.process.js").processDiscordMessage;
let notifyDiscordInboundEventOutboundSuccess: typeof import("../inbound-event-delivery.js").notifyDiscordInboundEventOutboundSuccess;

vi.mock("openclaw/plugin-sdk/reply-runtime", () => ({
  dispatchInboundMessage: (params: DispatchInboundParams) => dispatchInboundMessage(params),
  settleReplyDispatcher: async (params: {
    dispatcher: { markComplete: () => void; waitForIdle: () => Promise<void> };
    onSettled?: () => void | Promise<void>;
  }) => {
    params.dispatcher.markComplete();
    try {
      await params.dispatcher.waitForIdle();
    } finally {
      await params.onSettled?.();
    }
  },
  createReplyDispatcherWithTyping: (opts: {
    deliver: (payload: unknown, info: { kind: string }) => Promise<void> | void;
    onReplyStart?: () => Promise<void> | void;
  }) => {
    const pendingDeliveries: Promise<void>[] = [];
    const queueDelivery = (payload: unknown, info: { kind: "block" | "final" }) => {
      const delivery = Promise.resolve(opts.deliver(payload, info)).catch(() => undefined);
      pendingDeliveries.push(delivery);
      return true;
    };
    return {
      dispatcher: {
        sendToolResult: vi.fn(() => true),
        sendBlockReply: vi.fn((payload: unknown) => queueDelivery(payload, { kind: "block" })),
        sendFinalReply: vi.fn((payload: unknown) => queueDelivery(payload, { kind: "final" })),
        waitForIdle: vi.fn(async () => {
          await Promise.all(pendingDeliveries);
        }),
        getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
        markComplete: vi.fn(),
      },
      replyOptions: {
        onReplyStart: opts.onReplyStart,
      },
      markDispatchIdle: vi.fn(),
      markRunComplete: vi.fn(),
    };
  },
}));

vi.mock("openclaw/plugin-sdk/conversation-runtime", () => ({
  recordInboundSession: (...args: unknown[]) => recordInboundSession(...args),
  resolvePinnedMainDmOwnerFromAllowlist: (params: {
    dmScope?: string | null;
    allowFrom?: Array<string | number> | null;
    normalizeEntry: (entry: string) => string | undefined;
  }) => {
    if ((params.dmScope ?? "main") !== "main") {
      return null;
    }
    const allowFrom = Array.isArray(params.allowFrom) ? params.allowFrom : [];
    if (allowFrom.some((entry) => String(entry).trim() === "*")) {
      return null;
    }
    const owners = Array.from(
      new Set(
        allowFrom
          .map((entry) => params.normalizeEntry(String(entry)))
          .filter((entry): entry is string => Boolean(entry)),
      ),
    );
    return owners.length === 1 ? owners[0] : null;
  },
  registerSessionBindingAdapter: vi.fn(),
  unregisterSessionBindingAdapter: vi.fn(),
  resolveThreadBindingConversationIdFromBindingId: (bindingId: string) =>
    bindingId.split(":").at(-1) ?? bindingId,
}));

vi.mock("openclaw/plugin-sdk/session-store-runtime", () => ({
  loadSessionStore: (storePath: string, opts?: unknown) =>
    configSessionsMocks.loadSessionStore(storePath, opts),
  readSessionUpdatedAt: (params?: unknown) => configSessionsMocks.readSessionUpdatedAt(params),
  readLatestAssistantTextFromSessionTranscript: (sessionFile: string) =>
    configSessionsMocks.readLatestAssistantTextFromSessionTranscript(sessionFile),
  resolveAndPersistSessionFile: (params?: unknown) =>
    configSessionsMocks.resolveAndPersistSessionFile(params),
  resolveSessionStoreEntry: (params: { store: Record<string, unknown>; sessionKey?: string }) =>
    configSessionsMocks.resolveSessionStoreEntry(params),
  resolveStorePath: (path?: unknown, opts?: unknown) =>
    configSessionsMocks.resolveStorePath(path, opts),
}));

vi.mock("../client.js", () => ({
  createDiscordRuntimeAccountContext: (params: { cfg: unknown; accountId: string }) => ({
    cfg: params.cfg,
    accountId: params.accountId,
  }),
  createDiscordRestClient: (params: unknown) => createDiscordRestClientSpy(params),
}));

const BASE_CHANNEL_ROUTE = {
  agentId: "main",
  channel: "discord",
  accountId: "default",
  sessionKey: "agent:main:discord:channel:c1",
  mainSessionKey: "agent:main:main",
} as const;

async function createBaseContext(
  ...args: Parameters<typeof createBaseDiscordMessageContext>
): Promise<Awaited<ReturnType<typeof createBaseDiscordMessageContext>>> {
  return await createBaseDiscordMessageContext(...args);
}

async function createAutomaticSourceDeliveryContext(
  overrides: Parameters<typeof createBaseDiscordMessageContext>[0] = {},
): Promise<Awaited<ReturnType<typeof createBaseDiscordMessageContext>>> {
  const cfg = (overrides.cfg ?? {}) as {
    messages?: {
      groupChat?: Record<string, unknown>;
    } & Record<string, unknown>;
  } & Record<string, unknown>;
  return await createBaseContext({
    ...overrides,
    cfg: {
      ...cfg,
      messages: {
        ...cfg.messages,
        ackReaction: cfg.messages?.ackReaction ?? "👀",
        groupChat: {
          ...cfg.messages?.groupChat,
          visibleReplies: "automatic",
        },
      },
    },
  });
}

function createDirectMessageContextOverrides(
  ...args: Parameters<typeof createDiscordDirectMessageContextOverrides>
): ReturnType<typeof createDiscordDirectMessageContextOverrides> {
  return createDiscordDirectMessageContextOverrides(...args);
}

function mockDispatchSingleBlockReply(payload: { text: string; isReasoning?: boolean }) {
  dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
    await params?.dispatcher.sendBlockReply(payload);
    return { queuedFinal: false, counts: { final: 0, tool: 0, block: 1 } };
  });
}

function createNoQueuedDispatchResult() {
  return { queuedFinal: false, counts: { final: 0, tool: 0, block: 0 } };
}

async function processStreamOffDiscordMessage() {
  const ctx = await createBaseContext({ discordConfig: { streamMode: "off" } });
  await runProcessDiscordMessage(ctx);
}

beforeAll(async () => {
  vi.useRealTimers();
  ({ createBaseDiscordMessageContext, createDiscordDirectMessageContextOverrides } =
    await import("./message-handler.test-harness.js"));
  ({ __testing: threadBindingTesting, createThreadBindingManager } =
    await import("./thread-bindings.js"));
  ({ processDiscordMessage } = await import("./message-handler.process.js"));
  ({ notifyDiscordInboundEventOutboundSuccess } = await import("../inbound-event-delivery.js"));
});

beforeEach(() => {
  vi.useRealTimers();
  sendMocks.reactMessageDiscord.mockClear();
  sendMocks.removeReactionDiscord.mockClear();
  discordTargetMocks.resolveDiscordTargetChannelId.mockClear();
  editMessageDiscord.mockClear();
  deliverDiscordReply.mockClear();
  createDiscordDraftStream.mockClear();
  dispatchInboundMessage.mockClear();
  recordInboundSession.mockClear();
  loadSessionStore.mockClear();
  readSessionUpdatedAt.mockClear();
  readLatestAssistantTextFromSessionTranscript.mockClear();
  resolveAndPersistSessionFile.mockClear();
  resolveSessionStoreEntry.mockClear();
  resolveStorePath.mockClear();
  createDiscordRestClientSpy.mockClear();
  dispatchInboundMessage.mockResolvedValue(createNoQueuedDispatchResult());
  recordInboundSession.mockResolvedValue(undefined);
  loadSessionStore.mockReturnValue({});
  readSessionUpdatedAt.mockReturnValue(undefined);
  readLatestAssistantTextFromSessionTranscript.mockResolvedValue(undefined);
  resolveAndPersistSessionFile.mockResolvedValue({
    sessionFile: "/tmp/openclaw-discord-process-test-session.jsonl",
  });
  resolveSessionStoreEntry.mockImplementation((params) => ({
    existing: params.sessionKey ? params.store[params.sessionKey] : undefined,
  }));
  resolveStorePath.mockReturnValue("/tmp/openclaw-discord-process-test-sessions.json");
  threadBindingTesting.resetThreadBindingsForTests();
});

function getLastRouteUpdate():
  | {
      sessionKey?: string;
      channel?: string;
      to?: string;
      accountId?: string;
      mainDmOwnerPin?: { ownerRecipient?: string; senderRecipient?: string };
    }
  | undefined {
  const callArgs = recordInboundSession.mock.calls[recordInboundSession.mock.calls.length - 1] as
    | unknown[]
    | undefined;
  const params = callArgs?.[0] as
    | {
        updateLastRoute?: {
          sessionKey?: string;
          channel?: string;
          to?: string;
          accountId?: string;
          mainDmOwnerPin?: { ownerRecipient?: string; senderRecipient?: string };
        };
      }
    | undefined;
  return params?.updateLastRoute;
}

function getLastDispatchCtx():
  | {
      BodyForAgent?: string;
      ChatType?: string;
      CommandBody?: string;
      From?: string;
      MediaTranscribedIndexes?: number[];
      MessageSid?: string;
      MessageSidFull?: string;
      MessageThreadId?: string | number;
      ModelParentSessionKey?: string;
      OriginatingTo?: string;
      ParentSessionKey?: string;
      SessionKey?: string;
      ThreadStarterBody?: string;
      To?: string;
      Transcript?: string;
    }
  | undefined {
  const callArgs = dispatchInboundMessage.mock.calls[
    dispatchInboundMessage.mock.calls.length - 1
  ] as unknown[] | undefined;
  const params = callArgs?.[0] as
    | {
        ctx?: {
          BodyForAgent?: string;
          ChatType?: string;
          CommandBody?: string;
          From?: string;
          MediaTranscribedIndexes?: number[];
          MessageSid?: string;
          MessageSidFull?: string;
          MessageThreadId?: string | number;
          ModelParentSessionKey?: string;
          OriginatingTo?: string;
          ParentSessionKey?: string;
          SessionKey?: string;
          ThreadStarterBody?: string;
          To?: string;
          Transcript?: string;
        };
      }
    | undefined;
  return params?.ctx;
}

function getLastDispatchReplyOptions(): DispatchInboundParams["replyOptions"] | undefined {
  const callArgs = dispatchInboundMessage.mock.calls[
    dispatchInboundMessage.mock.calls.length - 1
  ] as unknown[] | undefined;
  const params = callArgs?.[0] as DispatchInboundParams | undefined;
  return params?.replyOptions;
}

async function runProcessDiscordMessage(ctx: DiscordMessagePreflightContext): Promise<void> {
  await processDiscordMessage(ctx);
}

async function runInPartialStreamMode(): Promise<void> {
  const ctx = await createBaseContext({
    discordConfig: { streamMode: "partial" },
  });
  await runProcessDiscordMessage(ctx);
}

function getReactionEmojis(): string[] {
  return (
    sendMocks.reactMessageDiscord.mock.calls as unknown as Array<[unknown, unknown, string]>
  ).map((call) => call[2]);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error(`${label} was not an object`);
  }
  return value as Record<string, unknown>;
}

type MockWithCalls = { mock: { calls: unknown[][] } };

function firstMockCall(mock: MockWithCalls, label: string): unknown[] {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error(`missing ${label} call`);
  }
  return call;
}

function firstMockArg(mock: MockWithCalls, label: string) {
  return firstMockCall(mock, label)[0];
}

function firstDispatchParams(): DispatchInboundParams {
  return firstMockArg(dispatchInboundMessage, "dispatchInboundMessage") as DispatchInboundParams;
}

function expectRecordFields(record: Record<string, unknown>, fields: Record<string, unknown>) {
  for (const [key, value] of Object.entries(fields)) {
    expect(record[key]).toEqual(value);
  }
}

function expectAckReactionRuntimeOptions(
  options: unknown,
  params?: {
    accountId?: string;
    ackReaction?: string;
    removeAckAfterReply?: boolean;
  },
) {
  const optionRecord = requireRecord(options, "reaction runtime options");
  requireRecord(optionRecord.rest, "reaction REST client");
  if (params?.accountId) {
    expect(optionRecord.accountId).toBe(params.accountId);
  }
  const messages: Record<string, unknown> = {};
  if (params?.ackReaction) {
    messages.ackReaction = params.ackReaction;
  }
  if (params?.removeAckAfterReply !== undefined) {
    messages.removeAckAfterReply = params.removeAckAfterReply;
  }
  if (Object.keys(messages).length > 0) {
    const cfg = requireRecord(optionRecord.cfg, "reaction config");
    expectRecordFields(requireRecord(cfg.messages, "reaction message config"), messages);
  }
}

function requireReactionCall(
  mock: typeof sendMocks.reactMessageDiscord | typeof sendMocks.removeReactionDiscord,
  index: number,
) {
  const call = mock.mock.calls[index] as unknown[] | undefined;
  if (!call) {
    throw new Error(`missing reaction call ${index + 1}`);
  }
  return call;
}

function expectReactionCallAt(
  mock: typeof sendMocks.reactMessageDiscord | typeof sendMocks.removeReactionDiscord,
  index: number,
  emoji: string,
  params?: {
    accountId?: string;
    ackReaction?: string;
    removeAckAfterReply?: boolean;
    channelId?: string;
    messageId?: string;
  },
) {
  const call = requireReactionCall(mock, index);
  expect(call[0]).toBe(params?.channelId ?? "c1");
  expect(call[1]).toBe(params?.messageId ?? "m1");
  expect(call[2]).toBe(emoji);
  expectAckReactionRuntimeOptions(call[3], params);
}

function expectReactionCallsContain(channelId: string, messageId: string, emoji: string) {
  const calls = sendMocks.reactMessageDiscord.mock.calls as unknown as Array<
    [string, string, string]
  >;
  const hasCall = calls.some(
    ([actualChannelId, actualMessageId, actualEmoji]) =>
      actualChannelId === channelId && actualMessageId === messageId && actualEmoji === emoji,
  );
  expect(hasCall).toBe(true);
}

function expectReactAckCallAt(
  index: number,
  emoji: string,
  params?: {
    channelId?: string;
    messageId?: string;
    accountId?: string;
    ackReaction?: string;
    removeAckAfterReply?: boolean;
  },
) {
  expectReactionCallAt(sendMocks.reactMessageDiscord, index, emoji, params);
}

function expectRemoveAckCallAt(
  index: number,
  emoji: string,
  params?: {
    channelId?: string;
    messageId?: string;
    accountId?: string;
    ackReaction?: string;
    removeAckAfterReply?: boolean;
  },
) {
  expectReactionCallAt(sendMocks.removeReactionDiscord, index, emoji, params);
}

function createMockDraftStreamForTest() {
  const draftStream = createMockDraftStream();
  createDiscordDraftStream.mockReturnValueOnce(draftStream);
  return draftStream;
}

function expectPreviewEditContent(content: string) {
  const call = firstMockCall(editMessageDiscord, "preview edit");
  expect(call[0]).toBe("c1");
  expect(call[1]).toBe("preview-1");
  expect(call[2]).toEqual({ content, flags: MessageFlags.SuppressEmbeds });
  requireRecord(requireRecord(call[3], "preview edit options").rest, "preview edit REST client");
}

function expectSinglePreviewEdit() {
  expectPreviewEditContent("Hello\nWorld");
  expect(deliverDiscordReply).not.toHaveBeenCalled();
}

describe("processDiscordMessage ack reactions", () => {
  it("drops bot-loop-suppressed messages before Discord side effects", async () => {
    const botLoopProtection: ChannelBotLoopProtectionFacts = {
      scopeId: "discord-process-side-effect-test",
      conversationId: "c-loop-side-effects",
      senderId: "bot-a",
      receiverId: "bot-b",
      config: {
        maxEventsPerWindow: 1,
        windowSeconds: 60,
        cooldownSeconds: 60,
      },
      defaultEnabled: true,
      nowMs: 10_000,
    };
    expect(recordChannelBotPairLoopAndCheckSuppression(botLoopProtection)).toEqual({
      suppressed: false,
    });
    const observer = { onReplyPlanResolved: vi.fn() };
    const ctx = await createAutomaticSourceDeliveryContext({
      messageChannelId: botLoopProtection.conversationId,
      message: {
        id: "m-loop-side-effects",
        channelId: botLoopProtection.conversationId,
        timestamp: new Date().toISOString(),
        attachments: [
          {
            id: "att-loop",
            url: "https://cdn.discordapp.test/loop.png",
            contentType: "image/png",
            filename: "loop.png",
            size: 16,
          },
        ],
      },
      botLoopProtection: {
        ...botLoopProtection,
        nowMs: 10_001,
      },
    });

    await processDiscordMessage(ctx, observer);

    expect(observer.onReplyPlanResolved).not.toHaveBeenCalled();
    expect(createDiscordRestClientSpy).not.toHaveBeenCalled();
    expect(sendMocks.reactMessageDiscord).not.toHaveBeenCalled();
    expect(recordInboundSession).not.toHaveBeenCalled();
    expect(dispatchInboundMessage).not.toHaveBeenCalled();
  });

  it("skips ack reactions for group-mentions when mentions are not required", async () => {
    const ctx = await createBaseContext({
      shouldRequireMention: false,
      effectiveWasMentioned: false,
    });

    await runProcessDiscordMessage(ctx);

    expect(sendMocks.reactMessageDiscord).not.toHaveBeenCalled();
  });

  it("sends ack reactions for mention-gated guild messages when mentioned", async () => {
    const ctx = await createAutomaticSourceDeliveryContext({
      accountId: "ops",
      shouldRequireMention: true,
      effectiveWasMentioned: true,
      route: {
        agentId: "main",
        channel: "discord",
        accountId: "ops",
        sessionKey: "agent:main:discord:channel:c1",
        mainSessionKey: "agent:main:main",
      },
    });

    await runProcessDiscordMessage(ctx);

    expectReactAckCallAt(0, "👀", {
      accountId: "ops",
      ackReaction: "👀",
    });
  });

  it("uses preflight-resolved messageChannelId when message.channelId is missing", async () => {
    const ctx = await createAutomaticSourceDeliveryContext({
      message: {
        id: "m1",
        timestamp: new Date().toISOString(),
        attachments: [],
      },
      messageChannelId: "fallback-channel",
      shouldRequireMention: true,
      effectiveWasMentioned: true,
    });

    await runProcessDiscordMessage(ctx);

    expectReactAckCallAt(0, "👀", {
      channelId: "fallback-channel",
      accountId: "default",
      ackReaction: "👀",
    });
  });

  it("uses separate REST clients for feedback and reply delivery", async () => {
    const feedbackRest = { post: vi.fn(async () => undefined) };
    const deliveryRest = { post: vi.fn(async () => undefined) };
    createDiscordRestClientSpy
      .mockReturnValueOnce({
        token: "feedback-token",
        rest: feedbackRest as never,
        account: { config: {} } as never,
      })
      .mockReturnValueOnce({
        token: "delivery-token",
        rest: deliveryRest as never,
        account: { config: {} } as never,
      });
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.dispatcher.sendFinalReply({ text: "hello" });
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticSourceDeliveryContext();

    await runProcessDiscordMessage(ctx);

    expect(sendMocks.reactMessageDiscord).toHaveBeenCalled();
    const feedbackOptions = requireRecord(
      requireReactionCall(sendMocks.reactMessageDiscord, 0)[3],
      "feedback reaction options",
    );
    expect(feedbackOptions.rest).toBe(feedbackRest);
    const deliveryParams = requireRecord(
      firstMockArg(deliverDiscordReply, "deliverDiscordReply"),
      "delivery params",
    );
    expect(deliveryParams.rest).toBe(deliveryRest);
    expect(feedbackRest).not.toBe(deliveryRest);
  });

  it("debounces intermediate phase reactions and jumps to done for short runs", async () => {
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onReasoningStream?.();
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      return createNoQueuedDispatchResult();
    });

    const ctx = await createAutomaticSourceDeliveryContext();

    await runProcessDiscordMessage(ctx);

    const emojis = getReactionEmojis();
    expect(emojis).toContain("👀");
    expect(emojis).toContain(DEFAULT_EMOJIS.done);
    expect(emojis).not.toContain(DEFAULT_EMOJIS.thinking);
    expect(emojis).not.toContain(DEFAULT_EMOJIS.coding);
  });

  it("marks automatic visible replies as failed when final Discord delivery fails", async () => {
    dispatchInboundMessage.mockResolvedValueOnce({
      queuedFinal: false,
      counts: { final: 0, tool: 0, block: 0 },
      failedCounts: { final: 1 },
    });

    const ctx = await createAutomaticSourceDeliveryContext();

    await runProcessDiscordMessage(ctx);

    const emojis = getReactionEmojis();
    expect(emojis).toContain(DEFAULT_EMOJIS.error);
    expect(emojis).not.toContain(DEFAULT_EMOJIS.done);
  });

  it("can bind status reactions to an explicitly tracked reaction target", async () => {
    vi.useFakeTimers();
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({
        name: "message",
        phase: "start",
        args: {
          action: "react",
          channelId: "c1",
          messageId: "m1",
          emoji: "📈",
          trackToolCalls: true,
        },
      });
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);
      return createNoQueuedDispatchResult();
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      cfg: { messages: { ackReaction: "👀" } },
    });

    await runProcessDiscordMessage(ctx);
    await vi.runAllTimersAsync();

    expectReactionCallsContain("c1", "m1", "📈");
    expectReactionCallsContain("c1", "m1", "✉️");
    expectReactionCallsContain("c1", "m1", DEFAULT_EMOJIS.done);
  });

  it("resolves tracked reaction to targets like the Discord reaction action", async () => {
    vi.useFakeTimers();
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({
        name: "message",
        phase: "start",
        args: {
          action: "react",
          to: "user:u1",
          messageId: "m1",
          emoji: "📈",
          trackToolCalls: true,
        },
      });
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);
      return createNoQueuedDispatchResult();
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      cfg: { messages: { ackReaction: "👀" } },
    });

    await runProcessDiscordMessage(ctx);
    await vi.runAllTimersAsync();

    const resolveCall = firstMockCall(
      discordTargetMocks.resolveDiscordTargetChannelId,
      "resolveDiscordTargetChannelId",
    );
    expect(resolveCall[0]).toBe("user:u1");
    expect(requireRecord(resolveCall[1], "Discord target resolve options").accountId).toBe(
      "default",
    );
    expectReactionCallsContain("dm-u1", "m1", "📈");
    expectReactionCallsContain("dm-u1", "m1", "✉️");
    expectReactionCallsContain("dm-u1", "m1", DEFAULT_EMOJIS.done);
  });

  it("shows stall emojis for long no-progress runs", async () => {
    vi.useFakeTimers();
    let releaseDispatch: (() => void) | undefined;
    const dispatchGate = new Promise<void>((resolve) => {
      releaseDispatch = () => resolve();
    });
    dispatchInboundMessage.mockImplementationOnce(async () => {
      await dispatchGate;
      return createNoQueuedDispatchResult();
    });

    const ctx = await createAutomaticSourceDeliveryContext();
    const runPromise = runProcessDiscordMessage(ctx);

    await vi.advanceTimersByTimeAsync(30_001);
    if (!releaseDispatch) {
      throw new Error("Expected Discord dispatch release callback to be initialized");
    }
    releaseDispatch();
    await vi.runAllTimersAsync();

    await runPromise;
    const emojis = (
      sendMocks.reactMessageDiscord.mock.calls as unknown as Array<[unknown, unknown, string]>
    ).map((call) => call[2]);
    expect(emojis).toContain(DEFAULT_EMOJIS.stallSoft);
    expect(emojis).toContain(DEFAULT_EMOJIS.stallHard);
    expect(emojis).toContain(DEFAULT_EMOJIS.done);
  });

  it("applies status reaction emoji/timing overrides from config", async () => {
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onReasoningStream?.();
      return createNoQueuedDispatchResult();
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      cfg: {
        messages: {
          ackReaction: "👀",
          statusReactions: {
            emojis: { queued: "🟦", thinking: "🧪", done: "🏁" },
            timing: { debounceMs: 0 },
          },
        },
        session: { store: "/tmp/openclaw-discord-process-test-sessions.json" },
      },
    });

    await runProcessDiscordMessage(ctx);

    const emojis = getReactionEmojis();
    expect(emojis).toContain("🟦");
    expect(emojis).toContain("🏁");
  });

  it("falls back to plain ack when status reactions are disabled", async () => {
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onReasoningStream?.();
      return createNoQueuedDispatchResult();
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      cfg: {
        messages: {
          ackReaction: "👀",
          statusReactions: {
            enabled: false,
            timing: { debounceMs: 0 },
          },
        },
        session: { store: "/tmp/openclaw-discord-process-test-sessions.json" },
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(getReactionEmojis()).toEqual(["👀"]);
  });

  it("shows compacting reaction during auto-compaction and resumes thinking", async () => {
    vi.useFakeTimers();
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onCompactionStart?.();
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      await params?.replyOptions?.onCompactionEnd?.();
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      return createNoQueuedDispatchResult();
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      cfg: {
        messages: {
          ackReaction: "👀",
          statusReactions: {
            timing: { debounceMs: 0 },
          },
        },
        session: { store: "/tmp/openclaw-discord-process-test-sessions.json" },
      },
    });

    const runPromise = runProcessDiscordMessage(ctx);
    await vi.advanceTimersByTimeAsync(2_500);
    await vi.runAllTimersAsync();
    await runPromise;

    const emojis = getReactionEmojis();
    expect(emojis).toContain(DEFAULT_EMOJIS.compacting);
    expect(emojis).toContain(DEFAULT_EMOJIS.thinking);
  });

  it("clears status reactions when dispatch aborts and removeAckAfterReply is enabled", async () => {
    const abortController = new AbortController();
    dispatchInboundMessage.mockImplementationOnce(async () => {
      abortController.abort();
      throw new Error("aborted");
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      abortSignal: abortController.signal,
      cfg: {
        messages: {
          ackReaction: "👀",
          removeAckAfterReply: true,
        },
        session: { store: "/tmp/openclaw-discord-process-test-sessions.json" },
      },
    });

    await runProcessDiscordMessage(ctx);

    await vi.waitFor(() => expect(sendMocks.removeReactionDiscord).toHaveBeenCalled());
    expectRemoveAckCallAt(0, "👀", {
      accountId: "default",
      ackReaction: "👀",
      removeAckAfterReply: true,
    });
  });

  it("removes the plain ack reaction when status reactions are disabled and removeAckAfterReply is enabled", async () => {
    const ctx = await createAutomaticSourceDeliveryContext({
      cfg: {
        messages: {
          ackReaction: "👀",
          removeAckAfterReply: true,
          statusReactions: {
            enabled: false,
          },
        },
        session: { store: "/tmp/openclaw-discord-process-test-sessions.json" },
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(getReactionEmojis()).toEqual(["👀"]);
    expectRemoveAckCallAt(0, "👀", {
      accountId: "default",
      ackReaction: "👀",
      removeAckAfterReply: true,
    });
  });
});

describe("processDiscordMessage session routing", () => {
  it("carries preflight audio transcript into dispatch context and marks media transcribed", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(new Uint8Array([1, 2, 3, 4]), {
          headers: { "content-type": "audio/ogg" },
        }),
    );
    const ctx = await createBaseContext({
      message: {
        id: "m-audio-preflight",
        channelId: "c1",
        content: "",
        timestamp: new Date().toISOString(),
        attachments: [
          {
            id: "att-audio-preflight",
            url: "https://cdn.discordapp.com/attachments/voice.ogg",
            content_type: "audio/ogg",
            filename: "voice.ogg",
          },
        ],
      },
      baseText: "<media:audio>",
      messageText: "<media:audio>",
      preflightAudioTranscript: "hello from discord voice",
      discordRestFetch: fetchImpl,
      mediaMaxBytes: 1024 * 1024,
    });

    await runProcessDiscordMessage(ctx);

    expectRecordFields(requireRecord(getLastDispatchCtx(), "dispatch context"), {
      BodyForAgent: "hello from discord voice",
      CommandBody: "hello from discord voice",
      Transcript: "hello from discord voice",
      MediaTranscribedIndexes: [0],
    });
  });

  it("does not attach referenced reply media when reply context is hidden", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("hidden reply media should not be fetched");
    });
    const ctx = await createBaseContext({
      cfg: {
        channels: { discord: { contextVisibility: "allowlist" } },
        messages: { ackReaction: "👀" },
        session: { store: "/tmp/openclaw-discord-process-test-sessions.json" },
      },
      author: {
        id: "U1",
        username: "alice",
        discriminator: "0",
        globalName: "Alice",
      },
      channelConfig: {
        allowed: true,
        users: ["U1"],
      },
      discordRestFetch: fetchImpl,
      message: {
        id: "m-reply-hidden-media",
        channelId: "c1",
        content: "<@bot> what is this?",
        timestamp: new Date().toISOString(),
        attachments: [],
        messageReference: {
          type: 0,
          message_id: "m-hidden",
          channel_id: "c1",
        },
        referencedMessage: {
          id: "m-hidden",
          channelId: "c1",
          content: "hidden image",
          timestamp: new Date().toISOString(),
          attachments: [
            {
              id: "att-hidden",
              url: "https://cdn.discordapp.com/attachments/hidden.png",
              content_type: "image/png",
              filename: "hidden.png",
            },
          ],
          author: {
            id: "U2",
            username: "mallory",
            discriminator: "0",
            globalName: "Mallory",
          },
        },
      },
      baseText: "<@bot> what is this?",
      messageText: "<@bot> what is this?",
    });

    await runProcessDiscordMessage(ctx);

    const dispatchCtx = requireRecord(getLastDispatchCtx(), "dispatch context");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(dispatchCtx.ReplyToBody).toBeUndefined();
    expect(dispatchCtx.MediaPath).toBeUndefined();
    expect(dispatchCtx.MediaPaths).toBeUndefined();
  });

  it("stores DM lastRoute with user target for direct-session continuity", async () => {
    const ctx = await createBaseContext({
      ...createDirectMessageContextOverrides(),
      message: {
        id: "m1",
        channelId: "dm1",
        timestamp: new Date().toISOString(),
        attachments: [],
      },
      messageChannelId: "dm1",
    });

    await runProcessDiscordMessage(ctx);

    expect(getLastRouteUpdate()).toEqual({
      sessionKey: "agent:main:discord:direct:u1",
      channel: "discord",
      to: "user:U1",
      accountId: "default",
    });
    expectRecordFields(requireRecord(getLastDispatchCtx(), "dispatch context"), {
      ChatType: "direct",
      From: "discord:U1",
      To: "user:U1",
      OriginatingTo: "user:U1",
      SessionKey: "agent:main:discord:direct:u1",
    });
  });

  it("pins Discord text DM main-route updates to the single configured DM owner", async () => {
    const ctx = await createBaseContext({
      ...createDirectMessageContextOverrides(),
      cfg: {
        messages: { ackReaction: "👀" },
        session: {
          store: "/tmp/openclaw-discord-process-test-sessions.json",
          dmScope: "main",
        },
      },
      channelConfig: { users: ["user:111"] },
      baseSessionKey: "agent:main:main",
      author: {
        id: "222",
        username: "bob",
        discriminator: "0",
        globalName: "Bob",
      },
      sender: { id: "222", label: "bob" },
      route: {
        agentId: "main",
        channel: "discord",
        accountId: "default",
        sessionKey: "agent:main:main",
        mainSessionKey: "agent:main:main",
      },
    });

    await runProcessDiscordMessage(ctx);

    expectRecordFields(requireRecord(getLastRouteUpdate(), "last route update"), {
      sessionKey: "agent:main:main",
      channel: "discord",
      to: "user:222",
      accountId: "default",
    });
    expectRecordFields(
      requireRecord(
        requireRecord(getLastRouteUpdate(), "last route update").mainDmOwnerPin,
        "main DM owner pin",
      ),
      {
        ownerRecipient: "111",
        senderRecipient: "222",
      },
    );
  });

  it("stores group lastRoute with channel target", async () => {
    const ctx = await createBaseContext({
      baseSessionKey: "agent:main:discord:channel:c1",
      route: BASE_CHANNEL_ROUTE,
    });

    await runProcessDiscordMessage(ctx);

    expect(getLastRouteUpdate()).toEqual({
      sessionKey: "agent:main:discord:channel:c1",
      channel: "discord",
      to: "channel:c1",
      accountId: "default",
    });
  });

  it("marks always-on guild replies as message-tool-only and disables source streaming", async () => {
    const ctx = await createBaseContext({
      shouldRequireMention: false,
      effectiveWasMentioned: false,
      discordConfig: { streaming: "partial", blockStreaming: true },
      route: BASE_CHANNEL_ROUTE,
    });

    await runProcessDiscordMessage(ctx);

    expectRecordFields(requireRecord(getLastDispatchReplyOptions(), "dispatch reply options"), {
      sourceReplyDeliveryMode: "message_tool_only",
      disableBlockStreaming: true,
    });
    expect(createDiscordDraftStream).not.toHaveBeenCalled();
  });

  it("sends the configured ack while suppressing automatic status reactions for always-on guild replies", async () => {
    const ctx = await createBaseContext({
      shouldRequireMention: false,
      effectiveWasMentioned: false,
      ackReactionScope: "all",
      cfg: {
        messages: {
          ackReaction: "👀",
          ackReactionScope: "all",
          statusReactions: {
            timing: { debounceMs: 0 },
          },
        },
        session: { store: "/tmp/openclaw-discord-process-test-sessions.json" },
      },
      route: BASE_CHANNEL_ROUTE,
    });

    await runProcessDiscordMessage(ctx);

    expect(getLastDispatchReplyOptions()?.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(getReactionEmojis()).toEqual(["👀"]);
    expect(sendMocks.removeReactionDiscord).not.toHaveBeenCalled();
  });

  it("honors explicit status reactions for always-on guild replies", async () => {
    vi.useFakeTimers();
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onReasoningStream?.();
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      return createNoQueuedDispatchResult();
    });
    const ctx = await createBaseContext({
      shouldRequireMention: false,
      effectiveWasMentioned: false,
      ackReactionScope: "all",
      cfg: {
        messages: {
          ackReaction: "👀",
          ackReactionScope: "all",
          statusReactions: {
            enabled: true,
            timing: { debounceMs: 0 },
          },
        },
        session: { store: "/tmp/openclaw-discord-process-test-sessions.json" },
      },
      route: BASE_CHANNEL_ROUTE,
    });

    const runPromise = runProcessDiscordMessage(ctx);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.runAllTimersAsync();
    await runPromise;

    expect(getLastDispatchReplyOptions()?.sourceReplyDeliveryMode).toBe("message_tool_only");
    const emojis = getReactionEmojis();
    expect(emojis).toContain("👀");
    expect(emojis).toContain(DEFAULT_EMOJIS.thinking);
    expect(emojis).toContain(DEFAULT_EMOJIS.done);
  });

  it("suppresses Discord reactions for room events even when status reactions are explicit", async () => {
    vi.useFakeTimers();
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onReasoningStream?.();
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      return createNoQueuedDispatchResult();
    });
    const ctx = await createBaseContext({
      shouldRequireMention: false,
      effectiveWasMentioned: false,
      inboundEventKind: "room_event",
      ackReactionScope: "all",
      cfg: {
        messages: {
          ackReaction: "👀",
          ackReactionScope: "all",
          statusReactions: {
            enabled: true,
            timing: { debounceMs: 0 },
          },
        },
        session: { store: "/tmp/openclaw-discord-process-test-sessions.json" },
      },
      route: BASE_CHANNEL_ROUTE,
    });

    const runPromise = runProcessDiscordMessage(ctx);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.runAllTimersAsync();
    await runPromise;

    expect(getLastDispatchReplyOptions()?.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(getReactionEmojis()).toEqual([]);
    expect(sendMocks.removeReactionDiscord).not.toHaveBeenCalled();
  });

  it("records Discord room events in history while source replies are tool-only", async () => {
    const guildHistories = new Map();
    const ctx = await createBaseContext({
      guildHistories,
      historyLimit: 10,
      shouldRequireMention: false,
      effectiveWasMentioned: false,
      inboundEventKind: "room_event",
      baseSessionKey: BASE_CHANNEL_ROUTE.sessionKey,
      route: BASE_CHANNEL_ROUTE,
    });

    await runProcessDiscordMessage(ctx);

    expect(getLastDispatchReplyOptions()?.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(getLastDispatchReplyOptions()?.suppressTyping).toBe(true);
    expect(getLastDispatchReplyOptions()?.queuedDeliveryCorrelations).toHaveLength(1);
    expect(guildHistories.get("c1")).toMatchObject([
      {
        body: "hi",
        messageId: "m1",
        sender: "Alice",
      },
    ]);
  });

  it("clears Discord room event history after a visible action send succeeds", async () => {
    const guildHistories = new Map();
    dispatchInboundMessage.mockImplementationOnce(async () => {
      notifyDiscordInboundEventOutboundSuccess({
        sessionKey: BASE_CHANNEL_ROUTE.sessionKey,
        inboundEventKind: "room_event",
        to: "channel:c1",
        accountId: "default",
      });
      return createNoQueuedDispatchResult();
    });
    const ctx = await createBaseContext({
      guildHistories,
      historyLimit: 10,
      shouldRequireMention: false,
      effectiveWasMentioned: false,
      inboundEventKind: "room_event",
      baseSessionKey: BASE_CHANNEL_ROUTE.sessionKey,
      route: BASE_CHANNEL_ROUTE,
    });

    await runProcessDiscordMessage(ctx);

    expect(guildHistories.get("c1")).toEqual([]);
  });

  it("clears Discord group DM room event history after a visible action send succeeds", async () => {
    const guildHistories = new Map();
    dispatchInboundMessage.mockImplementationOnce(async () => {
      notifyDiscordInboundEventOutboundSuccess({
        sessionKey: BASE_CHANNEL_ROUTE.sessionKey,
        inboundEventKind: "room_event",
        to: "channel:c1",
        accountId: "default",
      });
      return createNoQueuedDispatchResult();
    });
    const ctx = await createBaseContext({
      guildHistories,
      historyLimit: 10,
      isGuildMessage: false,
      isGroupDm: true,
      isDirectMessage: false,
      shouldRequireMention: false,
      effectiveWasMentioned: false,
      inboundEventKind: "room_event",
      baseSessionKey: BASE_CHANNEL_ROUTE.sessionKey,
      route: BASE_CHANNEL_ROUTE,
    });

    await runProcessDiscordMessage(ctx);

    expect(guildHistories.get("c1")).toEqual([]);
  });

  it("clears Discord room event history after a queued core send succeeds", async () => {
    const guildHistories = new Map();
    const ctx = await createBaseContext({
      guildHistories,
      historyLimit: 10,
      shouldRequireMention: false,
      effectiveWasMentioned: false,
      inboundEventKind: "room_event",
      baseSessionKey: BASE_CHANNEL_ROUTE.sessionKey,
      route: BASE_CHANNEL_ROUTE,
    });

    await runProcessDiscordMessage(ctx);

    const begin = getLastDispatchReplyOptions()?.queuedDeliveryCorrelations?.[0]?.begin;
    expect(begin).toBeTypeOf("function");
    const end = begin?.();
    notifyDiscordInboundEventOutboundSuccess({
      sessionKey: BASE_CHANNEL_ROUTE.sessionKey,
      inboundEventKind: "room_event",
      to: "channel:c1",
      accountId: "default",
    });
    end?.();

    expect(guildHistories.get("c1")).toEqual([]);
  });

  it("uses PluralKit original ids for inbound dedupe while preserving the Discord message id", async () => {
    const ctx = await createBaseContext({
      canonicalMessageId: "orig-123",
      message: {
        id: "proxy-456",
        channelId: "c1",
        timestamp: new Date().toISOString(),
        attachments: [],
      },
    });

    await runProcessDiscordMessage(ctx);

    expectRecordFields(requireRecord(getLastDispatchCtx(), "dispatch context"), {
      MessageSid: "orig-123",
      MessageSidFull: "proxy-456",
    });
  });

  it("defaults guild replies to message-tool-only source delivery", async () => {
    await runProcessDiscordMessage(
      await createBaseContext({
        shouldRequireMention: true,
        effectiveWasMentioned: true,
        route: BASE_CHANNEL_ROUTE,
      }),
    );
    expect(getLastDispatchReplyOptions()?.sourceReplyDeliveryMode).toBe("message_tool_only");

    dispatchInboundMessage.mockClear();
    await runProcessDiscordMessage(
      await createBaseContext({
        shouldRequireMention: true,
        effectiveWasMentioned: true,
        cfg: {
          messages: {
            groupChat: {
              visibleReplies: "automatic",
            },
          },
          session: { store: "/tmp/openclaw-discord-process-test-sessions.json" },
        },
        route: BASE_CHANNEL_ROUTE,
      }),
    );
    expect(getLastDispatchReplyOptions()?.sourceReplyDeliveryMode).toBe("automatic");

    dispatchInboundMessage.mockClear();
    await runProcessDiscordMessage(
      await createBaseContext({
        shouldRequireMention: false,
        effectiveWasMentioned: false,
        inboundEventKind: "room_event",
        cfg: {
          messages: {
            groupChat: {
              visibleReplies: "automatic",
            },
          },
          session: { store: "/tmp/openclaw-discord-process-test-sessions.json" },
        },
        route: BASE_CHANNEL_ROUTE,
      }),
    );
    expect(getLastDispatchReplyOptions()?.sourceReplyDeliveryMode).toBe("message_tool_only");

    dispatchInboundMessage.mockClear();
    await runProcessDiscordMessage(
      await createBaseContext({
        ...createDirectMessageContextOverrides(),
      }),
    );
    expect(getLastDispatchReplyOptions()?.sourceReplyDeliveryMode).toBe("automatic");
  });

  it("prefers bound session keys and sets MessageThreadId for bound thread messages", async () => {
    const threadBindings = createThreadBindingManager({
      cfg: {} as import("openclaw/plugin-sdk/config-contracts").OpenClawConfig,
      accountId: "default",
      persist: false,
      enableSweeper: false,
    });
    await threadBindings.bindTarget({
      threadId: "thread-1",
      channelId: "c-parent",
      targetKind: "subagent",
      targetSessionKey: "agent:main:subagent:child",
      agentId: "main",
      webhookId: "wh_1",
      webhookToken: "tok_1",
      introText: "",
    });

    const ctx = await createBaseContext({
      messageChannelId: "thread-1",
      threadChannel: { id: "thread-1", name: "subagent-thread" },
      boundSessionKey: "agent:main:subagent:child",
      threadBindings,
      route: BASE_CHANNEL_ROUTE,
    });

    await runProcessDiscordMessage(ctx);

    expectRecordFields(requireRecord(getLastDispatchCtx(), "dispatch context"), {
      SessionKey: "agent:main:subagent:child",
      MessageThreadId: "thread-1",
    });
    expect(getLastRouteUpdate()).toEqual({
      sessionKey: "agent:main:subagent:child",
      channel: "discord",
      to: "channel:thread-1",
      accountId: "default",
    });
  });

  it("passes Discord thread parent only for model inheritance when transcript inheritance is off", async () => {
    const ctx = await createBaseContext({
      baseSessionKey: "agent:main:discord:channel:thread-1",
      route: {
        ...BASE_CHANNEL_ROUTE,
        sessionKey: "agent:main:discord:channel:thread-1",
      },
      messageChannelId: "thread-1",
      message: {
        id: "m1",
        channelId: "thread-1",
        timestamp: new Date().toISOString(),
        attachments: [],
      },
      threadChannel: { id: "thread-1", name: "child-thread" },
      threadParentId: "parent-1",
      discordConfig: { thread: { inheritParent: false } },
    });

    await runProcessDiscordMessage(ctx);

    expectRecordFields(requireRecord(getLastDispatchCtx(), "dispatch context"), {
      SessionKey: "agent:main:discord:channel:thread-1",
      MessageThreadId: "thread-1",
      ModelParentSessionKey: "agent:main:discord:channel:parent-1",
    });
    expect(getLastDispatchCtx()?.ParentSessionKey).toBeUndefined();
  });

  it("omits thread starter context when the effective thread session already exists", async () => {
    const threadSessionKey = "agent:main:discord:channel:thread-1";
    readSessionUpdatedAt.mockImplementation((params?: unknown) => {
      const sessionKey = (params as { sessionKey?: string } | undefined)?.sessionKey;
      return sessionKey === threadSessionKey ? 1_700_000_000_000 : undefined;
    });
    const rest = {
      get: vi.fn(async () => ({
        content: "original thread starter",
        embeds: [],
        author: { id: "U2", username: "bob", discriminator: "0" },
        timestamp: new Date().toISOString(),
      })),
    };
    const ctx = await createBaseContext({
      baseSessionKey: threadSessionKey,
      route: BASE_CHANNEL_ROUTE,
      messageChannelId: "thread-1",
      message: {
        id: "m1",
        channelId: "thread-1",
        content: "follow-up",
        timestamp: new Date().toISOString(),
        attachments: [],
      },
      messageText: "follow-up",
      baseText: "follow-up",
      threadChannel: { id: "thread-1", name: "child-thread" },
      threadParentId: "parent-1",
      client: { rest },
      channelConfig: { allowed: true, users: ["U2"] },
    });

    await runProcessDiscordMessage(ctx);

    expect(rest.get).toHaveBeenCalled();
    expectRecordFields(requireRecord(getLastDispatchCtx(), "dispatch context"), {
      SessionKey: threadSessionKey,
      MessageThreadId: "thread-1",
    });
    expect(getLastDispatchCtx()?.ThreadStarterBody).toBeUndefined();
  });
});

describe("processDiscordMessage draft streaming", () => {
  async function runSingleChunkFinalScenario(discordConfig: Record<string, unknown>) {
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.dispatcher.sendFinalReply({ text: "Hello\nWorld" });
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig,
    });

    await runProcessDiscordMessage(ctx);
  }

  async function createBlockModeContext(
    discordConfig: Record<string, unknown> = { streamMode: "block" },
  ) {
    return await createAutomaticSourceDeliveryContext({
      cfg: {
        messages: { ackReaction: "👀" },
        session: { store: "/tmp/openclaw-discord-process-test-sessions.json" },
        channels: {
          discord: {
            draftChunk: { minChars: 1, maxChars: 5, breakPreference: "newline" },
          },
        },
      },
      discordConfig,
    });
  }

  it("finalizes via preview edit when final fits one chunk", async () => {
    await runSingleChunkFinalScenario({ streamMode: "partial", maxLinesPerMessage: 5 });
    expectSinglePreviewEdit();
  });

  it("accepts streaming=true alias for partial preview mode", async () => {
    await runSingleChunkFinalScenario({ streaming: true, maxLinesPerMessage: 5 });
    expectSinglePreviewEdit();
  });

  it("defaults unset Discord preview streaming to progress mode without drafting text-only turns", async () => {
    await runSingleChunkFinalScenario({ maxLinesPerMessage: 5 });
    expect(createDiscordDraftStream).toHaveBeenCalledTimes(1);
    expect(editMessageDiscord).not.toHaveBeenCalled();
    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
  });

  it("streams Discord tool progress by default when streaming is unset", async () => {
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await params?.replyOptions?.onItemEvent?.({ progressText: "exec done" });
      await params?.dispatcher.sendFinalReply({ text: "done" });
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: { maxLinesPerMessage: 5 },
    });

    await runProcessDiscordMessage(ctx);

    const updates = draftStream.update.mock.calls.map((call) => call[0]);
    expect(updates).toEqual(["Pinching...\n🛠️ Exec\n• exec done"]);
    expectPreviewEditContent("done");
    expect(deliverDiscordReply).not.toHaveBeenCalled();
  });

  it("streams Discord tool progress for coding-profile message-tool-only guild replies", async () => {
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      expect(params?.replyOptions?.sourceReplyDeliveryMode).toBe("message_tool_only");
      expect(params?.replyOptions?.allowProgressCallbacksWhenSourceDeliverySuppressed).toBe(true);
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await params?.replyOptions?.onItemEvent?.({ progressText: "exec done" });
      return createNoQueuedDispatchResult();
    });

    const ctx = await createBaseContext({
      cfg: {
        tools: { profile: "coding" },
        session: { store: "/tmp/openclaw-discord-process-test-sessions.json" },
      },
      route: BASE_CHANNEL_ROUTE,
    });

    await runProcessDiscordMessage(ctx);

    expect(getLastDispatchReplyOptions()?.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(draftStream.update).toHaveBeenCalledWith("Pinching...\n🛠️ Exec\n• exec done");
    expect(deliverDiscordReply).not.toHaveBeenCalled();
  });

  it("keeps Discord preview streaming off when explicitly disabled", async () => {
    await runSingleChunkFinalScenario({ streaming: { mode: "off" }, maxLinesPerMessage: 5 });
    expect(createDiscordDraftStream).not.toHaveBeenCalled();
    expect(editMessageDiscord).not.toHaveBeenCalled();
    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
  });

  it("falls back to standard send when final needs multiple chunks", async () => {
    await runSingleChunkFinalScenario({ streamMode: "partial", maxLinesPerMessage: 1 });

    expect(editMessageDiscord).not.toHaveBeenCalled();
    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
  });

  it("uses transcript-backed final text when progress final text is truncated", async () => {
    const draftStream = createMockDraftStreamForTest();
    const prefix =
      "Here is the complete Discord answer with enough stable prefix text before truncation";
    const truncatedFinal = `${prefix}...`;
    const fullAnswer = `${prefix} ${Array.from(
      { length: 260 },
      (_value, index) => `continuation${index}`,
    ).join(" ")}`;

    loadSessionStore.mockReturnValue({
      "agent:main:discord:channel:c1": { sessionId: "session-1" },
    });
    readLatestAssistantTextFromSessionTranscript.mockResolvedValue({
      text: fullAnswer,
      timestamp: Date.now() + 60_000,
    });
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await params?.replyOptions?.onItemEvent?.({ progressText: "exec done" });
      await params?.dispatcher.sendFinalReply({ text: truncatedFinal });
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      baseSessionKey: BASE_CHANNEL_ROUTE.sessionKey,
      discordConfig: { maxLinesPerMessage: 120 },
      route: BASE_CHANNEL_ROUTE,
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.update).toHaveBeenCalledTimes(1);
    expect(editMessageDiscord).not.toHaveBeenCalled();
    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
    const params = firstMockArg(deliverDiscordReply, "deliverDiscordReply");
    const replies = requireRecord(params, "deliverDiscordReply params").replies;
    expect(Array.isArray(replies)).toBe(true);
    expect((replies as Array<{ text?: string }>)[0]?.text).toBe(fullAnswer);
  });

  it("clears partial drafts when fallback final delivery fails before completion", async () => {
    const draftStream = createMockDraftStreamForTest();
    deliverDiscordReply.mockRejectedValueOnce(new Error("send failed"));
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onPartialReply?.({ text: "partial answer..." });
      await params?.dispatcher.sendFinalReply({ text: "complete\nanswer" });
      return {
        queuedFinal: true,
        counts: { final: 1, tool: 0, block: 0 },
        failedCounts: { final: 1 },
      };
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: { streamMode: "partial", maxLinesPerMessage: 1 },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.update).toHaveBeenCalledWith("partial answer...");
    expect(editMessageDiscord).not.toHaveBeenCalled();
    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
    expect(draftStream.discardPending).toHaveBeenCalled();
    expect(draftStream.clear).toHaveBeenCalledTimes(1);
  });

  it("uses root discord maxLinesPerMessage for preview finalization when runtime config omits it", async () => {
    const longReply = Array.from({ length: 20 }, (_value, index) => `Line ${index + 1}`).join("\n");
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.dispatcher.sendFinalReply({ text: longReply });
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      cfg: {
        messages: { ackReaction: "👀" },
        session: { store: "/tmp/openclaw-discord-process-test-sessions.json" },
        channels: {
          discord: {
            maxLinesPerMessage: 120,
          },
        },
      },
      discordConfig: { streamMode: "partial" },
    });

    await runProcessDiscordMessage(ctx);

    expectPreviewEditContent(longReply);
    expect(deliverDiscordReply).not.toHaveBeenCalled();
  });

  it("falls back to standard delivery for explicit reply-tag finals", async () => {
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.dispatcher.sendFinalReply({
        text: "[[reply_to_current]] Hello\nWorld",
        replyToId: "m-explicit-1",
        replyToTag: true,
        replyToCurrent: true,
      });
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: { streamMode: "partial", maxLinesPerMessage: 5 },
    });

    await runProcessDiscordMessage(ctx);

    expect(editMessageDiscord).not.toHaveBeenCalled();
    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
  });

  it("does not flush draft previews for media finals before normal delivery", async () => {
    const draftStream = createMockDraftStreamForTest();
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.dispatcher.sendFinalReply({
        text: "Photo",
        mediaUrl: "https://example.com/a.png",
      } as never);
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: { streamMode: "partial", maxLinesPerMessage: 5 },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.flush).not.toHaveBeenCalled();
    expect(draftStream.discardPending).toHaveBeenCalledTimes(1);
    expect(draftStream.clear).toHaveBeenCalledTimes(1);
    expect(editMessageDiscord).not.toHaveBeenCalled();
    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
  });

  it("does not flush draft previews for error finals before normal delivery", async () => {
    const draftStream = createMockDraftStreamForTest();
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.dispatcher.sendFinalReply({
        text: "Something failed",
        isError: true,
      } as never);
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: { streamMode: "partial", maxLinesPerMessage: 5 },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.flush).not.toHaveBeenCalled();
    expect(draftStream.discardPending).toHaveBeenCalledTimes(1);
    expect(draftStream.clear).toHaveBeenCalledTimes(1);
    expect(editMessageDiscord).not.toHaveBeenCalled();
    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
  });

  it("suppresses reasoning payload delivery to Discord", async () => {
    mockDispatchSingleBlockReply({ text: "thinking...", isReasoning: true });
    await processStreamOffDiscordMessage();

    expect(deliverDiscordReply).not.toHaveBeenCalled();
  });

  it("suppresses reasoning-tagged final payload delivery to Discord", async () => {
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.dispatcher.sendFinalReply({
        text: "Reasoning:\nthis should stay internal",
        isReasoning: true,
      });
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: { streamMode: "off" },
    });

    await runProcessDiscordMessage(ctx);

    expect(deliverDiscordReply).not.toHaveBeenCalled();
    expect(editMessageDiscord).not.toHaveBeenCalled();
  });

  it("delivers non-reasoning block payloads to Discord", async () => {
    mockDispatchSingleBlockReply({ text: "hello from block stream" });
    await processStreamOffDiscordMessage();

    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
  });

  it("streams block previews using draft chunking", async () => {
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onPartialReply?.({ text: "HelloWorld" });
      return createNoQueuedDispatchResult();
    });

    const ctx = await createBlockModeContext();

    await runProcessDiscordMessage(ctx);

    const updates = draftStream.update.mock.calls.map((call) => call[0]);
    expect(updates).toEqual(["Hello", "HelloWorld"]);
  });

  it("keeps canonical block mode on the Discord draft preview path", async () => {
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onPartialReply?.({ text: "HelloWorld" });
      return createNoQueuedDispatchResult();
    });

    const ctx = await createBlockModeContext({ streaming: { mode: "block" } });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.update).toHaveBeenCalledWith("Hello");
    expect(firstDispatchParams().replyOptions?.disableBlockStreaming).toBe(true);
  });

  it("keeps progress label visible when Discord tool progress lines are disabled", async () => {
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onReplyStart?.();
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await params?.replyOptions?.onItemEvent?.({ progressText: "exec done" });
      return createNoQueuedDispatchResult();
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: {
        streaming: {
          mode: "progress",
          progress: {
            label: "Shelling",
            toolProgress: false,
          },
        },
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.update).toHaveBeenCalledTimes(1);
    expect(draftStream.update).toHaveBeenCalledWith("Shelling");
    expect(draftStream.flush).toHaveBeenCalledTimes(1);
    expect(
      requireRecord(firstDispatchParams().replyOptions, "dispatch reply options")
        .suppressDefaultToolProgressMessages,
    ).toBe(true);
  });

  it("does not start Discord progress drafts for text-only accepted turns", async () => {
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async () => createNoQueuedDispatchResult());

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: {
        streaming: {
          mode: "progress",
          progress: {
            label: "Shelling",
          },
        },
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.update).not.toHaveBeenCalled();
    expect(draftStream.flush).not.toHaveBeenCalled();
  });

  it("keeps Discord progress drafts instead of delivering text-only interim blocks after work expands", async () => {
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.dispatcher.sendBlockReply({ text: "on it" });
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await params?.replyOptions?.onItemEvent?.({ progressText: "exec done" });
      await params?.dispatcher.sendFinalReply({ text: "done" });
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 1 } };
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: {
        streaming: {
          mode: "progress",
          progress: {
            label: "Shelling",
          },
        },
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.update).toHaveBeenCalledWith("Shelling\n🛠️ Exec\n• exec done");
    expect(deliverDiscordReply).not.toHaveBeenCalled();
    expectPreviewEditContent("done");
  });

  it("uses raw tool-progress detail in Discord progress drafts", async () => {
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({
        name: "exec",
        phase: "start",
        args: { command: "pnpm test -- --watch=false" },
        detailMode: "raw",
      });
      await params?.replyOptions?.onItemEvent?.({ progressText: "done" });
      return createNoQueuedDispatchResult();
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: {
        streaming: {
          mode: "progress",
          progress: {
            label: "Shelling",
          },
        },
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.update).toHaveBeenCalledWith(
      "Shelling\n🛠️ run tests, `pnpm test -- --watch=false`\n• done",
    );
  });

  it("can hide raw command progress text in Discord progress drafts by config", async () => {
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({
        name: "exec",
        phase: "start",
        args: { command: "pnpm test -- --watch=false" },
        detailMode: "raw",
      });
      await params?.replyOptions?.onItemEvent?.({ progressText: "done" });
      return createNoQueuedDispatchResult();
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: {
        streaming: {
          mode: "progress",
          progress: {
            label: "Shelling",
            commandText: "status",
          },
        },
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.update).toHaveBeenCalledWith("Shelling\n🛠️ Exec\n• done");
  });

  it("keeps Discord progress lines below the configured label", async () => {
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({ name: "first", phase: "start" });
      await params?.replyOptions?.onToolStart?.({ name: "second", phase: "start" });
      await params?.replyOptions?.onToolStart?.({ name: "third", phase: "start" });
      return createNoQueuedDispatchResult();
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: {
        streaming: {
          mode: "progress",
          progress: {
            label: "Clawing...",
            maxLines: 4,
          },
        },
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.update).toHaveBeenCalledWith("Clawing...\n🧩 First\n🧩 Second\n🧩 Third");
  });

  it("skips empty apply_patch starts and renders the patch summary", async () => {
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({ name: "apply_patch", phase: "start" });
      await params?.replyOptions?.onPatchSummary?.({
        phase: "end",
        name: "apply_patch",
        summary: "1 modified",
        modified: ["extensions/discord/src/monitor/message-handler.draft-preview.ts"],
      });
      return createNoQueuedDispatchResult();
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: {
        streaming: {
          mode: "progress",
          progress: {
            label: "Clawing...",
          },
        },
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.update).toHaveBeenCalledWith(
      "Clawing...\n🩹 1 modified; extensions/discord/src/monitor/message-handler.draft-prev…",
    );
    const updates = draftStream.update.mock.calls.map((call) => call[0]);
    expect(updates.join("\n")).not.toContain("Apply Patch");
  });

  it("shows reasoning text instead of a bare Reasoning progress line", async () => {
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await params?.replyOptions?.onItemEvent?.({
        kind: "analysis",
        title: "Reasoning",
      });
      await params?.replyOptions?.onReasoningStream?.({ text: "Reading" });
      await params?.replyOptions?.onReasoningStream?.({ text: "Reading the event projector" });
      return createNoQueuedDispatchResult();
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: {
        streaming: {
          mode: "progress",
          progress: {
            label: "Clawing...",
          },
        },
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.update).toHaveBeenCalledWith(
      "Clawing...\n🛠️ Exec\n• _Reading the event projector_",
    );
    const updates = draftStream.update.mock.calls.map((call) => call[0]);
    expect(updates.join("\n")).not.toContain("Reasoning");
  });

  it("replaces reasoning snapshots instead of appending duplicates", async () => {
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await params?.replyOptions?.onReasoningStream?.({ text: "Checking files" });
      await params?.replyOptions?.onReasoningStream?.({
        text: "Checking files and tests",
      });
      return createNoQueuedDispatchResult();
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: {
        streaming: {
          mode: "progress",
          progress: {
            label: "Clawing...",
          },
        },
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.update).toHaveBeenCalledWith(
      "Clawing...\n🛠️ Exec\n• _Checking files and tests_",
    );
    const updates = draftStream.update.mock.calls.map((call) => call[0]);
    expect(updates.join("\n")).not.toContain("_Checking files_Reasoning:");
  });

  it("keeps Discord progress lines across assistant boundaries", async () => {
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({ name: "first", phase: "start" });
      await params?.replyOptions?.onAssistantMessageStart?.();
      await params?.replyOptions?.onToolStart?.({ name: "second", phase: "start" });
      return createNoQueuedDispatchResult();
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: {
        streaming: {
          mode: "progress",
          progress: {
            label: "Shelling",
          },
        },
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.update).toHaveBeenCalledWith("Shelling\n🧩 First\n🧩 Second");
    expect(draftStream.forceNewMessage).not.toHaveBeenCalled();
  });

  it("suppresses standalone Discord tool progress when partial preview lines are disabled", async () => {
    createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async () => createNoQueuedDispatchResult());

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: {
        streaming: {
          mode: "partial",
          preview: {
            toolProgress: false,
          },
        },
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(firstDispatchParams().replyOptions?.suppressDefaultToolProgressMessages).toBe(true);
  });

  it("strips reply tags from preview partials", async () => {
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onPartialReply?.({
        text: "[[reply_to_current]] Hello world",
      });
      return createNoQueuedDispatchResult();
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: { streamMode: "partial" },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.update).toHaveBeenCalledWith("Hello world");
  });

  it("forces new preview messages on assistant boundaries in block mode", async () => {
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onPartialReply?.({ text: "Hello" });
      await params?.replyOptions?.onAssistantMessageStart?.();
      return createNoQueuedDispatchResult();
    });

    const ctx = await createBlockModeContext();

    await runProcessDiscordMessage(ctx);

    expect(draftStream.forceNewMessage).toHaveBeenCalledTimes(1);
  });

  it("strips reasoning tags from partial stream updates", async () => {
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onPartialReply?.({
        text: "<thinking>Let me think about this</thinking>\nThe answer is 42",
      });
      return createNoQueuedDispatchResult();
    });

    await runInPartialStreamMode();

    const updates = draftStream.update.mock.calls.map((call) => call[0]);
    for (const text of updates) {
      expect(text).not.toContain("<thinking>");
    }
  });

  it("skips pure-reasoning partial updates without updating draft", async () => {
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onPartialReply?.({
        text: "Reasoning:\nThe user asked about X so I need to consider Y",
      });
      return createNoQueuedDispatchResult();
    });

    await runInPartialStreamMode();

    expect(draftStream.update).not.toHaveBeenCalled();
  });
});
