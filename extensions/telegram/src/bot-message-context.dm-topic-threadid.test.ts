import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getRecordedUpdateLastRoute,
  loadTelegramMessageContextRouteHarness,
  recordInboundSessionMock,
} from "./bot-message-context.route-test-support.js";

vi.mock("./bot-message-context.body.js", () => ({
  resolveTelegramInboundBody: async () => ({
    bodyText: "hello",
    rawBody: "hello",
    historyKey: undefined,
    commandAuthorized: false,
    effectiveWasMentioned: true,
    canDetectMention: false,
    shouldBypassMention: false,
    stickerCacheHit: false,
    locationData: undefined,
  }),
}));

let buildTelegramMessageContextForTest: typeof import("./bot-message-context.test-harness.js").buildTelegramMessageContextForTest;
let clearRuntimeConfigSnapshot: typeof import("openclaw/plugin-sdk/runtime-config-snapshot").clearRuntimeConfigSnapshot;

describe("buildTelegramMessageContext DM topic threadId in deliveryContext (#8891)", () => {
  async function buildCtx(params: {
    message: Record<string, unknown>;
    options?: Record<string, unknown>;
    resolveGroupActivation?: () => boolean | undefined;
    sessionRuntime?: Parameters<typeof buildTelegramMessageContextForTest>[0]["sessionRuntime"];
  }) {
    return await buildTelegramMessageContextForTest({
      message: params.message,
      options: params.options,
      resolveGroupActivation: params.resolveGroupActivation,
      ...(params.sessionRuntime !== undefined ? { sessionRuntime: params.sessionRuntime } : {}),
    });
  }

  function expectRecordedRoute(params: { to: string; threadId?: string }) {
    const updateLastRoute = getRecordedUpdateLastRoute(0) as
      | { threadId?: string; to?: string }
      | undefined;
    if (!updateLastRoute) {
      throw new Error("expected recorded Telegram route");
    }
    expect(updateLastRoute.to).toBe(params.to);
    expect(updateLastRoute.threadId).toBe(params.threadId);
  }

  afterEach(() => {
    clearRuntimeConfigSnapshot();
  });

  beforeAll(async () => {
    ({ clearRuntimeConfigSnapshot, buildTelegramMessageContextForTest } =
      await loadTelegramMessageContextRouteHarness());
  });

  beforeEach(() => {
    recordInboundSessionMock.mockClear();
  });

  it("passes threadId to updateLastRoute for DM topics", async () => {
    const ctx = await buildCtx({
      message: {
        chat: { id: 1234, type: "private" },
        message_thread_id: 42, // DM Topic ID
      },
    });

    if (!ctx?.ctxPayload) {
      throw new Error("expected Telegram DM topic context payload");
    }
    expect(recordInboundSessionMock).toHaveBeenCalled();

    expectRecordedRoute({ to: "telegram:1234", threadId: "42" });
  });

  it("builds Telegram payloads through the shared channel turn context", async () => {
    const { buildChannelTurnContext } = await import("openclaw/plugin-sdk/channel-inbound");
    const buildChannelTurnContextMock = vi.fn(buildChannelTurnContext);

    const ctx = await buildCtx({
      message: {
        chat: { id: 1234, type: "private" },
        text: "hello",
        reply_to_message: {
          message_id: 9,
          date: 1_700_000_001,
          text: "parent",
          from: { id: 99, first_name: "Bob" },
        },
      },
      sessionRuntime: {
        buildChannelTurnContext: buildChannelTurnContextMock,
      },
    });

    expect(ctx?.ctxPayload.ReplyToBody).toBe("parent");
    expect(buildChannelTurnContextMock).toHaveBeenCalledOnce();
    const [turnOptions] = buildChannelTurnContextMock.mock.calls.at(0) ?? [];
    expect(turnOptions?.channel).toBe("telegram");
    expect(turnOptions?.from).toBe("telegram:1234");
    expect(turnOptions?.message.rawBody).toBe("hello");
    expect(turnOptions?.message.bodyForAgent).toBe("hello");
    expect(turnOptions?.reply?.to).toBe("telegram:1234");
    expect(turnOptions?.reply?.originatingTo).toBe("telegram:1234");
    expect(turnOptions?.reply?.replyToId).toBe("9");
    expect(turnOptions?.supplemental?.quote?.id).toBe("9");
    expect(turnOptions?.supplemental?.quote?.body).toBe("parent");
    expect(turnOptions?.supplemental?.quote?.sender).toBe("Bob");
    expect(turnOptions?.supplemental?.quote?.senderAllowed).toBe(true);
  });

  it("does not pass threadId for regular DM without topic", async () => {
    const ctx = await buildCtx({
      message: {
        chat: { id: 1234, type: "private" },
      },
    });

    if (!ctx?.ctxPayload) {
      throw new Error("expected Telegram DM context payload");
    }
    expect(recordInboundSessionMock).toHaveBeenCalled();

    expectRecordedRoute({ to: "telegram:1234" });
  });

  it("passes threadId to updateLastRoute for forum topic group messages", async () => {
    const ctx = await buildCtx({
      message: {
        chat: { id: -1001234567890, type: "supergroup", title: "Test Group", is_forum: true },
        text: "@bot hello",
        message_thread_id: 99,
      },
      options: { forceWasMentioned: true },
      resolveGroupActivation: () => true,
    });

    if (!ctx?.ctxPayload) {
      throw new Error("expected Telegram forum topic context payload");
    }
    expect(recordInboundSessionMock).toHaveBeenCalled();

    expectRecordedRoute({ to: "telegram:-1001234567890:topic:99", threadId: "99" });
  });

  it("passes threadId to updateLastRoute for the forum General topic", async () => {
    const ctx = await buildCtx({
      message: {
        chat: { id: -1001234567890, type: "supergroup", title: "Test Group", is_forum: true },
        text: "@bot hello",
      },
      options: { forceWasMentioned: true },
      resolveGroupActivation: () => true,
    });

    if (!ctx?.ctxPayload) {
      throw new Error("expected Telegram General topic context payload");
    }
    expect(recordInboundSessionMock).toHaveBeenCalled();

    expectRecordedRoute({ to: "telegram:-1001234567890:topic:1", threadId: "1" });
  });
});
