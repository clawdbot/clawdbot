import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/channel-send-result";
// Tlon outbound chunking tests cover the declared text delivery limit.
import { describe, expect, it } from "vitest";
import { tlonPlugin } from "./channel.js";

function requireTlonOutbound(): ChannelOutboundAdapter {
  const outbound = tlonPlugin.outbound;
  if (!outbound) {
    throw new Error("expected tlon plugin to declare an outbound adapter");
  }
  return outbound;
}

describe("tlon channel outbound", () => {
  it("declares bounded Markdown chunking for text delivery", () => {
    const outbound = requireTlonOutbound();
    expect(outbound.chunkerMode).toBe("markdown");
    expect(outbound.textChunkLimit).toBe(10_000);
    expect(outbound.chunker).toBeTypeOf("function");
  });

  it("splits text above the declared limit into bounded chunks", () => {
    const outbound = requireTlonOutbound();
    const chunker = outbound.chunker;
    if (!chunker) {
      throw new Error("expected tlon outbound to declare a chunker");
    }
    const chunks = chunker("x".repeat(10_001), 10_000);
    expect(chunks).toEqual(["x".repeat(10_000), "x"]);
    expect(chunks.every((chunk) => chunk.length <= 10_000)).toBe(true);
  });
});
