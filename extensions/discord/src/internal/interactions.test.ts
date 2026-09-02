// Discord tests cover interactions plugin behavior.
import {
  ComponentType,
  type GuildMemberFlags,
  InteractionResponseType,
  InteractionType,
  MessageFlags,
} from "discord-api-types/v10";
import { describe, expect, it, vi } from "vitest";
import { Container, TextDisplay } from "./components.js";
import {
  AutocompleteInteraction,
  BaseComponentInteraction,
  ModalInteraction,
  createInteraction,
  type RawInteraction,
} from "./interactions.js";
import { Message } from "./structures.js";
import {
  attachRestMock,
  createInternalComponentInteractionPayload,
  createInternalInteractionPayload,
  createInternalModalInteractionPayload,
  createInternalTestClient,
} from "./test-builders.test-support.js";

describe("BaseInteraction", () => {
  it.each([
    {
      name: "command reply",
      kind: "command",
      operation: "reply",
      callbackType: InteractionResponseType.ChannelMessageWithSource,
    },
    {
      name: "command defer",
      kind: "command",
      operation: "defer",
      callbackType: InteractionResponseType.DeferredChannelMessageWithSource,
    },
    {
      name: "component acknowledgment",
      kind: "component",
      operation: "acknowledge",
      callbackType: InteractionResponseType.DeferredMessageUpdate,
    },
    {
      name: "component update",
      kind: "component",
      operation: "update",
      callbackType: InteractionResponseType.UpdateMessage,
    },
    {
      name: "component modal",
      kind: "component",
      operation: "show-modal",
      callbackType: InteractionResponseType.Modal,
    },
    {
      name: "component activity",
      kind: "component",
      operation: "launch-activity",
      callbackType: InteractionResponseType.LaunchActivity,
    },
    {
      name: "modal acknowledgment",
      kind: "modal",
      operation: "acknowledge",
      callbackType: InteractionResponseType.DeferredMessageUpdate,
    },
    {
      name: "command autocomplete",
      kind: "autocomplete",
      operation: "autocomplete",
      callbackType: InteractionResponseType.ApplicationCommandAutocompleteResult,
    },
  ] as const)("keeps a rejected $name eligible for its initial callback", async (testCase) => {
    const failure = new Error("Discord rejected the interaction callback");
    const post = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined);
    const patch = vi.fn(async () => undefined);
    const client = createInternalTestClient();
    attachRestMock(client, { patch, post });
    const identity = { id: "interaction1", token: "token1" };
    const payload =
      testCase.kind === "component"
        ? createInternalComponentInteractionPayload(identity)
        : testCase.kind === "modal"
          ? createInternalModalInteractionPayload(identity)
          : createInternalInteractionPayload({
              ...identity,
              ...(testCase.kind === "autocomplete"
                ? { type: InteractionType.ApplicationCommandAutocomplete }
                : {}),
            });
    const interaction = createInteraction(client, payload);

    const sendInitialCallback = () => {
      switch (testCase.operation) {
        case "reply":
          return interaction.reply("first");
        case "defer":
          return interaction.defer();
        case "acknowledge":
          return interaction.acknowledge();
        case "update":
          if (!(interaction instanceof BaseComponentInteraction)) {
            throw new Error("expected a component interaction");
          }
          return interaction.update("first");
        case "show-modal":
          if (!(interaction instanceof BaseComponentInteraction)) {
            throw new Error("expected a component interaction");
          }
          return interaction.showModal({ serialize: () => ({ title: "Choose" }) });
        case "launch-activity":
          if (!(interaction instanceof BaseComponentInteraction)) {
            throw new Error("expected a component interaction");
          }
          return interaction.launchActivity();
        case "autocomplete":
          if (!(interaction instanceof AutocompleteInteraction)) {
            throw new Error("expected an autocomplete interaction");
          }
          return interaction.respond([{ name: "Choice", value: "choice" }]);
        default:
          throw new Error("expected a supported interaction callback");
      }
    };

    await expect(sendInitialCallback()).rejects.toBe(failure);
    expect(interaction.responseState).toBe("unacknowledged");
    expect(interaction.acknowledged).toBe(false);

    if (testCase.operation === "autocomplete") {
      await sendInitialCallback();
    } else {
      await interaction.reply("recovered");
    }

    expect(post).toHaveBeenNthCalledWith(
      1,
      "/interactions/interaction1/token1/callback",
      expect.objectContaining({ body: expect.objectContaining({ type: testCase.callbackType }) }),
    );
    expect(post).toHaveBeenNthCalledWith(2, "/interactions/interaction1/token1/callback", {
      body:
        testCase.operation === "autocomplete"
          ? {
              type: InteractionResponseType.ApplicationCommandAutocompleteResult,
              data: { choices: [{ name: "Choice", value: "choice" }] },
            }
          : {
              type: InteractionResponseType.ChannelMessageWithSource,
              data: { content: "recovered" },
            },
    });
    expect(patch).not.toHaveBeenCalled();
    expect(interaction.responseState).toBe("replied");
  });

  it("waits for provider acceptance before recording a deferred interaction", async () => {
    let acceptCallback!: () => void;
    const accepted = new Promise<void>((resolve) => {
      acceptCallback = resolve;
    });
    const post = vi.fn(() => accepted);
    const client = createInternalTestClient();
    attachRestMock(client, { post });
    const interaction = createInteraction(
      client,
      createInternalInteractionPayload({ id: "interaction1", token: "token1" }),
    );

    const pending = interaction.defer();
    const stateBeforeAcceptance = interaction.responseState;
    acceptCallback();
    await pending;

    expect(stateBeforeAcceptance).toBe("unacknowledged");
    expect(interaction.responseState).toBe("deferred");
    expect(interaction.acknowledged).toBe(true);
  });

  it.each([
    { first: "accepted", nextRoute: "/webhooks/app1/token1" },
    { first: "rejected", nextRoute: "/interactions/interaction1/token1/callback" },
  ] as const)(
    "serializes concurrent replies after the first callback is $first",
    async (testCase) => {
      let acceptFirst!: () => void;
      let rejectFirst!: (error: Error) => void;
      const firstResponse = new Promise<void>((resolve, reject) => {
        acceptFirst = resolve;
        rejectFirst = reject;
      });
      const post = vi
        .fn()
        .mockImplementationOnce(() => firstResponse)
        .mockResolvedValue(undefined);
      const client = createInternalTestClient();
      attachRestMock(client, { post });
      const interaction = createInteraction(
        client,
        createInternalInteractionPayload({ id: "interaction1", token: "token1" }),
      );

      const first = interaction.reply("first");
      await vi.waitFor(() => expect(post).toHaveBeenCalledOnce());
      const second = interaction.reply("second");
      const callsBeforeAcceptance = post.mock.calls.length;
      const settled = Promise.allSettled([first, second]);
      if (testCase.first === "accepted") {
        acceptFirst();
      } else {
        rejectFirst(new Error("Discord rejected the first callback"));
      }

      const [firstResult, secondResult] = await settled;
      expect(callsBeforeAcceptance).toBe(1);
      expect(firstResult.status).toBe(testCase.first === "accepted" ? "fulfilled" : "rejected");
      expect(secondResult.status).toBe("fulfilled");
      expect(post).toHaveBeenNthCalledWith(1, "/interactions/interaction1/token1/callback", {
        body: {
          type: InteractionResponseType.ChannelMessageWithSource,
          data: { content: "first" },
        },
      });
      if (testCase.first === "accepted") {
        expect(post).toHaveBeenNthCalledWith(
          2,
          testCase.nextRoute,
          { body: { content: "second" } },
          undefined,
        );
      } else {
        expect(post).toHaveBeenNthCalledWith(2, testCase.nextRoute, {
          body: {
            type: InteractionResponseType.ChannelMessageWithSource,
            data: { content: "second" },
          },
        });
      }
      expect(interaction.responseState).toBe("replied");
    },
  );

  it("waits for the accepted initial callback before an explicit follow-up", async () => {
    let acceptFirst!: () => void;
    const firstResponse = new Promise<void>((resolve) => {
      acceptFirst = resolve;
    });
    const post = vi
      .fn()
      .mockImplementationOnce(() => firstResponse)
      .mockResolvedValue(undefined);
    const client = createInternalTestClient();
    attachRestMock(client, { post });
    const interaction = createInteraction(
      client,
      createInternalInteractionPayload({ id: "interaction1", token: "token1" }),
    );

    const initial = interaction.reply("first");
    await vi.waitFor(() => expect(post).toHaveBeenCalledOnce());
    const followUp = interaction.followUp("second");
    const callsBeforeAcceptance = post.mock.calls.length;
    acceptFirst();
    await Promise.all([initial, followUp]);

    expect(callsBeforeAcceptance).toBe(1);
    expect(post).toHaveBeenNthCalledWith(
      2,
      "/webhooks/app1/token1",
      { body: { content: "second" } },
      undefined,
    );
  });

  it.each([
    { kind: "command", operation: "defer" },
    { kind: "component", operation: "defer" },
    { kind: "component", operation: "acknowledge" },
    { kind: "component", operation: "update" },
    { kind: "component", operation: "show-modal" },
    { kind: "component", operation: "launch-activity" },
    { kind: "modal", operation: "defer" },
    { kind: "modal", operation: "acknowledge" },
    { kind: "autocomplete", operation: "autocomplete" },
  ] as const)(
    "rejects a second initial $kind $operation without calling Discord",
    async (testCase) => {
      const post = vi.fn(async () => undefined);
      const client = createInternalTestClient();
      attachRestMock(client, { post });
      const identity = { id: "interaction1", token: "token1" };
      const raw =
        testCase.kind === "component"
          ? createInternalComponentInteractionPayload(identity)
          : testCase.kind === "modal"
            ? createInternalModalInteractionPayload(identity)
            : createInternalInteractionPayload({
                ...identity,
                ...(testCase.kind === "autocomplete"
                  ? { type: InteractionType.ApplicationCommandAutocomplete }
                  : {}),
              });
      const interaction = createInteraction(client, raw);
      const first =
        testCase.kind === "autocomplete" && interaction instanceof AutocompleteInteraction
          ? interaction.respond([{ name: "First", value: "first" }])
          : interaction.reply("first");
      const next = () => {
        switch (testCase.operation) {
          case "defer":
            return interaction.defer();
          case "acknowledge":
            return interaction.acknowledge();
          case "update":
            if (!(interaction instanceof BaseComponentInteraction)) {
              throw new Error("expected a component interaction");
            }
            return interaction.update("second");
          case "show-modal":
            if (!(interaction instanceof BaseComponentInteraction)) {
              throw new Error("expected a component interaction");
            }
            return interaction.showModal({ serialize: () => ({ title: "Choose" }) });
          case "launch-activity":
            if (!(interaction instanceof BaseComponentInteraction)) {
              throw new Error("expected a component interaction");
            }
            return interaction.launchActivity();
          case "autocomplete":
            if (!(interaction instanceof AutocompleteInteraction)) {
              throw new Error("expected an autocomplete interaction");
            }
            return interaction.respond([{ name: "Second", value: "second" }]);
          default:
            throw new Error("expected an initial interaction callback");
        }
      };

      const [firstResult, secondResult] = await Promise.allSettled([first, next()]);
      expect(firstResult.status).toBe("fulfilled");
      expect(secondResult.status).toBe("rejected");
      if (secondResult.status === "rejected") {
        expect(secondResult.reason).toMatchObject({
          message: expect.stringMatching(/already.*acknowledg/i),
        });
      }
      expect(post).toHaveBeenCalledOnce();
      expect(interaction.acknowledged).toBe(true);
    },
  );

  it("waits for the initial response before fetching the original reply", async () => {
    let acceptFirst!: () => void;
    const firstResponse = new Promise<void>((resolve) => {
      acceptFirst = resolve;
    });
    const post = vi.fn(() => firstResponse);
    const get = vi.fn(async () => ({ id: "message1" }));
    const client = createInternalTestClient();
    attachRestMock(client, { get, post });
    const interaction = createInteraction(
      client,
      createInternalInteractionPayload({ id: "interaction1", token: "token1" }),
    );

    const initial = interaction.reply("first");
    await vi.waitFor(() => expect(post).toHaveBeenCalledOnce());
    const fetched = interaction.fetchReply();
    const fetchesBeforeAcceptance = get.mock.calls.length;
    acceptFirst();

    await expect(Promise.all([initial, fetched])).resolves.toEqual([undefined, { id: "message1" }]);
    expect(fetchesBeforeAcceptance).toBe(0);
    expect(get).toHaveBeenCalledWith("/webhooks/app1/token1/messages/%40original");
  });

  it("keeps response transactions independent for different interactions", async () => {
    let acceptFirst!: () => void;
    const firstResponse = new Promise<void>((resolve) => {
      acceptFirst = resolve;
    });
    const post = vi
      .fn()
      .mockImplementationOnce(() => firstResponse)
      .mockResolvedValue(undefined);
    const client = createInternalTestClient();
    attachRestMock(client, { post });
    const firstInteraction = createInteraction(
      client,
      createInternalInteractionPayload({ id: "interaction1", token: "token1" }),
    );
    const secondInteraction = createInteraction(
      client,
      createInternalInteractionPayload({ id: "interaction2", token: "token2" }),
    );

    const first = firstInteraction.reply("first");
    await vi.waitFor(() => expect(post).toHaveBeenCalledOnce());
    await secondInteraction.reply("second");
    expect(firstInteraction.responseState).toBe("unacknowledged");
    expect(secondInteraction.responseState).toBe("replied");
    acceptFirst();
    await first;

    expect(post).toHaveBeenNthCalledWith(2, "/interactions/interaction2/token2/callback", {
      body: { type: InteractionResponseType.ChannelMessageWithSource, data: { content: "second" } },
    });
  });

  it("edits the original interaction response after defer", async () => {
    const post = vi.fn(async () => undefined);
    const patch = vi.fn(async () => undefined);
    const client = createInternalTestClient();
    attachRestMock(client, { patch, post });
    const interaction = createInteraction(
      client,
      createInternalInteractionPayload({ id: "interaction1", token: "token1" }),
    );

    await interaction.defer({ ephemeral: true });
    await interaction.reply({ content: "done", ephemeral: true });

    expect(post).toHaveBeenNthCalledWith(1, "/interactions/interaction1/token1/callback", {
      body: {
        type: InteractionResponseType.DeferredChannelMessageWithSource,
        data: { flags: 64 },
      },
    });
    expect(patch).toHaveBeenCalledWith("/webhooks/app1/token1/messages/%40original", {
      body: { content: "done", flags: 64 },
    });
  });

  it("deletes the original interaction response after defer", async () => {
    const del = vi.fn(async () => undefined);
    const post = vi.fn(async () => undefined);
    const client = createInternalTestClient();
    attachRestMock(client, { delete: del, post });
    const interaction = createInteraction(
      client,
      createInternalInteractionPayload({ id: "interaction1", token: "token1" }),
    );

    await interaction.defer();
    expect(interaction.responseState).toBe("deferred");
    await interaction.deleteReply();

    expect(del).toHaveBeenCalledWith("/webhooks/app1/token1/messages/%40original");
    expect(interaction.responseState).toBe("replied");
  });

  it("uses with_components for Components V2 follow-ups", async () => {
    const post = vi.fn(async () => undefined);
    const client = createInternalTestClient();
    attachRestMock(client, { post });
    const interaction = createInteraction(
      client,
      createInternalInteractionPayload({ id: "interaction1", token: "token1" }),
    );

    await interaction.reply("first");
    await interaction.reply({
      components: [new Container([new TextDisplay("done")])],
    });

    expect(post).toHaveBeenNthCalledWith(
      2,
      "/webhooks/app1/token1",
      {
        body: {
          components: [
            {
              type: 17,
              components: [{ type: 10, content: "done" }],
            },
          ],
          flags: MessageFlags.IsComponentsV2,
        },
      },
      { with_components: true },
    );
  });

  it("uses with_components when editing deferred Components V2 replies", async () => {
    const post = vi.fn(async () => undefined);
    const patch = vi.fn(async () => undefined);
    const client = createInternalTestClient();
    attachRestMock(client, { patch, post });
    const interaction = createInteraction(
      client,
      createInternalInteractionPayload({ id: "interaction1", token: "token1" }),
    );

    await interaction.defer();
    await interaction.reply({
      components: [new Container([new TextDisplay("done")])],
    });

    expect(patch).toHaveBeenCalledWith(
      "/webhooks/app1/token1/messages/%40original",
      {
        body: {
          components: [
            {
              type: 17,
              components: [{ type: 10, content: "done" }],
            },
          ],
          flags: MessageFlags.IsComponentsV2,
        },
      },
      { with_components: true },
    );
  });

  it("edits the original component message after acknowledge", async () => {
    const post = vi.fn(async () => undefined);
    const patch = vi.fn(async () => undefined);
    const client = createInternalTestClient();
    attachRestMock(client, { patch, post });
    const interaction = createInteraction(
      client,
      createInternalComponentInteractionPayload({
        id: "interaction1",
        token: "token1",
        data: {
          component_type: ComponentType.Button,
          custom_id: "button1",
        },
      }),
    );

    await interaction.acknowledge();
    await interaction.reply({ content: "updated", components: [] });

    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith("/interactions/interaction1/token1/callback", {
      body: { type: InteractionResponseType.DeferredMessageUpdate },
    });
    expect(patch).toHaveBeenCalledWith("/webhooks/app1/token1/messages/%40original", {
      body: { content: "updated", components: [] },
    });
  });

  it("rejects malformed interaction payloads at the boundary", () => {
    expect(() =>
      createInteraction(createInternalTestClient(), {
        id: "interaction1",
        type: 3,
      } as unknown as RawInteraction),
    ).toThrow(/Invalid Discord interaction payload/);
  });

  it("preserves guild member user identity fields", () => {
    const interaction = createInteraction(
      createInternalTestClient(),
      createInternalInteractionPayload({
        id: "interaction1",
        token: "token1",
        type: InteractionType.ApplicationCommand,
        guild_id: "guild1",
        member: {
          roles: [],
          permissions: "0",
          flags: 0 as GuildMemberFlags,
          joined_at: "2026-01-01T00:00:00.000Z",
          deaf: false,
          mute: false,
          user: {
            id: "user1",
            username: "alice",
            global_name: "Alice Cooper",
            discriminator: "1234",
            avatar: null,
          },
        },
      }),
    );

    expect(interaction.user?.id).toBe("user1");
    expect(interaction.user?.username).toBe("alice");
    expect(interaction.user?.globalName).toBe("Alice Cooper");
    expect(interaction.user?.discriminator).toBe("1234");
  });

  it("waits for a one-off component reply without invoking registered handlers", async () => {
    const get = vi.fn(async () => ({
      id: "message1",
      channel_id: "channel1",
      author: {
        id: "bot1",
        username: "bot",
        discriminator: "0000",
        global_name: null,
        avatar: null,
      },
      content: "pick",
      timestamp: "2026-05-01T00:00:00.000Z",
    }));
    const post = vi.fn(async () => undefined);
    const client = createInternalTestClient();
    attachRestMock(client, { get, post });
    const interaction = createInteraction(
      client,
      createInternalInteractionPayload({ id: "interaction1", token: "token1" }),
    );

    const wait = interaction.replyAndWaitForComponent({ content: "pick" }, 1_000);
    await vi.waitFor(() =>
      expect(get).toHaveBeenCalledWith("/webhooks/app1/token1/messages/%40original"),
    );

    await client.handleInteraction(
      createInternalComponentInteractionPayload({
        id: "component-interaction1",
        token: "component-token1",
        data: { custom_id: "button1" },
        message: {
          id: "message1",
          channel_id: "channel1",
          author: {
            id: "bot1",
            username: "bot",
            discriminator: "0000",
            global_name: null,
            avatar: null,
          },
          content: "pick",
          timestamp: "2026-05-01T00:00:00.000Z",
          edited_timestamp: null,
          tts: false,
          mention_everyone: false,
          mentions: [],
          mention_roles: [],
          attachments: [],
          embeds: [],
          pinned: false,
          type: 0,
        },
      }),
    );

    const result = await wait;
    if (!result.success) {
      throw new Error("expected component wait to succeed");
    }
    expect(result.customId).toBe("button1");
    expect(result.message).toBeInstanceOf(Message);
    expect(result.message?.id).toBe("message1");
    expect(result.message?.channelId).toBe("channel1");
    expect(result.values).toBeUndefined();
    expect(post).toHaveBeenNthCalledWith(
      2,
      "/interactions/component-interaction1/component-token1/callback",
      {
        body: { type: InteractionResponseType.DeferredMessageUpdate },
      },
    );
  });
});

describe("ModalInteraction", () => {
  it("reads submitted fields from Components V2 label wrappers", () => {
    const interaction = createInteraction(
      createInternalTestClient(),
      createInternalModalInteractionPayload({
        id: "interaction1",
        token: "token1",
        data: {
          components: [
            {
              type: ComponentType.Label,
              component: {
                type: ComponentType.TextInput,
                custom_id: "title",
                value: "Hello",
              },
            },
          ],
        },
      }),
    );

    expect(interaction).toBeInstanceOf(ModalInteraction);
    expect((interaction as ModalInteraction).fields.getText("title")).toBe("Hello");
  });

  it("acknowledges modal submits as message updates", async () => {
    const post = vi.fn(async () => undefined);
    const client = createInternalTestClient();
    attachRestMock(client, { post });
    const interaction = createInteraction(
      client,
      createInternalModalInteractionPayload({
        id: "interaction1",
        token: "token1",
      }),
    );

    await (interaction as ModalInteraction).acknowledge();

    expect(post).toHaveBeenCalledWith("/interactions/interaction1/token1/callback", {
      body: { type: InteractionResponseType.DeferredMessageUpdate },
    });
  });

  it("edits the original modal source message after acknowledge", async () => {
    const post = vi.fn(async () => undefined);
    const patch = vi.fn(async () => undefined);
    const client = createInternalTestClient();
    attachRestMock(client, { patch, post });
    const interaction = createInteraction(
      client,
      createInternalModalInteractionPayload({
        id: "interaction1",
        token: "token1",
      }),
    );

    await (interaction as ModalInteraction).acknowledge();
    await interaction.reply({ content: "cleared", components: [] });

    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith("/interactions/interaction1/token1/callback", {
      body: { type: InteractionResponseType.DeferredMessageUpdate },
    });
    expect(patch).toHaveBeenCalledWith("/webhooks/app1/token1/messages/%40original", {
      body: { content: "cleared", components: [] },
    });
  });
});
