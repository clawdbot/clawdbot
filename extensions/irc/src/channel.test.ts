import { afterEach, describe, expect, it } from "vitest";
import { ircOutboundBaseAdapter } from "./outbound-base.js";
import { clearIrcRuntime } from "./runtime.js";

describe("irc outbound chunking", () => {
  afterEach(() => {
    clearIrcRuntime();
  });

  it("chunks outbound text without requiring IRC runtime initialization", () => {
    expect(ircOutboundBaseAdapter.chunker("alpha beta", 5)).toEqual(["alpha", "beta"]);
    expect(ircOutboundBaseAdapter.deliveryMode).toBe("direct");
    expect(ircOutboundBaseAdapter.chunkerMode).toBe("markdown");
    expect(ircOutboundBaseAdapter.textChunkLimit).toBe(350);
  });
});
