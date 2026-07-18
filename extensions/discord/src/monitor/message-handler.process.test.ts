// Discord tests cover message handler.process plugin behavior.
import { expectDefined } from "@openclaw/normalization-core";
import { DEFAULT_EMOJIS, DEFAULT_TIMING } from "openclaw/plugin-sdk/channel-feedback";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-dispatch-runtime";
import { setReplyPayloadMetadata } from "openclaw/plugin-sdk/reply-payload-testing";
import { logVerbose, sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiscordMessagePreflightContext } from "./message-handler.preflight.js";

vi.mock("openclaw/plugin-sdk/runtime-env", { spy: true });

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
    update: vi.fn<(text: string) => void>(() => {
      messageId ??= "preview-next";
    }),
    flush: vi.fn(async () => {}),
    messageId: vi.fn(() => messageId),
    clear: vi.fn(async () => {
      messageId = undefined;
    }),
    deleteCurrentMessage: vi.fn(async () => {
      messageId = undefined;
    }),
    discardPending: vi.fn(async () => {}),
    seal: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    forceNewMessage: vi.fn(() => {
      messageId = undefined;
    }),
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

function createNonTerminalToolWarningPayload(): ReplyPayload {
  return setReplyPayloadMetadata(
    {
      text: "⚠️ 🛠️ `run openclaw definitely-not-a-real-subcommand (agent)` failed",
      isError: true,
    },
    { nonTerminalToolErrorWarning: true },
  );
}

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

const typingMocks = vi.hoisted(() => ({
  sendTyping: vi.fn<(params: { rest: unknown; channelId: string }) => Promise<void>>(
    async () => {},
  ),
}));

vi.mock("./typing.js", () => ({
  sendTyping: typingMocks.sendTyping,
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

vi.mock("./reply-delivery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./reply-delivery.js")>()),
  deliverDiscordReply: (params: unknown) => deliveryMocks.deliverDiscordReply(params),
}));

type DispatchInboundParams = {
  ctx?: Record<string, unknown>;
  dispatcher: {
    sendBlockReply: (payload: ReplyPayload) => boolean | Promise<boolean>;
    sendFinalReply: (payload: ReplyPayload) => boolean | Promise<boolean>;
    waitForIdle: () => Promise<void>;
  };
  replyOptions?: {
    onReasoningStream?: (payload?: {
      text?: string;
      isReasoningSnapshot?: boolean;
      requiresReasoningProgressOptIn?: boolean;
    }) => Promise<void> | void;
    onReasoningEnd?: () => Promise<void> | void;
    onToolStart?: (payload: {
      name?: string;
      phase?: string;
      args?: Record<string, unknown>;
      detailMode?: "explain" | "raw";
    }) => Promise<void> | void;
    onItemEvent?: (payload: {
      itemId?: string;
      kind?: string;
      phase?: string;
      status?: string;
      progressText?: string;
      summary?: string;
      title?: string;
      name?: string;
    }) => Promise<false | void> | false | void;
    onNarrationUpdate?: (payload: { text: string }) => Promise<void> | void;
    onProgressNarratorLifecycle?: (lifecycle: {
      beginTurn: () => void;
      stopTurn: () => void;
    }) => void;
    isProgressDraftVisible?: () => boolean;
    progressPreambleEnabled?: boolean;
    narrationHideCommandText?: boolean;
    onVerboseProgressVisibility?: (isActive: () => boolean) => void;
    onPlanUpdate?: (payload: {
      phase?: string;
      explanation?: string;
      steps?: Array<{ step: string; status: "pending" | "in_progress" | "completed" }>;
    }) => Promise<void> | void;
    onApprovalEvent?: (payload: { phase?: string; command?: string }) => Promise<void> | void;
    onCommandOutput?: (payload: {
      phase?: string;
      name?: string;
      title?: string;
      status?: string;
      exitCode?: number | null;
    }) => Promise<false | void> | false | void;
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
    typingKeepalive?: boolean;
    disableBlockStreaming?: boolean;
    suppressDefaultToolProgressMessages?: boolean;
    queuedDeliveryCorrelations?: Array<{ begin: () => () => void }>;
    suppressTyping?: boolean;
    onCompactionStart?: () => Promise<void> | void;
    onCompactionEnd?: () => Promise<void> | void;
    onPartialReply?: (payload: { text?: string }) => Promise<void> | void;
    onAssistantMessageStart?: () => Promise<void> | void;
    allowProgressCallbacksWhenSourceDeliverySuppressed?: boolean;
    onTypingCleanup?: () => Promise<void> | void;
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
  getSessionEntry: vi.fn<(params?: unknown) => unknown>(() => undefined),
  readLatestAssistantTextByIdentity: vi.fn<
    (params?: unknown) => Promise<{ text: string; timestamp?: number } | undefined>
  >(async () => undefined),
  readSessionUpdatedAt: vi.fn<(params?: unknown) => number | undefined>(() => undefined),
  resolveStorePath: vi.fn<(path?: unknown, opts?: unknown) => string>(
    () => "/tmp/openclaw-discord-process-test-sessions.json",
  ),
}));
const getSessionEntry = configSessionsMocks.getSessionEntry;
const readLatestAssistantTextByIdentity = configSessionsMocks.readLatestAssistantTextByIdentity;
const readSessionUpdatedAt = configSessionsMocks.readSessionUpdatedAt;
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
let threadBindingTesting: typeof import("./thread-bindings.js").testing;
let createThreadBindingManager: typeof import("./thread-bindings.js").createThreadBindingManager;
let processDiscordMessage: typeof import("./message-handler.process.js").processDiscordMessage;
let formatDiscordReplySkip: typeof import("./message-handler.process.js").formatDiscordReplySkip;
let notifyDiscordInboundEventOutboundSuccess: typeof import("../inbound-event-delivery.js").notifyDiscordInboundEventOutboundSuccess;

vi.mock("openclaw/plugin-sdk/reply-runtime", () => ({
  dispatchReplyWithBufferedBlockDispatcher: async (params: {
    dispatcherOptions: {
      beforeDeliver?: (
        payload: ReplyPayload,
        info: { kind: "block" | "final" },
      ) => Promise<ReplyPayload | null> | ReplyPayload | null;
      deliver: (payload: unknown, info: { kind: "block" | "final" }) => Promise<void> | void;
      onError?: (err: unknown, info: { kind: "block" | "final" }) => void;
      transformReplyPayload?: (payload: ReplyPayload) => ReplyPayload | null;
      typingCallbacks?: {
        onReplyStart?: () => Promise<void> | void;
        onIdle?: () => void;
        onCleanup?: () => void;
      };
      onReplyStart?: () => Promise<void> | void;
      onIdle?: () => void;
      onCleanup?: () => void;
      onSettled?: () => unknown;
      onFreshSettledDelivery?: () => unknown;
    };
    ctx?: Record<string, unknown>;
    replyOptions?: DispatchInboundParams["replyOptions"];
  }) => {
    const pendingDeliveries: Promise<void>[] = [];
    const deliver = async (payload: ReplyPayload, info: { kind: "block" | "final" }) => {
      const transformed = params.dispatcherOptions.transformReplyPayload
        ? params.dispatcherOptions.transformReplyPayload(payload)
        : payload;
      if (!transformed) {
        return;
      }
      const deliverPayload = params.dispatcherOptions.beforeDeliver
        ? await params.dispatcherOptions.beforeDeliver(transformed, info)
        : transformed;
      if (!deliverPayload) {
        return;
      }
      await params.dispatcherOptions.deliver(deliverPayload, info);
    };
    const queueDelivery = (payload: ReplyPayload, info: { kind: "block" | "final" }) => {
      const delivery = Promise.resolve(deliver(payload, info)).catch((err: unknown) => {
        params.dispatcherOptions.onError?.(err, info);
      });
      pendingDeliveries.push(delivery);
      return true;
    };
    const typingCallbacks = params.dispatcherOptions.typingCallbacks;
    const replyOptions = {
      ...params.replyOptions,
      onReplyStart: params.dispatcherOptions.onReplyStart ?? typingCallbacks?.onReplyStart,
      onTypingCleanup: params.dispatcherOptions.onCleanup ?? typingCallbacks?.onCleanup,
    };
    try {
      return await dispatchInboundMessage({
        ctx: params.ctx,
        replyOptions,
        dispatcher: {
          sendBlockReply: vi.fn((payload: ReplyPayload) =>
            queueDelivery(payload, { kind: "block" }),
          ),
          sendFinalReply: vi.fn((payload: ReplyPayload) =>
            queueDelivery(payload, { kind: "final" }),
          ),
          waitForIdle: vi.fn(async () => {
            await Promise.all(pendingDeliveries);
          }),
        },
      });
    } finally {
      await params.dispatcherOptions.onSettled?.();
      await params.dispatcherOptions.onFreshSettledDelivery?.();
      params.dispatcherOptions.onIdle?.();
      typingCallbacks?.onIdle?.();
    }
  },
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

vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>();
  const replyRuntime = await import("openclaw/plugin-sdk/reply-runtime");
  return {
    ...actual,
    dispatchChannelInboundTurn: async (
      plan: Parameters<typeof actual.dispatchChannelInboundTurn>[0],
    ) => {
      const { cfg, route, delivery, sessionInitRetry, ...prepared } = plan;
      const runDispatch = async () => {
        for (let retryIndex = 0; ; retryIndex += 1) {
          try {
            return await replyRuntime.dispatchReplyWithBufferedBlockDispatcher({
              ctx: plan.ctxPayload,
              cfg,
              dispatcherOptions: {
                ...plan.dispatcherOptions,
                deliver: delivery.deliver,
                onError: delivery.onError,
              },
              toolsAllow: plan.toolsAllow,
              replyOptions: plan.replyOptions,
              replyResolver: plan.replyResolver,
            });
          } catch (error) {
            const delayMs = sessionInitRetry?.delaysMs[retryIndex];
            const message = error instanceof Error ? error.message : String(error);
            if (
              delayMs === undefined ||
              sessionInitRetry?.signal?.aborted === true ||
              !/^reply session initialization conflicted for \S+$/u.test(message)
            ) {
              throw error;
            }
            await sessionInitRetry?.sleep?.(delayMs, sessionInitRetry.signal);
          }
        }
      };
      return await actual.runPreparedInboundReply({
        ...prepared,
        routeSessionKey: route.sessionKey,
        storePath: resolveStorePath(cfg.session?.store, { agentId: route.agentId }),
        recordInboundSession,
        runDispatch,
      });
    },
  };
});

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
  getSessionEntry: (params?: unknown) => configSessionsMocks.getSessionEntry(params),
  readSessionUpdatedAt: (params?: unknown) => configSessionsMocks.readSessionUpdatedAt(params),
  resolveStorePath: (path?: unknown, opts?: unknown) =>
    configSessionsMocks.resolveStorePath(path, opts),
}));

vi.mock("openclaw/plugin-sdk/session-transcript-runtime", () => ({
  readLatestAssistantTextByIdentity: (params?: unknown) =>
    configSessionsMocks.readLatestAssistantTextByIdentity(params),
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
  const ctx = await createBaseContext({ discordConfig: { streaming: { mode: "off" } } });
  await runProcessDiscordMessage(ctx);
}

beforeAll(async () => {
  vi.useRealTimers();
  ({ createBaseDiscordMessageContext, createDiscordDirectMessageContextOverrides } =
    await import("./message-handler.test-harness.js"));
  ({ testing: threadBindingTesting, createThreadBindingManager } =
    await import("./thread-bindings.js"));
  ({ processDiscordMessage, formatDiscordReplySkip } =
    await import("./message-handler.process.js"));
  ({ notifyDiscordInboundEventOutboundSuccess } = await import("../inbound-event-delivery.js"));
});

beforeEach(() => {
  vi.useRealTimers();
  sendMocks.reactMessageDiscord.mockClear();
  sendMocks.removeReactionDiscord.mockClear();
  typingMocks.sendTyping.mockClear();
  typingMocks.sendTyping.mockResolvedValue(undefined);
  discordTargetMocks.resolveDiscordTargetChannelId.mockClear();
  editMessageDiscord.mockClear();
  deliverDiscordReply.mockClear();
  createDiscordDraftStream.mockClear();
  dispatchInboundMessage.mockClear();
  recordInboundSession.mockClear();
  readSessionUpdatedAt.mockClear();
  getSessionEntry.mockClear();
  readLatestAssistantTextByIdentity.mockClear();
  resolveStorePath.mockClear();
  createDiscordRestClientSpy.mockClear();
  dispatchInboundMessage.mockResolvedValue(createNoQueuedDispatchResult());
  recordInboundSession.mockResolvedValue(undefined);
  readSessionUpdatedAt.mockReturnValue(undefined);
  getSessionEntry.mockReturnValue(undefined);
  readLatestAssistantTextByIdentity.mockResolvedValue(undefined);
  resolveStorePath.mockReturnValue("/tmp/openclaw-discord-process-test-sessions.json");
  threadBindingTesting.resetThreadBindingsForTests();
});

afterEach(() => {
  vi.useRealTimers();
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
      Body?: string;
      BodyForAgent?: string;
      ChatType?: string;
      CommandBody?: string;
      From?: string;
      GroupRequireMention?: boolean;
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
          Body?: string;
          BodyForAgent?: string;
          ChatType?: string;
          CommandBody?: string;
          From?: string;
          GroupRequireMention?: boolean;
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
    discordConfig: { streaming: { mode: "partial" } },
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

function getDeliveredFinalTexts(): string[] {
  return deliverDiscordReply.mock.calls.flatMap((call) => {
    const params = requireRecord(call[0], "deliverDiscordReply params");
    if (params.kind !== "final") {
      return [];
    }
    return ((params as { replies?: Array<{ text?: string }> }).replies ?? []).flatMap((reply) =>
      typeof reply.text === "string" ? [reply.text] : [],
    );
  });
}

function expectFinalWithProgressReceipt(answer: string, ...parts: string[]) {
  const text = getDeliveredFinalTexts()[0] ?? "";
  const receiptStart = text.lastIndexOf("\n-# ");
  expect(receiptStart).toBeGreaterThan(-1);
  expect(text.slice(0, receiptStart)).toBe(answer);
  const receipt = text.slice(receiptStart + 1);
  for (const part of parts) {
    expect(receipt).toContain(part);
  }
  expect(receipt).toContain("⏱️");
}

function expectFreshFinalText(text: string) {
  const finalParams = deliverDiscordReply.mock.calls
    .map((call) => requireRecord(call[0], "deliverDiscordReply params"))
    .find((params) => params.kind === "final");
  expect(finalParams).toBeDefined();
  const replies = (finalParams as { replies?: Array<{ text?: string }> }).replies;
  expect(replies?.[0]?.text).toBe(text);
}

describe("processDiscordMessage ack reactions", () => {
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

  it("starts typing only after reply dispatch is admitted", async () => {
    const admit = vi.fn();
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      admit();
      await params?.replyOptions?.onReplyStart?.();
      await params?.dispatcher.sendFinalReply({ text: "normal reply" });
      await params?.dispatcher.waitForIdle();
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });
    const ctx = await createAutomaticSourceDeliveryContext();

    await runProcessDiscordMessage(ctx);

    expect(typingMocks.sendTyping).toHaveBeenCalledTimes(1);
    expect(expectDefined(admit.mock.invocationCallOrder[0], "admission call order")).toBeLessThan(
      expectDefined(typingMocks.sendTyping.mock.invocationCallOrder[0], "typing call order"),
    );
    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
  });

  it("starts typing when an admitted fast reply bypasses resolver lifecycle", async () => {
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.dispatcher.sendFinalReply({ text: "fast reply" });
      await params?.dispatcher.waitForIdle();
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });
    const ctx = await createAutomaticSourceDeliveryContext();

    await runProcessDiscordMessage(ctx);

    expect(typingMocks.sendTyping).toHaveBeenCalledTimes(1);
    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
  });

  it("does not start typing for fast replies when typing mode is never", async () => {
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.dispatcher.sendFinalReply({ text: "fast reply" });
      await params?.dispatcher.waitForIdle();
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });
    const ctx = await createAutomaticSourceDeliveryContext({
      cfg: { session: { typingMode: "never" } },
    });

    await runProcessDiscordMessage(ctx);

    expect(typingMocks.sendTyping).not.toHaveBeenCalled();
    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
  });

  it("does not start typing for fast room-event replies", async () => {
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.dispatcher.sendFinalReply({ text: "room event reply" });
      await params?.dispatcher.waitForIdle();
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });
    const ctx = await createAutomaticSourceDeliveryContext({
      inboundEventKind: "room_event",
    });

    await runProcessDiscordMessage(ctx);

    expect(getLastDispatchReplyOptions()?.suppressTyping).toBe(true);
    expect(typingMocks.sendTyping).not.toHaveBeenCalled();
    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
  });

  it("forwards repeated resolver typing refresh callbacks", async () => {
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onReplyStart?.();
      await params?.replyOptions?.onReplyStart?.();
      await params?.dispatcher.sendFinalReply({ text: "long reply" });
      await params?.dispatcher.waitForIdle();
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });
    const ctx = await createAutomaticSourceDeliveryContext({
      cfg: { session: { typingMode: "message" } },
    });

    await runProcessDiscordMessage(ctx);

    expect(typingMocks.sendTyping).toHaveBeenCalledTimes(2);
    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
  });

  it("does not create visible typing feedback when reply dispatch stays silent", async () => {
    dispatchInboundMessage.mockResolvedValueOnce(createNoQueuedDispatchResult());
    const ctx = await createAutomaticSourceDeliveryContext();

    await runProcessDiscordMessage(ctx);

    expect(typingMocks.sendTyping).not.toHaveBeenCalled();
  });

  it("keeps one typing refresh loop for default message-tool replies", async () => {
    vi.useFakeTimers();
    try {
      dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
        await params?.replyOptions?.onReplyStart?.();
        await vi.advanceTimersByTimeAsync(3_500);
        return createNoQueuedDispatchResult();
      });
      const ctx = await createBaseContext({
        shouldRequireMention: false,
        effectiveWasMentioned: false,
        cfg: {
          messages: { groupChat: { visibleReplies: "message_tool" } },
          session: { store: "/tmp/openclaw-discord-process-test-sessions.json" },
        },
        route: BASE_CHANNEL_ROUTE,
      });

      await runProcessDiscordMessage(ctx);

      expect(getLastDispatchReplyOptions()?.typingKeepalive).toBe(false);
      expect(typingMocks.sendTyping).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
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
      await new Promise((resolve) => {
        setTimeout(resolve, 1_000);
      });
      await params?.replyOptions?.onCompactionEnd?.();
      await new Promise((resolve) => {
        setTimeout(resolve, 1_000);
      });
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

  it.each([
    {
      outcome: "done",
      timingKey: "doneHoldMs",
      configuredHoldMs: 2_000,
      terminalEmoji: DEFAULT_EMOJIS.done,
    },
    {
      outcome: "error",
      timingKey: "errorHoldMs",
      configuredHoldMs: 4_000,
      terminalEmoji: DEFAULT_EMOJIS.error,
    },
  ] as const)(
    "uses configured statusReactions.timing.$timingKey for $outcome cleanup",
    async ({ outcome, timingKey, configuredHoldMs, terminalEmoji }) => {
      vi.useFakeTimers();
      dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
        if (outcome === "done") {
          await params?.replyOptions?.onReasoningStream?.();
          return createNoQueuedDispatchResult();
        }
        return {
          queuedFinal: false,
          counts: { final: 0, tool: 0, block: 0 },
          failedCounts: { final: 1 },
        };
      });

      const ctx = await createAutomaticSourceDeliveryContext({
        cfg: {
          messages: {
            ackReaction: "👀",
            removeAckAfterReply: true,
            statusReactions: {
              timing: { [timingKey]: configuredHoldMs, debounceMs: 0 },
            },
          },
          session: { store: "/tmp/openclaw-discord-process-test-sessions.json" },
        },
      });

      await runProcessDiscordMessage(ctx);
      expect(getReactionEmojis()).toContain(terminalEmoji);

      await vi.advanceTimersByTimeAsync(configuredHoldMs - 1);
      expect(sendMocks.removeReactionDiscord).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        terminalEmoji,
        expect.anything(),
      );

      await vi.advanceTimersByTimeAsync(1);
      await vi.runAllTimersAsync();
      expect(sendMocks.removeReactionDiscord).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        terminalEmoji,
        expect.anything(),
      );
    },
  );
});

describe("processDiscordMessage session routing", () => {
  it("carries preflight audio transcript into dispatch context and marks media transcribed", async () => {
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
      preparedMedia: [
        {
          path: "/tmp/openclaw-discord-test/voice.ogg",
          contentType: "audio/ogg",
          placeholder: "<media:audio>",
        },
      ],
    });

    await runProcessDiscordMessage(ctx);

    expectRecordFields(requireRecord(getLastDispatchCtx(), "dispatch context"), {
      BodyForAgent: "hello from discord voice",
      CommandBody: "hello from discord voice",
      Transcript: "hello from discord voice",
      MediaTranscribedIndexes: [0],
    });
  });

  it("uses prepared media instead of re-downloading after the run queue", async () => {
    // Regression for #96165: Discord CDN attachment URLs expire, so process
    // must not re-fetch attachments preflight already downloaded at receipt
    // time. A throwing fetchImpl here proves no re-fetch happens.
    const fetchImpl = vi.fn(async () => {
      throw new Error("attachment should not be re-fetched after preflight downloaded it");
    });
    const ctx = await createBaseContext({
      message: {
        id: "m-preflight-media",
        channelId: "c1",
        content: "look",
        timestamp: new Date().toISOString(),
        attachments: [
          {
            id: "att-preflight-media",
            url: "https://cdn.discordapp.com/attachments/1/photo.png?ex=expired",
            content_type: "image/png",
            filename: "photo.png",
          },
        ],
      },
      baseText: "look",
      messageText: "look",
      preparedMedia: [
        {
          path: "/tmp/openclaw-discord-test/photo.png",
          contentType: "image/png",
          placeholder: "<media:image>",
        },
      ],
      discordRestFetch: fetchImpl,
    });

    await runProcessDiscordMessage(ctx);

    expect(fetchImpl).not.toHaveBeenCalled();
    expectRecordFields(requireRecord(getLastDispatchCtx(), "dispatch context"), {
      MediaPath: "/tmp/openclaw-discord-test/photo.png",
      MediaType: "image/png",
      MediaPaths: ["/tmp/openclaw-discord-test/photo.png"],
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

  it("does not inject the bot's previous message body when users reply to it", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("self-reply media should not be fetched");
    });
    const ctx = await createBaseContext({
      botUserId: "bot-1",
      cfg: {
        channels: { discord: { contextVisibility: "all" } },
        messages: { ackReaction: "👀" },
        session: { store: "/tmp/openclaw-discord-process-test-sessions.json" },
      },
      discordRestFetch: fetchImpl,
      message: {
        id: "m-self-reply",
        channelId: "c1",
        content: "<@bot> hit that again",
        timestamp: new Date().toISOString(),
        attachments: [],
        messageReference: {
          type: 0,
          message_id: "m-bot-previous",
          channel_id: "c1",
        },
        referencedMessage: {
          id: "m-bot-previous",
          channelId: "c1",
          content: "The same stale bot response keeps looping.",
          timestamp: new Date().toISOString(),
          attachments: [
            {
              id: "att-bot-previous",
              url: "https://cdn.discordapp.com/attachments/previous.png",
              content_type: "image/png",
              filename: "previous.png",
            },
          ],
          author: {
            id: "bot-1",
            username: "Spartacus",
            discriminator: "0",
            globalName: "Spartacus",
          },
        },
      },
      baseText: "<@bot> hit that again",
      messageText: "<@bot> hit that again",
    });

    await runProcessDiscordMessage(ctx);

    const dispatchCtx = requireRecord(getLastDispatchCtx(), "dispatch context");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(dispatchCtx.ReplyToId).toBe("m-bot-previous");
    expect(dispatchCtx.ReplyToSender).toBe("Spartacus");
    expect(dispatchCtx.ReplyToBody).toBeUndefined();
    expect(JSON.stringify(dispatchCtx)).not.toContain("The same stale bot response keeps looping.");
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

  it("marks explicit message-tool guild replies as message-tool-only and disables source streaming", async () => {
    const ctx = await createBaseContext({
      shouldRequireMention: false,
      effectiveWasMentioned: false,
      discordConfig: { streaming: { mode: "partial", block: { enabled: true } } },
      cfg: {
        messages: {
          groupChat: { visibleReplies: "message_tool" },
        },
        session: { store: "/tmp/openclaw-discord-process-test-sessions.json" },
      },
      route: BASE_CHANNEL_ROUTE,
    });

    await runProcessDiscordMessage(ctx);

    expectRecordFields(requireRecord(getLastDispatchReplyOptions(), "dispatch reply options"), {
      sourceReplyDeliveryMode: "message_tool_only",
      typingKeepalive: false,
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
          groupChat: { visibleReplies: "message_tool" },
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
      await new Promise((resolve) => {
        setTimeout(resolve, 1_000);
      });
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
          groupChat: { visibleReplies: "message_tool" },
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

  it("suppresses Discord reactions for room events when ack scope does not force all messages", async () => {
    vi.useFakeTimers();
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onReasoningStream?.();
      await new Promise((resolve) => {
        setTimeout(resolve, 1_000);
      });
      return createNoQueuedDispatchResult();
    });
    const ctx = await createBaseContext({
      shouldRequireMention: false,
      effectiveWasMentioned: false,
      inboundEventKind: "room_event",
      ackReactionScope: "group-all",
      cfg: {
        messages: {
          ackReaction: "👀",
          ackReactionScope: "group-all",
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

  it("sends Discord ack reactions for room events when ack scope is all", async () => {
    vi.useFakeTimers();
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onReasoningStream?.();
      await new Promise((resolve) => {
        setTimeout(resolve, 1_000);
      });
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
    expect(getReactionEmojis()).toEqual(["👀"]);
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
    expect(getLastDispatchCtx()?.GroupRequireMention).toBe(false);
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

  it("resolves guild source delivery from default, explicit, and room-event modes", async () => {
    await runProcessDiscordMessage(
      await createBaseContext({
        shouldRequireMention: true,
        effectiveWasMentioned: true,
        route: BASE_CHANNEL_ROUTE,
      }),
    );
    expect(getLastDispatchReplyOptions()?.sourceReplyDeliveryMode).toBe("automatic");

    dispatchInboundMessage.mockClear();
    await runProcessDiscordMessage(
      await createBaseContext({
        shouldRequireMention: true,
        effectiveWasMentioned: true,
        cfg: {
          messages: {
            groupChat: {
              visibleReplies: "message_tool",
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
      ThreadParentId: "parent-1",
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
      cfg: {
        channels: { discord: { contextVisibility: "allowlist" } },
      },
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
      ThreadLabel: "Discord thread #parent",
    });
    expect(getLastDispatchCtx()?.ThreadStarterBody).toBeUndefined();
  });
});

describe("processDiscordMessage draft streaming", () => {
  function useProgressDraftStartDelay() {
    vi.useFakeTimers();
    return async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    };
  }

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
    discordConfig: Record<string, unknown> = { streaming: { mode: "block" } },
  ) {
    return await createAutomaticSourceDeliveryContext({
      cfg: {
        messages: { ackReaction: "👀" },
        session: { store: "/tmp/openclaw-discord-process-test-sessions.json" },
        channels: {
          discord: {
            streaming: {
              preview: { chunk: { minChars: 1, maxChars: 5, breakPreference: "newline" } },
            },
          },
        },
      },
      discordConfig,
    });
  }

  it("sends a fresh final message when final fits one chunk", async () => {
    await runSingleChunkFinalScenario({ streaming: { mode: "partial" }, maxLinesPerMessage: 5 });
    expect(editMessageDiscord).not.toHaveBeenCalled();
    expectFreshFinalText("Hello\nWorld");
  });

  it("retries stale preview cleanup at teardown after fresh final delivery", async () => {
    const draftStream = createMockDraftStream();
    draftStream.clear.mockImplementationOnce(async () => {});
    createDiscordDraftStream.mockReturnValueOnce(draftStream);

    await runSingleChunkFinalScenario({
      streaming: { mode: "partial" },
      maxLinesPerMessage: 5,
    });

    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
    expect(draftStream.clear).toHaveBeenCalledTimes(2);
    expect(draftStream.messageId()).toBeUndefined();
  });

  it("delivers a fresh message instead of a preview edit when the final reply resolves a mention alias", async () => {
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.dispatcher.sendFinalReply({ text: "On it @Sentinel" });
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: { streaming: { mode: "partial" }, maxLinesPerMessage: 5 },
      cfg: {
        channels: { discord: { mentionAliases: { Sentinel: "1485891428809707651" } } },
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(editMessageDiscord).not.toHaveBeenCalled();
    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
  });

  it("delivers a fresh message instead of a preview edit for a literal user mention in the final reply", async () => {
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.dispatcher.sendFinalReply({ text: "On it <@1485891428809707651>" });
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: { streaming: { mode: "partial" }, maxLinesPerMessage: 5 },
    });

    await runProcessDiscordMessage(ctx);

    expect(editMessageDiscord).not.toHaveBeenCalled();
    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
  });

  it("sends a fresh final message when an unaliased handle stays plain text", async () => {
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.dispatcher.sendFinalReply({ text: "On it @Sentinel" });
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: { streaming: { mode: "partial" }, maxLinesPerMessage: 5 },
    });

    await runProcessDiscordMessage(ctx);

    expect(editMessageDiscord).not.toHaveBeenCalled();
    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
  });

  it("sends a fresh final message for broadcast mentions like @everyone", async () => {
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.dispatcher.sendFinalReply({ text: "heads up @everyone" });
      await params?.dispatcher.waitForIdle();
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: { streaming: { mode: "partial" }, maxLinesPerMessage: 5 },
    });

    await runProcessDiscordMessage(ctx);

    expect(editMessageDiscord).not.toHaveBeenCalled();
    expect(firstMockArg(deliverDiscordReply, "deliverDiscordReply")).toMatchObject({
      allowedMentions: { parse: ["users", "roles"] },
    });
  });

  it("sends a fresh final message when a targeted mention is mixed with @everyone", async () => {
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.dispatcher.sendFinalReply({ text: "heads up @Sentinel @everyone" });
      await params?.dispatcher.waitForIdle();
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: { streaming: { mode: "partial" }, maxLinesPerMessage: 5 },
      cfg: {
        channels: { discord: { mentionAliases: { Sentinel: "1485891428809707651" } } },
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(editMessageDiscord).not.toHaveBeenCalled();
    expect(firstMockArg(deliverDiscordReply, "deliverDiscordReply")).toMatchObject({
      allowedMentions: { parse: ["users", "roles"] },
    });
  });

  it("defaults unset Discord preview streaming to progress mode without drafting text-only turns", async () => {
    await runSingleChunkFinalScenario({ maxLinesPerMessage: 5 });
    expect(getLastDispatchReplyOptions()?.onPartialReply).toBeUndefined();
    expect(createDiscordDraftStream).toHaveBeenCalledTimes(1);
    expect(editMessageDiscord).not.toHaveBeenCalled();
    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
  });

  it("does not stream Discord tool progress before the initial delay", async () => {
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

    expect(draftStream.update).not.toHaveBeenCalled();
    expectFreshFinalText("done");
    expect(editMessageDiscord).not.toHaveBeenCalled();
    expect(draftStream.clear).toHaveBeenCalledTimes(1);
    expect(draftStream.deleteCurrentMessage).not.toHaveBeenCalled();
  });

  it("does not attach a progress receipt when final delivery starts before the delay", async () => {
    vi.useFakeTimers();
    const draftStream = createMockDraftStreamForTest();
    let notifyLookupStarted: (() => void) | undefined;
    let resolveTranscriptLookup: (() => void) | undefined;
    const lookupStarted = new Promise<void>((resolve) => {
      notifyLookupStarted = resolve;
    });
    const truncatedFinal =
      "Here is the complete Discord answer with enough stable prefix text before truncation...";

    getSessionEntry.mockReturnValue({ sessionId: "session-1" });
    readLatestAssistantTextByIdentity.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveTranscriptLookup = () => resolve(undefined);
          notifyLookupStarted?.();
        }),
    );
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await params?.replyOptions?.onItemEvent?.({ progressText: "exec done" });
      await params?.dispatcher.sendFinalReply({ text: truncatedFinal });
      await lookupStarted;
      await vi.advanceTimersByTimeAsync(5_000);
      resolveTranscriptLookup?.();
      await params?.dispatcher.waitForIdle();
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      baseSessionKey: BASE_CHANNEL_ROUTE.sessionKey,
      discordConfig: { maxLinesPerMessage: 5 },
      route: BASE_CHANNEL_ROUTE,
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.update).not.toHaveBeenCalled();
    expectFreshFinalText(truncatedFinal);
    expect(getDeliveredFinalTexts()[0]).not.toContain("\n-# ");
  });

  it("streams Discord tool progress when explicitly enabled", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await params?.replyOptions?.onItemEvent?.({ progressText: "exec done" });
      await elapseProgressDraftStartDelay();
      await params?.dispatcher.sendFinalReply({ text: "done" });
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: {
        maxLinesPerMessage: 5,
        streaming: {
          mode: "progress",
          progress: { label: "Working", toolProgress: true },
        },
      },
    });

    await runProcessDiscordMessage(ctx);

    const updates = draftStream.update.mock.calls.map((call) => call[0]);
    expect(updates).toEqual(["Working\n\n🛠️ Exec\n• exec done"]);
    expectFinalWithProgressReceipt("done", "🛠️ 1 tool call");
    // The working draft deletes once the receipt-bearing final landed.
    expect(editMessageDiscord).not.toHaveBeenCalled();
    expect(draftStream.clear).toHaveBeenCalledTimes(1);
    expect(draftStream.messageId()).toBeUndefined();
  });

  it("renders narration updates into the Discord progress draft", async () => {
    vi.useFakeTimers();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      expect(params?.replyOptions?.isProgressDraftVisible?.()).toBe(false);
      await params?.replyOptions?.onNarrationUpdate?.({
        text: "Reading the gateway config and restarting agents.",
      });
      expect(draftStream.update).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(params?.replyOptions?.isProgressDraftVisible?.()).toBe(true);
      await params?.dispatcher.sendFinalReply({ text: "done" });
      expect(params?.replyOptions?.isProgressDraftVisible?.()).toBe(false);
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: { maxLinesPerMessage: 5 },
    });

    await runProcessDiscordMessage(ctx);

    const updates = draftStream.update.mock.calls.map((call) => call[0]);
    expect(updates).toContain("Reading the gateway config and restarting agents.");
    expectFinalWithProgressReceipt("done", "🛠️ 1 tool call");
  });

  it("stops narration at final and resets it for a queued turn", async () => {
    createMockDraftStreamForTest();
    const beginTurn = vi.fn();
    const stopTurn = vi.fn();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      params?.replyOptions?.onProgressNarratorLifecycle?.({ beginTurn, stopTurn });
      await params?.dispatcher.sendFinalReply({ text: "primary" });
      expect(stopTurn).toHaveBeenCalled();

      await params?.replyOptions?.onAssistantMessageStart?.();
      expect(beginTurn).toHaveBeenCalledOnce();
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticSourceDeliveryContext();
    await runProcessDiscordMessage(ctx);
  });

  it("omits the narration callback when progress narration is disabled", async () => {
    createMockDraftStreamForTest();
    dispatchInboundMessage.mockImplementationOnce(async () => createNoQueuedDispatchResult());

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: {
        streaming: { mode: "progress", progress: { label: "Shelling", narration: false } },
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(getLastDispatchReplyOptions()?.onNarrationUpdate).toBeUndefined();
    expect(getLastDispatchReplyOptions()?.isProgressDraftVisible).toBeUndefined();
  });

  it("mirrors status-only command text into the narration input policy", async () => {
    createMockDraftStreamForTest();
    dispatchInboundMessage.mockImplementationOnce(async () => createNoQueuedDispatchResult());

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: {
        streaming: { mode: "progress", progress: { label: "Shelling", commandText: "status" } },
      },
    });

    await runProcessDiscordMessage(ctx);

    const replyOptions = getLastDispatchReplyOptions();
    expect(replyOptions?.onNarrationUpdate).toBeDefined();
    expect(replyOptions?.isProgressDraftVisible).toBeDefined();
    expect(replyOptions?.narrationHideCommandText).toBe(true);
  });

  it("declines failed item progress without updating the Discord draft", async () => {
    const draftStream = createMockDraftStreamForTest();
    let callbackResult: false | void = undefined;

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      callbackResult = await params?.replyOptions?.onItemEvent?.({
        itemId: "tool-1",
        kind: "tool",
        name: "exec",
        phase: "end",
        status: "failed",
        progressText: "exec failed",
      });
      return createNoQueuedDispatchResult();
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: { maxLinesPerMessage: 5 },
    });

    await runProcessDiscordMessage(ctx);

    expect(callbackResult).toBe(false);
    expect(draftStream.update).not.toHaveBeenCalled();
  });

  it("declines failed command output without updating the Discord draft", async () => {
    const draftStream = createMockDraftStreamForTest();
    let callbackResult: false | void = undefined;

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      callbackResult = await params?.replyOptions?.onCommandOutput?.({
        phase: "error",
        title: "Exec",
        name: "exec",
        status: "error",
        exitCode: 1,
      });
      return createNoQueuedDispatchResult();
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: { maxLinesPerMessage: 5 },
    });

    await runProcessDiscordMessage(ctx);

    expect(callbackResult).toBe(false);
    expect(draftStream.update).not.toHaveBeenCalled();
  });

  it("counts window thinking bursts closed by a tool call when no end event fires", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    // deepseek streams reasoning then a tool call with no thinking_end between
    // bursts; the tool-start boundary (and the summary flush) must still tally.
    createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onReasoningStream?.({ text: "Listing the workspace" });
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await params?.replyOptions?.onReasoningStream?.({ text: "Picking the largest" });
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await params?.replyOptions?.onReasoningStream?.({ text: "Composing the answer" });
      await elapseProgressDraftStartDelay();
      await params?.dispatcher.sendFinalReply({ text: "done" });
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: {
        streaming: { mode: "progress", progress: { label: "Shelling", thinking: true } },
      },
    });

    await runProcessDiscordMessage(ctx);

    // 2 bursts closed by tool calls + 1 trailing burst flushed at summary.
    expectFinalWithProgressReceipt("done", "🧠 3 thoughts", "🛠️ 2 tool calls");
  });

  it("counts window thinking bursts in the collapse summary", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onReasoningStream?.({ text: "Planning the survey" });
      await params?.replyOptions?.onReasoningEnd?.();
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await params?.replyOptions?.onReasoningStream?.({ text: "Reading results" });
      await params?.replyOptions?.onReasoningEnd?.();
      // A boundary without a preceding burst must not inflate the count.
      await params?.replyOptions?.onReasoningEnd?.();
      await elapseProgressDraftStartDelay();
      await params?.dispatcher.sendFinalReply({ text: "done" });
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: {
        streaming: { mode: "progress", progress: { label: "Shelling", thinking: true } },
      },
    });

    await runProcessDiscordMessage(ctx);

    expectFinalWithProgressReceipt("done", "🧠 2 thoughts", "🛠️ 1 tool call");
  });

  it("counts distinct narration notes in the collapse summary", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onItemEvent?.({
        kind: "preamble",
        itemId: "p1",
        progressText: "Listing the workspace",
      });
      // Re-fire of the same note (delta/snapshot) must not inflate the count.
      await params?.replyOptions?.onItemEvent?.({
        kind: "preamble",
        itemId: "p1",
        progressText: "Listing the workspace files",
      });
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await elapseProgressDraftStartDelay();
      await params?.replyOptions?.onItemEvent?.({
        kind: "preamble",
        itemId: "p2",
        progressText: "Composing the answer",
      });
      await params?.dispatcher.sendFinalReply({ text: "done" });
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: {
        streaming: { mode: "progress", progress: { label: "Shelling", commentary: true } },
      },
    });

    await runProcessDiscordMessage(ctx);

    expectFinalWithProgressReceipt("done", "💬 2 notes", "🛠️ 1 tool call");
  });

  it("does not update Discord progress drafts after final answer delivery", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await params?.replyOptions?.onItemEvent?.({ progressText: "exec running" });
      await elapseProgressDraftStartDelay();
      await params?.dispatcher.sendFinalReply({ text: "done" });
      await params?.dispatcher.waitForIdle();
      await params?.replyOptions?.onCommandOutput?.({
        phase: "end",
        title: "Exec",
        name: "exec",
        exitCode: 1,
      });
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: {
        maxLinesPerMessage: 5,
        streaming: { mode: "progress", progress: { label: "Shelling" } },
      },
    });

    await runProcessDiscordMessage(ctx);

    const updates = draftStream.update.mock.calls.map((call) => call[0]);
    expect(updates).toEqual(["Shelling\n\n🛠️ Exec\n• exec running"]);
    expectFinalWithProgressReceipt("done", "🛠️ 1 tool call");
  });

  it("does not update Discord progress drafts while final answer delivery is pending", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await params?.replyOptions?.onItemEvent?.({ progressText: "exec running" });
      await elapseProgressDraftStartDelay();
      void params?.dispatcher.sendFinalReply({ text: "done" });
      await params?.replyOptions?.onCommandOutput?.({
        phase: "end",
        title: "Exec",
        name: "exec",
        exitCode: 1,
      });
      await params?.dispatcher.waitForIdle();
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: {
        maxLinesPerMessage: 5,
        streaming: { mode: "progress", progress: { label: "Shelling" } },
      },
    });

    await runProcessDiscordMessage(ctx);

    const updates = draftStream.update.mock.calls.map((call) => call[0]);
    expect(updates).toEqual(["Shelling\n\n🛠️ Exec\n• exec running"]);
    expectFinalWithProgressReceipt("done", "🛠️ 1 tool call");
  });

  it("streams Discord tool progress for coding-profile message-tool-only guild replies", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      expect(params?.replyOptions?.sourceReplyDeliveryMode).toBe("message_tool_only");
      expect(params?.replyOptions?.allowProgressCallbacksWhenSourceDeliverySuppressed).toBe(true);
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await params?.replyOptions?.onItemEvent?.({ progressText: "exec done" });
      await elapseProgressDraftStartDelay();
      return createNoQueuedDispatchResult();
    });

    const ctx = await createBaseContext({
      cfg: {
        channels: {
          discord: {
            streaming: {
              mode: "progress",
              progress: { toolProgress: true },
            },
          },
        },
        tools: { profile: "coding" },
        messages: {
          groupChat: { visibleReplies: "message_tool" },
        },
        session: { store: "/tmp/openclaw-discord-process-test-sessions.json" },
      },
      route: BASE_CHANNEL_ROUTE,
    });

    await runProcessDiscordMessage(ctx);

    expect(getLastDispatchReplyOptions()?.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(draftStream.update).toHaveBeenCalledWith("Working\n\n🛠️ Exec\n• exec done");
    expect(deliverDiscordReply).not.toHaveBeenCalled();
  });

  it("keeps Discord preview streaming off when explicitly disabled", async () => {
    await runSingleChunkFinalScenario({ streaming: { mode: "off" }, maxLinesPerMessage: 5 });
    expect(createDiscordDraftStream).not.toHaveBeenCalled();
    expect(editMessageDiscord).not.toHaveBeenCalled();
    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
  });

  it("falls back to standard send when final needs multiple chunks", async () => {
    await runSingleChunkFinalScenario({ streaming: { mode: "partial" }, maxLinesPerMessage: 1 });

    expect(editMessageDiscord).not.toHaveBeenCalled();
    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
  });

  it("uses transcript-backed final text when progress final text is truncated", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();
    const prefix =
      "Here is the complete Discord answer with enough stable prefix text before truncation";
    const truncatedFinal = `${prefix}...`;
    const fullAnswer = `${prefix} ${Array.from(
      { length: 260 },
      (_value, index) => `continuation${index}`,
    ).join(" ")}`;

    getSessionEntry.mockReturnValue({ sessionId: "session-1" });
    readLatestAssistantTextByIdentity.mockResolvedValue({
      text: fullAnswer,
      timestamp: Date.now() + 60_000,
    });
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await params?.replyOptions?.onItemEvent?.({ progressText: "exec done" });
      await elapseProgressDraftStartDelay();
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
    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
    expectFinalWithProgressReceipt(fullAnswer, "🛠️ 1 tool call");
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
      discordConfig: { streaming: { mode: "partial" }, maxLinesPerMessage: 1 },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.update).toHaveBeenCalledWith("partial answer...");
    expect(editMessageDiscord).not.toHaveBeenCalled();
    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
    expect(draftStream.discardPending).toHaveBeenCalled();
    expect(draftStream.clear).toHaveBeenCalledTimes(1);
  });

  it("uses root discord maxLinesPerMessage for fresh final delivery when runtime config omits it", async () => {
    const longReply = Array.from({ length: 20 }, (_value, index) => `Line ${index + 1}`).join("\n");
    const draftStream = createMockDraftStreamForTest();
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
      discordConfig: { streaming: { mode: "partial" } },
    });

    await runProcessDiscordMessage(ctx);

    expect(editMessageDiscord).not.toHaveBeenCalled();
    expectFreshFinalText(longReply);
    expect(draftStream.discardPending).toHaveBeenCalledTimes(1);
    expect(draftStream.clear).toHaveBeenCalledTimes(1);
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
      discordConfig: { streaming: { mode: "partial" }, maxLinesPerMessage: 5 },
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
      discordConfig: { streaming: { mode: "partial" }, maxLinesPerMessage: 5 },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.flush).not.toHaveBeenCalled();
    expect(draftStream.discardPending).toHaveBeenCalledTimes(1);
    expect(draftStream.clear).toHaveBeenCalledTimes(1);
    expect(editMessageDiscord).not.toHaveBeenCalled();
    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
  });

  it("sends a fresh visible TTS supplement final and clears the preview", async () => {
    const draftStream = createMockDraftStreamForTest();
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.dispatcher.sendFinalReply({
        mediaUrl: "https://example.com/tts.mp3",
        audioAsVoice: true,
        spokenText: "Spoken answer",
        ttsSupplement: { spokenText: "Spoken answer" },
      } as never);
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: { streaming: { mode: "partial" }, maxLinesPerMessage: 5 },
      replyToMode: "first",
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.flush).not.toHaveBeenCalled();
    expect(draftStream.discardPending).toHaveBeenCalledTimes(1);
    expect(draftStream.clear).toHaveBeenCalledTimes(1);
    expect(editMessageDiscord).not.toHaveBeenCalled();
    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
    expect(firstMockArg(deliverDiscordReply, "deliverDiscordReply")).toMatchObject({
      replyToId: "m1",
      replies: [
        {
          text: "Spoken answer",
          mediaUrl: "https://example.com/tts.mp3",
          audioAsVoice: true,
          spokenText: "Spoken answer",
          ttsSupplement: { spokenText: "Spoken answer" },
        },
      ],
    });
  });

  it("sends fresh visible text for TTS supplement finals", async () => {
    const draftStream = createMockDraftStreamForTest();
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.dispatcher.sendFinalReply({
        mediaUrl: "https://example.com/tts.mp3",
        audioAsVoice: true,
        spokenText: "Spoken answer",
        ttsSupplement: { spokenText: "Spoken answer" },
      } as never);
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: { streaming: { mode: "partial" }, maxLinesPerMessage: 5 },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.flush).not.toHaveBeenCalled();
    expect(draftStream.discardPending).toHaveBeenCalled();
    expect(draftStream.clear).toHaveBeenCalled();
    expect(editMessageDiscord).not.toHaveBeenCalled();
    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
    expect(firstMockArg(deliverDiscordReply, "deliverDiscordReply")).toMatchObject({
      replies: [
        {
          text: "Spoken answer",
          mediaUrl: "https://example.com/tts.mp3",
          audioAsVoice: true,
          spokenText: "Spoken answer",
          ttsSupplement: { spokenText: "Spoken answer" },
        },
      ],
    });
  });

  it("keeps already-delivered TTS supplement fallback audio-only", async () => {
    editMessageDiscord.mockRejectedValueOnce(new Error("edit failed"));
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.dispatcher.sendFinalReply({
        mediaUrl: "https://example.com/tts.mp3",
        audioAsVoice: true,
        spokenText: "Spoken answer",
        ttsSupplement: {
          spokenText: "Spoken answer",
          visibleTextAlreadyDelivered: true,
        },
      } as never);
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: { streaming: { mode: "partial" }, maxLinesPerMessage: 5 },
    });

    await runProcessDiscordMessage(ctx);

    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
    expect(firstMockArg(deliverDiscordReply, "deliverDiscordReply")).toMatchObject({
      replies: [
        {
          mediaUrl: "https://example.com/tts.mp3",
          audioAsVoice: true,
          spokenText: "Spoken answer",
          ttsSupplement: {
            spokenText: "Spoken answer",
            visibleTextAlreadyDelivered: true,
          },
        },
      ],
    });
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
      discordConfig: { streaming: { mode: "partial" }, maxLinesPerMessage: 5 },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.flush).not.toHaveBeenCalled();
    expect(draftStream.discardPending).toHaveBeenCalledTimes(1);
    expect(draftStream.clear).toHaveBeenCalledTimes(1);
    expect(editMessageDiscord).not.toHaveBeenCalled();
    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
  });

  it("drops later tool warning finals after preview final replies", async () => {
    const draftStream = createMockDraftStreamForTest();
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.dispatcher.sendFinalReply({ text: "delivery survived" });
      await params?.dispatcher.waitForIdle();
      await params?.dispatcher.sendFinalReply(createNonTerminalToolWarningPayload());
      return { queuedFinal: true, counts: { final: 2, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: { streaming: { mode: "partial" }, maxLinesPerMessage: 5 },
    });

    await runProcessDiscordMessage(ctx);

    expect(editMessageDiscord).not.toHaveBeenCalled();
    expectFreshFinalText("delivery survived");
    expect(draftStream.discardPending).toHaveBeenCalledTimes(1);
    expect(draftStream.clear).toHaveBeenCalledTimes(1);
    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
  });

  it("drops earlier tool warning finals when recovered replies arrive", async () => {
    const draftStream = createMockDraftStreamForTest();
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.dispatcher.sendFinalReply(createNonTerminalToolWarningPayload());
      await params?.dispatcher.sendFinalReply({ text: "delivery recovered" });
      await params?.dispatcher.waitForIdle();
      return { queuedFinal: true, counts: { final: 2, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: { streaming: { mode: "partial" }, maxLinesPerMessage: 5 },
    });

    await runProcessDiscordMessage(ctx);

    expect(editMessageDiscord).not.toHaveBeenCalled();
    expectFreshFinalText("delivery recovered");
    expect(draftStream.discardPending).toHaveBeenCalledTimes(1);
    expect(draftStream.clear).toHaveBeenCalledTimes(1);
    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
  });

  it("suppresses pure tool warning finals when no recovered reply is available", async () => {
    const draftStream = createMockDraftStreamForTest();
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.dispatcher.sendFinalReply(createNonTerminalToolWarningPayload());
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: { streaming: { mode: "partial" }, maxLinesPerMessage: 5 },
    });

    await runProcessDiscordMessage(ctx);

    expect(editMessageDiscord).not.toHaveBeenCalled();
    expect(draftStream.clear).toHaveBeenCalledTimes(1);
    expect(deliverDiscordReply).not.toHaveBeenCalled();
  });

  it("suppresses tool warning finals when the recovered reply fails to send", async () => {
    deliverDiscordReply.mockRejectedValueOnce(new Error("send failed"));
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.dispatcher.sendFinalReply({ text: "delivery failed" });
      await params?.dispatcher.waitForIdle();
      await params?.dispatcher.sendFinalReply(createNonTerminalToolWarningPayload());
      return {
        queuedFinal: true,
        counts: { final: 2, tool: 0, block: 0 },
        failedCounts: { final: 1 },
      };
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: { streaming: { mode: "off" } },
    });

    await runProcessDiscordMessage(ctx);

    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
    expect(firstMockArg(deliverDiscordReply, "deliverDiscordReply")).toMatchObject({
      replies: [{ text: "delivery failed" }],
    });
  });

  it("suppresses mutating tool warning finals after successful-looking replies", async () => {
    const draftStream = createMockDraftStreamForTest();
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.dispatcher.sendFinalReply({ text: "Done." });
      await params?.dispatcher.sendFinalReply({
        text: "⚠️ 🛠️ `write file (agent)` failed",
        isError: true,
      } as never);
      return { queuedFinal: true, counts: { final: 2, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: { streaming: { mode: "partial" }, maxLinesPerMessage: 5 },
    });

    await runProcessDiscordMessage(ctx);

    expect(editMessageDiscord).not.toHaveBeenCalled();
    expectFreshFinalText("Done.");
    expect(draftStream.discardPending).toHaveBeenCalledTimes(1);
    expect(draftStream.clear).toHaveBeenCalledTimes(1);
    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
  });

  it("renders reasoning block payloads as a 🧠 blockquote", async () => {
    mockDispatchSingleBlockReply({ text: "thinking...", isReasoning: true });
    await processStreamOffDiscordMessage();

    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
    expect(firstMockArg(deliverDiscordReply, "deliverDiscordReply")).toMatchObject({
      replies: [{ text: "> 🧠 thinking..." }],
    });
  });

  it("renders reasoning-tagged final payloads as a 🧠 blockquote, never the final", async () => {
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.dispatcher.sendFinalReply({
        text: "Reasoning:\nthis renders as a quoted thinking message",
        isReasoning: true,
      });
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: { streaming: { mode: "off" } },
    });

    await runProcessDiscordMessage(ctx);

    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
    expect(firstMockArg(deliverDiscordReply, "deliverDiscordReply")).toMatchObject({
      replies: [{ text: "> 🧠 this renders as a quoted thinking message" }],
    });
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

  it("shows only the agent status in the default Discord progress draft", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onReplyStart?.();
      await params?.replyOptions?.onItemEvent?.({
        itemId: "preamble-1",
        kind: "preamble",
        progressText: "Claiming my square footage. Tastefully, but with claws.",
      });
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await params?.replyOptions?.onItemEvent?.({ progressText: "exec done" });
      await elapseProgressDraftStartDelay();
      return createNoQueuedDispatchResult();
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: {
        streaming: {
          mode: "progress",
        },
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.update).toHaveBeenCalledTimes(1);
    expect(draftStream.update).toHaveBeenCalledWith(
      "Claiming my square footage. Tastefully, but with claws.",
    );
    expect(String(draftStream.update.mock.calls[0]?.[0])).not.toMatch(/Working|Exec|\n\n/);
    expect(draftStream.flush).toHaveBeenCalledTimes(1);
    expect(
      requireRecord(firstDispatchParams().replyOptions, "dispatch reply options")
        .suppressDefaultToolProgressMessages,
    ).toBe(true);
  });

  it("renders a preamble headline without enabling commentary progress", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      expect(params?.replyOptions?.progressPreambleEnabled).toBe(true);
      await params?.replyOptions?.onItemEvent?.({
        itemId: "preamble-1",
        kind: "preamble",
        progressText: "Checking private context before replying.",
      });
      expect(draftStream.update).not.toHaveBeenCalled();
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await elapseProgressDraftStartDelay();
      await params?.dispatcher.sendFinalReply({ text: "done" });
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: {
        streaming: {
          mode: "progress",
          progress: { label: false, commentary: false },
        },
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.update).toHaveBeenLastCalledWith(
      "Checking private context before replying.",
    );
    expectFinalWithProgressReceipt("done", "🛠️ 1 tool call");
    expect(getDeliveredFinalTexts()[0]).not.toContain("💬");
  });

  it("renders plan updates as an immediate Discord checklist", async () => {
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onPlanUpdate?.({
        phase: "update",
        explanation: "Implementing the change.",
        steps: [
          { step: "Inspect", status: "completed" },
          { step: "Patch", status: "in_progress" },
          { step: "Test", status: "pending" },
        ],
      });
      return createNoQueuedDispatchResult();
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: {
        streaming: { mode: "progress", progress: { label: false } },
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.update).toHaveBeenCalledWith(
      "Implementing the change.\n\n✅ Inspect\n▸ Patch\n▢ Test",
    );
    expect(draftStream.flush).toHaveBeenCalledTimes(1);
  });

  it("keeps opt-in commentary receipts independent from hidden tool progress", async () => {
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await params?.replyOptions?.onItemEvent?.({
        itemId: "preamble-silent",
        kind: "preamble",
        progressText: "[[reply_to_current]] _NO_REPLY_ [[audio_as_voice]]",
      });
      await params?.replyOptions?.onItemEvent?.({
        itemId: "preamble-1",
        kind: "preamble",
        progressText: "Checking the current weather source before summarizing.",
      });
      await params?.replyOptions?.onItemEvent?.({
        itemId: "preamble-1",
        kind: "preamble",
        progressText: "Checking the current weather source before summarizing clearly.",
      });
      await params?.replyOptions?.onItemEvent?.({
        itemId: "preamble-2",
        kind: "preamble",
        progressText: "Checking route impacts.",
      });
      await params?.replyOptions?.onItemEvent?.({
        itemId: "tool-1",
        kind: "tool",
        name: "exec",
        progressText: "curl weather api",
      });
      await params?.dispatcher.sendFinalReply({ text: "done" });
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: {
        streaming: {
          mode: "progress",
          progress: {
            label: false,
            toolProgress: false,
            commentary: true,
          },
        },
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.update).toHaveBeenLastCalledWith(
      "💬 Checking the current weather source before summarizing clearly.\n💬 Checking route impacts.",
    );
    const updates = draftStream.update.mock.calls.map((call) => call[0]).join("\n");
    expect(updates).not.toContain("Exec");
    expect(updates).not.toContain("curl weather api");
    expectFinalWithProgressReceipt("done", "💬 2 notes", "🛠️ 1 tool call");
  });

  it.each([
    ["active", true],
    ["inactive", false],
  ])(
    "renders Discord commentary in the draft exactly when durable verbose progress is %s",
    async (_label, durableLaneActive) => {
      const draftStream = createMockDraftStreamForTest();

      dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
        params?.replyOptions?.onVerboseProgressVisibility?.(() => durableLaneActive);
        await params?.replyOptions?.onItemEvent?.({
          itemId: "preamble-1",
          kind: "preamble",
          progressText: "Checking the current weather source before summarizing.",
        });
        return createNoQueuedDispatchResult();
      });

      const ctx = await createAutomaticSourceDeliveryContext({
        discordConfig: {
          streaming: {
            mode: "progress",
            progress: {
              label: false,
              toolProgress: false,
              commentary: true,
            },
          },
        },
      });

      await runProcessDiscordMessage(ctx);

      const updates = draftStream.update.mock.calls.map((call) => call[0]).join("\n");
      if (durableLaneActive) {
        // The durable verbose lane owns commentary: the ephemeral draft must
        // not render it a second time.
        expect(updates).toBe("");
      } else {
        expect(updates).toContain("Checking the current weather source");
      }
    },
  );

  it.each([
    ["active", true],
    ["inactive", false],
  ])(
    "renders Discord tool lines in the draft exactly when durable verbose progress is %s",
    async (_label, durableLaneActive) => {
      const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
      const draftStream = createMockDraftStreamForTest();

      dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
        params?.replyOptions?.onVerboseProgressVisibility?.(() => durableLaneActive);
        await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        await params?.replyOptions?.onItemEvent?.({ progressText: "exec running" });
        await params?.replyOptions?.onCommandOutput?.({
          phase: "end",
          title: "Exec",
          name: "exec",
          exitCode: 0,
        });
        await elapseProgressDraftStartDelay();
        return createNoQueuedDispatchResult();
      });

      const ctx = await createAutomaticSourceDeliveryContext({
        discordConfig: {
          streaming: { mode: "progress", progress: { label: "Shelling" } },
        },
      });

      await runProcessDiscordMessage(ctx);

      const updates = draftStream.update.mock.calls.map((call) => call[0]).join("\n");
      if (durableLaneActive) {
        // The durable verbose lane persists tool summaries: the ephemeral
        // draft must not render the same tool activity a second time.
        expect(updates).toBe("");
      } else {
        expect(updates).toContain("Exec");
      }
    },
  );

  it("retracts a preamble headline by item identity", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onItemEvent?.({
        itemId: "preamble-1",
        kind: "preamble",
        progressText: "Temporary note.",
      });
      await params?.replyOptions?.onItemEvent?.({
        itemId: "preamble-1",
        kind: "preamble",
        progressText: "",
      });
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await elapseProgressDraftStartDelay();
      return createNoQueuedDispatchResult();
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: {
        streaming: {
          mode: "progress",
          progress: {
            label: false,
          },
        },
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.update).toHaveBeenLastCalledWith("🛠️ Exec");
    expect(draftStream.update.mock.calls.flat().join("\n")).not.toContain("Temporary note.");
    // Cleanup still removes the unfinished tool-progress draft at run end.
    expect(draftStream.clear).toHaveBeenCalledTimes(1);
  });

  it("does not update Discord commentary progress after final answer delivery starts", async () => {
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onItemEvent?.({
        itemId: "preamble-1",
        kind: "preamble",
        progressText: "Checking source data.",
      });
      void params?.dispatcher.sendFinalReply({ text: "done" });
      await params?.replyOptions?.onItemEvent?.({
        itemId: "preamble-2",
        kind: "preamble",
        progressText: "Late commentary should not edit the draft.",
      });
      await params?.dispatcher.waitForIdle();
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: {
        streaming: {
          mode: "progress",
          progress: {
            label: false,
            commentary: true,
          },
        },
      },
    });

    await runProcessDiscordMessage(ctx);

    const updates = draftStream.update.mock.calls.map((call) => call[0]);
    expect(updates).toEqual(["💬 Checking source data."]);
    expectFinalWithProgressReceipt("done");
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
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.dispatcher.sendBlockReply({ text: "on it" });
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await params?.replyOptions?.onItemEvent?.({ progressText: "exec done" });
      await elapseProgressDraftStartDelay();
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

    expect(draftStream.update).toHaveBeenCalledWith("Shelling\n\n🛠️ Exec\n• exec done");
    expectFinalWithProgressReceipt("done", "🛠️ 1 tool call");
  });

  it("drops later tool warning finals after progress preview final replies", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await params?.replyOptions?.onItemEvent?.({ progressText: "exec done" });
      await elapseProgressDraftStartDelay();
      await params?.dispatcher.sendFinalReply({ text: "delivery survived" });
      await params?.dispatcher.waitForIdle();
      await params?.dispatcher.sendFinalReply(createNonTerminalToolWarningPayload());
      return { queuedFinal: true, counts: { final: 2, tool: 0, block: 0 } };
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

    expect(draftStream.update).toHaveBeenCalledWith("Shelling\n\n🛠️ Exec\n• exec done");
    // The delivered final consumed the draft; the later tool warning must not
    // resurrect it or produce a second visible reply.
    expect(draftStream.clear).toHaveBeenCalledTimes(1);
    expect(draftStream.messageId()).toBeUndefined();
    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
    expectFinalWithProgressReceipt("delivery survived", "🛠️ 1 tool call");
  });

  it("consumes a progress draft once across repeated final payloads", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await params?.replyOptions?.onItemEvent?.({ progressText: "exec done" });
      await elapseProgressDraftStartDelay();
      await params?.dispatcher.sendFinalReply({ text: "first answer" });
      await params?.dispatcher.waitForIdle();
      await params?.dispatcher.sendFinalReply({ text: "second answer" });
      await params?.dispatcher.waitForIdle();
      return { queuedFinal: true, counts: { final: 2, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: {
        streaming: { mode: "progress", progress: { label: "Shelling" } },
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.clear).toHaveBeenCalledTimes(1);
    const finals = getDeliveredFinalTexts();
    expect(finals).toHaveLength(2);
    expect(finals[0]).toMatch(/^first answer\n-# .*🛠️ 1 tool call/);
    expect(finals[1]).toBe("second answer");
  });

  it("preserves the progress receipt when the first final delivery fails", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();
    deliverDiscordReply.mockRejectedValueOnce(new Error("Discord unavailable"));

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await params?.replyOptions?.onItemEvent?.({ progressText: "exec done" });
      await elapseProgressDraftStartDelay();
      await params?.dispatcher.sendFinalReply({ text: "first answer" });
      await params?.dispatcher.waitForIdle();
      await params?.dispatcher.sendFinalReply({ text: "retry answer" });
      await params?.dispatcher.waitForIdle();
      return {
        queuedFinal: true,
        counts: { final: 1, tool: 0, block: 0 },
        failedCounts: { final: 1 },
      };
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: {
        streaming: { mode: "progress", progress: { label: "Shelling" } },
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.clear).toHaveBeenCalledTimes(1);
    const attemptedFinals = getDeliveredFinalTexts();
    expect(attemptedFinals).toHaveLength(2);
    expect(attemptedFinals[0]).toMatch(/^first answer\n-# .*🛠️ 1 tool call/);
    expect(attemptedFinals[1]).toMatch(/^retry answer\n-# .*🛠️ 1 tool call/);
  });

  it("re-arms progress collapse for a queued assistant turn", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await params?.replyOptions?.onItemEvent?.({ progressText: "first tool done" });
      await elapseProgressDraftStartDelay();
      await params?.dispatcher.sendFinalReply({ text: "first answer" });
      await params?.dispatcher.waitForIdle();
      await params?.replyOptions?.onAssistantMessageStart?.();
      await params?.replyOptions?.onToolStart?.({ name: "read", phase: "start" });
      await params?.replyOptions?.onItemEvent?.({ progressText: "second tool done" });
      await elapseProgressDraftStartDelay();
      await params?.dispatcher.sendFinalReply({ text: "second answer" });
      await params?.dispatcher.waitForIdle();
      return { queuedFinal: true, counts: { final: 2, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: {
        streaming: { mode: "progress", progress: { label: "Shelling" } },
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.clear).toHaveBeenCalledTimes(2);
    expect(draftStream.forceNewMessage).toHaveBeenCalledTimes(1);
    const finals = getDeliveredFinalTexts();
    expect(finals).toHaveLength(2);
    expect(finals[0]).toMatch(/^first answer\n-# .*🛠️ 1 tool call/);
    expect(finals[1]).toMatch(/^second answer\n-# .*🛠️ 1 tool call/);
  });

  it("does not collapse a text-only queued assistant turn", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await params?.replyOptions?.onItemEvent?.({ progressText: "first tool done" });
      await elapseProgressDraftStartDelay();
      await params?.dispatcher.sendFinalReply({ text: "first answer" });
      await params?.dispatcher.waitForIdle();
      await params?.replyOptions?.onAssistantMessageStart?.();
      await params?.dispatcher.sendFinalReply({ text: "text-only answer" });
      await params?.dispatcher.waitForIdle();
      return { queuedFinal: true, counts: { final: 2, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: {
        streaming: { mode: "progress", progress: { label: "Shelling" } },
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.clear).toHaveBeenCalledTimes(1);
    expect(getDeliveredFinalTexts()).toEqual([
      expect.stringMatching(/^first answer\n-# /),
      "text-only answer",
    ]);
  });

  it("cleans up an unfinished queued progress turn", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await params?.replyOptions?.onItemEvent?.({ progressText: "first tool done" });
      await elapseProgressDraftStartDelay();
      await params?.dispatcher.sendFinalReply({ text: "first answer" });
      await params?.dispatcher.waitForIdle();
      await params?.replyOptions?.onAssistantMessageStart?.();
      await params?.replyOptions?.onToolStart?.({ name: "read", phase: "start" });
      await params?.replyOptions?.onItemEvent?.({ progressText: "queued work" });
      await elapseProgressDraftStartDelay();
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: {
        streaming: { mode: "progress", progress: { label: "Shelling" } },
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.forceNewMessage).toHaveBeenCalledTimes(1);
    expect(draftStream.clear).toHaveBeenCalledTimes(2);
    expect(draftStream.messageId()).toBeUndefined();
  });

  it("uses raw tool-progress detail in Discord progress drafts", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({
        name: "exec",
        phase: "start",
        args: { command: "pnpm test -- --watch=false" },
        detailMode: "raw",
      });
      await params?.replyOptions?.onItemEvent?.({ progressText: "done" });
      await elapseProgressDraftStartDelay();
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
      "Shelling\n\n🛠️ run tests, `pnpm test -- --watch=false`\n• done",
    );
  });

  it("can hide raw command progress text in Discord progress drafts by config", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({
        name: "exec",
        phase: "start",
        args: { command: "pnpm test -- --watch=false" },
        detailMode: "raw",
      });
      await params?.replyOptions?.onItemEvent?.({ progressText: "done" });
      await elapseProgressDraftStartDelay();
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

    expect(draftStream.update).toHaveBeenCalledWith("Shelling\n\n🛠️ Exec\n• done");
  });

  it("keeps Discord progress lines below the configured label", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({ name: "first", phase: "start" });
      await params?.replyOptions?.onToolStart?.({ name: "second", phase: "start" });
      await params?.replyOptions?.onToolStart?.({ name: "third", phase: "start" });
      await elapseProgressDraftStartDelay();
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

    expect(draftStream.update).toHaveBeenCalledWith("Clawing...\n\n🧩 First\n🧩 Second\n🧩 Third");
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
      "Clawing...\n\n🩹 1 modified; extensions/discord/src/monitor/message-handler.draft-preview.ts",
    );
    const updates = draftStream.update.mock.calls.map((call) => call[0]);
    expect(updates.join("\n")).not.toContain("Apply Patch");
  });

  it("shows reasoning text instead of a bare Reasoning progress line", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await params?.replyOptions?.onItemEvent?.({
        kind: "analysis",
        title: "Reasoning",
      });
      await params?.replyOptions?.onReasoningStream?.({ text: "Reading" });
      await params?.replyOptions?.onReasoningStream?.({ text: "Reading the event projector" });
      await elapseProgressDraftStartDelay();
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
      "Clawing...\n\n🛠️ Exec\n🧠 _Reading the event projector_",
    );
    const updates = draftStream.update.mock.calls.map((call) => call[0]);
    expect(updates.join("\n")).not.toContain("Reasoning");
    expect(updates.join("\n")).not.toContain("Thinking\n");
  });

  it("hides non-stream reasoning progress until Discord thinking progress is enabled", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await params?.replyOptions?.onReasoningStream?.({
        text: "Private planning",
        requiresReasoningProgressOptIn: true,
      });
      await params?.replyOptions?.onItemEvent?.({ progressText: "done" });
      await elapseProgressDraftStartDelay();
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

    expect(draftStream.update).toHaveBeenCalledWith("Clawing...\n\n🛠️ Exec\n• done");
    expect(draftStream.update.mock.calls.map((call) => call[0]).join("\n")).not.toContain(
      "Private planning",
    );
  });

  it("accumulates reasoning deltas in Discord progress drafts", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      for (const text of ["Considering", " plugin", " installation", "!"]) {
        await params?.replyOptions?.onReasoningStream?.({ text });
      }
      await elapseProgressDraftStartDelay();
      return createNoQueuedDispatchResult();
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: {
        streaming: {
          mode: "progress",
          progress: {
            label: "Clawing...",
            thinking: true,
          },
        },
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.update).toHaveBeenCalledWith(
      "Clawing...\n\n🛠️ Exec\n🧠 _Considering plugin installation!_",
    );
    const updates = draftStream.update.mock.calls.map((call) => call[0]);
    expect(updates.join("\n")).not.toContain("• _!_");
  });

  it("preserves raw reasoning content that starts with Thinking", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await params?.replyOptions?.onReasoningStream?.({ text: "Thinking" });
      await params?.replyOptions?.onReasoningStream?.({ text: " through the install plan" });
      await elapseProgressDraftStartDelay();
      return createNoQueuedDispatchResult();
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: {
        streaming: {
          mode: "progress",
          progress: {
            label: "Clawing...",
            thinking: true,
          },
        },
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.update).toHaveBeenCalledWith(
      "Clawing...\n\n🛠️ Exec\n🧠 _Thinking through the install plan_",
    );
  });

  it("preserves raw reasoning content that starts with Thinking colon", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await params?.replyOptions?.onReasoningStream?.({ text: "Thinking: compare install paths" });
      await elapseProgressDraftStartDelay();
      return createNoQueuedDispatchResult();
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: {
        streaming: {
          mode: "progress",
          progress: {
            label: "Clawing...",
            thinking: true,
          },
        },
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.update).toHaveBeenCalledWith(
      "Clawing...\n\n🛠️ Exec\n🧠 _Thinking: compare install paths_",
    );
  });

  it("preserves raw reasoning content that starts with Reasoning colon", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await params?.replyOptions?.onReasoningStream?.({ text: "Reasoning: compare install paths" });
      await elapseProgressDraftStartDelay();
      return createNoQueuedDispatchResult();
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: {
        streaming: {
          mode: "progress",
          progress: {
            label: "Clawing...",
            thinking: true,
          },
        },
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.update).toHaveBeenCalledWith(
      "Clawing...\n\n🛠️ Exec\n🧠 _Reasoning: compare install paths_",
    );
  });

  it("strips legacy Reasoning newline wrappers from progress snapshots", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await params?.replyOptions?.onReasoningStream?.({
        text: "Reasoning:\ncompare install paths",
      });
      await elapseProgressDraftStartDelay();
      return createNoQueuedDispatchResult();
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: {
        streaming: {
          mode: "progress",
          progress: {
            label: "Clawing...",
            thinking: true,
          },
        },
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.update).toHaveBeenCalledWith(
      "Clawing...\n\n🛠️ Exec\n🧠 _compare install paths_",
    );
  });

  it("strips legacy Thinking ellipsis display wrappers from progress snapshots", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await params?.replyOptions?.onReasoningStream?.({
        text: "Thinking...\n\n_compare install paths_",
      });
      await elapseProgressDraftStartDelay();
      return createNoQueuedDispatchResult();
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: {
        streaming: {
          mode: "progress",
          progress: {
            label: "Clawing...",
            thinking: true,
          },
        },
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.update).toHaveBeenCalledWith(
      "Clawing...\n\n🛠️ Exec\n🧠 _compare install paths_",
    );
  });

  it("preserves raw reasoning content that starts with a Thinking line", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await params?.replyOptions?.onReasoningStream?.({ text: "Thinking\nthrough the plan" });
      await elapseProgressDraftStartDelay();
      return createNoQueuedDispatchResult();
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: {
        streaming: {
          mode: "progress",
          progress: {
            label: "Clawing...",
            thinking: true,
          },
        },
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.update).toHaveBeenCalledWith(
      "Clawing...\n\n🛠️ Exec\n🧠 _Thinking through the plan_",
    );
  });

  it("appends raw reasoning chunks that start with Thinking", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await params?.replyOptions?.onReasoningStream?.({ text: "I was " });
      await params?.replyOptions?.onReasoningStream?.({ text: "Thinking about the plan" });
      await elapseProgressDraftStartDelay();
      return createNoQueuedDispatchResult();
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: {
        streaming: {
          mode: "progress",
          progress: {
            label: "Clawing...",
            thinking: true,
          },
        },
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.update).toHaveBeenCalledWith(
      "Clawing...\n\n🛠️ Exec\n🧠 _I was Thinking about the plan_",
    );
  });

  it("appends raw reasoning chunks that start with Thinking ellipsis", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await params?.replyOptions?.onReasoningStream?.({ text: "I was " });
      await params?.replyOptions?.onReasoningStream?.({ text: "Thinking... through the plan" });
      await elapseProgressDraftStartDelay();
      return createNoQueuedDispatchResult();
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: {
        streaming: {
          mode: "progress",
          progress: {
            label: "Clawing...",
            thinking: true,
          },
        },
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.update).toHaveBeenCalledWith(
      "Clawing...\n\n🛠️ Exec\n🧠 _I was Thinking... through the plan_",
    );
  });

  it("appends raw reasoning chunks that start with Reasoning colon", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await params?.replyOptions?.onReasoningStream?.({ text: "I was " });
      await params?.replyOptions?.onReasoningStream?.({ text: "Reasoning: through edge cases" });
      await elapseProgressDraftStartDelay();
      return createNoQueuedDispatchResult();
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: {
        streaming: {
          mode: "progress",
          progress: {
            label: "Clawing...",
            thinking: true,
          },
        },
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.update).toHaveBeenCalledWith(
      "Clawing...\n\n🛠️ Exec\n🧠 _I was Reasoning: through edge cases_",
    );
  });

  it("keeps reasoning italics balanced when progress lines truncate", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await params?.replyOptions?.onReasoningStream?.({
        text: "Thinking through a very detailed installation plan with many steps",
      });
      await elapseProgressDraftStartDelay();
      return createNoQueuedDispatchResult();
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: {
        streaming: {
          mode: "progress",
          progress: {
            label: "Clawing...",
            maxLineChars: 36,
            thinking: true,
          },
        },
      },
    });

    await runProcessDiscordMessage(ctx);

    const lastUpdate = draftStream.update.mock.calls.at(-1)?.[0];
    const reasoningLine = lastUpdate?.split("\n").at(-1);

    expect(reasoningLine).toMatch(/^🧠 _.*…_$/u);
    expect(reasoningLine?.match(/_/gu)).toHaveLength(2);
  });

  it("replaces reasoning snapshots instead of appending duplicates", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await params?.replyOptions?.onReasoningStream?.({
        text: "Checking ",
        isReasoningSnapshot: true,
      });
      await params?.replyOptions?.onReasoningStream?.({
        text: "Reading \n\nChecking ",
        isReasoningSnapshot: true,
      });
      await elapseProgressDraftStartDelay();
      return createNoQueuedDispatchResult();
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: {
        streaming: {
          mode: "progress",
          progress: {
            label: "Clawing...",
            thinking: true,
          },
        },
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.update.mock.calls.at(-1)?.[0]).toContain("_Reading Checking_");
    const updates = draftStream.update.mock.calls.map((call) => call[0]);
    expect(updates.join("\n")).not.toContain("_Checking Reading");
  });

  it("keeps Discord progress lines across assistant boundaries", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({ name: "first", phase: "start" });
      await params?.replyOptions?.onAssistantMessageStart?.();
      await params?.replyOptions?.onToolStart?.({ name: "second", phase: "start" });
      await elapseProgressDraftStartDelay();
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

    expect(draftStream.update).toHaveBeenCalledWith("Shelling\n\n🧩 First\n🧩 Second");
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
      discordConfig: { streaming: { mode: "partial" } },
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

describe("processDiscordMessage deliver-lambda abort logging", () => {
  it("emits logVerbose with formatDiscordReplySkip when deliver fires on a pre-aborted signal", async () => {
    // Capture logVerbose calls via the ESM namespace binding. We rely on the
    // same vi.spyOn pattern used in native-command.model-picker.test.ts so the
    // production module keeps its real logVerbose import while the test still
    // sees every invocation that the deliver lambda surfaces.
    const verboseSpy = vi.mocked(logVerbose).mockImplementation(() => {});

    const abortController = new AbortController();
    // Drive the dispatcher so deliver actually runs: abort the signal inside
    // the dispatch mock and then queue a single block reply via the captured
    // dispatcher. The mocked createReplyDispatcherWithTyping (see line ~229)
    // routes sendBlockReply straight into the deliver lambda, where the very
    // first gate is `if (isProcessAborted(abortSignal)) return;` — the line
    // the PR added the logVerbose call to.
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      abortController.abort();
      await params?.dispatcher.sendBlockReply({ text: "post-abort block payload" });
      return { queuedFinal: false, counts: { final: 0, tool: 0, block: 1 } };
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      abortSignal: abortController.signal,
      cfg: {
        messages: {
          ackReaction: "👀",
        },
        session: { store: "/tmp/openclaw-discord-process-test-sessions.json" },
      },
    });

    await runProcessDiscordMessage(ctx);

    // The base test harness routes through guild g1 / channel c1 (see
    // createBaseDiscordMessageContext) so the deliver lambda receives the
    // matching deliver target and session key from ctxPayload.SessionKey.
    const dispatchedSessionKey = getLastDispatchCtx()?.SessionKey;
    expect(dispatchedSessionKey).toBeTypeOf("string");
    const expectedLog = formatDiscordReplySkip({
      kind: "block",
      reason: "aborted before delivery",
      target: "channel:c1",
      sessionKey: dispatchedSessionKey,
    });
    const verboseCalls = verboseSpy.mock.calls.map((call) => call[0]);
    expect(verboseCalls).toContain(expectedLog);
    // Restore so other tests sharing this worker (isolate=false) keep the
    // real logVerbose binding.
    verboseSpy.mockRestore();
  });
});

describe("processDiscordMessage reply session init conflict retry", () => {
  const conflictError = () =>
    new Error("reply session initialization conflicted for agent:main:discord:channel:c1");

  it("retries only dispatch while recording, acknowledging, and adding history once", async () => {
    const sleepSpy = vi.mocked(sleepWithAbort).mockResolvedValue(undefined);
    dispatchInboundMessage
      .mockRejectedValueOnce(conflictError())
      .mockRejectedValueOnce(conflictError())
      .mockResolvedValueOnce(createNoQueuedDispatchResult());
    const guildHistories = new Map();
    const ctx = await createBaseContext({
      guildHistories,
      historyLimit: 10,
      shouldRequireMention: false,
      effectiveWasMentioned: false,
      inboundEventKind: "room_event",
      ackReactionScope: "all",
      cfg: {
        messages: {
          ackReaction: "👀",
          ackReactionScope: "all",
        },
      },
      baseSessionKey: BASE_CHANNEL_ROUTE.sessionKey,
      route: BASE_CHANNEL_ROUTE,
    });

    await runProcessDiscordMessage(ctx);

    expect(dispatchInboundMessage).toHaveBeenCalledTimes(3);
    expect(sleepSpy).toHaveBeenNthCalledWith(1, 250, undefined);
    expect(sleepSpy).toHaveBeenNthCalledWith(2, 1_000, undefined);
    expect(recordInboundSession).toHaveBeenCalledTimes(1);
    expect(getReactionEmojis()).toEqual(["👀"]);
    expect(guildHistories.get("c1")).toHaveLength(1);
    expect(guildHistories.get("c1")?.[0]).toMatchObject({
      body: "hi",
      messageId: "m1",
    });
    sleepSpy.mockRestore();
  });

  it("commits replay ownership after a visible terminal failure notice", async () => {
    const sleepSpy = vi.mocked(sleepWithAbort).mockResolvedValue(undefined);
    const originalError = conflictError();
    dispatchInboundMessage.mockRejectedValue(originalError);

    const ctx = await createBaseContext();
    await expect(runProcessDiscordMessage(ctx)).resolves.toBeUndefined();

    expect(dispatchInboundMessage).toHaveBeenCalledTimes(4);
    expect(recordInboundSession).toHaveBeenCalledTimes(1);
    expect(sleepSpy).toHaveBeenNthCalledWith(1, 250, undefined);
    expect(sleepSpy).toHaveBeenNthCalledWith(2, 1_000, undefined);
    expect(sleepSpy).toHaveBeenNthCalledWith(3, 2_500, undefined);
    expectFreshFinalText(
      "⚠️ Couldn't process this message because the session stayed busy. Please try again in a moment.",
    );
    sleepSpy.mockRestore();
  });

  it("keeps exhaustion retryable when the visible failure notice cannot land", async () => {
    const sleepSpy = vi.mocked(sleepWithAbort).mockResolvedValue(undefined);
    const originalError = conflictError();
    dispatchInboundMessage.mockRejectedValue(originalError);
    deliverDiscordReply.mockRejectedValueOnce(new Error("Discord unavailable"));

    const ctx = await createBaseContext();
    let thrown: unknown;
    try {
      await runProcessDiscordMessage(ctx);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).toMatchObject({ cause: expect.any(Error) });
    expect(dispatchInboundMessage).toHaveBeenCalledTimes(4);
    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
    sleepSpy.mockRestore();
  });

  it("rebuilds a released replay without duplicating its pending history", async () => {
    const sleepSpy = vi.mocked(sleepWithAbort).mockResolvedValue(undefined);
    dispatchInboundMessage.mockRejectedValue(conflictError());
    deliverDiscordReply.mockRejectedValueOnce(new Error("Discord unavailable"));
    const guildHistories = new Map();
    const createReplayContext = () =>
      createBaseContext({
        guildHistories,
        historyLimit: 10,
        inboundEventKind: "room_event",
      });

    await expect(runProcessDiscordMessage(await createReplayContext())).rejects.toBeInstanceOf(
      Error,
    );
    expect(guildHistories.get("c1")).toHaveLength(1);

    dispatchInboundMessage.mockResolvedValue(createNoQueuedDispatchResult());
    await runProcessDiscordMessage(await createReplayContext());

    expect(getLastDispatchCtx()?.Body).not.toContain("[Chat messages since your last reply");
    expect(guildHistories.get("c1")).toHaveLength(1);
    expect(guildHistories.get("c1")?.[0]?.messageId).toBe("m1");
    sleepSpy.mockRestore();
  });

  it("preserves unrelated dispatch errors", async () => {
    const originalError = new Error("some other dispatch error");
    dispatchInboundMessage.mockRejectedValueOnce(originalError);

    const ctx = await createBaseContext();
    await expect(runProcessDiscordMessage(ctx)).rejects.toBe(originalError);

    expect(dispatchInboundMessage).toHaveBeenCalledTimes(1);
  });

  it("treats an aborted conflict as cancellation", async () => {
    const abortController = new AbortController();
    dispatchInboundMessage.mockImplementationOnce(async () => {
      abortController.abort();
      throw conflictError();
    });

    const ctx = await createBaseContext({ abortSignal: abortController.signal });
    await expect(runProcessDiscordMessage(ctx)).resolves.toBeUndefined();

    expect(dispatchInboundMessage).toHaveBeenCalledTimes(1);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
