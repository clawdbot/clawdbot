import {
  ApplicationCommandOptionType,
  InteractionResponseType,
  InteractionType,
} from "discord-api-types/v10";
import { describe, expect, it, vi } from "vitest";
import { Command, CommandWithSubcommands } from "./commands.js";
import type { AutocompleteInteraction, CommandInteraction } from "./interactions.js";
import {
  attachRestMock,
  createInternalInteractionPayload,
  createInternalTestClient,
} from "./test-builders.test-support.js";

describe("dispatchInteraction", () => {
  it("passes command ephemeral defaults into deferred responses", async () => {
    const run = vi.fn(async (interaction: CommandInteraction) => {
      await interaction.reply("done");
    });
    class DeferredCommand extends Command {
      override name = "deferred";
      override description = "Deferred command";
      override defer = true;
      override ephemeral = true;
      run = run;
    }
    const client = createInternalTestClient([new DeferredCommand()]);
    const post = vi.fn(async () => undefined);
    const patch = vi.fn(async () => undefined);
    attachRestMock(client, { post, patch });

    await client.handleInteraction(
      createInternalInteractionPayload({
        id: "interaction1",
        token: "token1",
        data: { id: "command1", name: "deferred", type: 1 },
      }),
    );

    expect(post).toHaveBeenNthCalledWith(1, "/interactions/interaction1/token1/callback", {
      body: {
        type: InteractionResponseType.DeferredChannelMessageWithSource,
        data: { flags: 64 },
      },
    });
    expect(patch).toHaveBeenCalledWith("/webhooks/app1/token1/messages/%40original", {
      body: { content: "done" },
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("dispatches the focused option autocomplete handler", async () => {
    const optionAutocomplete = vi.fn(async (interaction: AutocompleteInteraction) => {
      await interaction.respond([{ name: "alpha", value: "alpha" }]);
    });
    class OptionAutocompleteCommand extends Command {
      override name = "choose";
      override description = "Choose";
      override options = [
        {
          name: "model",
          description: "Model",
          type: ApplicationCommandOptionType.String,
          autocomplete: optionAutocomplete,
        },
      ];
      run() {}
    }
    const client = createInternalTestClient([new OptionAutocompleteCommand()]);
    const post = vi.fn(async () => undefined);
    attachRestMock(client, { post });

    await client.handleInteraction(
      createInternalInteractionPayload({
        id: "interaction1",
        token: "token1",
        type: InteractionType.ApplicationCommandAutocomplete,
        data: {
          id: "command1",
          name: "choose",
          type: 1,
          options: [
            {
              name: "model",
              type: ApplicationCommandOptionType.String,
              value: "a",
              focused: true,
            },
          ],
        },
      }),
    );

    expect(optionAutocomplete).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith("/interactions/interaction1/token1/callback", {
      body: {
        type: InteractionResponseType.ApplicationCommandAutocompleteResult,
        data: { choices: [{ name: "alpha", value: "alpha" }] },
      },
    });
  });

  it("defers selected subcommands before running them", async () => {
    const run = vi.fn(async (interaction: CommandInteraction) => {
      await interaction.reply("joined");
    });
    class JoinCommand extends Command {
      override name = "join";
      override description = "Join";
      override defer = true;
      override ephemeral = true;
      run = run;
    }
    class VoiceCommand extends CommandWithSubcommands {
      override name = "vc";
      override description = "Voice";
      subcommands = [new JoinCommand()];
    }
    const client = createInternalTestClient([new VoiceCommand()]);
    const post = vi.fn(async () => undefined);
    const patch = vi.fn(async () => undefined);
    attachRestMock(client, { post, patch });

    await client.handleInteraction(
      createInternalInteractionPayload({
        id: "interaction1",
        token: "token1",
        data: {
          id: "command1",
          name: "vc",
          type: 1,
          options: [{ name: "join", type: ApplicationCommandOptionType.Subcommand }],
        },
      }),
    );

    expect(post).toHaveBeenNthCalledWith(1, "/interactions/interaction1/token1/callback", {
      body: {
        type: InteractionResponseType.DeferredChannelMessageWithSource,
        data: { flags: 64 },
      },
    });
    expect(patch).toHaveBeenCalledWith("/webhooks/app1/token1/messages/%40original", {
      body: { content: "joined" },
    });
    expect(run).toHaveBeenCalledTimes(1);
  });
});
