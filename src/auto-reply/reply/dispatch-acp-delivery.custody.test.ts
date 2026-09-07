import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  OutboundDeliveryError,
  PlatformMessageNotDispatchedError,
} from "../../infra/outbound/deliver-types.js";
import { markReplyPayloadAsTtsSupplement } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import { createAcpDispatchDeliveryCoordinator } from "./dispatch-acp-delivery.js";
import { runWithDispatchAbortSignal } from "./dispatch-from-config.abort.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";
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
  routed = true,
  abortSignal?: AbortSignal,
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
    shouldRouteToOriginating: routed,
    originatingChannel: "visiblechat",
    originatingTo: "channel:thread-1",
    abortSignal,
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

  it.each([false, true])(
    "keeps generated and confirmed block order through a selective fallback (routed=%s)",
    async (routed) => {
      const controller = new AbortController();
      const notDispatched = new PlatformMessageNotDispatchedError("offline", { cause: undefined });
      const attempts: Array<{ kind: string; text?: string }> = [];
      const dispatcher = createReplyDispatcher({
        deliver: async (payload, info) => {
          attempts.push({ kind: info.kind, text: payload.text });
          if (info.kind === "block" && payload.text === "B") {
            throw notDispatched;
          }
          return { visibleReplySent: true };
        },
      });
      if (routed) {
        deliveryMocks.routeReply
          .mockResolvedValueOnce({ ok: true, delivered: true })
          .mockResolvedValueOnce({
            ok: false,
            delivered: false,
            queueCustody: "released",
            cause: notDispatched,
          })
          .mockResolvedValueOnce({ ok: true, delivered: true });
      }
      const coordinator = createVisibleChatAcpCoordinator(
        createAcpTestConfig(),
        dispatcher,
        routed,
        controller.signal,
      );
      await coordinator.deliver("block", { text: "A" }, { skipTts: true });
      await coordinator.deliver("block", { text: "B" }, { skipTts: true });
      await coordinator.settleVisibleText();
      expect(coordinator.getBlockTextForFallback()).toBe("B");
      await coordinator.deliver(
        "final",
        { text: "B" },
        { skipTts: true, transcriptSource: { kind: "fallback" } },
      );
      dispatcher.markComplete();
      await dispatcher.waitForIdle();

      expect(
        routed
          ? deliveryMocks.routeReply.mock.calls.map(([call]) => ({
              kind: call.replyKind,
              text: call.payload.text,
            }))
          : attempts,
      ).toEqual([
        { kind: "block", text: "A" },
        { kind: "block", text: "B" },
        { kind: "final", text: "B" },
      ]);
      expect(coordinator.getAccumulatedTranscriptText()).toBe("A\nB");
      controller.abort();
      await expect(coordinator.resolveAccumulatedDeliveredTranscriptText()).resolves.toBe("A\nB");
    },
  );

  it.each([
    { routed: false, audio: false },
    { routed: true, audio: false },
    { routed: false, audio: true },
    { routed: true, audio: true },
  ])(
    "retains directive-only block provenance for TTS (routed=$routed, audio=$audio)",
    async ({ routed, audio }) => {
      const dispatcher = createReplyDispatcher({
        deliver: async () => ({ visibleReplySent: true }),
      });
      const coordinator = createVisibleChatAcpCoordinator(
        createAcpTestConfig({ tts: { auto: "always" } }),
        dispatcher,
        routed,
      );
      const generated = "[[tts:text]]Spoken.[[/tts:text]]";
      await expect(
        coordinator.deliver("block", { text: generated }, { skipTts: true }),
      ).resolves.toBe(false);
      expect(coordinator.getBlockTextForFallback()).toBe("");
      const fallback = audio
        ? markReplyPayloadAsTtsSupplement(
            { mediaUrl: "https://example.test/spoken.ogg" },
            "Spoken.",
          )
        : { text: "Spoken." };
      await coordinator.deliver("final", fallback, {
        skipTts: true,
        transcriptSource: { kind: "blocks" },
      });
      dispatcher.markComplete();
      await dispatcher.waitForIdle();

      expect(coordinator.getAccumulatedTranscriptText()).toBe(generated);
      await expect(coordinator.resolveAccumulatedDeliveredTranscriptText()).resolves.toBe(
        generated,
      );
    },
  );

  it("keeps an explicit runtime final canonical when its caption is retried", async () => {
    const coordinator = createVisibleChatAcpCoordinator(createAcpTestConfig());
    await coordinator.deliver("block", { text: "Earlier block." }, { skipTts: true });
    deliveryMocks.routeReply
      .mockResolvedValueOnce({
        ok: false,
        delivered: false,
        queueCustody: "released",
        cause: new PlatformMessageNotDispatchedError("caption was not dispatched", {
          cause: undefined,
        }),
      })
      .mockResolvedValueOnce({ ok: true, delivered: true });
    await coordinator.deliver(
      "final",
      markReplyPayloadAsTtsSupplement({
        text: "Explicit final.",
        mediaUrl: "https://example.test/final.ogg",
      }),
      { skipTts: true },
    );
    expect(
      deliveryMocks.routeReply.mock.calls.map(([call]) => ({
        kind: call.replyKind,
        payload: call.payload,
      })),
    ).toEqual([
      { kind: "block", payload: { text: "Earlier block." } },
      {
        kind: "final",
        payload: {
          text: "Explicit final.",
          mediaUrl: "https://example.test/final.ogg",
          spokenText: "Explicit final.",
          ttsSupplement: { spokenText: "Explicit final." },
        },
      },
      { kind: "final", payload: { text: "Explicit final." } },
    ]);
    expect(coordinator.getAccumulatedTranscriptText()).toBe("Explicit final.");
    await expect(coordinator.resolveAccumulatedDeliveredTranscriptText()).resolves.toBe(
      "Explicit final.",
    );
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

  it.each([true, false])(
    "retries released TTS only with no-send proof, provenUnsent=%s",
    async (provenUnsent) => {
      deliveryMocks.routeReply.mockResolvedValueOnce({
        ok: false,
        delivered: false,
        queueCustody: "released",
        error: "voice delivery failed",
        ...(provenUnsent
          ? {
              cause: new PlatformMessageNotDispatchedError("voice rejected before dispatch", {
                cause: undefined,
              }),
            }
          : {}),
      });
      const dispatcher = createDispatcher();
      const coordinator = createVisibleChatAcpCoordinator(createAcpTestConfig(), dispatcher);
      const payload = markReplyPayloadAsTtsSupplement({
        text: "hello",
        mediaUrl: "/tmp/openclaw-media/acp-tts.ogg",
        audioAsVoice: true,
      });

      await expect(coordinator.deliver("final", payload, { skipTts: true })).resolves.toBe(true);

      if (!provenUnsent) {
        expect(deliveryMocks.routeReply).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ payload, replyKind: "final" }),
        );
        expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
        expect(coordinator.hasDeliveredFinalReply()).toBe(false);
        expect(coordinator.hasDeliveredAnswerFinalToUser()).toBe(false);
        expect(coordinator.hasDeliveredFinalTtsMedia()).toBe(false);
        expect(coordinator.hasDeliveredVisibleText()).toBe(false);
        expect(coordinator.getRoutedCounts()).toEqual({ tool: 0, block: 0, final: 0 });
        await expect(coordinator.resolveAccumulatedDeliveredTranscriptText()).resolves.toBe("");
        return;
      }
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
    },
  );

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

describe.each(["held", "identityless"] as const)("ACP direct %s delivery", (pendingKind) => {
  const pendingResult = () => {
    if (pendingKind === "held") {
      throw Object.assign(
        new OutboundDeliveryError("queued", {
          cause: new PlatformMessageNotDispatchedError("offline", { cause: undefined }),
        }),
        { queueCustody: "held" as const },
      );
    }
    return {
      visibleReplySent: false,
      suppression: { reason: "adapter_returned_no_identity" as const },
    };
  };

  it.each([false, true])(
    "retains only the uncovered block for fallback (uncoveredFirst=%s)",
    async (uncoveredFirst) => {
      const texts = uncoveredFirst ? ["uncovered", "pending"] : ["pending", "uncovered"];
      const dispatcher = createReplyDispatcher({
        deliver: async (payload) => {
          if (payload.text === "pending") {
            return pendingResult();
          }
          throw new PlatformMessageNotDispatchedError("rejected before dispatch", {
            cause: undefined,
          });
        },
      });
      const coordinator = createVisibleChatAcpCoordinator(createAcpTestConfig(), dispatcher, false);
      for (const text of texts) {
        await coordinator.deliver("block", { text }, { skipTts: true });
      }
      dispatcher.markComplete();
      await coordinator.settleVisibleText();

      expect(coordinator.getBlockTextForFallback()).toBe("uncovered");
      expect(coordinator.hasPendingAnswerDelivery()).toBe(true);
      expect(coordinator.hasDeliveredVisibleText()).toBe(false);
      await expect(coordinator.resolveAccumulatedDeliveredTranscriptText()).resolves.toBe("");
    },
  );

  it.each([
    { name: "text", text: "answer", audio: false },
    { name: "audio", text: undefined, audio: true },
    { name: "caption", text: "answer", audio: true },
  ])(
    "keeps pending final $name ownership separate from confirmed delivery",
    async ({ text, audio }) => {
      const dispatcher = createReplyDispatcher({ deliver: async () => pendingResult() });
      const coordinator = createVisibleChatAcpCoordinator(createAcpTestConfig(), dispatcher, false);
      const payload = audio
        ? markReplyPayloadAsTtsSupplement(
            { text, mediaUrl: "https://example.test/answer.ogg" },
            "answer",
          )
        : { text };
      await coordinator.deliver("final", payload, { skipTts: true });
      dispatcher.markComplete();
      await coordinator.settleVisibleText();
      await expect(coordinator.resolveAccumulatedDeliveredTranscriptText()).resolves.toBe("");

      expect(coordinator.hasPendingAnswerDelivery()).toBe(Boolean(text));
      expect(coordinator.hasPendingFinalTtsMedia()).toBe(audio);
      expect(coordinator.hasDeliveredFinalReply()).toBe(false);
      expect(coordinator.hasDeliveredAnswerFinalToUser()).toBe(false);
      expect(coordinator.hasDeliveredFinalTtsMedia()).toBe(false);
    },
  );

  it.each([{ isCommentary: true }, { isReasoning: true }, { isStatusNotice: true }] as const)(
    "does not let pending non-answer output own an answer (%j)",
    async (classification) => {
      const dispatcher = createReplyDispatcher({ deliver: async () => pendingResult() });
      const coordinator = createVisibleChatAcpCoordinator(createAcpTestConfig(), dispatcher, false);
      await coordinator.deliver(
        "block",
        { text: "Working.", ...classification },
        { skipTts: true },
      );
      dispatcher.markComplete();
      await coordinator.settleVisibleText();
      expect(coordinator.hasPendingAnswerDelivery()).toBe(false);
      expect(coordinator.hasPendingFinalTtsMedia()).toBe(false);
      expect(coordinator.getBlockTextForFallback()).toBe("");
      await expect(coordinator.resolveAccumulatedDeliveredTranscriptText()).resolves.toBe("");
    },
  );
});

describe.each([undefined, "released"] as const)(
  "ACP partial direct delivery with %s custody",
  (queueCustody) => {
    it.each(["block", "caption"] as const)(
      "preserves pending %s coverage without retrying possibly delivered text",
      async (kind) => {
        const failure = new OutboundDeliveryError("audio failed after caption acceptance", {
          cause: new Error("transport result unavailable"),
          results: [{ channel: "visiblechat", messageId: "accepted-caption" }],
        });
        if (queueCustody) {
          failure.queueCustody = queueCustody;
        }
        const attempted: ReplyPayload[] = [];
        const dispatcher = createReplyDispatcher({
          deliver: async (payload) => {
            attempted.push(payload);
            throw failure;
          },
        });
        const coordinator = createAcpDispatchDeliveryCoordinator({
          cfg: createAcpTestConfig(),
          ctx: buildTestCtx({ Provider: "visiblechat", Surface: "visiblechat" }),
          dispatcher,
          inboundAudio: false,
          shouldRouteToOriginating: false,
          suppressBlockUserDelivery: kind === "caption",
        });
        await coordinator.deliver("block", { text: "answer" }, { skipTts: true });
        if (kind === "caption") {
          await coordinator.deliver(
            "final",
            markReplyPayloadAsTtsSupplement({
              text: "answer",
              mediaUrl: "https://example.test/answer.ogg",
            }),
            { skipTts: true },
          );
        }
        dispatcher.markComplete();
        await coordinator.settleVisibleText();
        expect(attempted).toHaveLength(1);
        expect(coordinator.getBlockTextForFallback()).toBe("");
        expect(coordinator.hasPendingAnswerDelivery()).toBe(true);
        expect(coordinator.hasPendingFinalTtsMedia()).toBe(kind === "caption");
        expect(coordinator.hasDeliveredAnswerFinalToUser()).toBe(false);
        await expect(coordinator.resolveAccumulatedDeliveredTranscriptText()).resolves.toBe("");
      },
    );
  },
);

it("releases outer cancellation while retaining admitted final ownership and transcript drain", async () => {
  const finalStarted = createDeferred();
  const finalization = createDeferred<never>();
  const controller = new AbortController();
  const attempted: string[] = [];
  const dispatcher = createReplyDispatcher({
    deliver: async (payload) => {
      attempted.push(payload.text ?? "");
      if (payload.text === "visible prefix") {
        return { visibleReplySent: true };
      }
      finalStarted.resolve();
      return { visibleReplySent: false, finalization: finalization.promise };
    },
  });
  const coordinator = createVisibleChatAcpCoordinator(
    createAcpTestConfig(),
    dispatcher,
    false,
    controller.signal,
  );
  await coordinator.deliver("block", { text: "visible prefix" }, { skipTts: true });
  await coordinator.settleVisibleText();
  let finalSettled = false;
  const finalDelivery = coordinator
    .deliver("final", { text: "pending final" }, { skipTts: true })
    .then((result) => {
      finalSettled = true;
      return result;
    });
  const cancellation = expect(
    runWithDispatchAbortSignal(controller.signal, () => finalDelivery),
  ).rejects.toMatchObject({ name: "AbortError" });
  await finalStarted.promise;
  controller.abort();
  let transcriptSettled = false;
  const transcript = coordinator.resolveAccumulatedDeliveredTranscriptText().then((text) => {
    transcriptSettled = true;
    return text;
  });
  try {
    await cancellation;
    await coordinator.settleVisibleText();
    await nextEventLoopTurn();
    expect(finalSettled).toBe(false);
    expect(transcriptSettled).toBe(false);
    expect(coordinator.hasDeliveredFinalReply()).toBe(false);
    expect(coordinator.hasDeliveredAnswerFinalToUser()).toBe(false);
  } finally {
    finalization.reject(
      Object.assign(
        new OutboundDeliveryError("queued final", {
          cause: new PlatformMessageNotDispatchedError("offline", { cause: undefined }),
        }),
        { queueCustody: "held" as const },
      ),
    );
    await finalDelivery;
    dispatcher.markComplete();
    await dispatcher.waitForIdle();
  }
  expect(attempted).toEqual(["visible prefix", "pending final"]);
  expect(coordinator.hasPendingAnswerDelivery()).toBe(true);
  await expect(transcript).resolves.toBe("visible prefix");
  await expect(coordinator.resolveAccumulatedDeliveredTranscriptText()).resolves.toBe(
    "visible prefix",
  );
});
