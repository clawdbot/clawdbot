// Covers Signal delivery binding and numbered-reaction dispatch.
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
  maybeResolveSignalQuestionReaction,
  registerSignalQuestionReactionTargetForDeliveredPayload,
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

describe("Signal question reactions", () => {
  beforeEach(() => {
    hoisted.resolve.mockReset().mockResolvedValue({
      status: "answered",
      questionId: "choice",
      optionValue: "One",
    });
  });

  it("matches the bot-authored target and ignores a duplicate", async () => {
    const payload = buildPayload();
    expect(
      registerSignalQuestionReactionTargetForDeliveredPayload({
        cfg: {},
        target: { channel: "signal", to: "+15550002222", accountId: "default" },
        payload: payload!,
        results: [{ channel: "signal", messageId: "1000" }],
        targetAuthor: "+15550001111",
      }),
    ).toBe(true);
    const params = {
      cfg: {},
      accountId: "default",
      conversationKey: "+15550002222",
      messageId: "1000",
      reactionKey: "1️⃣",
      isRemove: false,
      actorId: "+15550002222",
      targetAuthor: "+15550001111",
      logDebug: vi.fn(),
    };

    await expect(maybeResolveSignalQuestionReaction({ ...params, isRemove: true })).resolves.toBe(
      false,
    );
    await expect(
      maybeResolveSignalQuestionReaction({ ...params, reactionKey: "4️⃣" }),
    ).resolves.toBe(true);
    await expect(maybeResolveSignalQuestionReaction(params)).resolves.toBe(true);
    await expect(maybeResolveSignalQuestionReaction(params)).resolves.toBe(true);
    expect(hoisted.resolve).toHaveBeenCalledOnce();
    expect(hoisted.resolve).toHaveBeenCalledWith(
      expect.objectContaining({ questionId, optionValue: "One", senderId: "+15550002222" }),
    );
    expect(params.logDebug).toHaveBeenCalledWith(
      expect.stringContaining("stale question reaction ignored"),
    );
  });
});
