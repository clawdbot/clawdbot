import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const FINAL_REPLY_TEXT = "final answer";
const THREAD_TS = "thread-1";
const SAME_TEXT = "same reply";

const createSlackDraftStreamMock = vi.fn();
const deliverRepliesMock = vi.fn(async () => {});
const finalizeSlackPreviewEditMock = vi.fn(async () => {});
const postMessageMock = vi.fn(async () => ({ ok: true, ts: "171234.999" }));
const appendSlackStreamMock = vi.fn(async () => {});
const startSlackStreamMock = vi.fn(async () => ({
  channel: "C123",
  threadTs: THREAD_TS,
  stopped: false,
  delivered: true,
  pendingText: "",
}));
const stopSlackStreamMock = vi.fn(async () => {});
class TestSlackStreamNotDeliveredError extends Error {
  readonly pendingText: string;
  readonly slackCode: string;
  constructor(pendingText: string, slackCode: string) {
    super(`slack-stream not delivered: ${slackCode}`);
    this.name = "SlackStreamNotDeliveredError";
    this.pendingText = pendingText;
    this.slackCode = slackCode;
  }
}
let mockedNativeStreaming = false;
let mockedBlockStreamingEnabled: boolean | undefined = false;
let capturedReplyOptions: { disableBlockStreaming?: boolean } | undefined;
let mockedReplyThreadTs: string | undefined = THREAD_TS;
let mockedReplyThreadTsSequence: Array<string | undefined> | undefined;
let mockedDispatchSequence: Array<{
  kind: "tool" | "block" | "final";
  payload: {
    text: string;
    isError?: boolean;
    isReasoning?: boolean;
    mediaUrl?: string;
    mediaUrls?: string[];
  };
}> = [];
let mockedProgressEvents: string[] = [];

const noop = () => {};
const noopAsync = async () => {};

function createDraftStreamStub() {
  return {
    update: vi.fn(),
    flush: noopAsync,
    clear: noopAsync,
    discardPending: noopAsync,
    seal: noopAsync,
    stop: noop,
    forceNewMessage: noop,
    messageId: () => "171234.567",
    channelId: () => "C123",
  };
}

function createPreparedSlackMessage(params?: {
  message?: Partial<{
    channel: string;
    ts: string;
    thread_ts?: string;
    user: string;
  }>;
  replyToMode?: "off" | "first" | "all" | "batched";
}) {
  return {
    ctx: {
      cfg: {},
      runtime: {},
      botToken: "xoxb-test",
      app: { client: { chat: { postMessage: postMessageMock } } },
      teamId: "T1",
      textLimit: 4000,
      typingReaction: "",
      removeAckAfterReply: false,
      historyLimit: 0,
      channelHistories: new Map(),
      allowFrom: [],
      setSlackThreadStatus: async () => undefined,
    },
    account: {
      accountId: "default",
      config: {},
    },
    message: {
      channel: "C123",
      ts: "171234.111",
      thread_ts: THREAD_TS,
      user: "U123",
      ...params?.message,
    },
    route: {
      agentId: "agent-1",
      accountId: "default",
      mainSessionKey: "main",
    },
    channelConfig: null,
    replyTarget: "channel:C123",
    ctxPayload: {
      MessageThreadId: THREAD_TS,
    },
    replyToMode: params?.replyToMode ?? "all",
    isDirectMessage: false,
    isRoomish: false,
    historyKey: "history-key",
    preview: "",
    ackReactionValue: "eyes",
    ackReactionPromise: null,
  } as never;
}

vi.mock("openclaw/plugin-sdk/agent-runtime", () => ({
  resolveHumanDelayConfig: () => undefined,
}));

vi.mock("openclaw/plugin-sdk/channel-feedback", () => ({
  DEFAULT_TIMING: {
    doneHoldMs: 0,
    errorHoldMs: 0,
  },
  createStatusReactionController: () => ({
    setQueued: async () => {},
    setThinking: async () => {},
    setTool: async () => {},
    setError: async () => {},
    setDone: async () => {},
    clear: async () => {},
    restoreInitial: async () => {},
  }),
  logAckFailure: () => {},
  logTypingFailure: () => {},
  removeAckReactionAfterReply: () => {},
}));

vi.mock("openclaw/plugin-sdk/channel-reply-pipeline", () => ({
  createChannelReplyPipeline: () => ({
    typingCallbacks: {
      onIdle: vi.fn(),
    },
    onModelSelected: undefined,
  }),
}));

vi.mock("openclaw/plugin-sdk/channel-streaming", () => ({
  resolveChannelStreamingBlockEnabled: () => mockedBlockStreamingEnabled,
  resolveChannelStreamingNativeTransport: () => mockedNativeStreaming,
  resolveChannelStreamingPreviewToolProgress: () => true,
}));

vi.mock("openclaw/plugin-sdk/outbound-runtime", () => ({
  resolveAgentOutboundIdentity: () => undefined,
}));

vi.mock("openclaw/plugin-sdk/reply-history", () => ({
  clearHistoryEntriesIfEnabled: () => {},
}));

vi.mock("openclaw/plugin-sdk/reply-payload", () => ({
  resolveSendableOutboundReplyParts: (
    payload: { text?: string; mediaUrl?: string; mediaUrls?: string[] },
    opts?: { text?: string },
  ) => {
    const text = (opts?.text ?? payload.text ?? "").trim();
    const mediaUrls = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
    return {
      text,
      trimmedText: text,
      hasText: text.length > 0,
      hasMedia: mediaUrls.length > 0,
      mediaUrls,
      hasContent: text.length > 0 || mediaUrls.length > 0,
    };
  },
}));

vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  danger: (message: string) => message,
  logVerbose: () => {},
  shouldLogVerbose: () => false,
}));

vi.mock("openclaw/plugin-sdk/security-runtime", () => ({
  resolvePinnedMainDmOwnerFromAllowlist: () => undefined,
}));

vi.mock("openclaw/plugin-sdk/text-runtime", () => ({
  normalizeOptionalLowercaseString: (value?: string) => value?.toLowerCase(),
}));

vi.mock("../../actions.js", () => ({
  reactSlackMessage: async () => {},
  removeSlackReaction: async () => {},
}));

vi.mock("../../draft-stream.js", () => ({
  createSlackDraftStream: createSlackDraftStreamMock,
}));

vi.mock("../../format.js", () => ({
  normalizeSlackOutboundText: (value: string) => value.trim(),
}));

vi.mock("../../limits.js", () => ({
  SLACK_TEXT_LIMIT: 4000,
}));

vi.mock("../../sent-thread-cache.js", () => ({
  recordSlackThreadParticipation: () => {},
}));

vi.mock("../../stream-mode.js", () => ({
  applyAppendOnlyStreamUpdate: ({ incoming }: { incoming: string }) => ({
    changed: true,
    rendered: incoming,
    source: incoming,
  }),
  buildStatusFinalPreviewText: () => "status",
  resolveSlackStreamingConfig: () => ({
    mode: "partial",
    nativeStreaming: mockedNativeStreaming,
    draftMode: "append",
  }),
}));

vi.mock("../../streaming.js", () => ({
  appendSlackStream: appendSlackStreamMock,
  markSlackStreamFallbackDelivered: (session: {
    delivered: boolean;
    pendingText: string;
    stopped: boolean;
  }) => {
    const hadNativeDelivery = session.delivered;
    session.delivered = true;
    session.pendingText = "";
    if (!hadNativeDelivery) {
      session.stopped = true;
    }
  },
  SlackStreamNotDeliveredError: TestSlackStreamNotDeliveredError,
  startSlackStream: startSlackStreamMock,
  stopSlackStream: stopSlackStreamMock,
}));

vi.mock("../../threading.js", () => ({
  resolveSlackThreadTargets: () => ({
    statusThreadTs: THREAD_TS,
    isThreadReply: true,
  }),
}));

vi.mock("../allow-list.js", () => ({
  normalizeSlackAllowOwnerEntry: (value: string) => value,
}));

vi.mock("../config.runtime.js", () => ({
  resolveStorePath: () => "/tmp/openclaw-store.json",
  updateLastRoute: async () => {},
}));

vi.mock("../replies.js", () => ({
  createSlackReplyDeliveryPlan: () => ({
    peekThreadTs: () => mockedReplyThreadTsSequence?.[0] ?? mockedReplyThreadTs,
    nextThreadTs: () =>
      mockedReplyThreadTsSequence ? mockedReplyThreadTsSequence.shift() : mockedReplyThreadTs,
    markSent: () => {},
  }),
  deliverReplies: deliverRepliesMock,
  readSlackReplyBlocks: () => undefined,
  resolveDeliveredSlackReplyThreadTs: (params: {
    replyToMode: "off" | "first" | "all" | "batched";
    payloadReplyToId?: string;
    replyThreadTs?: string;
  }) =>
    (params.replyToMode === "off" ? undefined : params.payloadReplyToId) ?? params.replyThreadTs,
  resolveSlackThreadTs: () => mockedReplyThreadTs,
}));

vi.mock("../reply.runtime.js", () => ({
  createReplyDispatcherWithTyping: (params: {
    deliver: (payload: unknown, info: { kind: "tool" | "block" | "final" }) => Promise<void>;
  }) => ({
    dispatcher: {
      deliver: params.deliver,
    },
    replyOptions: {},
    markDispatchIdle: () => {},
  }),
  dispatchInboundMessage: async (params: {
    replyOptions?: {
      disableBlockStreaming?: boolean;
      onItemEvent?: (payload: { progressText: string }) => Promise<void> | void;
    };
    dispatcher: {
      deliver: (
        payload: {
          text: string;
          isError?: boolean;
          isReasoning?: boolean;
          mediaUrl?: string;
          mediaUrls?: string[];
        },
        info: { kind: "tool" | "block" | "final" },
      ) => Promise<void>;
    };
  }) => {
    capturedReplyOptions = params.replyOptions;
    for (const progressText of mockedProgressEvents) {
      await params.replyOptions?.onItemEvent?.({ progressText });
    }
    for (const entry of mockedDispatchSequence) {
      await params.dispatcher.deliver(entry.payload, { kind: entry.kind });
    }
    return {
      queuedFinal: false,
      counts: {
        final: mockedDispatchSequence.filter((entry) => entry.kind === "final").length,
      },
    };
  },
}));

vi.mock("./preview-finalize.js", () => ({
  finalizeSlackPreviewEdit: finalizeSlackPreviewEditMock,
}));

let dispatchPreparedSlackMessage: typeof import("./dispatch.js").dispatchPreparedSlackMessage;

describe("dispatchPreparedSlackMessage preview fallback", () => {
  beforeAll(async () => {
    ({ dispatchPreparedSlackMessage } = await import("./dispatch.js"));
  });

  beforeEach(() => {
    createSlackDraftStreamMock.mockReset();
    deliverRepliesMock.mockReset();
    finalizeSlackPreviewEditMock.mockReset();
    postMessageMock.mockClear();
    appendSlackStreamMock.mockReset();
    startSlackStreamMock.mockReset();
    stopSlackStreamMock.mockReset();
    mockedNativeStreaming = false;
    mockedBlockStreamingEnabled = false;
    capturedReplyOptions = undefined;
    mockedReplyThreadTs = THREAD_TS;
    mockedReplyThreadTsSequence = undefined;
    mockedDispatchSequence = [{ kind: "final", payload: { text: FINAL_REPLY_TEXT } }];
    mockedProgressEvents = [];

    createSlackDraftStreamMock.mockReturnValue(createDraftStreamStub());
    finalizeSlackPreviewEditMock.mockRejectedValue(new Error("socket closed"));
    startSlackStreamMock.mockResolvedValue({
      channel: "C123",
      threadTs: THREAD_TS,
      stopped: false,
      delivered: true,
      pendingText: "",
    });
    appendSlackStreamMock.mockResolvedValue(undefined);
    stopSlackStreamMock.mockResolvedValue(undefined);
  });

  it("falls back to normal delivery when preview finalize fails", async () => {
    await dispatchPreparedSlackMessage(createPreparedSlackMessage());

    expect(finalizeSlackPreviewEditMock).toHaveBeenCalledTimes(1);
    expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
    expect(deliverRepliesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        replyThreadTs: THREAD_TS,
        replies: [expect.objectContaining({ text: FINAL_REPLY_TEXT })],
      }),
    );
  });

  it("finalizes fast draft preview text without sending a duplicate normal reply", async () => {
    const draftStream = {
      ...createDraftStreamStub(),
      flush: vi.fn(noopAsync),
      clear: vi.fn(noopAsync),
      discardPending: vi.fn(noopAsync),
      seal: vi.fn(noopAsync),
    };
    createSlackDraftStreamMock.mockReturnValueOnce(draftStream);
    finalizeSlackPreviewEditMock.mockResolvedValueOnce(undefined);
    mockedDispatchSequence = [{ kind: "final", payload: { text: "✅" } }];

    await dispatchPreparedSlackMessage(createPreparedSlackMessage());

    expect(draftStream.flush).toHaveBeenCalledTimes(1);
    expect(draftStream.seal).toHaveBeenCalledTimes(1);
    expect(finalizeSlackPreviewEditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "C123",
        messageId: "171234.567",
        text: "✅",
      }),
    );
    expect(deliverRepliesMock).not.toHaveBeenCalled();
    expect(draftStream.clear).not.toHaveBeenCalled();
  });

  it("suppresses block streaming when Slack draft preview streaming is active", async () => {
    mockedBlockStreamingEnabled = true;

    await dispatchPreparedSlackMessage(createPreparedSlackMessage());

    expect(capturedReplyOptions?.disableBlockStreaming).toBe(true);
  });

  it("escapes Slack mrkdwn in tool progress preview labels", async () => {
    const draftStream = createDraftStreamStub();
    createSlackDraftStreamMock.mockReturnValueOnce(draftStream);
    mockedDispatchSequence = [];
    mockedProgressEvents = ["ran <!here> <@U123> *bold* `code` & done"];

    await dispatchPreparedSlackMessage(createPreparedSlackMessage());

    expect(draftStream.update).toHaveBeenCalledWith(
      "Working…\n• ran &lt;!here&gt; &lt;@U123&gt; \\*bold\\* \\`code\\` &amp; done",
    );
  });

  it("starts native streams in the first-reply thread for top-level channel messages", async () => {
    mockedNativeStreaming = true;
    mockedReplyThreadTs = "171234.111";
    mockedDispatchSequence = [{ kind: "final", payload: { text: FINAL_REPLY_TEXT } }];

    await dispatchPreparedSlackMessage(
      createPreparedSlackMessage({
        message: { thread_ts: undefined },
        replyToMode: "all",
      }),
    );

    expect(startSlackStreamMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C123",
        threadTs: "171234.111",
        text: FINAL_REPLY_TEXT,
      }),
    );
    expect(deliverRepliesMock).not.toHaveBeenCalled();
  });

  it("suppresses reasoning payloads before Slack native streaming delivery", async () => {
    mockedNativeStreaming = true;
    mockedDispatchSequence = [
      { kind: "block", payload: { text: "Reasoning:\n_hidden_", isReasoning: true } },
      { kind: "final", payload: { text: FINAL_REPLY_TEXT } },
    ];

    await dispatchPreparedSlackMessage(createPreparedSlackMessage());

    expect(startSlackStreamMock).toHaveBeenCalledTimes(1);
    expect(startSlackStreamMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: FINAL_REPLY_TEXT,
      }),
    );
    expect(appendSlackStreamMock).not.toHaveBeenCalled();
    expect(deliverRepliesMock).not.toHaveBeenCalled();
  });

  it("keeps same-content tool and final payloads distinct after preview fallback", async () => {
    mockedDispatchSequence = [
      { kind: "tool", payload: { text: SAME_TEXT } },
      { kind: "final", payload: { text: SAME_TEXT } },
    ];

    await dispatchPreparedSlackMessage(createPreparedSlackMessage());

    expect(finalizeSlackPreviewEditMock).toHaveBeenCalledTimes(1);
    expect(deliverRepliesMock).toHaveBeenCalledTimes(2);
    expect(deliverRepliesMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        replyThreadTs: THREAD_TS,
        replies: [expect.objectContaining({ text: SAME_TEXT })],
      }),
    );
    expect(deliverRepliesMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        replyThreadTs: THREAD_TS,
        replies: [expect.objectContaining({ text: SAME_TEXT })],
      }),
    );
  });

  it("keeps multi-part block replies in the first reply thread after the plan is consumed", async () => {
    mockedReplyThreadTsSequence = [THREAD_TS, undefined];
    mockedDispatchSequence = [
      { kind: "block", payload: { text: "first block" } },
      { kind: "block", payload: { text: "second block" } },
    ];

    await dispatchPreparedSlackMessage(
      createPreparedSlackMessage({
        replyToMode: "first",
      }),
    );

    expect(deliverRepliesMock).toHaveBeenCalledTimes(2);
    expect(deliverRepliesMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        replyThreadTs: THREAD_TS,
        replies: [expect.objectContaining({ text: "first block" })],
      }),
    );
    expect(deliverRepliesMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        replyThreadTs: THREAD_TS,
        replies: [expect.objectContaining({ text: "second block" })],
      }),
    );
  });

  it("does not flush draft previews for media finals before normal delivery", async () => {
    const draftStream = {
      ...createDraftStreamStub(),
      flush: vi.fn(noopAsync),
      clear: vi.fn(noopAsync),
      discardPending: vi.fn(noopAsync),
      seal: vi.fn(noopAsync),
    };
    createSlackDraftStreamMock.mockReturnValueOnce(draftStream);
    mockedDispatchSequence = [
      {
        kind: "final",
        payload: { text: "Photo", mediaUrl: "https://example.com/a.png" },
      },
    ];

    await dispatchPreparedSlackMessage(createPreparedSlackMessage());

    expect(draftStream.flush).not.toHaveBeenCalled();
    expect(draftStream.discardPending).toHaveBeenCalled();
    expect(draftStream.clear).toHaveBeenCalledTimes(1);
    expect(finalizeSlackPreviewEditMock).not.toHaveBeenCalled();
    expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
  });

  it("does not flush draft previews for error finals before normal delivery", async () => {
    const draftStream = {
      ...createDraftStreamStub(),
      flush: vi.fn(noopAsync),
      clear: vi.fn(noopAsync),
      discardPending: vi.fn(noopAsync),
      seal: vi.fn(noopAsync),
    };
    createSlackDraftStreamMock.mockReturnValueOnce(draftStream);
    mockedDispatchSequence = [
      {
        kind: "final",
        payload: { text: "Something failed", isError: true },
      },
    ];

    await dispatchPreparedSlackMessage(createPreparedSlackMessage());

    expect(draftStream.flush).not.toHaveBeenCalled();
    expect(draftStream.discardPending).toHaveBeenCalled();
    expect(draftStream.clear).toHaveBeenCalledTimes(1);
    expect(finalizeSlackPreviewEditMock).not.toHaveBeenCalled();
    expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
  });

  it("routes pending native stream text through chunked sender when finalize fails before the SDK buffer flushes", async () => {
    mockedNativeStreaming = true;
    const session = {
      channel: "C123",
      threadTs: THREAD_TS,
      stopped: false,
      delivered: false,
      pendingText: FINAL_REPLY_TEXT,
    };
    startSlackStreamMock.mockResolvedValueOnce(session);
    stopSlackStreamMock.mockRejectedValueOnce(
      new TestSlackStreamNotDeliveredError(FINAL_REPLY_TEXT, "user_not_found"),
    );

    await dispatchPreparedSlackMessage(createPreparedSlackMessage());

    expect(postMessageMock).not.toHaveBeenCalled();
    expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
    expect(deliverRepliesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        replyThreadTs: THREAD_TS,
        replies: [expect.objectContaining({ text: FINAL_REPLY_TEXT })],
      }),
    );
    expect(session.stopped).toBe(true);
  });

  it("routes all pending native stream text through chunked sender when an append flush fails", async () => {
    mockedNativeStreaming = true;
    mockedDispatchSequence = [
      { kind: "block", payload: { text: "first buffered" } },
      { kind: "final", payload: { text: "second flushes" } },
    ];
    const session = {
      channel: "C123",
      threadTs: THREAD_TS,
      stopped: false,
      delivered: false,
      pendingText: "first buffered",
    };
    startSlackStreamMock.mockResolvedValueOnce(session);
    appendSlackStreamMock.mockImplementationOnce(async () => {
      session.pendingText += "\nsecond flushes";
      throw new TestSlackStreamNotDeliveredError(session.pendingText, "user_not_found");
    });

    await dispatchPreparedSlackMessage(createPreparedSlackMessage());

    expect(postMessageMock).not.toHaveBeenCalled();
    expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
    expect(deliverRepliesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        replyThreadTs: THREAD_TS,
        replies: [expect.objectContaining({ text: "first buffered\nsecond flushes" })],
      }),
    );
    expect(stopSlackStreamMock).not.toHaveBeenCalled();
  });

  it("forwards oversized pending stream text to the chunked sender intact (chunking is the sender's responsibility)", async () => {
    mockedNativeStreaming = true;
    // SLACK_TEXT_LIMIT mocks to 4000; use > 1 message worth of content.
    const oversized = "x".repeat(8500);
    const session = {
      channel: "C123",
      threadTs: THREAD_TS,
      stopped: false,
      delivered: false,
      pendingText: oversized,
    };
    startSlackStreamMock.mockResolvedValueOnce(session);
    stopSlackStreamMock.mockRejectedValueOnce(
      new TestSlackStreamNotDeliveredError(oversized, "team_not_found"),
    );

    await dispatchPreparedSlackMessage(createPreparedSlackMessage());

    expect(postMessageMock).not.toHaveBeenCalled();
    expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
    expect(deliverRepliesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        replyThreadTs: THREAD_TS,
        textLimit: 4000,
        replies: [expect.objectContaining({ text: oversized })],
      }),
    );
    expect(session.stopped).toBe(true);
  });

  it("routes full pendingText (earlier buffered + failing chunk) through chunked sender on non-benign append failure", async () => {
    mockedNativeStreaming = true;
    mockedDispatchSequence = [
      { kind: "block", payload: { text: "first buffered" } },
      { kind: "final", payload: { text: "second payload" } },
    ];
    const session = {
      channel: "C123",
      threadTs: THREAD_TS,
      stopped: false,
      delivered: false,
      pendingText: "first buffered",
    };
    startSlackStreamMock.mockResolvedValueOnce(session);
    // Non-benign error (plain Error, NOT SlackStreamNotDeliveredError).
    // appendSlackStream mutates pendingText BEFORE throwing so the full
    // buffer (earlier chunk + current chunk) must be preserved and routed
    // through the chunked fallback - not dropped or partially re-sent.
    appendSlackStreamMock.mockImplementationOnce(async () => {
      session.pendingText += "\nsecond payload";
      throw new Error("network socket closed");
    });

    await dispatchPreparedSlackMessage(createPreparedSlackMessage());

    // Chunked fallback sent the FULL pendingText, not just the failing
    // payload (so the earlier buffered chunk is not dropped).
    expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
    expect(deliverRepliesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        replyThreadTs: THREAD_TS,
        replies: [expect.objectContaining({ text: "first buffered\nsecond payload" })],
      }),
    );
    // Session was marked fallback-delivered by deliverPendingStreamFallback,
    // so finalize skips stopSlackStream.
    expect(session.pendingText).toBe("");
    expect(session.stopped).toBe(true);
    expect(stopSlackStreamMock).not.toHaveBeenCalled();
    // No raw postMessage path was invoked.
    expect(postMessageMock).not.toHaveBeenCalled();
  });
});
