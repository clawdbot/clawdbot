import "./test-helpers.js";
import { formatInboundEnvelope } from "openclaw/plugin-sdk/channel-envelope";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAcceptedWhatsAppSendResult,
  installWebAutoReplyUnitTestHooks,
  makeSessionStore,
} from "./auto-reply.test-harness.js";
import { buildMentionConfig } from "./auto-reply/mentions.js";
import { createEchoTracker } from "./auto-reply/monitor/echo.js";
import { awaitBackgroundTasks } from "./auto-reply/monitor/last-route.js";
import { createWebOnMessageHandler } from "./auto-reply/monitor/on-message.js";

const updateLastRouteInBackgroundMock = vi.hoisted(() => vi.fn());

vi.mock("./auto-reply/monitor/last-route.js", async () => {
  const actual = await vi.importActual<typeof import("./auto-reply/monitor/last-route.js")>(
    "./auto-reply/monitor/last-route.js",
  );
  return {
    ...actual,
    updateLastRouteInBackground: (...args: unknown[]) => updateLastRouteInBackgroundMock(...args),
  };
});

function makeCfg(storePath: string): OpenClawConfig {
  return {
    channels: { whatsapp: { allowFrom: ["*"] } },
    session: { store: storePath },
  };
}

function makeReplyLogger() {
  return {
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  } as unknown as Parameters<typeof createWebOnMessageHandler>[0]["replyLogger"];
}

function createHandlerForTest(opts: { cfg: OpenClawConfig; replyResolver: unknown }) {
  const backgroundTasks = new Set<Promise<unknown>>();
  const replyLogger = makeReplyLogger();
  const handler = createWebOnMessageHandler({
    cfg: opts.cfg,
    verbose: false,
    connectionId: "test",
    maxMediaBytes: 1024,
    groupHistoryLimit: 3,
    groupHistories: new Map(),
    groupMemberNames: new Map(),
    echoTracker: createEchoTracker({ maxItems: 10 }),
    backgroundTasks,
    replyResolver: opts.replyResolver as Parameters<
      typeof createWebOnMessageHandler
    >[0]["replyResolver"],
    replyLogger,
    baseMentionConfig: buildMentionConfig(opts.cfg),
    account: {},
  });

  return { handler, backgroundTasks };
}

function buildInboundMessage(params: {
  id: string;
  from: string;
  conversationId: string;
  chatType: "direct" | "group";
  chatId: string;
  timestamp: number;
  body?: string;
  to?: string;
  accountId?: string;
  senderE164?: string;
  senderName?: string;
  selfE164?: string;
}) {
  return {
    id: params.id,
    from: params.from,
    conversationId: params.conversationId,
    to: params.to ?? "+2000",
    body: params.body ?? "hello",
    timestamp: params.timestamp,
    chatType: params.chatType,
    chatId: params.chatId,
    accountId: params.accountId ?? "default",
    senderE164: params.senderE164,
    senderName: params.senderName,
    selfE164: params.selfE164,
    sendComposing: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(createAcceptedWhatsAppSendResult("text", "r1")),
    sendMedia: vi.fn().mockResolvedValue(createAcceptedWhatsAppSendResult("media", "m1")),
  };
}

describe("web auto-reply last-route", () => {
  installWebAutoReplyUnitTestHooks();

  beforeEach(() => {
    updateLastRouteInBackgroundMock.mockClear();
  });

  it("updates last-route for direct chats without senderE164", async () => {
    const now = Date.now();
    const mainSessionKey = "agent:main:main";
    const store = await makeSessionStore({
      [mainSessionKey]: { sessionId: "sid", updatedAt: now - 1 },
    });

    const cfg = makeCfg(store.storePath);
    const { handler, backgroundTasks } = createHandlerForTest({
      cfg,
      replyResolver: vi.fn().mockResolvedValue(undefined),
    });

    await handler(
      buildInboundMessage({
        id: "m1",
        from: "+1000",
        conversationId: "+1000",
        chatType: "direct",
        chatId: "direct:+1000",
        timestamp: now,
      }),
    );

    await awaitBackgroundTasks(backgroundTasks);

    expect(updateLastRouteInBackgroundMock).toHaveBeenCalledTimes(1);
    const updateParams = updateLastRouteInBackgroundMock.mock.calls.at(0)?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(updateParams?.cfg).toBe(cfg);
    expect(updateParams?.backgroundTasks).toBe(backgroundTasks);
    expect(updateParams?.warn).toBeTypeOf("function");
    const {
      cfg: _cfg,
      backgroundTasks: _backgroundTasks,
      warn: _warn,
      ctx,
      ...routeParams
    } = updateParams ?? {};
    expect(routeParams).toEqual({
      storeAgentId: "main",
      sessionKey: mainSessionKey,
      channel: "whatsapp",
      to: "+1000",
      accountId: "default",
    });
    const body = formatInboundEnvelope({
      channel: "WhatsApp",
      from: "+1000",
      timestamp: now,
      body: "hello",
      chatType: "direct",
      sender: {
        e164: "+1000",
        id: "+1000",
      },
    });
    expect(ctx).toEqual({
      From: "+1000",
      To: "+2000",
      SessionKey: mainSessionKey,
      AccountId: "default",
      ChatType: "direct",
      CommandAuthorized: undefined,
      ConversationLabel: "+1000",
      CommandSource: undefined,
      CommandTurn: {
        authorized: false,
        body: "hello",
        kind: "normal",
        source: "message",
      },
      GroupMembers: "+1000",
      GroupSubject: undefined,
      GroupSystemPrompt: undefined,
      InboundHistory: undefined,
      MediaPath: undefined,
      MediaTranscribedIndexes: undefined,
      MediaType: undefined,
      MediaUrl: undefined,
      MessageSid: "m1",
      Provider: "whatsapp",
      Surface: "whatsapp",
      OriginatingChannel: "whatsapp",
      OriginatingTo: "+1000",
      ReplyThreading: undefined,
      ReplyToBody: undefined,
      ReplyToId: undefined,
      ReplyToSender: undefined,
      SenderE164: "+1000",
      SenderId: "+1000",
      SenderName: undefined,
      Transcript: undefined,
      UntrustedStructuredContext: undefined,
      WasMentioned: undefined,
      RawBody: "hello",
      Body: body,
      BodyForAgent: "hello",
      CommandBody: "hello",
      Timestamp: now,
    });

    await store.cleanup();
  });

  it("updates last-route for group chats with account id", async () => {
    const now = Date.now();
    const groupSessionKey = "agent:main:whatsapp:group:123@g.us";
    const store = await makeSessionStore({
      [groupSessionKey]: { sessionId: "sid", updatedAt: now - 1 },
    });

    const cfg = makeCfg(store.storePath);
    const { handler, backgroundTasks } = createHandlerForTest({
      cfg,
      replyResolver: vi.fn().mockResolvedValue(undefined),
    });

    await handler(
      buildInboundMessage({
        id: "g1",
        from: "123@g.us",
        conversationId: "123@g.us",
        chatType: "group",
        chatId: "123@g.us",
        timestamp: now,
        accountId: "work",
        senderE164: "+1000",
        senderName: "Alice",
        selfE164: "+2000",
      }),
    );

    await awaitBackgroundTasks(backgroundTasks);

    expect(updateLastRouteInBackgroundMock).toHaveBeenCalledTimes(1);
    const updateParams = updateLastRouteInBackgroundMock.mock.calls.at(0)?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(updateParams?.cfg).toBe(cfg);
    expect(updateParams?.backgroundTasks).toBe(backgroundTasks);
    expect(updateParams?.warn).toBeTypeOf("function");
    const {
      cfg: _cfg,
      backgroundTasks: _backgroundTasks,
      warn: _warn,
      ctx,
      ...routeParams
    } = updateParams ?? {};
    expect(routeParams).toEqual({
      storeAgentId: "main",
      sessionKey: `${groupSessionKey}:thread:whatsapp-account-work`,
      channel: "whatsapp",
      to: "123@g.us",
      accountId: "work",
    });
    expect(ctx).toEqual({
      From: "123@g.us",
      To: "+2000",
      SessionKey: `${groupSessionKey}:thread:whatsapp-account-work`,
      AccountId: "work",
      ChatType: "group",
      ConversationLabel: "123@g.us",
      GroupSubject: undefined,
      SenderName: "Alice",
      SenderId: "+1000",
      SenderE164: "+1000",
      Provider: "whatsapp",
      Surface: "whatsapp",
      OriginatingChannel: "whatsapp",
      OriginatingTo: "123@g.us",
    });

    await store.cleanup();
  });
});
