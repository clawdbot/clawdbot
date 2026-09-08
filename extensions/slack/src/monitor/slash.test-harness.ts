// Slack plugin module implements slash harness behavior.
import { vi } from "vitest";

type AsyncMock = ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<unknown>>>;

const mocks = vi.hoisted(() => ({
  dispatchMock: vi.fn(),
  turnPlanMock: vi.fn(),
  readAllowFromStoreMock: vi.fn(),
  upsertPairingRequestMock: vi.fn(),
  resolveAgentRouteMock: vi.fn(),
  finalizeInboundContextMock: vi.fn(),
  resolveConversationLabelMock: vi.fn(),
  recordSessionMetaFromInboundMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  resolveStorePathMock: vi.fn(),
  deliverSlackSlashRepliesMock: vi.fn<(params: unknown) => Promise<unknown>>(async (params) => {
    const delivery = params as {
      replies?: unknown[];
      onReplySettled?: (settlement: { replyIndex: number; visibleReplySent: boolean }) => void;
    };
    delivery.replies?.forEach((_reply, replyIndex) =>
      delivery.onReplySettled?.({ replyIndex, visibleReplySent: true }),
    );
  }),
}));

vi.mock("./slash-dispatch.runtime.js", async (importOriginal) => {
  return {
    ...(await importOriginal<typeof import("./slash-dispatch.runtime.js")>()),
    deliverSlackSlashReplies: (params: unknown) => mocks.deliverSlackSlashRepliesMock(params),
    dispatchChannelInboundTurn: async (plan: {
      cfg: unknown;
      ctxPayload: unknown;
      route: { sessionKey: string };
      dispatchReplyFromConfig?: unknown;
      dispatcherOptions?: { onSettled?: () => unknown };
      delivery: { deliver?: unknown; onError?: unknown };
      replyOptions?: unknown;
    }) => {
      mocks.turnPlanMock(plan);
      void mocks.recordSessionMetaFromInboundMock({
        sessionKey:
          (plan.ctxPayload as { SessionKey?: string }).SessionKey ?? plan.route.sessionKey,
        ctx: plan.ctxPayload,
      });
      let dispatchResult: unknown;
      try {
        const deliver = async (...args: unknown[]) => {
          const result = await (
            plan.delivery.deliver as (...deliveryArgs: unknown[]) => Promise<{
              finalization?: Promise<unknown>;
            } | void>
          )(...args);
          // Routed core observes deferred rejection immediately, then awaits the same
          // finalization during settlement. Mirror that ownership in this legacy-shaped shim.
          void result?.finalization?.catch(() => undefined);
          return result;
        };
        dispatchResult = await mocks.dispatchMock({
          ctx: plan.ctxPayload,
          cfg: plan.cfg,
          dispatcherOptions: {
            ...plan.dispatcherOptions,
            deliver,
            onError: plan.delivery.onError,
          },
          replyOptions: plan.replyOptions,
        });
      } finally {
        await plan.dispatcherOptions?.onSettled?.();
      }
      return {
        admission: { kind: "dispatch" },
        dispatched: true,
        ctxPayload: plan.ctxPayload,
        routeSessionKey: plan.route.sessionKey,
        dispatchResult,
      };
    },
    finalizeInboundContext: (...args: unknown[]) => mocks.finalizeInboundContextMock(...args),
    isChannelPartialDeliveryError: (error: unknown) =>
      Boolean(
        error &&
        typeof error === "object" &&
        (error as { code?: unknown }).code === "CHANNEL_PARTIAL_DELIVERY",
      ),
    resolveAgentRoute: (...args: unknown[]) => mocks.resolveAgentRouteMock(...args),
    resolveChunkMode: vi.fn(() => "auto"),
    resolveConversationLabel: (...args: unknown[]) => mocks.resolveConversationLabelMock(...args),
    resolveMarkdownTableMode: vi.fn(() => "auto"),
  };
});

type SlashHarnessMocks = {
  dispatchMock: typeof mocks.dispatchMock;
  turnPlanMock: ReturnType<typeof vi.fn>;
  readAllowFromStoreMock: ReturnType<typeof vi.fn>;
  upsertPairingRequestMock: ReturnType<typeof vi.fn>;
  resolveAgentRouteMock: ReturnType<typeof vi.fn>;
  finalizeInboundContextMock: ReturnType<typeof vi.fn>;
  resolveConversationLabelMock: ReturnType<typeof vi.fn>;
  recordSessionMetaFromInboundMock: AsyncMock;
  resolveStorePathMock: ReturnType<typeof vi.fn>;
  deliverSlackSlashRepliesMock: AsyncMock;
};

export function getSlackSlashMocks(): SlashHarnessMocks {
  return mocks;
}

export function resetSlackSlashMocks() {
  mocks.dispatchMock.mockReset().mockResolvedValue({ counts: { final: 1, tool: 0, block: 0 } });
  mocks.turnPlanMock.mockReset();
  mocks.readAllowFromStoreMock.mockReset().mockResolvedValue([]);
  mocks.upsertPairingRequestMock.mockReset().mockResolvedValue({ code: "PAIRCODE", created: true });
  mocks.resolveAgentRouteMock.mockReset().mockReturnValue({
    agentId: "main",
    sessionKey: "session:1",
    accountId: "acct",
  });
  mocks.finalizeInboundContextMock.mockReset().mockImplementation((ctx: unknown) => ctx);
  mocks.resolveConversationLabelMock.mockReset().mockReturnValue(undefined);
  mocks.recordSessionMetaFromInboundMock.mockReset().mockResolvedValue(undefined);
  mocks.resolveStorePathMock.mockReset().mockReturnValue("/tmp/openclaw-sessions.json");
  mocks.deliverSlackSlashRepliesMock.mockReset().mockImplementation(async (params: unknown) => {
    const delivery = params as {
      replies?: unknown[];
      onReplySettled?: (settlement: { replyIndex: number; visibleReplySent: boolean }) => void;
    };
    delivery.replies?.forEach((_reply, replyIndex) =>
      delivery.onReplySettled?.({ replyIndex, visibleReplySent: true }),
    );
  });
}
