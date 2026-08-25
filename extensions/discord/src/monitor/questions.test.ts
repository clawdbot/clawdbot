// Discord question component feedback tests.
import { InteractionResponseType, MessageFlags } from "discord-api-types/v10";
import { describe, expect, it, vi } from "vitest";
import {
  createInteraction as createDiscordInteraction,
  type ButtonInteraction,
} from "../internal/discord.js";
import {
  attachRestMock,
  createInternalComponentInteractionPayload,
  createInternalTestClient,
} from "../internal/test-builders.test-support.js";
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

  it.each(
    [
      {
        name: "submitted answer",
        result: {
          status: "answered" as const,
          questionId: "target",
          optionValue: "Production",
        },
        expectedText: "Answer submitted.",
      },
      {
        name: "already answered question",
        result: { status: "already-terminal" as const, reason: "already-terminal" as const },
        expectedText: "This question was already answered.",
      },
      {
        name: "question resolution failure",
        error: new Error("question service unavailable"),
        expectedText: "Could not submit this answer.",
      },
    ].flatMap((outcome) => [
      { ...outcome, acknowledged: false },
      { ...outcome, acknowledged: true },
    ]),
  )("delivers $name feedback when acknowledgement is $acknowledged", async (testCase) => {
    const client = createInternalTestClient();
    const post = vi.fn(async () => undefined);
    if (!testCase.acknowledged) {
      post.mockRejectedValueOnce(new Error("temporary connection reset"));
    }
    attachRestMock(client, { post });
    const interaction = createDiscordInteraction(
      client,
      createInternalComponentInteractionPayload({
        id: "interaction-1",
        token: "interaction-token",
        user: {
          id: "user-1",
          username: "Alice",
          discriminator: "0",
          avatar: null,
          global_name: null,
        },
      }),
    ) as ButtonInteraction;
    const resolveQuestion = vi.fn(async () => {
      if (testCase.error) {
        throw testCase.error;
      }
      return testCase.result;
    });
    const button = createDiscordQuestionButton({
      cfg: {} as never,
      accountId: "default",
      authorizeQuestion: vi.fn(async () => true),
      resolveQuestion: resolveQuestion as never,
    });

    await button.run(interaction, {
      id: "ask_0123456789abcdef0123456789abcdef",
      i: "1",
    });

    expect(resolveQuestion).toHaveBeenCalledOnce();
    expect(post).toHaveBeenNthCalledWith(
      1,
      "/interactions/interaction-1/interaction-token/callback",
      {
        body: { type: InteractionResponseType.DeferredMessageUpdate },
      },
    );
    if (testCase.acknowledged) {
      expect(post).toHaveBeenNthCalledWith(
        2,
        "/webhooks/app1/interaction-token",
        { body: { content: testCase.expectedText, flags: MessageFlags.Ephemeral } },
        undefined,
      );
      expect(interaction.responseState).toBe("deferred-update");
    } else {
      expect(post).toHaveBeenNthCalledWith(
        2,
        "/interactions/interaction-1/interaction-token/callback",
        {
          body: {
            type: InteractionResponseType.ChannelMessageWithSource,
            data: { content: testCase.expectedText, flags: MessageFlags.Ephemeral },
          },
        },
      );
      expect(interaction.responseState).toBe("replied");
    }
  });
});
