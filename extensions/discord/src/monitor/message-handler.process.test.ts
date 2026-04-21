import { DEFAULT_EMOJIS } from "openclaw/plugin-sdk/channel-feedback";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-dispatch-runtime";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const sendMocks = vi.hoisted(() => ({
  reactMessageDiscord: vi.fn<
    (channelId: string, messageId: string, emoji: string, opts?: unknown) => Promise<void>
  >(async () => {}),
  removeReactionDiscord: vi.fn<
    (channelId: string, messageId: string, emoji: string, opts?: unknown) => Promise<void>
  >(async () => {}),
}));
function createMockDraftStream() {
  return {
    update: vi.fn<(text: string) => void>(() => {}),
    flush: vi.fn(async () => {}),
    messageId: vi.fn(() => "preview-1"),
    clear: vi.fn(async () => {}),
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
  createDiscordDraftStream: vi.fn(() => createMockDraftStream()),
}));
const editMessageDiscord = deliveryMocks.editMessageDiscord;
const deliverDiscordReply = deliveryMocks.deliverDiscordReply;
const createDiscordDraftStream = deliveryMocks.createDiscordDraftStream;
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
let createBaseDiscordMessageContext: typeof import("./message-handler.test-harness.js").createBaseDiscordMessageContext;
let createDiscordDirectMessageContextOverrides: typeof import("./message-handler.test-harness.js").createDiscordDirectMessageContextOverrides;
let threadBindingTesting: typeof import("./thread-bindings.js").__testing;
let createThreadBindingManager: typeof import("./thread-bindings.js").createThreadBindingManager;
let processDiscordMessage: typeof import("./message-handler.process.js").processDiscordMessage;

const sendModule = await import("../send.js");
vi.spyOn(sendModule, "reactMessageDiscord").mockImplementation(
  async (channelId, messageId, emoji, opts) => {
    await sendMocks.reactMessageDiscord(channelId, messageId, emoji, opts);
    return { ok: true };
  },
);
vi.spyOn(sendModule, "removeReactionDiscord").mockImplementation(
  async (channelId, messageId, emoji, opts) => {
    await sendMocks.removeReactionDiscord(channelId, messageId, emoji, opts);
    return { ok: true };
  },
);

const sendMessagesModule = await import("../send.messages.js");
vi.spyOn(sendMessagesModule, "editMessageDiscord").mockImplementation(
  ((
    channelId: Parameters<typeof sendMessagesModule.editMessageDiscord>[0],
    messageId: Parameters<typeof sendMessagesModule.editMessageDiscord>[1],
    payload: Parameters<typeof sendMessagesModule.editMessageDiscord>[2],
    opts: Parameters<typeof sendMessagesModule.editMessageDiscord>[3],
  ) => deliveryMocks.editMessageDiscord(channelId, messageId, payload, opts) as never) as never,
);

const draftStreamModule = await import("../draft-stream.js");
vi.spyOn(draftStreamModule, "createDiscordDraftStream").mockImplementation(
  deliveryMocks.createDiscordDraftStream,
);

const replyDeliveryModule = await import("./reply-delivery.js");
vi.spyOn(replyDeliveryModule, "deliverDiscordReply").mockImplementation(
  ((params: Parameters<typeof replyDeliveryModule.deliverDiscordReply>[0]) =>
    deliveryMocks.deliverDiscordReply(params) as never) as never,
);

const replyRuntimeModule = await import("openclaw/plugin-sdk/reply-runtime");
vi.spyOn(replyRuntimeModule, "dispatchInboundMessage").mockImplementation(
  ((params: Parameters<typeof replyRuntimeModule.dispatchInboundMessage>[0]) =>
    dispatchInboundMessage(params as DispatchInboundParams) as never) as never,
);
vi.spyOn(replyRuntimeModule, "createReplyDispatcherWithTyping").mockImplementation(((opts: {
  deliver: (payload: unknown, info: { kind: string }) => Promise<void> | void;
}) => ({
  dispatcher: {
    sendToolResult: vi.fn(() => true),
    sendBlockReply: vi.fn((payload: unknown) => {
      void opts.deliver(payload as never, { kind: "block" });
      return true;
    }),
    sendFinalReply: vi.fn((payload: unknown) => {
      void opts.deliver(payload as never, { kind: "final" });
      return true;
    }),
    waitForIdle: vi.fn(async () => {}),
    getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
    markComplete: vi.fn(),
  },
  replyOptions: {},
  markDispatchIdle: vi.fn(),
  markRunComplete: vi.fn(),
})) as never);

const conversationRuntimeModule = await import("openclaw/plugin-sdk/conversation-runtime");
vi.spyOn(conversationRuntimeModule, "recordInboundSession").mockImplementation(
  ((params: Parameters<typeof conversationRuntimeModule.recordInboundSession>[0]) =>
    recordInboundSession(params) as never) as never,
);

const configRuntimeModule = await import("openclaw/plugin-sdk/config-runtime");
vi.spyOn(configRuntimeModule, "readSessionUpdatedAt").mockImplementation(
  ((params: Parameters<typeof configRuntimeModule.readSessionUpdatedAt>[0]) =>
    configSessionsMocks.readSessionUpdatedAt(params) as never) as never,
);
vi.spyOn(configRuntimeModule, "resolveStorePath").mockImplementation(
  ((
    path: Parameters<typeof configRuntimeModule.resolveStorePath>[0],
    opts: Parameters<typeof configRuntimeModule.resolveStorePath>[1],
  ) => configSessionsMocks.resolveStorePath(path, opts) as never) as never,
);

const clientModule = await import("../client.js");
const createDiscordRestClientSpy = vi.spyOn(clientModule, "createDiscordRestClient");

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
  await processDiscordMessage(ctx as any);
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
  | { sessionKey?: string; channel?: string; to?: string; accountId?: string }
  | undefined {
  const callArgs = recordInboundSession.mock.calls.at(-1) as unknown[] | undefined;
  const params = callArgs?.[0] as
    | {
        updateLastRoute?: {
          sessionKey?: string;
          channel?: string;
          to?: string;
          accountId?: string;
        };
      }
    | undefined;
  return params?.updateLastRoute;
}

function getLastDispatchCtx():
  | { SessionKey?: string; MessageThreadId?: string | number }
  | undefined {
  const callArgs = dispatchInboundMessage.mock.calls.at(-1) as unknown[] | undefined;
  const params = callArgs?.[0] as
    | { ctx?: { SessionKey?: string; MessageThreadId?: string | number } }
    | undefined;
  return params?.ctx;
}

async function runProcessDiscordMessage(ctx: unknown): Promise<void> {
  await processDiscordMessage(ctx as any);
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

    await processDiscordMessage(ctx as any);

    expect(sendMocks.reactMessageDiscord).not.toHaveBeenCalled();
  });

  it("sends ack reactions for mention-gated guild messages when mentioned", async () => {
    const ctx = await createBaseContext({
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

    await processDiscordMessage(ctx as any);

    expectReactAckCallAt(0, "👀", {
      accountId: "ops",
      ackReaction: "👀",
    });
  });

  it("uses preflight-resolved messageChannelId when message.channelId is missing", async () => {
    const ctx = await createBaseContext({
      message: {
        id: "m1",
        timestamp: new Date().toISOString(),
        attachments: [],
      },
      messageChannelId: "fallback-channel",
      shouldRequireMention: true,
      effectiveWasMentioned: true,
    });

    await processDiscordMessage(ctx as any);

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

    const ctx = await createBaseContext();

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

    const ctx = await createBaseContext();

    await processDiscordMessage(ctx as any);

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

    const ctx = await createBaseContext();
    const runPromise = processDiscordMessage(ctx as any);

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

    const ctx = await createBaseContext({
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

    await processDiscordMessage(ctx as any);

    const emojis = getReactionEmojis();
    expect(emojis).toContain("🟦");
    expect(emojis).toContain("🏁");
  });

  it("falls back to plain ack when status reactions are disabled", async () => {
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onReasoningStream?.();
      return createNoQueuedDispatchResult();
    });

    const ctx = await createBaseContext({
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

    const ctx = await createBaseContext({
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

    const runPromise = processDiscordMessage(ctx as any);
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

    const ctx = await createBaseContext({
      abortSignal: abortController.signal,
      cfg: {
        messages: {
          ackReaction: "👀",
          removeAckAfterReply: true,
        },
        session: { store: "/tmp/openclaw-discord-process-test-sessions.json" },
      },
    });

    await processDiscordMessage(ctx as any);

    expectRemoveAckCallAt(0, "👀", {
      accountId: "default",
      ackReaction: "👀",
      removeAckAfterReply: true,
    });
  });

  it("removes the plain ack reaction when status reactions are disabled and removeAckAfterReply is enabled", async () => {
    const ctx = await createBaseContext({
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

    await processDiscordMessage(ctx as any);

    expect(getLastRouteUpdate()).toEqual({
      sessionKey: "agent:main:discord:direct:u1",
      channel: "discord",
      to: "user:U1",
      accountId: "default",
    });
  });

  it("stores group lastRoute with channel target", async () => {
    const ctx = await createBaseContext({
      baseSessionKey: "agent:main:discord:channel:c1",
      route: BASE_CHANNEL_ROUTE,
    });

    await processDiscordMessage(ctx as any);

    expect(getLastRouteUpdate()).toEqual({
      sessionKey: "agent:main:discord:channel:c1",
      channel: "discord",
      to: "channel:c1",
      accountId: "default",
    });
  });

  it("prefers bound session keys and sets MessageThreadId for bound thread messages", async () => {
    const threadBindings = createThreadBindingManager({
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

    await processDiscordMessage(ctx as any);

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
});

describe("processDiscordMessage draft streaming", () => {
  async function runSingleChunkFinalScenario(discordConfig: Record<string, unknown>) {
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.dispatcher.sendFinalReply({ text: "Hello\nWorld" });
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    const ctx = await createBaseContext({
      discordConfig,
    });

    await processDiscordMessage(ctx as any);
  }

  async function createBlockModeContext() {
    return await createBaseContext({
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

    const ctx = await createBaseContext({
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

    await processDiscordMessage(ctx as any);

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

    const ctx = await createBaseContext({
      discordConfig: { streamMode: "partial", maxLinesPerMessage: 5 },
    });

    await processDiscordMessage(ctx as any);

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

    const ctx = await createBaseContext({ discordConfig: { streamMode: "off" } });

    await processDiscordMessage(ctx as any);

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

    await processDiscordMessage(ctx as any);

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

    const ctx = await createBaseContext({
      discordConfig: { streamMode: "partial" },
    });

    await processDiscordMessage(ctx as any);

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

    await processDiscordMessage(ctx as any);

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
