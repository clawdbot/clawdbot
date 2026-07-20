// Discord tests cover sender bot-status forwarding into the inbound context payload.
import { describe, expect, it } from "vitest";
import { buildDiscordMessageProcessContext } from "./message-handler.context.js";
import { createBaseDiscordMessageContext } from "./message-handler.test-harness.js";

describe("discord buildDiscordMessageProcessContext sender bot status", () => {
  it("preserves the native Discord channel id for tool authorization", async () => {
    const ctx = await createBaseDiscordMessageContext();

    const result = await buildDiscordMessageProcessContext({ ctx, text: "hi", mediaList: [] });
    if (!result) {
      throw new Error("expected a built Discord message context");
    }

    expect(result.ctxPayload.NativeChannelId).toBe(ctx.messageChannelId);
  });

  it("forwards bot author status to ctxPayload.SenderIsBot", async () => {
    const ctx = await createBaseDiscordMessageContext({
      author: { id: "U1", username: "alice", discriminator: "0", globalName: "Alice", bot: true },
    });

    const result = await buildDiscordMessageProcessContext({ ctx, text: "hi", mediaList: [] });
    if (!result) {
      throw new Error("expected a built Discord message context");
    }

    expect(result.ctxPayload.SenderIsBot).toBe(true);
  });

  it("omits SenderIsBot for human authors", async () => {
    const ctx = await createBaseDiscordMessageContext();

    const result = await buildDiscordMessageProcessContext({ ctx, text: "hi", mediaList: [] });
    if (!result) {
      throw new Error("expected a built Discord message context");
    }

    expect(result.ctxPayload.SenderIsBot).toBeUndefined();
  });

  it("omits SenderIsBot for PluralKit proxy senders despite the bot author", async () => {
    const ctx = await createBaseDiscordMessageContext({
      author: { id: "U1", username: "pk", discriminator: "0", globalName: "PK", bot: true },
      sender: { label: "user", name: "Member", tag: "member", isPluralKit: true },
    });

    const result = await buildDiscordMessageProcessContext({ ctx, text: "hi", mediaList: [] });
    if (!result) {
      throw new Error("expected a built Discord message context");
    }

    expect(result.ctxPayload.SenderIsBot).toBeUndefined();
  });

  it("does not duplicate forwarded media already rendered in room-event history text", async () => {
    const guildHistories = new Map();
    const forwardedText = "[Forwarded message]\n<media:image>";
    const ctx = await createBaseDiscordMessageContext({
      guildHistories,
      historyLimit: 10,
      inboundEventKind: "room_event",
      message: {
        id: "m-forwarded",
        channelId: "c1",
        timestamp: new Date().toISOString(),
        attachments: [],
        message_snapshots: [
          {
            message: {
              attachments: [
                {
                  id: "forwarded-image",
                  filename: "forwarded.png",
                  content_type: "image/png",
                  url: "https://cdn.discordapp.com/forwarded.png",
                },
              ],
            },
          },
        ],
      },
    });

    await buildDiscordMessageProcessContext({
      ctx,
      text: forwardedText,
      mediaList: [{ path: "/tmp/forwarded.png", contentType: "image/png", kind: "image" }],
    });

    expect(guildHistories.get("c1")?.[0]?.body).toBe(forwardedText);
  });
});
