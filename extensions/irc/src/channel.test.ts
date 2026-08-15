// Irc tests cover channel plugin behavior.
import { describe, expect, it } from "vitest";
import { ircPlugin } from "./channel.js";
import { ircOutboundBaseAdapter } from "./outbound-base.js";

describe("irc outbound chunking", () => {
  it("chunks outbound text without requiring IRC runtime initialization", () => {
    expect(ircOutboundBaseAdapter.chunker("alpha beta", 5)).toEqual(["alpha", "beta"]);
    expect(ircOutboundBaseAdapter.deliveryMode).toBe("direct");
    expect(ircOutboundBaseAdapter.chunkerMode).toBe("markdown");
    expect(ircOutboundBaseAdapter.textChunkLimit).toBe(350);
  });
});

describe("irc target classification", () => {
  it("distinguishes nicknames from channels", () => {
    expect(ircPlugin.messaging?.inferTargetChatType?.({ to: "alice" })).toBe("direct");
    expect(ircPlugin.messaging?.inferTargetChatType?.({ to: "#operators" })).toBe("group");
  });
});
