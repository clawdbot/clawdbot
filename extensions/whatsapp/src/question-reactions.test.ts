// Covers WhatsApp delivery binding and numbered-reaction dispatch.
import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock("openclaw/plugin-sdk/question-gateway-runtime", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("openclaw/plugin-sdk/question-gateway-runtime")>();
  return {
    ...original,
    questionGatewayRuntime: {
      ...original.questionGatewayRuntime,
      resolveReaction: hoisted.resolve,
    },
  };
});

import { questionGatewayRuntime } from "openclaw/plugin-sdk/question-gateway-runtime";
import {
  clearWhatsAppQuestionReactionTargetsForTest,
  maybeResolveWhatsAppQuestionReaction,
  registerWhatsAppQuestionReactionTargetForDeliveredPayload,
} from "./question-reactions.js";

const questionId = "ask_0123456789abcdef0123456789abcdef";

function buildPayload() {
  const presentation = {
    blocks: [
      { type: "text" as const, text: "Pick one" },
      {
        type: "buttons" as const,
        buttons: ["One", "Two"].map((label) => ({
          label,
          action: { type: "question" as const, questionId, optionValue: label },
        })),
      },
    ],
  };
  return questionGatewayRuntime.prepareReactionPayloadForDelivery({
    payload: { presentation, channelData: { askUser: { questionId } } },
    presentation,
  });
}

describe("WhatsApp question reactions", () => {
  beforeEach(() => {
    clearWhatsAppQuestionReactionTargetsForTest();
    hoisted.resolve.mockReset().mockResolvedValue({
      status: "answered",
      questionId: "choice",
      optionValue: "Two",
    });
  });

  it("round-trips a delivered message and silently consumes a stale second tap", async () => {
    const payload = buildPayload();
    expect(payload).not.toBeNull();
    expect(
      registerWhatsAppQuestionReactionTargetForDeliveredPayload({
        cfg: {},
        target: { channel: "whatsapp", accountId: "default" },
        payload: payload!,
        results: [{ channel: "whatsapp", messageId: "wa-1", toJid: "1555@s.whatsapp.net" }],
      }),
    ).toBe(true);
    const msg = {
      key: { remoteJid: "1555@s.whatsapp.net", participant: "1555@s.whatsapp.net" },
      message: {
        reactionMessage: {
          text: "2️⃣",
          key: { id: "wa-1", remoteJid: "1555@s.whatsapp.net" },
        },
      },
    };
    const debug = vi.fn();

    await expect(
      maybeResolveWhatsAppQuestionReaction({
        cfg: {},
        accountId: "default",
        msg: {
          ...msg,
          message: {
            reactionMessage: {
              ...msg.message.reactionMessage,
              text: "4️⃣",
            },
          },
        },
        senderId: "+1555",
        logDebug: debug,
      }),
    ).resolves.toBe(true);
    await expect(
      maybeResolveWhatsAppQuestionReaction({
        cfg: {},
        accountId: "default",
        msg,
        senderId: "+1555",
        logDebug: debug,
      }),
    ).resolves.toBe(true);
    expect(hoisted.resolve).toHaveBeenCalledWith(
      expect.objectContaining({ questionId, optionValue: "Two", senderId: "+1555" }),
    );

    await expect(
      maybeResolveWhatsAppQuestionReaction({
        cfg: {},
        accountId: "default",
        msg,
        senderId: "+1555",
        logDebug: debug,
      }),
    ).resolves.toBe(true);
    expect(hoisted.resolve).toHaveBeenCalledOnce();
    expect(debug).toHaveBeenCalledWith(expect.stringContaining("stale question reaction ignored"));
  });
});
