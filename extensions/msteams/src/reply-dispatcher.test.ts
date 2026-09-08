// Msteams tests cover reply dispatcher plugin behavior.
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createReplyDispatcher } from "openclaw/plugin-sdk/reply-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReplyPayload } from "../runtime-api.js";

const createChannelMessageReplyPipelineMock = vi.hoisted(() => vi.fn());
const getMSTeamsRuntimeMock = vi.hoisted(() => vi.fn());
const enqueueSystemEventMock = vi.hoisted(() => vi.fn());
const getGlobalHookRunnerMock = vi.hoisted(() => vi.fn());
const renderReplyPayloadsToMessagesMock = vi.hoisted(() =>
  vi.fn<(typeof import("./messenger.js"))["renderReplyPayloadsToMessages"]>(() => []),
);
const sendMSTeamsMessagesMock = vi.hoisted(() =>
  vi.fn<(typeof import("./messenger.js"))["sendMSTeamsMessages"]>(async () => []),
);

vi.mock("../runtime-api.js", () => ({
  createChannelMessageReplyPipeline: createChannelMessageReplyPipelineMock,
  logTypingFailure: vi.fn(),
  resolveChannelMediaMaxBytes: vi.fn(() => 8 * 1024 * 1024),
}));

vi.mock("./runtime.js", () => ({
  getMSTeamsRuntime: getMSTeamsRuntimeMock,
}));

vi.mock("openclaw/plugin-sdk/plugin-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/plugin-runtime")>()),
  getGlobalHookRunner: getGlobalHookRunnerMock,
}));

vi.mock("./messenger.js", () => ({
  buildConversationReference: vi.fn((ref) => ref),
  renderReplyPayloadsToMessages: renderReplyPayloadsToMessagesMock,
  sendMSTeamsMessages: sendMSTeamsMessagesMock,
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
  close: ReturnType<typeof vi.fn<() => Promise<{ id: string } | undefined>>>;
  canceled: boolean;
  events: {
    on: ReturnType<typeof vi.fn>;
    off: ReturnType<typeof vi.fn>;
  };
  acknowledge: (text: string) => void;
};

function createStreamMock(): StreamMock {
  let chunkHandler:
    | ((activity: {
        id: string;
        type: string;
        text: string;
        channelData: { streamType: string };
      }) => void)
    | undefined;
  return {
    update: vi.fn(),
    emit: vi.fn(),
    clearText: vi.fn(),
    close: vi.fn(async () => ({ id: "stream-final" })),
    canceled: false,
    events: {
      on: vi.fn((_event: "chunk", handler: typeof chunkHandler) => {
        chunkHandler = handler;
        return 0;
      }),
      off: vi.fn(() => {
        chunkHandler = undefined;
      }),
    },
    acknowledge: (text: string) => {
      chunkHandler?.({
        id: "stream-acknowledged",
        type: "typing",
        text,
        channelData: { streamType: "streaming" },
      });
    },
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
    sendMSTeamsMessagesMock.mockReset().mockResolvedValue([]);
    renderReplyPayloadsToMessagesMock.mockReset().mockReturnValue([]);
    getGlobalHookRunnerMock.mockReturnValue(undefined);
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

    getMSTeamsRuntimeMock.mockReturnValue({
      system: {
        enqueueSystemEvent: enqueueSystemEventMock,
      },
      channel: {
        text: {
          resolveChunkMode: vi.fn(() => "length"),
          resolveMarkdownTableMode: vi.fn(() => "code"),
        },
        reply: { resolveHumanDelayConfig: vi.fn(() => undefined) },
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
    deliver: (
      payload: ReplyPayload,
    ) => ReturnType<ReturnType<typeof createMSTeamsReplyDispatcher>["delivery"]["deliver"]>;
  };

  type PipelineArgs = {
    typing?: {
      keepaliveIntervalMs?: number;
      maxDurationMs?: number;
      start?: () => Promise<void>;
    };
  };

  function dispatcherOptions(): DispatcherOptions {
    const created = lastCreatedDispatcher;
    if (!created) {
      throw new Error("createDispatcher must be called first");
    }
    return {
      onReplyStart: created.dispatcherOptions.onReplyStart,
      deliver: (payload) => created.delivery.deliver(payload, { kind: "final" }),
    };
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

  function registerHooks(...hooks: string[]): void {
    const registered = new Set(hooks);
    getGlobalHookRunnerMock.mockReturnValue({
      hasHooks: vi.fn((hookName: string) => registered.has(hookName)),
    });
  }

  it("sends an informative status update once work expands in personal chats", async () => {
    vi.useFakeTimers();
    const dispatcher = createDispatcher("personal", {
      streaming: { mode: "progress", progress: { toolProgress: true } },
    });
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

  it("keeps quiet Teams progress useful without exposing routine tool rows", async () => {
    vi.useFakeTimers();
    const dispatcher = createDispatcher("personal", {
      streaming: { mode: "progress", progress: { label: "Working" } },
    });
    const stream = getStreamMock();

    await dispatcher.replyOptions.onToolStart?.({ name: "exec" });
    expect(stream.update).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(stream.update).toHaveBeenLastCalledWith("Working");

    await dispatcher.replyOptions.onApprovalEvent?.({
      phase: "requested",
      approvalId: "approval-1",
      command: "confirm-operation",
    });
    expect(stream.update).toHaveBeenLastCalledWith(expect.stringContaining("confirm-operation"));

    await dispatcher.replyOptions.onCommandOutput?.({
      itemId: "command-1",
      phase: "end",
      name: "exec",
      exitCode: 1,
    });
    expect(stream.update).toHaveBeenLastCalledWith(expect.stringContaining("exit 1"));

    await dispatcher.replyOptions.onApprovalEvent?.({
      phase: "resolved",
      approvalId: "approval-1",
    });
    expect(stream.update).toHaveBeenLastCalledWith(
      expect.not.stringContaining("confirm-operation"),
    );
    await dispatcher.replyOptions.onCommandOutput?.({
      itemId: "command-1",
      phase: "end",
      name: "exec",
      exitCode: 0,
    });
    expect(stream.update).toHaveBeenLastCalledWith("Working");
  });

  it("forwards partial replies into the Teams stream via emit()", async () => {
    const dispatcher = createDispatcher("personal");

    dispatcher.replyOptions.onPartialReply?.({ text: "partial response" });

    // Migration uses ctx.stream.emit(text) for chunks (vs the deleted
    // TeamsHttpStream.update). The SDK's HttpStream accumulates the text
    // and flushes the closing activity at stream.close().
    expect(getStreamMock().emit).toHaveBeenCalledWith("partial response");
  });

  it("preserves partial and progress streams for observer-only hooks", async () => {
    registerHooks("message_sent");

    const partialDispatcher = createDispatcher("personal");
    partialDispatcher.replyOptions.onPartialReply?.({ text: "partial response" });
    expect(getStreamMock().emit).toHaveBeenCalledWith("partial response");

    vi.useFakeTimers();
    const progressDispatcher = createDispatcher("personal", {
      streaming: { mode: "progress", progress: { toolProgress: true } },
    });
    await progressDispatcher.replyOptions.onToolStart?.({ name: "exec" });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(getStreamMock().update).toHaveBeenCalled();
  });

  it.each(
    [
      { label: "reply_payload_sending", hooks: ["reply_payload_sending"] },
      { label: "message_sending", hooks: ["message_sending"] },
      {
        label: "both modifying hooks",
        hooks: ["reply_payload_sending", "message_sending"],
      },
    ].flatMap(({ label, hooks }) =>
      (["partial", "progress"] as const).map((mode) => ({ label, hooks, mode })),
    ),
  )("suppresses $mode provider streams when $label is registered", async ({ hooks, mode }) => {
    registerHooks(...hooks);
    renderReplyPayloadsToMessagesMock.mockReturnValue([{ content: "final" }] as never);
    sendMSTeamsMessagesMock.mockResolvedValue(["final-id"] as never);

    const dispatcher = createDispatcher("personal", { streaming: { mode } });
    dispatcher.replyOptions.onPartialReply?.({ text: "original partial" });
    await dispatcher.replyOptions.onToolStart?.({ name: "exec" });
    await dispatcher.delivery.deliver({ text: "authoritative final" }, { kind: "final" });
    await dispatcher.dispatcherOptions.onSettled?.();

    const stream = getStreamMock();
    expect(dispatcher.replyOptions.onPartialReply).toBeUndefined();
    expect(dispatcher.replyOptions.onToolStart).toBeUndefined();
    expect(dispatcher.replyOptions.suppressDefaultToolProgressMessages).toBeUndefined();
    expect(stream.emit).not.toHaveBeenCalled();
    expect(stream.update).not.toHaveBeenCalled();
    expect(sendMSTeamsMessagesMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to normal Teams delivery when native stream close returns no final activity", async () => {
    renderReplyPayloadsToMessagesMock.mockReturnValue([{ text: "streamed final" }] as never);
    sendMSTeamsMessagesMock.mockResolvedValue(["fallback-id"] as never);
    const dispatcher = createDispatcher("personal");
    const options = dispatcherOptions();
    getStreamMock().close.mockResolvedValueOnce(undefined);

    dispatcher.replyOptions.onPartialReply?.({ text: "streamed" });
    const result = await options.deliver({ text: "streamed final" });
    await dispatcher.dispatcherOptions.onSettled?.();
    await expect(result?.finalization).resolves.toEqual({
      visibleReplySent: true,
      messageIds: ["fallback-id"],
      content: "streamed final",
    });

    expect(renderReplyPayloadsToMessagesMock).toHaveBeenCalledWith(
      [{ text: "streamed final" }],
      expect.any(Object),
    );
    expect(sendMSTeamsMessagesMock).toHaveBeenCalledWith(
      expect.objectContaining({ messages: [{ text: "streamed final" }] }),
    );
  });

  it("keeps acknowledged stream identity ahead of successful fallback ids", async () => {
    renderReplyPayloadsToMessagesMock.mockReturnValue([{ text: "world" }] as never);
    sendMSTeamsMessagesMock.mockResolvedValue(["fallback-id"] as never);
    const dispatcher = createDispatcher("personal");
    const options = dispatcherOptions();
    const stream = getStreamMock();
    stream.close.mockResolvedValueOnce(undefined);

    dispatcher.replyOptions.onPartialReply?.({ text: "hello" });
    stream.acknowledge("hello");
    const result = await options.deliver({ text: "hello world" });
    await dispatcher.dispatcherOptions.onSettled?.();

    await expect(result?.finalization).resolves.toEqual({
      visibleReplySent: true,
      messageIds: ["stream-acknowledged", "fallback-id"],
      content: "hello world",
    });
  });

  it("preserves acknowledged text when a media-only final has no logical text", async () => {
    renderReplyPayloadsToMessagesMock.mockReturnValue([
      { mediaUrl: "https://example.com/image.png" },
    ] as never);
    sendMSTeamsMessagesMock.mockResolvedValue(["media-id"] as never);
    const dispatcher = createDispatcher("personal");
    const options = dispatcherOptions();
    const stream = getStreamMock();
    stream.close.mockResolvedValueOnce(undefined);

    dispatcher.replyOptions.onPartialReply?.({ text: "hello" });
    stream.acknowledge("hello");
    const result = await options.deliver({ mediaUrl: "https://example.com/image.png" });
    await dispatcher.dispatcherOptions.onSettled?.();

    await expect(result?.finalization).resolves.toEqual({
      visibleReplySent: true,
      messageIds: ["stream-acknowledged", "media-id"],
      content: "hello",
    });
  });

  it("reports only accepted native and fallback content after partial fallback failure", async () => {
    renderReplyPayloadsToMessagesMock.mockReturnValue([
      { text: "world-one" },
      { text: "world-two" },
    ] as never);
    sendMSTeamsMessagesMock
      .mockResolvedValueOnce(["fallback-id"] as never)
      .mockRejectedValueOnce(new Error("fallback failed"));
    const dispatcher = createDispatcher("personal");
    const options = dispatcherOptions();
    const stream = getStreamMock();
    stream.close.mockRejectedValueOnce(new Error("close failed"));

    dispatcher.replyOptions.onPartialReply?.({ text: "hello" });
    stream.acknowledge("hello");
    const result = await options.deliver({ text: "hello world" });
    const finalization = expect(result?.finalization).rejects.toMatchObject({
      code: "CHANNEL_PARTIAL_DELIVERY",
      deliveryResult: {
        visibleReplySent: true,
        messageIds: ["stream-acknowledged", "fallback-id"],
        content: "hello\nworld-one",
      },
    });
    await dispatcher.dispatcherOptions.onSettled?.();
    await finalization;
  });

  it("sets suppressDefaultToolProgressMessages when progress tool lines are enabled", async () => {
    vi.useFakeTimers();
    const dispatcher = createDispatcher("personal", {
      streaming: {
        mode: "progress",
        progress: {
          toolProgress: true,
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
          toolProgress: true,
          label: "Working",
          commandText: "raw",
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

  it("preserves command output text when raw command progress is configured", async () => {
    vi.useFakeTimers();
    const dispatcher = createDispatcher("personal", {
      streaming: {
        mode: "progress",
        progress: {
          toolProgress: true,
          label: "Working",
          commandText: "raw",
        },
      },
    });

    await dispatcher.replyOptions.onCommandOutput?.({
      phase: "end",
      title: "pnpm test -- --watch=false",
      name: "exec",
      exitCode: 1,
    });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(getStreamMock().update).toHaveBeenLastCalledWith(
      expect.stringContaining("pnpm test -- --watch=false"),
    );
  });

  it.each(
    [undefined, false, true].flatMap((toolProgress) => [
      { kind: "snapshot", toolProgress, isReasoningSnapshot: true, continuation: "Checking files" },
      { kind: "delta", toolProgress, isReasoningSnapshot: false, continuation: " files" },
    ]),
  )(
    "keeps $kind reasoning visible with toolProgress=$toolProgress",
    async ({ toolProgress, isReasoningSnapshot, continuation }) => {
      vi.useFakeTimers();
      const dispatcher = createDispatcher("personal", {
        streaming: { mode: "progress", progress: { toolProgress, label: "Working" } },
      });

      await dispatcher.replyOptions.onReasoningStream?.({ text: "Checking", isReasoningSnapshot });
      await vi.advanceTimersByTimeAsync(1_500);
      await dispatcher.replyOptions.onReasoningStream?.({
        text: continuation,
        isReasoningSnapshot,
      });

      const stream = getStreamMock();
      expect(stream.update).toHaveBeenLastCalledWith(expect.stringContaining("Checking files"));
      const latest = String(stream.update.mock.calls.at(-1)?.[0]);
      expect(latest.match(/Checking/g)).toHaveLength(1);

      dispatcher.replyOptions.onReasoningEnd?.();
      await dispatcher.replyOptions.onReasoningStream?.({
        text: "Next thought",
        isReasoningSnapshot,
      });
      expect(stream.update).toHaveBeenLastCalledWith(expect.stringContaining("Next thought"));
      expect(stream.update).toHaveBeenLastCalledWith(expect.not.stringContaining("Checking files"));

      await dispatcher.delivery.deliver({ text: "Final answer" }, { kind: "final" });
      await dispatcher.dispatcherOptions.onSettled?.();
      const updateCount = stream.update.mock.calls.length;
      await dispatcher.replyOptions.onReasoningStream?.({
        text: "Late reasoning",
        isReasoningSnapshot,
      });
      await vi.advanceTimersByTimeAsync(1_500);
      expect(stream.update).toHaveBeenCalledTimes(updateCount);
    },
  );

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

  it.each([undefined, false, true])(
    "suppresses standalone Teams progress with toolProgress=%s",
    (toolProgress) => {
      const dispatcher = createDispatcher("personal", {
        streaming: {
          mode: "progress",
          progress: {
            toolProgress,
          },
        },
      });

      expect(dispatcher.replyOptions.suppressDefaultToolProgressMessages).toBe(true);
    },
  );

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
    renderReplyPayloadsToMessagesMock.mockReturnValue([{ text: "one" }, { text: "two" }] as never);
    sendMSTeamsMessagesMock
      .mockResolvedValueOnce(["id-1"] as never)
      .mockRejectedValueOnce(Object.assign(new Error("gateway timeout"), { statusCode: 502 }));

    const dispatcher = createDispatcher(
      "personal",
      { streaming: { block: { enabled: false } } },
      { onSentMessageIds },
    );
    const options = dispatcherOptions();

    const result = await options.deliver({ text: "block content" });
    const finalization = expect(result?.finalization).rejects.toMatchObject({
      code: "CHANNEL_PARTIAL_DELIVERY",
      deliveryResult: {
        visibleReplySent: true,
        messageIds: ["id-1"],
        content: "one",
      },
    });
    await dispatcher.dispatcherOptions.onSettled?.();
    await finalization;

    expect(onSentMessageIds).toHaveBeenCalledWith(["id-1"]);
    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
    const [message, context] = firstSystemEventCall();
    expect(message).toContain("Microsoft Teams delivery failed");
    expect(message).toContain("the delivery outcome is unknown for 1 of 2 message blocks");
    expect(message).not.toContain("not delivered");
    expect(message).not.toContain("The user may not have received");
    expect(message).toContain("Error: gateway timeout.");
    expect(message).toContain("Delivery may already have succeeded");
    expect(message).not.toContain("Retrying later may succeed");
    expect(sendMSTeamsMessagesMock).toHaveBeenCalledTimes(2);
    expect(sendMSTeamsMessagesMock.mock.calls.map(([send]) => send.messages)).toEqual([
      [{ text: "one" }],
      [{ text: "two" }],
    ]);
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
    await dispatcher.dispatcherOptions.onSettled?.();

    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
  });

  it("returns queued delivery identity only after the provider send runs", async () => {
    renderReplyPayloadsToMessagesMock.mockReturnValue([{ text: "hello" }] as never);
    sendMSTeamsMessagesMock.mockResolvedValue(["id-1"] as never);
    const dispatcher = createDispatcher("groupchat", {
      streaming: { block: { enabled: false } },
    });

    expect(dispatcher.delivery.observeMessageSent).toBe(true);
    const result = await dispatcher.delivery.deliver({ text: "hello" }, { kind: "final" });
    let settled = false;
    void result?.finalization?.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(sendMSTeamsMessagesMock).not.toHaveBeenCalled();

    await dispatcher.dispatcherOptions.onSettled?.();
    await expect(result?.finalization).resolves.toEqual({
      visibleReplySent: true,
      messageIds: ["id-1"],
      content: "hello",
    });
  });

  it("keeps suppressed queued sends non-visible", async () => {
    renderReplyPayloadsToMessagesMock.mockReturnValue([{ text: "hello" }] as never);
    sendMSTeamsMessagesMock.mockResolvedValue([]);
    const onSentMessageIds = vi.fn();
    const dispatcher = createDispatcher(
      "groupchat",
      { streaming: { block: { enabled: false } } },
      { onSentMessageIds },
    );

    const result = await dispatcher.delivery.deliver({ text: "hello" }, { kind: "final" });
    await dispatcher.dispatcherOptions.onSettled?.();

    await expect(result?.finalization).resolves.toEqual({
      visibleReplySent: false,
    });
    expect(onSentMessageIds).not.toHaveBeenCalled();
  });

  it("returns native stream identity and final content after close", async () => {
    const dispatcher = createDispatcher("personal");
    dispatcher.replyOptions.onPartialReply?.({ text: "streamed" });

    const result = await dispatcher.delivery.deliver({ text: "streamed final" }, { kind: "final" });
    expect(getStreamMock().close).not.toHaveBeenCalled();

    await dispatcher.dispatcherOptions.onSettled?.();
    await expect(result?.finalization).resolves.toEqual({
      visibleReplySent: true,
      messageIds: ["stream-final"],
      content: "streamed final",
    });
  });

  it("preserves both progress finals through real dispatcher settlement", async () => {
    renderReplyPayloadsToMessagesMock.mockImplementation((payloads) =>
      payloads.flatMap((payload) => (payload.text ? [{ text: payload.text }] : [])),
    );
    sendMSTeamsMessagesMock.mockResolvedValue(["block-result"]);
    const teams = createDispatcher("personal", { streaming: { mode: "progress" } });
    const deliveries: Array<Awaited<ReturnType<typeof teams.delivery.deliver>>> = [];
    const events: string[] = [];
    const producer = createReplyDispatcher({
      deliver: async (payload, info) => {
        events.push(`deliver:${payload.text}`);
        const result = await teams.delivery.deliver(payload, info);
        deliveries.push(result);
        return result;
      },
      onIdle: async () => {
        events.push("settle");
        await teams.dispatcherOptions.onSettled?.();
      },
    });
    producer.sendFinalReply({ text: "First distinct result." });
    producer.sendFinalReply({ text: "# Second distinct result" });
    producer.markComplete();
    await producer.waitForIdle();
    const results = await Promise.all(
      deliveries.map((result) => Promise.resolve(result?.finalization ?? result)),
    );
    expect(events).toEqual([
      "deliver:First distinct result.",
      "deliver:# Second distinct result",
      "settle",
    ]);
    for (const text of ["First distinct result.", "Second distinct result"]) {
      expect(results).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            visibleReplySent: true,
            content: expect.stringContaining(text),
          }),
        ]),
      );
    }
  });

  it.each(["close", "fallback"])("joins an active native %s before later blocks", async (phase) => {
    const started = createDeferred<void>();
    const release = createDeferred<void>();
    const sent: string[] = [];
    renderReplyPayloadsToMessagesMock.mockImplementation((payloads) =>
      payloads.flatMap((payload) => (payload.text ? [{ text: payload.text }] : [])),
    );
    sendMSTeamsMessagesMock.mockImplementation(async ({ messages }) => {
      const text = messages[0]?.text ?? "";
      if (phase === "fallback" && text === "First result") {
        started.resolve();
        await release.promise;
      }
      sent.push(text);
      return [`block-${text}`];
    });
    const teams = createDispatcher("personal", {
      streaming: { mode: "progress", block: { enabled: true } },
    });
    getStreamMock().close.mockImplementation(async () => {
      if (phase === "fallback") {
        throw new Error("close failed");
      }
      started.resolve();
      await release.promise;
      sent.push("First result");
      return { id: "stream-final" };
    });
    const first = await teams.delivery.deliver({ text: "First result" }, { kind: "final" });
    const settling = teams.dispatcherOptions.onSettled?.();
    await started.promise;
    const later = teams.delivery.deliver({ text: "Second result" }, { kind: "final" });
    release.resolve();
    const second = await later;
    await settling;
    await teams.dispatcherOptions.onSettled?.();
    const results = await Promise.all([first?.finalization, second?.finalization]);
    expect(sent).toEqual(["First result", "Second result"]);
    expect(results).toEqual([
      expect.objectContaining({ visibleReplySent: true, content: "First result" }),
      expect.objectContaining({ visibleReplySent: true, content: "Second result" }),
    ]);
  });

  it.each(["partial", "progress"] as const)(
    "honors late Stop before later %s text and media",
    async (mode) => {
      renderReplyPayloadsToMessagesMock.mockImplementation((payloads) =>
        payloads.map(({ text, mediaUrl }) => ({ text, mediaUrl })),
      );
      sendMSTeamsMessagesMock.mockResolvedValue(["must-not-send"]);
      const teams = createDispatcher("personal", { streaming: { mode } });
      const stream = getStreamMock();
      if (mode === "partial") {
        teams.replyOptions.onPartialReply?.({ text: "First result" });
      }
      const first = await teams.delivery.deliver({ text: "First result" }, { kind: "final" });
      stream.acknowledge("First result");
      stream.close.mockImplementation(async () => {
        stream.canceled = true;
        return undefined;
      });
      const second = await teams.delivery.deliver(
        { text: "Second result", mediaUrl: "https://example.test/later.png" },
        { kind: "final" },
      );
      await teams.dispatcherOptions.onSettled?.();
      await expect(first?.finalization).resolves.toMatchObject({
        visibleReplySent: true,
        content: "First result",
      });
      expect(second).toEqual({
        visibleReplySent: false,
        suppression: { reason: "no_visible_result" },
      });
      expect(sendMSTeamsMessagesMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      name: "attached media",
      payloads: [
        {
          text: "provider final",
          mediaUrl: "https://example.test/must-not-send.png",
        },
      ],
    },
    {
      name: "media after text",
      payloads: [
        { text: "provider final" },
        { mediaUrl: "https://example.test/must-not-send.png" },
      ],
    },
    {
      name: "media before text",
      payloads: [
        { mediaUrl: "https://example.test/must-not-send.png" },
        { text: "provider final" },
      ],
    },
  ])("settles a stopped divergent final without $name fallback", async ({ payloads }) => {
    renderReplyPayloadsToMessagesMock.mockReturnValue([
      { mediaUrl: "https://example.test/must-not-send.png" },
    ] as never);
    const dispatcher = createDispatcher("personal");
    const stream = getStreamMock();
    stream.close.mockImplementation(async () => {
      stream.canceled = true;
      return undefined;
    });

    dispatcher.replyOptions.onPartialReply?.({ text: "streamed preview" });
    stream.acknowledge("streamed preview");
    dispatcher.replyOptions.onPartialReply?.({ text: "provider final" });
    const results = [];
    for (const payload of payloads) {
      results.push(await dispatcher.delivery.deliver(payload, { kind: "final" }));
    }
    await dispatcher.dispatcherOptions.onSettled?.();

    const nativeResult = results.find((result) => result?.finalization !== undefined);
    await expect(nativeResult?.finalization).resolves.toEqual({
      visibleReplySent: true,
      messageIds: ["stream-acknowledged"],
      content: "streamed preview",
    });
    expect(stream.clearText).toHaveBeenCalledTimes(1);
    expect(stream.close).toHaveBeenCalledTimes(1);
    expect(renderReplyPayloadsToMessagesMock).not.toHaveBeenCalled();
    expect(sendMSTeamsMessagesMock).not.toHaveBeenCalled();
  });

  it("releases later payloads only after divergent native replacement settles", async () => {
    renderReplyPayloadsToMessagesMock.mockReturnValue([{ text: "second payload" }] as never);
    sendMSTeamsMessagesMock.mockResolvedValue(["post-native-id"] as never);
    const dispatcher = createDispatcher("personal");
    const stream = getStreamMock();

    dispatcher.replyOptions.onPartialReply?.({ text: "streamed preview" });
    stream.acknowledge("streamed preview");
    dispatcher.replyOptions.onPartialReply?.({ text: "provider final" });
    const nativeResult = await dispatcher.delivery.deliver(
      { text: "provider final" },
      { kind: "final" },
    );
    await dispatcher.delivery.deliver({ text: "second payload" }, { kind: "final" });

    expect(sendMSTeamsMessagesMock).not.toHaveBeenCalled();
    await dispatcher.dispatcherOptions.onSettled?.();

    await expect(nativeResult?.finalization).resolves.toEqual({
      visibleReplySent: true,
      messageIds: ["stream-final", "post-native-id"],
      content: "provider final\nsecond payload",
    });
    expect(renderReplyPayloadsToMessagesMock).toHaveBeenCalledWith(
      [{ text: "second payload" }],
      expect.any(Object),
    );
    expect(sendMSTeamsMessagesMock).toHaveBeenCalledTimes(1);
  });

  it("settles delivery when sent-message ID observation throws", async () => {
    renderReplyPayloadsToMessagesMock.mockReturnValue([{ text: "hello" }] as never);
    sendMSTeamsMessagesMock.mockResolvedValue(["id-1"] as never);
    const dispatcher = createDispatcher(
      "groupchat",
      { streaming: { block: { enabled: false } } },
      {
        onSentMessageIds: () => {
          throw new Error("observer failed");
        },
      },
    );

    const result = await dispatcher.delivery.deliver({ text: "hello" }, { kind: "final" });
    await dispatcher.dispatcherOptions.onSettled?.();

    await expect(result?.finalization).resolves.toEqual({
      visibleReplySent: true,
      messageIds: ["id-1"],
      content: "hello",
    });
  });

  it("preserves a never-dispatched queued failure for core event suppression", async () => {
    const failure = new PlatformMessageNotDispatchedError("local media load failed", {
      cause: new Error("missing file"),
    });
    renderReplyPayloadsToMessagesMock.mockReturnValue([{ mediaUrl: "/missing/file" }] as never);
    sendMSTeamsMessagesMock.mockRejectedValue(failure);
    const dispatcher = createDispatcher("groupchat", {
      streaming: { block: { enabled: false } },
    });

    const result = await dispatcher.delivery.deliver({ text: "attachment" }, { kind: "final" });
    const finalization = expect(result?.finalization).rejects.toBe(failure);
    await dispatcher.dispatcherOptions.onSettled?.();
    await finalization;
  });
});
