import { MessageReferenceType, MessageType } from "discord-api-types/v10";
import { describe, expect, it, vi } from "vitest";
import { Message } from "../internal/discord.js";
import {
  createFakeRestClient,
  createInternalTestClient,
} from "../internal/test-builders.test-support.js";
import { buildDiscordMessageProcessContext } from "./message-handler.context.js";
import { hydrateDiscordMessageIfNeeded } from "./message-handler.hydration.js";
import { createBaseDiscordMessageContext } from "./message-handler.test-harness.js";

const TEST_TIMESTAMP = "2026-01-01T00:00:00.000Z";

function createMessagePayload(overrides = {}) {
  return {
    id: "m1",
    channel_id: "c1",
    content: "what did this mean?",
    attachments: [],
    embeds: [],
    mentions: [],
    mention_roles: [],
    mention_everyone: false,
    timestamp: TEST_TIMESTAMP,
    edited_timestamp: null,
    author: {
      id: "u1",
      username: "alice",
      global_name: null,
      discriminator: "0",
      avatar: null,
    },
    type: MessageType.Default,
    tts: false,
    pinned: false,
    flags: 0,
    ...overrides,
  };
}

function createDefaultReplyPayload(overrides = {}) {
  return createMessagePayload({
    message_reference: {
      type: MessageReferenceType.Default,
      message_id: "m0",
      channel_id: "c1",
    },
    type: MessageType.Reply,
    ...overrides,
  });
}

function createReferencedMessagePayload(content: string) {
  return createMessagePayload({
    id: "m0",
    content,
    author: {
      id: "u2",
      username: "bob",
      discriminator: "0",
      avatar: null,
    },
  });
}

describe("hydrateDiscordMessageIfNeeded", () => {
  it("hydrates partial internal messages without assigning over getters", async () => {
    const client = createInternalTestClient();
    const rest = createFakeRestClient([
      createMessagePayload({
        content: "hello <@u2>",
        attachments: [{ id: "a1", filename: "note.txt" }],
        embeds: [{ title: "Embed" }],
        mentions: [
          {
            id: "u2",
            username: "bob",
            global_name: "Bob Builder",
            discriminator: "0",
            avatar: null,
          },
        ],
        mention_roles: ["role1"],
        mention_everyone: false,
        referenced_message: createMessagePayload({
          id: "m0",
          content: "earlier",
          author: {
            id: "u3",
            username: "carol",
            discriminator: "0",
            avatar: null,
          },
        }),
      }),
    ]);
    const message = new Message<true>(client, { id: "m1", channelId: "c1" }) as unknown as Message;

    const hydrated = await hydrateDiscordMessageIfNeeded({
      client: { rest },
      message,
      messageChannelId: "c1",
    });

    expect(hydrated).toBeInstanceOf(Message);
    expect(hydrated.content).toBe("hello <@u2>");
    expect(hydrated.attachments).toHaveLength(1);
    expect(hydrated.embeds).toHaveLength(1);
    expect(hydrated.mentionedUsers[0]?.globalName).toBe("Bob Builder");
    expect(hydrated.mentionedRoles).toEqual(["role1"]);
    expect(hydrated.referencedMessage?.content).toBe("earlier");
  });

  it("uses referenced messages supplied by current-message hydration", async () => {
    const client = createInternalTestClient();
    const rest = createFakeRestClient([
      createDefaultReplyPayload({
        content: "hello <@123>",
        mentions: [
          {
            id: "123",
            username: "bob",
            global_name: null,
            discriminator: "0",
            avatar: null,
          },
        ],
        referenced_message: createReferencedMessagePayload("the replied-to message"),
      }),
    ]);
    const message = new Message(
      client,
      createDefaultReplyPayload({
        content: "hello <@123>",
      }),
    );

    const hydrated = await hydrateDiscordMessageIfNeeded({
      client: { rest },
      message,
      messageChannelId: "c1",
    });

    expect(rest.calls.map((call) => call.path)).toEqual(["/channels/c1/messages/m1"]);
    expect(hydrated.referencedMessage?.content).toBe("the replied-to message");
  });

  it("fetches the referenced message when the hydrated reply still omits it", async () => {
    const client = createInternalTestClient();
    const rest = createFakeRestClient([
      createReferencedMessagePayload("the directly fetched message"),
    ]);
    const message = new Message(client, createDefaultReplyPayload());

    const hydrated = await hydrateDiscordMessageIfNeeded({
      client: { rest },
      message,
      messageChannelId: "c1",
    });

    expect(rest.calls.map((call) => call.path)).toEqual(["/channels/c1/messages/m0"]);
    expect(hydrated.referencedMessage?.content).toBe("the directly fetched message");

    const ctx = await createBaseDiscordMessageContext({
      message: hydrated,
      author: hydrated.author,
      baseText: hydrated.content,
      messageText: hydrated.content,
    });
    const result = await buildDiscordMessageProcessContext({
      ctx,
      text: hydrated.content,
      mediaList: [],
    });
    if (!result) {
      throw new Error("expected a built Discord message context");
    }

    expect(result.ctxPayload.ReplyToId).toBe("m0");
    expect(result.ctxPayload.ReplyToBody).toBe("the directly fetched message");
  });

  it("uses the referenced channel when directly hydrating a cross-channel reply", async () => {
    const client = createInternalTestClient();
    const reply = createDefaultReplyPayload({
      message_reference: {
        type: MessageReferenceType.Default,
        message_id: "m0",
        channel_id: "c2",
      },
    });
    const rest = createFakeRestClient([
      createReferencedMessagePayload("the cross-channel message"),
    ]);
    const message = new Message(client, reply);

    const hydrated = await hydrateDiscordMessageIfNeeded({
      client: { rest },
      message,
      messageChannelId: "c1",
    });

    expect(rest.calls[0]?.path).toBe("/channels/c2/messages/m0");
    expect(hydrated.referencedMessage?.content).toBe("the cross-channel message");
  });

  it("keeps the original reply message when hydration fetch fails", async () => {
    const client = createInternalTestClient();
    const rest = createFakeRestClient();
    const get = vi.fn(async () => {
      throw Object.assign(new Error("Missing Access"), { status: 403 });
    });
    rest.get = get;
    const message = new Message(client, createDefaultReplyPayload());

    const hydrated = await hydrateDiscordMessageIfNeeded({
      client: { rest },
      message,
      messageChannelId: "c1",
    });

    expect(get).toHaveBeenCalledOnce();
    expect(hydrated).toBe(message);
    expect(hydrated.referencedMessage).toBeNull();
  });

  it("does not hydrate known-deleted or forwarded references", async () => {
    const client = createInternalTestClient();
    const rest = createFakeRestClient();
    const deletedReply = new Message(
      client,
      createDefaultReplyPayload({
        referenced_message: null,
      }),
    );
    const forwardedMessage = new Message(
      client,
      createMessagePayload({
        message_reference: {
          type: MessageReferenceType.Forward,
          message_id: "m0",
          channel_id: "c1",
        },
      }),
    );

    await hydrateDiscordMessageIfNeeded({
      client: { rest },
      message: deletedReply,
      messageChannelId: "c1",
    });
    await hydrateDiscordMessageIfNeeded({
      client: { rest },
      message: forwardedMessage,
      messageChannelId: "c1",
    });

    expect(rest.calls).toHaveLength(0);
  });
});
