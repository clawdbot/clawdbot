import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const FINAL_REPLY_TEXT = "final answer";
const THREAD_TS = "thread-1";
const SAME_TEXT = "same reply";

const createSlackDraftStreamMock = vi.fn();
const deliverRepliesMock = vi.fn(async () => {});
const finalizeSlackPreviewEditMock = vi.fn(async () => {});
const postMessageMock = vi.fn(async () => ({ ok: true, ts: "171234.999" }));
const updateLastRouteMock = vi.fn(async () => {});
const appendSlackStreamMock = vi.fn(async () => {});
const startSlackStreamMock = vi.fn(async () => ({
  channel: "C123",
  threadTs: THREAD_TS,
  stopped: false,
  delivered: true,
  pendingText: "",
}));
const stopSlackStreamMock = vi.fn(async () => {});
const reactSlackMessageMock = vi.fn(async () => {});
const removeSlackReactionMock = vi.fn(async () => {});
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
let mockedSlackStreamingMode: "off" | "partial" | "block" | "progress" = "partial";
let mockedSlackDraftMode: "replace" | "status_final" | "append" = "append";
let capturedReplyOptions:
  | {
      disableBlockStreaming?: boolean;
      suppressDefaultToolProgressMessages?: boolean;
      onItemEvent?: (payload: {
        kind?: string;
        progressText?: string;
        summary?: string;
        title?: string;
        name?: string;
        phase?: string;
        status?: string;
        meta?: string;
      }) => Promise<void> | void;
      onPartialReply?: (payload: { text: string }) => Promise<void> | void;
    }
  | undefined;
let capturedStatusReactionOptions: { enabled?: boolean; initialEmoji?: string } | undefined;
const statusReactionControllerMock = {
  setQueued: vi.fn(async () => {}),
  setThinking: vi.fn(async () => {}),
  setTool: vi.fn(async () => {}),
  setError: vi.fn(async () => {}),
  setDone: vi.fn(async () => {}),
  clear: vi.fn(async () => {}),
  restoreInitial: vi.fn(async () => {}),
};
let mockedReplyThreadTs: string | undefined = THREAD_TS;
let mockedReplyThreadTsSequence: Array<string | undefined> | undefined;
let capturedTyping:
  | {
      start: () => Promise<void>;
      stop?: () => Promise<void>;
      onStartError: (err: unknown) => void;
      onStopError?: (err: unknown) => void;
    }
  | undefined;
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

function countFinalDispatches(): number {
  let count = 0;
  for (const entry of mockedDispatchSequence) {
    if (entry.kind === "final") {
      count++;
    }
  }
  return count;
}

let mockedProgressEvents: string[] = [];
let mockedReplyOptionEvents: Array<
  | {
      kind: "item";
      itemKind?: string;
      progressText?: string;
      summary?: string;
      title?: string;
      name?: string;
      phase?: string;
      status?: string;
      meta?: string;
    }
  | { kind: "partial"; text: string }
> = [];

function requireCapturedTyping() {
  if (!capturedTyping) {
    throw new Error("expected Slack typing callback");
  }
  return capturedTyping;
}

function requireCapturedItemEventHandler() {
  const handler = capturedReplyOptions?.onItemEvent;
  if (!handler) {
    throw new Error("expected Slack reply item event handler");
  }
  return handler;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error(`${label} was not an object`);
  }
  return value as Record<string, unknown>;
}

function expectRecordFields(record: Record<string, unknown>, fields: Record<string, unknown>) {
  for (const [key, value] of Object.entries(fields)) {
    expect(record[key]).toEqual(value);
  }
}

function requireMockCall(mock: unknown, index: number, label: string): unknown[] {
  const call = (mock as { mock?: { calls?: unknown[][] } }).mock?.calls?.[index];
  if (!call) {
    throw new Error(`missing ${label} call ${index + 1}`);
  }
  return call;
}

function expectMockCallArgFields(
  mock: unknown,
  index: number,
  label: string,
  fields: Record<string, unknown>,
) {
  expectRecordFields(requireRecord(requireMockCall(mock, index, label)[0], label), fields);
}

function expectDeliverReplyCall(index: number, text: string, fields?: Record<string, unknown>) {
  const params = requireRecord(
    requireMockCall(deliverRepliesMock, index, "deliver replies")[0],
    "deliver replies params",
  );
  expectRecordFields(params, { replyThreadTs: THREAD_TS, ...fields });
  expect(params.replies).toEqual([{ text }]);
}

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
  cfg?: Record<string, unknown>;
  accountConfig?: Record<string, unknown>;
  ctxPayload?: Record<string, unknown>;
  message?: Partial<{
    channel: string;
    ts: string;
    thread_ts?: string;
    user: string;
  }>;
  replyToMode?: "off" | "first" | "all" | "batched";
  isDirectMessage?: boolean;
  route?: Partial<{
    agentId: string;
    accountId: string;
    mainSessionKey: string;
    sessionKey: string;
    lastRoutePolicy: "main" | "session";
  }>;
  setSlackThreadStatus?: (params: {
    channelId: string;
    threadTs?: string;
    status: string;
  }) => Promise<void>;
  typingReaction?: string;
  ackReactionMessageTs?: string;
  ackReactionPromise?: Promise<boolean> | null;
}) {
  const routeSessionKey = params?.route?.sessionKey ?? "agent:agent-1:slack:C123";
  const mainSessionKey = params?.route?.mainSessionKey ?? "main";
  const lastRoutePolicy =
    params?.route?.lastRoutePolicy ?? (routeSessionKey === mainSessionKey ? "main" : "session");

  return {
    ctx: {
      cfg: params?.cfg ?? {},
      runtime: {},
      botToken: "xoxb-test",
      app: { client: { chat: { postMessage: postMessageMock } } },
      teamId: "T1",
      textLimit: 4000,
      typingReaction: params?.typingReaction ?? "",
      removeAckAfterReply: false,
      historyLimit: 0,
      channelHistories: new Map(),
      allowFrom: [],
      setSlackThreadStatus: params?.setSlackThreadStatus ?? (async () => undefined),
    },
    account: {
      accountId: "default",
      config: params?.accountConfig ?? {},
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
      mainSessionKey,
      sessionKey: routeSessionKey,
      lastRoutePolicy,
      ...params?.route,
    },
    channelConfig: null,
    replyTarget: "channel:C123",
    ctxPayload: {
      MessageThreadId: THREAD_TS,
      ...params?.ctxPayload,
    },
    turn: {
      storePath: "/tmp/slack-sessions.json",
      record: {},
    },
    replyToMode: params?.replyToMode ?? "all",
    isDirectMessage: params?.isDirectMessage ?? false,
    isRoomish: false,
    historyKey: "history-key",
    preview: "",
    ackReactionValue: "eyes",
    ackReactionMessageTs: params?.ackReactionMessageTs,
    ackReactionPromise: params?.ackReactionPromise ?? null,
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
  createStatusReactionController: (params: { enabled?: boolean; initialEmoji?: string }) => {
    capturedStatusReactionOptions = params;
    return statusReactionControllerMock;
  },
  logAckFailure: () => {},
  logTypingFailure: () => {},
  removeAckReactionAfterReply: () => {},
}));

vi.mock("../conversation.runtime.js", () => ({
  recordInboundSession: vi.fn(async () => undefined),
}));

vi.mock("openclaw/plugin-sdk/channel-message", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-message")>();
  return {
    ...actual,
    createChannelMessageReplyPipeline: (params: {
      typing?: {
        start: () => Promise<void>;
        stop?: () => Promise<void>;
        onStartError: (err: unknown) => void;
        onStopError?: (err: unknown) => void;
      };
    }) => {
      capturedTyping = params.typing;
      return {
        ...(params.typing
          ? {
              typingCallbacks: {
                onReplyStart: params.typing.start,
                onIdle: () => {
                  void params.typing?.stop?.();
                },
              },
            }
          : {}),
        onModelSelected: undefined,
      };
    },
    resolveChannelMessageSourceReplyDeliveryMode: (params: {
      cfg?: { messages?: { groupChat?: { visibleReplies?: string } } };
      ctx?: { ChatType?: string };
      requested?: "automatic" | "message_tool_only";
    }) => {
      if (params.requested) {
        return params.requested;
      }
      const chatType = params.ctx?.ChatType;
      if (chatType === "group" || chatType === "channel") {
        return params.cfg?.messages?.groupChat?.visibleReplies === "automatic"
          ? "automatic"
          : "message_tool_only";
      }
      return "automatic";
    },
  };
});

vi.mock("openclaw/plugin-sdk/channel-streaming", () => ({
  buildChannelProgressDraftLine: (params: {
    progressText?: string;
    summary?: string;
    title?: string;
    name?: string;
  }) => {
    const text = params.progressText ?? params.summary ?? params.title ?? params.name;
    return text
      ? {
          kind: "item",
          text,
          label: params.title ?? params.name ?? "Update",
        }
      : undefined;
  },
  buildChannelProgressDraftLineForEntry: (
    entry: {
      streaming?: {
        progress?: { commandText?: "raw" | "status" };
        preview?: { commandText?: "raw" | "status" };
      };
    },
    params: {
      itemKind?: string;
      progressText?: string;
      summary?: string;
      title?: string;
      name?: string;
    },
  ) => {
    if (
      (entry.streaming?.progress?.commandText ?? entry.streaming?.preview?.commandText) ===
        "status" &&
      (params.itemKind === "command" || params.name === "exec")
    ) {
      return {
        kind: "item",
        text: "🛠️ Exec",
        label: "Exec",
      };
    }
    const text = params.progressText ?? params.summary ?? params.title ?? params.name;
    return text
      ? {
          kind: "item",
          text,
          label: params.title ?? params.name ?? "Update",
        }
      : undefined;
  },
  createChannelProgressDraftGate: (params: { onStart: () => void | Promise<void> }) => {
    let started = false;
    let workEvents = 0;
    return {
      get hasStarted() {
        return started;
      },
      async noteWork() {
        workEvents += 1;
        if (!started && workEvents > 1) {
          started = true;
          await params.onStart();
        }
        return started;
      },
      async startNow() {
        if (!started) {
          started = true;
          await params.onStart();
        }
      },
      cancel() {},
    };
  },
  formatChannelProgressDraftText: (params: {
    entry?: { streaming?: { progress?: { label?: string | false; maxLines?: number } } };
    lines: Array<
      string | { text: string; icon?: string; detail?: string; status?: string; label: string }
    >;
    formatLine?: (line: string) => string;
  }) => {
    const label = params.entry?.streaming?.progress?.label;
    const maxLines = params.entry?.streaming?.progress?.maxLines ?? 8;
    const formatLine = params.formatLine ?? ((line: string) => line);
    const lines = [
      label === false ? undefined : (label ?? "Thinking"),
      ...params.lines.map((line) => {
        const text =
          typeof line === "string"
            ? line
            : line.detail
              ? `${line.icon ?? ""} ${line.detail}`.trim()
              : line.status
                ? `${line.icon ?? ""} ${line.status}`.trim()
                : line.text;
        const formatted = formatLine(text);
        return /^\p{Extended_Pictographic}/u.test(text) ? formatted : `• ${formatted}`;
      }),
    ]
      .filter((line): line is string => Boolean(line))
      .slice(-maxLines);
    return lines.join("\n");
  },
  formatChannelProgressDraftLine: (params: {
    progressText?: string;
    summary?: string;
    title?: string;
    name?: string;
  }) => params.progressText ?? params.summary ?? params.title ?? params.name,
  formatChannelProgressDraftLineForEntry: (
    _entry: unknown,
    params: {
      progressText?: string;
      summary?: string;
      title?: string;
      name?: string;
    },
  ) => params.progressText ?? params.summary ?? params.title ?? params.name,
  resolveChannelProgressDraftMaxLines: (entry?: {
    streaming?: { progress?: { maxLines?: number } };
  }) => entry?.streaming?.progress?.maxLines ?? 8,
  resolveChannelProgressDraftRender: (entry?: {
    streaming?: { progress?: { render?: "text" | "rich" } };
  }) => entry?.streaming?.progress?.render ?? "text",
  resolveChannelStreamingBlockEnabled: () => mockedBlockStreamingEnabled,
  resolveChannelStreamingNativeTransport: () => mockedNativeStreaming,
  resolveChannelStreamingPreviewToolProgress: (entry?: {
    streaming?: { progress?: { toolProgress?: boolean }; preview?: { toolProgress?: boolean } };
  }) => entry?.streaming?.progress?.toolProgress ?? entry?.streaming?.preview?.toolProgress ?? true,
  resolveChannelStreamingSuppressDefaultToolProgressMessages: (
    entry?: {
      streaming?: {
        mode?: string;
        progress?: { toolProgress?: boolean };
        preview?: { toolProgress?: boolean };
      };
    },
    options?: {
      draftStreamActive?: boolean;
      previewStreamingEnabled?: boolean;
      previewToolProgressEnabled?: boolean;
    },
  ) => {
    if (options?.draftStreamActive === false || options?.previewStreamingEnabled === false) {
      return false;
    }
    if (entry?.streaming?.mode === "progress") {
      return true;
    }
    if (options?.draftStreamActive === true) {
      return true;
    }
    return options?.previewToolProgressEnabled ?? true;
  },
  isChannelProgressDraftWorkToolName: (name?: string) =>
    Boolean(name && !["message", "react", "reaction"].includes(name.toLowerCase())),
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

vi.mock("openclaw/plugin-sdk/string-coerce-runtime", () => ({
  normalizeOptionalLowercaseString: (value?: string) => value?.toLowerCase(),
}));

vi.mock("../../actions.js", () => ({
  reactSlackMessage: reactSlackMessageMock,
  removeSlackReaction: removeSlackReactionMock,
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
    mode: mockedSlackStreamingMode,
    nativeStreaming: mockedNativeStreaming,
    draftMode: mockedSlackDraftMode,
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
  updateLastRoute: updateLastRouteMock,
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
      suppressDefaultToolProgressMessages?: boolean;
      onItemEvent?: (payload: {
        kind?: string;
        progressText?: string;
        summary?: string;
        title?: string;
        name?: string;
        phase?: string;
        status?: string;
        meta?: string;
      }) => Promise<void> | void;
      onPartialReply?: (payload: { text: string }) => Promise<void> | void;
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
    if (mockedReplyOptionEvents.length > 0) {
      for (const entry of mockedReplyOptionEvents) {
        if (entry.kind === "item") {
          await params.replyOptions?.onItemEvent?.({
            kind: entry.itemKind,
            progressText: entry.progressText,
            summary: entry.summary,
            title: entry.title,
            name: entry.name,
            phase: entry.phase,
            status: entry.status,
            meta: entry.meta,
          });
        } else {
          await params.replyOptions?.onPartialReply?.({ text: entry.text });
        }
      }
    } else {
      for (const progressText of mockedProgressEvents) {
        await params.replyOptions?.onItemEvent?.({ progressText });
      }
    }
    for (const entry of mockedDispatchSequence) {
      await params.dispatcher.deliver(entry.payload, { kind: entry.kind });
    }
    return {
      queuedFinal: false,
      counts: {
        final: countFinalDispatches(),
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
    updateLastRouteMock.mockReset();
    appendSlackStreamMock.mockReset();
    startSlackStreamMock.mockReset();
    stopSlackStreamMock.mockReset();
    reactSlackMessageMock.mockReset();
    removeSlackReactionMock.mockReset();
    for (const value of Object.values(statusReactionControllerMock)) {
      value.mockClear();
    }
    mockedNativeStreaming = false;
    mockedBlockStreamingEnabled = false;
    mockedSlackStreamingMode = "partial";
    mockedSlackDraftMode = "append";
    capturedReplyOptions = undefined;
    capturedStatusReactionOptions = undefined;
    capturedTyping = undefined;
    mockedReplyThreadTs = THREAD_TS;
    mockedReplyThreadTsSequence = undefined;
    mockedDispatchSequence = [{ kind: "final", payload: { text: FINAL_REPLY_TEXT } }];
    mockedProgressEvents = [];
    mockedReplyOptionEvents = [];

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
    expectDeliverReplyCall(0, FINAL_REPLY_TEXT);
  });

  it("updates non-main DM last-route metadata on the prepared thread session", async () => {
    await dispatchPreparedSlackMessage(
      createPreparedSlackMessage({
        cfg: { session: { dmScope: "per-channel-peer" } },
        isDirectMessage: true,
        message: {
          channel: "D123",
          user: "U1",
          ts: "501.000",
          thread_ts: "500.000",
        },
        route: {
          agentId: "main",
          mainSessionKey: "agent:main:main",
          sessionKey: "agent:main:slack:direct:u1",
          lastRoutePolicy: "session",
        },
        ctxPayload: {
          MessageThreadId: "500.000",
          SessionKey: "agent:main:slack:direct:u1:thread:500.000",
        },
      }),
    );

    expect(updateLastRouteMock).toHaveBeenCalledWith({
      storePath: "/tmp/openclaw-store.json",
      sessionKey: "agent:main:slack:direct:u1:thread:500.000",
      deliveryContext: {
        channel: "slack",
        to: "user:U1",
        accountId: "default",
        threadId: "500.000",
      },
      ctx: {
        MessageThreadId: "500.000",
        SessionKey: "agent:main:slack:direct:u1:thread:500.000",
      },
    });
  });

  it("keeps default main-scope DM last-route metadata on the main session", async () => {
    await dispatchPreparedSlackMessage(
      createPreparedSlackMessage({
        isDirectMessage: true,
        message: {
          channel: "D123",
          user: "U1",
          ts: "601.000",
          thread_ts: "600.000",
        },
        route: {
          agentId: "main",
          mainSessionKey: "agent:main:main",
          sessionKey: "agent:main:main",
          lastRoutePolicy: "main",
        },
        ctxPayload: {
          MessageThreadId: "600.000",
          SessionKey: "agent:main:main:thread:600.000",
        },
      }),
    );

    expect(updateLastRouteMock).toHaveBeenCalledWith({
      storePath: "/tmp/openclaw-store.json",
      sessionKey: "agent:main:main",
      deliveryContext: {
        channel: "slack",
        to: "user:U1",
        accountId: "default",
        threadId: "600.000",
      },
      ctx: {
        MessageThreadId: "600.000",
        SessionKey: "agent:main:main:thread:600.000",
      },
    });
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
    expectMockCallArgFields(finalizeSlackPreviewEditMock, 0, "preview edit params", {
      channelId: "C123",
      messageId: "171234.567",
      text: "✅",
    });
    expect(deliverRepliesMock).not.toHaveBeenCalled();
    expect(draftStream.clear).not.toHaveBeenCalled();
  });

  it("suppresses block streaming when Slack draft preview streaming is active", async () => {
    mockedBlockStreamingEnabled = true;

    await dispatchPreparedSlackMessage(createPreparedSlackMessage());

    expect(capturedReplyOptions?.disableBlockStreaming).toBe(true);
  });

  it("keeps Slack typing callbacks when channel replies are message-tool-only", async () => {
    const setSlackThreadStatus = vi.fn(async () => undefined);

    await dispatchPreparedSlackMessage(
      createPreparedSlackMessage({
        cfg: { messages: { groupChat: { visibleReplies: "message_tool" } } },
        ctxPayload: { ChatType: "channel" },
        setSlackThreadStatus,
        typingReaction: "hourglass_flowing_sand",
      }),
    );

    const typing = requireCapturedTyping();
    expect(capturedReplyOptions?.disableBlockStreaming).toBe(true);

    await typing.start();
    await typing.stop?.();

    expect(setSlackThreadStatus).toHaveBeenCalledWith({
      channelId: "C123",
      threadTs: THREAD_TS,
      status: "is typing...",
    });
    expect(setSlackThreadStatus).toHaveBeenCalledWith({
      channelId: "C123",
      threadTs: THREAD_TS,
      status: "",
    });
    const reactCall = requireMockCall(reactSlackMessageMock, 0, "react Slack message");
    expect(reactCall[0]).toBe("C123");
    expect(reactCall[1]).toBe("171234.111");
    expect(reactCall[2]).toBe("hourglass_flowing_sand");
    expect(requireRecord(reactCall[3], "react Slack message options").token).toBe("xoxb-test");
    const removeReactionCall = requireMockCall(removeSlackReactionMock, 0, "remove Slack reaction");
    expect(removeReactionCall[0]).toBe("C123");
    expect(removeReactionCall[1]).toBe("171234.111");
    expect(removeReactionCall[2]).toBe("hourglass_flowing_sand");
    expect(requireRecord(removeReactionCall[3], "remove Slack reaction options").token).toBe(
      "xoxb-test",
    );
  });

  it("keeps Slack status reactions when channel replies are message-tool-only", async () => {
    await dispatchPreparedSlackMessage(
      createPreparedSlackMessage({
        cfg: {
          messages: {
            groupChat: { visibleReplies: "message_tool" },
            statusReactions: { enabled: true },
          },
        },
        ctxPayload: { ChatType: "channel" },
        ackReactionMessageTs: "171234.111",
        ackReactionPromise: Promise.resolve(true),
      }),
    );

    expect(capturedReplyOptions?.disableBlockStreaming).toBe(true);
    expectRecordFields(requireRecord(capturedStatusReactionOptions, "status reaction options"), {
      enabled: true,
      initialEmoji: "eyes",
    });
    expect(statusReactionControllerMock.setQueued).toHaveBeenCalledTimes(1);
    expect(statusReactionControllerMock.setDone).toHaveBeenCalledTimes(1);
  });

  it("escapes Slack mrkdwn in tool progress preview labels", async () => {
    const draftStream = createDraftStreamStub();
    createSlackDraftStreamMock.mockReturnValueOnce(draftStream);
    mockedDispatchSequence = [];
    mockedProgressEvents = ["ran <!here> <@U123> *bold* `code` & done"];

    await dispatchPreparedSlackMessage(
      createPreparedSlackMessage({
        accountConfig: { streaming: { progress: { label: "Shelling" } } },
      }),
    );

    expect(draftStream.update).toHaveBeenCalledWith(
      "Shelling\n• ran &lt;!here&gt; &lt;@U123&gt; \\*bold\\* \\`code\\` &amp; done",
    );
  });

  it("honors Slack progress maxLines above the legacy eight-line cap", async () => {
    const draftStream = createDraftStreamStub();
    createSlackDraftStreamMock.mockReturnValueOnce(draftStream);
    mockedDispatchSequence = [];
    mockedProgressEvents = Array.from({ length: 10 }, (_value, index) => `step ${index + 1}`);

    await dispatchPreparedSlackMessage(
      createPreparedSlackMessage({
        accountConfig: { streaming: { progress: { label: "Shelling", maxLines: 10 } } },
      }),
    );

    expect(draftStream.update).toHaveBeenLastCalledWith(
      [
        "• step 1",
        "• step 2",
        "• step 3",
        "• step 4",
        "• step 5",
        "• step 6",
        "• step 7",
        "• step 8",
        "• step 9",
        "• step 10",
      ].join("\n"),
    );
  });

  it("preserves Slack progress lines across status-final answer partials", async () => {
    const draftStream = createDraftStreamStub();
    createSlackDraftStreamMock.mockReturnValueOnce(draftStream);
    mockedSlackStreamingMode = "progress";
    mockedSlackDraftMode = "status_final";
    mockedDispatchSequence = [];
    mockedReplyOptionEvents = [
      { kind: "item", progressText: "tool one" },
      { kind: "partial", text: "partial answer" },
      { kind: "item", progressText: "tool two" },
    ];

    await dispatchPreparedSlackMessage(
      createPreparedSlackMessage({
        accountConfig: { streaming: { progress: { label: "Shelling" } } },
      }),
    );

    expect(draftStream.update).toHaveBeenLastCalledWith(
      ["Shelling", "• tool one", "• tool two"].join("\n"),
    );
  });

  it("can hide raw Slack command progress text by config", async () => {
    const draftStream = createDraftStreamStub();
    createSlackDraftStreamMock.mockReturnValueOnce(draftStream);
    mockedSlackStreamingMode = "progress";
    mockedSlackDraftMode = "status_final";
    mockedDispatchSequence = [];
    mockedReplyOptionEvents = [
      {
        kind: "item",
        itemKind: "command",
        name: "exec",
        progressText: "exec pnpm test -- --watch=false",
      },
      { kind: "item", progressText: "done" },
    ];

    await dispatchPreparedSlackMessage(
      createPreparedSlackMessage({
        accountConfig: {
          streaming: { mode: "progress", progress: { label: "Shelling", commandText: "status" } },
        },
      }),
    );

    expect(draftStream.update).toHaveBeenCalledWith("Shelling\n🛠️ Exec\n• done");
    expect(draftStream.update.mock.calls.flat().join("\n")).not.toContain("pnpm test");
  });

  it("suppresses standalone Slack tool progress when progress lines are disabled", async () => {
    mockedSlackStreamingMode = "progress";
    mockedSlackDraftMode = "status_final";
    mockedDispatchSequence = [];

    await dispatchPreparedSlackMessage(
      createPreparedSlackMessage({
        accountConfig: { streaming: { mode: "progress", progress: { toolProgress: false } } },
      }),
    );

    expect(capturedReplyOptions?.suppressDefaultToolProgressMessages).toBe(true);
    await requireCapturedItemEventHandler()({ progressText: "hidden progress" });
  });

  it("does not create a blank Slack progress draft when label and lines are disabled", async () => {
    const draftStream = createDraftStreamStub();
    createSlackDraftStreamMock.mockReturnValueOnce(draftStream);
    mockedSlackStreamingMode = "progress";
    mockedSlackDraftMode = "status_final";
    mockedDispatchSequence = [];
    mockedReplyOptionEvents = [
      { kind: "item", progressText: "tool one" },
      { kind: "item", progressText: "tool two" },
      { kind: "partial", text: "partial answer" },
    ];

    await dispatchPreparedSlackMessage(
      createPreparedSlackMessage({
        accountConfig: {
          streaming: { mode: "progress", progress: { label: false, toolProgress: false } },
        },
      }),
    );

    expect(capturedReplyOptions?.suppressDefaultToolProgressMessages).toBe(true);
    expect(draftStream.update).not.toHaveBeenCalled();
  });

  it("suppresses standalone Slack tool progress when partial preview lines are disabled", async () => {
    mockedSlackStreamingMode = "partial";
    mockedSlackDraftMode = "replace";
    mockedDispatchSequence = [];

    await dispatchPreparedSlackMessage(
      createPreparedSlackMessage({
        accountConfig: { streaming: { mode: "partial", preview: { toolProgress: false } } },
      }),
    );

    expect(capturedReplyOptions?.suppressDefaultToolProgressMessages).toBe(true);
    await requireCapturedItemEventHandler()({ progressText: "hidden partial progress" });
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

    expectMockCallArgFields(startSlackStreamMock, 0, "Slack stream start params", {
      channel: "C123",
      threadTs: "171234.111",
      text: FINAL_REPLY_TEXT,
    });
    expect(deliverRepliesMock).not.toHaveBeenCalled();
  });

  it("suppresses reasoning payloads before Slack native streaming delivery", async () => {
    mockedNativeStreaming = true;
    mockedDispatchSequence = [
      { kind: "block", payload: { text: "hidden", isReasoning: true } },
      { kind: "final", payload: { text: FINAL_REPLY_TEXT } },
    ];

    await dispatchPreparedSlackMessage(createPreparedSlackMessage());

    expect(startSlackStreamMock).toHaveBeenCalledTimes(1);
    expectMockCallArgFields(startSlackStreamMock, 0, "Slack stream start params", {
      text: FINAL_REPLY_TEXT,
    });
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
    expectDeliverReplyCall(0, SAME_TEXT);
    expectDeliverReplyCall(1, SAME_TEXT);
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
    expectDeliverReplyCall(0, "first block");
    expectDeliverReplyCall(1, "second block");
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
    expectDeliverReplyCall(0, FINAL_REPLY_TEXT);
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
    expectDeliverReplyCall(0, "first buffered\nsecond flushes");
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
    expectDeliverReplyCall(0, oversized, { textLimit: 4000 });
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
    expectDeliverReplyCall(0, "first buffered\nsecond payload");
    // Session was marked fallback-delivered by deliverPendingStreamFallback,
    // so finalize skips stopSlackStream.
    expect(session.pendingText).toBe("");
    expect(session.stopped).toBe(true);
    expect(stopSlackStreamMock).not.toHaveBeenCalled();
    // No raw postMessage path was invoked.
    expect(postMessageMock).not.toHaveBeenCalled();
  });
});
