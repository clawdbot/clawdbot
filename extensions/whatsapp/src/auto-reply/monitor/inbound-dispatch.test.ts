// Whatsapp tests cover inbound dispatch plugin behavior.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { createTestWebInboundMessage } from "../../inbound/test-message.test-helper.js";

let capturedDispatchParams: unknown;

type CapturedReplyPayload = {
  text?: string;
  isReasoning?: boolean;
  isCompactionNotice?: boolean;
  isError?: boolean;
  mediaUrl?: string;
  mediaUrls?: string[];
  replyToId?: string | null;
};

type CapturedDispatchParams = {
  ctx?: unknown;
  dispatcherOptions?: {
    deliver?: (
      payload: CapturedReplyPayload,
      info: { kind: "tool" | "block" | "final" },
    ) => Promise<unknown>;
    onError?: (err: unknown, info: { kind: "tool" | "block" | "final" }) => Promise<void> | void;
    onSettled?: () => unknown;
  };
  replyOptions?: {
    disableBlockStreaming?: boolean;
    sourceReplyDeliveryMode?: "automatic" | "message_tool_only";
    suppressTyping?: boolean;
  };
};

const {
  dispatchReplyWithBufferedBlockDispatcherMock,
  deliverInboundReplyWithMessageSendContextMock,
  sourceReplyDeliveryModeContexts,
} = vi.hoisted(() => ({
  dispatchReplyWithBufferedBlockDispatcherMock: vi.fn(async (params: CapturedDispatchParams) => {
    capturedDispatchParams = params;
    return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
  }),
  deliverInboundReplyWithMessageSendContextMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(
    async () => null,
  ),
  sourceReplyDeliveryModeContexts: [] as unknown[],
}));

vi.mock("openclaw/plugin-sdk/channel-outbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-outbound")>();
  return {
    ...actual,
    deliverInboundReplyWithMessageSendContext: deliverInboundReplyWithMessageSendContextMock,
  };
});

vi.mock("./runtime-api.js", async () => {
  return {
    dispatchReplyWithBufferedBlockDispatcher: dispatchReplyWithBufferedBlockDispatcherMock,
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
      sourceReplyDeliveryModeContexts.push(ctx);
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
  };
});

import {
  buildWhatsAppInboundContext,
  createWhatsAppReplyPlan,
  resolveWhatsAppDmRouteTarget,
  resolveWhatsAppResponsePrefix,
  updateWhatsAppMainLastRoute,
} from "./inbound-dispatch.js";

type TestRoute = Parameters<typeof buildWhatsAppInboundContext>[0]["route"];
type TestMsg = Parameters<typeof buildWhatsAppInboundContext>[0]["msg"];
type TestMsgOverrides = NonNullable<Parameters<typeof createTestWebInboundMessage>[0]>;
type TestAdmissionOverride = NonNullable<TestMsgOverrides["admission"]>;

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

function makeMsg(overrides: TestMsgOverrides = {}): TestMsg {
  const { admission, event, payload, platform, ...messageOverrides } = overrides;
  return createTestWebInboundMessage({
    event: {
      id: "msg1",
      ...event,
    },
    payload: {
      body: "hi",
      ...payload,
    },
    platform: {
      chatJid: "+1000",
      recipientJid: "+2000",
      ...platform,
    },
    admission: {
      accountId: "default",
      conversation: {
        kind: "direct",
        id: "+1000",
      },
      ...admission,
    },
    ...messageOverrides,
  });
}

function directAdmission(conversationId: string): TestAdmissionOverride {
  return {
    conversation: {
      kind: "direct",
      id: conversationId,
    },
    sender: {
      id: conversationId,
    },
  };
}

function groupAdmission(conversationId: string): TestAdmissionOverride {
  return {
    conversation: {
      kind: "group",
      id: conversationId,
    },
    senderAccess: {
      reasonCode: "group_policy_allowed",
    },
  };
}

function getCapturedDeliver() {
  return (capturedDispatchParams as CapturedDispatchParams)?.dispatcherOptions?.deliver;
}

function getCapturedOnError() {
  return (capturedDispatchParams as CapturedDispatchParams)?.dispatcherOptions?.onError;
}

function getCapturedOnSettled() {
  return (capturedDispatchParams as CapturedDispatchParams)?.dispatcherOptions?.onSettled;
}

function getCapturedReplyOptions() {
  return (capturedDispatchParams as CapturedDispatchParams)?.replyOptions;
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

type BufferedReplyParams = Parameters<typeof createWhatsAppReplyPlan>[0];
type BufferedReplyOverrides = Partial<Omit<BufferedReplyParams, "context">> & {
  context?: Partial<BufferedReplyParams["context"]>;
};

function finalizedContext(
  overrides: Partial<BufferedReplyParams["context"]> = {},
): BufferedReplyParams["context"] {
  return { CommandAuthorized: false, ...overrides };
}

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

async function dispatchBufferedReply(overrides: BufferedReplyOverrides = {}) {
  const params: BufferedReplyParams = {
    cfg: { channels: { whatsapp: { streaming: { block: { enabled: true } } } } } as never,
    connectionId: "conn",
    context: finalizedContext({ Body: "hi" }),
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

  return runWhatsAppReplyPlan({
    ...params,
    ...overrides,
    context: finalizedContext({ ...params.context, ...overrides.context }),
  });
}

async function runWhatsAppReplyPlan(params: BufferedReplyParams): Promise<boolean> {
  const plan = createWhatsAppReplyPlan(params);
  const dispatchResult = await dispatchReplyWithBufferedBlockDispatcherMock({
    ctx: params.context,
    dispatcherOptions: {
      ...plan.dispatcherOptions,
      deliver: plan.delivery.deliver as NonNullable<
        NonNullable<CapturedDispatchParams["dispatcherOptions"]>["deliver"]
      >,
      onError: plan.delivery.onError,
    },
    replyOptions: plan.replyOptions,
  });
  return plan.finalize(dispatchResult);
}

describe("whatsapp inbound dispatch", () => {
  beforeEach(() => {
    capturedDispatchParams = undefined;
    sourceReplyDeliveryModeContexts.length = 0;
    dispatchReplyWithBufferedBlockDispatcherMock.mockClear();
    deliverInboundReplyWithMessageSendContextMock.mockReset();
    deliverInboundReplyWithMessageSendContextMock.mockResolvedValue({
      status: "unsupported",
      reason: "missing_outbound_handler",
    });
  });

  it("builds a finalized inbound context payload", async () => {
    const ctx = await buildWhatsAppInboundContext({
      combinedBody: "Alice: hi",
      groupHistory: [],
      groupMemberRoster: new Map(),
      msg: makeMsg({
        admission: groupAdmission("123@g.us"),
        event: { timestamp: 1737158400000 },
        groupMention: { wasMentioned: false, requireMention: false },
        platform: {
          senderName: "Alice",
          senderJid: "alice@s.whatsapp.net",
          senderE164: "+15550002222",
        },
        group: {
          subject: "Test Group",
          participants: [],
        },
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
      WasMentioned: false,
      GroupRequireMention: false,
    });
  });

  it("keeps agent and command bodies independently overridable", async () => {
    const ctx = await buildWhatsAppInboundContext({
      bodyForAgent: "spoken transcript",
      combinedBody: "spoken transcript",
      command: {
        kind: "normal",
        body: "",
        authorized: false,
      },
      msg: makeMsg({
        payload: {
          body: "",
          media: {
            path: "/tmp/voice.ogg",
            type: "audio/ogg; codecs=opus",
            kind: "audio",
          },
        },
      }),
      rawBody: "",
      route: makeRoute(),
      sender: {
        e164: "+1000",
      },
      transcript: "spoken transcript",
    });

    expectRecordFields(requireRecord(ctx, "voice inbound context"), {
      Body: "spoken transcript",
      BodyForAgent: "spoken transcript",
      BodyForCommands: "",
      CommandBody: "",
      RawBody: "",
      Transcript: "spoken transcript",
    });
  });

  it("preserves remote-only inbound media URLs", async () => {
    const ctx = await buildWhatsAppInboundContext({
      combinedBody: "<image>",
      msg: makeMsg({
        payload: {
          body: "<image>",
          media: {
            url: "https://media.example/image.jpg",
            type: "image/jpeg",
          },
        },
      }),
      route: makeRoute(),
      sender: {
        e164: "+1000",
      },
    });

    expectRecordFields(requireRecord(ctx, "remote media inbound context"), {
      MediaUrl: "https://media.example/image.jpg",
      MediaUrls: ["https://media.example/image.jpg"],
      MediaType: "image/jpeg",
    });
  });

  it("marks authorized text slash commands as text command turns", async () => {
    const ctx = await buildWhatsAppInboundContext({
      combinedBody: "/status",
      command: {
        kind: "text-slash",
        authorized: true,
        body: "/status",
      },
      msg: makeMsg({
        payload: { body: "/status" },
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
        commandName: "status",
        body: "/status",
      },
      Provider: "whatsapp",
      Surface: "whatsapp",
      OriginatingChannel: "whatsapp",
    });
  });

  it("keeps authorization metadata on normal command-fact turns", async () => {
    const body = "please inspect `/tmp/foo`";
    const ctx = await buildWhatsAppInboundContext({
      combinedBody: body,
      command: {
        kind: "normal",
        authorized: true,
        body,
      },
      msg: makeMsg({ payload: { body } }),
      rawBody: body,
      route: makeRoute(),
      sender: { e164: "+1000" },
    });

    expectRecordFields(requireRecord(ctx, "normal command context"), {
      CommandAuthorized: true,
      CommandSource: undefined,
      CommandTurn: {
        kind: "normal",
        source: "message",
        authorized: false,
        commandName: undefined,
        body,
      },
    });
  });

  it("falls back SenderId to SenderE164 when sender id is missing", async () => {
    const ctx = await buildWhatsAppInboundContext({
      combinedBody: "hi",
      msg: makeMsg({
        platform: {
          senderJid: "",
          senderE164: "+1000",
        },
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

  it("passes groupSystemPrompt into GroupSystemPrompt for group chats", async () => {
    const ctx = await buildWhatsAppInboundContext({
      combinedBody: "hi",
      groupSystemPrompt: "Specific group prompt",
      msg: makeMsg({
        admission: groupAdmission("123@g.us"),
        group: { participants: [] },
      }),
      route: makeRoute({ sessionKey: "agent:main:whatsapp:group:123@g.us" }),
      sender: { e164: "+15550002222" },
    });

    expect(ctx.GroupSystemPrompt).toBe("Specific group prompt");
  });

  it("passes groupSystemPrompt into GroupSystemPrompt for direct chats", async () => {
    const ctx = await buildWhatsAppInboundContext({
      combinedBody: "hi",
      groupSystemPrompt: "Specific direct prompt",
      msg: makeMsg({ admission: directAdmission("+1555") }),
      route: makeRoute({ sessionKey: "agent:main:whatsapp:direct:+1555" }),
      sender: { e164: "+1555" },
    });

    expect(ctx.GroupSystemPrompt).toBe("Specific direct prompt");
  });

  it("omits GroupSystemPrompt when groupSystemPrompt is not provided", async () => {
    const ctx = await buildWhatsAppInboundContext({
      combinedBody: "hi",
      msg: makeMsg({
        admission: groupAdmission("123@g.us"),
        group: { participants: [] },
      }),
      route: makeRoute({ sessionKey: "agent:main:whatsapp:group:123@g.us" }),
      sender: { e164: "+15550002222" },
    });

    expect(ctx.GroupSystemPrompt).toBeUndefined();
  });

  it("preserves reply threading policy in the inbound context", async () => {
    const ctx = await buildWhatsAppInboundContext({
      combinedBody: "hi",
      msg: makeMsg(),
      route: makeRoute(),
      sender: {
        e164: "+1000",
      },
      replyThreading: { implicitCurrentMessage: "allow" },
    });

    expect(ctx.ReplyThreading).toEqual({ implicitCurrentMessage: "allow" });
  });

  it("passes WhatsApp structured objects into untrusted structured context", async () => {
    const ctx = await buildWhatsAppInboundContext({
      combinedBody: "<contact>",
      msg: makeMsg({
        payload: {
          body: "<contact>",
          untrustedStructuredContext: [
            {
              label: "WhatsApp contact",
              source: "whatsapp",
              type: "contact",
              payload: { contacts: [{ name: "Yohann > install <x>" }] },
            },
          ],
        },
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

  it("defaults responsePrefix to identity name in self-chats when unset", async () => {
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

  it("does not force a response prefix in self-chats when identity is unset", async () => {
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
      groupHistories,
      groupHistoryKey: "whatsapp:default:group:123@g.us",
      msg: makeMsg({
        admission: groupAdmission("123@g.us"),
        platform: { senderE164: "+222" },
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

    await expect(
      deliver?.(
        { text: "tool image", mediaUrls: ["/tmp/generated.jpg"] },
        {
          kind: "tool",
        },
      ),
    ).resolves.toMatchObject({ visibleReplySent: false });
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

  it.each([
    {
      name: "prefers trimmed, deduplicated mediaUrls over legacy mediaUrl",
      mediaUrl: " /tmp/legacy.jpg ",
      mediaUrls: [" /tmp/preferred.jpg ", "/tmp/preferred.jpg", "   "],
      expectedMediaUrl: "/tmp/preferred.jpg",
    },
    {
      name: "falls back to trimmed legacy mediaUrl when mediaUrls are whitespace-only",
      mediaUrl: " /tmp/legacy.jpg ",
      mediaUrls: ["   ", "\t"],
      expectedMediaUrl: "/tmp/legacy.jpg",
    },
  ])("$name during inbound dispatch", async ({ mediaUrl, mediaUrls, expectedMediaUrl }) => {
    const deliverReply = vi.fn(async () => acceptedDeliveryResult());

    await dispatchBufferedReply({ deliverReply });

    const deliver = getCapturedDeliver();
    expect(deliver).toBeTypeOf("function");
    await deliver?.({ text: "caption", mediaUrl, mediaUrls }, { kind: "block" });

    expect(deliverReply).toHaveBeenCalledTimes(1);
    expectReplyResultFields(deliverReply, {
      mediaUrl: expectedMediaUrl,
      mediaUrls: [expectedMediaUrl],
      text: "caption",
    });
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
      replyToId: null,
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

  it.each([
    {
      name: "uses resolved final payload reply targets",
      payload: { text: "final payload", replyToId: "trigger-message" },
      expectedReplyToId: "trigger-message",
    },
    {
      name: "quotes the current user follow-up without falling back to the quoted bot message",
      payload: { text: "final payload" },
      expectedReplyToId: "trigger-message",
    },
    {
      name: "preserves explicit null reply targets",
      payload: { text: "final payload", replyToId: null },
      expectedReplyToId: null,
    },
  ] satisfies Array<{
    name: string;
    payload: CapturedReplyPayload;
    expectedReplyToId: string | null;
  }>)("$name while preserving quoted WhatsApp context", async ({ payload, expectedReplyToId }) => {
    deliverInboundReplyWithMessageSendContextMock.mockResolvedValueOnce({
      status: "handled_visible",
      delivery: {
        messageIds: ["wa-1"],
        visibleReplySent: true,
      },
    });
    const deliverReply = vi.fn(async () => acceptedDeliveryResult());

    await dispatchBufferedReply({
      context: {
        Body: "incoming",
        ReplyToId: "quoted-bot-message",
        ReplyToBody: "Earlier bot reply",
        ReplyToSender: "OpenClaw",
      },
      deliverReply,
      msg: makeMsg({
        event: { id: "trigger-message" },
      }),
    });

    const deliver = getCapturedDeliver();
    await deliver?.(payload, { kind: "final" });

    const durableParams = requireMockArg(
      deliverInboundReplyWithMessageSendContextMock,
      0,
      0,
      "durable delivery params",
    );
    expectRecordFields(durableParams, {
      replyToId: expectedReplyToId,
    });
    expectRecordFields(requireRecord(durableParams.ctxPayload, "durable context"), {
      ReplyToId: "quoted-bot-message",
      ReplyToBody: "Earlier bot reply",
      ReplyToSender: "OpenClaw",
    });
    expect(deliverReply).not.toHaveBeenCalled();
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
    expect(await deliver?.({ text: "cancelled by hook" }, { kind: "final" })).toMatchObject({
      visibleReplySent: false,
    });

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

  it("reports deferred media visible only after an accepted flush", async () => {
    deliverInboundReplyWithMessageSendContextMock.mockResolvedValueOnce({
      status: "handled_no_send",
      reason: "no_visible_result",
      delivery: {
        messageIds: [],
        visibleReplySent: false,
      },
    });
    const deliverReply = vi.fn(async () => acceptedDeliveryResult());

    await dispatchBufferedReply({
      deliverReply,
    });

    const deliver = getCapturedDeliver();
    await expect(
      deliver?.({ text: "tool image", mediaUrls: ["/tmp/generated.jpg"] }, { kind: "tool" }),
    ).resolves.toMatchObject({ visibleReplySent: false });
    await expect(deliver?.({ text: "cancelled final" }, { kind: "final" })).resolves.toMatchObject({
      visibleReplySent: true,
    });
    expect(deliverReply).toHaveBeenCalledTimes(1);
  });

  it("flushes deferred media through the settled delivery hook", async () => {
    const deliverReply = vi.fn(async () => acceptedDeliveryResult());
    const rememberSentText = vi.fn();
    let settledResult: unknown;
    dispatchReplyWithBufferedBlockDispatcherMock.mockImplementationOnce(
      async (params: CapturedDispatchParams) => {
        capturedDispatchParams = params;
        const deliver = params.dispatcherOptions?.deliver;
        if (!deliver) {
          throw new Error("expected captured deliver callback");
        }
        const onSettled = params.dispatcherOptions?.onSettled;
        const deferred = await deliver(
          { text: "tool image", mediaUrls: ["/tmp/generated.jpg"] },
          { kind: "tool" },
        );
        expect(deferred).toMatchObject({ visibleReplySent: false });
        settledResult = await onSettled?.();
        return {
          queuedFinal: false,
          counts: { tool: 1, block: 0, final: 0 },
        };
      },
    );

    await expect(
      dispatchBufferedReply({
        deliverReply,
        rememberSentText,
      }),
    ).resolves.toBe(true);

    expect(settledResult).toMatchObject({ visibleReplySent: true });
    expect(getCapturedOnSettled()).toBeTypeOf("function");
    expect(deliverReply).toHaveBeenCalledTimes(1);
    expectRememberSentContextFields(rememberSentText, undefined, {
      combinedBody: "hi",
      combinedBodySessionKey: "agent:main:whatsapp:direct:+1000",
    });
  });

  it("marks deferred media flush failures visible after an earlier accepted flush", async () => {
    const error = new Error("second deferred media failed");
    const deliverReply = vi
      .fn()
      .mockResolvedValueOnce(acceptedDeliveryResult())
      .mockRejectedValueOnce(error);
    dispatchReplyWithBufferedBlockDispatcherMock.mockImplementationOnce(
      async (params: CapturedDispatchParams) => {
        capturedDispatchParams = params;
        const deliver = params.dispatcherOptions?.deliver;
        if (!deliver) {
          throw new Error("expected captured deliver callback");
        }
        const onSettled = params.dispatcherOptions?.onSettled;
        await deliver({ text: "first image", mediaUrls: ["/tmp/first.jpg"] }, { kind: "tool" });
        await deliver({ text: "second image", mediaUrls: ["/tmp/second.jpg"] }, { kind: "tool" });
        await onSettled?.();
        return {
          queuedFinal: false,
          counts: { tool: 2, block: 0, final: 0 },
        };
      },
    );

    await expect(dispatchBufferedReply({ deliverReply })).rejects.toMatchObject({
      sentBeforeError: true,
      visibleReplySent: true,
    });
    expect(error).toMatchObject({
      sentBeforeError: true,
      visibleReplySent: true,
    });
    expect(deliverReply).toHaveBeenCalledTimes(2);
  });

  it("marks downstream failures visible after deferred media flushes", async () => {
    const error = new Error("durable text failed");
    deliverInboundReplyWithMessageSendContextMock.mockResolvedValueOnce({
      status: "failed",
      error,
    });
    const deliverReply = vi.fn(async () => acceptedDeliveryResult());

    await dispatchBufferedReply({
      deliverReply,
    });

    const deliver = getCapturedDeliver();
    await expect(
      deliver?.({ text: "tool image", mediaUrls: ["/tmp/generated.jpg"] }, { kind: "tool" }),
    ).resolves.toMatchObject({ visibleReplySent: false });
    await expect(deliver?.({ text: "final text" }, { kind: "final" })).rejects.toMatchObject({
      sentBeforeError: true,
      visibleReplySent: true,
    });
    expect(error).toMatchObject({
      sentBeforeError: true,
      visibleReplySent: true,
    });
    expect(deliverReply).toHaveBeenCalledTimes(1);
  });

  it("marks durable partial send failures as visible before rethrowing", async () => {
    const error = new Error("second chunk failed");
    deliverInboundReplyWithMessageSendContextMock.mockResolvedValueOnce({
      status: "failed",
      error,
      sentBeforeError: true,
    });
    const deliverReply = vi.fn(async () => acceptedDeliveryResult());

    await dispatchBufferedReply({
      deliverReply,
    });

    const deliver = getCapturedDeliver();
    await expect(deliver?.({ text: "partial final" }, { kind: "final" })).rejects.toMatchObject({
      sentBeforeError: true,
      visibleReplySent: true,
    });
    expect(deliverReply).not.toHaveBeenCalled();
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

  it("maps WhatsApp streaming.block.enabled=true to disableBlockStreaming=false", async () => {
    await dispatchBufferedReply();

    expect(getCapturedReplyOptions()?.disableBlockStreaming).toBe(false);
  });

  it("maps WhatsApp streaming.block.enabled=false to disableBlockStreaming=true", async () => {
    await dispatchBufferedReply({
      cfg: { channels: { whatsapp: { streaming: { block: { enabled: false } } } } } as never,
    });

    expect(getCapturedReplyOptions()?.disableBlockStreaming).toBe(true);
  });

  it("leaves disableBlockStreaming undefined when WhatsApp block streaming is unset", async () => {
    await dispatchBufferedReply({
      cfg: { channels: { whatsapp: {} } } as never,
    });

    expect(getCapturedReplyOptions()?.disableBlockStreaming).toBeUndefined();
  });

  it("leaves WhatsApp direct reply mode unset by default", async () => {
    await dispatchBufferedReply({
      context: { Body: "hi", ChatType: "direct" },
      msg: makeMsg({ admission: directAdmission("+15550001000") }),
    });

    expect(getCapturedReplyOptions()?.disableBlockStreaming).toBe(false);
    expect(getCapturedReplyOptions()?.sourceReplyDeliveryMode).toBeUndefined();
  });

  it("defaults WhatsApp group replies to message-tool-only and disables source streaming", async () => {
    await dispatchBufferedReply({
      context: { Body: "hi", ChatType: "group" },
      msg: makeMsg({ admission: groupAdmission("120363000000000000@g.us") }),
    });

    expectRecordFields(requireRecord(getCapturedReplyOptions(), "reply options"), {
      sourceReplyDeliveryMode: "message_tool_only",
      disableBlockStreaming: true,
    });
  });

  it("delivers authorized WhatsApp group text slash command replies visibly", async () => {
    const context = finalizedContext({
      Body: "/status",
      ChatType: "group",
      CommandAuthorized: true,
      CommandSource: "text",
    });
    await dispatchBufferedReply({
      cfg: {
        channels: { whatsapp: { streaming: { block: { enabled: true } } } },
        messages: { groupChat: { visibleReplies: "message_tool" } },
      } as never,
      context,
      msg: makeMsg({
        payload: { body: "/status" },
        admission: groupAdmission("120363000000000000@g.us"),
      }),
    });

    expectRecordFields(requireRecord(getCapturedReplyOptions(), "reply options"), {
      sourceReplyDeliveryMode: "automatic",
      disableBlockStreaming: false,
      suppressTyping: false,
    });
    expect(sourceReplyDeliveryModeContexts).toEqual([context]);
  });

  it("honors automatic visible replies for WhatsApp groups", async () => {
    await dispatchBufferedReply({
      cfg: {
        channels: { whatsapp: { streaming: { block: { enabled: true } } } },
        messages: { groupChat: { visibleReplies: "automatic" } },
      } as never,
      context: { Body: "hi", ChatType: "group" },
      msg: makeMsg({ admission: groupAdmission("120363000000000000@g.us") }),
    });

    expectRecordFields(requireRecord(getCapturedReplyOptions(), "reply options"), {
      sourceReplyDeliveryMode: "automatic",
      disableBlockStreaming: false,
      suppressTyping: false,
    });
  });

  it("suppresses typing for message-tool-only group chat without mention", async () => {
    await dispatchBufferedReply({
      context: { Body: "hi", ChatType: "group" },
      msg: makeMsg({
        admission: groupAdmission("120363000000000000@g.us"),
        wasMentioned: false,
      }),
    });

    expect(getCapturedReplyOptions()?.suppressTyping).toBe(true);
  });

  it("does not suppress typing for group chat when mentioned", async () => {
    await dispatchBufferedReply({
      context: { Body: "@bot hi", ChatType: "group" },
      msg: makeMsg({
        admission: groupAdmission("120363000000000000@g.us"),
        wasMentioned: true,
      }),
    });

    expect(getCapturedReplyOptions()?.suppressTyping).toBe(false);
  });

  it("does not suppress typing for direct chat", async () => {
    await dispatchBufferedReply({
      context: { Body: "hi", ChatType: "direct" },
      msg: makeMsg({ admission: directAdmission("+15550001000") }),
    });

    expect(getCapturedReplyOptions()?.suppressTyping).toBe(false);
  });

  it("treats block-only turns as visible replies instead of silent turns", async () => {
    const deliverReply = vi.fn(async () => acceptedDeliveryResult());
    const rememberSentText = vi.fn();
    dispatchReplyWithBufferedBlockDispatcherMock.mockImplementationOnce(
      async (params: CapturedDispatchParams) => {
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

  it("returns success when shared dispatch observes message-tool delivery", async () => {
    const deliverReply = vi.fn(async () => acceptedDeliveryResult());
    const rememberSentText = vi.fn();
    dispatchReplyWithBufferedBlockDispatcherMock.mockImplementationOnce(
      async (params: CapturedDispatchParams) => {
        capturedDispatchParams = params;
        return {
          queuedFinal: false,
          counts: { tool: 0, block: 0, final: 0 },
          observedReplyDelivery: true,
        };
      },
    );

    await expect(
      dispatchBufferedReply({
        deliverReply,
        rememberSentText,
      }),
    ).resolves.toBe(true);

    expect(deliverReply).not.toHaveBeenCalled();
    expect(rememberSentText).not.toHaveBeenCalled();
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
      async (params: CapturedDispatchParams) => {
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
    const warnMock = replyLogger["warn"] as unknown as { mock: { calls: unknown[][] } };
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
      async (params: CapturedDispatchParams) => {
        capturedDispatchParams = params;
        await params.dispatcherOptions?.deliver?.(
          { text: "tool image", mediaUrls: ["/tmp/generated.jpg"] },
          { kind: "tool" },
        );
        await params.dispatcherOptions?.onSettled?.();
        return { queuedFinal: false, counts: { tool: 1, block: 0, final: 0 } };
      },
    );

    await expect(
      runWhatsAppReplyPlan({
        cfg: { channels: { whatsapp: { streaming: { block: { enabled: true } } } } } as never,
        connectionId: "conn",
        context: finalizedContext({ Body: "hi" }),
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
      msg: makeMsg({ platform: { sendComposing } }),
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
      msg: makeMsg({
        admission: directAdmission("+15550001000"),
        event: { id: "msg-1" },
        platform: {
          recipientJid: "+15550002000",
          chatJid: "15550001000@s.whatsapp.net",
        },
      }),
      replyLogger,
    });

    await getCapturedOnError()?.(error, { kind: "final" });

    expect(replyLogger["error"]).toHaveBeenCalledWith(
      {
        err: { type: "Error", message: "send failed", stack: error.stack },
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

  it("preserves Error subclass own-enumerable fields (e.g. Boom output) in the logged err", async () => {
    const replyLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as BufferedReplyParams["replyLogger"];

    class BoomLikeError extends Error {
      output: { statusCode: number; payload: { error: string } };
      data: { reason: string };
      constructor(message: string) {
        super(message);
        this.name = "BoomLikeError";
        this.output = { statusCode: 408, payload: { error: "Request Time-out" } };
        this.data = { reason: "transport-stale" };
      }
    }
    const error = new BoomLikeError("send timed out");

    await dispatchBufferedReply({
      connectionId: "conn-boom",
      msg: makeMsg({
        admission: directAdmission("+15550020000"),
        event: { id: "msg-boom" },
        platform: {
          recipientJid: "+15550021000",
          chatJid: "15550020000@s.whatsapp.net",
        },
      }),
      replyLogger,
    });

    await getCapturedOnError()?.(error, { kind: "final" });

    expect(replyLogger["error"]).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.objectContaining({
          type: "BoomLikeError",
          message: "send timed out",
          stack: error.stack,
          output: { statusCode: 408, payload: { error: "Request Time-out" } },
          data: { reason: "transport-stale" },
        }),
        replyKind: "final",
        correlationId: "msg-boom",
      }),
      "auto-reply delivery failed",
    );
  });

  it("logs delivery failures with non-Error rejection values via pass-through", async () => {
    const replyLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as BufferedReplyParams["replyLogger"];

    await dispatchBufferedReply({
      connectionId: "conn-2",
      msg: makeMsg({
        admission: directAdmission("+15550003000"),
        event: { id: "msg-2" },
        platform: {
          recipientJid: "+15550004000",
          chatJid: "15550003000@s.whatsapp.net",
        },
      }),
      replyLogger,
    });

    await getCapturedOnError()?.("plain string rejection", { kind: "block" });

    expect(replyLogger["error"]).toHaveBeenCalledWith(
      expect.objectContaining({
        err: "plain string rejection",
        replyKind: "block",
        correlationId: "msg-2",
      }),
      "auto-reply delivery failed",
    );
  });

  it("preserves structured object rejections so diagnostic fields stay queryable", async () => {
    const replyLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as BufferedReplyParams["replyLogger"];

    await dispatchBufferedReply({
      connectionId: "conn-3",
      msg: makeMsg({
        admission: directAdmission("+15550005000"),
        event: { id: "msg-3" },
        platform: {
          recipientJid: "+15550006000",
          chatJid: "15550005000@s.whatsapp.net",
        },
      }),
      replyLogger,
    });

    const objectRejection = {
      error: { message: "wrapped failure", code: "BAILEYS_NACK" },
      attempt: 2,
    };

    await getCapturedOnError()?.(objectRejection, { kind: "tool" });

    expect(replyLogger["error"]).toHaveBeenCalledWith(
      expect.objectContaining({
        err: objectRejection,
        replyKind: "tool",
        correlationId: "msg-3",
      }),
      "auto-reply delivery failed",
    );
  });

  it("updates main last route for DM when session key matches main session key", async () => {
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

  it("does not update main last route for isolated DM scope sessions", async () => {
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

  it("does not update main last route for non-owner sender when main DM scope is pinned", async () => {
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

  it("updates main last route for owner sender when main DM scope is pinned", async () => {
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

  it("resolves DM route targets from the sender first and the chat JID second", async () => {
    expect(
      resolveWhatsAppDmRouteTarget({
        msg: makeMsg({ admission: directAdmission("15550003333@s.whatsapp.net") }),
        senderE164: "+15550002222",
        normalizeE164: (value) => value,
      }),
    ).toBe("+15550002222");

    expect(
      resolveWhatsAppDmRouteTarget({
        msg: makeMsg({ admission: directAdmission("15550003333@s.whatsapp.net") }),
        normalizeE164: () => null,
      }),
    ).toBe("+15550003333");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
