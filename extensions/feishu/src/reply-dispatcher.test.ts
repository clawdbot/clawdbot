// Feishu tests cover reply dispatcher plugin behavior.
import os from "node:os";
import path from "node:path";
import {
  createChannelPartialDeliveryError,
  isChannelPartialDeliveryError,
} from "openclaw/plugin-sdk/channel-inbound";
import { createReplyDispatcher } from "openclaw/plugin-sdk/reply-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { afterAll, beforeEach, describe, expect, it, type Mock, vi } from "vitest";

type StreamingSessionStub = {
  active: boolean;
  credentials: unknown;
  start: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  closeWithResult: Mock<FeishuStreamingSession["closeWithResult"]>;
  discard: Mock<FeishuStreamingSession["discard"]>;
  isActive: ReturnType<typeof vi.fn>;
};

const resolveFeishuAccountMock = vi.hoisted(() => vi.fn());
const getFeishuRuntimeMock = vi.hoisted(() => vi.fn());
const getGlobalHookRunnerMock = vi.hoisted(() => vi.fn());
const sendMessageFeishuMock = vi.hoisted(() => vi.fn());
const sendStructuredCardFeishuMock = vi.hoisted(() => vi.fn());
const sendCardFeishuMock = vi.hoisted(() => vi.fn());
const sendMediaFeishuMock = vi.hoisted(() => vi.fn());
const createFeishuClientMock = vi.hoisted(() => vi.fn());
const resolveReceiveIdTypeMock = vi.hoisted(() => vi.fn());
const addTypingIndicatorMock = vi.hoisted(() => vi.fn(async () => ({ messageId: "om_msg" })));
const removeTypingIndicatorMock = vi.hoisted(() => vi.fn(async () => {}));
const streamingInstances = vi.hoisted((): StreamingSessionStub[] => []);
const shouldSuppressFeishuTextForVoiceMediaMock = vi.hoisted(
  () =>
    (params: {
      mediaUrl?: string;
      audioAsVoice?: boolean;
      ttsSupplement?: { visibleTextAlreadyDelivered?: boolean };
    }) =>
      params.ttsSupplement
        ? params.ttsSupplement.visibleTextAlreadyDelivered === true
        : params.audioAsVoice === true || /\.(?:ogg|opus)(?:[?#]|$)/i.test(params.mediaUrl ?? ""),
);
const resolvePinnedHostnameWithPolicyMock = vi.hoisted(() =>
  vi.fn(async (hostname: string) => {
    if (hostname === "files.example.test") {
      throw new Error("Blocked: resolves to private/internal/special-use IP address");
    }
    return {
      hostname,
      addresses: ["93.184.216.34"],
      lookup: vi.fn(),
    };
  }),
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
vi.mock("openclaw/plugin-sdk/plugin-runtime", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getGlobalHookRunner: getGlobalHookRunnerMock };
});
vi.mock("./send.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./send.js")>()),
  sendMessageFeishu: sendMessageFeishuMock,
  sendStructuredCardFeishu: sendStructuredCardFeishuMock,
  sendCardFeishu: sendCardFeishuMock,
}));
vi.mock("./media.js", () => ({
  sendMediaFeishu: sendMediaFeishuMock,
  shouldSuppressFeishuTextForVoiceMedia: shouldSuppressFeishuTextForVoiceMediaMock,
}));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    resolvePinnedHostnameWithPolicy: resolvePinnedHostnameWithPolicyMock,
  };
});
vi.mock("./client.js", () => ({ createFeishuClient: createFeishuClientMock }));
vi.mock("./targets.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./targets.js")>()),
  resolveReceiveIdType: resolveReceiveIdTypeMock,
}));
vi.mock("./typing.js", () => ({
  addTypingIndicator: addTypingIndicatorMock,
  removeTypingIndicator: removeTypingIndicatorMock,
}));
vi.mock("./streaming-card.js", () => {
  class FeishuStreamingFinalizationError extends Error {
    result: { visibleReplySent: boolean; content?: string; messageId?: string };

    constructor(
      cause: unknown,
      result: { visibleReplySent: boolean; content?: string; messageId?: string },
    ) {
      super(cause instanceof Error ? cause.message : String(cause), { cause });
      this.result = result;
    }
  }
  return {
    mergeStreamingText,
    FeishuStreamingFinalizationError,
    FeishuStreamingSession: class {
      active = false;
      credentials: unknown;
      start = vi.fn(async () => {
        this.active = true;
      });
      update = vi.fn(async () => {});
      closeWithResult = vi.fn<FeishuStreamingSession["closeWithResult"]>(async (text, _options) => {
        this.active = false;
        return {
          visibleReplySent: Boolean(text?.trim()),
          ...(text?.trim() ? { content: text } : {}),
          messageId: "om_stream",
        };
      });
      discard = vi.fn<FeishuStreamingSession["discard"]>(async () => {
        this.active = false;
        return { visibleReplySent: false };
      });
      isActive = vi.fn(() => this.active);

      constructor(_client: unknown, credentials: unknown) {
        this.credentials = credentials;
        streamingInstances.push(this);
      }
    },
  };
});

import { buildFeishuPostMessageContent } from "./markdown.js";
import { streamingStartBackoffUntilByAccount } from "./reply-dispatcher-state.js";
import { createFeishuReplyDispatcher } from "./reply-dispatcher.js";
import { FeishuStreamingFinalizationError, type FeishuStreamingSession } from "./streaming-card.js";

type StreamingCloseResult = Awaited<ReturnType<FeishuStreamingSession["closeWithResult"]>>;

afterAll(() => {
  vi.doUnmock("./accounts.js");
  vi.doUnmock("./runtime.js");
  vi.doUnmock("./send.js");
  vi.doUnmock("./media.js");
  vi.doUnmock("./client.js");
  vi.doUnmock("./targets.js");
  vi.doUnmock("./typing.js");
  vi.doUnmock("./streaming-card.js");
  vi.doUnmock("openclaw/plugin-sdk/ssrf-runtime");
  vi.doUnmock("openclaw/plugin-sdk/plugin-runtime");
  vi.resetModules();
});

describe("createFeishuReplyDispatcher streaming behavior", () => {
  type ReplyDispatcherArgs = Parameters<typeof createFeishuReplyDispatcher>[0];
  type ReplyDispatcherPlan = ReturnType<typeof createFeishuReplyDispatcher>;
  type TypingDispatcherOptions = ReplyDispatcherPlan["dispatcherOptions"] &
    ReplyDispatcherPlan["delivery"];

  beforeEach(() => {
    vi.clearAllMocks();
    streamingStartBackoffUntilByAccount.clear();
    streamingInstances.length = 0;
    sendMediaFeishuMock.mockReset().mockResolvedValue(undefined);
    sendStructuredCardFeishuMock.mockReset().mockResolvedValue(undefined);
    sendCardFeishuMock.mockReset().mockResolvedValue({ messageId: "om_card" });
    getGlobalHookRunnerMock.mockReturnValue(null);

    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "auto",
        streaming: { mode: "partial" },
        httpTimeoutMs: 45_000,
      },
    });

    resolveReceiveIdTypeMock.mockReturnValue("chat_id");
    createFeishuClientMock.mockReturnValue({});

    getFeishuRuntimeMock.mockReturnValue({
      channel: {
        text: {
          resolveTextChunkLimit: vi.fn(() => 4000),
          resolveChunkMode: vi.fn(() => "line"),
          resolveMarkdownTableMode: vi.fn(() => "preserve"),
          convertMarkdownTables: vi.fn((text) => text),
          chunkTextWithMode: vi.fn((text) => [text]),
          chunkMarkdownTextWithMode: vi.fn((text) => [text]),
        },
        reply: {
          resolveHumanDelayConfig: vi.fn(() => undefined),
        },
      },
    });
  });

  function useNonStreamingAutoAccount() {
    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "auto",
        streaming: { mode: "off" },
      },
    });
  }

  it.each([
    { root: "[root]", account: undefined, expected: "[root] reply" },
    { root: "[root]", account: "[account]", expected: "[account] reply" },
    { root: "[root]", account: "", expected: "reply" },
    { root: "auto", account: undefined, expected: "[Test Bot] reply" },
    { root: "[{model}]", account: undefined, expected: "[gpt-5.6-luna] reply" },
  ])("delivers the resolved prefix $expected", async ({ root, account, expected }) => {
    useNonStreamingAutoAccount();
    const { result } = createDispatcherHarness({
      accountId: "main",
      cfg: {
        messages: { responsePrefix: "[global]" },
        agents: { list: [{ id: "agent", identity: { name: "Test Bot" } }] },
        channels: {
          feishu: { responsePrefix: root, accounts: { main: { responsePrefix: account } } },
        },
      },
    });
    result.replyOptions.onModelSelected?.({
      provider: "openai",
      model: "gpt-5.6-luna",
      thinkLevel: "off",
    });
    const dispatcher = createReplyDispatcher(toTypingDispatcherOptions(result));
    dispatcher.sendFinalReply({ text: "reply" });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();
    expect(sendMessageFeishuMock).toHaveBeenCalledWith(expect.objectContaining({ text: expected }));
  });

  it("keeps card attribution on the selected-model prefix context", async () => {
    const { result, options } = createDispatcherHarness();
    result.replyOptions.onModelSelected?.({
      provider: "openai",
      model: "gpt-5.6-luna",
      thinkLevel: "off",
    });
    const delivery = await options.deliver({ text: "reply" }, { kind: "final" });
    await options.onIdle?.();
    await delivery?.finalization;
    expect(requireStreamingInstance(0).closeWithResult).toHaveBeenCalledWith("reply", {
      note: "Agent: agent | Model: gpt-5.6-luna | Provider: openai",
    });
  });

  it.each(["reply_payload_sending", "message_sending"])(
    "suppresses all pre-hook CardKit previews when %s is registered",
    async (hookName) => {
      getGlobalHookRunnerMock.mockReturnValue({
        hasHooks: vi.fn((name: string) => name === hookName),
      });
      resolveFeishuAccountMock.mockReturnValue({
        accountId: "main",
        appId: "app_id",
        appSecret: "app_secret",
        domain: "lark",
        config: {
          renderMode: "card",
          streaming: { mode: "partial" },
        },
      });
      const { result, options } = createDispatcherHarness();

      await options.onReplyStart?.();
      expect(result.replyOptions.onPartialReply).toBeUndefined();
      expect(result.replyOptions.onReasoningStream).toBeUndefined();
      expect(result.replyOptions.onToolStart).toBeUndefined();
      expect(result.replyOptions.onCompactionStart).toBeUndefined();
      expect(streamingInstances).toHaveLength(0);

      const delivery = await options.deliver({ text: "accepted final" }, { kind: "final" });
      expect(streamingInstances).toHaveLength(1);
      expect(requireStreamingInstance(0).start).toHaveBeenCalledTimes(1);
      const idle = Promise.resolve(options.onIdle?.());
      await idle;
      await delivery?.finalization;
      expect(requireStreamingInstance(0).closeWithResult).toHaveBeenCalledWith("accepted final", {
        note: "Agent: agent",
      });
    },
  );

  function useNonStreamingBlockAccount() {
    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "auto",
        streaming: { mode: "off", block: { enabled: true } },
      },
    });
  }

  function setupNonStreamingAutoDispatcher() {
    useNonStreamingAutoAccount();

    const result = createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
      sendTarget: "oc_chat",
    });

    return toTypingDispatcherOptions(result);
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
      sendTarget: "oc_chat",
      ...overrides,
    });

    return {
      result,
      options: toTypingDispatcherOptions(result),
    };
  }

  function toTypingDispatcherOptions(result: ReplyDispatcherPlan): TypingDispatcherOptions {
    return { ...result.dispatcherOptions, ...result.delivery };
  }

  function requireRecord(value: unknown, label: string): Record<string, unknown> {
    expect(isRecord(value), `${label} must be an object`).toBe(true);
    return value as Record<string, unknown>;
  }

  function expectRecordFields(
    value: unknown,
    label: string,
    expected: Record<string, unknown>,
  ): Record<string, unknown> {
    const record = requireRecord(value, label);
    for (const [key, expectedValue] of Object.entries(expected)) {
      expect(record[key], `${label}.${key}`).toEqual(expectedValue);
    }
    return record;
  }

  function expectMockArgFields(
    mock: ReturnType<typeof vi.fn>,
    label: string,
    expected: Record<string, unknown>,
    callIndex = 0,
    argIndex = 0,
  ): Record<string, unknown> {
    return expectRecordFields(mockArg(mock, callIndex, argIndex, label), label, expected);
  }

  function mockArg(
    mock: ReturnType<typeof vi.fn>,
    callIndex: number,
    argIndex: number,
    label: string,
  ) {
    const call = mock.mock.calls[callIndex];
    if (!call) {
      throw new Error(`missing ${label} call ${callIndex + 1}`);
    }
    return call[argIndex];
  }

  function firstMockArg(mock: ReturnType<typeof vi.fn>, label: string, argIndex = 0) {
    return mockArg(mock, 0, argIndex, label);
  }

  function requireStreamingInstance(instanceIndex: number): StreamingSessionStub {
    const instance = streamingInstances[instanceIndex];
    if (!instance) {
      throw new Error(`Expected streaming instance ${instanceIndex}`);
    }
    return instance;
  }

  function firstStreamingCloseText(instanceIndex = 0): string {
    const close = requireStreamingInstance(instanceIndex).closeWithResult;
    return String(firstMockArg(close, "streaming close"));
  }

  function expectLastMockArgFields(
    mock: ReturnType<typeof vi.fn>,
    label: string,
    expected: Record<string, unknown>,
    argIndex = 0,
  ): Record<string, unknown> {
    const callIndex = mock.mock.calls.length - 1;
    return expectMockArgFields(mock, label, expected, callIndex, argIndex);
  }

  function expectStreamingStartOptions(
    instanceIndex: number,
    expected: Record<string, unknown>,
  ): Record<string, unknown> {
    const start = requireStreamingInstance(instanceIndex).start;
    expect(firstMockArg(start, "streaming start")).toBe("oc_chat");
    expect(firstMockArg(start, "streaming start", 1)).toBe("chat_id");
    return expectRecordFields(
      firstMockArg(start, "streaming start", 2),
      "streaming start options",
      expected,
    );
  }

  function streamingUpdateTexts(instanceIndex = 0): string[] {
    return requireStreamingInstance(instanceIndex).update.mock.calls.map((call: unknown[]) =>
      typeof call[0] === "string" ? call[0] : "",
    );
  }

  it("skips typing indicator when account typingIndicator is disabled", async () => {
    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "auto",
        streaming: { mode: "partial" },
        typingIndicator: false,
      },
    });

    const result = createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: {} as never,
      chatId: "oc_chat",
      sendTarget: "oc_chat",
      replyToMessageId: "om_parent",
    });

    const options = toTypingDispatcherOptions(result);
    await options.onReplyStart?.();

    expect(addTypingIndicatorMock).not.toHaveBeenCalled();
  });

  it("skips typing indicator for stale replayed messages", async () => {
    const result = createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: {} as never,
      chatId: "oc_chat",
      sendTarget: "oc_chat",
      replyToMessageId: "om_parent",
      messageCreateTimeMs: Date.now() - 3 * 60_000,
    });

    const options = toTypingDispatcherOptions(result);
    await options.onReplyStart?.();

    expect(addTypingIndicatorMock).not.toHaveBeenCalled();
  });

  it("treats second-based timestamps as stale for typing suppression", async () => {
    const result = createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: {} as never,
      chatId: "oc_chat",
      sendTarget: "oc_chat",
      replyToMessageId: "om_parent",
      messageCreateTimeMs: Math.floor((Date.now() - 3 * 60_000) / 1000),
    });

    const options = toTypingDispatcherOptions(result);
    await options.onReplyStart?.();

    expect(addTypingIndicatorMock).not.toHaveBeenCalled();
  });

  it("keeps typing indicator for fresh messages", async () => {
    const result = createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: {} as never,
      chatId: "oc_chat",
      sendTarget: "oc_chat",
      replyToMessageId: "om_parent",
      messageCreateTimeMs: Date.now() - 30_000,
    });

    const options = toTypingDispatcherOptions(result);
    await options.onReplyStart?.();

    expect(addTypingIndicatorMock).toHaveBeenCalledTimes(1);
    expectMockArgFields(addTypingIndicatorMock, "typing indicator params", {
      messageId: "om_parent",
    });
  });

  it("targets typing at the inbound message while replies stay on the thread root", async () => {
    useNonStreamingAutoAccount();
    const { options } = createDispatcherHarness({
      replyToMessageId: "om_topic_root",
      typingTargetMessageId: "om_topic_child",
      replyInThread: true,
      messageCreateTimeMs: Date.now() - 30_000,
    });

    await options.onReplyStart?.();
    await options.deliver({ text: "plain text" }, { kind: "final" });

    expectMockArgFields(addTypingIndicatorMock, "typing indicator params", {
      messageId: "om_topic_child",
    });
    expectMockArgFields(sendMessageFeishuMock, "message send params", {
      replyToMessageId: "om_topic_root",
      replyInThread: true,
    });
  });

  it("routes visible sends to sendTarget while keeping chatId separate", async () => {
    useNonStreamingAutoAccount();
    const { options } = createDispatcherHarness({
      chatId: "oc_p2p_chat",
      sendTarget: "user:ou_sender",
      replyToMessageId: "om_direct",
      skipReplyToInMessages: true,
    });

    await options.deliver({ text: "plain text" }, { kind: "final" });

    expectMockArgFields(sendMessageFeishuMock, "message send params", {
      to: "user:ou_sender",
      replyToMessageId: undefined,
    });
  });

  it("streams auto mode plain final text when streaming is enabled", async () => {
    const { options } = createDispatcherHarness();
    await options.deliver({ text: "plain text" }, { kind: "final" });
    await options.onIdle?.();

    expect(streamingInstances).toHaveLength(1);
    expect(requireStreamingInstance(0).credentials).toMatchObject({ httpTimeoutMs: 45_000 });
    expect(requireStreamingInstance(0).closeWithResult).toHaveBeenCalledWith("plain text", {
      note: "Agent: agent",
    });
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
  });

  it("keeps oversized auto mode plain final text on the chunked message path", async () => {
    const runtime = getFeishuRuntimeMock();
    runtime.channel.text.resolveTextChunkLimit.mockReturnValue(10);
    runtime.channel.text.chunkMarkdownTextWithMode.mockReturnValue(["0123456789", "abcdefghij"]);

    const { options } = createDispatcherHarness();
    await options.deliver({ text: "0123456789abcdefghij" }, { kind: "final" });
    await options.onIdle?.();

    expect(streamingInstances).toHaveLength(0);
    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(2);
    expectMockArgFields(sendMessageFeishuMock, "first message send params", {
      text: "0123456789",
    });
    expectMockArgFields(
      sendMessageFeishuMock,
      "second message send params",
      {
        text: "abcdefghij",
      },
      1,
    );
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
  });

  it("splits raw final text at the serialized post byte envelope", async () => {
    useNonStreamingAutoAccount();
    const runtime = getFeishuRuntimeMock();
    runtime.channel.text.resolveTextChunkLimit.mockReturnValue(25_000);
    const text = Array.from({ length: 6_150 }, () => "a").join("\n");

    const { options } = createDispatcherHarness();
    await options.deliver({ text }, { kind: "final" });
    await options.onIdle?.();

    expect(sendMessageFeishuMock.mock.calls.length).toBeGreaterThan(1);
    for (const [params] of sendMessageFeishuMock.mock.calls) {
      const content = buildFeishuPostMessageContent({ messageText: params.text });
      expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(30 * 1024);
    }
  });

  it("keeps oversized auto mode markdown final text on the chunked card path", async () => {
    const runtime = getFeishuRuntimeMock();
    runtime.channel.text.resolveTextChunkLimit.mockReturnValue(10);
    runtime.channel.text.chunkMarkdownTextWithMode.mockReturnValue(["```ts\nx\n```", "tail"]);

    const { options } = createDispatcherHarness({ runtime: createRuntimeLogger() });
    await options.deliver({ text: "```ts\nconst x = 1\n```\ntail" }, { kind: "final" });
    await options.onIdle?.();

    expect(streamingInstances).toHaveLength(0);
    expect(runtime.channel.text.chunkMarkdownTextWithMode).toHaveBeenCalledTimes(1);
    expect(runtime.channel.text.chunkTextWithMode).not.toHaveBeenCalled();
    expect(sendStructuredCardFeishuMock).toHaveBeenCalledTimes(2);
    expectMockArgFields(sendStructuredCardFeishuMock, "first card send params", {
      text: "```ts\nx\n```",
    });
    expectMockArgFields(
      sendStructuredCardFeishuMock,
      "second card send params",
      {
        text: "tail",
      },
      1,
    );
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
  });

  it.each(["static", "streaming fallback"])(
    "budgets full metadata on every %s card chunk",
    async (deliveryMode) => {
      const account = resolveFeishuAccountMock();
      resolveFeishuAccountMock.mockReturnValue({
        ...account,
        configured: true,
        config: {
          ...account.config,
          renderMode: "card",
          streaming: { mode: deliveryMode === "static" ? "off" : "partial" },
        },
      });
      getFeishuRuntimeMock().channel.text.resolveTextChunkLimit.mockReturnValue(40_000);
      const create = vi.fn(async (_request: { data: { content: string } }) => ({
        code: 0,
        data: { message_id: `om_envelope_${create.mock.calls.length}` },
      }));
      createFeishuClientMock.mockReturnValue({ im: { message: { create } } });
      const actualSend = await vi.importActual<typeof import("./send.js")>("./send.js");
      sendStructuredCardFeishuMock.mockImplementation(actualSend.sendStructuredCardFeishu);
      const name = "界".repeat(1_100);
      const body = "x".repeat(24_576);
      const { options } = createDispatcherHarness({
        identity: { name },
        // Required peer-bot mentions intentionally disable CardKit streaming.
        ...(deliveryMode === "static"
          ? { requiredMentionTargets: [{ openId: "ou_peer_bot", name: "Peer Bot", key: "" }] }
          : {}),
      });
      const delivery = await options.deliver(
        { text: `\`\`\`text\n${body}\n\`\`\`` },
        { kind: "final" },
      );
      if (deliveryMode !== "static") {
        requireStreamingInstance(0).closeWithResult.mockResolvedValueOnce({
          visibleReplySent: false,
        });
      }
      await options.onIdle?.();
      await delivery?.finalization;
      expect(create.mock.calls.length).toBeGreaterThan(1);
      const bodies: string[] = [];
      for (const [request] of create.mock.calls) {
        const content = request.data.content;
        expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(30 * 1024);
        const card = JSON.parse(content);
        expect(card.header.title.content).toBe(name);
        expect(card.body.elements[2].content).toBe(`<font color='grey'>Agent: ${name}</font>`);
        const markdown = card.body.elements[0].content as string;
        const prefix = `${deliveryMode === "static" ? "<at id=ou_peer_bot></at> " : ""}\`\`\`text\n`;
        expect(markdown.startsWith(prefix)).toBe(true);
        expect(markdown.endsWith("\n```")).toBe(true);
        bodies.push(markdown.slice(prefix.length, -4));
      }
      expect(bodies.join("")).toBe(body);
    },
  );

  it("discards partial streaming preview before oversized final text fallback", async () => {
    const runtime = getFeishuRuntimeMock();
    runtime.channel.text.resolveTextChunkLimit.mockReturnValue(10);
    runtime.channel.text.chunkMarkdownTextWithMode.mockReturnValue(["final text", " overflow"]);

    const { result, options } = createDispatcherHarness({ runtime: createRuntimeLogger() });
    result.replyOptions.onPartialReply?.({ text: "partial" });
    await options.deliver({ text: "final text overflow" }, { kind: "final" });
    await options.onIdle?.();

    expect(streamingInstances).toHaveLength(1);
    expect(requireStreamingInstance(0).discard).toHaveBeenCalledTimes(1);
    expect(requireStreamingInstance(0).closeWithResult).not.toHaveBeenCalled();
    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(2);
    expectMockArgFields(sendMessageFeishuMock, "first message send params", {
      text: "final text",
    });
    expectMockArgFields(
      sendMessageFeishuMock,
      "second message send params",
      {
        text: " overflow",
      },
      1,
    );
  });

  it("keeps auto mode plain tool text on the message path when streaming is enabled", async () => {
    const { options } = createDispatcherHarness();
    await options.deliver({ text: "tool summary" }, { kind: "tool" });

    expect(streamingInstances).toHaveLength(0);
    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    expectMockArgFields(sendMessageFeishuMock, "message send params", {
      text: "tool summary",
    });
  });

  it("keeps active auto mode streaming sessions from swallowing tool text", async () => {
    const { result, options } = createDispatcherHarness({
      runtime: createRuntimeLogger(),
    });

    await options.onReplyStart?.();
    result.replyOptions.onAssistantMessageStart?.();
    await options.deliver({ text: "tool summary" }, { kind: "tool" });
    await options.deliver({ text: "plain final answer" }, { kind: "final" });
    await options.onIdle?.();

    expect(streamingInstances).toHaveLength(1);
    expect(requireStreamingInstance(0).start).toHaveBeenCalledTimes(1);
    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    expectMockArgFields(sendMessageFeishuMock, "message send params", {
      text: "tool summary",
    });
    expect(requireStreamingInstance(0).closeWithResult).toHaveBeenCalledWith("plain final answer", {
      note: "Agent: agent",
    });
  });

  it("keeps auto mode plain text on the message path when streaming is disabled", async () => {
    const options = setupNonStreamingAutoDispatcher();
    await options.deliver({ text: "plain text" }, { kind: "final" });

    expect(streamingInstances).toHaveLength(0);
    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
  });

  it("passes mention-forward targets to non-streaming plain text replies without rewriting body text", async () => {
    useNonStreamingAutoAccount();

    const { options } = createDispatcherHarness({
      replyToMessageId: "om_msg",
      mentionTargets: [{ openId: "ou_target", name: "Target User", key: "@_user_1" }],
    });
    await options.deliver(
      { text: 'plain text <at user_id="ou_body">Body User</at>' },
      { kind: "final" },
    );

    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    expectMockArgFields(sendMessageFeishuMock, "message send params", {
      text: 'plain text <at user_id="ou_body">Body User</at>',
      mentions: [{ openId: "ou_target", name: "Target User", key: "@_user_1" }],
    });
  });

  it("puts required bot mentions on every chunk and disables streaming cards", async () => {
    const runtime = getFeishuRuntimeMock();
    runtime.channel.text.resolveTextChunkLimit.mockReturnValue(10);
    runtime.channel.text.chunkMarkdownTextWithMode.mockImplementation((text: string) =>
      text === "First paragraph." ? ["First ", "paragraph."] : [text],
    );
    const requiredMentionTargets = [{ openId: "ou_peer_bot", name: "Peer Bot", key: "" }];
    const { options } = createDispatcherHarness({ requiredMentionTargets });

    await options.deliver({ text: "First paragraph." }, { kind: "final" });

    expect(streamingInstances).toHaveLength(0);
    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(2);
    expectMockArgFields(sendMessageFeishuMock, "first bot reply chunk", {
      text: "First ",
      mentions: requiredMentionTargets,
    });
    expectMockArgFields(
      sendMessageFeishuMock,
      "second bot reply chunk",
      { text: "paragraph.", mentions: requiredMentionTargets },
      1,
    );
  });

  it("puts required bot mentions on static card replies", async () => {
    const requiredMentionTargets = [{ openId: "ou_peer_bot", name: "Peer Bot", key: "" }];
    const { options } = createDispatcherHarness({ requiredMentionTargets });

    await options.deliver({ text: "```md\nanswer\n```" }, { kind: "final" });

    expect(streamingInstances).toHaveLength(0);
    expectMockArgFields(sendStructuredCardFeishuMock, "bot card reply", {
      mentions: requiredMentionTargets,
    });
  });

  it("does not attach automatic mentions to card replies", async () => {
    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "card",
        streaming: { mode: "off" },
      },
    });

    const { options } = createDispatcherHarness({
      replyToMessageId: "om_msg",
      mentionTargets: [{ openId: "ou_context_user", name: "Context user", key: "" }],
    });
    await options.deliver({ text: "card text" }, { kind: "final" });

    expect(sendStructuredCardFeishuMock).toHaveBeenCalledTimes(1);
    expect(firstMockArg(sendStructuredCardFeishuMock, "structured card params")).not.toHaveProperty(
      "mentions",
    );
  });

  const approvalPresentationText = [
    "Plugin bind approval required",
    "Allow Codex to bind this conversation?",
    "- Allow once: `/plugin allow`\n- Deny: `/plugin deny`",
  ].join("\n\n");

  const approvalPresentation = {
    title: "Plugin bind approval required",
    blocks: [
      { type: "text" as const, text: "Allow Codex to bind this conversation?" },
      {
        type: "buttons" as const,
        buttons: [
          { label: "Allow once", action: { type: "command" as const, command: "/plugin allow" } },
          { label: "Deny", action: { type: "command" as const, command: "/plugin deny" } },
        ],
      },
    ],
  };

  function presentationCardBodies() {
    return sendCardFeishuMock.mock.calls.map(
      (call) => requireRecord(call[0], "native card send").card,
    );
  }

  it.each(["final", "block"] as const)(
    "delivers a %s reply's buttons as a native card",
    async (kind) => {
      useNonStreamingAutoAccount();
      const { options } = createDispatcherHarness();

      const delivery = await options.deliver(
        { text: "Plugin bind approval required", presentation: approvalPresentation },
        { kind },
      );

      expect(sendCardFeishuMock).toHaveBeenCalledTimes(1);
      expect(sendMessageFeishuMock).not.toHaveBeenCalled();
      expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
      const serialized = JSON.stringify(presentationCardBodies()[0]);
      expect(serialized).toContain("Allow once");
      expect(serialized).toContain("Deny");
      expect(serialized).toContain("Allow Codex to bind this conversation?");
      expect(delivery?.visibleReplySent).toBe(true);
    },
  );

  it("delivers a controls-only reply instead of sending nothing", async () => {
    useNonStreamingAutoAccount();
    const { options } = createDispatcherHarness();

    const delivery = await options.deliver(
      {
        interactive: {
          blocks: [
            {
              type: "buttons",
              buttons: [
                { label: "Allow once", value: "allow-once" },
                { label: "Deny", value: "deny" },
              ],
            },
          ],
        },
      },
      { kind: "final" },
    );

    expect(sendCardFeishuMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(presentationCardBodies()[0])).toContain("allow-once");
    expect(delivery?.visibleReplySent).toBe(true);
  });

  it("keeps a status-style fallback reply as its authored text", async () => {
    useNonStreamingAutoAccount();
    const { options } = createDispatcherHarness();

    await options.deliver(
      {
        text: "Status: uptime 3h",
        presentationTextMode: "fallback",
        presentation: {
          title: "Status",
          blocks: [
            {
              type: "table",
              caption: "Runtime",
              headers: ["Fact", "Value"],
              rows: [["Uptime", "3h"]],
            },
          ],
        },
      },
      { kind: "final" },
    );

    expect(sendCardFeishuMock).not.toHaveBeenCalled();
    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Status: uptime 3h" }),
    );
  });

  it("delivers new media accompanying an already displayed presentation", async () => {
    useNonStreamingAutoAccount();
    sendMediaFeishuMock.mockResolvedValueOnce({ messageId: "om_new_media" });
    sendCardFeishuMock
      .mockResolvedValueOnce({ messageId: "om_first_card" })
      .mockResolvedValueOnce({ messageId: "om_second_card" });
    const { options } = createDispatcherHarness();
    const payload = { text: "Approve?", presentation: approvalPresentation };

    await options.deliver(payload, { kind: "final" });
    const delivered = await options.deliver(
      { ...payload, mediaUrl: "https://example.com/new-attachment.png" },
      { kind: "final" },
    );

    expect(sendCardFeishuMock).toHaveBeenCalledTimes(2);
    expect(sendMediaFeishuMock).toHaveBeenCalledTimes(1);
    expect(delivered).toMatchObject({
      visibleReplySent: true,
      messageIds: ["om_new_media", "om_second_card"],
    });
  });

  it("delivers changed legacy callbacks even when their visible prose is identical", async () => {
    useNonStreamingAutoAccount();
    const { options } = createDispatcherHarness();
    for (const value of ["choice-a", "choice-b"]) {
      await options.deliver(
        {
          text: "Choose an option",
          interactive: { blocks: [{ type: "buttons", buttons: [{ label: "Continue", value }] }] },
        },
        { kind: "final" },
      );
    }

    const cards = presentationCardBodies();
    expect(cards).toHaveLength(2);
    expect(JSON.stringify(cards[0])).toContain("choice-a");
    expect(JSON.stringify(cards[1])).toContain("choice-b");
  });

  it("retains accepted media identity when the final native card is rejected", async () => {
    useNonStreamingAutoAccount();
    sendCardFeishuMock.mockRejectedValueOnce(new Error("final card rejected"));
    sendMediaFeishuMock.mockResolvedValueOnce({ messageId: "om_accepted_media" });
    const { options } = createDispatcherHarness();
    const delivery = options.deliver(
      {
        text: "Choose an option",
        presentation: approvalPresentation,
        mediaUrl: "https://example.com/accepted-attachment.png",
      },
      { kind: "final" },
    );

    await expect(delivery).rejects.toMatchObject({
      code: "CHANNEL_PARTIAL_DELIVERY",
      deliveryResult: { visibleReplySent: true, messageIds: ["om_accepted_media"], content: "" },
    });
    expect(sendMediaFeishuMock).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    "retains accepted controls content when its receipt is missing with media=%s",
    async (withMedia) => {
      useNonStreamingAutoAccount();
      sendMediaFeishuMock.mockResolvedValueOnce({ messageId: "om_accepted_media" });
      sendCardFeishuMock.mockRejectedValueOnce(
        createChannelPartialDeliveryError(
          new Error("Feishu card send failed: no message_id returned"),
          { visibleReplySent: true, messageIds: [] },
        ),
      );
      const { options } = createDispatcherHarness();

      await expect(
        options.deliver(
          {
            text: "Choose an option",
            presentation: approvalPresentation,
            ...(withMedia ? { mediaUrl: "https://example.com/accepted.png" } : {}),
          },
          { kind: "final" },
        ),
      ).rejects.toMatchObject({
        code: "CHANNEL_PARTIAL_DELIVERY",
        deliveryResult: {
          visibleReplySent: true,
          content: `Choose an option\n\n${approvalPresentationText}`,
          ...(withMedia ? { messageIds: ["om_accepted_media"] } : {}),
        },
      });
      expect(sendCardFeishuMock).toHaveBeenCalledOnce();
      expect(sendMediaFeishuMock).toHaveBeenCalledTimes(withMedia ? 1 : 0);
    },
  );

  it("includes the required peer-bot mention after sanitizing presentation content", async () => {
    useNonStreamingAutoAccount();
    const { options } = createDispatcherHarness({
      mentionTargets: [{ openId: "ou_context_user", name: "Context user", key: "" }],
      requiredMentionTargets: [{ openId: "ou_peer_bot", name: "Peer bot", key: "" }],
    });
    const delivered = await options.deliver(
      { text: "Choose <at id=ou_other></at>", presentation: approvalPresentation },
      { kind: "final" },
    );

    const card = JSON.stringify(presentationCardBodies()[0]);
    expect(card).toContain("<at id=ou_peer_bot></at>");
    expect(card).not.toContain("<at id=ou_context_user></at>");
    expect(card).not.toContain("<at id=ou_other></at>");
    expect(card).toContain("&lt;at id=ou_other&gt;&lt;/at&gt;");
    expect(delivered).toMatchObject({ visibleReplySent: true });
  });

  it("does not repeat fallback prose inside its native controls card", async () => {
    useNonStreamingAutoAccount();
    const { options } = createDispatcherHarness();
    await options.deliver(
      {
        text: "Restart the gateway?\n\n- Yes\n- No",
        presentationTextMode: "fallback",
        presentation: {
          blocks: [
            { type: "text", text: "Restart the gateway?" },
            {
              type: "buttons",
              buttons: [
                { label: "Yes", action: { type: "command", command: "/yes" } },
                { label: "No", action: { type: "command", command: "/no" } },
              ],
            },
          ],
        },
      },
      { kind: "final" },
    );

    const card = JSON.stringify(presentationCardBodies()[0]);
    expect(card.split("Restart the gateway?")).toHaveLength(2);
    expect(card.split('"Yes"')).toHaveLength(2);
    expect(card.split('"No"')).toHaveLength(2);
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
  });

  it.each([
    { kind: "final", renderMode: "auto", streaming: "off" },
    { kind: "block", renderMode: "auto", streaming: "off" },
    { kind: "block", renderMode: "card", streaming: "partial" },
    { kind: "block", renderMode: "auto", streaming: "partial" },
    { kind: "final", renderMode: "card", streaming: "partial" },
    { kind: "final", renderMode: "auto", streaming: "partial" },
  ] as const)(
    "keeps oversized $kind control labels visible alongside voice media with $renderMode/$streaming",
    async ({ kind, renderMode, streaming }) => {
      const account = resolveFeishuAccountMock();
      resolveFeishuAccountMock.mockReturnValue({
        ...account,
        config: {
          ...account.config,
          renderMode,
          streaming: { mode: streaming, block: { enabled: streaming === "partial" } },
        },
      });
      sendMediaFeishuMock.mockResolvedValueOnce({ messageId: "om_voice" });
      const { dispatcher, deliveries } = createRecordedFeishuDispatcher();
      const lines = Array.from({ length: 250 }, (_, index) => `line ${index}`);
      const payload = {
        text: "Pick a run",
        mediaUrl: "https://example.com/answer.ogg",
        audioAsVoice: true,
        presentation: {
          blocks: [
            ...lines.map((text) => ({ type: "text" as const, text })),
            {
              type: "buttons" as const,
              buttons: [
                { label: "Open run", action: { type: "command" as const, command: "/open" } },
              ],
            },
          ],
        },
      };
      const fallbackText = ["Pick a run", ...lines, "- Open run: `/open`"].join("\n\n");
      const finalText = "The run is ready.";
      const hasLaterFinal = kind === "block" || streaming === "partial";

      // Queue both logical payloads before automatic idle. A final may replace
      // ordinary stream text, but it must not erase an earlier controls fallback.
      expect(
        kind === "block" ? dispatcher.sendBlockReply(payload) : dispatcher.sendFinalReply(payload),
      ).toBe(true);
      if (hasLaterFinal) {
        expect(dispatcher.sendFinalReply({ text: finalText })).toBe(true);
      }
      dispatcher.markComplete();
      await dispatcher.waitForIdle();

      expect(deliveries.map((entry) => entry.kind)).toEqual(
        hasLaterFinal ? [kind, "final"] : [kind],
      );
      expect(sendCardFeishuMock).not.toHaveBeenCalled();
      expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
      expect(sendMediaFeishuMock).toHaveBeenCalledOnce();
      if (streaming === "partial") {
        const finalStream = requireStreamingInstance(streamingInstances.length - 1);
        expect(finalStream.closeWithResult).toHaveBeenCalledWith(finalText, {
          note: "Agent: agent",
        });
        expect(finalStream.discard).not.toHaveBeenCalled();
      } else {
        expect(streamingInstances).toHaveLength(0);
      }
      const postTexts = sendMessageFeishuMock.mock.calls.map(
        ([params]) => requireRecord(params, "post send").text,
      );
      expect(postTexts).toEqual(
        kind === "block" && streaming === "off" ? [fallbackText, finalText] : [fallbackText],
      );
      const firstDelivery = deliveries[0]?.delivery;
      const settled = (await firstDelivery?.finalization) ?? firstDelivery;
      expect(settled).toMatchObject({ visibleReplySent: true, content: fallbackText });
      expect(settled?.messageIds).toContain("om_voice");
      expect(settled?.messageIds ?? []).not.toContain("om_stream");
    },
  );

  it("preserves full labels in oversized reply controls fallback", async () => {
    useNonStreamingAutoAccount();
    const { options } = createDispatcherHarness();
    const label = "Open the complete retained workflow run details";
    const delivery = await options.deliver(
      {
        presentation: {
          blocks: [
            ...Array.from({ length: 200 }, () => ({ type: "divider" as const })),
            {
              type: "buttons",
              buttons: [{ label, action: { type: "command", command: "/open-run" } }],
            },
          ],
        },
      },
      { kind: "final" },
    );

    expect(sendCardFeishuMock).not.toHaveBeenCalled();
    expect(sendMessageFeishuMock).toHaveBeenCalledOnce();
    expect(delivery?.visibleReplySent).toBe(true);
    expect(requireRecord(sendMessageFeishuMock.mock.calls[0]?.[0], "post send").text).toBe(
      `- ${label}: \`/open-run\``,
    );
  });

  type RecordedFeishuDelivery = {
    kind: "tool" | "block" | "final";
    delivery: Awaited<ReturnType<TypingDispatcherOptions["deliver"]>>;
  };

  function createRecordedFeishuDispatcher(onDelivered?: (kind: string) => void) {
    const { result, options } = createDispatcherHarness();
    const deliveries: RecordedFeishuDelivery[] = [];
    const entered = vi.fn();
    const dispatcher = createReplyDispatcher({
      ...options,
      deliver: async (payload, info) => {
        entered(info.kind);
        const delivery = await options.deliver(payload, info);
        if (delivery?.finalization) {
          void delivery.finalization.catch(() => undefined);
        }
        deliveries.push({ kind: info.kind, delivery });
        onDelivered?.(info.kind);
        return delivery;
      },
    });
    return { result, options, dispatcher, deliveries, entered };
  }

  it.each(["block", "tool"] as const)(
    "preserves an earlier block before %s controls",
    async (kind) => {
      resolveFeishuAccountMock.mockReturnValue({
        accountId: "main",
        appId: "app_id",
        appSecret: "app_secret",
        domain: "feishu",
        config: {
          renderMode: "auto",
          streaming: { mode: "partial", block: { enabled: true } },
        },
      });
      const { dispatcher, deliveries } = createRecordedFeishuDispatcher();
      const text = "The earlier answer paragraph.";
      expect(dispatcher.sendBlockReply({ text })).toBe(true);
      const controls = { text: "Choose the next action.", presentation: approvalPresentation };
      expect(
        kind === "block"
          ? dispatcher.sendBlockReply(controls)
          : dispatcher.sendToolResult(controls),
      ).toBe(true);
      dispatcher.markComplete();
      await dispatcher.waitForIdle();

      expect(deliveries.map((entry) => entry.kind)).toEqual(["block", kind]);
      await expect(deliveries[0]?.delivery?.finalization).resolves.toMatchObject({
        visibleReplySent: true,
        content: text,
        messageIds: ["om_stream"],
      });
      expect(deliveries[1]?.delivery).toMatchObject({
        visibleReplySent: true,
        content: `Choose the next action.\n\n${approvalPresentationText}`,
        messageIds: ["om_card"],
      });
      expect(requireStreamingInstance(0).discard).not.toHaveBeenCalled();
      expect(requireStreamingInstance(0).closeWithResult).toHaveBeenCalledWith(text, {
        note: "Agent: agent",
      });
      expect(sendCardFeishuMock).toHaveBeenCalledOnce();
      expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "suppresses discarded block prose while retaining accepted media=%s",
    async (withMedia) => {
      sendMediaFeishuMock.mockResolvedValue({ messageId: "om-block-media" });
      sendCardFeishuMock.mockResolvedValue({ messageId: "om-final-controls" });
      const { dispatcher, deliveries } = createRecordedFeishuDispatcher();
      const obsoleteText = "```text\nobsolete streaming paragraph\n```";

      // Both payloads enter the real serialized queue before it drains. The old
      // block returns deferred settlement; the final replaces its preview before idle.
      const blockQueued = dispatcher.sendBlockReply({
        text: obsoleteText,
        ...(withMedia ? { mediaUrl: "https://example.com/accepted.png" } : {}),
      });
      const finalQueued = dispatcher.sendFinalReply({
        text: "Choose the next action.",
        presentation: approvalPresentation,
      });
      dispatcher.markComplete();
      await dispatcher.waitForIdle();
      expect(blockQueued).toBe(true);
      expect(finalQueued).toBe(true);

      const block = deliveries.find((entry) => entry.kind === "block")?.delivery;
      const final = deliveries.find((entry) => entry.kind === "final")?.delivery;
      expect(block?.finalization).toBeDefined();
      const settledBlock = await block?.finalization;
      expect(settledBlock).toBeDefined();
      expect(settledBlock?.visibleReplySent).toBe(withMedia);
      expect(settledBlock?.messageIds ?? []).toEqual(withMedia ? ["om-block-media"] : []);
      expect(settledBlock?.content ?? "").not.toContain("obsolete streaming paragraph");
      if (withMedia) {
        // Core falls back to the original payload text when content is absent.
        expect(settledBlock?.content).toBe("");
      }
      expect(final).toMatchObject({
        visibleReplySent: true,
        messageIds: ["om-final-controls"],
      });
      expect(sendMediaFeishuMock).toHaveBeenCalledTimes(withMedia ? 1 : 0);
      expect(sendCardFeishuMock).toHaveBeenCalledOnce();
      expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
      expect(sendMessageFeishuMock).not.toHaveBeenCalled();
      expect(requireStreamingInstance(0).discard).toHaveBeenCalledOnce();
    },
  );

  it.each([false, true])(
    "retains the original preview receipt after failed cleanup with media=%s",
    async (withMedia) => {
      const obsoleteText = "```text\naccepted preview remains visible\n```";
      sendMediaFeishuMock.mockResolvedValue({ messageId: "om-block-media" });
      const { result, dispatcher, deliveries } = createRecordedFeishuDispatcher((kind) => {
        if (kind !== "block") {
          return;
        }
        const instance = requireStreamingInstance(0);
        instance.discard.mockImplementationOnce(async () => {
          instance.active = false;
          throw new FeishuStreamingFinalizationError(new Error("preview clear rejected"), {
            visibleReplySent: true,
            content: obsoleteText,
            messageId: "om-original-preview",
          });
        });
      });
      expect(
        dispatcher.sendBlockReply({
          text: obsoleteText,
          ...(withMedia ? { mediaUrl: "https://example.com/accepted.png" } : {}),
        }),
      ).toBe(true);
      expect(
        dispatcher.sendFinalReply({
          text: "Choose the next action.",
          presentation: approvalPresentation,
        }),
      ).toBe(true);
      dispatcher.markComplete();
      await dispatcher.waitForIdle();

      const block = deliveries.find((entry) => entry.kind === "block")?.delivery;
      expect(block?.finalization).toBeDefined();
      await expect(block?.finalization).rejects.toMatchObject({
        code: "CHANNEL_PARTIAL_DELIVERY",
        deliveryResult: {
          visibleReplySent: true,
          content: obsoleteText,
          messageIds: ["om-original-preview", ...(withMedia ? ["om-block-media"] : [])],
        },
      });
      expect(deliveries.some((entry) => entry.kind === "final")).toBe(false);
      expect(sendCardFeishuMock).not.toHaveBeenCalled();
      expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
      expect(sendMediaFeishuMock).toHaveBeenCalledTimes(withMedia ? 1 : 0);
      await expect(result.ensureNoVisibleReplyFallback("failed-cleanup")).resolves.toBe(false);
      expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    },
  );

  it("keeps an idle-owned close receipt when a later controls card arrives", async () => {
    const text = "```text\naccepted block\n```";
    const closedResult = {
      visibleReplySent: true,
      content: text,
      messageId: "om-closed-before-controls",
    };
    let releaseClose!: () => void;
    const closing = new Promise<typeof closedResult>((resolve) => {
      releaseClose = () => resolve(closedResult);
    });
    sendCardFeishuMock.mockResolvedValue({ messageId: "om-later-controls" });
    const { dispatcher, options, deliveries, entered } = createRecordedFeishuDispatcher((kind) => {
      if (kind !== "block") {
        return;
      }
      const instance = requireStreamingInstance(0);
      instance.closeWithResult.mockImplementationOnce(() => {
        // The real session becomes inactive before its awaited close I/O.
        instance.active = false;
        return closing;
      });
    });

    try {
      expect(dispatcher.sendBlockReply({ text })).toBe(true);
      await vi.waitFor(() =>
        expect(requireStreamingInstance(0).closeWithResult).toHaveBeenCalledOnce(),
      );
      // Automatic idle already captured the block completion and owns the close.
      expect(
        dispatcher.sendFinalReply({
          text: "Choose the next action.",
          presentation: approvalPresentation,
        }),
      ).toBe(true);
      await vi.waitFor(() => expect(entered).toHaveBeenCalledWith("final"));
      releaseClose();
      dispatcher.markComplete();
      await dispatcher.waitForIdle();

      const block = deliveries.find((entry) => entry.kind === "block")?.delivery;
      const final = deliveries.find((entry) => entry.kind === "final")?.delivery;
      expect(block?.finalization).toBeDefined();
      await expect(block?.finalization).resolves.toMatchObject({
        visibleReplySent: true,
        content: text,
        messageIds: ["om-closed-before-controls"],
      });
      expect(final).toMatchObject({
        visibleReplySent: true,
        messageIds: ["om-later-controls"],
      });
      expect(requireStreamingInstance(0).discard).not.toHaveBeenCalled();
      expect(sendCardFeishuMock).toHaveBeenCalledOnce();
      expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
    } finally {
      releaseClose();
      dispatcher.markComplete();
      await options.onIdle?.();
      await dispatcher.waitForIdle();
    }
  });

  it("retains an idle-owned receipt when matching media registers its completion after close", async () => {
    const text = "```text\naccepted text with later media\n```";
    const closedResult = {
      visibleReplySent: true,
      content: text,
      messageId: "om-closed-stream",
    };
    let releaseClose!: () => void;
    const closing = new Promise<typeof closedResult>((resolve) => {
      releaseClose = () => resolve(closedResult);
    });
    let releaseMedia!: () => void;
    const media = new Promise<{ messageId: string }>((resolve) => {
      releaseMedia = () => resolve({ messageId: "om-late-media" });
    });
    sendMediaFeishuMock.mockReturnValue(media);
    const { dispatcher, options, deliveries } = createRecordedFeishuDispatcher((kind) => {
      if (kind !== "block") {
        return;
      }
      const instance = requireStreamingInstance(0);
      instance.closeWithResult.mockImplementationOnce(() => {
        instance.active = false;
        return closing;
      });
    });

    try {
      expect(dispatcher.sendBlockReply({ text })).toBe(true);
      await vi.waitFor(() =>
        expect(requireStreamingInstance(0).closeWithResult).toHaveBeenCalledOnce(),
      );
      // The preceding delivery has returned. Only idle close overlaps this next
      // serialized delivery; two deliver calls never run concurrently.
      expect(
        dispatcher.sendFinalReply({
          text,
          mediaUrl: "https://example.com/late.png",
        }),
      ).toBe(true);
      await vi.waitFor(() => expect(sendMediaFeishuMock).toHaveBeenCalledOnce());
      releaseClose();
      const block = deliveries.find((entry) => entry.kind === "block")?.delivery;
      expect(block?.finalization).toBeDefined();
      await block?.finalization;
      expect(deliveries.filter((entry) => entry.kind === "final")).toHaveLength(0);

      releaseMedia();
      dispatcher.markComplete();
      await dispatcher.waitForIdle();
      const final = deliveries.find((entry) => entry.kind === "final")?.delivery;
      expect(final?.finalization).toBeDefined();
      await expect(final?.finalization).resolves.toMatchObject({
        visibleReplySent: true,
        content: text,
        messageIds: ["om-closed-stream", "om-late-media"],
      });
      expect(sendMediaFeishuMock).toHaveBeenCalledOnce();
      expect(requireStreamingInstance(0).discard).not.toHaveBeenCalled();
      expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
      expect(sendCardFeishuMock).not.toHaveBeenCalled();
    } finally {
      releaseClose();
      releaseMedia();
      dispatcher.markComplete();
      await options.onIdle?.();
      await dispatcher.waitForIdle();
    }
  });

  it("suppresses internal block payload delivery", async () => {
    const { options } = createDispatcherHarness();
    await options.deliver({ text: "internal reasoning chunk" }, { kind: "block" });

    expect(streamingInstances).toHaveLength(0);
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(sendMediaFeishuMock).not.toHaveBeenCalled();
  });

  it("disables block streaming by default to prevent silent reply drops", () => {
    const result = createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: {} as never,
      chatId: "oc_chat",
      sendTarget: "oc_chat",
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
        streaming: { mode: "partial", block: { enabled: true } },
      },
    });

    const { result, options } = createDispatcherHarness();
    expect(result.replyOptions).toHaveProperty("disableBlockStreaming", false);

    await options.deliver({ text: "plain block" }, { kind: "block" });
    await options.onIdle?.();

    expect(streamingInstances).toHaveLength(1);
    expect(requireStreamingInstance(0).closeWithResult).toHaveBeenCalledWith("plain block", {
      note: "Agent: agent",
    });
  });

  it("sends complete chunked blocks to the DM target", async () => {
    useNonStreamingBlockAccount();
    const runtime = getFeishuRuntimeMock();
    runtime.channel.text.resolveTextChunkLimit.mockReturnValue(10);
    runtime.channel.text.chunkMarkdownTextWithMode.mockImplementation((text: string) =>
      text === "First paragraph." ? ["First ", "paragraph."] : [text],
    );
    const mentions = [{ openId: "ou_target", name: "Target User", key: "@_user_1" }];
    const { options } = createDispatcherHarness({
      chatId: "oc_p2p_chat",
      sendTarget: "user:ou_sender",
      mentionTargets: mentions,
    });

    await options.deliver({ text: "First paragraph." }, { kind: "block" });
    await options.deliver(
      { text: "Second paragraph.", mediaUrl: "https://example.com/block.png" },
      { kind: "block" },
    );
    await options.onIdle?.();

    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(3);
    expectMockArgFields(sendMessageFeishuMock, "first block chunk", {
      to: "user:ou_sender",
      text: "First ",
      mentions,
    });
    expectMockArgFields(sendMessageFeishuMock, "second block chunk", { text: "paragraph." }, 1);
    expectMockArgFields(sendMessageFeishuMock, "second block", { text: "Second paragraph." }, 2);
    expect(sendMessageFeishuMock.mock.calls[1]?.[0]).not.toHaveProperty("mentions");
    expect(sendMessageFeishuMock.mock.calls[2]?.[0]).not.toHaveProperty("mentions");
    expectMockArgFields(sendMediaFeishuMock, "block media", {
      to: "user:ou_sender",
      mediaUrl: "https://example.com/block.png",
    });
    expect(streamingInstances).toHaveLength(0);
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
  });

  it("delivers a final message when it differs from independently sent blocks", async () => {
    useNonStreamingBlockAccount();
    const { options } = createDispatcherHarness();

    await options.deliver({ text: "partial block" }, { kind: "block" });
    await options.deliver({ text: "final answer" }, { kind: "final" });
    await options.onIdle?.();

    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(2);
    expectMockArgFields(sendMessageFeishuMock, "block message", { text: "partial block" });
    expectMockArgFields(sendMessageFeishuMock, "final message", { text: "final answer" }, 1);
  });

  it("does not prepend automatic mentions to streaming card closes", async () => {
    const overrides = {
      runtime: createRuntimeLogger(),
      mentionTargets: [{ openId: "ou-target", name: "Target User", key: "@_user_1" }],
    } as Partial<ReplyDispatcherArgs>;
    const { options } = createDispatcherHarness(overrides);
    await options.deliver({ text: "```md\nanswer\n```" }, { kind: "final" });
    await options.onIdle?.();

    expect(streamingInstances).toHaveLength(1);
    expect(requireStreamingInstance(0).closeWithResult).toHaveBeenCalledWith("```md\nanswer\n```", {
      note: "Agent: agent",
    });
  });

  it("keeps core block streaming disabled when Feishu blockStreaming is explicitly false", async () => {
    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "auto",
        streaming: { mode: "partial", block: { enabled: false } },
      },
    });

    const result = createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: {} as never,
      chatId: "oc_chat",
      sendTarget: "oc_chat",
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
    expect(requireStreamingInstance(0).start).toHaveBeenCalledTimes(1);
    expectStreamingStartOptions(0, {
      replyToMessageId: undefined,
      replyInThread: undefined,
      rootId: "om_root_topic",
      header: { title: "agent", template: "blue" },
      note: "Agent: agent",
    });
    expect(requireStreamingInstance(0).closeWithResult).toHaveBeenCalledTimes(1);
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
  });

  it("strips prose from identity emoji in streaming and static card headers", async () => {
    const identity = {
      name: "Agent",
      emoji: "根据心情/语气自由切换 😊🇺🇸👍🏽👨‍👩‍👧‍👦",
      theme: "green" as const,
    };
    const { options } = createDispatcherHarness({
      runtime: createRuntimeLogger(),
      identity,
    });
    await options.deliver({ text: "```ts\nconst x = 1\n```" }, { kind: "final" });

    expectStreamingStartOptions(0, {
      header: { title: "😊🇺🇸👍🏽👨‍👩‍👧‍👦 Agent", template: "green" },
    });

    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "card",
        streaming: { mode: "off" },
      },
    });
    const { options: staticOptions } = createDispatcherHarness({
      runtime: createRuntimeLogger(),
      identity,
    });
    await staticOptions.deliver({ text: "| a | b |\n| - | - |" }, { kind: "final" });

    expectLastMockArgFields(sendStructuredCardFeishuMock, "structured card params", {
      header: { title: "😊🇺🇸👍🏽👨‍👩‍👧‍👦 Agent", template: "green" },
    });
  });

  it("closes streaming with block text when final reply is missing", async () => {
    const { options } = createDispatcherHarness({
      runtime: createRuntimeLogger(),
    });
    await options.deliver({ text: "```md\npartial answer\n```" }, { kind: "block" });
    await options.onIdle?.();

    expect(streamingInstances).toHaveLength(1);
    expect(requireStreamingInstance(0).start).toHaveBeenCalledTimes(1);
    expect(requireStreamingInstance(0).closeWithResult).toHaveBeenCalledTimes(1);
    expect(requireStreamingInstance(0).closeWithResult).toHaveBeenCalledWith(
      "```md\npartial answer\n```",
      {
        note: "Agent: agent",
      },
    );
  });

  it("coalesces cumulative final payloads into one streaming card until idle", async () => {
    const { options } = createDispatcherHarness({
      runtime: createRuntimeLogger(),
    });
    await options.deliver({ text: "```md\n完整回复第一段\n```" }, { kind: "final" });
    await options.deliver({ text: "```md\n完整回复第一段 + 第二段\n```" }, { kind: "final" });
    await options.onIdle?.();

    expect(streamingInstances).toHaveLength(1);
    expect(requireStreamingInstance(0).closeWithResult).toHaveBeenCalledTimes(1);
    expect(requireStreamingInstance(0).closeWithResult).toHaveBeenCalledWith(
      "```md\n完整回复第一段 + 第二段\n```",
      {
        note: "Agent: agent",
      },
    );
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
  });

  it("retains each logical payload content when finals coalesce onto one card", async () => {
    const { options } = createDispatcherHarness({
      runtime: createRuntimeLogger(),
    });
    const firstDelivery = await options.deliver({ text: "first final" }, { kind: "final" });
    const secondDelivery = await options.deliver(
      { text: "first final plus second" },
      { kind: "final" },
    );

    await options.onIdle?.();

    await expect(firstDelivery?.finalization).resolves.toMatchObject({
      content: "first final",
      messageIds: ["om_stream"],
    });
    await expect(secondDelivery?.finalization).resolves.toMatchObject({
      content: "first final plus second",
      messageIds: ["om_stream"],
    });
  });

  it("appends an independent error final without replacing the assistant answer", async () => {
    const { options } = createDispatcherHarness({
      runtime: createRuntimeLogger(),
    });
    await options.deliver({ text: "The file is ready." }, { kind: "final" });
    await options.deliver({ text: "⚠️ Exec failed", isError: true }, { kind: "final" });
    await options.onIdle?.();

    expect(streamingInstances).toHaveLength(1);
    expect(requireStreamingInstance(0).closeWithResult).toHaveBeenCalledTimes(1);
    expect(requireStreamingInstance(0).closeWithResult).toHaveBeenCalledWith(
      "The file is ready.\n\n⚠️ Exec failed",
      { note: "Agent: agent" },
    );
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
  });

  it("does not duplicate the answer from a cumulative error final", async () => {
    const { options } = createDispatcherHarness({
      runtime: createRuntimeLogger(),
    });
    await options.deliver({ text: "The file is ready." }, { kind: "final" });
    await options.deliver(
      { text: "The file is ready.\n\n⚠️ Exec failed", isError: true },
      { kind: "final" },
    );
    await options.onIdle?.();

    expect(streamingInstances).toHaveLength(1);
    expect(requireStreamingInstance(0).closeWithResult).toHaveBeenCalledWith(
      "The file is ready.\n\n⚠️ Exec failed",
      { note: "Agent: agent" },
    );
  });

  it.each([4_000, 40])(
    "keeps a completed answer before a controls error final with text limit %i",
    async (textChunkLimit) => {
      getFeishuRuntimeMock().channel.text.resolveTextChunkLimit.mockReturnValue(textChunkLimit);
      const { dispatcher, deliveries } = createRecordedFeishuDispatcher();
      const answer = "The file is ready.";
      const errorText = "⚠️ Exec failed";
      expect(dispatcher.sendFinalReply({ text: answer })).toBe(true);
      expect(
        dispatcher.sendFinalReply({
          text: errorText,
          isError: true,
          presentation: approvalPresentation,
        }),
      ).toBe(true);
      dispatcher.markComplete();
      await dispatcher.waitForIdle();

      expect(deliveries.map((entry) => entry.kind)).toEqual(["final", "final"]);
      await expect(deliveries[0]?.delivery?.finalization).resolves.toMatchObject({
        visibleReplySent: true,
        content: answer,
        messageIds: ["om_stream"],
      });
      expect(deliveries[1]?.delivery).toMatchObject({
        visibleReplySent: true,
        content: `${errorText}\n\n${approvalPresentationText}`,
        messageIds: ["om_card"],
      });
      expect(requireStreamingInstance(0).discard).not.toHaveBeenCalled();
      expect(requireStreamingInstance(0).closeWithResult).toHaveBeenCalledWith(answer, {
        note: "Agent: agent",
      });
      expect(sendCardFeishuMock).toHaveBeenCalledOnce();
      expect(JSON.stringify(presentationCardBodies()[0])).not.toContain(answer);
      expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
    },
  );

  it("replaces a partial preview when the first final is an error", async () => {
    const { result, options } = createDispatcherHarness({
      runtime: createRuntimeLogger(),
    });
    result.replyOptions.onPartialReply?.({ text: "Working on it..." });
    await options.deliver({ text: "⚠️ Exec failed", isError: true }, { kind: "final" });
    await options.onIdle?.();

    expect(streamingInstances).toHaveLength(1);
    expect(requireStreamingInstance(0).closeWithResult).toHaveBeenCalledWith("⚠️ Exec failed", {
      note: "Agent: agent",
    });
  });

  it("falls back to chunked text when an appended error exceeds the streaming limit", async () => {
    const runtime = getFeishuRuntimeMock();
    runtime.channel.text.resolveTextChunkLimit.mockReturnValue(20);

    const { options } = createDispatcherHarness({
      runtime: createRuntimeLogger(),
    });
    await options.deliver({ text: "123456789012345678" }, { kind: "final" });
    await options.deliver({ text: "⚠️ Exec failed", isError: true }, { kind: "final" });
    await options.onIdle?.();

    expect(streamingInstances).toHaveLength(1);
    expect(requireStreamingInstance(0).discard).toHaveBeenCalledTimes(1);
    expect(requireStreamingInstance(0).closeWithResult).not.toHaveBeenCalled();
    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    expectLastMockArgFields(sendMessageFeishuMock, "message send params", {
      text: "123456789012345678\n\n⚠️ Exec failed",
    });
  });

  it("skips exact duplicate final text after streaming close", async () => {
    const { options } = createDispatcherHarness({
      runtime: createRuntimeLogger(),
    });
    await options.deliver({ text: "```md\n同一条回复\n```" }, { kind: "final" });
    await options.onIdle?.();
    await options.deliver({ text: "```md\n同一条回复\n```" }, { kind: "final" });

    expect(streamingInstances).toHaveLength(1);
    expect(requireStreamingInstance(0).closeWithResult).toHaveBeenCalledTimes(1);
    expect(requireStreamingInstance(0).closeWithResult).toHaveBeenCalledWith(
      "```md\n同一条回复\n```",
      {
        note: "Agent: agent",
      },
    );
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
  });

  it("skips final text already closed by idle streaming", async () => {
    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "card",
        streaming: { mode: "partial" },
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
    expect(requireStreamingInstance(0).closeWithResult).toHaveBeenCalledTimes(1);
    expect(requireStreamingInstance(0).closeWithResult).toHaveBeenCalledWith(
      "```md\nidle streamed reply\n```",
      {
        note: "Agent: agent",
      },
    );
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
  });

  it("waits for deliverable text before starting a card after assistant message start", async () => {
    const { result, options } = createDispatcherHarness({
      runtime: createRuntimeLogger(),
    });

    await options.onReplyStart?.();
    result.replyOptions.onAssistantMessageStart?.();
    await options.deliver({ text: "plain final answer" }, { kind: "final" });
    await options.onIdle?.();

    expect(streamingInstances).toHaveLength(1);
    expect(requireStreamingInstance(0).start).toHaveBeenCalledTimes(1);
    expect(requireStreamingInstance(0).closeWithResult).toHaveBeenCalledWith("plain final answer", {
      note: "Agent: agent",
    });
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
  });

  it("does not create an empty card when assistant message start has no deliverable final", async () => {
    const { result, options } = createDispatcherHarness({
      runtime: createRuntimeLogger(),
    });

    await options.onReplyStart?.();
    result.replyOptions.onAssistantMessageStart?.();
    await options.onIdle?.();

    expect(streamingInstances).toHaveLength(0);
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
  });

  it("starts a streaming card from partial snapshots in auto mode", async () => {
    const { result, options } = createDispatcherHarness({
      runtime: createRuntimeLogger(),
    });

    result.replyOptions.onPartialReply?.({ text: "plain" });
    result.replyOptions.onPartialReply?.({ text: "plain streamed answer" });
    await options.onIdle?.();

    expect(streamingInstances).toHaveLength(1);
    expect(requireStreamingInstance(0).closeWithResult).toHaveBeenCalledWith(
      "plain streamed answer",
      {
        note: "Agent: agent",
      },
    );
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
  });

  it("delivers distinct late final text after streaming card close", async () => {
    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "card",
        streaming: { mode: "partial" },
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

    expect(streamingInstances).toHaveLength(2);
    expect(requireStreamingInstance(0).closeWithResult).toHaveBeenCalledTimes(1);
    expect(requireStreamingInstance(0).closeWithResult).toHaveBeenCalledWith(
      "First complete answer",
      {
        note: "Agent: agent",
      },
    );
    expect(requireStreamingInstance(1).closeWithResult).toHaveBeenCalledWith(
      "Late tool-result final",
      {
        note: "Agent: agent",
      },
    );
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
    expect(sendMediaFeishuMock).toHaveBeenCalledTimes(1);
    expectMockArgFields(sendMediaFeishuMock, "media send params", {
      mediaUrl: "https://example.com/a.png",
    });
  });

  it("delivers oversized late final text after streaming card close", async () => {
    const runtime = getFeishuRuntimeMock();
    runtime.channel.text.resolveTextChunkLimit.mockReturnValue(10);
    runtime.channel.text.chunkMarkdownTextWithMode.mockReturnValue(["oversized ", "late final"]);

    const { options } = createDispatcherHarness({
      runtime: createRuntimeLogger(),
    });

    await options.deliver({ text: "First" }, { kind: "final" });
    await options.onIdle?.();
    await options.deliver(
      { text: "oversized late final", mediaUrl: "https://example.com/a.png" },
      { kind: "final" },
    );
    await options.onIdle?.();

    expect(streamingInstances).toHaveLength(1);
    expect(requireStreamingInstance(0).closeWithResult).toHaveBeenCalledTimes(1);
    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(2);
    expect(sendMessageFeishuMock.mock.calls.map(([request]) => request.text)).toEqual([
      "oversized ",
      "late final",
    ]);
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
    expect(sendMediaFeishuMock).toHaveBeenCalledTimes(1);
    expectMockArgFields(sendMediaFeishuMock, "media send params", {
      mediaUrl: "https://example.com/a.png",
    });
  });

  it("suppresses duplicate final text while still sending media", async () => {
    const options = setupNonStreamingAutoDispatcher();
    await options.deliver({ text: "plain final" }, { kind: "final" });
    await options.deliver(
      { text: "plain final", mediaUrl: "https://example.com/a.png" },
      { kind: "final" },
    );

    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    expectLastMockArgFields(sendMessageFeishuMock, "message send params", {
      text: "plain final",
    });
    expect(sendMediaFeishuMock).toHaveBeenCalledTimes(1);
    expectMockArgFields(sendMediaFeishuMock, "media send params", {
      mediaUrl: "https://example.com/a.png",
    });
  });

  it("keeps distinct non-streaming final payloads", async () => {
    const options = setupNonStreamingAutoDispatcher();
    await options.deliver({ text: "notice header" }, { kind: "final" });
    await options.deliver({ text: "actual answer body" }, { kind: "final" });

    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(2);
    expectMockArgFields(sendMessageFeishuMock, "first message send params", {
      text: "notice header",
    });
    expectMockArgFields(
      sendMessageFeishuMock,
      "second message send params",
      {
        text: "actual answer body",
      },
      1,
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
        streaming: { mode: "partial" },
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
    expect(requireStreamingInstance(0).closeWithResult).toHaveBeenCalledTimes(1);
    expect(requireStreamingInstance(0).closeWithResult).toHaveBeenCalledWith("hellolo world", {
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
        streaming: { mode: "partial" },
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
    expect(requireStreamingInstance(0).closeWithResult).toHaveBeenCalledTimes(1);
    expect(requireStreamingInstance(0).closeWithResult).toHaveBeenCalledWith(
      "```md\npartial\n```",
      {
        note: "Agent: agent",
      },
    );
  });

  it("preserves previous generation blocks when partial snapshots reset after tools", async () => {
    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "card",
        streaming: { mode: "partial" },
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
    expect(requireStreamingInstance(0).closeWithResult).toHaveBeenCalledWith(
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
        streaming: { mode: "partial" },
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

    expect(requireStreamingInstance(0).closeWithResult).toHaveBeenCalledWith("visible answer", {
      note: "Agent: agent",
    });
  });

  it("sends media-only payloads as attachments", async () => {
    const { options } = createDispatcherHarness();
    await options.deliver({ mediaUrl: "https://example.com/a.png" }, { kind: "final" });

    expect(sendMediaFeishuMock).toHaveBeenCalledTimes(1);
    expectMockArgFields(sendMediaFeishuMock, "media send params", {
      to: "oc_chat",
      mediaUrl: "https://example.com/a.png",
    });
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
  });

  it("passes audioAsVoice to media attachments", async () => {
    const { options } = createDispatcherHarness();
    await options.deliver(
      { mediaUrl: "https://example.com/reply.mp3", audioAsVoice: true },
      { kind: "final" },
    );

    expectMockArgFields(sendMediaFeishuMock, "media send params", {
      mediaUrl: "https://example.com/reply.mp3",
      audioAsVoice: true,
    });
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
    expectMockArgFields(sendMediaFeishuMock, "media send params", {
      mediaUrl: "https://example.com/reply.mp3",
      audioAsVoice: true,
    });
  });

  it("sends TTS text before voice media when it is not already visible", async () => {
    useNonStreamingAutoAccount();
    const { options } = createDispatcherHarness();
    await options.deliver(
      {
        text: "Readable answer",
        mediaUrl: "https://example.com/reply.ogg",
        audioAsVoice: true,
        ttsSupplement: { spokenText: "Readable answer" },
      },
      { kind: "final" },
    );

    expectMockArgFields(sendMessageFeishuMock, "message send params", {
      text: "Readable answer",
    });
    expectMockArgFields(sendMediaFeishuMock, "media send params", {
      mediaUrl: "https://example.com/reply.ogg",
      audioAsVoice: true,
    });
    expect(sendMessageFeishuMock.mock.invocationCallOrder[0]).toBeLessThan(
      sendMediaFeishuMock.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("keeps streamed text visible before its TTS supplement", async () => {
    const account = resolveFeishuAccountMock();
    resolveFeishuAccountMock.mockReturnValue({
      ...account,
      config: {
        ...account.config,
        streaming: { ...account.config.streaming, block: { enabled: true } },
      },
    });
    const { options } = createDispatcherHarness();
    await options.deliver({ text: "Readable answer" }, { kind: "block" });
    await options.deliver(
      {
        mediaUrl: "https://example.com/reply.ogg",
        audioAsVoice: true,
        ttsSupplement: {
          spokenText: "Readable answer",
          visibleTextAlreadyDelivered: true,
        },
      },
      { kind: "final" },
    );
    await options.onIdle?.();

    expect(streamingInstances).toHaveLength(1);
    expect(requireStreamingInstance(0).discard).not.toHaveBeenCalled();
    expect(requireStreamingInstance(0).closeWithResult).toHaveBeenCalledWith("Readable answer", {
      note: "Agent: agent",
    });
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(sendMediaFeishuMock).toHaveBeenCalledTimes(1);
  });

  it("discards partial streaming text when final replies send voice media", async () => {
    const { result, options } = createDispatcherHarness({
      runtime: createRuntimeLogger(),
    });

    result.replyOptions.onPartialReply?.({ text: "spoken reply" });
    await options.deliver(
      {
        text: "spoken reply",
        mediaUrl: "https://example.com/reply.mp3",
        audioAsVoice: true,
      },
      { kind: "final" },
    );
    await options.onIdle?.();

    expect(streamingInstances).toHaveLength(1);
    expect(requireStreamingInstance(0).discard).toHaveBeenCalledTimes(1);
    expect(requireStreamingInstance(0).closeWithResult).not.toHaveBeenCalled();
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
    expect(sendMediaFeishuMock).toHaveBeenCalledTimes(1);
    expectMockArgFields(sendMediaFeishuMock, "media send params", {
      mediaUrl: "https://example.com/reply.mp3",
      audioAsVoice: true,
    });
  });

  it("keeps partial streaming text when final replies send regular media only", async () => {
    const { result, options } = createDispatcherHarness({
      runtime: createRuntimeLogger(),
    });

    result.replyOptions.onPartialReply?.({ text: "caption from stream" });
    await options.deliver(
      {
        mediaUrl: "https://example.com/image.png",
      },
      { kind: "final" },
    );
    await options.onIdle?.();

    expect(streamingInstances).toHaveLength(1);
    expect(requireStreamingInstance(0).discard).not.toHaveBeenCalled();
    expect(requireStreamingInstance(0).closeWithResult).toHaveBeenCalledWith(
      "caption from stream",
      {
        note: "Agent: agent",
      },
    );
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
    expect(sendMediaFeishuMock).toHaveBeenCalledTimes(1);
    expectMockArgFields(sendMediaFeishuMock, "media send params", {
      mediaUrl: "https://example.com/image.png",
    });
  });

  it("preserves the no-provider-dispatch marker for media preparation failures", async () => {
    useNonStreamingAutoAccount();
    const marker = Object.assign(
      new Error("media load failed", { cause: new Error("blocked local load") }),
      {
        code: "OPENCLAW_PLATFORM_MESSAGE_NOT_DISPATCHED",
        retryable: true,
      },
    );
    sendMediaFeishuMock.mockRejectedValueOnce(marker);
    const { options } = createDispatcherHarness();

    const error = await options
      .deliver({ mediaUrl: "https://files.example.test/image.png" }, { kind: "final" })
      .catch((caught: unknown) => caught);

    expect(error).toBe(marker);
  });

  it("never sends media fallback text after an accepted attachment loses its receipt", async () => {
    useNonStreamingAutoAccount();
    const acceptedError = createChannelPartialDeliveryError(
      new Error("Feishu image send failed: no message_id returned"),
      { messageIds: [], visibleReplySent: true },
    );
    sendMediaFeishuMock.mockRejectedValueOnce(acceptedError);
    const { result, options } = createDispatcherHarness();

    const error = await options
      .deliver(
        {
          text: "caption that must not be duplicated",
          mediaUrl: "https://example.com/reply.mp3",
          audioAsVoice: true,
        },
        { kind: "final" },
      )
      .catch((caught: unknown) => caught);

    expect(isChannelPartialDeliveryError(error)).toBe(true);
    expect(sendMediaFeishuMock).toHaveBeenCalledOnce();
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(result.getVisibleReplyState().visibleReplySent).toBe(true);
    await expect(result.ensureNoVisibleReplyFallback("accepted-no-id")).resolves.toBe(false);
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      kind: "text",
      text: "already accepted",
      provider: sendMessageFeishuMock,
    },
    {
      kind: "card",
      text: "| first | second |\n| - | - |",
      provider: sendStructuredCardFeishuMock,
    },
  ])(
    "never sends no-visible fallback after an accepted $kind reply loses its receipt",
    async ({ text, provider }) => {
      useNonStreamingAutoAccount();
      const acceptedError = createChannelPartialDeliveryError(
        new Error("Feishu reply failed: no message_id returned"),
        { messageIds: [], visibleReplySent: true },
      );
      provider.mockRejectedValueOnce(acceptedError);
      const { result, options } = createDispatcherHarness();

      const error = await options
        .deliver({ text }, { kind: "final" })
        .catch((caught: unknown) => caught);

      expect(error).toMatchObject({
        code: "CHANNEL_PARTIAL_DELIVERY",
        deliveryResult: {
          content: text,
          messageIds: [],
          visibleReplySent: true,
        },
      });
      expect(provider).toHaveBeenCalledOnce();
      await Promise.resolve(options.onError?.(error, { kind: "final" }));
      expect(result.getVisibleReplyState().visibleReplySent).toBe(true);
      await expect(result.ensureNoVisibleReplyFallback("accepted-no-id")).resolves.toBe(false);
      expect(provider).toHaveBeenCalledOnce();
      if (provider !== sendMessageFeishuMock) {
        expect(sendMessageFeishuMock).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    { kind: "text", provider: sendMessageFeishuMock, acceptedBeforeReceiptLoss: 0 },
    { kind: "text", provider: sendMessageFeishuMock, acceptedBeforeReceiptLoss: 1 },
    { kind: "card", provider: sendStructuredCardFeishuMock, acceptedBeforeReceiptLoss: 0 },
    { kind: "card", provider: sendStructuredCardFeishuMock, acceptedBeforeReceiptLoss: 1 },
  ])(
    "retains accepted $kind chunk content after receipt loss with $acceptedBeforeReceiptLoss prior receipts",
    async ({ kind, provider, acceptedBeforeReceiptLoss }) => {
      useNonStreamingAutoAccount();
      const runtime = getFeishuRuntimeMock();
      runtime.channel.text.resolveTextChunkLimit.mockReturnValue(6);
      runtime.channel.text.chunkMarkdownTextWithMode.mockReturnValue(["first", "second", "third"]);

      if (acceptedBeforeReceiptLoss > 0) {
        provider.mockResolvedValueOnce({ messageId: "om-first" });
      }
      provider.mockRejectedValueOnce(
        createChannelPartialDeliveryError(
          new Error("Feishu reply failed: no message_id returned"),
          {
            messageIds: [],
            visibleReplySent: true,
          },
        ),
      );
      const { options } = createDispatcherHarness();
      const text = kind === "card" ? "| first | second |\n| - | - |" : "firstsecondthird";

      const error = await options
        .deliver({ text }, { kind: "final" })
        .catch((caught: unknown) => caught);

      expect(error).toMatchObject({
        code: "CHANNEL_PARTIAL_DELIVERY",
        deliveryResult: {
          content: acceptedBeforeReceiptLoss > 0 ? "firstsecond" : "first",
          messageIds: acceptedBeforeReceiptLoss > 0 ? ["om-first"] : [],
          visibleReplySent: true,
        },
      });
      expect(provider).toHaveBeenCalledTimes(acceptedBeforeReceiptLoss + 1);
    },
  );

  it("retains the finalized streaming card when companion media never dispatches", async () => {
    const marker = Object.assign(
      new Error("media load failed", { cause: new Error("blocked local load") }),
      {
        code: "OPENCLAW_PLATFORM_MESSAGE_NOT_DISPATCHED",
        retryable: true,
      },
    );
    sendMediaFeishuMock.mockRejectedValueOnce(marker);
    const { options } = createDispatcherHarness();

    const error = await options
      .deliver(
        { text: "accepted card", mediaUrl: "https://files.example.test/image.png" },
        { kind: "final" },
      )
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "CHANNEL_PARTIAL_DELIVERY",
      deliveryResult: {
        content: "accepted card",
        messageIds: ["om_stream"],
        visibleReplySent: true,
      },
    });
    expect(requireStreamingInstance(0).closeWithResult).toHaveBeenCalledWith("accepted card", {
      note: "Agent: agent",
    });
  });

  it("preserves an accepted fallback chunk when later recovery fails", async () => {
    const core = getFeishuRuntimeMock();
    core.channel.text.chunkMarkdownTextWithMode.mockReturnValue(["first", "second"]);
    let rejectMedia!: (error: unknown) => void;
    sendMediaFeishuMock.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectMedia = reject;
      }),
    );
    sendStructuredCardFeishuMock
      .mockResolvedValueOnce({ messageId: "om-first-static" })
      .mockRejectedValueOnce(new Error("second fallback failed"));
    const { options } = createDispatcherHarness();
    const deliveryErrorPromise = options
      .deliver(
        { text: "firstsecond", mediaUrl: "https://example.com/image.png" },
        { kind: "final" },
      )
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(sendMediaFeishuMock).toHaveBeenCalledTimes(1));
    requireStreamingInstance(0).closeWithResult.mockResolvedValueOnce({
      visibleReplySent: false,
      messageId: "om-empty-stream",
    });

    rejectMedia(new Error("media failed"));

    await expect(deliveryErrorPromise).resolves.toMatchObject({
      code: "CHANNEL_PARTIAL_DELIVERY",
      deliveryResult: {
        content: "first",
        messageIds: ["om-first-static"],
        visibleReplySent: true,
      },
    });
    expect(sendStructuredCardFeishuMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry degraded-voice fallback as a failed media send", async () => {
    useNonStreamingAutoAccount();
    sendMediaFeishuMock.mockResolvedValueOnce({
      messageId: "om-media",
      voiceIntentDegradedToFile: true,
      receipt: {
        primaryPlatformMessageId: "om-media",
        platformMessageIds: ["om-media"],
        parts: [],
        sentAt: 1,
      },
    });
    sendMessageFeishuMock.mockRejectedValueOnce(new Error("fallback text failed"));
    const { options } = createDispatcherHarness();

    const error = await options
      .deliver(
        { text: "voice caption", mediaUrl: "voice.mp3", audioAsVoice: true },
        { kind: "final" },
      )
      .catch((caught: unknown) => caught);

    expect(sendMediaFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    expect(error).toMatchObject({
      code: "CHANNEL_PARTIAL_DELIVERY",
      deliveryResult: {
        messageIds: ["om-media"],
        visibleReplySent: true,
      },
    });
  });

  it("preserves an accepted text receipt when a later media send fails", async () => {
    useNonStreamingAutoAccount();
    sendMessageFeishuMock.mockResolvedValueOnce({ messageId: "om-text" });
    sendMediaFeishuMock.mockRejectedValueOnce(new Error("media failed"));
    const { options } = createDispatcherHarness();

    const error = await options
      .deliver(
        { text: "accepted caption", mediaUrl: "https://example.com/image.png" },
        { kind: "final" },
      )
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "CHANNEL_PARTIAL_DELIVERY",
      deliveryResult: {
        content: "accepted caption",
        messageIds: ["om-text"],
        visibleReplySent: true,
      },
    });
  });

  it("reports the accepted preview when a final streaming rewrite is rejected", async () => {
    const { result, options } = createDispatcherHarness();
    result.replyOptions.onPartialReply?.({ text: "accepted preview" });
    const delivery = await options.deliver({ text: "rejected final" }, { kind: "final" });
    const instance = requireStreamingInstance(0);
    instance.closeWithResult.mockRejectedValueOnce(
      new FeishuStreamingFinalizationError(new Error("final update failed"), {
        visibleReplySent: true,
        content: "accepted preview",
        messageId: "om-stream",
      }),
    );

    await expect(options.onIdle?.()).rejects.toThrow("final update failed");
    await expect(delivery?.finalization).rejects.toMatchObject({
      code: "CHANNEL_PARTIAL_DELIVERY",
      deliveryResult: {
        content: "accepted preview",
        messageIds: ["om-stream"],
        visibleReplySent: true,
      },
    });
  });

  it("allows recovery after a final rewrite leaves only an earlier preview visible", async () => {
    const { result, options } = createDispatcherHarness();
    result.replyOptions.onPartialReply?.({ text: "accepted preview" });
    const rejectedDelivery = await options.deliver({ text: "final answer" }, { kind: "final" });
    requireStreamingInstance(0).closeWithResult.mockRejectedValueOnce(
      new FeishuStreamingFinalizationError(new Error("final update failed"), {
        visibleReplySent: true,
        content: "accepted preview",
        messageId: "om-preview",
      }),
    );

    await expect(options.onIdle?.()).rejects.toThrow("final update failed");
    await expect(rejectedDelivery?.finalization).rejects.toMatchObject({
      deliveryResult: {
        content: "accepted preview",
        messageIds: ["om-preview"],
        visibleReplySent: true,
      },
    });

    const recoveryDelivery = await options.deliver({ text: "final answer" }, { kind: "final" });
    await expect(recoveryDelivery?.finalization).resolves.toMatchObject({
      content: "final answer",
      visibleReplySent: true,
    });
    expect(streamingInstances).toHaveLength(2);
    expect(requireStreamingInstance(1).closeWithResult).toHaveBeenCalledWith("final answer", {
      note: "Agent: agent",
    });
  });

  it("falls back to a static card when final streaming content was never accepted", async () => {
    sendStructuredCardFeishuMock.mockResolvedValueOnce({ messageId: "om-static" });
    const { options } = createDispatcherHarness();
    const delivery = await options.deliver({ text: "accepted final" }, { kind: "final" });
    requireStreamingInstance(0).closeWithResult.mockRejectedValueOnce(
      new FeishuStreamingFinalizationError(new Error("final update failed"), {
        visibleReplySent: false,
        messageId: "om-empty-stream",
      }),
    );

    await expect(options.onIdle?.()).rejects.toThrow("final update failed");
    await expect(delivery?.finalization).rejects.toMatchObject({
      code: "CHANNEL_PARTIAL_DELIVERY",
      deliveryResult: {
        content: "accepted final",
        messageIds: ["om-static"],
        visibleReplySent: true,
      },
    });
    expect(sendStructuredCardFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({ text: "accepted final" }),
    );

    await options.deliver({ text: "accepted final" }, { kind: "final" });
    await options.onIdle?.();
    expect(sendStructuredCardFeishuMock).toHaveBeenCalledTimes(1);
  });

  it("does not repeat an earlier static fallback when a later fallback fails", async () => {
    sendStructuredCardFeishuMock
      .mockResolvedValueOnce({ messageId: "om-first-static" })
      .mockRejectedValueOnce(new Error("second fallback failed"));
    const { options } = createDispatcherHarness();
    const firstDelivery = await options.deliver({ text: "first final" }, { kind: "final" });
    const secondDelivery = await options.deliver({ text: "second final" }, { kind: "final" });
    requireStreamingInstance(0).closeWithResult.mockResolvedValueOnce({
      visibleReplySent: false,
      messageId: "om-empty-stream",
    });

    await options.onIdle?.();

    await expect(firstDelivery?.finalization).resolves.toMatchObject({
      content: "first final",
      messageIds: ["om-first-static"],
      visibleReplySent: true,
    });
    await expect(secondDelivery?.finalization).rejects.toThrow("second fallback failed");
    expect(sendStructuredCardFeishuMock).toHaveBeenCalledTimes(2);
    expect(
      sendStructuredCardFeishuMock.mock.calls.filter(
        ([request]) => request?.text === "first final",
      ),
    ).toHaveLength(1);
  });

  it("retains an accepted static fallback prefix when a later chunk fails", async () => {
    const core = getFeishuRuntimeMock();
    core.channel.text.chunkMarkdownTextWithMode.mockReturnValue(["first", "second"]);
    sendStructuredCardFeishuMock
      .mockResolvedValueOnce({ messageId: "om-first-static" })
      .mockRejectedValueOnce(new Error("second chunk failed"));
    const { options } = createDispatcherHarness();
    const delivery = await options.deliver({ text: "firstsecond" }, { kind: "final" });
    requireStreamingInstance(0).closeWithResult.mockResolvedValueOnce({
      visibleReplySent: false,
      messageId: "om-empty-stream",
    });

    await options.onIdle?.();

    await expect(delivery?.finalization).rejects.toMatchObject({
      code: "CHANNEL_PARTIAL_DELIVERY",
      deliveryResult: {
        content: "first",
        messageIds: ["om-first-static"],
        visibleReplySent: true,
      },
    });
  });

  it("falls back visibly when a queued idle close loses a concurrent streaming delivery", async () => {
    const { options } = createDispatcherHarness();
    const firstDelivery = await options.deliver({ text: "first" }, { kind: "final" });
    const instance = requireStreamingInstance(0);
    let resolveClose!: (result: StreamingCloseResult) => void;
    const closePromise = new Promise<StreamingCloseResult>((resolve) => {
      resolveClose = resolve;
    });
    instance.closeWithResult.mockReturnValueOnce(closePromise);
    const firstIdle = Promise.resolve(options.onIdle?.());
    await vi.waitFor(() => expect(instance.closeWithResult).toHaveBeenCalledTimes(1));

    const nextDelivery = await options.deliver({ text: "second" }, { kind: "final" });
    instance.active = false;
    resolveClose({ visibleReplySent: true, content: "first", messageId: "om_stream" });

    await firstIdle;
    await expect(firstDelivery?.finalization).resolves.toMatchObject({
      visibleReplySent: true,
    });
    expect(nextDelivery).toMatchObject({
      content: "second",
      visibleReplySent: true,
    });
    expect(sendStructuredCardFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({ text: "second" }),
    );
  });

  it("reuses a closing card for an identical concurrent final", async () => {
    const { options } = createDispatcherHarness();
    const firstDelivery = await options.deliver({ text: "same" }, { kind: "final" });
    const instance = requireStreamingInstance(0);
    let resolveClose!: (result: {
      visibleReplySent: boolean;
      content: string;
      messageId: string;
    }) => void;
    const closePromise = new Promise<{
      visibleReplySent: boolean;
      content: string;
      messageId: string;
    }>((resolve) => {
      resolveClose = resolve;
    });
    instance.closeWithResult.mockReturnValueOnce(closePromise);
    const idle = Promise.resolve(options.onIdle?.());
    await vi.waitFor(() => expect(instance.closeWithResult).toHaveBeenCalledTimes(1));
    instance.active = false;

    const concurrentDelivery = await options.deliver({ text: "same" }, { kind: "final" });
    resolveClose({
      visibleReplySent: true,
      content: "same",
      messageId: "om-same",
    });

    await idle;
    await expect(firstDelivery?.finalization).resolves.toMatchObject({
      content: "same",
      messageIds: ["om-same"],
      visibleReplySent: true,
    });
    await expect(concurrentDelivery?.finalization).resolves.toMatchObject({
      content: "same",
      messageIds: ["om-same"],
      visibleReplySent: true,
    });
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
  });

  it("retains a failed visible close for media-delayed finalization registration", async () => {
    let resolveMedia!: (result: { messageId: string }) => void;
    sendMediaFeishuMock.mockReturnValueOnce(
      new Promise<{ messageId: string }>((resolve) => {
        resolveMedia = resolve;
      }),
    );
    const { options } = createDispatcherHarness();

    const deliveryPromise = options.deliver(
      { text: "accepted card", mediaUrl: "https://example.com/image.png" },
      { kind: "final" },
    );
    await vi.waitFor(() => expect(sendMediaFeishuMock).toHaveBeenCalledTimes(1));
    const instance = requireStreamingInstance(0);
    instance.closeWithResult.mockRejectedValueOnce(
      new FeishuStreamingFinalizationError(new Error("close failed"), {
        visibleReplySent: true,
        content: "accepted card",
        messageId: "om-stream",
      }),
    );

    await expect(options.onIdle?.()).rejects.toThrow("close failed");
    resolveMedia({ messageId: "om-media" });
    const delivery = await deliveryPromise;

    await expect(delivery?.finalization).rejects.toMatchObject({
      code: "CHANNEL_PARTIAL_DELIVERY",
      deliveryResult: {
        content: "accepted card",
        messageIds: ["om-stream", "om-media"],
        visibleReplySent: true,
      },
    });
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
  });

  it("waits for an in-flight close before recovering from companion media failure", async () => {
    let rejectMedia!: (error: unknown) => void;
    sendMediaFeishuMock.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectMedia = reject;
      }),
    );
    const { options } = createDispatcherHarness();
    const deliveryErrorPromise = options
      .deliver(
        { text: "accepted card", mediaUrl: "https://example.com/image.png" },
        { kind: "final" },
      )
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(sendMediaFeishuMock).toHaveBeenCalledTimes(1));

    const instance = requireStreamingInstance(0);
    let resolveClose!: (result: {
      visibleReplySent: boolean;
      content: string;
      messageId: string;
    }) => void;
    instance.closeWithResult.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveClose = resolve;
      }),
    );
    const idle = Promise.resolve(options.onIdle?.());
    await vi.waitFor(() => expect(instance.closeWithResult).toHaveBeenCalledTimes(1));

    rejectMedia(new Error("media failed"));
    await Promise.resolve();
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
    instance.active = false;
    resolveClose({
      visibleReplySent: true,
      content: "accepted card",
      messageId: "om-card",
    });

    await idle;
    await expect(deliveryErrorPromise).resolves.toMatchObject({
      code: "CHANNEL_PARTIAL_DELIVERY",
      deliveryResult: {
        content: "accepted card",
        messageIds: ["om-card"],
        visibleReplySent: true,
      },
    });
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
  });

  it("settles a delivery arriving during an unrelated failed close separately", async () => {
    const { options } = createDispatcherHarness();
    const firstDelivery = await options.deliver({ text: "first" }, { kind: "final" });
    const instance = requireStreamingInstance(0);
    let rejectClose!: (error: unknown) => void;
    instance.closeWithResult.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectClose = reject;
      }),
    );
    const idle = Promise.resolve(options.onIdle?.());
    await vi.waitFor(() => expect(instance.closeWithResult).toHaveBeenCalledTimes(1));

    const lateDelivery = await options.deliver({ text: "second" }, { kind: "final" });
    rejectClose(
      new FeishuStreamingFinalizationError(new Error("close failed"), {
        visibleReplySent: true,
        content: "first",
        messageId: "om-stream",
      }),
    );

    await expect(idle).rejects.toThrow("close failed");
    await expect(firstDelivery?.finalization).rejects.toMatchObject({
      deliveryResult: { content: "first" },
    });
    expect(lateDelivery).toMatchObject({
      content: "second",
      visibleReplySent: true,
    });
    expect(sendStructuredCardFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({ text: "second" }),
    );
  });

  it("preserves and finalizes a replacement streaming session started during close", async () => {
    const core = getFeishuRuntimeMock();
    core.channel.text.resolveTextChunkLimit.mockReturnValue(5);
    core.channel.text.chunkMarkdownTextWithMode.mockImplementation((text: string) => [text]);
    const { options } = createDispatcherHarness();
    const firstDelivery = await options.deliver({ text: "one" }, { kind: "final" });
    const firstInstance = requireStreamingInstance(0);
    let resolveClose!: (result: StreamingCloseResult) => void;
    const closePromise = new Promise<StreamingCloseResult>((resolve) => {
      resolveClose = resolve;
    });
    firstInstance.closeWithResult.mockReturnValueOnce(closePromise);
    const idle = Promise.resolve(options.onIdle?.());
    await vi.waitFor(() => expect(firstInstance.closeWithResult).toHaveBeenCalledTimes(1));
    firstInstance.active = false;

    await options.deliver({ text: "oversized" }, { kind: "final" });
    const replacementDelivery = await options.deliver({ text: "two" }, { kind: "final" });
    expect(streamingInstances).toHaveLength(2);
    resolveClose({ visibleReplySent: true, content: "one", messageId: "om_stream" });

    await idle;
    await expect(firstDelivery?.finalization).resolves.toMatchObject({ content: "one" });
    await expect(replacementDelivery?.finalization).resolves.toMatchObject({ content: "two" });
    expect(requireStreamingInstance(1).closeWithResult).toHaveBeenCalledWith("two", {
      note: "Agent: agent",
    });
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ text: "two" }),
    );
  });

  it("assigns an idle-closed card to its later matching final before media", async () => {
    const { result, options } = createDispatcherHarness();
    await options.onReplyStart?.();
    result.replyOptions.onPartialReply?.({ text: "accepted answer" });
    await options.onIdle?.();
    sendMediaFeishuMock.mockResolvedValueOnce({ messageId: "om-media" });

    const delivery = await options.deliver(
      { text: "accepted answer", mediaUrl: "https://example.com/image.png" },
      { kind: "final" },
    );

    expect(delivery).toMatchObject({
      content: "accepted answer",
      messageIds: ["om_stream", "om-media"],
      visibleReplySent: true,
    });
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
  });

  it("keeps a media-delayed final associated with its own closed streaming session", async () => {
    let resolveMedia!: (result: { messageId: string }) => void;
    sendMediaFeishuMock.mockReturnValueOnce(
      new Promise<{ messageId: string }>((resolve) => {
        resolveMedia = resolve;
      }),
    );
    const { result, options } = createDispatcherHarness();

    const firstDeliveryPromise = options.deliver(
      { text: "first", mediaUrl: "https://example.com/image.png" },
      { kind: "final" },
    );
    await vi.waitFor(() => expect(sendMediaFeishuMock).toHaveBeenCalledTimes(1));
    requireStreamingInstance(0).closeWithResult.mockResolvedValueOnce({
      visibleReplySent: true,
      content: "first",
      messageId: "om-first",
    });
    await options.onIdle?.();

    result.replyOptions.onPartialReply?.({ text: "second" });
    await vi.waitFor(() => expect(streamingInstances).toHaveLength(2));
    const secondInstance = requireStreamingInstance(1);
    let resolveSecondClose!: (result: {
      visibleReplySent: boolean;
      content: string;
      messageId: string;
    }) => void;
    secondInstance.closeWithResult.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSecondClose = resolve;
      }),
    );

    const secondDelivery = await options.deliver({ text: "second" }, { kind: "final" });
    await vi.waitFor(() => expect(secondInstance.closeWithResult).toHaveBeenCalledTimes(1));

    resolveMedia({ messageId: "om-media" });
    const firstDelivery = await firstDeliveryPromise;
    secondInstance.active = false;
    resolveSecondClose({
      visibleReplySent: true,
      content: "second",
      messageId: "om-second",
    });

    await expect(secondDelivery?.finalization).resolves.toMatchObject({
      content: "second",
      messageIds: ["om-second"],
      visibleReplySent: true,
    });
    await expect(firstDelivery?.finalization).resolves.toMatchObject({
      content: "first",
      messageIds: ["om-first", "om-media"],
      visibleReplySent: true,
    });
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
  });

  it("shares one closed streaming settlement with every delayed payload owner", async () => {
    let resolveFirstMedia!: (result: { messageId: string }) => void;
    let resolveSecondMedia!: (result: { messageId: string }) => void;
    let mediaCall = 0;
    sendMediaFeishuMock.mockImplementation(
      () =>
        new Promise<{ messageId: string }>((resolve) => {
          if (mediaCall++ === 0) {
            resolveFirstMedia = resolve;
          } else {
            resolveSecondMedia = resolve;
          }
        }),
    );
    const { options } = createDispatcherHarness();

    const firstDeliveryPromise = options.deliver(
      { text: "first", mediaUrl: "https://example.com/first.png" },
      { kind: "final" },
    );
    await vi.waitFor(() => expect(sendMediaFeishuMock).toHaveBeenCalledTimes(1));
    const secondDeliveryPromise = options.deliver(
      { text: "second", mediaUrl: "https://example.com/second.png" },
      { kind: "final" },
    );
    await vi.waitFor(() => expect(sendMediaFeishuMock).toHaveBeenCalledTimes(2));
    requireStreamingInstance(0).closeWithResult.mockResolvedValueOnce({
      visibleReplySent: true,
      content: "second",
      messageId: "om-shared",
    });
    await options.onIdle?.();

    resolveFirstMedia({ messageId: "om-media-first" });
    const firstDelivery = await firstDeliveryPromise;
    await expect(firstDelivery?.finalization).resolves.toMatchObject({
      content: "first",
      messageIds: ["om-shared", "om-media-first"],
      visibleReplySent: true,
    });

    resolveSecondMedia({ messageId: "om-media-second" });
    const secondDelivery = await secondDeliveryPromise;
    await expect(secondDelivery?.finalization).resolves.toMatchObject({
      content: "second",
      messageIds: ["om-shared", "om-media-second"],
      visibleReplySent: true,
    });
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
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
    expectMockArgFields(sendMediaFeishuMock, "media send params", {
      mediaUrl: "https://example.com/reply.mp3",
      audioAsVoice: true,
    });
    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    expectMockArgFields(sendMessageFeishuMock, "message send params", {
      text: "spoken reply",
    });
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
    expectMockArgFields(sendMediaFeishuMock, "media send params", {
      mediaUrl: "https://example.com/reply.opus?download=1",
    });
  });

  it("preserves captions for regular audio attachments", async () => {
    useNonStreamingAutoAccount();
    const { options } = createDispatcherHarness();
    await options.deliver(
      {
        text: "caption text",
        mediaUrl: "https://example.com/song.mp3",
      },
      { kind: "final" },
    );

    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    expectMockArgFields(sendMessageFeishuMock, "message send params", {
      text: "caption text",
    });
    expect(sendMediaFeishuMock).toHaveBeenCalledTimes(1);
    expectMockArgFields(sendMediaFeishuMock, "media send params", {
      mediaUrl: "https://example.com/song.mp3",
    });
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
    expectMockArgFields(sendMessageFeishuMock, "message send params", {
      text: "spoken reply\n\n📎 https://example.com/reply.mp3",
    });
  });

  it("reports every accepted voice upload fallback in the successful delivery result", async () => {
    sendMediaFeishuMock
      .mockRejectedValueOnce(new Error("first upload failed"))
      .mockRejectedValueOnce(new Error("second upload failed"));
    sendMessageFeishuMock
      .mockResolvedValueOnce({ messageId: "om-first-fallback" })
      .mockResolvedValueOnce({ messageId: "om-second-fallback" });
    const { options } = createDispatcherHarness();

    const delivery = await options.deliver(
      {
        text: "spoken reply",
        mediaUrls: ["https://example.com/first.mp3", "https://example.com/second.mp3"],
        audioAsVoice: true,
      },
      { kind: "final" },
    );

    expect(delivery).toMatchObject({
      messageIds: ["om-first-fallback", "om-second-fallback"],
      visibleReplySent: true,
      content:
        "spoken reply\n\n📎 https://example.com/first.mp3\n\n📎 https://example.com/second.mp3",
    });
    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(2);
  });

  it("retains every accepted voice upload fallback when a later fallback fails", async () => {
    sendMediaFeishuMock
      .mockRejectedValueOnce(new Error("first upload failed"))
      .mockRejectedValueOnce(new Error("second upload failed"))
      .mockRejectedValueOnce(new Error("third upload failed"));
    sendMessageFeishuMock
      .mockResolvedValueOnce({ messageId: "om-first-fallback" })
      .mockResolvedValueOnce({ messageId: "om-second-fallback" })
      .mockRejectedValueOnce(new Error("third fallback failed"));
    const { options } = createDispatcherHarness();

    const error = await options
      .deliver(
        {
          text: "spoken reply",
          mediaUrls: [
            "https://example.com/first.mp3",
            "https://example.com/second.mp3",
            "https://example.com/third.mp3",
          ],
          audioAsVoice: true,
        },
        { kind: "final" },
      )
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "CHANNEL_PARTIAL_DELIVERY",
      deliveryResult: {
        messageIds: ["om-first-fallback", "om-second-fallback"],
        visibleReplySent: true,
        content:
          "spoken reply\n\n📎 https://example.com/first.mp3\n\n📎 https://example.com/second.mp3",
      },
    });
    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(3);
  });

  it("does not leak local media paths in the upload failure fallback", async () => {
    const mediaPath = path.join(os.tmpdir(), "openclaw-feishu-reply-local-voice.mp3");
    sendMediaFeishuMock.mockRejectedValueOnce(new Error("media failed"));

    const { options } = createDispatcherHarness();
    await options.deliver(
      {
        text: "spoken reply",
        mediaUrl: mediaPath,
        audioAsVoice: true,
      },
      { kind: "final" },
    );

    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    const fallbackText = String(firstMockArg(sendMessageFeishuMock, "message send params").text);
    expect(fallbackText).toBe("spoken reply\n\nMedia upload failed. Please try again.");
    expect(fallbackText).not.toContain(mediaPath);
  });

  it.each([{ mediaUrls: [] }, { mediaUrls: ["   "] }])(
    "falls back to legacy mediaUrl when mediaUrls has no usable entries",
    async ({ mediaUrls }) => {
      useNonStreamingAutoAccount();
      const { options } = createDispatcherHarness();
      await options.deliver(
        { text: "caption", mediaUrl: "https://example.com/a.png", mediaUrls },
        { kind: "final" },
      );

      expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
      expect(sendMediaFeishuMock).toHaveBeenCalledTimes(1);
      expectMockArgFields(sendMediaFeishuMock, "media send params", {
        mediaUrl: "https://example.com/a.png",
      });
    },
  );

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
    expect(requireStreamingInstance(0).start).toHaveBeenCalledTimes(1);
    expect(requireStreamingInstance(0).closeWithResult).toHaveBeenCalledTimes(1);
    expect(sendMediaFeishuMock).toHaveBeenCalledTimes(1);
    expectMockArgFields(sendMediaFeishuMock, "media send params", {
      mediaUrl: "https://example.com/a.png",
    });
  });

  it("passes replyInThread to sendMessageFeishu for plain text", async () => {
    useNonStreamingAutoAccount();
    const { options } = createDispatcherHarness({
      replyToMessageId: "om_msg",
      replyInThread: true,
    });
    await options.deliver({ text: "plain text" }, { kind: "final" });

    expectMockArgFields(sendMessageFeishuMock, "message send params", {
      replyToMessageId: "om_msg",
      replyInThread: true,
    });
  });

  it("allows top-level fallback for normal group quoted replies", async () => {
    useNonStreamingAutoAccount();
    const { options } = createDispatcherHarness({
      replyToMessageId: "om_quote_reply",
      replyInThread: true,
      threadReply: true,
      rootId: "om_original_msg",
    });
    await options.deliver(
      { text: "plain text", mediaUrl: "https://example.com/reply.png" },
      { kind: "final" },
    );

    expectMockArgFields(sendMessageFeishuMock, "message send params", {
      replyToMessageId: "om_quote_reply",
      replyInThread: true,
      allowTopLevelReplyFallback: true,
    });
    expectMockArgFields(sendMediaFeishuMock, "media send params", {
      replyToMessageId: "om_quote_reply",
      replyInThread: true,
      allowTopLevelReplyFallback: true,
    });
  });

  it("keeps native topic replies opted out of top-level fallback", async () => {
    useNonStreamingAutoAccount();
    const { options } = createDispatcherHarness({
      replyToMessageId: "om_topic_root",
      replyInThread: true,
      threadReply: true,
      rootId: "om_topic_root",
    });
    await options.deliver(
      { text: "plain text", mediaUrl: "https://example.com/reply.png" },
      { kind: "final" },
    );

    expectMockArgFields(sendMessageFeishuMock, "message send params", {
      replyToMessageId: "om_topic_root",
      replyInThread: true,
      allowTopLevelReplyFallback: false,
    });
    expectMockArgFields(sendMediaFeishuMock, "media send params", {
      replyToMessageId: "om_topic_root",
      replyInThread: true,
      allowTopLevelReplyFallback: false,
    });
  });

  it("passes replyInThread to sendStructuredCardFeishu for card text", async () => {
    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "card",
        streaming: { mode: "off" },
      },
    });

    const { options } = createDispatcherHarness({
      replyToMessageId: "om_msg",
      replyInThread: true,
    });
    await options.deliver({ text: "card text" }, { kind: "final" });

    expectMockArgFields(sendStructuredCardFeishuMock, "structured card params", {
      replyToMessageId: "om_msg",
      replyInThread: true,
    });
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
    const updateCalls = requireStreamingInstance(0).update.mock.calls.map((c: unknown[]) =>
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

    expect(requireStreamingInstance(0).closeWithResult).toHaveBeenCalledTimes(1);
    const closeArg = firstStreamingCloseText();
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
        streaming: { mode: "off" },
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
    expect(requireStreamingInstance(0).closeWithResult).toHaveBeenCalledTimes(1);
    const closeArg = firstStreamingCloseText();
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
    const closeArg = firstStreamingCloseText();
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
    expect(requireStreamingInstance(0).closeWithResult).toHaveBeenCalledTimes(1);

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
    expectStreamingStartOptions(0, {
      replyToMessageId: "om_msg",
      replyInThread: true,
      header: { title: "agent", template: "blue" },
      note: "Agent: agent",
    });
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
    expectStreamingStartOptions(0, {
      replyToMessageId: "om_msg",
      replyInThread: true,
      rootId: "om_root_topic",
    });
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
        streaming: { mode: "partial" },
      },
    });

    const { options } = createDispatcherHarness({
      agentId: "main",
      runtime: createRuntimeLogger(),
    });
    await options.deliver({ text: "streamed card" }, { kind: "final" });
    await options.onIdle?.();

    expectStreamingStartOptions(0, {
      header: undefined,
    });

    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "card",
        streaming: { mode: "off" },
      },
    });

    const { options: staticOptions } = createDispatcherHarness({
      agentId: "main",
      runtime: createRuntimeLogger(),
    });
    await staticOptions.deliver({ text: "static card" }, { kind: "final" });

    expectLastMockArgFields(sendStructuredCardFeishuMock, "structured card params", {
      header: undefined,
    });
  });

  it("shows shared transient tool status on streaming cards but omits it from the final close", async () => {
    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "card",
        streaming: { mode: "partial" },
      },
    });

    const { result, options } = createDispatcherHarness({
      runtime: createRuntimeLogger(),
    });
    await options.onReplyStart?.();
    result.replyOptions.onToolStart?.({ name: "web_search" });
    result.replyOptions.onPartialReply?.({ text: "final answer" });
    await options.onIdle?.();

    const updateTexts = streamingUpdateTexts();
    expect(updateTexts.join("\n")).toContain("🔎 Web Search");
    expect(requireStreamingInstance(0).closeWithResult).toHaveBeenCalledWith("final answer", {
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
        // Raw command text requires the documented commandText opt-in; the
        // default "status" mode renders the tool label only.
        streaming: { mode: "partial", progress: { commandText: "raw" } },
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

    const updateTexts = streamingUpdateTexts();
    expect(updateTexts.join("\n")).toContain("🛠️ run tests, `pnpm test -- --watch=false`");
  });

  it("omits message-like tools from streaming card status", async () => {
    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "card",
        streaming: { mode: "partial" },
      },
    });

    const { result, options } = createDispatcherHarness({
      runtime: createRuntimeLogger(),
    });
    await options.onReplyStart?.();
    result.replyOptions.onToolStart?.({ name: "message" });
    result.replyOptions.onPartialReply?.({ text: "final answer" });
    await options.onIdle?.();

    const updateTexts = streamingUpdateTexts();
    expect(updateTexts.join("\n")).not.toContain("Message");
  });

  it("does not suppress a later final after error closeout", async () => {
    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "card",
        streaming: { mode: "partial" },
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
      Promise.resolve(options.onError?.(new Error("media failed"), { kind: "final" })),
      options.onIdle?.(),
    ]);
    await options.deliver({ text: "Second answer" }, { kind: "final" });
    await options.onIdle?.();

    expect(streamingInstances).toHaveLength(2);
    expect(requireStreamingInstance(0).closeWithResult).toHaveBeenCalledWith("First answer", {
      note: "Agent: agent",
    });
    expect(requireStreamingInstance(1).closeWithResult).toHaveBeenCalledWith("Second answer", {
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
        streaming: { mode: "partial" },
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
    await Promise.resolve(options.onError?.(new Error("media failed"), { kind: "final" }));
    await options.deliver({ text: "Recovered answer" }, { kind: "final" });
    await options.onIdle?.();

    expect(streamingInstances).toHaveLength(3);
    expect(requireStreamingInstance(0).closeWithResult).toHaveBeenCalledWith("First answer", {
      note: "Agent: agent",
    });
    expect(requireStreamingInstance(1).closeWithResult).toHaveBeenCalledWith("Late attachment", {
      note: "Agent: agent",
    });
    expect(requireStreamingInstance(2).closeWithResult).toHaveBeenCalledWith("Recovered answer", {
      note: "Agent: agent",
    });
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
  });

  it("sends a no-visible-reply fallback when no visible output was delivered", async () => {
    const runtime = createRuntimeLogger();
    const { result } = createDispatcherHarness({ runtime });

    await expect(result.ensureNoVisibleReplyFallback("empty-complete")).resolves.toBe(true);

    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    expect(String(firstMockArg(sendMessageFeishuMock, "send message params").text)).toContain(
      "without visible content",
    );
    expect(result.getVisibleReplyState()).toEqual({
      visibleReplySent: true,
      skippedFinalReason: null,
    });
  });

  it("does not send no-visible-reply fallback after an intentional silent final", async () => {
    const runtime = createRuntimeLogger();
    const { result, options } = createDispatcherHarness({ runtime, sessionKey: "main" });

    options.onSkip?.({ text: "NO_REPLY" }, { kind: "final", reason: "silent" });
    await expect(result.ensureNoVisibleReplyFallback("empty-complete")).resolves.toBe(false);

    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(result.getVisibleReplyState()).toEqual({
      visibleReplySent: false,
      skippedFinalReason: "silent",
    });
  });

  it("does not send no-visible-reply fallback after an intentional silent block", async () => {
    const runtime = createRuntimeLogger();
    const { result, options } = createDispatcherHarness({ runtime, sessionKey: "main" });

    options.onSkip?.({ text: "NO_REPLY" }, { kind: "block", reason: "silent" });
    await expect(result.ensureNoVisibleReplyFallback("empty-complete")).resolves.toBe(false);

    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(result.getVisibleReplyState()).toEqual({
      visibleReplySent: false,
      skippedFinalReason: "silent",
    });
  });

  it.each([
    "cancelled_by_reply_payload_sending_hook",
    "empty_after_reply_payload_sending_hook",
    "cancelled_by_message_sending_hook",
    "empty_after_message_sending_hook",
    "channel_transform",
  ] as const)("does not bypass a recorded final %s with a raw fallback", async (reason) => {
    useNonStreamingAutoAccount();
    const { result, options } = createDispatcherHarness();
    const payload = { text: "Intentionally suppressed answer" };
    await options.beforeDeliver?.(payload, { kind: "final" });
    await result.delivery.onDelivered?.(
      payload,
      { kind: "final" },
      {
        visibleReplySent: false,
        suppression: { reason },
      },
    );

    await expect(result.ensureNoVisibleReplyFallback("dispatch-complete")).resolves.toBe(false);
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
  });

  it.each(["no_visible_result", "no_visible_payload", "adapter_returned_no_identity"] as const)(
    "keeps recovery available for an unqualified %s outcome",
    async (reason) => {
      useNonStreamingAutoAccount();
      const { result } = createDispatcherHarness();
      await result.delivery.onDelivered?.(
        { text: "Answer" },
        { kind: "final" },
        {
          visibleReplySent: false,
          suppression: { reason },
        },
      );

      await expect(result.ensureNoVisibleReplyFallback("dispatch-complete")).resolves.toBe(true);
      expect(sendMessageFeishuMock).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { failureKind: "final", cancellationFirst: true, recover: true },
    { failureKind: "final", cancellationFirst: false, recover: true },
    { failureKind: "block", cancellationFirst: false, recover: false },
  ] as const)(
    "preserves recovery=$recover for $failureKind failure with cancellationFirst=$cancellationFirst",
    async ({ failureKind, cancellationFirst, recover }) => {
      useNonStreamingAutoAccount();
      const { result, options } = createDispatcherHarness();
      const cancelFinal = async () => {
        const payload = { text: "Cancelled final" };
        await options.beforeDeliver?.(payload, { kind: "final" });
        await result.delivery.onDelivered?.(
          payload,
          { kind: "final" },
          {
            visibleReplySent: false,
            suppression: { reason: "cancelled_by_message_sending_hook" },
          },
        );
      };
      const failDelivery = async () => {
        await options.beforeDeliver?.({ text: "Failed answer" }, { kind: failureKind });
        await Promise.resolve(options.onError?.(new Error("send rejected"), { kind: failureKind }));
      };
      if (cancellationFirst) {
        await cancelFinal();
        await failDelivery();
      } else {
        await failDelivery();
        await cancelFinal();
      }

      await expect(result.ensureNoVisibleReplyFallback("dispatch-complete")).resolves.toBe(recover);
      expect(sendMessageFeishuMock).toHaveBeenCalledTimes(recover ? 1 : 0);
    },
  );

  it("preserves a newer silent block when an older queued block fails", async () => {
    useNonStreamingBlockAccount();
    const runtime = createRuntimeLogger();
    const { result, options } = createDispatcherHarness({ runtime, sessionKey: "main" });

    options.onSkip?.(
      { text: "NO_REPLY" },
      { kind: "block", reason: "silent", assistantMessageIndex: 2 },
    );
    sendMessageFeishuMock.mockRejectedValueOnce(new Error("send failed"));
    const earlierBlock = { text: "Earlier visible block" };
    await options.beforeDeliver?.(earlierBlock, {
      kind: "block",
      assistantMessageIndex: 1,
    });

    await expect(options.deliver(earlierBlock, { kind: "block" })).rejects.toThrow("send failed");
    await expect(result.ensureNoVisibleReplyFallback("failed-block")).resolves.toBe(false);

    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    expect(result.getVisibleReplyState()).toEqual({
      visibleReplySent: false,
      skippedFinalReason: "silent",
    });
  });

  it("recovers when an unindexed queued block fails after intentional silence", async () => {
    useNonStreamingBlockAccount();
    const runtime = createRuntimeLogger();
    const { result, options } = createDispatcherHarness({ runtime, sessionKey: "main" });

    options.onSkip?.({ text: "NO_REPLY" }, { kind: "block", reason: "silent" });
    sendMessageFeishuMock.mockRejectedValueOnce(new Error("send failed"));

    await options.beforeDeliver?.({ text: "Earlier visible block" }, { kind: "block" });
    await expect(
      options.deliver({ text: "Earlier visible block" }, { kind: "block" }),
    ).rejects.toThrow("send failed");
    await expect(result.ensureNoVisibleReplyFallback("failed-block")).resolves.toBe(true);

    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(2);
    expect(String(sendMessageFeishuMock.mock.calls[1]?.[0]?.text)).toContain(
      "without visible content",
    );
    expect(result.getVisibleReplyState()).toEqual({
      visibleReplySent: true,
      skippedFinalReason: null,
    });
  });

  it("recovers when an indexed block fails after an unindexed silent block", async () => {
    useNonStreamingBlockAccount();
    const runtime = createRuntimeLogger();
    const { result, options } = createDispatcherHarness({ runtime, sessionKey: "main" });

    options.onSkip?.({ text: "NO_REPLY" }, { kind: "block", reason: "silent" });
    const laterBlock = { text: "Later visible block" };
    await options.beforeDeliver?.(laterBlock, {
      kind: "block",
      assistantMessageIndex: 2,
    });
    sendMessageFeishuMock.mockRejectedValueOnce(new Error("send failed"));

    await expect(options.deliver(laterBlock, { kind: "block" })).rejects.toThrow("send failed");
    await expect(result.ensureNoVisibleReplyFallback("failed-block")).resolves.toBe(true);

    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(2);
    expect(String(firstMockArg(sendMessageFeishuMock, "send message params").text)).toBe(
      "Later visible block",
    );
    expect(String(sendMessageFeishuMock.mock.calls[1]?.[0]?.text)).toContain(
      "without visible content",
    );
  });

  it("sends no-visible-reply fallback when a newer block fails after intentional silence", async () => {
    useNonStreamingBlockAccount();
    const runtime = createRuntimeLogger();
    const { result, options } = createDispatcherHarness({ runtime, sessionKey: "main" });

    options.onSkip?.(
      { text: "NO_REPLY" },
      { kind: "block", reason: "silent", assistantMessageIndex: 1 },
    );
    sendMessageFeishuMock.mockRejectedValueOnce(new Error("send failed"));
    const laterBlock = { text: "Later visible block" };
    await options.beforeDeliver?.(laterBlock, {
      kind: "block",
      assistantMessageIndex: 2,
    });

    await expect(options.deliver(laterBlock, { kind: "block" })).rejects.toThrow("send failed");
    await expect(result.ensureNoVisibleReplyFallback("failed-block")).resolves.toBe(true);

    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(2);
    expect(String(firstMockArg(sendMessageFeishuMock, "send message params").text)).toBe(
      "Later visible block",
    );
    expect(String(sendMessageFeishuMock.mock.calls[1]?.[0]?.text)).toContain(
      "without visible content",
    );
    expect(result.getVisibleReplyState()).toEqual({
      visibleReplySent: true,
      skippedFinalReason: null,
    });
  });

  it("preserves block ordering when a before-delivery hook replaces the payload", async () => {
    useNonStreamingBlockAccount();
    const runtime = createRuntimeLogger();
    const { result, options } = createDispatcherHarness({ runtime, sessionKey: "main" });

    options.onSkip?.(
      { text: "NO_REPLY" },
      { kind: "block", reason: "silent", assistantMessageIndex: 1 },
    );
    const originalBlock = { text: "Later visible block" };
    await options.beforeDeliver?.(originalBlock, {
      kind: "block",
      assistantMessageIndex: 2,
    });
    sendMessageFeishuMock.mockRejectedValueOnce(new Error("send failed"));

    await expect(
      options.deliver({ ...originalBlock, text: "Rewritten visible block" }, { kind: "block" }),
    ).rejects.toThrow("send failed");
    await expect(result.ensureNoVisibleReplyFallback("failed-block")).resolves.toBe(true);

    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(2);
    expect(String(firstMockArg(sendMessageFeishuMock, "send message params").text)).toBe(
      "Rewritten visible block",
    );
    expect(String(sendMessageFeishuMock.mock.calls[1]?.[0]?.text)).toContain(
      "without visible content",
    );
  });

  it("sends no-visible-reply fallback when a final fails after an earlier silent skip", async () => {
    useNonStreamingAutoAccount();
    const runtime = createRuntimeLogger();
    const { result, options } = createDispatcherHarness({ runtime, sessionKey: "main" });

    options.onSkip?.({ text: "NO_REPLY" }, { kind: "final", reason: "silent" });
    sendMessageFeishuMock.mockRejectedValueOnce(new Error("send failed"));

    await options.beforeDeliver?.({ text: "Later visible final" }, { kind: "final" });
    await expect(
      options.deliver({ text: "Later visible final" }, { kind: "final" }),
    ).rejects.toThrow("send failed");
    await expect(result.ensureNoVisibleReplyFallback("failed-final")).resolves.toBe(true);

    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(2);
    expect(String(firstMockArg(sendMessageFeishuMock, "send message params").text)).toBe(
      "Later visible final",
    );
    expect(String(sendMessageFeishuMock.mock.calls[1]?.[0]?.text)).toContain(
      "without visible content",
    );
    expect(result.getVisibleReplyState()).toEqual({
      visibleReplySent: true,
      skippedFinalReason: null,
    });
  });

  it("does not send no-visible-reply fallback after visible streaming close", async () => {
    const runtime = createRuntimeLogger();
    const { result, options } = createDispatcherHarness({ runtime });

    await options.deliver({ text: "```md\nvisible answer\n```" }, { kind: "final" });
    await options.onIdle?.();
    await expect(result.ensureNoVisibleReplyFallback("zero-final-count")).resolves.toBe(false);

    expect(streamingInstances).toHaveLength(1);
    expect(requireStreamingInstance(0).closeWithResult).toHaveBeenCalledTimes(1);
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(result.getVisibleReplyState()).toEqual({
      visibleReplySent: true,
      skippedFinalReason: null,
    });
  });

  it("falls back to the accepted final text when streaming close accepts no content", async () => {
    const runtime = createRuntimeLogger();
    const { result, options } = createDispatcherHarness({ runtime });

    await options.deliver({ text: "```md\nvisible answer\n```" }, { kind: "final" });
    requireStreamingInstance(0).closeWithResult = vi.fn(async () => {
      requireStreamingInstance(0).active = false;
      return { visibleReplySent: false, messageId: "om_stream" };
    });

    await options.onIdle?.();
    await expect(result.ensureNoVisibleReplyFallback("zero-final-count")).resolves.toBe(false);

    expect(requireStreamingInstance(0).closeWithResult).toHaveBeenCalledWith(
      "```md\nvisible answer\n```",
      {
        note: "Agent: agent",
      },
    );
    expect(sendStructuredCardFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({ text: "```md\nvisible answer\n```" }),
    );
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(result.getVisibleReplyState()).toEqual({
      visibleReplySent: true,
      skippedFinalReason: null,
    });
  });

  it("waits for pending streaming close before no-visible-reply fallback", async () => {
    const runtime = createRuntimeLogger();
    const { result, options } = createDispatcherHarness({ runtime });

    await options.deliver({ text: "```md\nvisible answer\n```" }, { kind: "final" });

    const streamingSession = requireStreamingInstance(0);
    let releaseClose: () => void = () => {};
    const closeMock = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        releaseClose = resolve;
      });
      streamingSession.active = false;
      return {
        visibleReplySent: true,
        content: "```md\nvisible answer\n```",
        messageId: "om_stream",
      };
    });
    streamingSession.closeWithResult = closeMock;

    const idlePromise = options.onIdle?.();
    const fallbackPromise = result.ensureNoVisibleReplyFallback("zero-final-count");

    for (let attempt = 0; attempt < 20 && closeMock.mock.calls.length === 0; attempt += 1) {
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    }
    expect(closeMock).toHaveBeenCalledTimes(1);
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();

    releaseClose();
    await idlePromise;
    await expect(fallbackPromise).resolves.toBe(false);

    expect(closeMock).toHaveBeenCalledWith("```md\nvisible answer\n```", {
      note: "Agent: agent",
    });
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(result.getVisibleReplyState()).toEqual({
      visibleReplySent: true,
      skippedFinalReason: null,
    });
  });

  it("does not send no-visible-reply fallback after media-only output", async () => {
    const runtime = createRuntimeLogger();
    const { result, options } = createDispatcherHarness({ runtime });

    await options.deliver({ mediaUrl: "https://example.com/a.png" }, { kind: "block" });
    await expect(result.ensureNoVisibleReplyFallback("zero-final-count")).resolves.toBe(false);

    expect(sendMediaFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(result.getVisibleReplyState()).toEqual({
      visibleReplySent: true,
      skippedFinalReason: null,
    });
  });

  it("sends no-visible-reply fallback after an empty card streaming close", async () => {
    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "card",
        streaming: { mode: "partial" },
      },
    });
    const runtime = createRuntimeLogger();
    const { result, options } = createDispatcherHarness({ runtime });

    await options.onReplyStart?.();
    await options.onIdle?.();
    await expect(result.ensureNoVisibleReplyFallback("zero-final-count")).resolves.toBe(true);

    expect(streamingInstances).toHaveLength(1);
    expect(requireStreamingInstance(0).closeWithResult).toHaveBeenCalledWith("", {
      note: "Agent: agent",
    });
    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    expect(result.getVisibleReplyState()).toEqual({
      visibleReplySent: true,
      skippedFinalReason: null,
    });
  });

  it("resets no-visible-reply state on the first reply start", async () => {
    const runtime = createRuntimeLogger();
    const { result, options } = createDispatcherHarness({ runtime });

    options.onSkip?.({ text: "NO_REPLY" }, { kind: "final", reason: "silent" });
    expect(result.getVisibleReplyState()).toEqual({
      visibleReplySent: false,
      skippedFinalReason: "silent",
    });

    await options.onReplyStart?.();

    expect(result.getVisibleReplyState()).toEqual({
      visibleReplySent: false,
      skippedFinalReason: null,
    });
  });

  it("keeps visible reply state across repeated reply-start keepalives", async () => {
    const runtime = createRuntimeLogger();
    const { result, options } = createDispatcherHarness({ runtime });

    await options.onReplyStart?.();
    await options.deliver({ mediaUrl: "https://example.com/a.png" }, { kind: "block" });
    await options.onReplyStart?.();

    await expect(result.ensureNoVisibleReplyFallback("zero-final-count")).resolves.toBe(false);
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(result.getVisibleReplyState()).toEqual({
      visibleReplySent: true,
      skippedFinalReason: null,
    });
  });

  it("cleans streaming state even when close throws", async () => {
    const origPush = streamingInstances.push.bind(streamingInstances);
    streamingInstances.push = (...args: StreamingSessionStub[]) => {
      const firstInstance = args[0];
      if (firstInstance && streamingInstances.length === 0) {
        firstInstance.closeWithResult = vi.fn(async () => {
          firstInstance.active = false;
          throw new Error("close failed");
        });
      }
      return origPush(...args);
    };

    try {
      const { options } = createDispatcherHarness({
        runtime: createRuntimeLogger(),
      });
      const firstDelivery = await options.deliver({ text: "```md\nfirst\n```" }, { kind: "final" });
      const firstFinalization = expect(firstDelivery?.finalization).rejects.toThrow("close failed");
      await expect(options.onIdle?.()).rejects.toThrow("close failed");
      await firstFinalization;
      await options.deliver({ text: "```md\nsecond\n```" }, { kind: "final" });
      await options.onIdle?.();

      expect(streamingInstances).toHaveLength(2);
      expect(requireStreamingInstance(1).closeWithResult).toHaveBeenCalledWith(
        "```md\nsecond\n```",
        {
          note: "Agent: agent",
        },
      );
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

    expectMockArgFields(sendMediaFeishuMock, "media send params", {
      replyToMessageId: "om_msg",
      replyInThread: true,
    });
  });

  it("backs off streaming retries after start() throws (HTTP 400)", async () => {
    const errorMock = vi.fn();
    let shouldFailStart = true;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);

    // Intercept streaming instance creation to make first start() reject
    const origPush = streamingInstances.push.bind(streamingInstances);
    streamingInstances.push = (...args: StreamingSessionStub[]) => {
      const firstInstance = args[0];
      if (shouldFailStart && firstInstance) {
        firstInstance.start = vi
          .fn()
          .mockRejectedValue(new Error("Create card request failed with HTTP 400"));
        shouldFailStart = false;
      }
      return origPush(...args);
    };

    try {
      const result = createFeishuReplyDispatcher({
        cfg: {} as never,
        agentId: "agent",
        runtime: { log: vi.fn(), error: errorMock } as never,
        chatId: "oc_chat",
        sendTarget: "oc_chat",
      });

      const options = toTypingDispatcherOptions(result);

      // First deliver with markdown triggers startStreaming - which will fail
      await options.deliver({ text: "```ts\nconst x = 1\n```" }, { kind: "final" });

      // Wait for the async error to propagate
      await vi.waitFor(() => {
        expect(errorMock.mock.calls.map(([message]) => String(message)).join("\n")).toContain(
          "streaming start failed",
        );
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
      expect(requireStreamingInstance(1).start).toHaveBeenCalled();
      expect(requireStreamingInstance(1).closeWithResult).toHaveBeenCalled();
    } finally {
      streamingInstances.push = origPush;
      nowSpy.mockRestore();
    }
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
