import { describe, expect, it, vi } from "vitest";
import { markOperationalReplyPayloadForSourceSuppressionDelivery } from "../reply-payload.js";
import { createAcpDispatchDeliveryCoordinator } from "./dispatch-acp-delivery.js";
import type { ReplyDispatcher } from "./reply-dispatcher.types.js";
import { buildTestCtx } from "./test-ctx.js";
import { createAcpTestConfig } from "./test-fixtures/acp-runtime.js";

vi.mock("./dispatch-acp-tts.runtime.js", () => ({
  maybeApplyTtsToPayload: async (params: { payload: unknown }) => params.payload,
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

function createContext(inboundEventKind?: "room_event") {
  return buildTestCtx({
    Provider: "visiblechat",
    Surface: "visiblechat",
    SessionKey: "agent:codex-acp:session-1",
    ...(inboundEventKind ? { InboundEventKind: inboundEventKind } : {}),
  });
}

describe("ACP operational reply delivery policy", () => {
  it("enforces send-policy denial without a separate suppression flag", async () => {
    const dispatcher = createDispatcher();
    const coordinator = createAcpDispatchDeliveryCoordinator({
      cfg: createAcpTestConfig({
        messages: { operationalReplies: { policy: "redirect" } },
      }),
      ctx: createContext(),
      dispatcher,
      inboundAudio: false,
      sendPolicyDenied: true,
      shouldRouteToOriginating: false,
    });

    const ordinaryDelivered = await coordinator.deliver("final", { text: "private final" });
    const noticeDelivered = await coordinator.deliver(
      "final",
      markOperationalReplyPayloadForSourceSuppressionDelivery({
        text: "private operational failure",
        isError: true,
      }),
    );

    expect(ordinaryDelivered).toBe(false);
    expect(noticeDelivered).toBe(false);
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it("keeps bare tool errors private in message-tool-only mode", async () => {
    const dispatcher = createDispatcher();
    const coordinator = createAcpDispatchDeliveryCoordinator({
      cfg: createAcpTestConfig(),
      ctx: createContext(),
      dispatcher,
      inboundAudio: false,
      sourceReplyDeliveryMode: "message_tool_only",
      suppressUserDelivery: true,
      suppressUserDeliveryBySourceReplyPolicy: true,
      shouldRouteToOriginating: false,
    });

    const delivered = await coordinator.deliver("tool", {
      text: "private failed tool output",
      isError: true,
    });

    expect(delivered).toBe(false);
    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
  });

  it("does not bypass independent user-delivery suppression for notices", async () => {
    const dispatcher = createDispatcher();
    const coordinator = createAcpDispatchDeliveryCoordinator({
      cfg: createAcpTestConfig({
        messages: { operationalReplies: { policy: "redirect" } },
      }),
      ctx: createContext(),
      dispatcher,
      inboundAudio: false,
      sourceReplyDeliveryMode: "message_tool_only",
      suppressUserDelivery: true,
      suppressUserDeliveryBySourceReplyPolicy: false,
      shouldRouteToOriginating: false,
    });

    const delivered = await coordinator.deliver(
      "final",
      markOperationalReplyPayloadForSourceSuppressionDelivery({
        text: "private operational notice",
        isStatusNotice: true,
      }),
    );

    expect(delivered).toBe(false);
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it("evaluates redirect policy for source-suppressed room events", async () => {
    const coordinator = createAcpDispatchDeliveryCoordinator({
      cfg: createAcpTestConfig({
        messages: { operationalReplies: { policy: "redirect" } },
      }),
      ctx: createContext("room_event"),
      dispatcher: createDispatcher(),
      inboundAudio: false,
      sourceReplyDeliveryMode: "message_tool_only",
      suppressUserDelivery: true,
      suppressUserDeliveryBySourceReplyPolicy: true,
      shouldRouteToOriginating: false,
    });

    await expect(
      coordinator.deliver(
        "final",
        markOperationalReplyPayloadForSourceSuppressionDelivery({
          text: "room operational failure",
          isError: true,
        }),
      ),
    ).rejects.toThrow("redirectSessionKey is required");
  });

  it("does not silence visible bare tool errors with the operational policy", async () => {
    const dispatcher = createDispatcher();
    const coordinator = createAcpDispatchDeliveryCoordinator({
      cfg: createAcpTestConfig({
        messages: { operationalReplies: { policy: "silent" } },
      }),
      ctx: createContext(),
      dispatcher,
      inboundAudio: false,
      shouldRouteToOriginating: false,
    });
    const toolError = { text: "visible failed tool output", isError: true };

    const delivered = await coordinator.deliver("tool", toolError);

    expect(delivered).toBe(true);
    expect(dispatcher.sendToolResult).toHaveBeenCalledWith(toolError);
  });
});
