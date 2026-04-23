import { vi, type Mock } from "vitest";

type BoundConversation = {
  bindingId: string;
  targetSessionKey: string;
};
type UnknownMock = Mock<(...args: unknown[]) => unknown>;
type AsyncUnknownMock = Mock<(...args: unknown[]) => Promise<unknown>>;
type FinalizeInboundContextMock = Mock<
  (ctx: Record<string, unknown>, opts?: unknown) => Record<string, unknown>
>;
type DispatchReplyCounts = {
  final: number;
  block?: number;
  tool?: number;
};
type DispatchReplyContext = Record<string, unknown> & {
  SessionKey?: string;
};
type DispatchReplyDispatcher = {
  sendFinalReply: (payload: { text: string }) => unknown;
};
type FeishuReplyDispatcherMockValue = {
  dispatcher: DispatchReplyDispatcher;
  replyOptions: Record<string, never>;
  markDispatchIdle: () => unknown;
};
type CreateFeishuReplyDispatcherMock = Mock<(params?: unknown) => FeishuReplyDispatcherMockValue>;
type DispatchReplyFromConfigMock = Mock<
  (params: {
    ctx: DispatchReplyContext;
    dispatcher: DispatchReplyDispatcher;
  }) => Promise<{ queuedFinal: boolean; counts: DispatchReplyCounts }>
>;
type WithReplyDispatcherMock = Mock<
  (params: {
    dispatcher?: DispatchReplyDispatcher;
    onSettled?: () => unknown;
    run: () => unknown;
  }) => Promise<unknown>
>;
type FeishuLifecycleTestMocks = {
  createEventDispatcherMock: UnknownMock;
  monitorWebSocketMock: AsyncUnknownMock;
  monitorWebhookMock: AsyncUnknownMock;
  createFeishuThreadBindingManagerMock: UnknownMock;
  createFeishuReplyDispatcherMock: CreateFeishuReplyDispatcherMock;
  resolveBoundConversationMock: Mock<(ref?: unknown) => BoundConversation | null>;
  touchBindingMock: UnknownMock;
  resolveAgentRouteMock: UnknownMock;
  resolveConfiguredBindingRouteMock: UnknownMock;
  ensureConfiguredBindingRouteReadyMock: UnknownMock;
  dispatchReplyFromConfigMock: DispatchReplyFromConfigMock;
  withReplyDispatcherMock: WithReplyDispatcherMock;
  finalizeInboundContextMock: FinalizeInboundContextMock;
  getMessageFeishuMock: AsyncUnknownMock;
  listFeishuThreadMessagesMock: AsyncUnknownMock;
  sendMessageFeishuMock: AsyncUnknownMock;
  sendCardFeishuMock: AsyncUnknownMock;
};

const feishuLifecycleTestMocks = vi.hoisted(
  (): FeishuLifecycleTestMocks => ({
    createEventDispatcherMock: vi.fn(),
    monitorWebSocketMock: vi.fn(async () => {}),
    monitorWebhookMock: vi.fn(async () => {}),
    createFeishuThreadBindingManagerMock: vi.fn(() => ({ stop: vi.fn() })),
    createFeishuReplyDispatcherMock: vi.fn(),
    resolveBoundConversationMock: vi.fn<(ref?: unknown) => BoundConversation | null>(() => null),
    touchBindingMock: vi.fn(),
    resolveAgentRouteMock: vi.fn(),
    resolveConfiguredBindingRouteMock: vi.fn(),
    ensureConfiguredBindingRouteReadyMock: vi.fn(),
    dispatchReplyFromConfigMock: vi.fn(),
    withReplyDispatcherMock: vi.fn(),
    finalizeInboundContextMock: vi.fn((ctx) => ctx),
    getMessageFeishuMock: vi.fn(async () => null),
    listFeishuThreadMessagesMock: vi.fn(async () => []),
    sendMessageFeishuMock: vi.fn(async () => ({ messageId: "om_sent", chatId: "chat_default" })),
    sendCardFeishuMock: vi.fn(async () => ({ messageId: "om_card", chatId: "chat_default" })),
  }),
);

export function getFeishuLifecycleTestMocks(): FeishuLifecycleTestMocks {
  return feishuLifecycleTestMocks;
}

export function resetFeishuLifecycleTestMocks(): void {
  for (const mock of Object.values(feishuLifecycleTestMocks)) {
    mock.mockReset();
  }
  feishuLifecycleTestMocks.monitorWebSocketMock.mockResolvedValue(undefined);
  feishuLifecycleTestMocks.monitorWebhookMock.mockResolvedValue(undefined);
  feishuLifecycleTestMocks.createFeishuThreadBindingManagerMock.mockReturnValue({ stop: vi.fn() });
  feishuLifecycleTestMocks.resolveBoundConversationMock.mockReturnValue(null);
  feishuLifecycleTestMocks.finalizeInboundContextMock.mockImplementation((ctx) => ctx);
  feishuLifecycleTestMocks.getMessageFeishuMock.mockResolvedValue(null);
  feishuLifecycleTestMocks.listFeishuThreadMessagesMock.mockResolvedValue([]);
  feishuLifecycleTestMocks.sendMessageFeishuMock.mockResolvedValue({
    messageId: "om_sent",
    chatId: "chat_default",
  });
  feishuLifecycleTestMocks.sendCardFeishuMock.mockResolvedValue({
    messageId: "om_card",
    chatId: "chat_default",
  });
}

const {
  createEventDispatcherMock,
  monitorWebSocketMock,
  monitorWebhookMock,
  createFeishuThreadBindingManagerMock,
  createFeishuReplyDispatcherMock,
  resolveBoundConversationMock,
  touchBindingMock,
  resolveConfiguredBindingRouteMock,
  ensureConfiguredBindingRouteReadyMock,
  getMessageFeishuMock,
  listFeishuThreadMessagesMock,
  sendMessageFeishuMock,
  sendCardFeishuMock,
} = feishuLifecycleTestMocks;

vi.mock("./client.js", () => {
  return {
    FEISHU_HTTP_TIMEOUT_ENV_VAR: "OPENCLAW_FEISHU_HTTP_TIMEOUT_MS",
    FEISHU_HTTP_TIMEOUT_MAX_MS: 300_000,
    FEISHU_HTTP_TIMEOUT_MS: 30_000,
    FEISHU_USER_AGENT: "openclaw-feishu-test",
    clearClientCache: vi.fn(),
    createFeishuClient: vi.fn(() => {
      throw new Error("unexpected Feishu client call in lifecycle test");
    }),
    createFeishuWSClient: vi.fn(async () => ({
      close: vi.fn(),
      start: vi.fn(),
    })),
    createEventDispatcher: createEventDispatcherMock,
    getFeishuClient: vi.fn(() => null),
    getFeishuUserAgent: vi.fn(() => "openclaw-feishu-test"),
    pluginVersion: "test",
    setFeishuClientRuntimeForTest: vi.fn(),
  };
});

vi.mock("./monitor.transport.js", () => ({
  monitorWebSocket: monitorWebSocketMock,
  monitorWebhook: monitorWebhookMock,
}));

vi.mock("./thread-bindings.js", () => ({
  createFeishuThreadBindingManager: createFeishuThreadBindingManagerMock,
}));

vi.mock("./reply-dispatcher.js", () => ({
  createFeishuReplyDispatcher: createFeishuReplyDispatcherMock,
}));

vi.mock("./send.js", () => ({
  sendCardFeishu: sendCardFeishuMock,
  getMessageFeishu: getMessageFeishuMock,
  listFeishuThreadMessages: listFeishuThreadMessagesMock,
  sendMessageFeishu: sendMessageFeishuMock,
}));

vi.mock("openclaw/plugin-sdk/conversation-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/conversation-runtime")>(
    "openclaw/plugin-sdk/conversation-runtime",
  );
  return {
    ...actual,
    resolveConfiguredBindingRoute: (
      params: Parameters<typeof actual.resolveConfiguredBindingRoute>[0],
    ) =>
      resolveConfiguredBindingRouteMock.getMockImplementation()
        ? resolveConfiguredBindingRouteMock(params)
        : actual.resolveConfiguredBindingRoute(params),
    resolveRuntimeConversationBindingRoute: (
      params: Parameters<typeof actual.resolveRuntimeConversationBindingRoute>[0],
    ) => {
      const conversation =
        "conversation" in params
          ? params.conversation
          : {
              channel: params.channel,
              accountId: params.accountId,
              conversationId: params.conversationId,
              parentConversationId: params.parentConversationId,
            };
      const bindingRecord = resolveBoundConversationMock(conversation);
      const boundSessionKey = bindingRecord?.targetSessionKey?.trim();
      if (!bindingRecord || !boundSessionKey) {
        return { bindingRecord: null, route: params.route };
      }
      touchBindingMock(bindingRecord.bindingId);
      return {
        bindingRecord,
        boundSessionKey,
        boundAgentId: params.route.agentId,
        route: {
          ...params.route,
          sessionKey: boundSessionKey,
          lastRoutePolicy: boundSessionKey === params.route.mainSessionKey ? "main" : "session",
          matchedBy: "binding.channel",
        },
      };
    },
    ensureConfiguredBindingRouteReady: (
      params: Parameters<typeof actual.ensureConfiguredBindingRouteReady>[0],
    ) =>
      ensureConfiguredBindingRouteReadyMock.getMockImplementation()
        ? ensureConfiguredBindingRouteReadyMock(params)
        : actual.ensureConfiguredBindingRouteReady(params),
    getSessionBindingService: () => ({
      resolveByConversation: resolveBoundConversationMock,
      touch: touchBindingMock,
    }),
  };
});

vi.mock("../../../src/infra/outbound/session-binding-service.js", () => ({
  getSessionBindingService: () => ({
    resolveByConversation: resolveBoundConversationMock,
    touch: touchBindingMock,
  }),
}));
