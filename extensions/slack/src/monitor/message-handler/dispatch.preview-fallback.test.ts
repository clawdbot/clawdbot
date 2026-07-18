// Slack tests cover dispatch.preview fallback plugin behavior.
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const FINAL_REPLY_TEXT = "final answer";
const THREAD_TS = "thread-1";
const SAME_TEXT = "same reply";

const createSlackDraftStreamMock = vi.fn();
const deliverRepliesMock = vi.fn(
  async () => undefined as { messageId?: string; channelId?: string } | undefined,
);
const finalizeSlackPreviewEditMock = vi.fn(async () => {});
const normalizeSlackOutboundTextMock = vi.fn((value: string) => value.trim());
const postMessageMock = vi.fn(async () => ({ ok: true, ts: "171234.999" }));
const chatUpdateMock = vi.fn(async () => ({ ok: true, ts: "171234.999" }));
const recordSlackThreadParticipationMock = vi.fn();
const updateLastRouteMock = vi.fn(async () => {});
const appendSlackStreamMock = vi.fn(async () => {});
const startSlackStreamMock = vi.fn(async () => ({
  channel: "C123",
  threadTs: THREAD_TS,
  stopped: false,
  delivered: true,
  pendingText: "",
}));
const stopSlackStreamMock = vi.fn(async (_params?: unknown) => ({}) as { messageId?: string });
const emitSlackMessageSentHooksMock = vi.fn(() => {});
const reactSlackMessageMock = vi.fn(async () => {});
const removeSlackReactionMock = vi.fn(async () => {});
const logVerboseMock = vi.fn();
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
      sourceReplyDeliveryMode?: "automatic" | "message_tool_only";
      suppressTyping?: boolean;
      suppressDefaultToolProgressMessages?: boolean;
      commentaryProgressEnabled?: boolean;
      progressPreambleEnabled?: boolean;
      commentaryPayloadsEnabled?: boolean;
      onVerboseProgressVisibility?: (isActive: () => boolean) => void;
      allowProgressCallbacksWhenSourceDeliverySuppressed?: boolean;
      allowToolLifecycleWhenProgressHidden?: boolean;
      turnAdoptionLifecycle?: object;
      onAssistantMessageStart?: () => Promise<void> | void;
      onReasoningEnd?: () => Promise<void> | void;
      onReasoningStream?: (payload?: {
        text?: string;
        isReasoningSnapshot?: boolean;
      }) => Promise<void> | void;
      onItemEvent?: (payload: {
        kind?: string;
        itemId?: string;
        toolCallId?: string;
        progressText?: string;
        summary?: string;
        title?: string;
        name?: string;
        phase?: string;
        status?: string;
        meta?: string;
      }) => Promise<void> | void;
      onCommandOutput?: (payload: {
        itemId?: string;
        toolCallId?: string;
        phase?: string;
        title?: string;
        name?: string;
        status?: string;
        exitCode?: number | null;
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
      onPlanUpdate?: (payload: {
        phase?: string;
        explanation?: string;
        steps?: Array<{
          step: string;
          status: "pending" | "in_progress" | "completed";
        }>;
      }) => Promise<void> | void;
      onPartialReply?: (payload: { text: string }) => Promise<void> | void;
      onQueuedFollowupAdmitted?: () => Promise<void> | void;
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
let mockedSlackIsThreadReply = true;
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
  presentation?: { blocks: unknown[] };
};
type TestDispatchCounts = Record<TestReplyDispatchKind, number>;
type TestDispatchSequenceEntry =
  | {
      kind: TestReplyDispatchKind;
      payload: TestReplyPayload;
    }
  | { kind: "queued_followup" }
  | { kind: "item"; progressText: string };
let mockedDispatchSequence: TestDispatchSequenceEntry[] = [];
let mockedQueuedDispatchCounts: TestDispatchCounts = { tool: 0, block: 0, final: 0 };
let mockedDispatcherCapturesDeliveryErrors = false;

let mockedProgressEvents: string[] = [];
let mockedEmptyProgressToolName: string | undefined;
let mockedReplyOptionEvents: Array<
  | {
      kind: "item";
      itemId?: string;
      toolCallId?: string;
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
  | {
      kind: "command_output";
      itemId?: string;
      toolCallId?: string;
      phase?: string;
      title?: string;
      name?: string;
      explanation?: string;
      status?: string;
      exitCode?: number | null;
    }
  | {
      kind: "plan";
      phase?: string;
      explanation?: string;
      steps: Array<{ step: string; status: "pending" | "in_progress" | "completed" }>;
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

function createSlackPlatformError(error: string, details?: { needed?: string; provided?: string }) {
  // Mirrors @slack/web-api 7.18.0 platformErrorFromResult: message plus structured result data.
  return Object.assign(new Error(`An API error occurred: ${error}`), {
    code: "slack_webapi_platform_error",
    data: { ok: false, error, ...details },
  });
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

function taskUpdate(
  id: unknown,
  title: string,
  status: "pending" | "in_progress" | "complete" | "error",
) {
  return { type: "task_update", id, title, status };
}

function contentTaskId(prefix: string) {
  return expect.stringMatching(new RegExp(`^${prefix}_[a-f0-9]{8}_1$`, "u"));
}

function collectNativeTaskUpdates() {
  const chunks: unknown[] = [];
  const collectChunks = (call: unknown[]) => {
    const arg = requireRecord(call[0], "native progress call");
    if (Array.isArray(arg.chunks)) {
      chunks.push(...arg.chunks);
    }
  };
  for (const call of startSlackStreamMock.mock.calls) {
    collectChunks(call);
  }
  for (const call of appendSlackStreamMock.mock.calls) {
    collectChunks(call);
  }
  for (const call of stopSlackStreamMock.mock.calls) {
    collectChunks(call);
  }
  return chunks.flatMap((chunk) => {
    const record = requireRecord(chunk, "native progress chunk");
    return record.type === "task_update" ? [record] : [];
  });
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
    loadingMessages?: string[];
  }) => Promise<void>;
  typingReaction?: string;
  ackReactionMessageTs?: string;
  ackReactionPromise?: Promise<boolean> | null;
  relayIdentity?: { username?: string; iconUrl?: string; iconEmoji?: string };
  turnAdoptionLifecycle?: object;
  eventScope?: {
    apiAppId: string;
    enterpriseId: string;
    isEnterpriseInstall: true;
    teamId: string;
    client: Record<string, unknown>;
  };
}) {
  const routeSessionKey = params?.route?.sessionKey ?? "agent:agent-1:slack:C123";
  const mainSessionKey = params?.route?.mainSessionKey ?? "main";
  const lastRoutePolicy =
    params?.route?.lastRoutePolicy ?? (routeSessionKey === mainSessionKey ? "main" : "session");
  const message = {
    channel: "C123",
    ts: "171234.111",
    thread_ts: THREAD_TS,
    user: "U123",
    ...params?.message,
  };

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
    relayIdentity: params?.relayIdentity,
    turnAdoptionLifecycle: params?.turnAdoptionLifecycle,
    eventScope: params?.eventScope,
    message,
    route: {
      agentId: "agent-1",
      accountId: "default",
      mainSessionKey,
      sessionKey: routeSessionKey,
      lastRoutePolicy,
      ...params?.route,
    },
    channelConfig: params?.channelConfig ?? null,
    replyTarget: `channel:${message.channel}`,
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
  progress?: {
    label?: string | false;
    maxLineChars?: number;
    nativeTaskCards?: true;
    render?: "rich";
    toolProgress?: boolean;
  };
  replyToMode?: "off" | "first" | "all" | "batched";
  eventScope?: {
    apiAppId: string;
    enterpriseId: string;
    isEnterpriseInstall: true;
    teamId: string;
    client: Record<string, unknown>;
  };
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
      eventScope: params.eventScope,
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

vi.mock("openclaw/plugin-sdk/channel-outbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-outbound")>();
  return {
    ...actual,
    createChannelProgressDraftCompositor: (
      params: Parameters<typeof actual.createChannelProgressDraftCompositor>[0],
    ) =>
      actual.createChannelProgressDraftCompositor({
        ...params,
        // Gate timing lives in the compositor suite; dispatch tests exercise
        // Slack rendering and delivery after work admits the draft.
        setTimeoutFn: ((handler: () => void) => {
          handler();
          return 0 as never;
        }) as unknown as typeof setTimeout,
        clearTimeoutFn: (() => {}) as typeof clearTimeout,
      }),
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
      ctx?: { ChatType?: string; InboundEventKind?: string };
      requested?: "automatic" | "message_tool_only";
    }) => {
      if (params.requested) {
        return params.requested;
      }
      if (params.ctx?.InboundEventKind === "room_event") {
        return "message_tool_only";
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
      explanation?: string;
      title?: string;
      name?: string;
      status?: string;
      exitCode?: number | null;
    }) => {
      if (params.event === "plan") {
        return params.explanation
          ? {
              kind: "plan",
              text: `🗺️ Update Plan: ${params.explanation}`,
              label: "Update Plan",
              detail: params.explanation,
              toolName: "update_plan",
            }
          : undefined;
      }
      if (params.event === "command-output") {
        const status =
          params.exitCode === 0
            ? "completed"
            : params.exitCode != null
              ? `exit ${params.exitCode}`
              : params.status;
        const id = params.toolCallId ? `command:${params.toolCallId}` : params.itemId;
        return {
          kind: "command-output",
          ...(id ? { id } : {}),
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
        if (params.name === mockedEmptyProgressToolName) {
          return undefined;
        }
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
        const id = params.toolCallId ? `command:${params.toolCallId}` : params.itemId;
        return {
          kind: "item",
          ...(id ? { id } : {}),
          text: "🛠️ Exec",
          label: "Exec",
        };
      }
      const text = params.progressText ?? params.summary ?? params.title ?? params.name;
      const id =
        params.itemKind === "command" || params.name === "exec"
          ? params.toolCallId
            ? `command:${params.toolCallId}`
            : params.itemId
          : undefined;
      return text
        ? {
            kind: "item",
            ...(id ? { id } : {}),
            text,
            label: params.title ?? params.name ?? "Update",
          }
        : undefined;
    },
    createChannelProgressDraftGate: (params: { onStart: () => void | Promise<void> }) => {
      let started = false;
      const startNow = async () => {
        if (!started) {
          started = true;
          await params.onStart();
        }
      };
      return {
        get hasStarted() {
          return started;
        },
        async noteWork() {
          // Gate timing is covered by the SDK suite; these tests exercise the
          // downstream Slack renderer after an explicit start.
          await startNow();
          return started;
        },
        startNow,
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
        return [...lines, line].slice(-params.maxLines);
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
      Boolean(
        name &&
        ![
          "message",
          "messages",
          "reply",
          "send",
          "reaction",
          "react",
          "typing",
          "update_plan",
        ].includes(name.toLowerCase()),
      ),
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
  logVerbose: logVerboseMock,
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
  markdownToSlackMrkdwnChunks: (value: string) => [value],
  normalizeSlackOutboundText: normalizeSlackOutboundTextMock,
}));

vi.mock("../../limits.js", () => ({
  SLACK_TEXT_LIMIT: 4000,
}));

vi.mock("../../sent-thread-cache.js", () => ({
  recordSlackThreadParticipation: recordSlackThreadParticipationMock,
}));

vi.mock("../../stream-mode.js", () => ({
  applyAppendOnlyStreamUpdate: ({ incoming }: { incoming: string }) => ({
    changed: true,
    rendered: incoming,
    source: incoming,
  }),
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
    session.pendingText = "";
    session.stopped = !session.delivered;
  },
  SlackStreamNotDeliveredError: TestSlackStreamNotDeliveredError,
  startSlackStream: startSlackStreamMock,
  stopSlackStream: async (params: { session: { stopped: boolean } }) => {
    params.session.stopped = true;
    return await stopSlackStreamMock(params);
  },
}));

vi.mock("../../message-sent-hook.js", () => ({
  emitSlackMessageSentHooks: emitSlackMessageSentHooksMock,
}));

vi.mock("../../threading.js", () => ({
  resolveSlackThreadTargets: () => ({
    statusThreadTs: THREAD_TS,
    isThreadReply: mockedSlackIsThreadReply,
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
    peekThreadTs: () =>
      mockedReplyThreadTsSequence ? mockedReplyThreadTsSequence[0] : mockedReplyThreadTs,
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

vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>();
  type DispatchParams = Parameters<typeof actual.dispatchChannelInboundTurn>[0];
  return {
    ...actual,
    dispatchChannelInboundTurn: async (params: DispatchParams) => {
      capturedReplyOptions = params.replyOptions as typeof capturedReplyOptions;
      if (mockedReplyOptionEvents.length > 0) {
        for (const entry of mockedReplyOptionEvents) {
          if (entry.kind === "item") {
            await params.replyOptions?.onItemEvent?.({
              kind: entry.itemKind,
              itemId: entry.itemId,
              toolCallId: entry.toolCallId,
              progressText: entry.progressText,
              summary: entry.summary,
              title: entry.title,
              name: entry.name,
              phase: entry.phase,
              status: entry.status,
              meta: entry.meta,
            });
          } else if (entry.kind === "command_output") {
            await params.replyOptions?.onCommandOutput?.({
              itemId: entry.itemId,
              toolCallId: entry.toolCallId,
              phase: entry.phase,
              title: entry.title,
              name: entry.name,
              status: entry.status,
              exitCode: entry.exitCode,
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
          } else if (entry.kind === "plan") {
            await params.replyOptions?.onPlanUpdate?.({
              phase: entry.phase,
              explanation: entry.explanation,
              steps: entry.steps,
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
        if (entry.kind === "queued_followup") {
          await params.replyOptions?.onQueuedFollowupAdmitted?.();
          continue;
        }
        if (entry.kind === "item") {
          await params.replyOptions?.onItemEvent?.({ progressText: entry.progressText });
          continue;
        }
        const payload = entry.payload as ReplyPayload;
        const transformed = params.dispatcherOptions?.transformReplyPayload
          ? params.dispatcherOptions.transformReplyPayload(payload)
          : payload;
        if (!transformed) {
          continue;
        }
        const deliverPayload = params.dispatcherOptions?.beforeDeliver
          ? await params.dispatcherOptions.beforeDeliver(transformed, { kind: entry.kind })
          : transformed;
        if (!deliverPayload) {
          continue;
        }
        mockedQueuedDispatchCounts[entry.kind] += 1;
        try {
          await params.delivery.deliver(deliverPayload, { kind: entry.kind });
        } catch (error) {
          if (!mockedDispatcherCapturesDeliveryErrors) {
            throw error;
          }
          mockedQueuedDispatchCounts[entry.kind] -= 1;
        }
      }
      return {
        admission: { kind: "dispatch" } as const,
        dispatched: true as const,
        ctxPayload: params.ctxPayload,
        routeSessionKey: params.route.sessionKey,
        dispatchResult: {
          queuedFinal: false,
          counts: { ...mockedQueuedDispatchCounts },
        },
      };
    },
  };
});

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
    normalizeSlackOutboundTextMock.mockClear();
    postMessageMock.mockClear();
    chatUpdateMock.mockClear();
    recordSlackThreadParticipationMock.mockReset();
    updateLastRouteMock.mockReset();
    appendSlackStreamMock.mockReset();
    startSlackStreamMock.mockReset();
    stopSlackStreamMock.mockReset();
    reactSlackMessageMock.mockReset();
    removeSlackReactionMock.mockReset();
    logVerboseMock.mockReset();
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
    mockedSlackIsThreadReply = true;
    mockedDispatchSequence = [{ kind: "final", payload: { text: FINAL_REPLY_TEXT } }];
    mockedQueuedDispatchCounts = { tool: 0, block: 0, final: 0 };
    mockedDispatcherCapturesDeliveryErrors = false;
    mockedProgressEvents = [];
    mockedEmptyProgressToolName = undefined;
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
    stopSlackStreamMock.mockResolvedValue({});
    emitSlackMessageSentHooksMock.mockClear();
  });

  it("forwards durable ingress ownership into reply options", async () => {
    const turnAdoptionLifecycle = {
      admission: "exclusive",
      abortSignal: new AbortController().signal,
      onAdopted: vi.fn(),
      onDeferred: vi.fn(),
      onAbandoned: vi.fn(),
    };

    await dispatchPreparedSlackMessage(createPreparedSlackMessage({ turnAdoptionLifecycle }));

    expect(capturedReplyOptions?.turnAdoptionLifecycle).toBe(turnAdoptionLifecycle);
  });

  it("falls back to normal delivery when preview finalize fails", async () => {
    await dispatchPreparedSlackMessage(createPreparedSlackMessage());

    expect(finalizeSlackPreviewEditMock).toHaveBeenCalledTimes(1);
    expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
    expectDeliverReplyCall(0, FINAL_REPLY_TEXT);
  });

  it("uses the relay identity when the agent has no explicit Slack identity", async () => {
    const relayIdentity = { username: "Nik Team Claw" };

    await dispatchPreparedSlackMessage(createPreparedSlackMessage({ relayIdentity }));

    expect(createSlackDraftStreamMock).not.toHaveBeenCalled();
    expect(finalizeSlackPreviewEditMock).not.toHaveBeenCalled();
    expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
    expectDeliverReplyCall(0, FINAL_REPLY_TEXT, { identity: relayIdentity });
  });

  it("uses supported native Slack streaming authorship when a custom identity is active", async () => {
    mockedNativeStreaming = true;
    const relayIdentity = { username: "Nik Team Claw" };

    await dispatchPreparedSlackMessage(createPreparedSlackMessage({ relayIdentity }));

    expectMockCallArgFields(startSlackStreamMock, 0, "Slack stream start params", {
      text: FINAL_REPLY_TEXT,
      identity: relayIdentity,
    });
    expect(createSlackDraftStreamMock).not.toHaveBeenCalled();
    expect(deliverRepliesMock).not.toHaveBeenCalled();
  });

  it("does not create a Slack thread for top-level messages when replyToMode is off", async () => {
    mockedSlackStreamingMode = "off";
    mockedSlackIsThreadReply = false;

    await dispatchPreparedSlackMessage(createPreparedSlackMessage({ replyToMode: "off" }));

    expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
    expectDeliverReplyCall(0, FINAL_REPLY_TEXT, { replyThreadTs: undefined });
  });

  it("stays in an existing Slack thread when replyToMode is off", async () => {
    mockedSlackStreamingMode = "off";
    mockedSlackIsThreadReply = true;

    await dispatchPreparedSlackMessage(createPreparedSlackMessage({ replyToMode: "off" }));

    expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
    expectDeliverReplyCall(0, FINAL_REPLY_TEXT, { replyThreadTs: THREAD_TS });
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
    expect(emitSlackMessageSentHooksMock).toHaveBeenCalledTimes(1);
    expectMockCallArgFields(emitSlackMessageSentHooksMock, 0, "preview message_sent", {
      content: "✅",
      success: true,
      messageId: "171234.567",
      sessionKeyForInternalHooks: "agent:agent-1:slack:C123",
    });
    expect(deliverRepliesMock).not.toHaveBeenCalled();
    expect(draftStream.clear).not.toHaveBeenCalled();
  });

  it("finalizes native chart blocks without re-escaping accessible preview text", async () => {
    const draftStream = {
      ...createDraftStreamStub(),
      flush: vi.fn(noopAsync),
      clear: vi.fn(noopAsync),
      discardPending: vi.fn(noopAsync),
      seal: vi.fn(noopAsync),
    };
    const accessibleText =
      "Quarterly results\n\nRevenue (bar chart)\n- &lt;@U123&gt;: Q1: 12; Q2: 18";
    mockedSlackReplyBlocks = [
      {
        type: "section",
        text: { type: "mrkdwn", text: "Quarterly results", verbatim: true },
      },
      {
        type: "data_visualization",
        title: "Revenue",
        chart: {
          type: "bar",
          series: [
            {
              name: "<@U123>",
              data: [
                { label: "Q1", value: 12 },
                { label: "Q2", value: 18 },
              ],
            },
          ],
          axis_config: { categories: ["Q1", "Q2"] },
        },
      },
    ];
    createSlackDraftStreamMock.mockReturnValueOnce(draftStream);
    finalizeSlackPreviewEditMock.mockResolvedValueOnce(undefined);
    mockedDispatchSequence = [
      {
        kind: "final",
        payload: {
          text: "Quarterly results",
          presentation: {
            blocks: [
              {
                type: "chart",
                chartType: "bar",
                title: "Revenue",
                categories: ["Q1", "Q2"],
                series: [{ name: "<@U123>", values: [12, 18] }],
              },
            ],
          },
        },
      },
    ];

    await dispatchPreparedSlackMessage(createPreparedSlackMessage());

    expectMockCallArgFields(finalizeSlackPreviewEditMock, 0, "chart preview edit params", {
      channelId: "C123",
      messageId: "171234.567",
      text: accessibleText,
      blocks: mockedSlackReplyBlocks,
      threadTs: THREAD_TS,
    });
    expect(normalizeSlackOutboundTextMock).not.toHaveBeenCalled();
    expectMockCallArgFields(emitSlackMessageSentHooksMock, 0, "chart preview message_sent", {
      content: accessibleText,
      success: true,
      messageId: "171234.567",
    });
    expect(deliverRepliesMock).not.toHaveBeenCalled();
    expect(draftStream.clear).not.toHaveBeenCalled();
  });

  it("normalizes only authored preview text when blocks own their fallback", async () => {
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
        payload: {
          text: "**Summary**",
          presentation: {
            blocks: [
              {
                type: "buttons",
                buttons: [
                  {
                    label: "Owner <@U123>",
                    action: { type: "callback", value: "owner" },
                  },
                ],
              },
            ],
          },
        },
      },
    ];

    await dispatchPreparedSlackMessage(createPreparedSlackMessage());

    expect(normalizeSlackOutboundTextMock).toHaveBeenCalledTimes(1);
    expect(normalizeSlackOutboundTextMock).toHaveBeenCalledWith("**Summary**");
    expectMockCallArgFields(finalizeSlackPreviewEditMock, 0, "block preview edit params", {
      text: "**Summary**",
    });
  });

  it("delivers split table fallbacks normally instead of hiding them in a preview edit", async () => {
    const draftStream = {
      ...createDraftStreamStub(),
      flush: vi.fn(noopAsync),
      clear: vi.fn(noopAsync),
      discardPending: vi.fn(noopAsync),
      seal: vi.fn(noopAsync),
    };
    const payload = {
      text: "Accounts",
      presentation: {
        blocks: [
          {
            type: "table",
            caption: "Account owners",
            headers: ["Owner"],
            rows: Array.from({ length: 100 }, (_entry, index) => [
              `owner-${String(index)}-${"x".repeat(110)}`,
            ]),
          },
          {
            type: "buttons",
            buttons: [{ label: "Refresh", value: "refresh" }],
          },
        ],
      },
    };
    createSlackDraftStreamMock.mockReturnValueOnce(draftStream);
    mockedDispatchSequence = [{ kind: "final", payload }];

    await dispatchPreparedSlackMessage(createPreparedSlackMessage());

    expect(finalizeSlackPreviewEditMock).not.toHaveBeenCalled();
    const delivered = requireRecord(
      requireMockCall(deliverRepliesMock, 0, "deliver replies")[0],
      "deliver replies params",
    );
    expect(delivered.replies).toEqual([payload]);
  });

  it("keeps distinct split table fallbacks distinct in delivery tracking", async () => {
    mockedSlackStreamingMode = "off";
    const buildPayload = (owner: string) => ({
      text: "Accounts",
      presentation: {
        blocks: [
          {
            type: "table",
            caption: "Account owners",
            headers: ["Owner"],
            rows: Array.from({ length: 100 }, () => [`${owner}-${"x".repeat(110)}`]),
          },
        ],
      },
    });
    const firstPayload = buildPayload("Ada");
    const secondPayload = buildPayload("Grace");
    mockedDispatchSequence = [
      { kind: "final", payload: firstPayload },
      { kind: "final", payload: secondPayload },
    ];

    await dispatchPreparedSlackMessage(createPreparedSlackMessage());

    expect(deliverRepliesMock).toHaveBeenCalledTimes(2);
    const firstDelivery = requireRecord(
      requireMockCall(deliverRepliesMock, 0, "first table delivery")[0],
      "first table delivery params",
    );
    const secondDelivery = requireRecord(
      requireMockCall(deliverRepliesMock, 1, "second table delivery")[0],
      "second table delivery params",
    );
    expect(firstDelivery.replies).toEqual([firstPayload]);
    expect(secondDelivery.replies).toEqual([secondPayload]);
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
      eventScope: undefined,
    });
    expect(setSlackThreadStatus).toHaveBeenCalledWith({
      channelId: "C123",
      threadTs: THREAD_TS,
      status: "",
      eventScope: undefined,
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

  it("logs the formatted Slack error when adding the typing reaction fails", async () => {
    reactSlackMessageMock.mockRejectedValueOnce(
      createSlackPlatformError("missing_scope", {
        needed: "reactions:write",
        provided: "chat:write",
      }),
    );

    await dispatchPreparedSlackMessage(
      createPreparedSlackMessage({ typingReaction: "hourglass_flowing_sand" }),
    );
    await expect(requireCapturedTyping().start()).resolves.toBeUndefined();

    expect(logVerboseMock).toHaveBeenCalledWith(
      "slack send: typing reaction failed: An API error occurred: missing_scope; code: slack_webapi_platform_error; slack error: missing_scope; needed: reactions:write; provided: chat:write",
    );
  });

  it("logs the formatted Slack error when removing the typing reaction fails", async () => {
    removeSlackReactionMock.mockRejectedValueOnce(createSlackPlatformError("invalid_auth"));

    await dispatchPreparedSlackMessage(
      createPreparedSlackMessage({ typingReaction: "hourglass_flowing_sand" }),
    );
    const typing = requireCapturedTyping();
    await typing.start();
    await expect(typing.stop?.()).resolves.toBeUndefined();

    expect(logVerboseMock).toHaveBeenCalledWith(
      "slack send: typing reaction removal failed: An API error occurred: invalid_auth; code: slack_webapi_platform_error; slack error: invalid_auth",
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
    expect(capturedReplyOptions?.allowProgressCallbacksWhenSourceDeliverySuppressed).toBe(true);
    expect(capturedReplyOptions?.allowToolLifecycleWhenProgressHidden).toBe(true);
    expectRecordFields(requireRecord(capturedStatusReactionOptions, "status reaction options"), {
      enabled: true,
      initialEmoji: "eyes",
    });
    expect(statusReactionControllerMock.setQueued).toHaveBeenCalledTimes(1);
    expect(statusReactionControllerMock.setDone).toHaveBeenCalledTimes(1);
  });

  it("keeps Slack lifecycle reactions off by default when an ack reaction exists", async () => {
    await dispatchPreparedSlackMessage(
      createPreparedSlackMessage({
        ackReactionMessageTs: "171234.111",
        ackReactionPromise: Promise.resolve(true),
      }),
    );

    expectRecordFields(requireRecord(capturedStatusReactionOptions, "status reaction options"), {
      enabled: false,
      initialEmoji: "eyes",
    });
    expect(statusReactionControllerMock.setQueued).not.toHaveBeenCalled();
    expect(statusReactionControllerMock.setDone).not.toHaveBeenCalled();
  });

  it("keeps Slack lifecycle reactions off for ambient room-event acks", async () => {
    await dispatchPreparedSlackMessage(
      createPreparedSlackMessage({
        cfg: { messages: { statusReactions: { enabled: true } } },
        ctxPayload: { ChatType: "channel", InboundEventKind: "room_event" },
        ackReactionMessageTs: "171234.111",
        ackReactionPromise: Promise.resolve(true),
      }),
    );

    expectRecordFields(requireRecord(capturedStatusReactionOptions, "status reaction options"), {
      enabled: false,
      initialEmoji: "eyes",
    });
    expect(statusReactionControllerMock.setQueued).not.toHaveBeenCalled();
    expect(statusReactionControllerMock.setDone).not.toHaveBeenCalled();
  });

  it("suppresses Slack typing for ambient room events", async () => {
    await dispatchPreparedSlackMessage(
      createPreparedSlackMessage({
        cfg: { messages: { groupChat: { visibleReplies: "automatic" } } },
        ctxPayload: { ChatType: "channel", InboundEventKind: "room_event" },
      }),
    );

    expect(capturedReplyOptions?.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(capturedReplyOptions?.suppressTyping).toBe(true);
  });

  it("leaves Slack typing unsuppressed for normal channel turns", async () => {
    await dispatchPreparedSlackMessage(
      createPreparedSlackMessage({
        cfg: { messages: { groupChat: { visibleReplies: "automatic" } } },
        ctxPayload: { ChatType: "channel" },
      }),
    );

    expect(capturedReplyOptions?.sourceReplyDeliveryMode).toBe("automatic");
    expect(capturedReplyOptions?.suppressTyping).toBeUndefined();
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
    mockedSlackStreamingMode = "progress";
    mockedSlackDraftMode = "status_final";
    mockedReplyOptionEvents = [
      { kind: "tool_start", name: "exec" },
      { kind: "item", itemKind: "analysis", title: "Reasoning" },
      { kind: "reasoning", text: "Reading" },
      { kind: "reasoning", text: " the Slack handler" },
    ];

    await dispatchPreparedSlackMessage(
      createPreparedSlackMessage({
        accountConfig: { streaming: { mode: "progress", progress: { label: "Shelling" } } },
      }),
    );

    expect(draftStream.update).toHaveBeenLastCalledWith(
      ["Shelling", "", "• exec", "🧠 \\_Reading the Slack handler\\_"].join("\n"),
    );
    const updates = draftStream.update.mock.calls.map((call) => String(call[0]));
    expect(updates.join("\n")).not.toContain("Reasoning");
  });

  it("replaces Slack reasoning snapshots instead of appending duplicates", async () => {
    const draftStream = createDraftStreamStub();
    createSlackDraftStreamMock.mockReturnValueOnce(draftStream);
    mockedDispatchSequence = [];
    mockedSlackStreamingMode = "progress";
    mockedSlackDraftMode = "status_final";
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
        accountConfig: { streaming: { mode: "progress", progress: { label: "Shelling" } } },
      }),
    );

    expect(draftStream.update).toHaveBeenLastCalledWith(
      ["Shelling", "", "• exec", "🧠 \\_Reading Checking\\_"].join("\n"),
    );
    const updates = draftStream.update.mock.calls.map((call) => String(call[0]));
    expect(updates.join("\n")).not.toContain("Checking Reading");
  });

  it("extracts mm:think reasoning snapshots for Slack progress draft previews", async () => {
    const draftStream = createDraftStreamStub();
    createSlackDraftStreamMock.mockReturnValueOnce(draftStream);
    mockedDispatchSequence = [];
    mockedSlackStreamingMode = "progress";
    mockedSlackDraftMode = "status_final";
    mockedReplyOptionEvents = [
      {
        kind: "reasoning",
        text: "<mm:think>Reading\nChecking</mm:think>",
        isReasoningSnapshot: true,
      },
    ];

    await dispatchPreparedSlackMessage(
      createPreparedSlackMessage({
        accountConfig: { streaming: { mode: "progress", progress: { label: "Shelling" } } },
      }),
    );

    expect(draftStream.update).toHaveBeenLastCalledWith(
      ["Shelling", "", "🧠 \\_Reading Checking\\_"].join("\n"),
    );
    const updates = draftStream.update.mock.calls.map((call) => String(call[0]));
    expect(updates.join("\n")).toContain("Reading Checking");
  });

  it("keeps plain Slack reasoning content that starts with Thinking", async () => {
    const draftStream = createDraftStreamStub();
    createSlackDraftStreamMock.mockReturnValueOnce(draftStream);
    mockedDispatchSequence = [];
    mockedSlackStreamingMode = "progress";
    mockedSlackDraftMode = "status_final";
    mockedReplyOptionEvents = [
      {
        kind: "reasoning",
        text: "Thinking about Slack preview state",
        isReasoningSnapshot: true,
      },
    ];

    await dispatchPreparedSlackMessage(
      createPreparedSlackMessage({
        accountConfig: { streaming: { mode: "progress", progress: { label: "Shelling" } } },
      }),
    );

    expect(draftStream.update).toHaveBeenLastCalledWith(
      ["Shelling", "", "🧠 \\_Thinking about Slack preview state\\_"].join("\n"),
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
      ["Shelling", "", "• tool one", "• tool two"].join("\n"),
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
      text: ["Shelling", "", "• tool one", "• tool two"].join("\n"),
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
      text: expect.stringMatching(/⏱️ \d+s$/),
    });
    expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
    expect(draftStream.clear).not.toHaveBeenCalled();
  });

  it("keeps plan explanation in rich blocks with a fresh preamble", async () => {
    const draftStream = createDraftStreamStub();
    createSlackDraftStreamMock.mockReturnValueOnce(draftStream);
    mockedSlackStreamingMode = "progress";
    mockedSlackDraftMode = "status_final";
    mockedDispatchSequence = [];
    mockedReplyOptionEvents = [
      {
        kind: "item",
        itemKind: "preamble",
        itemId: "preamble-1",
        progressText: "Checking the workspace",
      },
      {
        kind: "plan",
        phase: "update",
        explanation: "Executing the checklist.",
        steps: [{ step: "Patch", status: "in_progress" }],
      },
    ];

    await dispatchPreparedSlackMessage(
      createPreparedSlackMessage({
        accountConfig: {
          streaming: { mode: "progress", progress: { label: "Shelling", render: "rich" } },
        },
      }),
    );

    expect(draftStream.update).toHaveBeenLastCalledWith({
      text: ["Shelling", "", "Checking the workspace", "", "▸ Patch"].join("\n"),
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: "*Shelling*" },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "_Checking the workspace — Executing the checklist._",
          },
        },
        {
          type: "section",
          text: { type: "mrkdwn", text: "▸ Patch" },
        },
      ],
    });
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
      text: ["Working", "", "• tool one", "• tool two"].join("\n"),
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
    expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
  });

  it("sends a progress final fresh before collapsing its draft to a receipt", async () => {
    const draftStream = { ...createDraftStreamStub(), clear: vi.fn(noopAsync) };
    createSlackDraftStreamMock.mockReturnValueOnce(draftStream);
    finalizeSlackPreviewEditMock.mockResolvedValueOnce(undefined);
    mockedReplyThreadTsSequence = [undefined];
    mockedSlackStreamingMode = "progress";
    mockedSlackDraftMode = "status_final";
    mockedDispatchSequence = [{ kind: "final", payload: { text: FINAL_REPLY_TEXT } }];
    mockedReplyOptionEvents = [
      {
        kind: "tool_start",
        itemId: "tool-1",
        name: "bash",
        phase: "start",
        args: { command: "pnpm test" },
      },
    ];

    await dispatchPreparedSlackMessage(
      createPreparedSlackMessage({
        accountConfig: { streaming: { mode: "progress", progress: { label: "Working" } } },
      }),
    );

    expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
    expectDeliverReplyCall(0, FINAL_REPLY_TEXT);
    expectMockCallArgFields(finalizeSlackPreviewEditMock, 0, "progress receipt edit", {
      channelId: "C123",
      messageId: "171234.567",
      text: expect.stringMatching(/^🛠️ 1 tool call · ⏱️ \d+s$/),
    });
    expect(deliverRepliesMock.mock.invocationCallOrder[0]).toBeLessThan(
      finalizeSlackPreviewEditMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(draftStream.clear).not.toHaveBeenCalled();
  });

  it("leaves a progress draft untouched when the fresh final send fails", async () => {
    const draftStream = { ...createDraftStreamStub(), clear: vi.fn(noopAsync) };
    createSlackDraftStreamMock.mockReturnValueOnce(draftStream);
    deliverRepliesMock.mockRejectedValueOnce(new Error("final send failed"));
    mockedSlackStreamingMode = "progress";
    mockedSlackDraftMode = "status_final";
    mockedDispatchSequence = [{ kind: "final", payload: { text: FINAL_REPLY_TEXT } }];
    mockedReplyOptionEvents = [{ kind: "item", progressText: "working" }];

    await expect(
      dispatchPreparedSlackMessage(
        createPreparedSlackMessage({
          accountConfig: { streaming: { mode: "progress", progress: { label: "Working" } } },
        }),
      ),
    ).rejects.toThrow("final send failed");

    expect(draftStream.update).toHaveBeenCalled();
    expect(finalizeSlackPreviewEditMock).not.toHaveBeenCalled();
    expect(draftStream.clear).not.toHaveBeenCalled();
  });

  it("keeps a progress draft for an error final without creating a receipt", async () => {
    const draftStream = { ...createDraftStreamStub(), clear: vi.fn(noopAsync) };
    createSlackDraftStreamMock.mockReturnValueOnce(draftStream);
    mockedSlackStreamingMode = "progress";
    mockedSlackDraftMode = "status_final";
    mockedDispatchSequence = [{ kind: "final", payload: { text: "tool failed", isError: true } }];
    mockedReplyOptionEvents = [{ kind: "item", progressText: "working" }];

    await dispatchPreparedSlackMessage(
      createPreparedSlackMessage({
        accountConfig: { streaming: { mode: "progress", progress: { label: "Working" } } },
      }),
    );

    expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
    expect(finalizeSlackPreviewEditMock).not.toHaveBeenCalled();
    expect(draftStream.clear).not.toHaveBeenCalled();
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
      taskUpdate(contentTaskId("item"), "tool one", "in_progress"),
    ]);
    expectNativeProgressAppend(0, [
      planUpdate("tool two"),
      taskUpdate(contentTaskId("item"), "tool one", "in_progress"),
      taskUpdate(contentTaskId("item"), "tool two", "in_progress"),
    ]);
    expectNativeProgressAppend(2, [
      planUpdate("tool three"),
      taskUpdate(contentTaskId("item"), "tool one", "complete"),
      taskUpdate(contentTaskId("item"), "tool two", "complete"),
      taskUpdate(contentTaskId("item"), "tool three", "complete"),
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
      taskUpdate(contentTaskId("item"), "slow tool", "in_progress"),
    ]);
    expectNativeProgressAppend(0, [
      planUpdate("slow tool"),
      taskUpdate(contentTaskId("item"), "slow tool", "complete"),
    ]);
    expect(startSlackStreamMock.mock.invocationCallOrder[0]).toBeLessThan(
      appendSlackStreamMock.mock.invocationCallOrder[0] ?? 0,
    );
    expect(stopSlackStreamMock).toHaveBeenCalledTimes(1);
    expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
    expectDeliverReplyCall(0, FINAL_REPLY_TEXT);
  });

  it("emits message_sent only once for native progress final replies (no double emit)", async () => {
    // In native-progress mode the final answer is delivered through
    // deliverNormally -> deliverReplies, which owns the message_sent emit. The
    // dispatch-level stream finalizer must NOT also emit for the same final
    // answer (regression for the streamedFinalContent double-emit bug).
    await dispatchNativeProgressScenario({
      finalPayload: { text: FINAL_REPLY_TEXT },
      events: [{ kind: "item", progressText: "slow tool" }],
    });

    // Final routed through deliverReplies (the owner of the emit here)...
    expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
    expectDeliverReplyCall(0, FINAL_REPLY_TEXT);
    // ...and the stream WAS finalized, so the old code would have double-emitted.
    expect(stopSlackStreamMock).toHaveBeenCalledTimes(1);
    // The dispatch-level finalizer must not emit (deliverReplies already does).
    expect(emitSlackMessageSentHooksMock).not.toHaveBeenCalled();
  });

  it("emits message_sent exactly once via the finalizer for a plain text-stream final reply", async () => {
    // Plain text-stream mode (no native progress card): the final answer is
    // flushed through the text stream and never goes through deliverReplies, so
    // the dispatch finalizer owns the single message_sent emit. This is the
    // positive counterpart to the native-progress no-double-emit regression.
    mockedNativeStreaming = true;
    mockedDispatchSequence = [{ kind: "final", payload: { text: FINAL_REPLY_TEXT } }];
    startSlackStreamMock.mockResolvedValueOnce({
      channel: "C123",
      threadTs: THREAD_TS,
      stopped: false,
      delivered: true,
      pendingText: "",
    });
    stopSlackStreamMock.mockResolvedValueOnce({ messageId: "171234.567" });

    await dispatchPreparedSlackMessage(
      createPreparedSlackMessage({
        isDirectMessage: true,
        message: { channel: "D123" },
        route: { sessionKey: "agent:agent-1:slack:direct:u123" },
        ctxPayload: {
          SessionKey: "agent:agent-1:slack:direct:u123:thread:thread-1",
          To: "user:U123",
          OriginatingTo: "user:U123",
        },
      }),
    );

    // The final was flushed through the stream, not deliverReplies.
    expect(deliverRepliesMock).not.toHaveBeenCalled();
    expect(stopSlackStreamMock).toHaveBeenCalledTimes(1);
    // The finalizer emits exactly once, with success and the delivered Slack ts,
    // and threads the canonical session key (mirrors the P2 fix in replies.ts:
    // the dispatch finalizer emit must also carry session correlation).
    expect(emitSlackMessageSentHooksMock).toHaveBeenCalledTimes(1);
    expectMockCallArgFields(emitSlackMessageSentHooksMock, 0, "finalizer message_sent", {
      content: FINAL_REPLY_TEXT,
      success: true,
      messageId: "171234.567",
      to: "user:U123",
      sessionKeyForInternalHooks: "agent:agent-1:slack:direct:u123:thread:thread-1",
    });
  });

  it("routes split table fallbacks around native text streaming", async () => {
    mockedNativeStreaming = true;
    const payload = {
      text: "Accounts",
      presentation: {
        blocks: [
          {
            type: "table",
            caption: "Account owners",
            headers: ["Owner"],
            rows: Array.from({ length: 100 }, (_entry, index) => [
              `owner-${String(index)}-${"x".repeat(110)}`,
            ]),
          },
        ],
      },
    };
    mockedDispatchSequence = [{ kind: "final", payload }];

    await dispatchPreparedSlackMessage(createPreparedSlackMessage());

    expect(startSlackStreamMock).not.toHaveBeenCalled();
    expect(appendSlackStreamMock).not.toHaveBeenCalled();
    const delivered = requireRecord(
      requireMockCall(deliverRepliesMock, 0, "split table delivery")[0],
      "split table delivery params",
    );
    expect(delivered.replies).toEqual([payload]);
  });

  it("emits message_sent for every final payload appended to one text stream", async () => {
    mockedNativeStreaming = true;
    mockedDispatchSequence = [
      { kind: "final", payload: { text: "answer" } },
      { kind: "final", payload: { text: "late warning", isError: true } },
    ];
    startSlackStreamMock.mockResolvedValueOnce({
      channel: "C123",
      threadTs: THREAD_TS,
      stopped: false,
      delivered: true,
      pendingText: "",
    });
    stopSlackStreamMock.mockResolvedValueOnce({ messageId: "171234.890" });

    await dispatchPreparedSlackMessage(createPreparedSlackMessage());

    expect(deliverRepliesMock).not.toHaveBeenCalled();
    expect(emitSlackMessageSentHooksMock).toHaveBeenCalledTimes(2);
    expectMockCallArgFields(emitSlackMessageSentHooksMock, 0, "first final message_sent", {
      content: "answer",
      success: true,
      messageId: "171234.890",
    });
    expectMockCallArgFields(emitSlackMessageSentHooksMock, 1, "second final message_sent", {
      content: "late warning",
      success: true,
      messageId: "171234.890",
    });
  });

  it("emits message_sent exactly once when stopSlackStream throws and the pending stream falls back", async () => {
    // The combined fallback send defers hooks so dispatch can preserve the
    // original final-payload boundary.
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
    deliverRepliesMock.mockResolvedValueOnce({
      messageId: "171234.901",
      channelId: "C123",
    });

    await dispatchPreparedSlackMessage(createPreparedSlackMessage());

    expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
    expectDeliverReplyCall(0, FINAL_REPLY_TEXT);
    expect(emitSlackMessageSentHooksMock).toHaveBeenCalledTimes(1);
    expectMockCallArgFields(emitSlackMessageSentHooksMock, 0, "fallback message_sent", {
      content: FINAL_REPLY_TEXT,
      success: true,
    });
    expect(
      requireRecord(
        requireMockCall(emitSlackMessageSentHooksMock, 0, "fallback message_sent")[0],
        "fallback message_sent",
      ),
    ).not.toHaveProperty("messageId");
  });

  it("emits message_sent for a tool-only stream fallback", async () => {
    mockedNativeStreaming = true;
    mockedDispatchSequence = [{ kind: "tool", payload: { text: "tool output" } }];
    const session = {
      channel: "C123",
      threadTs: THREAD_TS,
      stopped: false,
      delivered: false,
      pendingText: "tool output",
    };
    startSlackStreamMock.mockResolvedValueOnce(session);
    stopSlackStreamMock.mockRejectedValueOnce(
      new TestSlackStreamNotDeliveredError("tool output", "user_not_found"),
    );
    deliverRepliesMock.mockResolvedValueOnce({
      messageId: "171234.902",
      channelId: "C123",
    });

    await dispatchPreparedSlackMessage(createPreparedSlackMessage());

    expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
    expectDeliverReplyCall(0, "tool output");
    expect(emitSlackMessageSentHooksMock).toHaveBeenCalledTimes(1);
    expectMockCallArgFields(emitSlackMessageSentHooksMock, 0, "tool fallback message_sent", {
      content: "tool output",
      success: true,
    });
    expect(
      requireRecord(
        requireMockCall(emitSlackMessageSentHooksMock, 0, "tool fallback message_sent")[0],
        "tool fallback message_sent",
      ),
    ).not.toHaveProperty("messageId");
  });

  it("emits acknowledged finals before a pending stream suffix falls back", async () => {
    mockedNativeStreaming = true;
    mockedDispatchSequence = [
      { kind: "final", payload: { text: "already visible" } },
      { kind: "final", payload: { text: "still buffered" } },
    ];
    const session = {
      channel: "C123",
      threadTs: THREAD_TS,
      stopped: false,
      delivered: true,
      pendingText: "",
    };
    startSlackStreamMock.mockResolvedValueOnce(session);
    appendSlackStreamMock.mockImplementationOnce(async () => {
      session.pendingText = "\nstill buffered";
    });
    stopSlackStreamMock.mockRejectedValueOnce(
      new TestSlackStreamNotDeliveredError("still buffered", "user_not_found"),
    );

    await dispatchPreparedSlackMessage(createPreparedSlackMessage());

    expect(emitSlackMessageSentHooksMock).toHaveBeenCalledTimes(2);
    expectMockCallArgFields(emitSlackMessageSentHooksMock, 0, "acknowledged message_sent", {
      content: "already visible",
      success: true,
    });
    expectMockCallArgFields(emitSlackMessageSentHooksMock, 1, "fallback message_sent", {
      content: "still buffered",
      success: true,
    });
    expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
    expectDeliverReplyCall(0, "still buffered");
    expect(stopSlackStreamMock).toHaveBeenCalledTimes(2);
  });

  it("finalizes buffered finals natively before attempting fallback delivery", async () => {
    mockedNativeStreaming = true;
    mockedDispatchSequence = [
      { kind: "final", payload: { text: "already visible" } },
      { kind: "final", payload: { text: "buffered second" } },
      { kind: "final", payload: { text: "failing third" } },
    ];
    const session = {
      channel: "C123",
      threadTs: THREAD_TS,
      stopped: false,
      delivered: true,
      pendingText: "",
    };
    startSlackStreamMock.mockResolvedValueOnce(session);
    appendSlackStreamMock
      .mockImplementationOnce(async () => {
        session.pendingText = "\nbuffered second";
      })
      .mockImplementationOnce(async () => {
        session.pendingText += "\nfailing third";
        throw new TestSlackStreamNotDeliveredError(
          "buffered second\nfailing third",
          "user_not_found",
        );
      });
    stopSlackStreamMock.mockResolvedValueOnce({ messageId: "171234.999" });

    await dispatchPreparedSlackMessage(createPreparedSlackMessage());

    expect(deliverRepliesMock).not.toHaveBeenCalled();
    expect(stopSlackStreamMock).toHaveBeenCalledTimes(1);
    expect(emitSlackMessageSentHooksMock).toHaveBeenCalledTimes(3);
    expectMockCallArgFields(emitSlackMessageSentHooksMock, 0, "first final message_sent", {
      content: "already visible",
      messageId: "171234.999",
      success: true,
    });
    expectMockCallArgFields(emitSlackMessageSentHooksMock, 1, "second final message_sent", {
      content: "buffered second",
      messageId: "171234.999",
      success: true,
    });
    expectMockCallArgFields(emitSlackMessageSentHooksMock, 2, "third final message_sent", {
      content: "failing third",
      messageId: "171234.999",
      success: true,
    });
  });

  it("emits one terminal failure per buffered final when native stop and fallback fail", async () => {
    mockedNativeStreaming = true;
    mockedDispatchSequence = [
      { kind: "final", payload: { text: "already visible" } },
      { kind: "final", payload: { text: "buffered second" } },
      { kind: "final", payload: { text: "failing third" } },
    ];
    const session = {
      channel: "C123",
      threadTs: THREAD_TS,
      stopped: false,
      delivered: true,
      pendingText: "",
    };
    startSlackStreamMock.mockResolvedValueOnce(session);
    appendSlackStreamMock
      .mockImplementationOnce(async () => {
        session.pendingText = "\nbuffered second";
      })
      .mockImplementationOnce(async () => {
        session.pendingText += "\nfailing third";
        throw new TestSlackStreamNotDeliveredError(
          "buffered second\nfailing third",
          "user_not_found",
        );
      });
    deliverRepliesMock.mockRejectedValueOnce(new Error("fallback send failed"));
    stopSlackStreamMock.mockRejectedValueOnce(
      new TestSlackStreamNotDeliveredError("buffered second\nfailing third", "user_not_found"),
    );

    await expect(dispatchPreparedSlackMessage(createPreparedSlackMessage())).rejects.toThrowError(
      "slack-stream not delivered: user_not_found",
    );

    expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
    expectDeliverReplyCall(0, "buffered second\nfailing third");
    expect(stopSlackStreamMock).toHaveBeenCalledTimes(1);
    expect(emitSlackMessageSentHooksMock).toHaveBeenCalledTimes(3);
    expectMockCallArgFields(emitSlackMessageSentHooksMock, 0, "acknowledged message_sent", {
      content: "already visible",
      success: true,
    });
    expectMockCallArgFields(emitSlackMessageSentHooksMock, 1, "buffered message_sent", {
      content: "buffered second",
      error: "fallback send failed",
      success: false,
    });
    expectMockCallArgFields(emitSlackMessageSentHooksMock, 2, "failed-append message_sent", {
      content: "failing third",
      error: "fallback send failed",
      success: false,
    });
  });

  it("removes all failed buffered finals from production-style delivery counts", async () => {
    mockedNativeStreaming = true;
    mockedDispatcherCapturesDeliveryErrors = true;
    mockedDispatchSequence = [
      { kind: "final", payload: { text: "first buffered" } },
      { kind: "final", payload: { text: "second buffered" } },
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
      session.pendingText += "\nsecond buffered";
      throw new TestSlackStreamNotDeliveredError(session.pendingText, "user_not_found");
    });
    stopSlackStreamMock.mockRejectedValueOnce(
      new TestSlackStreamNotDeliveredError("first buffered\nsecond buffered", "user_not_found"),
    );
    deliverRepliesMock.mockRejectedValueOnce(new Error("fallback send failed"));

    await dispatchPreparedSlackMessage(
      createPreparedSlackMessage({
        cfg: { messages: { statusReactions: { enabled: true } } },
        ackReactionMessageTs: "171234.111",
        ackReactionPromise: Promise.resolve(true),
      }),
    );

    expect(emitSlackMessageSentHooksMock).toHaveBeenCalledTimes(2);
    expect(statusReactionControllerMock.setDone).not.toHaveBeenCalled();
    expect(statusReactionControllerMock.restoreInitial).toHaveBeenCalledTimes(1);
  });

  it("removes all failed buffered tools from production-style delivery counts", async () => {
    mockedNativeStreaming = true;
    mockedDispatcherCapturesDeliveryErrors = true;
    mockedDispatchSequence = [
      { kind: "tool", payload: { text: "first tool" } },
      { kind: "tool", payload: { text: "second tool" } },
    ];
    const session = {
      channel: "C123",
      threadTs: THREAD_TS,
      stopped: false,
      delivered: false,
      pendingText: "first tool",
    };
    startSlackStreamMock.mockResolvedValueOnce(session);
    appendSlackStreamMock.mockImplementationOnce(async () => {
      session.pendingText += "\nsecond tool";
      throw new TestSlackStreamNotDeliveredError(session.pendingText, "user_not_found");
    });
    stopSlackStreamMock.mockRejectedValueOnce(
      new TestSlackStreamNotDeliveredError("first tool\nsecond tool", "user_not_found"),
    );
    deliverRepliesMock.mockRejectedValueOnce(new Error("fallback send failed"));

    await dispatchPreparedSlackMessage(
      createPreparedSlackMessage({
        cfg: { messages: { statusReactions: { enabled: true } } },
        ackReactionMessageTs: "171234.111",
        ackReactionPromise: Promise.resolve(true),
      }),
    );

    expect(emitSlackMessageSentHooksMock).toHaveBeenCalledTimes(2);
    expect(statusReactionControllerMock.setDone).not.toHaveBeenCalled();
    expect(statusReactionControllerMock.restoreInitial).toHaveBeenCalledTimes(1);
  });

  it("keeps a buffered final acknowledged when a later block flushes the stream", async () => {
    mockedNativeStreaming = true;
    mockedDispatchSequence = [
      { kind: "final", payload: { text: "buffered final" } },
      { kind: "block", payload: { text: "flushes both" } },
      { kind: "final", payload: { text: "pending tail" } },
    ];
    const session = {
      channel: "C123",
      threadTs: THREAD_TS,
      stopped: false,
      delivered: false,
      pendingText: "buffered final",
    };
    startSlackStreamMock.mockResolvedValueOnce(session);
    appendSlackStreamMock
      .mockImplementationOnce(async () => {
        session.delivered = true;
        session.pendingText = "";
      })
      .mockImplementationOnce(async () => {
        session.pendingText = "\npending tail";
      });
    stopSlackStreamMock.mockRejectedValueOnce(
      new TestSlackStreamNotDeliveredError("pending tail", "user_not_found"),
    );

    await dispatchPreparedSlackMessage(createPreparedSlackMessage());

    expect(emitSlackMessageSentHooksMock).toHaveBeenCalledTimes(3);
    expectMockCallArgFields(emitSlackMessageSentHooksMock, 0, "flushed final message_sent", {
      content: "buffered final",
      success: true,
    });
    expectMockCallArgFields(emitSlackMessageSentHooksMock, 1, "flushed block message_sent", {
      content: "flushes both",
      success: true,
    });
    expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
    expectDeliverReplyCall(0, "pending tail");
    expectMockCallArgFields(emitSlackMessageSentHooksMock, 2, "fallback final message_sent", {
      content: "pending tail",
      success: true,
    });
  });

  it("emits message_sent for each payload when an append flush falls back", async () => {
    // appendSlackStream throwing SlackStreamNotDeliveredError mid-stream routes
    // all buffered text through deliverReplies; the finalizer must not also emit.
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
    stopSlackStreamMock.mockRejectedValueOnce(
      new TestSlackStreamNotDeliveredError("first buffered\nsecond flushes", "user_not_found"),
    );

    await dispatchPreparedSlackMessage(createPreparedSlackMessage());

    expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
    expectDeliverReplyCall(0, "first buffered\nsecond flushes");
    expect(stopSlackStreamMock).toHaveBeenCalledTimes(1);
    expect(emitSlackMessageSentHooksMock).toHaveBeenCalledTimes(2);
    expectMockCallArgFields(emitSlackMessageSentHooksMock, 0, "fallback block message_sent", {
      content: "first buffered",
      success: true,
    });
    expectMockCallArgFields(emitSlackMessageSentHooksMock, 1, "fallback final message_sent", {
      content: "second flushes",
      success: true,
    });
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

  it("does not admit an empty non-work tool line into native progress", async () => {
    mockedEmptyProgressToolName = "update_plan";

    await dispatchNativeProgressScenario({
      finalPayload: { text: FINAL_REPLY_TEXT },
      events: [
        {
          kind: "item",
          itemKind: "preamble",
          itemId: "preamble-1",
          progressText: "Planning the change",
        },
        { kind: "tool_start", name: "update_plan", phase: "start" },
      ],
    });

    expect(startSlackStreamMock).not.toHaveBeenCalled();
    expect(appendSlackStreamMock).not.toHaveBeenCalled();
    expect(stopSlackStreamMock).not.toHaveBeenCalled();
    expectDeliverReplyCall(0, FINAL_REPLY_TEXT);
  });

  it("starts native Slack progress from typed plan steps", async () => {
    await dispatchNativeProgressScenario({
      finalPayload: { text: FINAL_REPLY_TEXT },
      events: [
        {
          kind: "plan",
          phase: "update",
          explanation: "Executing the checklist.",
          steps: [
            { step: "Inspect", status: "completed" },
            { step: "Patch", status: "in_progress" },
            { step: "Test", status: "pending" },
          ],
        },
      ],
    });

    expectNativeProgressStart([
      planUpdate("Executing the checklist."),
      taskUpdate("plan_step_1", "Inspect", "complete"),
      taskUpdate("plan_step_2", "Patch", "in_progress"),
      taskUpdate("plan_step_3", "Test", "pending"),
    ]);
  });

  it("keeps plan explanation in native chunks alongside a fresh preamble", async () => {
    await dispatchNativeProgressScenario({
      finalPayload: { text: FINAL_REPLY_TEXT },
      events: [
        {
          kind: "item",
          itemKind: "preamble",
          itemId: "preamble-1",
          progressText: "Checking the workspace",
        },
        {
          kind: "plan",
          phase: "update",
          explanation: "Executing the checklist.",
          steps: [{ step: "Patch", status: "in_progress" }],
        },
      ],
    });

    expectNativeProgressStart([
      planUpdate("Checking the workspace — Executing the checklist."),
      taskUpdate("plan_step_1", "Patch", "in_progress"),
    ]);
  });

  it("starts native Slack progress from an explanation-only plan", async () => {
    await dispatchNativeProgressScenario({
      finalPayload: { text: FINAL_REPLY_TEXT },
      events: [
        {
          kind: "plan",
          phase: "update",
          explanation: "Reviewing the implementation.",
          steps: [],
        },
      ],
    });

    expectNativeProgressStart([
      planUpdate("Reviewing the implementation."),
      taskUpdate(expect.any(String), "Update Plan — Reviewing the implementation.", "in_progress"),
    ]);
  });

  it("starts native Slack progress from a retained headline when tool rows are hidden", async () => {
    await dispatchNativeProgressScenario({
      finalPayload: { text: FINAL_REPLY_TEXT },
      progress: { label: false, nativeTaskCards: true, render: "rich", toolProgress: false },
      events: [
        {
          kind: "item",
          itemKind: "preamble",
          itemId: "preamble-1",
          progressText: "Checking the workspace",
        },
        {
          kind: "tool_start",
          itemId: "tool-1",
          name: "bash",
          phase: "start",
          args: { command: "pnpm test" },
        },
      ],
    });

    expectNativeProgressStart([planUpdate("Checking the workspace")]);
    expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
  });

  it("does not replace answer text with a late plan update", async () => {
    const draftStream = createDraftStreamStub();
    createSlackDraftStreamMock.mockReturnValueOnce(draftStream);
    mockedDispatchSequence = [];
    mockedReplyOptionEvents = [
      { kind: "partial", text: "Answer started" },
      {
        kind: "plan",
        phase: "update",
        explanation: "Late plan",
        steps: [{ step: "Should stay hidden", status: "in_progress" }],
      },
    ];

    await dispatchPreparedSlackMessage(createPreparedSlackMessage());

    expect(draftStream.update).toHaveBeenCalledTimes(1);
    expect(draftStream.update).toHaveBeenLastCalledWith("Answer started");
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

  it("uses the enterprise event team as the native progress stream fallback", async () => {
    const eventClient = {
      chat: { postMessage: postMessageMock, update: chatUpdateMock },
      users: {
        info: vi.fn<() => Promise<{ user: Record<string, never> }>>(async () => ({ user: {} })),
      },
    };

    await dispatchNativeProgressScenario({
      finalPayload: { text: FINAL_REPLY_TEXT },
      events: [{ kind: "item", progressText: "checking" }],
      eventScope: {
        apiAppId: "A_TEST",
        enterpriseId: "E_TEST",
        isEnterpriseInstall: true,
        teamId: "T_ENTERPRISE",
        client: eventClient,
      },
    });

    expectMockCallArgFields(startSlackStreamMock, 0, "enterprise progress stream start params", {
      client: eventClient,
      teamId: "T_ENTERPRISE",
    });
  });

  it("reuses native Slack progress task identity across command item and output events", async () => {
    await dispatchNativeProgressScenario({
      finalPayload: { text: FINAL_REPLY_TEXT },
      events: [
        {
          kind: "item",
          itemId: "tool:call-1",
          toolCallId: "call-1",
          itemKind: "command",
          name: "bash",
          phase: "update",
          status: "running",
          progressText: "install dependencies",
        },
        {
          kind: "command_output",
          itemId: "tool:call-1-output",
          toolCallId: "call-1",
          name: "bash",
          phase: "end",
          exitCode: 0,
        },
      ],
    });

    const taskUpdates = collectNativeTaskUpdates();
    expect([...new Set(taskUpdates.map((task) => task.id))]).toEqual([
      expect.stringMatching(/^command_call_1_[a-f0-9]{8}$/),
    ]);
    expect(taskUpdates.at(0)?.id).toEqual(expect.stringMatching(/^command_call_1_[a-f0-9]{8}$/));
    expect(taskUpdates).toContainEqual(
      taskUpdate(taskUpdates.at(0)?.id, "bash — completed", "complete"),
    );
    expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
    expectDeliverReplyCall(0, FINAL_REPLY_TEXT);
  });

  it("keeps duplicate-text native tool tasks as distinct rows", async () => {
    await dispatchNativeProgressScenario({
      finalPayload: { text: FINAL_REPLY_TEXT },
      events: [
        {
          kind: "tool_start",
          itemId: "tool-1",
          name: "bash",
          phase: "start",
          args: { command: "pnpm test" },
        },
        {
          kind: "tool_start",
          itemId: "tool-2",
          name: "bash",
          phase: "start",
          args: { command: "pnpm test" },
        },
      ],
    });

    const inProgressTasks = collectNativeTaskUpdates().filter(
      (task) => task.status === "in_progress",
    );
    expect([...new Set(inProgressTasks.map((task) => task.title))]).toHaveLength(1);
    expect([...new Set(inProgressTasks.map((task) => task.id))]).toEqual([
      expect.stringMatching(/^tool_1_[a-f0-9]{8}$/u),
      expect.stringMatching(/^tool_2_[a-f0-9]{8}$/u),
    ]);
  });

  it("keeps one native Slack progress row across rolling reasoning snapshots", async () => {
    await dispatchNativeProgressScenario({
      finalPayload: { text: FINAL_REPLY_TEXT },
      events: [
        { kind: "reasoning", text: "Checking", isReasoningSnapshot: true },
        {
          kind: "reasoning",
          text: "Checking the Slack handler",
          isReasoningSnapshot: true,
        },
      ],
    });

    const taskUpdates = collectNativeTaskUpdates();
    const reasoningTaskId = taskUpdates.at(0)?.id;
    expect([...new Set(taskUpdates.map((task) => task.id))]).toEqual([
      expect.stringMatching(/^reasoning_[a-f0-9]{8}$/u),
    ]);
    expect(taskUpdates).toContainEqual(taskUpdate(reasoningTaskId, "Checking", "in_progress"));
    expect(taskUpdates).toContainEqual(
      taskUpdate(reasoningTaskId, "Checking the Slack handler", "in_progress"),
    );
    expect(taskUpdates).toContainEqual(
      taskUpdate(reasoningTaskId, "Checking the Slack handler", "complete"),
    );
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

  it("collapses a native progress stream to a receipt after its fresh final lands", async () => {
    stopSlackStreamMock.mockResolvedValueOnce({ messageId: "171234.888" });
    finalizeSlackPreviewEditMock.mockResolvedValueOnce(undefined);

    await dispatchNativeProgressScenario({
      finalPayload: { text: FINAL_REPLY_TEXT },
      events: [
        {
          kind: "tool_start",
          itemId: "tool-1",
          name: "bash",
          phase: "start",
          args: { command: "pnpm test" },
        },
      ],
    });

    expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
    expectMockCallArgFields(finalizeSlackPreviewEditMock, 0, "native progress receipt", {
      channelId: "C123",
      messageId: "171234.888",
      text: expect.stringMatching(/^🛠️ 1 tool call · ⏱️ \d+s$/),
      threadTs: THREAD_TS,
    });
    expect(deliverRepliesMock.mock.invocationCallOrder[0]).toBeLessThan(
      finalizeSlackPreviewEditMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("acknowledges a rotated native progress stream before the queued turn", async () => {
    const firstSession = {
      channel: "C123",
      threadTs: THREAD_TS,
      stopped: false,
      delivered: true,
      pendingText: "",
    };
    const secondSession = { ...firstSession };
    startSlackStreamMock.mockResolvedValueOnce(firstSession).mockResolvedValueOnce(secondSession);
    stopSlackStreamMock
      .mockResolvedValueOnce({ messageId: "171234.701" })
      .mockResolvedValueOnce({ messageId: "171234.702" });
    finalizeSlackPreviewEditMock.mockResolvedValue(undefined);
    mockedNativeStreaming = true;
    mockedSlackStreamingMode = "progress";
    mockedSlackDraftMode = "status_final";
    mockedReplyOptionEvents = [
      {
        kind: "tool_start",
        itemId: "tool-1",
        name: "bash",
        phase: "start",
        args: { command: "pnpm test" },
      },
    ];
    mockedDispatchSequence = [
      { kind: "final", payload: { text: "same answer" } },
      { kind: "queued_followup" },
      { kind: "item", progressText: "queued tool" },
      { kind: "final", payload: { text: "same answer" } },
    ];

    await dispatchPreparedSlackMessage(
      createPreparedSlackMessage({
        accountConfig: {
          streaming: {
            mode: "progress",
            progress: { nativeTaskCards: true, render: "rich" },
          },
        },
      }),
    );

    expect(startSlackStreamMock).toHaveBeenCalledTimes(2);
    expect(stopSlackStreamMock).toHaveBeenCalledTimes(2);
    expect(deliverRepliesMock).toHaveBeenCalledTimes(2);
    expectDeliverReplyCall(0, "same answer");
    expectDeliverReplyCall(1, "same answer");
    expect(finalizeSlackPreviewEditMock).toHaveBeenCalledTimes(2);
    expectMockCallArgFields(finalizeSlackPreviewEditMock, 0, "first queued-turn receipt", {
      messageId: "171234.701",
      text: expect.stringMatching(/^🛠️ 1 tool call · ⏱️ \d+s$/),
    });
    expectMockCallArgFields(finalizeSlackPreviewEditMock, 1, "second queued-turn receipt", {
      messageId: "171234.702",
      text: expect.stringMatching(/^⏱️ \d+s$/),
    });
    expect(finalizeSlackPreviewEditMock.mock.invocationCallOrder[0]).toBeLessThan(
      startSlackStreamMock.mock.invocationCallOrder[1] ?? 0,
    );
    expect(stopSlackStreamMock.mock.invocationCallOrder[0]).toBeLessThan(
      deliverRepliesMock.mock.invocationCallOrder[1] ?? 0,
    );
  });

  it("settles a failed native progress rotation before starting the queued turn", async () => {
    const firstSession = {
      channel: "C123",
      threadTs: THREAD_TS,
      stopped: false,
      delivered: true,
      pendingText: "",
    };
    const secondSession = { ...firstSession };
    startSlackStreamMock.mockResolvedValueOnce(firstSession).mockResolvedValueOnce(secondSession);
    stopSlackStreamMock
      .mockRejectedValueOnce(new Error("socket reset"))
      .mockResolvedValueOnce({ messageId: "171234.702" });
    finalizeSlackPreviewEditMock.mockResolvedValue(undefined);
    mockedNativeStreaming = true;
    mockedSlackStreamingMode = "progress";
    mockedSlackDraftMode = "status_final";
    mockedReplyOptionEvents = [{ kind: "item", progressText: "first tool" }];
    mockedDispatchSequence = [
      { kind: "final", payload: { text: "first answer" } },
      { kind: "queued_followup" },
      { kind: "item", progressText: "queued tool" },
      { kind: "final", payload: { text: "queued answer" } },
    ];

    await dispatchPreparedSlackMessage(
      createPreparedSlackMessage({
        accountConfig: {
          streaming: {
            mode: "progress",
            progress: { nativeTaskCards: true, render: "rich" },
          },
        },
      }),
    );

    expect(startSlackStreamMock).toHaveBeenCalledTimes(2);
    expect(stopSlackStreamMock).toHaveBeenCalledTimes(2);
    expect(deliverRepliesMock).toHaveBeenCalledTimes(2);
    expect(finalizeSlackPreviewEditMock).toHaveBeenCalledTimes(1);
    expectMockCallArgFields(stopSlackStreamMock, 0, "failed rotated stream", {
      session: firstSession,
    });
    expectMockCallArgFields(stopSlackStreamMock, 1, "queued stream cleanup", {
      session: secondSession,
    });
    expect(logVerboseMock).toHaveBeenCalledWith(
      "slack-stream: failed to rotate native progress stream (socket reset)",
    );
    const rotationFailureCall = logVerboseMock.mock.invocationCallOrder.find(
      (_order, index) =>
        logVerboseMock.mock.calls[index]?.[0] ===
        "slack-stream: failed to rotate native progress stream (socket reset)",
    );
    expect(rotationFailureCall).toBeLessThan(startSlackStreamMock.mock.invocationCallOrder[1] ?? 0);
  });

  it("marks native Slack progress tasks as error when final text is an error", async () => {
    await dispatchNativeProgressScenario({
      finalPayload: { text: "tool failed", isError: true },
      events: [{ kind: "item", progressText: "failing tool" }],
    });

    expectNativeProgressStart([
      planUpdate("failing tool"),
      taskUpdate(contentTaskId("item"), "failing tool", "in_progress"),
    ]);
    expectNativeProgressAppend(0, [
      planUpdate("failing tool"),
      taskUpdate(contentTaskId("item"), "failing tool", "error"),
    ]);
    expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
    expect(finalizeSlackPreviewEditMock).not.toHaveBeenCalled();
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
      taskUpdate(contentTaskId("item"), "tool one", "in_progress"),
      taskUpdate(contentTaskId("item"), "tool two", "in_progress"),
      taskUpdate(contentTaskId("item"), "tool three", "in_progress"),
    ]);
    expect(appendSlackStreamMock).not.toHaveBeenCalled();
    expect(deliverRepliesMock).not.toHaveBeenCalled();
    expectMockCallArgFields(stopSlackStreamMock, 0, "native progress stream stop", {
      chunks: [
        planUpdate("tool three"),
        taskUpdate(contentTaskId("item"), "tool one", "complete"),
        taskUpdate(contentTaskId("item"), "tool two", "complete"),
        taskUpdate(contentTaskId("item"), "tool three", "complete"),
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
      taskUpdate(contentTaskId("item"), "tool one", "in_progress"),
    ]);
    expectNativeProgressAppend(2, [
      planUpdate("Shelling"),
      taskUpdate(contentTaskId("item"), "tool one", "complete"),
      taskUpdate(contentTaskId("item"), "tool two", "complete"),
      taskUpdate(contentTaskId("item"), "tool three", "complete"),
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

    expect(draftStream.forceNewMessage).not.toHaveBeenCalled();
    expect(draftStream.update).toHaveBeenLastCalledWith({
      text: ["Shelling", "", "• tool one", "• tool two"].join("\n"),
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
    expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
  });

  it("preserves text Slack progress lines after a draft boundary status update", async () => {
    const draftStream = createDraftStreamStub();
    createSlackDraftStreamMock.mockReturnValueOnce(draftStream);
    mockedSlackStreamingMode = "progress";
    mockedSlackDraftMode = "status_final";
    mockedDispatchSequence = [];
    mockedReplyOptionEvents = [
      { kind: "item", progressText: "tool one" },
      { kind: "item", progressText: "tool two" },
      { kind: "assistant_start" },
      { kind: "partial", text: "partial answer" },
    ];

    await dispatchPreparedSlackMessage(
      createPreparedSlackMessage({
        accountConfig: { streaming: { progress: { label: "Working" } } },
      }),
    );

    expect(draftStream.forceNewMessage).not.toHaveBeenCalled();
    expect(draftStream.update).toHaveBeenLastCalledWith(
      ["Working", "", "• tool one", "• tool two"].join("\n"),
    );
  });

  it("re-arms an isolated progress draft on an assistant boundary after final delivery", async () => {
    const draftStream = createDraftStreamStub();
    createSlackDraftStreamMock.mockReturnValueOnce(draftStream);
    finalizeSlackPreviewEditMock.mockResolvedValueOnce(undefined);
    mockedSlackStreamingMode = "progress";
    mockedSlackDraftMode = "status_final";
    mockedReplyOptionEvents = [{ kind: "item", progressText: "first turn" }];

    await dispatchPreparedSlackMessage(
      createPreparedSlackMessage({
        accountConfig: { streaming: { mode: "progress", progress: { label: "Working" } } },
      }),
    );
    await capturedReplyOptions?.onAssistantMessageStart?.();
    await requireCapturedItemEventHandler()({ progressText: "second turn" });

    expect(draftStream.forceNewMessage).toHaveBeenCalledTimes(1);
    expect(draftStream.update).toHaveBeenLastCalledWith("Working\n\n• second turn");
  });

  it("re-arms an isolated progress draft when a queued followup is admitted", async () => {
    const draftStream = createDraftStreamStub();
    createSlackDraftStreamMock.mockReturnValueOnce(draftStream);
    finalizeSlackPreviewEditMock.mockResolvedValueOnce(undefined);
    mockedSlackStreamingMode = "progress";
    mockedSlackDraftMode = "status_final";
    mockedReplyOptionEvents = [{ kind: "item", progressText: "first turn" }];

    await dispatchPreparedSlackMessage(
      createPreparedSlackMessage({
        accountConfig: { streaming: { mode: "progress", progress: { label: "Working" } } },
      }),
    );
    await capturedReplyOptions?.onQueuedFollowupAdmitted?.();
    await requireCapturedItemEventHandler()({ progressText: "queued turn" });

    expect(draftStream.forceNewMessage).toHaveBeenCalledTimes(1);
    expect(draftStream.update).toHaveBeenLastCalledWith("Working\n\n• queued turn");
  });

  it("re-arms queued progress after a silent turn without a final delivery", async () => {
    const draftStream = createDraftStreamStub();
    createSlackDraftStreamMock.mockReturnValueOnce(draftStream);
    mockedSlackStreamingMode = "progress";
    mockedSlackDraftMode = "status_final";
    mockedDispatchSequence = [];
    mockedReplyOptionEvents = [{ kind: "item", progressText: "silent turn" }];

    await dispatchPreparedSlackMessage(
      createPreparedSlackMessage({
        accountConfig: { streaming: { mode: "progress", progress: { label: "Working" } } },
      }),
    );
    await capturedReplyOptions?.onQueuedFollowupAdmitted?.();
    await requireCapturedItemEventHandler()({ progressText: "queued turn" });

    expect(draftStream.forceNewMessage).toHaveBeenCalledTimes(1);
    expect(draftStream.update).toHaveBeenLastCalledWith("Working\n\n• queued turn");
  });

  it("forces a new draft message on assistant boundaries in partial mode", async () => {
    const draftStream = createDraftStreamStub();
    createSlackDraftStreamMock.mockReturnValueOnce(draftStream);
    mockedSlackStreamingMode = "partial";
    mockedSlackDraftMode = "replace";
    mockedDispatchSequence = [];
    mockedReplyOptionEvents = [
      { kind: "partial", text: "first chunk" },
      { kind: "assistant_start" },
      { kind: "partial", text: "second chunk" },
    ];

    await dispatchPreparedSlackMessage(createPreparedSlackMessage({}));

    expect(draftStream.forceNewMessage).toHaveBeenCalledTimes(1);
  });

  it("starts a new draft delivery target when a queued followup is admitted", async () => {
    const draftStream = {
      ...createDraftStreamStub(),
      flush: vi.fn(noopAsync),
    };
    createSlackDraftStreamMock.mockReturnValueOnce(draftStream);
    mockedSlackStreamingMode = "partial";
    mockedSlackDraftMode = "replace";
    mockedDispatchSequence = [];
    mockedReplyOptionEvents = [{ kind: "partial", text: "first reply" }];

    await dispatchPreparedSlackMessage(createPreparedSlackMessage({}));
    await capturedReplyOptions?.onQueuedFollowupAdmitted?.();

    expect(draftStream.flush).toHaveBeenCalledTimes(1);
    expect(draftStream.forceNewMessage).toHaveBeenCalledTimes(1);
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

    expect(draftStream.update).toHaveBeenCalledWith("Shelling\n\n🛠️ Exec\n• done");
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

  it("keeps only the latest Slack commentary when tool progress is disabled", async () => {
    const draftStream = createDraftStreamStub();
    createSlackDraftStreamMock.mockReturnValueOnce(draftStream);
    mockedSlackStreamingMode = "progress";
    mockedSlackDraftMode = "status_final";
    mockedDispatchSequence = [];
    mockedReplyOptionEvents = [
      {
        kind: "tool_start",
        itemId: "tool-1",
        name: "bash",
        phase: "start",
        args: { command: "pnpm test" },
      },
      {
        kind: "item",
        itemKind: "preamble",
        itemId: "preamble-1",
        progressText: "Checking the Slack event path",
      },
      {
        kind: "item",
        itemKind: "preamble",
        itemId: "preamble-2",
        progressText: "Preparing the smallest fix",
      },
    ];

    await dispatchPreparedSlackMessage(
      createPreparedSlackMessage({
        accountConfig: {
          streaming: {
            mode: "progress",
            progress: { label: false, commentary: true, toolProgress: false, maxLines: 1 },
          },
        },
      }),
    );

    expect(capturedReplyOptions?.commentaryProgressEnabled).toBe(true);
    expect(capturedReplyOptions?.suppressDefaultToolProgressMessages).toBe(true);
    expect(draftStream.update).toHaveBeenLastCalledWith("💬 Preparing the smallest fix");
    expect(draftStream.update.mock.calls.flat().join("\n")).not.toContain("pnpm test");

    const updateCount = draftStream.update.mock.calls.length;
    capturedReplyOptions?.onVerboseProgressVisibility?.(() => true);
    await requireCapturedItemEventHandler()({
      kind: "preamble",
      itemId: "preamble-3",
      progressText: "Delivered by the verbose lane",
    });
    expect(draftStream.update).toHaveBeenCalledTimes(updateCount);
  });

  it("uses the enterprise event client for Slack commentary drafts", async () => {
    const draftStream = createDraftStreamStub();
    createSlackDraftStreamMock.mockReturnValueOnce(draftStream);
    mockedSlackStreamingMode = "progress";
    mockedSlackDraftMode = "status_final";
    mockedDispatchSequence = [];
    mockedReplyOptionEvents = [
      {
        kind: "item",
        itemKind: "preamble",
        itemId: "preamble-1",
        progressText: "Checking the Enterprise event path",
      },
      {
        kind: "item",
        itemKind: "preamble",
        itemId: "preamble-2",
        progressText: "Using the scoped listener client",
      },
    ];
    const eventClient = {
      chat: { postMessage: postMessageMock, update: chatUpdateMock },
    };
    const eventScope = {
      apiAppId: "A_TEST",
      enterpriseId: "E_TEST",
      isEnterpriseInstall: true as const,
      teamId: "T_ENTERPRISE",
      client: eventClient,
    };

    await dispatchPreparedSlackMessage(
      createPreparedSlackMessage({
        accountConfig: {
          enterpriseOrgInstall: true,
          streaming: {
            mode: "progress",
            progress: { label: false, commentary: true, toolProgress: false, maxLines: 1 },
          },
        },
        eventScope,
      }),
    );

    expect(createSlackDraftStreamMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventScope }),
    );
    expect(draftStream.update).toHaveBeenLastCalledWith("💬 Using the scoped listener client");
  });

  it("renders the latest Slack preamble as the status headline by default", async () => {
    const draftStream = createDraftStreamStub();
    createSlackDraftStreamMock.mockReturnValueOnce(draftStream);
    mockedSlackStreamingMode = "progress";
    mockedSlackDraftMode = "status_final";
    mockedDispatchSequence = [];
    mockedReplyOptionEvents = [
      {
        kind: "tool_start",
        itemId: "tool-1",
        name: "bash",
        phase: "start",
        args: { command: "pnpm test" },
      },
      {
        kind: "item",
        itemKind: "preamble",
        itemId: "preamble-1",
        progressText: "Checking the legacy Slack path",
      },
      {
        kind: "item",
        itemKind: "preamble",
        itemId: "preamble-2",
        progressText: "Keeping the released behavior",
      },
    ];

    await dispatchPreparedSlackMessage(
      createPreparedSlackMessage({
        accountConfig: {
          streaming: { mode: "progress", progress: { label: false, maxLines: 1 } },
        },
      }),
    );

    expect(capturedReplyOptions?.commentaryProgressEnabled).toBeUndefined();
    expect(capturedReplyOptions?.onVerboseProgressVisibility).toBeUndefined();
    expect(capturedReplyOptions?.progressPreambleEnabled).toBe(true);
    expect(draftStream.update).toHaveBeenLastCalledWith("Keeping the released behavior");
  });

  it("preserves Slack preamble previews outside progress mode", async () => {
    const draftStream = createDraftStreamStub();
    createSlackDraftStreamMock.mockReturnValueOnce(draftStream);
    mockedSlackStreamingMode = "partial";
    mockedSlackDraftMode = "replace";
    mockedDispatchSequence = [];
    mockedReplyOptionEvents = [
      {
        kind: "item",
        itemKind: "preamble",
        itemId: "preamble-1",
        progressText: "Keeping the partial preview path",
      },
    ];

    await dispatchPreparedSlackMessage(
      createPreparedSlackMessage({
        accountConfig: {
          streaming: { mode: "partial", progress: { label: false } },
        },
      }),
    );

    expect(capturedReplyOptions?.commentaryProgressEnabled).toBeUndefined();
    expect(draftStream.update).toHaveBeenLastCalledWith("• Keeping the partial preview path");
  });

  it("preserves Slack reasoning previews outside status-final mode", async () => {
    const draftStream = createDraftStreamStub();
    createSlackDraftStreamMock.mockReturnValueOnce(draftStream);
    mockedSlackStreamingMode = "partial";
    mockedSlackDraftMode = "replace";
    mockedDispatchSequence = [];
    mockedReplyOptionEvents = [
      { kind: "reasoning", text: "Reading" },
      { kind: "reasoning", text: " the Slack handler" },
    ];

    await dispatchPreparedSlackMessage(
      createPreparedSlackMessage({
        accountConfig: {
          streaming: { mode: "partial", progress: { label: false } },
        },
      }),
    );

    expect(draftStream.update).toHaveBeenLastCalledWith("• Reading the Slack handler");
  });

  it("keeps preamble headlines and tool progress when commentary is disabled", async () => {
    const draftStream = createDraftStreamStub();
    createSlackDraftStreamMock.mockReturnValueOnce(draftStream);
    mockedSlackStreamingMode = "progress";
    mockedSlackDraftMode = "status_final";
    mockedDispatchSequence = [];
    mockedReplyOptionEvents = [
      {
        kind: "tool_start",
        itemId: "tool-1",
        name: "bash",
        phase: "start",
        args: { command: "pnpm test" },
      },
      {
        kind: "item",
        itemKind: "preamble",
        itemId: "preamble-1",
        progressText: "Hidden commentary",
      },
    ];

    await dispatchPreparedSlackMessage(
      createPreparedSlackMessage({
        accountConfig: {
          streaming: {
            mode: "progress",
            progress: { label: false, commentary: false, toolProgress: true },
          },
        },
      }),
    );

    const updates = draftStream.update.mock.calls.flat().join("\n");
    expect(capturedReplyOptions?.commentaryProgressEnabled).toBeUndefined();
    expect(updates).toContain("pnpm test");
    expect(updates).toContain("Hidden commentary");
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
    expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
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

  it("uses the enterprise event team as the native text stream fallback", async () => {
    mockedNativeStreaming = true;
    const eventClient = {
      chat: { postMessage: postMessageMock, update: chatUpdateMock },
      users: {
        info: vi.fn<() => Promise<{ user: Record<string, never> }>>(async () => ({ user: {} })),
      },
    };

    await dispatchPreparedSlackMessage(
      createPreparedSlackMessage({
        eventScope: {
          apiAppId: "A_TEST",
          enterpriseId: "E_TEST",
          isEnterpriseInstall: true,
          teamId: "T_ENTERPRISE",
          client: eventClient,
        },
      }),
    );

    expectMockCallArgFields(startSlackStreamMock, 0, "enterprise Slack stream start params", {
      client: eventClient,
      teamId: "T_ENTERPRISE",
    });
  });

  it("resolves and caches the native stream recipient team per enterprise client", async () => {
    mockedNativeStreaming = true;
    const usersInfo = vi.fn(async () => ({ user: { team_id: "T_RECIPIENT" } }));
    const eventClient = {
      chat: { postMessage: postMessageMock, update: chatUpdateMock },
      users: { info: usersInfo },
    };
    const eventScope = {
      apiAppId: "A_TEST",
      enterpriseId: "E_TEST",
      isEnterpriseInstall: true as const,
      teamId: "T_ENTERPRISE",
      client: eventClient,
    };

    await dispatchPreparedSlackMessage(createPreparedSlackMessage({ eventScope }));
    await dispatchPreparedSlackMessage(createPreparedSlackMessage({ eventScope }));

    expect(usersInfo).toHaveBeenCalledTimes(1);
    expect(usersInfo).toHaveBeenCalledWith({ token: "xoxb-test", user: "U123" });
    expectMockCallArgFields(startSlackStreamMock, 0, "first enterprise Slack stream start", {
      client: eventClient,
      teamId: "T_RECIPIENT",
    });
    expectMockCallArgFields(startSlackStreamMock, 1, "cached enterprise Slack stream start", {
      client: eventClient,
      teamId: "T_RECIPIENT",
    });
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

  it("defers hooks and suppresses duplicate TTS finals when flush creates the preview id", async () => {
    let flushed = false;
    const draftStream = {
      ...createDraftStreamStub(),
      flush: vi.fn(async () => {
        flushed = true;
      }),
      clear: vi.fn(noopAsync),
      discardPending: vi.fn(noopAsync),
      seal: vi.fn(noopAsync),
      messageId: () => (flushed ? "171234.567" : undefined),
    };
    createSlackDraftStreamMock.mockReturnValueOnce(draftStream);
    finalizeSlackPreviewEditMock.mockResolvedValueOnce(undefined);
    mockedSlackIsThreadReply = false;
    mockedReplyThreadTsSequence = [undefined, undefined];
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

    await dispatchPreparedSlackMessage(
      createPreparedSlackMessage({
        message: { thread_ts: undefined },
        replyToMode: "first",
      }),
    );

    expect(finalizeSlackPreviewEditMock).toHaveBeenCalledTimes(1);
    expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
    const delivered = requireRecord(
      requireMockCall(deliverRepliesMock, 0, "deliver replies")[0],
      "deliver replies params",
    );
    expectRecordFields(delivered, { replyThreadTs: THREAD_TS });
    expect(emitSlackMessageSentHooksMock).not.toHaveBeenCalled();
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
    mockedSlackIsThreadReply = false;
    mockedReplyThreadTsSequence = [undefined];
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

    await dispatchPreparedSlackMessage(
      createPreparedSlackMessage({
        message: { thread_ts: undefined },
        replyToMode: "first",
      }),
    );

    expect(finalizeSlackPreviewEditMock).toHaveBeenCalledTimes(1);
    expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
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

  it("keeps chart semantics singular when TTS preview finalization fails", async () => {
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
        text: { type: "mrkdwn", text: "Spoken answer", verbatim: true },
      },
      {
        type: "data_visualization",
        title: "Revenue",
        chart: {
          type: "bar",
          series: [
            {
              name: "<@U123>",
              data: [
                { label: "Q1", value: 12 },
                { label: "Q2", value: 18 },
              ],
            },
          ],
          axis_config: { categories: ["Q1", "Q2"] },
        },
      },
    ];
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
          presentation: {
            blocks: [
              {
                type: "chart",
                chartType: "bar",
                title: "Revenue",
                categories: ["Q1", "Q2"],
                series: [{ name: "<@U123>", values: [12, 18] }],
              },
            ],
          },
        },
      },
    ];

    await dispatchPreparedSlackMessage(createPreparedSlackMessage());

    expectMockCallArgFields(finalizeSlackPreviewEditMock, 0, "chart TTS preview edit params", {
      text: "Spoken answer\n\nRevenue (bar chart)\n- &lt;@U123&gt;: Q1: 12; Q2: 18",
      blocks: mockedSlackReplyBlocks,
    });
    expect(normalizeSlackOutboundTextMock).not.toHaveBeenCalled();

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
        presentation: {
          blocks: [
            {
              type: "chart",
              chartType: "bar",
              title: "Revenue",
              categories: ["Q1", "Q2"],
              series: [{ name: "<@U123>", values: [12, 18] }],
            },
          ],
        },
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

  it("routes pending native stream text through chunked sender for unexpected finalize failures", async () => {
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
      new TestSlackStreamNotDeliveredError(
        FINAL_REPLY_TEXT,
        "method_not_supported_for_channel_type",
      ),
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

  it("fails dispatch when an unexpected finalize fallback cannot deliver a buffered tail", async () => {
    mockedNativeStreaming = true;
    const session = {
      channel: "C123",
      threadTs: THREAD_TS,
      stopped: false,
      delivered: true,
      pendingText: "buffered tail",
    };
    startSlackStreamMock.mockResolvedValueOnce(session);
    stopSlackStreamMock.mockRejectedValueOnce(
      new TestSlackStreamNotDeliveredError(
        "buffered tail",
        "method_not_supported_for_channel_type",
      ),
    );
    deliverRepliesMock.mockRejectedValueOnce(new Error("fallback send failed"));

    await expect(dispatchPreparedSlackMessage(createPreparedSlackMessage())).rejects.toThrowError(
      "slack-stream not delivered: method_not_supported_for_channel_type",
    );

    expectDeliverReplyCall(0, "buffered tail");
    expect(recordSlackThreadParticipationMock).toHaveBeenCalledWith(
      expect.any(String),
      "C123",
      THREAD_TS,
      expect.any(Object),
    );
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
    stopSlackStreamMock.mockRejectedValueOnce(
      new TestSlackStreamNotDeliveredError("first buffered\nsecond flushes", "user_not_found"),
    );

    await dispatchPreparedSlackMessage(createPreparedSlackMessage());

    expect(postMessageMock).not.toHaveBeenCalled();
    expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
    expectDeliverReplyCall(0, "first buffered\nsecond flushes");
    expect(stopSlackStreamMock).toHaveBeenCalledTimes(1);
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
    stopSlackStreamMock.mockRejectedValueOnce(new Error("stop failed"));

    await dispatchPreparedSlackMessage(createPreparedSlackMessage());

    // Chunked fallback sent the FULL pendingText, not just the failing
    // payload (so the earlier buffered chunk is not dropped).
    expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
    expectDeliverReplyCall(0, "first buffered\nsecond payload");
    // Session was retired after fallback, so finalization cannot resend the
    // Slack SDK's retained private buffer.
    expect(session.pendingText).toBe("");
    expect(session.stopped).toBe(true);
    expect(stopSlackStreamMock).toHaveBeenCalledTimes(1);
    // No raw postMessage path was invoked.
    expect(postMessageMock).not.toHaveBeenCalled();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
