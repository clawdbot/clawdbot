import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

type StreamingSessionStub = {
  active: boolean;
  start: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  isActive: ReturnType<typeof vi.fn>;
};

const resolveFeishuAccountMock = vi.hoisted(() => vi.fn());
const getFeishuRuntimeMock = vi.hoisted(() => vi.fn());
const sendMessageFeishuMock = vi.hoisted(() => vi.fn());
const sendMarkdownCardFeishuMock = vi.hoisted(() => vi.fn());
const sendStructuredCardFeishuMock = vi.hoisted(() => vi.fn());
const sendMediaFeishuMock = vi.hoisted(() => vi.fn());
const createFeishuClientMock = vi.hoisted(() => vi.fn());
const resolveReceiveIdTypeMock = vi.hoisted(() => vi.fn());
const createReplyDispatcherWithTypingMock = vi.hoisted(() => vi.fn());
const addTypingIndicatorMock = vi.hoisted(() => vi.fn(async () => ({ messageId: "om_msg" })));
const removeTypingIndicatorMock = vi.hoisted(() => vi.fn(async () => {}));
const streamingInstances = vi.hoisted((): StreamingSessionStub[] => []);
const shouldSuppressFeishuTextForVoiceMediaMock = vi.hoisted(
  () => (params: { mediaUrl?: string; audioAsVoice?: boolean }) =>
    params.audioAsVoice === true || /\.(?:ogg|opus)(?:[?#]|$)/i.test(params.mediaUrl ?? ""),
);

function mergeStreamingText(
  previousText: string | undefined,
  nextText: string | undefined,
): string {
  const previous = typeof previousText === "string" ? previousText : "";
  const next = typeof nextText === "string" ? nextText : "";
  if (!next) {
    return previous;
  }
  if (!previous || next === previous) {
    return next;
  }
  if (next.startsWith(previous) || next.includes(previous)) {
    return next;
  }
  if (previous.startsWith(next) || previous.includes(next)) {
    return previous;
  }
  const maxOverlap = Math.min(previous.length, next.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    if (previous.slice(-overlap) === next.slice(0, overlap)) {
      return `${previous}${next.slice(overlap)}`;
    }
  }
  return `${previous}${next}`;
}

vi.mock("./accounts.js", () => ({
  resolveFeishuAccount: resolveFeishuAccountMock,
  resolveFeishuRuntimeAccount: resolveFeishuAccountMock,
}));
vi.mock("./runtime.js", () => ({ getFeishuRuntime: getFeishuRuntimeMock }));
vi.mock("./send.js", () => ({
  sendMessageFeishu: sendMessageFeishuMock,
  sendMarkdownCardFeishu: sendMarkdownCardFeishuMock,
  sendStructuredCardFeishu: sendStructuredCardFeishuMock,
}));
vi.mock("./media.js", () => ({
  sendMediaFeishu: sendMediaFeishuMock,
  shouldSuppressFeishuTextForVoiceMedia: shouldSuppressFeishuTextForVoiceMediaMock,
}));
vi.mock("./client.js", () => ({ createFeishuClient: createFeishuClientMock }));
vi.mock("./targets.js", () => ({ resolveReceiveIdType: resolveReceiveIdTypeMock }));
vi.mock("./typing.js", () => ({
  addTypingIndicator: addTypingIndicatorMock,
  removeTypingIndicator: removeTypingIndicatorMock,
}));
vi.mock("./streaming-card.js", () => {
  return {
    mergeStreamingText,
    FeishuStreamingSession: class {
      active = false;
      start = vi.fn(async () => {
        this.active = true;
      });
      update = vi.fn(async () => {});
      close = vi.fn(async () => {
        this.active = false;
      });
      isActive = vi.fn(() => this.active);

      constructor() {
        streamingInstances.push(this);
      }
    },
  };
});

import {
  clearFeishuStreamingStartBackoffForTests,
  createFeishuReplyDispatcher,
} from "./reply-dispatcher.js";

afterAll(() => {
  vi.doUnmock("./accounts.js");
  vi.doUnmock("./runtime.js");
  vi.doUnmock("./send.js");
  vi.doUnmock("./media.js");
  vi.doUnmock("./client.js");
  vi.doUnmock("./targets.js");
  vi.doUnmock("./typing.js");
  vi.doUnmock("./streaming-card.js");
  vi.resetModules();
});

describe("createFeishuReplyDispatcher streaming behavior", () => {
  type ReplyDispatcherArgs = Parameters<typeof createFeishuReplyDispatcher>[0];

  beforeEach(() => {
    vi.clearAllMocks();
    clearFeishuStreamingStartBackoffForTests();
    streamingInstances.length = 0;
    sendMediaFeishuMock.mockResolvedValue(undefined);
    sendStructuredCardFeishuMock.mockResolvedValue(undefined);

    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "auto",
        streaming: true,
      },
    });

    resolveReceiveIdTypeMock.mockReturnValue("chat_id");
    createFeishuClientMock.mockReturnValue({});

    createReplyDispatcherWithTypingMock.mockImplementation((opts) => ({
      dispatcher: {},
      replyOptions: {},
      markDispatchIdle: vi.fn(),
      _opts: opts,
    }));

    getFeishuRuntimeMock.mockReturnValue({
      channel: {
        text: {
          resolveTextChunkLimit: vi.fn(() => 4000),
          resolveChunkMode: vi.fn(() => "line"),
          resolveMarkdownTableMode: vi.fn(() => "preserve"),
          convertMarkdownTables: vi.fn((text) => text),
          chunkTextWithMode: vi.fn((text) => [text]),
        },
        reply: {
          createReplyDispatcherWithTyping: createReplyDispatcherWithTypingMock,
          resolveHumanDelayConfig: vi.fn(() => undefined),
        },
      },
    });
  });

  function setupNonStreamingAutoDispatcher() {
    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "auto",
        streaming: false,
      },
    });

    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
    });

    return createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
  }

  function createRuntimeLogger() {
    return { log: vi.fn(), error: vi.fn() } as never;
  }

  function createDispatcherHarness(overrides: Partial<ReplyDispatcherArgs> = {}) {
    const result = createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: {} as never,
      chatId: "oc_chat",
      ...overrides,
    });

    return {
      result,
      options: createReplyDispatcherWithTypingMock.mock.calls.at(-1)?.[0],
    };
  }

  it("skips typing indicator when account typingIndicator is disabled", async () => {
    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "auto",
        streaming: true,
        typingIndicator: false,
      },
    });

    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: {} as never,
      chatId: "oc_chat",
      replyToMessageId: "om_parent",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.onReplyStart?.();

    expect(addTypingIndicatorMock).not.toHaveBeenCalled();
  });

  it("skips typing indicator for stale replayed messages", async () => {
    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: {} as never,
      chatId: "oc_chat",
      replyToMessageId: "om_parent",
      messageCreateTimeMs: Date.now() - 3 * 60_000,
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.onReplyStart?.();

    expect(addTypingIndicatorMock).not.toHaveBeenCalled();
  });

  it("treats second-based timestamps as stale for typing suppression", async () => {
    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: {} as never,
      chatId: "oc_chat",
      replyToMessageId: "om_parent",
      messageCreateTimeMs: Math.floor((Date.now() - 3 * 60_000) / 1000),
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.onReplyStart?.();

    expect(addTypingIndicatorMock).not.toHaveBeenCalled();
  });

  it("keeps typing indicator for fresh messages", async () => {
    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: {} as never,
      chatId: "oc_chat",
      replyToMessageId: "om_parent",
      messageCreateTimeMs: Date.now() - 30_000,
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.onReplyStart?.();

    expect(addTypingIndicatorMock).toHaveBeenCalledTimes(1);
    expect(addTypingIndicatorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "om_parent",
      }),
    );
  });

  it("keeps auto mode plain text on non-streaming send path", async () => {
    const { options } = createDispatcherHarness();
    await options.deliver({ text: "plain text" }, { kind: "final" });

    expect(streamingInstances).toHaveLength(0);
    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMarkdownCardFeishuMock).not.toHaveBeenCalled();
  });

  it("suppresses internal block payload delivery", async () => {
    const { options } = createDispatcherHarness();
    await options.deliver({ text: "internal reasoning chunk" }, { kind: "block" });

    expect(streamingInstances).toHaveLength(0);
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(sendMarkdownCardFeishuMock).not.toHaveBeenCalled();
    expect(sendMediaFeishuMock).not.toHaveBeenCalled();
  });

  it("disables block streaming by default to prevent silent reply drops", () => {
    const result = createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: {} as never,
      chatId: "oc_chat",
    });

    expect(result.replyOptions).toHaveProperty("disableBlockStreaming", true);
  });

  it("enables core block streaming when Feishu blockStreaming is explicitly true", async () => {
    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "auto",
        streaming: true,
        blockStreaming: true,
      },
    });

    const { result, options } = createDispatcherHarness();
    expect(result.replyOptions).toHaveProperty("disableBlockStreaming", false);

    await options.deliver({ text: "plain block" }, { kind: "block" });
    await options.onIdle?.();

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].close).toHaveBeenCalledWith("plain block", {
      note: "Agent: agent",
    });
  });

  it("keeps core block streaming disabled when Feishu blockStreaming is explicitly false", () => {
    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "auto",
        streaming: true,
        blockStreaming: false,
      },
    });

    const result = createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: {} as never,
      chatId: "oc_chat",
    });

    expect(result.replyOptions).toHaveProperty("disableBlockStreaming", true);
  });

  it("uses streaming session for auto mode markdown payloads", async () => {
    const { options } = createDispatcherHarness({
      runtime: createRuntimeLogger(),
      rootId: "om_root_topic",
    });
    await options.deliver({ text: "```ts\nconst x = 1\n```" }, { kind: "final" });
    await options.onIdle?.();

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].start).toHaveBeenCalledTimes(1);
    expect(streamingInstances[0].start).toHaveBeenCalledWith(
      "oc_chat",
      "chat_id",
      expect.objectContaining({
        replyToMessageId: undefined,
        replyInThread: undefined,
        rootId: "om_root_topic",
        header: { title: "agent", template: "blue" },
        note: "Agent: agent",
      }),
    );
    expect(streamingInstances[0].close).toHaveBeenCalledTimes(1);
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(sendMarkdownCardFeishuMock).not.toHaveBeenCalled();
  });

  it("closes streaming with block text when final reply is missing", async () => {
    const { options } = createDispatcherHarness({
      runtime: createRuntimeLogger(),
    });
    await options.deliver({ text: "```md\npartial answer\n```" }, { kind: "block" });
    await options.onIdle?.();

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].start).toHaveBeenCalledTimes(1);
    expect(streamingInstances[0].close).toHaveBeenCalledTimes(1);
    expect(streamingInstances[0].close).toHaveBeenCalledWith("```md\npartial answer\n```", {
      note: "Agent: agent",
    });
  });

  it("coalesces distinct final payloads into one streaming card until idle", async () => {
    const { options } = createDispatcherHarness({
      runtime: createRuntimeLogger(),
    });
    await options.deliver({ text: "```md\n完整回复第一段\n```" }, { kind: "final" });
    await options.deliver({ text: "```md\n完整回复第一段 + 第二段\n```" }, { kind: "final" });
    await options.onIdle?.();

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].close).toHaveBeenCalledTimes(1);
    expect(streamingInstances[0].close).toHaveBeenCalledWith(
      "```md\n完整回复第一段 + 第二段\n```",
      {
        note: "Agent: agent",
      },
    );
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(sendMarkdownCardFeishuMock).not.toHaveBeenCalled();
  });

  it("skips exact duplicate final text after streaming close", async () => {
    const { options } = createDispatcherHarness({
      runtime: createRuntimeLogger(),
    });
    await options.deliver({ text: "```md\n同一条回复\n```" }, { kind: "final" });
    await options.onIdle?.();
    await options.deliver({ text: "```md\n同一条回复\n```" }, { kind: "final" });

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].close).toHaveBeenCalledTimes(1);
    expect(streamingInstances[0].close).toHaveBeenCalledWith("```md\n同一条回复\n```", {
      note: "Agent: agent",
    });
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(sendMarkdownCardFeishuMock).not.toHaveBeenCalled();
  });

  it("skips final text already closed by idle streaming", async () => {
    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "card",
        streaming: true,
      },
    });

    const { result, options } = createDispatcherHarness({
      runtime: createRuntimeLogger(),
    });

    await options.onReplyStart?.();
    result.replyOptions.onPartialReply?.({ text: "```md\nidle streamed reply\n```" });
    await options.onIdle?.();
    await options.deliver({ text: "```md\nidle streamed reply\n```" }, { kind: "final" });

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].close).toHaveBeenCalledTimes(1);
    expect(streamingInstances[0].close).toHaveBeenCalledWith("```md\nidle streamed reply\n```", {
      note: "Agent: agent",
    });
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(sendMarkdownCardFeishuMock).not.toHaveBeenCalled();
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
  });

  it("skips distinct late final text after streaming card close", async () => {
    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "card",
        streaming: true,
      },
    });

    const { options } = createDispatcherHarness({
      runtime: createRuntimeLogger(),
    });

    await options.deliver({ text: "First complete answer" }, { kind: "final" });
    await options.onIdle?.();
    await options.deliver(
      { text: "Late tool-result final", mediaUrl: "https://example.com/a.png" },
      { kind: "final" },
    );
    await options.onIdle?.();

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].close).toHaveBeenCalledTimes(1);
    expect(streamingInstances[0].close).toHaveBeenCalledWith("First complete answer", {
      note: "Agent: agent",
    });
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(sendMarkdownCardFeishuMock).not.toHaveBeenCalled();
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
    expect(sendMediaFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMediaFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaUrl: "https://example.com/a.png",
      }),
    );
  });

  it("suppresses duplicate final text while still sending media", async () => {
    const options = setupNonStreamingAutoDispatcher();
    await options.deliver({ text: "plain final" }, { kind: "final" });
    await options.deliver(
      { text: "plain final", mediaUrl: "https://example.com/a.png" },
      { kind: "final" },
    );

    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMessageFeishuMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        text: "plain final",
      }),
    );
    expect(sendMediaFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMediaFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaUrl: "https://example.com/a.png",
      }),
    );
  });

  it("keeps distinct non-streaming final payloads", async () => {
    const options = setupNonStreamingAutoDispatcher();
    await options.deliver({ text: "notice header" }, { kind: "final" });
    await options.deliver({ text: "actual answer body" }, { kind: "final" });

    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(2);
    expect(sendMessageFeishuMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ text: "notice header" }),
    );
    expect(sendMessageFeishuMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ text: "actual answer body" }),
    );
  });

  it("treats block updates as delta chunks", async () => {
    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "card",
        streaming: true,
      },
    });

    const { result, options } = createDispatcherHarness({
      runtime: createRuntimeLogger(),
    });
    await options.onReplyStart?.();
    result.replyOptions.onPartialReply?.({ text: "hello" });
    await options.deliver({ text: "lo world" }, { kind: "block" });
    await options.onIdle?.();

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].close).toHaveBeenCalledTimes(1);
    expect(streamingInstances[0].close).toHaveBeenCalledWith("hellolo world", {
      note: "Agent: agent",
    });
  });

  it("skips block payloads that exactly repeat the latest partial snapshot", async () => {
    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "card",
        streaming: true,
      },
    });

    const { result, options } = createDispatcherHarness({
      runtime: createRuntimeLogger(),
    });
    await options.onReplyStart?.();
    result.replyOptions.onPartialReply?.({ text: "```md\npartial\n```" });
    await options.deliver({ text: "```md\npartial\n```" }, { kind: "block" });
    await options.onIdle?.();

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].close).toHaveBeenCalledTimes(1);
    expect(streamingInstances[0].close).toHaveBeenCalledWith("```md\npartial\n```", {
      note: "Agent: agent",
    });
  });

  it("preserves previous generation blocks when partial snapshots reset after tools", async () => {
    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "card",
        streaming: true,
      },
    });

    const { result, options } = createDispatcherHarness({
      runtime: createRuntimeLogger(),
    });
    await options.onReplyStart?.();
    result.replyOptions.onPartialReply?.({
      text: "Preparing the lookup plan with enough text to count as one block.",
    });
    result.replyOptions.onPartialReply?.({ text: "Found" });
    result.replyOptions.onPartialReply?.({ text: "Found the answer." });
    await options.onIdle?.();

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].close).toHaveBeenCalledWith(
      "Preparing the lookup plan with enough text to count as one block.Found the answer.",
      {
        note: "Agent: agent",
      },
    );
  });

  it("strips reasoning tags from streamed partial snapshots", async () => {
    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "card",
        streaming: true,
      },
    });

    const { result, options } = createDispatcherHarness({
      runtime: createRuntimeLogger(),
    });
    await options.onReplyStart?.();
    result.replyOptions.onPartialReply?.({
      text: "<thinking>private chain of thought</thinking>\nvisible answer",
    });
    await options.onIdle?.();

    expect(streamingInstances[0].close).toHaveBeenCalledWith("visible answer", {
      note: "Agent: agent",
    });
  });

  it("sends media-only payloads as attachments", async () => {
    const { options } = createDispatcherHarness();
    await options.deliver({ mediaUrl: "https://example.com/a.png" }, { kind: "final" });

    expect(sendMediaFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMediaFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "oc_chat",
        mediaUrl: "https://example.com/a.png",
      }),
    );
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(sendMarkdownCardFeishuMock).not.toHaveBeenCalled();
  });

  it("passes audioAsVoice to media attachments", async () => {
    const { options } = createDispatcherHarness();
    await options.deliver(
      { mediaUrl: "https://example.com/reply.mp3", audioAsVoice: true },
      { kind: "final" },
    );

    expect(sendMediaFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaUrl: "https://example.com/reply.mp3",
        audioAsVoice: true,
      }),
    );
  });

  it("suppresses duplicate text when final replies send voice media", async () => {
    const { options } = createDispatcherHarness();
    await options.deliver(
      {
        text: "spoken reply",
        mediaUrl: "https://example.com/reply.mp3",
        audioAsVoice: true,
      },
      { kind: "final" },
    );

    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
    expect(sendMediaFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMediaFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaUrl: "https://example.com/reply.mp3",
        audioAsVoice: true,
      }),
    );
  });

  it("sends skipped voice text when final voice media degrades to a file attachment", async () => {
    sendMediaFeishuMock.mockResolvedValueOnce({
      messageId: "file_msg",
      voiceIntentDegradedToFile: true,
    });

    const { options } = createDispatcherHarness();
    await options.deliver(
      {
        text: "spoken reply",
        mediaUrl: "https://example.com/reply.mp3",
        audioAsVoice: true,
      },
      { kind: "final" },
    );

    expect(sendMediaFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMediaFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaUrl: "https://example.com/reply.mp3",
        audioAsVoice: true,
      }),
    );
    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "spoken reply",
      }),
    );
  });

  it("suppresses duplicate text for native voice media without audioAsVoice", async () => {
    const { options } = createDispatcherHarness();
    await options.deliver(
      {
        text: "spoken reply",
        mediaUrl: "https://example.com/reply.opus?download=1",
      },
      { kind: "final" },
    );

    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(sendMediaFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMediaFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaUrl: "https://example.com/reply.opus?download=1",
      }),
    );
  });

  it("preserves captions for regular audio attachments", async () => {
    const { options } = createDispatcherHarness();
    await options.deliver(
      {
        text: "caption text",
        mediaUrl: "https://example.com/song.mp3",
      },
      { kind: "final" },
    );

    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "caption text",
      }),
    );
    expect(sendMediaFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMediaFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaUrl: "https://example.com/song.mp3",
      }),
    );
  });

  it("keeps skipped voice text in the upload failure fallback", async () => {
    sendMediaFeishuMock.mockRejectedValueOnce(new Error("media failed"));

    const { options } = createDispatcherHarness();
    await options.deliver(
      {
        text: "spoken reply",
        mediaUrl: "https://example.com/reply.mp3",
        audioAsVoice: true,
      },
      { kind: "final" },
    );

    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "spoken reply\n\n📎 https://example.com/reply.mp3",
      }),
    );
  });

  it("falls back to legacy mediaUrl when mediaUrls is an empty array", async () => {
    const { options } = createDispatcherHarness();
    await options.deliver(
      { text: "caption", mediaUrl: "https://example.com/a.png", mediaUrls: [] },
      { kind: "final" },
    );

    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMediaFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMediaFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaUrl: "https://example.com/a.png",
      }),
    );
  });

  it("sends attachments after streaming final markdown replies", async () => {
    const { options } = createDispatcherHarness({
      runtime: createRuntimeLogger(),
    });
    await options.deliver(
      { text: "```ts\nconst x = 1\n```", mediaUrls: ["https://example.com/a.png"] },
      { kind: "final" },
    );
    await options.onIdle?.();

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].start).toHaveBeenCalledTimes(1);
    expect(streamingInstances[0].close).toHaveBeenCalledTimes(1);
    expect(sendMediaFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMediaFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaUrl: "https://example.com/a.png",
      }),
    );
  });

  it("passes replyInThread to sendMessageFeishu for plain text", async () => {
    const { options } = createDispatcherHarness({
      replyToMessageId: "om_msg",
      replyInThread: true,
    });
    await options.deliver({ text: "plain text" }, { kind: "final" });

    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        replyToMessageId: "om_msg",
        replyInThread: true,
      }),
    );
  });

  it("passes replyInThread to sendStructuredCardFeishu for card text", async () => {
    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "card",
        streaming: false,
      },
    });

    const { options } = createDispatcherHarness({
      replyToMessageId: "om_msg",
      replyInThread: true,
    });
    await options.deliver({ text: "card text" }, { kind: "final" });

    expect(sendStructuredCardFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        replyToMessageId: "om_msg",
        replyInThread: true,
      }),
    );
  });

  it("streams reasoning content as blockquote before answer", async () => {
    const { result, options } = createDispatcherHarness({
      runtime: createRuntimeLogger(),
      allowReasoningPreview: true,
    });

    await options.onReplyStart?.();
    result.replyOptions.onReasoningStream?.({ text: "thinking step 1" });
    result.replyOptions.onReasoningStream?.({
      text: "thinking step 1\nstep 2",
    });
    result.replyOptions.onPartialReply?.({ text: "answer part" });
    result.replyOptions.onReasoningEnd?.();
    await options.deliver({ text: "answer part final" }, { kind: "final" });
    await options.onIdle?.();

    expect(streamingInstances).toHaveLength(1);
    const updateCalls = streamingInstances[0].update.mock.calls.map((c: unknown[]) =>
      typeof c[0] === "string" ? c[0] : "",
    );
    const reasoningUpdate = updateCalls.find((c) => c.includes("Thinking"));
    expect(reasoningUpdate).toContain("> 💭 **Thinking**");
    // formatReasoningPrefix strips "Reasoning:" prefix and italic markers
    expect(reasoningUpdate).toContain("> thinking step");
    expect(reasoningUpdate).not.toContain("Reasoning:");
    expect(reasoningUpdate).not.toMatch(/> _.*_/);

    const combinedUpdate = updateCalls.find((c) => c.includes("Thinking") && c.includes("---"));
    if (!combinedUpdate) {
      throw new Error("expected combined reasoning and final-answer streaming update");
    }

    expect(streamingInstances[0].close).toHaveBeenCalledTimes(1);
    const closeArg = streamingInstances[0].close.mock.calls[0][0] as string;
    expect(closeArg).toContain("> 💭 **Thinking**");
    expect(closeArg).toContain("---");
    expect(closeArg).toContain("answer part final");
  });

  it("provides onReasoningStream and onReasoningEnd when reasoning previews are allowed", () => {
    const { result } = createDispatcherHarness({
      runtime: createRuntimeLogger(),
      allowReasoningPreview: true,
    });

    expect(result.replyOptions.onReasoningStream).toBeTypeOf("function");
    expect(result.replyOptions.onReasoningEnd).toBeTypeOf("function");
  });

  it("omits reasoning callbacks unless reasoning previews are allowed", () => {
    const { result } = createDispatcherHarness({
      runtime: createRuntimeLogger(),
    });

    expect(result.replyOptions.onReasoningStream).toBeUndefined();
    expect(result.replyOptions.onReasoningEnd).toBeUndefined();
  });

  it("omits reasoning callbacks when streaming is disabled", () => {
    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "auto",
        streaming: false,
      },
    });

    const { result } = createDispatcherHarness({
      runtime: createRuntimeLogger(),
    });

    expect(result.replyOptions.onReasoningStream).toBeUndefined();
    expect(result.replyOptions.onReasoningEnd).toBeUndefined();
  });

  it("renders reasoning-only card when no answer text arrives", async () => {
    const { result, options } = createDispatcherHarness({
      runtime: createRuntimeLogger(),
      allowReasoningPreview: true,
    });

    await options.onReplyStart?.();
    result.replyOptions.onReasoningStream?.({ text: "deep thought" });
    result.replyOptions.onReasoningEnd?.();
    await options.onIdle?.();

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].close).toHaveBeenCalledTimes(1);
    const closeArg = streamingInstances[0].close.mock.calls[0][0] as string;
    expect(closeArg).toContain("> 💭 **Thinking**");
    expect(closeArg).toContain("> deep thought");
    expect(closeArg).not.toContain("Reasoning:");
    expect(closeArg).not.toContain("---");
  });

  it("ignores empty reasoning payloads", async () => {
    const { result, options } = createDispatcherHarness({
      runtime: createRuntimeLogger(),
      allowReasoningPreview: true,
    });

    await options.onReplyStart?.();
    result.replyOptions.onReasoningStream?.({ text: "" });
    result.replyOptions.onPartialReply?.({ text: "```ts\ncode\n```" });
    await options.deliver({ text: "```ts\ncode\n```" }, { kind: "final" });
    await options.onIdle?.();

    expect(streamingInstances).toHaveLength(1);
    const closeArg = streamingInstances[0].close.mock.calls[0][0] as string;
    expect(closeArg).not.toContain("Thinking");
    expect(closeArg).toBe("```ts\ncode\n```");
  });

  it("deduplicates final text by raw answer payload, not combined card text", async () => {
    const { result, options } = createDispatcherHarness({
      runtime: createRuntimeLogger(),
      allowReasoningPreview: true,
    });

    await options.onReplyStart?.();
    result.replyOptions.onReasoningStream?.({ text: "thought" });
    result.replyOptions.onReasoningEnd?.();
    await options.deliver({ text: "```ts\nfinal answer\n```" }, { kind: "final" });
    await options.onIdle?.();

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].close).toHaveBeenCalledTimes(1);

    // Deliver the same raw answer text again — should be deduped
    await options.deliver({ text: "```ts\nfinal answer\n```" }, { kind: "final" });

    // No second streaming session since the raw answer text matches
    expect(streamingInstances).toHaveLength(1);
  });

  it("passes replyToMessageId and replyInThread to streaming.start()", async () => {
    const { options } = createDispatcherHarness({
      runtime: createRuntimeLogger(),
      replyToMessageId: "om_msg",
      replyInThread: true,
    });
    await options.deliver({ text: "```ts\nconst x = 1\n```" }, { kind: "final" });

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].start).toHaveBeenCalledWith(
      "oc_chat",
      "chat_id",
      expect.objectContaining({
        replyToMessageId: "om_msg",
        replyInThread: true,
        header: { title: "agent", template: "blue" },
        note: "Agent: agent",
      }),
    );
  });

  it("uses streaming cards for thread replies and keeps topic metadata", async () => {
    const { options } = createDispatcherHarness({
      runtime: createRuntimeLogger(),
      replyToMessageId: "om_msg",
      replyInThread: false,
      threadReply: true,
      rootId: "om_root_topic",
    });
    await options.deliver({ text: "```ts\nconst x = 1\n```" }, { kind: "final" });

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].start).toHaveBeenCalledWith(
      "oc_chat",
      "chat_id",
      expect.objectContaining({
        replyToMessageId: "om_msg",
        replyInThread: true,
        rootId: "om_root_topic",
      }),
    );
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
  });

  it("omits the generic main header from streaming and static cards", async () => {
    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "card",
        streaming: true,
      },
    });

    const { options } = createDispatcherHarness({
      agentId: "main",
      runtime: createRuntimeLogger(),
    });
    await options.deliver({ text: "streamed card" }, { kind: "final" });
    await options.onIdle?.();

    expect(streamingInstances[0].start).toHaveBeenCalledWith(
      "oc_chat",
      "chat_id",
      expect.objectContaining({
        header: undefined,
      }),
    );

    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "card",
        streaming: false,
      },
    });

    const { options: staticOptions } = createDispatcherHarness({
      agentId: "main",
      runtime: createRuntimeLogger(),
    });
    await staticOptions.deliver({ text: "static card" }, { kind: "final" });

    expect(sendStructuredCardFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        header: undefined,
      }),
    );
  });

  it("shows shared transient tool status on streaming cards but omits it from the final close", async () => {
    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "card",
        streaming: true,
      },
    });

    const { result, options } = createDispatcherHarness({
      runtime: createRuntimeLogger(),
    });
    await options.onReplyStart?.();
    result.replyOptions.onToolStart?.({ name: "web_search" });
    result.replyOptions.onPartialReply?.({ text: "final answer" });
    await options.onIdle?.();

    const updateTexts = streamingInstances[0].update.mock.calls.map((call: unknown[]) =>
      typeof call[0] === "string" ? call[0] : "",
    );
    expect(updateTexts).toEqual(expect.arrayContaining([expect.stringContaining("🔎 Web Search")]));
    expect(streamingInstances[0].close).toHaveBeenCalledWith("final answer", {
      note: "Agent: agent",
    });
  });

  it("shows raw command detail in streaming card tool status", async () => {
    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "card",
        streaming: true,
      },
    });

    const { result, options } = createDispatcherHarness({
      runtime: createRuntimeLogger(),
    });
    await options.onReplyStart?.();
    result.replyOptions.onToolStart?.({
      name: "exec",
      args: { command: "pnpm test -- --watch=false" },
      detailMode: "raw",
    });
    result.replyOptions.onPartialReply?.({ text: "final answer" });
    await options.onIdle?.();

    const updateTexts = streamingInstances[0].update.mock.calls.map((call: unknown[]) =>
      typeof call[0] === "string" ? call[0] : "",
    );
    expect(updateTexts).toEqual(
      expect.arrayContaining([
        expect.stringContaining("🛠️ Exec: run tests, `pnpm test -- --watch=false`"),
      ]),
    );
  });

  it("omits message-like tools from streaming card status", async () => {
    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "card",
        streaming: true,
      },
    });

    const { result, options } = createDispatcherHarness({
      runtime: createRuntimeLogger(),
    });
    await options.onReplyStart?.();
    result.replyOptions.onToolStart?.({ name: "message" });
    result.replyOptions.onPartialReply?.({ text: "final answer" });
    await options.onIdle?.();

    const updateTexts = streamingInstances[0].update.mock.calls.map((call: unknown[]) =>
      typeof call[0] === "string" ? call[0] : "",
    );
    expect(updateTexts).not.toEqual(expect.arrayContaining([expect.stringContaining("Message")]));
  });

  it("does not suppress a later final after error closeout", async () => {
    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "card",
        streaming: true,
      },
    });
    sendMediaFeishuMock.mockRejectedValueOnce(new Error("media failed"));

    const { options } = createDispatcherHarness({
      runtime: createRuntimeLogger(),
    });

    await expect(
      options.deliver(
        { text: "First answer", mediaUrl: "https://example.com/a.png" },
        { kind: "final" },
      ),
    ).rejects.toThrow("media failed");
    await Promise.all([
      options.onError?.(new Error("media failed"), { kind: "final" }),
      options.onIdle?.(),
    ]);
    await options.deliver({ text: "Second answer" }, { kind: "final" });
    await options.onIdle?.();

    expect(streamingInstances).toHaveLength(2);
    expect(streamingInstances[0].close).toHaveBeenCalledWith("First answer", {
      note: "Agent: agent",
    });
    expect(streamingInstances[1].close).toHaveBeenCalledWith("Second answer", {
      note: "Agent: agent",
    });
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
  });

  it("does not suppress a recovery final after late media failure", async () => {
    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "card",
        streaming: true,
      },
    });

    const { options } = createDispatcherHarness({
      runtime: createRuntimeLogger(),
    });

    await options.deliver({ text: "First answer" }, { kind: "final" });
    await options.onIdle?.();
    sendMediaFeishuMock.mockRejectedValueOnce(new Error("media failed"));
    await expect(
      options.deliver(
        { text: "Late attachment", mediaUrl: "https://example.com/a.png" },
        { kind: "final" },
      ),
    ).rejects.toThrow("media failed");
    await options.onError?.(new Error("media failed"), { kind: "final" });
    await options.deliver({ text: "Recovered answer" }, { kind: "final" });
    await options.onIdle?.();

    expect(streamingInstances).toHaveLength(2);
    expect(streamingInstances[0].close).toHaveBeenCalledWith("First answer", {
      note: "Agent: agent",
    });
    expect(streamingInstances[1].close).toHaveBeenCalledWith("Recovered answer", {
      note: "Agent: agent",
    });
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
  });

  it("cleans streaming state even when close throws", async () => {
    const origPush = streamingInstances.push.bind(streamingInstances);
    streamingInstances.push = (...args: StreamingSessionStub[]) => {
      if (args.length > 0 && streamingInstances.length === 0) {
        args[0].close = vi.fn(async () => {
          args[0].active = false;
          throw new Error("close failed");
        });
      }
      return origPush(...args);
    };

    try {
      const { options } = createDispatcherHarness({
        runtime: createRuntimeLogger(),
      });
      await options.deliver({ text: "```md\nfirst\n```" }, { kind: "final" });
      await expect(options.onIdle?.()).rejects.toThrow("close failed");
      await options.deliver({ text: "```md\nsecond\n```" }, { kind: "final" });
      await options.onIdle?.();

      expect(streamingInstances).toHaveLength(2);
      expect(streamingInstances[1].close).toHaveBeenCalledWith("```md\nsecond\n```", {
        note: "Agent: agent",
      });
    } finally {
      streamingInstances.push = origPush;
    }
  });

  it("passes replyInThread to media attachments", async () => {
    const { options } = createDispatcherHarness({
      replyToMessageId: "om_msg",
      replyInThread: true,
    });
    await options.deliver({ mediaUrl: "https://example.com/a.png" }, { kind: "final" });

    expect(sendMediaFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        replyToMessageId: "om_msg",
        replyInThread: true,
      }),
    );
  });

  it("backs off streaming retries after start() throws (HTTP 400)", async () => {
    const errorMock = vi.fn();
    let shouldFailStart = true;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);

    // Intercept streaming instance creation to make first start() reject
    const origPush = streamingInstances.push.bind(streamingInstances);
    streamingInstances.push = (...args: StreamingSessionStub[]) => {
      if (shouldFailStart) {
        args[0].start = vi
          .fn()
          .mockRejectedValue(new Error("Create card request failed with HTTP 400"));
        shouldFailStart = false;
      }
      return origPush(...args);
    };

    try {
      createFeishuReplyDispatcher({
        cfg: {} as never,
        agentId: "agent",
        runtime: { log: vi.fn(), error: errorMock } as never,
        chatId: "oc_chat",
      });

      const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];

      // First deliver with markdown triggers startStreaming - which will fail
      await options.deliver({ text: "```ts\nconst x = 1\n```" }, { kind: "final" });

      // Wait for the async error to propagate
      await vi.waitFor(() => {
        expect(errorMock).toHaveBeenCalledWith(expect.stringContaining("streaming start failed"));
      });
      expect(streamingInstances).toHaveLength(1);
      expect(sendStructuredCardFeishuMock).toHaveBeenCalledTimes(1);

      // Immediate next markdown reply should skip a new streaming start and
      // fall back directly to a normal card instead of paying the 400 latency.
      await options.deliver({ text: "```ts\nconst y = 2\n```" }, { kind: "final" });

      expect(streamingInstances).toHaveLength(1);
      expect(sendStructuredCardFeishuMock).toHaveBeenCalledTimes(2);

      // After the short backoff expires, retry streaming so fixed permissions
      // or transient Feishu failures recover without a process restart.
      nowSpy.mockReturnValue(62_000);
      await options.deliver({ text: "```ts\nconst z = 3\n```" }, { kind: "final" });
      await options.onIdle?.();

      expect(streamingInstances).toHaveLength(2);
      expect(streamingInstances[1].start).toHaveBeenCalled();
      expect(streamingInstances[1].close).toHaveBeenCalled();
    } finally {
      streamingInstances.push = origPush;
      nowSpy.mockRestore();
    }
  });
});
