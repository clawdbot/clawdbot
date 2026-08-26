// Tests ACP delivery's channel-transform ownership and suppression boundary.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReplyPayload } from "../reply-payload.js";
import { createAcpDispatchDeliveryCoordinator } from "./dispatch-acp-delivery.js";
import { prepareAcpDeliveryPayload } from "./dispatch-acp-payload.js";
import {
  bindReplyDispatcherConversationContext,
  createReplyDispatcher,
} from "./reply-dispatcher.js";
import { buildTestCtx } from "./test-ctx.js";
import { createAcpTestConfig } from "./test-fixtures/acp-runtime.js";

const ttsMocks = vi.hoisted(() => ({
  maybeApplyTtsToPayload: vi.fn(async (paramsUnknown: unknown) => {
    const params = paramsUnknown as { payload: unknown };
    return params.payload;
  }),
}));

vi.mock("../../tts/tts.runtime.js", () => ({
  maybeApplyTtsToPayload: (params: unknown) => ttsMocks.maybeApplyTtsToPayload(params),
}));

function createCoordinator(params: {
  dispatcher: ReturnType<typeof createReplyDispatcher>;
  suppressBlockUserDelivery?: boolean;
}) {
  return createAcpDispatchDeliveryCoordinator({
    cfg: createAcpTestConfig({ tts: { enabled: true } }),
    ctx: buildTestCtx({
      Provider: "visiblechat",
      Surface: "visiblechat",
      SessionKey: "agent:codex-acp:session-1",
    }),
    dispatcher: params.dispatcher,
    inboundAudio: false,
    sessionTtsAuto: "always",
    suppressBlockUserDelivery: params.suppressBlockUserDelivery,
    shouldRouteToOriginating: false,
  });
}

describe("ACP channel reply transforms", () => {
  beforeEach(() => {
    ttsMocks.maybeApplyTtsToPayload.mockClear();
  });

  it("strips bound private context from routed replies without applying direct presentation", () => {
    const conversationContext = [
      "[Chat messages since your last reply - for context]",
      "[VisibleChat] Alice: private history",
      "",
      "[Current message - respond to this]",
      '<function_calls><invoke name="exec">private XML</invoke></function_calls>',
      "private inbound paragraph",
    ].join("\n");
    const dispatcher = createReplyDispatcher({
      deliver: vi.fn(async () => {}),
      responsePrefix: "[direct]",
      transformReplyPayload: (payload) => ({ ...payload, text: `direct ${payload.text}` }),
    });
    bindReplyDispatcherConversationContext(dispatcher, conversationContext);

    const outcome = prepareAcpDeliveryPayload({
      cfg: createAcpTestConfig(),
      dispatcher,
      kind: "final",
      payload: { text: `${conversationContext}\n\nVisible answer.` },
      routed: true,
    });

    expect(outcome.kind).toBe("deliver");
    if (outcome.kind === "deliver") {
      expect(outcome.payload).toEqual({ text: "Visible answer." });
    }
    dispatcher.markComplete();
  });

  it("honors dispatcher channel suppression before TTS or transcript accounting", async () => {
    const transport = vi.fn(async () => {});
    const dispatcher = createReplyDispatcher({
      deliver: transport,
      transformReplyPayload: () => null,
    });
    const coordinator = createCoordinator({ dispatcher });

    await expect(coordinator.deliver("final", { text: "private reply" })).resolves.toBe(false);
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(ttsMocks.maybeApplyTtsToPayload).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
    expect(coordinator.getAccumulatedTranscriptText()).toBe("");
    expect(coordinator.hasDeliveredFinalReply()).toBe(false);
    expect(coordinator.getDeliverySuppressionReason()).toBe("channel_transform");
  });

  it("preserves transform ownership while rebuilding deferred ACP final text", async () => {
    const transport = vi.fn(async () => {});
    const transformReplyPayload = vi.fn((payload: ReplyPayload) => ({
      ...payload,
      text: `${payload.text}!`,
    }));
    const dispatcher = createReplyDispatcher({ deliver: transport, transformReplyPayload });
    const coordinator = createCoordinator({ dispatcher, suppressBlockUserDelivery: true });

    await coordinator.deliver("final", { text: "hello" }, { skipTts: true });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(transformReplyPayload).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledWith({ text: "hello!" }, { kind: "final" });
  });
});
