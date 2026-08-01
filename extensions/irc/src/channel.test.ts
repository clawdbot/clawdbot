// Irc tests cover channel plugin behavior.
import { describe, expect, it } from "vitest";
import { ircOutboundBaseAdapter } from "./outbound-base.js";

describe("irc outbound chunking", () => {
  it("chunks outbound text without requiring IRC runtime initialization", () => {
    expect(ircOutboundBaseAdapter.chunker("alpha beta", 5)).toEqual(["alpha", "beta"]);
    expect(ircOutboundBaseAdapter.deliveryMode).toBe("direct");
    expect(ircOutboundBaseAdapter.chunkerMode).toBe("markdown");
    expect(ircOutboundBaseAdapter.textChunkLimit).toBe(350);
  });
});
