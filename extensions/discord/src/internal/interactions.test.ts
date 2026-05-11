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
  BaseInteraction,
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
  it("edits the original interaction response after defer", async () => {
    const post = vi.fn(async () => undefined);
    const patch = vi.fn(async () => undefined);
    const client = createInternalTestClient();
    attachRestMock(client, { patch, post });
    const interaction = new BaseInteraction(
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

  it("uses with_components for Components V2 follow-ups", async () => {
    const post = vi.fn(async () => undefined);
    const client = createInternalTestClient();
    attachRestMock(client, { post });
    const interaction = new BaseInteraction(
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
    const interaction = new BaseInteraction(
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
    const interaction = new BaseInteraction(
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
