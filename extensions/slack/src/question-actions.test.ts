// Slack question envelope and feedback tests.
import { describe, expect, it, vi } from "vitest";
import {
  decodeSlackQuestionAction,
  encodeSlackQuestionAction,
  resolveSlackQuestionAction,
} from "./question-actions.js";

describe("Slack question actions", () => {
  const questionId = "ask_0123456789abcdef0123456789abcdef";

  it("round-trips a compact option index within Slack's value limit", () => {
    const value = encodeSlackQuestionAction({ questionId, optionIndex: 3 });

    expect(value).toBe(`slq1:${questionId}:3`);
    expect(value).toHaveLength(43);
    expect(value?.length).toBeLessThanOrEqual(2000);
    expect(decodeSlackQuestionAction(value)).toEqual({ questionId, optionIndex: 3 });
  });

  it.each([
    [{ status: "answered", questionId: "target", optionValue: "Production" }, "Answer submitted."],
    [{ status: "already-terminal", reason: "not-found" }, "This question was already answered."],
  ] as const)("shows ephemeral-ready outcome feedback", async (result, expectedText) => {
    const respond = vi.fn(async () => undefined);

    await resolveSlackQuestionAction({
      action: { questionId, optionIndex: 1 },
      cfg: {} as never,
      accountId: "default",
      userId: "U123",
      respond,
      resolveQuestion: vi.fn(async () => result),
    });

    expect(respond).toHaveBeenCalledWith(expectedText);
  });

  it("does not turn a committed answer into an error when feedback fails", async () => {
    const respond = vi.fn(async () => {
      throw new Error("receipt failed");
    });

    await expect(
      resolveSlackQuestionAction({
        action: { questionId, optionIndex: 1 },
        cfg: {} as never,
        accountId: "default",
        userId: "U123",
        respond,
        resolveQuestion: vi.fn(async () => ({
          status: "answered" as const,
          questionId: "target",
          optionValue: "Production",
        })),
      }),
    ).resolves.toBeUndefined();
    expect(respond).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith("Answer submitted.");
  });
});
