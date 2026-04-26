import { describe, expect, it, vi, beforeEach } from "vitest";

let capturedDispatchParams: unknown;

type CapturedReplyPayload = {
  text?: string;
  isReasoning?: boolean;
  isCompactionNotice?: boolean;
  mediaUrl?: string;
  mediaUrls?: string[];
};

const { dispatchReplyWithBufferedBlockDispatcherMock } = vi.hoisted(() => ({
  dispatchReplyWithBufferedBlockDispatcherMock: vi.fn(async (params: { ctx: unknown }) => {
    capturedDispatchParams = params;
    return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
  }),
}));

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
    reply: async () => {},
    sendMedia: async () => {},
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

type BufferedReplyParams = Parameters<typeof dispatchWhatsAppBufferedReply>[0];

function makeReplyLogger(): BufferedReplyParams["replyLogger"] {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  } as never;
}

async function dispatchBufferedReply(overrides: Partial<BufferedReplyParams> = {}) {
  const params: BufferedReplyParams = {
    cfg: { channels: { whatsapp: { blockStreaming: true } } } as never,
    connectionId: "conn",
    context: { Body: "hi" },
    conversationId: "+1000",
    deliverReply: async () => {},
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

    expect(ctx).toMatchObject({
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

    expect(ctx).toMatchObject({
      Body: "spoken transcript",
      BodyForAgent: "spoken transcript",
      BodyForCommands: "<media:audio>",
      CommandBody: "<media:audio>",
      RawBody: "<media:audio>",
      Transcript: "spoken transcript",
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

  it("delivers block and final WhatsApp payloads; suppresses text-only tool payloads but delivers media", async () => {
    const deliverReply = vi.fn(async () => undefined);
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
    expect(deliverReply).toHaveBeenCalledTimes(1);
    expect(rememberSentText).toHaveBeenCalledTimes(1);
    expect(deliverReply).toHaveBeenLastCalledWith(
      expect.objectContaining({
        replyResult: expect.objectContaining({
          mediaUrls: ["/tmp/generated.jpg"],
          text: undefined,
        }),
      }),
    );

    await deliver?.(
      { text: "generated image", mediaUrls: ["/tmp/generated.jpg"] },
      {
        kind: "block",
      },
    );
    expect(deliverReply).toHaveBeenCalledTimes(2);
    expect(rememberSentText).toHaveBeenCalledTimes(2);
    expect(deliverReply).toHaveBeenLastCalledWith(
      expect.objectContaining({
        replyResult: expect.objectContaining({
          mediaUrls: ["/tmp/generated.jpg"],
          text: "generated image",
        }),
      }),
    );

    await deliver?.({ text: "block payload" }, { kind: "block" });
    await deliver?.({ text: "final payload" }, { kind: "final" });
    expect(deliverReply).toHaveBeenCalledTimes(4);
    expect(rememberSentText).toHaveBeenCalledTimes(4);
  });

  it("suppresses reasoning and compaction payloads before WhatsApp delivery", async () => {
    const deliverReply = vi.fn(async () => undefined);
    const rememberSentText = vi.fn();

    await dispatchBufferedReply({
      deliverReply,
      rememberSentText,
    });

    const deliver = getCapturedDeliver();
    expect(deliver).toBeTypeOf("function");

    await deliver?.({ text: "Reasoning:\n_hidden_", isReasoning: true }, { kind: "block" });
    await deliver?.(
      { text: "🧹 Compacting context...", isCompactionNotice: true },
      { kind: "block" },
    );
    expect(deliverReply).not.toHaveBeenCalled();
    expect(rememberSentText).not.toHaveBeenCalled();
  });

  it("maps WhatsApp blockStreaming=true to disableBlockStreaming=false", async () => {
    await dispatchBufferedReply();

    expect(
      (
        capturedDispatchParams as {
          replyOptions?: { disableBlockStreaming?: boolean };
        }
      )?.replyOptions?.disableBlockStreaming,
    ).toBe(false);
  });

  it("maps WhatsApp blockStreaming=false to disableBlockStreaming=true", async () => {
    await dispatchBufferedReply({
      cfg: { channels: { whatsapp: { blockStreaming: false } } } as never,
    });

    expect(
      (
        capturedDispatchParams as {
          replyOptions?: { disableBlockStreaming?: boolean };
        }
      )?.replyOptions?.disableBlockStreaming,
    ).toBe(true);
  });

  it("leaves disableBlockStreaming undefined when WhatsApp blockStreaming is unset", async () => {
    await dispatchBufferedReply({
      cfg: { channels: { whatsapp: {} } } as never,
    });

    expect(
      (
        capturedDispatchParams as {
          replyOptions?: { disableBlockStreaming?: boolean };
        }
      )?.replyOptions?.disableBlockStreaming,
    ).toBeUndefined();
  });

  it("treats block-only turns as visible replies instead of silent turns", async () => {
    const deliverReply = vi.fn(async () => undefined);
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

  it("returns true for tool-only media turns after delivering media", async () => {
    const deliverReply = vi.fn(async () => undefined);
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
    expect(deliverReply).toHaveBeenCalledWith(
      expect.objectContaining({
        replyResult: expect.objectContaining({
          mediaUrls: ["/tmp/generated.jpg"],
          text: undefined,
        }),
      }),
    );
    expect(rememberSentText).toHaveBeenCalledWith(undefined, expect.any(Object));
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
