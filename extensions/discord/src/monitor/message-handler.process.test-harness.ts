// Discord tests cover message handler.process plugin behavior.
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-dispatch-runtime";
import { setReplyPayloadMetadata } from "openclaw/plugin-sdk/reply-payload-testing";
import { logVerbose, sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";
import { afterEach, beforeAll, beforeEach, vi } from "vitest";
import type { DiscordMessagePreflightContext } from "./message-handler.preflight.js";

vi.mock("openclaw/plugin-sdk/runtime-env", { spy: true });

export const logVerboseForTest = logVerbose;
export const sleepWithAbortForTest = sleepWithAbort;

const sendMocks = vi.hoisted(() => ({
  reactMessageDiscord: vi.fn<
    (channelId: string, messageId: string, emoji: string, opts?: unknown) => Promise<void>
  >(async () => {}),
  removeReactionDiscord: vi.fn<
    (channelId: string, messageId: string, emoji: string, opts?: unknown) => Promise<void>
  >(async () => {}),
}));
export function createMockDraftStream() {
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
export const editMessageDiscord = deliveryMocks.editMessageDiscord;
export const deliverDiscordReply = deliveryMocks.deliverDiscordReply;
export const createDiscordDraftStream = deliveryMocks.createDiscordDraftStream;

export function createNonTerminalToolWarningPayload(): ReplyPayload {
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

export type DispatchInboundParams = {
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
export const getSessionEntry = configSessionsMocks.getSessionEntry;
export const readLatestAssistantTextByIdentity =
  configSessionsMocks.readLatestAssistantTextByIdentity;
export const readSessionUpdatedAt = configSessionsMocks.readSessionUpdatedAt;
const resolveStorePath = configSessionsMocks.resolveStorePath;
const createDiscordRestClientSpy = vi.hoisted(() =>
  vi.fn<
    (params: unknown) => {
      token: string;
      rest: object;
      account: { accountId: string; config: object };
    }
  >(() => ({
    token: "",
    rest: {},
    account: { accountId: "default", config: {} },
  })),
);
export const sendMocksForTest = sendMocks;
export const typingMocksForTest = typingMocks;
export const discordTargetMocksForTest = discordTargetMocks;
export const dispatchInboundMessageForTest = dispatchInboundMessage;
export const recordInboundSessionForTest = recordInboundSession;
export const createDiscordRestClientSpyForTest = createDiscordRestClientSpy;
let createBaseDiscordMessageContext: typeof import("./message-handler.test-harness.js").createBaseDiscordMessageContext;
let createDiscordDirectMessageContextOverrides: typeof import("./message-handler.test-harness.js").createDiscordDirectMessageContextOverrides;
let threadBindingTesting: typeof import("./thread-bindings.js").testing;
export let createThreadBindingManager: typeof import("./thread-bindings.js").createThreadBindingManager;
let processDiscordMessage: typeof import("./message-handler.process.js").processDiscordMessage;
export let formatDiscordReplySkip: typeof import("./message-handler.process.js").formatDiscordReplySkip;
export let notifyDiscordInboundEventOutboundSuccess: typeof import("../inbound-event-delivery.js").notifyDiscordInboundEventOutboundSuccess;

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

export const BASE_CHANNEL_ROUTE = {
  agentId: "main",
  channel: "discord",
  accountId: "default",
  sessionKey: "agent:main:discord:channel:c1",
  mainSessionKey: "agent:main:main",
} as const;

export async function createBaseContext(
  ...args: Parameters<typeof createBaseDiscordMessageContext>
): Promise<Awaited<ReturnType<typeof createBaseDiscordMessageContext>>> {
  return await createBaseDiscordMessageContext(...args);
}

export async function createAutomaticSourceDeliveryContext(
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

export function createDirectMessageContextOverrides(
  ...args: Parameters<typeof createDiscordDirectMessageContextOverrides>
): ReturnType<typeof createDiscordDirectMessageContextOverrides> {
  return createDiscordDirectMessageContextOverrides(...args);
}

export function mockDispatchSingleBlockReply(payload: { text: string; isReasoning?: boolean }) {
  dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
    await params?.dispatcher.sendBlockReply(payload);
    return { queuedFinal: false, counts: { final: 0, tool: 0, block: 1 } };
  });
}

export function createNoQueuedDispatchResult() {
  return { queuedFinal: false, counts: { final: 0, tool: 0, block: 0 } };
}

export async function processStreamOffDiscordMessage() {
  const ctx = await createBaseContext({ discordConfig: { streaming: { mode: "off" } } });
  await runProcessDiscordMessage(ctx);
}

export function registerDiscordProcessTestLifecycle() {
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
}

export function getLastRouteUpdate():
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

export function getLastDispatchCtx():
  | {
      Body?: string;
      BodyForAgent?: string;
      ChatType?: string;
      CommandBody?: string;
      From?: string;
      GroupRequireMention?: boolean;
      media?: Array<{ transcribed?: boolean }>;
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
          media?: Array<{ transcribed?: boolean }>;
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

export function getLastDispatchReplyOptions(): DispatchInboundParams["replyOptions"] | undefined {
  const callArgs = dispatchInboundMessage.mock.calls[
    dispatchInboundMessage.mock.calls.length - 1
  ] as unknown[] | undefined;
  const params = callArgs?.[0] as DispatchInboundParams | undefined;
  return params?.replyOptions;
}

export async function runProcessDiscordMessage(ctx: DiscordMessagePreflightContext): Promise<void> {
  await processDiscordMessage(ctx);
}

export async function runInPartialStreamMode(): Promise<void> {
  const ctx = await createBaseContext({
    discordConfig: { streaming: { mode: "partial" } },
  });
  await runProcessDiscordMessage(ctx);
}
