// Discord tests cover sender bot-status forwarding into the inbound context payload.
import { describe, expect, it } from "vitest";
import { buildDiscordMessageProcessContext } from "./message-handler.context.js";
import type { DiscordHistoryEntry } from "./message-handler.history.js";
import { createBaseDiscordMessageContext } from "./message-handler.test-harness.js";

function historyEntry(params: {
  id: string;
  senderId: string;
  sender: string;
  body: string;
}): DiscordHistoryEntry {
  return {
    sender: params.sender,
    body: params.body,
    messageId: params.id,
    senderProvenance: Object.freeze({
      id: params.senderId,
      memberRoleIds: Object.freeze([]),
    }),
  };
}

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
      sender: { id: "U1", label: "user", name: "alice", isPluralKit: false },
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
    expect(guildHistories.get("c1")?.[0]?.senderProvenance).toEqual({
      id: "U1",
      name: "alice",
      memberRoleIds: [],
    });
    expect(Object.isFrozen(guildHistories.get("c1")?.[0]?.senderProvenance)).toBe(true);
    expect(Object.isFrozen(guildHistories.get("c1")?.[0]?.senderProvenance.memberRoleIds)).toBe(
      true,
    );
  });

  it("filters pending and inbound history by sender provenance in allowlist mode", async () => {
    const guildHistories = new Map<string, DiscordHistoryEntry[]>([
      [
        "c1",
        [
          historyEntry({ id: "allowed", senderId: "111", sender: "Alice", body: "allowed body" }),
          historyEntry({ id: "blocked", senderId: "222", sender: "Mallory", body: "blocked body" }),
        ],
      ],
    ]);
    const ctx = await createBaseDiscordMessageContext({
      cfg: { channels: { discord: { contextVisibility: "allowlist" } } },
      guildHistories,
      historyLimit: 10,
      channelConfig: { allowed: true, users: ["111"] },
    });

    const result = await buildDiscordMessageProcessContext({ ctx, text: "current", mediaList: [] });
    if (!result) {
      throw new Error("expected a built Discord message context");
    }

    expect(result.ctxPayload.Body).toContain("allowed body");
    expect(result.ctxPayload.Body).not.toContain("blocked body");
    expect(result.ctxPayload.InboundHistory).toEqual([
      expect.objectContaining({ messageId: "allowed", body: "allowed body" }),
    ]);
  });

  it("keeps all pending and inbound history under the default visibility mode", async () => {
    const guildHistories = new Map<string, DiscordHistoryEntry[]>([
      [
        "c1",
        [
          historyEntry({ id: "allowed", senderId: "111", sender: "Alice", body: "allowed body" }),
          historyEntry({ id: "other", senderId: "222", sender: "Mallory", body: "other body" }),
        ],
      ],
    ]);
    const ctx = await createBaseDiscordMessageContext({
      guildHistories,
      historyLimit: 10,
      channelConfig: { allowed: true, users: ["111"] },
    });

    const result = await buildDiscordMessageProcessContext({ ctx, text: "current", mediaList: [] });
    if (!result) {
      throw new Error("expected a built Discord message context");
    }

    expect(result.ctxPayload.Body).toContain("allowed body");
    expect(result.ctxPayload.Body).toContain("other body");
    expect(result.ctxPayload.InboundHistory).toHaveLength(2);
  });

  it("records an unavailable-attachment notice for path-less media facts", async () => {
    // Failed downloads produce path-less facts that core drops from the media
    // projection; the body notice is the model's only record of the attachment.
    const ctx = await createBaseDiscordMessageContext();

    const result = await buildDiscordMessageProcessContext({
      ctx,
      text: "look at this",
      mediaList: [
        { contentType: "image/png", kind: "image" },
        { path: "/tmp/ok.png", contentType: "image/png", kind: "image" },
      ],
    });
    if (!result) {
      throw new Error("expected a built Discord message context");
    }

    expect(result.ctxPayload.Body).toContain("look at this");
    expect(result.ctxPayload.Body).toContain("[discord attachment unavailable]");
    // BodyForAgent is what the model reads; Body alone would leave it silent.
    // It derives from the raw message text (harness baseText), not the envelope.
    expect(result.ctxPayload.BodyForAgent).toContain("hi");
    expect(result.ctxPayload.BodyForAgent).toContain("[discord attachment unavailable]");
  });

  it("keeps audio-transcript precedence in the agent text when media fails", async () => {
    const ctx = await createBaseDiscordMessageContext({
      preflightAudioTranscript: "spoken words",
    });

    const result = await buildDiscordMessageProcessContext({
      ctx,
      text: "look at this",
      mediaList: [{ contentType: "image/png", kind: "image" }],
    });
    if (!result) {
      throw new Error("expected a built Discord message context");
    }

    expect(result.ctxPayload.BodyForAgent).toContain("spoken words");
    expect(result.ctxPayload.BodyForAgent).toContain("[discord attachment unavailable]");
  });

  it("projects queued batch message ids into the finalized payload", async () => {
    const ctx = await createBaseDiscordMessageContext({
      batchMessageIds: ["m-2", "m-3"],
    });

    const result = await buildDiscordMessageProcessContext({
      ctx,
      text: "current",
      mediaList: [],
    });
    if (!result) {
      throw new Error("expected a built Discord message context");
    }

    expect(result.ctxPayload.MessageSids).toEqual(["m-2", "m-3"]);
    expect(result.ctxPayload.MessageSidFirst).toBe("m-2");
    expect(result.ctxPayload.MessageSidLast).toBe("m-3");
  });

  it("pluralizes the unavailable notice and skips it when all media resolved", async () => {
    const ctx = await createBaseDiscordMessageContext();

    const failedTwice = await buildDiscordMessageProcessContext({
      ctx,
      text: "two broken",
      mediaList: [
        { contentType: "image/png", kind: "image" },
        { contentType: "video/mp4", kind: "video" },
      ],
    });
    expect(failedTwice?.ctxPayload.Body).toContain("[discord 2 attachments unavailable]");

    const allResolved = await buildDiscordMessageProcessContext({
      ctx: await createBaseDiscordMessageContext(),
      text: "fine",
      mediaList: [{ path: "/tmp/ok.png", contentType: "image/png", kind: "image" }],
    });
    expect(allResolved?.ctxPayload.Body).not.toContain("unavailable");
  });

  it("does not inject stale pending history when history is disabled", async () => {
    const guildHistories = new Map<string, DiscordHistoryEntry[]>([
      ["c1", [historyEntry({ id: "stale", senderId: "111", sender: "Alice", body: "stale body" })]],
    ]);
    const ctx = await createBaseDiscordMessageContext({
      guildHistories,
      historyLimit: 0,
    });

    const result = await buildDiscordMessageProcessContext({ ctx, text: "current", mediaList: [] });
    if (!result) {
      throw new Error("expected a built Discord message context");
    }

    expect(result.ctxPayload.Body).toContain("current");
    expect(result.ctxPayload.Body).not.toContain("stale body");
    expect(result.ctxPayload.InboundHistory).toBeUndefined();
  });
});
