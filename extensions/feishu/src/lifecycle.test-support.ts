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
type DispatchReplyFromConfigMock = Mock<
  (params: {
    ctx: DispatchReplyContext;
    dispatcher: DispatchReplyDispatcher;
  }) => Promise<{ queuedFinal: boolean; counts: DispatchReplyCounts }>
>;
type WithReplyDispatcherMock = Mock<(params: { run: () => unknown }) => Promise<unknown>>;
type FeishuLifecycleTestMocks = {
  createEventDispatcherMock: UnknownMock;
  monitorWebSocketMock: AsyncUnknownMock;
  monitorWebhookMock: AsyncUnknownMock;
  createFeishuThreadBindingManagerMock: UnknownMock;
  createFeishuReplyDispatcherMock: UnknownMock;
  resolveBoundConversationMock: Mock<() => BoundConversation | null>;
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
    resolveBoundConversationMock: vi.fn<() => BoundConversation | null>(() => null),
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

vi.mock("./client.js", async () => {
  const actual = await vi.importActual<typeof import("./client.js")>("./client.js");
  return {
    ...actual,
    createEventDispatcher: createEventDispatcherMock,
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
