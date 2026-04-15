import { describe, expect, it } from "vitest";
import { normalizeExplicitDiscordSessionKey } from "./session-key-normalization.js";

describe("normalizeExplicitDiscordSessionKey", () => {
  it("rewrites bare discord:dm keys for direct chats", () => {
    expect(
      normalizeExplicitDiscordSessionKey("discord:dm:123456", {
        ChatType: "direct",
        From: "discord:123456",
        SenderId: "123456",
      }),
    ).toBe("discord:direct:123456");
  });

  it("rewrites legacy discord:dm keys for direct chats", () => {
    expect(
      normalizeExplicitDiscordSessionKey("agent:fina:discord:dm:123456", {
        ChatType: "direct",
        From: "discord:123456",
        SenderId: "123456",
      }),
    ).toBe("agent:fina:discord:direct:123456");
  });

  it("rewrites phantom discord:channel keys when sender matches", () => {
    expect(
      normalizeExplicitDiscordSessionKey("discord:channel:123456", {
        ChatType: "direct",
        From: "discord:123456",
        SenderId: "123456",
      }),
    ).toBe("discord:direct:123456");
  });

  it("leaves non-direct channel keys unchanged", () => {
    expect(
      normalizeExplicitDiscordSessionKey("agent:fina:discord:channel:123456", {
        ChatType: "channel",
        From: "discord:channel:123456",
        SenderId: "789",
      }),
    ).toBe("agent:fina:discord:channel:123456");
  });
});
