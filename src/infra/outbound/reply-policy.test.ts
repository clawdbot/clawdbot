// Covers reply-to fanout and delivery policy consumption for explicit,
// implicit, single-use, and disabled reply modes.
import { describe, expect, it } from "vitest";
import { createReplyToFanout, normalizeOutboundReplyFacts } from "./reply-policy.js";

describe("normalizeOutboundReplyFacts", () => {
  it("canonicalizes legacy modes without suppressing explicit replies", () => {
    expect(normalizeOutboundReplyFacts({ replyToId: "reply-1", replyToMode: "batched" })).toEqual({
      source: "implicit",
      replyToId: "reply-1",
      mode: "first",
    });
    expect(
      normalizeOutboundReplyFacts({ replyToId: "reply-1", replyToMode: "off" }),
    ).toBeUndefined();
    expect(
      normalizeOutboundReplyFacts({
        reply: { source: "explicit", replyToId: "reply-1" },
        replyToMode: "off",
      }),
    ).toEqual({ source: "explicit", replyToId: "reply-1" });
  });
});

describe("createReplyToFanout", () => {
  it("consumes implicit single-use replies once", () => {
    const next = createReplyToFanout({
      replyToId: "reply-1",
      replyToIdSource: "implicit",
      replyToMode: "first",
    });

    expect([next(), next(), next()]).toEqual(["reply-1", undefined, undefined]);
  });

  it("keeps explicit replies reusable even in single-use modes", () => {
    const next = createReplyToFanout({
      replyToId: "reply-1",
      replyToIdSource: "explicit",
      replyToMode: "first",
    });

    expect([next(), next()]).toEqual(["reply-1", "reply-1"]);
  });

  it("keeps all-mode replies reusable", () => {
    const next = createReplyToFanout({
      replyToId: "reply-1",
      replyToIdSource: "implicit",
      replyToMode: "all",
    });

    expect([next(), next()]).toEqual(["reply-1", "reply-1"]);
  });
});
