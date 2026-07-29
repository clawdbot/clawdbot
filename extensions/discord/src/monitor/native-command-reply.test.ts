// Discord tests cover native command reply plugin behavior.
import { describe, expect, it, vi } from "vitest";
import { Container, TextDisplay } from "../internal/discord.js";
import {
  deliverDiscordInteractionReply,
  hasRenderableReplyPayload,
  settleDiscordInteractionWithoutVisibleReply,
} from "./native-command-reply.js";

function createInteraction() {
  return {
    reply: vi.fn().mockResolvedValue({ ok: true }),
    followUp: vi.fn().mockResolvedValue({ ok: true }),
  };
}

describe("deliverDiscordInteractionReply", () => {
  it("sends component-only native command replies as follow-ups", async () => {
    const interaction = createInteraction();
    const components = [new Container([new TextDisplay("Pick a model")])];
    const payload = {
      channelData: {
        discord: {
          components,
        },
      },
    };

    expect(hasRenderableReplyPayload(payload)).toBe(true);

    await deliverDiscordInteractionReply({
      interaction: interaction as never,
      payload,
      textLimit: 2000,
      preferFollowUp: true,
      responseEphemeral: true,
      chunkMode: "length",
    });

    expect(interaction.followUp).toHaveBeenCalledWith({
      components,
      ephemeral: true,
    });
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it("sends component-only native command replies through the initial reply when not deferred", async () => {
    const interaction = createInteraction();
    const components = [new Container([new TextDisplay("Choose an action")])];

    await deliverDiscordInteractionReply({
      interaction: interaction as never,
      payload: {
        channelData: {
          discord: {
            components,
          },
        },
      },
      textLimit: 2000,
      preferFollowUp: false,
      chunkMode: "length",
    });

    expect(interaction.reply).toHaveBeenCalledWith({
      components,
    });
    expect(interaction.followUp).not.toHaveBeenCalled();
  });
});

describe("settleDiscordInteractionWithoutVisibleReply", () => {
  it("deletes a deferred slash-command loading response", async () => {
    const interaction = {
      responseState: "deferred",
      deleteReply: vi.fn().mockResolvedValue(undefined),
    };

    await settleDiscordInteractionWithoutVisibleReply(interaction as never);

    expect(interaction.deleteReply).toHaveBeenCalledTimes(1);
  });

  it.each(["unacknowledged", "deferred-update", "replied"])(
    "does not delete an interaction in the %s state",
    async (responseState) => {
      const interaction = {
        responseState,
        deleteReply: vi.fn().mockResolvedValue(undefined),
      };

      await settleDiscordInteractionWithoutVisibleReply(interaction as never);

      expect(interaction.deleteReply).not.toHaveBeenCalled();
    },
  );
});
