import { beforeEach, describe, expect, it, vi } from "vitest";

const createChannelReplyPipelineMock = vi.hoisted(() => vi.fn());
const createReplyDispatcherWithTypingMock = vi.hoisted(() => vi.fn());
const getMSTeamsRuntimeMock = vi.hoisted(() => vi.fn());
const enqueueSystemEventMock = vi.hoisted(() => vi.fn());
const renderReplyPayloadsToMessagesMock = vi.hoisted(() => vi.fn(() => []));
const sendMSTeamsMessagesMock = vi.hoisted(() => vi.fn(async () => []));
const streamInstances = vi.hoisted(
  () =>
    [] as Array<{
      hasContent: boolean;
      isFinalized: boolean;
      isFailed: boolean;
      streamedLength: number;
      sendInformativeUpdate: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      finalize: ReturnType<typeof vi.fn>;
    }>,
);

vi.mock("../runtime-api.js", () => ({
  createChannelReplyPipeline: createChannelReplyPipelineMock,
  logTypingFailure: vi.fn(),
  resolveChannelMediaMaxBytes: vi.fn(() => 8 * 1024 * 1024),
}));

vi.mock("./runtime.js", () => ({
  getMSTeamsRuntime: getMSTeamsRuntimeMock,
}));

vi.mock("./messenger.js", () => ({
  buildConversationReference: vi.fn((ref) => ref),
  renderReplyPayloadsToMessages: renderReplyPayloadsToMessagesMock,
  sendMSTeamsMessages: sendMSTeamsMessagesMock,
}));

vi.mock("./errors.js", () => ({
  classifyMSTeamsSendError: vi.fn(() => ({})),
  formatMSTeamsSendErrorHint: vi.fn(() => undefined),
  formatUnknownError: vi.fn((err) => String(err)),
}));

vi.mock("./revoked-context.js", () => ({
  withRevokedProxyFallback: async ({ run }: { run: () => Promise<unknown> }) => await run(),
}));

vi.mock("./streaming-message.js", () => ({
  TeamsHttpStream: class {
    hasContent = false;
    isFinalized = false;
    isFailed = false;
    streamedLength = 0;
    sendInformativeUpdate = vi.fn(async () => {});
    update = vi.fn();
    finalize = vi.fn(async function (this: { isFinalized: boolean }) {
      this.isFinalized = true;
    });

    constructor() {
      streamInstances.push(this);
    }
  },
}));

import { createMSTeamsReplyDispatcher, pickInformativeStatusText } from "./reply-dispatcher.js";

describe("createMSTeamsReplyDispatcher", () => {
  let typingCallbacks: {
    onReplyStart: ReturnType<typeof vi.fn>;
    onIdle: ReturnType<typeof vi.fn>;
    onCleanup: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    streamInstances.length = 0;

    typingCallbacks = {
      onReplyStart: vi.fn(async () => {}),
      onIdle: vi.fn(),
      onCleanup: vi.fn(),
    };

    createChannelReplyPipelineMock.mockReturnValue({
      onModelSelected: vi.fn(),
      typingCallbacks,
    });

    createReplyDispatcherWithTypingMock.mockImplementation((options) => ({
      dispatcher: {},
      replyOptions: {},
      markDispatchIdle: vi.fn(),
      _options: options,
    }));

    getMSTeamsRuntimeMock.mockReturnValue({
      system: {
        enqueueSystemEvent: enqueueSystemEventMock,
      },
      channel: {
        text: {
          resolveChunkMode: vi.fn(() => "length"),
          resolveMarkdownTableMode: vi.fn(() => "code"),
        },
        reply: {
          createReplyDispatcherWithTyping: createReplyDispatcherWithTypingMock,
          resolveHumanDelayConfig: vi.fn(() => undefined),
        },
      },
    });
  });

  let lastCreatedDispatcher: ReturnType<typeof createMSTeamsReplyDispatcher> | undefined;
  let lastContextSendActivity: ReturnType<typeof vi.fn> | undefined;

  function createDispatcher(
    conversationType: string = "personal",
    msteamsConfig: Record<string, unknown> = {},
    extraParams: { onSentMessageIds?: (ids: string[]) => void } = {},
  ) {
    const contextSendActivity = vi.fn(async () => ({ id: "activity-1" }));
    lastContextSendActivity = contextSendActivity;
    const dispatcher = createMSTeamsReplyDispatcher({
      cfg: { channels: { msteams: msteamsConfig } } as never,
      agentId: "agent",
      sessionKey: "agent:main:main",
      runtime: { error: vi.fn() } as never,
      log: { debug: vi.fn(), error: vi.fn(), warn: vi.fn() } as never,
      adapter: {
        continueConversation: vi.fn(),
        process: vi.fn(),
        updateActivity: vi.fn(),
        deleteActivity: vi.fn(),
      } as never,
      appId: "app",
      conversationRef: {
        conversation: { id: "conv", conversationType },
        user: { id: "user" },
        agent: { id: "bot" },
        channelId: "msteams",
        serviceUrl: "https://service.example.com",
      } as never,
      context: {
        sendActivity: contextSendActivity,
      } as never,
      replyStyle: "thread",
      textLimit: 4000,
      ...extraParams,
    });
    lastCreatedDispatcher = dispatcher;
    return dispatcher;
  }

  function getContextSendActivity(): ReturnType<typeof vi.fn> {
    if (!lastContextSendActivity) {
      throw new Error("createDispatcher must be called first");
    }
    return lastContextSendActivity;
  }

  async function triggerPartialReply(text: string): Promise<void> {
    if (!lastCreatedDispatcher) {
      throw new Error("createDispatcher must be called first");
    }
    lastCreatedDispatcher.replyOptions.onPartialReply?.({ text });
  }

  it("sends an informative status update on reply start for personal chats", async () => {
    createDispatcher("personal");
    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];

    await options.onReplyStart?.();

    expect(streamInstances).toHaveLength(1);
    expect(streamInstances[0]?.sendInformativeUpdate).toHaveBeenCalledTimes(1);
  });

  it("starts the typing keepalive in personal chats so the TurnContext survives long tool chains", async () => {
    createDispatcher("personal");
    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];

    await options.onReplyStart?.();

    // In addition to the streaming card's informative update, the typing
    // keepalive is now started on personal chats so Bot Framework proxies
    // stay alive during long tool chains (#59731).
    expect(typingCallbacks.onReplyStart).toHaveBeenCalledTimes(1);
  });

  it("skips the typing keepalive in personal chats when typingIndicator=false", async () => {
    createDispatcher("personal", { typingIndicator: false });
    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];

    await options.onReplyStart?.();

    // Even though we still send the informative update, the opt-out
    // disables the typing keepalive.
    expect(streamInstances[0]?.sendInformativeUpdate).toHaveBeenCalledTimes(1);
    expect(typingCallbacks.onReplyStart).not.toHaveBeenCalled();
  });

  it("passes a longer keepalive TTL so the loop survives long tool chains", () => {
    createDispatcher("personal");

    const pipelineArgs = createChannelReplyPipelineMock.mock.calls[0]?.[0];
    expect(pipelineArgs?.typing?.keepaliveIntervalMs).toBeGreaterThan(3_000);
    expect(pipelineArgs?.typing?.keepaliveIntervalMs).toBeLessThanOrEqual(10_000);
    // Issue #59731 reports 60s+ tool chains — the default 60s TTL is too
    // tight so the dispatcher passes its own generous ceiling.
    expect(pipelineArgs?.typing?.maxDurationMs).toBeGreaterThanOrEqual(300_000);
  });

  it("allows typing keepalive sends before any stream tokens arrive", async () => {
    createDispatcher("personal");
    const pipelineArgs = createChannelReplyPipelineMock.mock.calls[0]?.[0];
    const sendTyping = pipelineArgs?.typing?.start as () => Promise<void>;

    // No onPartialReply has been called yet, so the stream is not active.
    // The typing keepalive should be allowed to warm the TurnContext.
    const contextSendActivity = getContextSendActivity();
    contextSendActivity.mockClear();
    await sendTyping();
    expect(contextSendActivity).toHaveBeenCalledWith({ type: "typing" });
  });

  it("suppresses typing keepalive sends while the stream card is actively chunking", async () => {
    createDispatcher("personal");
    const pipelineArgs = createChannelReplyPipelineMock.mock.calls[0]?.[0];
    const sendTyping = pipelineArgs?.typing?.start as () => Promise<void>;

    // Simulate the stream actively receiving a partial chunk. While the
    // stream card is live we do not want a plain "..." typing indicator
    // layered on top of it.
    await triggerPartialReply("streaming content");

    const contextSendActivity = getContextSendActivity();
    contextSendActivity.mockClear();
    await sendTyping();
    expect(contextSendActivity).not.toHaveBeenCalled();
  });

  it("resumes typing keepalive sends once the stream finalizes between tool rounds", async () => {
    createDispatcher("personal");
    const pipelineArgs = createChannelReplyPipelineMock.mock.calls[0]?.[0];
    const sendTyping = pipelineArgs?.typing?.start as () => Promise<void>;

    // First segment: tokens flow, stream is active, typing is gated off.
    await triggerPartialReply("first segment tokens");
    const stream = streamInstances[0];
    if (!stream) {
      throw new Error("expected a Teams stream instance to be created");
    }
    const contextSendActivity = getContextSendActivity();
    contextSendActivity.mockClear();
    await sendTyping();
    expect(contextSendActivity).not.toHaveBeenCalled();

    // First segment complete: the stream is finalized ahead of the tool
    // chain. Mirror what preparePayload does by flipping the mocked stream's
    // finalized flag. The controller's isStreamActive check reads this via
    // the real stream controller wired into the dispatcher.
    stream.isFinalized = true;

    // During the tool chain the loop should be allowed to fire again so
    // the Bot Framework proxy stays warm. See #59731.
    contextSendActivity.mockClear();
    await sendTyping();
    expect(contextSendActivity).toHaveBeenCalledWith({ type: "typing" });
  });

  it("fires native typing in group chats (no stream) because the gate never applies", async () => {
    createDispatcher("groupchat");
    const pipelineArgs = createChannelReplyPipelineMock.mock.calls[0]?.[0];
    const sendTyping = pipelineArgs?.typing?.start as () => Promise<void>;

    // In group chats we don't create a stream, so isStreamActive() always
    // returns false and the typing indicator still fires normally.
    const contextSendActivity = getContextSendActivity();
    contextSendActivity.mockClear();
    await sendTyping();
    expect(contextSendActivity).toHaveBeenCalledWith({ type: "typing" });
  });

  it("is a no-op for channel conversations (typing unsupported)", async () => {
    createDispatcher("channel");
    const pipelineArgs = createChannelReplyPipelineMock.mock.calls[0]?.[0];
    const sendTyping = pipelineArgs?.typing?.start as () => Promise<void>;

    const contextSendActivity = getContextSendActivity();
    contextSendActivity.mockClear();
    await sendTyping();
    // Teams channel conversations do not support the typing activity at
    // all, so the start callback is a no-op regardless of stream state.
    expect(contextSendActivity).not.toHaveBeenCalled();
  });

  it("sends native typing indicator for channel conversations by default", async () => {
    createDispatcher("channel");
    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];

    await options.onReplyStart?.();

    expect(streamInstances).toHaveLength(0);
    expect(typingCallbacks.onReplyStart).toHaveBeenCalledTimes(1);
  });

  it("skips native typing indicator when typingIndicator=false", async () => {
    createDispatcher("channel", { typingIndicator: false });
    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];

    await options.onReplyStart?.();

    expect(typingCallbacks.onReplyStart).not.toHaveBeenCalled();
  });

  it("only sends the informative status update once", async () => {
    createDispatcher("personal");
    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];

    await options.onReplyStart?.();
    await options.onReplyStart?.();

    expect(streamInstances[0]?.sendInformativeUpdate).toHaveBeenCalledTimes(1);
  });

  it("forwards partial replies into the Teams stream", async () => {
    const dispatcher = createDispatcher("personal");

    dispatcher.replyOptions.onPartialReply?.({ text: "partial response" });

    expect(streamInstances[0]?.update).toHaveBeenCalledWith("partial response");
  });

  it("does not create a stream for channel conversations", async () => {
    createDispatcher("channel");

    expect(streamInstances).toHaveLength(0);
  });

  it("sets disableBlockStreaming=false when blockStreaming=true", () => {
    const dispatcher = createDispatcher("personal", { blockStreaming: true });

    expect(dispatcher.replyOptions.disableBlockStreaming).toBe(false);
  });

  it("sets disableBlockStreaming=true when blockStreaming=false", () => {
    const dispatcher = createDispatcher("personal", { blockStreaming: false });

    expect(dispatcher.replyOptions.disableBlockStreaming).toBe(true);
  });

  it("leaves disableBlockStreaming undefined when blockStreaming is not set", () => {
    const dispatcher = createDispatcher("personal", {});

    expect(dispatcher.replyOptions.disableBlockStreaming).toBeUndefined();
  });

  it("flushes messages immediately on deliver when blockStreaming is enabled", async () => {
    renderReplyPayloadsToMessagesMock.mockReturnValue([{ content: "hello" }] as never);
    sendMSTeamsMessagesMock.mockResolvedValue(["id-1"] as never);

    createDispatcher("personal", { blockStreaming: true });
    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];

    // Call deliver — with blockStreaming enabled it should flush immediately
    await options.deliver({ text: "block content" });

    expect(sendMSTeamsMessagesMock).toHaveBeenCalledTimes(1);
  });

  it("does not flush messages on deliver when blockStreaming is disabled", async () => {
    renderReplyPayloadsToMessagesMock.mockReturnValue([{ content: "hello" }] as never);

    createDispatcher("personal", { blockStreaming: false });
    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];

    await options.deliver({ text: "block content" });

    expect(sendMSTeamsMessagesMock).not.toHaveBeenCalled();
  });

  it("queues a system event when some queued Teams messages fail to send", async () => {
    const onSentMessageIds = vi.fn();
    renderReplyPayloadsToMessagesMock.mockReturnValue([
      { content: "one" },
      { content: "two" },
    ] as never);
    sendMSTeamsMessagesMock
      .mockRejectedValueOnce(Object.assign(new Error("gateway timeout"), { statusCode: 502 }))
      .mockResolvedValueOnce(["id-1"] as never)
      .mockRejectedValueOnce(Object.assign(new Error("gateway timeout"), { statusCode: 502 }));

    const dispatcher = createDispatcher(
      "personal",
      { blockStreaming: false },
      { onSentMessageIds },
    );
    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];

    await options.deliver({ text: "block content" });
    await dispatcher.markDispatchIdle();

    expect(onSentMessageIds).toHaveBeenCalledWith(["id-1"]);
    expect(enqueueSystemEventMock).toHaveBeenCalledWith(
      expect.stringContaining("Microsoft Teams delivery failed"),
      expect.objectContaining({
        sessionKey: "agent:main:main",
        contextKey: "msteams:delivery-failure:conv",
      }),
    );
    expect(enqueueSystemEventMock).toHaveBeenCalledWith(
      expect.stringContaining("The user may not have received the full reply"),
      expect.any(Object),
    );
  });

  it("does not queue a delivery-failure system event when Teams send succeeds", async () => {
    renderReplyPayloadsToMessagesMock.mockReturnValue([{ content: "hello" }] as never);
    sendMSTeamsMessagesMock.mockResolvedValue(["id-1"] as never);

    const dispatcher = createDispatcher("personal", { blockStreaming: false });
    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];

    await options.deliver({ text: "block content" });
    await dispatcher.markDispatchIdle();

    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
  });
});

describe("pickInformativeStatusText", () => {
  it("selects a deterministic status line for a fixed random source", () => {
    expect(pickInformativeStatusText(() => 0)).toBe("Thinking...");
    expect(pickInformativeStatusText(() => 0.99)).toBe("Putting an answer together...");
  });
});
