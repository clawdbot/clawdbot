import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { markReplyPayloadAsTtsSupplement } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import { createAcpDispatchDeliveryCoordinator } from "./dispatch-acp-delivery.js";
import type { ReplyDispatcher } from "./reply-dispatcher.types.js";
import { buildTestCtx } from "./test-ctx.js";
import {
  createAcpTestConfig,
  createAcpTestReplyDispatcher as createDispatcher,
} from "./test-fixtures/acp-runtime.js";

const deliveryMocks = vi.hoisted(() => ({
  routeReply: vi.fn<typeof import("./route-reply.js").routeReply>(),
}));

vi.mock("./route-reply.runtime.js", () => deliveryMocks);
vi.mock("../../tts/tts.runtime.js", () => ({
  maybeApplyTtsToPayload: async ({ payload }: { payload: ReplyPayload }) => payload,
}));
vi.mock("../../channels/plugins/index.js", () => ({
  normalizeChannelId: (channelId?: string | null) => channelId?.trim().toLowerCase() || null,
  getChannelPlugin: () => ({
    config: { listAccountIds: () => ["default"], resolveAccount: () => ({}) },
    outbound: {
      shouldTreatDeliveredTextAsVisible: ({ kind, text }: { kind: string; text?: string }) =>
        kind === "block" && Boolean(text?.trim()),
    },
  }),
}));

function createVisibleChatAcpCoordinator(
  cfg: OpenClawConfig,
  dispatcher: ReplyDispatcher = createDispatcher(),
) {
  return createAcpDispatchDeliveryCoordinator({
    cfg,
    ctx: buildTestCtx({
      Provider: "visiblechat",
      Surface: "visiblechat",
      SessionKey: "agent:codex-acp:session-1",
    }),
    dispatcher,
    inboundAudio: false,
    shouldRouteToOriginating: true,
    originatingChannel: "visiblechat",
    originatingTo: "channel:thread-1",
  });
}

describe("ACP routed delivery custody", () => {
  beforeEach(() => {
    deliveryMocks.routeReply.mockReset();
    deliveryMocks.routeReply.mockResolvedValue({
      ok: true,
      delivered: true,
      messageId: "mock-message",
    });
  });

  it.each(["held", "released"] as const)(
    "does not retry routed ACP text after a partial delivery failure with %s custody",
    async (queueCustody) => {
      deliveryMocks.routeReply.mockResolvedValueOnce({
        ok: false,
        delivered: true,
        messageId: "visible-1",
        queueCustody,
        error: "later chunk failed",
      });
      const coordinator = createVisibleChatAcpCoordinator(createAcpTestConfig());

      await expect(
        coordinator.deliver("final", { text: "hello" }, { skipTts: true }),
      ).resolves.toBe(true);

      expect(deliveryMocks.routeReply).toHaveBeenCalledTimes(1);
      expect(coordinator.getRoutedCounts().final).toBe(1);
      expect(coordinator.hasDeliveredFinalReply()).toBe(true);
      expect(coordinator.hasDeliveredVisibleText()).toBe(true);
      await expect(coordinator.resolveAccumulatedDeliveredTranscriptText()).resolves.toBe("hello");
    },
  );

  it.each([
    { ok: false, queueCustody: "held", ambiguous: undefined },
    { ok: false, queueCustody: "held", ambiguous: true },
    { ok: false, queueCustody: "released", ambiguous: true },
    { ok: true, queueCustody: undefined, ambiguous: true },
  ] as const)(
    "handles pending TTS before caption fallback with custody=$queueCustody and ambiguous=$ambiguous",
    async ({ ok, queueCustody, ambiguous }) => {
      deliveryMocks.routeReply.mockResolvedValueOnce({
        ok,
        delivered: false,
        queueCustody,
        ambiguous,
        ...(ok
          ? { reason: "adapter_returned_no_identity" }
          : { error: "delivery remains unconfirmed" }),
      });
      const dispatcher = createDispatcher();
      const coordinator = createVisibleChatAcpCoordinator(createAcpTestConfig(), dispatcher);
      const payload = markReplyPayloadAsTtsSupplement({
        text: "hello",
        mediaUrl: "/tmp/openclaw-media/acp-tts.ogg",
        audioAsVoice: true,
      });

      await expect(coordinator.deliver("final", payload, { skipTts: true })).resolves.toBe(true);
      await coordinator.settleVisibleText();

      expect(deliveryMocks.routeReply).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ payload, replyKind: "final" }),
      );
      expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
      expect(coordinator.hasDeliveredFinalReply()).toBe(false);
      expect(coordinator.hasDeliveredAnswerFinalToUser()).toBe(false);
      expect(coordinator.hasDeliveredFinalTtsMedia()).toBe(false);
      expect(coordinator.hasDeliveredVisibleText()).toBe(false);
      expect(coordinator.hasFailedVisibleTextDelivery()).toBe(false);
      expect(coordinator.getRoutedCounts()).toEqual({ tool: 0, block: 0, final: 0 });
      await expect(coordinator.resolveAccumulatedDeliveredTranscriptText()).resolves.toBe("");
    },
  );

  it("still sends a text caption after a released, proven-unsent TTS failure", async () => {
    deliveryMocks.routeReply.mockResolvedValueOnce({
      ok: false,
      delivered: false,
      queueCustody: "released",
      error: "voice rejected before dispatch",
    });
    const dispatcher = createDispatcher();
    const coordinator = createVisibleChatAcpCoordinator(createAcpTestConfig(), dispatcher);
    const payload = markReplyPayloadAsTtsSupplement({
      text: "hello",
      mediaUrl: "/tmp/openclaw-media/acp-tts.ogg",
      audioAsVoice: true,
    });

    await expect(coordinator.deliver("final", payload, { skipTts: true })).resolves.toBe(true);

    expect(deliveryMocks.routeReply).toHaveBeenCalledTimes(2);
    expect(deliveryMocks.routeReply).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ payload }),
    );
    expect(deliveryMocks.routeReply).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ payload: { text: "hello" }, replyKind: "final" }),
    );
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(coordinator.hasDeliveredFinalReply()).toBe(true);
    expect(coordinator.hasDeliveredAnswerFinalToUser()).toBe(true);
    expect(coordinator.hasDeliveredFinalTtsMedia()).toBe(false);
    expect(coordinator.hasDeliveredVisibleText()).toBe(true);
    expect(coordinator.hasFailedVisibleTextDelivery()).toBe(false);
    expect(coordinator.getRoutedCounts()).toEqual({ tool: 0, block: 0, final: 1 });
    await expect(coordinator.resolveAccumulatedDeliveredTranscriptText()).resolves.toBe("hello");
  });

  it.each([{ isCommentary: true }, { isReasoning: true }, { isStatusNotice: true }] as const)(
    "keeps pending non-answer custody separate from the answer (%j)",
    async (classification) => {
      deliveryMocks.routeReply.mockResolvedValueOnce({
        ok: false,
        delivered: false,
        queueCustody: "held",
      });
      const coordinator = createVisibleChatAcpCoordinator(createAcpTestConfig());
      await expect(
        coordinator.deliver("block", { text: "Working on it.", ...classification }),
      ).resolves.toBe(true);
      expect(coordinator.hasPendingAnswerDelivery()).toBe(false);
      await expect(
        coordinator.deliver("final", { text: "The answer." }, { skipTts: true }),
      ).resolves.toBe(true);
      expect(deliveryMocks.routeReply).toHaveBeenLastCalledWith(
        expect.objectContaining({
          replyKind: "final",
          payload: { text: "The answer." },
        }),
      );
      expect(coordinator.hasDeliveredAnswerFinalToUser()).toBe(true);
    },
  );
});
