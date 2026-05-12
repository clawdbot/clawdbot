import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const ensureConfiguredBindingRouteReadyMock = vi.hoisted(() => vi.fn());
const recordInboundSessionMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const resolveTelegramConversationRouteMock = vi.hoisted(() => vi.fn());

vi.mock("./conversation-route.js", async () => {
  const actual =
    await vi.importActual<typeof import("./conversation-route.js")>("./conversation-route.js");
  return {
    ...actual,
    resolveTelegramConversationRoute: (...args: unknown[]) =>
      resolveTelegramConversationRouteMock(...args),
  };
});

let buildTelegramMessageContextForTest: typeof import("./bot-message-context.test-harness.js").buildTelegramMessageContextForTest;

const configuredBindingRuntime = {
  ensureConfiguredBindingRouteReady: (...args: unknown[]) =>
    ensureConfiguredBindingRouteReadyMock(...args),
} as NonNullable<
  import("./bot-message-context.types.js").BuildTelegramMessageContextParams["runtime"]
>;

const configuredBindingSessionRuntime = {
  recordInboundSession: (...args: unknown[]) => recordInboundSessionMock(...args),
} as NonNullable<
  import("./bot-message-context.types.js").BuildTelegramMessageContextParams["sessionRuntime"]
>;

function createConfiguredTelegramBinding() {
  return {
    spec: {
      channel: "telegram",
      accountId: "work",
      conversationId: "-1001234567890:topic:42",
      parentConversationId: "-1001234567890",
      agentId: "codex",
      mode: "persistent",
    },
    record: {
      bindingId: "config:acp:telegram:work:-1001234567890:topic:42",
      targetSessionKey: "agent:codex:acp:binding:telegram:work:abc123",
      targetKind: "session",
      conversation: {
        channel: "telegram",
        accountId: "work",
        conversationId: "-1001234567890:topic:42",
        parentConversationId: "-1001234567890",
      },
      status: "active",
      boundAt: 0,
      metadata: {
        source: "config",
        mode: "persistent",
        agentId: "codex",
      },
    },
  } as const;
}

function createConfiguredTelegramRoute() {
  const configuredBinding = createConfiguredTelegramBinding();
  return {
    configuredBinding: {
      conversation: {
        channel: "telegram",
        accountId: "work",
        conversationId: "-1001234567890:topic:42",
        parentConversationId: "-1001234567890",
      },
      compiledBinding: {
        channel: "telegram",
        accountPattern: "work",
        binding: {
          type: "acp",
          agentId: "codex",
          match: {
            channel: "telegram",
            accountId: "work",
            peer: {
              kind: "group",
              id: "-1001234567890:topic:42",
            },
          },
        },
        bindingConversationId: "-1001234567890:topic:42",
        target: {
          conversationId: "-1001234567890:topic:42",
          parentConversationId: "-1001234567890",
        },
        agentId: "codex",
        provider: {
          compileConfiguredBinding: () => ({
            conversationId: "-1001234567890:topic:42",
            parentConversationId: "-1001234567890",
          }),
          matchInboundConversation: () => ({
            conversationId: "-1001234567890:topic:42",
            parentConversationId: "-1001234567890",
          }),
        },
        targetFactory: {
          driverId: "acp",
          materialize: () => ({
            record: configuredBinding.record,
            statefulTarget: {
              kind: "stateful",
              driverId: "acp",
              sessionKey: configuredBinding.record.targetSessionKey,
              agentId: configuredBinding.spec.agentId,
            },
          }),
        },
      },
      match: {
        conversationId: "-1001234567890:topic:42",
        parentConversationId: "-1001234567890",
      },
      record: configuredBinding.record,
      statefulTarget: {
        kind: "stateful",
        driverId: "acp",
        sessionKey: configuredBinding.record.targetSessionKey,
        agentId: configuredBinding.spec.agentId,
      },
    },
    configuredBindingSessionKey: configuredBinding.record.targetSessionKey,
    route: {
      agentId: "codex",
      accountId: "work",
      channel: "telegram",
      sessionKey: configuredBinding.record.targetSessionKey,
      mainSessionKey: "agent:codex:main",
      matchedBy: "binding.channel",
      lastRoutePolicy: "bound",
    },
  } as const;
}

describe("buildTelegramMessageContext ACP configured bindings", () => {
  beforeAll(async () => {
    ({ buildTelegramMessageContextForTest } =
      await import("./bot-message-context.test-harness.js"));
  });

  beforeEach(() => {
    ensureConfiguredBindingRouteReadyMock.mockReset();
    recordInboundSessionMock.mockClear();
    resolveTelegramConversationRouteMock.mockReset();
    resolveTelegramConversationRouteMock.mockReturnValue(createConfiguredTelegramRoute());
    ensureConfiguredBindingRouteReadyMock.mockResolvedValue({ ok: true });
  });

  it("treats configured topic bindings as explicit route matches on non-default accounts", async () => {
    const ctx = await buildTelegramMessageContextForTest({
      accountId: "work",
      runtime: configuredBindingRuntime,
      sessionRuntime: configuredBindingSessionRuntime,
      message: {
        chat: { id: -1001234567890, type: "supergroup", title: "OpenClaw", is_forum: true },
        message_thread_id: 42,
        text: "hello",
      },
    });

    expect(ctx?.route.accountId).toBe("work");
    expect(ctx?.route.matchedBy).toBe("binding.channel");
    expect(ctx?.route.sessionKey).toBe("agent:codex:acp:binding:telegram:work:abc123");
    expect(ctx?.turn.record.updateLastRoute).toBeUndefined();
    expect(ensureConfiguredBindingRouteReadyMock).toHaveBeenCalledTimes(1);
  });

  it("skips ACP session initialization when topic access is denied", async () => {
    const ctx = await buildTelegramMessageContextForTest({
      accountId: "work",
      runtime: configuredBindingRuntime,
      sessionRuntime: configuredBindingSessionRuntime,
      message: {
        chat: { id: -1001234567890, type: "supergroup", title: "OpenClaw", is_forum: true },
        message_thread_id: 42,
        text: "hello",
      },
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: false },
        topicConfig: { enabled: false },
      }),
    });

    expect(ctx).toBeNull();
    expect(resolveTelegramConversationRouteMock).toHaveBeenCalledTimes(1);
    expect(ensureConfiguredBindingRouteReadyMock).not.toHaveBeenCalled();
  });

  it("defers ACP session initialization for unauthorized control commands", async () => {
    const ctx = await buildTelegramMessageContextForTest({
      accountId: "work",
      runtime: configuredBindingRuntime,
      sessionRuntime: configuredBindingSessionRuntime,
      message: {
        chat: { id: -1001234567890, type: "supergroup", title: "OpenClaw", is_forum: true },
        message_thread_id: 42,
        text: "/new",
      },
      cfg: {
        channels: {
          telegram: {},
        },
        commands: {
          useAccessGroups: true,
        },
      },
    });

    expect(ctx).toBeNull();
    expect(resolveTelegramConversationRouteMock).toHaveBeenCalledTimes(1);
    expect(ensureConfiguredBindingRouteReadyMock).not.toHaveBeenCalled();
  });

  it("drops inbound processing when configured ACP binding initialization fails", async () => {
    ensureConfiguredBindingRouteReadyMock.mockResolvedValue({
      ok: false,
      error: "gateway unavailable",
    });

    const ctx = await buildTelegramMessageContextForTest({
      accountId: "work",
      runtime: configuredBindingRuntime,
      sessionRuntime: configuredBindingSessionRuntime,
      message: {
        chat: { id: -1001234567890, type: "supergroup", title: "OpenClaw", is_forum: true },
        message_thread_id: 42,
        text: "hello",
      },
    });

    expect(ctx).toBeNull();
    expect(resolveTelegramConversationRouteMock).toHaveBeenCalledTimes(1);
    expect(ensureConfiguredBindingRouteReadyMock).toHaveBeenCalledTimes(1);
  });
});
