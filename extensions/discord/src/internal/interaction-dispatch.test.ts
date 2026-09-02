// Discord tests cover interaction dispatch plugin behavior.
import {
  ApplicationCommandOptionType,
  ComponentType,
  InteractionResponseType,
  InteractionType,
} from "discord-api-types/v10";
import { describe, expect, it, vi } from "vitest";
import { Command, CommandWithSubcommands } from "./commands.js";
import type { AutocompleteInteraction, CommandInteraction } from "./interactions.js";
import {
  attachRestMock,
  createInternalComponentInteractionPayload,
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

  it("reports a visible failure when a deferred command handler throws", async () => {
    // Regression: a throwing handler used to leave the deferred interaction
    // pending forever, so Discord showed a spinner that never resolved and the
    // only trace was a Gateway log line. See openclaw#77716.
    const run = vi.fn(async () => {
      throw new Error("prepared model catalog owner config was replaced during the read");
    });
    class ThrowingDeferredCommand extends Command {
      override name = "boom";
      override description = "Throwing command";
      override defer = true;
      run = run;
    }
    const client = createInternalTestClient([new ThrowingDeferredCommand()]);
    const post = vi.fn(async () => undefined);
    const patch = vi.fn(async () => undefined);
    attachRestMock(client, { post, patch });

    await expect(
      client.handleInteraction(
        createInternalInteractionPayload({
          id: "interaction1",
          token: "token1",
          data: { id: "command1", name: "boom", type: 1 },
        }),
      ),
    ).rejects.toThrow("prepared model catalog owner config was replaced");

    expect(run).toHaveBeenCalledTimes(1);
    // The deferred response must be resolved with a visible message rather than
    // left hanging; the caller still sees the rejection so it is logged.
    expect(patch).toHaveBeenCalledWith(
      "/webhooks/app1/token1/messages/%40original",
      expect.objectContaining({
        body: expect.objectContaining({
          content: expect.stringContaining("failed"),
          allowed_mentions: { parse: [] },
        }),
      }),
    );
    // The exception text must not reach the channel; it carries the agent dir.
    expect(patch).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        body: expect.objectContaining({
          content: expect.stringContaining("prepared model catalog"),
        }),
      }),
    );
  });

  it("keeps handler exception text out of the channel", async () => {
    // An interaction response is visible to the whole channel, and the notice
    // used to interpolate the exception message. That both disclosed internal
    // detail and let Discord mention-parse whatever the handler threw.
    const run = vi.fn(async () => {
      throw new Error("@everyone broke the catalog at /Users/someone/.openclaw");
    });
    class MentionThrowingCommand extends Command {
      override name = "boom";
      override description = "Throws a mention";
      override defer = true;
      run = run;
    }
    const client = createInternalTestClient([new MentionThrowingCommand()]);
    const post = vi.fn(async () => undefined);
    const patch = vi.fn(async () => undefined);
    attachRestMock(client, { post, patch });

    await expect(
      client.handleInteraction(
        createInternalInteractionPayload({
          id: "interaction1",
          token: "token1",
          data: { id: "command1", name: "boom", type: 1 },
        }),
      ),
    ).rejects.toThrow("@everyone broke the catalog");

    for (const leak of ["@everyone", "/Users/someone/.openclaw"]) {
      expect(patch).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          body: expect.objectContaining({ content: expect.stringContaining(leak) }),
        }),
      );
    }
    expect(patch).toHaveBeenCalledWith(
      "/webhooks/app1/token1/messages/%40original",
      expect.objectContaining({
        body: expect.objectContaining({ allowed_mentions: { parse: [] } }),
      }),
    );
  });

  it("does not add a failure follow-up when the handler already replied", async () => {
    // nextReplyAction() maps `replied` to a follow-up, so an unconditional
    // report would post a second, contradictory message next to the reply the
    // user already received.
    const run = vi.fn(async (interaction: CommandInteraction) => {
      await interaction.reply("partial result");
      throw new Error("failed after replying");
    });
    class RepliesThenThrowsCommand extends Command {
      override name = "boom";
      override description = "Replies then throws";
      override defer = true;
      run = run;
    }
    const client = createInternalTestClient([new RepliesThenThrowsCommand()]);
    // Typed parameters so mock.calls is indexable: the absence assertions below
    // read the request path, which a zero-arity vi.fn() cannot express.
    const post = vi.fn(async (_path: string, _data?: unknown, _query?: unknown) => undefined);
    const patch = vi.fn(async () => undefined);
    attachRestMock(client, { post, patch });

    await expect(
      client.handleInteraction(
        createInternalInteractionPayload({
          id: "interaction1",
          token: "token1",
          data: { id: "command1", name: "boom", type: 1 },
        }),
      ),
    ).rejects.toThrow("failed after replying");

    // Exactly the handler's own two requests: the deferred callback and the
    // edit carrying its reply. Counting them is what makes this an absence
    // assertion -- matching on argument shape silently passes when the follow-up
    // is issued with a different arity.
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]?.[0]).toBe("/interactions/interaction1/token1/callback");
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledWith("/webhooks/app1/token1/messages/%40original", {
      body: { content: "partial result" },
    });
    // A follow-up would POST to the webhook route; nothing may go there.
    expect(post.mock.calls.some(([path]) => path === "/webhooks/app1/token1")).toBe(false);
  });

  it("does not touch the original response when a component acknowledgement fails", async () => {
    // A component acknowledgement is a DeferredMessageUpdate: Discord leaves no
    // spinner, and the interaction's original response IS the message the button
    // is attached to. Editing it would overwrite the message the user is still
    // reading -- destroying live content to report a failure.
    const run = vi.fn(async () => {
      throw new Error("approval resolution exploded");
    });
    const client = createInternalTestClient([]);
    client.componentHandler.register({
      customId: "component1",
      type: ComponentType.Button,
      defer: true,
      ephemeral: false,
      run,
      customIdParser: (id: string) => ({ data: { id } }),
    } as never);
    const post = vi.fn(async () => undefined);
    const patch = vi.fn(async () => undefined);
    attachRestMock(client, { post, patch });

    await expect(
      client.handleInteraction(
        createInternalComponentInteractionPayload({
          id: "interaction1",
          token: "token1",
        }),
      ),
    ).rejects.toThrow("approval resolution exploded");

    expect(run).toHaveBeenCalledTimes(1);
    // The acknowledgement callback is the handler's own. Nothing may edit the
    // component's message afterwards.
    expect(patch).not.toHaveBeenCalled();
  });

  it("does not issue a second callback when nothing was acknowledged", async () => {
    // Response state advances only after a REST success, so an unacknowledged
    // interaction cannot be distinguished from one whose acknowledgement reached
    // Discord but whose response was lost. Replying here would start a fresh
    // rate-limit budget and risk "already acknowledged"; Discord already shows
    // its own "application did not respond" notice.
    const run = vi.fn(async () => {
      throw new Error("exploded before deferring");
    });
    class ImmediateThrowCommand extends Command {
      override name = "boom";
      override description = "Throws immediately";
      override defer = false;
      run = run;
    }
    const client = createInternalTestClient([new ImmediateThrowCommand()]);
    const post = vi.fn(async () => undefined);
    const patch = vi.fn(async () => undefined);
    attachRestMock(client, { post, patch });

    await expect(
      client.handleInteraction(
        createInternalInteractionPayload({
          id: "interaction1",
          token: "token1",
          data: { id: "command1", name: "boom", type: 1 },
        }),
      ),
    ).rejects.toThrow("exploded before deferring");

    expect(run).toHaveBeenCalledTimes(1);
    expect(post).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
  });

  it("does not overwrite output a deferred handler already sent as a follow-up", async () => {
    // followUp() puts a visible message in front of the user without advancing
    // responseState. Discord may have consumed the deferred placeholder to
    // deliver it, so editing the original response could overwrite that output.
    const run = vi.fn(async (interaction: CommandInteraction) => {
      await interaction.followUp("progress");
      throw new Error("failed after follow-up");
    });
    class FollowUpThenThrowsCommand extends Command {
      override name = "boom";
      override description = "Follows up then throws";
      override defer = true;
      run = run;
    }
    const client = createInternalTestClient([new FollowUpThenThrowsCommand()]);
    const post = vi.fn(async () => undefined);
    const patch = vi.fn(async () => undefined);
    attachRestMock(client, { post, patch });

    await expect(
      client.handleInteraction(
        createInternalInteractionPayload({
          id: "interaction1",
          token: "token1",
          data: { id: "command1", name: "boom", type: 1 },
        }),
      ),
    ).rejects.toThrow("failed after follow-up");

    expect(patch).not.toHaveBeenCalled();
  });

  it("does not overwrite a follow-up that was still in flight when the handler threw", async () => {
    // The handler starts a follow-up without awaiting it, then throws. Read
    // outside the response queue, hasSentFollowUp is still false at that moment,
    // because it is only set once the follow-up REST call resolves. The edit
    // re-reads it inside the queue, after the follow-up has settled.
    let releaseFollowUp: (() => void) | undefined;
    // The first post is the deferred callback and must resolve, or the handler
    // never runs. Only the follow-up that follows it is held open.
    let posts = 0;
    const post = vi.fn(async () => {
      posts += 1;
      if (posts === 1) {
        return undefined;
      }
      return await new Promise<undefined>((resolve) => {
        releaseFollowUp = () => resolve(undefined);
      });
    });
    const patch = vi.fn(async () => undefined);
    const run = vi.fn((interaction: CommandInteraction) => {
      void interaction.followUp("progress").catch(() => undefined);
      return Promise.reject(new Error("failed with a follow-up in flight"));
    });
    class RacingFollowUpCommand extends Command {
      override name = "boom";
      override description = "Throws with a follow-up in flight";
      override defer = true;
      run = run as unknown as Command["run"];
    }
    const client = createInternalTestClient([new RacingFollowUpCommand()]);
    attachRestMock(client, { post, patch });

    const handled = client.handleInteraction(
      createInternalInteractionPayload({
        id: "interaction1",
        token: "token1",
        data: { id: "command1", name: "boom", type: 1 },
      }),
    );
    await vi.waitFor(() => expect(releaseFollowUp).toBeDefined());
    releaseFollowUp?.();

    await expect(handled).rejects.toThrow("failed with a follow-up in flight");
    expect(post).toHaveBeenCalledTimes(2);
    expect(patch).not.toHaveBeenCalled();
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
