import { beforeEach, describe, expect, it, vi } from "vitest";
import { telegramRouteTestSessionRuntime } from "./bot-message-context.route-test-support.js";
import { buildTelegramMessageContextForTest } from "./bot-message-context.test-harness.js";

const recordInboundSessionMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const resolveTelegramConversationRouteMock = vi.hoisted(() => vi.fn());
type TelegramTestSessionRuntime = NonNullable<
  import("./bot-message-context.types.js").BuildTelegramMessageContextParams["sessionRuntime"]
>;
const recordInboundSessionForThreadBindingTest: NonNullable<
  TelegramTestSessionRuntime["recordInboundSession"]
> = async (params) => {
  await recordInboundSessionMock(params);
};

vi.mock("./conversation-route.js", async () => {
  const actual =
    await vi.importActual<typeof import("./conversation-route.js")>("./conversation-route.js");
  return {
    ...actual,
    resolveTelegramConversationRoute: (...args: unknown[]) =>
      resolveTelegramConversationRouteMock(...args),
  };
});

const threadBindingSessionRuntime = {
  ...telegramRouteTestSessionRuntime,
  recordInboundSession: recordInboundSessionForThreadBindingTest,
} satisfies TelegramTestSessionRuntime;

function createBoundRoute(params: { accountId: string; sessionKey: string; agentId: string }) {
  return {
    configuredBinding: null,
    configuredBindingSessionKey: "",
    route: {
      accountId: params.accountId,
      agentId: params.agentId,
      channel: "telegram",
      sessionKey: params.sessionKey,
      mainSessionKey: `agent:${params.agentId}:main`,
      matchedBy: "binding.channel",
      lastRoutePolicy: "bound",
    },
  } as const;
}

function createForumTopicMessage() {
  return {
    message_id: 1,
    chat: { id: -100200300, type: "supergroup", is_forum: true },
    message_thread_id: 77,
    date: 1_700_000_000,
    text: "hello",
    from: { id: 42, first_name: "Alice" },
  } as const;
}

async function buildForumTopicMessageContext(accountId?: string) {
  return await buildTelegramMessageContextForTest({
    ...(accountId ? { accountId } : {}),
    sessionRuntime: threadBindingSessionRuntime,
    message: createForumTopicMessage(),
    options: { forceWasMentioned: true },
    resolveGroupActivation: () => true,
  });
}

function expectRouteArgs(): Record<string, unknown> {
  expect(resolveTelegramConversationRouteMock).toHaveBeenCalledTimes(1);
  return (
    resolveTelegramConversationRouteMock.mock.calls.at(0) as unknown as [Record<string, unknown>]
  )[0];
}

describe("buildTelegramMessageContext thread binding override", () => {
  beforeEach(() => {
    recordInboundSessionMock.mockClear();
    resolveTelegramConversationRouteMock.mockReset();
  });

  it("passes forum topic messages through the route seam and uses the bound session", async () => {
    resolveTelegramConversationRouteMock.mockReturnValue(
      createBoundRoute({
        accountId: "default",
        sessionKey: "agent:codex-acp:session-1",
        agentId: "codex-acp",
      }),
    );

    const ctx = await buildForumTopicMessageContext();

    const routeArgs = expectRouteArgs();
    expect(routeArgs.accountId).toBe("default");
    expect(routeArgs.chatId).toBe(-100200300);
    expect(routeArgs.isGroup).toBe(true);
    expect(routeArgs.resolvedThreadId).toBe(77);
    expect(routeArgs.replyThreadId).toBe(77);
    expect(routeArgs.senderId).toBe("42");
    expect(ctx?.ctxPayload?.SessionKey).toBe("agent:codex-acp:session-1");
    expect(ctx?.turn.record.updateLastRoute).toBeUndefined();
  });

  it("treats named-account bound conversations as explicit route matches", async () => {
    resolveTelegramConversationRouteMock.mockReturnValue(
      createBoundRoute({
        accountId: "work",
        sessionKey: "agent:codex-acp:session-2",
        agentId: "codex-acp",
      }),
    );

    const ctx = await buildForumTopicMessageContext("work");

    const routeArgs = expectRouteArgs();
    expect(routeArgs.accountId).toBe("work");
    expect(routeArgs.chatId).toBe(-100200300);
    expect(routeArgs.isGroup).toBe(true);
    expect(routeArgs.resolvedThreadId).toBe(77);
    expect(routeArgs.replyThreadId).toBe(77);
    expect(routeArgs.senderId).toBe("42");
    expect(ctx?.route.accountId).toBe("work");
    expect(ctx?.route.matchedBy).toBe("binding.channel");
    expect(ctx?.ctxPayload?.SessionKey).toBe("agent:codex-acp:session-2");
  });

  it("passes dm messages through the route seam and uses the bound session", async () => {
    resolveTelegramConversationRouteMock.mockReturnValue(
      createBoundRoute({
        accountId: "default",
        sessionKey: "agent:codex-acp:session-dm",
        agentId: "codex-acp",
      }),
    );

    const ctx = await buildTelegramMessageContextForTest({
      sessionRuntime: threadBindingSessionRuntime,
      message: {
        message_id: 1,
        chat: { id: 1234, type: "private" },
        date: 1_700_000_000,
        text: "hello",
        from: { id: 42, first_name: "Alice" },
      },
    });

    const routeArgs = expectRouteArgs();
    expect(routeArgs.accountId).toBe("default");
    expect(routeArgs.chatId).toBe(1234);
    expect(routeArgs.isGroup).toBe(false);
    expect(routeArgs.resolvedThreadId).toBeUndefined();
    expect(routeArgs.replyThreadId).toBeUndefined();
    expect(routeArgs.senderId).toBe("42");
    expect(ctx?.ctxPayload?.SessionKey).toBe("agent:codex-acp:session-dm");
  });

  it("preserves Telegram DM topic thread IDs in the inbound context", async () => {
    resolveTelegramConversationRouteMock.mockReturnValue(
      createBoundRoute({
        accountId: "default",
        sessionKey: "agent:codex-acp:session-dm-topic",
        agentId: "codex-acp",
      }),
    );

    const ctx = await buildTelegramMessageContextForTest({
      sessionRuntime: threadBindingSessionRuntime,
      message: {
        message_id: 1,
        message_thread_id: 77,
        chat: { id: 1234, type: "private" },
        date: 1_700_000_000,
        text: "hello",
        from: { id: 42, first_name: "Alice" },
      },
    });

    const routeArgs = expectRouteArgs();
    expect(routeArgs.chatId).toBe(1234);
    expect(routeArgs.isGroup).toBe(false);
    expect(routeArgs.resolvedThreadId).toBeUndefined();
    expect(routeArgs.replyThreadId).toBe(77);
    expect(ctx?.ctxPayload?.MessageThreadId).toBe(77);
  });
});
