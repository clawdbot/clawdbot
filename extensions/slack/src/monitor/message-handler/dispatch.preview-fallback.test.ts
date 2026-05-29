import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const FINAL_REPLY_TEXT = "final answer";
const THREAD_TS = "thread-1";
const SAME_TEXT = "same reply";

const createSlackDraftStreamMock = vi.fn();
const deliverRepliesMock = vi.fn(async () => {});
const finalizeSlackPreviewEditMock = vi.fn(async () => {});
const postMessageMock = vi.fn(async () => ({ ok: true, ts: "171234.999" }));
const chatUpdateMock = vi.fn(async () => ({ ok: true, ts: "171234.999" }));
const recordInboundSessionMock = vi.fn(async () => undefined);
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
let mockedPinnedMainDmOwner: string | undefined;
let capturedReplyOptions:
  | {
      disableBlockStreaming?: boolean;
      suppressDefaultToolProgressMessages?: boolean;
      onAssistantMessageStart?: () => Promise<void> | void;
      onReasoningEnd?: () => Promise<void> | void;
      onReasoningStream?: (payload?: {
        text?: string;
        isReasoningSnapshot?: boolean;
      }) => Promise<void> | void;
      onItemEvent?: (payload: {
        kind?: string;
        itemId?: string;
        progressText?: string;
        summary?: string;
        title?: string;
        name?: string;
        phase?: string;
        status?: string;
        meta?: string;
      }) => Promise<void> | void;
      onToolStart?: (payload: {
        itemId?: string;
        toolCallId?: string;
        name: string;
        phase?: string;
        args?: Record<string, unknown>;
        detailMode?: "explain" | "raw";
      }) => Promise<void> | void;
      onPatchSummary?: (payload: {
        itemId?: string;
        toolCallId?: string;
        phase?: string;
        title?: string;
        name?: string;
        added?: string[];
        modified?: string[];
        deleted?: string[];
        summary?: string;
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
let mockedSlackReplyBlocks: unknown[] | undefined;
let capturedTyping:
  | {
      start: () => Promise<void>;
      stop?: () => Promise<void>;
      onStartError: (err: unknown) => void;
      onStopError?: (err: unknown) => void;
    }
  | undefined;
type TestReplyDispatchKind = "tool" | "block" | "final";
type TestReplyPayload = {
  text?: string;
  isError?: boolean;
  isReasoning?: boolean;
  mediaUrl?: string;
  mediaUrls?: string[];
  audioAsVoice?: boolean;
  spokenText?: string;
  ttsSupplement?: { spokenText: string; visibleTextAlreadyDelivered?: boolean };
};
type TestDispatchCounts = Record<TestReplyDispatchKind, number>;
let mockedDispatchSequence: Array<{
  kind: TestReplyDispatchKind;
  payload: TestReplyPayload;
}> = [];
let mockedQueuedDispatchCounts: TestDispatchCounts = { tool: 0, block: 0, final: 0 };

let mockedProgressEvents: string[] = [];
let mockedReplyOptionEvents: Array<
  | {
      kind: "item";
      itemId?: string;
      itemKind?: string;
      progressText?: string;
      summary?: string;
      title?: string;
      name?: string;
      phase?: string;
      status?: string;
      meta?: string;
    }
  | {
      kind: "tool_start";
      itemId?: string;
      toolCallId?: string;
      name: string;
      phase?: string;
      args?: Record<string, unknown>;
      detailMode?: "explain" | "raw";
    }
  | {
      kind: "patch";
      itemId?: string;
      toolCallId?: string;
      phase?: string;
      title?: string;
      name?: string;
      added?: string[];
      modified?: string[];
      deleted?: string[];
      summary?: string;
    }
  | { kind: "concurrent_items"; progressTexts: string[] }
  | { kind: "partial"; text: string }
  | { kind: "assistant_start" }
  | { kind: "reasoning"; text?: string; isReasoningSnapshot?: boolean }
  | { kind: "reasoning_end" }
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

function expectNativeProgressStart(chunks: unknown[]) {
  expect(postMessageMock).not.toHaveBeenCalled();
  expect(chatUpdateMock).not.toHaveBeenCalled();
  expectMockCallArgFields(startSlackStreamMock, 0, "native progress stream start", {
    channel: "C123",
    threadTs: THREAD_TS,
    taskDisplayMode: "plan",
    chunks,
  });
}

function expectNativeProgressAppend(index: number, chunks: unknown[]) {
  expectMockCallArgFields(appendSlackStreamMock, index, "native progress stream append", {
    chunks,
  });
}

function planUpdate(title: string) {
  return { type: "plan_update", title };
}

function taskUpdate(id: unknown, title: string, status: "in_progress" | "complete" | "error") {
  return { type: "task_update", id, title, status };
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

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function createDraftStreamStub() {
  return {
    update: vi.fn(),
    flush: noopAsync,
    clear: noopAsync,
    discardPending: noopAsync,
    seal: noopAsync,
    stop: noop,
    forceNewMessage: vi.fn(),
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
    bot_id: string;
    event_ts: string;
  }>;
  channelConfig?: Record<string, unknown> | null;
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
      app: { client: { chat: { postMessage: postMessageMock, update: chatUpdateMock } } },
      teamId: "T1",
      botUserId: "U_OPENCLAW",
      botId: "B_OPENCLAW",
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
    channelConfig: params?.channelConfig ?? null,
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

async function dispatchNativeProgressScenario(params: {
  events: typeof mockedReplyOptionEvents;
  finalPayload?: { text: string; isError?: boolean };
  progress?: { label?: string; maxLineChars?: number; nativeTaskCards?: true; render?: "rich" };
  replyToMode?: "off" | "first" | "all" | "batched";
}) {
  mockedNativeStreaming = true;
  mockedSlackStreamingMode = "progress";
  mockedSlackDraftMode = "status_final";
  mockedDispatchSequence =
    params.finalPayload === undefined ? [] : [{ kind: "final", payload: params.finalPayload }];
  mockedReplyOptionEvents = params.events;

  await dispatchPreparedSlackMessage(
    createPreparedSlackMessage({
      replyToMode: params.replyToMode,
      accountConfig: {
        streaming: {
          mode: "progress",
          progress: params.progress ?? { nativeTaskCards: true, render: "rich" },
        },
      },
    }),
  );
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
  recordInboundSession: recordInboundSessionMock,
}));

vi.mock("openclaw/plugin-sdk/channel-outbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-outbound")>();
  return {
    ...actual,
    createChannelMessageReplyPipeline: (params: {
      transformReplyPayload?: (payload: TestReplyPayload) => TestReplyPayload | null;
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
        ...(params.transformReplyPayload
          ? { transformReplyPayload: params.transformReplyPayload }
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
    resolveAgentOutboundIdentity: () => undefined,
    buildChannelProgressDraftLine: (params: {
      event?: string;
      itemId?: string;
      toolCallId?: string;
      progressText?: string;
      summary?: string;
      title?: string;
      name?: string;
      status?: string;
      exitCode?: number | null;
    }) => {
      if (params.event === "command-output") {
        const status =
          params.exitCode === 0
            ? "completed"
            : params.exitCode != null
              ? `exit ${params.exitCode}`
              : params.status;
        return {
          kind: "command-output",
          ...((params.itemId ?? params.toolCallId)
            ? { id: params.itemId ?? params.toolCallId }
            : {}),
          text: status ?? params.title ?? params.name ?? "exec",
          label: params.name ?? "exec",
          ...(status ? { status } : {}),
          toolName: params.name ?? "exec",
        };
      }
      const text = params.progressText ?? params.summary ?? params.title ?? params.name;
      return text
        ? {
            kind: "item",
            ...((params.itemId ?? params.toolCallId)
              ? { id: params.itemId ?? params.toolCallId }
              : {}),
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
        event?: string;
        itemId?: string;
        toolCallId?: string;
        itemKind?: string;
        args?: Record<string, unknown>;
        meta?: string;
        progressText?: string;
        summary?: string;
        title?: string;
        name?: string;
      },
    ) => {
      if (params.event === "tool") {
        const text = params.name;
        return text
          ? {
              kind: "tool",
              ...((params.itemId ?? params.toolCallId)
                ? { id: params.itemId ?? params.toolCallId }
                : {}),
              text,
              label: params.name ?? "Tool",
              ...(typeof params.args?.command === "string" ? { detail: params.args.command } : {}),
              toolName: params.name,
            }
          : undefined;
      }
      if (
        params.itemKind === "analysis" &&
        params.title === "Reasoning" &&
        !params.meta &&
        !params.summary &&
        !params.progressText
      ) {
        return undefined;
      }
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
    resolveChannelProgressDraftMaxLineChars: (entry?: {
      streaming?: { progress?: { maxLineChars?: number } };
    }) => entry?.streaming?.progress?.maxLineChars,
    mergeChannelProgressDraftLine: <TLine extends string | { id?: string; text: string }>(
      lines: TLine[],
      line: TLine,
      params: { maxLines: number },
    ) => {
      const normalized = typeof line === "string" ? line.trim() : line.text.trim();
      const lineId = typeof line === "object" ? line.id : undefined;
      if (lineId) {
        const index = lines.findIndex((entry) => typeof entry === "object" && entry.id === lineId);
        if (index >= 0) {
          const next = [...lines];
          next[index] = line;
          return next.slice(-params.maxLines);
        }
      }
      const previous = lines.at(-1);
      const previousText = typeof previous === "string" ? previous.trim() : previous?.text.trim();
      return previousText === normalized ? lines : [...lines, line].slice(-params.maxLines);
    },
    resolveChannelProgressDraftRender: (entry?: {
      streaming?: { progress?: { render?: "text" | "rich" } };
    }) => entry?.streaming?.progress?.render ?? "text",
    resolveChannelStreamingBlockEnabled: () => mockedBlockStreamingEnabled,
    resolveChannelStreamingNativeTransport: () => mockedNativeStreaming,
    resolveChannelStreamingPreviewToolProgress: (entry?: {
      streaming?: { progress?: { toolProgress?: boolean }; preview?: { toolProgress?: boolean } };
    }) =>
      entry?.streaming?.progress?.toolProgress ?? entry?.streaming?.preview?.toolProgress ?? true,
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
  };
});

vi.mock("openclaw/plugin-sdk/reply-history", () => ({
  clearHistoryEntriesIfEnabled: () => {},
  createChannelHistoryWindow: () => ({
    clear: () => {},
  }),
}));

vi.mock("openclaw/plugin-sdk/reply-payload", () => ({
  buildTtsSupplementMediaPayload: (payload: {
    text?: string;
    mediaUrl?: string;
    mediaUrls?: string[];
    audioAsVoice?: boolean;
    spokenText?: string;
    ttsSupplement?: { spokenText: string; visibleTextAlreadyDelivered?: boolean };
  }) => {
    const { text: _text, ...rest } = payload;
    return rest;
  },
  getReplyPayloadTtsSupplement: (payload: {
    mediaUrl?: string;
    mediaUrls?: string[];
    ttsSupplement?: { spokenText?: string; visibleTextAlreadyDelivered?: boolean };
  }) => {
    const hasMedia = Boolean(payload.mediaUrl || payload.mediaUrls?.length);
    const spokenText = payload.ttsSupplement?.spokenText?.trim();
    return hasMedia && spokenText
      ? {
          spokenText,
          ...(payload.ttsSupplement?.visibleTextAlreadyDelivered === true
            ? { visibleTextAlreadyDelivered: true }
            : {}),
        }
      : undefined;
  },
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
  resolvePinnedMainDmOwnerFromAllowlist: () => mockedPinnedMainDmOwner,
}));

vi.mock("openclaw/plugin-sdk/string-coerce-runtime", () => ({
  isRecord: (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value),
  normalizeOptionalLowercaseString: (value?: string) => value?.toLowerCase(),
  normalizeOptionalString: (value?: string) => value,
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
  readSlackReplyBlocks: () => mockedSlackReplyBlocks,
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
    transformReplyPayload?: (payload: TestReplyPayload) => TestReplyPayload | null;
    beforeDeliver?: (
      payload: TestReplyPayload,
      info: { kind: TestReplyDispatchKind },
    ) => Promise<TestReplyPayload | null> | TestReplyPayload | null;
    deliver: (payload: TestReplyPayload, info: { kind: TestReplyDispatchKind }) => Promise<void>;
  }) => ({
    dispatcher: {
      deliver: async (payload: TestReplyPayload, info: { kind: TestReplyDispatchKind }) => {
        const transformed = params.transformReplyPayload
          ? params.transformReplyPayload(payload)
          : payload;
        if (!transformed) {
          return;
        }
        const deliverPayload = params.beforeDeliver
          ? await params.beforeDeliver(transformed, info)
          : transformed;
        if (!deliverPayload) {
          return;
        }
        mockedQueuedDispatchCounts[info.kind] += 1;
        await params.deliver(deliverPayload, info);
      },
    },
    replyOptions: {},
    markDispatchIdle: () => {},
  }),
  dispatchReplyWithBufferedBlockDispatcher: async (params: {
    dispatcherOptions: {
      transformReplyPayload?: (payload: TestReplyPayload) => TestReplyPayload | null;
      beforeDeliver?: (
        payload: TestReplyPayload,
        info: { kind: TestReplyDispatchKind },
      ) => Promise<TestReplyPayload | null> | TestReplyPayload | null;
      deliver: (payload: TestReplyPayload, info: { kind: TestReplyDispatchKind }) => Promise<void>;
    };
    replyOptions?: {
      disableBlockStreaming?: boolean;
      suppressDefaultToolProgressMessages?: boolean;
      onItemEvent?: (payload: {
        kind?: string;
        itemId?: string;
        progressText?: string;
        summary?: string;
        title?: string;
        name?: string;
        phase?: string;
        status?: string;
        meta?: string;
      }) => Promise<void> | void;
      onToolStart?: (payload: {
        itemId?: string;
        toolCallId?: string;
        name: string;
        phase?: string;
        args?: Record<string, unknown>;
        detailMode?: "explain" | "raw";
      }) => Promise<void> | void;
      onPatchSummary?: (payload: {
        itemId?: string;
        toolCallId?: string;
        phase?: string;
        title?: string;
        name?: string;
        added?: string[];
        modified?: string[];
        deleted?: string[];
        summary?: string;
      }) => Promise<void> | void;
      onAssistantMessageStart?: () => Promise<void> | void;
      onReasoningEnd?: () => Promise<void> | void;
      onReasoningStream?: (payload?: {
        text?: string;
        isReasoningSnapshot?: boolean;
      }) => Promise<void> | void;
      onPartialReply?: (payload: { text: string }) => Promise<void> | void;
    };
  }) => {
    capturedReplyOptions = params.replyOptions;
    if (mockedReplyOptionEvents.length > 0) {
      for (const entry of mockedReplyOptionEvents) {
        if (entry.kind === "item") {
          await params.replyOptions?.onItemEvent?.({
            kind: entry.itemKind,
            itemId: entry.itemId,
            progressText: entry.progressText,
            summary: entry.summary,
            title: entry.title,
            name: entry.name,
            phase: entry.phase,
            status: entry.status,
            meta: entry.meta,
          });
        } else if (entry.kind === "tool_start") {
          await params.replyOptions?.onToolStart?.({
            itemId: entry.itemId,
            toolCallId: entry.toolCallId,
            name: entry.name,
            phase: entry.phase,
            args: entry.args,
            detailMode: entry.detailMode,
          });
        } else if (entry.kind === "patch") {
          await params.replyOptions?.onPatchSummary?.({
            itemId: entry.itemId,
            toolCallId: entry.toolCallId,
            phase: entry.phase,
            title: entry.title,
            name: entry.name,
            added: entry.added,
            modified: entry.modified,
            deleted: entry.deleted,
            summary: entry.summary,
          });
        } else if (entry.kind === "concurrent_items") {
          await Promise.all(
            entry.progressTexts.map((progressText) =>
              Promise.resolve(params.replyOptions?.onItemEvent?.({ progressText })),
            ),
          );
        } else if (entry.kind === "assistant_start") {
          await params.replyOptions?.onAssistantMessageStart?.();
        } else if (entry.kind === "reasoning") {
          await params.replyOptions?.onReasoningStream?.({
            text: entry.text,
            isReasoningSnapshot: entry.isReasoningSnapshot,
          });
        } else if (entry.kind === "reasoning_end") {
          await params.replyOptions?.onReasoningEnd?.();
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
      const transformed = params.dispatcherOptions.transformReplyPayload
        ? params.dispatcherOptions.transformReplyPayload(entry.payload)
        : entry.payload;
      if (!transformed) {
        continue;
      }
      const deliverPayload = params.dispatcherOptions.beforeDeliver
        ? await params.dispatcherOptions.beforeDeliver(transformed, { kind: entry.kind })
        : transformed;
      if (!deliverPayload) {
        continue;
      }
      mockedQueuedDispatchCounts[entry.kind] += 1;
      await params.dispatcherOptions.deliver(deliverPayload, { kind: entry.kind });
    }
    return {
      queuedFinal: false,
      counts: { ...mockedQueuedDispatchCounts },
    };
  },
  dispatchInboundMessage: async (params: {
    replyOptions?: {
      disableBlockStreaming?: boolean;
      suppressDefaultToolProgressMessages?: boolean;
      onAssistantMessageStart?: () => Promise<void> | void;
      onReasoningEnd?: () => Promise<void> | void;
      onReasoningStream?: (payload?: {
        text?: string;
        isReasoningSnapshot?: boolean;
      }) => Promise<void> | void;
      onItemEvent?: (payload: {
        kind?: string;
        itemId?: string;
        progressText?: string;
        summary?: string;
        title?: string;
        name?: string;
        phase?: string;
        status?: string;
        meta?: string;
      }) => Promise<void> | void;
      onToolStart?: (payload: {
        itemId?: string;
        toolCallId?: string;
        name: string;
        phase?: string;
        args?: Record<string, unknown>;
        detailMode?: "explain" | "raw";
      }) => Promise<void> | void;
      onPatchSummary?: (payload: {
        itemId?: string;
        toolCallId?: string;
        phase?: string;
        title?: string;
        name?: string;
        added?: string[];
        modified?: string[];
        deleted?: string[];
        summary?: string;
      }) => Promise<void> | void;
      onPartialReply?: (payload: { text: string }) => Promise<void> | void;
    };
    dispatcher: {
      deliver: (payload: TestReplyPayload, info: { kind: TestReplyDispatchKind }) => Promise<void>;
    };
  }) => {
    capturedReplyOptions = params.replyOptions;
    if (mockedReplyOptionEvents.length > 0) {
      for (const entry of mockedReplyOptionEvents) {
        if (entry.kind === "item") {
          await params.replyOptions?.onItemEvent?.({
            kind: entry.itemKind,
            itemId: entry.itemId,
            progressText: entry.progressText,
            summary: entry.summary,
            title: entry.title,
            name: entry.name,
            phase: entry.phase,
            status: entry.status,
            meta: entry.meta,
          });
        } else if (entry.kind === "tool_start") {
          await params.replyOptions?.onToolStart?.({
            itemId: entry.itemId,
            toolCallId: entry.toolCallId,
            name: entry.name,
            phase: entry.phase,
            args: entry.args,
            detailMode: entry.detailMode,
          });
        } else if (entry.kind === "patch") {
          await params.replyOptions?.onPatchSummary?.({
            itemId: entry.itemId,
            toolCallId: entry.toolCallId,
            phase: entry.phase,
            title: entry.title,
            name: entry.name,
            added: entry.added,
            modified: entry.modified,
            deleted: entry.deleted,
            summary: entry.summary,
          });
        } else if (entry.kind === "concurrent_items") {
          await Promise.all(
            entry.progressTexts.map((progressText) =>
              Promise.resolve(params.replyOptions?.onItemEvent?.({ progressText })),
            ),
          );
        } else if (entry.kind === "partial") {
          await params.replyOptions?.onPartialReply?.({ text: entry.text });
        } else if (entry.kind === "assistant_start") {
          await params.replyOptions?.onAssistantMessageStart?.();
        } else if (entry.kind === "reasoning") {
          await params.replyOptions?.onReasoningStream?.({
            text: entry.text,
            isReasoningSnapshot: entry.isReasoningSnapshot,
          });
        } else {
          await params.replyOptions?.onReasoningEnd?.();
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
      counts: { ...mockedQueuedDispatchCounts },
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
    chatUpdateMock.mockClear();
    recordInboundSessionMock.mockReset();
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
    mockedPinnedMainDmOwner = undefined;
    capturedReplyOptions = undefined;
    capturedStatusReactionOptions = undefined;
    capturedTyping = undefined;
    mockedReplyThreadTs = THREAD_TS;
    mockedReplyThreadTsSequence = undefined;
    mockedSlackReplyBlocks = undefined;
    mockedDispatchSequence = [{ kind: "final", payload: { text: FINAL_REPLY_TEXT } }];
    mockedQueuedDispatchCounts = { tool: 0, block: 0, final: 0 };
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

  it("passes accepted Slack bot messages through the shared bot loop guard", async () => {
    const base = {
      cfg: {
        channels: {
          defaults: {
            botLoopProtection: {
              maxEventsPerWindow: 1,
              windowSeconds: 60,
              cooldownSeconds: 60,
            },
          },
        },
      },
      accountConfig: { allowBots: true },
      message: {
        channel: "C_LOOP_SLACK",
        bot_id: "B_OTHER",
        user: undefined,
      },
    };

    await dispatchPreparedSlackMessage(
      createPreparedSlackMessage({
        ...base,
        message: {
          ...base.message,
          ts: "900.001",
          event_ts: "900.001",
        },
      }),
    );
    await dispatchPreparedSlackMessage(
      createPreparedSlackMessage({
        ...base,
        message: {
          ...base.message,
          ts: "900.002",
          event_ts: "900.002",
        },
      }),
    );

    expect(recordInboundSessionMock).toHaveBeenCalledTimes(1);
    expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
  });

  it("restores Slack status reactions when bot loop protection drops a turn", async () => {
    const base = {
      cfg: {
        messages: {
          statusReactions: { enabled: true },
        },
        channels: {
          defaults: {
            botLoopProtection: {
              maxEventsPerWindow: 1,
              windowSeconds: 60,
              cooldownSeconds: 60,
            },
          },
        },
      },
      accountConfig: { allowBots: true },
      message: {
        channel: "C_LOOP_SLACK_STATUS",
        bot_id: "B_OTHER",
        user: undefined,
      },
    };

    await dispatchPreparedSlackMessage(
      createPreparedSlackMessage({
        ...base,
        message: {
          ...base.message,
          ts: "910.001",
          event_ts: "910.001",
        },
      }),
    );

    for (const value of Object.values(statusReactionControllerMock)) {
      value.mockClear();
    }

    await dispatchPreparedSlackMessage(
      createPreparedSlackMessage({
        ...base,
        ackReactionMessageTs: "910.002",
        ackReactionPromise: Promise.resolve(true),
        message: {
          ...base.message,
          ts: "910.002",
          event_ts: "910.002",
        },
      }),
    );

    expect(recordInboundSessionMock).toHaveBeenCalledTimes(1);
    expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
    expect(statusReactionControllerMock.setQueued).toHaveBeenCalledTimes(1);
    expect(statusReactionControllerMock.restoreInitial).toHaveBeenCalledTimes(1);
    expect(statusReactionControllerMock.setDone).not.toHaveBeenCalled();
  });

  it("layers Slack channel bot loop overrides over account settings field-by-field", async () => {
    const base = {
      cfg: {
        channels: {
          defaults: {
            botLoopProtection: {
              maxEventsPerWindow: 20,
              windowSeconds: 1,
              cooldownSeconds: 60,
            },
          },
        },
      },
      accountConfig: {
        allowBots: true,
        botLoopProtection: {
          windowSeconds: 120,
          cooldownSeconds: 240,
        },
      },
      channelConfig: {
        botLoopProtection: {
          maxEventsPerWindow: 1,
        },
      },
      message: {
        channel: "C_LOOP_SLACK_LAYERED",
        bot_id: "B_OTHER_LAYERED",
        user: undefined,
      },
    };

    await dispatchPreparedSlackMessage(
      createPreparedSlackMessage({
        ...base,
        message: {
          ...base.message,
          ts: "900.001",
          event_ts: "900.001",
        },
      }),
    );
    await dispatchPreparedSlackMessage(
      createPreparedSlackMessage({
        ...base,
        message: {
          ...base.message,
          ts: "961.001",
          event_ts: "961.001",
        },
      }),
    );

    expect(recordInboundSessionMock).toHaveBeenCalledTimes(1);
    expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
  });

  it("updates non-main DM last-route metadata on the prepared direct session", async () => {
    mockedPinnedMainDmOwner = "U2";
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
          SessionKey: "agent:main:slack:direct:u1",
        },
      }),
    );

    expect(updateLastRouteMock).toHaveBeenCalledWith({
      storePath: "/tmp/openclaw-store.json",
      sessionKey: "agent:main:slack:direct:u1",
      deliveryContext: {
        channel: "slack",
        to: "user:U1",
        accountId: "default",
        threadId: "500.000",
      },
      ctx: {
        MessageThreadId: "500.000",
        SessionKey: "agent:main:slack:direct:u1",
      },
    });
  });

  it("uses DM transport thread metadata for last-route updates", async () => {
    await dispatchPreparedSlackMessage(
      createPreparedSlackMessage({
        isDirectMessage: true,
        message: {
          channel: "D123",
          user: "U1",
          ts: "701.000",
          thread_ts: "701.000",
        },
        route: {
          agentId: "main",
          mainSessionKey: "agent:main:main",
          sessionKey: "agent:main:main",
          lastRoutePolicy: "main",
        },
        ctxPayload: {
          MessageThreadId: undefined,
          ReplyToId: "701.000",
          TransportThreadId: "701.000",
          SessionKey: "agent:main:main",
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
        threadId: "701.000",
      },
      ctx: {
        ReplyToId: "701.000",
        TransportThreadId: "701.000",
        SessionKey: "agent:main:main",
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
          SessionKey: "agent:main:main",
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
        SessionKey: "agent:main:main",
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

  it("does not clear a finalized Slack draft when a later tool warning is delivered", async () => {
    const draftStream = {
      ...createDraftStreamStub(),
      flush: vi.fn(noopAsync),
      clear: vi.fn(noopAsync),
      discardPending: vi.fn(noopAsync),
      seal: vi.fn(noopAsync),
    };
    createSlackDraftStreamMock.mockReturnValueOnce(draftStream);
    finalizeSlackPreviewEditMock.mockResolvedValueOnce(undefined);
    mockedDispatchSequence = [
      { kind: "final", payload: { text: "answer" } },
      { kind: "final", payload: { text: "⚠️ Apply Patch failed", isError: true } },
    ];

    await dispatchPreparedSlackMessage(
      createPreparedSlackMessage({
        accountConfig: { streaming: { mode: "partial", preview: { toolProgress: false } } },
      }),
    );

    expect(finalizeSlackPreviewEditMock).toHaveBeenCalledTimes(1);
    expectMockCallArgFields(finalizeSlackPreviewEditMock, 0, "preview edit params", {
      channelId: "C123",
      messageId: "171234.567",
      text: "answer",
    });
    const delivered = requireRecord(
      requireMockCall(deliverRepliesMock, 0, "deliver replies")[0],
      "deliver replies params",
    );
    expect(delivered.replies).toEqual([{ text: "⚠️ Apply Patch failed", isError: true }]);
    expect(draftStream.seal).toHaveBeenCalledTimes(1);
    expect(draftStream.clear).not.toHaveBeenCalled();
  });

  it("does not reuse draft cleanup after a normally delivered final reply", async () => {
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
        payload: { text: "answer", mediaUrl: "https://example.com/final.png" },
      },
      { kind: "final", payload: { text: "late cleanup failed", isError: true } },
    ];

    await dispatchPreparedSlackMessage(createPreparedSlackMessage());

    expect(finalizeSlackPreviewEditMock).not.toHaveBeenCalled();
    expect(deliverRepliesMock).toHaveBeenCalledTimes(2);
    expect(draftStream.clear).toHaveBeenCalledTimes(1);
    const firstDelivered = requireRecord(
      requireMockCall(deliverRepliesMock, 0, "deliver replies")[0],
      "deliver replies params",
    );
    expect(firstDelivered.replies).toEqual([
      { text: "answer", mediaUrl: "https://example.com/final.png" },
    ]);
    const lateDelivered = requireRecord(
      requireMockCall(deliverRepliesMock, 1, "deliver replies")[0],
      "deliver replies params",
    );
    expect(lateDelivered.replies).toEqual([{ text: "late cleanup failed", isError: true }]);
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

  it("shows reasoning text in Slack progress draft previews", async () => {
    const draftStream = createDraftStreamStub();
    createSlackDraftStreamMock.mockReturnValueOnce(draftStream);
    mockedDispatchSequence = [];
    mockedReplyOptionEvents = [
      { kind: "tool_start", name: "exec" },
      { kind: "item", itemKind: "analysis", title: "Reasoning" },
      { kind: "reasoning", text: "Reading" },
      { kind: "reasoning", text: " the Slack handler" },
    ];

    await dispatchPreparedSlackMessage(
      createPreparedSlackMessage({
        accountConfig: { streaming: { progress: { label: "Shelling" } } },
      }),
    );

    expect(draftStream.update).toHaveBeenLastCalledWith(
      ["Shelling", "• exec", "• Reading the Slack handler"].join("\n"),
    );
    const updates = draftStream.update.mock.calls.map((call) => String(call[0]));
    expect(updates.join("\n")).not.toContain("Reasoning");
  });

  it("replaces Slack reasoning snapshots instead of appending duplicates", async () => {
    const draftStream = createDraftStreamStub();
    createSlackDraftStreamMock.mockReturnValueOnce(draftStream);
    mockedDispatchSequence = [];
    mockedReplyOptionEvents = [
      { kind: "tool_start", name: "exec" },
      { kind: "reasoning", text: "<think>Checking </think>", isReasoningSnapshot: true },
      {
        kind: "reasoning",
        text: "<think>Reading\n\nChecking </think>",
        isReasoningSnapshot: true,
      },
    ];

    await dispatchPreparedSlackMessage(
      createPreparedSlackMessage({
        accountConfig: { streaming: { progress: { label: "Shelling" } } },
      }),
    );

    expect(draftStream.update).toHaveBeenLastCalledWith(
      ["Shelling", "• exec", "• Reading Checking"].join("\n"),
    );
    const updates = draftStream.update.mock.calls.map((call) => String(call[0]));
    expect(updates.join("\n")).not.toContain("Checking Reading");
  });

  it("keeps plain Slack reasoning content that starts with Thinking", async () => {
    const draftStream = createDraftStreamStub();
    createSlackDraftStreamMock.mockReturnValueOnce(draftStream);
    mockedDispatchSequence = [];
    mockedReplyOptionEvents = [
      {
        kind: "reasoning",
        text: "Thinking about Slack preview state",
        isReasoningSnapshot: true,
      },
    ];

    await dispatchPreparedSlackMessage(
      createPreparedSlackMessage({
        accountConfig: { streaming: { progress: { label: "Shelling" } } },
      }),
    );

    expect(draftStream.update).toHaveBeenLastCalledWith(
      ["Shelling", "• Thinking about Slack preview state"].join("\n"),
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

  it("renders rich status-final progress drafts as legacy Slack section blocks and finalizes once", async () => {
    const draftStream = {
      ...createDraftStreamStub(),
      flush: vi.fn(noopAsync),
      clear: vi.fn(noopAsync),
      discardPending: vi.fn(noopAsync),
      seal: vi.fn(noopAsync),
    };
    createSlackDraftStreamMock.mockReturnValueOnce(draftStream);
    finalizeSlackPreviewEditMock.mockResolvedValueOnce(undefined);
    mockedSlackStreamingMode = "progress";
    mockedSlackDraftMode = "status_final";
    mockedDispatchSequence = [{ kind: "final", payload: { text: FINAL_REPLY_TEXT } }];
    mockedReplyOptionEvents = [
      { kind: "item", progressText: "tool one" },
      { kind: "partial", text: "partial answer" },
      { kind: "item", progressText: "tool two" },
    ];

    await dispatchPreparedSlackMessage(
      createPreparedSlackMessage({
        accountConfig: { streaming: { progress: { label: "Shelling", render: "rich" } } },
      }),
    );

    expect(draftStream.update).toHaveBeenLastCalledWith({
      text: ["Shelling", "• tool one", "• tool two"].join("\n"),
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: "*Shelling*" },
        },
        {
          type: "section",
          fields: [
            { type: "mrkdwn", text: "• *Update*" },
            { type: "mrkdwn", text: "—" },
          ],
        },
        {
          type: "section",
          fields: [
            { type: "mrkdwn", text: "• *Update*" },
            { type: "mrkdwn", text: "—" },
          ],
        },
      ],
    });
    expectMockCallArgFields(finalizeSlackPreviewEditMock, 0, "preview edit params", {
      channelId: "C123",
      messageId: "171234.567",
      text: FINAL_REPLY_TEXT,
    });
    expect(deliverRepliesMock).not.toHaveBeenCalled();
    expect(draftStream.clear).not.toHaveBeenCalled();
  });

  it("keeps unlabeled rich Slack progress drafts as legacy section blocks", async () => {
    const draftStream = {
      ...createDraftStreamStub(),
      flush: vi.fn(noopAsync),
      clear: vi.fn(noopAsync),
      discardPending: vi.fn(noopAsync),
      seal: vi.fn(noopAsync),
    };
    createSlackDraftStreamMock.mockReturnValueOnce(draftStream);
    finalizeSlackPreviewEditMock.mockResolvedValueOnce(undefined);
    mockedSlackStreamingMode = "progress";
    mockedSlackDraftMode = "status_final";
    mockedDispatchSequence = [{ kind: "final", payload: { text: FINAL_REPLY_TEXT } }];
    mockedReplyOptionEvents = [
      { kind: "item", progressText: "tool one" },
      { kind: "partial", text: "partial answer" },
      { kind: "item", progressText: "tool two" },
    ];

    await dispatchPreparedSlackMessage(
      createPreparedSlackMessage({
        accountConfig: { streaming: { progress: { render: "rich" } } },
      }),
    );

    expect(draftStream.update).toHaveBeenLastCalledWith({
      text: ["Thinking", "• tool one", "• tool two"].join("\n"),
      blocks: [
        {
          type: "section",
          fields: [
            { type: "mrkdwn", text: "• *Update*" },
            { type: "mrkdwn", text: "—" },
          ],
        },
        {
          type: "section",
          fields: [
            { type: "mrkdwn", text: "• *Update*" },
            { type: "mrkdwn", text: "—" },
          ],
        },
      ],
    });
    expect(finalizeSlackPreviewEditMock).toHaveBeenCalledTimes(1);
    expect(deliverRepliesMock).not.toHaveBeenCalled();
  });

  it("mandatory E2E: streams native Slack progress with the newest meaningful plan title when no explicit label exists", async () => {
    await dispatchNativeProgressScenario({
      finalPayload: { text: FINAL_REPLY_TEXT },
      events: [
        { kind: "item", progressText: "tool one" },
        { kind: "item", progressText: "tool two" },
        { kind: "item", progressText: "tool three" },
      ],
    });

    expect(createSlackDraftStreamMock).not.toHaveBeenCalled();
    expectNativeProgressStart([
      planUpdate("tool one"),
      taskUpdate("item_1", "tool one", "in_progress"),
    ]);
    expectNativeProgressAppend(0, [
      planUpdate("tool two"),
      taskUpdate("item_1", "tool one", "in_progress"),
      taskUpdate("item_2", "tool two", "in_progress"),
    ]);
    expectNativeProgressAppend(2, [
      planUpdate("tool three"),
      taskUpdate("item_1", "tool one", "complete"),
      taskUpdate("item_2", "tool two", "complete"),
      taskUpdate("item_3", "tool three", "complete"),
    ]);
    expect(stopSlackStreamMock).toHaveBeenCalledTimes(1);
    expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
    expectDeliverReplyCall(0, FINAL_REPLY_TEXT);
  });

  it("starts native Slack progress on a single tool item before final text and completes it once", async () => {
    await dispatchNativeProgressScenario({
      finalPayload: { text: FINAL_REPLY_TEXT },
      events: [{ kind: "item", progressText: "slow tool" }],
    });

    expect(createSlackDraftStreamMock).not.toHaveBeenCalled();
    expectNativeProgressStart([
      planUpdate("slow tool"),
      taskUpdate("item_1", "slow tool", "in_progress"),
    ]);
    expectNativeProgressAppend(0, [
      planUpdate("slow tool"),
      taskUpdate("item_1", "slow tool", "complete"),
    ]);
    expect(startSlackStreamMock.mock.invocationCallOrder[0]).toBeLessThan(
      appendSlackStreamMock.mock.invocationCallOrder[0] ?? 0,
    );
    expect(stopSlackStreamMock).toHaveBeenCalledTimes(1);
    expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
    expectDeliverReplyCall(0, FINAL_REPLY_TEXT);
  });

  it("does not start a text stream for native progress mode when no progress card exists", async () => {
    await dispatchNativeProgressScenario({
      finalPayload: { text: FINAL_REPLY_TEXT },
      events: [],
    });

    expect(startSlackStreamMock).not.toHaveBeenCalled();
    expect(appendSlackStreamMock).not.toHaveBeenCalled();
    expect(stopSlackStreamMock).not.toHaveBeenCalled();
    expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
    expectDeliverReplyCall(0, FINAL_REPLY_TEXT);
  });

  it("starts native Slack progress from the first running tool callback before final text", async () => {
    const taskId = expect.stringMatching(/^exec_call_1_[a-f0-9]{8}$/);

    await dispatchNativeProgressScenario({
      finalPayload: { text: FINAL_REPLY_TEXT },
      events: [
        {
          kind: "tool_start",
          itemId: "exec-call-1",
          toolCallId: "tool-call-1",
          name: "bash",
          phase: "start",
        },
      ],
    });

    expect(createSlackDraftStreamMock).not.toHaveBeenCalled();
    expectNativeProgressStart([planUpdate("bash"), taskUpdate(taskId, "bash", "in_progress")]);
    expectNativeProgressAppend(0, [planUpdate("bash"), taskUpdate(taskId, "bash", "complete")]);
    expect(startSlackStreamMock.mock.invocationCallOrder[0]).toBeLessThan(
      appendSlackStreamMock.mock.invocationCallOrder[0] ?? 0,
    );
    expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
    expectDeliverReplyCall(0, FINAL_REPLY_TEXT);
  });

  it("keeps final fallback in the planned thread when native Slack progress start fails", async () => {
    startSlackStreamMock.mockRejectedValueOnce(new Error("start stream failed"));
    mockedReplyThreadTsSequence = [THREAD_TS, undefined];

    await dispatchNativeProgressScenario({
      replyToMode: "first",
      finalPayload: { text: FINAL_REPLY_TEXT },
      events: [{ kind: "item", progressText: "slow tool" }],
    });

    expect(startSlackStreamMock).toHaveBeenCalledTimes(1);
    expect(appendSlackStreamMock).not.toHaveBeenCalled();
    expect(stopSlackStreamMock).not.toHaveBeenCalled();
    expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
    expectDeliverReplyCall(0, FINAL_REPLY_TEXT);
  });

  it("marks native Slack progress tasks as error when final text is an error", async () => {
    await dispatchNativeProgressScenario({
      finalPayload: { text: "tool failed", isError: true },
      events: [{ kind: "item", progressText: "failing tool" }],
    });

    expectNativeProgressStart([
      planUpdate("failing tool"),
      taskUpdate("item_1", "failing tool", "in_progress"),
    ]);
    expectNativeProgressAppend(0, [
      planUpdate("failing tool"),
      taskUpdate("item_1", "failing tool", "error"),
    ]);
    expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
    const deliverParams = requireRecord(
      requireMockCall(deliverRepliesMock, 0, "deliver replies")[0],
      "deliver replies params",
    );
    expectRecordFields(deliverParams, { replyThreadTs: THREAD_TS });
    expect(deliverParams.replies).toEqual([{ text: "tool failed", isError: true }]);
  });

  it("completes a native Slack progress plan even when no final text is sent", async () => {
    await dispatchNativeProgressScenario({
      events: [{ kind: "concurrent_items", progressTexts: ["tool one", "tool two", "tool three"] }],
    });

    expectNativeProgressStart([
      planUpdate("tool three"),
      taskUpdate("item_1", "tool one", "in_progress"),
      taskUpdate("item_2", "tool two", "in_progress"),
      taskUpdate("item_3", "tool three", "in_progress"),
    ]);
    expect(appendSlackStreamMock).not.toHaveBeenCalled();
    expect(deliverRepliesMock).not.toHaveBeenCalled();
    expectMockCallArgFields(stopSlackStreamMock, 0, "native progress stream stop", {
      chunks: [
        planUpdate("tool three"),
        taskUpdate("item_1", "tool one", "complete"),
        taskUpdate("item_2", "tool two", "complete"),
        taskUpdate("item_3", "tool three", "complete"),
      ],
    });
  });

  it("mandatory E2E: preserves an explicit configured native Slack progress plan title", async () => {
    await dispatchNativeProgressScenario({
      finalPayload: { text: FINAL_REPLY_TEXT },
      progress: { label: "Shelling", nativeTaskCards: true, render: "rich" },
      events: [
        { kind: "item", progressText: "tool one" },
        { kind: "item", progressText: "tool two" },
        { kind: "item", progressText: "tool three" },
      ],
    });

    expect(createSlackDraftStreamMock).not.toHaveBeenCalled();
    expectNativeProgressStart([
      planUpdate("Shelling"),
      taskUpdate("item_1", "tool one", "in_progress"),
    ]);
    expectNativeProgressAppend(2, [
      planUpdate("Shelling"),
      taskUpdate("item_1", "tool one", "complete"),
      taskUpdate("item_2", "tool two", "complete"),
      taskUpdate("item_3", "tool three", "complete"),
    ]);
    expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
    expectDeliverReplyCall(0, FINAL_REPLY_TEXT);
  });

  it("passes configured native progress max line chars into stream chunks", async () => {
    const taskId = expect.stringMatching(/^exec_call_1_[a-f0-9]{8}$/);

    await dispatchNativeProgressScenario({
      finalPayload: { text: FINAL_REPLY_TEXT },
      progress: { label: "Shelling", maxLineChars: 12, nativeTaskCards: true, render: "rich" },
      events: [
        {
          kind: "tool_start",
          itemId: "exec-call-1",
          toolCallId: "tool-call-1",
          name: "bash",
          phase: "start",
          args: { command: "1234567890abcdefghijklmnopqrstuvwxyz" },
        },
      ],
    });

    expectNativeProgressStart([
      planUpdate("Shelling"),
      taskUpdate(taskId, "bash — 12345…uvwxyz", "in_progress"),
    ]);
    expectNativeProgressAppend(0, [
      planUpdate("Shelling"),
      taskUpdate(taskId, "bash — 12345…uvwxyz", "complete"),
    ]);
  });

  it("preserves patch item identity in native Slack progress task updates", async () => {
    const taskId = expect.stringMatching(/^patch_item_1_[a-f0-9]{8}$/);

    await dispatchNativeProgressScenario({
      finalPayload: { text: FINAL_REPLY_TEXT },
      events: [
        {
          kind: "patch",
          itemId: "patch:item-1",
          toolCallId: "patch-call-1",
          name: "apply_patch",
          phase: "end",
          summary: "updated Slack progress tests",
        },
      ],
    });

    expectNativeProgressStart([
      planUpdate("updated Slack progress tests"),
      taskUpdate(taskId, "updated Slack progress tests", "in_progress"),
    ]);
    expectNativeProgressAppend(0, [
      planUpdate("updated Slack progress tests"),
      taskUpdate(taskId, "updated Slack progress tests", "complete"),
    ]);
  });

  it("preserves the last rich Slack progress lines after a draft boundary status update", async () => {
    const draftStream = {
      ...createDraftStreamStub(),
      flush: vi.fn(noopAsync),
      clear: vi.fn(noopAsync),
      discardPending: vi.fn(noopAsync),
      seal: vi.fn(noopAsync),
    };
    createSlackDraftStreamMock.mockReturnValueOnce(draftStream);
    finalizeSlackPreviewEditMock.mockResolvedValueOnce(undefined);
    mockedSlackStreamingMode = "progress";
    mockedSlackDraftMode = "status_final";
    mockedDispatchSequence = [{ kind: "final", payload: { text: FINAL_REPLY_TEXT } }];
    mockedReplyOptionEvents = [
      { kind: "item", progressText: "tool one" },
      { kind: "item", progressText: "tool two" },
      { kind: "assistant_start" },
      { kind: "partial", text: "partial answer" },
    ];

    await dispatchPreparedSlackMessage(
      createPreparedSlackMessage({
        accountConfig: { streaming: { progress: { label: "Shelling", render: "rich" } } },
      }),
    );

    expect(draftStream.forceNewMessage).toHaveBeenCalledTimes(1);
    expect(draftStream.update).toHaveBeenLastCalledWith({
      text: ["Shelling", "• tool one", "• tool two"].join("\n"),
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: "*Shelling*" },
        },
        {
          type: "section",
          fields: [
            { type: "mrkdwn", text: "• *Update*" },
            { type: "mrkdwn", text: "—" },
          ],
        },
        {
          type: "section",
          fields: [
            { type: "mrkdwn", text: "• *Update*" },
            { type: "mrkdwn", text: "—" },
          ],
        },
      ],
    });
    expect(finalizeSlackPreviewEditMock).toHaveBeenCalledTimes(1);
    expect(deliverRepliesMock).not.toHaveBeenCalled();
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

  it("preserves hidden-title rich Slack progress drafts when the label is hidden", async () => {
    const draftStream = {
      ...createDraftStreamStub(),
      flush: vi.fn(noopAsync),
      clear: vi.fn(noopAsync),
      discardPending: vi.fn(noopAsync),
      seal: vi.fn(noopAsync),
    };
    createSlackDraftStreamMock.mockReturnValueOnce(draftStream);
    finalizeSlackPreviewEditMock.mockResolvedValueOnce(undefined);
    mockedSlackStreamingMode = "progress";
    mockedSlackDraftMode = "status_final";
    mockedDispatchSequence = [{ kind: "final", payload: { text: FINAL_REPLY_TEXT } }];
    mockedReplyOptionEvents = [
      { kind: "item", progressText: "tool one" },
      { kind: "partial", text: "partial answer" },
      { kind: "item", progressText: "tool two" },
    ];

    await dispatchPreparedSlackMessage(
      createPreparedSlackMessage({
        accountConfig: { streaming: { progress: { label: false, render: "rich" } } },
      }),
    );

    expect(draftStream.update).toHaveBeenLastCalledWith({
      text: ["• tool one", "• tool two"].join("\n"),
      blocks: [
        {
          type: "section",
          fields: [
            { type: "mrkdwn", text: "• *Update*" },
            { type: "mrkdwn", text: "—" },
          ],
        },
        {
          type: "section",
          fields: [
            { type: "mrkdwn", text: "• *Update*" },
            { type: "mrkdwn", text: "—" },
          ],
        },
      ],
    });
    expect(finalizeSlackPreviewEditMock).toHaveBeenCalledTimes(1);
    expect(deliverRepliesMock).not.toHaveBeenCalled();
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

  it("suppresses reasoning payloads in the non-streaming delivery path", async () => {
    mockedNativeStreaming = false;
    mockedDispatchSequence = [
      { kind: "block", payload: { text: "Reasoning:\n_hidden_", isReasoning: true } },
      { kind: "final", payload: { text: FINAL_REPLY_TEXT } },
    ];

    await dispatchPreparedSlackMessage(createPreparedSlackMessage());

    expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
    expectDeliverReplyCall(0, FINAL_REPLY_TEXT);
  });

  it("does not count suppressed reasoning-only payloads as delivered", async () => {
    mockedNativeStreaming = false;
    mockedDispatchSequence = [
      { kind: "final", payload: { text: "Reasoning:\n_hidden_", isReasoning: true } },
    ];

    await dispatchPreparedSlackMessage(
      createPreparedSlackMessage({
        cfg: {
          messages: {
            statusReactions: { enabled: true },
          },
        },
        ackReactionMessageTs: "171234.111",
        ackReactionPromise: Promise.resolve(true),
      }),
    );

    expect(deliverRepliesMock).not.toHaveBeenCalled();
    expect(statusReactionControllerMock.setDone).not.toHaveBeenCalled();
    expect(statusReactionControllerMock.restoreInitial).toHaveBeenCalledTimes(1);
  });

  it("does not consume first-reply delivery state for suppressed reasoning payloads", async () => {
    mockedNativeStreaming = false;
    mockedReplyThreadTsSequence = [THREAD_TS, undefined];
    mockedDispatchSequence = [
      { kind: "block", payload: { text: "hidden", isReasoning: true } },
      { kind: "final", payload: { text: FINAL_REPLY_TEXT } },
    ];

    await dispatchPreparedSlackMessage(
      createPreparedSlackMessage({
        replyToMode: "first",
      }),
    );

    expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
    expectDeliverReplyCall(0, FINAL_REPLY_TEXT, { replyThreadTs: THREAD_TS });
  });

  it("suppresses reasoning payloads in non-streaming delivery when mixed with tool payloads", async () => {
    mockedNativeStreaming = false;
    mockedDispatchSequence = [
      { kind: "tool", payload: { text: "tool result" } },
      { kind: "block", payload: { text: "Let me think about this...", isReasoning: true } },
      { kind: "block", payload: { text: "I need to consider...", isReasoning: true } },
      { kind: "final", payload: { text: FINAL_REPLY_TEXT } },
    ];

    await dispatchPreparedSlackMessage(createPreparedSlackMessage());

    expect(deliverRepliesMock).toHaveBeenCalledTimes(2);
    expectDeliverReplyCall(0, "tool result");
    expectDeliverReplyCall(1, FINAL_REPLY_TEXT);
  });

  it("suppresses reasoning payloads via deliverNormally fallback from streaming errors", async () => {
    mockedNativeStreaming = true;
    mockedDispatchSequence = [
      { kind: "block", payload: { text: "Let me analyze...", isReasoning: true } },
      { kind: "final", payload: { text: FINAL_REPLY_TEXT } },
    ];
    startSlackStreamMock.mockRejectedValueOnce(new Error("stream setup failed"));

    await dispatchPreparedSlackMessage(createPreparedSlackMessage());

    for (const call of deliverRepliesMock.mock.calls) {
      const params = (call as unknown[])[0] as {
        replies: Array<{ isReasoning?: boolean }>;
      };
      for (const reply of params.replies) {
        expect(reply.isReasoning).not.toBe(true);
      }
    }
    expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
    expectDeliverReplyCall(0, FINAL_REPLY_TEXT);
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
    finalizeSlackPreviewEditMock.mockResolvedValueOnce(undefined);
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

  it("keeps the preview and sends media-only for TTS supplement finals", async () => {
    const draftStream = {
      ...createDraftStreamStub(),
      flush: vi.fn(noopAsync),
      clear: vi.fn(noopAsync),
      discardPending: vi.fn(noopAsync),
      seal: vi.fn(noopAsync),
    };
    mockedSlackReplyBlocks = [
      {
        type: "section",
        text: { type: "mrkdwn", text: "Spoken answer" },
      },
    ];
    createSlackDraftStreamMock.mockReturnValueOnce(draftStream);
    finalizeSlackPreviewEditMock.mockResolvedValueOnce(undefined);
    mockedReplyThreadTsSequence = [undefined];
    mockedDispatchSequence = [
      {
        kind: "final",
        payload: {
          mediaUrl: "https://example.com/tts.mp3",
          audioAsVoice: true,
          spokenText: "Spoken answer",
          ttsSupplement: { spokenText: "Spoken answer" },
        },
      },
    ];

    await dispatchPreparedSlackMessage(createPreparedSlackMessage());

    expect(draftStream.flush).toHaveBeenCalledTimes(1);
    expect(draftStream.clear).not.toHaveBeenCalled();
    expectMockCallArgFields(finalizeSlackPreviewEditMock, 0, "preview edit params", {
      channelId: "C123",
      messageId: "171234.567",
      text: "Spoken answer",
      blocks: mockedSlackReplyBlocks,
    });
    const delivered = requireRecord(
      requireMockCall(deliverRepliesMock, 0, "deliver replies")[0],
      "deliver replies params",
    );
    expectRecordFields(delivered, { replyThreadTs: THREAD_TS });
    expect(delivered.replies).toEqual([
      {
        mediaUrl: "https://example.com/tts.mp3",
        audioAsVoice: true,
        spokenText: "Spoken answer",
        ttsSupplement: { spokenText: "Spoken answer" },
      },
    ]);
  });

  it("suppresses duplicate TTS supplement finals after preview finalization", async () => {
    const draftStream = {
      ...createDraftStreamStub(),
      flush: vi.fn(noopAsync),
      clear: vi.fn(noopAsync),
      discardPending: vi.fn(noopAsync),
      seal: vi.fn(noopAsync),
    };
    createSlackDraftStreamMock.mockReturnValueOnce(draftStream);
    finalizeSlackPreviewEditMock.mockResolvedValueOnce(undefined);
    const payload = {
      text: "Spoken answer",
      mediaUrl: "https://example.com/tts.mp3",
      audioAsVoice: true,
      spokenText: "Spoken answer",
      ttsSupplement: { spokenText: "Spoken answer" },
    };
    mockedDispatchSequence = [
      { kind: "final", payload },
      { kind: "final", payload },
    ];

    await dispatchPreparedSlackMessage(createPreparedSlackMessage());

    expect(finalizeSlackPreviewEditMock).toHaveBeenCalledTimes(1);
    expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
    const delivered = requireRecord(
      requireMockCall(deliverRepliesMock, 0, "deliver replies")[0],
      "deliver replies params",
    );
    expect(delivered.replies).toEqual([
      {
        mediaUrl: "https://example.com/tts.mp3",
        audioAsVoice: true,
        spokenText: "Spoken answer",
        ttsSupplement: { spokenText: "Spoken answer" },
      },
    ]);
  });

  it("falls back with visible text when TTS supplement preview finalization fails", async () => {
    const draftStream = {
      ...createDraftStreamStub(),
      flush: vi.fn(noopAsync),
      clear: vi.fn(noopAsync),
      discardPending: vi.fn(noopAsync),
      seal: vi.fn(noopAsync),
    };
    createSlackDraftStreamMock.mockReturnValueOnce(draftStream);
    mockedReplyThreadTsSequence = [undefined];
    mockedDispatchSequence = [
      {
        kind: "final",
        payload: {
          mediaUrl: "https://example.com/tts.mp3",
          audioAsVoice: true,
          spokenText: "Spoken answer",
          ttsSupplement: { spokenText: "Spoken answer" },
        },
      },
    ];

    await dispatchPreparedSlackMessage(createPreparedSlackMessage());

    expect(finalizeSlackPreviewEditMock).toHaveBeenCalledTimes(1);
    expect(draftStream.discardPending).toHaveBeenCalled();
    expect(draftStream.clear).toHaveBeenCalledTimes(1);
    const delivered = requireRecord(
      requireMockCall(deliverRepliesMock, 0, "deliver replies")[0],
      "deliver replies params",
    );
    expectRecordFields(delivered, { replyThreadTs: THREAD_TS });
    expect(delivered.replies).toEqual([
      {
        text: "Spoken answer",
        mediaUrl: "https://example.com/tts.mp3",
        audioAsVoice: true,
        spokenText: "Spoken answer",
        ttsSupplement: { spokenText: "Spoken answer" },
      },
    ]);
  });

  it("falls back with visible text when TTS supplement preview has no message id", async () => {
    const draftStream = {
      ...createDraftStreamStub(),
      flush: vi.fn(noopAsync),
      clear: vi.fn(noopAsync),
      discardPending: vi.fn(noopAsync),
      seal: vi.fn(noopAsync),
      messageId: () => undefined,
    };
    createSlackDraftStreamMock.mockReturnValueOnce(draftStream);
    mockedDispatchSequence = [
      {
        kind: "final",
        payload: {
          mediaUrl: "https://example.com/tts.mp3",
          audioAsVoice: true,
          spokenText: "Spoken answer",
          ttsSupplement: { spokenText: "Spoken answer" },
        },
      },
    ];

    await dispatchPreparedSlackMessage(createPreparedSlackMessage());

    expect(finalizeSlackPreviewEditMock).not.toHaveBeenCalled();
    expect(draftStream.discardPending).toHaveBeenCalled();
    const delivered = requireRecord(
      requireMockCall(deliverRepliesMock, 0, "deliver replies")[0],
      "deliver replies params",
    );
    expect(delivered.replies).toEqual([
      {
        text: "Spoken answer",
        mediaUrl: "https://example.com/tts.mp3",
        audioAsVoice: true,
        spokenText: "Spoken answer",
        ttsSupplement: { spokenText: "Spoken answer" },
      },
    ]);
  });

  it("keeps already-delivered TTS supplements audio-only without a draft preview", async () => {
    mockedSlackStreamingMode = "off";
    mockedBlockStreamingEnabled = true;
    mockedDispatchSequence = [
      {
        kind: "final",
        payload: {
          mediaUrl: "https://example.com/tts.mp3",
          audioAsVoice: true,
          spokenText: "Spoken answer",
          ttsSupplement: {
            spokenText: "Spoken answer",
            visibleTextAlreadyDelivered: true,
          },
        },
      },
    ];

    await dispatchPreparedSlackMessage(createPreparedSlackMessage());

    expect(finalizeSlackPreviewEditMock).not.toHaveBeenCalled();
    const delivered = requireRecord(
      requireMockCall(deliverRepliesMock, 0, "deliver replies")[0],
      "deliver replies params",
    );
    expect(delivered.replies).toEqual([
      {
        mediaUrl: "https://example.com/tts.mp3",
        audioAsVoice: true,
        spokenText: "Spoken answer",
        ttsSupplement: {
          spokenText: "Spoken answer",
          visibleTextAlreadyDelivered: true,
        },
      },
    ]);
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
