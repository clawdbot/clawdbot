// Telegram question callback feedback tests.
import { describe, expect, it, vi } from "vitest";
import {
  handleTelegramQuestionCallback,
  sendTelegramQuestionFeedback,
  type TelegramCallbackMessageActions,
} from "./bot-handlers.callback-actions.js";

const callback = {
  questionId: "ask_0123456789abcdef0123456789abcdef",
  intent: "select" as const,
  optionIndex: 1,
};

function createCallbackActions() {
  const clearCallbackButtons = vi.fn<TelegramCallbackMessageActions["clearCallbackButtons"]>();
  clearCallbackButtons.mockResolvedValue(true);
  return {
    editCallbackMessage: vi.fn<TelegramCallbackMessageActions["editCallbackMessage"]>(),
    clearCallbackButtons,
    editCallbackButtons: vi.fn<TelegramCallbackMessageActions["editCallbackButtons"]>(),
    editCallbackMessageWithButtons:
      vi.fn<TelegramCallbackMessageActions["editCallbackMessageWithButtons"]>(),
    deleteCallbackMessage: vi.fn<TelegramCallbackMessageActions["deleteCallbackMessage"]>(),
    replyToCallbackChat: vi.fn<TelegramCallbackMessageActions["replyToCallbackChat"]>(),
  } satisfies TelegramCallbackMessageActions;
}

describe("sendTelegramQuestionFeedback", () => {
  it("sends the custom-input prompt before retiring question controls", async () => {
    const actions = createCallbackActions();

    await sendTelegramQuestionFeedback({
      actions,
      text: "Reply with your own answer.",
      mode: "custom-input",
      isGroup: false,
      user: { id: 42, is_bot: false, first_name: "Ayaan" },
    });

    const [replyOrder] = actions.replyToCallbackChat.mock.invocationCallOrder;
    const [clearOrder] = actions.clearCallbackButtons.mock.invocationCallOrder;
    expect(replyOrder).toBeDefined();
    expect(clearOrder).toBeDefined();
    if (replyOrder === undefined || clearOrder === undefined) {
      throw new Error("Expected both custom-input feedback operations");
    }
    expect(replyOrder).toBeLessThan(clearOrder);
  });

  it("keeps question controls when Telegram rejects the custom-input prompt", async () => {
    const actions = createCallbackActions();
    actions.replyToCallbackChat.mockRejectedValue(new Error("send rejected"));

    await expect(
      sendTelegramQuestionFeedback({
        actions,
        text: "Reply with your own answer.",
        mode: "custom-input",
        isGroup: false,
        user: { id: 42, is_bot: false, first_name: "Ayaan" },
      }),
    ).rejects.toThrow("send rejected");

    expect(actions.clearCallbackButtons).not.toHaveBeenCalled();
  });
});

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

    expect(feedback).toHaveBeenCalledWith(expectedText, "terminal");
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
    expect(feedback).toHaveBeenCalledWith("Answer submitted.", "terminal");
  });

  it("switches an active question to Telegram force-reply input", async () => {
    const feedback = vi.fn(async () => undefined);

    await handleTelegramQuestionCallback({
      callback: { questionId: callback.questionId, intent: "custom-input" },
      cfg: {} as never,
      senderId: "42",
      feedback,
      resolveQuestion: vi.fn(async () => ({
        status: "custom-input" as const,
        questionId: "target",
      })),
    });

    expect(feedback).toHaveBeenCalledWith("Reply with your own answer.", "custom-input");
  });
});
