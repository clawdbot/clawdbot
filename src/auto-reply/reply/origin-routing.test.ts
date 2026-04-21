import { describe, expect, it } from "vitest";
import {
  resolveOriginAccountId,
  resolveOriginMessageProvider,
  resolveOriginMessageTo,
} from "./origin-routing.js";

describe("origin-routing helpers", () => {
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

  it("prefers originating destination over fallback destination", () => {
    const to = resolveOriginMessageTo({
      originatingTo: "channel:C1",
      to: "channel:C2",
    });

    expect(to).toBe("channel:C1");
  });

  it("prefers originating account over fallback account", () => {
    const accountId = resolveOriginAccountId({
      originatingAccountId: "work",
      accountId: "personal",
    });

    expect(accountId).toBe("work");
  });
});
