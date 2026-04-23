import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { createAcpDispatchDeliveryCoordinator } from "./dispatch-acp-delivery.js";
import type { ReplyDispatcher } from "./reply-dispatcher.js";
import { buildTestCtx } from "./test-ctx.js";
import { createAcpTestConfig } from "./test-fixtures/acp-runtime.js";

const ttsMocks = vi.hoisted(() => ({
  maybeApplyTtsToPayload: vi.fn(async (paramsUnknown: unknown) => {
    const params = paramsUnknown as { payload: unknown };
    return params.payload;
  }),
}));

const deliveryMocks = vi.hoisted(() => ({
  routeReply: vi.fn(async (_params: unknown) => ({ ok: true, messageId: "mock-message" })),
  runMessageAction: vi.fn(async (_params: unknown) => ({ ok: true as const })),
}));

const channelPluginMocks = vi.hoisted(() => ({
  shouldTreatDeliveredTextAsVisible: (({
    kind,
    text,
  }: {
    kind: "tool" | "block" | "final";
    text?: string;
  }) => kind === "block" && typeof text === "string" && text.trim().length > 0) as
    | ((params: { kind: "tool" | "block" | "final"; text?: string }) => boolean)
    | undefined,
  shouldTreatRoutedTextAsVisible: undefined as
    | ((params: { kind: "tool" | "block" | "final"; text?: string }) => boolean)
    | undefined,
  getChannelPlugin: vi.fn((channelId: string) => {
    if (channelId !== "visiblechat") {
      return undefined;
    }
    return {
      outbound: {
        shouldTreatDeliveredTextAsVisible: channelPluginMocks.shouldTreatDeliveredTextAsVisible,
        shouldTreatRoutedTextAsVisible: channelPluginMocks.shouldTreatRoutedTextAsVisible,
      },
    };
  }),
}));

vi.mock("./dispatch-acp-tts.runtime.js", () => ({
  maybeApplyTtsToPayload: (params: unknown) => ttsMocks.maybeApplyTtsToPayload(params),
}));

vi.mock("./route-reply.runtime.js", () => ({
  routeReply: (params: unknown) => deliveryMocks.routeReply(params),
}));

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: (channelId: string) => channelPluginMocks.getChannelPlugin(channelId),
  normalizeChannelId: (channelId?: string | null) => channelId?.trim().toLowerCase() || null,
}));

vi.mock("../../infra/outbound/message-action-runner.js", () => ({
  runMessageAction: (params: unknown) => deliveryMocks.runMessageAction(params),
}));

function createDispatcher(): ReplyDispatcher {
  return {
    sendToolResult: vi.fn(() => true),
    sendBlockReply: vi.fn(() => true),
    sendFinalReply: vi.fn(() => true),
    waitForIdle: vi.fn(async () => {}),
    getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
    getFailedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
    markComplete: vi.fn(),
  };
}

function createCoordinator(onReplyStart?: (...args: unknown[]) => Promise<void>) {
  return createAcpDispatchDeliveryCoordinator({
    cfg: createAcpTestConfig(),
    ctx: buildTestCtx({
      Provider: "visiblechat",
      Surface: "visiblechat",
      SessionKey: "agent:codex-acp:session-1",
    }),
    dispatcher: createDispatcher(),
    inboundAudio: false,
    shouldRouteToOriginating: false,
    ...(onReplyStart ? { onReplyStart } : {}),
  });
}

function createVisibleChatAcpCoordinator(cfg: OpenClawConfig) {
  return createAcpDispatchDeliveryCoordinator({
    cfg,
    ctx: buildTestCtx({
      Provider: "visiblechat",
      Surface: "visiblechat",
      SessionKey: "agent:codex-acp:session-1",
    }),
    dispatcher: createDispatcher(),
    inboundAudio: false,
    shouldRouteToOriginating: true,
    originatingChannel: "visiblechat",
    originatingTo: "channel:thread-1",
  });
}

async function expectVisibleChatBlockRoutesToAccount(
  cfg: OpenClawConfig,
  accountId: string | undefined,
): Promise<void> {
  const coordinator = createVisibleChatAcpCoordinator(cfg);

  await coordinator.deliver("block", { text: "hello" }, { skipTts: true });

  expect(deliveryMocks.routeReply).toHaveBeenCalledWith(
    expect.objectContaining({
      channel: "visiblechat",
      to: "channel:thread-1",
      accountId,
    }),
  );
}

describe("createAcpDispatchDeliveryCoordinator", () => {
  beforeEach(() => {
    deliveryMocks.routeReply.mockClear();
    deliveryMocks.routeReply.mockResolvedValue({ ok: true, messageId: "mock-message" });
    deliveryMocks.runMessageAction.mockClear();
    deliveryMocks.runMessageAction.mockResolvedValue({ ok: true as const });
    channelPluginMocks.getChannelPlugin.mockClear();
    channelPluginMocks.shouldTreatDeliveredTextAsVisible = ({
      kind,
      text,
    }: {
      kind: "tool" | "block" | "final";
      text?: string;
    }) => kind === "block" && typeof text === "string" && text.trim().length > 0;
    channelPluginMocks.shouldTreatRoutedTextAsVisible = undefined;
  });

  it("bypasses TTS when skipTts is requested", async () => {
    const dispatcher = createDispatcher();
    const coordinator = createAcpDispatchDeliveryCoordinator({
      cfg: createAcpTestConfig(),
      ctx: buildTestCtx({
        Provider: "visiblechat",
        Surface: "visiblechat",
        SessionKey: "agent:codex-acp:session-1",
      }),
      dispatcher,
      inboundAudio: false,
      shouldRouteToOriginating: false,
    });

    await coordinator.deliver("final", { text: "hello" }, { skipTts: true });
    await coordinator.settleVisibleText();

    expect(ttsMocks.maybeApplyTtsToPayload).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "hello" });
  });

  it("tracks successful final delivery separately from routed counters", async () => {
    const coordinator = createCoordinator();

    expect(coordinator.hasDeliveredFinalReply()).toBe(false);
    expect(coordinator.hasDeliveredVisibleText()).toBe(false);
    expect(coordinator.hasFailedVisibleTextDelivery()).toBe(false);

    await coordinator.deliver("final", { text: "hello" }, { skipTts: true });
    await coordinator.settleVisibleText();

    expect(coordinator.hasDeliveredFinalReply()).toBe(true);
    expect(coordinator.hasDeliveredVisibleText()).toBe(true);
    expect(coordinator.hasFailedVisibleTextDelivery()).toBe(false);
    expect(coordinator.getRoutedCounts().final).toBe(0);
  });

  it("tracks visible direct block text for dispatcher-backed delivery", async () => {
    const coordinator = createAcpDispatchDeliveryCoordinator({
      cfg: createAcpTestConfig(),
      ctx: buildTestCtx({
        Provider: "visiblechat",
        Surface: "visiblechat",
        SessionKey: "agent:codex-acp:session-1",
      }),
      dispatcher: createDispatcher(),
      inboundAudio: false,
      shouldRouteToOriginating: false,
    });

    await coordinator.deliver("block", { text: "hello" }, { skipTts: true });
    await coordinator.settleVisibleText();

    expect(coordinator.hasDeliveredFinalReply()).toBe(false);
    expect(coordinator.hasDeliveredVisibleText()).toBe(true);
    expect(coordinator.hasFailedVisibleTextDelivery()).toBe(false);
    expect(coordinator.getRoutedCounts().block).toBe(0);
  });

  it("prefers provider over surface when detecting direct channel visibility", async () => {
    const coordinator = createAcpDispatchDeliveryCoordinator({
      cfg: createAcpTestConfig(),
      ctx: buildTestCtx({
        Provider: "visiblechat",
        Surface: "webchat",
        SessionKey: "agent:codex-acp:session-1",
      }),
      dispatcher: createDispatcher(),
      inboundAudio: false,
      shouldRouteToOriginating: false,
    });

    await coordinator.deliver("block", { text: "hello" }, { skipTts: true });
    await coordinator.settleVisibleText();

    expect(coordinator.hasDeliveredVisibleText()).toBe(true);
    expect(coordinator.hasFailedVisibleTextDelivery()).toBe(false);
  });

  it("does not treat channels without a visibility override as visible for direct block delivery", async () => {
    const coordinator = createAcpDispatchDeliveryCoordinator({
      cfg: createAcpTestConfig(),
      ctx: buildTestCtx({
        Provider: "plainchat",
        Surface: "plainchat",
        SessionKey: "agent:codex-acp:session-1",
      }),
      dispatcher: createDispatcher(),
      inboundAudio: false,
      shouldRouteToOriginating: false,
    });

    await coordinator.deliver("block", { text: "hello" }, { skipTts: true });
    await coordinator.settleVisibleText();

    expect(coordinator.hasDeliveredFinalReply()).toBe(false);
    expect(coordinator.hasDeliveredVisibleText()).toBe(false);
    expect(coordinator.hasFailedVisibleTextDelivery()).toBe(false);
    expect(coordinator.getRoutedCounts().block).toBe(0);
  });

  it("treats direct plugin-owned block text as visible", async () => {
    const coordinator = createCoordinator();

    await coordinator.deliver("block", { text: "hello" }, { skipTts: true });
    await coordinator.settleVisibleText();

    expect(coordinator.hasDeliveredVisibleText()).toBe(true);
    expect(coordinator.hasFailedVisibleTextDelivery()).toBe(false);
  });

  it("honors the legacy routed visibility hook name for plugin compatibility", async () => {
    channelPluginMocks.shouldTreatDeliveredTextAsVisible = undefined;
    channelPluginMocks.shouldTreatRoutedTextAsVisible = ({
      kind,
      text,
    }: {
      kind: "tool" | "block" | "final";
      text?: string;
    }) => kind === "block" && typeof text === "string" && text.trim().length > 0;
    const coordinator = createCoordinator();

    await coordinator.deliver("block", { text: "hello" }, { skipTts: true });
    await coordinator.settleVisibleText();

    expect(coordinator.hasDeliveredVisibleText()).toBe(true);
    expect(coordinator.hasFailedVisibleTextDelivery()).toBe(false);
  });

  it("tracks failed visible block delivery separately", async () => {
    const dispatcher: ReplyDispatcher = {
      sendToolResult: vi.fn(() => true),
      sendBlockReply: vi.fn(() => false),
      sendFinalReply: vi.fn(() => true),
      waitForIdle: vi.fn(async () => {}),
      getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
      getFailedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
      markComplete: vi.fn(),
    };
    const coordinator = createAcpDispatchDeliveryCoordinator({
      cfg: createAcpTestConfig(),
      ctx: buildTestCtx({
        Provider: "visiblechat",
        Surface: "visiblechat",
        SessionKey: "agent:codex-acp:session-1",
      }),
      dispatcher,
      inboundAudio: false,
      shouldRouteToOriginating: false,
    });

    await coordinator.deliver("block", { text: "hello" }, { skipTts: true });

    expect(coordinator.hasDeliveredVisibleText()).toBe(false);
    expect(coordinator.hasFailedVisibleTextDelivery()).toBe(true);
  });

  it("starts reply lifecycle only once when called directly and through deliver", async () => {
    const onReplyStart = vi.fn(async () => {});
    const coordinator = createCoordinator(onReplyStart);

    await coordinator.startReplyLifecycle();
    await coordinator.deliver("final", { text: "hello" });
    await coordinator.startReplyLifecycle();
    await coordinator.deliver("block", { text: "world" });

    expect(onReplyStart).toHaveBeenCalledTimes(1);
  });

  it("starts reply lifecycle once when deliver triggers first", async () => {
    const onReplyStart = vi.fn(async () => {});
    const coordinator = createCoordinator(onReplyStart);

    await coordinator.deliver("final", { text: "hello" });
    await coordinator.startReplyLifecycle();

    expect(onReplyStart).toHaveBeenCalledTimes(1);
  });

  it("does not block delivery when reply lifecycle startup hangs", async () => {
    const onReplyStart = vi.fn(
      async () =>
        await new Promise<void>(() => {
          // Intentionally never resolve to simulate a stuck typing/reaction side effect.
        }),
    );
    const coordinator = createCoordinator(onReplyStart);

    const delivered = await Promise.race([
      coordinator.deliver("final", { text: "hello" }).then(() => "delivered"),
      new Promise<string>((resolve) => {
        setTimeout(() => resolve("timed-out"), 50);
      }),
    ]);

    expect(delivered).toBe("delivered");
    expect(onReplyStart).toHaveBeenCalledTimes(1);
  });

  it("does not start reply lifecycle for empty payload delivery", async () => {
    const onReplyStart = vi.fn(async () => {});
    const coordinator = createCoordinator(onReplyStart);

    await coordinator.deliver("final", {});

    expect(onReplyStart).not.toHaveBeenCalled();
  });

  it("does not fire onReplyStart when user delivery is suppressed", async () => {
    const onReplyStart = vi.fn(async () => {});
    const dispatcher = createDispatcher();
    const coordinator = createAcpDispatchDeliveryCoordinator({
      cfg: createAcpTestConfig(),
      ctx: buildTestCtx({
        Provider: "visiblechat",
        Surface: "visiblechat",
        SessionKey: "agent:codex-acp:session-1",
      }),
      dispatcher,
      inboundAudio: false,
      suppressUserDelivery: true,
      shouldRouteToOriginating: false,
      onReplyStart,
    });

    // Directly invoking the lifecycle (e.g. from dispatch-acp.ts before the
    // first deliver call) must not fire the typing indicator when delivery is
    // suppressed by sendPolicy: "deny".
    await coordinator.startReplyLifecycle();
    const delivered = await coordinator.deliver("final", { text: "hello" });

    expect(delivered).toBe(false);
    expect(onReplyStart).not.toHaveBeenCalled();
  });

  it("keeps parent-owned background ACP child delivery silent while preserving accumulated output", async () => {
    const dispatcher = createDispatcher();
    const coordinator = createAcpDispatchDeliveryCoordinator({
      cfg: createAcpTestConfig(),
      ctx: buildTestCtx({
        Provider: "visiblechat",
        Surface: "visiblechat",
        SessionKey: "agent:codex-acp:session-1",
      }),
      dispatcher,
      inboundAudio: false,
      suppressUserDelivery: true,
      shouldRouteToOriginating: true,
      originatingChannel: "visiblechat",
      originatingTo: "visiblechat:123",
    });

    const blockDelivered = await coordinator.deliver("block", { text: "working on it" });
    const finalDelivered = await coordinator.deliver("final", { text: "done" });
    await coordinator.settleVisibleText();

    expect(blockDelivered).toBe(false);
    expect(finalDelivered).toBe(false);
    expect(dispatcher.sendBlockReply).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(coordinator.getAccumulatedBlockText()).toBe("working on it");
    expect(coordinator.hasDeliveredVisibleText()).toBe(false);
  });

  it("routes ACP replies through the configured default account when AccountId is omitted", async () => {
    await expectVisibleChatBlockRoutesToAccount(
      createAcpTestConfig({
        channels: {
          visiblechat: {
            defaultAccount: "work",
          },
        },
      }),
      "work",
    );
  });

  it("mirrors routed ACP replies into the target ACP session", async () => {
    const coordinator = createAcpDispatchDeliveryCoordinator({
      cfg: createAcpTestConfig(),
      ctx: buildTestCtx({
        Provider: "visiblechat",
        Surface: "visiblechat",
        SessionKey: "agent:main:main",
      }),
      dispatcher: createDispatcher(),
      inboundAudio: false,
      sessionKey: "agent:claude:acp:spawned",
      shouldRouteToOriginating: true,
      originatingChannel: "visiblechat",
      originatingTo: "channel:thread-1",
    });

    await coordinator.deliver("block", { text: "hello" }, { skipTts: true });

    expect(deliveryMocks.routeReply).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:claude:acp:spawned",
        policySessionKey: "agent:main:main",
      }),
    );
  });

  it("routes ACP replies when cfg.channels is missing", async () => {
    await expectVisibleChatBlockRoutesToAccount({} as OpenClawConfig, undefined);
  });

  it("treats routed plugin-owned block text as visible", async () => {
    const coordinator = createAcpDispatchDeliveryCoordinator({
      cfg: createAcpTestConfig(),
      ctx: buildTestCtx({
        Provider: "visiblechat",
        Surface: "visiblechat",
        SessionKey: "agent:codex-acp:session-1",
      }),
      dispatcher: createDispatcher(),
      inboundAudio: false,
      shouldRouteToOriginating: true,
      originatingChannel: "visiblechat",
      originatingTo: "channel:thread-1",
    });

    await coordinator.deliver("block", { text: "hello" }, { skipTts: true });

    expect(coordinator.hasDeliveredVisibleText()).toBe(true);
    expect(coordinator.hasFailedVisibleTextDelivery()).toBe(false);
    expect(coordinator.getRoutedCounts().block).toBe(1);
  });
});
