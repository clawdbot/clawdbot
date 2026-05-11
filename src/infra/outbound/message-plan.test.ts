import { describe, expect, it } from "vitest";
import { planOutboundMediaMessageUnits, planOutboundTextMessageUnits } from "./message-plan.js";
import { createReplyToDeliveryPolicy } from "./reply-policy.js";

describe("outbound message planning", () => {
  it("plans text chunks with one implicit reply in single-use modes", () => {
    const policy = createReplyToDeliveryPolicy({
      replyToId: "reply-1",
      replyToMode: "first",
    });
    const reply = policy.resolveCurrentReplyTo({});
    const units = planOutboundTextMessageUnits({
      text: "abcd",
      textLimit: 2,
      chunker: (text, limit) => [text.slice(0, limit), text.slice(limit)],
      overrides: { replyToId: reply.replyToId, replyToIdSource: reply.source },
      consumeReplyTo: (overrides) =>
        policy.applyReplyToConsumption(overrides, {
          consumeImplicitReply: overrides.replyToIdSource === "implicit",
        }),
    });

    expect(
      units.map((unit) =>
        unit.kind === "text" ? [unit.kind, unit.text, unit.overrides.replyToId] : [unit.kind],
      ),
    ).toEqual([
      ["text", "ab", "reply-1"],
      ["text", "cd", undefined],
    ]);
  });

  it("keeps explicit text replies from consuming the implicit slot", () => {
    const policy = createReplyToDeliveryPolicy({
      replyToId: "implicit-reply",
      replyToMode: "first",
    });
    const explicit = policy.resolveCurrentReplyTo({ replyToId: "explicit-reply" });
    const firstUnits = planOutboundTextMessageUnits({
      text: "explicit",
      overrides: { replyToId: explicit.replyToId, replyToIdSource: explicit.source },
      consumeReplyTo: (overrides) =>
        policy.applyReplyToConsumption(overrides, {
          consumeImplicitReply: overrides.replyToIdSource === "implicit",
        }),
    });
    const implicit = policy.resolveCurrentReplyTo({});
    const secondUnits = planOutboundTextMessageUnits({
      text: "implicit",
      overrides: { replyToId: implicit.replyToId, replyToIdSource: implicit.source },
      consumeReplyTo: (overrides) =>
        policy.applyReplyToConsumption(overrides, {
          consumeImplicitReply: overrides.replyToIdSource === "implicit",
        }),
    });

    expect(firstUnits[0]?.overrides.replyToId).toBe("explicit-reply");
    expect(secondUnits[0]?.overrides.replyToId).toBe("implicit-reply");
  });

  it("plans media sends with one implicit reply and a leading caption", () => {
    const policy = createReplyToDeliveryPolicy({
      replyToId: "reply-1",
      replyToMode: "batched",
    });
    const reply = policy.resolveCurrentReplyTo({});
    const units = planOutboundMediaMessageUnits({
      caption: "caption",
      mediaUrls: ["https://example.com/1.png", "https://example.com/2.png"],
      overrides: { replyToId: reply.replyToId, replyToIdSource: reply.source },
      consumeReplyTo: (overrides) =>
        policy.applyReplyToConsumption(overrides, {
          consumeImplicitReply: overrides.replyToIdSource === "implicit",
        }),
    });

    expect(
      units.map((unit) =>
        unit.kind === "media"
          ? [unit.kind, unit.caption, unit.mediaUrl, unit.overrides.replyToId]
          : [unit.kind],
      ),
    ).toEqual([
      ["media", "caption", "https://example.com/1.png", "reply-1"],
      ["media", undefined, "https://example.com/2.png", undefined],
    ]);
  });

  it("adds formatting overrides only to chunked text units", () => {
    const units = planOutboundTextMessageUnits({
      text: "**bold**",
      textLimit: 4000,
      chunker: () => ["<b>bold</b>"],
      chunkedTextFormatting: { parseMode: "HTML" },
      overrides: {},
    });

    expect(units).toEqual([
      {
        kind: "text",
        text: "<b>bold</b>",
        overrides: { formatting: { parseMode: "HTML" } },
      },
    ]);
  });
});
