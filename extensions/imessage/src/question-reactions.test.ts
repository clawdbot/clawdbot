// Covers iMessage delivery binding and numbered-reaction dispatch.
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
  clearIMessageQuestionReactionTargetsForTest,
  hasIMessageQuestionReactionTarget,
  maybeResolveIMessageQuestionReaction,
  registerIMessageQuestionReactionTargetForDeliveredPayload,
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

describe("iMessage question reactions", () => {
  beforeEach(() => {
    clearIMessageQuestionReactionTargetsForTest();
    hoisted.resolve.mockReset().mockResolvedValue({
      status: "answered",
      questionId: "choice",
      optionValue: "Two",
    });
  });

  it("recognizes a stable GUID and consumes a stale duplicate", async () => {
    expect(
      registerIMessageQuestionReactionTargetForDeliveredPayload({
        accountId: "default",
        target: { channel: "imessage" },
        payload: buildPayload()!,
        results: [
          {
            channel: "imessage",
            messageId: "42",
            meta: { imessageMessageGuid: "p:0/GUID-1" },
          },
        ],
      }),
    ).toBe(true);
    const message = {
      sender: "+15550002222",
      is_reaction: true,
      is_reaction_add: true,
      reaction_emoji: "2️⃣",
      reacted_to_guid: "GUID-1",
    };
    expect(hasIMessageQuestionReactionTarget({ accountId: "default", message, bodyText: "" })).toBe(
      true,
    );
    expect(
      hasIMessageQuestionReactionTarget({
        accountId: "default",
        message: { ...message, reaction_emoji: "❤️" },
        bodyText: "",
      }),
    ).toBe(false);
    expect(
      hasIMessageQuestionReactionTarget({
        accountId: "default",
        message: { ...message, is_reaction_add: false },
        bodyText: "",
      }),
    ).toBe(false);
    const params = {
      cfg: {},
      accountId: "default",
      message,
      bodyText: "",
      senderId: "+15550002222",
      logDebug: vi.fn(),
    };

    await expect(
      maybeResolveIMessageQuestionReaction({
        ...params,
        message: { ...message, reaction_emoji: "4️⃣" },
      }),
    ).resolves.toBe(true);
    await expect(maybeResolveIMessageQuestionReaction(params)).resolves.toBe(true);
    await expect(maybeResolveIMessageQuestionReaction(params)).resolves.toBe(true);
    expect(hoisted.resolve).toHaveBeenCalledOnce();
    expect(hoisted.resolve).toHaveBeenCalledWith(
      expect.objectContaining({ questionId, optionValue: "Two", senderId: "+15550002222" }),
    );
  });
});
