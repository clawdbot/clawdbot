import { describe, expect, it } from "vitest";
import { Message } from "../internal/discord.js";
import {
  createFakeRestClient,
  createInternalTestClient,
} from "../internal/test-builders.test-support.js";
import { hydrateDiscordMessageIfNeeded } from "./message-handler.hydration.js";

describe("hydrateDiscordMessageIfNeeded", () => {
  it("hydrates partial internal messages without assigning over getters", async () => {
    const client = createInternalTestClient();
    const rest = createFakeRestClient([
      {
        id: "m1",
        channel_id: "c1",
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
        timestamp: new Date().toISOString(),
        author: {
          id: "u1",
          username: "alice",
          discriminator: "0",
          avatar: null,
        },
        referenced_message: {
          id: "m0",
          channel_id: "c1",
          content: "earlier",
          attachments: [],
          embeds: [],
          mentions: [],
          mention_roles: [],
          mention_everyone: false,
          timestamp: new Date().toISOString(),
          author: {
            id: "u3",
            username: "carol",
            discriminator: "0",
            avatar: null,
          },
          type: 0,
          tts: false,
          pinned: false,
          flags: 0,
        },
        type: 0,
        tts: false,
        pinned: false,
        flags: 0,
      },
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
});
