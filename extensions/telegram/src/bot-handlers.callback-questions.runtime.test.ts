// Telegram question callback feedback tests.
import { describe, expect, it, vi } from "vitest";
import { handleTelegramQuestionCallback } from "./bot-handlers.callback-questions.runtime.js";

const callback = {
  questionId: "ask_0123456789abcdef0123456789abcdef",
  optionIndex: 1,
};

describe("handleTelegramQuestionCallback", () => {
  it.each([
    [{ status: "answered", questionId: "target", optionValue: "Production" }, "Answer submitted."],
    [
      { status: "already-terminal", reason: "already-terminal" },
      "This question was already answered.",
    ],
  ] as const)("shows outcome feedback", async (result, expectedText) => {
    const feedback = vi.fn(async () => undefined);
    const resolveQuestion = vi.fn(async () => result);

    await handleTelegramQuestionCallback({
      callback,
      cfg: {} as never,
      senderId: "42",
      feedback,
      resolveQuestion,
    });

    expect(feedback).toHaveBeenCalledWith(expectedText, true);
  });

  it("does not turn a committed answer into an error when feedback fails", async () => {
    const feedback = vi.fn(async () => {
      throw new Error("receipt failed");
    });

    await expect(
      handleTelegramQuestionCallback({
        callback,
        cfg: {} as never,
        senderId: "42",
        feedback,
        resolveQuestion: vi.fn(async () => ({
          status: "answered" as const,
          questionId: "target",
          optionValue: "Production",
        })),
      }),
    ).resolves.toBeUndefined();
    expect(feedback).toHaveBeenCalledOnce();
    expect(feedback).toHaveBeenCalledWith("Answer submitted.", true);
  });
});
