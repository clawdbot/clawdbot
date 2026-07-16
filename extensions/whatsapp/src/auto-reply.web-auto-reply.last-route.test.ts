import "./test-helpers.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installWebAutoReplyUnitTestHooks, makeSessionStore } from "./auto-reply.test-harness.js";

const updateLastRouteInBackgroundMock = vi.hoisted(() => vi.fn());
let awaitBackgroundTasks: typeof import("./auto-reply/monitor/last-route.js").awaitBackgroundTasks;
let buildMentionConfig: typeof import("./auto-reply/mentions.js").buildMentionConfig;
let createEchoTracker: typeof import("./auto-reply/monitor/echo.js").createEchoTracker;
let createWebOnMessageHandler: typeof import("./auto-reply/monitor/on-message.js").createWebOnMessageHandler;

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
    replyLogger: makeReplyLogger(),
    baseMentionConfig: buildMentionConfig(opts.cfg),
    account: {},
  });

  return { handler, backgroundTasks };
}

function createLastRouteHarness(storePath: string) {
  const replyResolver = vi.fn().mockResolvedValue(undefined);
  const cfg = makeCfg(storePath);
  return createHandlerForTest({ cfg, replyResolver });
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
    reply: vi.fn().mockResolvedValue(undefined),
    sendMedia: vi.fn().mockResolvedValue(undefined),
  };
}

describe("web auto-reply last-route", () => {
  installWebAutoReplyUnitTestHooks();

  beforeEach(async () => {
    vi.resetModules();
    updateLastRouteInBackgroundMock.mockClear();
    ({ awaitBackgroundTasks } = await import("./auto-reply/monitor/last-route.js"));
    ({ buildMentionConfig } = await import("./auto-reply/mentions.js"));
    ({ createEchoTracker } = await import("./auto-reply/monitor/echo.js"));
    ({ createWebOnMessageHandler } = await import("./auto-reply/monitor/on-message.js"));
  });

  it("updates last-route for direct chats without senderE164", async () => {
    const now = Date.now();
    const mainSessionKey = "agent:main:main";
    const store = await makeSessionStore({
      [mainSessionKey]: { sessionId: "sid", updatedAt: now - 1 },
    });

    const { handler, backgroundTasks } = createLastRouteHarness(store.storePath);

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

    expect(updateLastRouteInBackgroundMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "whatsapp",
        to: "+1000",
      }),
    );

    await store.cleanup();
  });

  it("updates last-route for group chats with account id", async () => {
    const now = Date.now();
    const groupSessionKey = "agent:main:whatsapp:group:123@g.us";
    const store = await makeSessionStore({
      [groupSessionKey]: { sessionId: "sid", updatedAt: now - 1 },
    });

    const { handler, backgroundTasks } = createLastRouteHarness(store.storePath);

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

    expect(updateLastRouteInBackgroundMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "whatsapp",
        to: "123@g.us",
        accountId: "work",
      }),
    );

    await store.cleanup();
  });
});
