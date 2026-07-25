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

describe("irc outbound sanitizeText", () => {
  it("strips internal tool-trace banners before outbound delivery", () => {
    const text = "Done.\n⚠️ 🛠️ `search repos (agent)` failed";

    expect(ircOutboundBaseAdapter.sanitizeText({ text })).toBe("Done.");
  });

  it("preserves ordinary assistant prose while sanitizing", () => {
    const text = "The pipeline has 3 open deals.";

    expect(ircOutboundBaseAdapter.sanitizeText({ text })).toBe(text);
  });
});
