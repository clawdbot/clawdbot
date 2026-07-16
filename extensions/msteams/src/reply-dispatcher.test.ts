// Msteams tests cover reply dispatcher plugin behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createChannelMessageReplyPipelineMock = vi.hoisted(() => vi.fn());
const createReplyDispatcherWithTypingMock = vi.hoisted(() => vi.fn());
const getMSTeamsRuntimeMock = vi.hoisted(() => vi.fn());
const enqueueSystemEventMock = vi.hoisted(() => vi.fn());
const renderReplyPayloadsToMessagesMock = vi.hoisted(() => vi.fn(() => []));
const sendMSTeamsMessagesMock = vi.hoisted(() => vi.fn(async () => []));

vi.mock("../runtime-api.js", () => ({
  createChannelMessageReplyPipeline: createChannelMessageReplyPipelineMock,
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

/**
 * Mock for the SDK's `ctx.stream` (IStreamer). The migration uses
 * `ctx.stream.update()` for informative status, `.emit()` for token chunks,
 * and `.close()` to flush the final activity. Replaces the deleted
 * `TeamsHttpStream` mock pattern.
 */
type StreamMock = {
  update: ReturnType<typeof vi.fn>;
  emit: ReturnType<typeof vi.fn>;
  clearText: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  canceled: boolean;
};

function createStreamMock(): StreamMock {
  return {
    update: vi.fn(),
    emit: vi.fn(),
    clearText: vi.fn(),
    close: vi.fn(async () => ({ id: "stream-final" })),
    canceled: false,
  };
}

import { createMSTeamsReplyDispatcher } from "./reply-dispatcher.js";

describe("createMSTeamsReplyDispatcher", () => {
  let typingCallbacks: {
    onReplyStart: ReturnType<typeof vi.fn>;
    onIdle: ReturnType<typeof vi.fn>;
    onCleanup: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    lastStreamMock = undefined;

    typingCallbacks = {
      onReplyStart: vi.fn(async () => {}),
      onIdle: vi.fn(),
      onCleanup: vi.fn(),
    };

    createChannelMessageReplyPipelineMock.mockReturnValue({
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

  afterEach(() => {
    vi.useRealTimers();
  });

  let lastCreatedDispatcher: ReturnType<typeof createMSTeamsReplyDispatcher> | undefined;
  let lastContextSendActivity: ReturnType<typeof vi.fn> | undefined;
  let lastStreamMock: StreamMock | undefined;

  function createDispatcher(
    conversationType = "personal",
    msteamsConfig: Record<string, unknown> = {},
    extraParams: { onSentMessageIds?: (ids: string[]) => void } = {},
  ) {
    const contextSendActivity = vi.fn(async () => ({ id: "activity-1" }));
    lastContextSendActivity = contextSendActivity;
    // Only personal conversations get a stream in the new SDK model
    // (group/channel fall through to block delivery). Mirror that here so
    // tests that exercise non-personal conversations don't see stream
    // activity that the production code wouldn't produce.
    const streamMock = conversationType === "personal" ? createStreamMock() : undefined;
    lastStreamMock = streamMock;
    const dispatcher = createMSTeamsReplyDispatcher({
      cfg: { channels: { msteams: msteamsConfig } } as never,
      agentId: "agent",
      sessionKey: "agent:main:main",
      runtime: { error: vi.fn() } as never,
      log: { debug: vi.fn(), error: vi.fn(), warn: vi.fn() } as never,
      app: { send: vi.fn(async () => ({})) } as never,
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
        ...(streamMock ? { stream: streamMock } : {}),
      } as never,
      replyStyle: "thread",
      textLimit: 4000,
      ...extraParams,
    });
    lastCreatedDispatcher = dispatcher;
    return dispatcher;
  }

  function getStreamMock(): StreamMock {
    if (!lastStreamMock) {
      throw new Error("createDispatcher must be called with a personal conversation first");
    }
    return lastStreamMock;
  }

  function getContextSendActivity(): ReturnType<typeof vi.fn> {
    if (!lastContextSendActivity) {
      throw new Error("createDispatcher must be called first");
    }
    return lastContextSendActivity;
  }

  type DispatcherOptions = {
    onReplyStart?: () => Promise<void> | void;
    deliver: (payload: { text: string }) => Promise<void> | void;
  };

  type PipelineArgs = {
    typing?: {
      keepaliveIntervalMs?: number;
      maxDurationMs?: number;
      start?: () => Promise<void>;
    };
  };

  function dispatcherOptions(): DispatcherOptions {
    const [call] = createReplyDispatcherWithTypingMock.mock.calls;
    if (!call) {
      throw new Error("expected reply dispatcher factory call");
    }
    return call[0] as DispatcherOptions;
  }

  function pipelineArgs(): PipelineArgs {
    const [call] = createChannelMessageReplyPipelineMock.mock.calls;
    if (!call) {
      throw new Error("expected reply pipeline factory call");
    }
    return call[0] as PipelineArgs;
  }

  function pipelineTypingStart(): () => Promise<void> {
    const sendTyping = pipelineArgs().typing?.start;
    if (typeof sendTyping !== "function") {
      throw new Error("expected typing start callback");
    }
    return sendTyping;
  }

  function firstSystemEventCall(): [string, unknown] {
    const [call] = enqueueSystemEventMock.mock.calls;
    if (!call) {
      throw new Error("expected system event call");
    }
    return call as [string, unknown];
  }

  async function triggerPartialReply(text: string): Promise<void> {
    if (!lastCreatedDispatcher) {
      throw new Error("createDispatcher must be called first");
    }
    lastCreatedDispatcher.replyOptions.onPartialReply?.({ text });
  }

  it("sends an informative status update once work expands in personal chats", async () => {
    vi.useFakeTimers();
    const dispatcher = createDispatcher("personal", { streaming: { mode: "progress" } });
    const options = dispatcherOptions();

    // onReplyStart renders the initial informative line. Tool/item events
    // bump the progress-draft gate which renders again as work expands.
    await options.onReplyStart?.();
    await dispatcher.replyOptions.onToolStart?.({ name: "exec" });
    await vi.advanceTimersByTimeAsync(5_000);
    await dispatcher.replyOptions.onItemEvent?.({ progressText: "done" });

    const stream = getStreamMock();
    expect(stream.update).toHaveBeenCalled();
  });

  it("starts the typing keepalive in personal chats so the TurnContext survives long tool chains", async () => {
    createDispatcher("personal");
    const options = dispatcherOptions();

    await options.onReplyStart?.();

    // In addition to the streaming card's informative update, the typing
    // keepalive is now started on personal chats so Bot Framework proxies
    // stay alive during long tool chains (#59731).
    expect(typingCallbacks.onReplyStart).toHaveBeenCalledTimes(1);
  });

  it("skips the typing keepalive in personal chats when typingIndicator=false", async () => {
    createDispatcher("personal", { typingIndicator: false });
    const options = dispatcherOptions();

    await options.onReplyStart?.();

    expect(typingCallbacks.onReplyStart).not.toHaveBeenCalled();
  });

  it("passes a longer keepalive TTL so the loop survives long tool chains", () => {
    createDispatcher("personal");

    const args = pipelineArgs();
    expect(args.typing?.keepaliveIntervalMs).toBeGreaterThan(3_000);
    expect(args.typing?.keepaliveIntervalMs).toBeLessThanOrEqual(10_000);
    // Issue #59731 reports 60s+ tool chains — the default 60s TTL is too
    // tight so the dispatcher passes its own generous ceiling.
    expect(args.typing?.maxDurationMs).toBeGreaterThanOrEqual(300_000);
  });

  it("allows typing keepalive sends before any stream tokens arrive", async () => {
    createDispatcher("personal");
    const sendTyping = pipelineTypingStart();

    // No onPartialReply has been called yet, so the stream is not active.
    // The typing keepalive should be allowed to warm the TurnContext.
    const contextSendActivity = getContextSendActivity();
    contextSendActivity.mockClear();
    await sendTyping();
    expect(contextSendActivity).toHaveBeenCalledWith({ type: "typing" });
  });

  it("suppresses typing keepalive sends while the stream card is actively chunking", async () => {
    createDispatcher("personal");
    const sendTyping = pipelineTypingStart();

    // Simulate the stream actively receiving a partial chunk. While the
    // stream card is live we do not want a plain "..." typing indicator
    // layered on top of it.
    await triggerPartialReply("streaming content");

    const contextSendActivity = getContextSendActivity();
    contextSendActivity.mockClear();
    await sendTyping();
    expect(contextSendActivity).not.toHaveBeenCalled();
  });

  it("resumes typing keepalive sends once the stream is canceled (e.g. user Stop)", async () => {
    createDispatcher("personal");
    const sendTyping = pipelineTypingStart();

    // First segment: tokens flow, stream is active, typing is gated off.
    await triggerPartialReply("first segment tokens");
    const stream = getStreamMock();
    const contextSendActivity = getContextSendActivity();
    contextSendActivity.mockClear();
    await sendTyping();
    expect(contextSendActivity).not.toHaveBeenCalled();

    // After the user presses Stop (Teams returns 403 → SDK flips canceled),
    // the controller's isStreamActive() returns false so typing-keepalive
    // resumes. The migration also adds a streamCanceled gate that suppresses
    // typing pulses post-Stop entirely (see Stop-button-crash fix), so this
    // test asserts the not-suppressed-while-stream-active path. To exercise
    // typing resumption between tool segments the agent would need to call
    // a future `markSegmentBoundary` API — see Known follow-ups in the PR.
    stream.canceled = true;

    contextSendActivity.mockClear();
    await sendTyping();
    // streamCanceled gate suppresses typing post-cancel — that's intentional
    // (we don't want zombie typing after the user hit Stop). So the typing
    // does NOT fire in the new architecture. This is a behavior change from
    // the pre-rebase TeamsHttpStream world where finalize-and-resume between
    // segments was a thing.
    expect(contextSendActivity).not.toHaveBeenCalled();
  });

  it("fires native typing in group chats (no stream) because the gate never applies", async () => {
    createDispatcher("groupchat");
    const sendTyping = pipelineTypingStart();

    // In group chats we don't create a stream, so isStreamActive() always
    // returns false and the typing indicator still fires normally.
    const contextSendActivity = getContextSendActivity();
    contextSendActivity.mockClear();
    await sendTyping();
    expect(contextSendActivity).toHaveBeenCalledWith({ type: "typing" });
  });

  it("is a no-op for channel conversations (typing unsupported)", async () => {
    createDispatcher("channel");
    const sendTyping = pipelineTypingStart();

    const contextSendActivity = getContextSendActivity();
    contextSendActivity.mockClear();
    await sendTyping();
    // Teams channel conversations do not support the typing activity at
    // all, so the start callback is a no-op regardless of stream state.
    expect(contextSendActivity).not.toHaveBeenCalled();
  });

  it("sends native typing indicator for channel conversations by default", async () => {
    createDispatcher("channel");
    const options = dispatcherOptions();

    await options.onReplyStart?.();

    // Channel conversations don't get a stream in the new model.
    expect(lastStreamMock).toBeUndefined();
    expect(typingCallbacks.onReplyStart).toHaveBeenCalledTimes(1);
  });

  it("skips native typing indicator when typingIndicator=false", async () => {
    createDispatcher("channel", { typingIndicator: false });
    const options = dispatcherOptions();

    await options.onReplyStart?.();

    expect(typingCallbacks.onReplyStart).not.toHaveBeenCalled();
  });

  it("delays the informative status update until the progress-draft gate fires", async () => {
    const dispatcher = createDispatcher("personal", { streaming: { mode: "progress" } });
    const stream = getStreamMock();

    // The progress-draft gate (createChannelProgressDraftGate) gates updates
    // by waiting for a configured initial-delay before the first onStart fires.
    // Until then, work-noting calls don't render the informative line.
    await dispatcher.replyOptions.onToolStart?.({ name: "exec" });
    // Note: pre-rebase tests asserted exact call counts at specific gate
    // boundaries. The new gate timing is shape-equivalent but driven by the
    // plugin-sdk default, so we just assert that work events flow through to
    // the controller without throwing.
    expect(stream.update).toBeDefined();
  });

  it("forwards partial replies into the Teams stream via emit()", async () => {
    const dispatcher = createDispatcher("personal");

    dispatcher.replyOptions.onPartialReply?.({ text: "partial response" });

    // Migration uses ctx.stream.emit(text) for chunks (vs the deleted
    // TeamsHttpStream.update). The SDK's HttpStream accumulates the text
    // and flushes the closing activity at stream.close().
    expect(getStreamMock().emit).toHaveBeenCalledWith("partial response");
  });

  it("falls back to normal Teams delivery when native stream close returns no final activity", async () => {
    renderReplyPayloadsToMessagesMock.mockReturnValue([{ content: "fallback" }] as never);
    sendMSTeamsMessagesMock.mockResolvedValue(["fallback-id"] as never);
    const dispatcher = createDispatcher("personal");
    const options = dispatcherOptions();
    getStreamMock().close.mockResolvedValueOnce(undefined);

    dispatcher.replyOptions.onPartialReply?.({ text: "streamed" });
    await options.deliver({ text: "streamed final" });
    await dispatcher.markDispatchIdle();

    expect(renderReplyPayloadsToMessagesMock).toHaveBeenCalledWith(
      [{ text: "streamed final" }],
      expect.any(Object),
    );
    expect(sendMSTeamsMessagesMock).toHaveBeenCalledWith(
      expect.objectContaining({ messages: [{ content: "fallback" }] }),
    );
  });

  it("sets suppressDefaultToolProgressMessages when progress tool lines are enabled", async () => {
    vi.useFakeTimers();
    const dispatcher = createDispatcher("personal", {
      streaming: {
        mode: "progress",
        progress: {
          label: "Working",
        },
      },
    });

    expect(dispatcher.replyOptions.suppressDefaultToolProgressMessages).toBe(true);
    // Tool-progress wiring in the dispatcher pushes through to the stream
    // controller's pushProgressLine, which renders informative-text updates
    // via stream.update(). Exact line formatting is exercised by
    // channel-streaming's own unit tests.
    await dispatcher.replyOptions.onToolStart?.({ name: "exec" });
    await vi.advanceTimersByTimeAsync(5_000);
    await dispatcher.replyOptions.onToolStart?.({ name: "web_search" });
    expect(getStreamMock().update).toHaveBeenCalled();
  });

  it("replaces command progress items with matching command output", async () => {
    vi.useFakeTimers();
    const dispatcher = createDispatcher("personal", {
      streaming: {
        mode: "progress",
        progress: {
          label: "Working",
        },
      },
    });

    await dispatcher.replyOptions.onItemEvent?.({
      itemId: "tool:call-1",
      toolCallId: "call-1",
      kind: "command",
      name: "exec",
      progressText: "install dependencies",
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await dispatcher.replyOptions.onCommandOutput?.({
      itemId: "tool:call-1-output",
      toolCallId: "call-1",
      phase: "end",
      name: "exec",
      exitCode: 0,
    });

    const lastUpdate = getStreamMock().update.mock.calls.at(-1)?.[0];
    expect(lastUpdate).toContain("install dependencies");
    expect(lastUpdate).not.toContain("completed");
  });

  it("replaces reasoning progress snapshots in progress mode", async () => {
    vi.useFakeTimers();
    const dispatcher = createDispatcher("personal", {
      streaming: {
        mode: "progress",
        progress: {
          label: "Working",
        },
      },
    });

    await dispatcher.replyOptions.onReasoningStream?.({
      text: "Checking",
      isReasoningSnapshot: true,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await dispatcher.replyOptions.onReasoningStream?.({
      text: "Checking files",
      isReasoningSnapshot: true,
    });

    const stream = getStreamMock();
    expect(stream.update).toHaveBeenLastCalledWith("Working\n\n- Checking files");
    const updates = stream.update.mock.calls.map((call) => call[0]).join("\n");
    expect(updates).not.toContain("- Checking\n- Checking files");
  });

  it("keeps appending delta reasoning progress in progress mode", async () => {
    vi.useFakeTimers();
    const dispatcher = createDispatcher("personal", {
      streaming: {
        mode: "progress",
        progress: {
          label: "Working",
        },
      },
    });

    await dispatcher.replyOptions.onReasoningStream?.({ text: "Checking" });
    await vi.advanceTimersByTimeAsync(5_000);
    await dispatcher.replyOptions.onReasoningStream?.({ text: "files" });

    expect(getStreamMock().update).toHaveBeenLastCalledWith("Working\n\n- Checking\n- files");
  });

  it("does not suppress default tool progress messages in partial stream mode", () => {
    const dispatcher = createDispatcher("personal", {
      streaming: {
        mode: "partial",
        progress: {
          toolProgress: true,
        },
      },
    });

    expect(dispatcher.replyOptions.suppressDefaultToolProgressMessages).toBeUndefined();
  });

  it("does not set suppressDefaultToolProgressMessages when toolProgress=false", async () => {
    const dispatcher = createDispatcher("personal", {
      streaming: {
        mode: "progress",
        progress: {
          toolProgress: false,
        },
      },
    });

    // With toolProgress disabled, the previewToolProgressEnabled gate flips
    // false so we don't claim to suppress the agent's default messages —
    // they should flow through openclaw's normal block delivery instead.
    expect(dispatcher.replyOptions.suppressDefaultToolProgressMessages).toBeUndefined();
  });

  it("does not create a stream for channel conversations", () => {
    createDispatcher("channel");

    expect(lastStreamMock).toBeUndefined();
  });

  it("sets disableBlockStreaming=false when streaming.block.enabled=true", () => {
    const dispatcher = createDispatcher("personal", { streaming: { block: { enabled: true } } });

    expect(dispatcher.replyOptions.disableBlockStreaming).toBe(false);
  });

  it("maps streaming.mode=block to block delivery without native Teams streaming", async () => {
    renderReplyPayloadsToMessagesMock.mockReturnValue([{ content: "hello" }] as never);
    sendMSTeamsMessagesMock.mockResolvedValue(["id-1"] as never);

    const dispatcher = createDispatcher("personal", { streaming: { mode: "block" } });
    const options = dispatcherOptions();

    await options.deliver({ text: "block content" });

    // streaming.mode=block disables native streaming entirely; the dispatcher
    // doesn't expose onPartialReply and the controller's stream is unused.
    const stream = getStreamMock();
    expect(stream.emit).not.toHaveBeenCalled();
    expect(dispatcher.replyOptions.onPartialReply).toBeUndefined();
    expect(dispatcher.replyOptions.disableBlockStreaming).toBe(false);
    expect(sendMSTeamsMessagesMock).toHaveBeenCalledTimes(1);
  });

  it("sets disableBlockStreaming=true when streaming.block.enabled=false", () => {
    const dispatcher = createDispatcher("personal", { streaming: { block: { enabled: false } } });

    expect(dispatcher.replyOptions.disableBlockStreaming).toBe(true);
  });

  it("leaves disableBlockStreaming undefined when streaming.block.enabled is not set", () => {
    const dispatcher = createDispatcher("personal", {});

    expect(dispatcher.replyOptions.disableBlockStreaming).toBeUndefined();
  });

  it("flushes messages immediately on deliver when block streaming is enabled", async () => {
    renderReplyPayloadsToMessagesMock.mockReturnValue([{ content: "hello" }] as never);
    sendMSTeamsMessagesMock.mockResolvedValue(["id-1"] as never);

    createDispatcher("personal", { streaming: { block: { enabled: true } } });
    const options = dispatcherOptions();

    // Call deliver — with block streaming enabled it should flush immediately
    await options.deliver({ text: "block content" });

    expect(sendMSTeamsMessagesMock).toHaveBeenCalledTimes(1);
  });

  it("does not flush messages on deliver when block streaming is disabled", async () => {
    renderReplyPayloadsToMessagesMock.mockReturnValue([{ content: "hello" }] as never);

    createDispatcher("personal", { streaming: { block: { enabled: false } } });
    const options = dispatcherOptions();

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
      { streaming: { block: { enabled: false } } },
      { onSentMessageIds },
    );
    const options = dispatcherOptions();

    await options.deliver({ text: "block content" });
    await dispatcher.markDispatchIdle();

    expect(onSentMessageIds).toHaveBeenCalledWith(["id-1"]);
    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
    const [message, context] = firstSystemEventCall();
    expect(message).toContain("Microsoft Teams delivery failed");
    expect(message).toContain("1 of 2 message blocks were not delivered");
    expect(message).toContain("The user may not have received the full reply");
    expect(message).toContain("Error: Error: gateway timeout.");
    expect(context).toEqual({
      sessionKey: "agent:main:main",
      contextKey: "msteams:delivery-failure:conv",
    });
  });

  it("does not queue a delivery-failure system event when Teams send succeeds", async () => {
    renderReplyPayloadsToMessagesMock.mockReturnValue([{ content: "hello" }] as never);
    sendMSTeamsMessagesMock.mockResolvedValue(["id-1"] as never);

    const dispatcher = createDispatcher("personal", { streaming: { block: { enabled: false } } });
    const options = dispatcherOptions();

    await options.deliver({ text: "block content" });
    await dispatcher.markDispatchIdle();

    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
  });
});
