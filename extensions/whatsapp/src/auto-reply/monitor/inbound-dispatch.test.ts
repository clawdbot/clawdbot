import { describe, expect, it, vi, beforeEach } from "vitest";
import type { WhatsAppSendResult } from "../../inbound/send-result.js";

let capturedDispatchParams: unknown;

type CapturedReplyPayload = {
  text?: string;
  isReasoning?: boolean;
  isCompactionNotice?: boolean;
  isError?: boolean;
  mediaUrl?: string;
  mediaUrls?: string[];
};

const {
  dispatchReplyWithBufferedBlockDispatcherMock,
  deliverInboundReplyWithMessageSendContextMock,
} = vi.hoisted(() => ({
  dispatchReplyWithBufferedBlockDispatcherMock: vi.fn(async (params: { ctx: unknown }) => {
    capturedDispatchParams = params;
    return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
  }),
  deliverInboundReplyWithMessageSendContextMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(
    async () => null,
  ),
}));

vi.mock("openclaw/plugin-sdk/channel-message", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-message")>();
  return {
    ...actual,
    deliverInboundReplyWithMessageSendContext: deliverInboundReplyWithMessageSendContextMock,
  };
});

vi.mock("./runtime-api.js", () => ({
  dispatchReplyWithBufferedBlockDispatcher: dispatchReplyWithBufferedBlockDispatcherMock,
  finalizeInboundContext: <T extends Record<string, unknown>>(ctx: T) => ({
    ...ctx,
    BodyForCommands:
      typeof ctx.CommandBody === "string"
        ? ctx.CommandBody
        : typeof ctx.BodyForAgent === "string"
          ? ctx.BodyForAgent
          : "",
  }),
  getAgentScopedMediaLocalRoots: () => [],
  jidToE164: (value: string) => {
    const phone = value.split("@")[0]?.replace(/[^\d]/g, "");
    return phone ? `+${phone}` : null;
  },
  logVerbose: () => {},
  resolveChannelMessageSourceReplyDeliveryMode: ({
    cfg,
    ctx,
  }: {
    cfg: {
      messages?: {
        visibleReplies?: "automatic" | "message_tool";
        groupChat?: { visibleReplies?: "automatic" | "message_tool" };
      };
    };
    ctx: { ChatType?: string; CommandSource?: "native" | "text"; CommandAuthorized?: boolean };
  }) => {
    if (
      ctx.CommandSource === "native" ||
      (ctx.CommandSource === "text" && ctx.CommandAuthorized === true)
    ) {
      return "automatic";
    }
    if (ctx.ChatType === "group" || ctx.ChatType === "channel") {
      const configuredMode =
        cfg.messages?.groupChat?.visibleReplies ?? cfg.messages?.visibleReplies;
      return configuredMode === "automatic" ? "automatic" : "message_tool_only";
    }
    return cfg.messages?.visibleReplies === "message_tool" ? "message_tool_only" : "automatic";
  },
  resolveChunkMode: () => "length",
  resolveIdentityNamePrefix: (cfg: {
    agents?: { list?: Array<{ id?: string; default?: boolean; identity?: { name?: string } }> };
  }) => {
    const agent = cfg.agents?.list?.find((entry) => entry.default) ?? cfg.agents?.list?.[0];
    const name = agent?.identity?.name?.trim();
    return name ? `[${name}]` : undefined;
  },
  resolveInboundLastRouteSessionKey: (params: { sessionKey: string }) => params.sessionKey,
  resolveMarkdownTableMode: () => undefined,
  resolveSendableOutboundReplyParts: (payload: {
    text?: string;
    mediaUrls?: string[];
    mediaUrl?: string;
  }) => {
    const urls = [
      ...(Array.isArray(payload.mediaUrls) ? payload.mediaUrls : []),
      ...(payload.mediaUrl ? [payload.mediaUrl] : []),
    ];
    return {
      text: payload.text ?? "",
      hasMedia: urls.length > 0,
    };
  },
  resolveTextChunkLimit: () => 4000,
  shouldLogVerbose: () => false,
  toLocationContext: () => ({}),
}));

import {
  buildWhatsAppInboundContext,
  dispatchWhatsAppBufferedReply,
  resolveWhatsAppDmRouteTarget,
  resolveWhatsAppResponsePrefix,
  updateWhatsAppMainLastRoute,
} from "./inbound-dispatch.js";

type TestRoute = Parameters<typeof buildWhatsAppInboundContext>[0]["route"];
type TestMsg = Parameters<typeof buildWhatsAppInboundContext>[0]["msg"];

function acceptedSendResult(kind: "media" | "text", id: string): WhatsAppSendResult {
  return {
    kind,
    messageId: id,
    keys: [{ id }],
    providerAccepted: true,
  };
}

function testReceipt(messageIds: string[]) {
  return {
    ...(messageIds[0] ? { primaryPlatformMessageId: messageIds[0] } : {}),
    platformMessageIds: messageIds,
    parts: messageIds.map((messageId, index) => ({
      platformMessageId: messageId,
      kind: "text" as const,
      index,
    })),
    sentAt: 123,
  };
}

function makeRoute(overrides: Partial<TestRoute> = {}): TestRoute {
  return {
    agentId: "main",
    channel: "whatsapp",
    accountId: "default",
    sessionKey: "agent:main:whatsapp:direct:+1000",
    mainSessionKey: "agent:main:whatsapp:direct:+1000",
    lastRoutePolicy: "main",
    matchedBy: "default",
    ...overrides,
  };
}

function makeMsg(overrides: Partial<TestMsg> = {}): TestMsg {
  return {
    id: "msg1",
    from: "+1000",
    to: "+2000",
    conversationId: "+1000",
    accountId: "default",
    chatId: "+1000",
    chatType: "direct",
    body: "hi",
    sendComposing: async () => {},
    reply: async () => acceptedSendResult("text", "r1"),
    sendMedia: async () => acceptedSendResult("media", "m1"),
    ...overrides,
  };
}

function getCapturedDeliver() {
  return (
    capturedDispatchParams as {
      dispatcherOptions?: {
        deliver?: (
          payload: CapturedReplyPayload,
          info: { kind: "tool" | "block" | "final" },
        ) => Promise<void>;
      };
    }
  )?.dispatcherOptions?.deliver;
}

function getCapturedOnError() {
  return (
    capturedDispatchParams as {
      dispatcherOptions?: {
        onError?: (err: unknown, info: { kind: "tool" | "block" | "final" }) => void;
      };
    }
  )?.dispatcherOptions?.onError;
}

function getCapturedReplyOptions() {
  return (
    capturedDispatchParams as {
      replyOptions?: {
        disableBlockStreaming?: boolean;
        sourceReplyDeliveryMode?: "automatic" | "message_tool_only";
      };
    }
  )?.replyOptions;
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

function requireMockArg(
  mock: { mock: { calls: unknown[][] } },
  callIndex: number,
  argIndex: number,
  label: string,
) {
  return requireRecord(mock.mock.calls[callIndex]?.[argIndex], label);
}

function requireLastMockArg(
  mock: { mock: { calls: unknown[][] } },
  argIndex: number,
  label: string,
) {
  const callIndex = mock.mock.calls.length - 1;
  return requireMockArg(mock, callIndex, argIndex, label);
}

function expectReplyResultFields(
  deliverReply: { mock: { calls: unknown[][] } },
  fields: Record<string, unknown>,
) {
  const params = requireLastMockArg(deliverReply, 0, "deliver reply params");
  expectRecordFields(requireRecord(params.replyResult, "reply result"), fields);
}

function expectRememberSentContextFields(
  rememberSentText: { mock: { calls: unknown[][] } },
  text: unknown,
  fields: Record<string, unknown>,
) {
  const call = rememberSentText.mock.calls.at(-1);
  expect(call?.[0]).toBe(text);
  expectRecordFields(requireRecord(call?.[1], "remember sent context"), fields);
}

type BufferedReplyParams = Parameters<typeof dispatchWhatsAppBufferedReply>[0];

function makeReplyLogger(): BufferedReplyParams["replyLogger"] {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  } as never;
}

function acceptedDeliveryResult() {
  return {
    results: [
      {
        kind: "text" as const,
        messageId: "wa-sent-1",
        keys: [{ id: "wa-sent-1" }],
        providerAccepted: true,
      },
    ],
    receipt: testReceipt(["wa-sent-1"]),
    providerAccepted: true,
  };
}

function unacceptedDeliveryResult() {
  return {
    results: [],
    receipt: testReceipt([]),
    providerAccepted: false,
  };
}

async function dispatchBufferedReply(overrides: Partial<BufferedReplyParams> = {}) {
  const params: BufferedReplyParams = {
    cfg: { channels: { whatsapp: { blockStreaming: true } } } as never,
    connectionId: "conn",
    context: { Body: "hi" },
    conversationId: "+1000",
    deliverReply: async () => acceptedDeliveryResult(),
    groupHistories: new Map(),
    groupHistoryKey: "+1000",
    maxMediaBytes: 1,
    msg: makeMsg(),
    rememberSentText: () => {},
    replyLogger: makeReplyLogger(),
    replyPipeline: {} as never,
    replyResolver: (async () => undefined) as never,
    route: makeRoute(),
    shouldClearGroupHistory: false,
  };

  return dispatchWhatsAppBufferedReply({ ...params, ...overrides });
}

describe("whatsapp inbound dispatch", () => {
  beforeEach(() => {
    capturedDispatchParams = undefined;
    dispatchReplyWithBufferedBlockDispatcherMock.mockClear();
    deliverInboundReplyWithMessageSendContextMock.mockReset();
    deliverInboundReplyWithMessageSendContextMock.mockResolvedValue({
      status: "unsupported",
      reason: "missing_outbound_handler",
    });
  });

  it("builds a finalized inbound context payload", () => {
    const ctx = buildWhatsAppInboundContext({
      combinedBody: "Alice: hi",
      conversationId: "123@g.us",
      groupHistory: [],
      groupMemberRoster: new Map(),
      msg: makeMsg({
        from: "123@g.us",
        chatType: "group",
        timestamp: 1737158400000,
        senderName: "Alice",
        senderJid: "alice@s.whatsapp.net",
        senderE164: "+15550002222",
        groupSubject: "Test Group",
        groupParticipants: [],
      }),
      route: makeRoute({ sessionKey: "agent:main:whatsapp:group:123@g.us" }),
      sender: {
        name: "Alice",
        e164: "+15550002222",
      },
    });

    expectRecordFields(requireRecord(ctx, "inbound context"), {
      Body: "Alice: hi",
      BodyForAgent: "hi",
      BodyForCommands: "hi",
      RawBody: "hi",
      CommandBody: "hi",
      Timestamp: 1737158400000,
      SenderId: "+15550002222",
      SenderE164: "+15550002222",
      OriginatingChannel: "whatsapp",
      OriginatingTo: "123@g.us",
    });
  });

  it("keeps agent and command bodies independently overridable", () => {
    const ctx = buildWhatsAppInboundContext({
      bodyForAgent: "spoken transcript",
      combinedBody: "spoken transcript",
      commandBody: "<media:audio>",
      conversationId: "+1000",
      msg: makeMsg({
        body: "<media:audio>",
        mediaPath: "/tmp/voice.ogg",
        mediaType: "audio/ogg; codecs=opus",
      }),
      rawBody: "<media:audio>",
      route: makeRoute(),
      sender: {
        e164: "+1000",
      },
      transcript: "spoken transcript",
    });

    expectRecordFields(requireRecord(ctx, "voice inbound context"), {
      Body: "spoken transcript",
      BodyForAgent: "spoken transcript",
      BodyForCommands: "<media:audio>",
      CommandBody: "<media:audio>",
      RawBody: "<media:audio>",
      Transcript: "spoken transcript",
    });
  });

  it("marks authorized text slash commands as text command turns", () => {
    const ctx = buildWhatsAppInboundContext({
      combinedBody: "/status",
      commandBody: "/status",
      commandAuthorized: true,
      commandTurn: {
        kind: "text-slash",
        source: "text",
        authorized: true,
        body: "/status",
      },
      conversationId: "+1000",
      msg: makeMsg({
        body: "/status",
      }),
      rawBody: "/status",
      route: makeRoute(),
      sender: {
        e164: "+1000",
      },
    });

    expectRecordFields(requireRecord(ctx, "slash command context"), {
      Body: "/status",
      BodyForAgent: "/status",
      BodyForCommands: "/status",
      CommandBody: "/status",
      RawBody: "/status",
      CommandAuthorized: true,
      CommandSource: "text",
      CommandTurn: {
        kind: "text-slash",
        source: "text",
        authorized: true,
        body: "/status",
      },
      Provider: "whatsapp",
      Surface: "whatsapp",
      OriginatingChannel: "whatsapp",
    });
  });

  it("falls back SenderId to SenderE164 when sender id is missing", () => {
    const ctx = buildWhatsAppInboundContext({
      combinedBody: "hi",
      conversationId: "+1000",
      msg: makeMsg({
        senderJid: "",
        senderE164: "+1000",
      }),
      route: makeRoute(),
      sender: {
        e164: "+1000",
      },
    });

    expect(ctx.SenderId).toBe("+1000");
    expect(ctx.SenderE164).toBe("+1000");
    expect(ctx.To).toBe("+2000");
  });

  it("passes groupSystemPrompt into GroupSystemPrompt for group chats", () => {
    const ctx = buildWhatsAppInboundContext({
      combinedBody: "hi",
      conversationId: "123@g.us",
      groupSystemPrompt: "Specific group prompt",
      msg: makeMsg({ from: "123@g.us", chatType: "group", groupParticipants: [] }),
      route: makeRoute({ sessionKey: "agent:main:whatsapp:group:123@g.us" }),
      sender: { e164: "+15550002222" },
    });

    expect(ctx.GroupSystemPrompt).toBe("Specific group prompt");
  });

  it("passes groupSystemPrompt into GroupSystemPrompt for direct chats", () => {
    const ctx = buildWhatsAppInboundContext({
      combinedBody: "hi",
      conversationId: "+1555",
      groupSystemPrompt: "Specific direct prompt",
      msg: makeMsg({ from: "+1555", chatType: "direct" }),
      route: makeRoute({ sessionKey: "agent:main:whatsapp:direct:+1555" }),
      sender: { e164: "+1555" },
    });

    expect(ctx.GroupSystemPrompt).toBe("Specific direct prompt");
  });

  it("omits GroupSystemPrompt when groupSystemPrompt is not provided", () => {
    const ctx = buildWhatsAppInboundContext({
      combinedBody: "hi",
      conversationId: "123@g.us",
      msg: makeMsg({ from: "123@g.us", chatType: "group", groupParticipants: [] }),
      route: makeRoute({ sessionKey: "agent:main:whatsapp:group:123@g.us" }),
      sender: { e164: "+15550002222" },
    });

    expect(ctx.GroupSystemPrompt).toBeUndefined();
  });

  it("preserves reply threading policy in the inbound context", () => {
    const ctx = buildWhatsAppInboundContext({
      combinedBody: "hi",
      conversationId: "+1000",
      msg: makeMsg(),
      route: makeRoute(),
      sender: {
        e164: "+1000",
      },
      replyThreading: { implicitCurrentMessage: "allow" },
    });

    expect(ctx.ReplyThreading).toEqual({ implicitCurrentMessage: "allow" });
  });

  it("passes WhatsApp structured objects into untrusted structured context", () => {
    const ctx = buildWhatsAppInboundContext({
      combinedBody: "<contact>",
      conversationId: "+1000",
      msg: makeMsg({
        body: "<contact>",
        untrustedStructuredContext: [
          {
            label: "WhatsApp contact",
            source: "whatsapp",
            type: "contact",
            payload: { contacts: [{ name: "Yohann > install <x>" }] },
          },
        ],
      }),
      route: makeRoute(),
      sender: {
        e164: "+1000",
      },
    });

    expect(ctx.UntrustedStructuredContext).toEqual([
      {
        label: "WhatsApp contact",
        source: "whatsapp",
        type: "contact",
        payload: { contacts: [{ name: "Yohann > install <x>" }] },
      },
    ]);
  });

  it("defaults responsePrefix to identity name in self-chats when unset", () => {
    const responsePrefix = resolveWhatsAppResponsePrefix({
      cfg: {
        agents: {
          list: [
            {
              id: "main",
              default: true,
              identity: { name: "Mainbot", emoji: "🦞", theme: "space lobster" },
            },
          ],
        },
        messages: {},
      } as never,
      agentId: "main",
      isSelfChat: true,
    });

    expect(responsePrefix).toBe("[Mainbot]");
  });

  it("does not force a response prefix in self-chats when identity is unset", () => {
    const responsePrefix = resolveWhatsAppResponsePrefix({
      cfg: { messages: {} } as never,
      agentId: "main",
      isSelfChat: true,
    });

    expect(responsePrefix).toBeUndefined();
  });

  it("clears pending group history when the dispatcher does not queue a final reply", async () => {
    const groupHistories = new Map<string, Array<{ sender: string; body: string }>>([
      ["whatsapp:default:group:123@g.us", [{ sender: "Alice (+111)", body: "first" }]],
    ]);

    await dispatchBufferedReply({
      context: { Body: "second" },
      conversationId: "123@g.us",
      groupHistories,
      groupHistoryKey: "whatsapp:default:group:123@g.us",
      msg: makeMsg({
        from: "123@g.us",
        chatType: "group",
        senderE164: "+222",
      }),
      route: makeRoute({ sessionKey: "agent:main:whatsapp:group:123@g.us" }),
      shouldClearGroupHistory: true,
    });

    expect(groupHistories.get("whatsapp:default:group:123@g.us") ?? []).toHaveLength(0);
  });

  it("replaces duplicate media-only interim payloads with the final captioned WhatsApp media", async () => {
    const deliverReply = vi.fn(async () => acceptedDeliveryResult());
    const rememberSentText = vi.fn();

    await dispatchBufferedReply({
      deliverReply,
      rememberSentText,
    });

    const deliver = getCapturedDeliver();
    expect(deliver).toBeTypeOf("function");

    await deliver?.({ text: "tool payload" }, { kind: "tool" });
    expect(deliverReply).not.toHaveBeenCalled();
    expect(rememberSentText).not.toHaveBeenCalled();

    await deliver?.(
      { text: "tool image", mediaUrls: ["/tmp/generated.jpg"] },
      {
        kind: "tool",
      },
    );
    expect(deliverReply).not.toHaveBeenCalled();
    expect(rememberSentText).not.toHaveBeenCalled();

    await deliver?.(
      { text: "generated image", mediaUrls: ["/tmp/generated.jpg"] },
      {
        kind: "block",
      },
    );
    expect(deliverReply).toHaveBeenCalledTimes(1);
    expect(rememberSentText).toHaveBeenCalledTimes(1);
    expectReplyResultFields(deliverReply, {
      mediaUrls: ["/tmp/generated.jpg"],
      text: "generated image",
    });

    await deliver?.({ text: "block payload" }, { kind: "block" });
    await deliver?.({ text: "final payload" }, { kind: "final" });
    expect(deliverReply).toHaveBeenCalledTimes(3);
    expect(rememberSentText).toHaveBeenCalledTimes(3);
  });

  it("queues final WhatsApp payloads through durable outbound delivery", async () => {
    deliverInboundReplyWithMessageSendContextMock.mockResolvedValueOnce({
      status: "handled_visible",
      delivery: {
        messageIds: ["wa-1"],
        visibleReplySent: true,
      },
    });
    const deliverReply = vi.fn(async () => acceptedDeliveryResult());
    const rememberSentText = vi.fn();

    await dispatchBufferedReply({
      context: { Body: "incoming", SessionKey: "agent:main:whatsapp:+15551234567" },
      deliverReply,
      rememberSentText,
      route: makeRoute({
        accountId: "default",
        agentId: "main",
        sessionKey: "agent:main:whatsapp:+15551234567",
      }),
    });

    const deliver = getCapturedDeliver();
    await deliver?.({ text: "final payload" }, { kind: "final" });

    const durableParams = requireMockArg(
      deliverInboundReplyWithMessageSendContextMock,
      0,
      0,
      "durable delivery params",
    );
    expectRecordFields(durableParams, {
      channel: "whatsapp",
      accountId: "default",
      agentId: "main",
      to: "+1000",
      info: { kind: "final" },
    });
    expectRecordFields(requireRecord(durableParams.payload, "durable payload"), {
      text: "final payload",
    });
    expectRecordFields(requireRecord(durableParams.ctxPayload, "durable context"), {
      SessionKey: "agent:main:whatsapp:+15551234567",
    });
    expect(deliverReply).not.toHaveBeenCalled();
    expectRememberSentContextFields(rememberSentText, "final payload", {
      combinedBody: "incoming",
      combinedBodySessionKey: "agent:main:whatsapp:+15551234567",
    });
  });

  it("does not fall back when durable WhatsApp delivery suppresses a send", async () => {
    deliverInboundReplyWithMessageSendContextMock.mockResolvedValueOnce({
      status: "handled_no_send",
      reason: "no_visible_result",
      delivery: {
        messageIds: [],
        visibleReplySent: false,
      },
    });
    const deliverReply = vi.fn(async () => acceptedDeliveryResult());
    const rememberSentText = vi.fn();

    await dispatchBufferedReply({
      deliverReply,
      rememberSentText,
    });

    const deliver = getCapturedDeliver();
    await deliver?.({ text: "cancelled by hook" }, { kind: "final" });

    const durableParams = requireMockArg(
      deliverInboundReplyWithMessageSendContextMock,
      0,
      0,
      "suppressed durable delivery params",
    );
    expectRecordFields(durableParams, {
      channel: "whatsapp",
      info: { kind: "final" },
    });
    expectRecordFields(requireRecord(durableParams.payload, "suppressed payload"), {
      text: "cancelled by hook",
    });
    expect(deliverReply).not.toHaveBeenCalled();
    expect(rememberSentText).not.toHaveBeenCalled();
  });

  it("keeps media replies on the WhatsApp owner delivery path", async () => {
    deliverInboundReplyWithMessageSendContextMock.mockResolvedValueOnce({
      status: "handled_visible",
      delivery: {
        messageIds: ["wa-1"],
        visibleReplySent: true,
      },
    });
    const deliverReply = vi.fn(async () => acceptedDeliveryResult());
    const rememberSentText = vi.fn();

    await dispatchBufferedReply({
      deliverReply,
      rememberSentText,
    });

    const deliver = getCapturedDeliver();
    await deliver?.(
      { text: "generated image", mediaUrls: ["/tmp/generated.jpg"] },
      { kind: "final" },
    );

    expect(deliverInboundReplyWithMessageSendContextMock).not.toHaveBeenCalled();
    expectReplyResultFields(deliverReply, {
      mediaUrls: ["/tmp/generated.jpg"],
      text: "generated image",
    });
    expectRememberSentContextFields(rememberSentText, "generated image", {
      combinedBody: "hi",
      combinedBodySessionKey: "agent:main:whatsapp:direct:+1000",
    });
  });

  it("normalizes WhatsApp payload text before delivery and echo bookkeeping", async () => {
    const deliverReply = vi.fn(async () => acceptedDeliveryResult());
    const rememberSentText = vi.fn();

    await dispatchBufferedReply({
      deliverReply,
      rememberSentText,
    });

    const deliver = getCapturedDeliver();
    expect(deliver).toBeTypeOf("function");

    await deliver?.(
      {
        text: 'Before\n<function_calls><invoke name="web_search"><parameter name="query">x</parameter></invoke></function_calls>\nAfter',
      },
      { kind: "final" },
    );

    expectReplyResultFields(deliverReply, { text: "Before\n\nAfter" });
    expectRememberSentContextFields(rememberSentText, "Before\n\nAfter", {
      combinedBody: "hi",
      combinedBodySessionKey: "agent:main:whatsapp:direct:+1000",
    });
  });

  it("suppresses reasoning and compaction payloads before WhatsApp delivery", async () => {
    const deliverReply = vi.fn(async () => acceptedDeliveryResult());
    const rememberSentText = vi.fn();

    await dispatchBufferedReply({
      deliverReply,
      rememberSentText,
    });

    const deliver = getCapturedDeliver();
    expect(deliver).toBeTypeOf("function");

    await deliver?.({ text: "hidden", isReasoning: true }, { kind: "block" });
    await deliver?.(
      { text: "🧹 Compacting context...", isCompactionNotice: true },
      { kind: "block" },
    );
    expect(deliverReply).not.toHaveBeenCalled();
    expect(rememberSentText).not.toHaveBeenCalled();
  });

  it("suppresses payloads that normalize to no visible WhatsApp content", async () => {
    const deliverReply = vi.fn(async () => acceptedDeliveryResult());
    const rememberSentText = vi.fn();

    await dispatchBufferedReply({
      deliverReply,
      rememberSentText,
    });

    const deliver = getCapturedDeliver();
    expect(deliver).toBeTypeOf("function");

    await deliver?.(
      {
        text: '<function_calls><invoke name="web_search"><parameter name="query">x</parameter></invoke></function_calls>',
      },
      { kind: "final" },
    );

    expect(deliverReply).not.toHaveBeenCalled();
    expect(rememberSentText).not.toHaveBeenCalled();
  });

  it("suppresses error payload text", async () => {
    const deliverReply = vi.fn(async () => acceptedDeliveryResult());
    const rememberSentText = vi.fn();

    await dispatchBufferedReply({ deliverReply, rememberSentText });

    const deliver = getCapturedDeliver();
    expect(deliver).toBeTypeOf("function");

    await deliver?.({ text: "provider exploded", isError: true }, { kind: "final" });

    expect(deliverReply).not.toHaveBeenCalled();
    expect(rememberSentText).not.toHaveBeenCalled();
  });

  it("maps WhatsApp blockStreaming=true to disableBlockStreaming=false", async () => {
    await dispatchBufferedReply();

    expect(getCapturedReplyOptions()?.disableBlockStreaming).toBe(false);
  });

  it("maps WhatsApp blockStreaming=false to disableBlockStreaming=true", async () => {
    await dispatchBufferedReply({
      cfg: { channels: { whatsapp: { blockStreaming: false } } } as never,
    });

    expect(getCapturedReplyOptions()?.disableBlockStreaming).toBe(true);
  });

  it("leaves disableBlockStreaming undefined when WhatsApp blockStreaming is unset", async () => {
    await dispatchBufferedReply({
      cfg: { channels: { whatsapp: {} } } as never,
    });

    expect(getCapturedReplyOptions()?.disableBlockStreaming).toBeUndefined();
  });

  it("leaves WhatsApp direct reply mode unset by default", async () => {
    await dispatchBufferedReply({
      context: { Body: "hi", ChatType: "direct" },
      msg: makeMsg({ from: "+15550001000", chatType: "direct" }),
    });

    expect(getCapturedReplyOptions()?.disableBlockStreaming).toBe(false);
    expect(getCapturedReplyOptions()?.sourceReplyDeliveryMode).toBeUndefined();
  });

  it("defaults WhatsApp group replies to message-tool-only and disables source streaming", async () => {
    await dispatchBufferedReply({
      context: { Body: "hi", ChatType: "group" },
      msg: makeMsg({ from: "120363000000000000@g.us", chatType: "group" }),
    });

    expectRecordFields(requireRecord(getCapturedReplyOptions(), "reply options"), {
      sourceReplyDeliveryMode: "message_tool_only",
      disableBlockStreaming: true,
    });
  });

  it("delivers authorized WhatsApp group text slash command replies visibly", async () => {
    await dispatchBufferedReply({
      cfg: {
        channels: { whatsapp: { blockStreaming: true } },
        messages: { groupChat: { visibleReplies: "message_tool" } },
      } as never,
      context: {
        Body: "/status",
        ChatType: "group",
        CommandAuthorized: true,
        CommandSource: "text",
      },
      msg: makeMsg({
        body: "/status",
        from: "120363000000000000@g.us",
        chatType: "group",
      }),
    });

    expectRecordFields(requireRecord(getCapturedReplyOptions(), "reply options"), {
      sourceReplyDeliveryMode: "automatic",
      disableBlockStreaming: false,
    });
  });

  it("honors automatic visible replies for WhatsApp groups", async () => {
    await dispatchBufferedReply({
      cfg: {
        channels: { whatsapp: { blockStreaming: true } },
        messages: { groupChat: { visibleReplies: "automatic" } },
      } as never,
      context: { Body: "hi", ChatType: "group" },
      msg: makeMsg({ from: "120363000000000000@g.us", chatType: "group" }),
    });

    expectRecordFields(requireRecord(getCapturedReplyOptions(), "reply options"), {
      sourceReplyDeliveryMode: "automatic",
      disableBlockStreaming: false,
    });
  });

  it("treats block-only turns as visible replies instead of silent turns", async () => {
    const deliverReply = vi.fn(async () => acceptedDeliveryResult());
    const rememberSentText = vi.fn();
    dispatchReplyWithBufferedBlockDispatcherMock.mockImplementationOnce(
      async (params: {
        ctx: unknown;
        dispatcherOptions?: {
          deliver?: (
            payload: { text?: string },
            info: { kind: "tool" | "block" | "final" },
          ) => Promise<void>;
        };
      }) => {
        capturedDispatchParams = params;
        await params.dispatcherOptions?.deliver?.({ text: "partial block" }, { kind: "block" });
        return { queuedFinal: false, counts: { tool: 0, block: 1, final: 0 } };
      },
    );

    await expect(
      dispatchBufferedReply({
        deliverReply,
        rememberSentText,
      }),
    ).resolves.toBe(true);

    expect(deliverReply).toHaveBeenCalledTimes(1);
    expect(rememberSentText).toHaveBeenCalledTimes(1);
  });

  it("does not treat generated WhatsApp text as sent when the provider did not accept it", async () => {
    const deliverReply = vi.fn(async () => unacceptedDeliveryResult());
    const rememberSentText = vi.fn();
    const replyLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as BufferedReplyParams["replyLogger"];
    dispatchReplyWithBufferedBlockDispatcherMock.mockImplementationOnce(
      async (params: {
        ctx: unknown;
        dispatcherOptions?: {
          deliver?: (
            payload: { text?: string },
            info: { kind: "tool" | "block" | "final" },
          ) => Promise<void>;
        };
      }) => {
        capturedDispatchParams = params;
        await params.dispatcherOptions?.deliver?.({ text: "final text" }, { kind: "final" });
        return { queuedFinal: false, counts: { tool: 0, block: 0, final: 1 } };
      },
    );

    await expect(
      dispatchBufferedReply({
        deliverReply,
        rememberSentText,
        replyLogger,
      }),
    ).resolves.toBe(false);

    expect(deliverReply).toHaveBeenCalledTimes(1);
    expect(rememberSentText).not.toHaveBeenCalled();
    const warnMock = replyLogger.warn as unknown as { mock: { calls: unknown[][] } };
    const warningContext = requireMockArg(warnMock, 0, 0, "warning context");
    expectRecordFields(warningContext, {
      replyKind: "final",
      conversationId: "+1000",
    });
    expect(warnMock.mock.calls.at(0)?.[1]).toBe("auto-reply was not accepted by WhatsApp provider");
  });

  it("returns true for tool-only media turns after delivering media", async () => {
    const deliverReply = vi.fn(async () => acceptedDeliveryResult());
    const rememberSentText = vi.fn();
    dispatchReplyWithBufferedBlockDispatcherMock.mockImplementationOnce(
      async (params: {
        ctx: unknown;
        dispatcherOptions?: {
          deliver?: (
            payload: CapturedReplyPayload,
            info: { kind: "tool" | "block" | "final" },
          ) => Promise<void>;
        };
      }) => {
        capturedDispatchParams = params;
        await params.dispatcherOptions?.deliver?.(
          { text: "tool image", mediaUrls: ["/tmp/generated.jpg"] },
          { kind: "tool" },
        );
        return { queuedFinal: false, counts: { tool: 1, block: 0, final: 0 } };
      },
    );

    await expect(
      dispatchWhatsAppBufferedReply({
        cfg: { channels: { whatsapp: { blockStreaming: true } } } as never,
        connectionId: "conn",
        context: { Body: "hi" },
        conversationId: "+1000",
        deliverReply,
        groupHistories: new Map(),
        groupHistoryKey: "+1000",
        maxMediaBytes: 1,
        msg: makeMsg(),
        rememberSentText,
        replyLogger: {
          info: () => {},
          warn: () => {},
          error: () => {},
          debug: () => {},
        } as never,
        replyPipeline: {},
        replyResolver: (async () => undefined) as never,
        route: makeRoute(),
        shouldClearGroupHistory: false,
      }),
    ).resolves.toBe(true);

    expect(deliverReply).toHaveBeenCalledTimes(1);
    expectReplyResultFields(deliverReply, {
      mediaUrls: ["/tmp/generated.jpg"],
      text: undefined,
    });
    expectRememberSentContextFields(rememberSentText, undefined, {});
  });

  it("passes sendComposing through as the reply typing callback", async () => {
    const sendComposing = vi.fn(async () => undefined);

    await dispatchBufferedReply({
      msg: makeMsg({ sendComposing }),
    });

    expect(
      (
        capturedDispatchParams as {
          dispatcherOptions?: { onReplyStart?: unknown };
        }
      )?.dispatcherOptions?.onReplyStart,
    ).toBe(sendComposing);
  });

  it("logs delivery failures from the shared dispatcher with WhatsApp context", async () => {
    const replyLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as BufferedReplyParams["replyLogger"];
    const error = new Error("send failed");

    await dispatchBufferedReply({
      connectionId: "conn-1",
      conversationId: "+15550001000",
      msg: makeMsg({
        id: "msg-1",
        from: "+15550001000",
        to: "+15550002000",
        chatId: "15550001000@s.whatsapp.net",
      }),
      replyLogger,
    });

    getCapturedOnError()?.(error, { kind: "final" });

    expect(replyLogger.error).toHaveBeenCalledWith(
      {
        err: error,
        replyKind: "final",
        correlationId: "msg-1",
        connectionId: "conn-1",
        conversationId: "+15550001000",
        chatId: "15550001000@s.whatsapp.net",
        to: "+15550001000",
        from: "+15550002000",
      },
      "auto-reply delivery failed",
    );
  });

  it("updates main last route for DM when session key matches main session key", () => {
    const updateLastRoute = vi.fn();

    updateWhatsAppMainLastRoute({
      backgroundTasks: new Set(),
      cfg: {} as never,
      ctx: { Body: "hello" },
      dmRouteTarget: "+1000",
      pinnedMainDmRecipient: null,
      route: makeRoute(),
      updateLastRoute,
      warn: () => {},
    });

    expect(updateLastRoute).toHaveBeenCalledTimes(1);
  });

  it("does not update main last route for isolated DM scope sessions", () => {
    const updateLastRoute = vi.fn();

    updateWhatsAppMainLastRoute({
      backgroundTasks: new Set(),
      cfg: {} as never,
      ctx: { Body: "hello" },
      dmRouteTarget: "+3000",
      pinnedMainDmRecipient: null,
      route: makeRoute({
        sessionKey: "agent:main:whatsapp:dm:+1000:peer:+3000",
        mainSessionKey: "agent:main:whatsapp:direct:+1000",
      }),
      updateLastRoute,
      warn: () => {},
    });

    expect(updateLastRoute).not.toHaveBeenCalled();
  });

  it("does not update main last route for non-owner sender when main DM scope is pinned", () => {
    const updateLastRoute = vi.fn();

    updateWhatsAppMainLastRoute({
      backgroundTasks: new Set(),
      cfg: {} as never,
      ctx: { Body: "hello" },
      dmRouteTarget: "+3000",
      pinnedMainDmRecipient: "+1000",
      route: makeRoute({
        sessionKey: "agent:main:main",
        mainSessionKey: "agent:main:main",
      }),
      updateLastRoute,
      warn: () => {},
    });

    expect(updateLastRoute).not.toHaveBeenCalled();
  });

  it("updates main last route for owner sender when main DM scope is pinned", () => {
    const updateLastRoute = vi.fn();

    updateWhatsAppMainLastRoute({
      backgroundTasks: new Set(),
      cfg: {} as never,
      ctx: { Body: "hello" },
      dmRouteTarget: "+1000",
      pinnedMainDmRecipient: "+1000",
      route: makeRoute({
        sessionKey: "agent:main:main",
        mainSessionKey: "agent:main:main",
      }),
      updateLastRoute,
      warn: () => {},
    });

    expect(updateLastRoute).toHaveBeenCalledTimes(1);
  });

  it("resolves DM route targets from the sender first and the chat JID second", () => {
    expect(
      resolveWhatsAppDmRouteTarget({
        msg: makeMsg({ from: "15550003333@s.whatsapp.net" }),
        senderE164: "+15550002222",
        normalizeE164: (value) => value,
      }),
    ).toBe("+15550002222");

    expect(
      resolveWhatsAppDmRouteTarget({
        msg: makeMsg({ from: "15550003333@s.whatsapp.net" }),
        normalizeE164: () => null,
      }),
    ).toBe("+15550003333");
  });
});
