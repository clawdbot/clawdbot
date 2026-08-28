// Tests canonical message-provider resolution for reply routing.
import { describe, expect, it } from "vitest";
import { resolveOriginMessageProvider } from "./origin-routing.js";

describe("resolveOriginMessageProvider", () => {
  it("prefers originating channel over provider for message provider", () => {
    const provider = resolveOriginMessageProvider({
      originatingChannel: "QuietChat",
      provider: "heartbeat",
    });

    expect(provider).toBe("quietchat");
  });

  it("falls back to provider when originating channel is missing", () => {
    const provider = resolveOriginMessageProvider({
      provider: "  WorkChat  ",
    });

    expect(provider).toBe("workchat");
  });

  it("canonicalizes built-in aliases before comparing delivery routes", () => {
    expect(
      resolveOriginMessageProvider({
        originatingChannel: "imsg",
        provider: "imessage",
      }),
    ).toBe("imessage");
  });
});
