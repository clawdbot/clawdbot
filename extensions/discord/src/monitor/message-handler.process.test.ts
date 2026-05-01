import { DEFAULT_EMOJIS } from "openclaw/plugin-sdk/channel-feedback";
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
    onReasoningStream?: () => Promise<void> | void;
    onReasoningEnd?: () => Promise<void> | void;
    onToolStart?: (payload: { name?: string }) => Promise<void> | void;
    onItemEvent?: (payload: {
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
    }) => Promise<void> | void;
    sourceReplyDeliveryMode?: "automatic" | "message_tool_only";
    disableBlockStreaming?: boolean;
    suppressDefaultToolProgressMessages?: boolean;
    onCompactionStart?: () => Promise<void> | void;
    onCompactionEnd?: () => Promise<void> | void;
    onPartialReply?: (payload: { text?: string }) => Promise<void> | void;
    onAssistantMessageStart?: () => Promise<void> | void;
  };
};
const dispatchInboundMessage = vi.hoisted(() =>
  vi.fn<
    (
      params?: DispatchInboundParams,
    ) => Promise<{ queuedFinal: boolean; counts: { final: number; tool: number; block: number } }>
  >(async (_params?: DispatchInboundParams) => ({
    queuedFinal: false,
    counts: { final: 0, tool: 0, block: 0 },
  })),
);
const recordInboundSession = vi.hoisted(() =>
  vi.fn<(params?: unknown) => Promise<void>>(async () => {}),
);
const configSessionsMocks = vi.hoisted(() => ({
  readSessionUpdatedAt: vi.fn<(params?: unknown) => number | undefined>(() => undefined),
  resolveStorePath: vi.fn<(path?: unknown, opts?: unknown) => string>(
    () => "/tmp/openclaw-discord-process-test-sessions.json",
  ),
}));
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
let threadBindingTesting: typeof import("./thread-bindings.js").__testing;
let createThreadBindingManager: typeof import("./thread-bindings.js").createThreadBindingManager;
let processDiscordMessage: typeof import("./message-handler.process.js").processDiscordMessage;

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
  }) => ({
    dispatcher: {
      sendToolResult: vi.fn(() => true),
      sendBlockReply: vi.fn((payload: unknown) => {
        void opts.deliver(payload, { kind: "block" });
        return true;
      }),
      sendFinalReply: vi.fn((payload: unknown) => {
        void opts.deliver(payload, { kind: "final" });
        return true;
      }),
      waitForIdle: vi.fn(async () => {}),
      getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
      markComplete: vi.fn(),
    },
    replyOptions: {},
    markDispatchIdle: vi.fn(),
    markRunComplete: vi.fn(),
  }),
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
  readSessionUpdatedAt: (...args: unknown[]) => configSessionsMocks.readSessionUpdatedAt(...args),
  resolveStorePath: (...args: unknown[]) => configSessionsMocks.resolveStorePath(...args),
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
});

beforeEach(() => {
  vi.useRealTimers();
  sendMocks.reactMessageDiscord.mockClear();
  sendMocks.removeReactionDiscord.mockClear();
  editMessageDiscord.mockClear();
  deliverDiscordReply.mockClear();
  createDiscordDraftStream.mockClear();
  dispatchInboundMessage.mockClear();
  recordInboundSession.mockClear();
  readSessionUpdatedAt.mockClear();
  resolveStorePath.mockClear();
  createDiscordRestClientSpy.mockClear();
  dispatchInboundMessage.mockResolvedValue(createNoQueuedDispatchResult());
  recordInboundSession.mockResolvedValue(undefined);
  readSessionUpdatedAt.mockReturnValue(undefined);
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
  const callArgs = recordInboundSession.mock.calls.at(-1) as unknown[] | undefined;
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
      CommandBody?: string;
      MediaTranscribedIndexes?: number[];
      MessageThreadId?: string | number;
      ModelParentSessionKey?: string;
      ParentSessionKey?: string;
      SessionKey?: string;
      Transcript?: string;
    }
  | undefined {
  const callArgs = dispatchInboundMessage.mock.calls.at(-1) as unknown[] | undefined;
  const params = callArgs?.[0] as
    | {
        ctx?: {
          BodyForAgent?: string;
          CommandBody?: string;
          MediaTranscribedIndexes?: number[];
          MessageThreadId?: string | number;
          ModelParentSessionKey?: string;
          ParentSessionKey?: string;
          SessionKey?: string;
          Transcript?: string;
        };
      }
    | undefined;
  return params?.ctx;
}

function getLastDispatchReplyOptions(): DispatchInboundParams["replyOptions"] | undefined {
  const callArgs = dispatchInboundMessage.mock.calls.at(-1) as unknown[] | undefined;
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

function expectAckReactionRuntimeOptions(params?: {
  accountId?: string;
  ackReaction?: string;
  removeAckAfterReply?: boolean;
}) {
  const messages: Record<string, unknown> = {};
  if (params?.ackReaction) {
    messages.ackReaction = params.ackReaction;
  }
  if (params?.removeAckAfterReply !== undefined) {
    messages.removeAckAfterReply = params.removeAckAfterReply;
  }
  return expect.objectContaining({
    rest: expect.anything(),
    ...(Object.keys(messages).length > 0
      ? { cfg: expect.objectContaining({ messages: expect.objectContaining(messages) }) }
      : {}),
    ...(params?.accountId ? { accountId: params.accountId } : {}),
  });
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
  expect(sendMocks.reactMessageDiscord).toHaveBeenNthCalledWith(
    index + 1,
    params?.channelId ?? "c1",
    params?.messageId ?? "m1",
    emoji,
    expectAckReactionRuntimeOptions(params),
  );
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
  expect(sendMocks.removeReactionDiscord).toHaveBeenNthCalledWith(
    index + 1,
    params?.channelId ?? "c1",
    params?.messageId ?? "m1",
    emoji,
    expectAckReactionRuntimeOptions(params),
  );
}

function createMockDraftStreamForTest() {
  const draftStream = createMockDraftStream();
  createDiscordDraftStream.mockReturnValueOnce(draftStream);
  return draftStream;
}

function expectSinglePreviewEdit() {
  expect(editMessageDiscord).toHaveBeenCalledWith(
    "c1",
    "preview-1",
    { content: "Hello\nWorld" },
    expect.objectContaining({ rest: expect.anything() }),
  );
  expect(deliverDiscordReply).not.toHaveBeenCalled();
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
    expect(sendMocks.reactMessageDiscord.mock.calls[0]?.[3]).toEqual(
      expect.objectContaining({ rest: feedbackRest }),
    );
    expect(deliverDiscordReply).toHaveBeenCalledWith(
      expect.objectContaining({ rest: deliveryRest }),
    );
    expect(feedbackRest).not.toBe(deliveryRest);
  });

  it("debounces intermediate phase reactions and jumps to done for short runs", async () => {
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onReasoningStream?.();
      await params?.replyOptions?.onToolStart?.({ name: "exec" });
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

  it("shows stall emojis for long no-progress runs", async () => {
    vi.useFakeTimers();
    let releaseDispatch!: () => void;
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

    expect(getLastDispatchCtx()).toMatchObject({
      BodyForAgent: "hello from discord voice",
      CommandBody: "hello from discord voice",
      Transcript: "hello from discord voice",
      MediaTranscribedIndexes: [0],
    });
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

    expect(getLastRouteUpdate()).toMatchObject({
      sessionKey: "agent:main:main",
      channel: "discord",
      to: "user:222",
      accountId: "default",
      mainDmOwnerPin: {
        ownerRecipient: "111",
        senderRecipient: "222",
      },
    });
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

    expect(getLastDispatchReplyOptions()).toMatchObject({
      sourceReplyDeliveryMode: "message_tool_only",
      disableBlockStreaming: true,
    });
    expect(createDiscordDraftStream).not.toHaveBeenCalled();
  });

  it("suppresses automatic status reactions for always-on guild replies", async () => {
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
    expect(sendMocks.reactMessageDiscord).not.toHaveBeenCalled();
    expect(sendMocks.removeReactionDiscord).not.toHaveBeenCalled();
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
        ...createDirectMessageContextOverrides(),
      }),
    );
    expect(getLastDispatchReplyOptions()?.sourceReplyDeliveryMode).toBe("automatic");
  });

  it("prefers bound session keys and sets MessageThreadId for bound thread messages", async () => {
    const threadBindings = createThreadBindingManager({
      cfg: {} as import("openclaw/plugin-sdk/config-types").OpenClawConfig,
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

    expect(getLastDispatchCtx()).toMatchObject({
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

    expect(getLastDispatchCtx()).toMatchObject({
      SessionKey: "agent:main:discord:channel:thread-1",
      MessageThreadId: "thread-1",
      ModelParentSessionKey: "agent:main:discord:channel:parent-1",
    });
    expect(getLastDispatchCtx()?.ParentSessionKey).toBeUndefined();
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

  async function createBlockModeContext() {
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
      discordConfig: { streamMode: "block" },
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

  it("keeps preview streaming off by default when streaming is unset", async () => {
    await runSingleChunkFinalScenario({ maxLinesPerMessage: 5 });
    expect(editMessageDiscord).not.toHaveBeenCalled();
    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
  });

  it("falls back to standard send when final needs multiple chunks", async () => {
    await runSingleChunkFinalScenario({ streamMode: "partial", maxLinesPerMessage: 1 });

    expect(editMessageDiscord).not.toHaveBeenCalled();
    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
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

    expect(editMessageDiscord).toHaveBeenCalledWith(
      "c1",
      "preview-1",
      { content: longReply },
      expect.objectContaining({ rest: expect.anything() }),
    );
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
