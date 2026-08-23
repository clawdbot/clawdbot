// Discord question component feedback tests.
import { describe, expect, it, vi } from "vitest";
import type { ButtonInteraction } from "../internal/discord.js";
import { createDiscordQuestionButton } from "./questions.js";

type InteractionHarness = {
  interaction: ButtonInteraction;
  acknowledge: ReturnType<typeof vi.fn>;
  followUp: ReturnType<typeof vi.fn>;
};

function createInteraction(): InteractionHarness {
  const acknowledge = vi.fn();
  const followUp = vi.fn();
  const interaction = {
    userId: "user-1",
    reply: vi.fn(),
    acknowledge,
    followUp,
  } as unknown as ButtonInteraction;
  return { interaction, acknowledge, followUp };
}

describe("Discord question button", () => {
  it.each([
    [{ status: "answered", questionId: "target", optionValue: "Production" }, "Answer submitted."],
    [
      { status: "already-terminal", reason: "already-terminal" },
      "This question was already answered.",
    ],
  ] as const)("shows ephemeral outcome feedback", async (result, expectedText) => {
    const { interaction, acknowledge, followUp } = createInteraction();
    const button = createDiscordQuestionButton({
      cfg: {} as never,
      accountId: "default",
      authorizeQuestion: vi.fn(async () => true),
      resolveQuestion: vi.fn(async () => result),
    });

    await button.run(interaction, {
      id: "ask_0123456789abcdef0123456789abcdef",
      i: "1",
    });

    expect(acknowledge).toHaveBeenCalledOnce();
    expect(followUp).toHaveBeenCalledWith({ content: expectedText, ephemeral: true });
  });

  it("does not resolve unauthorized clicks", async () => {
    const { interaction, acknowledge } = createInteraction();
    const resolveQuestion = vi.fn();
    const button = createDiscordQuestionButton({
      cfg: {} as never,
      accountId: "default",
      authorizeQuestion: vi.fn(async () => false),
      resolveQuestion,
    });

    await button.run(interaction, {
      id: "ask_0123456789abcdef0123456789abcdef",
      i: "1",
    });

    expect(resolveQuestion).not.toHaveBeenCalled();
    expect(acknowledge).not.toHaveBeenCalled();
  });

  it("does not turn a committed answer into an error when feedback fails", async () => {
    const { interaction, followUp } = createInteraction();
    followUp.mockRejectedValue(new Error("receipt failed"));
    const button = createDiscordQuestionButton({
      cfg: {} as never,
      accountId: "default",
      authorizeQuestion: vi.fn(async () => true),
      resolveQuestion: vi.fn(async () => ({
        status: "answered" as const,
        questionId: "target",
        optionValue: "Production",
      })),
    });

    await expect(
      button.run(interaction, {
        id: "ask_0123456789abcdef0123456789abcdef",
        i: "1",
      }),
    ).resolves.toBeUndefined();
    expect(followUp).toHaveBeenCalledOnce();
    expect(followUp).toHaveBeenCalledWith({
      content: "Answer submitted.",
      ephemeral: true,
    });
  });
});
