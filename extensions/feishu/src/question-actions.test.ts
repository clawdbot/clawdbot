import { describe, expect, it, vi } from "vitest";
import {
  buildFeishuQuestionInteractionContext,
  buildFeishuQuestionTargetContext,
  resolveFeishuQuestionAction,
} from "./question-actions.js";

describe("Feishu question actions", () => {
  it("binds inbound actions to the initiating user, conversation, and expiry", () => {
    expect(
      buildFeishuQuestionInteractionContext({
        operatorOpenId: "ou_user",
        chatId: "oc_chat",
        now: 1_000,
      }),
    ).toEqual({
      u: "ou_user",
      h: "oc_chat",
      e: 3_601_000,
    });
  });

  it("binds outbound actions to the target identity type", () => {
    expect(buildFeishuQuestionTargetContext("chat:oc_chat", 1_000)).toEqual({
      h: "oc_chat",
      e: 3_601_000,
    });
    expect(buildFeishuQuestionTargetContext("user:ou_user", 1_000)).toEqual({
      u: "ou_user",
      e: 3_601_000,
    });
    expect(buildFeishuQuestionTargetContext("user:user_123", 1_000)).toEqual({
      i: "user_123",
      e: 3_601_000,
    });
  });

  it.each([
    {
      result: {
        status: "answered" as const,
        questionId: "question",
        optionValue: "Production",
      },
      feedback: "Answer submitted.",
    },
    {
      result: {
        status: "already-terminal" as const,
        reason: "already-terminal" as const,
      },
      feedback: "This question was already answered.",
    },
  ])("reports Gateway resolution result", async ({ result, feedback }) => {
    const resolveQuestion = vi.fn(async () => result);
    const respond = vi.fn(async () => {});

    await resolveFeishuQuestionAction({
      questionId: "ask_0123456789abcdef0123456789abcdef",
      optionValue: "Production",
      cfg: {},
      accountId: "main",
      userId: "ou_user",
      respond,
      resolveQuestion,
    });

    expect(resolveQuestion).toHaveBeenCalledWith({
      cfg: {},
      questionId: "ask_0123456789abcdef0123456789abcdef",
      optionValue: "Production",
      senderId: "ou_user",
      clientDisplayName: "Feishu question (main)",
    });
    expect(respond).toHaveBeenCalledWith(feedback);
  });

  it("turns Gateway failures into visible retry feedback", async () => {
    const respond = vi.fn(async () => {});

    await resolveFeishuQuestionAction({
      questionId: "ask_0123456789abcdef0123456789abcdef",
      optionValue: "Production",
      cfg: {},
      accountId: "main",
      userId: "ou_user",
      respond,
      resolveQuestion: vi.fn(async () => {
        throw new Error("offline");
      }),
    });

    expect(respond).toHaveBeenCalledWith("Could not submit this answer.");
  });
});
